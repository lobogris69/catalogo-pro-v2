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
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '2.0.0',
    build: 'aula-bloque1-09jun',
    service: 'CatalogPRO v2'
  });
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
function generarPdfCatalogoStream(catalog: any, sheets: any[], destStream: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const PDFDocumentLib = require('pdfkit');
    const doc = new PDFDocumentLib({ size: 'A4', margin: 0, autoFirstPage: false });
    doc.pipe(destStream);
    destStream.on('finish', () => resolve());
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
      `Generado: ${new Date().toLocaleString('es-ES')}`,
      { align: 'center' }
    );

    // Cada lámina en una página, ajustada al tamaño
    for (const sheet of sheets) {
      const imgPath = getSheetImagePath(sheet);
      if (!fs.existsSync(imgPath)) {
        console.warn('[PDF] Imagen no encontrada: ' + imgPath);
        continue;
      }
      try {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
        doc.fontSize(8).fillColor('#666').text(
          `${catalog.name} · Lám. ${sheet.orden || '?'}${sheet.titulo ? ' · ' + sheet.titulo : ''}`,
          20, 10, { width: 800, align: 'left' }
        );
        doc.image(imgPath, 20, 25, {
          fit: [800, 540],
          align: 'center',
          valign: 'center'
        });
        doc.fontSize(8).fillColor('#999').text(
          `Página ${sheet.orden || '?'}`,
          20, 575, { width: 800, align: 'center' }
        );
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
    const filename = `${nombreFicheroSeguro(catalog.name)}_v${catalog.version || 1}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await generarPdfCatalogoStream(catalog, sheets, res);
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
app.get('/api/admin/limpiar-pruebas/preview', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const counts: any = {};
    const tablas = [
      ['catalogs', 'catálogos'],
      ['sheets', 'láminas'],
      ['visits', 'visitas'],
      ['annotations', 'anotaciones'],
      ['catalog_versions', 'versiones'],
      ['visit_emails', 'emails registrados']
    ];
    for (const [tabla, label] of tablas) {
      const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${tabla}`);
      counts[tabla] = { label, n: r.rows[0].n };
    }
    res.json({ success: true, counts });
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

    // 1) Recoger rutas físicas de láminas ANTES de borrar (para limpiar disco)
    const sheetsR = await pool.query(`SELECT imagen_path, miniatura_path FROM sheets`);
    const rutasFisicas: string[] = [];
    for (const s of sheetsR.rows) {
      for (const p of [s.imagen_path, s.miniatura_path]) {
        if (!p) continue;
        let rel = String(p);
        if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
        else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
        rutasFisicas.push(path.join(UPLOADS_DIR, rel));
      }
    }

    // 2) Borrar en orden seguro (hijos antes que padres).
    //    Muchas tienen ON DELETE CASCADE, pero lo hacemos explícito para contar bien.
    const ordenBorrado = [
      'visit_emails',
      'annotations',
      'visits',
      'express_sheets',
      'catalog_versions',
      'catalog_changes',
      'catalog_assignments',
      'sheets',
      'catalogs'
    ];
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

    // 4) Borrar carpeta de versiones (PDFs/ZIPs generados) si existe
    try {
      const versionsDir = path.join(UPLOADS_DIR, 'versions');
      if (fsMod.existsSync(versionsDir)) {
        for (const f of fsMod.readdirSync(versionsDir)) {
          try { fsMod.unlinkSync(path.join(versionsDir, f)); archivosFisicosBorrados++; } catch {}
        }
      }
    } catch (e) { /* ignorar */ }

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
    const r = await pool.query(
      `INSERT INTO annotations (visit_id, sheet_id, orden_en_visita, texto_libre, tipo, pos_x, pos_y, product_id, cantidad, zone_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [visitId, sheet_id ? Number(sheet_id) : null, orden, String(texto_libre).trim(), tipoFinal, posX, posY, productId, cantidad, zoneId]
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
    const r = await pool.query(
      `UPDATE annotations SET texto_libre = $1, tipo = $2, cantidad = $3 WHERE id = $4 RETURNING *`,
      [String(texto_libre).trim(), tipoFinal, cantidad, id]
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
    const maxR = await pool.query(`SELECT COALESCE(MAX(orden),0) AS m FROM annotation_templates`);
    const orden = Number(maxR.rows[0].m) + 1;
    const r = await pool.query(
      `INSERT INTO annotation_templates (texto, tipo, orden) VALUES ($1, $2, $3) RETURNING *`,
      [String(texto).trim().substring(0, 150), tipoFinal, orden]
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
    const r = await pool.query(
      `UPDATE annotation_templates SET texto=$1, tipo=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [String(texto).trim().substring(0, 150), tipoFinal, id]
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
    const pattern = '%' + qLower + '%';

    // ORDER BY relevancia (coincidencias exactas primero, luego "empieza por", luego "contiene")
    // Esto hace que si el comercial escribe "BETER" salgan primero los productos
    // cuyo nombre/código empieza por "BETER" antes que los que solo lo contienen.
    const sql = `
      SELECT id, codigo, nombre, ean, precio_pvp, precio_pvf, categoria, familia, marca, tipo
      FROM products
      WHERE activo = TRUE
        AND (
          LOWER(nombre) LIKE $1
          OR LOWER(codigo) LIKE $1
          OR LOWER(COALESCE(ean,'')) LIKE $1
        )
      ORDER BY
        CASE
          WHEN LOWER(codigo) = $2 THEN 0                  -- código exacto = máxima prioridad
          WHEN LOWER(ean) = $2 THEN 1                     -- EAN exacto
          WHEN LOWER(nombre) LIKE $3 THEN 2               -- nombre empieza por…
          WHEN LOWER(codigo) LIKE $3 THEN 3               -- código empieza por…
          ELSE 4
        END,
        LENGTH(nombre),
        nombre
      LIMIT 20
    `;
    const startsWith = qLower + '%';
    const r = await pool.query(sql, [pattern, qLower, startsWith]);
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
      params.push('%' + q + '%');
      const pPattern = params.length;
      where.push(`(LOWER(nombre) LIKE $${pPattern} OR LOWER(codigo) LIKE $${pPattern} OR LOWER(COALESCE(ean,'')) LIKE $${pPattern} OR LOWER(COALESCE(marca,'')) LIKE $${pPattern})`);
    }

    const whereSQL = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const countR = await pool.query(`SELECT COUNT(*)::int AS n FROM products ${whereSQL}`, params);
    const total = countR.rows[0].n;

    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM products ${whereSQL} ORDER BY nombre LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, products: r.rows, total });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// GET un producto por id
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
             p.activo AS producto_activo
      FROM sheet_zones z
      LEFT JOIN products p ON p.id = z.product_id
      WHERE z.sheet_id = $1
      ORDER BY z.orden, z.id
    `, [sheetId]);
    res.json({ success: true, zones: r.rows });
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
    res.json({ success: true, zone: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// PUT actualizar zona (mover, redimensionar, asignar producto, etiqueta) — solo admin real
app.put('/api/zones/:zoneId', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = Number(req.params.zoneId);
    const { x, y, ancho, alto, product_id, etiqueta } = req.body;
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
    res.json({ success: true, zone: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// DELETE borrar zona — solo admin real
app.delete('/api/zones/:zoneId', verifyToken, requireRealAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = Number(req.params.zoneId);
    const r = await pool.query(`DELETE FROM sheet_zones WHERE id = $1`, [zoneId]);
    res.json({ success: true, borrada: (r.rowCount || 0) > 0 });
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
    res.json({ success: true, formacion: r.rows[0] });
  } catch (e) {
    // Si falló a mitad, limpiar archivo subido
    if (req.file) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(400).json({ success: false, error: (e as Error).message });
  }
});

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
// FRONTEND FALLBACK (DEBE ser el último GET, después de todos los /api/*)
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
