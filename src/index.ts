import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';

const execAsync = promisify(exec);

dotenv.config();

// ============================================================================
// CONFIGURACION
// ============================================================================
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-este-secreto-en-produccion';
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/data/uploads';
const FRONTEND_DIR = path.join(__dirname, 'public');

// Crear directorio de uploads si no existe
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ============================================================================
// MIDDLEWARES
// ============================================================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Servir frontend estatico
app.use(express.static(FRONTEND_DIR));
// Servir uploads
app.use('/uploads', express.static(UPLOADS_DIR));

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================
interface AuthRequest extends Request {
  user?: { id: number; email: string; role: string; name: string; sage_commercial_code?: string };
}

function verifyToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'No autorizado' });
    return;
  }
  const token = auth.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;

    // === IMPERSONACION ===
    // Si admin envia header X-Impersonate-User, simula ser ese usuario
    // Pero el rol REAL del que pide sigue siendo admin (controlado por requireRealAdmin)
    const impersonateHeader = req.headers['x-impersonate-user'];
    if (impersonateHeader && decoded.role === 'admin') {
      const targetId = Number(impersonateHeader);
      if (targetId > 0 && targetId !== decoded.id) {
        // Cargar el usuario impersonado (sincronamente con una query rapida)
        pool.query('SELECT id, email, name, role, sage_commercial_code FROM users WHERE id = $1 AND is_active = TRUE', [targetId])
          .then(r => {
            if (r.rows.length > 0) {
              const target = r.rows[0];
              req.user = {
                id: target.id,
                email: target.email,
                name: target.name,
                role: target.role,
                sage_commercial_code: target.sage_commercial_code,
                _realAdminId: decoded.id,
                _realAdminEmail: decoded.email
              } as any;
            }
            next();
          })
          .catch(() => next());
        return;
      }
    }
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: 'Token invalido o caducado' });
  }
}

// requireAdmin acepta admin REAL o admin impersonando (porque solo admin puede impersonar)
function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const u = req.user as any;
  // Es admin REAL si tiene _realAdminId (impersonando) o si su rol es admin
  if (!u) {
    res.status(403).json({ success: false, error: 'No autorizado' });
    return;
  }
  if (u._realAdminId || u.role === 'admin') {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Solo admin' });
}

// requireRealAdmin: solo admin REAL (no impersonando). Para gestion de usuarios.
function requireRealAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const u = req.user as any;
  if (!u) {
    res.status(403).json({ success: false, error: 'No autorizado' });
    return;
  }
  if (u._realAdminId) {
    res.status(403).json({ success: false, error: 'No permitido mientras impersonas otro usuario' });
    return;
  }
  if (u.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Solo admin' });
    return;
  }
  next();
}

// Helper B5: en algunos endpoints, si el catalogo es 'express' rechazamos
// porque sus laminas vienen del maestro y no se pueden subir/editar/borrar aqui.
// Devuelve true si OK (puede continuar), false si rechazado (ya envio respuesta).
async function assertNotExpress(catalogId: number, res: Response): Promise<boolean> {
  const r = await pool.query('SELECT tipo FROM catalogs WHERE id = $1', [catalogId]);
  if (r.rows.length === 0) {
    res.status(404).json({ success: false, error: 'Catalogo no encontrado' });
    return false;
  }
  if (r.rows[0].tipo === 'express') {
    res.status(400).json({
      success: false,
      error: 'No se puede modificar laminas en un Express. Las laminas pertenecen al maestro padre. Usa los endpoints /express-sheets para anadir/quitar/reordenar referencias.'
    });
    return false;
  }
  return true;
}

// Helper B5: igual que el anterior pero buscando el catalogo desde una sheet_id.
async function assertSheetNotInExpress(sheetId: number, res: Response): Promise<boolean> {
  const r = await pool.query(
    `SELECT c.tipo FROM sheets s JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = $1`,
    [sheetId]
  );
  if (r.rows.length === 0) {
    res.status(404).json({ success: false, error: 'Lamina no encontrada' });
    return false;
  }
  if (r.rows[0].tipo === 'express') {
    // Nota: una sheet NUNCA deberia pertenecer a un catalog express (las sheets cuelgan del maestro).
    // Pero esto es defensa en profundidad por si en el futuro cambia algo.
    res.status(400).json({ success: false, error: 'Esta lamina pertenece a un Express, modifica desde el maestro padre' });
    return false;
  }
  return true;
}

// ============================================================================
// MULTER (subida de archivos)
// ============================================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 50);
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ============================================================================
// INICIALIZACION BD
// ============================================================================
async function initDB(): Promise<void> {
  console.log('Inicializando BD...');
  try {
    // Crear todas las tablas (idempotente)
    const schemaSQL = `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, email VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL, name VARCHAR(150) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('admin','sales')),
        sage_commercial_code VARCHAR(20), is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY, razon_social VARCHAR(255) NOT NULL,
        cif VARCHAR(20), cp VARCHAR(10), direccion VARCHAR(255),
        municipio VARCHAR(100), provincia VARCHAR(100),
        telefono VARCHAR(50), whatsapp VARCHAR(50),
        email VARCHAR(150), email_alternativo VARCHAR(150),
        numero_cuenta VARCHAR(50), sage_code VARCHAR(20) UNIQUE,
        commercial_code VARCHAR(20), categoria VARCHAR(10),
        ciclo_visita_dias INTEGER DEFAULT 90,
        ciclo_modificado_por_id INTEGER REFERENCES users(id),
        ciclo_modificado_at TIMESTAMP,
        notas_internas TEXT,
        is_new_from_visit BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        ultima_visita_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_clients_sage_code ON clients(sage_code);
      CREATE INDEX IF NOT EXISTS idx_clients_commercial ON clients(commercial_code);
      CREATE INDEX IF NOT EXISTS idx_clients_razon ON clients(razon_social);

      CREATE TABLE IF NOT EXISTS catalogs (
        id SERIAL PRIMARY KEY, name VARCHAR(150) NOT NULL,
        description TEXT,
        tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('maestro','clon','express')),
        parent_id INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
        version INTEGER DEFAULT 1,
        estado VARCHAR(20) DEFAULT 'borrador' CHECK (estado IN ('borrador','publicado','archivado')),
        fecha_caducidad DATE,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        published_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sheets (
        id SERIAL PRIMARY KEY,
        catalog_id INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
        orden INTEGER NOT NULL DEFAULT 0,
        titulo VARCHAR(255), notas TEXT,
        imagen_path VARCHAR(500) NOT NULL,
        miniatura_path VARCHAR(500),
        tags TEXT,
        enlace_externo_url VARCHAR(500),
        enlace_externo_titulo VARCHAR(150),
        oculta BOOLEAN DEFAULT FALSE,
        origen_sheet_id INTEGER REFERENCES sheets(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sheets_catalog ON sheets(catalog_id);
      CREATE INDEX IF NOT EXISTS idx_sheets_orden ON sheets(catalog_id, orden);

      CREATE TABLE IF NOT EXISTS catalog_versions (
        id SERIAL PRIMARY KEY,
        catalog_id INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        snapshot_json JSONB NOT NULL, notas_version TEXT,
        published_by INTEGER REFERENCES users(id),
        published_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS catalog_changes (
        id SERIAL PRIMARY KEY,
        catalog_id INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
        version_anterior INTEGER, version_nueva INTEGER,
        tipo_cambio VARCHAR(30) NOT NULL,
        sheet_id INTEGER, detalles_json JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS catalog_assignments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        catalog_id INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, catalog_id)
      );

      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id),
        user_id INTEGER REFERENCES users(id),
        catalog_id INTEGER REFERENCES catalogs(id),
        version_catalog INTEGER,
        status VARCHAR(20) DEFAULT 'draft',
        notas_generales TEXT, duracion_minutos INTEGER,
        lat NUMERIC(10,7), lng NUMERIC(10,7),
        hubo_pedido BOOLEAN DEFAULT FALSE,
        email_enviado_oficina BOOLEAN DEFAULT FALSE,
        email_enviado_cliente VARCHAR(150),
        email_enviado_comercial BOOLEAN DEFAULT FALSE,
        pdf_path VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW(),
        confirmed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id SERIAL PRIMARY KEY,
        visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
        sheet_id INTEGER REFERENCES sheets(id),
        orden_en_visita INTEGER NOT NULL DEFAULT 0,
        texto_libre TEXT NOT NULL,
        tipo VARCHAR(20) DEFAULT 'pedido',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- B5: tabla de union para catalogos Express
      -- Un Express NO duplica laminas: solo guarda referencias al maestro padre.
      -- Si el maestro cambia una imagen/tag, el Express lo refleja automaticamente (espejo en vivo).
      CREATE TABLE IF NOT EXISTS express_sheets (
        id SERIAL PRIMARY KEY,
        express_catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
        sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        orden INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(express_catalog_id, sheet_id)
      );
      CREATE INDEX IF NOT EXISTS idx_express_catalog ON express_sheets(express_catalog_id);
      CREATE INDEX IF NOT EXISTS idx_express_orden ON express_sheets(express_catalog_id, orden);
    `;
    await pool.query(schemaSQL);

    // Crear admin por defecto si no hay usuarios
    const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    if (cnt.rows[0].n === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await pool.query(
        'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)',
        ['f.ayllon66@gmail.com', hash, 'Fernando Ayllon', 'admin']
      );
      console.log('✅ Usuario admin creado: f.ayllon66@gmail.com / admin123');
    }
    console.log('✅ BD inicializada');
  } catch (e) {
    console.error('❌ Error inicializando BD - DETALLE COMPLETO:');
    console.error('  Tipo de error:', typeof e);
    console.error('  Error JSON:', JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
    console.error('  Error toString:', String(e));
    if (e instanceof Error) {
      console.error('  Mensaje:', e.message);
      console.error('  Stack:', e.stack);
    }
    console.error('  DATABASE_URL configurado:', process.env.DATABASE_URL ? 'SI (oculto)' : 'NO - FALTA!');
    throw e;
  }
}

// ============================================================================
// HEALTH
// ============================================================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '2.0.0', service: 'CatalogPRO v2' });
});

// ============================================================================
// AUTH
// ============================================================================
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email y contrasena obligatorios' });
      return;
    }
    const r = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [email]);
    if (r.rows.length === 0) {
      res.status(401).json({ success: false, error: 'Email o contrasena incorrectos' });
      return;
    }
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ success: false, error: 'Email o contrasena incorrectos' });
      return;
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, sage_commercial_code: user.sage_commercial_code },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ success: true, token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// USUARIOS (admin)
// ============================================================================
app.get('/api/users', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query('SELECT id, email, name, role, sage_commercial_code, is_active, created_at FROM users ORDER BY role, name');
    res.json({ success: true, users: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.post('/api/users', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, name, role, sage_commercial_code } = req.body;
    if (!email || !password || !name || !role) {
      res.status(400).json({ success: false, error: 'Faltan campos obligatorios' });
      return;
    }
    if (!['admin','sales'].includes(role)) {
      res.status(400).json({ success: false, error: 'Rol invalido' });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 4 caracteres' });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (email, password_hash, name, role, sage_commercial_code) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, sage_commercial_code, is_active, created_at',
      [email.trim().toLowerCase(), hash, name.trim(), role, sage_commercial_code ? String(sage_commercial_code).trim() : null]
    );
    res.status(201).json({ success: true, user: r.rows[0] });
  } catch (e) {
    const msg = (e as Error).message || '';
    if (msg.includes('duplicate') || msg.includes('users_email_key')) {
      res.status(400).json({ success: false, error: 'Ya existe un usuario con ese email' });
      return;
    }
    res.status(400).json({ success: false, error: msg });
  }
});

// Editar usuario (admin) - nombre, email, rol, codigo Sage, activo
app.put('/api/users/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { name, email, role, sage_commercial_code, is_active } = req.body;
    if (!name || !email || !role) {
      res.status(400).json({ success: false, error: 'Nombre, email y rol son obligatorios' });
      return;
    }
    if (!['admin','sales'].includes(role)) {
      res.status(400).json({ success: false, error: 'Rol invalido' });
      return;
    }
    // No permitir que el admin se quite admin a si mismo
    if (id === req.user!.id && role !== 'admin') {
      res.status(400).json({ success: false, error: 'No puedes quitarte tu propio rol de admin' });
      return;
    }
    const r = await pool.query(
      `UPDATE users SET name=$1, email=$2, role=$3, sage_commercial_code=$4, is_active=$5
       WHERE id=$6 RETURNING id, email, name, role, sage_commercial_code, is_active`,
      [name.trim(), email.trim().toLowerCase(), role, sage_commercial_code ? String(sage_commercial_code).trim() : null, is_active !== false, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Usuario no encontrado' });
      return;
    }
    res.json({ success: true, user: r.rows[0] });
  } catch (e) {
    const msg = (e as Error).message || '';
    if (msg.includes('duplicate') || msg.includes('users_email_key')) {
      res.status(400).json({ success: false, error: 'Ya existe otro usuario con ese email' });
      return;
    }
    res.status(400).json({ success: false, error: msg });
  }
});

// Admin: cambiar contraseña de cualquier usuario
app.put('/api/users/:id/password', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { new_password } = req.body;
    if (!new_password || new_password.length < 4) {
      res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 4 caracteres' });
      return;
    }
    const hash = await bcrypt.hash(new_password, 10);
    const r = await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id, email', [hash, id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Usuario no encontrado' });
      return;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Cualquier usuario: cambiar su propia contraseña (requiere la actual)
app.put('/api/users/me/password', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      res.status(400).json({ success: false, error: 'Contraseña actual y nueva son obligatorias' });
      return;
    }
    if (new_password.length < 4) {
      res.status(400).json({ success: false, error: 'La nueva contraseña debe tener al menos 4 caracteres' });
      return;
    }
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Usuario no encontrado' });
      return;
    }
    const ok = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!ok) {
      res.status(401).json({ success: false, error: 'La contraseña actual no es correcta' });
      return;
    }
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user!.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Cualquier usuario: cambiar su propio codigo Sage
app.put('/api/users/me/sage-code', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { sage_commercial_code } = req.body;
    const valor = sage_commercial_code ? String(sage_commercial_code).trim() : null;
    await pool.query('UPDATE users SET sage_commercial_code=$1 WHERE id=$2', [valor, req.user!.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Eliminar usuario (admin)
app.delete('/api/users/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user!.id) {
      res.status(400).json({ success: false, error: 'No puedes eliminarte a ti mismo' });
      return;
    }
    // Mejor desactivar que eliminar (porque puede tener visitas asociadas)
    const r = await pool.query('UPDATE users SET is_active=FALSE WHERE id=$1 RETURNING id', [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Usuario no encontrado' });
      return;
    }
    res.json({ success: true, mensaje: 'Usuario desactivado (no eliminado, conserva su historial)' });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// CATALOGOS
// ============================================================================
// Listar catalogos visibles por el usuario
app.get('/api/catalogs', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    // Para cada catalogo devolvemos:
    //  - sheet_count: numero de laminas (en sheets para maestro/clon, en express_sheets para express)
    //  - parent_name: nombre del maestro padre (solo si es express, NULL en otros casos)
    let r;
    if (req.user.role === 'admin') {
      r = await pool.query(`
        SELECT c.*,
          CASE
            WHEN c.tipo = 'express' THEN (SELECT COUNT(*)::int FROM express_sheets es WHERE es.express_catalog_id = c.id)
            ELSE (SELECT COUNT(*)::int FROM sheets WHERE catalog_id = c.id AND oculta = FALSE)
          END AS sheet_count,
          (SELECT name FROM catalogs cp WHERE cp.id = c.parent_id) AS parent_name
        FROM catalogs c
        ORDER BY c.updated_at DESC
      `);
    } else {
      r = await pool.query(`
        SELECT c.*,
          CASE
            WHEN c.tipo = 'express' THEN (SELECT COUNT(*)::int FROM express_sheets es WHERE es.express_catalog_id = c.id)
            ELSE (SELECT COUNT(*)::int FROM sheets WHERE catalog_id = c.id AND oculta = FALSE)
          END AS sheet_count,
          (SELECT name FROM catalogs cp WHERE cp.id = c.parent_id) AS parent_name
        FROM catalogs c
        JOIN catalog_assignments ca ON ca.catalog_id = c.id
        WHERE ca.user_id = $1 AND c.estado != 'archivado'
        ORDER BY c.updated_at DESC
      `, [req.user.id]);
    }
    res.json({ success: true, catalogs: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Crear catalogo (maestro o express, solo admin)
// Si es express, parent_id (maestro padre) es OBLIGATORIO.
app.post('/api/catalogs', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, tipo, fecha_caducidad, parent_id } = req.body;
    if (!name || !tipo) {
      res.status(400).json({ success: false, error: 'Nombre y tipo obligatorios' });
      return;
    }
    if (!['maestro','express'].includes(tipo)) {
      res.status(400).json({ success: false, error: 'Tipo invalido (maestro|express)' });
      return;
    }
    // Si es express necesitamos un maestro padre valido
    let parentIdFinal: number | null = null;
    if (tipo === 'express') {
      if (!parent_id) {
        res.status(400).json({ success: false, error: 'Un Express debe colgar de un maestro. Falta parent_id.' });
        return;
      }
      const pad = await pool.query(`SELECT id, tipo FROM catalogs WHERE id = $1`, [Number(parent_id)]);
      if (pad.rows.length === 0) {
        res.status(400).json({ success: false, error: 'El maestro padre indicado no existe' });
        return;
      }
      if (pad.rows[0].tipo !== 'maestro') {
        res.status(400).json({ success: false, error: 'Un Express solo puede colgar de un catalogo de tipo maestro' });
        return;
      }
      parentIdFinal = Number(parent_id);
    }
    const r = await pool.query(
      `INSERT INTO catalogs (name, description, tipo, fecha_caducidad, created_by, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, description || '', tipo, fecha_caducidad || null, req.user!.id, parentIdFinal]
    );
    res.status(201).json({ success: true, catalog: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Ver catalogo + sus laminas
// Si es 'express', las laminas vienen del maestro padre via express_sheets (espejo en vivo).
// Si es 'maestro' o 'clon', vienen de sheets directamente como siempre.
app.get('/api/catalogs/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const c = await pool.query('SELECT * FROM catalogs WHERE id = $1', [id]);
    if (c.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Catalogo no encontrado' });
      return;
    }
    const cat = c.rows[0];

    let sheetsRows;
    if (cat.tipo === 'express') {
      // Laminas a traves de express_sheets, ordenadas por es.orden (orden DENTRO del Express)
      // Si una lamina del maestro fue borrada, la JOIN la deja fuera automaticamente.
      const r = await pool.query(`
        SELECT s.*, es.orden AS orden, es.id AS express_sheet_id
        FROM express_sheets es
        JOIN sheets s ON s.id = es.sheet_id
        WHERE es.express_catalog_id = $1
        ORDER BY es.orden, es.id
      `, [id]);
      sheetsRows = r.rows;
    } else {
      const r = await pool.query(
        'SELECT * FROM sheets WHERE catalog_id = $1 ORDER BY orden, id',
        [id]
      );
      sheetsRows = r.rows;
    }
    res.json({ success: true, catalog: cat, sheets: sheetsRows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// LAMINAS - subir una a una
// ============================================================================
app.post('/api/catalogs/:id/sheets', verifyToken, requireAdmin, upload.single('imagen'), async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    if (!(await assertNotExpress(catalogId, res))) return;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se ha subido ninguna imagen' });
      return;
    }
    // Sacar el orden mas alto + 1
    const maxR = await pool.query('SELECT COALESCE(MAX(orden),0) AS max_orden FROM sheets WHERE catalog_id = $1', [catalogId]);
    const orden = Number(maxR.rows[0].max_orden) + 1;

    const imagenPath = '/uploads/' + req.file.filename;
    const titulo = (req.body.titulo || '').trim() || `Lamina ${orden}`;
    const notas = (req.body.notas || '').trim();
    const tags = (req.body.tags || '').trim();

    const r = await pool.query(
      `INSERT INTO sheets (catalog_id, orden, titulo, notas, imagen_path, tags)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [catalogId, orden, titulo, notas, imagenPath, tags]
    );
    await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);
    res.status(201).json({ success: true, sheet: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Reordenar lamina
app.put('/api/catalogs/:cid/sheets/:sid/order', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { nuevo_orden } = req.body;
    if (typeof nuevo_orden !== 'number') {
      res.status(400).json({ success: false, error: 'nuevo_orden debe ser numero' });
      return;
    }
    await pool.query('UPDATE sheets SET orden = $1 WHERE id = $2 AND catalog_id = $3',
      [nuevo_orden, Number(req.params.sid), Number(req.params.cid)]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Reordenar varias laminas a la vez (drag&drop)
app.put('/api/catalogs/:cid/sheets/reorder', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const catalogId = Number(req.params.cid);
    if (!(await assertNotExpress(catalogId, res))) return;
    const { sheet_ids } = req.body;
    if (!Array.isArray(sheet_ids) || sheet_ids.length === 0) {
      res.status(400).json({ success: false, error: 'sheet_ids debe ser array no vacio' });
      return;
    }
    await client.query('BEGIN');
    // Actualizar orden secuencialmente segun el array recibido
    for (let i = 0; i < sheet_ids.length; i++) {
      const sheetId = Number(sheet_ids[i]);
      await client.query(
        'UPDATE sheets SET orden = $1 WHERE id = $2 AND catalog_id = $3',
        [i + 1, sheetId, catalogId]
      );
    }
    await client.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);
    await client.query('COMMIT');
    res.json({ success: true, reordenadas: sheet_ids.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ success: false, error: (e as Error).message });
  } finally {
    client.release();
  }
});

// Borrar TODAS las laminas de un catalogo (mantiene el catalogo, solo vacia)
// Si es express -> vacia la tabla express_sheets (referencias). NUNCA borra laminas reales del maestro.
// Si es maestro/clon -> borra las laminas reales y sus archivos en disco.
app.delete('/api/catalogs/:cid/sheets/all', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.cid);
    const catInfo = await pool.query('SELECT tipo FROM catalogs WHERE id = $1', [catalogId]);
    if (catInfo.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Catalogo no encontrado' });
      return;
    }
    if (catInfo.rows[0].tipo === 'express') {
      // En un Express solo quitamos las referencias, NO tocamos sheets ni archivos.
      const r = await pool.query('DELETE FROM express_sheets WHERE express_catalog_id = $1', [catalogId]);
      await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);
      res.json({ success: true, eliminadas: r.rowCount, archivos_borrados: 0 });
      return;
    }
    // Maestro/clon: borrado real
    const r = await pool.query('DELETE FROM sheets WHERE catalog_id = $1 RETURNING imagen_path', [catalogId]);
    // Borrar archivos físicos
    let borrados = 0;
    for (const row of r.rows) {
      const filePath = path.join(UPLOADS_DIR, path.basename(row.imagen_path));
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          borrados++;
        }
      } catch (e) {
        console.warn('No se pudo borrar archivo:', filePath, (e as Error).message);
      }
    }
    await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);
    res.json({ success: true, eliminadas: r.rows.length, archivos_borrados: borrados });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// B5 - CATALOGOS EXPRESS (selecciones del maestro, espejo en vivo)
// ============================================================================

// GET laminas DISPONIBLES en el maestro padre que aun NO estan en este Express.
// Sirve para el "selector" del editor Express (panel izquierdo).
// Devuelve tambien las que ya estan, marcadas con ya_en_express=true.
app.get('/api/catalogs/:id/master-sheets', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const expressId = Number(req.params.id);
    // Verificar que es express y obtener parent_id
    const c = await pool.query(`SELECT id, tipo, parent_id, name FROM catalogs WHERE id = $1`, [expressId]);
    if (c.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Catalogo no encontrado' });
      return;
    }
    if (c.rows[0].tipo !== 'express') {
      res.status(400).json({ success: false, error: 'Este endpoint solo aplica a catalogos Express' });
      return;
    }
    if (!c.rows[0].parent_id) {
      res.status(400).json({ success: false, error: 'Este Express no tiene maestro padre asignado' });
      return;
    }
    // Todas las laminas del maestro, con flag de si ya estan en este Express
    const r = await pool.query(`
      SELECT s.*,
        EXISTS(SELECT 1 FROM express_sheets es WHERE es.express_catalog_id = $1 AND es.sheet_id = s.id) AS ya_en_express
      FROM sheets s
      WHERE s.catalog_id = $2 AND s.oculta = FALSE
      ORDER BY s.orden, s.id
    `, [expressId, c.rows[0].parent_id]);
    res.json({ success: true, parent_id: c.rows[0].parent_id, sheets: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST anadir varias laminas del maestro al Express
// Body: { sheet_ids: [12, 34, 56] }
// Las añade al final, respetando el orden actual de express_sheets.
app.post('/api/catalogs/:id/express-sheets', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const expressId = Number(req.params.id);
    const { sheet_ids } = req.body;
    if (!Array.isArray(sheet_ids) || sheet_ids.length === 0) {
      res.status(400).json({ success: false, error: 'sheet_ids debe ser un array no vacio' });
      return;
    }
    // Verificar que el catalogo es express
    const c = await client.query(`SELECT tipo, parent_id FROM catalogs WHERE id = $1`, [expressId]);
    if (c.rows.length === 0 || c.rows[0].tipo !== 'express') {
      res.status(400).json({ success: false, error: 'Solo aplicable a catalogos Express' });
      return;
    }
    const parentId = c.rows[0].parent_id;
    if (!parentId) {
      res.status(400).json({ success: false, error: 'Express sin maestro padre' });
      return;
    }
    // Filtrar: solo aceptamos sheet_ids que SI pertenecen al maestro padre
    const validSheets = await client.query(
      `SELECT id FROM sheets WHERE catalog_id = $1 AND id = ANY($2::int[])`,
      [parentId, sheet_ids.map((x: any) => Number(x))]
    );
    const validIds = validSheets.rows.map((r: any) => r.id);
    if (validIds.length === 0) {
      res.status(400).json({ success: false, error: 'Ninguna lamina valida del maestro padre' });
      return;
    }
    await client.query('BEGIN');
    // Orden actual maximo
    const maxR = await client.query(
      `SELECT COALESCE(MAX(orden),0) AS m FROM express_sheets WHERE express_catalog_id = $1`,
      [expressId]
    );
    let nextOrden = Number(maxR.rows[0].m) + 1;
    let anadidas = 0;
    for (const sid of validIds) {
      const ins = await client.query(
        `INSERT INTO express_sheets (express_catalog_id, sheet_id, orden)
         VALUES ($1, $2, $3)
         ON CONFLICT (express_catalog_id, sheet_id) DO NOTHING`,
        [expressId, sid, nextOrden]
      );
      if (ins.rowCount && ins.rowCount > 0) {
        nextOrden++;
        anadidas++;
      }
    }
    await client.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [expressId]);
    await client.query('COMMIT');
    res.json({ success: true, anadidas });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ success: false, error: (e as Error).message });
  } finally {
    client.release();
  }
});

// DELETE quitar una lamina del Express (NO borra la lamina real del maestro)
app.delete('/api/catalogs/:cid/express-sheets/:sid', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const expressId = Number(req.params.cid);
    const sheetId = Number(req.params.sid);
    const r = await pool.query(
      `DELETE FROM express_sheets WHERE express_catalog_id = $1 AND sheet_id = $2 RETURNING id`,
      [expressId, sheetId]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Esta lamina no estaba en el Express' });
      return;
    }
    await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [expressId]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// PUT reordenar laminas dentro del Express (drag&drop)
// Body: { sheet_ids: [12,34,56] }  -> ese sera el orden final
app.put('/api/catalogs/:cid/express-sheets/reorder', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const expressId = Number(req.params.cid);
    const { sheet_ids } = req.body;
    if (!Array.isArray(sheet_ids)) {
      res.status(400).json({ success: false, error: 'sheet_ids debe ser un array' });
      return;
    }
    await client.query('BEGIN');
    for (let i = 0; i < sheet_ids.length; i++) {
      await client.query(
        `UPDATE express_sheets SET orden = $1 WHERE express_catalog_id = $2 AND sheet_id = $3`,
        [i + 1, expressId, Number(sheet_ids[i])]
      );
    }
    await client.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [expressId]);
    await client.query('COMMIT');
    res.json({ success: true, reordenadas: sheet_ids.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ success: false, error: (e as Error).message });
  } finally {
    client.release();
  }
});

// Editar lamina (titulo/notas/tags - sin tocar imagen)
app.put('/api/sheets/:id', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { titulo, notas, tags, enlace_externo_url, enlace_externo_titulo } = req.body;
    const r = await pool.query(
      `UPDATE sheets SET titulo=$1, notas=$2, tags=$3, enlace_externo_url=$4, enlace_externo_titulo=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [titulo, notas, tags, enlace_externo_url || null, enlace_externo_titulo || null, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    res.json({ success: true, sheet: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Sustituir imagen de lamina (sin perder orden ni datos)
app.put('/api/sheets/:id/image', verifyToken, requireAdmin, upload.single('imagen'), async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se ha subido ninguna imagen' });
      return;
    }
    const nuevoPath = '/uploads/' + req.file.filename;
    const r = await pool.query(
      `UPDATE sheets SET imagen_path=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [nuevoPath, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    res.json({ success: true, sheet: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Eliminar lamina
app.delete('/api/sheets/:id', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('DELETE FROM sheets WHERE id = $1 RETURNING *', [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// ASIGNACIONES de catalogos a comerciales
// ============================================================================

// Ver quien tiene asignado este catalogo
app.get('/api/catalogs/:id/assignments', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    const r = await pool.query(`
      SELECT u.id, u.name, u.email, u.role, u.sage_commercial_code, u.is_active,
             ca.id AS assignment_id, ca.assigned_at
      FROM users u
      LEFT JOIN catalog_assignments ca ON ca.user_id = u.id AND ca.catalog_id = $1
      WHERE u.role = 'sales' OR u.role = 'admin'
      ORDER BY u.role DESC, u.name
    `, [catalogId]);
    res.json({ success: true, users: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Asignar catalogo a usuario
app.post('/api/catalogs/:id/assignments', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    const { user_id } = req.body;
    if (!user_id) {
      res.status(400).json({ success: false, error: 'user_id obligatorio' });
      return;
    }
    await pool.query(
      `INSERT INTO catalog_assignments (user_id, catalog_id) VALUES ($1, $2)
       ON CONFLICT (user_id, catalog_id) DO NOTHING`,
      [Number(user_id), catalogId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Desasignar catalogo de usuario
app.delete('/api/catalogs/:cid/assignments/:uid', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.cid);
    const userId = Number(req.params.uid);
    await pool.query(
      'DELETE FROM catalog_assignments WHERE catalog_id = $1 AND user_id = $2',
      [catalogId, userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// LAMINAS - subir PDF entero y trocear en laminas
// ============================================================================
const uploadPdf = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('Solo se aceptan archivos PDF'));
      return;
    }
    cb(null, true);
  }
});

app.post('/api/catalogs/:id/sheets/from-pdf', verifyToken, requireAdmin, uploadPdf.single('pdf'), async (req: AuthRequest, res: Response) => {
  let pdfPath: string | null = null;
  try {
    const catalogId = Number(req.params.id);
    if (!(await assertNotExpress(catalogId, res))) return;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se ha subido ningun PDF' });
      return;
    }
    pdfPath = req.file.path;
    console.log(`[PDF] Procesando PDF: ${pdfPath}`);

    // Verificar que pdftoppm esta disponible
    try {
      await execAsync('which pdftoppm');
    } catch (e) {
      res.status(500).json({ success: false, error: 'pdftoppm (poppler-utils) no esta instalado en el servidor' });
      return;
    }

    // Sacar el orden actual mas alto para que las nuevas laminas vayan despues
    const maxR = await pool.query('SELECT COALESCE(MAX(orden),0) AS max_orden FROM sheets WHERE catalog_id = $1', [catalogId]);
    let ordenSiguiente = Number(maxR.rows[0].max_orden) + 1;

    // Trocear el PDF con pdftoppm
    // Sale: prefix-001.jpg, prefix-002.jpg, etc.
    const prefix = path.join(UPLOADS_DIR, `pdf_${Date.now()}`);
    const cmd = `pdftoppm -jpeg -jpegopt quality=88 -r 250 "${pdfPath}" "${prefix}"`;
    console.log(`[PDF] Ejecutando: ${cmd}`);
    await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });

    // Buscar los JPGs generados
    const baseName = path.basename(prefix);
    const archivos = fs.readdirSync(UPLOADS_DIR)
      .filter(f => f.startsWith(baseName + '-') && f.endsWith('.jpg'))
      .sort();

    if (archivos.length === 0) {
      res.status(500).json({ success: false, error: 'No se generaron paginas del PDF. Posiblemente este corrupto.' });
      return;
    }

    console.log(`[PDF] ${archivos.length} paginas generadas`);

    // Insertar cada pagina como una lamina en BD
    const laminasCreadas = [];
    for (let i = 0; i < archivos.length; i++) {
      const archivo = archivos[i];
      const imagenPath = '/uploads/' + archivo;
      const titulo = `Lamina ${ordenSiguiente}`;
      const r = await pool.query(
        `INSERT INTO sheets (catalog_id, orden, titulo, imagen_path)
         VALUES ($1,$2,$3,$4) RETURNING id, orden, titulo, imagen_path`,
        [catalogId, ordenSiguiente, titulo, imagenPath]
      );
      laminasCreadas.push(r.rows[0]);
      ordenSiguiente++;
    }

    // Borrar el PDF original (ya no nos sirve)
    try {
      if (pdfPath) fs.unlinkSync(pdfPath);
    } catch (e) {
      console.warn('No se pudo borrar PDF temporal:', (e as Error).message);
    }

    await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);

    res.status(201).json({
      success: true,
      message: `${laminasCreadas.length} laminas creadas correctamente`,
      laminas_creadas: laminasCreadas.length,
      sheets: laminasCreadas
    });
  } catch (e) {
    console.error('[PDF] Error:', e);
    // Intentar borrar el PDF si quedo
    if (pdfPath) {
      try { fs.unlinkSync(pdfPath); } catch {}
    }
    res.status(500).json({ success: false, error: (e as Error).message || 'Error procesando PDF' });
  }
});

// ============================================================================
// CLIENTES
// ============================================================================
import * as XLSX from 'xlsx';

// Listar clientes (paginado + busqueda + filtro por comercial)
app.get('/api/clients', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const commercial = String(req.query.commercial || '').trim();
    const activeOnly = req.query.active === '1' || req.query.active === 'true';

    const whereParts: string[] = [];
    const params: any[] = [];

    // Sales solo ven los suyos
    if (req.user!.role === 'sales' && req.user!.sage_commercial_code) {
      whereParts.push(`commercial_code = $${params.length + 1}`);
      params.push(req.user!.sage_commercial_code);
    } else if (commercial) {
      whereParts.push(`commercial_code = $${params.length + 1}`);
      params.push(commercial);
    }

    if (activeOnly) {
      whereParts.push('is_active = TRUE');
    }

    if (search) {
      whereParts.push(`(razon_social ILIKE $${params.length + 1} OR sage_code ILIKE $${params.length + 1} OR cif ILIKE $${params.length + 1} OR municipio ILIKE $${params.length + 1})`);
      params.push('%' + search + '%');
    }

    const whereSQL = whereParts.length > 0 ? 'WHERE ' + whereParts.join(' AND ') : '';
    const countR = await pool.query(`SELECT COUNT(*)::int AS total FROM clients ${whereSQL}`, params);
    const total = countR.rows[0].total;

    const r = await pool.query(
      `SELECT * FROM clients ${whereSQL} ORDER BY razon_social LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ success: true, clients: r.rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Ver detalle de un cliente
app.get('/api/clients/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const id = Number(req.params.id);
    const r = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Cliente no encontrado' });
      return;
    }
    // Historial de visitas del cliente (las ultimas 20).
    // Admin ve todas, comercial (incluido admin impersonando) solo las suyas.
    let visitasQuery, visitasParams;
    if (req.user.role === 'admin') {
      visitasQuery = `
        SELECT v.id, v.client_id, v.user_id, v.catalog_id, v.status, v.hubo_pedido,
               v.notas_generales, v.created_at, v.confirmed_at,
               u.name AS comercial_nombre,
               c.name AS catalog_nombre,
               (SELECT COUNT(*)::int FROM annotations a WHERE a.visit_id = v.id) AS num_anotaciones
        FROM visits v
        LEFT JOIN users u ON u.id = v.user_id
        LEFT JOIN catalogs c ON c.id = v.catalog_id
        WHERE v.client_id = $1
        ORDER BY v.created_at DESC
        LIMIT 20
      `;
      visitasParams = [id];
    } else {
      visitasQuery = `
        SELECT v.id, v.client_id, v.user_id, v.catalog_id, v.status, v.hubo_pedido,
               v.notas_generales, v.created_at, v.confirmed_at,
               u.name AS comercial_nombre,
               c.name AS catalog_nombre,
               (SELECT COUNT(*)::int FROM annotations a WHERE a.visit_id = v.id) AS num_anotaciones
        FROM visits v
        LEFT JOIN users u ON u.id = v.user_id
        LEFT JOIN catalogs c ON c.id = v.catalog_id
        WHERE v.client_id = $1 AND v.user_id = $2
        ORDER BY v.created_at DESC
        LIMIT 20
      `;
      visitasParams = [id, req.user.id];
    }
    const visitas = await pool.query(visitasQuery, visitasParams);
    res.json({ success: true, client: r.rows[0], visitas: visitas.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Importar clientes desde Excel de Sage (admin)
const uploadExcel = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      cb(new Error('Solo se aceptan archivos Excel (.xlsx o .xls)'));
      return;
    }
    cb(null, true);
  }
});

app.post('/api/clients/import-sage', verifyToken, requireAdmin, uploadExcel.single('excel'), async (req: AuthRequest, res: Response) => {
  let filePath: string | null = null;
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se ha subido ningun Excel' });
      return;
    }
    filePath = req.file.path;
    console.log(`[IMPORT] Procesando Excel: ${filePath}`);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rows.length < 2) {
      res.status(400).json({ success: false, error: 'Excel vacio o sin datos' });
      return;
    }

    // Validar cabecera
    const header = rows[0].map((h: any) => String(h).trim().toLowerCase());
    const expectedCols = ['cód. cliente', 'razón social', 'cif/dni', 'deleg.', 'teléfono', 'municipio', 'provincia', 'comercial asig.', 'cód. contable', 'categoría', 'correo electrónico1'];
    let cabeceraOk = true;
    for (let i = 0; i < expectedCols.length; i++) {
      if (!header[i] || !header[i].includes(expectedCols[i].split('.')[0].split(' ')[0])) {
        // permisivo: si la primera palabra coincide, ok
      }
    }
    // No validamos estrictamente, solo avisamos
    console.log(`[IMPORT] Cabecera leida: ${header.join(' | ')}`);

    let nuevos = 0;
    let actualizados = 0;
    let dadosBaja = 0;
    let ignorados = 0;
    let errores = 0;
    const erroresList: string[] = [];

    // Procesar cada fila
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      try {
        const sage_code = String(row[0] || '').trim();
        const razon_social_raw = String(row[1] || '').trim();
        const cif = String(row[2] || '').trim() || null;
        // const deleg = String(row[3] || '').trim();
        const telefono = String(row[4] || '').trim() || null;
        const municipio = String(row[5] || '').trim() || null;
        const provincia = String(row[6] || '').trim() || null;
        const commercial_code = String(row[7] || '').trim() || null;
        // const cod_contable = String(row[8] || '').trim();
        const categoria = String(row[9] || '').trim() || null;
        const email = String(row[10] || '').trim() || null;

        // Ignorar filas vacias o "CLIENTES VARIOS"
        if (!sage_code || !razon_social_raw || razon_social_raw.toUpperCase().includes('CLIENTES VARIOS')) {
          ignorados++;
          continue;
        }

        // Detectar BAJA-
        let is_active = true;
        let razon_social = razon_social_raw;
        const upper = razon_social_raw.toUpperCase();
        if (upper.startsWith('BAJA-') || upper.startsWith('BAJA -') || upper.startsWith('BAJA ')) {
          is_active = false;
          razon_social = razon_social_raw.replace(/^BAJA\s*-?\s*/i, '').trim();
          dadosBaja++;
        }

        // INSERT o UPDATE (por sage_code)
        const existe = await pool.query('SELECT id FROM clients WHERE sage_code = $1', [sage_code]);
        if (existe.rows.length > 0) {
          // UPDATE
          await pool.query(
            `UPDATE clients SET
              razon_social = $1, cif = $2, telefono = $3,
              municipio = $4, provincia = $5, commercial_code = $6,
              categoria = $7, email = $8, is_active = $9, updated_at = NOW()
             WHERE sage_code = $10`,
            [razon_social, cif, telefono, municipio, provincia, commercial_code, categoria, email, is_active, sage_code]
          );
          actualizados++;
        } else {
          // INSERT
          await pool.query(
            `INSERT INTO clients
              (sage_code, razon_social, cif, telefono, municipio, provincia, commercial_code, categoria, email, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [sage_code, razon_social, cif, telefono, municipio, provincia, commercial_code, categoria, email, is_active]
          );
          nuevos++;
        }
      } catch (e) {
        errores++;
        if (erroresList.length < 10) {
          erroresList.push(`Fila ${i + 1}: ${(e as Error).message}`);
        }
      }
    }

    // Borrar el Excel temporal
    try { if (filePath) fs.unlinkSync(filePath); } catch {}

    const total_en_bd = (await pool.query('SELECT COUNT(*)::int AS n FROM clients')).rows[0].n;

    res.json({
      success: true,
      mensaje: `Importacion completada`,
      nuevos,
      actualizados,
      dados_de_baja: dadosBaja,
      ignorados,
      errores,
      errores_detalle: erroresList,
      total_en_bd
    });
  } catch (e) {
    console.error('[IMPORT] Error:', e);
    if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
    res.status(500).json({ success: false, error: (e as Error).message || 'Error importando Excel' });
  }
});

// ============================================================================
// B6 - VISITAS Y ANOTACIONES (pedidos durante visita comercial)
// ============================================================================
// Concepto: una visita es UN comercial visitando UN cliente con UN catalogo.
// Mientras dura, el comercial puede escribir anotaciones (= items pedidos / notas)
// asociadas a una lamina concreta. Cuando termina, "confirma" la visita.
//
// Reglas:
//  - Solo puede tener UNA visita en estado 'draft' por (comercial, cliente) a la vez.
//    Si ya existe, devolvemos esa misma para continuarla.
//  - Comerciales solo ven SUS propias visitas. Admin REAL ve todas. Admin
//    impersonando ve las del comercial impersonado (rol efectivo = sales).
//  - Cuando se confirma, marcamos confirmed_at y hubo_pedido segun anotaciones tipo='pedido'.

// Helper: averiguar el user_id "efectivo" (admin impersonando -> el comercial)
function effectiveUserId(req: AuthRequest): number {
  return req.user!.id;
}

// Helper: determinar si el rol efectivo es comercial
function isEffectiveSales(req: AuthRequest): boolean {
  return req.user!.role === 'sales';
}

// POST iniciar visita (o continuar la existente)
// Body: { client_id, catalog_id }
app.post('/api/visits/start', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { client_id, catalog_id } = req.body;
    if (!client_id || !catalog_id) {
      res.status(400).json({ success: false, error: 'client_id y catalog_id obligatorios' });
      return;
    }
    const userId = effectiveUserId(req);
    // Buscar visita draft existente para este (user, client)
    const existing = await pool.query(
      `SELECT * FROM visits WHERE user_id = $1 AND client_id = $2 AND status = 'draft' ORDER BY created_at DESC LIMIT 1`,
      [userId, Number(client_id)]
    );
    if (existing.rows.length > 0) {
      // Si el catalogo cambia, lo actualizamos (el comercial puede haber abierto otro)
      if (existing.rows[0].catalog_id !== Number(catalog_id)) {
        await pool.query(`UPDATE visits SET catalog_id = $1 WHERE id = $2`, [Number(catalog_id), existing.rows[0].id]);
        existing.rows[0].catalog_id = Number(catalog_id);
      }
      res.json({ success: true, visit: existing.rows[0], continued: true });
      return;
    }
    // Crear nueva
    const cat = await pool.query(`SELECT version FROM catalogs WHERE id = $1`, [Number(catalog_id)]);
    const versionCat = cat.rows[0]?.version || 1;
    const r = await pool.query(
      `INSERT INTO visits (client_id, user_id, catalog_id, version_catalog, status)
       VALUES ($1, $2, $3, $4, 'draft') RETURNING *`,
      [Number(client_id), userId, Number(catalog_id), versionCat]
    );
    // Actualizar ultima_visita_at del cliente
    await pool.query(`UPDATE clients SET ultima_visita_at = NOW() WHERE id = $1`, [Number(client_id)]);
    res.json({ success: true, visit: r.rows[0], continued: false });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// GET visita actual (draft) del usuario - si existe
app.get('/api/visits/current', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = effectiveUserId(req);
    const r = await pool.query(
      `SELECT v.*, c.razon_social AS cliente_nombre, cat.name AS catalog_nombre
       FROM visits v
       LEFT JOIN clients c ON c.id = v.client_id
       LEFT JOIN catalogs cat ON cat.id = v.catalog_id
       WHERE v.user_id = $1 AND v.status = 'draft'
       ORDER BY v.created_at DESC LIMIT 1`,
      [userId]
    );
    res.json({ success: true, visit: r.rows[0] || null });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET una visita concreta + sus anotaciones
app.get('/api/visits/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const v = await pool.query(`
      SELECT v.*, c.razon_social AS cliente_nombre, cat.name AS catalog_nombre, u.name AS comercial_nombre
      FROM visits v
      LEFT JOIN clients c ON c.id = v.client_id
      LEFT JOIN catalogs cat ON cat.id = v.catalog_id
      LEFT JOIN users u ON u.id = v.user_id
      WHERE v.id = $1`, [id]);
    if (v.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    // Comercial solo ve las suyas (admin REAL ve todas)
    if (isEffectiveSales(req) && v.rows[0].user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    // Cargar anotaciones con datos de la lamina
    const anots = await pool.query(`
      SELECT a.*, s.titulo AS sheet_titulo, s.imagen_path AS sheet_imagen, s.orden AS sheet_orden
      FROM annotations a
      LEFT JOIN sheets s ON s.id = a.sheet_id
      WHERE a.visit_id = $1
      ORDER BY a.orden_en_visita, a.id`, [id]);
    res.json({ success: true, visit: v.rows[0], annotations: anots.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST anotar una lamina dentro de una visita
// Body: { sheet_id, texto_libre, tipo? }  tipo: 'pedido' (default), 'devolucion' o 'nota'
app.post('/api/visits/:id/annotations', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const visitId = Number(req.params.id);
    const userId = effectiveUserId(req);
    const { sheet_id, texto_libre, tipo } = req.body;
    if (!texto_libre || !String(texto_libre).trim()) {
      res.status(400).json({ success: false, error: 'texto_libre obligatorio' });
      return;
    }
    const tipoFinal = ['pedido','devolucion','nota'].includes(tipo) ? tipo : 'pedido';
    // Comprobar permiso sobre la visita
    const v = await pool.query(`SELECT user_id, status FROM visits WHERE id = $1`, [visitId]);
    if (v.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    if (isEffectiveSales(req) && v.rows[0].user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    if (v.rows[0].status !== 'draft') {
      res.status(400).json({ success: false, error: 'No se pueden añadir anotaciones a una visita ya confirmada' });
      return;
    }
    // Orden: max+1
    const maxR = await pool.query(
      `SELECT COALESCE(MAX(orden_en_visita),0) AS m FROM annotations WHERE visit_id = $1`,
      [visitId]
    );
    const orden = Number(maxR.rows[0].m) + 1;
    const r = await pool.query(
      `INSERT INTO annotations (visit_id, sheet_id, orden_en_visita, texto_libre, tipo)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [visitId, sheet_id ? Number(sheet_id) : null, orden, String(texto_libre).trim(), tipoFinal]
    );
    res.json({ success: true, annotation: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// PUT editar texto de una anotacion
app.put('/api/annotations/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const { texto_libre, tipo } = req.body;
    if (!texto_libre || !String(texto_libre).trim()) {
      res.status(400).json({ success: false, error: 'texto_libre obligatorio' });
      return;
    }
    // Check ownership via visit
    const a = await pool.query(`
      SELECT a.*, v.user_id AS visit_user, v.status AS visit_status
      FROM annotations a JOIN visits v ON v.id = a.visit_id WHERE a.id = $1`, [id]);
    if (a.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Anotación no encontrada' });
      return;
    }
    if (isEffectiveSales(req) && a.rows[0].visit_user !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta anotación' });
      return;
    }
    if (a.rows[0].visit_status !== 'draft') {
      res.status(400).json({ success: false, error: 'No se pueden editar anotaciones de una visita confirmada' });
      return;
    }
    const tipoFinal = ['pedido','devolucion','nota'].includes(tipo) ? tipo : a.rows[0].tipo;
    const r = await pool.query(
      `UPDATE annotations SET texto_libre = $1, tipo = $2 WHERE id = $3 RETURNING *`,
      [String(texto_libre).trim(), tipoFinal, id]
    );
    res.json({ success: true, annotation: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// DELETE quitar una anotacion
app.delete('/api/annotations/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const a = await pool.query(`
      SELECT a.id, v.user_id AS visit_user, v.status AS visit_status
      FROM annotations a JOIN visits v ON v.id = a.visit_id WHERE a.id = $1`, [id]);
    if (a.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Anotación no encontrada' });
      return;
    }
    if (isEffectiveSales(req) && a.rows[0].visit_user !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta anotación' });
      return;
    }
    if (a.rows[0].visit_status !== 'draft') {
      res.status(400).json({ success: false, error: 'No se pueden borrar anotaciones de una visita confirmada' });
      return;
    }
    await pool.query(`DELETE FROM annotations WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// POST cerrar / confirmar visita
// Body: { notas_generales? }
app.post('/api/visits/:id/confirm', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const { notas_generales } = req.body;
    const v = await pool.query(`SELECT * FROM visits WHERE id = $1`, [id]);
    if (v.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    if (isEffectiveSales(req) && v.rows[0].user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    if (v.rows[0].status !== 'draft') {
      res.status(400).json({ success: false, error: 'La visita ya estaba confirmada' });
      return;
    }
    const huboPedido = await pool.query(
      `SELECT COUNT(*)::int AS n FROM annotations WHERE visit_id = $1 AND tipo IN ('pedido','devolucion')`,
      [id]
    );
    const r = await pool.query(
      `UPDATE visits SET status = 'confirmed', confirmed_at = NOW(),
       notas_generales = $1, hubo_pedido = $2 WHERE id = $3 RETURNING *`,
      [notas_generales ? String(notas_generales).trim() : null, huboPedido.rows[0].n > 0, id]
    );
    // Actualizar ultima_visita_at del cliente
    await pool.query(`UPDATE clients SET ultima_visita_at = NOW() WHERE id = $1`, [r.rows[0].client_id]);
    res.json({ success: true, visit: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// POST descartar visita en draft (sin confirmar - la borra)
app.post('/api/visits/:id/discard', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const v = await pool.query(`SELECT * FROM visits WHERE id = $1`, [id]);
    if (v.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    if (isEffectiveSales(req) && v.rows[0].user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    if (v.rows[0].status !== 'draft') {
      res.status(400).json({ success: false, error: 'Solo se pueden descartar visitas en borrador' });
      return;
    }
    await pool.query(`DELETE FROM visits WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// FRONTEND FALLBACK
// ============================================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ============================================================================
// ARRANQUE
// ============================================================================
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CatalogPRO v2 escuchando en puerto ${PORT}`);
  });
}).catch(e => {
  console.error('❌ Error fatal al arrancar - DETALLE COMPLETO:');
  console.error('  Tipo:', typeof e);
  console.error('  Error JSON:', JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
  console.error('  toString:', String(e));
  if (e instanceof Error) {
    console.error('  Mensaje:', e.message);
    console.error('  Stack:', e.stack);
  }
  process.exit(1);
});
