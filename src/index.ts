import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import sharp from 'sharp';
import {
  getMegaStorage,
  ensureFolder,
  uploadFileBuffer,
  shareFolderLink,
  sanitizeName,
  nombreCarpetaCatalogo,
  nombreLaminaOrdenada,
  debugCredenciales,
  invalidarSesionMega,
  ROOT_FOLDER,
  COMERCIALES_FOLDER,
  GENERAL_FOLDER
} from './mega';
import { generarTagsIA, resolverRutaImagen } from './ai-tags';
import { detectarZonasIA, ultimoErrorIA, refinarRecuadroPrecio, detectarPreciosIA } from './ai-zones';
import { parseExcelTabla, computarTabla, renderTablaExpositor, resumenExcel } from './expositor-tablas';

// ============================================================================
// AI-TAGS - dispara generacion en background y hace UPDATE cuando esta listo.
// No lanza. No bloquea la respuesta HTTP.
// ============================================================================
function generarTagsBackground(sheetId: number, imagenPathAbs: string, titulo: string | null): void {
  setImmediate(async () => {
    try {
      const tags = await generarTagsIA(imagenPathAbs, titulo);
      if (!tags) return;
      // Solo escribir si la lamina sigue existiendo y no tiene tags puestos a mano
      await pool.query(
        `UPDATE sheets SET tags = $1, updated_at = NOW()
         WHERE id = $2 AND (tags IS NULL OR tags = '')`,
        [tags, sheetId]
      );
    } catch (e: any) {
      console.warn('[ai-tags-bg] fallo para sheet ' + sheetId + ':', e?.message || e);
    }
  });
}

const execAsync = promisify(exec);

dotenv.config();

// ============================================================================
// CONFIGURACION
// ============================================================================
const app = express();
// Railway esta detras de un proxy. Confiar en X-Forwarded-For (1 hop) para
// que req.ip devuelva la IP real del cliente (necesario para rate-limit).
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-este-secreto-en-produccion';
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/data/uploads';
const FRONTEND_DIR = path.join(__dirname, 'public');

// Crear directorio de uploads si no existe
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
// Carpeta dedicada a miniaturas (~400px WebP) generadas con sharp
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbs');
if (!fs.existsSync(THUMBS_DIR)) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
}

// ============================================================================
// MINIATURAS (sharp) - se usan en listas/mosaicos. El PNG original se mantiene
// intacto para el visor a pantalla completa donde se necesita maxima calidad.
// ============================================================================
// Borra un archivo de /uploads/ de forma segura (no lanza si no existe o falla).
// Acepta tanto rutas web ("/uploads/abc.jpg") como solo el filename.
function borrarUploadSeguro(rutaWeb: string | null | undefined): void {
  if (!rutaWeb) return;
  try {
    let rel = String(rutaWeb);
    if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
    else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
    const abs = path.join(UPLOADS_DIR, rel);
    // Sanity check: que el path resuelto este DENTRO de UPLOADS_DIR (evitar ../../etc/passwd)
    if (!abs.startsWith(UPLOADS_DIR)) return;
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) {
    console.warn('[borrarUploadSeguro] falla borrando ' + rutaWeb + ':', (e as Error).message);
  }
}

// ============================================================================
// AUDIT LOG de laminas (no lanza si falla; nunca debe romper la operacion)
// tipo_cambio: 'created' | 'updated_image' | 'updated_meta' | 'deleted'
// ============================================================================
type TipoCambioSheet = 'created' | 'updated_image' | 'updated_meta' | 'deleted'
  | 'updated_zonas' | 'updated_precios' | 'updated_tablas';

async function logSheetChange(
  tipoCambio: TipoCambioSheet,
  sheetId: number | null,
  catalogId: number | null,
  titulo: string | null,
  campos: any,
  actor: { id?: number; name?: string } | null
): Promise<void> {
  try {
    // Traer nombre del catalogo para el snapshot (util cuando la lamina
    // se borra: el catalog_name queda registrado para el email de resumen).
    let catalogName: string | null = null;
    if (catalogId) {
      const c = await pool.query('SELECT name FROM catalogs WHERE id = $1', [catalogId]);
      catalogName = c.rows[0]?.name || null;
    }
    await pool.query(
      `INSERT INTO sheet_audit_log
         (sheet_id, catalog_id, catalog_name, titulo, tipo_cambio, campos_json, actor_id, actor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        sheetId,
        catalogId,
        catalogName,
        titulo ? String(titulo).substring(0, 255) : null,
        tipoCambio,
        campos ? JSON.stringify(campos) : null,
        actor?.id || null,
        actor?.name || null
      ]
    );
  } catch (e: any) {
    console.warn('[audit-log] no se pudo registrar cambio:', e.message);
  }
}

// Trabajar las zonas de una lamina son DECENAS de peticiones (arrastrar un recuadro
// son varias, y una deteccion con IA otras tantas). Si cada una dejara su linea, el
// historial no habria quien lo leyera. Asi que los cambios del mismo tipo sobre la
// misma lamina se AGRUPAN en una sola linea mientras sigas trabajando en ella: se le
// refresca la fecha y se le suma un contador. Pasada la ventana, empieza linea nueva.
const VENTANA_AGRUPAR_MIN = 30;

async function logSheetChangeAgrupado(
  tipoCambio: 'updated_zonas' | 'updated_precios' | 'updated_tablas',
  sheetId: number,
  actor: { id?: number; name?: string } | null,
  detalle?: string
): Promise<void> {
  try {
    const s = await pool.query('SELECT catalog_id, titulo FROM sheets WHERE id = $1', [sheetId]);
    if (!s.rows.length) return;
    const previa = await pool.query(
      `SELECT id, campos_json FROM sheet_audit_log
        WHERE sheet_id = $1 AND tipo_cambio = $2
          AND created_at > NOW() - ($3 || ' minutes')::interval
        ORDER BY created_at DESC LIMIT 1`,
      [sheetId, tipoCambio, String(VENTANA_AGRUPAR_MIN)]);
    if (previa.rows.length) {
      const c = previa.rows[0].campos_json || {};
      const n = (Number(c.n) || 1) + 1;
      await pool.query(
        `UPDATE sheet_audit_log SET created_at = NOW(), campos_json = $1 WHERE id = $2`,
        [JSON.stringify({ ...c, n, ultimo: detalle || c.ultimo || null }), previa.rows[0].id]);
      return;
    }
    await logSheetChange(tipoCambio, sheetId, s.rows[0].catalog_id, s.rows[0].titulo,
      { n: 1, ultimo: detalle || null }, actor);
  } catch (e: any) {
    console.warn('[audit-log] no se pudo agrupar cambio:', e.message);
  }
}

// Reprocesa un PNG in-place para corregir colores oscuros causados por perfiles
// ICC embebidos que los navegadores interpretan distinto al visor de fotos.
// Sin perdida, misma resolucion. Solo actua en PNG con perfil.
// Devuelve true si tuvo que modificar el archivo.
async function normalizarPngColor(rutaAbs: string): Promise<boolean> {
  try {
    if (!fs.existsSync(rutaAbs)) return false;
    const ext = path.extname(rutaAbs).toLowerCase();
    if (ext !== '.png') return false;
    const meta = await sharp(rutaAbs).metadata();
    // Solo si hay perfil ICC (los PNG limpios de sRGB no necesitan procesado)
    if (!meta.hasProfile) return false;
    const buf = await sharp(rutaAbs)
      .toColorspace('srgb')
      .png({ compressionLevel: 9, palette: false, effort: 6 })
      .toBuffer();
    fs.writeFileSync(rutaAbs, buf);
    return true;
  } catch (e: any) {
    console.warn('[color-fix] falla en ' + rutaAbs + ':', e?.message || e);
    return false;
  }
}

async function generarMiniatura(rutaOriginalAbs: string, nombreOriginal: string): Promise<string | null> {
  try {
    if (!fs.existsSync(rutaOriginalAbs)) return null;
    // Nombre del thumb: mismo basename pero forzado a .webp
    const base = path.parse(nombreOriginal).name; // sin extension
    const thumbName = base + '.webp';
    const thumbAbs = path.join(THUMBS_DIR, thumbName);
    // Si ya existe (regeneracion), sobreescribimos
    await sharp(rutaOriginalAbs)
      .resize({ width: 400, height: 600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(thumbAbs);
    return '/uploads/thumbs/' + thumbName;
  } catch (e) {
    // Si sharp falla (formato raro, archivo corrupto), seguimos sin miniatura
    console.warn('[thumbs] generarMiniatura falló para ' + nombreOriginal + ':', (e as Error).message);
    return null;
  }
}

// ============================================================================
// POSTGRES POOL (resiliente)
// - max 10 conexiones simultaneas (suficiente para nuestro trafico)
// - idle timeout 30s para soltar conexiones inactivas
// - connection timeout 10s al levantar (no se cuelga eternamente al arrancar)
// - error handler: si una conexion idle muere (red, reinicio Postgres),
//   se LOGUEA pero el proceso NO crashea. La proxima query la sustituye.
// ============================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
// Sin este handler, un error en una conexion idle CRASHEA el proceso entero.
// Con el, lo logueamos y seguimos: el pool descartara esa conexion y abrira
// otra cuando la necesite. Patron oficial recomendado por node-postgres.
pool.on('error', (err) => {
  console.error('[pg-pool] error en conexion idle (no crashea):', err.message);
});

// ============================================================================
// MIDDLEWARES
// ============================================================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
// Compresion HTTP gzip/brotli para respuestas de texto (JS, CSS, JSON, HTML).
// Las imagenes ya estan comprimidas (PNG/JPG/WebP) -> filter las salta.
app.use(compression({
  threshold: 1024, // no comprimir respuestas <1KB
  filter: (req, res) => {
    const ct = res.getHeader('content-type');
    if (typeof ct === 'string' && /(image|video|application\/octet-stream|application\/pdf|application\/zip)/i.test(ct)) {
      return false;
    }
    return compression.filter(req, res);
  }
}));
// Última petición atendida. Solo sirve para que, si el proceso se cae, el log
// diga QUÉ se estaba haciendo: sin esto un 502 es imposible de rastrear.
let _ultimaPeticion = '(ninguna)';
app.use((req, _res, next) => {
  if (req.path !== '/api/health') _ultimaPeticion = `${req.method} ${req.path} @ ${new Date().toISOString()}`;
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Servir frontend estatico
app.use(express.static(FRONTEND_DIR));
// Servir uploads con cache agresivo (los nombres incluyen timestamp/hash, son immutable)
// Una vez que el navegador descarga una lamina, no la vuelve a pedir durante 1 ano.
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '365d',
  immutable: true,
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// ============================================================================
// PARAM VALIDATION (Express app.param)
// Valida AUTOMATICAMENTE que cualquier :id, :cid, :sid, :uid, :sheetId, :zoneId,
// :versionId, :versionNumber en la ruta sea un entero positivo. Si no, responde
// 400 con mensaje limpio (evita el SQL error 500 "invalid input syntax for
// type integer: NaN" cuando alguien pide /api/clients/count u otros paths con
// texto donde la app espera un numero).
// ============================================================================
const validateNumericParam = (paramName: string) => (
  req: Request, res: Response, next: NextFunction, value: string
): void => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    res.status(400).json({ success: false, error: `Parametro ${paramName} invalido (debe ser entero positivo)` });
    return;
  }
  next();
};
['id', 'cid', 'sid', 'uid', 'sheetId', 'zoneId', 'versionId', 'versionNumber'].forEach(name => {
  app.param(name, validateNumericParam(name));
});

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
      -- Busqueda difusa (trigramas): tolera erratas ("ellorca"->"llorca") y palabras
      -- en cualquier orden. pg_trgm es "trusted" en PG13+, cualquier usuario puede crearlo.
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
        latitude REAL,
        longitude REAL,
        geo_at TIMESTAMP,
        geo_status VARCHAR(20),
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
      -- Indices clave para visits y annotations (faltaban; queries de
      -- "mis visitas", "historial cliente" y "anotaciones visita" hacian
      -- full table scan).
      CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id);
      CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id);
      CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
      CREATE INDEX IF NOT EXISTS idx_visits_user_created ON visits(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_annotations_visit ON annotations(visit_id);
      CREATE INDEX IF NOT EXISTS idx_annotations_sheet ON annotations(sheet_id);
      -- Assignments: UNIQUE(user_id, catalog_id) ya da indice compuesto;
      -- anadir uno por catalog_id para "que comerciales tiene este catalogo"
      CREATE INDEX IF NOT EXISTS idx_assignments_catalog ON catalog_assignments(catalog_id);

      -- FASE 2.b': ZONAS CLICABLES sobre láminas (admin las dibuja, comercial las pulsa)
      -- Coordenadas en PORCENTAJE (0-100) respecto al ancho/alto de la imagen,
      -- NO en píxeles, para que la zona caiga bien en cualquier tamaño de pantalla
      -- (tablet, PC, móvil). product_id puede ser NULL al crear la zona y asignarse después.
      CREATE TABLE IF NOT EXISTS sheet_zones (
        id SERIAL PRIMARY KEY,
        sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        x REAL NOT NULL,           -- % desde la izquierda (0-100)
        y REAL NOT NULL,           -- % desde arriba (0-100)
        ancho REAL NOT NULL,       -- % de ancho (0-100)
        alto REAL NOT NULL,        -- % de alto (0-100)
        etiqueta VARCHAR(150),     -- texto opcional que el admin puede poner a la zona
        orden INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_zones_sheet ON sheet_zones(sheet_id);
      CREATE INDEX IF NOT EXISTS idx_zones_product ON sheet_zones(product_id);

      -- Marca cuando se paso la deteccion de zonas por IA (para no repetir)
      ALTER TABLE sheets ADD COLUMN IF NOT EXISTS zones_ia_at TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_sheets_zones_ia ON sheets(zones_ia_at);

      -- Excluir esta lamina de los PRECIOS DINAMICOS. Para laminas complejas (expositores
      -- con muchas referencias) donde reescribir precio a precio es arriesgado y se prefiere
      -- rehacer la lamina a mano a la manera original. Excluida = se ve y exporta TAL CUAL.
      ALTER TABLE sheets ADD COLUMN IF NOT EXISTS precios_excluida BOOLEAN NOT NULL DEFAULT FALSE;

      -- Marca cuando el ADMIN ha REVISADO y APROBADO a mano las zonas de la lamina
      -- (distinto de zones_ia_at, que es solo "la IA paso por aqui"). Para saber en la
      -- rejilla que laminas estan hechas de verdad y no perder tiempo re-abriendolas.
      ALTER TABLE sheets ADD COLUMN IF NOT EXISTS zonas_aprobadas_at TIMESTAMP;

      -- Zona-FAMILIA: en vez de apuntar a un unico producto (product_id), una zona
      -- puede apuntar a una familia con variantes (gafas de presbicia: color x graduacion).
      -- familia_ref = palabra/modelo con la que resolvemos las variantes en products (ej. "verona").
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS familia_ref VARCHAR(120);
      -- familia_skus = lista CURADA a mano de product_ids que forman la familia (JSON array).
      -- Si esta presente, manda sobre familia_ref (el admin elige exactamente que codigos van).
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS familia_skus JSONB;

      -- Zona-COMISION: productos de laboratorios que Lomhifar NO factura (ej. Lainco).
      -- No estan en Sage; el pedido se anota con unidades+descuento (por linea) y
      -- almacen+num_socio (por pedido). El nombre del producto va en etiqueta.
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS es_comision BOOLEAN DEFAULT FALSE;
      -- Comision con VARIANTES (lista a mano de nombres/referencias que NO estan en Sage):
      -- el comercial elige la variante en un desplegable y anota como comision. JSON array de strings.
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS comision_variantes JSONB;

      -- Zona con REFERENCIAS SUELTAS: un expositor (ej. gafas) del que el cliente pide
      -- unidades sueltas que NO estan en Sage. El comercial anota cada referencia +
      -- unidades a mano durante la visita, sin dar de alta cada articulo.
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS permite_sueltas BOOLEAN DEFAULT FALSE;

      -- Campos de comision en las lineas de pedido (anotaciones)
      ALTER TABLE annotations ADD COLUMN IF NOT EXISTS es_comision BOOLEAN DEFAULT FALSE;
      ALTER TABLE annotations ADD COLUMN IF NOT EXISTS descuento REAL;         -- % descuento por linea
      ALTER TABLE annotations ADD COLUMN IF NOT EXISTS almacen VARCHAR(150);   -- almacen de envio (por pedido)
      ALTER TABLE annotations ADD COLUMN IF NOT EXISTS num_socio VARCHAR(60);  -- numero de socio del cliente
      ALTER TABLE annotations ADD COLUMN IF NOT EXISTS referencia VARCHAR(120); -- referencia suelta tecleada a mano (expositor, no esta en Sage)

      -- ===== ZONAS DE VENTA =====
      -- La restriccion de "esto aqui no se puede vender" es del TERRITORIO, no del
      -- comercial: Eva lleva Navarra y Rioja, y un laboratorio puede venderse en una
      -- y en la otra no. Atarlo al comercial obligaba a elegir entre quitarselo entero
      -- o arriesgarse a que lo ofrezca donde no debe.
      CREATE TABLE IF NOT EXISTS zonas_venta (
        id           SERIAL PRIMARY KEY,
        nombre       VARCHAR(80) NOT NULL UNIQUE,
        prefijos_cp  VARCHAR(200),          -- "01" o "22,44,50": los 2 primeros digitos del CP
        color        VARCHAR(20) DEFAULT '#0369a1',
        orden        INTEGER DEFAULT 0,
        created_at   TIMESTAMP DEFAULT NOW()
      );
      INSERT INTO zonas_venta (nombre, prefijos_cp, color, orden) VALUES
        ('Álava',    '01',       '#0369a1', 1),
        ('Gipuzkoa', '20',       '#0d9488', 2),
        ('Vizcaya',  '48',       '#7c3aed', 3),
        ('Navarra',  '31',       '#ea580c', 4),
        ('Aragón',   '22,44,50', '#16a34a', 5)
      ON CONFLICT (nombre) DO NOTHING;

      -- Zona del cliente. Se deduce del CP y si no, se pregunta UNA vez al empezar la
      -- visita y queda guardada: asi los datos se completan solos con el uso.
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS zona_id INTEGER REFERENCES zonas_venta(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_clients_zona ON clients(zona_id);

      -- QUE NO SE PUEDE VENDER EN CADA ZONA. Por laboratorio (categoria) o por lamina
      -- suelta. Se declara una vez y vale para todos los comerciales, ahora y despues.
      CREATE TABLE IF NOT EXISTS zona_restricciones (
        id           SERIAL PRIMARY KEY,
        zona_id      INTEGER NOT NULL REFERENCES zonas_venta(id) ON DELETE CASCADE,
        categoria_id INTEGER REFERENCES categorias(id) ON DELETE CASCADE,
        sheet_id     INTEGER REFERENCES sheets(id) ON DELETE CASCADE,
        motivo       VARCHAR(200),
        creado_por   VARCHAR(150),
        created_at   TIMESTAMP DEFAULT NOW(),
        CHECK (categoria_id IS NOT NULL OR sheet_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_zona_restr_cat ON zona_restricciones(zona_id, categoria_id) WHERE categoria_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_zona_restr_sheet ON zona_restricciones(zona_id, sheet_id) WHERE sheet_id IS NOT NULL;

      -- ===== REPARTO DE LAMINAS A LOS EXPRESS DE CADA COMERCIAL =====
      -- Fernando sube la lamina al maestro y hasta ahora tenia que anadirla a mano en
      -- el Express de cada comercial. Dos capas:
      --  1) REGLAS por categoria/laboratorio: "todo lo de Lainco va al Express de Eva".
      --     Cubren el trabajo repetido de cada semana.
      --  2) EXCEPCIONES por lamina, que MANDAN sobre las reglas: "esta lamina en
      --     concreto no se puede vender en esa zona" (o al reves: solo en esa).
      CREATE TABLE IF NOT EXISTS reparto_reglas (
        id                 SERIAL PRIMARY KEY,
        categoria_id       INTEGER NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
        express_catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
        activa             BOOLEAN NOT NULL DEFAULT TRUE,
        created_at         TIMESTAMP DEFAULT NOW(),
        UNIQUE(categoria_id, express_catalog_id)
      );
      CREATE INDEX IF NOT EXISTS idx_reparto_reglas_cat ON reparto_reglas(categoria_id);

      CREATE TABLE IF NOT EXISTS reparto_excepciones (
        id                 SERIAL PRIMARY KEY,
        sheet_id           INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        express_catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
        modo               VARCHAR(10) NOT NULL CHECK (modo IN ('incluir','excluir')),
        motivo             VARCHAR(200),           -- "no se puede vender en su zona"
        creado_por         VARCHAR(150),
        created_at         TIMESTAMP DEFAULT NOW(),
        UNIQUE(sheet_id, express_catalog_id)
      );
      CREATE INDEX IF NOT EXISTS idx_reparto_exc_sheet ON reparto_excepciones(sheet_id);

      -- Marca de "esta lamina llego sola por una regla": sale destacada en el Express
      -- hasta que se valida, para que un reparto automatico nunca pase desapercibido.
      ALTER TABLE express_sheets ADD COLUMN IF NOT EXISTS auto_reparto BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE express_sheets ADD COLUMN IF NOT EXISTS validada_at TIMESTAMP;

      -- ROL 'oficina': administracion. Consulta el catalogo en su tablet/PC (solo ver,
      -- no hace visitas ni pedidos) y gestiona su parte de la coordinacion: dar de alta
      -- los codigos que pide Fernando y actualizar en Sage lo que el ha cambiado.
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','sales','oficina'));

      -- Cada aviso a administracion: "esta version del catalogo trae esto y hay que
      -- hacer esto". Cierra el circuito: ellos responden y queda registrado quien y cuando.
      CREATE TABLE IF NOT EXISTS coordinacion_avisos (
        id            SERIAL PRIMARY KEY,
        catalog_id    INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
        catalog_name  VARCHAR(255),
        version_number INTEGER,
        notas         TEXT,                    -- que cambio en esta version (lo que escribe Fernando)
        n_altas       INTEGER NOT NULL DEFAULT 0,
        n_cambios     INTEGER NOT NULL DEFAULT 0,
        creado_por    VARCHAR(150),
        created_at    TIMESTAMP DEFAULT NOW(),
        visto_at      TIMESTAMP,               -- cuando administracion lo abrio
        visto_por     VARCHAR(150),
        cerrado_at    TIMESTAMP                -- cuando dieron todo por hecho
      );
      CREATE INDEX IF NOT EXISTS idx_coord_avisos_fecha ON coordinacion_avisos(created_at DESC);

      -- Codigo que administracion asigna a un producto pendiente. Se guarda aunque el
      -- producto todavia no haya llegado por la sincronizacion de Sage: en cuanto llegue,
      -- se enlaza solo. Asi Fernando no teclea codigos (que es donde entran las erratas).
      ALTER TABLE products ADD COLUMN IF NOT EXISTS codigo_asignado VARCHAR(50);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS codigo_asignado_at TIMESTAMP;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS codigo_asignado_por VARCHAR(150);

      -- Lamina cambiada que administracion tiene que reflejar en Sage. Se marca hecha
      -- desde su pantalla y Fernando lo ve al momento.
      ALTER TABLE sheets ADD COLUMN IF NOT EXISTS sage_actualizado_at TIMESTAMP;
      ALTER TABLE sheets ADD COLUMN IF NOT EXISTS sage_actualizado_por VARCHAR(150);

      -- PRODUCTO PENDIENTE DE ALTA: Fernando hace las laminas ANTES de que administracion
      -- de de alta el producto en Sage. Sin esto habia que inventarse un producto
      -- "comercial" (que es para expositores/promos que nunca estaran en Sage) y luego
      -- cambiarlo zona por zona. El provisional guarda ya los datos que administracion
      -- necesita para el alta (PVL, PVP, coste, oferta) y se ENLAZA al real de un clic.
      ALTER TABLE products ADD COLUMN IF NOT EXISTS pendiente_alta BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_coste DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS oferta_texto VARCHAR(200);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS pendiente_desde TIMESTAMP;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS pendiente_solicitante VARCHAR(150);
      CREATE INDEX IF NOT EXISTS idx_products_pendiente ON products(pendiente_alta) WHERE pendiente_alta = TRUE;

      -- Zona con REF. DE MODELO: expositores (bisuteria, pendientes...) donde TODOS los
      -- articulos estan dados de alta en Sage como UN SOLO codigo porque valen lo mismo,
      -- pero cada modelo lleva su numero impreso en la lamina (1094, 1443...). La zona
      -- apunta al CN unico (product_id) y guarda aqui el numero del modelo, que viaja en
      -- la linea del pedido ("3 uds - 1243441 PENDIENTE MIMILO ref. 1094") para que la
      -- oficina sepa QUE servir. Campo propio y no la columna etiqueta porque esa ya esta ocupada
      -- (nombre en zonas de comision, modelo en familias, descripcion de la IA).
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS ref_modelo VARCHAR(60);

      -- Zona-ENLACE: en vez de un producto, una zona puede ser un enlace a OTRO catalogo
      -- (ej. desde el catalogo general saltar al especifico de BSN y volver).
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS link_catalog_id INTEGER REFERENCES catalogs(id) ON DELETE SET NULL;
      -- Pagina destino opcional (si null, abre el catalogo por la primera pagina) + texto del boton.
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS link_sheet_id INTEGER REFERENCES sheets(id) ON DELETE SET NULL;
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS link_label VARCHAR(80);
      -- Pagina de REGRESO opcional (lamina del catalogo de ORIGEN): al pulsar "Volver"
      -- aterriza aqui en vez de en la pagina desde donde se salto (para saltarse las
      -- hojas restantes de ese laboratorio). Si null, vuelve a donde estaba.
      ALTER TABLE sheet_zones ADD COLUMN IF NOT EXISTS link_back_sheet_id INTEGER REFERENCES sheets(id) ON DELETE SET NULL;

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
        pos_x REAL,
        pos_y REAL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- B7: añadir pos_x/pos_y si la tabla ya existia sin ellas (migracion idempotente)
      -- pos_x y pos_y son porcentajes 0-1 sobre el ancho/alto de la lamina.
      -- NULL = anotacion sin posicion (asociada a la lamina entera, comportamiento anterior).
      DO $migrate$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='annotations' AND column_name='pos_x') THEN
          ALTER TABLE annotations ADD COLUMN pos_x REAL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='annotations' AND column_name='pos_y') THEN
          ALTER TABLE annotations ADD COLUMN pos_y REAL;
        END IF;
        -- Fase 2.c': anotaciones vinculadas a producto/zona
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='annotations' AND column_name='product_id') THEN
          ALTER TABLE annotations ADD COLUMN product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='annotations' AND column_name='cantidad') THEN
          ALTER TABLE annotations ADD COLUMN cantidad INTEGER;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='annotations' AND column_name='zone_id') THEN
          ALTER TABLE annotations ADD COLUMN zone_id INTEGER REFERENCES sheet_zones(id) ON DELETE SET NULL;
        END IF;
        -- Notificaciones por email: comerciales reciben aviso al cerrar versión nueva
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='users' AND column_name='recibir_notificaciones') THEN
          ALTER TABLE users ADD COLUMN recibir_notificaciones BOOLEAN DEFAULT TRUE;
        END IF;
      END$migrate$;

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

      -- D: plantillas globales de anotacion (gestionadas por admin)
      CREATE TABLE IF NOT EXISTS annotation_templates (
        id SERIAL PRIMARY KEY,
        texto VARCHAR(150) NOT NULL,
        tipo VARCHAR(20) NOT NULL DEFAULT 'pedido' CHECK (tipo IN ('pedido','devolucion','nota')),
        orden INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_templates_orden ON annotation_templates(orden, id);
      -- Clase (SOLO informativa/visual) de una plantilla de PEDIDO, para distinguir de un
      -- vistazo un descuento en % de una bonificacion en genero (12+1). 'normal' = pedido
      -- corriente. No cambia el pedido en si (es texto libre); solo pinta el badge.
      ALTER TABLE annotation_templates ADD COLUMN IF NOT EXISTS clase VARCHAR(20);

      -- C: configuracion global de emails (clave-valor, gestion admin real)
      -- Permite cambiar entre modo "pruebas" (redirige a emails de test) y "produccion"
      -- (envio real a oficina + cliente + comercial)
      CREATE TABLE IF NOT EXISTS email_config (
        clave           VARCHAR(80) PRIMARY KEY,
        valor           TEXT NOT NULL DEFAULT '',
        descripcion     VARCHAR(255),
        updated_at      TIMESTAMP DEFAULT NOW()
      );

      -- C: log de emails enviados por cada visita (para auditoria/reenvio)
      CREATE TABLE IF NOT EXISTS visit_emails (
        id              SERIAL PRIMARY KEY,
        visit_id        INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
        destinatario    VARCHAR(255) NOT NULL,
        destinatario_real VARCHAR(255),
        rol             VARCHAR(20) NOT NULL CHECK (rol IN ('oficina','cliente','comercial')),
        modo            VARCHAR(20) NOT NULL CHECK (modo IN ('pruebas','produccion')),
        asunto          VARCHAR(255),
        ok              BOOLEAN NOT NULL DEFAULT FALSE,
        error           TEXT,
        message_id      VARCHAR(255),
        sent_at         TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_visit_emails_visit ON visit_emails(visit_id);

      -- Fase 1 (Productos): tabla maestra de productos
      -- tipo='sage': producto sincronizado con Sage (codigo Sage como id externo)
      -- tipo='comercial': expositores/promos creados a mano (no estan en Sage)
      CREATE TABLE IF NOT EXISTS products (
        id              SERIAL PRIMARY KEY,
        codigo          VARCHAR(50) NOT NULL UNIQUE,  -- codigo Sage o codigo interno (EXPO-XXX)
        nombre          VARCHAR(255) NOT NULL,
        descripcion     TEXT,
        ean             VARCHAR(20),                  -- codigo nacional / EAN13 (solo sage)
        precio_pvp      DECIMAL(10,2),                -- precio venta publico
        precio_pvf      DECIMAL(10,2),                -- precio venta farmacia (PVL)
        categoria       VARCHAR(100),
        familia         VARCHAR(100),
        marca           VARCHAR(100),
        tipo            VARCHAR(20) NOT NULL DEFAULT 'sage' CHECK (tipo IN ('sage','comercial')),
        notas_admin     TEXT,                         -- notas para administracion (ej: "equivale a 24 x cod 12345")
        activo          BOOLEAN NOT NULL DEFAULT TRUE,
        descatalogado_at TIMESTAMP,                   -- fecha en que se marca como descatalogado
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_products_codigo ON products(codigo);
      CREATE INDEX IF NOT EXISTS idx_products_tipo ON products(tipo);
      CREATE INDEX IF NOT EXISTS idx_products_activo ON products(activo);
      CREATE INDEX IF NOT EXISTS idx_products_nombre ON products(nombre);
      -- Indice trigram para busqueda difusa por nombre (word_similarity / % ). Acelera
      -- las erratas y el "contiene" sin ancla. Ver /api/products/search.
      CREATE INDEX IF NOT EXISTS idx_products_nombre_trgm ON products USING gin (LOWER(nombre) gin_trgm_ops);
      -- ===== Sync Sage - campos extra en products (idempotente) =====
      -- 3 tarifas PVF (sin IVA - lo que paga la farmacia)
      -- 3 tarifas PVPR (con IVA - lo que la farmacia cobra al publico)
      -- flags: obsoleto_lc (flag Sage), es_baja (prefijo "BAJA-" en descripcion)
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_pvf_1 DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_pvf_2 DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_pvf_3 DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_pvpr_1 DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_pvpr_2 DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_pvpr_3 DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_compra DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS obsoleto_lc BOOLEAN DEFAULT FALSE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS es_baja BOOLEAN DEFAULT FALSE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS codigo_alt_1 VARCHAR(50);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS codigo_alt_2 VARCHAR(50);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS codigo_familia VARCHAR(50);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS codigo_proveedor VARCHAR(50);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS fecha_alta_sage DATE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_minimo INTEGER;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_maximo INTEGER;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS synced_from_sage_at TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_products_alt1 ON products(codigo_alt_1);
      CREATE INDEX IF NOT EXISTS idx_products_es_baja ON products(es_baja);

      -- ============================================================================
      -- PRECIOS DINÁMICOS — FASE 0 (base de datos + config). Ver documento de diseño.
      -- ============================================================================
      -- Config global clave-valor (nº de tarifas, etc.). Multi-tarifa configurable.
      CREATE TABLE IF NOT EXISTS app_config (
        clave   VARCHAR(60) PRIMARY KEY,
        valor   TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      INSERT INTO app_config (clave, valor) VALUES ('num_tarifas', '1') ON CONFLICT (clave) DO NOTHING;
      -- Horas que dura la sesion antes de pedir la contrasena otra vez. Configurable
      -- desde el panel: 8h obligaba a los comerciales a re-entrar a media jornada.
      INSERT INTO app_config (clave, valor) VALUES ('sesion_horas', '168') ON CONFLICT (clave) DO NOTHING;

      -- Cambios de precio PROGRAMADOS con fecha de entrada en vigor. El "precio de hoy"
      -- de un producto+tarifa = la fila con fecha_vigencia <= hoy más reciente; si no hay,
      -- se usa el precio base de products (precio_pvf_N / precio_pvpr_N). Los PVF y PVPR van
      -- juntos (cambian a la vez). 'grupo'/'lote' permiten agrupar una subida (por laboratorio/
      -- familia) para gestionarla y ponerle la misma fecha. NO se muestra hasta su día.
      CREATE TABLE IF NOT EXISTS precio_programado (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        tarifa SMALLINT NOT NULL DEFAULT 1,
        pvf DECIMAL(10,2),
        pvpr DECIMAL(10,2),
        fecha_vigencia DATE NOT NULL,
        grupo VARCHAR(80),                 -- etiqueta del grupo (ej. laboratorio/familia)
        lote VARCHAR(80),                  -- referencia de la subida/lote (para gestionarla junta)
        creado_por INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_precprog_lookup ON precio_programado(product_id, tarifa, fecha_vigencia DESC);
      CREATE INDEX IF NOT EXISTS idx_precprog_lote ON precio_programado(lote);
      CREATE INDEX IF NOT EXISTS idx_precprog_fecha ON precio_programado(fecha_vigencia);

      -- ===== F3 precios dinamicos: RECUADROS sobre la lamina (tapar y reescribir) =====
      -- Cada fila = un recuadro que TAPA un precio impreso en la imagen y lo REESCRIBE
      -- con el precio de HOY (de la BD). x/y/ancho/alto en % del ancho/alto de la imagen
      -- (igual que sheet_zones). color_fondo se muestrea del propio PNG (el rectangulo
      -- tapa queda invisible); tam_rel = tamano de fuente como % del ANCHO de la imagen
      -- (asi escala con el visor responsive/zoom). campo = que precio pinta.
      CREATE TABLE IF NOT EXISTS lamina_recuadro (
        id SERIAL PRIMARY KEY,
        sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        zone_id INTEGER REFERENCES sheet_zones(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        campo VARCHAR(12) NOT NULL DEFAULT 'pvf',      -- pvf | pvpr | oferta
        x REAL NOT NULL, y REAL NOT NULL, ancho REAL NOT NULL, alto REAL NOT NULL,
        color_fondo VARCHAR(24) NOT NULL DEFAULT '#ffffff',
        color_texto VARCHAR(24) NOT NULL DEFAULT '#2b2a29',
        tam_rel REAL NOT NULL DEFAULT 1.8,             -- font-size como % del ancho de imagen
        alinear VARCHAR(8) NOT NULL DEFAULT 'left',    -- left | center | right
        fuente VARCHAR(80),                             -- font-family; null = default de la app
        negrita BOOLEAN NOT NULL DEFAULT TRUE,
        prefijo VARCHAR(24) DEFAULT '',
        sufijo VARCHAR(8) DEFAULT '€',
        decimales SMALLINT NOT NULL DEFAULT 2,
        sep_decimal CHAR(1) NOT NULL DEFAULT ',',      -- ',' estandar ES; '.' si la lamina lo usa
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        origen VARCHAR(12) NOT NULL DEFAULT 'manual',  -- manual | ia
        confianza SMALLINT NOT NULL DEFAULT 100,        -- 0..100 cruce de señales reales
        revisar BOOLEAN NOT NULL DEFAULT FALSE,         -- alguna señal no cuadra: revisar a mano
        nota VARCHAR(200),                              -- motivo de la revision (para el admin)
        valor_impreso DECIMAL(10,2),                    -- numero que leyo la IA en la imagen (comparar con BD)
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_recuadro_sheet ON lamina_recuadro(sheet_id);
      CREATE INDEX IF NOT EXISTS idx_recuadro_zone ON lamina_recuadro(zone_id);
      ALTER TABLE lamina_recuadro ADD COLUMN IF NOT EXISTS confianza SMALLINT NOT NULL DEFAULT 100;
      ALTER TABLE lamina_recuadro ADD COLUMN IF NOT EXISTS revisar BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE lamina_recuadro ADD COLUMN IF NOT EXISTS nota VARCHAR(200);
      ALTER TABLE lamina_recuadro ADD COLUMN IF NOT EXISTS valor_impreso DECIMAL(10,2);

      -- ===== F4 precios dinamicos: OFERTAS / CAMPANAS (ventana inicio-fin) =====
      -- La empresa define ofertas EN LA APP (no vienen de Sage). A diferencia del precio
      -- (escalon con fecha de entrada), la oferta tiene inicio+fin y CADUCA sola. Ambito:
      -- un producto, o un GRUPO (todos los de una marca/laboratorio o de una familia), o todos.
      -- tipo: descuento (% ), bonificacion (genero, texto "3+1"...), o texto libre (promo).
      CREATE TABLE IF NOT EXISTS oferta (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(120),                            -- nombre interno de la campana
        ambito VARCHAR(12) NOT NULL DEFAULT 'producto', -- producto | familia | marca | todos
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        familia VARCHAR(120),
        marca VARCHAR(120),
        tipo VARCHAR(14) NOT NULL DEFAULT 'descuento',  -- descuento | bonificacion | texto
        valor DECIMAL(10,2),                            -- % si tipo=descuento
        texto VARCHAR(120),                             -- etiqueta a mostrar (bonificacion/texto)
        fecha_inicio DATE NOT NULL,
        fecha_fin DATE NOT NULL,
        prioridad SMALLINT NOT NULL DEFAULT 0,          -- desempate: mayor gana
        color VARCHAR(24) NOT NULL DEFAULT '#dc2626',   -- color de la etiqueta
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        creado_por INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_oferta_vig ON oferta(activo, fecha_inicio, fecha_fin);
      CREATE INDEX IF NOT EXISTS idx_oferta_prod ON oferta(product_id);
      CREATE INDEX IF NOT EXISTS idx_oferta_marca ON oferta(marca);
      CREATE INDEX IF NOT EXISTS idx_oferta_familia ON oferta(familia);

      -- ===== TABLAS DE EXPOSITOR (biblioteca) =====
      -- Laminas de expositor con TABLA densa de precios (Leukoplast/Essity...). El admin
      -- sube su Excel (con la estructura secciones/filas), la app calcula importes y totales
      -- y la dibuja bonita, y se asocia a la(s) lamina(s) para sustituir el bloque de precios.
      CREATE TABLE IF NOT EXISTS expositor_tabla (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(160) NOT NULL,
        datos JSONB NOT NULL,            -- { titulo, secciones:[{titulo, filas:[{producto,medidas,cn,uds,pvl,dto}]}] }
        origen VARCHAR(12) NOT NULL DEFAULT 'excel',  -- excel | manual
        archivo VARCHAR(200),            -- nombre del xlsx original (informativo)
        creado_por INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      -- Asociacion tabla -> lamina + hueco (bbox %) donde se pega la tabla dibujada.
      CREATE TABLE IF NOT EXISTS lamina_tabla (
        id SERIAL PRIMARY KEY,
        sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        tabla_id INTEGER NOT NULL REFERENCES expositor_tabla(id) ON DELETE CASCADE,
        x REAL NOT NULL DEFAULT 2, y REAL NOT NULL DEFAULT 20,
        ancho REAL NOT NULL DEFAULT 60, alto REAL NOT NULL DEFAULT 65,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_lamina_tabla_sheet ON lamina_tabla(sheet_id);

      -- ===== CANAL DE INCIDENCIAS (comercial -> admin) =====
      -- El comercial reporta desde la propia app, con captura opcional. Se guarda
      -- la VERSION y la pantalla donde estaba: sin eso, media incidencia es
      -- adivinar. Mismo planteamiento que en las otras apps.
      CREATE TABLE IF NOT EXISTS incidencias (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        autor VARCHAR(150),                    -- nombre/email al reportar (queda aunque se borre el usuario)
        rol VARCHAR(20),
        tipo VARCHAR(20) NOT NULL DEFAULT 'incidencia',  -- incidencia | sugerencia | duda
        texto TEXT NOT NULL,
        captura_path VARCHAR(300),
        version_app VARCHAR(40),
        pantalla VARCHAR(200),                 -- dónde estaba (hash/vista)
        dispositivo VARCHAR(300),              -- user agent recortado
        estado VARCHAR(20) NOT NULL DEFAULT 'nueva',     -- nueva | vista | resuelta
        respuesta TEXT,
        respondida_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_incidencias_estado ON incidencias(estado, created_at DESC);

      -- PAPELERA: borrar una tabla (o quitarla de una lamina) ya no destruye nada,
      -- solo marca la fecha. Asi se puede DESHACER, sobre todo un borrado en bloque.
      ALTER TABLE expositor_tabla ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;
      ALTER TABLE lamina_tabla   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;

      -- ===== Sync Sage - campos extra en clients (idempotente) =====
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS tarifa_precio INTEGER;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS nombre_comercial VARCHAR(255);
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS codigo_provincia VARCHAR(10);
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS lsys_fecha_grabacion TIMESTAMP;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS fecha_alta_sage DATE;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS synced_from_sage_at TIMESTAMP;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS es_baja BOOLEAN DEFAULT FALSE;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS baja_empresa_lc BOOLEAN DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS idx_clients_lsys ON clients(lsys_fecha_grabacion);
      CREATE INDEX IF NOT EXISTS idx_clients_es_baja ON clients(es_baja);

      -- ===== Stock actual por articulo (viene del sync frecuente) =====
      CREATE TABLE IF NOT EXISTS product_stock (
        codigo_sage    VARCHAR(50) PRIMARY KEY,
        unidades       DECIMAL(12,2) DEFAULT 0,
        valor_almacen  DECIMAL(12,2) DEFAULT 0,
        updated_at     TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_stock_updated ON product_stock(updated_at DESC);

      -- ===== Historial de batches de sincronizacion Sage =====
      CREATE TABLE IF NOT EXISTS sync_batches (
        id                      SERIAL PRIMARY KEY,
        tipo                    VARCHAR(20) NOT NULL CHECK (tipo IN ('products','clients','stock')),
        batch_id                VARCHAR(100),
        generated_at            TIMESTAMP,
        received_at             TIMESTAMP DEFAULT NOW(),
        num_recibidos           INTEGER DEFAULT 0,
        num_actualizados        INTEGER DEFAULT 0,
        num_nuevos              INTEGER DEFAULT 0,
        num_sin_cambios         INTEGER DEFAULT 0,
        num_marcados_inactivos  INTEGER DEFAULT 0,
        duracion_ms             INTEGER,
        error                   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_batches_recv ON sync_batches(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sync_batches_tipo ON sync_batches(tipo, received_at DESC);

      -- Fase 1: histórico de cambios de precio (auditoría)
      CREATE TABLE IF NOT EXISTS product_price_history (
        id              SERIAL PRIMARY KEY,
        product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        precio_pvp_old  DECIMAL(10,2),
        precio_pvp_new  DECIMAL(10,2),
        precio_pvf_old  DECIMAL(10,2),
        precio_pvf_new  DECIMAL(10,2),
        origen          VARCHAR(20),                  -- 'import_sage' | 'manual'
        changed_by_id   INTEGER REFERENCES users(id),
        changed_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pph_product ON product_price_history(product_id);
      CREATE INDEX IF NOT EXISTS idx_pph_date ON product_price_history(changed_at DESC);

      -- ====================================================================
      -- AULA DE FORMACIÓN
      -- ====================================================================
      -- Tabla principal: cada fila es una formación (archivo + metadatos)
      CREATE TABLE IF NOT EXISTS formaciones (
        id              SERIAL PRIMARY KEY,
        laboratorio     VARCHAR(150) NOT NULL,        -- 'Bayer', 'Cantabria Labs', etc.
        nombre          VARCHAR(255) NOT NULL,        -- título de la formación
        tematica        VARCHAR(150),                 -- 'Dermatología', 'Solar', etc.
        descripcion     TEXT,
        archivo_path    VARCHAR(500) NOT NULL,        -- ruta en disco
        archivo_nombre  VARCHAR(255) NOT NULL,        -- nombre original
        archivo_mime    VARCHAR(100),                 -- 'application/pdf', 'video/mp4', etc.
        archivo_size    BIGINT,                       -- tamaño en bytes
        fecha_formacion DATE,                         -- fecha que indica el material (opcional)
        publico         BOOLEAN DEFAULT TRUE,         -- TRUE = todos comerciales; FALSE = solo los de formacion_permisos
        creado_por      INTEGER REFERENCES users(id),
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_formaciones_lab ON formaciones(laboratorio);
      CREATE INDEX IF NOT EXISTS idx_formaciones_tematica ON formaciones(tematica);
      CREATE INDEX IF NOT EXISTS idx_formaciones_fecha ON formaciones(fecha_formacion DESC);

      -- Histórico de versiones: cuando se actualiza el archivo, la versión anterior
      -- queda registrada aquí para auditoría. NO se borra el archivo viejo.
      CREATE TABLE IF NOT EXISTS formacion_versions (
        id              SERIAL PRIMARY KEY,
        formacion_id    INTEGER NOT NULL REFERENCES formaciones(id) ON DELETE CASCADE,
        archivo_path    VARCHAR(500) NOT NULL,
        archivo_nombre  VARCHAR(255) NOT NULL,
        archivo_mime    VARCHAR(100),
        archivo_size    BIGINT,
        notas           TEXT,                         -- p.ej. "actualización tras feedback"
        reemplazado_por INTEGER REFERENCES users(id), -- quién subió la versión nueva (causando que esta pasase a histórico)
        archivado_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_form_versions_formacion ON formacion_versions(formacion_id);

      -- Permisos: si la formación tiene publico=FALSE, solo los usuarios listados aquí la ven.
      -- Si publico=TRUE, esta tabla se ignora (todos los comerciales activos la ven).
      CREATE TABLE IF NOT EXISTS formacion_permisos (
        id              SERIAL PRIMARY KEY,
        formacion_id    INTEGER NOT NULL REFERENCES formaciones(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(formacion_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_form_permisos_formacion ON formacion_permisos(formacion_id);
      CREATE INDEX IF NOT EXISTS idx_form_permisos_user ON formacion_permisos(user_id);

      -- ===== CATEGORIAS / TAGS para láminas =====
      CREATE TABLE IF NOT EXISTS categorias (
        id              SERIAL PRIMARY KEY,
        nombre          VARCHAR(80) NOT NULL UNIQUE,
        color           VARCHAR(20) DEFAULT '#cc007a',
        orden           INTEGER DEFAULT 0,
        created_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sheet_categorias (
        id              SERIAL PRIMARY KEY,
        sheet_id        INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
        categoria_id    INTEGER NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
        created_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(sheet_id, categoria_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sheet_cat_sheet ON sheet_categorias(sheet_id);
      CREATE INDEX IF NOT EXISTS idx_sheet_cat_cat ON sheet_categorias(categoria_id);

      -- ===== MEGA BACKUPS (historial de respaldos subidos a MEGA) =====
      -- Cada fila representa una subida a MEGA de un catalogo hacia un destino
      -- (comercial concreto o General para todos). Se guarda el link publico
      -- generado para poder reenviarlo por email sin regenerar.
      CREATE TABLE IF NOT EXISTS mega_backups (
        id                SERIAL PRIMARY KEY,
        catalog_id        INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
        catalog_name      VARCHAR(255) NOT NULL,
        catalog_version   INTEGER NOT NULL,
        destino_tipo      VARCHAR(20) NOT NULL CHECK (destino_tipo IN ('comercial','general')),
        destino_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        destino_user_name VARCHAR(150),
        mega_url          TEXT NOT NULL,
        mega_folder_name  VARCHAR(500) NOT NULL,
        num_laminas       INTEGER NOT NULL DEFAULT 0,
        size_mb           NUMERIC(10,2),
        email_enviado_at  TIMESTAMP,
        created_by        INTEGER REFERENCES users(id),
        created_at        TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mega_catalog ON mega_backups(catalog_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mega_user ON mega_backups(destino_user_id, created_at DESC);

      -- ===== MEGA FOLDERS (catalogo dinamico de carpetas raiz en MEGA) =====
      -- Cada fila = una carpeta raiz existente en /CatalogPRO backup/ en MEGA.
      -- El admin comparte la carpeta manualmente en MEGA y pega el URL aqui
      -- (MEGA rate-limitea la generacion de share links via API).
      -- user_id opcional: si esta puesto, el email del backup se envia a ese
      -- comercial concreto. Si es NULL, la carpeta es "laboratorio" y el admin
      -- decide manualmente a quien enviar el link (multi-destinatario).
      CREATE TABLE IF NOT EXISTS mega_folders (
        id            SERIAL PRIMARY KEY,
        nombre        VARCHAR(200) NOT NULL UNIQUE,
        mega_url      TEXT NOT NULL DEFAULT '',
        user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        descripcion   VARCHAR(255),
        orden         INTEGER DEFAULT 0,
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mega_folders_orden ON mega_folders(orden, id);
      CREATE INDEX IF NOT EXISTS idx_mega_folders_user ON mega_folders(user_id);

      -- ===== AUDITORIA DE CAMBIOS EN LAMINAS =====
      -- Cada operacion sobre sheets (crear/editar/borrar) registra una fila
      -- aqui con snapshot del titulo y catalog_name (para poder mostrar la
      -- info despues incluso si la lamina se borro). Usado por el resumen
      -- semanal a oficina.
      CREATE TABLE IF NOT EXISTS sheet_audit_log (
        id            SERIAL PRIMARY KEY,
        sheet_id      INTEGER,
        catalog_id    INTEGER,
        catalog_name  VARCHAR(255),
        titulo        VARCHAR(255),
        tipo_cambio   VARCHAR(30) NOT NULL CHECK (tipo_cambio IN ('created','updated_image','updated_meta','deleted')),
        campos_json   JSONB,
        actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_name    VARCHAR(150),
        created_at    TIMESTAMP DEFAULT NOW()
      );
      -- Tipos nuevos (jul 2026): hasta ahora solo se registraba la imagen y los datos
      -- de la lamina, asi que "modificada" mentia si lo que tocabas eran las zonas, los
      -- cuadros de precio o las tablas. El CHECK original no los admitia.
      ALTER TABLE sheet_audit_log DROP CONSTRAINT IF EXISTS sheet_audit_log_tipo_cambio_check;
      ALTER TABLE sheet_audit_log ADD CONSTRAINT sheet_audit_log_tipo_cambio_check
        CHECK (tipo_cambio IN ('created','updated_image','updated_meta','deleted',
                               'updated_zonas','updated_precios','updated_tablas'));
      CREATE INDEX IF NOT EXISTS idx_sheet_audit_catalog ON sheet_audit_log(catalog_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sheet_audit_sheet ON sheet_audit_log(sheet_id);
      CREATE INDEX IF NOT EXISTS idx_sheet_audit_created ON sheet_audit_log(created_at DESC);

      -- ===== DESTINATARIOS OFICINA (resumen a oficina) =====
      CREATE TABLE IF NOT EXISTS office_summary_recipients (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(150) NOT NULL UNIQUE,
        nombre        VARCHAR(150),
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMP DEFAULT NOW()
      );

      -- ===== HISTORIAL DE ENVIOS DE RESUMEN =====
      -- Cada fila = un envio del resumen. Guarda el punto de corte (fecha)
      -- y a quienes se envio. Permite saber "desde cuando calcular los
      -- cambios" para el siguiente envio.
      CREATE TABLE IF NOT EXISTS office_summary_sent (
        id                 SERIAL PRIMARY KEY,
        sent_at            TIMESTAMP DEFAULT NOW(),
        cambios_desde      TIMESTAMP NOT NULL,
        cambios_hasta      TIMESTAMP NOT NULL,
        num_nuevas         INTEGER DEFAULT 0,
        num_modificadas    INTEGER DEFAULT 0,
        num_eliminadas     INTEGER DEFAULT 0,
        destinatarios      TEXT[],
        sent_by            INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_office_summary_sent_at ON office_summary_sent(sent_at DESC);
    `;
    await pool.query(schemaSQL);

    // H: migración idempotente — añadir columnas geo a clients si no existen.
    // Hacemos cada ALTER por separado y silenciamos el error de "ya existe"
    // (PostgreSQL emite error 42701 "duplicate column" si la columna existe).
    const geoAlters = [
      `ALTER TABLE clients ADD COLUMN latitude REAL`,
      `ALTER TABLE clients ADD COLUMN longitude REAL`,
      `ALTER TABLE clients ADD COLUMN geo_at TIMESTAMP`,
      `ALTER TABLE clients ADD COLUMN geo_status VARCHAR(20)`
    ];
    for (const sql of geoAlters) {
      try {
        await pool.query(sql);
        console.log('✅ Aplicado: ' + sql);
      } catch (e: any) {
        if (e.code === '42701') {
          // Columna ya existe, OK
        } else {
          console.error('⚠️ Error en migración:', sql, e.message);
        }
      }
    }
    // Crear índice geo AHORA que las columnas existen (no antes, porque la tabla
    // ya existía sin las columnas y CREATE TABLE IF NOT EXISTS no añade columnas)
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_clients_geo ON clients(latitude, longitude)`);
    } catch (e: any) {
      console.error('⚠️ Error creando índice geo:', e.message);
    }

    // E: migración idempotente — añadir columnas pdf_path/zip_path/tamano_bytes
    // a catalog_versions si no existen.
    const versionAlters = [
      `ALTER TABLE catalog_versions ADD COLUMN pdf_path VARCHAR(500)`,
      `ALTER TABLE catalog_versions ADD COLUMN zip_path VARCHAR(500)`,
      `ALTER TABLE catalog_versions ADD COLUMN pdf_size_bytes BIGINT`,
      `ALTER TABLE catalog_versions ADD COLUMN zip_size_bytes BIGINT`,
      `ALTER TABLE catalog_versions ADD COLUMN total_laminas INTEGER`,
      `ALTER TABLE catalog_versions ADD COLUMN status VARCHAR(20) DEFAULT 'ok'`
    ];
    for (const sql of versionAlters) {
      try {
        await pool.query(sql);
        console.log('✅ Aplicado: ' + sql);
      } catch (e: any) {
        if (e.code === '42701') {
          // Columna ya existe
        } else {
          console.error('⚠️ Error en migración catalog_versions:', sql, e.message);
        }
      }
    }

    // FASE 1 FIX (27 may): migración idempotente — añadir campos extra del Sage real:
    // proveedor, iva_group, subfamilia. La columna 'familia' ya existe (la usaremos
    // para mapear el campo "Subfamilia" del Sage; y 'categoria' se mapeará desde "Familia").
    const productosAlters = [
      `ALTER TABLE products ADD COLUMN proveedor VARCHAR(150)`,
      `ALTER TABLE products ADD COLUMN iva_group VARCHAR(10)`,
      `ALTER TABLE products ADD COLUMN subfamilia VARCHAR(100)`
    ];
    for (const sql of productosAlters) {
      try {
        await pool.query(sql);
        console.log('✅ Aplicado: ' + sql);
      } catch (e: any) {
        if (e.code === '42701') {
          // Columna ya existe
        } else {
          console.error('⚠️ Error en migración products:', sql, e.message);
        }
      }
    }

    // Sembrar configuracion email por defecto si no existe
    const emailDefaults = [
      ['modo', 'pruebas', 'Modo actual: pruebas (redirige a emails de test) o produccion (envio real)'],
      ['oficina_emails', '', 'Emails de oficina separados por coma. Reciben resumen+PDF en modo produccion'],
      ['pruebas_email_oficina', '', 'Email donde llegan los emails "de oficina" en modo pruebas'],
      ['pruebas_email_cliente', '', 'Email donde llegan los emails "al cliente" en modo pruebas'],
      ['pruebas_email_comercial', '', 'Email donde llegan los emails "al comercial" en modo pruebas'],
      ['remitente_from', '"CatalogPRO LOMHIFAR" <f.ayllon66@gmail.com>', 'Remitente FROM de todos los emails enviados'],
      ['firma_html', '<p style="color:#888;font-size:12px">LOMHIFAR S.L. · Distribución parafarmacéutica</p>', 'Firma HTML al pie de los emails'],
      // G - Planning/rutero
      ['planning_ciclo_default', '90', 'Ciclo de visita por defecto en días (se aplica a clientes sin ciclo propio)'],
      ['planning_ventana_proxima_dias', '15', 'Días ANTES del ciclo en que el cliente pasa a amarillo (próxima visita)'],
      ['planning_ventana_urgente_dias', '15', 'Días DESPUÉS del ciclo en que el cliente pasa a rojo (urgente)']
    ];
    for (const [k, v, d] of emailDefaults) {
      await pool.query(
        `INSERT INTO email_config (clave, valor, descripcion) VALUES ($1, $2, $3)
         ON CONFLICT (clave) DO NOTHING`,
        [k, v, d]
      );
    }

    // Sembrar plantillas iniciales solo si la tabla esta vacia (LOMHIFAR habitual)
    const tplCnt = await pool.query('SELECT COUNT(*)::int AS n FROM annotation_templates');
    if (tplCnt.rows[0].n === 0) {
      const seed = [
        ['12+1', 'pedido'],
        ['6+1 oferta', 'pedido'],
        ['Oferta -15%', 'pedido'],
        ['1 caja', 'pedido'],
        ['Reposición habitual', 'pedido'],
        ['Revisar caducidad', 'nota'],
        ['Tarifa pendiente', 'nota'],
        ['Devolver lote caducado', 'devolucion'],
        ['Devolver por mal estado', 'devolucion']
      ];
      for (let i = 0; i < seed.length; i++) {
        await pool.query(
          'INSERT INTO annotation_templates (texto, tipo, orden) VALUES ($1, $2, $3)',
          [seed[i][0], seed[i][1], i + 1]
        );
      }
      console.log('✅ Sembradas ' + seed.length + ' plantillas de anotación iniciales');
    }

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
// /api/health verifica que la BD responde. Si no responde devuelve 503,
// Railway lo detecta como unhealthy y reinicia el contenedor.
// Timeout 3s para no quedarse colgado si BD esta saturada.
app.get('/api/health', async (_req, res) => {
  try {
    const t0 = Date.now();
    // SELECT 1 con timeout (statement_timeout en query)
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout 3s')), 3000))
    ]);
    res.json({
      ok: true,
      version: '2.0.0',
      // Marca del build: se sube A MANO en cada cambio de BACKEND. Sin esto no hay
      // forma de saber si Railway ya sirve el codigo nuevo (el APP_VERSION del
      // frontend solo delata los cambios de app.js) y se acaba depurando a ciegas.
      build: 'v147-pdf-zona-23jul',
      service: 'CatalogPRO v2',
      db_ms: Date.now() - t0,
      uptime_s: Math.round(process.uptime()),
      memory_MB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: 'db_unreachable',
      detail: (e as Error).message
    });
  }
});

// ============================================================================
// AUTH
// ============================================================================
// Rate limit del login: max 10 intentos por IP cada 15 min. Para evitar
// fuerza bruta sobre el endpoint mas sensible. No bloquea a un comercial
// real (que normalmente loguea 1-2 veces por dia desde la misma IP).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Demasiados intentos de login. Espera 15 minutos.' },
  // Solo cuenta intentos fallidos (no penalizar logins legitimos repetidos)
  skipSuccessfulRequests: true
});

app.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
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
      { expiresIn: (await sesionHorasConfig()) * 3600 }   // en segundos: el tipo de jwt no admite "Nh" dinámico
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
    if (!['admin','sales','oficina'].includes(role)) {
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
    if (!['admin','sales','oficina'].includes(role)) {
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

// Cualquier usuario: cambiar su propia contraseña (requiere la actual)
// IMPORTANTE: esta ruta /me/... DEBE ir ANTES que /:id/... porque el validador
// global de :id (entero positivo) rechaza "me" y devolveria "Parametro id invalido".
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

// GG3: toggle simple ON/OFF para recibir notificaciones por email
app.put('/api/users/me/notificaciones', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { recibir } = req.body;
    const valor = recibir === true || recibir === 'true' || recibir === 1;
    await pool.query('UPDATE users SET recibir_notificaciones=$1 WHERE id=$2', [valor, req.user!.id]);
    res.json({ success: true, recibir_notificaciones: valor });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Admin: cambiar contraseña de cualquier usuario (va DESPUES de las rutas /me/...)
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

// Devolver perfil del usuario actual (incluye preferencias)
app.get('/api/users/me', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      'SELECT id, email, name, role, sage_commercial_code, COALESCE(recibir_notificaciones, TRUE) AS recibir_notificaciones FROM users WHERE id=$1',
      [req.user!.id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Usuario no encontrado' });
      return;
    }
    res.json({ success: true, user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
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
    // Administracion (rol 'oficina') consulta TODOS los catalogos vivos: no se les
    // asigna nada porque no venden, lo usan como ayuda para atender al telefono.
    if (req.user.role === 'oficina') {
      r = await pool.query(`
        SELECT c.*,
          CASE
            WHEN c.tipo = 'express' THEN (SELECT COUNT(*)::int FROM express_sheets es WHERE es.express_catalog_id = c.id)
            ELSE (SELECT COUNT(*)::int FROM sheets WHERE catalog_id = c.id AND oculta = FALSE)
          END AS sheet_count,
          (SELECT name FROM catalogs cp WHERE cp.id = c.parent_id) AS parent_name
        FROM catalogs c
        WHERE c.estado != 'archivado'
        ORDER BY c.updated_at DESC
      `);
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
    // Un Express para un comercial suele ser "el maestro MENOS unas pocas", no una
    // seleccion desde cero: arrancarlo vacio obligaba a marcar 350 laminas a mano.
    // Por defecto se copia el maestro ENTERO con su mismo orden y luego se quitan las
    // que sobren. Con copiar_maestro:false se crea vacio (campanas de ofertas sueltas).
    let copiadas = 0;
    if (tipo === 'express' && parentIdFinal && req.body.copiar_maestro !== false) {
      const ins = await pool.query(
        `INSERT INTO express_sheets (express_catalog_id, sheet_id, orden)
         SELECT $1, id, ROW_NUMBER() OVER (ORDER BY orden, id)
           FROM sheets WHERE catalog_id = $2 AND oculta = FALSE
         ON CONFLICT DO NOTHING
         RETURNING id`, [r.rows[0].id, parentIdFinal]);
      copiadas = ins.rowCount || 0;
    }
    res.status(201).json({ success: true, catalog: r.rows[0], laminas_copiadas: copiadas });
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
    // Enriquecer cada lámina con sus categorías asignadas (para mostrar chips en editor admin)
    if (sheetsRows.length > 0) {
      const sheetIds = sheetsRows.map((s: any) => s.id);
      // Ultimo cambio de cada lamina (para el distintivo "cambiada tras revisarla" y el
      // filtro "cambiadas esta semana"). Una sola consulta para todas: nada de N+1.
      try {
        const camR = await pool.query(
          `SELECT sheet_id, MAX(created_at) AS ultimo_cambio,
                  (ARRAY_AGG(tipo_cambio ORDER BY created_at DESC))[1] AS ultimo_tipo
             FROM sheet_audit_log
            WHERE sheet_id = ANY($1::int[]) AND tipo_cambio <> 'deleted'
            GROUP BY sheet_id`, [sheetIds]);
        const mapaCam: any = {};
        camR.rows.forEach((x: any) => { mapaCam[x.sheet_id] = x; });
        sheetsRows.forEach((s: any) => {
          s.ultimo_cambio = mapaCam[s.id]?.ultimo_cambio || null;
          s.ultimo_cambio_tipo = mapaCam[s.id]?.ultimo_tipo || null;
        });
      } catch (_) { /* si falla la auditoría, la rejilla sigue funcionando igual */ }
      // ¿Cuántas zonas de cada lámina apuntan a un producto PENDIENTE DE ALTA?
      // Es lo que enciende el distintivo "⏳ falta dar de alta" en la lista.
      try {
        const pendR = await pool.query(
          `SELECT z.sheet_id, COUNT(*)::int AS n
             FROM sheet_zones z JOIN products p ON p.id = z.product_id
            WHERE z.sheet_id = ANY($1::int[]) AND p.pendiente_alta = TRUE
            GROUP BY z.sheet_id`, [sheetIds]);
        const mapaPend: any = {};
        pendR.rows.forEach((x: any) => { mapaPend[x.sheet_id] = x.n; });
        sheetsRows.forEach((s: any) => { s.num_pendientes_alta = mapaPend[s.id] || 0; });
      } catch (_) { /* idem */ }
      const catsR = await pool.query(`
        SELECT sc.sheet_id, c.id, c.nombre, c.color
        FROM sheet_categorias sc
        INNER JOIN categorias c ON c.id = sc.categoria_id
        WHERE sc.sheet_id = ANY($1::int[])
        ORDER BY c.orden ASC, c.nombre ASC
      `, [sheetIds]);
      const catsBySheet: { [key: number]: any[] } = {};
      for (const row of catsR.rows) {
        if (!catsBySheet[row.sheet_id]) catsBySheet[row.sheet_id] = [];
        catsBySheet[row.sheet_id].push({ id: row.id, nombre: row.nombre, color: row.color });
      }
      for (const s of sheetsRows) {
        s.categorias = catsBySheet[s.id] || [];
      }
      // Numero de zonas por lamina (para el distintivo de revision en la rejilla)
      const zR = await pool.query(
        `SELECT sheet_id, COUNT(*)::int AS n FROM sheet_zones WHERE sheet_id = ANY($1::int[]) GROUP BY sheet_id`,
        [sheetIds]
      );
      const zBySheet: { [key: number]: number } = {};
      for (const row of zR.rows) zBySheet[row.sheet_id] = row.n;
      // Recuadros de PRECIO por lamina (distintivo morado en la rejilla): con 350+ laminas
      // hay que ver de un vistazo cuales tienen precios asignados y cuales faltan.
      // 'pendientes' = los marcados revisar (aun no se muestran al cliente).
      const rR = await pool.query(
        `SELECT sheet_id, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE revisar = TRUE)::int AS pend
           FROM lamina_recuadro
          WHERE sheet_id = ANY($1::int[]) AND activo = TRUE
          GROUP BY sheet_id`,
        [sheetIds]
      );
      const rBySheet: { [key: number]: { n: number; pend: number } } = {};
      for (const row of rR.rows) rBySheet[row.sheet_id] = { n: row.n, pend: row.pend };
      // Tablas de expositor asociadas por lámina (distintivo "Tabla dinámica" en la rejilla).
      const tR = await pool.query(
        `SELECT sheet_id, COUNT(*)::int AS n FROM lamina_tabla WHERE sheet_id = ANY($1::int[]) AND activo=TRUE AND deleted_at IS NULL GROUP BY sheet_id`, [sheetIds]);
      const tBySheet: { [key: number]: number } = {};
      for (const row of tR.rows) tBySheet[row.sheet_id] = row.n;
      for (const s of sheetsRows) {
        s.num_recuadros = rBySheet[s.id]?.n || 0;
        s.num_recuadros_pend = rBySheet[s.id]?.pend || 0;
        s.num_tablas = tBySheet[s.id] || 0;
      }
      for (const s of sheetsRows) {
        s.num_zonas = zBySheet[s.id] || 0;
      }
    }
    res.json({ success: true, catalog: cat, sheets: sheetsRows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// J - DESCARGAR COPIA LOCAL DEL CATALOGO (PDF o ZIP)
// ============================================================================
// Helper: verifica acceso a un catalogo (admin = todos, comercial = solo asignados)
// y devuelve catalog + sheets cargados, o null si no tiene acceso.
async function cargarCatalogoConAcceso(catalogId: number, req: AuthRequest):
  Promise<{ catalog: any, sheets: any[] } | { error: string, status: number } | null> {
  try {
    if (!req.user) return { error: 'Unauthorized', status: 401 };
    const userId = effectiveUserId(req);

    // Cargar catalogo
    const c = await pool.query('SELECT * FROM catalogs WHERE id = $1', [catalogId]);
    if (c.rows.length === 0) return { error: 'Catalogo no encontrado', status: 404 };
    const cat = c.rows[0];

    // Si es comercial, verificar que el catalogo está asignado a él
    if (isEffectiveSales(req)) {
      const a = await pool.query(
        'SELECT 1 FROM catalog_assignments WHERE user_id = $1 AND catalog_id = $2',
        [userId, catalogId]
      );
      if (a.rows.length === 0) {
        return { error: 'No tienes acceso a este catalogo', status: 403 };
      }
    }

    // Cargar laminas (igual que GET /api/catalogs/:id)
    let sheetsRows;
    if (cat.tipo === 'express') {
      const r = await pool.query(`
        SELECT s.*, es.orden AS orden, es.id AS express_sheet_id
        FROM express_sheets es
        JOIN sheets s ON s.id = es.sheet_id
        WHERE es.express_catalog_id = $1
        ORDER BY es.orden, es.id
      `, [catalogId]);
      sheetsRows = r.rows;
    } else {
      const r = await pool.query(
        'SELECT * FROM sheets WHERE catalog_id = $1 AND oculta = FALSE ORDER BY orden, id',
        [catalogId]
      );
      sheetsRows = r.rows;
    }
    // Enriquecer cada lámina con sus categorías (si las tiene)
    if (sheetsRows.length > 0) {
      const sheetIds = sheetsRows.map((s: any) => s.id);
      const catsR = await pool.query(`
        SELECT sc.sheet_id, c.id, c.nombre, c.color
        FROM sheet_categorias sc
        INNER JOIN categorias c ON c.id = sc.categoria_id
        WHERE sc.sheet_id = ANY($1::int[])
        ORDER BY c.orden ASC, c.nombre ASC
      `, [sheetIds]);
      const catsBySheet: { [key: number]: any[] } = {};
      for (const row of catsR.rows) {
        if (!catsBySheet[row.sheet_id]) catsBySheet[row.sheet_id] = [];
        catsBySheet[row.sheet_id].push({ id: row.id, nombre: row.nombre, color: row.color });
      }
      for (const s of sheetsRows) {
        s.categorias = catsBySheet[s.id] || [];
      }
    }
    return { catalog: cat, sheets: sheetsRows };
  } catch (e) {
    return { error: (e as Error).message, status: 500 };
  }
}

// Helper: dado un sheet, devuelve el path local en disco de su imagen.
// Las imagenes se guardan en UPLOADS_DIR (/app/data/uploads por defecto)
function getSheetImagePath(sheet: any): string {
  const uploadsDir = process.env.UPLOADS_DIR || '/app/data/uploads';
  // sheet.imagen_path puede venir como "/uploads/abc.jpg" o "abc.jpg"
  let rel = sheet.imagen_path || '';
  if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
  else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
  const path = require('path');
  return path.join(uploadsDir, rel);
}

// Sanitizar nombre de fichero (quitar caracteres no validos)
function nombreFicheroSeguro(s: string): string {
  return String(s || 'catalogo')
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 60);
}

// J/E: Generar PDF del catálogo a un stream cualquiera (res HTTP o fichero).
// Devuelve una promesa que resuelve cuando el PDF está completo.
// calidad: 'alta' = original sin compresión; 'pequena' = redimensionado a 1200px lado largo y JPEG 80% (apto WhatsApp/email)
async function generarPdfCatalogoStream(catalog: any, sheets: any[], destStream: any, calidad: 'alta' | 'pequena' = 'alta'): Promise<void> {
  const fs = require('fs');
  const sharp = require('sharp');
  const path = require('path');
  // Si es pequeña, pre-procesar imágenes a un directorio temporal
  let imagenesProcesadas: { [key: number]: string } = {};
  let tempDir = '';
  if (calidad === 'pequena') {
    const os = require('os');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-low-'));
    for (const sheet of sheets) {
      const imgPath = getSheetImagePath(sheet);
      if (!fs.existsSync(imgPath)) continue;
      try {
        const outPath = path.join(tempDir, `s${sheet.id}.jpg`);
        await sharp(imgPath)
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, mozjpeg: true })
          .toFile(outPath);
        imagenesProcesadas[sheet.id] = outPath;
      } catch (e: any) {
        console.warn('[PDF-pequena] Fallo redimensionando lámina ' + sheet.id + ':', e.message);
      }
    }
  }

  return new Promise((resolve, reject) => {
    const PDFDocumentLib = require('pdfkit');
    const doc = new PDFDocumentLib({ size: 'A4', margin: 0, autoFirstPage: false });
    doc.pipe(destStream);
    destStream.on('finish', () => {
      // Limpiar temporales
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
      resolve();
    });
    destStream.on('error', (e: any) => reject(e));
    doc.on('error', (e: any) => reject(e));

    // Página de portada
    doc.addPage({ size: 'A4', margin: 50 });
    doc.fontSize(22).fillColor('#cc007a').text('LOMHIFAR', { align: 'center' });
    doc.fontSize(10).fillColor('#666').text('Distribución de productos parafarmacéuticos', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(20).fillColor('#000').text(catalog.name, { align: 'center' });
    if (catalog.description) {
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#666').text(catalog.description, { align: 'center' });
    }
    doc.moveDown(2);
    doc.fontSize(10).fillColor('#666').text(
      `Versión ${catalog.version || 1} · ${sheets.length} láminas`,
      { align: 'center' }
    );
    doc.fontSize(9).fillColor('#999').text(
      `Generado: ${new Date().toLocaleString('es-ES')}${calidad === 'pequena' ? ' · Calidad reducida' : ''}`,
      { align: 'center' }
    );

    // Cada lámina en una página, ajustada al tamaño
    for (const sheet of sheets) {
      // Usar imagen procesada si es pequeña y existe, sino la original
      const imgPath = (calidad === 'pequena' && imagenesProcesadas[sheet.id])
        ? imagenesProcesadas[sheet.id]
        : getSheetImagePath(sheet);
      if (!fs.existsSync(imgPath)) {
        console.warn('[PDF] Imagen no encontrada: ' + imgPath);
        continue;
      }
      try {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
        // Cabecera de la página: nombre del catálogo + lámina + título (todo en una línea)
        doc.fontSize(8).fillColor('#666').text(
          `${catalog.name} · Lám. ${sheet.orden || '?'}${sheet.titulo ? ' · ' + sheet.titulo : ''}`,
          20, 10, { width: 800, align: 'left' }
        );
        // Imagen ocupando casi toda la página (sin texto "Página X" abajo que forzaba salto)
        doc.image(imgPath, 20, 25, {
          fit: [800, 555],
          align: 'center',
          valign: 'center'
        });
      } catch (err) {
        console.error('[PDF] Error añadiendo lámina ' + sheet.id + ':', (err as Error).message);
      }
    }
    doc.end();
  });
}

// J/E: Generar ZIP del catálogo a un stream cualquiera (res HTTP o fichero).
async function generarZipCatalogoStream(catalog: any, sheets: any[], destStream: any): Promise<void> {
  const fs = require('fs');
  const path = require('path');
  const archiver = require('archiver');
  return new Promise(async (resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err: any) => {
      console.error('[ZIP] Error:', err.message);
      reject(err);
    });
    destStream.on('finish', () => resolve());
    destStream.on('error', (e: any) => reject(e));
    archive.pipe(destStream);

    // Manifest
    const manifest: any = {
      catalogo: {
        id: catalog.id,
        nombre: catalog.name,
        descripcion: catalog.description,
        version: catalog.version,
        tipo: catalog.tipo,
        fecha_descarga: new Date().toISOString(),
        total_laminas: sheets.length
      },
      laminas: sheets.map((s: any) => ({
        orden: s.orden,
        titulo: s.titulo,
        notas: s.notas,
        tags: s.tags,
        fichero: `laminas/${String(s.orden || 0).padStart(3, '0')}${path.extname(s.imagen_path || '.jpg')}`
      }))
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifiesto.json' });

    // README
    const readme = `CATALOGO: ${catalog.name}
Versión: ${catalog.version || 1}
Tipo: ${catalog.tipo}
Total láminas: ${sheets.length}
Fecha de descarga: ${new Date().toLocaleString('es-ES')}

CONTENIDO DEL ZIP:
- /laminas/      Las imágenes originales en alta resolución, numeradas en orden.
- manifiesto.json  Metadatos del catálogo (títulos, notas, tags).
- README.txt     Este archivo.

Generado por CatalogPRO v2 — LOMHIFAR S.L.
`;
    archive.append(readme, { name: 'README.txt' });

    // Láminas
    for (const sheet of sheets) {
      const imgPath = getSheetImagePath(sheet);
      if (!fs.existsSync(imgPath)) {
        console.warn('[ZIP] Imagen no encontrada: ' + imgPath);
        continue;
      }
      const ext = path.extname(sheet.imagen_path || '.jpg');
      const nombreEnZip = `laminas/${String(sheet.orden || 0).padStart(3, '0')}${ext}`;
      archive.file(imgPath, { name: nombreEnZip });
    }
    await archive.finalize();
  });
}

// GET descargar catalogo como PDF (todas las laminas en orden)
app.get('/api/catalogs/:id/download-pdf', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const acceso = await cargarCatalogoConAcceso(id, req);
    if (!acceso || 'error' in acceso) {
      const a = acceso as any;
      res.status(a?.status || 500).json({ success: false, error: a?.error || 'Error' });
      return;
    }
    const { catalog, sheets } = acceso;
    if (sheets.length === 0) {
      res.status(400).json({ success: false, error: 'Este catálogo no tiene láminas' });
      return;
    }
    const calidad = (req.query.calidad === 'pequena') ? 'pequena' : 'alta';
    const sufijo = calidad === 'pequena' ? '_pequeno' : '';
    // PDF POR ZONA: el respaldo en papel no filtra solo. Si el comercial lleva dos
    // zonas y le damos el catalogo entero, el PDF se convierte justo en el agujero
    // por el que puede ofrecer en Aragon algo que solo se vende en Navarra.
    let laminas = sheets;
    let sufZona = '';
    const zonaId = Number(req.query.zona_id) || 0;
    if (zonaId) {
      const z = await pool.query(`SELECT nombre FROM zonas_venta WHERE id=$1`, [zonaId]);
      if (z.rows.length) {
        const veto = new Set((await laminasRestringidasEnZona(zonaId)).map(Number));
        laminas = sheets.filter((s: any) => !veto.has(Number(s.id)));
        sufZona = '_' + nombreFicheroSeguro(z.rows[0].nombre);
      }
    }
    if (!laminas.length) { res.status(400).json({ success: false, error: 'No queda ninguna lámina para esa zona' }); return; }
    const filename = `${nombreFicheroSeguro(catalog.name)}_v${catalog.version || 1}${sufZona}${sufijo}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await generarPdfCatalogoStream(catalog, laminas, res, calidad);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  }
});

// GET descargar catalogo como ZIP
app.get('/api/catalogs/:id/download-zip', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const acceso = await cargarCatalogoConAcceso(id, req);
    if (!acceso || 'error' in acceso) {
      const a = acceso as any;
      res.status(a?.status || 500).json({ success: false, error: a?.error || 'Error' });
      return;
    }
    const { catalog, sheets } = acceso;
    if (sheets.length === 0) {
      res.status(400).json({ success: false, error: 'Este catálogo no tiene láminas' });
      return;
    }
    const filename = `${nombreFicheroSeguro(catalog.name)}_v${catalog.version || 1}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await generarZipCatalogoStream(catalog, sheets, res);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  }
});

// ============================================================================
// E - VERSIONES V1/V2/V3 CON HISTORIAL
// ============================================================================

// Helper: directorio donde se guardan los PDF/ZIP de versiones cerradas
function getVersionsDir(): string {
  const uploadsDir = process.env.UPLOADS_DIR || '/app/data/uploads';
  const path = require('path');
  const fs = require('fs');
  const dir = path.join(uploadsDir, 'versions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// POST cerrar versión actual del catálogo (solo admin real)
// Body: { notas_version: string } (opcional)
app.post('/api/catalogs/:id/close-version', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { notas_version } = req.body;

    // Cargar catálogo y láminas
    const acceso = await cargarCatalogoConAcceso(id, req);
    if (!acceso || 'error' in acceso) {
      const a = acceso as any;
      res.status(a?.status || 500).json({ success: false, error: a?.error || 'Error' });
      return;
    }
    const { catalog, sheets } = acceso;
    if (sheets.length === 0) {
      res.status(400).json({ success: false, error: 'No puedes cerrar versión de un catálogo vacío' });
      return;
    }

    // Calcular versión a cerrar y siguiente
    const versionACerrar = catalog.version || 1;

    // Comprobar que no exista ya esta versión cerrada (idempotencia)
    const yaCerrada = await pool.query(
      `SELECT id FROM catalog_versions WHERE catalog_id = $1 AND version_number = $2`,
      [id, versionACerrar]
    );
    if (yaCerrada.rows.length > 0) {
      res.status(400).json({ success: false, error: `La versión ${versionACerrar} ya está cerrada. Sigue editando el catálogo y vuelve a cerrar.` });
      return;
    }

    const fs = require('fs');
    const path = require('path');
    const versionsDir = getVersionsDir();
    const baseName = `${nombreFicheroSeguro(catalog.name)}_v${versionACerrar}_${Date.now()}`;
    const pdfFile = path.join(versionsDir, baseName + '.pdf');
    const zipFile = path.join(versionsDir, baseName + '.zip');

    // Snapshot JSON con metadatos completos de las láminas (orden, titulos, tags, etc)
    const snapshot = {
      version: versionACerrar,
      fecha_cierre: new Date().toISOString(),
      catalog: {
        id: catalog.id,
        name: catalog.name,
        description: catalog.description,
        tipo: catalog.tipo
      },
      sheets: sheets.map((s: any) => ({
        id: s.id,
        orden: s.orden,
        titulo: s.titulo,
        notas: s.notas,
        tags: s.tags,
        imagen_path: s.imagen_path
      }))
    };

    // Generar PDF a disco
    console.log(`[E] Generando PDF versión ${versionACerrar} de catálogo ${catalog.name}...`);
    let pdfSize = 0;
    try {
      await generarPdfCatalogoStream(catalog, sheets, fs.createWriteStream(pdfFile));
      pdfSize = fs.statSync(pdfFile).size;
      console.log(`[E] PDF OK: ${pdfFile} (${pdfSize} bytes)`);
    } catch (err) {
      console.error('[E] Error generando PDF:', err);
      throw new Error('Error generando PDF de la versión: ' + (err as Error).message);
    }

    // Generar ZIP a disco
    console.log(`[E] Generando ZIP versión ${versionACerrar}...`);
    let zipSize = 0;
    try {
      await generarZipCatalogoStream(catalog, sheets, fs.createWriteStream(zipFile));
      zipSize = fs.statSync(zipFile).size;
      console.log(`[E] ZIP OK: ${zipFile} (${zipSize} bytes)`);
    } catch (err) {
      console.error('[E] Error generando ZIP:', err);
      // No bloqueante - guardamos solo PDF si ZIP falla
    }

    // Guardar registro en catalog_versions
    const r = await pool.query(
      `INSERT INTO catalog_versions (
         catalog_id, version_number, snapshot_json, notas_version,
         published_by, pdf_path, zip_path, pdf_size_bytes, zip_size_bytes,
         total_laminas, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        versionACerrar,
        JSON.stringify(snapshot),
        (notas_version || '').toString().trim() || null,
        req.user?.id || null,
        pdfFile,
        zipSize > 0 ? zipFile : null,
        pdfSize,
        zipSize > 0 ? zipSize : null,
        sheets.length,
        'ok'
      ]
    );

    // Administracion se entera de que hay version nueva Y de lo que les toca hacer.
    // Best-effort y sin await: cerrar version no puede fallar porque el correo falle.
    avisarAdministracionDeVersion(id, versionACerrar, (notas_version || '').toString().trim() || null,
      req.user?.name || null).catch(() => {});

    // Incrementar la versión "viva" del catálogo
    await pool.query(
      `UPDATE catalogs SET version = $1, updated_at = NOW() WHERE id = $2`,
      [versionACerrar + 1, id]
    );

    // Notificación email a comerciales asignados (fire-and-forget, no bloquea)
    notificarComercialesNuevaVersion(id, versionACerrar, sheets.length, req.user?.id || null)
      .catch((e: any) => console.error('[notif] Error disparando notificación:', e.message));

    res.json({
      success: true,
      version_cerrada: versionACerrar,
      nueva_version: versionACerrar + 1,
      registro: r.rows[0]
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET listado de versiones cerradas de un catálogo (admin y comerciales asignados)
app.get('/api/catalogs/:id/versions', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    // Verificar acceso al catálogo
    const acceso = await cargarCatalogoConAcceso(id, req);
    if (!acceso || 'error' in acceso) {
      const a = acceso as any;
      res.status(a?.status || 500).json({ success: false, error: a?.error || 'Error' });
      return;
    }
    const r = await pool.query(
      `SELECT cv.id, cv.version_number, cv.notas_version, cv.published_at,
              cv.pdf_path IS NOT NULL AS tiene_pdf,
              cv.zip_path IS NOT NULL AS tiene_zip,
              cv.pdf_size_bytes, cv.zip_size_bytes, cv.total_laminas, cv.status,
              u.name AS published_by_name, u.email AS published_by_email
       FROM catalog_versions cv
       LEFT JOIN users u ON u.id = cv.published_by
       WHERE cv.catalog_id = $1
       ORDER BY cv.version_number DESC`,
      [id]
    );
    res.json({ success: true, versions: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET descargar PDF de una versión cerrada (admin + comerciales asignados al catálogo)
app.get('/api/catalog-versions/:id/download-pdf', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const versionId = Number(req.params.id);
    const r = await pool.query(
      `SELECT cv.*, c.name AS catalog_name FROM catalog_versions cv
       JOIN catalogs c ON c.id = cv.catalog_id WHERE cv.id = $1`,
      [versionId]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Versión no encontrada' });
      return;
    }
    const v = r.rows[0];
    // Verificar acceso al catálogo
    const acceso = await cargarCatalogoConAcceso(v.catalog_id, req);
    if (!acceso || 'error' in acceso) {
      const a = acceso as any;
      res.status(a?.status || 500).json({ success: false, error: a?.error || 'Error' });
      return;
    }
    if (!v.pdf_path) {
      res.status(404).json({ success: false, error: 'Esta versión no tiene PDF' });
      return;
    }
    const fs = require('fs');
    if (!fs.existsSync(v.pdf_path)) {
      res.status(404).json({ success: false, error: 'Archivo PDF no encontrado en disco' });
      return;
    }
    const filename = `${nombreFicheroSeguro(v.catalog_name)}_v${v.version_number}_historico.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(v.pdf_path).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET descargar ZIP de una versión cerrada
app.get('/api/catalog-versions/:id/download-zip', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const versionId = Number(req.params.id);
    const r = await pool.query(
      `SELECT cv.*, c.name AS catalog_name FROM catalog_versions cv
       JOIN catalogs c ON c.id = cv.catalog_id WHERE cv.id = $1`,
      [versionId]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Versión no encontrada' });
      return;
    }
    const v = r.rows[0];
    const acceso = await cargarCatalogoConAcceso(v.catalog_id, req);
    if (!acceso || 'error' in acceso) {
      const a = acceso as any;
      res.status(a?.status || 500).json({ success: false, error: a?.error || 'Error' });
      return;
    }
    if (!v.zip_path) {
      res.status(404).json({ success: false, error: 'Esta versión no tiene ZIP' });
      return;
    }
    const fs = require('fs');
    if (!fs.existsSync(v.zip_path)) {
      res.status(404).json({ success: false, error: 'Archivo ZIP no encontrado en disco' });
      return;
    }
    const filename = `${nombreFicheroSeguro(v.catalog_name)}_v${v.version_number}_historico.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(v.zip_path).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ success: false, error: (e as Error).message });
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

    // Corregir colores oscuros por perfil ICC embebido (solo PNG con perfil)
    await normalizarPngColor(req.file.path);
    // Generar miniatura WebP ~400px (no bloquea si falla)
    const miniaturaPath = await generarMiniatura(req.file.path, req.file.filename);

    const r = await pool.query(
      `INSERT INTO sheets (catalog_id, orden, titulo, notas, imagen_path, miniatura_path, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [catalogId, orden, titulo, notas, imagenPath, miniaturaPath, tags]
    );
    await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);
    await logSheetChange('created', r.rows[0].id, catalogId, r.rows[0].titulo,
      { orden: r.rows[0].orden, imagen_path: r.rows[0].imagen_path },
      { id: req.user?.id, name: req.user?.name });
    // Generar tags con IA en background (no bloquea la respuesta)
    if (!tags) generarTagsBackground(r.rows[0].id, req.file.path, r.rows[0].titulo);
    res.status(201).json({ success: true, sheet: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// INSERTAR HOJA EN BLANCO en una posicion concreta (para añadir algo olvidado).
// Genera un PNG blanco + miniatura, desplaza el orden y crea la lamina.
// body: { after_sheet_id } -> inserta JUSTO DESPUES de esa lamina; null = al principio.
// ============================================================================
app.post('/api/catalogs/:id/sheets/insert-blank', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    if (!(await assertNotExpress(catalogId, res))) return;
    const afterSheetId = req.body?.after_sheet_id ? Number(req.body.after_sheet_id) : null;

    // Determinar el orden de la nueva hoja
    let newOrden = 0;
    if (afterSheetId) {
      const s = await pool.query('SELECT orden FROM sheets WHERE id = $1 AND catalog_id = $2', [afterSheetId, catalogId]);
      if (s.rows.length === 0) { res.status(404).json({ success: false, error: 'Lámina de referencia no encontrada' }); return; }
      newOrden = Number(s.rows[0].orden) + 1;
    }
    // Hacer hueco: desplazar +1 todo lo que va en esa posicion o despues
    await pool.query('UPDATE sheets SET orden = orden + 1 WHERE catalog_id = $1 AND orden >= $2', [catalogId, newOrden]);

    // Generar imagen blanca (A4 vertical) + miniatura
    const fname = 'blank-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.png';
    const fpath = path.join(UPLOADS_DIR, fname);
    await sharp({ create: { width: 1240, height: 1754, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .png().toFile(fpath);
    const imagenPath = '/uploads/' + fname;
    const miniaturaPath = await generarMiniatura(fpath, fname);

    const r = await pool.query(
      `INSERT INTO sheets (catalog_id, orden, titulo, imagen_path, miniatura_path)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [catalogId, newOrden, '(hoja en blanco)', imagenPath, miniaturaPath]
    );
    await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);
    await logSheetChange('created', r.rows[0].id, catalogId, r.rows[0].titulo,
      { orden: r.rows[0].orden, blank: true }, { id: req.user?.id, name: req.user?.name });
    res.status(201).json({ success: true, sheet: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// SUBIDA MASIVA de láminas (multi-upload con orden secuencial por nombre)
// Acepta hasta 50 archivos por petición (límite seguro Railway).
// Frontend puede llamar varias veces si tiene >50.
// ============================================================================
const uploadMultiple = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024,      // 20 MB por archivo
    files: 50                          // hasta 50 archivos por petición
  }
});

app.post('/api/catalogs/:id/sheets/bulk', verifyToken, requireAdmin,
  uploadMultiple.array('imagenes', 50),
  async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    if (!(await assertNotExpress(catalogId, res))) return;
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ success: false, error: 'No se han subido archivos' });
      return;
    }
    // Validar todos son imágenes
    for (const f of files) {
      if (!f.mimetype.startsWith('image/')) {
        // Limpiar todos los archivos subidos
        const fs = require('fs');
        for (const fx of files) {
          try { fs.unlinkSync(fx.path); } catch (_) {}
        }
        res.status(400).json({
          success: false,
          error: `Solo se aceptan imágenes. "${f.originalname}" es ${f.mimetype}`
        });
        return;
      }
    }
    // ORDEN: alfabético por nombre original (los nombres deben venir con 001, 002...)
    files.sort((a, b) => a.originalname.localeCompare(b.originalname, 'es', { numeric: true }));

    // Obtener el siguiente orden disponible
    const maxR = await pool.query(
      'SELECT COALESCE(MAX(orden),0) AS max_orden FROM sheets WHERE catalog_id = $1',
      [catalogId]
    );
    let ordenSiguiente = Number(maxR.rows[0].max_orden) + 1;

    const insertadas: any[] = [];
    const errores: any[] = [];

    for (const f of files) {
      try {
        const imagenPath = '/uploads/' + f.filename;
        // Título: el nombre del archivo sin extensión (limpio)
        const tituloAuto = f.originalname.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || `Lámina ${ordenSiguiente}`;
        // Corregir colores oscuros por perfil ICC embebido (solo PNG con perfil)
        await normalizarPngColor(f.path);
        // Generar miniatura WebP (si falla queda null y se usa imagen_path)
        const miniaturaPath = await generarMiniatura(f.path, f.filename);
        const r = await pool.query(
          `INSERT INTO sheets (catalog_id, orden, titulo, notas, imagen_path, miniatura_path, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [catalogId, ordenSiguiente, tituloAuto, '', imagenPath, miniaturaPath, '']
        );
        insertadas.push(r.rows[0]);
        await logSheetChange('created', r.rows[0].id, catalogId, r.rows[0].titulo,
          { orden: r.rows[0].orden, imagen_path: r.rows[0].imagen_path, origen: 'bulk' },
          { id: req.user?.id, name: req.user?.name });
        // Generar tags con IA en background (no bloquea la respuesta)
        generarTagsBackground(r.rows[0].id, f.path, r.rows[0].titulo);
        ordenSiguiente++;
      } catch (e: any) {
        errores.push({ archivo: f.originalname, error: e.message });
        // Si falla la BD, también borrar el archivo físico
        try { require('fs').unlinkSync(f.path); } catch (_) {}
      }
    }

    if (insertadas.length > 0) {
      await pool.query('UPDATE catalogs SET updated_at = NOW() WHERE id = $1', [catalogId]);
    }

    res.json({
      success: errores.length === 0,
      total: files.length,
      insertadas: insertadas.length,
      errores: errores,
      sheets: insertadas
    });
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
// ============================================================================
// ZONAS DE VENTA: que NO se puede vender en el territorio de cada cliente
// ============================================================================

// Zona del cliente, en cascada de mas fiable a menos:
//   1) la que se le haya fijado a mano (zona_id)  2) los 2 primeros digitos del CP
//   3) el nombre de la provincia
// Devuelve null si no se puede saber: entonces se pregunta al empezar la visita.
async function zonaDeCliente(clientId: number): Promise<any | null> {
  const c = await pool.query(`SELECT id, zona_id, cp, provincia FROM clients WHERE id=$1`, [clientId]);
  if (!c.rows.length) return null;
  const cli = c.rows[0];
  if (cli.zona_id) {
    const z = await pool.query(`SELECT * FROM zonas_venta WHERE id=$1`, [cli.zona_id]);
    if (z.rows.length) return { ...z.rows[0], fuente: 'fijada a mano' };
  }
  const zonas = (await pool.query(`SELECT * FROM zonas_venta ORDER BY orden, nombre`)).rows;
  const cp = String(cli.cp || '').replace(/\D/g, '');
  if (cp.length >= 4) {
    const pref = cp.padStart(5, '0').slice(0, 2);
    const z = zonas.find((x: any) => String(x.prefijos_cp || '').split(',').map((s: string) => s.trim()).includes(pref));
    if (z) return { ...z, fuente: 'código postal' };
  }
  const prov = String(cli.provincia || '').trim().toLowerCase();
  if (prov) {
    // Comparacion sin tildes: "alava" casa con "Álava", "guipuzcoa" con "Gipuzkoa" no,
    // asi que se admiten tambien las grafias castellanas mas habituales.
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const alias: Record<string, string> = {
      'guipuzcoa': 'gipuzkoa', 'guipuzkoa': 'gipuzkoa', 'gipuzcoa': 'gipuzkoa',
      'vizcaya': 'vizcaya', 'bizkaia': 'vizcaya', 'araba': 'alava',
      'zaragoza': 'aragon', 'huesca': 'aragon', 'teruel': 'aragon'
    };
    const buscado = alias[norm(prov)] || norm(prov);
    const z = zonas.find((x: any) => norm(x.nombre) === buscado);
    if (z) return { ...z, fuente: 'provincia' };
  }
  return null;
}

// Laminas que NO se pueden ensenar en esa zona (por laboratorio o por lamina suelta).
async function laminasRestringidasEnZona(zonaId: number): Promise<number[]> {
  const r = await pool.query(
    `SELECT DISTINCT s.id
       FROM zona_restricciones zr
       LEFT JOIN sheet_categorias sc ON sc.categoria_id = zr.categoria_id
       JOIN sheets s ON s.id = COALESCE(zr.sheet_id, sc.sheet_id)
      WHERE zr.zona_id = $1`, [zonaId]);
  return r.rows.map((x: any) => Number(x.id));
}

app.get('/api/zonas', verifyToken, async (_req: AuthRequest, res: Response) => {
  try {
    const z = await pool.query(
      `SELECT z.*, (SELECT COUNT(*)::int FROM clients c WHERE c.zona_id = z.id) AS n_clientes,
              (SELECT COUNT(*)::int FROM zona_restricciones r WHERE r.zona_id = z.id) AS n_restricciones
         FROM zonas_venta z ORDER BY z.orden, z.nombre`);
    res.json({ success: true, zonas: z.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Restricciones de una zona + catalogo de categorias para el desplegable.
app.get('/api/zonas/:id/restricciones', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const zonaId = Number(req.params.id);
    const r = await pool.query(
      `SELECT zr.id, zr.categoria_id, zr.sheet_id, zr.motivo, zr.created_at,
              cat.nombre AS categoria, cat.color, s.titulo AS lamina, s.orden AS lamina_orden
         FROM zona_restricciones zr
         LEFT JOIN categorias cat ON cat.id = zr.categoria_id
         LEFT JOIN sheets s ON s.id = zr.sheet_id
        WHERE zr.zona_id = $1 ORDER BY cat.nombre NULLS LAST, s.orden`, [zonaId]);
    const cats = await pool.query(`SELECT id, nombre, color FROM categorias ORDER BY orden, nombre`);
    res.json({ success: true, restricciones: r.rows, categorias: cats.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.post('/api/zonas/:id/restricciones', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const zonaId = Number(req.params.id);
    const catId = req.body?.categoria_id ? Number(req.body.categoria_id) : null;
    const sheetId = req.body?.sheet_id ? Number(req.body.sheet_id) : null;
    if (!catId && !sheetId) { res.status(400).json({ success: false, error: 'Elige un laboratorio o una lámina' }); return; }
    await pool.query(
      `INSERT INTO zona_restricciones (zona_id, categoria_id, sheet_id, motivo, creado_por)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [zonaId, catId, sheetId, (req.body?.motivo || '').toString().slice(0, 200) || null, req.user?.name || null]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.delete('/api/zonas/restricciones/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(`DELETE FROM zona_restricciones WHERE id=$1`, [Number(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// LO QUE USA LA VISITA: zona del cliente + laminas que hay que ocultarle.
app.get('/api/clients/:id/zona', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = Number(req.params.id);
    const zona = await zonaDeCliente(clientId);
    const restringidas = zona ? await laminasRestringidasEnZona(Number(zona.id)) : [];
    res.json({ success: true, zona, restringidas });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Fijar la zona de un cliente (lo hace el comercial al empezar la visita si no se sabe).
app.put('/api/clients/:id/zona', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const zonaId = req.body?.zona_id ? Number(req.body.zona_id) : null;
    await pool.query(`UPDATE clients SET zona_id=$1, updated_at=NOW() WHERE id=$2`, [zonaId, Number(req.params.id)]);
    const zona = await zonaDeCliente(Number(req.params.id));
    const restringidas = zona ? await laminasRestringidasEnZona(Number(zona.id)) : [];
    res.json({ success: true, zona, restringidas });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Rellenar zonas de golpe a partir del CP / provincia que ya tengan los clientes.
app.post('/api/zonas/deducir', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const cs = await pool.query(`SELECT id FROM clients WHERE zona_id IS NULL AND is_active = TRUE`);
    let hechos = 0;
    for (const c of cs.rows) {
      const z = await zonaDeCliente(Number(c.id));
      if (z && z.fuente !== 'fijada a mano') {
        await pool.query(`UPDATE clients SET zona_id=$1 WHERE id=$2`, [z.id, c.id]);
        hechos++;
      }
    }
    res.json({ success: true, revisados: cs.rows.length, asignados: hechos, sin_datos: cs.rows.length - hechos });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// --- Reglas por categoria/laboratorio ---
app.get('/api/reparto/reglas', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT r.id, r.categoria_id, r.express_catalog_id, r.activa,
              cat.nombre AS categoria, cat.color, c.name AS express
         FROM reparto_reglas r
         JOIN categorias cat ON cat.id = r.categoria_id
         JOIN catalogs c ON c.id = r.express_catalog_id
        ORDER BY cat.nombre, c.name`);
    const cats = await pool.query(`SELECT id, nombre, color FROM categorias ORDER BY orden, nombre`);
    const exps = await pool.query(`SELECT id, name FROM catalogs WHERE tipo='express' AND estado <> 'archivado' ORDER BY name`);
    res.json({ success: true, reglas: r.rows, categorias: cats.rows, express: exps.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.post('/api/reparto/reglas', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catId = Number(req.body?.categoria_id), expId = Number(req.body?.express_catalog_id);
    if (!catId || !expId) { res.status(400).json({ success: false, error: 'Elige la categoría y el catálogo' }); return; }
    const c = await pool.query(`SELECT tipo FROM catalogs WHERE id=$1`, [expId]);
    if (!c.rows.length || c.rows[0].tipo !== 'express') { res.status(400).json({ success: false, error: 'El destino debe ser un catálogo Express' }); return; }
    const r = await pool.query(
      `INSERT INTO reparto_reglas (categoria_id, express_catalog_id) VALUES ($1,$2)
       ON CONFLICT (categoria_id, express_catalog_id) DO UPDATE SET activa = TRUE RETURNING *`, [catId, expId]);
    res.json({ success: true, regla: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.delete('/api/reparto/reglas/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(`DELETE FROM reparto_reglas WHERE id=$1`, [Number(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Aplicar una regla RETROACTIVAMENTE a las laminas que ya tienen esa categoria.
app.post('/api/reparto/reglas/:id/aplicar', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`SELECT categoria_id FROM reparto_reglas WHERE id=$1`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'Regla no encontrada' }); return; }
    const laminas = await pool.query(
      `SELECT sc.sheet_id FROM sheet_categorias sc JOIN sheets s ON s.id = sc.sheet_id
        WHERE sc.categoria_id = $1 ORDER BY s.orden, s.id`, [r.rows[0].categoria_id]);
    let n = 0;
    for (const l of laminas.rows) { const x = await repartirLamina(Number(l.sheet_id)); n += x.anadida_en.length; }
    res.json({ success: true, laminas: laminas.rows.length, anadidas: n });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// --- Excepciones de una lamina concreta (mandan sobre las reglas) ---
app.get('/api/sheets/:id/reparto', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.id);
    const d = await destinosDeLamina(sheetId);
    const exps = await pool.query(
      `SELECT c.id, c.name,
              (SELECT 1 FROM express_sheets es WHERE es.express_catalog_id = c.id AND es.sheet_id = $1) AS dentro
         FROM catalogs c WHERE c.tipo='express' AND c.estado <> 'archivado' ORDER BY c.name`, [sheetId]);
    const exc = await pool.query(
      `SELECT express_catalog_id, modo, motivo FROM reparto_excepciones WHERE sheet_id=$1`, [sheetId]);
    res.json({
      success: true,
      express: exps.rows.map((c: any) => ({
        id: c.id, name: c.name,
        dentro: !!c.dentro,
        por_regla: d.porRegla.includes(Number(c.id)),
        excepcion: exc.rows.find((e: any) => Number(e.express_catalog_id) === Number(c.id)) || null,
        destino_final: d.destinos.includes(Number(c.id))
      }))
    });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.post('/api/sheets/:id/reparto/excepcion', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.id);
    const expId = Number(req.body?.express_catalog_id);
    const modo = req.body?.modo;
    if (!expId) { res.status(400).json({ success: false, error: 'Falta el catálogo' }); return; }
    if (modo === null || modo === 'auto') {          // quitar la excepción: vuelve a mandar la regla
      await pool.query(`DELETE FROM reparto_excepciones WHERE sheet_id=$1 AND express_catalog_id=$2`, [sheetId, expId]);
    } else {
      if (!['incluir', 'excluir'].includes(modo)) { res.status(400).json({ success: false, error: 'Modo inválido' }); return; }
      await pool.query(
        `INSERT INTO reparto_excepciones (sheet_id, express_catalog_id, modo, motivo, creado_por)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (sheet_id, express_catalog_id)
         DO UPDATE SET modo=EXCLUDED.modo, motivo=EXCLUDED.motivo, creado_por=EXCLUDED.creado_por`,
        [sheetId, expId, modo, (req.body?.motivo || '').toString().slice(0, 200) || null, req.user?.name || null]);
      // "excluir" tiene efecto inmediato: si ya estaba dentro, se saca.
      if (modo === 'excluir') {
        await pool.query(`DELETE FROM express_sheets WHERE express_catalog_id=$1 AND sheet_id=$2`, [expId, sheetId]);
      } else {
        await insertarEnExpressPorPosicion(expId, sheetId, false);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Repartir a mano (o volver a repartir) una lamina concreta.
app.post('/api/sheets/:id/reparto/aplicar', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await repartirLamina(Number(req.params.id));
    res.json({ success: true, ...r });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// BANDEJA: laminas del maestro que no estan en NINGUN Express. La red de seguridad
// para que una lamina nueva no se quede sin llegar a nadie por un despiste.
app.get('/api/reparto/sin-repartir', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.query.catalog_id) || null;
    const r = await pool.query(
      `SELECT s.id, s.titulo, s.orden, s.catalog_id, s.created_at,
              (SELECT COUNT(*)::int FROM sheet_categorias sc WHERE sc.sheet_id = s.id) AS n_categorias
         FROM sheets s
         JOIN catalogs c ON c.id = s.catalog_id AND c.tipo = 'maestro'
        WHERE s.oculta = FALSE
          AND ($1::int IS NULL OR s.catalog_id = $1)
          AND NOT EXISTS (SELECT 1 FROM express_sheets es WHERE es.sheet_id = s.id)
          AND EXISTS (SELECT 1 FROM catalogs e WHERE e.tipo='express' AND e.parent_id = s.catalog_id)
        ORDER BY s.created_at DESC, s.orden LIMIT 200`, [catalogId]);
    res.json({ success: true, laminas: r.rows, total: r.rows.length });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Validar (dar por buenas) las laminas que llegaron solas a un Express.
app.post('/api/catalogs/:id/express-sheets/validar-auto', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `UPDATE express_sheets SET auto_reparto = FALSE, validada_at = NOW()
        WHERE express_catalog_id = $1 AND auto_reparto = TRUE RETURNING id`, [Number(req.params.id)]);
    res.json({ success: true, validadas: r.rowCount || 0 });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// ============================================================================
// REPARTO DE UNA LAMINA A LOS EXPRESS
// Destinos = los Express que casan por REGLA (categoria/laboratorio), corregidos por
// las EXCEPCIONES de esa lamina, que siempre mandan. La lamina se coloca en su sitio
// RELATIVO: justo detras del vecino que tenga delante en el maestro, porque cada
// Express lleva su propio orden y "la posicion 12 del maestro" no significa nada alli.
// ============================================================================
async function destinosDeLamina(sheetId: number): Promise<{ destinos: number[]; porRegla: number[]; excluidos: number[]; incluidos: number[] }> {
  const porReglaR = await pool.query(
    `SELECT DISTINCT r.express_catalog_id AS id
       FROM sheet_categorias sc
       JOIN reparto_reglas r ON r.categoria_id = sc.categoria_id AND r.activa = TRUE
       JOIN catalogs c ON c.id = r.express_catalog_id AND c.tipo = 'express'
      WHERE sc.sheet_id = $1`, [sheetId]);
  const porRegla = porReglaR.rows.map((x: any) => Number(x.id));
  const excR = await pool.query(
    `SELECT e.express_catalog_id AS id, e.modo FROM reparto_excepciones e
       JOIN catalogs c ON c.id = e.express_catalog_id AND c.tipo = 'express'
      WHERE e.sheet_id = $1`, [sheetId]);
  const excluidos = excR.rows.filter((x: any) => x.modo === 'excluir').map((x: any) => Number(x.id));
  const incluidos = excR.rows.filter((x: any) => x.modo === 'incluir').map((x: any) => Number(x.id));
  const destinos = Array.from(new Set([...porRegla, ...incluidos])).filter(id => !excluidos.includes(id));
  return { destinos, porRegla, excluidos, incluidos };
}

// Inserta la lamina en un Express justo detras del vecino que la precede en el maestro.
async function insertarEnExpressPorPosicion(expressId: number, sheetId: number, auto: boolean): Promise<boolean> {
  const ya = await pool.query(
    `SELECT 1 FROM express_sheets WHERE express_catalog_id=$1 AND sheet_id=$2`, [expressId, sheetId]);
  if (ya.rows.length) return false;   // ya la tiene: no se toca ni su posicion
  // Vecino: la lamina mas cercana POR DELANTE en el maestro que tambien este en el Express.
  const vecino = await pool.query(
    `SELECT es.orden
       FROM sheets s
       JOIN express_sheets es ON es.sheet_id = s.id AND es.express_catalog_id = $1
      WHERE s.catalog_id = (SELECT catalog_id FROM sheets WHERE id = $2)
        AND (s.orden, s.id) < (SELECT orden, id FROM sheets WHERE id = $2)
      ORDER BY s.orden DESC, s.id DESC LIMIT 1`, [expressId, sheetId]);
  const ordenDestino = vecino.rows.length ? Number(vecino.rows[0].orden) + 1 : 1;
  await pool.query(
    `UPDATE express_sheets SET orden = orden + 1 WHERE express_catalog_id=$1 AND orden >= $2`,
    [expressId, ordenDestino]);
  await pool.query(
    `INSERT INTO express_sheets (express_catalog_id, sheet_id, orden, auto_reparto)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [expressId, sheetId, ordenDestino, auto]);
  return true;
}

async function repartirLamina(sheetId: number): Promise<{ anadida_en: any[]; destinos: number[] }> {
  const { destinos } = await destinosDeLamina(sheetId);
  const anadida: any[] = [];
  for (const expressId of destinos) {
    try {
      const ok = await insertarEnExpressPorPosicion(expressId, sheetId, true);
      if (ok) {
        const c = await pool.query(`SELECT name FROM catalogs WHERE id=$1`, [expressId]);
        anadida.push({ catalog_id: expressId, nombre: c.rows[0]?.name || '' });
      }
    } catch (e) { console.warn('[reparto] express ' + expressId + ':', (e as Error).message); }
  }
  return { anadida_en: anadida, destinos };
}

// Copiar TODAS las laminas del maestro a un Express que ya existe, respetando su orden.
// Para los Express creados antes de que esto fuera el comportamiento por defecto, y para
// "empezar de cero desde el maestro" si te has liado quitando laminas.
app.post('/api/catalogs/:id/express-sheets/copiar-maestro', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const expressId = Number(req.params.id);
    const c = await pool.query(`SELECT tipo, parent_id FROM catalogs WHERE id=$1`, [expressId]);
    if (!c.rows.length || c.rows[0].tipo !== 'express') { res.status(400).json({ success: false, error: 'Solo aplicable a catálogos Express' }); return; }
    if (!c.rows[0].parent_id) { res.status(400).json({ success: false, error: 'Express sin maestro padre' }); return; }
    // reemplazar=true: se vacia antes, para recuperar exactamente el orden del maestro.
    if (req.body?.reemplazar === true) {
      await pool.query(`DELETE FROM express_sheets WHERE express_catalog_id=$1`, [expressId]);
    }
    const base = await pool.query(
      `SELECT COALESCE(MAX(orden),0) AS m FROM express_sheets WHERE express_catalog_id=$1`, [expressId]);
    const r = await pool.query(
      `INSERT INTO express_sheets (express_catalog_id, sheet_id, orden)
       SELECT $1, id, $3 + ROW_NUMBER() OVER (ORDER BY orden, id)
         FROM sheets WHERE catalog_id = $2 AND oculta = FALSE
       ON CONFLICT (express_catalog_id, sheet_id) DO NOTHING
       RETURNING id`, [expressId, c.rows[0].parent_id, Number(base.rows[0].m)]);
    res.json({ success: true, anadidas: r.rowCount || 0 });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

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
    // Snapshot ANTES para saber que cambio
    const antesR = await pool.query('SELECT titulo, notas, tags FROM sheets WHERE id=$1', [id]);
    const antes = antesR.rows[0] || {};
    const r = await pool.query(
      `UPDATE sheets SET titulo=$1, notas=$2, tags=$3, enlace_externo_url=$4, enlace_externo_titulo=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [titulo, notas, tags, enlace_externo_url || null, enlace_externo_titulo || null, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    // Solo loguear si algo cambio realmente
    const cambios: any = {};
    if (antes.titulo !== r.rows[0].titulo) cambios.titulo = { antes: antes.titulo, ahora: r.rows[0].titulo };
    if (antes.notas !== r.rows[0].notas) cambios.notas = { antes: antes.notas, ahora: r.rows[0].notas };
    if (antes.tags !== r.rows[0].tags) cambios.tags = { antes: antes.tags, ahora: r.rows[0].tags };
    if (Object.keys(cambios).length > 0) {
      await logSheetChange('updated_meta', id, r.rows[0].catalog_id, r.rows[0].titulo,
        cambios, { id: req.user?.id, name: req.user?.name });
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
    // Capturar paths antiguos para borrar tras commit
    const oldR = await pool.query('SELECT imagen_path, miniatura_path FROM sheets WHERE id=$1', [id]);
    const oldImagen = oldR.rows[0]?.imagen_path;
    const oldMini = oldR.rows[0]?.miniatura_path;

    const nuevoPath = '/uploads/' + req.file.filename;
    // Corregir colores oscuros por perfil ICC embebido
    await normalizarPngColor(req.file.path);
    // Regenerar miniatura tras sustituir imagen
    const nuevaMini = await generarMiniatura(req.file.path, req.file.filename);
    const r = await pool.query(
      `UPDATE sheets SET imagen_path=$1, miniatura_path=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [nuevoPath, nuevaMini, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    // Borrar archivos antiguos del disco (no bloquea respuesta si falla)
    borrarUploadSeguro(oldImagen);
    borrarUploadSeguro(oldMini);
    await logSheetChange('updated_image', id, r.rows[0].catalog_id, r.rows[0].titulo,
      { imagen_path_nueva: nuevoPath, imagen_path_anterior: oldImagen },
      { id: req.user?.id, name: req.user?.name });
    res.json({ success: true, sheet: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// Eliminar lamina
app.delete('/api/sheets/:id', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    // Snapshot ANTES para audit
    const antesR = await pool.query('SELECT catalog_id, titulo, tags FROM sheets WHERE id=$1', [id]);
    const antes = antesR.rows[0];
    const r = await pool.query('DELETE FROM sheets WHERE id = $1 RETURNING imagen_path, miniatura_path', [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    // Limpiar archivos huerfanos en disco
    borrarUploadSeguro(r.rows[0].imagen_path);
    borrarUploadSeguro(r.rows[0].miniatura_path);
    if (antes) {
      await logSheetChange('deleted', id, antes.catalog_id, antes.titulo,
        { tags: antes.tags }, { id: req.user?.id, name: req.user?.name });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// AI-TAGS - regenerar tags de una lamina concreta y backfill
// ============================================================================

// Regenera tags de UNA lamina (sincrono; el llamador espera unos segundos).
// Devuelve los tags generados.
app.post('/api/sheets/:id/regenerate-tags', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const s = await pool.query('SELECT id, titulo, imagen_path FROM sheets WHERE id = $1', [id]);
    if (s.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    const abs = resolverRutaImagen(s.rows[0].imagen_path, UPLOADS_DIR);
    if (!abs || !fs.existsSync(abs)) {
      res.status(400).json({ success: false, error: 'La imagen no existe en disco' });
      return;
    }
    const tags = await generarTagsIA(abs, s.rows[0].titulo);
    if (!tags) {
      res.status(500).json({ success: false, error: 'La IA no devolvio tags (revisa OPENAI_API_KEY o intenta de nuevo)' });
      return;
    }
    await pool.query('UPDATE sheets SET tags = $1, updated_at = NOW() WHERE id = $2', [tags, id]);
    res.json({ success: true, tags });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Backfill: genera tags para laminas SIN tags. limit por peticion (default 20).
// Idempotente y llamable en bucle desde el frontend hasta agotar.
app.post('/api/admin/backfill-tags', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const pend = await pool.query(
      `SELECT id, titulo, imagen_path FROM sheets
       WHERE (tags IS NULL OR tags = '') AND imagen_path IS NOT NULL
       ORDER BY id
       LIMIT $1`,
      [limit]
    );
    let ok = 0, ko = 0;
    const fallos: any[] = [];
    for (const row of pend.rows) {
      const abs = resolverRutaImagen(row.imagen_path, UPLOADS_DIR);
      if (!abs || !fs.existsSync(abs)) { ko++; fallos.push({ id: row.id, motivo: 'no en disco' }); continue; }
      const tags = await generarTagsIA(abs, row.titulo);
      if (!tags) { ko++; fallos.push({ id: row.id, motivo: 'IA sin respuesta' }); continue; }
      await pool.query('UPDATE sheets SET tags = $1, updated_at = NOW() WHERE id = $2 AND (tags IS NULL OR tags = $3)', [tags, row.id, '']);
      ok++;
    }
    const restantesR = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sheets WHERE (tags IS NULL OR tags = '') AND imagen_path IS NOT NULL`
    );
    res.json({ success: true, procesadas: pend.rows.length, ok, fallidas: ko, restantes: restantesR.rows[0].n, fallos: fallos.slice(0, 10) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// Match por NOMBRE/modelo: fallback cuando la lamina no trae Codigo Nacional
// (tipico en gafas de presbicia, gafas de sol, accesorios...). La IA lee el
// modelo ("Gafas Verona") y aqui lo casamos contra products.nombre exigiendo
// que TODAS las palabras significativas aparezcan (en cualquier orden).
// Devuelve { producto, ambiguo } — ambiguo=true si el modelo tiene varias
// variantes en Sage (p.ej. +1.0..+3.0), en cuyo caso enlazamos a la 1a como
// referencia de familia pero avisamos de que hay que afinar dioptria/color.
// ============================================================================
const STOPWORDS_MATCH = new Set([
  'gafa', 'gafas', 'de', 'del', 'la', 'el', 'los', 'las', 'con', 'sin', 'para',
  'y', 'o', 'a', 'en', 'por', 'un', 'una', 'modelo', 'pack', 'unidad', 'unidades',
  'ud', 'uds', 'expositor', 'surtido', 'color', 'colores', 'talla', 'nuevo', 'nueva'
]);
async function matchProductoPorNombre(descripcion: string | null): Promise<{ producto: any; ambiguo: boolean } | null> {
  if (!descripcion) return null;
  const palabras = descripcion
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
    .replace(/[^a-z0-9+\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS_MATCH.has(w));
  if (palabras.length === 0) return null;
  // Construir condicion AND: nombre debe contener cada palabra clave
  const conds = palabras.map((_, i) => `LOWER(nombre) LIKE '%' || $${i + 1} || '%'`).join(' AND ');
  const r = await pool.query(
    `SELECT id, codigo, nombre, precio_pvf_1, precio_pvpr_1, activo
     FROM products WHERE ${conds} ORDER BY nombre LIMIT 20`,
    palabras
  );
  if (r.rows.length === 0) return null;
  return { producto: r.rows[0], ambiguo: r.rows.length > 1 };
}

// ============================================================================
// FAMILIAS con variantes (gafas de presbicia: color x graduacion).
// Dado un "ref" (modelo, ej. "verona"), busca todos sus SKUs en products y los
// descompone en ejes: graduacion (parseada del "+X.X" del nombre) y color
// (los tokens que VARIAN entre SKUs; si no varia ninguno -> sin eje color).
// Devuelve la estructura lista para pintar selectores en el visor del cliente.
// ============================================================================
const STOPWORDS_FAMILIA = new Set([
  'gafa', 'gafas', 'modelo', 'mujer', 'hombre', 'unisex', 'presbicia', 'lectura',
  'vista', 'cansada', 'de', 'para', 'con', 'sin', 'la', 'el', 'los', 'las', 'und', 'uds'
]);
const COLORES_CONOCIDOS = new Set([
  'AZUL', 'ROJO', 'ROJA', 'ROSA', 'BEIGE', 'NEGRO', 'NEGRA', 'VERDE', 'NARANJA',
  'CARNE', 'BLANCO', 'BLANCA', 'AMARILLO', 'MORADO', 'GRIS', 'MARRON', 'CAREY',
  'TRANSPARENTE', 'LILA', 'CELESTE', 'FUCSIA', 'DORADO', 'PLATA', 'VIOLETA',
  'TURQUESA', 'NUDE', 'CORAL', 'AZULES', 'GRANATE'
]);
function gradNum(g: string): number { return parseFloat(g.replace('+', '')) || 0; }

// Descompone un nombre de producto en sus EJES (formato/graduacion/talla/color)
// reconocidos por patron, y devuelve la "base" (nombre sin esos ejes) que sirve
// para agrupar SKUs de una misma familia sin mezclar productos distintos.
function extraerEjesProducto(nombreRaw: string): { ejes: Record<string, string>; base: string } {
  const nombre = (nombreRaw || '').toUpperCase();
  const ejes: Record<string, string> = {};
  let base = nombre;

  // FORMATO: expositor completo vs unidad suelta (prefijo EXP. / EXPOSITOR)
  ejes.formato = /\bEXP\.?\b|EXPOSITOR/.test(nombre) ? 'Expositor completo' : 'Suelto';
  base = base.replace(/\bEXP\.?\b|EXPOSITOR(ES)?/g, ' ');

  // GRADUACION +X.X (gafas de presbicia)
  const g = nombre.match(/\+\s?(\d)(?:[.,](\d))?/);
  if (g) { ejes.graduacion = `+${g[1]}.${g[2] || '0'}`; base = base.replace(/\+\s?\d(?:[.,]\d)?/g, ' '); }

  // TALLA: T/XX o T-XX (guantes), TALLA XX, o rango (35-40).
  // Normalizamos "T/GRD"/"T-G" etc. tal cual aparecen; el separador / o - da igual.
  const t1 = nombre.match(/\bT[\/\-]\s?([A-ZÑ0-9]+)/);
  const t2 = nombre.match(/\bTALLA\s+([A-Z0-9]+)/);
  const t3 = nombre.match(/\((\d{2,3})\s*-\s*(\d{2,3})\)/);
  if (t1) ejes.talla = t1[1];
  else if (t2) ejes.talla = t2[1];
  else if (t3) ejes.talla = `${t3[1]}-${t3[2]}`;
  if (ejes.talla) {
    base = base.replace(/\bT[\/\-]\s?[A-ZÑ0-9]+/g, ' ')
               .replace(/\bTALLA\s+[A-Z0-9]+/g, ' ')
               .replace(/\(\d{2,3}\s*-\s*\d{2,3}\)/g, ' ');
  }

  // COLOR: *XXX* entre asteriscos, o una palabra de color conocida
  const cAst = nombre.match(/\*([^*]+)\*/);
  if (cAst) { ejes.color = cAst[1].trim(); base = base.replace(/\*[^*]+\*/g, ' '); }
  else {
    const tok = nombre.replace(/[^A-ZÑ\s]/g, ' ').split(/\s+/).find(t => COLORES_CONOCIDOS.has(t));
    if (tok) { ejes.color = tok; base = base.replace(new RegExp('\\b' + tok + '\\b'), ' '); }
  }

  // BASE limpia: quitar cantidades entre parentesis, simbolos y stopwords genericas
  base = base
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-ZÑ0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS_FAMILIA.has(t.toLowerCase()))
    .join(' ')
    .trim();

  return { ejes, base };
}

// Ejes en el orden en que se muestran los selectores al cliente
const EJES_DEF: Array<{ key: string; label: string }> = [
  { key: 'color', label: 'Color' },
  { key: 'talla', label: 'Talla' },
  { key: 'graduacion', label: 'Graduación' },
  { key: 'formato', label: 'Formato' }
];

async function resolverFamilia(ref: string | null): Promise<any | null> {
  if (!ref) return null;
  const palabras = ref
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS_FAMILIA.has(w) && !/^\+?\d/.test(w));
  if (palabras.length === 0) return null;
  // Cada palabra: subcadena O parecida por trigramas (tolera erratas "ellorca"->"llorca").
  // Igual criterio que /api/products/search. Orden de palabras ya indiferente (AND).
  const conds = palabras.map((_, i) => `(LOWER(nombre) LIKE '%' || $${i + 1} || '%' OR word_similarity($${i + 1}, LOWER(nombre)) > 0.45)`).join(' AND ');
  const r = await pool.query(
    `SELECT id, codigo, nombre, ean, precio_pvf_1, precio_pvpr_1, precio_pvf, activo
     FROM products WHERE ${conds} AND activo = TRUE ORDER BY nombre LIMIT 200`,
    palabras
  );
  if (r.rows.length === 0) return null;

  // Agrupar por BASE: productos con la misma base son la misma familia.
  // Asi NO mezclamos productos distintos de una marca (Fixotape tira nasal != venda).
  const grupos = new Map<string, any[]>();
  for (const p of r.rows) {
    const { ejes, base } = extraerEjesProducto(p.nombre);
    if (!base) continue;
    if (!grupos.has(base)) grupos.set(base, []);
    grupos.get(base)!.push({ p, ejes });
  }
  if (grupos.size === 0) return null;

  // Elegir el grupo que MEJOR casa con lo que leyo la IA (mas palabras del ref en la base),
  // desempatando por numero de variantes.
  let mejor: { base: string; items: any[] } | null = null;
  let mejorScore = -1;
  for (const [base, items] of grupos) {
    const bl = base.toLowerCase();
    const score = palabras.filter(w => bl.includes(w)).length * 1000 + items.length;
    if (score > mejorScore) { mejorScore = score; mejor = { base, items }; }
  }
  if (!mejor) return null;
  const items = mejor.items;

  const variantes = items.map(({ p, ejes }: any) => ({
    product_id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    ean: p.ean,
    ejes,                                            // { color, talla, graduacion, formato }
    pvf: p.precio_pvf_1 ?? p.precio_pvf ?? null,
    pvpr: p.precio_pvpr_1 ?? null
  }));

  // Solo son "ejes a elegir" los que tienen MAS DE UN valor distinto
  const ejes: Array<{ key: string; label: string; valores: string[] }> = [];
  for (const def of EJES_DEF) {
    let valores = Array.from(new Set(items.map((it: any) => it.ejes[def.key]).filter(Boolean)));
    if (def.key === 'graduacion') valores = valores.sort((a, b) => gradNum(a) - gradNum(b));
    if (valores.length > 1) ejes.push({ key: def.key, label: def.label, valores });
  }

  return {
    ref,
    modelo: mejor.base,
    n_variantes: variantes.length,
    ejes,          // selectores a mostrar (0..N). Si esta vacio, es 1 solo producto.
    variantes
  };
}

// Igual que resolverFamilia pero a partir de una LISTA CONCRETA de product_ids que el
// admin ha curado a mano. Reusa la extraccion de ejes; no busca por nombre (cero adivinar).
async function resolverFamiliaPorIds(ids: number[]): Promise<any | null> {
  const limpios = Array.from(new Set((ids || []).map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0)));
  if (limpios.length === 0) return null;
  const r = await pool.query(
    `SELECT id, codigo, nombre, ean, precio_pvf_1, precio_pvpr_1, precio_pvf, activo
     FROM products WHERE id = ANY($1::int[])`,
    [limpios]
  );
  if (r.rows.length === 0) return null;
  // Mantener el orden en que el admin los guardo
  const porId = new Map<number, any>(r.rows.map((p: any) => [p.id, p]));
  const ordenados = limpios.map(id => porId.get(id)).filter(Boolean);
  const variantes = ordenados.map((p: any) => {
    const { ejes } = extraerEjesProducto(p.nombre);
    return {
      product_id: p.id, codigo: p.codigo, nombre: p.nombre, ean: p.ean,
      ejes, pvf: p.precio_pvf_1 ?? p.precio_pvf ?? null, pvpr: p.precio_pvpr_1 ?? null,
      activo: p.activo
    };
  });
  const ejes: Array<{ key: string; label: string; valores: string[] }> = [];
  for (const def of EJES_DEF) {
    let valores = Array.from(new Set(variantes.map((v: any) => v.ejes[def.key]).filter(Boolean)));
    if (def.key === 'graduacion') valores = valores.sort((a, b) => gradNum(a) - gradNum(b));
    if (valores.length > 1) ejes.push({ key: def.key, label: def.label, valores });
  }
  // Modelo = base comun mas frecuente (solo etiqueta informativa)
  const bases = ordenados.map((p: any) => extraerEjesProducto(p.nombre).base);
  const modelo = bases.sort((a, b) => bases.filter(x => x === b).length - bases.filter(x => x === a).length)[0] || '';
  return { ref: null, modelo, n_variantes: variantes.length, ejes, variantes };
}

// ============================================================================
// AI-ZONES - Detecta productos en una lamina y devuelve zonas propuestas
// con product_id sugerido por match con codigo Sage. NO guarda nada en BD:
// solo devuelve el JSON para que el usuario revise y confirme.
// ============================================================================
app.post('/api/sheets/:id/detect-zones-ia', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const s = await pool.query('SELECT id, titulo, imagen_path FROM sheets WHERE id = $1', [id]);
    if (s.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    const abs = resolverRutaImagen(s.rows[0].imagen_path, UPLOADS_DIR);
    if (!abs || !fs.existsSync(abs)) {
      res.status(400).json({ success: false, error: 'La imagen no existe en disco' });
      return;
    }
    const t0 = Date.now();
    const zonas = await detectarZonasIA(abs);
    if (zonas === null) {
      res.status(500).json({ success: false, error: 'La IA no respondio. Revisa OPENAI_API_KEY o reintenta.' });
      return;
    }
    // Match Sage con multiples variantes del CN (6 o 7 digitos con o sin ceros)
    const buscarProductoPorCN = async (cn: string): Promise<any> => {
      // Variantes a probar en orden de preferencia
      const variantes = new Set<string>();
      const digitos = cn.replace(/\D/g, '');
      if (!digitos) return null;
      variantes.add(digitos);                                          // 2059856
      if (digitos.length === 7) variantes.add(digitos.substring(0, 6)); // 205985 (quita digito control)
      if (digitos.length === 6) variantes.add(digitos + '0');           // 2059850 (por si faltaba control)
      variantes.add(digitos.replace(/^0+/, ''));                       // sin ceros a la izquierda
      // Rellenar con 0 a 6 y 7 digitos por si BD usa padding
      variantes.add(digitos.padStart(6, '0'));
      variantes.add(digitos.padStart(7, '0'));
      const arr = Array.from(variantes).filter(v => v.length >= 4);
      // 1) Match exacto por codigo o codigo_alt_1 con cualquiera de las variantes
      const exact = await pool.query(
        `SELECT id, codigo, nombre, precio_pvf_1, precio_pvpr_1, activo
         FROM products
         WHERE codigo = ANY($1::text[]) OR codigo_alt_1 = ANY($1::text[]) OR codigo_alt_2 = ANY($1::text[])
         LIMIT 1`,
        [arr]
      );
      if (exact.rows.length > 0) return exact.rows[0];
      // 2) Match por prefijo (LIKE) por si el CN varia en el ultimo digito
      if (digitos.length >= 5) {
        const prefijo = digitos.substring(0, 6);
        const like = await pool.query(
          `SELECT id, codigo, nombre, precio_pvf_1, precio_pvpr_1, activo
           FROM products
           WHERE codigo LIKE $1 || '%' OR codigo_alt_1 LIKE $1 || '%'
           LIMIT 1`,
          [prefijo]
        );
        if (like.rows.length > 0) return like.rows[0];
      }
      return null;
    };
    const enriquecidas = await Promise.all(zonas.map(async (z) => {
      let productoSugerido: any = null;
      if (z.codigo_nacional) {
        productoSugerido = await buscarProductoPorCN(z.codigo_nacional);
      }
      // Si no hubo match por CN, probar con codigo del fabricante como respaldo.
      // Probamos con y SIN separadores (puntos/guiones): p.ej. Beter imprime "14.302"
      // pero en Sage esta guardado como "14302". Asi mejora el match de ese laboratorio.
      if (!productoSugerido && z.codigo_fabricante) {
        const fabRaw = z.codigo_fabricante.replace(/\s/g, '');
        const fabNorm = z.codigo_fabricante.replace(/[.\s\-\/]/g, '');
        const fabVars = Array.from(new Set([fabRaw, fabNorm].filter((v: string) => v && v.length >= 3)));
        if (fabVars.length > 0) {
          const r = await pool.query(
            `SELECT id, codigo, nombre, precio_pvf_1, precio_pvpr_1, activo
             FROM products
             WHERE codigo = ANY($1::text[]) OR codigo_alt_1 = ANY($1::text[]) OR codigo_alt_2 = ANY($1::text[])
             LIMIT 1`,
            [fabVars]
          );
          if (r.rows.length > 0) productoSugerido = r.rows[0];
        }
        // Si no casó por codigo/alt, buscar la referencia DENTRO DEL NOMBRE: algunos labs
        // (Beter) imprimen la ref como "REF. 40051" pero el codigo Sage es otro (188109).
        // Solo la aceptamos si el match es INEQUIVOCO (una sola coincidencia).
        if (!productoSugerido && fabNorm && fabNorm.length >= 4) {
          const rn = await pool.query(
            `SELECT id, codigo, nombre, precio_pvf_1, precio_pvpr_1, activo
             FROM products WHERE nombre ILIKE '%' || $1 || '%' ORDER BY activo DESC LIMIT 2`,
            [fabNorm]
          );
          if (rn.rows.length === 1) productoSugerido = rn.rows[0];
        }
      }
      // Ultimo respaldo: match por NOMBRE/modelo (gafas, accesorios sin CN)
      let matchAmbiguo = false;
      let familiaRef: string | null = null;
      let familia: any = null;
      if (!productoSugerido) {
        const porNombre = await matchProductoPorNombre(z.descripcion);
        if (porNombre) { productoSugerido = porNombre.producto; matchAmbiguo = porNombre.ambiguo; }
      }
      // Si el modelo tiene VARIAS variantes (color/graduacion), es una FAMILIA:
      // en vez de fijar un SKU concreto, proponemos la familia para que el cliente elija.
      if (matchAmbiguo && z.descripcion) {
        const fam = await resolverFamilia(z.descripcion);
        if (fam && fam.variantes.length > 1) {
          familiaRef = z.descripcion;
          familia = { modelo: fam.modelo, ejes: fam.ejes, n_variantes: fam.n_variantes };
          productoSugerido = null; // la familia manda; no fijamos un SKU
        }
      }
      return { ...z, producto_sugerido: productoSugerido, match_ambiguo: matchAmbiguo, familia_ref: familiaRef, familia };
    }));
    res.json({
      success: true,
      zonas: enriquecidas,
      total_detectadas: enriquecidas.length,
      con_match_sage: enriquecidas.filter(z => z.producto_sugerido).length,
      duracion_ms: Date.now() - t0
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Guarda en lote las zonas confirmadas por el usuario. Body: { zonas: [{ x, y, ancho, alto, product_id, etiqueta }] }
// Sustituye TODAS las zonas de la lamina (borra las anteriores).
app.post('/api/sheets/:id/save-zones', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const zonas = Array.isArray(req.body?.zonas) ? req.body.zonas : [];
    const s = await pool.query('SELECT id FROM sheets WHERE id = $1', [id]);
    if (s.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Lamina no encontrada' });
      return;
    }
    // Borrar las anteriores en la misma transaccion
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM sheet_zones WHERE sheet_id = $1', [id]);
      let orden = 0;
      const insertadas: any[] = [];
      for (const z of zonas) {
        const x = Number(z.x), y = Number(z.y), ancho = Number(z.ancho), alto = Number(z.alto);
        if (!isFinite(x) || !isFinite(y) || !isFinite(ancho) || !isFinite(alto) || ancho < 0.5 || alto < 0.5) continue;
        const productId = z.product_id != null ? Number(z.product_id) : null;
        const etiqueta = z.etiqueta ? String(z.etiqueta).trim().substring(0, 150) : null;
        const familiaRef = z.familia_ref ? String(z.familia_ref).trim().substring(0, 120) : null;
        const r = await client.query(
          `INSERT INTO sheet_zones (sheet_id, product_id, x, y, ancho, alto, etiqueta, orden, familia_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [id, productId, x, y, ancho, alto, etiqueta, orden++, familiaRef]
        );
        insertadas.push(r.rows[0]);
      }
      await client.query('COMMIT');
      res.json({ success: true, zonas: insertadas, total: insertadas.length });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// BACKFILL de deteccion de zonas: procesa laminas que aun no han pasado por
// la IA Y no tienen ninguna zona todavia. Guarda directamente las zonas
// propuestas en sheet_zones (con product_id si hubo match Sage, o null si no).
// Idempotente: llama en bucle hasta que restantes = 0.
// ----------------------------------------------------------------------------
// Diagnostico rapido: prueba la IA con UNA lamina y devuelve el error crudo si lo hay
app.get('/api/admin/detect-zones-diag', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sid = req.query.id ? Number(req.query.id) : null;
    const r = sid
      ? await pool.query(`SELECT id, titulo, imagen_path FROM sheets WHERE id = $1`, [sid])
      : await pool.query(
          `SELECT s.id, s.titulo, s.imagen_path FROM sheets s
           WHERE s.imagen_path IS NOT NULL
           ORDER BY s.id
           LIMIT 1`
        );
    if (r.rows.length === 0) {
      res.json({ success: false, error: 'No hay laminas' });
      return;
    }
    const sh = r.rows[0];
    const abs = resolverRutaImagen(sh.imagen_path, UPLOADS_DIR);
    if (!abs || !fs.existsSync(abs)) {
      res.json({ success: false, error: 'archivo no existe: ' + abs });
      return;
    }
    const t0 = Date.now();
    const zonas = await detectarZonasIA(abs);
    const dur = Date.now() - t0;
    const errIA = ultimoErrorIA();

    // Para cada producto detectado, mostrar que lee la IA y contra que casa (debug de match)
    const detalle: any[] = [];
    for (const z of (zonas || [])) {
      const cn = z.codigo_nacional;
      const fab = z.codigo_fabricante;
      // Que encontrariamos buscando por codigo/codigo_alt (match actual)
      const porCodigo = await pool.query(
        `SELECT id, codigo, nombre FROM products
         WHERE codigo = $1 OR codigo_alt_1 = $1 OR codigo_alt_2 = $1
            OR codigo = $2 OR codigo_alt_1 = $2 OR codigo_alt_2 = $2 LIMIT 1`,
        [cn || '', (fab || '').replace(/\s/g, '')]
      );
      // Que encontrariamos buscando el CN en EAN (donde Sage guarda el codigo nacional)
      const porEan = cn ? await pool.query(
        `SELECT id, codigo, nombre, ean FROM products WHERE ean = $1 OR ean LIKE $1 || '%' LIMIT 1`,
        [cn]
      ) : { rows: [] };
      // Que encontrariamos buscando la descripcion en el nombre del producto (gafas por modelo)
      const desc = (z.descripcion || '').trim();
      const porNombre = desc.length >= 4 ? await pool.query(
        `SELECT id, codigo, nombre FROM products WHERE LOWER(nombre) LIKE '%' || LOWER($1) || '%' LIMIT 2`,
        [desc.substring(0, 40)]
      ) : { rows: [] };
      detalle.push({
        lee: { cn, fab, descripcion: desc.substring(0, 50) },
        match_por_codigo: porCodigo.rows[0] || null,
        match_por_ean: porEan.rows[0] || null,
        match_por_nombre: porNombre.rows.map((r: any) => r.nombre)
      });
    }

    res.json({
      success: zonas !== null,
      sheet: { id: sh.id, titulo: sh.titulo },
      zonas_detectadas: zonas?.length ?? 0,
      duracion_ms: dur,
      error_ia: errIA,
      detalle,
      openai_key_configurada: !!(process.env.OPENAI_API_KEY || '').trim(),
      openai_key_len: (process.env.OPENAI_API_KEY || '').trim().length
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Debug: lista las N ultimas laminas procesadas por el backfill con su titulo y numero de zonas
app.get('/api/admin/backfill-detect-zones/stats', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const proc = await pool.query(
      `SELECT s.id, s.titulo, s.zones_ia_at,
              (SELECT COUNT(*) FROM sheet_zones z WHERE z.sheet_id = s.id) AS zonas
       FROM sheets s
       WHERE s.zones_ia_at IS NOT NULL
       ORDER BY s.zones_ia_at DESC
       LIMIT 20`
    );
    const pend = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sheets s
       WHERE s.zones_ia_at IS NULL
         AND s.imagen_path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sheet_zones z WHERE z.sheet_id = s.id)`
    );
    // Numeros globales reales (verificar match Sage)
    const glob = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM sheet_zones) AS total_zonas,
         (SELECT COUNT(*)::int FROM sheet_zones WHERE product_id IS NOT NULL) AS zonas_con_producto,
         (SELECT COUNT(*)::int FROM sheet_zones WHERE familia_ref IS NOT NULL) AS zonas_con_familia,
         (SELECT COUNT(*)::int FROM sheet_zones WHERE product_id IS NULL AND familia_ref IS NULL) AS zonas_sin_nada,
         (SELECT COUNT(*)::int FROM products) AS total_productos`
    );
    // Muestra de zonas sin resolver (para entender POR QUE no casan): sus etiquetas
    const sinNada = await pool.query(
      `SELECT etiqueta, COUNT(*)::int AS n FROM sheet_zones
       WHERE product_id IS NULL AND familia_ref IS NULL AND etiqueta IS NOT NULL AND etiqueta <> ''
       GROUP BY etiqueta ORDER BY n DESC, etiqueta LIMIT 40`
    );
    res.json({
      success: true,
      procesadas_recientes: proc.rows,
      pendientes: pend.rows[0]?.n ?? 0,
      global: glob.rows[0],
      muestra_sin_resolver: sinNada.rows
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Re-match de FAMILIAS sobre zonas YA existentes sin producto (gafas procesadas antes
// de la feature de familias). Usa la etiqueta guardada -> resolverFamilia. SIN coste de IA.
app.post('/api/admin/rematch-familias', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const zonas = await pool.query(
      `SELECT id, etiqueta FROM sheet_zones
       WHERE familia_ref IS NULL AND product_id IS NULL AND etiqueta IS NOT NULL AND etiqueta <> ''`
    );
    let asignadas = 0, revisadas = 0;
    for (const z of zonas.rows) {
      revisadas++;
      const fam = await resolverFamilia(z.etiqueta);
      if (fam && fam.variantes.length > 1) {
        await pool.query('UPDATE sheet_zones SET familia_ref = $1, updated_at = NOW() WHERE id = $2', [z.etiqueta, z.id]);
        asignadas++;
      }
    }
    res.json({ success: true, revisadas, familias_asignadas: asignadas });
  } catch (e: any) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// Resetea la marca zones_ia_at en laminas que fueron procesadas pero se quedaron sin zonas
// (afectadas por el bug de max_tokens truncado). Asi el backfill las volvera a intentar.
app.post('/api/admin/reset-detect-zones', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const soloFallidas = String(req.query.solo_fallidas || '1') !== '0';
    let sql: string;
    if (soloFallidas) {
      // Solo las procesadas pero sin zonas guardadas (los fallos del bug)
      sql = `UPDATE sheets SET zones_ia_at = NULL
             WHERE zones_ia_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM sheet_zones z WHERE z.sheet_id = sheets.id)
             RETURNING id`;
    } else {
      // Reset absoluto: todas las procesadas (incluye las que si tenian zonas)
      sql = `UPDATE sheets SET zones_ia_at = NULL WHERE zones_ia_at IS NOT NULL RETURNING id`;
    }
    const r = await pool.query(sql);
    res.json({ success: true, reset: r.rowCount, solo_fallidas: soloFallidas });
  } catch (e: any) {
    console.warn('[reset-detect-zones] error:', e?.message || e);
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

app.post('/api/admin/backfill-detect-zones', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    // Laminas sin marca IA y sin zonas
    const pend = await pool.query(
      `SELECT s.id, s.titulo, s.imagen_path FROM sheets s
       WHERE s.zones_ia_at IS NULL
         AND s.imagen_path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sheet_zones z WHERE z.sheet_id = s.id)
       ORDER BY s.id
       LIMIT $1`,
      [limit]
    );

    // Helper: match Sage por CN con variantes (mismo que detect-zones-ia) + fallback por nombre
    const buscarProducto = async (cn: string | null, fab: string | null, descripcion: string | null): Promise<number | null> => {
      const variantes = new Set<string>();
      if (cn) {
        const d = cn.replace(/\D/g, '');
        if (d.length >= 4) {
          variantes.add(d);
          if (d.length === 7) variantes.add(d.substring(0, 6));
          if (d.length === 6) variantes.add(d + '0');
          variantes.add(d.replace(/^0+/, ''));
          variantes.add(d.padStart(6, '0'));
          variantes.add(d.padStart(7, '0'));
        }
      }
      if (fab) {
        variantes.add(String(fab).replace(/\s/g, ''));
        variantes.add(String(fab).replace(/[.\s\-\/]/g, '')); // Beter: "14.302" -> "14302"
      }
      const arr = Array.from(variantes).filter(v => v.length >= 3);
      if (arr.length > 0) {
        const r = await pool.query(
          `SELECT id FROM products
           WHERE codigo = ANY($1::text[]) OR codigo_alt_1 = ANY($1::text[]) OR codigo_alt_2 = ANY($1::text[])
           LIMIT 1`,
          [arr]
        );
        if (r.rows.length > 0) return r.rows[0].id;
      }
      // Ref dentro del NOMBRE (Beter imprime "REF. 40051" pero el codigo Sage es otro).
      // Solo si el match es inequivoco (una sola coincidencia).
      const fabNorm = fab ? String(fab).replace(/[.\s\-\/]/g, '') : '';
      if (fabNorm.length >= 4) {
        const rn = await pool.query(
          `SELECT id FROM products WHERE nombre ILIKE '%' || $1 || '%' ORDER BY activo DESC LIMIT 2`,
          [fabNorm]
        );
        if (rn.rows.length === 1) return rn.rows[0].id;
      }
      if (cn) {
        const d = cn.replace(/\D/g, '');
        if (d.length >= 5) {
          const prefijo = d.substring(0, 6);
          const like = await pool.query(
            `SELECT id FROM products WHERE codigo LIKE $1 || '%' OR codigo_alt_1 LIKE $1 || '%' LIMIT 1`,
            [prefijo]
          );
          if (like.rows.length > 0) return like.rows[0].id;
        }
      }
      // Fallback por NOMBRE/modelo (gafas y accesorios sin CN impreso)
      const porNombre = await matchProductoPorNombre(descripcion);
      if (porNombre) return porNombre.producto.id;
      return null;
    };

    let procesadas = 0, zonas_creadas = 0, con_match = 0, errores = 0;
    const fallos: any[] = [];
    for (const row of pend.rows) {
      procesadas++;
      const abs = resolverRutaImagen(row.imagen_path, UPLOADS_DIR);
      if (!abs || !fs.existsSync(abs)) {
        errores++;
        fallos.push({ id: row.id, motivo: 'no existe en disco' });
        continue;
      }
      const zonas = await detectarZonasIA(abs);
      if (zonas === null) {
        errores++;
        const errIA = ultimoErrorIA();
        fallos.push({ id: row.id, titulo: row.titulo?.substring(0, 40), motivo: errIA || 'IA sin respuesta' });
        continue;
      }
      // Insertar cada zona propuesta con su producto (si hay match) o null
      let orden = 0;
      for (const z of zonas) {
        let productId = await buscarProducto(z.codigo_nacional, z.codigo_fabricante, z.descripcion);
        let familiaRef: string | null = null;
        // Si no hubo match unico por codigo, ver si es una FAMILIA (varias variantes color/graduacion)
        if (!productId && z.descripcion) {
          const fam = await resolverFamilia(z.descripcion);
          if (fam && fam.variantes.length > 1) { familiaRef = z.descripcion; productId = null; }
        }
        if (productId || familiaRef) con_match++;
        const etiqueta = z.descripcion || z.codigo_fabricante || z.codigo_nacional || null;
        await pool.query(
          `INSERT INTO sheet_zones (sheet_id, product_id, x, y, ancho, alto, etiqueta, orden, familia_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [row.id, productId, z.x, z.y, z.width, z.height, etiqueta, orden++, familiaRef]
        );
        zonas_creadas++;
      }
      // Marcar la lamina como procesada por IA (aunque no haya devuelto productos)
      await pool.query('UPDATE sheets SET zones_ia_at = NOW() WHERE id = $1', [row.id]);
    }
    // Cuantas quedan
    const restR = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sheets s
       WHERE s.zones_ia_at IS NULL
         AND s.imagen_path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sheet_zones z WHERE z.sheet_id = s.id)`
    );
    res.json({
      success: true,
      procesadas, zonas_creadas, con_match, errores,
      restantes: restR.rows[0].n,
      fallos: fallos.slice(0, 10)
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
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

    // Insertar cada pagina como una lamina en BD (+ generar miniatura)
    const laminasCreadas = [];
    for (let i = 0; i < archivos.length; i++) {
      const archivo = archivos[i];
      const imagenPath = '/uploads/' + archivo;
      const titulo = `Lamina ${ordenSiguiente}`;
      const rutaAbs = path.join(UPLOADS_DIR, archivo);
      // Corregir colores oscuros por perfil ICC embebido
      await normalizarPngColor(rutaAbs);
      const miniaturaPath = await generarMiniatura(rutaAbs, archivo);
      const r = await pool.query(
        `INSERT INTO sheets (catalog_id, orden, titulo, imagen_path, miniatura_path)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, orden, titulo, imagen_path, miniatura_path`,
        [catalogId, ordenSiguiente, titulo, imagenPath, miniaturaPath]
      );
      laminasCreadas.push(r.rows[0]);
      await logSheetChange('created', r.rows[0].id, catalogId, r.rows[0].titulo,
        { orden: r.rows[0].orden, imagen_path: r.rows[0].imagen_path, origen: 'from-pdf' },
        { id: req.user?.id, name: req.user?.name });
      // Generar tags con IA en background
      generarTagsBackground(r.rows[0].id, rutaAbs, r.rows[0].titulo);
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

// ============================================================================
// ESTADÍSTICAS POR CLIENTE
// Devuelve métricas del cliente. Algunas son "solo admin" (comercial top,
// % con pedido, tendencia). Se devuelven igualmente, pero el frontend decide
// si las muestra al comercial (extra defensa: no aporta info sensible suelta).
// Modular: cada métrica es un bloque try/catch independiente, fácil de añadir
// o quitar sin tocar el resto.
// ============================================================================
app.get('/api/clients/:id/stats', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const clientId = Number(req.params.id);

    // Verificar que el cliente existe
    const clienteR = await pool.query(`SELECT id, ciclo_visita_dias FROM clients WHERE id = $1`, [clientId]);
    if (clienteR.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Cliente no encontrado' });
      return;
    }
    const ciclo = clienteR.rows[0].ciclo_visita_dias || 90;

    // Filtro de visitas según rol (admin = todas; comercial = solo suyas)
    const esAdmin = req.user.role === 'admin';
    const filtroUsuario = esAdmin ? '' : ` AND v.user_id = ${Number(req.user.id)}`;

    const stats: any = {};

    // --- 1) Total visitas confirmadas ---
    try {
      const r = await pool.query(`
        SELECT COUNT(*)::int AS n
        FROM visits v
        WHERE v.client_id = $1 AND v.status = 'confirmed' ${filtroUsuario}
      `, [clientId]);
      stats.total_visitas = r.rows[0].n;
    } catch (e) { stats.total_visitas = 0; }

    // --- 2) Última visita ---
    try {
      const r = await pool.query(`
        SELECT v.confirmed_at, v.created_at
        FROM visits v
        WHERE v.client_id = $1 AND v.status = 'confirmed' ${filtroUsuario}
        ORDER BY v.confirmed_at DESC NULLS LAST, v.created_at DESC
        LIMIT 1
      `, [clientId]);
      stats.ultima_visita = r.rows[0]?.confirmed_at || r.rows[0]?.created_at || null;
    } catch (e) { stats.ultima_visita = null; }

    // --- 3) Próxima visita estimada (última + ciclo_visita_dias) ---
    if (stats.ultima_visita) {
      const proxima = new Date(stats.ultima_visita);
      proxima.setDate(proxima.getDate() + ciclo);
      stats.proxima_visita_estimada = proxima.toISOString();
      stats.ciclo_dias = ciclo;
    } else {
      stats.proxima_visita_estimada = null;
      stats.ciclo_dias = ciclo;
    }

    // --- 4) Total pedido acumulado (suma PVF de todas las anotaciones con producto) ---
    try {
      const r = await pool.query(`
        SELECT COALESCE(SUM(a.cantidad * p.precio_pvf), 0)::numeric AS total
        FROM annotations a
        JOIN visits v ON v.id = a.visit_id
        JOIN products p ON p.id = a.product_id
        WHERE v.client_id = $1 AND v.status = 'confirmed' ${filtroUsuario}
          AND a.cantidad IS NOT NULL AND p.precio_pvf IS NOT NULL
      `, [clientId]);
      stats.total_pedido_acumulado = Number(r.rows[0].total) || 0;
    } catch (e) { stats.total_pedido_acumulado = 0; }

    // --- 5) Top 5 productos más pedidos ---
    try {
      const r = await pool.query(`
        SELECT p.codigo, p.nombre, SUM(a.cantidad)::int AS cant_total,
               COUNT(DISTINCT v.id)::int AS veces
        FROM annotations a
        JOIN visits v ON v.id = a.visit_id
        JOIN products p ON p.id = a.product_id
        WHERE v.client_id = $1 AND v.status = 'confirmed' ${filtroUsuario}
          AND a.cantidad IS NOT NULL
        GROUP BY p.id, p.codigo, p.nombre
        ORDER BY cant_total DESC NULLS LAST
        LIMIT 5
      `, [clientId]);
      stats.top_productos = r.rows;
    } catch (e) { stats.top_productos = []; }

    // --- 6) Comercial que más le visita (SOLO ADMIN) ---
    if (esAdmin) {
      try {
        const r = await pool.query(`
          SELECT u.name AS comercial, COUNT(v.id)::int AS visitas
          FROM visits v
          JOIN users u ON u.id = v.user_id
          WHERE v.client_id = $1 AND v.status = 'confirmed'
          GROUP BY u.id, u.name
          ORDER BY visitas DESC
          LIMIT 1
        `, [clientId]);
        stats.comercial_top = r.rows[0] || null;
      } catch (e) { stats.comercial_top = null; }
    }

    // --- 7) % visitas con pedido vs sin pedido (SOLO ADMIN) ---
    if (esAdmin) {
      try {
        const r = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE hubo_pedido)::int AS con_pedido,
            COUNT(*) FILTER (WHERE NOT hubo_pedido)::int AS sin_pedido,
            COUNT(*)::int AS total
          FROM visits
          WHERE client_id = $1 AND status = 'confirmed'
        `, [clientId]);
        const t = r.rows[0].total;
        stats.pct_con_pedido = t > 0 ? Math.round((r.rows[0].con_pedido / t) * 100) : 0;
        stats.visitas_con_pedido = r.rows[0].con_pedido;
        stats.visitas_sin_pedido = r.rows[0].sin_pedido;
      } catch (e) {
        stats.pct_con_pedido = 0;
        stats.visitas_con_pedido = 0;
        stats.visitas_sin_pedido = 0;
      }
    }

    // --- 8) Tendencia: último pedido vs media (SOLO ADMIN) ---
    if (esAdmin) {
      try {
        // Calculamos el total PVF de cada visita confirmada y comparamos el último con la media
        const r = await pool.query(`
          SELECT v.id, v.confirmed_at,
                 COALESCE(SUM(a.cantidad * p.precio_pvf), 0)::numeric AS total_visita
          FROM visits v
          LEFT JOIN annotations a ON a.visit_id = v.id
          LEFT JOIN products p ON p.id = a.product_id
          WHERE v.client_id = $1 AND v.status = 'confirmed'
          GROUP BY v.id, v.confirmed_at
          HAVING COALESCE(SUM(a.cantidad * p.precio_pvf), 0) > 0
          ORDER BY v.confirmed_at DESC
        `, [clientId]);
        if (r.rows.length >= 2) {
          const ultimo = Number(r.rows[0].total_visita);
          const previas = r.rows.slice(1).map((x: any) => Number(x.total_visita));
          const media = previas.reduce((s: number, v: number) => s + v, 0) / previas.length;
          const variacion = media > 0 ? Math.round(((ultimo - media) / media) * 100) : 0;
          stats.tendencia = {
            ultimo_pedido: ultimo,
            media_anteriores: Math.round(media * 100) / 100,
            variacion_pct: variacion,
            direccion: variacion > 5 ? 'sube' : variacion < -5 ? 'baja' : 'estable'
          };
        } else {
          stats.tendencia = null;
        }
      } catch (e) { stats.tendencia = null; }
    }

    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// DASHBOARD ADMIN — Fase 1 (5 widgets)
// Cada widget es un bloque try/catch independiente. Fácil añadir/quitar.
// AA1: periodo = mes actual (día 1 del mes hasta hoy)
// BB1: solo admin (requireRealAdmin)
// ============================================================================
app.get('/api/dashboard', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    // Rangos: mes actual (1º del mes a hoy) y "hoy"
    const fechaInicioMes = `DATE_TRUNC('month', CURRENT_DATE)`;
    const fechaHoy = `CURRENT_DATE`;

    // --- Widget 1: Visitas de hoy ---
    try {
      const r = await pool.query(`
        SELECT v.id, v.status, v.hubo_pedido, v.created_at, v.confirmed_at,
               c.razon_social AS cliente_nombre,
               c.municipio AS cliente_municipio,
               u.name AS comercial_nombre,
               (SELECT COUNT(*)::int FROM annotations a WHERE a.visit_id = v.id) AS num_anotaciones
        FROM visits v
        LEFT JOIN clients c ON c.id = v.client_id
        LEFT JOIN users u ON u.id = v.user_id
        WHERE v.created_at >= ${fechaHoy}
          AND v.created_at < ${fechaHoy} + INTERVAL '1 day'
        ORDER BY v.created_at DESC
        LIMIT 50
      `);
      data.visitas_hoy = r.rows;
    } catch (e) { data.visitas_hoy = []; }

    // --- Widget 2: Resumen del mes ---
    try {
      const visitasMes = await pool.query(`
        SELECT COUNT(*)::int AS total_visitas,
               COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmadas,
               COUNT(DISTINCT user_id)::int AS comerciales_activos
        FROM visits
        WHERE created_at >= ${fechaInicioMes}
      `);
      const totalPVF = await pool.query(`
        SELECT COALESCE(SUM(a.cantidad * p.precio_pvf), 0)::numeric AS total
        FROM annotations a
        JOIN visits v ON v.id = a.visit_id
        JOIN products p ON p.id = a.product_id
        WHERE v.created_at >= ${fechaInicioMes}
          AND v.status = 'confirmed'
          AND a.cantidad IS NOT NULL
          AND p.precio_pvf IS NOT NULL
      `);
      data.resumen_mes = {
        total_visitas: visitasMes.rows[0].total_visitas,
        confirmadas: visitasMes.rows[0].confirmadas,
        comerciales_activos: visitasMes.rows[0].comerciales_activos,
        total_pvf: Number(totalPVF.rows[0].total) || 0
      };
    } catch (e) {
      data.resumen_mes = { total_visitas: 0, confirmadas: 0, comerciales_activos: 0, total_pvf: 0 };
    }

    // --- Widget 3: Clientes sin visitar hace X días (los más vencidos) ---
    // Se considera "vencido" si su última visita es más antigua que ciclo+30 días
    // o nunca tuvo visita y su created_at supera 60 días (cliente importado hace tiempo).
    // Devolvemos los 10 más vencidos.
    try {
      const r = await pool.query(`
        SELECT c.id, c.razon_social, c.municipio, c.ultima_visita_at,
               COALESCE(c.ciclo_visita_dias, 90) AS ciclo,
               CASE
                 WHEN c.ultima_visita_at IS NULL THEN
                   EXTRACT(DAY FROM (NOW() - c.created_at))::int
                 ELSE
                   EXTRACT(DAY FROM (NOW() - c.ultima_visita_at))::int
               END AS dias_sin_visitar
        FROM clients c
        WHERE c.is_active = TRUE
          AND (
            (c.ultima_visita_at IS NULL AND c.created_at < NOW() - INTERVAL '60 days')
            OR (c.ultima_visita_at IS NOT NULL AND c.ultima_visita_at < NOW() - (COALESCE(c.ciclo_visita_dias, 90) || ' days')::interval)
          )
        ORDER BY dias_sin_visitar DESC
        LIMIT 10
      `);
      data.sin_visitar = r.rows;
    } catch (e) { data.sin_visitar = []; }

    // --- Widget 4: Top productos del mes (más pedidos) ---
    try {
      const r = await pool.query(`
        SELECT p.id, p.codigo, p.nombre,
               SUM(a.cantidad)::int AS uds_total,
               COUNT(DISTINCT v.id)::int AS visitas,
               COALESCE(SUM(a.cantidad * p.precio_pvf), 0)::numeric AS total_pvf
        FROM annotations a
        JOIN visits v ON v.id = a.visit_id
        JOIN products p ON p.id = a.product_id
        WHERE v.created_at >= ${fechaInicioMes}
          AND v.status = 'confirmed'
          AND a.cantidad IS NOT NULL
        GROUP BY p.id, p.codigo, p.nombre
        ORDER BY uds_total DESC NULLS LAST
        LIMIT 10
      `);
      data.top_productos = r.rows.map((x: any) => ({ ...x, total_pvf: Number(x.total_pvf) || 0 }));
    } catch (e) { data.top_productos = []; }

    // --- Widget 5: Top clientes del mes (los que más han pedido en PVF) ---
    try {
      const r = await pool.query(`
        SELECT c.id, c.razon_social, c.municipio,
               COUNT(DISTINCT v.id)::int AS visitas,
               COALESCE(SUM(a.cantidad * p.precio_pvf), 0)::numeric AS total_pvf
        FROM visits v
        JOIN clients c ON c.id = v.client_id
        LEFT JOIN annotations a ON a.visit_id = v.id
        LEFT JOIN products p ON p.id = a.product_id AND p.precio_pvf IS NOT NULL
        WHERE v.created_at >= ${fechaInicioMes}
          AND v.status = 'confirmed'
        GROUP BY c.id, c.razon_social, c.municipio
        HAVING COALESCE(SUM(a.cantidad * p.precio_pvf), 0) > 0
        ORDER BY total_pvf DESC
        LIMIT 10
      `);
      data.top_clientes = r.rows.map((x: any) => ({ ...x, total_pvf: Number(x.total_pvf) || 0 }));
    } catch (e) { data.top_clientes = []; }

    // --- Widget 6: Comerciales del mes (ranking visitas + PVF) ---
    try {
      const r = await pool.query(`
        SELECT u.id, u.name,
               COUNT(DISTINCT v.id)::int AS visitas,
               COUNT(*) FILTER (WHERE v.hubo_pedido)::int AS con_pedido,
               COALESCE(SUM(a.cantidad * p.precio_pvf), 0)::numeric AS total_pvf
        FROM users u
        JOIN visits v ON v.user_id = u.id
        LEFT JOIN annotations a ON a.visit_id = v.id
        LEFT JOIN products p ON p.id = a.product_id AND p.precio_pvf IS NOT NULL
        WHERE v.created_at >= DATE_TRUNC('month', CURRENT_DATE)
          AND v.status = 'confirmed'
        GROUP BY u.id, u.name
        ORDER BY visitas DESC, total_pvf DESC
        LIMIT 10
      `);
      data.ranking_comerciales = r.rows.map((x: any) => ({ ...x, total_pvf: Number(x.total_pvf) || 0 }));
    } catch (e) { data.ranking_comerciales = []; }

    // --- Widget 7: Visitas por semana (últimas 8 semanas) ---
    // Devuelve un array con {semana_inicio, visitas} para últimas 8 semanas (incluyendo la actual)
    try {
      const r = await pool.query(`
        WITH semanas AS (
          SELECT generate_series(
            DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '7 weeks',
            DATE_TRUNC('week', CURRENT_DATE),
            INTERVAL '1 week'
          ) AS semana_inicio
        )
        SELECT s.semana_inicio,
               COALESCE(COUNT(v.id), 0)::int AS visitas,
               COALESCE(COUNT(v.id) FILTER (WHERE v.hubo_pedido), 0)::int AS con_pedido
        FROM semanas s
        LEFT JOIN visits v ON DATE_TRUNC('week', v.created_at) = s.semana_inicio
                           AND v.status = 'confirmed'
        GROUP BY s.semana_inicio
        ORDER BY s.semana_inicio ASC
      `);
      data.visitas_por_semana = r.rows;
    } catch (e) { data.visitas_por_semana = []; }

    // --- Widget 8: Próximas visitas previstas (ciclo vence en próximos 7 días) ---
    // Solo clientes cuya última visita + ciclo cae entre hoy y dentro de 7 días.
    // Los que YA están vencidos NO entran aquí (esos están en "Sin visitar").
    try {
      const r = await pool.query(`
        SELECT c.id, c.razon_social, c.municipio,
               c.ultima_visita_at,
               COALESCE(c.ciclo_visita_dias, 90) AS ciclo,
               (c.ultima_visita_at + (COALESCE(c.ciclo_visita_dias, 90) || ' days')::interval)::date AS fecha_prevista,
               EXTRACT(DAY FROM ((c.ultima_visita_at + (COALESCE(c.ciclo_visita_dias, 90) || ' days')::interval) - NOW()))::int AS dias_restantes
        FROM clients c
        WHERE c.is_active = TRUE
          AND c.ultima_visita_at IS NOT NULL
          AND (c.ultima_visita_at + (COALESCE(c.ciclo_visita_dias, 90) || ' days')::interval) > NOW()
          AND (c.ultima_visita_at + (COALESCE(c.ciclo_visita_dias, 90) || ' days')::interval) <= NOW() + INTERVAL '7 days'
        ORDER BY fecha_prevista ASC
        LIMIT 10
      `);
      data.proximas_previstas = r.rows;
    } catch (e) { data.proximas_previstas = []; }

    res.json({ success: true, dashboard: data });
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
        // NOTA: email_alternativo NO se incluye en UPDATE intencionalmente.
        // Si un comercial añadió un email_alternativo durante una visita
        // (caso "el cliente pide enviar a otra direccion"), debe persistir
        // entre re-importaciones del Sage. Solo se machaca con un UPDATE
        // manual o desde el endpoint resend-to-custom con guardar_en_cliente=true.
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
    // Admin real (sin impersonar) NO puede hacer visitas: bloqueado a nivel backend
    if (req.user?.role === 'oficina') {
      res.status(403).json({ success: false, error: 'Tu cuenta es de consulta: puedes ver los catálogos, pero no hacer visitas ni pedidos.' });
      return;
    }
    if (req.user?.role === 'admin') {
      res.status(403).json({ success: false, error: 'Como administrador no puedes hacer visitas. Usa "Ver como" o entra con cuenta comercial.' });
      return;
    }
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

// I.3: SINCRONIZACION de visita offline + sus anotaciones de golpe.
// Recibe: { client_id, catalog_id, created_at, confirm: bool, annotations: [{ sheet_id, texto_libre, tipo, pos_x, pos_y, orden_en_visita }] }
// Devuelve: { success: true, visit_id, annotation_ids_map: { local_id_anot: id_real } }
app.post('/api/sync/visit-batch', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = effectiveUserId(req);
    const { client_id, catalog_id, created_at, confirm, annotations, notas_generales } = req.body;

    if (!client_id || !catalog_id) {
      res.status(400).json({ success: false, error: 'client_id y catalog_id obligatorios' });
      return;
    }

    // Validar que el cliente existe (puede haber sido borrado entre que se creó offline y ahora)
    const cliCheck = await pool.query(`SELECT id FROM clients WHERE id = $1 AND is_active = TRUE`, [Number(client_id)]);
    if (cliCheck.rows.length === 0) {
      res.status(400).json({ success: false, error: 'El cliente ya no existe o está inactivo' });
      return;
    }

    // Validar catálogo
    const catCheck = await pool.query(`SELECT version FROM catalogs WHERE id = $1`, [Number(catalog_id)]);
    if (catCheck.rows.length === 0) {
      res.status(400).json({ success: false, error: 'El catálogo ya no existe' });
      return;
    }
    const versionCat = catCheck.rows[0].version || 1;

    // Crear visita con timestamp original (created_at offline) preservado
    const createdAtPg = created_at ? new Date(created_at).toISOString() : new Date().toISOString();
    const visitR = await pool.query(
      `INSERT INTO visits (client_id, user_id, catalog_id, version_catalog, status, created_at, notas_generales)
       VALUES ($1, $2, $3, $4, 'draft', $5::timestamp, $6) RETURNING *`,
      [Number(client_id), userId, Number(catalog_id), versionCat, createdAtPg, notas_generales || null]
    );
    const visitId = visitR.rows[0].id;

    // Crear anotaciones (mapeando local_id → id real)
    const annIdMap: any = {};
    let ordenContador = 1;
    if (Array.isArray(annotations)) {
      for (const ann of annotations) {
        try {
          const tipoFinal = ['pedido', 'devolucion', 'nota'].includes(ann.tipo) ? ann.tipo : 'pedido';
          // pos_x/pos_y opcionales
          let posX: number | null = null, posY: number | null = null;
          if (ann.pos_x != null && ann.pos_x !== '') {
            const px = Number(ann.pos_x);
            if (Number.isFinite(px) && px >= 0 && px <= 1) posX = px;
          }
          if (ann.pos_y != null && ann.pos_y !== '') {
            const py = Number(ann.pos_y);
            if (Number.isFinite(py) && py >= 0 && py <= 1) posY = py;
          }
          const orden = Number(ann.orden_en_visita) || ordenContador++;
          const annR = await pool.query(
            `INSERT INTO annotations (visit_id, sheet_id, orden_en_visita, texto_libre, tipo, pos_x, pos_y)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              visitId,
              ann.sheet_id ? Number(ann.sheet_id) : null,
              orden,
              String(ann.texto_libre || '').trim() || '(sin texto)',
              tipoFinal,
              posX,
              posY
            ]
          );
          if (ann.local_id) annIdMap[ann.local_id] = annR.rows[0].id;
        } catch (errAnn) {
          console.error('[SYNC] Error insertando anotación:', (errAnn as Error).message);
        }
      }
    }

    // Si confirm=true, confirmar la visita (mantiene comportamiento de POST /:id/confirm)
    let confirmed = false;
    if (confirm) {
      try {
        await pool.query(
          `UPDATE visits SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
          [visitId]
        );
        // ultima_visita_at del cliente
        await pool.query(`UPDATE clients SET ultima_visita_at = NOW() WHERE id = $1`, [Number(client_id)]);
        confirmed = true;
        // NOTA: NO disparamos emails automáticos al sincronizar (Fernando decidirá si los envía manualmente)
        // Esto evita spam si por error se sincronizan visitas viejas.
      } catch (errConf) {
        console.error('[SYNC] Error confirmando visita:', (errConf as Error).message);
      }
    }

    res.json({
      success: true,
      visit_id: visitId,
      confirmed,
      annotation_ids_map: annIdMap,
      annotations_count: Object.keys(annIdMap).length
    });
  } catch (e) {
    console.error('[SYNC/VISIT-BATCH] ERROR:', (e as Error).message);
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// I.3: descargar lista de clientes asignados al comercial para uso offline.
// Devuelve solo los campos necesarios para la ficha + alta de visita.
app.get('/api/sync/my-clients', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const userId = effectiveUserId(req);

    const params: any[] = [];
    let whereClause = `c.is_active = TRUE`;

    if (isEffectiveSales(req)) {
      // Comercial: solo sus clientes asignados (por commercial_code)
      const uR = await pool.query(`SELECT sage_commercial_code FROM users WHERE id = $1`, [userId]);
      const ccode = uR.rows[0]?.sage_commercial_code;
      if (!ccode) { res.json({ success: true, clientes: [] }); return; }
      params.push(String(ccode));
      whereClause += ` AND c.commercial_code = $${params.length}`;
    }

    const r = await pool.query(
      `SELECT id, sage_code, razon_social, cif, cp, direccion, municipio, provincia,
              telefono, whatsapp, email, email_alternativo, commercial_code, categoria,
              latitude, longitude, ciclo_visita_dias, ultima_visita_at, notas_internas
       FROM clients c
       WHERE ${whereClause}
       ORDER BY razon_social
       LIMIT 5000`,
      params
    );

    // Planning offline: incluir la configuración del planning para que el frontend
    // pueda calcular los estados localmente cuando no haya red.
    let planningConfig = {
      ciclo_default: 90,
      ventana_proxima_dias: 15,
      ventana_urgente_dias: 15
    };
    try {
      const cfgR = await pool.query(
        `SELECT clave, valor FROM email_config WHERE clave IN
         ('planning_ciclo_default','planning_ventana_proxima_dias','planning_ventana_urgente_dias')`
      );
      cfgR.rows.forEach((row: any) => {
        if (row.clave === 'planning_ciclo_default') planningConfig.ciclo_default = Number(row.valor) || 90;
        if (row.clave === 'planning_ventana_proxima_dias') planningConfig.ventana_proxima_dias = Number(row.valor) || 15;
        if (row.clave === 'planning_ventana_urgente_dias') planningConfig.ventana_urgente_dias = Number(row.valor) || 15;
      });
    } catch (_) {}

    res.json({ success: true, clientes: r.rows, total: r.rows.length, planning_config: planningConfig });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
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

// F: GET resumen de la ULTIMA visita CERRADA de un cliente.
// Devuelve fecha, comercial, catalogo, pedidos/devoluciones/notas, y notas generales.
// Permisos: comercial solo ve sus propias visitas con ese cliente. Admin ve todas.
// Devuelve {visit: null, annotations: []} si no hay visita cerrada con el cliente.
app.get('/api/clients/:id/last-visit-summary', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const clientId = Number(req.params.id);
    const userId = effectiveUserId(req);
    let q, params;
    if (isEffectiveSales(req)) {
      // Comercial: solo SUS visitas con este cliente
      q = `
        SELECT v.*, u.name AS comercial_nombre, cat.name AS catalog_nombre
        FROM visits v
        LEFT JOIN users u ON u.id = v.user_id
        LEFT JOIN catalogs cat ON cat.id = v.catalog_id
        WHERE v.client_id = $1 AND v.user_id = $2
          AND v.status IN ('confirmed', 'sent')
        ORDER BY COALESCE(v.confirmed_at, v.created_at) DESC
        LIMIT 1
      `;
      params = [clientId, userId];
    } else {
      // Admin: cualquier visita cerrada del cliente
      q = `
        SELECT v.*, u.name AS comercial_nombre, cat.name AS catalog_nombre
        FROM visits v
        LEFT JOIN users u ON u.id = v.user_id
        LEFT JOIN catalogs cat ON cat.id = v.catalog_id
        WHERE v.client_id = $1
          AND v.status IN ('confirmed', 'sent')
        ORDER BY COALESCE(v.confirmed_at, v.created_at) DESC
        LIMIT 1
      `;
      params = [clientId];
    }
    const r = await pool.query(q, params);
    if (r.rows.length === 0) {
      res.json({ success: true, visit: null, annotations: [] });
      return;
    }
    const visit = r.rows[0];
    // Cargar anotaciones con datos lamina
    const anots = await pool.query(`
      SELECT a.*, s.titulo AS sheet_titulo, s.orden AS sheet_orden, s.imagen_path AS sheet_imagen
      FROM annotations a
      LEFT JOIN sheets s ON s.id = a.sheet_id
      WHERE a.visit_id = $1
      ORDER BY a.orden_en_visita, a.id`, [visit.id]);
    res.json({ success: true, visit, annotations: anots.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// G - PLANNING/RUTERO
// ============================================================================
// Listado de clientes con su estado de visita (semaforo). Calculo SQL para que
// sea rapido aunque haya 3000 clientes.
// Query params (todos opcionales):
//   estado: urgente | proxima | al_dia | sin_historial | todos (default todos)
//   q: busqueda razon_social o sage_code
//   provincia: filtro provincia exacto
//   municipio: filtro municipio exacto
//   comercial: codigo_comercial (solo admin lo usa). Comerciales solo ven los suyos.
//   limit / offset (default 100 / 0)
app.get('/api/planning', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const userId = effectiveUserId(req);

    // Leer config de planning de email_config (reutilizamos tabla clave-valor)
    const cfgR = await pool.query(
      `SELECT clave, valor FROM email_config WHERE clave IN
       ('planning_ciclo_default','planning_ventana_proxima_dias','planning_ventana_urgente_dias')`
    );
    const cfg: any = {};
    cfgR.rows.forEach((r: any) => { cfg[r.clave] = r.valor; });
    const cicloDefault = Number(cfg.planning_ciclo_default || 90);
    const ventanaProxima = Number(cfg.planning_ventana_proxima_dias || 15);
    const ventanaUrgente = Number(cfg.planning_ventana_urgente_dias || 15);

    // Params
    const estado = String(req.query.estado || 'todos');
    const q = String(req.query.q || '').trim().toLowerCase();
    const provincia = String(req.query.provincia || '').trim();
    const municipio = String(req.query.municipio || '').trim();
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    // Decidir filtro por comercial:
    //   - Admin real: si pasa ?comercial=X usa ese; si no, todos
    //   - Comercial (o admin impersonando): solo SUS clientes via sage_commercial_code
    // FIX: construimos los parametros con posiciones EXPLICITAS para evitar bugs de
    // off-by-one que tuvimos en la version anterior con paramIdx aritmetica.
    let comercialFilterClause = '';
    const params: any[] = [];

    if (isEffectiveSales(req)) {
      const uR = await pool.query(`SELECT sage_commercial_code FROM users WHERE id = $1`, [userId]);
      const ccode = uR.rows[0]?.sage_commercial_code;
      if (!ccode) {
        res.json({ success: true, clientes: [], total: 0, config: { cicloDefault, ventanaProxima, ventanaUrgente } });
        return;
      }
      params.push(String(ccode));
      comercialFilterClause = ` AND c.commercial_code = $${params.length}`;
    } else {
      const adminCom = String(req.query.comercial || '').trim();
      if (adminCom) {
        params.push(adminCom);
        comercialFilterClause = ` AND c.commercial_code = $${params.length}`;
      }
    }

    // Filtros varios - cada uno añade su parametro y captura su posicion
    let extraClauses = '';
    if (q) {
      params.push('%' + q + '%');
      const pos = params.length;
      extraClauses += ` AND (LOWER(c.razon_social) LIKE $${pos} OR LOWER(c.sage_code) LIKE $${pos})`;
    }
    if (provincia) {
      params.push(provincia);
      extraClauses += ` AND c.provincia = $${params.length}`;
    }
    if (municipio) {
      params.push(municipio);
      extraClauses += ` AND c.municipio = $${params.length}`;
    }

    // Añadir ciclo + ventanas + (estado si filtra) + limit + offset CON SUS POSICIONES
    params.push(cicloDefault);
    const posCiclo = params.length;
    params.push(ventanaProxima);
    const posProxima = params.length;
    params.push(ventanaUrgente);
    const posUrgente = params.length;
    let posEstado = 0;
    if (estado !== 'todos') {
      params.push(estado);
      posEstado = params.length;
    }
    params.push(limit);
    const posLimit = params.length;
    params.push(offset);
    const posOffset = params.length;

    // Query principal:
    // - Calculamos ciclo efectivo (cliente.ciclo_visita_dias o cicloDefault)
    // - Dias_desde_ultima_visita = NULL si nunca tuvo visita
    // - Estado: urgente / proxima / al_dia / sin_historial segun ventanas
    // - LEFT JOIN con la ultima visita confirmada del cliente para mostrar fecha y comercial
    const sql = `
      WITH ultima_visita AS (
        SELECT DISTINCT ON (v.client_id)
          v.client_id,
          COALESCE(v.confirmed_at, v.created_at) AS fecha_ultima,
          u.name AS comercial_ultima_visita,
          v.id AS visita_id
        FROM visits v
        LEFT JOIN users u ON u.id = v.user_id
        WHERE v.status IN ('confirmed','sent')
        ORDER BY v.client_id, COALESCE(v.confirmed_at, v.created_at) DESC
      ),
      base AS (
        SELECT
          c.id, c.sage_code, c.razon_social, c.cif, c.commercial_code,
          c.municipio, c.provincia, c.categoria, c.email, c.email_alternativo,
          c.telefono, c.ciclo_visita_dias,
          uv.fecha_ultima, uv.comercial_ultima_visita, uv.visita_id AS ultima_visita_id,
          COALESCE(c.ciclo_visita_dias, $${posCiclo}) AS ciclo_efectivo,
          CASE WHEN uv.fecha_ultima IS NULL THEN NULL
               ELSE EXTRACT(DAY FROM (NOW() - uv.fecha_ultima))::int
          END AS dias_desde_ultima
        FROM clients c
        LEFT JOIN ultima_visita uv ON uv.client_id = c.id
        WHERE c.is_active = TRUE
          ${comercialFilterClause}
          ${extraClauses}
      ),
      conEstado AS (
        SELECT
          b.*,
          CASE
            WHEN b.dias_desde_ultima IS NULL THEN 'sin_historial'
            WHEN b.dias_desde_ultima > (b.ciclo_efectivo + $${posUrgente}) THEN 'urgente'
            WHEN b.dias_desde_ultima >= (b.ciclo_efectivo - $${posProxima}) THEN 'proxima'
            ELSE 'al_dia'
          END AS estado,
          CASE
            WHEN b.dias_desde_ultima IS NULL THEN 0
            ELSE (b.dias_desde_ultima - b.ciclo_efectivo)
          END AS dias_retraso
        FROM base b
      )
      SELECT * FROM conEstado
      ${posEstado ? `WHERE estado = $${posEstado}` : ''}
      ORDER BY
        CASE estado
          WHEN 'urgente' THEN 1
          WHEN 'proxima' THEN 2
          WHEN 'sin_historial' THEN 3
          WHEN 'al_dia' THEN 4
        END,
        dias_retraso DESC NULLS LAST,
        razon_social ASC
      LIMIT $${posLimit}
      OFFSET $${posOffset}
    `;

    const r = await pool.query(sql, params);
    console.log('[PLANNING] OK -', r.rows.length, 'filas (params:', params.length, ')');

    // Total para paginación (solo si limit < clientes)
    // FIX bug: la query de conteo se construye DESDE CERO con sus propios parametros
    // para no liar el indice. Si la lista trajo menos resultados que el limite, no
    // hace falta contar (ya sabemos el total).
    let total = r.rows.length;
    if (r.rows.length === limit) {
      const cParams: any[] = [];
      let cIdx = 1;
      let cComClause = '';
      let cExtraClauses = '';

      // Filtro por comercial (mismas reglas que la query principal)
      if (isEffectiveSales(req)) {
        const uR = await pool.query(`SELECT sage_commercial_code FROM users WHERE id = $1`, [userId]);
        const ccode = uR.rows[0]?.sage_commercial_code;
        if (ccode) {
          cComClause = ` AND c.commercial_code = $${cIdx++}`;
          cParams.push(String(ccode));
        }
      } else {
        const adminCom = String(req.query.comercial || '').trim();
        if (adminCom) {
          cComClause = ` AND c.commercial_code = $${cIdx++}`;
          cParams.push(adminCom);
        }
      }
      if (q) {
        cExtraClauses += ` AND (LOWER(c.razon_social) LIKE $${cIdx} OR LOWER(c.sage_code) LIKE $${cIdx})`;
        cParams.push('%' + q + '%');
        cIdx++;
      }
      if (provincia) {
        cExtraClauses += ` AND c.provincia = $${cIdx++}`;
        cParams.push(provincia);
      }
      if (municipio) {
        cExtraClauses += ` AND c.municipio = $${cIdx++}`;
        cParams.push(municipio);
      }

      // CRITICO: SOLO añadimos a cParams los parametros que el SQL REALMENTE usa.
      // El SQL de conteo solo usa $cicloPos (en SELECT) y opcionalmente $urgPos, $proxPos,
      // $estPos (en estadoClause si filtra por estado). Si estado='todos', el estadoClause
      // esta vacio y NO se usan urg ni prox. Por eso reconstruimos los params en ESTE momento
      // según lo que realmente se referencia en el SQL.

      // Empezamos con un sub-array para poder reordenar
      const cParamsBase: any[] = [...cParams]; // los de filtros (comercial, q, provincia, municipio)
      cParams.length = 0; // reset
      cParams.push(...cParamsBase);

      const cicloPos = cParams.push(cicloDefault); // = nueva longitud = posicion 1-indexed
      let proxPos = 0, urgPos = 0, estPos = 0;
      let estadoClause = '';
      if (estado !== 'todos') {
        // Solo en este caso usamos prox/urg/estado en el SQL
        proxPos = cParams.push(ventanaProxima);
        urgPos  = cParams.push(ventanaUrgente);
        estPos  = cParams.push(estado);
        estadoClause = `WHERE CASE
            WHEN b.dias_desde_ultima IS NULL THEN 'sin_historial'
            WHEN b.dias_desde_ultima > (b.ciclo_efectivo + $${urgPos}) THEN 'urgente'
            WHEN b.dias_desde_ultima >= (b.ciclo_efectivo - $${proxPos}) THEN 'proxima'
            ELSE 'al_dia'
          END = $${estPos}`;
      }

      console.log('[PLANNING-COUNT] params:', cParams.length, 'estado:', estado, 'cicloPos:', cicloPos, 'estPos:', estPos);

      const countSql = `
        WITH ultima_visita AS (
          SELECT DISTINCT ON (v.client_id) v.client_id,
            COALESCE(v.confirmed_at, v.created_at) AS fecha_ultima
          FROM visits v
          WHERE v.status IN ('confirmed','sent')
          ORDER BY v.client_id, COALESCE(v.confirmed_at, v.created_at) DESC
        ),
        base AS (
          SELECT c.id, uv.fecha_ultima,
            COALESCE(c.ciclo_visita_dias, $${cicloPos}) AS ciclo_efectivo,
            CASE WHEN uv.fecha_ultima IS NULL THEN NULL
                 ELSE EXTRACT(DAY FROM (NOW() - uv.fecha_ultima))::int
            END AS dias_desde_ultima
          FROM clients c
          LEFT JOIN ultima_visita uv ON uv.client_id = c.id
          WHERE c.is_active = TRUE ${cComClause} ${cExtraClauses}
        )
        SELECT COUNT(*)::int AS n FROM base b
        ${estadoClause}
      `;
      const cR = await pool.query(countSql, cParams);
      total = cR.rows[0].n;
    }

    res.json({
      success: true,
      clientes: r.rows,
      total,
      config: { cicloDefault, ventanaProxima, ventanaUrgente }
    });
  } catch (e) {
    console.error('[PLANNING] ERROR:', (e as Error).message);
    console.error('[PLANNING] Stack:', (e as Error).stack);
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Endpoint sencillo para actualizar el ciclo de UN cliente individual.
// PUT /api/clients/:id/ciclo  body: { ciclo_visita_dias: 60|null }
// null = usa el default global
app.put('/api/clients/:id/ciclo', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const id = Number(req.params.id);
    const ciclo = req.body.ciclo_visita_dias;
    const val = (ciclo === null || ciclo === '' || ciclo === undefined) ? null : Number(ciclo);
    if (val !== null && (val < 1 || val > 730 || !Number.isFinite(val))) {
      res.status(400).json({ success: false, error: 'Ciclo debe estar entre 1 y 730 días, o null para usar el default' });
      return;
    }
    await pool.query(`UPDATE clients SET ciclo_visita_dias = $1, updated_at = NOW() WHERE id = $2`, [val, id]);
    res.json({ success: true, ciclo_visita_dias: val });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// GET listas para filtros del planning (provincias y municipios distintos)
app.get('/api/planning/filtros', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const userId = effectiveUserId(req);
    let where = `WHERE c.is_active = TRUE`;
    const params: any[] = [];
    if (isEffectiveSales(req)) {
      const uR = await pool.query(`SELECT sage_commercial_code FROM users WHERE id = $1`, [userId]);
      const ccode = uR.rows[0]?.sage_commercial_code;
      if (!ccode) { res.json({ success: true, provincias: [], municipios: [], comerciales: [] }); return; }
      where += ` AND c.commercial_code = $1`;
      params.push(String(ccode));
    }
    const provR = await pool.query(`SELECT DISTINCT provincia FROM clients c ${where} AND provincia IS NOT NULL AND provincia <> '' ORDER BY provincia`, params);
    const muniR = await pool.query(`SELECT DISTINCT municipio FROM clients c ${where} AND municipio IS NOT NULL AND municipio <> '' ORDER BY municipio`, params);
    // Comerciales solo si admin (codigos distintos en clients)
    let comerciales: string[] = [];
    if (!isEffectiveSales(req)) {
      const comR = await pool.query(`SELECT DISTINCT commercial_code FROM clients WHERE is_active = TRUE AND commercial_code IS NOT NULL AND commercial_code <> '' ORDER BY commercial_code`);
      comerciales = comR.rows.map((r: any) => r.commercial_code);
    }
    res.json({
      success: true,
      provincias: provR.rows.map((r: any) => r.provincia),
      municipios: muniR.rows.map((r: any) => r.municipio),
      comerciales
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// G - Estado planning para un conjunto de IDs (usado por lista de Clientes
// para mostrar el semaforo 🔴🟡🟢 sin cargar el listado completo de planning)
// POST /api/clients/states-batch body: { ids: [1,2,3,...] }
app.post('/api/clients/states-batch', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.json({ success: true, states: {} });
      return;
    }
    // Leer config
    const cfgR = await pool.query(
      `SELECT clave, valor FROM email_config WHERE clave IN
       ('planning_ciclo_default','planning_ventana_proxima_dias','planning_ventana_urgente_dias')`
    );
    const cfg: any = {};
    cfgR.rows.forEach((r: any) => { cfg[r.clave] = r.valor; });
    const cicloDefault = Number(cfg.planning_ciclo_default || 90);
    const ventanaProxima = Number(cfg.planning_ventana_proxima_dias || 15);
    const ventanaUrgente = Number(cfg.planning_ventana_urgente_dias || 15);

    const idsInt = ids.map((x: any) => Number(x)).filter(Number.isFinite);
    if (idsInt.length === 0) { res.json({ success: true, states: {} }); return; }

    const r = await pool.query(`
      WITH ultima AS (
        SELECT DISTINCT ON (v.client_id)
          v.client_id, COALESCE(v.confirmed_at, v.created_at) AS fecha_ultima
        FROM visits v WHERE v.status IN ('confirmed','sent')
        ORDER BY v.client_id, COALESCE(v.confirmed_at, v.created_at) DESC
      )
      SELECT c.id,
        COALESCE(c.ciclo_visita_dias, $1) AS ciclo_efectivo,
        CASE WHEN u.fecha_ultima IS NULL THEN NULL
             ELSE EXTRACT(DAY FROM (NOW() - u.fecha_ultima))::int
        END AS dias,
        u.fecha_ultima
      FROM clients c
      LEFT JOIN ultima u ON u.client_id = c.id
      WHERE c.id = ANY($2::int[])
    `, [cicloDefault, idsInt]);

    const states: any = {};
    r.rows.forEach((row: any) => {
      let estado;
      if (row.dias === null) estado = 'sin_historial';
      else if (row.dias > row.ciclo_efectivo + ventanaUrgente) estado = 'urgente';
      else if (row.dias >= row.ciclo_efectivo - ventanaProxima) estado = 'proxima';
      else estado = 'al_dia';
      states[row.id] = {
        estado,
        dias: row.dias,
        ciclo: row.ciclo_efectivo,
        fecha_ultima: row.fecha_ultima
      };
    });
    res.json({ success: true, states });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// H - GEOCODING DE CLIENTES + ENDPOINTS DE MAPA
// ============================================================================

// Estado del proceso de geocoding en memoria (no persiste entre redeploys, OK
// porque el proceso es manual y se inicia desde la pantalla de configuracion)
const _geoState = {
  running: false,
  total: 0,
  procesados: 0,
  ok: 0,
  errores: 0,
  no_encontrados: 0,
  ultimoError: '',
  iniciadoPor: '',
  iniciadoAt: null as Date | null,
  cancelado: false
};

// GET estado del geocoding (para barra de progreso)
app.get('/api/geocode-status', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    // Stats de BD: cuantos clientes activos con/sin coords
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int AS con_coords,
        COUNT(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)::int AS sin_coords,
        COUNT(*) FILTER (WHERE geo_status = 'no_encontrado')::int AS no_encontrados,
        COUNT(*) FILTER (WHERE geo_status = 'error')::int AS con_error
      FROM clients WHERE is_active = TRUE
    `);
    const stats = r.rows[0];
    res.json({
      success: true,
      stats,
      proceso: {
        running: _geoState.running,
        total: _geoState.total,
        procesados: _geoState.procesados,
        ok: _geoState.ok,
        errores: _geoState.errores,
        no_encontrados: _geoState.no_encontrados,
        ultimoError: _geoState.ultimoError,
        iniciadoAt: _geoState.iniciadoAt
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST iniciar proceso de geocoding (fire-and-forget). Solo admin real.
// Body: { soloFaltantes: true } - si true, solo geocodifica los que aun no tienen coords
//                                  si false, fuerza re-geocodificar TODOS los activos
app.post('/api/geocode-start', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    if (_geoState.running) {
      res.status(400).json({ success: false, error: 'Ya hay un proceso de geocoding en curso' });
      return;
    }
    const soloFaltantes = req.body.soloFaltantes !== false; // default true
    // Lanzar en background
    iniciarGeocodingBackground(req.user?.email || '?', soloFaltantes).catch(e => {
      console.error('[GEOCODE] Error fatal:', e);
      _geoState.running = false;
      _geoState.ultimoError = (e as Error).message;
    });
    res.json({ success: true, message: 'Proceso iniciado en background. Refresca el estado periódicamente.' });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST cancelar geocoding (deja lo que llevaba hecho)
app.post('/api/geocode-cancel', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  if (!_geoState.running) {
    res.status(400).json({ success: false, error: 'No hay proceso en curso' });
    return;
  }
  _geoState.cancelado = true;
  res.json({ success: true, message: 'Solicitada cancelación. Se detendrá tras el cliente actual.' });
});

// ============================================================================
// LIMPIAR DATOS DE PRUEBA (admin real, doble confirmación escribiendo BORRAR)
// ============================================================================
// Borra catálogos, láminas, visitas, anotaciones, versiones y logs de email.
// NO toca: productos, clientes, usuarios, configuración de email, plantillas.
// Pensado para que Fernando arranque de cero el catálogo cuando termine las
// pruebas, sin perder los 10.607 productos ni los clientes importados.
// Backfill de miniaturas: recorre las laminas sin miniatura_path y genera la WebP.
// Idempotente, se puede llamar las veces que haga falta. Devuelve progreso al final.
// Limit opcional (?limit=50) para procesar en lotes y no exceder el timeout HTTP.
// Backfill: corrige perfiles ICC de PNG existentes que se ven oscuros en navegador.
// Recorre laminas cuya imagen es PNG y tiene perfil ICC. Lo elimina in-place con
// sharp (sin perdida, misma resolucion) y regenera la miniatura WebP. Idempotente.
app.post('/api/admin/backfill-color-profile', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 40));
    // Consultar solo laminas con PNG y con miniatura ya generada (para no perder
    // el resto de la logica de subida). Si necesitamos otras, se procesan aparte.
    const pend = await pool.query(
      `SELECT id, imagen_path FROM sheets
       WHERE imagen_path IS NOT NULL AND imagen_path ILIKE '%.png'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [limit, Number(req.query.offset) || 0]
    );
    let procesadas = 0, corregidas = 0, sin_perfil = 0, errores = 0;
    const fallos: any[] = [];
    for (const row of pend.rows) {
      procesadas++;
      let rel = String(row.imagen_path);
      if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
      else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
      const abs = path.join(UPLOADS_DIR, rel);
      if (!abs.startsWith(UPLOADS_DIR) || !fs.existsSync(abs)) {
        errores++;
        fallos.push({ id: row.id, motivo: 'archivo no existe en disco' });
        continue;
      }
      try {
        const modificado = await normalizarPngColor(abs);
        if (modificado) {
          corregidas++;
          // Regenerar miniatura tambien para que las miniaturas usen la misma correccion
          const nuevaMini = await generarMiniatura(abs, path.basename(abs));
          if (nuevaMini) {
            await pool.query('UPDATE sheets SET miniatura_path=$1, updated_at=NOW() WHERE id=$2', [nuevaMini, row.id]);
          }
        } else {
          sin_perfil++;
        }
      } catch (e: any) {
        errores++;
        fallos.push({ id: row.id, motivo: (e?.message || e).toString().substring(0, 120) });
      }
    }
    const restR = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sheets
       WHERE imagen_path IS NOT NULL AND imagen_path ILIKE '%.png'`
    );
    res.json({ success: true, procesadas, corregidas, sin_perfil, errores, total: restR.rows[0].n, fallos: fallos.slice(0, 10) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/backfill-thumbnails', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const pending = await pool.query(
      `SELECT id, imagen_path FROM sheets
       WHERE (miniatura_path IS NULL OR miniatura_path = '')
         AND imagen_path IS NOT NULL
       ORDER BY id
       LIMIT $1`,
      [limit]
    );
    let ok = 0, ko = 0;
    const errores: any[] = [];
    for (const row of pending.rows) {
      let rel = row.imagen_path as string;
      if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
      else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
      const rutaAbs = path.join(UPLOADS_DIR, rel);
      const filename = path.basename(rel);
      const mini = await generarMiniatura(rutaAbs, filename);
      if (mini) {
        await pool.query('UPDATE sheets SET miniatura_path=$1 WHERE id=$2', [mini, row.id]);
        ok++;
      } else {
        ko++;
        errores.push({ sheet_id: row.id, imagen_path: row.imagen_path });
      }
    }
    // Cuantas quedan
    const restantesR = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sheets
       WHERE (miniatura_path IS NULL OR miniatura_path = '')
         AND imagen_path IS NOT NULL`
    );
    res.json({
      success: true,
      procesadas: pending.rows.length,
      generadas: ok,
      fallidas: ko,
      restantes: restantesR.rows[0].n,
      errores: errores.slice(0, 10)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// MEGA BACKUP - endpoint temporal de test para verificar login antes de
// codificar el flujo completo. GET /api/admin/mega-test -> intenta login,
// devuelve nombre del usuario y espacio disponible.
// ============================================================================
// ============================================================================
// MEGA BACKUP - jobs asincronos con progreso
// ============================================================================
// Los jobs viven en memoria. Un catalogo de 400 laminas puede tardar 10+ min
// en subir. El cliente hace polling a /api/admin/mega-backup/status/:jobId.
// Si el proceso reinicia (Railway redeploy), el job se pierde -> aceptable
// para MVP; el usuario simplemente relanza el backup.
type MegaJobStatus = 'running' | 'done' | 'error';
interface MegaJob {
  id: string;
  catalog_id: number;
  catalog_name: string;
  catalog_version: number;
  status: MegaJobStatus;
  fase: string;
  total_laminas: number;
  subidas: number;
  fallidas: number;
  // Destinos = carpetas MEGA seleccionadas por el admin al lanzar el backup
  destinos: Array<{
    mega_folder_id: number;
    folder_nombre: string; // nombre de la carpeta raiz en MEGA (ej: "Catalogo Lomhifar Eva 2026")
    user_id: number | null; // comercial destinatario del email si esta configurado
    user_name: string | null;
    mega_url: string; // link publico raiz (pegado por admin previamente)
    subcarpeta_creada?: string; // ruta interna dentro de la carpeta raiz
    error?: string;
    backup_id?: number;
  }>;
  error?: string;
  started_at: number;
  ended_at?: number;
  created_by: number;
  con_precios?: boolean; // F5: subir las laminas RECOMPUESTAS (precios de hoy + ofertas)
}
const megaJobs = new Map<string, MegaJob>();

function nuevoJobId(): string {
  return 'mj_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

// Ejecuta el backup en background (no bloquea la respuesta HTTP inicial).
// El admin selecciona previamente a que mega_folders subir (por checkbox).
async function ejecutarBackupMega(job: MegaJob): Promise<void> {
  try {
    job.fase = 'Cargando datos del catalogo...';
    const catR = await pool.query('SELECT id, name, version FROM catalogs WHERE id = $1', [job.catalog_id]);
    if (catR.rows.length === 0) throw new Error('Catalogo no encontrado');
    const cat = catR.rows[0];

    const sheetsR = await pool.query(
      'SELECT id, orden, titulo, imagen_path FROM sheets WHERE catalog_id = $1 AND oculta = FALSE ORDER BY orden, id',
      [job.catalog_id]
    );
    const sheets = sheetsR.rows;
    job.total_laminas = sheets.length;
    if (sheets.length === 0) throw new Error('El catalogo no tiene laminas');
    if (!job.destinos || job.destinos.length === 0) {
      throw new Error('No has seleccionado ninguna carpeta MEGA de destino');
    }

    // Validar que todos los destinos tienen mega_url configurado
    const sinLink = job.destinos.filter(d => !d.mega_url);
    if (sinLink.length > 0) {
      throw new Error('Carpetas sin URL configurada: ' + sinLink.map(d => d.folder_nombre).join(', ') + '. Ve a "Carpetas MEGA" y pega el link publico primero.');
    }

    job.fase = 'Conectando a MEGA...';
    const storage = await getMegaStorage();
    const rootCP = await ensureFolder(storage.root, ROOT_FOLDER);
    const carpetaCat = nombreCarpetaCatalogo(cat.name, cat.version);

    // Para cada destino: crear subcarpeta del backup dentro de la carpeta raiz
    for (const destino of job.destinos) {
      job.fase = `Preparando "${destino.folder_nombre}"...`;
      const carpetaRaiz = await ensureFolder(rootCP, destino.folder_nombre);
      const carpetaSubida = await ensureFolder(carpetaRaiz, carpetaCat);
      destino.subcarpeta_creada = carpetaCat;

      // Reset contadores por destino
      job.subidas = 0;
      job.fallidas = 0;
      let sizeTotal = 0;
      for (let i = 0; i < sheets.length; i++) {
        const s = sheets[i];
        job.fase = `[${destino.folder_nombre}] Subiendo ${i + 1}/${sheets.length}...`;
        try {
          let rel = String(s.imagen_path || '');
          if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
          else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
          const abs = path.join(UPLOADS_DIR, rel);
          if (!fs.existsSync(abs)) throw new Error('archivo no existe en disco: ' + rel);
          // F5: si el backup es "con precios de hoy", subimos la lamina RECOMPUESTA
          // (precios vigentes + ofertas horneados); si falla, la original.
          let buf: Buffer;
          if (job.con_precios) {
            const rec = await recomponerLaminaHoy(s.id, 1);
            buf = rec || fs.readFileSync(abs);
          } else {
            buf = fs.readFileSync(abs);
          }
          sizeTotal += buf.length;
          const ext = path.extname(rel) || '.png';
          const nombre = nombreLaminaOrdenada(s.orden || (i + 1), s.titulo, ext);
          await uploadFileBuffer(carpetaSubida, nombre, buf);
          job.subidas++;
        } catch (e: any) {
          console.error(`[mega-backup] lamina ${s.id} fallo:`, e.message);
          job.fallidas++;
        }
      }

      // Guardar en historial (usa mega_url ya configurado por el admin)
      try {
        const ins = await pool.query(
          `INSERT INTO mega_backups
             (catalog_id, catalog_name, catalog_version, destino_tipo, destino_user_id,
              destino_user_name, mega_url, mega_folder_name, num_laminas, size_mb, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            job.catalog_id, cat.name, cat.version,
            destino.user_id ? 'comercial' : 'general',
            destino.user_id, destino.user_name || destino.folder_nombre,
            destino.mega_url, destino.folder_nombre + ' / ' + carpetaCat,
            job.subidas, Number((sizeTotal / 1024 / 1024).toFixed(2)),
            job.created_by
          ]
        );
        destino.backup_id = ins.rows[0].id;
      } catch (e: any) {
        console.error('[mega-backup] insert historial fallo:', e.message);
      }
    }

    job.fase = 'Completado';
    job.status = 'done';
    job.ended_at = Date.now();
  } catch (e: any) {
    console.error('[mega-backup] job fallo:', e.message);
    job.status = 'error';
    job.error = e.message;
    job.ended_at = Date.now();
  }
}

// Iniciar backup - body: { mega_folder_ids: number[] }
app.post('/api/admin/mega-backup/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    const megaFolderIds: number[] = Array.isArray(req.body?.mega_folder_ids)
      ? req.body.mega_folder_ids.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0)
      : [];
    if (megaFolderIds.length === 0) {
      res.status(400).json({ success: false, error: 'Debes seleccionar al menos una carpeta MEGA de destino' });
      return;
    }

    const catR = await pool.query('SELECT id, name, version FROM catalogs WHERE id = $1', [catalogId]);
    if (catR.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Catalogo no encontrado' });
      return;
    }
    const cat = catR.rows[0];

    // Cargar las carpetas seleccionadas (con usuario para email)
    const foldersR = await pool.query(
      `SELECT f.id, f.nombre, f.mega_url, f.user_id, u.name AS user_name
       FROM mega_folders f
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.id = ANY($1::int[]) AND f.is_active = TRUE
       ORDER BY f.orden, f.id`,
      [megaFolderIds]
    );
    if (foldersR.rows.length === 0) {
      res.status(400).json({ success: false, error: 'Ninguna de las carpetas seleccionadas esta activa' });
      return;
    }

    const destinos = foldersR.rows.map((f: any) => ({
      mega_folder_id: f.id,
      folder_nombre: f.nombre,
      user_id: f.user_id,
      user_name: f.user_name,
      mega_url: f.mega_url || ''
    }));

    const job: MegaJob = {
      id: nuevoJobId(),
      catalog_id: catalogId,
      catalog_name: cat.name,
      catalog_version: cat.version,
      status: 'running',
      fase: 'Iniciando...',
      total_laminas: 0,
      subidas: 0,
      fallidas: 0,
      destinos,
      started_at: Date.now(),
      created_by: req.user!.id,
      con_precios: !!req.body?.con_precios
    };
    megaJobs.set(job.id, job);

    ejecutarBackupMega(job).catch(e => {
      console.error('[mega-backup] uncaught en job', job.id, e);
    });

    res.json({ success: true, job_id: job.id });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Polling de estado
app.get('/api/admin/mega-backup/status/:jobId', verifyToken, requireRealAdmin, (req: AuthRequest, res: Response) => {
  const job = megaJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job no encontrado (puede haber caducado tras reinicio del servidor)' });
    return;
  }
  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      fase: job.fase,
      catalog_name: job.catalog_name,
      catalog_version: job.catalog_version,
      total_laminas: job.total_laminas,
      subidas: job.subidas,
      fallidas: job.fallidas,
      destinos: job.destinos,
      error: job.error,
      started_at: job.started_at,
      ended_at: job.ended_at,
      duracion_s: job.ended_at ? Math.round((job.ended_at - job.started_at) / 1000) : Math.round((Date.now() - job.started_at) / 1000)
    }
  });
});

// Listado del historial de backups de un catalogo
app.get('/api/admin/mega-backup/history/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    const r = await pool.query(
      `SELECT id, catalog_version, destino_tipo, destino_user_id, destino_user_name,
              mega_url, mega_folder_name, num_laminas, size_mb, email_enviado_at, created_at
       FROM mega_backups
       WHERE catalog_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [catalogId]
    );
    res.json({ success: true, backups: r.rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Regenera el link publico de una carpeta MEGA cuya URL fallo al crear
// (tipico caso: share() dio EAGAIN inicialmente). Encuentra la carpeta
// en MEGA por su ruta -> comercial/general -> nombre_carpeta.
// Track de operaciones de regenerar link en curso (para polling)
// NOTA: regenerate-link es LEGACY del enfoque anterior; queda para no romper
// clientes con state antiguo. En el flujo nuevo el admin pega el link manualmente.
const regenLinkJobs = new Map<number, { status: 'running' | 'done' | 'error'; mega_url?: string; error?: string; started_at: number }>();

app.post('/api/admin/mega-backup/regenerate-link/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  const backupId = Number(req.params.id);
  try {
    // Si ya se completo antes, devolver directamente
    const dbCheck = await pool.query(`SELECT mega_url FROM mega_backups WHERE id = $1`, [backupId]);
    if (dbCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Backup no encontrado' });
      return;
    }
    if (dbCheck.rows[0].mega_url) {
      res.json({ success: true, mega_url: dbCheck.rows[0].mega_url });
      return;
    }
    // Si hay un job en curso para este backup, esperarlo (polling)
    const existing = regenLinkJobs.get(backupId);
    if (existing && existing.status === 'running') {
      res.json({ success: false, error: 'Ya hay un intento en curso, espera unos segundos y reintenta' });
      return;
    }
    if (existing && existing.status === 'done' && existing.mega_url) {
      res.json({ success: true, mega_url: existing.mega_url });
      return;
    }
    // Arrancar en background
    regenLinkJobs.set(backupId, { status: 'running', started_at: Date.now() });
    (async () => {
      try {
        const r = await pool.query(
          `SELECT id, destino_tipo, destino_user_name, mega_folder_name FROM mega_backups WHERE id = $1`,
          [backupId]
        );
        const b = r.rows[0];
        // Sesion fresca para evitar rate-limit de session anterior
        invalidarSesionMega();
        const storage = await getMegaStorage();
        const rootCP = await ensureFolder(storage.root, ROOT_FOLDER);
        let parent;
        if (b.destino_tipo === 'general') {
          parent = await ensureFolder(rootCP, GENERAL_FOLDER);
        } else {
          const comerciales = await ensureFolder(rootCP, COMERCIALES_FOLDER);
          parent = await ensureFolder(comerciales, sanitizeName(b.destino_user_name || ''));
        }
        const carpeta = (parent.children || []).find((c: any) => c.directory && c.name === b.mega_folder_name);
        if (!carpeta) throw new Error('Carpeta ya no existe en MEGA. Vuelve a lanzar backup.');
        const url = await shareFolderLink(carpeta);
        await pool.query(`UPDATE mega_backups SET mega_url = $1 WHERE id = $2`, [url, backupId]);
        regenLinkJobs.set(backupId, { status: 'done', mega_url: url, started_at: existing?.started_at || Date.now() });
      } catch (e: any) {
        regenLinkJobs.set(backupId, { status: 'error', error: e.message, started_at: existing?.started_at || Date.now() });
        console.error('[regenerate-link] backup ' + backupId + ' fallo:', e.message);
      }
    })();
    // Responder al instante con "en curso" - cliente hace polling a GET status
    res.json({ success: false, status: 'running', error: 'Regenerando en background, haz polling a /status/' + backupId });
  } catch (e: any) {
    regenLinkJobs.set(backupId, { status: 'error', error: e.message, started_at: Date.now() });
    res.status(500).json({ success: false, error: e.message });
  }
});

// Polling del estado del regenerate
app.get('/api/admin/mega-backup/regenerate-link/status/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  const backupId = Number(req.params.id);
  // Consultar BD primero (fuente de verdad)
  const dbR = await pool.query(`SELECT mega_url FROM mega_backups WHERE id = $1`, [backupId]);
  if (dbR.rows.length === 0) {
    res.status(404).json({ success: false, error: 'Backup no encontrado' });
    return;
  }
  if (dbR.rows[0].mega_url) {
    res.json({ success: true, status: 'done', mega_url: dbR.rows[0].mega_url });
    return;
  }
  const job = regenLinkJobs.get(backupId);
  if (!job) {
    res.json({ success: false, status: 'nunca_intentado' });
    return;
  }
  res.json({
    success: job.status === 'done',
    status: job.status,
    mega_url: job.mega_url,
    error: job.error,
    duracion_s: Math.round((Date.now() - job.started_at) / 1000)
  });
});

// Enviar por email un link MEGA al comercial destinatario
app.post('/api/admin/mega-backup/send-email', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, mega_url, catalog_name, catalog_version, folder_name } = req.body || {};
    if (!user_id || !mega_url || !catalog_name) {
      res.status(400).json({ success: false, error: 'Faltan user_id / mega_url / catalog_name' });
      return;
    }
    const u = await pool.query(
      `SELECT id, email, name FROM users
       WHERE id = $1 AND role = 'sales' AND is_active = TRUE`,
      [user_id]
    );
    if (u.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Comercial no encontrado o inactivo' });
      return;
    }
    const dest = u.rows[0];
    if (!dest.email) {
      res.status(400).json({ success: false, error: 'El comercial no tiene email' });
      return;
    }
    const asunto = `☁️ Copia de seguridad del catálogo · ${catalog_name} · V${catalog_version || '?'}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
        <div style="background:linear-gradient(135deg,#cc007a 0%,#a3005f 100%);color:#fff;padding:24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:20px">☁️ Backup en MEGA</h2>
          <p style="margin:8px 0 0 0;opacity:0.9;font-size:14px">CatalogPRO · LOMHIFAR</p>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
          <p style="margin:0 0 14px 0;font-size:14px">Hola ${escapeHtml(dest.name)},</p>
          <p style="margin:0 0 14px 0;font-size:14px">
            Tienes disponible en <b>MEGA</b> una copia de respaldo del catálogo con todas las láminas
            como fotos PNG numeradas. <b>Guarda este enlace</b> por si algún día la app falla o no tienes cobertura:
            podrás abrir esta carpeta desde el móvil y presentar el catálogo al cliente con el visor de fotos.
          </p>
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:14px 0">
            <div style="font-size:11px;text-transform:uppercase;color:#be185d;font-weight:700;margin-bottom:4px">📚 Nuevo backup</div>
            <div style="font-size:16px;font-weight:600;color:#111827">${escapeHtml(catalog_name)} · V${catalog_version || '?'}</div>
            ${folder_name ? `<div style="font-size:12px;color:#6b7280;margin-top:6px">📁 Entra en la subcarpeta: <b>${escapeHtml(folder_name)}</b></div>` : ''}
          </div>
          <div style="text-align:center;margin:24px 0">
            <a href="${escapeHtml(mega_url)}" style="display:inline-block;background:#cc007a;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">
              ☁️ Abrir tu carpeta en MEGA
            </a>
          </div>
          <p style="font-size:12px;color:#6b7280;margin:0 0 14px 0">
            Este enlace es <b>permanente</b> y lleva a <b>tu carpeta personal</b> en MEGA.
            Ahí verás el histórico de todos tus catálogos. Guárdalo en favoritos.
          </p>
          <p style="font-size:12px;color:#6b7280;margin:14px 0 0 0">
            Enlace directo: <a href="${escapeHtml(mega_url)}" style="color:#cc007a;word-break:break-all">${escapeHtml(mega_url)}</a>
          </p>
          <hr style="border:none;border-top:1px solid #f3f4f6;margin:20px 0">
          <p style="font-size:11px;color:#9ca3af;margin:0">
            No respondas a este correo. Es un envio automatico desde CatalogPRO.
          </p>
        </div>
      </div>
    `;
    const result = await enviarEmailConRedireccion({
      rol: 'comercial',
      destinatarioReal: dest.email,
      asunto,
      html
    });
    if (result.ok) {
      // Marcar en el ultimo backup coincidente el email como enviado
      await pool.query(
        `UPDATE mega_backups
         SET email_enviado_at = NOW()
         WHERE destino_user_id = $1 AND mega_url = $2 AND email_enviado_at IS NULL`,
        [user_id, mega_url]
      );
      res.json({ success: true, destinatario: result.destinatarioFinal, modo: result.modo });
    } else {
      res.status(500).json({ success: false, error: result.error || 'fallo enviando email' });
    }
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// MEGA FOLDERS - CRUD y seed
// ============================================================================
app.get('/api/admin/mega-folders', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`
      SELECT f.id, f.nombre, f.mega_url, f.user_id, f.descripcion, f.orden, f.is_active,
             u.name AS user_name, u.email AS user_email
      FROM mega_folders f
      LEFT JOIN users u ON u.id = f.user_id
      ORDER BY f.orden, f.id`);
    res.json({ success: true, folders: r.rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/mega-folders', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { nombre, mega_url, user_id, descripcion, orden, crear_en_mega } = req.body || {};
    if (!nombre || !String(nombre).trim()) {
      res.status(400).json({ success: false, error: 'nombre es obligatorio' });
      return;
    }
    const nombreLimpio = String(nombre).trim().substring(0, 200);
    // Crear la carpeta en MEGA (opcional) - por defecto lo hacemos
    let creadaEnMega = false;
    if (crear_en_mega !== false) {
      try {
        const storage = await getMegaStorage();
        const rootCP = await ensureFolder(storage.root, ROOT_FOLDER);
        await ensureFolder(rootCP, nombreLimpio);
        creadaEnMega = true;
      } catch (e: any) {
        console.warn('[mega-folders] no se pudo crear en MEGA:', e.message);
        // Seguimos: el admin puede crearla manual en MEGA
      }
    }
    const ins = await pool.query(
      `INSERT INTO mega_folders (nombre, mega_url, user_id, descripcion, orden, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
      [
        nombreLimpio,
        String(mega_url || '').trim(),
        user_id ? Number(user_id) : null,
        descripcion ? String(descripcion).trim().substring(0, 255) : null,
        Number(orden) || 0
      ]
    );
    res.status(201).json({ success: true, folder: ins.rows[0], creada_en_mega: creadaEnMega });
  } catch (e: any) {
    if (e.code === '23505') {
      res.status(400).json({ success: false, error: 'Ya existe una carpeta con ese nombre' });
    } else {
      res.status(500).json({ success: false, error: e.message });
    }
  }
});

app.put('/api/admin/mega-folders/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    // Solo actualizar los campos que VIENEN en el body. Los que no vienen NO
    // se tocan (bug anterior: los ponia a null).
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (Object.prototype.hasOwnProperty.call(body, 'nombre')) {
      sets.push(`nombre = $${idx++}`);
      params.push(String(body.nombre || '').trim().substring(0, 200));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'mega_url')) {
      sets.push(`mega_url = $${idx++}`);
      params.push(String(body.mega_url || '').trim());
    }
    if (Object.prototype.hasOwnProperty.call(body, 'user_id')) {
      sets.push(`user_id = $${idx++}`);
      params.push(body.user_id ? Number(body.user_id) : null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'descripcion')) {
      sets.push(`descripcion = $${idx++}`);
      params.push(body.descripcion ? String(body.descripcion).trim().substring(0, 255) : null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'orden')) {
      sets.push(`orden = $${idx++}`);
      params.push(Number(body.orden) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
      sets.push(`is_active = $${idx++}`);
      params.push(Boolean(body.is_active));
    }
    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'No hay campos que actualizar' });
      return;
    }
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const r = await pool.query(
      `UPDATE mega_folders SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Carpeta no encontrada' });
      return;
    }
    res.json({ success: true, folder: r.rows[0] });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/admin/mega-folders/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('DELETE FROM mega_folders WHERE id = $1 RETURNING id', [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Carpeta no encontrada' });
      return;
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Seed: crea las 6 carpetas iniciales en MEGA y las inserta en BD.
// Idempotente: si ya existen se salta sin error.
app.post('/api/admin/mega-folders/seed', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    // Buscar user ids por nombre (los del sistema)
    const usersR = await pool.query(
      `SELECT id, name FROM users WHERE role = 'sales' AND is_active = TRUE`
    );
    const users = usersR.rows;
    const findUserId = (patron: string): number | null => {
      const u = users.find((x: any) => x.name.toLowerCase().includes(patron.toLowerCase()));
      return u ? u.id : null;
    };
    const evaId = findUserId('eva');
    const fernandoId = findUserId('fernando ayllon martiarena');
    const miguelId = findUserId('miguel');

    const iniciales = [
      { nombre: 'Catalogo Lomhifar Fernando 2026', user_id: fernandoId, descripcion: 'Comercial: Fernando (Sage 2)', orden: 10 },
      { nombre: 'Catalogo Lomhifar Eva 2026',       user_id: evaId,      descripcion: 'Comercial: Eva Lomillo (Sage 1)', orden: 20 },
      { nombre: 'Catalogo Lomhifar Duofarma 2026',  user_id: miguelId,   descripcion: 'Comercial: Miguel Angel (Vizcaya, Sage 6)', orden: 30 },
      { nombre: 'Catalogo Essity 2026',             user_id: null,       descripcion: 'Laboratorio Essity', orden: 40 },
      { nombre: 'Catalogo Beter 2026',              user_id: null,       descripcion: 'Laboratorio Beter', orden: 50 },
      { nombre: 'Catalogo Onevit 2026',             user_id: null,       descripcion: 'Laboratorio Onevit', orden: 60 }
    ];

    // Crear todas en MEGA
    const storage = await getMegaStorage();
    const rootCP = await ensureFolder(storage.root, ROOT_FOLDER);
    const resultados: any[] = [];
    for (const f of iniciales) {
      let creadaEnMega = false;
      try {
        await ensureFolder(rootCP, f.nombre);
        creadaEnMega = true;
      } catch (e: any) {
        console.warn('[seed] error creando en MEGA', f.nombre, ':', e.message);
      }
      // Insertar en BD si no existe
      const ins = await pool.query(
        `INSERT INTO mega_folders (nombre, mega_url, user_id, descripcion, orden, is_active)
         VALUES ($1, '', $2, $3, $4, TRUE)
         ON CONFLICT (nombre) DO NOTHING
         RETURNING *`,
        [f.nombre, f.user_id, f.descripcion, f.orden]
      );
      resultados.push({
        nombre: f.nombre,
        creada_en_mega: creadaEnMega,
        insertada_en_bd: ins.rows.length > 0,
        ya_existia: ins.rows.length === 0
      });
    }
    res.json({ success: true, resultados });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// OFFICE SUMMARY - resumen a oficina de cambios en catalogos + links MEGA.
// Se envia manualmente cuando el admin termina de actualizar los catalogos.
// ============================================================================

// ---- CRUD destinatarios ----
app.get('/api/admin/office-recipients', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query('SELECT * FROM office_summary_recipients ORDER BY id');
    res.json({ success: true, recipients: r.rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/office-recipients', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { email, nombre } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      res.status(400).json({ success: false, error: 'Email invalido' });
      return;
    }
    const ins = await pool.query(
      `INSERT INTO office_summary_recipients (email, nombre) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET nombre = EXCLUDED.nombre, is_active = TRUE
       RETURNING *`,
      [String(email).trim().toLowerCase(), nombre ? String(nombre).trim() : null]
    );
    res.status(201).json({ success: true, recipient: ins.rows[0] });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/admin/office-recipients/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (Object.prototype.hasOwnProperty.call(body, 'email')) {
      sets.push(`email = $${idx++}`); params.push(String(body.email || '').trim().toLowerCase());
    }
    if (Object.prototype.hasOwnProperty.call(body, 'nombre')) {
      sets.push(`nombre = $${idx++}`); params.push(body.nombre ? String(body.nombre).trim() : null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
      sets.push(`is_active = $${idx++}`); params.push(Boolean(body.is_active));
    }
    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'Nada que actualizar' });
      return;
    }
    params.push(id);
    const r = await pool.query(`UPDATE office_summary_recipients SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (r.rows.length === 0) { res.status(404).json({ success: false, error: 'No encontrado' }); return; }
    res.json({ success: true, recipient: r.rows[0] });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/admin/office-recipients/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query('DELETE FROM office_summary_recipients WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (r.rows.length === 0) { res.status(404).json({ success: false, error: 'No encontrado' }); return; }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Seed de los 4 emails iniciales de oficina (idempotente)
app.post('/api/admin/office-recipients/seed', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const emails = [
      { email: 'lomhifar@comercial.com',       nombre: 'Oficina Lomhifar' },
      { email: 'administracion@comercial.com', nombre: 'Administracion' },
      { email: 'comercial@lomhifar.com',       nombre: 'Comercial Lomhifar' },
      { email: 'lomhifartablet@lomhifar.com',  nombre: 'Tablet Oficina' }
    ];
    for (const e of emails) {
      await pool.query(
        `INSERT INTO office_summary_recipients (email, nombre) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET nombre = EXCLUDED.nombre, is_active = TRUE`,
        [e.email, e.nombre]
      );
    }
    const r = await pool.query('SELECT * FROM office_summary_recipients ORDER BY id');
    res.json({ success: true, recipients: r.rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- Helper: cargar datos del resumen (cambios + links MEGA) ----
async function cargarDatosResumen(): Promise<{
  desde: Date;
  hasta: Date;
  laminas_nuevas: any[];
  laminas_modificadas: any[];
  laminas_eliminadas: any[];
  mega_carpetas: any[];
}> {
  // Punto de corte: ultima vez que se envio, o hace 30 dias si nunca
  const lastR = await pool.query('SELECT MAX(sent_at) AS last FROM office_summary_sent');
  const desde: Date = lastR.rows[0]?.last || new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const hasta = new Date();

  // Cargar cambios desde 'desde' (agrupados por tipo)
  const audR = await pool.query(
    `SELECT a.id, a.sheet_id, a.catalog_id, a.catalog_name, a.titulo,
            a.tipo_cambio, a.campos_json, a.actor_name, a.created_at
     FROM sheet_audit_log a
     WHERE a.created_at > $1
     ORDER BY a.created_at DESC`,
    [desde]
  );
  const laminas_nuevas: any[] = [];
  const laminas_modificadas: any[] = [];
  const laminas_eliminadas: any[] = [];
  // Deduplicar por sheet_id (nos quedamos con el cambio mas reciente por sheet)
  const seen = new Set<number>();
  for (const row of audR.rows) {
    if (row.sheet_id && seen.has(row.sheet_id)) continue;
    if (row.sheet_id) seen.add(row.sheet_id);
    if (row.tipo_cambio === 'created') laminas_nuevas.push(row);
    else if (row.tipo_cambio === 'deleted') laminas_eliminadas.push(row);
    else laminas_modificadas.push(row);
  }

  // Ultimo backup MEGA por carpeta (Eva + laboratorios)
  const megaR = await pool.query(`
    SELECT DISTINCT ON (f.id)
           f.id, f.nombre, f.mega_url, f.user_id, u.name AS user_name, f.descripcion,
           b.catalog_name AS ultimo_catalogo, b.catalog_version AS ultima_version,
           b.mega_folder_name AS ultima_subcarpeta, b.created_at AS ultimo_backup_at,
           b.num_laminas AS ultimas_num_laminas
    FROM mega_folders f
    LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN mega_backups b ON b.mega_url = f.mega_url
    WHERE f.is_active = TRUE AND f.mega_url <> ''
    ORDER BY f.id, b.created_at DESC NULLS LAST
  `);

  return {
    desde,
    hasta,
    laminas_nuevas,
    laminas_modificadas,
    laminas_eliminadas,
    mega_carpetas: megaR.rows
  };
}

// ---- Preview (GET) ----
app.get('/api/admin/office-summary/preview', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const datos = await cargarDatosResumen();
    const destinatariosR = await pool.query(`SELECT email, nombre FROM office_summary_recipients WHERE is_active = TRUE ORDER BY id`);
    res.json({
      success: true,
      desde: datos.desde,
      hasta: datos.hasta,
      resumen: {
        nuevas: datos.laminas_nuevas.length,
        modificadas: datos.laminas_modificadas.length,
        eliminadas: datos.laminas_eliminadas.length,
        carpetas_mega: datos.mega_carpetas.length
      },
      laminas_nuevas: datos.laminas_nuevas,
      laminas_modificadas: datos.laminas_modificadas,
      laminas_eliminadas: datos.laminas_eliminadas,
      mega_carpetas: datos.mega_carpetas,
      destinatarios: destinatariosR.rows
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- Enviar (POST) ----
app.post('/api/admin/office-summary/send', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const datos = await cargarDatosResumen();
    const destR = await pool.query(`SELECT email FROM office_summary_recipients WHERE is_active = TRUE`);
    const destinatarios: string[] = destR.rows.map((r: any) => r.email);
    if (destinatarios.length === 0) {
      res.status(400).json({ success: false, error: 'No hay destinatarios de oficina configurados' });
      return;
    }

    const fmt = (d: Date) => new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
    const fmtFecha = (d: Date | string) => new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });

    const seccionMega = datos.mega_carpetas.length === 0 ? '' : `
      <h3 style="color:#111827;font-size:16px;margin:20px 0 8px 0">📚 Catálogos en MEGA</h3>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px">
        ${datos.mega_carpetas.map((f: any) => `
          <div style="padding:8px 0;border-bottom:1px solid #f3f4f6">
            <div style="font-weight:600;font-size:13px">
              <a href="${escapeHtml(f.mega_url)}" style="color:#cc007a;text-decoration:none">☁️ ${escapeHtml(f.nombre)}</a>
            </div>
            ${f.ultimo_catalogo ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">
              Último backup: <b>${escapeHtml(f.ultimo_catalogo)}</b> V${f.ultima_version} · ${f.ultimas_num_laminas} láminas · ${fmtFecha(f.ultimo_backup_at)}
            </div>` : `<div style="font-size:11px;color:#9ca3af;margin-top:2px">Sin backups todavia</div>`}
          </div>
        `).join('')}
      </div>
    `;

    const filaLamina = (l: any, tipo: string) => `
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:6px 8px;font-size:12px;font-weight:600;color:#111827">${escapeHtml(l.titulo || '(sin título)')}</td>
        <td style="padding:6px 8px;font-size:11px;color:#6b7280">${escapeHtml(l.catalog_name || '')}</td>
        <td style="padding:6px 8px;font-size:11px;color:#6b7280;white-space:nowrap">${fmtFecha(l.created_at)}</td>
        <td style="padding:6px 8px;font-size:11px;color:#6b7280">${escapeHtml(l.actor_name || '')}</td>
      </tr>
    `;

    const seccionCambios = (titulo: string, color: string, items: any[]) => items.length === 0 ? '' : `
      <h3 style="color:${color};font-size:15px;margin:16px 0 8px 0">${titulo} (${items.length})</h3>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
        <thead>
          <tr style="background:#f9fafb">
            <th style="padding:6px 8px;text-align:left;font-size:11px;color:#374151;font-weight:600">Lámina</th>
            <th style="padding:6px 8px;text-align:left;font-size:11px;color:#374151;font-weight:600">Catálogo</th>
            <th style="padding:6px 8px;text-align:left;font-size:11px;color:#374151;font-weight:600">Fecha</th>
            <th style="padding:6px 8px;text-align:left;font-size:11px;color:#374151;font-weight:600">Por</th>
          </tr>
        </thead>
        <tbody>${items.map(l => filaLamina(l, titulo)).join('')}</tbody>
      </table>
    `;

    const totalCambios = datos.laminas_nuevas.length + datos.laminas_modificadas.length + datos.laminas_eliminadas.length;
    const asunto = `[Lomhifar] Resumen catálogos · ${fmt(datos.hasta)} · ${totalCambios} cambio${totalCambios === 1 ? '' : 's'}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#333">
        <div style="background:linear-gradient(135deg,#cc007a 0%,#a3005f 100%);color:#fff;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:20px">📊 Resumen catálogos Lomhifar</h2>
          <p style="margin:6px 0 0 0;opacity:0.9;font-size:13px">
            Cambios desde ${fmt(datos.desde)} · Enviado ${fmt(datos.hasta)}
          </p>
        </div>
        <div style="background:#fff;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
          ${totalCambios === 0
            ? `<div style="padding:16px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;color:#166534;font-size:13px;text-align:center">
                 ✅ No ha habido cambios en láminas desde el último envío.
               </div>`
            : `<p style="margin:0 0 12px 0;font-size:14px">
                 Estos son los cambios en las láminas de los catálogos comerciales para que actualicéis
                 el <b>programa de gestión</b> (precios, altas, bajas, modificaciones).
               </p>
               ${seccionCambios('➕ Láminas nuevas', '#16a34a', datos.laminas_nuevas)}
               ${seccionCambios('✏️ Láminas modificadas', '#ca8a04', datos.laminas_modificadas)}
               ${seccionCambios('🗑️ Láminas eliminadas', '#dc2626', datos.laminas_eliminadas)}
              `
          }
          ${seccionMega}
          <hr style="border:none;border-top:1px solid #f3f4f6;margin:20px 0">
          <p style="font-size:11px;color:#9ca3af;margin:0">
            Envío manual desde CatalogPRO por el administrador. Los enlaces MEGA apuntan a la carpeta
            permanente de cada catálogo (dentro está la última versión).
          </p>
        </div>
      </div>
    `;

    // Enviar a cada destinatario (usa la misma infra que emails de visita)
    const fallos: string[] = [];
    for (const dest of destinatarios) {
      try {
        const r = await enviarEmailConRedireccion({
          rol: 'oficina',
          destinatarioReal: dest,
          asunto,
          html
        });
        if (!r.ok) fallos.push(dest + ': ' + (r.error || 'fallo'));
      } catch (e: any) {
        fallos.push(dest + ': ' + e.message);
      }
    }

    // Registrar el envio (para marcar el punto de corte)
    await pool.query(
      `INSERT INTO office_summary_sent
         (sent_at, cambios_desde, cambios_hasta, num_nuevas, num_modificadas, num_eliminadas, destinatarios, sent_by)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        datos.desde, datos.hasta,
        datos.laminas_nuevas.length, datos.laminas_modificadas.length, datos.laminas_eliminadas.length,
        destinatarios, req.user!.id
      ]
    );

    res.json({
      success: fallos.length === 0,
      enviados: destinatarios.length - fallos.length,
      fallos: fallos.length > 0 ? fallos : undefined,
      resumen: {
        nuevas: datos.laminas_nuevas.length,
        modificadas: datos.laminas_modificadas.length,
        eliminadas: datos.laminas_eliminadas.length
      }
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Historial de envios
app.get('/api/admin/office-summary/history', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.sent_at, s.cambios_desde, s.cambios_hasta,
             s.num_nuevas, s.num_modificadas, s.num_eliminadas,
             s.destinatarios, s.sent_by, u.name AS sent_by_name
      FROM office_summary_sent s
      LEFT JOIN users u ON u.id = s.sent_by
      ORDER BY s.sent_at DESC LIMIT 30`);
    res.json({ success: true, history: r.rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// SYNC SAGE - endpoints que reciben datos del worker de la oficina.
// Autenticacion: header X-API-Key (env var SAGE_SYNC_API_KEY).
// Formato: batches JSON con UPSERT en BD, marca inactivo los que no vienen.
// ============================================================================
function verificarSageApiKey(req: Request, res: Response): boolean {
  const expected = (process.env.SAGE_SYNC_API_KEY || '').trim();
  if (!expected) {
    res.status(500).json({ success: false, error: 'SAGE_SYNC_API_KEY no configurada en el servidor' });
    return false;
  }
  const got = String(req.headers['x-api-key'] || '').trim();
  if (!got || got !== expected) {
    res.status(401).json({ success: false, error: 'X-API-Key invalida' });
    return false;
  }
  return true;
}

// Registra un batch en el historial
async function registrarBatchSync(
  tipo: 'products' | 'clients' | 'stock',
  batchId: string | null,
  generatedAt: Date | null,
  contadores: { recibidos: number; actualizados: number; nuevos: number; sin_cambios: number; marcados_inactivos: number },
  duracionMs: number,
  error: string | null
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO sync_batches (tipo, batch_id, generated_at, num_recibidos, num_actualizados,
         num_nuevos, num_sin_cambios, num_marcados_inactivos, duracion_ms, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tipo, batchId, generatedAt,
       contadores.recibidos, contadores.actualizados, contadores.nuevos, contadores.sin_cambios,
       contadores.marcados_inactivos, duracionMs, error]
    );
  } catch (e: any) {
    console.warn('[sync-batches] insert fallo:', e.message);
  }
}

// ----- POST /api/sync/sage/products -----
app.post('/api/sync/sage/products', async (req: Request, res: Response) => {
  if (!verificarSageApiKey(req, res)) return;
  const t0 = Date.now();
  const batchId = req.body?.batch_id ? String(req.body.batch_id) : null;
  const generatedAt = req.body?.generated_at ? new Date(req.body.generated_at) : null;
  const productos = Array.isArray(req.body?.products) ? req.body.products : [];
  if (productos.length === 0) {
    res.status(400).json({ success: false, error: 'Body debe incluir products: array' });
    return;
  }
  const contadores = { recibidos: productos.length, actualizados: 0, nuevos: 0, sin_cambios: 0, marcados_inactivos: 0 };
  const codigosVistos: string[] = [];
  try {
    for (const p of productos) {
      const codigo = String(p.codigo_sage || p.codigo || '').trim();
      if (!codigo) continue;
      codigosVistos.push(codigo);
      const nombre = String(p.nombre || p.descripcion || '').trim();
      // Detectar BAJA- en la descripcion (regla de negocio del usuario)
      const esBaja = /^BAJA[-\s]/i.test(nombre);
      const obsoleto = Boolean(p.obsoleto);
      // Activo = NO obsoleto Y NO baja
      const activo = !esBaja && !obsoleto;
      // PVL (Articulos.PrecioVenta en Sage) = el precio de lamina del laboratorio, UNICO.
      // Es el que el comercial ve como "PVF". Llega en el campo precio_pvl (nuevo).
      // Si no viene, dejamos null (mostrar "—") en vez de un precio erroneo:
      // precio_venta_1/2/3 son las TARIFAS del distribuidor, NO el PVL (confirmado por Sage).
      const pvl = p.precio_pvl != null ? Number(p.precio_pvl) : null;
      const r = await pool.query(
        `INSERT INTO products (codigo, nombre, ean, tipo,
           precio_pvf_1, precio_pvf_2, precio_pvf_3,
           precio_pvpr_1, precio_pvpr_2, precio_pvpr_3,
           precio_pvp, precio_pvf, precio_compra,
           codigo_familia, codigo_proveedor, codigo_alt_1, codigo_alt_2,
           obsoleto_lc, es_baja, activo,
           stock_minimo, stock_maximo, fecha_alta_sage,
           synced_from_sage_at, updated_at)
         VALUES ($1,$2,$3,'sage',
           $4,$5,$6,$7,$8,$9,
           $8,$4,$10,
           $11,$12,$13,$14,
           $15,$16,$17,
           $18,$19,$20,
           NOW(), NOW())
         ON CONFLICT (codigo) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           ean = COALESCE(EXCLUDED.ean, products.ean),
           precio_pvf_1 = EXCLUDED.precio_pvf_1,
           precio_pvf_2 = EXCLUDED.precio_pvf_2,
           precio_pvf_3 = EXCLUDED.precio_pvf_3,
           precio_pvpr_1 = EXCLUDED.precio_pvpr_1,
           precio_pvpr_2 = EXCLUDED.precio_pvpr_2,
           precio_pvpr_3 = EXCLUDED.precio_pvpr_3,
           precio_pvp = EXCLUDED.precio_pvpr_1,
           precio_pvf = EXCLUDED.precio_pvf_1,
           precio_compra = EXCLUDED.precio_compra,
           codigo_familia = EXCLUDED.codigo_familia,
           codigo_proveedor = EXCLUDED.codigo_proveedor,
           codigo_alt_1 = EXCLUDED.codigo_alt_1,
           codigo_alt_2 = EXCLUDED.codigo_alt_2,
           obsoleto_lc = EXCLUDED.obsoleto_lc,
           es_baja = EXCLUDED.es_baja,
           activo = EXCLUDED.activo,
           stock_minimo = EXCLUDED.stock_minimo,
           stock_maximo = EXCLUDED.stock_maximo,
           fecha_alta_sage = COALESCE(EXCLUDED.fecha_alta_sage, products.fecha_alta_sage),
           synced_from_sage_at = NOW(),
           updated_at = NOW()
         RETURNING (xmax = 0) AS was_insert`,
        // precio_pvf_1/2/3 y precio_pvf ($4,$5,$6 y precio_pvf=$4 en el SQL) = PVL (unico).
        [codigo, nombre, p.codigo_alt_1 || null,
         pvl,
         pvl,
         pvl,
         p.precio_venta_iva_1 != null ? Number(p.precio_venta_iva_1) : null,
         p.precio_venta_iva_2 != null ? Number(p.precio_venta_iva_2) : null,
         p.precio_venta_iva_3 != null ? Number(p.precio_venta_iva_3) : null,
         p.precio_compra != null ? Number(p.precio_compra) : null,
         p.codigo_familia || null, p.codigo_proveedor || null,
         p.codigo_alt_1 || null, p.codigo_alt_2 || null,
         obsoleto, esBaja, activo,
         p.stock_min != null ? Number(p.stock_min) : null,
         p.stock_max != null ? Number(p.stock_max) : null,
         p.fecha_alta || null]
      );
      if (r.rows[0]?.was_insert) contadores.nuevos++;
      else contadores.actualizados++;
    }
    // Marcar inactivos los que NO vinieron (solo dentro de tipo='sage')
    if (codigosVistos.length > 0) {
      const inact = await pool.query(
        `UPDATE products SET activo = FALSE, updated_at = NOW()
         WHERE tipo = 'sage' AND activo = TRUE AND codigo <> ALL($1::text[])
         RETURNING id`,
        [codigosVistos]
      );
      contadores.marcados_inactivos = inact.rowCount || 0;
    }
    const duracion = Date.now() - t0;
    await registrarBatchSync('products', batchId, generatedAt, contadores, duracion, null);
    res.json({ success: true, ...contadores, duracion_ms: duracion });
  } catch (e: any) {
    const duracion = Date.now() - t0;
    await registrarBatchSync('products', batchId, generatedAt, contadores, duracion, e.message);
    res.status(500).json({ success: false, error: e.message, ...contadores });
  }
});

// ----- POST /api/sync/sage/clients -----
app.post('/api/sync/sage/clients', async (req: Request, res: Response) => {
  if (!verificarSageApiKey(req, res)) return;
  const t0 = Date.now();
  const batchId = req.body?.batch_id ? String(req.body.batch_id) : null;
  const generatedAt = req.body?.generated_at ? new Date(req.body.generated_at) : null;
  const clientes = Array.isArray(req.body?.clients) ? req.body.clients : [];
  const esIncremental = Boolean(req.body?.incremental);
  if (clientes.length === 0 && !esIncremental) {
    res.status(400).json({ success: false, error: 'Body debe incluir clients: array' });
    return;
  }
  const contadores = { recibidos: clientes.length, actualizados: 0, nuevos: 0, sin_cambios: 0, marcados_inactivos: 0 };
  const codigosVistos: string[] = [];
  try {
    for (const c of clientes) {
      const codigo = String(c.codigo_sage || c.codigo || '').trim();
      if (!codigo) continue;
      codigosVistos.push(codigo);
      const razonSocial = String(c.razon_social || '').trim();
      const esBaja = /^BAJA[-\s]/i.test(razonSocial);
      const bajaEmpresa = Boolean(c.baja_empresa);
      const isActive = !esBaja && !bajaEmpresa;
      const r = await pool.query(
        `INSERT INTO clients (sage_code, razon_social, nombre_comercial, cif,
           provincia, codigo_provincia, tarifa_precio,
           email, email_alternativo, fecha_alta_sage, lsys_fecha_grabacion,
           es_baja, baja_empresa_lc, is_active,
           synced_from_sage_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW(), NOW())
         ON CONFLICT (sage_code) DO UPDATE SET
           razon_social = EXCLUDED.razon_social,
           nombre_comercial = EXCLUDED.nombre_comercial,
           cif = COALESCE(EXCLUDED.cif, clients.cif),
           provincia = COALESCE(EXCLUDED.provincia, clients.provincia),
           codigo_provincia = COALESCE(EXCLUDED.codigo_provincia, clients.codigo_provincia),
           tarifa_precio = EXCLUDED.tarifa_precio,
           email = COALESCE(EXCLUDED.email, clients.email),
           email_alternativo = COALESCE(EXCLUDED.email_alternativo, clients.email_alternativo),
           fecha_alta_sage = COALESCE(EXCLUDED.fecha_alta_sage, clients.fecha_alta_sage),
           lsys_fecha_grabacion = COALESCE(EXCLUDED.lsys_fecha_grabacion, clients.lsys_fecha_grabacion),
           es_baja = EXCLUDED.es_baja,
           baja_empresa_lc = EXCLUDED.baja_empresa_lc,
           is_active = EXCLUDED.is_active,
           synced_from_sage_at = NOW(),
           updated_at = NOW()
         RETURNING (xmax = 0) AS was_insert`,
        [codigo, razonSocial, c.nombre_comercial || null, c.cif_dni || null,
         c.provincia || null, c.codigo_provincia || null,
         c.tarifa_precio != null ? Number(c.tarifa_precio) : null,
         c.email_1 || null, c.email_2 || null,
         c.fecha_alta || null,
         c.lsys_fecha_grabacion ? new Date(c.lsys_fecha_grabacion) : null,
         esBaja, bajaEmpresa, isActive]
      );
      if (r.rows[0]?.was_insert) contadores.nuevos++;
      else contadores.actualizados++;
    }
    // Solo marcar inactivos si NO es incremental (en incremental faltan muchos por diseño)
    if (!esIncremental && codigosVistos.length > 0) {
      const inact = await pool.query(
        `UPDATE clients SET is_active = FALSE, updated_at = NOW()
         WHERE sage_code IS NOT NULL AND is_active = TRUE AND sage_code <> ALL($1::text[])
         RETURNING id`,
        [codigosVistos]
      );
      contadores.marcados_inactivos = inact.rowCount || 0;
    }
    const duracion = Date.now() - t0;
    await registrarBatchSync('clients', batchId, generatedAt, contadores, duracion, null);
    res.json({ success: true, ...contadores, incremental: esIncremental, duracion_ms: duracion });
  } catch (e: any) {
    const duracion = Date.now() - t0;
    await registrarBatchSync('clients', batchId, generatedAt, contadores, duracion, e.message);
    res.status(500).json({ success: false, error: e.message, ...contadores });
  }
});

// ----- POST /api/sync/sage/stock -----
// Recibe solo los articulos con stock > 0 (~2850 filas). Los que no vengan se ponen a 0.
app.post('/api/sync/sage/stock', async (req: Request, res: Response) => {
  if (!verificarSageApiKey(req, res)) return;
  const t0 = Date.now();
  const batchId = req.body?.batch_id ? String(req.body.batch_id) : null;
  const generatedAt = req.body?.generated_at ? new Date(req.body.generated_at) : null;
  const items = Array.isArray(req.body?.stock) ? req.body.stock : [];
  const contadores = { recibidos: items.length, actualizados: 0, nuevos: 0, sin_cambios: 0, marcados_inactivos: 0 };
  const codigosVistos: string[] = [];
  try {
    for (const s of items) {
      const codigo = String(s.codigo_sage || s.codigo || '').trim();
      if (!codigo) continue;
      codigosVistos.push(codigo);
      const r = await pool.query(
        `INSERT INTO product_stock (codigo_sage, unidades, valor_almacen, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (codigo_sage) DO UPDATE SET
           unidades = EXCLUDED.unidades,
           valor_almacen = EXCLUDED.valor_almacen,
           updated_at = NOW()
         RETURNING (xmax = 0) AS was_insert`,
        [codigo, Number(s.unidades) || 0, Number(s.valor_almacen) || 0]
      );
      if (r.rows[0]?.was_insert) contadores.nuevos++;
      else contadores.actualizados++;
    }
    // Poner a 0 los que YA no vienen (dejaron de tener stock)
    const zeroR = await pool.query(
      `UPDATE product_stock SET unidades = 0, valor_almacen = 0, updated_at = NOW()
       WHERE unidades > 0 AND codigo_sage <> ALL($1::text[])
       RETURNING codigo_sage`,
      [codigosVistos]
    );
    contadores.marcados_inactivos = zeroR.rowCount || 0;
    const duracion = Date.now() - t0;
    await registrarBatchSync('stock', batchId, generatedAt, contadores, duracion, null);
    res.json({ success: true, ...contadores, puestos_a_cero: contadores.marcados_inactivos, duracion_ms: duracion });
  } catch (e: any) {
    const duracion = Date.now() - t0;
    await registrarBatchSync('stock', batchId, generatedAt, contadores, duracion, e.message);
    res.status(500).json({ success: false, error: e.message, ...contadores });
  }
});

// Endpoint para consultar stock actual de un articulo desde la app admin/comercial
app.get('/api/sync/stock/:codigo', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const codigo = String(req.params.codigo || '').trim();
    if (!codigo) { res.status(400).json({ success: false, error: 'codigo requerido' }); return; }
    const r = await pool.query(
      `SELECT codigo_sage, unidades, valor_almacen, updated_at FROM product_stock WHERE codigo_sage = $1`,
      [codigo]
    );
    if (r.rows.length === 0) {
      res.json({ success: true, stock: null, mensaje: 'sin registro (probablemente stock 0)' });
      return;
    }
    res.json({ success: true, stock: r.rows[0] });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Historial de batches de sincronizacion
app.get('/api/admin/sync-batches', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT id, tipo, batch_id, generated_at, received_at,
              num_recibidos, num_actualizados, num_nuevos, num_sin_cambios,
              num_marcados_inactivos, duracion_ms, error
       FROM sync_batches ORDER BY received_at DESC LIMIT 100`
    );
    // Ultimo por tipo para tarjetas resumen
    const ultimoR = await pool.query(
      `SELECT DISTINCT ON (tipo) tipo, received_at, num_recibidos, num_actualizados,
              num_nuevos, num_marcados_inactivos, error
       FROM sync_batches ORDER BY tipo, received_at DESC`
    );
    res.json({ success: true, batches: r.rows, ultimo_por_tipo: ultimoR.rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/mega-test', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  const cred = debugCredenciales();
  try {
    const t0 = Date.now();
    const storage = await getMegaStorage();
    const loginMs = Date.now() - t0;
    const rootHijos = (storage.root.children || []).length;
    // Buscar/crear estructura raiz de nuestro backup
    const rootCP = await ensureFolder(storage.root, ROOT_FOLDER);
    await ensureFolder(rootCP, COMERCIALES_FOLDER);
    await ensureFolder(rootCP, GENERAL_FOLDER);
    res.json({
      success: true,
      login_ms: loginMs,
      credenciales: cred,
      root_folders_en_mega: rootHijos,
      backup_root_creado: '/' + ROOT_FOLDER,
      estructura_lista: true
    });
  } catch (e: any) {
    res.status(500).json({
      success: false,
      error: e.message,
      credenciales_diagnostico: cred,
      hint: 'Verifica MEGA_EMAIL y MEGA_PASSWORD en Railway env vars'
    });
  }
});

// ============================================================================
// PRECIOS DINÁMICOS — FASE 0: config (nº tarifas) + resolución "precio de hoy" +
// gestión de cambios programados. Sin UI todavía; base para las fases siguientes.
// ============================================================================
async function numTarifasConfig(): Promise<number> {
  try {
    const r = await pool.query(`SELECT valor FROM app_config WHERE clave='num_tarifas'`);
    const n = parseInt(r.rows[0]?.valor || '1', 10);
    return (Number.isInteger(n) && n >= 1 && n <= 3) ? n : 1; // por ahora máx 3 (columnas _1/2/3)
  } catch { return 1; }
}

// Horas que dura la sesion antes de volver a pedir la contrasena. Lo fija el admin.
// Rango 1..720 (30 dias): por debajo de 1h es inusable y por encima de un mes deja
// de tener sentido como medida de seguridad.
async function sesionHorasConfig(): Promise<number> {
  try {
    const r = await pool.query(`SELECT valor FROM app_config WHERE clave='sesion_horas'`);
    const n = parseInt(r.rows[0]?.valor || '168', 10);
    return (Number.isInteger(n) && n >= 1 && n <= 720) ? n : 168;
  } catch { return 168; }
}

// INTERRUPTOR MAESTRO de precios dinámicos. Si se apaga, las láminas se ven y se
// exportan TAL CUAL (como siempre): no se reescribe ningún precio ni se pinta la capa
// en vivo. Los recuadros NO se borran: siguen ahí para cuando se vuelva a encender.
// Por defecto ENCENDIDO (no cambia el comportamiento actual).
async function preciosDinamicosActivo(): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT valor FROM app_config WHERE clave='precios_dinamicos_activo'`);
    return (r.rows[0]?.valor ?? '1') !== '0';
  } catch { return true; }
}

// Fuentes instaladas en el servidor válidas para reescribir precios (deben existir en el
// build: ver nixpacks fonts-liberation). Liberation Sans = métricas de Arial.
const FUENTES_SERVIDOR = ['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'DejaVu Sans', 'DejaVu Serif'];
// Config de render de precios reescritos: fuente (config una vez) + factor de tamaño fino.
async function configPreciosRender(): Promise<{ fuente: string; tamFactor: number }> {
  try {
    const r = await pool.query(`SELECT clave, valor FROM app_config WHERE clave IN ('precio_fuente','precio_tam_factor')`);
    const m: any = {}; r.rows.forEach((x: any) => { m[x.clave] = x.valor; });
    const fuente = FUENTES_SERVIDOR.includes(m.precio_fuente) ? m.precio_fuente : 'Liberation Sans';
    const tf = parseFloat(m.precio_tam_factor || '1');
    const tamFactor = (Number.isFinite(tf) && tf >= 0.5 && tf <= 2) ? tf : 1;
    return { fuente, tamFactor };
  } catch { return { fuente: 'Liberation Sans', tamFactor: 1 }; }
}

// Precio VIGENTE HOY de un producto para una tarifa: primero un cambio programado con
// fecha <= hoy (el más reciente); si no hay, el precio base de products (columna _N).
async function precioVigenteHoy(productId: number, tarifa: number): Promise<{ pvf: number | null; pvpr: number | null; fuente: string; fecha: string | null }> {
  const prog = await pool.query(
    `SELECT pvf, pvpr, fecha_vigencia FROM precio_programado
      WHERE product_id=$1 AND tarifa=$2 AND fecha_vigencia <= CURRENT_DATE
      ORDER BY fecha_vigencia DESC, id DESC LIMIT 1`, [productId, tarifa]);
  if (prog.rows.length) {
    return { pvf: prog.rows[0].pvf, pvpr: prog.rows[0].pvpr, fuente: 'programado', fecha: prog.rows[0].fecha_vigencia };
  }
  const col = (tarifa >= 1 && tarifa <= 3) ? tarifa : 1;
  // Fallback legacy: precio_pvf (farmacia) y precio_pvp (público). OJO: NO existe columna
  // 'precio_pvpr' sin sufijo; la pública histórica es precio_pvp.
  const base = await pool.query(
    `SELECT precio_pvf_${col} AS pvf, precio_pvpr_${col} AS pvpr, precio_pvf AS pvf_legacy, precio_pvp AS pvpr_legacy FROM products WHERE id=$1`, [productId]);
  if (!base.rows.length) return { pvf: null, pvpr: null, fuente: 'no-existe', fecha: null };
  const b = base.rows[0];
  return { pvf: b.pvf ?? b.pvf_legacy ?? null, pvpr: b.pvpr ?? b.pvpr_legacy ?? null, fuente: 'base', fecha: null };
}

// GET config global (num_tarifas)
app.get('/api/config', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`SELECT clave, valor FROM app_config`);
    const cfg: any = {}; r.rows.forEach((x: any) => { cfg[x.clave] = x.valor; });
    res.json({
      success: true, config: cfg,
      num_tarifas: await numTarifasConfig(),
      precios_dinamicos_activo: await preciosDinamicosActivo()
    });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// PUT config (admin real) — por ahora num_tarifas (1..3)
app.put('/api/config', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    if (req.body.num_tarifas !== undefined) {
      const n = parseInt(String(req.body.num_tarifas), 10);
      if (!Number.isInteger(n) || n < 1 || n > 3) { res.status(400).json({ success: false, error: 'num_tarifas debe ser 1..3 por ahora' }); return; }
      await pool.query(`INSERT INTO app_config (clave, valor, updated_at) VALUES ('num_tarifas',$1,NOW())
        ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`, [String(n)]);
    }
    // A partir de cuántos días se considera "atascado" y se recuerda a administración.
    if (req.body.coordinacion_dias_aviso !== undefined) {
      const d = parseInt(String(req.body.coordinacion_dias_aviso), 10);
      if (!Number.isInteger(d) || d < 1 || d > 90) { res.status(400).json({ success: false, error: 'Los días deben estar entre 1 y 90' }); return; }
      await pool.query(`INSERT INTO app_config (clave, valor, updated_at) VALUES ('coordinacion_dias_aviso',$1,NOW())
        ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`, [String(d)]);
    }
    // Duración de la sesión (horas). Solo afecta a los inicios de sesión NUEVOS:
    // los tokens ya repartidos conservan la caducidad con la que se firmaron.
    if (req.body.sesion_horas !== undefined) {
      const h = parseInt(String(req.body.sesion_horas), 10);
      if (!Number.isInteger(h) || h < 1 || h > 720) { res.status(400).json({ success: false, error: 'sesion_horas debe ser 1..720 (máx. 30 días)' }); return; }
      await pool.query(`INSERT INTO app_config (clave, valor, updated_at) VALUES ('sesion_horas',$1,NOW())
        ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`, [String(h)]);
    }
    // Interruptor maestro de precios dinámicos (volver a la lámina original al instante).
    if (req.body.precios_dinamicos_activo !== undefined) {
      const v = (req.body.precios_dinamicos_activo === false || req.body.precios_dinamicos_activo === '0' || req.body.precios_dinamicos_activo === 0) ? '0' : '1';
      await pool.query(`INSERT INTO app_config (clave, valor, updated_at) VALUES ('precios_dinamicos_activo',$1,NOW())
        ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`, [v]);
    }
    // F5 remate: fuente para reescribir precios (config una vez) + factor de tamaño.
    if (req.body.precio_fuente !== undefined) {
      const f = FUENTES_SERVIDOR.includes(String(req.body.precio_fuente)) ? String(req.body.precio_fuente) : 'Liberation Sans';
      await pool.query(`INSERT INTO app_config (clave, valor, updated_at) VALUES ('precio_fuente',$1,NOW())
        ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`, [f]);
    }
    if (req.body.precio_tam_factor !== undefined) {
      const tf = parseFloat(String(req.body.precio_tam_factor));
      if (!Number.isFinite(tf) || tf < 0.5 || tf > 2) { res.status(400).json({ success: false, error: 'precio_tam_factor debe ser 0.5..2' }); return; }
      await pool.query(`INSERT INTO app_config (clave, valor, updated_at) VALUES ('precio_tam_factor',$1,NOW())
        ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`, [String(tf)]);
    }
    res.json({ success: true, num_tarifas: await numTarifasConfig(), ...(await configPreciosRender()) });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

// GET precio vigente hoy de un producto (+ si hay un cambio pendiente futuro)
app.get('/api/precios/vigente', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const productId = Number(req.query.product_id);
    const tarifa = Number(req.query.tarifa) || 1;
    if (!Number.isInteger(productId) || productId <= 0) { res.status(400).json({ success: false, error: 'product_id inválido' }); return; }
    const hoy = await precioVigenteHoy(productId, tarifa);
    const pend = await pool.query(
      `SELECT pvf, pvpr, fecha_vigencia FROM precio_programado
        WHERE product_id=$1 AND tarifa=$2 AND fecha_vigencia > CURRENT_DATE
        ORDER BY fecha_vigencia ASC, id ASC LIMIT 1`, [productId, tarifa]);
    res.json({ success: true, tarifa, hoy, pendiente: pend.rows[0] || null });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// POST precios vigentes HOY de VARIOS productos de una vez (para pintar la lámina).
// Body: { product_ids:[...], tarifa? }. Devuelve mapa product_id -> {pvf,pvpr,fuente,pendiente}.
app.post('/api/precios/vigentes', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const rawIds: number[] = Array.isArray(req.body.product_ids)
      ? req.body.product_ids.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)
      : [];
    const ids: number[] = Array.from(new Set<number>(rawIds)).slice(0, 300);
    const tarifa = Number(req.body.tarifa) || 1;
    const precios: any = {};
    if (!ids.length) { res.json({ success: true, precios }); return; }
    // Cambios programados YA vigentes (uno por producto, el más reciente)
    const prog = await pool.query(
      `SELECT DISTINCT ON (product_id) product_id, pvf, pvpr, fecha_vigencia
         FROM precio_programado
        WHERE product_id = ANY($1::int[]) AND tarifa=$2 AND fecha_vigencia <= CURRENT_DATE
        ORDER BY product_id, fecha_vigencia DESC, id DESC`, [ids, tarifa]);
    const progMap: any = {}; prog.rows.forEach((r: any) => { progMap[r.product_id] = r; });
    // Precio base de products
    const col = (tarifa >= 1 && tarifa <= 3) ? tarifa : 1;
    const base = await pool.query(
      `SELECT id, precio_pvf_${col} AS pvf, precio_pvpr_${col} AS pvpr, precio_pvf AS pvf_l, precio_pvp AS pvpr_l
         FROM products WHERE id = ANY($1::int[])`, [ids]);
    const baseMap: any = {}; base.rows.forEach((r: any) => { baseMap[r.id] = r; });
    // Cambios PENDIENTES (futuro) — uno por producto, el más próximo
    const pend = await pool.query(
      `SELECT DISTINCT ON (product_id) product_id, pvf, pvpr, fecha_vigencia
         FROM precio_programado
        WHERE product_id = ANY($1::int[]) AND tarifa=$2 AND fecha_vigencia > CURRENT_DATE
        ORDER BY product_id, fecha_vigencia ASC, id ASC`, [ids, tarifa]);
    const pendMap: any = {}; pend.rows.forEach((r: any) => { pendMap[r.product_id] = r; });
    for (const id of ids) {
      const p = progMap[id]; const b = baseMap[id];
      let pvf: any = null, pvpr: any = null, fuente = 'no-existe';
      if (p) { pvf = p.pvf; pvpr = p.pvpr; fuente = 'programado'; }
      else if (b) { pvf = b.pvf ?? b.pvf_l ?? null; pvpr = b.pvpr ?? b.pvpr_l ?? null; fuente = 'base'; }
      precios[id] = { pvf, pvpr, fuente, pendiente: pendMap[id] ? { pvf: pendMap[id].pvf, pvpr: pendMap[id].pvpr, fecha: pendMap[id].fecha_vigencia } : null };
    }
    res.json({ success: true, precios });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// GET lista de cambios programados (admin real)
app.get('/api/precios/programados', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const cond: string[] = []; const vals: any[] = []; let i = 1;
    if (req.query.lote) { cond.push(`pp.lote=$${i++}`); vals.push(String(req.query.lote)); }
    if (req.query.product_id) { cond.push(`pp.product_id=$${i++}`); vals.push(Number(req.query.product_id)); }
    if (req.query.pendientes === 'true') cond.push(`pp.fecha_vigencia > CURRENT_DATE`);
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(
      `SELECT pp.*, p.codigo, p.nombre FROM precio_programado pp JOIN products p ON p.id=pp.product_id
       ${where} ORDER BY pp.fecha_vigencia DESC, pp.id DESC LIMIT 500`, vals);
    res.json({ success: true, programados: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// POST programar cambio(s) de precio (admin real). Body: {fecha_vigencia, grupo?, lote?, items:[{product_id,tarifa,pvf,pvpr}]} o un item suelto.
app.post('/api/precios/programar', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
    const fechaBase = String(req.body.fecha_vigencia || (items[0] && items[0].fecha_vigencia) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaBase)) { res.status(400).json({ success: false, error: 'fecha_vigencia (YYYY-MM-DD) obligatoria' }); return; }
    const grupo = req.body.grupo ? String(req.body.grupo).slice(0, 80) : null;
    const lote = req.body.lote ? String(req.body.lote).slice(0, 80) : null;
    const uid = req.user?.id || null;
    const creados: number[] = [];
    for (const it of items) {
      const pid = Number(it.product_id); const tarifa = Number(it.tarifa) || 1;
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const pvf = (it.pvf != null && it.pvf !== '') ? Number(it.pvf) : null;
      const pvpr = (it.pvpr != null && it.pvpr !== '') ? Number(it.pvpr) : null;
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(it.fecha_vigencia || '').slice(0, 10)) ? String(it.fecha_vigencia).slice(0, 10) : fechaBase;
      const r = await pool.query(
        `INSERT INTO precio_programado (product_id, tarifa, pvf, pvpr, fecha_vigencia, grupo, lote, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [pid, tarifa, pvf, pvpr, fecha, grupo, lote, uid]);
      creados.push(r.rows[0].id);
    }
    res.status(201).json({ success: true, creados });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

// DELETE un cambio programado (admin real)
app.delete('/api/precios/programado/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`DELETE FROM precio_programado WHERE id=$1 RETURNING id`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrado' }); return; }
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

// ============================================================================
// F3 RECUADROS DE PRECIO (tapar y reescribir) — CRUD + muestreo + deteccion IA
// ============================================================================

// GET recuadros de una lamina (los ve el visor comercial y el editor admin).
app.get('/api/sheets/:sheetId/recuadros', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.sheetId);
    const r = await pool.query(
      `SELECT r.*, p.codigo AS producto_codigo, p.nombre AS producto_nombre
         FROM lamina_recuadro r LEFT JOIN products p ON p.id = r.product_id
        WHERE r.sheet_id = $1 ORDER BY r.id`, [sheetId]);
    res.json({ success: true, recuadros: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Campos editables de un recuadro (whitelist) — helper compartido create/update.
function _recuadroCampos(body: any): { cols: string[]; vals: any[] } {
  const cols: string[] = []; const vals: any[] = [];
  const num = (v: any) => (v == null || v === '') ? null : Number(v);
  const push = (c: string, v: any) => { if (v !== undefined) { cols.push(c); vals.push(v); } };
  push('zone_id', body.zone_id === undefined ? undefined : (body.zone_id ? Number(body.zone_id) : null));
  push('product_id', body.product_id === undefined ? undefined : (body.product_id ? Number(body.product_id) : null));
  if (body.campo !== undefined) push('campo', ['pvf', 'pvpr', 'oferta'].includes(String(body.campo)) ? String(body.campo) : 'pvf');
  ['x', 'y', 'ancho', 'alto', 'tam_rel'].forEach(k => { if (body[k] !== undefined) push(k, num(body[k])); });
  if (body.color_fondo !== undefined) push('color_fondo', String(body.color_fondo).slice(0, 24));
  if (body.color_texto !== undefined) push('color_texto', String(body.color_texto).slice(0, 24));
  if (body.alinear !== undefined) push('alinear', ['left', 'center', 'right'].includes(String(body.alinear)) ? String(body.alinear) : 'left');
  if (body.fuente !== undefined) push('fuente', body.fuente ? String(body.fuente).slice(0, 80) : null);
  if (body.negrita !== undefined) push('negrita', !!body.negrita);
  if (body.prefijo !== undefined) push('prefijo', String(body.prefijo).slice(0, 24));
  if (body.sufijo !== undefined) push('sufijo', String(body.sufijo).slice(0, 8));
  if (body.decimales !== undefined) push('decimales', Math.max(0, Math.min(3, parseInt(String(body.decimales), 10) || 2)));
  if (body.sep_decimal !== undefined) push('sep_decimal', body.sep_decimal === '.' ? '.' : ',');
  if (body.activo !== undefined) push('activo', !!body.activo);
  if (body.revisar !== undefined) push('revisar', !!body.revisar);
  return { cols, vals };
}

// POST crear recuadro (admin real).
app.post('/api/sheets/:sheetId/recuadros', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.sheetId);
    const b = req.body || {};
    if ([b.x, b.y, b.ancho, b.alto].some((v: any) => typeof Number(v) !== 'number' || !Number.isFinite(Number(v)))) {
      res.status(400).json({ success: false, error: 'x/y/ancho/alto obligatorios (%)' }); return;
    }
    const { cols, vals } = _recuadroCampos({ ...b, origen: undefined });
    const allCols = ['sheet_id', 'origen', ...cols];
    const allVals = [sheetId, b.origen === 'ia' ? 'ia' : 'manual', ...vals];
    const ph = allVals.map((_, i) => '$' + (i + 1)).join(',');
    const r = await pool.query(
      `INSERT INTO lamina_recuadro (${allCols.join(',')}) VALUES (${ph}) RETURNING *`, allVals);
    logSheetChangeAgrupado('updated_precios', sheetId, { id: req.user?.id, name: req.user?.name }, 'cuadro de precio añadido');
    res.json({ success: true, recuadro: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// PUT actualizar recuadro (admin real).
app.put('/api/recuadros/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { cols, vals } = _recuadroCampos(req.body || {});
    if (!cols.length) { res.status(400).json({ success: false, error: 'nada que actualizar' }); return; }
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    sets.push('updated_at = NOW()');
    vals.push(id);
    const r = await pool.query(
      `UPDATE lamina_recuadro SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrado' }); return; }
    logSheetChangeAgrupado('updated_precios', r.rows[0].sheet_id, { id: req.user?.id, name: req.user?.name }, 'cuadro de precio editado');
    res.json({ success: true, recuadro: r.rows[0] });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

// DELETE TODOS los recuadros de una lamina de golpe (admin real). Mismo patron que el
// borrado masivo de zonas: si la deteccion IA no convence, se limpia y se empieza de cero
// sin ir uno por uno. ?solo_ia=true borra solo los de la IA y respeta los hechos a mano.
app.delete('/api/sheets/:id/recuadros', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.id);
    const soloIA = String(req.query.solo_ia || '') === 'true';
    const r = soloIA
      ? await pool.query(`DELETE FROM lamina_recuadro WHERE sheet_id=$1 AND origen='ia'`, [sheetId])
      : await pool.query(`DELETE FROM lamina_recuadro WHERE sheet_id=$1`, [sheetId]);
    if (r.rowCount) logSheetChangeAgrupado('updated_precios', sheetId, { id: req.user?.id, name: req.user?.name }, 'borrados los cuadros de precio (' + r.rowCount + ')');
    res.json({ success: true, borrados: r.rowCount || 0 });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// INFORME de precios dinamicos de un catalogo: clasifica cada lamina para saber cuales
// hay que revisar/actualizar a mano (no se actualizaron solas, precios anomalos, sin precio).
app.get('/api/catalogs/:id/informe-precios', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catId = Number(req.params.id);
    const sheets = (await pool.query(
      `SELECT id, orden, titulo, precios_excluida FROM sheets
        WHERE catalog_id=$1 AND (oculta IS NULL OR oculta=FALSE) ORDER BY orden, id`, [catId])).rows;
    if (!sheets.length) { res.json({ success: true, informe: { pendientes: [], anomalas: [], comision: [], excluidas: [], ok: 0, total: 0 } }); return; }
    const ids = sheets.map((s: any) => s.id);
    // Zonas por lamina: precificables (producto/familia) vs comision/sueltas.
    const zAgg = (await pool.query(
      `SELECT sheet_id,
              COUNT(*) FILTER (WHERE product_id IS NOT NULL OR familia_ref IS NOT NULL OR familia_skus IS NOT NULL)::int AS precif,
              COUNT(*) FILTER (WHERE es_comision=TRUE OR permite_sueltas=TRUE)::int AS comis,
              COUNT(*)::int AS total
         FROM sheet_zones WHERE sheet_id = ANY($1::int[]) GROUP BY sheet_id`, [ids])).rows;
    const zBy: any = {}; zAgg.forEach((r: any) => { zBy[r.sheet_id] = r; });
    // Recuadros por lamina: activos, pendientes de revisar y sus notas (anomalias).
    const rAgg = (await pool.query(
      `SELECT r.sheet_id,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE r.revisar=TRUE)::int AS pend,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT CASE WHEN r.revisar=TRUE AND r.nota IS NOT NULL THEN
                COALESCE(p.codigo,'') || ': ' || r.nota END), NULL) AS notas
         FROM lamina_recuadro r LEFT JOIN products p ON p.id=r.product_id
        WHERE r.sheet_id = ANY($1::int[]) AND r.activo=TRUE GROUP BY r.sheet_id`, [ids])).rows;
    const rBy: any = {}; rAgg.forEach((r: any) => { rBy[r.sheet_id] = r; });
    // Láminas con tabla de expositor asociada.
    const tAgg = (await pool.query(`SELECT sheet_id, COUNT(*)::int AS n FROM lamina_tabla WHERE sheet_id = ANY($1::int[]) AND activo=TRUE AND deleted_at IS NULL GROUP BY sheet_id`, [ids])).rows;
    const tBy: any = {}; tAgg.forEach((r: any) => { tBy[r.sheet_id] = r.n; });

    const pendientes: any[] = [], anomalas: any[] = [], comision: any[] = [], excluidas: any[] = [], tablas: any[] = [];
    let ok = 0;
    sheets.forEach((s: any, i: number) => {
      const z = zBy[s.id] || { precif: 0, comis: 0, total: 0 };
      const r = rBy[s.id] || { n: 0, pend: 0, notas: [] };
      const num = s.orden != null ? s.orden : (i + 1);
      const item = { sheet_id: s.id, numero: num, titulo: s.titulo || 'Sin título' };
      if (tBy[s.id] > 0) { tablas.push(item); return; }                    // tabla de expositor: al día por sí sola
      if (s.precios_excluida) { excluidas.push(item); return; }
      if (z.precif === 0) { if (z.comis > 0) comision.push(item); return; } // comision/sueltas o sin productos
      if (r.n === 0) { pendientes.push(item); return; }                    // tiene productos pero 0 precios
      if (r.pend > 0) { anomalas.push({ ...item, pendientes: r.pend, total: r.n, notas: r.notas || [] }); return; }
      ok++;
    });
    res.json({ success: true, informe: { pendientes, anomalas, comision, excluidas, tablas, ok, total: sheets.length } });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Excluir / incluir una lamina de los precios dinamicos (para expositores complejos que
// se prefiere rehacer a mano). Excluida -> se ve y exporta TAL CUAL.
app.put('/api/sheets/:id/precios-modo', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const excluida = (req.body?.excluida === true || req.body?.excluida === 'true' || req.body?.excluida === 1 || req.body?.excluida === '1');
    const r = await pool.query(`UPDATE sheets SET precios_excluida=$1, updated_at=NOW() WHERE id=$2 RETURNING precios_excluida`, [excluida, Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'Lamina no encontrada' }); return; }
    res.json({ success: true, precios_excluida: r.rows[0].precios_excluida });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// DELETE recuadro (admin real).
app.delete('/api/recuadros/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`DELETE FROM lamina_recuadro WHERE id=$1 RETURNING id, sheet_id`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrado' }); return; }
    logSheetChangeAgrupado('updated_precios', r.rows[0].sheet_id, { id: req.user?.id, name: req.user?.name }, 'cuadro de precio borrado');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

// POST muestrear: dada una caja aproximada (%), afina caja + colores + tamano de fuente
// leyendo el PNG real. No guarda nada; solo devuelve la sugerencia para el editor.
app.post('/api/sheets/:sheetId/recuadros/muestrear', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.sheetId);
    const s = await pool.query('SELECT imagen_path FROM sheets WHERE id=$1', [sheetId]);
    if (!s.rows.length) { res.status(404).json({ success: false, error: 'Lamina no encontrada' }); return; }
    const abs = resolverRutaImagen(s.rows[0].imagen_path, UPLOADS_DIR);
    if (!abs || !fs.existsSync(abs)) { res.status(400).json({ success: false, error: 'Imagen no existe en disco' }); return; }
    const b = req.body || {};
    const caja = { x: Number(b.x), y: Number(b.y), ancho: Number(b.ancho), alto: Number(b.alto) };
    if ([caja.x, caja.y, caja.ancho, caja.alto].some(v => !Number.isFinite(v))) { res.status(400).json({ success: false, error: 'caja invalida' }); return; }
    // modo 'manual': la caja dibujada por el usuario manda (solo se ajusta a la tinta).
    const ref = await refinarRecuadroPrecio(abs, caja, undefined, 'manual');
    if (!ref) { res.status(422).json({ success: false, error: 'No se detecto texto en esa zona (ajusta la caja sobre el numero)' }); return; }
    res.json({ success: true, sugerencia: ref });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// POST detectar precios con IA: localiza cada numero de precio, lo afina con sharp,
// lo casa con un producto de la lamina y crea los recuadros (origen=ia) para revisar.
app.post('/api/sheets/:sheetId/detect-precios-ia', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.sheetId);
    const s = await pool.query('SELECT imagen_path FROM sheets WHERE id=$1', [sheetId]);
    if (!s.rows.length) { res.status(404).json({ success: false, error: 'Lamina no encontrada' }); return; }
    const abs = resolverRutaImagen(s.rows[0].imagen_path, UPLOADS_DIR);
    if (!abs || !fs.existsSync(abs)) { res.status(400).json({ success: false, error: 'Imagen no existe en disco' }); return; }

    // Zonas de producto YA verificadas (product_id correcto y aprobado a mano) + precios BD.
    // ANCLAMOS TODO A ELLAS: el precio se busca DENTRO de su zona -> el product_id sale de
    // la zona (garantia), nunca de un CN que la IA pudiera leer mal.
    const zr = await pool.query(
      `SELECT z.id AS zone_id, z.product_id, z.x, z.y, z.ancho, z.alto,
              p.codigo AS producto_codigo,
              COALESCE(p.precio_pvf_1, p.precio_pvf)  AS bd_pvf,
              COALESCE(p.precio_pvpr_1, p.precio_pvp) AS bd_pvpr
         FROM sheet_zones z JOIN products p ON p.id = z.product_id
        WHERE z.sheet_id = $1 AND z.product_id IS NOT NULL`, [sheetId]);
    const zonas = zr.rows;
    const soloDig = (s: any) => String(s || '').replace(/\D/g, '');

    const detec = await detectarPreciosIA(abs);
    if (detec === null) { res.status(500).json({ success: false, error: 'La IA no respondio: ' + (ultimoErrorIA() || '') }); return; }

    // Separador decimal de la lamina por MAYORIA de lo que leyo la IA (consistencia).
    const nComa = detec.filter(d => d.sep_decimal === ',').length;
    const sepLamina = nComa > detec.length / 2 ? ',' : '.';

    // Asignar cada precio a su zona con robustez de REJILLA: misma COLUMNA (el centro-x del
    // precio cae en el rango-x de la zona) + zona verticalmente MAS CERCANA. Asi no cruza de
    // columna aunque la IA desvie un poco las coordenadas, y captura el precio aunque quede
    // justo bajo el recuadro. Sin columna que encaje o demasiado lejos -> se DESCARTA.
    const porZona = new Map<number, any[]>();
    let descartados_fuera = 0;
    const gapV = (z: any, cyp: number) => (cyp >= z.y && cyp <= z.y + z.alto) ? 0 : Math.min(Math.abs(cyp - z.y), Math.abs(cyp - (z.y + z.alto)));
    for (const d of detec) {
      const cxp = d.box.x + d.box.width / 2, cyp = d.box.y + d.box.height / 2;
      // 1) columna: zonas cuyo intervalo x contiene el centro-x del precio
      let cand = zonas.filter((z: any) => cxp >= z.x && cxp <= z.x + z.ancho);
      // 2) si ninguna columna encaja, permitir un pequeño margen lateral (2%)
      if (!cand.length) cand = zonas.filter((z: any) => cxp >= z.x - 2 && cxp <= z.x + z.ancho + 2);
      if (!cand.length) { descartados_fuera++; continue; }
      // zona de esa columna con menor distancia vertical
      let best: any = null, bestG = 1e9;
      for (const z of cand) { const g = gapV(z, cyp); if (g < bestG) { bestG = g; best = z; } }
      // demasiado lejos verticalmente (no es su precio) -> descartar. Tope = alto de la zona + 3%.
      if (!best || bestG > best.alto + 3) { descartados_fuera++; continue; }
      if (!porZona.has(best.zone_id)) porZona.set(best.zone_id, []);
      porZona.get(best.zone_id)!.push(d);
    }

    // Borra los recuadros IA previos de esta lamina (respeta los manuales)
    await pool.query(`DELETE FROM lamina_recuadro WHERE sheet_id=$1 AND origen='ia'`, [sheetId]);

    let creados = 0, con_revisar = 0; const detalle: any[] = [];
    for (const z of zonas) {
      const dets = porZona.get(z.zone_id) || [];
      if (!dets.length) continue;
      // Refinar cada precio de esta zona, RECORTANDO a la zona (+margen para el precio que
      // cae justo bajo el recuadro). El margen es pequeño: no llega a la fila vecina (~28%).
      const clip = { x: z.x - 1, y: z.y - 1, ancho: z.ancho + 2, alto: z.alto + 5 };
      const refs: any[] = [];
      for (const d of dets) {
        const ref = await refinarRecuadroPrecio(abs, { x: d.box.x, y: d.box.y, ancho: d.box.width, alto: d.box.height }, clip);
        if (ref) refs.push({ ref, valorIA: (typeof d.valor === 'number' ? d.valor : null), tipoIA: d.tipo, cnIA: soloDig(d.codigo_nacional) });
      }
      if (!refs.length) continue;
      // Nos quedamos como mucho con 2 (P.V.L. y P.V.P.R.): los 2 de mayor tam_rel (los precios
      // principales; descarta restos pequeños dentro de la zona).
      refs.sort((a, b) => b.ref.tam_rel - a.ref.tam_rel);
      const usar = refs.slice(0, 2);

      // CRUCE de señales para asignar pvf/pvpr y medir confianza.
      const cnMismatch = usar.some(u => u.cnIA && u.cnIA.length >= 5 && soloDig(z.producto_codigo) &&
        !(u.cnIA === soloDig(z.producto_codigo) || u.cnIA.slice(0, 6) === soloDig(z.producto_codigo).slice(0, 6)));

      let asign: { u: any; campo: string; conf: number; nota: string[]; revisar: boolean }[] = [];
      if (usar.length >= 2) {
        // Orden VERTICAL (arriba = pvf) y orden de VALOR (menor = pvf, invariante: PVL<PVPR).
        const porY = [...usar].sort((a, b) => a.ref.y - b.ref.y);
        const conValor = usar.every(u => u.valorIA != null);
        const porVal = [...usar].sort((a, b) => (a.valorIA ?? 0) - (b.valorIA ?? 0));
        // pvf = el de arriba; comprobamos si coincide con el de menor valor y con la etiqueta IA.
        const pvfBox = porY[0], pvprBox = porY[1];
        const valorOK = !conValor || (porVal[0] === pvfBox && porVal[1] === pvprBox);
        for (const [box, campo] of [[pvfBox, 'pvf'], [pvprBox, 'pvpr']] as [any, string][]) {
          const nota: string[] = []; let conf = 100;
          if (!valorOK) { conf -= 45; nota.push('orden vertical/valor no coincide'); }
          const tipoEsperado = campo === 'pvpr' ? 'pvpr' : 'pvl';
          if (box.tipoIA && box.tipoIA !== tipoEsperado && box.tipoIA !== (campo === 'pvf' ? 'pvl' : 'pvpr')) { conf -= 15; nota.push('etiqueta IA distinta'); }
          asign.push({ u: box, campo, conf, nota, revisar: false });
        }
      } else {
        const u = usar[0];
        // 1 solo precio: decidir campo por la etiqueta IA; si no, por cercania de valor a BD.
        let campo = u.tipoIA === 'pvpr' ? 'pvpr' : 'pvf';
        const nota: string[] = []; let conf = 85;
        if (u.valorIA != null && z.bd_pvf != null && z.bd_pvpr != null) {
          const dF = Math.abs(u.valorIA - Number(z.bd_pvf)), dP = Math.abs(u.valorIA - Number(z.bd_pvpr));
          const campoValor = dF <= dP ? 'pvf' : 'pvpr';
          if (campoValor !== campo) { conf -= 20; nota.push('etiqueta y valor no coinciden'); campo = campoValor; }
        }
        nota.push('solo se detecto 1 de los 2 precios');
        asign.push({ u, campo, conf, nota, revisar: false });
      }

      // Cruces finales por caja: CN, valor impreso vs BD, y coherencia de datos BD.
      for (const a of asign) {
        const bd = a.campo === 'pvpr' ? (z.bd_pvpr != null ? Number(z.bd_pvpr) : null) : (z.bd_pvf != null ? Number(z.bd_pvf) : null);
        if (cnMismatch) { a.conf -= 20; a.nota.push('CN leido ≠ codigo del producto'); }
        if (a.u.valorIA != null && bd != null && bd > 0) {
          const r = a.u.valorIA / bd;
          if (r < 0.5 || r > 2) { a.conf -= 20; a.nota.push('valor impreso (' + a.u.valorIA + ') lejos del BD (' + bd + ')'); }
        }
        // Dato BD dudoso: PVPR deberia ser > PVF (IVA). Si no, avisar para validar el dato.
        if (a.campo === 'pvpr' && z.bd_pvf != null && z.bd_pvpr != null && Number(z.bd_pvpr) <= Number(z.bd_pvf) * 1.03) {
          a.conf -= 15; a.nota.push('BD: PVPR≈PVF (dato dudoso)');
        }
        if (bd == null) { a.conf -= 15; a.nota.push('sin precio en BD'); }
        a.revisar = a.conf < 75;
      }

      for (const a of asign) {
        const ref = a.u.ref;
        const ins = await pool.query(
          `INSERT INTO lamina_recuadro
            (sheet_id, zone_id, product_id, campo, x, y, ancho, alto, color_fondo, color_texto, tam_rel, alinear, sep_decimal, origen, confianza, revisar, nota, valor_impreso)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ia',$14,$15,$16,$17) RETURNING id`,
          [sheetId, z.zone_id, z.product_id, a.campo,
           ref.x, ref.y, ref.ancho, ref.alto, ref.color_fondo, ref.color_texto, ref.tam_rel, ref.alinear, sepLamina,
           Math.max(0, a.conf), a.revisar, a.nota.join('; ').slice(0, 200) || null, a.u.valorIA]);
        creados++; if (a.revisar) con_revisar++;
        detalle.push({ product_id: z.product_id, codigo: z.producto_codigo, campo: a.campo, confianza: Math.max(0, a.conf), revisar: a.revisar, nota: a.nota.join('; '), recuadro_id: ins.rows[0].id });
      }
    }
    res.json({ success: true, creados, con_revisar, total_detectados: detec.length, descartados_fuera, zonas_producto: zonas.length, detalle });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// ============================================================================
// F4 OFERTAS / CAMPANAS (ventana inicio-fin) — CRUD + resolucion vigente
// ============================================================================

// Etiqueta a mostrar en el visor segun el tipo de oferta.
function labelOferta(o: any): string {
  if (o.texto) return String(o.texto);
  if (o.tipo === 'descuento' && o.valor != null) {
    const v = Number(o.valor);
    return '-' + (Number.isInteger(v) ? v : v.toFixed(2).replace('.', ',')) + '%';
  }
  if (o.tipo === 'bonificacion') return 'Bonificación';
  return 'Oferta';
}

// Especificidad del ambito (producto manda sobre familia/marca/todos en conflicto).
function especificidad(ambito: string): number {
  return ambito === 'producto' ? 3 : ambito === 'familia' ? 2 : ambito === 'marca' ? 1 : 0;
}

// Resuelve la oferta VIGENTE hoy para varios productos. Devuelve mapa product_id -> oferta.
async function ofertasVigentesLote(productIds: number[]): Promise<Record<number, any>> {
  const out: Record<number, any> = {};
  if (!productIds.length) return out;
  // Datos de los productos (familia/marca) para casar ofertas de grupo.
  const pr = await pool.query(`SELECT id, familia, marca FROM products WHERE id = ANY($1::int[])`, [productIds]);
  const prod: Record<number, any> = {}; pr.rows.forEach((p: any) => { prod[p.id] = p; });
  const marcas = Array.from(new Set(pr.rows.map((p: any) => p.marca).filter(Boolean)));
  const familias = Array.from(new Set(pr.rows.map((p: any) => p.familia).filter(Boolean)));
  // Ofertas activas y vigentes HOY que puedan aplicar a este conjunto.
  const ofs = await pool.query(
    `SELECT * FROM oferta
      WHERE activo = TRUE AND fecha_inicio <= CURRENT_DATE AND fecha_fin >= CURRENT_DATE
        AND (
          ambito = 'todos'
          OR (ambito = 'producto' AND product_id = ANY($1::int[]))
          OR (ambito = 'marca'    AND marca   = ANY($2::text[]))
          OR (ambito = 'familia'  AND familia = ANY($3::text[]))
        )`,
    [productIds, marcas.length ? marcas : [''], familias.length ? familias : ['']]);
  // Elegir la MEJOR por producto: especificidad -> prioridad -> mas reciente.
  const mejor = (a: any, b: any) => {
    const ea = especificidad(a.ambito), eb = especificidad(b.ambito);
    if (ea !== eb) return ea > eb ? a : b;
    if (a.prioridad !== b.prioridad) return a.prioridad > b.prioridad ? a : b;
    return new Date(a.fecha_inicio) >= new Date(b.fecha_inicio) ? a : b;
  };
  for (const id of productIds) {
    const p = prod[id]; if (!p) continue;
    let win: any = null;
    for (const o of ofs.rows) {
      const aplica = o.ambito === 'todos'
        || (o.ambito === 'producto' && o.product_id === id)
        || (o.ambito === 'marca' && o.marca && o.marca === p.marca)
        || (o.ambito === 'familia' && o.familia && o.familia === p.familia);
      if (!aplica) continue;
      win = win ? mejor(win, o) : o;
    }
    if (win) out[id] = { id: win.id, tipo: win.tipo, valor: win.valor, texto: win.texto, label: labelOferta(win), color: win.color, fecha_fin: win.fecha_fin };
  }
  return out;
}

// POST ofertas vigentes HOY de varios productos (para el visor comercial).
app.post('/api/ofertas/vigentes', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const ids = Array.from(new Set<number>(
      (Array.isArray(req.body.product_ids) ? req.body.product_ids : [])
        .map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)
    )).slice(0, 400);
    res.json({ success: true, ofertas: await ofertasVigentesLote(ids) });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// GET lista de ofertas (admin real). ?vigentes=true solo las de hoy.
app.get('/api/ofertas', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const cond: string[] = []; const vals: any[] = []; let i = 1;
    if (req.query.vigentes === 'true') cond.push(`activo=TRUE AND fecha_inicio<=CURRENT_DATE AND fecha_fin>=CURRENT_DATE`);
    if (req.query.product_id) { cond.push(`product_id=$${i++}`); vals.push(Number(req.query.product_id)); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(
      `SELECT o.*, p.codigo AS producto_codigo, p.nombre AS producto_nombre
         FROM oferta o LEFT JOIN products p ON p.id = o.product_id
         ${where} ORDER BY o.fecha_fin DESC, o.id DESC LIMIT 500`, vals);
    res.json({ success: true, ofertas: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Campos editables de una oferta (whitelist) — create/update.
function _ofertaCampos(body: any): { cols: string[]; vals: any[] } {
  const cols: string[] = []; const vals: any[] = [];
  const push = (c: string, v: any) => { cols.push(c); vals.push(v); };
  const fecha = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : null;
  if (body.nombre !== undefined) push('nombre', body.nombre ? String(body.nombre).slice(0, 120) : null);
  if (body.ambito !== undefined) push('ambito', ['producto', 'familia', 'marca', 'todos'].includes(String(body.ambito)) ? String(body.ambito) : 'producto');
  if (body.product_id !== undefined) push('product_id', body.product_id ? Number(body.product_id) : null);
  if (body.familia !== undefined) push('familia', body.familia ? String(body.familia).slice(0, 120) : null);
  if (body.marca !== undefined) push('marca', body.marca ? String(body.marca).slice(0, 120) : null);
  if (body.tipo !== undefined) push('tipo', ['descuento', 'bonificacion', 'texto'].includes(String(body.tipo)) ? String(body.tipo) : 'descuento');
  if (body.valor !== undefined) push('valor', (body.valor === '' || body.valor == null) ? null : Number(body.valor));
  if (body.texto !== undefined) push('texto', body.texto ? String(body.texto).slice(0, 120) : null);
  if (body.fecha_inicio !== undefined) push('fecha_inicio', fecha(body.fecha_inicio));
  if (body.fecha_fin !== undefined) push('fecha_fin', fecha(body.fecha_fin));
  if (body.prioridad !== undefined) push('prioridad', parseInt(String(body.prioridad), 10) || 0);
  if (body.color !== undefined) push('color', String(body.color).slice(0, 24));
  if (body.activo !== undefined) push('activo', !!body.activo);
  return { cols, vals };
}

// POST crear oferta (admin real).
app.post('/api/ofertas', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_inicio || '').slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_fin || '').slice(0, 10))) {
      res.status(400).json({ success: false, error: 'fecha_inicio y fecha_fin (YYYY-MM-DD) obligatorias' }); return;
    }
    if (String(b.fecha_fin).slice(0, 10) < String(b.fecha_inicio).slice(0, 10)) { res.status(400).json({ success: false, error: 'fecha_fin anterior a fecha_inicio' }); return; }
    const { cols, vals } = _ofertaCampos(b);
    cols.push('creado_por'); vals.push(req.user?.id || null);
    const ph = vals.map((_, i) => '$' + (i + 1)).join(',');
    const r = await pool.query(`INSERT INTO oferta (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    res.json({ success: true, oferta: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// PUT actualizar oferta (admin real).
app.put('/api/ofertas/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { cols, vals } = _ofertaCampos(req.body || {});
    if (!cols.length) { res.status(400).json({ success: false, error: 'nada que actualizar' }); return; }
    const sets = cols.map((c, i) => `${c} = $${i + 1}`); sets.push('updated_at = NOW()');
    vals.push(Number(req.params.id));
    const r = await pool.query(`UPDATE oferta SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true, oferta: r.rows[0] });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

// DELETE oferta (admin real).
app.delete('/api/ofertas/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`DELETE FROM oferta WHERE id=$1 RETURNING id`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

// ============================================================================
// F5 EXPORT — RECOMPOSICION: hornea en la imagen los precios de HOY (recuadros
// aprobados) + las ofertas vigentes. Sirve para descargar/compartir (WhatsApp),
// PDF del catalogo o backup MEGA, sin depender de la app.
// ============================================================================
// Color de fondo de la lamina alrededor del hueco de una tabla. Se muestrea una
// franja JUSTO ENCIMA (y si no, a la izquierda) del sitio donde va la tabla, para
// que el rectangulo que tapa la tabla vieja se funda con la lamina en vez de ser
// un bloque blanco que canta. Si algo falla, blanco.
async function colorFondoLamina(abs: string, W: number, H: number, x: number, y: number, w: number, h: number): Promise<string> {
  const muestra = async (left: number, top: number, width: number, height: number) => {
    if (width < 2 || height < 2 || left < 0 || top < 0 || left + width > W || top + height > H) return null;
    // flatten: si la lámina tiene transparencia, sin esto el muestreo daba NEGRO
    // (RGB 0,0,0 de un píxel transparente) y el fondo salía en negro.
    const px = await sharp(abs).flatten({ background: '#ffffff' })
      .extract({ left, top, width, height }).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
    return px.length >= 3 ? `#${[px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('')}` : null;
  };
  try {
    const franja = Math.max(3, Math.round(H * 0.004));
    // Se prueban las cuatro franjas de alrededor y se coge la MAS CLARA: la
    // tabla vieja (texto oscuro) puede tocar alguna, y el fondo de una lámina
    // comercial es siempre lo más claro de su entorno.
    const cands = [
      await muestra(x, Math.max(0, y - franja - 2), w, franja),                 // encima
      await muestra(x, Math.min(H - franja - 1, y + h + 2), w, franja),         // debajo
      await muestra(Math.max(0, x - franja - 2), y, franja, h),                 // izquierda
      await muestra(Math.min(W - franja - 1, x + w + 2), y, franja, h),         // derecha
    ].filter(Boolean) as string[];
    if (!cands.length) return '#ffffff';
    const luz = (c: string) => parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16);
    return cands.sort((a, b) => luz(b) - luz(a))[0];
  } catch { return '#ffffff'; }
}

async function recomponerLaminaHoy(sheetId: number, tarifa: number): Promise<Buffer | null> {
  const s = await pool.query('SELECT imagen_path, precios_excluida FROM sheets WHERE id=$1', [sheetId]);
  if (!s.rows.length) return null;
  const abs = resolverRutaImagen(s.rows[0].imagen_path, UPLOADS_DIR);
  if (!abs || !fs.existsSync(abs)) return null;
  // Interruptor maestro apagado O lamina EXCLUIDA -> se exporta TAL CUAL (forma original).
  if (!(await preciosDinamicosActivo()) || s.rows[0].precios_excluida) return await sharp(abs).png().toBuffer();
  const meta = await sharp(abs).metadata();
  const W = meta.width || 0, H = meta.height || 0;
  if (!W || !H) return null;

  const recs = (await pool.query(
    `SELECT * FROM lamina_recuadro WHERE sheet_id=$1 AND activo=TRUE AND revisar=FALSE`, [sheetId])).rows;
  const zonas = (await pool.query(
    `SELECT id, product_id, x, y, ancho, alto FROM sheet_zones WHERE sheet_id=$1 AND product_id IS NOT NULL`, [sheetId])).rows;
  const prodIds = Array.from(new Set<number>([...recs.map((r: any) => r.product_id), ...zonas.map((z: any) => z.product_id)].filter(Boolean)));
  const precios: Record<number, any> = {};
  for (const r of recs) { if (r.product_id && !precios[r.product_id]) precios[r.product_id] = await precioVigenteHoy(r.product_id, tarifa); }
  const ofertas = await ofertasVigentesLote(prodIds);
  const cfg = await configPreciosRender(); // fuente + factor de tamaño (config una vez)

  const esc = (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (val: number, rec: any) => {
    const dec = rec.decimales == null ? 2 : rec.decimales;
    let t = Number(val).toFixed(dec);
    if (rec.sep_decimal !== '.') t = t.replace('.', ',');
    return (rec.prefijo || '') + t + (rec.sufijo == null ? '€' : rec.sufijo);
  };
  // Huecos de las TABLAS de expositor asociadas. Se cargan ANTES de pintar los
  // precios porque un precio que caiga dentro de una tabla NO debe escribirse:
  // la tabla ya trae ese precio, y encima salia superpuesto y enorme sobre ella.
  const lt = await pool.query(
    `SELECT lt.x, lt.y, lt.ancho, lt.alto, t.datos FROM lamina_tabla lt
       JOIN expositor_tabla t ON t.id = lt.tabla_id
      WHERE lt.sheet_id = $1 AND lt.activo = TRUE AND lt.deleted_at IS NULL AND t.deleted_at IS NULL`, [sheetId]);
  const huecos = lt.rows.map((r: any) => ({ x: Number(r.x), y: Number(r.y), x2: Number(r.x) + Number(r.ancho), y2: Number(r.y) + Number(r.alto) }));
  // ¿El centro del recuadro cae dentro de algún hueco de tabla? (en %)
  const dentroDeTabla = (rec: any) => {
    const cx = Number(rec.x) + Number(rec.ancho) / 2, cy = Number(rec.y) + Number(rec.alto) / 2;
    return huecos.some(h => cx >= h.x && cx <= h.x2 && cy >= h.y && cy <= h.y2);
  };

  let els = '';
  // Recuadros de precio (tapar + reescribir precio de HOY)
  for (const rec of recs) {
    if (dentroDeTabla(rec)) continue;   // esa zona la cubre una tabla de expositor
    const pr = rec.product_id ? precios[rec.product_id] : null; if (!pr) continue;
    const val = rec.campo === 'pvpr' ? pr.pvpr : pr.pvf; if (val == null) continue;
    const txt = fmt(Number(val), rec);
    const dY = rec.alto / 100 * H * 0.12;
    const x = rec.x / 100 * W, y = rec.y / 100 * H - dY;
    const w = rec.ancho / 100 * W * 1.15, h = rec.alto / 100 * H * 1.25;
    const fs2 = rec.tam_rel / 100 * W * cfg.tamFactor;
    const by = y + h / 2 + fs2 * 0.35;
    const anchor = rec.alinear === 'right' ? 'end' : (rec.alinear === 'center' ? 'middle' : 'start');
    const tx = rec.alinear === 'right' ? x + w : (rec.alinear === 'center' ? x + w / 2 : x);
    const fam = rec.fuente || cfg.fuente;
    els += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${rec.color_fondo || '#fff'}"/>`;
    els += `<text x="${tx}" y="${by}" font-family="${fam}, Arial, DejaVu Sans, sans-serif" font-weight="${rec.negrita === false ? '400' : '700'}" font-size="${fs2}" fill="${rec.color_texto || '#2b2a29'}" text-anchor="${anchor}">${esc(txt)}</text>`;
  }
  // Ofertas: badge arriba-derecha de la zona
  for (const z of zonas) {
    if (dentroDeTabla(z)) continue;     // esa zona la cubre una tabla de expositor
    const of = ofertas[z.product_id]; if (!of) continue;
    const label = String(of.label || 'Oferta');
    const fs2 = W * 0.013;
    const padX = fs2 * 0.55, padY = fs2 * 0.32;
    const bw = label.length * fs2 * 0.6 + padX * 2, bh = fs2 + padY * 2;
    const zx = z.x / 100 * W, zy = z.y / 100 * H, zw = z.ancho / 100 * W;
    // Badge JUSTO ENCIMA de la zona (esquina del producto), no sobre el precio.
    const bx = Math.max(0, zx + zw - bw), by0 = Math.max(0, zy - bh - H * 0.004);
    els += `<rect x="${bx}" y="${by0}" width="${bw}" height="${bh}" rx="${bh * 0.3}" fill="${of.color || '#dc2626'}"/>`;
    els += `<text x="${bx + bw / 2}" y="${by0 + bh / 2 + fs2 * 0.35}" font-family="Liberation Sans, Arial, DejaVu Sans, sans-serif" font-weight="800" font-size="${fs2}" fill="#ffffff" text-anchor="middle">${esc(label)}</text>`;
  }
  // TABLAS de expositor asociadas: se pegan dibujadas (ya cargadas arriba en `lt`).
  const tablasComposites: sharp.OverlayOptions[] = [];
  for (const row of lt.rows) {
    const bx = Math.round(row.x / 100 * W), by = Math.round(row.y / 100 * H);
    const bw = Math.round(row.ancho / 100 * W), bh = Math.round(row.alto / 100 * H);
    if (bw < 10 || bh < 10) continue;
    try {
      // SOLO LA TABLA lleva fondo (el color de la lámina, para que tape del todo
      // lo que haya debajo y no se note el parche). Todo el contorno del hueco
      // queda TRANSPARENTE: pintar el hueco entero tapaba parte de su lámina.
      // Como la tabla se dibuja al ancho del hueco, el hueco queda cubierto a lo
      // ancho; si sobra alto, es sitio que él ha dibujado de más.
      const fondo = await colorFondoLamina(abs, W, H, bx, by, bw, bh);
      // El hueco manda en los dos ejes: el ANCHO reparte las columnas y el ALTO
      // decide el tamaño de letra. Así la tabla cubre el bloque de precios viejo.
      const { buffer: tb } = await renderTablaExpositor(row.datos, { width: bw, alto: bh, fondo });
      // MANDA EL ANCHO: la tabla se pega ocupando todo el ancho del hueco, que es
      // lo que tiene que tapar. Antes, si salía más alta que el hueco se encogía
      // entera (contain) y al encogerla se ESTRECHABA -> dejaba de cubrir la tabla
      // vieja por la derecha. Si sobra alto, se ve: el usuario ajusta el hueco.
      let fin = tb;
      const m = await sharp(tb).metadata();
      const tw0 = m.width || bw, th0 = m.height || 0;
      // La tabla NUNCA puede salirse de la lámina: sharp lanza al componer una
      // capa que se sale, y eso tumbaba la petición entera. Se recorta a lo que
      // quepa, en los DOS ejes (antes solo se miraba el alto).
      const maxW = Math.max(1, W - bx), maxH = Math.max(1, H - by);
      if (tw0 > maxW || th0 > maxH) {
        fin = await sharp(tb).extract({ left: 0, top: 0, width: Math.min(tw0, maxW), height: Math.min(th0, maxH) }).png().toBuffer();
      }
      if (bx < W && by < H) tablasComposites.push({ input: fin, left: bx, top: by });
    } catch (e) { /* si falla el render de una tabla, seguimos con el resto */ }
  }

  if (!els && !tablasComposites.length) return await sharp(abs).png().toBuffer(); // nada que recomponer
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${els}</svg>`;
  const capas: sharp.OverlayOptions[] = [{ input: Buffer.from(svg), top: 0, left: 0 }, ...tablasComposites];
  try {
    return await sharp(abs).composite(capas).png().toBuffer();
  } catch (e) {
    // Si el montaje falla por lo que sea, MEJOR DEVOLVER LA LÁMINA ORIGINAL que
    // reventar la petición: el comercial sigue trabajando y queda el aviso en log.
    console.error('[recompose] Fallo montando la lámina ' + sheetId + ':', (e as Error).message);
    return await sharp(abs).png().toBuffer();
  }
}

// GET lamina recompuesta (PNG) con precios de hoy + ofertas. Para descargar/compartir.
app.get('/api/sheets/:id/recompuesta', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const tarifa = Number(req.query.tarifa) || 1;
    const buf = await recomponerLaminaHoy(Number(req.params.id), tarifa);
    if (!buf) { res.status(404).json({ success: false, error: 'Lamina o imagen no encontrada' }); return; }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store'); // los precios cambian
    res.send(buf);
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// GET PDF del catalogo con TODAS las laminas recompuestas (precios de hoy + ofertas).
app.get('/api/catalogs/:id/pdf-hoy', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const catId = Number(req.params.id);
    const tarifa = Number(req.query.tarifa) || 1;
    const cat = await pool.query('SELECT name, tipo FROM catalogs WHERE id=$1', [catId]);
    if (!cat.rows.length) { res.status(404).json({ success: false, error: 'Catalogo no encontrado' }); return; }
    // Un Express no tiene laminas propias: las suyas van por express_sheets y en SU
    // orden. Sin esto, el PDF de un Express salia "no tiene laminas" — justo el
    // respaldo en papel que necesita el comercial.
    const sheets = cat.rows[0].tipo === 'express'
      ? (await pool.query(
          `SELECT s.id FROM express_sheets es JOIN sheets s ON s.id = es.sheet_id
            WHERE es.express_catalog_id = $1 AND (s.oculta IS NULL OR s.oculta = FALSE)
            ORDER BY es.orden, es.id`, [catId])).rows
      : (await pool.query(
          `SELECT id FROM sheets WHERE catalog_id=$1 AND (oculta IS NULL OR oculta=FALSE) ORDER BY orden, id`, [catId])).rows;
    if (!sheets.length) { res.status(400).json({ success: false, error: 'El catalogo no tiene laminas' }); return; }
    // PDF POR ZONA: el papel no filtra solo, asi que si el respaldo lleva todo, se
    // convierte en el agujero por el que se cuela lo que no se puede vender alli.
    let zonaNombre = '';
    const zonaId = Number(req.query.zona_id) || 0;
    let laminas = sheets;
    if (zonaId) {
      const z = await pool.query(`SELECT nombre FROM zonas_venta WHERE id=$1`, [zonaId]);
      if (z.rows.length) {
        zonaNombre = z.rows[0].nombre;
        const veto = new Set((await laminasRestringidasEnZona(zonaId)).map(Number));
        laminas = sheets.filter((s: any) => !veto.has(Number(s.id)));
      }
    }
    if (!laminas.length) { res.status(400).json({ success: false, error: 'No queda ninguna lámina para esa zona' }); return; }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const nombre = String(cat.rows[0].name || 'catalogo').replace(/[^a-z0-9._-]+/gi, '_');
    const sufijo = zonaNombre ? '_' + zonaNombre.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '_') : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}${sufijo}_precios_hoy.pdf"`);
    doc.pipe(res);
    const pageW = 595; // A4 ancho en pt
    for (const s of laminas) {
      const buf = await recomponerLaminaHoy(s.id, tarifa);
      if (!buf) continue;
      const m = await sharp(buf).metadata();
      const w = m.width || pageW, h = m.height || pageW;
      const pageH = pageW * h / w;
      doc.addPage({ size: [pageW, pageH], margin: 0 });
      doc.image(buf, 0, 0, { width: pageW, height: pageH });
    }
    doc.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ success: false, error: (e as Error).message });
    else res.end();
  }
});

// ============================================================================
// TABLAS DE EXPOSITOR — biblioteca (subir Excel), calcular y dibujar.
// ============================================================================
const uploadTablaMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const n = file.originalname.toLowerCase();
    cb(null, n.endsWith('.xlsx') || n.endsWith('.xls'));
  }
});

// Subir un Excel -> parsear -> guardar como tabla nueva.
// Nombre generico de pestana: "Hoja1", "Sheet2", "Tabla 1", "1"... no sirve
// para localizar la tabla luego y asociarla a su lamina.
const pestanaGenerica = (t: string) => !t || /^(hoja|sheet|tabla|table)?\s*\d*$/i.test(t.trim());

// Nombre LOGICO de una tabla, para que el usuario la encuentre despues:
//   1) el nombre de la pestana, si el se lo puso ("Emuliquen");
//   2) si la pestana es generica, el TITULO que el escribio dentro de la hoja
//      ("EXPOSITOR PIE VP NATURITAS AMPOLLAS");
//   3) en ultimo caso, archivo + primer producto de la hoja.
function nombreLogicoBloque(b: { titulo: string; filas: any[] }, base: string, multi: boolean): string {
  if (!pestanaGenerica(b.titulo)) return b.titulo;
  const sec = b.filas.find((f: any) => f.tipo === 'seccion');
  const tSec = sec && sec.celdas.find((c: string) => c);
  if (tSec) return tSec;
  if (!multi) return base;
  const dato = b.filas.find((f: any) => f.tipo === 'datos');
  const prod = (dato && dato.celdas.find((c: string) => c)) || b.titulo || 'hoja';
  return `${base} - ${prod}`;
}

app.post('/api/tablas', verifyToken, requireRealAdmin, uploadTablaMem.single('archivo'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ success: false, error: 'Sube un archivo Excel (.xlsx)' }); return; }
    const datos = parseExcelTabla(req.file.buffer);
    // CADA HOJA del Excel se guarda como una tabla INDEPENDIENTE de la biblioteca
    // (pedido del usuario: cada hoja pertenece a una lamina distinta). El nombre
    // de la tabla es el de la pestana; si el libro solo tiene una hoja o el nombre
    // es el generico "Hoja1", se usa el nombre del archivo.
    const bloques = (datos.bloques || []).filter(b => b.filas.some(f => f.tipo === 'datos'));
    if (!bloques.length) {
      res.status(422).json({ success: false, error: 'No he podido leer ninguna tabla: necesito una fila de cabeceras y filas por debajo. Esto es lo que he leído — ' + resumenExcel(req.file.buffer) });
      return;
    }
    const base = (req.body.nombre ? String(req.body.nombre) : req.file.originalname.replace(/\.(xlsx|xls)$/i, '')).trim();
    const multi = bloques.length > 1;
    const nuevas: string[] = [], actualizadas: string[] = [];
    const usados = new Set<string>();
    for (const b of bloques) {
      let nombre = nombreLogicoBloque(b, base, multi).slice(0, 150);
      // Dos hojas que resuelvan al mismo nombre dentro del MISMO archivo no deben
      // machacarse entre si: se numeran.
      let candidato = nombre, k = 2;
      while (usados.has(candidato.toLowerCase())) candidato = `${nombre} (${k++})`;
      nombre = candidato;
      usados.add(nombre.toLowerCase());
      const datosUno = JSON.stringify({ bloques: [b] });
      // Si ya existe una tabla con ese nombre se ACTUALIZA (re-subida de precios),
      // no se duplica. Asi el flujo de "soltar todos los Excel otra vez" funciona.
      const ex = await pool.query(`SELECT id FROM expositor_tabla WHERE LOWER(nombre)=LOWER($1) AND deleted_at IS NULL`, [nombre]);
      if (ex.rows.length) {
        await pool.query(`UPDATE expositor_tabla SET datos=$1, archivo=$2, updated_at=NOW() WHERE id=$3`,
          [datosUno, req.file.originalname.slice(0, 200), ex.rows[0].id]);
        actualizadas.push(nombre);
      } else {
        await pool.query(
          `INSERT INTO expositor_tabla (nombre, datos, origen, archivo, creado_por) VALUES ($1,$2,'excel',$3,$4)`,
          [nombre, datosUno, req.file.originalname.slice(0, 200), req.user?.id || null]);
        nuevas.push(nombre);
      }
    }
    const primera = computarTabla({ bloques: [bloques[0]] });
    res.json({ success: true, nuevas, actualizadas, n_tablas: nuevas.length + actualizadas.length,
               tabla: { nombre: nuevas[0] || actualizadas[0] }, n_filas: primera.n_filas, total: primera.total });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Listar tablas (con total y nº de filas calculados).
app.get('/api/tablas', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`SELECT id, nombre, datos, archivo, updated_at FROM expositor_tabla WHERE deleted_at IS NULL ORDER BY updated_at DESC`);
    const tablas = r.rows.map((t: any) => {
      const c = computarTabla(t.datos);
      return { id: t.id, nombre: t.nombre, archivo: t.archivo, updated_at: t.updated_at,
               n_filas: c.n_filas, n_secciones: c.n_secciones, n_columnas: (c as any).n_columnas || null, n_hojas: (c as any).n_hojas || 1, total: c.total };
    });
    res.json({ success: true, tablas });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Detalle (datos + calculado).
app.get('/api/tablas/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`SELECT * FROM expositor_tabla WHERE id=$1 AND deleted_at IS NULL`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true, tabla: r.rows[0], calc: computarTabla(r.rows[0].datos) });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Previsualización PNG de la tabla dibujada.
app.get('/api/tablas/:id/preview.png', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`SELECT datos FROM expositor_tabla WHERE id=$1 AND deleted_at IS NULL`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    const w = Number(req.query.w) || 1040;
    // `alto` (px, en la misma escala que w) = proporción del hueco. Con eso la
    // vista previa del editor sale igual que al pegarla: mismo reparto de
    // columnas y misma letra. Sin él, letra por defecto.
    const alto = Number(req.query.alto) || undefined;
    const { buffer } = await renderTablaExpositor(r.rows[0].datos, { width: w, alto });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Renombrar o sustituir por un Excel nuevo (actualización de precios).
app.put('/api/tablas/:id', verifyToken, requireRealAdmin, uploadTablaMem.single('archivo'), async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    let calc: any = null;
    if (req.body.nombre !== undefined) { sets.push(`nombre=$${i++}`); vals.push(String(req.body.nombre).slice(0, 160)); }
    if (req.file) {
      const datos = parseExcelTabla(req.file.buffer);
      const bloques = (datos.bloques || []).filter(b => b.filas.some(f => f.tipo === 'datos'));
      if (!bloques.length) {
        res.status(422).json({ success: false, error: 'No he podido leer la tabla, así que no toco la anterior. Esto es lo que he leído — ' + resumenExcel(req.file.buffer) });
        return;
      }
      // Esta ruta actualiza UNA tabla concreta. Si el Excel trae varias hojas:
      //   - la hoja que se llame como la tabla es la suya;
      //   - si ninguna coincide (el usuario ha partido su Excel en hojas nuevas),
      //     esta tabla se actualiza con la PRIMERA y las demas se guardan como
      //     tablas propias con nombre logico. Antes esto era un error que le
      //     mandaba a otra pantalla: un callejon sin salida.
      let elegido = bloques[0];
      let aviso: string | undefined;
      if (bloques.length > 1) {
        const act = await pool.query(`SELECT nombre FROM expositor_tabla WHERE id=$1 AND deleted_at IS NULL`, [id]);
        const nomAct = String(act.rows[0]?.nombre || '');
        const match = bloques.find(b => (b.titulo || '').toLowerCase() === nomAct.toLowerCase());
        if (match) {
          elegido = match;
        } else {
          const base = req.file.originalname.replace(/\.(xlsx|xls)$/i, '').trim();
          const extras: string[] = [];
          const usados = new Set<string>([nomAct.toLowerCase()]);
          for (const b of bloques.slice(1)) {
            let nombre = nombreLogicoBloque(b, base, true).slice(0, 150);
            let candidato = nombre, k = 2;
            while (usados.has(candidato.toLowerCase())) candidato = `${nombre} (${k++})`;
            nombre = candidato;
            usados.add(nombre.toLowerCase());
            const datosUno = JSON.stringify({ bloques: [b] });
            const ex = await pool.query(`SELECT id FROM expositor_tabla WHERE LOWER(nombre)=LOWER($1) AND deleted_at IS NULL`, [nombre]);
            if (ex.rows.length) {
              await pool.query(`UPDATE expositor_tabla SET datos=$1, archivo=$2, updated_at=NOW() WHERE id=$3`,
                [datosUno, req.file.originalname.slice(0, 200), ex.rows[0].id]);
            } else {
              await pool.query(`INSERT INTO expositor_tabla (nombre, datos, origen, archivo, creado_por) VALUES ($1,$2,'excel',$3,$4)`,
                [nombre, datosUno, req.file.originalname.slice(0, 200), req.user?.id || null]);
            }
            extras.push(nombre);
          }
          aviso = `El Excel trae ${bloques.length} hojas: esta tabla se ha actualizado con la 1ª (${nombreLogicoBloque(bloques[0], base, true).slice(0, 80)}) y la${extras.length > 1 ? 's' : ''} otra${extras.length > 1 ? 's' : ''} se ha${extras.length > 1 ? 'n' : ''} guardado como tabla propia: ${extras.join(', ')}. Comprueba qué tabla va asociada a cada lámina.`;
        }
      }
      (req as any)._avisoTabla = aviso;
      calc = computarTabla({ bloques: [elegido] });
      sets.push(`datos=$${i++}`); vals.push(JSON.stringify({ bloques: [elegido] }));
      sets.push(`archivo=$${i++}`); vals.push(req.file.originalname.slice(0, 200));
    }
    if (!sets.length) { res.status(400).json({ success: false, error: 'Nada que actualizar' }); return; }
    sets.push('updated_at=NOW()'); vals.push(id);
    const r = await pool.query(`UPDATE expositor_tabla SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id, nombre, updated_at`, vals);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true, tabla: r.rows[0], n_filas: calc ? calc.n_filas : undefined, total: calc ? calc.total : undefined,
               aviso: (req as any)._avisoTabla });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Borrar tabla (y sus asociaciones, por el ON DELETE CASCADE).
// DESHACER un borrado de tablas: las saca de la papelera junto con las
// asociaciones a laminas que se marcaron al borrarlas (vuelve todo como estaba).
app.post('/api/tablas/restaurar', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0);
    if (!ids.length) { res.status(400).json({ success: false, error: 'Nada que restaurar' }); return; }
    const r = await pool.query(`UPDATE expositor_tabla SET deleted_at=NULL WHERE id = ANY($1::int[]) RETURNING id, nombre`, [ids]);
    await pool.query(`UPDATE lamina_tabla SET deleted_at=NULL WHERE tabla_id = ANY($1::int[])`, [ids]);
    res.json({ success: true, restauradas: r.rows.map((x: any) => x.nombre), n: r.rows.length });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// DESHACER quitar una tabla de una lamina.
app.post('/api/lamina-tabla/:id/restaurar', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`UPDATE lamina_tabla SET deleted_at=NULL WHERE id=$1 RETURNING id`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.delete('/api/tablas/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    // A la PAPELERA (no se destruye): asi se puede deshacer. Se marcan tambien sus
    // asociaciones a laminas para que la lamina deje de usarla, y vuelvan si se deshace.
    const r = await pool.query(`UPDATE expositor_tabla SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [Number(req.params.id)]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    await pool.query(`UPDATE lamina_tabla SET deleted_at=NOW() WHERE tabla_id=$1 AND deleted_at IS NULL`, [Number(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// ----- Asociación tabla -> lámina (el "hueco" donde se pega) -----
// GET asociaciones de una lámina.
app.get('/api/sheets/:sheetId/tablas', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT lt.*, t.nombre AS tabla_nombre FROM lamina_tabla lt
         JOIN expositor_tabla t ON t.id = lt.tabla_id AND t.deleted_at IS NULL
        WHERE lt.sheet_id = $1 AND lt.deleted_at IS NULL ORDER BY lt.id`, [Number(req.params.sheetId)]);
    res.json({ success: true, tablas: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});
// POST asociar tabla a lámina (con bbox del hueco).
app.post('/api/sheets/:sheetId/tablas', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO lamina_tabla (sheet_id, tabla_id, x, y, ancho, alto)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [Number(req.params.sheetId), Number(b.tabla_id),
       b.x != null ? Number(b.x) : 2, b.y != null ? Number(b.y) : 20,
       b.ancho != null ? Number(b.ancho) : 60, b.alto != null ? Number(b.alto) : 65]);
    // Asociar una tabla = querer automatizar esta lamina -> quitar la exclusion (si la tenia),
    // que es contradictoria (excluida = no se toca nada, y la tabla justamente la toca).
    await pool.query(`UPDATE sheets SET precios_excluida=FALSE WHERE id=$1 AND precios_excluida=TRUE`, [Number(req.params.sheetId)]);
    logSheetChangeAgrupado('updated_tablas', Number(req.params.sheetId), { id: req.user?.id, name: req.user?.name }, 'tabla de expositor añadida');
    res.json({ success: true, asociacion: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});
// PUT mover/redimensionar el hueco o cambiar la tabla.
app.put('/api/lamina-tabla/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {}; const sets: string[] = []; const vals: any[] = []; let i = 1;
    ['x', 'y', 'ancho', 'alto', 'tabla_id'].forEach(k => { if (b[k] !== undefined) { sets.push(`${k}=$${i++}`); vals.push(Number(b[k])); } });
    if (b.activo !== undefined) { sets.push(`activo=$${i++}`); vals.push(!!b.activo); }
    if (!sets.length) { res.status(400).json({ success: false, error: 'nada que actualizar' }); return; }
    sets.push('updated_at=NOW()'); vals.push(Number(req.params.id));
    const r = await pool.query(`UPDATE lamina_tabla SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (r.rows.length) logSheetChangeAgrupado('updated_tablas', r.rows[0].sheet_id, { id: req.user?.id, name: req.user?.name }, 'tabla de expositor recolocada');
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true, asociacion: r.rows[0] });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});
// DELETE quitar la tabla de la lámina.
app.delete('/api/lamina-tabla/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`UPDATE lamina_tabla SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id, sheet_id`, [Number(req.params.id)]);
    if (r.rows.length) logSheetChangeAgrupado('updated_tablas', r.rows[0].sheet_id, { id: req.user?.id, name: req.user?.name }, 'tabla de expositor quitada');
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: (e as Error).message }); }
});

app.get('/api/admin/limpiar-pruebas/preview', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const counts: any = {};
    const tablas: [string, string][] = [
      ['catalogs', 'catálogos'],
      ['sheets', 'láminas'],
      ['visits', 'visitas'],
      ['annotations', 'anotaciones'],
      ['catalog_versions', 'versiones cerradas'],
      ['visit_emails', 'emails de visitas'],
      ['sheet_audit_log', 'registros de auditoría'],
      ['mega_backups', 'backups MEGA hechos'],
      ['office_summary_sent', 'resúmenes enviados'],
      ['formaciones', 'formaciones (Aula)'],
      ['formacion_versions', 'versiones de formaciones']
    ];
    for (const [tabla, label] of tablas) {
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${tabla}`);
        counts[tabla] = { label, n: r.rows[0].n };
      } catch (_) {
        counts[tabla] = { label, n: 0 };
      }
    }
    res.json({
      success: true,
      counts,
      se_mantienen: [
        'users (admin + comerciales)',
        'clients (importados de Sage)',
        'products (importados de Sage)',
        'categorias / annotation_templates',
        'mega_folders (las 6 carpetas MEGA)',
        'office_summary_recipients (los 4 emails de oficina)',
        'email_config'
      ]
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

app.post('/api/admin/limpiar-pruebas', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const confirmacion = String(req.body.confirmacion || '');
    if (confirmacion !== 'BORRAR') {
      res.status(400).json({ success: false, error: 'Confirmación incorrecta. Debes escribir BORRAR.' });
      return;
    }

    const borrados: any = {};

    // Selección de grupos a borrar (por defecto TODO, para compatibilidad).
    // 'catalogos' IMPLICA 'visitas': no tiene sentido conservar pedidos de catálogos borrados
    // (además evita errores de clave foránea al borrar las láminas que referencian).
    const gruposRaw = Array.isArray(req.body.grupos) ? req.body.grupos.map((g: any) => String(g)) : ['visitas', 'catalogos', 'aula'];
    const wantCatalogos = gruposRaw.includes('catalogos');
    const wantAula = gruposRaw.includes('aula');
    const wantVisitas = gruposRaw.includes('visitas') || wantCatalogos;
    if (!wantVisitas && !wantCatalogos && !wantAula) {
      res.status(400).json({ success: false, error: 'No has seleccionado nada que borrar.' });
      return;
    }

    // 1) Recoger rutas físicas de láminas ANTES de borrar (solo si se borran catálogos)
    const rutasFisicas: string[] = [];
    if (wantCatalogos) {
      const sheetsR = await pool.query(`SELECT imagen_path, miniatura_path FROM sheets`);
      for (const s of sheetsR.rows) {
        for (const p of [s.imagen_path, s.miniatura_path]) {
          if (!p) continue;
          let rel = String(p);
          if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
          else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
          rutasFisicas.push(path.join(UPLOADS_DIR, rel));
        }
      }
    }

    // 1b) Rutas fisicas de archivos de formaciones (solo si se borra el Aula)
    if (wantAula) {
      try {
        const formR = await pool.query(`SELECT archivo_path FROM formaciones`);
        for (const f of formR.rows) if (f.archivo_path) rutasFisicas.push(f.archivo_path);
        const formVR = await pool.query(`SELECT archivo_path FROM formacion_versions`);
        for (const f of formVR.rows) if (f.archivo_path) rutasFisicas.push(f.archivo_path);
      } catch (_) { /* si las tablas no existen, seguimos */ }
    }

    // 2) Borrar en orden seguro (hijos antes que padres).
    //    Muchas tienen ON DELETE CASCADE, pero lo hacemos explícito para contar bien.
    // Orden canónico seguro (hijos antes que padres) con el GRUPO de cada tabla.
    // Solo se borran las de los grupos seleccionados.
    const canonico: Array<{ t: string; g: 'visitas' | 'catalogos' | 'aula' }> = [
      { t: 'sheet_audit_log', g: 'catalogos' },
      { t: 'mega_backups', g: 'catalogos' },
      { t: 'office_summary_sent', g: 'catalogos' },
      { t: 'visit_emails', g: 'visitas' },
      { t: 'annotations', g: 'visitas' },
      { t: 'visits', g: 'visitas' },
      { t: 'express_sheets', g: 'catalogos' },
      { t: 'catalog_versions', g: 'catalogos' },
      { t: 'catalog_changes', g: 'catalogos' },
      { t: 'catalog_assignments', g: 'catalogos' },
      { t: 'sheet_categorias', g: 'catalogos' },
      { t: 'sheet_zones', g: 'catalogos' },
      { t: 'sheets', g: 'catalogos' },
      { t: 'catalogs', g: 'catalogos' },
      { t: 'formacion_permisos', g: 'aula' },
      { t: 'formacion_versions', g: 'aula' },
      { t: 'formaciones', g: 'aula' }
    ];
    const grupoActivo = (g: string) => (g === 'visitas' ? wantVisitas : g === 'catalogos' ? wantCatalogos : wantAula);
    const ordenBorrado = canonico.filter(x => grupoActivo(x.g)).map(x => x.t);
    for (const tabla of ordenBorrado) {
      try {
        const r = await pool.query(`DELETE FROM ${tabla}`);
        borrados[tabla] = r.rowCount || 0;
      } catch (e: any) {
        // Si una tabla no existe (ej. catalog_changes en algún entorno), seguimos
        borrados[tabla] = 'tabla no encontrada o error: ' + e.message;
      }
    }

    // 3) Borrar archivos físicos de láminas del disco
    let archivosFisicosBorrados = 0;
    const fsMod = require('fs');
    for (const ruta of rutasFisicas) {
      try {
        if (fsMod.existsSync(ruta)) {
          fsMod.unlinkSync(ruta);
          archivosFisicosBorrados++;
        }
      } catch (e) {
        // Ignorar errores de borrado de archivo individual
      }
    }

    // 4) Borrar carpeta de versiones (PDFs/ZIPs generados) solo si se borran catálogos
    if (wantCatalogos) {
      try {
        const versionsDir = path.join(UPLOADS_DIR, 'versions');
        if (fsMod.existsSync(versionsDir)) {
          for (const f of fsMod.readdirSync(versionsDir)) {
            try { fsMod.unlinkSync(path.join(versionsDir, f)); archivosFisicosBorrados++; } catch {}
          }
        }
      } catch (e) { /* ignorar */ }
    }

    res.json({
      success: true,
      borrados,
      archivos_fisicos_borrados: archivosFisicosBorrados,
      mensaje: 'Datos de prueba eliminados. Productos, clientes, usuarios, plantillas y configuración intactos.'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Funcion principal del geocoding en background
async function iniciarGeocodingBackground(iniciadoPor: string, soloFaltantes: boolean) {
  _geoState.running = true;
  _geoState.cancelado = false;
  _geoState.procesados = 0;
  _geoState.ok = 0;
  _geoState.errores = 0;
  _geoState.no_encontrados = 0;
  _geoState.ultimoError = '';
  _geoState.iniciadoPor = iniciadoPor;
  _geoState.iniciadoAt = new Date();

  try {
    // Cargar lista de clientes a geocodificar
    const whereClause = soloFaltantes
      ? `WHERE is_active = TRUE AND (latitude IS NULL OR longitude IS NULL)`
      : `WHERE is_active = TRUE`;
    const r = await pool.query(`
      SELECT id, razon_social, direccion, cp, municipio, provincia
      FROM clients
      ${whereClause}
      ORDER BY id
    `);
    _geoState.total = r.rows.length;
    console.log(`[GEOCODE] Iniciado: ${_geoState.total} clientes a procesar (soloFaltantes=${soloFaltantes})`);

    for (const c of r.rows) {
      if (_geoState.cancelado) {
        console.log('[GEOCODE] Cancelado por usuario');
        break;
      }
      // Construir query de búsqueda
      const partes = [];
      if (c.direccion) partes.push(c.direccion);
      if (c.cp) partes.push(c.cp);
      if (c.municipio) partes.push(c.municipio);
      if (c.provincia) partes.push(c.provincia);
      partes.push('Spain'); // siempre limitar a España
      const query = partes.join(', ');

      try {
        const coords = await geocodificarNominatim(query);
        if (coords) {
          await pool.query(
            `UPDATE clients SET latitude = $1, longitude = $2, geo_at = NOW(), geo_status = 'ok' WHERE id = $3`,
            [coords.lat, coords.lon, c.id]
          );
          _geoState.ok++;
        } else {
          // Si no encuentra con dirección completa, intentar solo con municipio + provincia
          if (c.municipio && c.provincia) {
            const queryFallback = `${c.municipio}, ${c.provincia}, Spain`;
            const coordsFallback = await geocodificarNominatim(queryFallback);
            if (coordsFallback) {
              await pool.query(
                `UPDATE clients SET latitude = $1, longitude = $2, geo_at = NOW(), geo_status = 'ok_aprox' WHERE id = $3`,
                [coordsFallback.lat, coordsFallback.lon, c.id]
              );
              _geoState.ok++;
            } else {
              await pool.query(
                `UPDATE clients SET geo_at = NOW(), geo_status = 'no_encontrado' WHERE id = $1`,
                [c.id]
              );
              _geoState.no_encontrados++;
            }
          } else {
            await pool.query(
              `UPDATE clients SET geo_at = NOW(), geo_status = 'no_encontrado' WHERE id = $1`,
              [c.id]
            );
            _geoState.no_encontrados++;
          }
        }
      } catch (err) {
        _geoState.errores++;
        _geoState.ultimoError = (err as Error).message;
        await pool.query(
          `UPDATE clients SET geo_at = NOW(), geo_status = 'error' WHERE id = $1`,
          [c.id]
        ).catch(() => {});
      }

      _geoState.procesados++;
      // Respetar limite de Nominatim: 1 peticion/segundo
      await new Promise(resolve => setTimeout(resolve, 1100));
    }

    console.log(`[GEOCODE] Finalizado: ${_geoState.ok} ok, ${_geoState.no_encontrados} no encontrados, ${_geoState.errores} errores`);
  } catch (err) {
    console.error('[GEOCODE] Error en proceso:', err);
    _geoState.ultimoError = (err as Error).message;
  } finally {
    _geoState.running = false;
    _geoState.cancelado = false;
  }
}

// Llamada individual a Nominatim de OpenStreetMap.
// Devuelve {lat, lon} o null si no encuentra.
async function geocodificarNominatim(query: string): Promise<{lat: number, lon: number} | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=es`;
  // Nominatim REQUIERE un User-Agent identificable
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'CatalogPRO-LOMHIFAR/2.0 (f.ayllon66@gmail.com)',
      'Accept-Language': 'es'
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: any = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = data[0];
  const lat = parseFloat(r.lat);
  const lon = parseFloat(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// GET clientes para el mapa (con coords + estado)
// Query params:
//   modo: 'todos' | 'pendientes' (default 'todos')
//   bbox: 'lat1,lon1,lat2,lon2' (opcional, filtra por bounding box)
app.get('/api/map/clients', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const userId = effectiveUserId(req);
    const modo = String(req.query.modo || 'todos');
    const bboxStr = String(req.query.bbox || '');

    // Leer config
    const cfgR = await pool.query(
      `SELECT clave, valor FROM email_config WHERE clave IN
       ('planning_ciclo_default','planning_ventana_proxima_dias','planning_ventana_urgente_dias')`
    );
    const cfg: any = {};
    cfgR.rows.forEach((r: any) => { cfg[r.clave] = r.valor; });
    const cicloDefault = Number(cfg.planning_ciclo_default || 90);
    const ventanaProxima = Number(cfg.planning_ventana_proxima_dias || 15);
    const ventanaUrgente = Number(cfg.planning_ventana_urgente_dias || 15);

    // Filtros
    const params: any[] = [];
    let comercialFilter = '';
    if (isEffectiveSales(req)) {
      const uR = await pool.query(`SELECT sage_commercial_code FROM users WHERE id = $1`, [userId]);
      const ccode = uR.rows[0]?.sage_commercial_code;
      if (!ccode) { res.json({ success: true, clientes: [] }); return; }
      params.push(String(ccode));
      comercialFilter = ` AND c.commercial_code = $${params.length}`;
    }

    // Bbox filter (cuando "cerca de aquí" envía un area de mapa)
    let bboxFilter = '';
    if (bboxStr) {
      const parts = bboxStr.split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        const [lat1, lon1, lat2, lon2] = parts;
        const latMin = Math.min(lat1, lat2);
        const latMax = Math.max(lat1, lat2);
        const lonMin = Math.min(lon1, lon2);
        const lonMax = Math.max(lon1, lon2);
        params.push(latMin); const pLatMin = params.length;
        params.push(latMax); const pLatMax = params.length;
        params.push(lonMin); const pLonMin = params.length;
        params.push(lonMax); const pLonMax = params.length;
        bboxFilter = ` AND c.latitude BETWEEN $${pLatMin} AND $${pLatMax} AND c.longitude BETWEEN $${pLonMin} AND $${pLonMax}`;
      }
    }

    params.push(cicloDefault); const posCiclo = params.length;
    params.push(ventanaProxima); const posProxima = params.length;
    params.push(ventanaUrgente); const posUrgente = params.length;

    // Solo clientes con coords (NULL coords no se ven en mapa)
    const sql = `
      WITH ultima_visita AS (
        SELECT DISTINCT ON (v.client_id) v.client_id,
          COALESCE(v.confirmed_at, v.created_at) AS fecha_ultima
        FROM visits v WHERE v.status IN ('confirmed','sent')
        ORDER BY v.client_id, COALESCE(v.confirmed_at, v.created_at) DESC
      ),
      base AS (
        SELECT
          c.id, c.sage_code, c.razon_social, c.cif, c.commercial_code,
          c.municipio, c.provincia, c.categoria, c.latitude, c.longitude,
          uv.fecha_ultima,
          COALESCE(c.ciclo_visita_dias, $${posCiclo}) AS ciclo_efectivo,
          CASE WHEN uv.fecha_ultima IS NULL THEN NULL
               ELSE EXTRACT(DAY FROM (NOW() - uv.fecha_ultima))::int
          END AS dias_desde_ultima
        FROM clients c
        LEFT JOIN ultima_visita uv ON uv.client_id = c.id
        WHERE c.is_active = TRUE
          AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
          ${comercialFilter}
          ${bboxFilter}
      ),
      conEstado AS (
        SELECT *,
          CASE
            WHEN dias_desde_ultima IS NULL THEN 'sin_historial'
            WHEN dias_desde_ultima > (ciclo_efectivo + $${posUrgente}) THEN 'urgente'
            WHEN dias_desde_ultima >= (ciclo_efectivo - $${posProxima}) THEN 'proxima'
            ELSE 'al_dia'
          END AS estado
        FROM base
      )
      SELECT * FROM conEstado
      ${modo === 'pendientes' ? `WHERE estado IN ('urgente','proxima','sin_historial')` : ''}
      ORDER BY razon_social
      LIMIT 2000
    `;

    const r = await pool.query(sql, params);
    res.json({ success: true, clientes: r.rows });
  } catch (e) {
    console.error('[MAP/CLIENTS] ERROR:', (e as Error).message);
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Actualizar bumper de health

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
    const { sheet_id, texto_libre, tipo, pos_x, pos_y } = req.body;
    if (!texto_libre || !String(texto_libre).trim()) {
      res.status(400).json({ success: false, error: 'texto_libre obligatorio' });
      return;
    }
    const tipoFinal = ['pedido','devolucion','nota'].includes(tipo) ? tipo : 'pedido';

    // B7: validar pos_x/pos_y si vienen (deben ser 0-1)
    let posX: number | null = null;
    let posY: number | null = null;
    if (pos_x !== undefined && pos_x !== null && pos_x !== '') {
      const px = Number(pos_x);
      if (!Number.isFinite(px) || px < 0 || px > 1) {
        res.status(400).json({ success: false, error: 'pos_x debe estar entre 0 y 1' });
        return;
      }
      posX = px;
    }
    if (pos_y !== undefined && pos_y !== null && pos_y !== '') {
      const py = Number(pos_y);
      if (!Number.isFinite(py) || py < 0 || py > 1) {
        res.status(400).json({ success: false, error: 'pos_y debe estar entre 0 y 1' });
        return;
      }
      posY = py;
    }

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
    // Fase 2.c': campos opcionales de producto/zona
    const productId = req.body.product_id ? Number(req.body.product_id) : null;
    const cantidad = (req.body.cantidad !== undefined && req.body.cantidad !== null && req.body.cantidad !== '')
      ? Number(req.body.cantidad) : null;
    const zoneId = req.body.zone_id ? Number(req.body.zone_id) : null;
    // Campos de COMISION (productos que no facturamos, ej. Lainco)
    const esComision = !!req.body.es_comision;
    const descuento = (req.body.descuento !== undefined && req.body.descuento !== null && req.body.descuento !== '')
      ? Number(req.body.descuento) : null;
    const almacen = req.body.almacen ? String(req.body.almacen).trim().substring(0, 150) : null;
    const numSocio = req.body.num_socio ? String(req.body.num_socio).trim().substring(0, 60) : null;
    // Referencia suelta tecleada a mano (expositor: gafa que no esta en Sage)
    const referencia = req.body.referencia ? String(req.body.referencia).trim().substring(0, 120) : null;
    const r = await pool.query(
      `INSERT INTO annotations (visit_id, sheet_id, orden_en_visita, texto_libre, tipo, pos_x, pos_y, product_id, cantidad, zone_id, es_comision, descuento, almacen, num_socio, referencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [visitId, sheet_id ? Number(sheet_id) : null, orden, String(texto_libre).trim(), tipoFinal, posX, posY, productId, cantidad, zoneId, esComision, descuento, almacen, numSocio, referencia]
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
    // Fase 2.c': permitir actualizar cantidad (D2: re-pulsar zona edita cantidad)
    const cantidad = (req.body.cantidad !== undefined && req.body.cantidad !== null && req.body.cantidad !== '')
      ? Number(req.body.cantidad) : a.rows[0].cantidad;
    // Comision: actualizar descuento/almacen/num_socio si vienen (si no, conservar)
    const descuento = (req.body.descuento !== undefined && req.body.descuento !== null && req.body.descuento !== '')
      ? Number(req.body.descuento) : a.rows[0].descuento;
    const almacen = req.body.almacen !== undefined ? (req.body.almacen ? String(req.body.almacen).trim().substring(0,150) : null) : a.rows[0].almacen;
    const numSocio = req.body.num_socio !== undefined ? (req.body.num_socio ? String(req.body.num_socio).trim().substring(0,60) : null) : a.rows[0].num_socio;
    const r = await pool.query(
      `UPDATE annotations SET texto_libre = $1, tipo = $2, cantidad = $3, descuento = $4, almacen = $5, num_socio = $6 WHERE id = $7 RETURNING *`,
      [String(texto_libre).trim(), tipoFinal, cantidad, descuento, almacen, numSocio, id]
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
// Body: { notas_generales?, email_cliente_override?, no_enviar_cliente? }
app.post('/api/visits/:id/confirm', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const { notas_generales, email_cliente_override, no_enviar_cliente } = req.body;
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

    // Resumen pre-envío: opciones del comercial al confirmar
    const opciones = {
      emailClienteOverride: email_cliente_override ? String(email_cliente_override).trim() : null,
      noEnviarCliente: !!no_enviar_cliente
    };

    // C: lanzar los 3 emails (oficina + cliente + comercial) de forma asíncrona.
    // No bloqueamos la respuesta al frontend - los emails se procesan en background.
    enviarEmailsVisita(id, opciones).catch((e: any) => console.error('Error enviando emails visita ' + id + ':', e));

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
// D - PLANTILLAS DE ANOTACION (globales, gestion por admin)
// ============================================================================

// GET listar plantillas (cualquier usuario autenticado las puede leer)
app.get('/api/annotation-templates', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT * FROM annotation_templates ORDER BY orden, id`
    );
    res.json({ success: true, templates: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST crear plantilla (admin real)
app.post('/api/annotation-templates', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { texto, tipo } = req.body;
    if (!texto || !String(texto).trim()) {
      res.status(400).json({ success: false, error: 'texto obligatorio' });
      return;
    }
    const tipoFinal = ['pedido','devolucion','nota'].includes(tipo) ? tipo : 'pedido';
    // clase solo aplica a PEDIDO (descuento % / bonificacion); en el resto va null
    const claseFinal = (tipoFinal === 'pedido' && ['descuento','bonificacion','normal'].includes(req.body.clase)) ? req.body.clase : null;
    const maxR = await pool.query(`SELECT COALESCE(MAX(orden),0) AS m FROM annotation_templates`);
    const orden = Number(maxR.rows[0].m) + 1;
    const r = await pool.query(
      `INSERT INTO annotation_templates (texto, tipo, orden, clase) VALUES ($1, $2, $3, $4) RETURNING *`,
      [String(texto).trim().substring(0, 150), tipoFinal, orden, claseFinal]
    );
    res.status(201).json({ success: true, template: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// PUT editar plantilla (admin real)
app.put('/api/annotation-templates/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { texto, tipo } = req.body;
    if (!texto || !String(texto).trim()) {
      res.status(400).json({ success: false, error: 'texto obligatorio' });
      return;
    }
    const tipoFinal = ['pedido','devolucion','nota'].includes(tipo) ? tipo : 'pedido';
    const claseFinal = (tipoFinal === 'pedido' && ['descuento','bonificacion','normal'].includes(req.body.clase)) ? req.body.clase : null;
    const r = await pool.query(
      `UPDATE annotation_templates SET texto=$1, tipo=$2, clase=$3, updated_at=NOW() WHERE id=$4 RETURNING *`,
      [String(texto).trim().substring(0, 150), tipoFinal, claseFinal, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Plantilla no encontrada' });
      return;
    }
    res.json({ success: true, template: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// DELETE borrar plantilla (admin real)
app.delete('/api/annotation-templates/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`DELETE FROM annotation_templates WHERE id = $1 RETURNING id`, [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Plantilla no encontrada' });
      return;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// PUT reordenar plantillas (admin real)
// Body: { ids: [3, 1, 4, 2] }
app.put('/api/annotation-templates/reorder', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      res.status(400).json({ success: false, error: 'ids debe ser array' });
      return;
    }
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(`UPDATE annotation_templates SET orden = $1, updated_at = NOW() WHERE id = $2`,
        [i + 1, Number(ids[i])]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ success: false, error: (e as Error).message });
  } finally {
    client.release();
  }
});

// ============================================================================
// D - PDF DE VISITA (resumen texto) - función reutilizable
// ============================================================================
const PDFDocumentLib = require('pdfkit');

// Carga los datos completos de una visita (con joins). Usado por PDF y emails.
async function cargarDatosVisitaCompleta(visitId: number) {
  const v = await pool.query(`
    SELECT v.*, c.razon_social AS cliente_nombre, c.cif AS cliente_cif,
           c.direccion AS cliente_direccion, c.cp AS cliente_cp,
           c.municipio AS cliente_municipio, c.provincia AS cliente_provincia,
           c.telefono AS cliente_telefono, c.email AS cliente_email,
           c.email_alternativo AS cliente_email_alternativo,
           c.sage_code AS cliente_sage,
           cat.name AS catalog_nombre,
           u.name AS comercial_nombre, u.email AS comercial_email
    FROM visits v
    LEFT JOIN clients c ON c.id = v.client_id
    LEFT JOIN catalogs cat ON cat.id = v.catalog_id
    LEFT JOIN users u ON u.id = v.user_id
    WHERE v.id = $1`, [visitId]);
  if (v.rows.length === 0) return null;
  const visit = v.rows[0];
  const anots = await pool.query(`
    SELECT a.*, s.titulo AS sheet_titulo, s.orden AS sheet_orden, s.tags AS sheet_tags,
           p.codigo AS producto_codigo, p.nombre AS producto_nombre,
           p.ean AS producto_ean, p.precio_pvf AS producto_pvf
    FROM annotations a
    LEFT JOIN sheets s ON s.id = a.sheet_id
    LEFT JOIN products p ON p.id = a.product_id
    WHERE a.visit_id = $1
    ORDER BY a.orden_en_visita, a.id`, [visitId]);
  return { visit, annotations: anots.rows };
}

// Genera el PDF de una visita como Buffer (para descarga o adjunto email)
function generarPdfVisitaBuffer(visit: any, annotations: any[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocumentLib({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fecha = visit.confirmed_at
        ? new Date(visit.confirmed_at).toLocaleDateString('es-ES')
        : new Date(visit.created_at).toLocaleDateString('es-ES');

      // ---------- CABECERA ----------
      doc.fontSize(18).fillColor('#cc007a').text('LOMHIFAR S.L.', { align: 'left' });
      doc.fontSize(9).fillColor('#666').text('Distribución de productos parafarmacéuticos');
      doc.moveDown(0.5);
      doc.fontSize(14).fillColor('#000').text('Resumen de visita comercial');
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#666').text(`Generado: ${new Date().toLocaleString('es-ES')}`);
      doc.moveDown(0.8);
      doc.strokeColor('#cc007a').lineWidth(1.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.8);

      // ---------- DATOS CLIENTE ----------
      doc.fontSize(11).fillColor('#000').font('Helvetica-Bold').text('Cliente');
      doc.font('Helvetica').fontSize(10).fillColor('#000');
      const addLine = (label: string, val: any) => {
        if (val == null || val === '') return;
        doc.font('Helvetica-Bold').text(label + ': ', { continued: true })
           .font('Helvetica').text(String(val));
      };
      addLine('Razón social', visit.cliente_nombre);
      addLine('Código Sage', visit.cliente_sage);
      addLine('CIF', visit.cliente_cif);
      const direccion = [visit.cliente_direccion, visit.cliente_cp, visit.cliente_municipio, visit.cliente_provincia].filter((x: any) => !!x).join(', ');
      if (direccion) addLine('Dirección', direccion);
      addLine('Teléfono', visit.cliente_telefono);
      addLine('Email', visit.cliente_email);
      doc.moveDown(0.6);

      // ---------- DATOS VISITA ----------
      doc.font('Helvetica-Bold').fontSize(11).text('Visita');
      doc.font('Helvetica').fontSize(10);
      addLine('Fecha', fecha);
      addLine('Comercial', visit.comercial_nombre);
      addLine('Catálogo mostrado', visit.catalog_nombre);
      addLine('Estado', visit.status === 'confirmed' ? 'Cerrada' : visit.status === 'sent' ? 'Enviada' : 'Borrador');
      doc.moveDown(0.6);

      // ---------- ANOTACIONES ----------
      const grupos: any = { pedido: [], devolucion: [], nota: [] };
      annotations.forEach((a: any) => {
        if (grupos[a.tipo]) grupos[a.tipo].push(a);
        else grupos.nota.push(a);
      });

      const pintarGrupo = (titulo: string, items: any[], color: string) => {
        if (items.length === 0) return;
        if (doc.y > 720) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(11).fillColor(color).text(titulo);
        doc.moveDown(0.3);

        // Separar items CON producto (tabla) de los de solo texto libre
        const conProducto = items.filter((a: any) => a.product_id);
        const sinProducto = items.filter((a: any) => !a.product_id);

        // ---- TABLA de productos ----
        if (conProducto.length > 0) {
          const x0 = 40;
          const colCod = x0;
          const colNom = x0 + 75;
          const colCant = x0 + 320;
          const colPvf = x0 + 375;
          const colSub = x0 + 455;
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#666');
          let yH = doc.y;
          doc.text('CÓDIGO', colCod, yH);
          doc.text('PRODUCTO', colNom, yH);
          doc.text('CANT', colCant, yH);
          doc.text('PVF', colPvf, yH);
          doc.text('SUBTOTAL', colSub, yH);
          doc.moveDown(0.2);
          doc.strokeColor('#ddd').lineWidth(0.5).moveTo(x0, doc.y).lineTo(555, doc.y).stroke();
          doc.moveDown(0.2);

          let totalGrupo = 0;
          conProducto.forEach((a: any) => {
            if (doc.y > 770) doc.addPage();
            const cant = a.cantidad || 0;
            const pvf = a.producto_pvf != null ? Number(a.producto_pvf) : null;
            const sub = (pvf != null && cant) ? pvf * cant : null;
            if (sub != null) totalGrupo += sub;
            const yR = doc.y;
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text(String(a.producto_codigo || '—'), colCod, yR, { width: 72 });
            doc.font('Helvetica').fontSize(8).text(String(a.producto_nombre || '').substring(0, 60), colNom, yR, { width: 240 });
            doc.fontSize(9).text(cant ? String(cant) : '—', colCant, yR, { width: 50 });
            doc.text(pvf != null ? pvf.toFixed(2) + '€' : '—', colPvf, yR, { width: 75 });
            doc.text(sub != null ? sub.toFixed(2) + '€' : '—', colSub, yR, { width: 95 });
            doc.moveDown(0.5);
          });
          doc.strokeColor('#ddd').lineWidth(0.5).moveTo(x0, doc.y).lineTo(555, doc.y).stroke();
          doc.moveDown(0.2);
          doc.font('Helvetica-Bold').fontSize(9).fillColor(color)
             .text('TOTAL PVF: ' + totalGrupo.toFixed(2) + '€', x0, doc.y, { width: 510, align: 'right' });
          doc.fillColor('#000');
          doc.moveDown(0.5);
        }

        // ---- Items de texto libre (sin producto) ----
        if (sinProducto.length > 0) {
          doc.font('Helvetica').fontSize(10).fillColor('#000');
          sinProducto.forEach((a: any) => {
            if (doc.y > 770) doc.addPage();
            const num = a.sheet_orden ? `Lám.${a.sheet_orden}` : '—';
            const tit = a.sheet_titulo ? ` · ${a.sheet_titulo}` : '';
            doc.font('Helvetica-Bold').text(`• ${num}${tit}`);
            doc.font('Helvetica').fillColor('#222').text(`    ${a.texto_libre}`);
            doc.fillColor('#000');
            doc.moveDown(0.2);
          });
        }
        doc.moveDown(0.4);
      };

      pintarGrupo('PEDIDOS (' + grupos.pedido.length + ')', grupos.pedido, '#166534');
      pintarGrupo('DEVOLUCIONES (' + grupos.devolucion.length + ')', grupos.devolucion, '#92400e');
      pintarGrupo('NOTAS (' + grupos.nota.length + ')', grupos.nota, '#374151');

      if (annotations.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#666')
           .text('Esta visita no tiene anotaciones registradas.');
        doc.moveDown(0.6);
      }

      // ---------- NOTAS GENERALES ----------
      if (visit.notas_generales && String(visit.notas_generales).trim()) {
        if (doc.y > 700) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Notas generales');
        doc.font('Helvetica').fontSize(10).fillColor('#222').text(visit.notas_generales);
        doc.moveDown(0.5);
      }

      // ---------- PIE ----------
      doc.fontSize(8).fillColor('#999').text(
        'LOMHIFAR S.L. · Documento generado automáticamente por CatalogPRO v2',
        40, 800, { width: 515, align: 'center' }
      );
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function nombrePdfVisita(visit: any): string {
  const fecha = visit.confirmed_at
    ? new Date(visit.confirmed_at).toLocaleDateString('es-ES')
    : new Date(visit.created_at).toLocaleDateString('es-ES');
  return `visita_${visit.cliente_sage || visit.client_id}_${fecha.replace(/\//g, '-')}.pdf`;
}

app.get('/api/visits/:id/pdf', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const datos = await cargarDatosVisitaCompleta(id);
    if (!datos) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    const { visit, annotations } = datos;
    if (isEffectiveSales(req) && visit.user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    const buffer = await generarPdfVisitaBuffer(visit, annotations);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nombrePdfVisita(visit)}"`);
    res.end(buffer);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  }
});

// Endpoint para enviar un PDF de backup local por email (lo usa la pantalla "Mis pedidos guardados")
const uploadBackupMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB máx
});
app.post('/api/backup/enviar-email', verifyToken, uploadBackupMem.single('adjunto'),
  async (req: AuthRequest, res: Response) => {
  try {
    const destinatario = (req.body?.destinatario || '').trim();
    const asunto = (req.body?.asunto || '').trim() || 'Pedido LOMHIFAR';
    const cuerpo = (req.body?.cuerpo || '').trim();
    if (!destinatario || !destinatario.includes('@')) {
      res.status(400).json({ success: false, error: 'Email destinatario no válido' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Falta el archivo adjunto' });
      return;
    }
    // Construir HTML con el cuerpo (preservando saltos de línea)
    const cuerpoHtml = escapeHtml(cuerpo).replace(/\n/g, '<br>');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background:#cc007a;color:white;padding:14px 20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:18px">📦 Pedido LOMHIFAR</h2>
        </div>
        <div style="padding:18px;background:#fff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
          <div style="font-size:14px;color:#333;line-height:1.6">
            ${cuerpoHtml || 'Adjunto el pedido en PDF.'}
          </div>
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0">
          <div style="font-size:12px;color:#9ca3af">
            Email enviado desde CatalogPRO v2 — LOMHIFAR S.L.
          </div>
        </div>
      </div>
    `;
    const result = await enviarEmailConRedireccion({
      rol: 'cliente',
      destinatarioReal: destinatario,
      asunto,
      html,
      attachments: [{
        filename: req.file.originalname || 'pedido.pdf',
        content: req.file.buffer,
        contentType: req.file.mimetype || 'application/pdf'
      }]
    });
    if (!result.ok) {
      res.status(500).json({ success: false, error: result.error || 'No se pudo enviar el email' });
      return;
    }
    res.json({ success: true, destinatarioFinal: result.destinatarioFinal, modo: result.modo });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// C - EMAILS AL CERRAR VISITA (nodemailer + Gmail SMTP)
// ============================================================================
const nodemailer = require('nodemailer');

// Lee toda la config de emails de la BD como objeto
async function leerEmailConfig(): Promise<Record<string,string>> {
  const r = await pool.query(`SELECT clave, valor FROM email_config`);
  const cfg: Record<string,string> = {};
  r.rows.forEach((row: any) => { cfg[row.clave] = row.valor || ''; });
  return cfg;
}

// Construye el transporter de nodemailer con las vars de entorno (Gmail SMTP)
let _transporterCache: any = null;
function getTransporter() {
  if (_transporterCache) return _transporterCache;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || '587');
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  _transporterCache = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    // Margen de tiempo amplio: Gmail puede tardar
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
  return _transporterCache;
}

// Helper central: envia 1 email con redireccion automatica si estamos en modo pruebas.
// Argumentos:
//   rol: 'oficina' | 'cliente' | 'comercial' - para saber si redirigir y a donde
//   destinatarioReal: email "real" al que iria en produccion
//   asunto, html, attachments?
// Devuelve: { ok, destinatario_final, message_id?, error?, modo }
async function enviarEmailConRedireccion(opts: {
  rol: 'oficina' | 'cliente' | 'comercial';
  destinatarioReal: string;
  asunto: string;
  html: string;
  attachments?: any[];
  visitId?: number;
}): Promise<{ok: boolean; destinatarioFinal: string; messageId?: string; error?: string; modo: string;}> {
  const cfg = await leerEmailConfig();
  const modo = cfg.modo === 'produccion' ? 'produccion' : 'pruebas';
  const from = process.env.SMTP_FROM || cfg.remitente_from || '"CatalogPRO" <noreply@example.com>';

  // Decidir destinatario final segun modo
  let destinatarioFinal = '';
  let asuntoFinal = opts.asunto;
  let htmlFinal = opts.html;
  if (modo === 'pruebas') {
    // Redirigir al email de prueba correspondiente al rol
    if (opts.rol === 'oficina')   destinatarioFinal = cfg.pruebas_email_oficina   || '';
    if (opts.rol === 'cliente')   destinatarioFinal = cfg.pruebas_email_cliente   || '';
    if (opts.rol === 'comercial') destinatarioFinal = cfg.pruebas_email_comercial || '';
    if (!destinatarioFinal) {
      return { ok: false, destinatarioFinal: '', error: `Modo pruebas pero no hay email de pruebas configurado para rol "${opts.rol}". Ve a Configuración.`, modo };
    }
    // Marcar claramente el email
    asuntoFinal = `[PRUEBA → ${opts.destinatarioReal || '(sin destinatario real)'}] ${opts.asunto}`;
    htmlFinal = `
      <div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:12px;margin-bottom:16px">
        <div style="font-weight:bold;color:#92400e;font-size:14px">⚠️ Este email es una PRUEBA</div>
        <div style="color:#78350f;font-size:13px;margin-top:4px">
          En modo producción habría ido a: <b>${opts.destinatarioReal || '(sin destinatario real)'}</b><br>
          Rol: <b>${opts.rol}</b>
        </div>
      </div>
      ${opts.html}
    `;
  } else {
    // Modo produccion: usar destinatario real
    destinatarioFinal = opts.destinatarioReal;
    if (!destinatarioFinal) {
      return { ok: false, destinatarioFinal: '', error: `Modo producción pero no hay destinatario real para rol "${opts.rol}".`, modo };
    }
  }

  // Enviar
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from,
      to: destinatarioFinal,
      subject: asuntoFinal,
      html: htmlFinal,
      attachments: opts.attachments || []
    });
    return { ok: true, destinatarioFinal, messageId: info.messageId, modo };
  } catch (e) {
    return { ok: false, destinatarioFinal, error: (e as Error).message, modo };
  }
}

// Plantillas HTML
function plantillaEmailOficina(visit: any, annotations: any[], cfg: Record<string,string>): string {
  const fecha = visit.confirmed_at ? new Date(visit.confirmed_at).toLocaleString('es-ES') : new Date(visit.created_at).toLocaleString('es-ES');
  const peds = annotations.filter((a: any) => a.tipo === 'pedido');
  const devs = annotations.filter((a: any) => a.tipo === 'devolucion');
  const nots = annotations.filter((a: any) => a.tipo === 'nota');
  const grupo = (titulo: string, items: any[], color: string) => {
    if (items.length === 0) return '';
    const conProducto = items.filter((a: any) => a.product_id);
    const sinProducto = items.filter((a: any) => !a.product_id);
    let html = `<h3 style="color:${color};margin-top:18px;margin-bottom:6px;font-size:15px">${titulo} (${items.length})</h3>`;

    // Tabla de productos
    if (conProducto.length > 0) {
      let total = 0;
      html += `
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px">
          <thead>
            <tr style="background:#f3f4f6;text-align:left">
              <th style="padding:6px 8px;border-bottom:2px solid ${color}">Código</th>
              <th style="padding:6px 8px;border-bottom:2px solid ${color}">Producto</th>
              <th style="padding:6px 8px;border-bottom:2px solid ${color};text-align:center">Cant</th>
              <th style="padding:6px 8px;border-bottom:2px solid ${color};text-align:right">PVF</th>
              <th style="padding:6px 8px;border-bottom:2px solid ${color};text-align:right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${conProducto.map((a: any) => {
              const cant = a.cantidad || 0;
              const pvf = a.producto_pvf != null ? Number(a.producto_pvf) : null;
              const sub = (pvf != null && cant) ? pvf * cant : null;
              if (sub != null) total += sub;
              return `
                <tr>
                  <td style="padding:6px 8px;border-bottom:1px solid #eee"><b>${escapeHtml(a.producto_codigo || '—')}</b></td>
                  <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(a.producto_nombre || '')}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">${cant || '—'}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${pvf != null ? pvf.toFixed(2) + '€' : '—'}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${sub != null ? sub.toFixed(2) + '€' : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4" style="padding:8px;text-align:right;font-weight:bold;color:${color}">TOTAL PVF:</td>
              <td style="padding:8px;text-align:right;font-weight:bold;color:${color}">${total.toFixed(2)}€</td>
            </tr>
          </tfoot>
        </table>
      `;
    }

    // Items de texto libre
    if (sinProducto.length > 0) {
      html += `
        <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6">
          ${sinProducto.map((a: any) => `
            <li>
              <b>${a.sheet_orden ? 'Lám.' + a.sheet_orden : '—'}${a.sheet_titulo ? ' · ' + escapeHtml(a.sheet_titulo) : ''}</b><br>
              <span style="color:#444">${escapeHtml(a.texto_libre)}</span>
            </li>
          `).join('')}
        </ul>
      `;
    }
    return html;
  };
  return `
    <div style="font-family:Arial,sans-serif;color:#222;max-width:680px">
      <h2 style="color:#cc007a;margin:0 0 4px">📋 Nueva visita cerrada</h2>
      <div style="color:#666;font-size:13px">${escapeHtml(fecha)}</div>
      <table style="margin-top:14px;font-size:14px;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Cliente:</b></td><td>${escapeHtml(visit.cliente_nombre || '—')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Código Sage:</b></td><td>${escapeHtml(visit.cliente_sage || '—')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>CIF:</b></td><td>${escapeHtml(visit.cliente_cif || '—')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Comercial:</b></td><td>${escapeHtml(visit.comercial_nombre || '—')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Catálogo:</b></td><td>${escapeHtml(visit.catalog_nombre || '—')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Resultado:</b></td><td>${visit.hubo_pedido ? '<b style="color:#166534">🛒 Con pedido</b>' : '<span style="color:#6b7280">Sin pedido</span>'}</td></tr>
      </table>
      ${grupo('PEDIDOS', peds, '#166534')}
      ${grupo('DEVOLUCIONES', devs, '#92400e')}
      ${grupo('NOTAS', nots, '#374151')}
      ${visit.notas_generales ? `
        <h3 style="margin-top:18px;margin-bottom:6px;font-size:15px">Notas generales</h3>
        <p style="white-space:pre-wrap;font-size:14px;background:#f9f9f9;padding:10px;border-radius:6px">${escapeHtml(visit.notas_generales)}</p>
      ` : ''}
      <p style="margin-top:24px;color:#666;font-size:13px">Adjunto el PDF resumen para procesar el pedido.</p>
      ${cfg.firma_html || ''}
    </div>
  `;
}

function plantillaEmailCliente(visit: any, annotations: any[], cfg: Record<string,string>): string {
  const fecha = visit.confirmed_at ? new Date(visit.confirmed_at).toLocaleDateString('es-ES') : new Date(visit.created_at).toLocaleDateString('es-ES');
  const peds = annotations.filter((a: any) => a.tipo === 'pedido');
  const devs = annotations.filter((a: any) => a.tipo === 'devolucion');
  return `
    <div style="font-family:Arial,sans-serif;color:#222;max-width:680px">
      <h2 style="color:#cc007a;margin:0 0 8px">Visita comercial — Resumen</h2>
      <p style="font-size:14px">Hola,</p>
      <p style="font-size:14px">Le confirmamos que <b>${escapeHtml(visit.comercial_nombre || 'un comercial de LOMHIFAR')}</b> ha visitado <b>${escapeHtml(visit.cliente_nombre || '')}</b> el ${escapeHtml(fecha)}.</p>
      ${peds.length > 0 ? `
        <h3 style="color:#166534;margin-top:18px;margin-bottom:6px;font-size:15px">Pedido (${peds.length})</h3>
        <ul style="font-size:14px;line-height:1.7">
          ${peds.map((a: any) => `<li><b>${a.sheet_titulo ? escapeHtml(a.sheet_titulo) : 'Lám.' + (a.sheet_orden || '—')}</b>: ${escapeHtml(a.texto_libre)}</li>`).join('')}
        </ul>
      ` : ''}
      ${devs.length > 0 ? `
        <h3 style="color:#92400e;margin-top:18px;margin-bottom:6px;font-size:15px">Devoluciones (${devs.length})</h3>
        <ul style="font-size:14px;line-height:1.7">
          ${devs.map((a: any) => `<li><b>${a.sheet_titulo ? escapeHtml(a.sheet_titulo) : 'Lám.' + (a.sheet_orden || '—')}</b>: ${escapeHtml(a.texto_libre)}</li>`).join('')}
        </ul>
      ` : ''}
      ${peds.length === 0 && devs.length === 0 ? `
        <p style="font-size:14px;background:#f3f4f6;padding:10px;border-radius:6px;color:#374151">En esta visita no se registró pedido. Si detecta alguna discrepancia, contacte con nosotros.</p>
      ` : ''}
      <p style="margin-top:24px;font-size:14px">Nuestro equipo procesará el pedido a la mayor brevedad. Si necesita modificar algo, no dude en contactar con su comercial.</p>
      <p style="font-size:14px">Gracias por confiar en LOMHIFAR.</p>
      ${cfg.firma_html || ''}
    </div>
  `;
}

function plantillaEmailComercial(visit: any, annotations: any[], cfg: Record<string,string>): string {
  const fecha = visit.confirmed_at ? new Date(visit.confirmed_at).toLocaleString('es-ES') : new Date(visit.created_at).toLocaleString('es-ES');
  return `
    <div style="font-family:Arial,sans-serif;color:#222;max-width:680px">
      <h2 style="color:#cc007a;margin:0 0 4px">✅ Visita registrada</h2>
      <p style="font-size:14px">Hola ${escapeHtml(visit.comercial_nombre || '')},</p>
      <p style="font-size:14px">Tu visita con <b>${escapeHtml(visit.cliente_nombre || '')}</b> del ${escapeHtml(fecha)} ha sido registrada correctamente.</p>
      <table style="margin-top:14px;font-size:14px">
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Anotaciones totales:</b></td><td>${annotations.length}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Pedidos:</b></td><td>${annotations.filter((a: any) => a.tipo === 'pedido').length}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Devoluciones:</b></td><td>${annotations.filter((a: any) => a.tipo === 'devolucion').length}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Notas:</b></td><td>${annotations.filter((a: any) => a.tipo === 'nota').length}</td></tr>
      </table>
      <p style="margin-top:20px;font-size:14px;color:#666">Adjunto el PDF como copia para tu archivo personal.</p>
      ${cfg.firma_html || ''}
    </div>
  `;
}

// Helper escapado HTML basico
function escapeHtml(s: any): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// EE1+FF3+GG3: notificar a comerciales asignados cuando se cierra una versión nueva.
// Fire-and-forget: si algo falla, solo se loguea, no rompe el cierre de versión.
// Respeta el toggle ON/OFF de cada comercial (recibir_notificaciones).
async function notificarComercialesNuevaVersion(catalogId: number, versionCerrada: number, totalLaminas: number, cerradorId: number | null) {
  try {
    // 1) Cargar info del catálogo
    const catR = await pool.query(`SELECT id, name, tipo FROM catalogs WHERE id = $1`, [catalogId]);
    if (catR.rows.length === 0) return;
    const cat = catR.rows[0];

    // 2) Nombre del admin que cerró la versión (si lo conocemos)
    let nombreCerrador = 'el administrador';
    if (cerradorId) {
      const adminR = await pool.query(`SELECT name FROM users WHERE id = $1`, [cerradorId]);
      if (adminR.rows.length > 0) nombreCerrador = adminR.rows[0].name;
    }

    // 3) Buscar comerciales asignados a este catálogo, activos y con notificaciones ON
    const comerciales = await pool.query(`
      SELECT u.id, u.email, u.name
      FROM users u
      JOIN catalog_assignments ca ON ca.user_id = u.id
      WHERE ca.catalog_id = $1
        AND u.is_active = TRUE
        AND u.role = 'sales'
        AND COALESCE(u.recibir_notificaciones, TRUE) = TRUE
        AND u.email IS NOT NULL AND u.email <> ''
    `, [catalogId]);

    if (comerciales.rows.length === 0) {
      console.log('[notif] Sin comerciales asignados a notificar para catálogo ' + catalogId);
      return;
    }

    // 4) Enlace a la app (Railway URL desde env o fallback)
    const appUrl = process.env.APP_PUBLIC_URL || 'https://catalogo-pro-v2-production.up.railway.app';

    // 5) HTML del email (FF3: aviso + resumen + enlace)
    const asunto = `📚 Nueva versión disponible · ${cat.name}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333">
        <div style="background: linear-gradient(135deg, #cc007a 0%, #a3005f 100%); color: #fff; padding: 24px; border-radius: 8px 8px 0 0">
          <h2 style="margin: 0; font-size: 20px">📚 Nueva versión del catálogo</h2>
          <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px">CatalogPRO · LOMHIFAR</p>
        </div>
        <div style="background: #fff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px">
          <p style="margin: 0 0 14px 0; font-size: 14px">Hola,</p>
          <p style="margin: 0 0 14px 0; font-size: 14px">
            <b>${escapeHtml(nombreCerrador)}</b> acaba de cerrar una nueva versión de uno de tus catálogos asignados:
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 14px 0">
            <div style="font-size: 16px; font-weight: 600; color: #111827; margin-bottom: 8px">
              ${escapeHtml(cat.name)} ${cat.tipo === 'express' ? '<span style="background:#eff6ff;color:#1e40af;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600">EXPRESS</span>' : ''}
            </div>
            <div style="font-size: 13px; color: #6b7280">
              📌 Versión <b>${versionCerrada}</b> · 📄 ${totalLaminas} láminas
            </div>
          </div>
          <p style="margin: 14px 0; font-size: 14px">
            Abre la app y sincroniza para tener las novedades en tu dispositivo:
          </p>
          <div style="text-align: center; margin: 24px 0">
            <a href="${appUrl}" style="display: inline-block; background: #cc007a; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px">
              🚀 Abrir CatalogPRO
            </a>
          </div>
          <hr style="border: none; border-top: 1px solid #f3f4f6; margin: 20px 0">
          <p style="font-size: 11px; color: #9ca3af; margin: 0">
            Recibes este email porque tienes activadas las notificaciones en tu cuenta.
            Para desactivarlas, entra a la app → <b>Mi cuenta</b> → Notificaciones.
          </p>
        </div>
      </div>
    `;

    // 6) Enviar a cada comercial (en paralelo, fire-and-forget)
    let okCount = 0, errCount = 0;
    for (const com of comerciales.rows) {
      try {
        const r = await enviarEmailConRedireccion({
          rol: 'comercial',
          destinatarioReal: com.email,
          asunto,
          html
        });
        if (r.ok) okCount++; else errCount++;
      } catch (e: any) {
        errCount++;
        console.error('[notif] Error enviando a ' + com.email + ':', e.message);
      }
    }
    console.log(`[notif] Catálogo ${catalogId} v${versionCerrada}: ${okCount} OK, ${errCount} fallidos de ${comerciales.rows.length}`);
  } catch (e: any) {
    console.error('[notif] Error global notificando nueva versión:', e.message);
  }
}

// Funcion principal: envia los 3 emails al cerrar visita
// Se llama de forma asincrona (fire-and-forget) desde POST /api/visits/:id/confirm
async function enviarEmailsVisita(visitId: number, opciones?: { emailClienteOverride?: string | null; noEnviarCliente?: boolean }) {
  try {
    const datos = await cargarDatosVisitaCompleta(visitId);
    if (!datos) return;
    const { visit, annotations } = datos;
    const cfg = await leerEmailConfig();
    const fecha = visit.confirmed_at ? new Date(visit.confirmed_at).toLocaleDateString('es-ES') : new Date(visit.created_at).toLocaleDateString('es-ES');
    const asuntoBase = `Visita ${fecha} · ${visit.cliente_nombre || 'Cliente'}`;

    // Generar PDF una sola vez
    let pdfBuffer: Buffer | null = null;
    try {
      pdfBuffer = await generarPdfVisitaBuffer(visit, annotations);
    } catch (e) {
      console.error('Error generando PDF para visita ' + visitId + ':', (e as Error).message);
    }
    const pdfFilename = nombrePdfVisita(visit);
    const adjuntoPdf = pdfBuffer ? [{ filename: pdfFilename, content: pdfBuffer, contentType: 'application/pdf' }] : [];

    // 1) Email a oficina (con PDF adjunto)
    const oficinaEmails = (cfg.oficina_emails || '').split(',').map(s => s.trim()).filter(Boolean);
    if (oficinaEmails.length > 0 || cfg.modo === 'pruebas') {
      const oficinaReal = oficinaEmails.join(', ');
      const r = await enviarEmailConRedireccion({
        rol: 'oficina',
        destinatarioReal: oficinaReal,
        asunto: `[OFICINA] ${asuntoBase}`,
        html: plantillaEmailOficina(visit, annotations, cfg),
        attachments: adjuntoPdf,
        visitId
      });
      await pool.query(
        `INSERT INTO visit_emails (visit_id, destinatario, destinatario_real, rol, modo, asunto, ok, error, message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [visitId, r.destinatarioFinal, oficinaReal, 'oficina', r.modo, `[OFICINA] ${asuntoBase}`, r.ok, r.error || null, r.messageId || null]
      );
    }

    // 2) Email al cliente (sin PDF para que sea ligero - confirmacion simple)
    // Resumen pre-envío: el comercial puede haber pedido NO enviar al cliente,
    // o haber especificado un email distinto al del cliente (override).
    const noEnviarCliente = opciones?.noEnviarCliente === true;
    const clienteReal = noEnviarCliente
      ? ''
      : (opciones?.emailClienteOverride || visit.cliente_email || '');
    if (!noEnviarCliente && (clienteReal || cfg.modo === 'pruebas')) {
      const r = await enviarEmailConRedireccion({
        rol: 'cliente',
        destinatarioReal: clienteReal,
        asunto: asuntoBase,
        html: plantillaEmailCliente(visit, annotations, cfg),
        visitId
      });
      await pool.query(
        `INSERT INTO visit_emails (visit_id, destinatario, destinatario_real, rol, modo, asunto, ok, error, message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [visitId, r.destinatarioFinal, clienteReal, 'cliente', r.modo, asuntoBase, r.ok, r.error || null, r.messageId || null]
      );
    }

    // 3) Email al comercial (con PDF adjunto, copia personal)
    const comercialReal = visit.comercial_email || '';
    if (comercialReal || cfg.modo === 'pruebas') {
      const r = await enviarEmailConRedireccion({
        rol: 'comercial',
        destinatarioReal: comercialReal,
        asunto: `[COPIA] ${asuntoBase}`,
        html: plantillaEmailComercial(visit, annotations, cfg),
        attachments: adjuntoPdf,
        visitId
      });
      await pool.query(
        `INSERT INTO visit_emails (visit_id, destinatario, destinatario_real, rol, modo, asunto, ok, error, message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [visitId, r.destinatarioFinal, comercialReal, 'comercial', r.modo, `[COPIA] ${asuntoBase}`, r.ok, r.error || null, r.messageId || null]
      );
    }
  } catch (e) {
    console.error('Error en enviarEmailsVisita(' + visitId + '):', (e as Error).message);
  }
}

// ============================================================================
// C - ENDPOINTS DE CONFIG DE EMAIL Y LOG DE ENVIOS
// ============================================================================

// GET config actual de emails (admin real)
app.get('/api/email-config', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`SELECT clave, valor, descripcion FROM email_config ORDER BY clave`);
    res.json({ success: true, config: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// PUT actualizar varios valores de config a la vez (admin real)
// Body: { values: { clave: valor, clave2: valor2, ... } }
app.put('/api/email-config', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const { values } = req.body;
    if (!values || typeof values !== 'object') {
      res.status(400).json({ success: false, error: 'Falta body.values con las claves a actualizar' });
      return;
    }
    await client.query('BEGIN');
    for (const k of Object.keys(values)) {
      const v = values[k] == null ? '' : String(values[k]);
      // Solo actualiza si la clave existe (no permitimos crear claves nuevas via PUT)
      await client.query(
        `UPDATE email_config SET valor = $1, updated_at = NOW() WHERE clave = $2`,
        [v, k]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ success: false, error: (e as Error).message });
  } finally {
    client.release();
  }
});

// POST email de prueba SMTP (verificar configuracion)
// Body: { to: 'email@ejemplo.com' }
app.post('/api/email-config/test', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { to } = req.body;
    if (!to) {
      res.status(400).json({ success: false, error: 'Falta destinatario "to"' });
      return;
    }
    const cfg = await leerEmailConfig();
    const transporter = getTransporter();
    const from = process.env.SMTP_FROM || cfg.remitente_from || '"CatalogPRO" <noreply@example.com>';
    const info = await transporter.sendMail({
      from,
      to,
      subject: 'CatalogPRO v2 - Prueba de envío SMTP',
      html: `
        <div style="font-family:Arial,sans-serif">
          <h2 style="color:#cc007a">✅ Prueba de envío correcta</h2>
          <p>Si recibes este email, la configuración SMTP de CatalogPRO v2 está funcionando.</p>
          <p style="color:#666;font-size:12px">Enviado: ${new Date().toLocaleString('es-ES')}</p>
        </div>
      `
    });
    res.json({ success: true, message_id: info.messageId });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// GET log de emails enviados de una visita
app.get('/api/visits/:id/emails', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    // Comprobar acceso
    const v = await pool.query(`SELECT user_id FROM visits WHERE id = $1`, [id]);
    if (v.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    if (isEffectiveSales(req) && v.rows[0].user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    const r = await pool.query(
      `SELECT * FROM visit_emails WHERE visit_id = $1 ORDER BY sent_at`,
      [id]
    );
    res.json({ success: true, emails: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST reenviar TODOS los emails de una visita (admin o dueño de visita)
app.post('/api/visits/:id/resend-emails', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const v = await pool.query(`SELECT user_id, status FROM visits WHERE id = $1`, [id]);
    if (v.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    if (isEffectiveSales(req) && v.rows[0].user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    if (v.rows[0].status !== 'confirmed' && v.rows[0].status !== 'sent') {
      res.status(400).json({ success: false, error: 'Solo se pueden reenviar emails de visitas cerradas' });
      return;
    }
    // Lanzar reenvio (async, no esperamos)
    enviarEmailsVisita(id).catch(e => console.error('Error reenvio emails visita ' + id + ':', e));
    res.json({ success: true, message: 'Reenvío en curso. Revisa el log en unos segundos.' });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// POST reenviar SOLO el email del cliente a una direccion puntual (caso "el cliente
// llama diciendo que no lo recibe y pide que lo mandes a otra direccion").
// Body: { email: 'destino@ej.com', guardar_en_cliente?: boolean }
// Si guardar_en_cliente=true ademas sobrescribe clients.email_alternativo.
app.post('/api/visits/:id/resend-to-custom', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = effectiveUserId(req);
    const { email, guardar_en_cliente } = req.body;
    if (!email || !String(email).trim()) {
      res.status(400).json({ success: false, error: 'Falta email destino' });
      return;
    }
    const emailDest = String(email).trim();
    // Validación básica de email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailDest)) {
      res.status(400).json({ success: false, error: 'Email no válido' });
      return;
    }
    // Cargar visita completa para verificar permisos y generar email
    const datos = await cargarDatosVisitaCompleta(id);
    if (!datos) {
      res.status(404).json({ success: false, error: 'Visita no encontrada' });
      return;
    }
    const { visit, annotations } = datos;
    if (isEffectiveSales(req) && visit.user_id !== userId) {
      res.status(403).json({ success: false, error: 'No tienes acceso a esta visita' });
      return;
    }
    if (visit.status !== 'confirmed' && visit.status !== 'sent') {
      res.status(400).json({ success: false, error: 'Solo se pueden reenviar emails de visitas cerradas' });
      return;
    }

    const cfg = await leerEmailConfig();
    const fecha = visit.confirmed_at ? new Date(visit.confirmed_at).toLocaleDateString('es-ES') : new Date(visit.created_at).toLocaleDateString('es-ES');
    const asuntoBase = `Visita ${fecha} · ${visit.cliente_nombre || 'Cliente'}`;

    // Generar PDF (mismo que email cliente original) y adjuntarlo
    let pdfBuffer: Buffer | null = null;
    try {
      pdfBuffer = await generarPdfVisitaBuffer(visit, annotations);
    } catch (e) {
      console.error('Error generando PDF para visita ' + id + ':', (e as Error).message);
    }
    const adjuntoPdf = pdfBuffer ? [{ filename: nombrePdfVisita(visit), content: pdfBuffer, contentType: 'application/pdf' }] : [];

    // En este endpoint el "destinatario real" es el email que el comercial ha indicado
    // (no el del Sage). En modo pruebas igualmente se redirige al email de pruebas
    // del rol cliente para no enviar nada real durante el desarrollo.
    const r = await enviarEmailConRedireccion({
      rol: 'cliente',
      destinatarioReal: emailDest,
      asunto: `[REENVÍO] ${asuntoBase}`,
      html: plantillaEmailCliente(visit, annotations, cfg),
      attachments: adjuntoPdf,
      visitId: id
    });

    // Loguearlo
    await pool.query(
      `INSERT INTO visit_emails (visit_id, destinatario, destinatario_real, rol, modo, asunto, ok, error, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, r.destinatarioFinal, emailDest, 'cliente', r.modo, `[REENVÍO] ${asuntoBase}`, r.ok, r.error || null, r.messageId || null]
    );

    // Si el envio fue OK y el usuario quiere guardar el email para futuras visitas,
    // sobrescribir clients.email_alternativo del cliente de esta visita
    let guardado = false;
    if (r.ok && guardar_en_cliente) {
      await pool.query(
        `UPDATE clients SET email_alternativo = $1 WHERE id = $2`,
        [emailDest, visit.client_id]
      );
      guardado = true;
    }

    if (!r.ok) {
      res.status(400).json({ success: false, error: r.error, guardado });
      return;
    }
    res.json({ success: true, destinatario: r.destinatarioFinal, modo: r.modo, guardado });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// FASE 1 — PRODUCTOS (catálogo maestro + importador Sage + expositores)
// ============================================================================

// ============================================================================
// BÚSQUEDA GLOBAL (Q3) — clientes + productos + láminas en una sola consulta
// Para admin: ve todo. Para comercial: solo SUS clientes asignados y catálogos
// asignados (la búsqueda respeta los permisos existentes).
// ============================================================================
app.get('/api/search-global', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      res.json({ success: true, clients: [], products: [], sheets: [] });
      return;
    }
    const pattern = '%' + q.toLowerCase() + '%';
    const userId = effectiveUserId(req);
    const esVentas = isEffectiveSales(req);

    // --- CLIENTES ---
    // Admin ve todos; comercial sólo los asignados a él (por commercial_code)
    let clientsSql = `
      SELECT id, razon_social, cif, sage_code, email, municipio, categoria
      FROM clients
      WHERE is_active = TRUE
        AND (
          LOWER(razon_social) LIKE $1
          OR LOWER(COALESCE(cif,'')) LIKE $1
          OR LOWER(COALESCE(sage_code,'')) LIKE $1
          OR LOWER(COALESCE(email,'')) LIKE $1
          OR LOWER(COALESCE(municipio,'')) LIKE $1
        )
    `;
    const clientsParams: any[] = [pattern];
    if (esVentas) {
      clientsSql += ` AND commercial_code IN (SELECT sage_commercial_code FROM users WHERE id = $2)`;
      clientsParams.push(userId);
    }
    clientsSql += ` ORDER BY razon_social LIMIT 10`;
    const clientsR = await pool.query(clientsSql, clientsParams);

    // --- PRODUCTOS --- (mismo criterio que /api/products/search)
    const startsWith = q.toLowerCase() + '%';
    const productsR = await pool.query(`
      SELECT id, codigo, nombre, ean, precio_pvf, tipo
      FROM products
      WHERE activo = TRUE
        AND (LOWER(nombre) LIKE $1 OR LOWER(codigo) LIKE $1 OR LOWER(COALESCE(ean,'')) LIKE $1)
      ORDER BY
        CASE
          WHEN LOWER(codigo) = $2 THEN 0
          WHEN LOWER(ean) = $2 THEN 1
          WHEN LOWER(nombre) LIKE $3 THEN 2
          WHEN LOWER(codigo) LIKE $3 THEN 3
          ELSE 4
        END,
        LENGTH(nombre)
      LIMIT 10
    `, [pattern, q.toLowerCase(), startsWith]);

    // --- LÁMINAS ---
    // Admin ve todas; comercial sólo de catálogos asignados a él.
    let sheetsSql = `
      SELECT s.id, s.titulo, s.tags, s.imagen_path, s.catalog_id,
             c.name AS catalog_name, c.tipo AS catalog_tipo
      FROM sheets s
      LEFT JOIN catalogs c ON c.id = s.catalog_id
      WHERE s.oculta = FALSE
        AND (LOWER(COALESCE(s.titulo,'')) LIKE $1 OR LOWER(COALESCE(s.tags,'')) LIKE $1)
    `;
    const sheetsParams: any[] = [pattern];
    if (esVentas) {
      sheetsSql += ` AND s.catalog_id IN (SELECT catalog_id FROM catalog_assignments WHERE user_id = $2)`;
      sheetsParams.push(userId);
    }
    sheetsSql += ` ORDER BY s.titulo LIMIT 10`;
    const sheetsR = await pool.query(sheetsSql, sheetsParams);

    res.json({
      success: true,
      clients: clientsR.rows,
      products: productsR.rows,
      sheets: sheetsR.rows
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// FASE 2.a: Búsqueda rápida de productos (autocomplete en modal anotar visita).
// IMPORTANTE: este endpoint DEBE ir antes del genérico /api/products/:id porque
// Express podría confundir "search" con un ":id" (no lo hace porque "search" no
// es numérico, pero por seguridad de orden lo colocamos antes igualmente).
// - Solo devuelve productos ACTIVOS (los descatalogados nunca aparecen).
// - Busca en: nombre + código + EAN.
// - Limit fijo a 20 (suficiente para autocomplete, no satura).
// - Devuelve solo campos mínimos (más rápido que el endpoint general).
// - Se aceptan también productos tipo 'comercial' (expositores/promos manuales).
app.get('/api/products/search', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      // No buscamos con menos de 2 caracteres → evita devolver miles de filas
      res.json({ success: true, products: [], total: 0 });
      return;
    }
    const qLower = q.toLowerCase();

    // Texto donde buscamos cada palabra (nombre + codigo + ean + marca), en minúsculas.
    const searchable = `(LOWER(nombre) || ' ' || LOWER(codigo) || ' ' || LOWER(COALESCE(ean,'')) || ' ' || LOWER(COALESCE(marca,'')))`;

    // Partimos la consulta en PALABRAS. Cada palabra debe aparecer (como subcadena) o
    // parecerse mucho (trigramas) a alguna palabra del nombre. Esto hace la búsqueda
    // INDEPENDIENTE DEL ORDEN ("ampollas flash" = "flash ampollas") y TOLERANTE A ERRATAS
    // ("ellorca" encuentra "llorca"). word_similarity(a,b) = parecido de 'a' con la mejor
    // porción de 'b' → ideal para una errata dentro de un nombre de varias palabras.
    const tokens = qLower.split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);
    const toks = tokens.length ? tokens : [qLower];

    const params: any[] = [];
    const conds: string[] = [];
    for (const t of toks) {
      params.push('%' + t + '%'); const pLike = params.length;
      params.push(t);             const pTok  = params.length;
      // subcadena (rápido, cubre parciales y orden) OR parecido difuso por trigramas
      conds.push(`(${searchable} LIKE $${pLike} OR word_similarity($${pTok}, LOWER(nombre)) > 0.45)`);
    }
    params.push(qLower);          const pQ = params.length;      // consulta entera (exacto / ranking)
    params.push(qLower + '%');    const pStarts = params.length; // empieza por…

    const sql = `
      SELECT id, codigo, nombre, ean, precio_pvp, precio_pvf, categoria, familia, marca, tipo,
             GREATEST(similarity(LOWER(nombre), $${pQ}), word_similarity($${pQ}, LOWER(nombre))) AS sim
      FROM products
      WHERE activo = TRUE
        AND (${conds.join(' AND ')})
      ORDER BY
        CASE
          WHEN LOWER(codigo) = $${pQ} THEN 0               -- código exacto = máxima prioridad
          WHEN LOWER(ean) = $${pQ} THEN 1                  -- EAN exacto
          WHEN LOWER(nombre) LIKE $${pStarts} THEN 2       -- nombre empieza por…
          WHEN LOWER(codigo) LIKE $${pStarts} THEN 3       -- código empieza por…
          ELSE 4
        END,
        sim DESC,                                          -- más parecido primero (erratas)
        LENGTH(nombre),
        nombre
      LIMIT 20
    `;
    const r = await pool.query(sql, params);
    res.json({ success: true, products: r.rows, total: r.rows.length });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// FASE 2.b': sugerir el siguiente código EXP-XXXX libre (para crear producto al vuelo).
// DEBE ir antes de /api/products/:id para que Express no lo confunda con un id.
app.get('/api/products/sugerir-codigo', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`
      SELECT codigo FROM products
      WHERE codigo ~ '^EXP-[0-9]+$'
      ORDER BY CAST(SUBSTRING(codigo FROM 5) AS INTEGER) DESC
      LIMIT 1
    `);
    let siguiente = 1;
    if (r.rows.length > 0) {
      const num = parseInt(r.rows[0].codigo.substring(4), 10);
      if (!isNaN(num)) siguiente = num + 1;
    }
    const codigo = 'EXP-' + String(siguiente).padStart(4, '0');
    res.json({ success: true, codigo });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET listar productos (con filtros)
// Query: tipo (sage|comercial|todos), activo (true|false|todos), q (búsqueda)
app.get('/api/products', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const tipo = String(req.query.tipo || 'todos');
    const activo = String(req.query.activo || 'true');
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    const where: string[] = [];
    const params: any[] = [];

    if (tipo === 'sage' || tipo === 'comercial') {
      params.push(tipo);
      where.push(`tipo = $${params.length}`);
    }
    if (activo === 'true') where.push(`activo = TRUE`);
    else if (activo === 'false') where.push(`activo = FALSE`);

    if (q) {
      // Búsqueda por PALABRAS (orden indiferente) + tolerante a erratas (trigramas),
      // igual que /api/products/search. "ampollas flash" = "flash ampollas"; "ellorca"→"llorca".
      const searchable = `(LOWER(nombre) || ' ' || LOWER(codigo) || ' ' || LOWER(COALESCE(ean,'')) || ' ' || LOWER(COALESCE(marca,'')))`;
      const toks = q.split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);
      const lista = toks.length ? toks : [q];
      for (const t of lista) {
        params.push('%' + t + '%'); const pLike = params.length;
        params.push(t);             const pTok  = params.length;
        where.push(`(${searchable} LIKE $${pLike} OR word_similarity($${pTok}, LOWER(nombre)) > 0.45)`);
      }
    }

    const whereSQL = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const countR = await pool.query(`SELECT COUNT(*)::int AS n FROM products ${whereSQL}`, params);
    const total = countR.rows[0].n;

    // Si hay búsqueda, ordenar por parecido (mejores primero); si no, alfabético.
    let orderSQL = 'ORDER BY nombre';
    if (q) {
      params.push(q); const pQ = params.length;
      orderSQL = `ORDER BY GREATEST(similarity(LOWER(nombre), $${pQ}), word_similarity($${pQ}, LOWER(nombre))) DESC, LENGTH(nombre), nombre`;
    }

    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM products ${whereSQL} ${orderSQL} LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, products: r.rows, total });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET un producto por id
// ============================================================================
// COORDINACION CON ADMINISTRACION
// Circuito cerrado: al cerrar version de un catalogo, administracion recibe el aviso
// con lo que cambia y lo que tienen que hacer (dar de alta codigos / actualizar Sage).
// Ellos responden desde su propia pantalla y Fernando se entera al momento.
// ============================================================================

const soloConsulta = (req: AuthRequest) => req.user?.role === 'oficina';
const puedeCoordinar = (req: AuthRequest) => req.user?.role === 'admin' || req.user?.role === 'oficina';

// Aviso a Fernando por Telegram cuando administracion responde (mismo bot que las
// incidencias: ya esta configurado y probado).
async function avisarCoordinacionTelegram(texto: string): Promise<void> {
  const token = process.env.INCIDENCIAS_BOT_TOKEN, chat = process.env.INCIDENCIAS_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: '🔄 ' + texto, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error('[coordinacion] Telegram:', (e as Error).message); }
}

// EL PANEL: lo que espera cada parte. Lo ven los dos lados, cada uno con su verbo.
app.get('/api/coordinacion', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!puedeCoordinar(req)) { res.status(403).json({ success: false, error: 'Sin acceso' }); return; }
    // 1) Altas: productos provisionales. Si ya tienen codigo asignado, estan esperando
    //    a que la sincronizacion de Sage los traiga (o a que Fernando los revise).
    const altas = await pool.query(
      `SELECT p.id, p.nombre, p.ean, p.precio_pvf, p.precio_pvp, p.precio_coste, p.oferta_texto,
              p.notas_admin, p.pendiente_desde, p.codigo_asignado, p.codigo_asignado_at, p.codigo_asignado_por,
              COALESCE(json_agg(json_build_object('sheet_id', s.id, 'titulo', s.titulo, 'orden', s.orden))
                       FILTER (WHERE s.id IS NOT NULL), '[]') AS laminas
         FROM products p
         LEFT JOIN sheet_zones z ON z.product_id = p.id
         LEFT JOIN sheets s ON s.id = z.sheet_id
        WHERE p.pendiente_alta = TRUE
        GROUP BY p.id ORDER BY p.pendiente_desde`);
    // 2) Cambios en laminas que administracion aun no ha reflejado en Sage.
    const cambios = await pool.query(
      `SELECT s.id AS sheet_id, s.titulo, s.orden, s.catalog_id, c.name AS catalogo,
              MAX(a.created_at) AS ultimo_cambio,
              ARRAY_AGG(DISTINCT a.tipo_cambio) AS tipos
         FROM sheet_audit_log a
         JOIN sheets s ON s.id = a.sheet_id
         JOIN catalogs c ON c.id = s.catalog_id
        WHERE a.tipo_cambio IN ('updated_image','updated_meta','updated_precios','updated_tablas')
          AND a.created_at > NOW() - INTERVAL '60 days'
          AND (s.sage_actualizado_at IS NULL OR a.created_at > s.sage_actualizado_at)
        GROUP BY s.id, s.titulo, s.orden, s.catalog_id, c.name
        ORDER BY MAX(a.created_at) DESC LIMIT 200`);
    const avisos = await pool.query(
      `SELECT * FROM coordinacion_avisos ORDER BY created_at DESC LIMIT 20`);
    res.json({
      success: true,
      soy: soloConsulta(req) ? 'oficina' : 'admin',
      altas: altas.rows,
      cambios: cambios.rows,
      avisos: avisos.rows,
      resumen: {
        altas_sin_codigo: altas.rows.filter((a: any) => !a.codigo_asignado).length,
        altas_con_codigo: altas.rows.filter((a: any) => a.codigo_asignado).length,
        cambios_pendientes: cambios.rows.length
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Administracion escribe el CODIGO que le han asignado al producto. Si ese codigo ya
// existe en la base (ya sincronizado desde Sage), se enlaza en el acto; si todavia no,
// se guarda y se enlazara solo cuando llegue. Fernando no teclea codigos nunca.
app.post('/api/coordinacion/altas/:id/codigo', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!puedeCoordinar(req)) { res.status(403).json({ success: false, error: 'Sin acceso' }); return; }
    const pendId = Number(req.params.id);
    const codigo = String(req.body?.codigo || '').trim();
    if (!codigo) { res.status(400).json({ success: false, error: 'Escribe el código asignado' }); return; }
    const p = await pool.query(`SELECT id, nombre FROM products WHERE id=$1 AND pendiente_alta=TRUE`, [pendId]);
    if (!p.rows.length) { res.status(404).json({ success: false, error: 'Ese producto ya no está pendiente' }); return; }
    await pool.query(
      `UPDATE products SET codigo_asignado=$1, codigo_asignado_at=NOW(), codigo_asignado_por=$2 WHERE id=$3`,
      [codigo, req.user?.name || null, pendId]);
    // ¿Existe ya el real? -> enlazar ahora mismo
    const real = await pool.query(
      `SELECT id, codigo, nombre FROM products
        WHERE pendiente_alta=FALSE AND (codigo=$1 OR ean=$1 OR codigo_alt_1=$1) LIMIT 1`, [codigo]);
    let enlazado = null;
    if (real.rows.length) enlazado = await enlazarPendiente(pendId, real.rows[0].id, req.user?.name || 'administración');
    avisarCoordinacionTelegram(
      `*${req.user?.name || 'Administración'}* ha asignado el código *${codigo}* a "${p.rows[0].nombre}"` +
      (enlazado ? `\nYa enlazado en ${enlazado.laminas} lámina(s): en la tablet sale el código bueno.`
                : `\nQueda a la espera de que llegue por la sincronización de Sage.`)).catch(() => {});
    res.json({ success: true, codigo, enlazado });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Sustituye el provisional por el real en zonas y pedidos. Usado por el enlace manual,
// por la asignacion de codigo y por el repesca automatico tras sincronizar con Sage.
async function enlazarPendiente(pendId: number, realId: number, quien: string): Promise<any> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const z = await client.query(`UPDATE sheet_zones SET product_id=$1, updated_at=NOW() WHERE product_id=$2 RETURNING sheet_id`, [realId, pendId]);
    const a = await client.query(`UPDATE annotations SET product_id=$1 WHERE product_id=$2 RETURNING id`, [realId, pendId]);
    await client.query(`DELETE FROM products WHERE id=$1`, [pendId]);
    await client.query('COMMIT');
    const sheets = Array.from(new Set(z.rows.map((x: any) => x.sheet_id)));
    for (const sid of sheets) {
      await logSheetChangeAgrupado('updated_zonas', Number(sid), { name: quien }, 'alta de producto enlazada');
    }
    return { zonas: z.rowCount || 0, lineas: a.rowCount || 0, laminas: sheets.length };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

// Repesca: productos con codigo asignado cuyo real YA esta en la base (llego por Sage).
// Se llama al abrir la coordinacion y despues de cada sincronizacion.
app.post('/api/coordinacion/repescar', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!puedeCoordinar(req)) { res.status(403).json({ success: false, error: 'Sin acceso' }); return; }
    const cand = await pool.query(
      `SELECT p.id, p.nombre, p.codigo_asignado, r.id AS real_id, r.codigo
         FROM products p
         JOIN products r ON r.pendiente_alta = FALSE
           AND (r.codigo = p.codigo_asignado OR r.ean = p.codigo_asignado OR r.codigo_alt_1 = p.codigo_asignado)
        WHERE p.pendiente_alta = TRUE AND p.codigo_asignado IS NOT NULL`);
    const hechos: any[] = [];
    for (const c of cand.rows) {
      const r = await enlazarPendiente(c.id, c.real_id, req.user?.name || 'sistema');
      hechos.push({ nombre: c.nombre, codigo: c.codigo, ...r });
    }
    if (hechos.length) {
      avisarCoordinacionTelegram(`${hechos.length} alta(s) ya en Sage y enlazadas solas:\n` +
        hechos.map(h => `• ${h.codigo} · ${h.nombre}`).join('\n')).catch(() => {});
    }
    res.json({ success: true, enlazados: hechos });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// FICHA DE LA LAMINA PARA ADMINISTRACION: la lamina en grande + todo lo que tienen
// que reflejar en Sage (codigos, precios, ofertas, tablas) y que ha cambiado.
// Sin esto veian "lamina 214 cambiada" y tenian que adivinar que tocar.
app.get('/api/coordinacion/lamina/:sheetId', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!puedeCoordinar(req)) { res.status(403).json({ success: false, error: 'Sin acceso' }); return; }
    const sheetId = Number(req.params.sheetId);
    const s = await pool.query(
      `SELECT s.id, s.titulo, s.orden, s.imagen_path, s.miniatura_path, s.catalog_id,
              s.sage_actualizado_at, s.sage_actualizado_por, c.name AS catalogo
         FROM sheets s LEFT JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = $1`, [sheetId]);
    if (!s.rows.length) { res.status(404).json({ success: false, error: 'Lámina no encontrada' }); return; }

    // Que lleva la lamina AHORA: es lo que tiene que estar en Sage.
    const zonas = await pool.query(
      `SELECT z.ref_modelo, z.etiqueta, z.es_comision,
              p.codigo, p.nombre, p.precio_pvf, p.precio_pvp, p.oferta_texto,
              p.pendiente_alta, p.codigo_asignado
         FROM sheet_zones z LEFT JOIN products p ON p.id = z.product_id
        WHERE z.sheet_id = $1 ORDER BY z.orden, z.id`, [sheetId]);
    const tablas = await pool.query(
      `SELECT t.nombre FROM lamina_tabla lt JOIN expositor_tabla t ON t.id = lt.tabla_id
        WHERE lt.sheet_id = $1 AND lt.deleted_at IS NULL AND t.deleted_at IS NULL`, [sheetId]);
    const nRecuadros = (await pool.query(
      `SELECT COUNT(*)::int n FROM lamina_recuadro WHERE sheet_id = $1`, [sheetId])).rows[0].n;
    // Historial reciente: el detalle de los cambios de datos lleva antes/ahora.
    const cambios = await pool.query(
      `SELECT tipo_cambio, campos_json, actor_name, created_at FROM sheet_audit_log
        WHERE sheet_id = $1 ORDER BY created_at DESC LIMIT 15`, [sheetId]);

    res.json({
      success: true,
      lamina: s.rows[0],
      productos: zonas.rows,
      tablas: tablas.rows.map((t: any) => t.nombre),
      n_recuadros_precio: nRecuadros,
      cambios: cambios.rows
    });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Administracion marca una lamina como "ya actualizada en Sage".
app.post('/api/coordinacion/cambios/:sheetId/hecho', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!puedeCoordinar(req)) { res.status(403).json({ success: false, error: 'Sin acceso' }); return; }
    const sheetId = Number(req.params.sheetId);
    const r = await pool.query(
      `UPDATE sheets SET sage_actualizado_at=NOW(), sage_actualizado_por=$1 WHERE id=$2 RETURNING titulo`,
      [req.user?.name || null, sheetId]);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'Lámina no encontrada' }); return; }
    if (soloConsulta(req)) {
      avisarCoordinacionTelegram(`*${req.user?.name}* ha actualizado en Sage: ${r.rows[0].titulo}`).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Administracion abre el aviso -> queda constancia de que lo han visto.
app.post('/api/coordinacion/avisos/:id/visto', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!puedeCoordinar(req)) { res.status(403).json({ success: false, error: 'Sin acceso' }); return; }
    await pool.query(
      `UPDATE coordinacion_avisos SET visto_at = COALESCE(visto_at, NOW()), visto_por = COALESCE(visto_por, $1) WHERE id=$2`,
      [req.user?.name || null, Number(req.params.id)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// RECORDATORIO DE LO ATASCADO. Lo que lleva demasiados dias esperando no puede
// depender de que alguien se acuerde: se avisa solo, como maximo una vez al dia y
// solo si de verdad hay algo atascado (si no, es ruido y dejan de leerlo).
const DIAS_ATASCO_DEFECTO = 7;

async function diasAtascoConfig(): Promise<number> {
  try {
    const r = await pool.query(`SELECT valor FROM app_config WHERE clave='coordinacion_dias_aviso'`);
    const n = parseInt(r.rows[0]?.valor || String(DIAS_ATASCO_DEFECTO), 10);
    return (Number.isInteger(n) && n >= 1 && n <= 90) ? n : DIAS_ATASCO_DEFECTO;
  } catch { return DIAS_ATASCO_DEFECTO; }
}

async function recordatorioCoordinacion(forzado: boolean): Promise<any> {
  const dias = await diasAtascoConfig();
  const altas = await pool.query(
    `SELECT nombre, ean, precio_pvf, pendiente_desde,
            EXTRACT(DAY FROM NOW() - pendiente_desde)::int AS dias
       FROM products
      WHERE pendiente_alta = TRUE AND codigo_asignado IS NULL
        AND pendiente_desde < NOW() - ($1 || ' days')::interval
      ORDER BY pendiente_desde`, [String(dias)]);
  const laminas = await pool.query(
    `SELECT s.titulo, s.orden, MAX(a.created_at) AS ultimo,
            EXTRACT(DAY FROM NOW() - MAX(a.created_at))::int AS dias
       FROM sheet_audit_log a JOIN sheets s ON s.id = a.sheet_id
      WHERE a.tipo_cambio IN ('updated_image','updated_meta','updated_precios','updated_tablas')
        AND (s.sage_actualizado_at IS NULL OR a.created_at > s.sage_actualizado_at)
      GROUP BY s.id, s.titulo, s.orden
     HAVING MAX(a.created_at) < NOW() - ($1 || ' days')::interval
      ORDER BY MAX(a.created_at) LIMIT 60`, [String(dias)]);

  if (!altas.rows.length && !laminas.rows.length) return { enviado: false, motivo: 'nada atascado', dias };

  if (!forzado) {
    const ult = await pool.query(`SELECT valor FROM app_config WHERE clave='coordinacion_recordatorio_at'`);
    const ultimo = ult.rows[0]?.valor ? new Date(ult.rows[0].valor).getTime() : 0;
    if (Date.now() - ultimo < 20 * 3600 * 1000) return { enviado: false, motivo: 'ya se aviso hoy', dias };
  }

  const users = await pool.query(`SELECT email FROM users WHERE role='oficina' AND is_active=TRUE`);
  const cfg = await leerEmailConfig();
  const extra = (cfg.oficina_emails || '').split(',').map(s => s.trim()).filter(Boolean);
  const destinos = Array.from(new Set([...users.rows.map((u: any) => u.email), ...extra]));
  if (!destinos.length) return { enviado: false, motivo: 'sin destinatarios', dias };

  const html = `
    <h2 style="font-family:Arial">⏰ Recordatorio · lleva más de ${dias} días esperando</h2>
    ${altas.rows.length ? `
      <h3 style="font-family:Arial;font-size:15px">🆕 Altas de producto sin código (${altas.rows.length})</h3>
      <ul style="font-family:Arial;font-size:13px">
        ${altas.rows.map((a: any) => `<li><b>${escapeHtml(a.nombre)}</b>${a.ean ? ' · CN ' + escapeHtml(a.ean) : ''} — <b>${a.dias} días</b></li>`).join('')}
      </ul>` : ''}
    ${laminas.rows.length ? `
      <h3 style="font-family:Arial;font-size:15px">✏️ Láminas cambiadas sin reflejar en Sage (${laminas.rows.length})</h3>
      <ul style="font-family:Arial;font-size:13px">
        ${laminas.rows.map((l: any) => `<li>${l.orden ? l.orden + ' · ' : ''}${escapeHtml(l.titulo || '')} — <b>${l.dias} días</b></li>`).join('')}
      </ul>` : ''}
    <p style="font-family:Arial;font-size:13px">Se resuelve en la app → <b>🔄 Coordinación</b>.</p>`;
  for (const email of destinos) {
    await enviarEmailConRedireccion({
      rol: 'oficina', destinatarioReal: email,
      asunto: `⏰ Pendiente desde hace más de ${dias} días (${altas.rows.length + laminas.rows.length})`, html
    });
  }
  await pool.query(
    `INSERT INTO app_config (clave, valor, updated_at) VALUES ('coordinacion_recordatorio_at', $1, NOW())
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [new Date().toISOString()]);
  avisarCoordinacionTelegram(
    `Recordatorio enviado a administración: ${altas.rows.length} alta(s) y ${laminas.rows.length} lámina(s) llevan más de ${dias} días.`).catch(() => {});
  return { enviado: true, altas: altas.rows.length, laminas: laminas.rows.length, destinos: destinos.length, dias };
}

// Cada 6 h se mira si hay algo atascado; el propio recordatorio no se repite antes de
// 20 h, asi que en la practica sale como mucho uno al dia.
setInterval(() => { recordatorioCoordinacion(false).catch(() => {}); }, 6 * 3600 * 1000).unref();

// Y a mano, desde la pantalla de coordinacion.
app.post('/api/coordinacion/recordatorio', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await recordatorioCoordinacion(true);
    res.json({ success: true, ...r });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Se dispara al CERRAR VERSION. Agrupa los cierres seguidos: si ya hubo un aviso de ese
// catalogo hace menos de 30 min, se actualiza en vez de mandar otro (cerrar tres
// versiones seguidas no puede suponer tres correos).
const VENTANA_AVISO_MIN = 30;

async function avisarAdministracionDeVersion(catalogId: number, versionNumber: number,
                                             notas: string | null, actor: string | null): Promise<void> {
  try {
    const cat = (await pool.query(`SELECT name FROM catalogs WHERE id=$1`, [catalogId])).rows[0];
    const nAltas = Number((await pool.query(`SELECT COUNT(*)::int n FROM products WHERE pendiente_alta=TRUE`)).rows[0].n);
    const nCambios = Number((await pool.query(
      `SELECT COUNT(DISTINCT a.sheet_id)::int n FROM sheet_audit_log a JOIN sheets s ON s.id=a.sheet_id
        WHERE a.catalog_id=$1 AND a.tipo_cambio <> 'deleted'
          AND (s.sage_actualizado_at IS NULL OR a.created_at > s.sage_actualizado_at)`, [catalogId])).rows[0].n);

    const previo = await pool.query(
      `SELECT id FROM coordinacion_avisos WHERE catalog_id=$1 AND created_at > NOW() - ($2 || ' minutes')::interval
        ORDER BY created_at DESC LIMIT 1`, [catalogId, String(VENTANA_AVISO_MIN)]);
    if (previo.rows.length) {
      await pool.query(
        `UPDATE coordinacion_avisos SET version_number=$1, notas=$2, n_altas=$3, n_cambios=$4, created_at=NOW() WHERE id=$5`,
        [versionNumber, notas, nAltas, nCambios, previo.rows[0].id]);
      return;   // agrupado: ni correo nuevo ni aviso duplicado
    }
    await pool.query(
      `INSERT INTO coordinacion_avisos (catalog_id, catalog_name, version_number, notas, n_altas, n_cambios, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [catalogId, cat?.name || null, versionNumber, notas, nAltas, nCambios, actor]);

    // Email a administracion (los usuarios con rol oficina + los emails de oficina)
    const users = await pool.query(`SELECT email FROM users WHERE role='oficina' AND is_active=TRUE`);
    const cfg = await leerEmailConfig();
    const extra = (cfg.oficina_emails || '').split(',').map(s => s.trim()).filter(Boolean);
    const destinos = Array.from(new Set([...users.rows.map((u: any) => u.email), ...extra]));
    if (!destinos.length) return;
    const html = `
      <h2 style="font-family:Arial">📚 ${escapeHtml(cat?.name || 'Catálogo')} · versión ${versionNumber}</h2>
      ${notas ? `<p style="font-family:Arial;font-size:14px"><b>Qué cambia:</b> ${escapeHtml(notas)}</p>` : ''}
      <p style="font-family:Arial;font-size:14px">
        Ya está disponible en vuestra tablet para consultar.<br><br>
        <b>Lo que hace falta de vuestra parte:</b><br>
        ${nAltas ? `🆕 <b>${nAltas}</b> producto(s) esperando alta (con sus precios y ofertas).<br>` : ''}
        ${nCambios ? `✏️ <b>${nCambios}</b> lámina(s) modificadas que hay que reflejar en Sage.<br>` : ''}
        ${(!nAltas && !nCambios) ? 'Nada pendiente: solo es información.' : ''}
      </p>
      <p style="font-family:Arial;font-size:14px">
        Entrad en la app → <b>🔄 Coordinación</b>: ahí ponéis el código que asignéis a cada alta
        y marcáis las láminas que vais actualizando. Fernando lo ve al momento y no hay que teclear códigos dos veces.
      </p>`;
    for (const email of destinos) {
      await enviarEmailConRedireccion({
        rol: 'oficina', destinatarioReal: email,
        asunto: `${cat?.name || 'Catálogo'} v${versionNumber}` +
                ((nAltas || nCambios) ? ` · ${nAltas + nCambios} cosa(s) pendientes` : ''),
        html
      });
    }
  } catch (e) { console.error('[coordinacion] aviso de version:', (e as Error).message); }
}

// ============================================================================
// PRODUCTOS PENDIENTES DE ALTA
// Fernando monta la lamina ANTES de que administracion de de alta el producto en
// Sage. El provisional deja la zona operativa y guarda de paso los datos que
// administracion necesita para el alta (PVL, PVP, coste, oferta). Cuando el
// producto real aparece, se ENLAZA de un clic y el provisional desaparece.
// ============================================================================

// Crear un provisional. El codigo se genera solo (PEND-n): el real lo pone Sage.
app.post('/api/products/pendiente', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) { res.status(400).json({ success: false, error: 'El nombre es obligatorio' }); return; }
    const cn = b.ean ? String(b.ean).replace(/\D/g, '') : null;
    // Si ya existe en Sage con ese CN, no tiene sentido crear un provisional.
    if (cn) {
      const ya = await pool.query(
        `SELECT id, codigo, nombre FROM products
          WHERE pendiente_alta = FALSE AND (codigo = $1 OR ean = $1 OR codigo_alt_1 = $1) LIMIT 1`, [cn]);
      if (ya.rows.length) {
        res.status(409).json({ success: false, error: 'Ese código nacional ya existe: ' + ya.rows[0].codigo + ' · ' + ya.rows[0].nombre, product: ya.rows[0] });
        return;
      }
    }
    const seq = await pool.query(`SELECT COALESCE(MAX(SUBSTRING(codigo FROM 6)::int), 0) + 1 AS n
                                    FROM products WHERE codigo ~ '^PEND-[0-9]+$'`);
    const codigo = 'PEND-' + seq.rows[0].n;
    const num = (v: any) => (v != null && v !== '' ? Number(v) : null);
    const r = await pool.query(
      `INSERT INTO products (codigo, nombre, ean, precio_pvp, precio_pvf, precio_coste, oferta_texto,
                             tipo, notas_admin, pendiente_alta, pendiente_desde, pendiente_solicitante)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'comercial',$8,TRUE,NOW(),$9) RETURNING *`,
      [codigo, nombre, cn, num(b.precio_pvp), num(b.precio_pvf), num(b.precio_coste),
       b.oferta_texto ? String(b.oferta_texto).trim().substring(0, 200) : null,
       b.notas_admin || null, req.user?.name || null]);
    res.json({ success: true, product: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Lista de pendientes + en que laminas se usa cada uno + si su CN YA existe en Sage
// (eso ultimo es el aviso "ya te lo han dado de alta, enlazalo").
app.get('/api/products/pendientes', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT p.*,
              COALESCE(json_agg(json_build_object('sheet_id', s.id, 'titulo', s.titulo,
                                                  'catalog_id', s.catalog_id, 'orden', s.orden))
                       FILTER (WHERE s.id IS NOT NULL), '[]') AS laminas
         FROM products p
         LEFT JOIN sheet_zones z ON z.product_id = p.id
         LEFT JOIN sheets s ON s.id = z.sheet_id
        WHERE p.pendiente_alta = TRUE
        GROUP BY p.id
        ORDER BY p.pendiente_desde DESC NULLS LAST, p.id DESC`);
    // Para los que tienen CN: ¿existe ya el real en Sage?
    const conCN = r.rows.filter((p: any) => p.ean);
    let sugerencias: any = {};
    if (conCN.length) {
      const cns = conCN.map((p: any) => String(p.ean));
      const s = await pool.query(
        `SELECT id, codigo, nombre, ean, codigo_alt_1 FROM products
          WHERE pendiente_alta = FALSE
            AND (codigo = ANY($1::text[]) OR ean = ANY($1::text[]) OR codigo_alt_1 = ANY($1::text[]))`, [cns]);
      conCN.forEach((p: any) => {
        const m = s.rows.find((x: any) => [x.codigo, x.ean, x.codigo_alt_1].includes(String(p.ean)));
        if (m) sugerencias[p.id] = m;
      });
    }
    res.json({ success: true, pendientes: r.rows, sugerencias, total: r.rows.length });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// ENLAZAR: sustituye el provisional por el producto REAL en todas las zonas y en las
// lineas de pedido ya anotadas, y borra el provisional. Todo o nada (transaccion).
app.post('/api/products/:id/enlazar', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const pendId = Number(req.params.id);
    const realId = Number(req.body?.product_id);
    if (!Number.isInteger(realId) || realId <= 0) { res.status(400).json({ success: false, error: 'Falta el producto real' }); return; }
    if (pendId === realId) { res.status(400).json({ success: false, error: 'Son el mismo producto' }); return; }
    const p = await pool.query(`SELECT id FROM products WHERE id=$1 AND pendiente_alta=TRUE`, [pendId]);
    if (!p.rows.length) { res.status(404).json({ success: false, error: 'No es un producto pendiente' }); return; }
    const real = await pool.query(`SELECT id, codigo, nombre FROM products WHERE id=$1 AND pendiente_alta=FALSE`, [realId]);
    if (!real.rows.length) { res.status(404).json({ success: false, error: 'Producto real no encontrado' }); return; }
    const r = await enlazarPendiente(pendId, realId, req.user?.name || 'admin');
    res.json({ success: true, ...r, producto: real.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.post('/api/products/pendientes/enviar', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`SELECT * FROM products WHERE pendiente_alta = TRUE ORDER BY pendiente_desde`);
    if (!r.rows.length) { res.status(400).json({ success: false, error: 'No hay productos pendientes de alta' }); return; }
    const cfg = await leerEmailConfig();
    const destinos = (req.body?.emails
      ? String(req.body.emails).split(',')
      : (cfg.oficina_emails || '').split(',')).map(s => s.trim()).filter(Boolean);
    if (!destinos.length) { res.status(400).json({ success: false, error: 'No hay emails de oficina configurados (⚙️ Configuración → Emails de oficina)' }); return; }
    const eur = (v: any) => (v != null ? Number(v).toFixed(2) + ' €' : '—');
    const html = `
      <h2 style="font-family:Arial">Altas de producto pendientes · CatalogPRO</h2>
      <p style="font-family:Arial;font-size:14px">Estos productos ya están en las láminas y necesitan alta en Sage:</p>
      <table style="border-collapse:collapse;font-family:Arial;font-size:13px" border="1" cellpadding="6">
        <tr style="background:#f3f4f6"><th>Producto</th><th>Cód. nacional</th><th>PVL</th><th>PVP</th><th>Coste</th><th>Oferta</th><th>Notas</th></tr>
        ${r.rows.map((p: any) => `<tr>
          <td><b>${escapeHtml(p.nombre)}</b></td>
          <td>${escapeHtml(p.ean || '—')}</td>
          <td>${eur(p.precio_pvf)}</td><td>${eur(p.precio_pvp)}</td><td>${eur(p.precio_coste)}</td>
          <td>${escapeHtml(p.oferta_texto || '—')}</td>
          <td>${escapeHtml(p.notas_admin || '')}</td>
        </tr>`).join('')}
      </table>
      <p style="font-family:Arial;font-size:12px;color:#666">Cuando estén dados de alta y lleguen por la sincronización, se enlazan solos con las láminas.</p>`;
    const enviados: any[] = [];
    for (const email of destinos) {
      const r2 = await enviarEmailConRedireccion({
        rol: 'oficina', destinatarioReal: email,
        asunto: 'Altas de producto pendientes (' + r.rows.length + ')', html
      });
      enviados.push({ email, ...r2 });
    }
    res.json({ success: true, enviados, total: r.rows.length });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

app.get('/api/products/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Producto no encontrado' });
      return;
    }
    // Histórico de precios
    const h = await pool.query(
      'SELECT * FROM product_price_history WHERE product_id = $1 ORDER BY changed_at DESC LIMIT 50',
      [id]
    );
    res.json({ success: true, product: r.rows[0], price_history: h.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST crear producto (manual, típicamente expositores tipo 'comercial')
// FASE 2.b': sugerir el siguiente código EXP-XXXX libre (para crear producto al vuelo)
app.post('/api/products', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { codigo, nombre, descripcion, ean, precio_pvp, precio_pvf, categoria, familia, marca, tipo, notas_admin } = req.body;
    if (!codigo || !nombre) {
      res.status(400).json({ success: false, error: 'Código y nombre obligatorios' });
      return;
    }
    const tipoFinal = ['sage','comercial'].includes(tipo) ? tipo : 'comercial';
    const r = await pool.query(
      `INSERT INTO products (codigo, nombre, descripcion, ean, precio_pvp, precio_pvf, categoria, familia, marca, tipo, notas_admin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        String(codigo).trim(),
        String(nombre).trim(),
        descripcion || null,
        ean || null,
        precio_pvp != null && precio_pvp !== '' ? Number(precio_pvp) : null,
        precio_pvf != null && precio_pvf !== '' ? Number(precio_pvf) : null,
        categoria || null,
        familia || null,
        marca || null,
        tipoFinal,
        notas_admin || null
      ]
    );
    res.json({ success: true, product: r.rows[0] });
  } catch (e: any) {
    if (e.code === '23505') {
      res.status(409).json({ success: false, error: 'Ya existe un producto con ese código' });
      return;
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT editar producto (admin)
app.put('/api/products/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { codigo, nombre, descripcion, ean, precio_pvp, precio_pvf, categoria, familia, marca, notas_admin, activo } = req.body;

    // Cargar producto actual para detectar cambios de precio
    const actualR = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (actualR.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Producto no encontrado' });
      return;
    }
    const actual = actualR.rows[0];

    const nuevoPvp = precio_pvp != null && precio_pvp !== '' ? Number(precio_pvp) : null;
    const nuevoPvf = precio_pvf != null && precio_pvf !== '' ? Number(precio_pvf) : null;
    const cambioPrecio = (Number(actual.precio_pvp) !== nuevoPvp) || (Number(actual.precio_pvf) !== nuevoPvf);

    const r = await pool.query(
      `UPDATE products SET
         codigo = COALESCE($1, codigo),
         nombre = COALESCE($2, nombre),
         descripcion = $3,
         ean = $4,
         precio_pvp = $5,
         precio_pvf = $6,
         categoria = $7,
         familia = $8,
         marca = $9,
         notas_admin = $10,
         activo = COALESCE($11, activo),
         updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [
        codigo ? String(codigo).trim() : null,
        nombre ? String(nombre).trim() : null,
        descripcion || null,
        ean || null,
        nuevoPvp,
        nuevoPvf,
        categoria || null,
        familia || null,
        marca || null,
        notas_admin || null,
        typeof activo === 'boolean' ? activo : null,
        id
      ]
    );

    // Registrar histórico si hubo cambio de precio
    if (cambioPrecio) {
      await pool.query(
        `INSERT INTO product_price_history (product_id, precio_pvp_old, precio_pvp_new, precio_pvf_old, precio_pvf_new, origen, changed_by_id)
         VALUES ($1,$2,$3,$4,$5,'manual',$6)`,
        [id, actual.precio_pvp, nuevoPvp, actual.precio_pvf, nuevoPvf, req.user?.id || null]
      );
    }

    res.json({ success: true, product: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST importar Excel de Sage - PRE-REVISIÓN (no aplica nada todavía)
// Devuelve resumen de cambios para que el admin decida si confirmar.
app.post('/api/products/import-preview', verifyToken, requireRealAdmin, uploadExcel.single('excel'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No se ha subido archivo' });
      return;
    }
    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rows.length < 2) {
      res.status(400).json({ success: false, error: 'El Excel está vacío o solo tiene cabecera' });
      return;
    }

    // Detectar columnas por nombre en la cabecera, normalizando (sin acentos, minúsculas, sin puntos)
    const normalizar = (s: string) => s.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar acentos
      .replace(/[.]/g, '');                                // quitar puntos
    const headers = rows[0].map(h => normalizar(String(h || '')));

    function findCol(...nombresPosibles: string[]): number {
      for (const n of nombresPosibles) {
        const nNorm = normalizar(n);
        const idx = headers.findIndex(h => h === nNorm);
        if (idx >= 0) return idx;
      }
      // Si no encuentra exacto, prueba "contiene"
      for (const n of nombresPosibles) {
        const nNorm = normalizar(n);
        const idx = headers.findIndex(h => h.includes(nNorm));
        if (idx >= 0) return idx;
      }
      return -1;
    }

    // Mapeo adaptado al Sage real de LOMHIFAR:
    //   "Artículo"         → código
    //   "Descripción"      → nombre
    //   "Cód. alternativo" → EAN
    //   "Precio venta"     → PVF (PVL, sin bonificaciones ni descuentos)
    //   "Familia"          → categoría
    //   "Subfamilia"       → familia (sub-clasificación)
    //   "Proveedor habitual" → proveedor
    //   "Grupo IVA"        → iva_group
    //   "Tipo artículo"    → tipo de fila (M material, C comentario, I inmaterial)
    const colCodigo    = findCol('articulo', 'artículo', 'codigo', 'código', 'cod_sage', 'cod', 'ref');
    const colNombre    = findCol('descripcion', 'descripción', 'nombre', 'producto');
    const colEAN       = findCol('cod alternativo', 'codigo alternativo', 'ean', 'codigo_nacional', 'cn', 'codigobarras');
    const colPVF       = findCol('precio venta', 'pvf', 'pvl', 'precio_pvf', 'precio_farmacia', 'precio_lab');
    const colPVP       = findCol('pvp', 'precio_pvp', 'precio_publico');
    const colCategoria = findCol('familia', 'categoria', 'categoría');
    const colFamilia   = findCol('subfamilia');
    const colMarca     = findCol('marca');
    const colProveedor = findCol('proveedor habitual', 'proveedor');
    const colIVA       = findCol('grupo iva', 'iva');
    const colTipoArt   = findCol('tipo articulo', 'tipo artículo', 'tipo');

    if (colCodigo < 0 || colNombre < 0) {
      res.status(400).json({
        success: false,
        error: 'No se encontró columna de código o nombre. Cabeceras detectadas: ' + headers.join(', ')
      });
      return;
    }

    // --- LÓGICA DE FILTRADO Y CLASIFICACIÓN ---
    // Palabras que indican que una fila tipo "C - Comentario" es basura
    // (mensajes operativos del Sage, NO productos reales)
    const PALABRAS_BASURA_C = [
      'iva ', 'obsequio', 'gracias', 'nota:', 'facturara', 'facturará',
      'girara', 'girará', 'cta lomhifar', 'n cta', 'nº cta',
      'pvf.:', 'pvp.:', 'pvf:', 'pvp:', 'euros',
      'facturas rectificativas', 'articulo comentario', 'artículo comentario',
      'suministrar', 'suministraremos', 'barcelona',
      'falta de stock', 'mercancia se la'
    ];

    function esBasuraTipoC(tipoLetra: string, desc: string, precio: number): boolean {
      if (tipoLetra !== 'C') return false;
      if (precio > 0) return false;  // tiene precio → producto real mal clasificado
      if (desc.length < 10) return true;
      // solo asteriscos, guiones o espacios
      if (/^[\s\*\-]+$/.test(desc)) return true;
      // patrón IBAN español: "ES86 3035 0127..."
      if (/^ES\d{2}(\s+\d+)+/.test(desc)) return true;
      const descLower = normalizar(desc);
      for (const p of PALABRAS_BASURA_C) {
        if (descLower.includes(normalizar(p))) return true;
      }
      return false;
    }

    function estaDescatalogado(desc: string): boolean {
      const u = desc.toUpperCase();
      if (u.includes('ANULADO')) return true;
      if (/\bBAJA\b/.test(u)) return true;
      if (u.includes('BAJA-')) return true;
      return false;
    }

    // Procesar filas
    const filasExcel: any[] = [];
    const codigosExcel = new Set<string>();
    const descartadasBasura: any[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const cod = String(row[colCodigo] || '').trim();
      if (!cod) continue;
      const nom = String(row[colNombre] || '').trim();
      if (!nom) continue;

      const tipoArtRaw = colTipoArt >= 0 ? String(row[colTipoArt] || '').trim() : '';
      const tipoLetra = tipoArtRaw.charAt(0).toUpperCase();  // 'M', 'C', 'I' o ''
      const precioRaw = colPVF >= 0 ? parseFloat(String(row[colPVF] || '').replace(',', '.')) : 0;
      const precio = isNaN(precioRaw) ? 0 : precioRaw;

      // Filtrar basura tipo C
      if (esBasuraTipoC(tipoLetra, nom, precio)) {
        descartadasBasura.push({ codigo: cod, nombre: nom, motivo: 'Comentario interno Sage (no es producto)' });
        continue;
      }

      // Detectar si está descatalogado (ANULADO o BAJA en el nombre)
      const descatalogado = estaDescatalogado(nom);

      const item: any = {
        codigo: cod,
        nombre: nom,
        ean: colEAN >= 0 ? (String(row[colEAN] || '').trim() || null) : null,
        precio_pvp: colPVP >= 0 ? (parseFloat(String(row[colPVP] || '').replace(',', '.')) || null) : null,
        precio_pvf: precio || null,
        categoria: colCategoria >= 0 ? (String(row[colCategoria] || '').trim() || null) : null,
        familia: colFamilia >= 0 ? (String(row[colFamilia] || '').trim() || null) : null,
        marca: colMarca >= 0 ? (String(row[colMarca] || '').trim() || null) : null,
        proveedor: colProveedor >= 0 ? (String(row[colProveedor] || '').trim() || null) : null,
        iva_group: colIVA >= 0 ? (String(row[colIVA] || '').trim() || null) : null,
        activo: !descatalogado,
        motivo_baja: descatalogado ? (nom.toUpperCase().includes('ANULADO') ? 'ANULADO' : 'BAJA') : null
      };
      filasExcel.push(item);
      codigosExcel.add(cod);
    }

    // Cargar productos actuales tipo 'sage' (no tocamos los 'comercial')
    const actualesR = await pool.query(`SELECT * FROM products WHERE tipo = 'sage'`);
    const actualesMap = new Map<string, any>();
    actualesR.rows.forEach((p: any) => actualesMap.set(p.codigo, p));

    // Clasificar cambios
    const nuevos: any[] = [];
    const actualizaciones: any[] = [];
    const sinCambio: any[] = [];
    const cambiosPrecioSignificativos: any[] = []; // > 20%
    let nuevosDescatalogados = 0;       // entran ya como BAJA/ANULADO
    let actualesDescatalogados = 0;     // existentes que ahora se marcan BAJA/ANULADO

    for (const item of filasExcel) {
      const actual = actualesMap.get(item.codigo);
      if (!actual) {
        nuevos.push(item);
        if (!item.activo) nuevosDescatalogados++;
      } else {
        // Comprobar si hay cambios
        const cambios: any = {};
        let hayCambio = false;
        const campos = ['nombre', 'ean', 'precio_pvp', 'precio_pvf', 'categoria', 'familia', 'marca', 'proveedor', 'iva_group', 'activo'];
        for (const campo of campos) {
          const v1 = actual[campo];
          const v2 = item[campo];
          // Comparación tolerante (null/undefined/'' equivalentes)
          const norm = (v: any) => v === null || v === undefined ? '' : String(v);
          if (norm(v1) !== norm(v2)) {
            cambios[campo] = { old: v1, new: v2 };
            hayCambio = true;
          }
        }
        if (hayCambio) {
          actualizaciones.push({ codigo: item.codigo, nombre: actual.nombre, cambios, item });
          // Si el activo pasó de true a false en esta importación
          if (actual.activo && !item.activo) actualesDescatalogados++;
          // Detectar cambio significativo de precio
          if (actual.precio_pvf && item.precio_pvf) {
            const pctPvf = ((Number(item.precio_pvf) - Number(actual.precio_pvf)) / Number(actual.precio_pvf)) * 100;
            if (Math.abs(pctPvf) >= 20) {
              cambiosPrecioSignificativos.push({
                codigo: item.codigo,
                nombre: item.nombre,
                pvp_old: Number(actual.precio_pvf),
                pvp_new: Number(item.precio_pvf),
                pct: pctPvf.toFixed(1)
              });
            }
          }
        } else {
          sinCambio.push(item);
        }
      }
    }

    // Productos que estaban y ya no están en el Excel (candidatos a descatalogar)
    const desaparecidos: any[] = [];
    for (const [codigo, prod] of actualesMap.entries()) {
      if (!codigosExcel.has(codigo) && prod.activo) {
        desaparecidos.push({ codigo, nombre: prod.nombre, ean: prod.ean });
      }
    }

    res.json({
      success: true,
      preview: {
        total_excel: filasExcel.length,
        descartados_basura: descartadasBasura.length,
        nuevos: nuevos.length,
        nuevos_descatalogados: nuevosDescatalogados,
        actualizaciones: actualizaciones.length,
        actuales_descatalogados: actualesDescatalogados,
        sin_cambio: sinCambio.length,
        desaparecidos: desaparecidos.length,
        cambios_precio_significativos: cambiosPrecioSignificativos,
        muestra_nuevos: nuevos.slice(0, 10),
        muestra_actualizaciones: actualizaciones.slice(0, 10),
        muestra_desaparecidos: desaparecidos.slice(0, 10),
        muestra_descartados: descartadasBasura.slice(0, 10),
        headers_detectados: {
          colCodigo: headers[colCodigo],
          colNombre: headers[colNombre],
          colEAN: colEAN >= 0 ? headers[colEAN] : '(no detectada)',
          colPVF: colPVF >= 0 ? headers[colPVF] : '(no detectada)',
          colPVP: colPVP >= 0 ? headers[colPVP] : '(no detectada)',
          colCategoria: colCategoria >= 0 ? headers[colCategoria] : '(no detectada)',
          colFamilia: colFamilia >= 0 ? headers[colFamilia] : '(no detectada)',
          colMarca: colMarca >= 0 ? headers[colMarca] : '(no detectada)',
          colProveedor: colProveedor >= 0 ? headers[colProveedor] : '(no detectada)',
          colIVA: colIVA >= 0 ? headers[colIVA] : '(no detectada)',
          colTipoArt: colTipoArt >= 0 ? headers[colTipoArt] : '(no detectada)'
        },
        // Las filas para enviar al confirmar (frontend las reenviará tal cual)
        filas_payload: filasExcel,
        codigos_desaparecidos: desaparecidos.map(d => d.codigo)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST aplicar la importación tras pre-revisión confirmada
// Body: { filas: [...], descatalogar_desaparecidos: bool, codigos_desaparecidos: [...] }
app.post('/api/products/import-confirm', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const filas: any[] = req.body.filas || [];
    const descatalogar = !!req.body.descatalogar_desaparecidos;
    const codigosDesap: string[] = req.body.codigos_desaparecidos || [];
    const userId = req.user?.id || null;

    if (filas.length === 0) {
      res.status(400).json({ success: false, error: 'No hay filas que importar' });
      return;
    }

    // Cargar mapa actual de tipo 'sage'
    const actualesR = await pool.query(`SELECT * FROM products WHERE tipo = 'sage'`);
    const actualesMap = new Map<string, any>();
    actualesR.rows.forEach((p: any) => actualesMap.set(p.codigo, p));

    let creados = 0, actualizados = 0, descatalogados = 0, marcadosBaja = 0;

    for (const item of filas) {
      const actual = actualesMap.get(item.codigo);
      // El 'activo' viene calculado del preview (false si nombre contiene BAJA/ANULADO).
      // Si no viene la propiedad, asumimos activo=true por defecto.
      const activo = (item.activo === undefined || item.activo === null) ? true : !!item.activo;
      const descatalogadoAt = activo ? null : new Date();

      if (!actual) {
        // Crear nuevo
        await pool.query(
          `INSERT INTO products (codigo, nombre, ean, precio_pvp, precio_pvf, categoria, familia, marca, proveedor, iva_group, tipo, activo, descatalogado_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sage',$11,$12)`,
          [item.codigo, item.nombre, item.ean, item.precio_pvp, item.precio_pvf, item.categoria, item.familia, item.marca, item.proveedor, item.iva_group, activo, descatalogadoAt]
        );
        creados++;
        if (!activo) marcadosBaja++;
      } else {
        // Actualizar
        const cambioPrecio = (Number(actual.precio_pvp || 0) !== Number(item.precio_pvp || 0)) || (Number(actual.precio_pvf || 0) !== Number(item.precio_pvf || 0));
        const pasaABaja = actual.activo && !activo;
        const vuelveDeBaja = !actual.activo && activo;
        // Si el item venía descatalogado, calculamos el descatalogado_at correcto
        const nuevoDescatalogadoAt = activo
          ? null                                        // pasa a activo → limpiamos
          : (actual.descatalogado_at || new Date());    // queda baja → mantenemos o fijamos ahora

        await pool.query(
          `UPDATE products SET nombre=$1, ean=$2, precio_pvp=$3, precio_pvf=$4,
            categoria=$5, familia=$6, marca=$7, proveedor=$8, iva_group=$9,
            activo=$10, descatalogado_at=$11, updated_at=NOW()
           WHERE id=$12`,
          [item.nombre, item.ean, item.precio_pvp, item.precio_pvf,
           item.categoria, item.familia, item.marca, item.proveedor, item.iva_group,
           activo, nuevoDescatalogadoAt, actual.id]
        );
        if (cambioPrecio) {
          await pool.query(
            `INSERT INTO product_price_history (product_id, precio_pvp_old, precio_pvp_new, precio_pvf_old, precio_pvf_new, origen, changed_by_id)
             VALUES ($1,$2,$3,$4,$5,'import_sage',$6)`,
            [actual.id, actual.precio_pvp, item.precio_pvp, actual.precio_pvf, item.precio_pvf, userId]
          );
        }
        actualizados++;
        if (pasaABaja) marcadosBaja++;
        // (Si vuelveDeBaja es true, simplemente se reactivó — lo dejamos a actualizados)
      }
    }

    if (descatalogar && codigosDesap.length > 0) {
      const r = await pool.query(
        `UPDATE products SET activo=FALSE, descatalogado_at=NOW(), updated_at=NOW()
         WHERE codigo = ANY($1::text[]) AND tipo='sage' AND activo=TRUE`,
        [codigosDesap]
      );
      descatalogados = r.rowCount || 0;
    }

    res.json({ success: true, creados, actualizados, descatalogados, marcados_baja: marcadosBaja });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// FASE 2.b' — ZONAS CLICABLES sobre láminas
// ============================================================================
// GET zonas de una lámina (con datos del producto asignado vía JOIN)
app.get('/api/sheets/:sheetId/zones', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.sheetId);
    const r = await pool.query(`
      SELECT z.*,
             p.codigo AS producto_codigo,
             p.nombre AS producto_nombre,
             p.ean AS producto_ean,
             p.precio_pvf AS producto_pvf,
             p.tipo AS producto_tipo,
             p.activo AS producto_activo,
             c.name AS link_catalog_nombre,
             ls.orden AS link_sheet_orden,
             ls.titulo AS link_sheet_titulo,
             lb.orden AS link_back_sheet_orden,
             lb.titulo AS link_back_sheet_titulo
      FROM sheet_zones z
      LEFT JOIN products p ON p.id = z.product_id
      LEFT JOIN catalogs c ON c.id = z.link_catalog_id
      LEFT JOIN sheets ls ON ls.id = z.link_sheet_id
      LEFT JOIN sheets lb ON lb.id = z.link_back_sheet_id
      WHERE z.sheet_id = $1
      ORDER BY z.orden, z.id
    `, [sheetId]);
    res.json({ success: true, zones: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Resolver una FAMILIA (color x graduacion -> SKUs). Usado por el visor del cliente
// para pintar los selectores al pulsar una zona-familia, y por el editor admin.
app.get('/api/families/resolve', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    // Opcion A: lista CURADA de product_ids (?ids=1,2,3) -> manda sobre el nombre.
    const idsRaw = String(req.query.ids || '').trim();
    if (idsRaw) {
      const ids = idsRaw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
      const fam = await resolverFamiliaPorIds(ids);
      res.json({ success: true, familia: fam });
      return;
    }
    // Opcion B: por modelo/nombre (auto-agrupa), usado para SUGERIR variantes al crear.
    const ref = String(req.query.ref || '').trim();
    if (!ref) { res.status(400).json({ success: false, error: 'Falta ref o ids' }); return; }
    const fam = await resolverFamilia(ref);
    res.json({ success: true, familia: fam || null });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST crear zona en una lámina (solo admin real)
app.post('/api/sheets/:sheetId/zones', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.sheetId);
    const { x, y, ancho, alto, product_id, etiqueta } = req.body;
    // Validar coordenadas en rango 0-100
    if ([x, y, ancho, alto].some(v => typeof v !== 'number' || v < 0 || v > 100)) {
      res.status(400).json({ success: false, error: 'Coordenadas inválidas (deben ser % entre 0 y 100)' });
      return;
    }
    // Calcular orden (siguiente)
    const ordenR = await pool.query(`SELECT COALESCE(MAX(orden), -1) + 1 AS next FROM sheet_zones WHERE sheet_id = $1`, [sheetId]);
    const orden = ordenR.rows[0].next;
    const r = await pool.query(`
      INSERT INTO sheet_zones (sheet_id, product_id, x, y, ancho, alto, etiqueta, orden)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [sheetId, product_id || null, x, y, ancho, alto, etiqueta || null, orden]);
    logSheetChangeAgrupado('updated_zonas', sheetId, { id: req.user?.id, name: req.user?.name }, 'zona añadida');
    res.json({ success: true, zone: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// PUT actualizar zona (mover, redimensionar, asignar producto, etiqueta) — solo admin real
app.put('/api/zones/:zoneId', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = Number(req.params.zoneId);
    const { x, y, ancho, alto, product_id, etiqueta, ref_modelo, familia_ref, familia_skus, es_comision, comision_variantes, link_catalog_id, link_sheet_id, link_label, link_back_sheet_id, permite_sueltas } = req.body;
    // Construir SET dinámico solo con los campos enviados
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (x !== undefined)        { sets.push(`x = $${i++}`); vals.push(x); }
    if (y !== undefined)        { sets.push(`y = $${i++}`); vals.push(y); }
    if (ancho !== undefined)    { sets.push(`ancho = $${i++}`); vals.push(ancho); }
    if (alto !== undefined)     { sets.push(`alto = $${i++}`); vals.push(alto); }
    if (product_id !== undefined) { sets.push(`product_id = $${i++}`); vals.push(product_id || null); }
    if (etiqueta !== undefined) { sets.push(`etiqueta = $${i++}`); vals.push(etiqueta || null); }
    // Nº de modelo impreso en la lámina (expositor con un solo código en Sage)
    if (ref_modelo !== undefined) {
      const rm = ref_modelo ? String(ref_modelo).trim().substring(0, 60) : null;
      sets.push(`ref_modelo = $${i++}`); vals.push(rm);
    }
    // Los cuatro tipos (producto Sage / familia / comision / enlace) son mutuamente excluyentes.
    if (familia_ref !== undefined) {
      const fr = familia_ref ? String(familia_ref).trim().substring(0, 120) : null;
      sets.push(`familia_ref = $${i++}`); vals.push(fr);
      if (fr) { sets.push(`product_id = NULL`); sets.push(`es_comision = FALSE`); sets.push(`link_catalog_id = NULL`); }
      else if (familia_skus === undefined) { sets.push(`familia_skus = NULL`); } // quitar familia -> limpiar lista (si no lo gestiona el bloque de familia_skus)
    }
    // Lista CURADA de product_ids (JSON). Si viene con elementos, es una familia manual.
    if (familia_skus !== undefined) {
      const arr = Array.isArray(familia_skus)
        ? Array.from(new Set(familia_skus.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)))
        : null;
      if (arr && arr.length > 0) {
        sets.push(`familia_skus = $${i++}`); vals.push(JSON.stringify(arr));
        // Solo limpiar exclusivos si el bloque de familia_ref NO lo hizo ya (evita
        // "multiple assignments to same column" cuando llegan familia_ref + familia_skus juntos).
        if (familia_ref === undefined) {
          sets.push(`product_id = NULL`); sets.push(`es_comision = FALSE`); sets.push(`link_catalog_id = NULL`);
        }
      } else {
        sets.push(`familia_skus = NULL`);
      }
    }
    if (es_comision !== undefined) {
      const ec = !!es_comision;
      sets.push(`es_comision = $${i++}`); vals.push(ec);
      if (ec) {
        sets.push(`product_id = NULL`); sets.push(`familia_ref = NULL`); sets.push(`link_catalog_id = NULL`);
        if (familia_skus === undefined) sets.push(`familia_skus = NULL`);
      } else if (comision_variantes === undefined) {
        sets.push(`comision_variantes = NULL`); // quitar comision -> limpiar sus variantes
      }
    }
    // Lista de variantes de comision (nombres a mano, NO estan en Sage). JSON array de strings.
    if (comision_variantes !== undefined) {
      const cv = Array.isArray(comision_variantes)
        ? comision_variantes.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0).slice(0, 100)
        : null;
      sets.push(`comision_variantes = $${i++}`); vals.push(cv && cv.length ? JSON.stringify(cv) : null);
    }
    // Referencias sueltas del expositor: capacidad ADICIONAL, no excluyente con el tipo de zona.
    if (permite_sueltas !== undefined) {
      sets.push(`permite_sueltas = $${i++}`); vals.push(!!permite_sueltas);
    }
    if (link_catalog_id !== undefined) {
      const lc = link_catalog_id ? Number(link_catalog_id) : null;
      sets.push(`link_catalog_id = $${i++}`); vals.push(lc);
      if (lc) { sets.push(`product_id = NULL`); sets.push(`familia_ref = NULL`); sets.push(`es_comision = FALSE`); }
      else { sets.push(`link_sheet_id = NULL`); sets.push(`link_back_sheet_id = NULL`); } // sin catalogo destino no hay pagina destino ni regreso
    }
    if (link_sheet_id !== undefined) {
      const ls = link_sheet_id ? Number(link_sheet_id) : null;
      sets.push(`link_sheet_id = $${i++}`); vals.push(ls);
    }
    if (link_back_sheet_id !== undefined) {
      const lb = link_back_sheet_id ? Number(link_back_sheet_id) : null;
      sets.push(`link_back_sheet_id = $${i++}`); vals.push(lb);
    }
    if (link_label !== undefined) {
      const lbl = link_label ? String(link_label).trim().substring(0, 80) : null;
      sets.push(`link_label = $${i++}`); vals.push(lbl);
    }
    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'Nada que actualizar' });
      return;
    }
    sets.push(`updated_at = NOW()`);
    vals.push(zoneId);
    const r = await pool.query(`UPDATE sheet_zones SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Zona no encontrada' });
      return;
    }
    logSheetChangeAgrupado('updated_zonas', r.rows[0].sheet_id, { id: req.user?.id, name: req.user?.name }, 'zona editada');
    res.json({ success: true, zone: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Marcar/desmarcar una lamina como "zonas revisadas y aprobadas por el admin"
app.post('/api/sheets/:id/aprobar-zonas', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const aprobar = req.body?.aprobada !== false; // por defecto aprobar
    const r = await pool.query(
      `UPDATE sheets SET zonas_aprobadas_at = ${aprobar ? 'NOW()' : 'NULL'}, updated_at = NOW()
       WHERE id = $1 RETURNING id, zonas_aprobadas_at`,
      [id]
    );
    if (r.rows.length === 0) { res.status(404).json({ success: false, error: 'Lamina no encontrada' }); return; }
    res.json({ success: true, sheet: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// HISTORIAL de una lamina: todo lo que se le ha hecho, de lo mas reciente a lo mas
// antiguo. Es lo que se abre al pulsar el distintivo de estado en la rejilla.
app.get('/api/sheets/:id/historial', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.id);
    const s = await pool.query(`SELECT titulo, created_at, zonas_aprobadas_at FROM sheets WHERE id=$1`, [sheetId]);
    if (!s.rows.length) { res.status(404).json({ success: false, error: 'Lámina no encontrada' }); return; }
    const r = await pool.query(
      `SELECT id, tipo_cambio, campos_json, actor_name, created_at
         FROM sheet_audit_log WHERE sheet_id = $1
        ORDER BY created_at DESC LIMIT 100`, [sheetId]);
    res.json({
      success: true,
      titulo: s.rows[0].titulo,
      creada_at: s.rows[0].created_at,
      revisada_at: s.rows[0].zonas_aprobadas_at,
      cambios: r.rows
    });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// CAMBIOS RECIENTES de un catalogo (por defecto 7 dias): el "parte semanal" de lo que
// se ha tocado. Una linea por lamina con su ultimo cambio y si esta pendiente de repasar.
app.get('/api/catalogs/:id/cambios', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    const dias = Math.max(1, Math.min(365, parseInt(String(req.query.dias || '7'), 10) || 7));
    const r = await pool.query(
      `SELECT a.sheet_id, s.orden, s.titulo, s.zonas_aprobadas_at,
              MAX(a.created_at) AS ultimo_cambio,
              ARRAY_AGG(DISTINCT a.tipo_cambio) AS tipos,
              COUNT(*)::int AS n_cambios,
              MAX(a.actor_name) AS actor
         FROM sheet_audit_log a
         JOIN sheets s ON s.id = a.sheet_id
        WHERE a.catalog_id = $1
          AND a.created_at > NOW() - ($2 || ' days')::interval
          AND a.tipo_cambio <> 'deleted'
        GROUP BY a.sheet_id, s.orden, s.titulo, s.zonas_aprobadas_at
        ORDER BY MAX(a.created_at) DESC`, [catalogId, String(dias)]);
    const filas = r.rows.map((x: any) => ({
      ...x,
      // "pendiente de repasar" = se tocó DESPUÉS de darla por revisada (o nunca se revisó)
      pendiente: !x.zonas_aprobadas_at || new Date(x.ultimo_cambio) > new Date(x.zonas_aprobadas_at)
    }));
    res.json({ success: true, dias, cambios: filas, total: filas.length, pendientes: filas.filter(f => f.pendiente).length });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Asignar el MISMO producto a todas las zonas de la lamina (expositor de un solo codigo
// en Sage: pendientes, bisuteria...). Asi no hay que repetir la misma busqueda 16 veces.
// solo_vacias=true (por defecto) respeta las zonas que ya tienen producto o son de otro tipo.
app.post('/api/sheets/:sheetId/zones/aplicar-producto', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.sheetId);
    const productId = Number(req.body?.product_id);
    if (!Number.isInteger(productId) || productId <= 0) {
      res.status(400).json({ success: false, error: 'product_id obligatorio' });
      return;
    }
    const soloVacias = req.body?.solo_vacias !== false;
    const p = await pool.query(`SELECT id FROM products WHERE id = $1`, [productId]);
    if (!p.rows.length) { res.status(404).json({ success: false, error: 'Producto no encontrado' }); return; }
    // Nunca se tocan familia / comision / enlace: son tipos de zona excluyentes.
    const r = await pool.query(`
      UPDATE sheet_zones SET product_id = $1, updated_at = NOW()
       WHERE sheet_id = $2
         AND familia_ref IS NULL AND familia_skus IS NULL
         AND COALESCE(es_comision, FALSE) = FALSE
         AND link_catalog_id IS NULL
         ${soloVacias ? 'AND product_id IS NULL' : ''}
       RETURNING id`, [productId, sheetId]);
    res.json({ success: true, actualizadas: r.rowCount || 0 });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// DELETE borrar zona — solo admin real
app.delete('/api/zones/:zoneId', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = Number(req.params.zoneId);
    const z = await pool.query(`SELECT sheet_id FROM sheet_zones WHERE id = $1`, [zoneId]);
    const r = await pool.query(`DELETE FROM sheet_zones WHERE id = $1`, [zoneId]);
    if (z.rows.length) logSheetChangeAgrupado('updated_zonas', z.rows[0].sheet_id, { id: req.user?.id, name: req.user?.name }, 'zona borrada');
    res.json({ success: true, borrada: (r.rowCount || 0) > 0 });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// DELETE TODAS las zonas de una lamina de golpe (ej. expositor grande con muchas
// zonas auto que en realidad es 1 solo producto) — solo admin real
app.delete('/api/sheets/:id/zones', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sheetId = Number(req.params.id);
    const r = await pool.query(`DELETE FROM sheet_zones WHERE sheet_id = $1`, [sheetId]);
    if (r.rowCount) logSheetChangeAgrupado('updated_zonas', sheetId, { id: req.user?.id, name: req.user?.name }, 'borradas todas las zonas (' + r.rowCount + ')');
    res.json({ success: true, borradas: r.rowCount || 0 });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// AULA DE FORMACIÓN (Bloque 1: backend admin)
// Almacenamiento: /app/data/uploads/formaciones/
// Formatos: PDF, imágenes, DOCX, PPTX, MP4 (1A)
// Tamaño: 50 MB documentos / 200 MB vídeos (2A)
// ============================================================================

// Directorio dedicado a formaciones (separado del resto de uploads)
function getFormacionesDir(): string {
  const path = require('path');
  const fs = require('fs');
  const dir = path.join(UPLOADS_DIR, 'formaciones');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Storage específico para formaciones
const storageFormaciones = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getFormacionesDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
    cb(null, `${Date.now()}_${safe}`);
  }
});

// Validación de tipos MIME permitidos
// 1A: PDF, imágenes, DOCX, PPTX, vídeos MP4
const MIMES_FORMACION_DOC = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];
const MIMES_FORMACION_VIDEO = [
  'video/mp4', 'video/webm', 'video/quicktime'
];

const uploadFormacion = multer({
  storage: storageFormaciones,
  // Límite mayor (200 MB) — luego validamos por tipo en el handler (50 MB doc / 200 MB vídeo)
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const tipo = file.mimetype;
    if (MIMES_FORMACION_DOC.includes(tipo) || MIMES_FORMACION_VIDEO.includes(tipo)) {
      cb(null, true);
    } else {
      cb(new Error(`Formato no permitido: ${tipo}. Solo PDF, imágenes, Word, PowerPoint o vídeos MP4.`));
    }
  }
});

// POST crear formación (admin sube archivo + metadatos)
app.post('/api/formaciones', verifyToken, requireRealAdmin, uploadFormacion.single('archivo'),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Falta el archivo' });
      return;
    }
    // Validación de tamaño por tipo (50 MB documento, 200 MB vídeo)
    const esVideo = MIMES_FORMACION_VIDEO.includes(req.file.mimetype);
    const limite = esVideo ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
    if (req.file.size > limite) {
      // Borrar el archivo recién subido para no dejar basura
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
      res.status(400).json({
        success: false,
        error: `Archivo demasiado grande. Máximo: ${esVideo ? '200 MB para vídeos' : '50 MB para documentos'}`
      });
      return;
    }
    const { laboratorio, nombre, tematica, descripcion, fecha_formacion, publico } = req.body;
    if (!laboratorio || !String(laboratorio).trim()) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
      res.status(400).json({ success: false, error: 'Falta el laboratorio' });
      return;
    }
    if (!nombre || !String(nombre).trim()) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
      res.status(400).json({ success: false, error: 'Falta el nombre' });
      return;
    }
    const r = await pool.query(`
      INSERT INTO formaciones
        (laboratorio, nombre, tematica, descripcion, archivo_path, archivo_nombre,
         archivo_mime, archivo_size, fecha_formacion, publico, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        String(laboratorio).trim(),
        String(nombre).trim(),
        tematica ? String(tematica).trim() : null,
        descripcion ? String(descripcion).trim() : null,
        req.file.path,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        fecha_formacion ? fecha_formacion : null,
        publico === 'false' || publico === false ? false : true,
        req.user!.id
      ]
    );
    // LL2: disparar email automático al CREAR (en background, no bloquea la respuesta)
    notificarFormacion(r.rows[0].id, 'nueva', req.user!.id)
      .catch((e: any) => console.error('[notif-formacion]:', e.message));
    res.json({ success: true, formacion: r.rows[0] });
  } catch (e) {
    // Si falló a mitad, limpiar archivo subido
    if (req.file) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// CATEGORÍAS / TAGS DE LÁMINAS
// ============================================================================

// GET listar todas las categorías (admin y comerciales pueden leer)
app.get('/api/categorias', verifyToken, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`
      SELECT c.*,
             (SELECT COUNT(*)::int FROM sheet_categorias sc WHERE sc.categoria_id = c.id) AS num_laminas
      FROM categorias c
      ORDER BY c.orden ASC, c.nombre ASC
    `);
    res.json({ success: true, categorias: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// POST crear categoría (solo admin)
app.post('/api/categorias', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { nombre, color, orden } = req.body || {};
    if (!nombre || typeof nombre !== 'string' || nombre.trim().length === 0) {
      res.status(400).json({ success: false, error: 'El nombre es obligatorio' });
      return;
    }
    const r = await pool.query(
      'INSERT INTO categorias (nombre, color, orden) VALUES ($1, $2, $3) RETURNING *',
      [nombre.trim().substring(0, 80), color || '#cc007a', orden || 0]
    );
    res.status(201).json({ success: true, categoria: r.rows[0] });
  } catch (e: any) {
    if (e.code === '23505') { // unique violation
      res.status(400).json({ success: false, error: 'Ya existe una categoría con ese nombre' });
    } else {
      res.status(400).json({ success: false, error: e.message });
    }
  }
});

// PUT editar categoría (solo admin)
app.put('/api/categorias/:id', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { nombre, color, orden } = req.body || {};
    const r = await pool.query(
      `UPDATE categorias SET
         nombre = COALESCE($1, nombre),
         color = COALESCE($2, color),
         orden = COALESCE($3, orden)
       WHERE id = $4 RETURNING *`,
      [nombre ? nombre.trim().substring(0, 80) : null, color, orden, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Categoría no encontrada' });
      return;
    }
    res.json({ success: true, categoria: r.rows[0] });
  } catch (e: any) {
    if (e.code === '23505') {
      res.status(400).json({ success: false, error: 'Ya existe otra categoría con ese nombre' });
    } else {
      res.status(400).json({ success: false, error: e.message });
    }
  }
});

// DELETE eliminar categoría (solo admin)
app.delete('/api/categorias/:id', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
    if (r.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Categoría no encontrada' });
      return;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// GET categorías asignadas a una lámina
app.get('/api/sheets/:id/categorias', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`
      SELECT c.* FROM categorias c
      INNER JOIN sheet_categorias sc ON sc.categoria_id = c.id
      WHERE sc.sheet_id = $1
      ORDER BY c.orden ASC, c.nombre ASC
    `, [id]);
    res.json({ success: true, categorias: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// PUT actualizar categorías de una lámina (reemplaza todas) — solo admin
app.put('/api/sheets/:id/categorias', verifyToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const sheetId = Number(req.params.id);
    const { categoria_ids } = req.body || {};
    if (!Array.isArray(categoria_ids)) {
      res.status(400).json({ success: false, error: 'categoria_ids debe ser un array' });
      return;
    }
    await client.query('BEGIN');
    await client.query('DELETE FROM sheet_categorias WHERE sheet_id = $1', [sheetId]);
    for (const catId of categoria_ids) {
      const cid = Number(catId);
      if (!isNaN(cid)) {
        await client.query(
          'INSERT INTO sheet_categorias (sheet_id, categoria_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [sheetId, cid]
        );
      }
    }
    await client.query('COMMIT');
    // Asignar la categoria es el momento en que se sabe de que laboratorio es la lamina:
    // aqui es donde tienen sentido las reglas de reparto. Best-effort: si algo falla, se
    // guardan las categorias igual y la lamina queda en la bandeja de "sin repartir".
    let reparto = null;
    try { reparto = await repartirLamina(sheetId); } catch (_) {}
    res.json({ success: true, reparto });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, error: (e as Error).message });
  } finally {
    client.release();
  }
});

// GET listar todas las categorias incluidas en TODAS las laminas de un catalogo
// (para que el visor del comercial pueda mostrar solo los filtros relevantes)
app.get('/api/catalogs/:id/categorias-disponibles', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const catalogId = Number(req.params.id);
    const r = await pool.query(`
      SELECT DISTINCT c.*,
             (SELECT COUNT(*)::int FROM sheet_categorias sc2
               INNER JOIN sheets s2 ON s2.id = sc2.sheet_id
              WHERE sc2.categoria_id = c.id AND s2.catalog_id = $1) AS num_laminas
      FROM categorias c
      INNER JOIN sheet_categorias sc ON sc.categoria_id = c.id
      INNER JOIN sheets s ON s.id = sc.sheet_id
      WHERE s.catalog_id = $1
      ORDER BY c.orden ASC, c.nombre ASC
    `, [catalogId]);
    res.json({ success: true, categorias: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// FORMACIONES (Aula)
// ============================================================================

// GET listar todas las formaciones (admin ve todo, comercial ve las que puede)
app.get('/api/formaciones', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const esAdmin = req.user?.role === 'admin';
    const userId = effectiveUserId(req);
    let sql = `
      SELECT f.*,
             u.name AS creador_nombre,
             (SELECT COUNT(*)::int FROM formacion_versions WHERE formacion_id = f.id) AS num_versiones_archivadas
      FROM formaciones f
      LEFT JOIN users u ON u.id = f.creado_por
    `;
    const params: any[] = [];
    if (!esAdmin) {
      // Comercial: solo las públicas O las que tiene permisos individuales
      sql += `
        WHERE f.publico = TRUE
          OR f.id IN (SELECT formacion_id FROM formacion_permisos WHERE user_id = $1)
      `;
      params.push(userId);
    }
    sql += ` ORDER BY f.fecha_formacion DESC NULLS LAST, f.created_at DESC`;
    const r = await pool.query(sql, params);
    res.json({ success: true, formaciones: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET descargar archivo de formación (con verificación de permisos)
app.get('/api/formaciones/:id/descargar', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const esAdmin = req.user?.role === 'admin';
    const userId = effectiveUserId(req);
    const f = await pool.query(`SELECT * FROM formaciones WHERE id = $1`, [id]);
    if (f.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Formación no encontrada' });
      return;
    }
    const formacion = f.rows[0];
    // Verificar permisos si no es admin
    if (!esAdmin && !formacion.publico) {
      const p = await pool.query(
        `SELECT 1 FROM formacion_permisos WHERE formacion_id = $1 AND user_id = $2`,
        [id, userId]
      );
      if (p.rows.length === 0) {
        res.status(403).json({ success: false, error: 'No tienes acceso a esta formación' });
        return;
      }
    }
    const fs = require('fs');
    if (!fs.existsSync(formacion.archivo_path)) {
      res.status(404).json({ success: false, error: 'Archivo no encontrado en el servidor' });
      return;
    }
    res.setHeader('Content-Type', formacion.archivo_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(formacion.archivo_nombre)}"`);
    fs.createReadStream(formacion.archivo_path).pipe(res);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  }
});

// PUT editar metadatos (sin tocar archivo)
app.put('/api/formaciones/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { laboratorio, nombre, tematica, descripcion, fecha_formacion, publico } = req.body;
    const f = await pool.query(`SELECT id FROM formaciones WHERE id = $1`, [id]);
    if (f.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Formación no encontrada' });
      return;
    }
    const r = await pool.query(`
      UPDATE formaciones SET
        laboratorio = COALESCE($1, laboratorio),
        nombre = COALESCE($2, nombre),
        tematica = $3,
        descripcion = $4,
        fecha_formacion = $5,
        publico = COALESCE($6, publico),
        updated_at = NOW()
      WHERE id = $7 RETURNING *`,
      [
        laboratorio ? String(laboratorio).trim() : null,
        nombre ? String(nombre).trim() : null,
        tematica !== undefined ? (tematica ? String(tematica).trim() : null) : null,
        descripcion !== undefined ? (descripcion ? String(descripcion).trim() : null) : null,
        fecha_formacion !== undefined ? (fecha_formacion || null) : null,
        (publico === true || publico === 'true') ? true : (publico === false || publico === 'false') ? false : null,
        id
      ]
    );
    res.json({ success: true, formacion: r.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// DELETE eliminar formación (borra archivo físico y registros)
app.delete('/api/formaciones/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const f = await pool.query(`SELECT archivo_path FROM formaciones WHERE id = $1`, [id]);
    if (f.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Formación no encontrada' });
      return;
    }
    // También borrar archivos de versiones archivadas
    const versiones = await pool.query(
      `SELECT archivo_path FROM formacion_versions WHERE formacion_id = $1`, [id]
    );
    // Borrar archivos físicos
    const fs = require('fs');
    try { if (fs.existsSync(f.rows[0].archivo_path)) fs.unlinkSync(f.rows[0].archivo_path); } catch (_) {}
    for (const v of versiones.rows) {
      try { if (fs.existsSync(v.archivo_path)) fs.unlinkSync(v.archivo_path); } catch (_) {}
    }
    // Borrar registros (CASCADE elimina versions y permisos)
    await pool.query(`DELETE FROM formaciones WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// GET listar laboratorios distintos (para el filtro)
app.get('/api/formaciones/laboratorios', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT laboratorio FROM formaciones
      WHERE laboratorio IS NOT NULL AND laboratorio <> ''
      ORDER BY laboratorio
    `);
    res.json({ success: true, laboratorios: r.rows.map((x: any) => x.laboratorio) });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// AULA — BLOQUE 3: Permisos individuales por comercial
// HH1: integrado en modal crear/editar (frontend manda lista de user_ids)
// II2: al cambiar de restringida a pública, NO se borran permisos (se conservan)
// ============================================================================

// GET listar IDs de comerciales con permiso explícito sobre una formación
app.get('/api/formaciones/:id/permisos', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(
      `SELECT user_id FROM formacion_permisos WHERE formacion_id = $1`, [id]
    );
    res.json({ success: true, user_ids: r.rows.map((x: any) => x.user_id) });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// PUT actualizar permisos: reemplaza la lista completa
// Body: { user_ids: [1, 2, 3] }
app.put('/api/formaciones/:id/permisos', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { user_ids } = req.body;
    if (!Array.isArray(user_ids)) {
      res.status(400).json({ success: false, error: 'user_ids debe ser un array' });
      return;
    }
    const f = await pool.query(`SELECT id FROM formaciones WHERE id = $1`, [id]);
    if (f.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Formación no encontrada' });
      return;
    }
    // Estrategia simple: borrar todos y reinsertar (transacción para atomicidad)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM formacion_permisos WHERE formacion_id = $1`, [id]);
      for (const uid of user_ids) {
        const uidNum = Number(uid);
        if (!isNaN(uidNum)) {
          await client.query(
            `INSERT INTO formacion_permisos (formacion_id, user_id) VALUES ($1, $2)
             ON CONFLICT (formacion_id, user_id) DO NOTHING`,
            [id, uidNum]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true, count: user_ids.length });
  } catch (e) {
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// ============================================================================
// AULA — BLOQUE 3: Reemplazar archivo (histórico de versiones)
// JJ1: integrado en modal editar (campo opcional "Reemplazar archivo")
// Si se sube nuevo archivo: el anterior va a formacion_versions, el nuevo
// pasa a ser el activo. Disparará email automático (LL2).
// ============================================================================
app.post('/api/formaciones/:id/reemplazar-archivo', verifyToken, requireRealAdmin,
  uploadFormacion.single('archivo'),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Falta el archivo' });
      return;
    }
    const id = Number(req.params.id);
    const { notas } = req.body;
    // Validar tamaño según tipo
    const esVideo = MIMES_FORMACION_VIDEO.includes(req.file.mimetype);
    const limite = esVideo ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
    if (req.file.size > limite) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
      res.status(400).json({
        success: false,
        error: `Archivo demasiado grande. Máximo: ${esVideo ? '200 MB para vídeos' : '50 MB para documentos'}`
      });
      return;
    }
    // Cargar formación actual
    const f = await pool.query(`SELECT * FROM formaciones WHERE id = $1`, [id]);
    if (f.rows.length === 0) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
      res.status(404).json({ success: false, error: 'Formación no encontrada' });
      return;
    }
    const actual = f.rows[0];
    // Mover el archivo actual al histórico
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO formacion_versions
          (formacion_id, archivo_path, archivo_nombre, archivo_mime, archivo_size, notas, reemplazado_por)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        id,
        actual.archivo_path,
        actual.archivo_nombre,
        actual.archivo_mime,
        actual.archivo_size,
        notas ? String(notas).trim() : null,
        req.user!.id
      ]);
      // Actualizar la formación con el nuevo archivo
      await client.query(`
        UPDATE formaciones SET
          archivo_path = $1,
          archivo_nombre = $2,
          archivo_mime = $3,
          archivo_size = $4,
          updated_at = NOW()
        WHERE id = $5
      `, [
        req.file.path,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        id
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      // Si la transacción falla, borrar el archivo recién subido
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
    // Disparar email automático en background (LL2 + MM2)
    notificarFormacion(id, 'actualizada', req.user!.id)
      .catch((e: any) => console.error('[notif-formacion]:', e.message));
    res.json({ success: true });
  } catch (e) {
    if (req.file) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

// GET listar versiones archivadas
app.get('/api/formaciones/:id/versiones', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`
      SELECT v.*, u.name AS reemplazado_por_nombre
      FROM formacion_versions v
      LEFT JOIN users u ON u.id = v.reemplazado_por
      WHERE v.formacion_id = $1
      ORDER BY v.archivado_at DESC
    `, [id]);
    res.json({ success: true, versiones: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET descargar versión archivada
app.get('/api/formaciones/versiones/:versionId/descargar', verifyToken, requireRealAdmin,
  async (req: AuthRequest, res: Response) => {
  try {
    const versionId = Number(req.params.versionId);
    const r = await pool.query(`SELECT * FROM formacion_versions WHERE id = $1`, [versionId]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Versión no encontrada' });
      return;
    }
    const v = r.rows[0];
    const fs = require('fs');
    if (!fs.existsSync(v.archivo_path)) {
      res.status(404).json({ success: false, error: 'Archivo de versión no existe en disco' });
      return;
    }
    res.setHeader('Content-Type', v.archivo_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(v.archivo_nombre)}"`);
    fs.createReadStream(v.archivo_path).pipe(res);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  }
});

// ============================================================================
// AULA — BLOQUE 3: Email automático al crear/actualizar (LL2 + MM2)
// MM2: solo a comerciales con acceso REAL (públicas: todos; restringida: solo los autorizados)
// Respeta toggle GG3 (recibir_notificaciones)
// ============================================================================
async function notificarFormacion(formacionId: number, accion: 'nueva' | 'actualizada', actorId: number) {
  try {
    // Cargar formación
    const fR = await pool.query(`SELECT * FROM formaciones WHERE id = $1`, [formacionId]);
    if (fR.rows.length === 0) return;
    const f = fR.rows[0];

    // Determinar destinatarios según pública/restringida y toggle de notificaciones
    let destinatarios: any[] = [];
    if (f.publico) {
      // Públicas: todos los comerciales activos con notificaciones ON
      const r = await pool.query(`
        SELECT id, email, name FROM users
        WHERE role = 'sales' AND is_active = TRUE
          AND COALESCE(recibir_notificaciones, TRUE) = TRUE
          AND email IS NOT NULL AND email <> ''
      `);
      destinatarios = r.rows;
    } else {
      // Restringidas: solo los del formacion_permisos con notificaciones ON
      const r = await pool.query(`
        SELECT u.id, u.email, u.name
        FROM users u
        JOIN formacion_permisos fp ON fp.user_id = u.id
        WHERE fp.formacion_id = $1
          AND u.role = 'sales' AND u.is_active = TRUE
          AND COALESCE(u.recibir_notificaciones, TRUE) = TRUE
          AND u.email IS NOT NULL AND u.email <> ''
      `, [formacionId]);
      destinatarios = r.rows;
    }

    if (destinatarios.length === 0) {
      console.log('[notif-formacion] Sin destinatarios para formación ' + formacionId);
      return;
    }

    // Nombre del actor
    let nombreActor = 'el administrador';
    try {
      const a = await pool.query(`SELECT name FROM users WHERE id = $1`, [actorId]);
      if (a.rows.length > 0) nombreActor = a.rows[0].name;
    } catch (_) {}

    const appUrl = process.env.APP_PUBLIC_URL || 'https://catalogo-pro-v2-production.up.railway.app';
    const verbo = accion === 'nueva' ? 'subido nueva' : 'actualizado';
    const asunto = `🎓 Formación ${accion === 'nueva' ? 'nueva' : 'actualizada'} · ${f.laboratorio}: ${f.nombre}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333">
        <div style="background: linear-gradient(135deg, #cc007a 0%, #a3005f 100%); color: #fff; padding: 24px; border-radius: 8px 8px 0 0">
          <h2 style="margin: 0; font-size: 20px">🎓 Aula de formación</h2>
          <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px">CatalogPRO · LOMHIFAR</p>
        </div>
        <div style="background: #fff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px">
          <p style="margin: 0 0 14px 0; font-size: 14px">Hola,</p>
          <p style="margin: 0 0 14px 0; font-size: 14px">
            <b>${escapeHtml(nombreActor)}</b> ha ${verbo} formación en el aula:
          </p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 14px 0">
            <div style="font-size: 11px; text-transform: uppercase; color: #be185d; font-weight: 700; margin-bottom: 4px">
              🧪 ${escapeHtml(f.laboratorio)}
            </div>
            <div style="font-size: 16px; font-weight: 600; color: #111827; margin-bottom: 6px">
              ${escapeHtml(f.nombre)}
            </div>
            ${f.tematica ? `<div style="font-size: 12px; color: #6b7280">Temática: ${escapeHtml(f.tematica)}</div>` : ''}
            ${f.descripcion ? `<div style="font-size: 13px; color: #4b5563; margin-top: 8px">${escapeHtml(String(f.descripcion).substring(0, 200))}${f.descripcion.length > 200 ? '…' : ''}</div>` : ''}
          </div>
          <p style="margin: 14px 0; font-size: 14px">
            Entra al aula para verlo:
          </p>
          <div style="text-align: center; margin: 24px 0">
            <a href="${appUrl}" style="display: inline-block; background: #cc007a; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px">
              🎓 Abrir Aula
            </a>
          </div>
          <hr style="border: none; border-top: 1px solid #f3f4f6; margin: 20px 0">
          <p style="font-size: 11px; color: #9ca3af; margin: 0">
            Recibes este email porque tienes activadas las notificaciones en tu cuenta.
            Para desactivarlas: <b>Mi cuenta</b> → Notificaciones.
          </p>
        </div>
      </div>
    `;

    let ok = 0, err = 0;
    for (const d of destinatarios) {
      try {
        const r = await enviarEmailConRedireccion({
          rol: 'comercial',
          destinatarioReal: d.email,
          asunto,
          html
        });
        if (r.ok) ok++; else err++;
      } catch (e: any) {
        err++;
        console.error('[notif-formacion] Error a ' + d.email + ':', e.message);
      }
    }
    console.log(`[notif-formacion] Formación ${formacionId} (${accion}): ${ok} OK, ${err} fallidos de ${destinatarios.length}`);
  } catch (e: any) {
    console.error('[notif-formacion] Error global:', e.message);
  }
}

// ============================================================================
// CANAL DE INCIDENCIAS  (comercial -> admin)
// El comercial reporta desde la propia app, con captura opcional. Se guarda
// SIEMPRE la version y la pantalla: la mitad de los "no funciona" son versiones
// viejas cacheadas, y sin eso se pierde el tiempo a ciegas.
// Aviso a Telegram opcional: en cuanto existan las variables de entorno
// INCIDENCIAS_BOT_TOKEN / INCIDENCIAS_CHAT_ID empieza a avisar, sin tocar codigo.
// ============================================================================
async function avisarIncidenciaTelegram(inc: any): Promise<void> {
  const token = process.env.INCIDENCIAS_BOT_TOKEN, chat = process.env.INCIDENCIAS_CHAT_ID;
  if (!token || !chat) return;   // aun no configurado: no pasa nada
  try {
    const t = `🛟 *${inc.tipo}* de ${inc.autor || 'alguien'}\n` +
      `${String(inc.texto).slice(0, 500)}\n` +
      `_${inc.version_app || 's/v'} · ${inc.pantalla || ''}_`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: t, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error('[incidencias] Telegram:', (e as Error).message); }
}

// Reportar (cualquier usuario identificado). Captura opcional.
app.post('/api/incidencias', verifyToken, upload.single('captura'), async (req: AuthRequest, res: Response) => {
  try {
    const texto = String(req.body?.texto || '').trim();
    if (!texto) { res.status(400).json({ success: false, error: 'Escribe qué ha pasado' }); return; }
    const tipo = ['incidencia', 'sugerencia', 'duda'].includes(req.body?.tipo) ? req.body.tipo : 'incidencia';
    const u = (await pool.query('SELECT name, email, role FROM users WHERE id=$1', [req.user?.id])).rows[0] || {};
    const r = await pool.query(
      `INSERT INTO incidencias (user_id, autor, rol, tipo, texto, captura_path, version_app, pantalla, dispositivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user?.id || null, (u.name || u.email || '').slice(0, 150), u.role || null, tipo,
       texto.slice(0, 4000), req.file ? req.file.filename : null,
       String(req.body?.version || '').slice(0, 40), String(req.body?.pantalla || '').slice(0, 200),
       String(req.headers['user-agent'] || '').slice(0, 300)]);
    avisarIncidenciaTelegram(r.rows[0]).catch(() => {});   // best-effort: nunca puede tumbar el proceso
    res.json({ success: true, incidencia: { id: r.rows[0].id } });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Las mías (el comercial ve su historial y la respuesta del admin).
app.get('/api/incidencias/mias', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT id, tipo, texto, captura_path, estado, respuesta, respondida_at, created_at
         FROM incidencias WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user?.id]);
    res.json({ success: true, incidencias: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Bandeja del admin. `estado=pendientes` = nuevas + vistas (lo que queda por cerrar).
app.get('/api/admin/incidencias', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const filtro = String(req.query.estado || 'pendientes');
    const cond = filtro === 'todas' ? '' : (filtro === 'pendientes' ? `WHERE estado <> 'resuelta'` : `WHERE estado = '${filtro.replace(/[^a-z]/g, '')}'`);
    const r = await pool.query(`SELECT * FROM incidencias ${cond} ORDER BY created_at DESC LIMIT 200`);
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM incidencias WHERE estado <> 'resuelta'`);
    res.json({ success: true, incidencias: r.rows, pendientes: n.rows[0].n });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Contador para el aviso del menu (barato, se puede pedir a menudo).
app.get('/api/admin/incidencias/pendientes', verifyToken, requireRealAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM incidencias WHERE estado <> 'resuelta'`);
    res.json({ success: true, pendientes: n.rows[0].n });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Responder / cambiar estado.
app.put('/api/admin/incidencias/:id', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (req.body?.estado && ['nueva', 'vista', 'resuelta'].includes(req.body.estado)) { sets.push(`estado=$${i++}`); vals.push(req.body.estado); }
    if (req.body?.respuesta !== undefined) {
      sets.push(`respuesta=$${i++}`); vals.push(String(req.body.respuesta).slice(0, 4000));
      sets.push(`respondida_at=NOW()`);
    }
    if (!sets.length) { res.status(400).json({ success: false, error: 'Nada que cambiar' }); return; }
    vals.push(Number(req.params.id));
    const r = await pool.query(`UPDATE incidencias SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rows.length) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.json({ success: true, incidencia: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// Captura de una incidencia (sirve la imagen solo a quien puede verla).
app.get('/api/incidencias/:id/captura', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query('SELECT user_id, captura_path FROM incidencias WHERE id=$1', [Number(req.params.id)]);
    if (!r.rows.length || !r.rows[0].captura_path) { res.status(404).json({ success: false, error: 'Sin captura' }); return; }
    if (req.user?.role !== 'admin' && r.rows[0].user_id !== req.user?.id) { res.status(403).json({ success: false, error: 'No autorizado' }); return; }
    const abs = path.join(UPLOADS_DIR, path.basename(r.rows[0].captura_path));
    if (!fs.existsSync(abs)) { res.status(404).json({ success: false, error: 'No encontrada' }); return; }
    res.sendFile(abs);
  } catch (e) { res.status(500).json({ success: false, error: (e as Error).message }); }
});

// ============================================================================
// FRONTEND FALLBACK (DEBE ser el último GET, después de todos los /api/*)
// Solo sirve index.html para rutas tipo "SPA" (sin extension o html).
// Para /api/* y /uploads/* responde 404 limpio en lugar de devolver HTML 200
// (eso confundia al navegador: al pedir una imagen huerfana recibia HTML
// y la mostraba como broken image).
// ============================================================================
app.get('*', (req, res) => {
  const url = req.path;
  if (url.startsWith('/api/') || url.startsWith('/uploads/')) {
    res.status(404).json({ success: false, error: 'Recurso no encontrado' });
    return;
  }
  // Si pide un archivo con extension reconocible (.css/.js/.png/etc) que no existe,
  // 404 en vez de devolver el HTML del SPA (que generaria errores raros).
  if (/\.[a-z0-9]{2,5}$/i.test(url) && !url.endsWith('.html')) {
    res.status(404).send('Not found');
    return;
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ============================================================================
// ERROR HANDLER GLOBAL DE EXPRESS (debe ir DESPUES de todas las rutas)
// Si alguna ruta async lanza una excepcion no capturada, Express por defecto
// la silencia y deja la peticion colgada hasta timeout. Este middleware la
// captura, devuelve JSON limpio al cliente y loguea el stack completo.
// ============================================================================
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error('[express-error]', req.method, req.path, '-', err?.message || err);
  if (err?.stack) console.error(err.stack);
  if (res.headersSent) return;
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    detail: process.env.NODE_ENV === 'production' ? undefined : String(err?.message || err)
  });
});

// ============================================================================
// PROCESS-LEVEL CRASH GUARDS
// uncaughtException: error sincrono no capturado en ningun try/catch.
// unhandledRejection: promise rechazada sin .catch().
// Estrategia: log detallado + exit(1). Railway re-arranca el contenedor
// automaticamente cuando el proceso sale con codigo distinto de 0. Esto es
// PREFERIBLE a seguir vivo en estado corrupto (puede tener memoria leakeada
// o pool roto). Recuperacion rapida (~3-5s) y consistente.
// ============================================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL uncaughtException]', err?.message, err?.stack,
    '| última petición:', _ultimaPeticion, '| memoria MB:', Math.round(process.memoryUsage().rss / 1048576));
  // Dar 1s a que los logs floten antes de salir
  setTimeout(() => process.exit(1), 1000).unref();
});

// unhandledRejection = casi siempre un .catch() olvidado en UNA petición. Antes
// se mataba el proceso: un fallo puntual de un usuario dejaba a TODOS los
// comerciales con Error 502. Ahora se registra con detalle (incluida la última
// petición atendida, para poder localizarlo) y solo se reinicia si se repite,
// que ahí sí huele a estado corrupto.
let _rechazos = 0;
process.on('unhandledRejection', (reason: any) => {
  _rechazos++;
  console.error(`[unhandledRejection #${_rechazos}]`, reason?.message || reason, reason?.stack,
    '| última petición:', _ultimaPeticion, '| memoria MB:', Math.round(process.memoryUsage().rss / 1048576));
  if (_rechazos >= 5) {
    console.error('[FATAL] 5 promesas rechazadas sin capturar: reiniciando por seguridad.');
    setTimeout(() => process.exit(1), 1000).unref();
  }
});
setInterval(() => { _rechazos = 0; }, 10 * 60 * 1000).unref();   // se olvida cada 10 min

// ============================================================================
// ARRANQUE + GRACEFUL SHUTDOWN
// ============================================================================
let server: import('http').Server | null = null;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] Recibido ${signal}, cerrando ordenadamente...`);
  // 1) Dejar de aceptar nuevas conexiones HTTP
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    console.log('[shutdown] HTTP server cerrado');
  }
  // 2) Cerrar pool de PostgreSQL (espera queries en vuelo)
  try {
    await pool.end();
    console.log('[shutdown] Pool PG cerrado');
  } catch (e) {
    console.error('[shutdown] Error cerrando pool:', (e as Error).message);
  }
  console.log('[shutdown] Listo. Bye.');
  process.exit(0);
}

// Railway envia SIGTERM al redeployar; tambien manejamos SIGINT (Ctrl+C local)
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

initDB().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CatalogPRO v2 escuchando en puerto ${PORT}`);
  });
  // Keep-alive timeout > 60s para no cortar peticiones largas (PDF, ZIP)
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
}).catch(e => {
  console.error('❌ Error fatal al arrancar - DETALLE COMPLETO:');
  console.error('  Tipo:', typeof e);
  console.error('  Error JSON:', JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
  console.error('  toString:', String(e));
  if (e instanceof Error) {
    console.error('  Mensaje:', e.message);
    console.error('  Stack:', e.stack);
  }
  // Exit con codigo 1 -> Railway re-arranca el contenedor automaticamente
  process.exit(1);
});
