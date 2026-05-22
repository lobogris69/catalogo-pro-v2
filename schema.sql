-- ============================================================================
-- CatalogPRO v2 - Schema PostgreSQL
-- LOMHIFAR S.L. - Mayo 2026
-- ============================================================================
-- Filosofia: la LAMINA es la unidad atomica. No hay tabla "articles".
-- Cada lamina es una imagen + metadatos. Los catalogos son colecciones de laminas.

-- ============================================================================
-- USUARIOS
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(150) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  name            VARCHAR(150) NOT NULL,
  role            VARCHAR(20)  NOT NULL CHECK (role IN ('admin','sales')),
  sage_commercial_code VARCHAR(20),
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================================
-- CLIENTES (igual que v1, con extras de visita)
-- ============================================================================
CREATE TABLE IF NOT EXISTS clients (
  id                       SERIAL PRIMARY KEY,
  razon_social             VARCHAR(255) NOT NULL,
  cif                      VARCHAR(20),
  cp                       VARCHAR(10),
  direccion                VARCHAR(255),
  municipio                VARCHAR(100),
  provincia                VARCHAR(100),
  telefono                 VARCHAR(50),
  whatsapp                 VARCHAR(50),
  email                    VARCHAR(150),
  email_alternativo        VARCHAR(150),
  numero_cuenta            VARCHAR(50),
  sage_code                VARCHAR(20) UNIQUE,
  commercial_code          VARCHAR(20),
  categoria                VARCHAR(10),
  ciclo_visita_dias        INTEGER DEFAULT 90,
  ciclo_modificado_por_id  INTEGER REFERENCES users(id),
  ciclo_modificado_at      TIMESTAMP,
  notas_internas           TEXT,
  is_new_from_visit        BOOLEAN DEFAULT FALSE,
  is_active                BOOLEAN DEFAULT TRUE,
  ultima_visita_at         TIMESTAMP,
  created_at               TIMESTAMP DEFAULT NOW(),
  updated_at               TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_sage_code ON clients(sage_code);
CREATE INDEX IF NOT EXISTS idx_clients_commercial ON clients(commercial_code);
CREATE INDEX IF NOT EXISTS idx_clients_razon ON clients(razon_social);

-- ============================================================================
-- CATALOGOS (maestros, clones, express)
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalogs (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(150) NOT NULL,
  description     TEXT,
  tipo            VARCHAR(20) NOT NULL CHECK (tipo IN ('maestro','clon','express')),
  parent_id       INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
  version         INTEGER DEFAULT 1,
  estado          VARCHAR(20) DEFAULT 'borrador' CHECK (estado IN ('borrador','publicado','archivado')),
  fecha_caducidad DATE,
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMP DEFAULT NOW(),
  published_at    TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catalogs_tipo ON catalogs(tipo);
CREATE INDEX IF NOT EXISTS idx_catalogs_parent ON catalogs(parent_id);

-- ============================================================================
-- LAMINAS (la unidad atomica del sistema)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sheets (
  id              SERIAL PRIMARY KEY,
  catalog_id      INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
  orden           INTEGER NOT NULL DEFAULT 0,
  titulo          VARCHAR(255),
  notas           TEXT,
  imagen_path     VARCHAR(500) NOT NULL,
  miniatura_path  VARCHAR(500),
  tags            TEXT,
  enlace_externo_url    VARCHAR(500),
  enlace_externo_titulo VARCHAR(150),
  oculta          BOOLEAN DEFAULT FALSE,
  origen_sheet_id INTEGER REFERENCES sheets(id),
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sheets_catalog ON sheets(catalog_id);
CREATE INDEX IF NOT EXISTS idx_sheets_orden ON sheets(catalog_id, orden);
CREATE INDEX IF NOT EXISTS idx_sheets_origen ON sheets(origen_sheet_id);

-- ============================================================================
-- VERSIONES DEL CATALOGO (historico)
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalog_versions (
  id              SERIAL PRIMARY KEY,
  catalog_id      INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  snapshot_json   JSONB NOT NULL,
  notas_version   TEXT,
  published_by    INTEGER REFERENCES users(id),
  published_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_versions_catalog ON catalog_versions(catalog_id, version_number);

-- ============================================================================
-- CAMBIOS (registro automatico para informe a comercial + oficina)
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalog_changes (
  id              SERIAL PRIMARY KEY,
  catalog_id      INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
  version_anterior INTEGER,
  version_nueva    INTEGER,
  tipo_cambio     VARCHAR(30) NOT NULL,
  sheet_id        INTEGER,
  detalles_json   JSONB,
  created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_changes_catalog ON catalog_changes(catalog_id);

-- ============================================================================
-- ASIGNACIONES (que comercial ve que catalogo)
-- ============================================================================
CREATE TABLE IF NOT EXISTS catalog_assignments (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  catalog_id      INTEGER REFERENCES catalogs(id) ON DELETE CASCADE,
  assigned_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, catalog_id)
);

-- ============================================================================
-- VISITAS (= pedidos en v1, pero conceptualmente son visitas)
-- ============================================================================
CREATE TABLE IF NOT EXISTS visits (
  id              SERIAL PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  user_id         INTEGER REFERENCES users(id),
  catalog_id      INTEGER REFERENCES catalogs(id),
  version_catalog INTEGER,
  status          VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','confirmed','sent')),
  notas_generales TEXT,
  duracion_minutos INTEGER,
  lat             NUMERIC(10,7),
  lng             NUMERIC(10,7),
  hubo_pedido     BOOLEAN DEFAULT FALSE,
  email_enviado_oficina  BOOLEAN DEFAULT FALSE,
  email_enviado_cliente  VARCHAR(150),
  email_enviado_comercial BOOLEAN DEFAULT FALSE,
  pdf_path        VARCHAR(500),
  created_at      TIMESTAMP DEFAULT NOW(),
  confirmed_at    TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id);
CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);

-- ============================================================================
-- ANOTACIONES (= order_items en v1, lo que escribe el comercial en cada lamina)
-- ============================================================================
CREATE TABLE IF NOT EXISTS annotations (
  id              SERIAL PRIMARY KEY,
  visit_id        INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  sheet_id        INTEGER REFERENCES sheets(id),
  orden_en_visita INTEGER NOT NULL DEFAULT 0,
  texto_libre     TEXT NOT NULL,
  tipo            VARCHAR(20) DEFAULT 'pedido' CHECK (tipo IN ('pedido','devolucion','nota')),
  created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_annot_visit ON annotations(visit_id);

-- ============================================================================
-- USUARIO ADMIN POR DEFECTO
-- ============================================================================
-- Se crea en codigo TS si la tabla esta vacia (con bcrypt)
