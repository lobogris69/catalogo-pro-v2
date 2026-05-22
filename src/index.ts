import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

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
    next();
  } catch (e) {
    res.status(401).json({ success: false, error: 'Token invalido o caducado' });
  }
}

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Solo admin' });
    return;
  }
  next();
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
    console.error('❌ Error inicializando BD:', (e as Error).message);
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
    const r = await pool.query('SELECT id, email, name, role, sage_commercial_code, is_active, created_at FROM users ORDER BY created_at');
    res.json({ success: true, users: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.post('/api/users', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
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
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (email, password_hash, name, role, sage_commercial_code) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, sage_commercial_code',
      [email, hash, name, role, sage_commercial_code || null]
    );
    res.status(201).json({ success: true, user: r.rows[0] });
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
    let r;
    if (req.user.role === 'admin') {
      r = await pool.query(`
        SELECT c.*, (SELECT COUNT(*)::int FROM sheets WHERE catalog_id = c.id AND oculta = FALSE) AS sheet_count
        FROM catalogs c
        ORDER BY c.updated_at DESC
      `);
    } else {
      r = await pool.query(`
        SELECT c.*, (SELECT COUNT(*)::int FROM sheets WHERE catalog_id = c.id AND oculta = FALSE) AS sheet_count
        FROM catalogs c
        JOIN catalog_assignments ca ON ca.catalog_id = c.id
        WHERE ca.user_id = $1 AND c.estado = 'publicado'
        ORDER BY c.updated_at DESC
      `, [req.user.id]);
    }
    res.json({ success: true, catalogs: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Crear catalogo (maestro o express, solo admin)
app.post('/api/catalogs', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, tipo, fecha_caducidad } = req.body;
    if (!name || !tipo) {
      res.status(400).json({ success: false, error: 'Nombre y tipo obligatorios' });
      return;
    }
    if (!['maestro','express'].includes(tipo)) {
      res.status(400).json({ success: false, error: 'Tipo invalido (maestro|express)' });
      return;
    }
    const r = await pool.query(
      `INSERT INTO catalogs (name, description, tipo, fecha_caducidad, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, description || '', tipo, fecha_caducidad || null, req.user!.id]
    );
    res.status(201).json({ success: true, catalog: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Ver catalogo + sus laminas
app.get('/api/catalogs/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const c = await pool.query('SELECT * FROM catalogs WHERE id = $1', [id]);
    if (c.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Catalogo no encontrado' });
      return;
    }
    const sheets = await pool.query(
      'SELECT * FROM sheets WHERE catalog_id = $1 ORDER BY orden, id',
      [id]
    );
    res.json({ success: true, catalog: c.rows[0], sheets: sheets.rows });
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
  console.error('❌ Error fatal al arrancar:', e.message);
  process.exit(1);
});
