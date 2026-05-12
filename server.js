require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'viandas-secret-change-in-production';

// ---- CAPA DE BASE DE DATOS ----
// Local (desarrollo): node:sqlite  →  TURSO_DATABASE_URL no definido
// Nube  (producción): @libsql/client → TURSO_DATABASE_URL=libsql://...

let _sqlite = null;
let _turso = null;

if (process.env.TURSO_DATABASE_URL) {
  const { createClient } = require('@libsql/client');
  _turso = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'viandas.db');
  _sqlite = new DatabaseSync(DB_PATH);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
}

const db = {
  async query(sql, args = []) {
    if (_turso) return (await _turso.execute({ sql, args })).rows;
    return _sqlite.prepare(sql).all(...args);
  },
  async get(sql, args = []) {
    if (_turso) return (await _turso.execute({ sql, args })).rows[0] ?? null;
    return _sqlite.prepare(sql).get(...args) ?? null;
  },
  async run(sql, args = []) {
    if (_turso) {
      const r = await _turso.execute({ sql, args });
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.rowsAffected };
    }
    return _sqlite.prepare(sql).run(...args);
  },
  async batch(statements) {
    // statements: [{ sql, args? }]
    if (_turso) {
      await _turso.batch(statements.map(s => ({ sql: s.sql, args: s.args || [] })), 'write');
    } else {
      _sqlite.exec('BEGIN');
      try {
        for (const { sql, args = [] } of statements) _sqlite.prepare(sql).run(...args);
        _sqlite.exec('COMMIT');
      } catch (e) {
        _sqlite.exec('ROLLBACK');
        throw e;
      }
    }
  },
  async exec(sql) {
    if (_turso) {
      for (const s of sql.split(';').map(x => x.trim()).filter(Boolean))
        await _turso.execute(s);
    } else {
      _sqlite.exec(sql);
    }
  },
};

// ---- INICIALIZACIÓN DE TABLAS Y DATOS ----
async function initDB() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      empresa TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'Principal',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_date TEXT NOT NULL,
      menu_item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ];
  for (const sql of tables) await db.exec(sql);

  if (!await db.get("SELECT id FROM users WHERE username = 'admin'")) {
    const hash = bcrypt.hashSync('password', 10);
    await db.run(
      "INSERT INTO users (username, name, empresa, password_hash, role) VALUES ('admin','Administrador','Marechiaro',?,?)",
      [hash, 'admin']
    );
  }
  if (!await db.get("SELECT key FROM settings WHERE key = 'cutoff_time'")) {
    await db.run("INSERT INTO settings (key, value) VALUES ('cutoff_time', '10:00')");
  }
  if ((await db.get("SELECT COUNT(*) as c FROM menu_items")).c === 0) {
    const items = [
      ['Milanesa de carne con puré', 'Milanesa de nalga con puré de papas', 'Principal'],
      ['Pollo al horno con papas', 'Suprema de pollo con papas al romero', 'Principal'],
      ['Tarta de verdura', 'Tarta casera de espinaca y ricota', 'Principal'],
      ['Ensalada mixta', 'Lechuga, tomate, zanahoria y remolacha', 'Acompañamiento'],
      ['Fruta de estación', 'Porción de fruta fresca', 'Postre'],
    ];
    for (const [name, desc, cat] of items)
      await db.run('INSERT INTO menu_items (name, description, category) VALUES (?,?,?)', [name, desc, cat]);
  }
}

// ---- MIDDLEWARE ----
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido o expirado' }); }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Se requieren permisos de administrador' });
    next();
  });
}

function isCutoffPassed(cutoffTime) {
  const [h, m] = cutoffTime.split(':').map(Number);
  const now = new Date();
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
}

function today() { return new Date().toISOString().split('T')[0]; }

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function isDateClosed(orderDate, cutoffTime) {
  const todayStr = today();
  if (orderDate <= todayStr) return true;
  const prev = new Date(orderDate + 'T12:00:00');
  prev.setDate(prev.getDate() - 1);
  if (prev.toISOString().split('T')[0] === todayStr) return isCutoffPassed(cutoffTime);
  return false;
}

// ---- AUTH ----
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  try {
    const user = await db.get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role, empresa: user.empresa },
      JWT_SECRET, { expiresIn: '12h' }
    );
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, empresa: user.empresa } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

// ---- MENÚ ----
app.get('/api/menu', authMiddleware, async (req, res) => {
  res.json(await db.query('SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name'));
});

app.get('/api/menu/all', adminMiddleware, async (req, res) => {
  res.json(await db.query('SELECT * FROM menu_items ORDER BY category, name'));
});

app.post('/api/menu', adminMiddleware, async (req, res) => {
  const { name, description, category } = req.body;
  if (!name) return res.status(400).json({ error: 'El nombre es requerido' });
  try {
    const r = await db.run('INSERT INTO menu_items (name, description, category) VALUES (?,?,?)',
      [name.trim(), (description || '').trim(), (category || 'Principal').trim()]);
    res.json(await db.get('SELECT * FROM menu_items WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) { res.status(500).json({ error: 'Error al crear item' }); }
});

app.put('/api/menu/:id', adminMiddleware, async (req, res) => {
  const { name, description, category, active } = req.body;
  try {
    await db.run('UPDATE menu_items SET name=?, description=?, category=?, active=? WHERE id=?',
      [name, description, category, active ? 1 : 0, req.params.id]);
    const item = await db.get('SELECT * FROM menu_items WHERE id = ?', [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Item no encontrado' });
    res.json(item);
  } catch (err) { res.status(500).json({ error: 'Error al actualizar item' }); }
});

app.delete('/api/menu/:id', adminMiddleware, async (req, res) => {
  await db.run('UPDATE menu_items SET active=0 WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ---- FECHAS DISPONIBLES ----
app.get('/api/available-dates', authMiddleware, async (req, res) => {
  const row = await db.get("SELECT value FROM settings WHERE key = 'cutoff_time'");
  const cutoffTime = row?.value || '10:00';
  const dates = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    dates.push({
      date: dateStr,
      dayName: d.toLocaleDateString('es-AR', { weekday: 'short' }),
      dayNum: d.getDate(),
      month: d.toLocaleDateString('es-AR', { month: 'short' }),
      closed: isDateClosed(dateStr, cutoffTime),
    });
  }
  res.json({ dates, cutoff_time: cutoffTime });
});

// ---- PEDIDOS (empleado) ----
app.get('/api/orders/my', authMiddleware, async (req, res) => {
  const date = req.query.date || addDays(1);
  res.json(await db.query(`
    SELECT o.id, o.quantity, o.notes, o.order_date,
           m.id as menu_item_id, m.name as item_name, m.category, m.description
    FROM orders o JOIN menu_items m ON o.menu_item_id = m.id
    WHERE o.user_id = ? AND o.order_date = ?
    ORDER BY m.category, m.name
  `, [req.user.id, date]));
});

app.post('/api/orders', authMiddleware, async (req, res) => {
  const { items, order_date } = req.body;
  if (!order_date) return res.status(400).json({ error: 'Debe indicar una fecha para el pedido' });
  const row = await db.get("SELECT value FROM settings WHERE key = 'cutoff_time'");
  const cutoffTime = row?.value || '10:00';
  if (isDateClosed(order_date, cutoffTime))
    return res.status(400).json({ error: `El período de pedido para el ${order_date} ya está cerrado.` });
  if (order_date <= today() || order_date > addDays(14))
    return res.status(400).json({ error: 'Solo se puede pedir para los próximos 14 días.' });
  if (!items || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'Debe seleccionar al menos un item' });
  try {
    await db.batch([
      { sql: 'DELETE FROM orders WHERE user_id = ? AND order_date = ?', args: [req.user.id, order_date] },
      ...items.map(item => ({
        sql: 'INSERT INTO orders (user_id, order_date, menu_item_id, quantity, notes) VALUES (?,?,?,?,?)',
        args: [req.user.id, order_date, item.menu_item_id, item.quantity || 1, (item.notes || '').trim()],
      })),
    ]);
    res.json({ success: true, message: 'Pedido registrado correctamente' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error al guardar el pedido' }); }
});

app.delete('/api/orders/my', authMiddleware, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Fecha requerida' });
  const row = await db.get("SELECT value FROM settings WHERE key = 'cutoff_time'");
  const cutoffTime = row?.value || '10:00';
  if (isDateClosed(date, cutoffTime))
    return res.status(400).json({ error: 'El período de pedido para esa fecha ya está cerrado.' });
  await db.run('DELETE FROM orders WHERE user_id = ? AND order_date = ?', [req.user.id, date]);
  res.json({ success: true });
});

// ---- CONFIGURACIÓN ----
app.get('/api/settings/cutoff', authMiddleware, async (req, res) => {
  const row = await db.get("SELECT value FROM settings WHERE key = 'cutoff_time'");
  res.json({ cutoff_time: row?.value || '10:00' });
});

app.put('/api/settings/cutoff', adminMiddleware, async (req, res) => {
  const { cutoff_time } = req.body;
  if (!cutoff_time || !/^\d{2}:\d{2}$/.test(cutoff_time))
    return res.status(400).json({ error: 'Formato de hora inválido (HH:MM)' });
  await db.run("INSERT INTO settings (key,value) VALUES ('cutoff_time',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [cutoff_time]);
  res.json({ success: true });
});

// ---- ADMIN: PEDIDOS ----
app.get('/api/admin/orders', adminMiddleware, async (req, res) => {
  const date = req.query.date || today();
  res.json(await db.query(`
    SELECT o.id, o.quantity, o.notes, o.order_date, o.created_at,
           u.name as user_name, u.empresa,
           m.name as item_name, m.category
    FROM orders o
    JOIN users u ON o.user_id = u.id
    JOIN menu_items m ON o.menu_item_id = m.id
    WHERE o.order_date = ?
    ORDER BY u.empresa, u.name, m.category, m.name
  `, [date]));
});

// ---- ADMIN: USUARIOS ----
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  res.json(await db.query('SELECT id, username, name, empresa, role, active, created_at FROM users ORDER BY empresa, name'));
});

app.post('/api/admin/users', adminMiddleware, async (req, res) => {
  const { username, name, empresa, password, role } = req.body;
  if (!username || !name || !password) return res.status(400).json({ error: 'Usuario, nombre y contraseña son requeridos' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = await db.run('INSERT INTO users (username, name, empresa, password_hash, role) VALUES (?,?,?,?,?)',
      [username.trim(), name.trim(), (empresa || '').trim(), hash, role || 'employee']);
    res.json(await db.get('SELECT id, username, name, empresa, role, active FROM users WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const { name, empresa, role, active, password } = req.body;
  try {
    if (password?.trim()) {
      const hash = bcrypt.hashSync(password, 10);
      await db.run('UPDATE users SET name=?, empresa=?, role=?, active=?, password_hash=? WHERE id=?',
        [name, empresa, role, active ? 1 : 0, hash, req.params.id]);
    } else {
      await db.run('UPDATE users SET name=?, empresa=?, role=?, active=? WHERE id=?',
        [name, empresa, role, active ? 1 : 0, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error al actualizar usuario' }); }
});

// ---- EXPORTAR EXCEL ----
app.get('/api/export/excel', adminMiddleware, async (req, res) => {
  const date = req.query.date || today();
  try {
    const rows = await db.query(`
      SELECT u.empresa, u.name as user_name, m.category, m.name as item_name, o.quantity, o.notes
      FROM orders o JOIN users u ON o.user_id = u.id JOIN menu_items m ON o.menu_item_id = m.id
      WHERE o.order_date = ? ORDER BY u.empresa, u.name, m.category, m.name
    `, [date]);

    const workbook = new ExcelJS.Workbook();

    const sheetR = workbook.addWorksheet('Resumen por Plato');
    sheetR.columns = [
      { header: 'Categoría', key: 'category', width: 18 },
      { header: 'Plato', key: 'item_name', width: 40 },
      { header: 'Total', key: 'total', width: 10 },
    ];
    const hr = sheetR.getRow(1);
    hr.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF767C36' } };
    hr.alignment = { vertical: 'middle', horizontal: 'center' };
    hr.height = 22;
    const summary = {};
    rows.forEach(r => { const k = `${r.category}||${r.item_name}`; summary[k] = (summary[k] || 0) + r.quantity; });
    Object.entries(summary).forEach(([key, total]) => {
      const [category, item_name] = key.split('||');
      const row = sheetR.addRow({ category, item_name, total });
      row.getCell('total').font = { bold: true };
      row.getCell('total').alignment = { horizontal: 'center' };
    });
    sheetR.addRow({});
    sheetR.addRow({ item_name: 'TOTAL GENERAL', total: rows.reduce((s, r) => s + r.quantity, 0) }).font = { bold: true, size: 12 };

    const sheetD = workbook.addWorksheet('Detalle de Pedidos');
    sheetD.columns = [
      { header: 'Empresa', key: 'empresa', width: 22 },
      { header: 'Empleado', key: 'user_name', width: 28 },
      { header: 'Categoría', key: 'category', width: 16 },
      { header: 'Plato', key: 'item_name', width: 38 },
      { header: 'Cantidad', key: 'quantity', width: 10 },
      { header: 'Notas', key: 'notes', width: 30 },
    ];
    const hd = sheetD.getRow(1);
    hd.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    hd.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF16243' } };
    hd.alignment = { vertical: 'middle', horizontal: 'center' };
    hd.height = 22;
    let lastEmpresa = null;
    rows.forEach((r, i) => {
      const row = sheetD.addRow(r);
      if (r.empresa !== lastEmpresa) { row.getCell('empresa').font = { bold: true }; lastEmpresa = r.empresa; }
      if (i % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pedidos-${date}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error al generar Excel' }); }
});

// ---- EXPORTAR PDF ----
app.get('/api/export/pdf', adminMiddleware, async (req, res) => {
  const date = req.query.date || today();
  try {
    const rows = await db.query(`
      SELECT u.empresa, u.name as user_name, m.category, m.name as item_name, o.quantity, o.notes
      FROM orders o JOIN users u ON o.user_id = u.id JOIN menu_items m ON o.menu_item_id = m.id
      WHERE o.order_date = ? ORDER BY m.category, m.name, u.empresa, u.name
    `, [date]);

    const summary = {};
    rows.forEach(r => {
      const k = `${r.category}||${r.item_name}`;
      if (!summary[k]) summary[k] = { category: r.category, item_name: r.item_name, total: 0 };
      summary[k].total += r.quantity;
    });
    const byEmpresa = {};
    rows.forEach(r => {
      const emp = r.empresa || 'Sin empresa';
      if (!byEmpresa[emp]) byEmpresa[emp] = [];
      byEmpresa[emp].push(r);
    });

    const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const totalItems = rows.reduce((s, r) => s + r.quantity, 0);

    const doc = new PDFDocument({ margin: 45, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pedidos-${date}.pdf"`);
    doc.pipe(res);

    doc.rect(0, 0, doc.page.width, 80).fill('#767C36');
    doc.fillColor('white').fontSize(22).font('Helvetica-Bold').text('Marechiaro — Resumen de Pedidos', 45, 20, { align: 'center' });
    doc.fontSize(11).font('Helvetica').text(dateFormatted.charAt(0).toUpperCase() + dateFormatted.slice(1), 45, 48, { align: 'center' });
    doc.fillColor('#000000'); doc.y = 95;
    doc.roundedRect(45, doc.y, doc.page.width - 90, 40, 6).fill('#F4F5E8');
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#767C36')
      .text(`Total raciones: ${totalItems}   |   Empresas: ${Object.keys(byEmpresa).length}   |   Platos: ${Object.keys(summary).length}`,
        45, doc.y + 13, { align: 'center' });
    doc.fillColor('#000000'); doc.y = 150;

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#F16243').text('RESUMEN POR PLATO', 45);
    doc.moveDown(0.4);
    doc.moveTo(45, doc.y).lineTo(doc.page.width - 45, doc.y).strokeColor('#F16243').lineWidth(1.5).stroke();
    doc.moveDown(0.4);
    let currentCat = null;
    Object.values(summary).sort((a, b) => a.category.localeCompare(b.category) || a.item_name.localeCompare(b.item_name))
      .forEach(item => {
        if (item.category !== currentCat) {
          currentCat = item.category;
          doc.moveDown(0.3);
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#8E9549').text(item.category.toUpperCase(), 50);
          doc.fillColor('#000000');
        }
        const y = doc.y;
        doc.fontSize(11).font('Helvetica').text(`  ${item.item_name}`, 60, y, { width: 360 });
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#F16243').text(`${item.total}`, doc.page.width - 90, y, { width: 45, align: 'right' });
        doc.fillColor('#000000');
      });

    doc.addPage();
    doc.rect(0, 0, doc.page.width, 60).fill('#F16243');
    doc.fillColor('white').fontSize(18).font('Helvetica-Bold').text('DETALLE POR EMPRESA', 45, 20, { align: 'center' });
    doc.fillColor('#000000'); doc.y = 80;

    Object.entries(byEmpresa).forEach(([empresa, pedidos]) => {
      if (doc.y > 680) doc.addPage();
      doc.moveDown(0.5);
      doc.roundedRect(45, doc.y, doc.page.width - 90, 22, 4).fill('#F4F5E8');
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#767C36').text(empresa, 55, doc.y + 5, { width: doc.page.width - 110 });
      doc.fillColor('#000000'); doc.moveDown(1.3);
      pedidos.forEach(r => {
        if (doc.y > 730) doc.addPage();
        doc.fontSize(10).font('Helvetica').text(`  ${r.user_name}`, 55, doc.y, { continued: true, width: 180 });
        doc.text(r.item_name, { continued: true, width: 220 });
        doc.font('Helvetica-Bold').text(` x${r.quantity}${r.notes ? '  (' + r.notes + ')' : ''}`, { width: 80 });
      });
    });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).font('Helvetica').fillColor('#999999')
        .text(`Página ${i + 1} de ${range.count}  —  ${new Date().toLocaleString('es-AR')}`,
          45, doc.page.height - 30, { align: 'center', width: doc.page.width - 90 });
    }
    doc.end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error al generar PDF' }); }
});

// ---- ARRANCAR ----
initDB()
  .then(() => {
    app.listen(PORT, () => {
      const mode = _turso ? 'Turso (nube)' : 'SQLite (local)';
      console.log(`\n✅ Servidor corriendo en http://localhost:${PORT}`);
      console.log(`🗄️  Base de datos: ${mode}\n`);
    });
  })
  .catch(err => {
    console.error('Error al inicializar la base de datos:', err);
    process.exit(1);
  });
