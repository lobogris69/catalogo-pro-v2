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
    const cmd = `pdftoppm -jpeg -r 150 "${pdfPath}" "${prefix}"`;
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
    const id = Number(req.params.id);
    const r = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Cliente no encontrado' });
      return;
    }
    res.json({ success: true, client: r.rows[0] });
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
