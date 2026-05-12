-- Crear la base de datos (ejecutar como superusuario)
-- CREATE DATABASE viandas;

-- Tabla de usuarios (empleados y admin)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  empresa VARCHAR(100) DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'employee', -- 'admin' o 'employee'
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de items del menú
CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  category VARCHAR(50) DEFAULT 'Principal',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de pedidos
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de configuración
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(50) PRIMARY KEY,
  value VARCHAR(255) NOT NULL
);

-- Horario de corte por defecto: 10:00
INSERT INTO settings (key, value) VALUES ('cutoff_time', '10:00')
  ON CONFLICT (key) DO NOTHING;

-- Usuario admin por defecto (password: admin123 - cambiar en producción)
-- Hash generado con bcrypt rounds=10
INSERT INTO users (username, name, empresa, password_hash, role)
VALUES ('admin', 'Administrador', 'Viandas', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin')
  ON CONFLICT (username) DO NOTHING;

-- Items de ejemplo para el menú
INSERT INTO menu_items (name, description, category) VALUES
  ('Milanesa de carne con puré', 'Milanesa de nalga con puré de papas', 'Principal'),
  ('Pollo al horno con papas', 'Suprema de pollo con papas al romero', 'Principal'),
  ('Tarta de verdura', 'Tarta casera de espinaca y ricota', 'Principal'),
  ('Ensalada mixta', 'Lechuga, tomate, zanahoria y remolacha', 'Acompañamiento'),
  ('Fruta de estación', 'Porción de fruta fresca', 'Postre')
ON CONFLICT DO NOTHING;
