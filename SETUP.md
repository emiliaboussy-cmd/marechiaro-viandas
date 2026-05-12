# Setup — Viandas App

## Lo único que necesitás instalar: Node.js
Descargar desde: https://nodejs.org → botón **"LTS"** → instalar con todas las opciones por defecto.

> ✅ No necesitás instalar PostgreSQL ni ninguna base de datos.
> La app usa SQLite, que crea automáticamente un archivo `viandas.db` en la carpeta del proyecto.

---

## Pasos para arrancar

### 1. Abrir la carpeta en VS Code
`File → Open Folder` → elegir la carpeta `viandas`

### 2. Abrir la terminal integrada
`Terminal → New Terminal` (o `Ctrl + ñ`)

### 3. Instalar dependencias
```bash
npm install
```

### 4. Iniciar el servidor
```bash
npm start
```

### 5. Abrir en el navegador
Ir a: **http://localhost:3000**

---

## Credenciales iniciales
| Campo | Valor |
|-------|-------|
| Usuario | `admin` |
| Contraseña | `password` |

> ⚠️ Cambiar la contraseña desde el panel **Usuarios** al ingresar por primera vez.

---

## Flujo de uso

### Admin (vos):
1. Entrás con `admin` / `password`
2. **Menú** → cargás los platos disponibles
3. **Usuarios** → creás las cuentas de los empleados (con su empresa)
4. **Configuración** → establecés el horario de corte (ej: 10:00)
5. Cada día → **Pedidos** → ves el resumen y descargás Excel o PDF

### Empleados:
1. Entran con su usuario y contraseña
2. Ven el menú del día con un countdown hasta el corte
3. Seleccionan sus platos y confirman
4. Pueden modificar o cancelar hasta el horario de corte

---

## Para desarrollo (auto-recarga al guardar)
```bash
npm run dev
```
