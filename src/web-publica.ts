/**
 * WEB PÚBLICA (lomhifar.es) · panel de control y salida pública.
 *
 * Módulo APARTE del resto de CatalogPRO: solo crea sus propias tablas (web_*) y sus propias rutas
 * (/api/web-publica y /api/web-admin/*). No toca ninguna tabla ni ruta de los comerciales; de
 * `products` solo LEE nombre, proveedor, EAN y estado (nunca precios ni costes).
 *
 * - GET /api/web-publica → lo que la web necesita, sin login. Lista blanca de campos: jamás precio.
 * - /api/web-admin/* → solo el dueño (usuarios de WEB_ADMIN_IDS, por defecto 1 = Fernando y
 *   10 = la cuenta técnica de pruebas). Se comprueba en el servidor, no escondiendo un botón.
 *
 * Bajas automáticas: una marca solo sale si tiene artículos activos en Sage (activo, sin baja,
 * sin descatalogar, proveedor no «BAJA -» ni «PRODUCTOS ELIMINADOS»). Si se deja de trabajar con
 * un proveedor y Sage lo da de baja, la marca y sus novedades desaparecen solas de la web.
 */
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import type { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';

type Deps = {
  pool: Pool;
  verifyToken: RequestHandler;
  upload: { single: (campo: string) => RequestHandler };
  uploadsDir: string;
};

/** Artículo vivo en Sage. Mismo criterio que el recuento de la web (18-nov-2026). */
const VIVO = `p.activo IS TRUE AND COALESCE(p.es_baja,false)=false AND COALESCE(p.obsoleto_lc,false)=false
  AND p.descatalogado_at IS NULL AND COALESCE(p.proveedor,'') NOT ILIKE 'BAJA%'
  AND COALESCE(p.proveedor,'') NOT ILIKE 'PRODUCTOS ELIMINADOS%'`;

/** Proveedores que NO son mercancía para la farmacia (o no se publican): no cuentan en las cifras de la web. */
const NO_MERCANCIA = 'BETER|VARIOS|MEDIA MARKT|CORTE INGLES|ALIEXPRESS|BIGBUY|ELECTROPRECIO|TODO-RELOJES|GRAFICAS|SISTEMAS INFORMATICOS|TECHOS|TELERECARGA|TRADING MEDIA|MERCHANDISING|ENVASES|MARKETING|PROMOCIONES|MESPUBLICITAT|INVERSIONES|PACKAGING|TERMOFORMADOS|DISPLAYS|PROJECT BOX|AYUDAS TECNO|ALLOGA';

/** Campos que se pueden publicar de un artículo. Cualquier otro (precio_*, coste, notas) NUNCA sale. */
const CAMPOS_ARTICULO = 'p.id, p.nombre, p.proveedor, p.ean';

export const AJUSTES_POR_DEFECTO: Record<string, string> = {
  telefono: '943 371 549',
  whatsapp: '34649848900',
  correo: 'lomhifar@lomhifar.com',
  horario_dias: 'de lunes a viernes',
  horario_abre: '09:00',
  horario_cierra: '20:00',
  novedades_titulo: 'noviembre de 2026',
};

function ids(): number[] {
  return (process.env.WEB_ADMIN_IDS || '1,10').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
}

async function migrar(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_marcas (
      slug VARCHAR(80) PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      descripcion TEXT NOT NULL DEFAULT '',
      familias JSONB NOT NULL DEFAULT '[]',
      patrones JSONB NOT NULL DEFAULT '[]',
      visible BOOLEAN NOT NULL DEFAULT TRUE,
      destacada BOOLEAN NOT NULL DEFAULT FALSE,
      orden INTEGER NOT NULL DEFAULT 0,
      logo_url TEXT,
      foto_url TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_novedades (
      id SERIAL PRIMARY KEY,
      product_id INTEGER,
      titulo VARCHAR(160) NOT NULL,
      marca VARCHAR(120) NOT NULL DEFAULT '',
      imagen_url TEXT,
      texto_alt VARCHAR(240) NOT NULL DEFAULT '',
      orden INTEGER NOT NULL DEFAULT 0,
      visible BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_ocultos (
      product_id INTEGER PRIMARY KEY,
      motivo VARCHAR(200) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_ajustes (
      clave VARCHAR(60) PRIMARY KEY,
      valor TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
}

type Patron = { campo: 'proveedor' | 'nombre'; texto: string };

/** WHERE para los artículos de una marca, con parámetros a partir de $inicio. */
function condicionMarca(patrones: Patron[], inicio: number): { sql: string; vals: string[] } {
  const partes: string[] = [];
  const vals: string[] = [];
  for (const p of patrones) {
    if (!p || !p.texto) continue;
    vals.push('%' + p.texto + '%');
    const col = p.campo === 'nombre' ? 'p.nombre' : `COALESCE(p.proveedor,'')`;
    partes.push(`${col} ILIKE $${inicio + vals.length - 1}`);
  }
  return { sql: partes.length ? '(' + partes.join(' OR ') + ')' : 'FALSE', vals };
}

async function contarRefs(pool: Pool, patrones: Patron[]): Promise<number> {
  const c = condicionMarca(patrones, 1);
  const r = await pool.query(
    `SELECT COUNT(*)::int n FROM products p WHERE ${VIVO} AND ${c.sql}
       AND NOT EXISTS (SELECT 1 FROM web_ocultos o WHERE o.product_id = p.id)`, c.vals);
  return r.rows[0].n;
}

async function leerAjustes(pool: Pool) {
  const r = await pool.query('SELECT clave, valor FROM web_ajustes');
  const a: Record<string, string> = { ...AJUSTES_POR_DEFECTO };
  for (const f of r.rows) a[f.clave] = f.valor;
  return a;
}

/** Lo que se publica. Construido campo a campo (lista blanca): nunca un SELECT * hacia fuera. */
async function construirSalida(pool: Pool, base: string) {
  const abs = (u: string | null) => (u ? (u.startsWith('/') ? base + u : u) : null);
  const ajustes = await leerAjustes(pool);
  const filas = (await pool.query('SELECT * FROM web_marcas WHERE visible ORDER BY destacada DESC, orden, nombre')).rows;
  const marcas = [];
  for (const m of filas) {
    const refs = await contarRefs(pool, m.patrones || []);
    if (refs === 0) continue; // proveedor de baja o sin artículos vivos → fuera de la web, solo
    marcas.push({
      slug: String(m.slug), nombre: String(m.nombre), desc: String(m.descripcion || ''),
      familias: Array.isArray(m.familias) ? m.familias.map(String) : [],
      refs, destacada: !!m.destacada,
      logo: abs(m.logo_url ? String(m.logo_url) : null), foto: abs(m.foto_url ? String(m.foto_url) : null),
    });
  }
  const nov = (await pool.query(`
    SELECT n.id, n.titulo, n.marca, n.imagen_url, n.texto_alt, n.product_id
    FROM web_novedades n
    LEFT JOIN products p ON p.id = n.product_id
    WHERE n.visible AND n.imagen_url IS NOT NULL
      AND (n.product_id IS NULL OR (${VIVO} AND NOT EXISTS (SELECT 1 FROM web_ocultos o WHERE o.product_id = n.product_id)))
    ORDER BY n.orden, n.id`)).rows.map((n) => ({
      titulo: String(n.titulo), marca: String(n.marca), imagen: abs(String(n.imagen_url)), alt: String(n.texto_alt || n.titulo),
    }));
  // Cifras públicas: solo mercancía real. Fuera los artículos sin proveedor, Beter, «PROVEEDORES VARIOS»
  // y las compras internas (imprenta, marketing, informática, tiendas…). Revisado con Fernando el 18-nov-2026.
  const tot = (await pool.query(`SELECT COUNT(*)::int refs, COUNT(DISTINCT p.proveedor)::int proveedores,
      COUNT(*) FILTER (WHERE p.fecha_alta_sage > NOW() - INTERVAL '12 months')::int altas
    FROM products p WHERE ${VIVO} AND p.proveedor IS NOT NULL AND p.proveedor !~* $1`, [NO_MERCANCIA])).rows[0];
  return {
    generado: new Date().toISOString(),
    contacto: {
      telefono: ajustes.telefono, whatsapp: ajustes.whatsapp, correo: ajustes.correo,
      horario: { dias: ajustes.horario_dias, abre: ajustes.horario_abre, cierra: ajustes.horario_cierra },
    },
    novedadesTitulo: ajustes.novedades_titulo,
    cifras: { referencias: tot.refs, proveedores: tot.proveedores, altas12m: tot.altas },
    marcas,
    novedades: nov,
  };
}

/** Comprobación de que la salida no lleva nada parecido a un precio. Se ejecuta en cada respuesta. */
export function sinPrecios(o: unknown): boolean {
  const s = JSON.stringify(o).toLowerCase();
  return !/"(precio|pvp|pvf|coste|precio_[a-z0-9_]*|cost|price)"\s*:/.test(s);
}

export function registrarWebPublica(app: Express, d: Deps) {
  const { pool } = d;
  migrar(pool).catch((e) => console.error('[web] migración', e.message));

  let cache: { t: number; datos: unknown } | null = null;
  const invalidar = () => { cache = null; };

  app.get('/api/web-publica', async (req: Request, res: Response) => {
    try {
      const base = process.env.WEB_PUBLICA_BASE || `https://${req.get('host')}`;
      if (!cache || Date.now() - cache.t > 60_000) cache = { t: Date.now(), datos: await construirSalida(pool, base) };
      if (!sinPrecios(cache.datos)) { res.status(500).json({ error: 'salida bloqueada' }); return; }
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(cache.datos);
    } catch (e: any) {
      console.error('[web] salida', e.message);
      res.status(503).json({ error: 'no disponible' });
    }
  });

  const soloDueno = (req: Request, res: Response, next: NextFunction) => {
    const u = (req as any).user;
    if (!u || u._realAdminId || u.role !== 'admin' || !ids().includes(Number(u.id))) {
      res.status(403).json({ error: 'Este apartado es solo para el administrador de la web.' });
      return;
    }
    next();
  };
  const P = [d.verifyToken, soloDueno];
  const ok = (res: Response, datos: unknown = {}) => { invalidar(); res.json({ ok: true, ...((datos as object) || {}) }); };
  const fallo = (res: Response, e: any) => { console.error('[web-admin]', e?.message); res.status(400).json({ error: e?.message || 'Error' }); };

  app.get('/api/web-admin/yo', ...P, (req: Request, res: Response) => { res.json({ ok: true, nombre: (req as any).user?.name || '' }); });

  // ---------- Marcas ----------
  app.get('/api/web-admin/marcas', ...P, async (_req, res) => {
    try {
      const filas = (await pool.query('SELECT * FROM web_marcas ORDER BY nombre')).rows;
      for (const m of filas) m.refs = await contarRefs(pool, m.patrones || []);
      res.json({ marcas: filas });
    } catch (e) { fallo(res, e); }
  });
  app.put('/api/web-admin/marcas/:slug', ...P, async (req, res) => {
    try {
      const b = req.body || {};
      const campos: string[] = []; const vals: unknown[] = [];
      const pon = (c: string, v: unknown) => { vals.push(v); campos.push(`${c} = $${vals.length}`); };
      if (typeof b.visible === 'boolean') pon('visible', b.visible);
      if (typeof b.destacada === 'boolean') pon('destacada', b.destacada);
      if (typeof b.nombre === 'string' && b.nombre.trim()) pon('nombre', b.nombre.trim().slice(0, 120));
      if (typeof b.descripcion === 'string') pon('descripcion', b.descripcion.trim().slice(0, 400));
      if (Array.isArray(b.familias)) pon('familias', JSON.stringify(b.familias.map(String).slice(0, 6)));
      if (Array.isArray(b.patrones)) pon('patrones', JSON.stringify(b.patrones.filter((p: any) => p && p.texto).map((p: any) => ({ campo: p.campo === 'nombre' ? 'nombre' : 'proveedor', texto: String(p.texto).slice(0, 80) }))));
      if (b.logo_url === null || typeof b.logo_url === 'string') pon('logo_url', b.logo_url || null);
      if (b.foto_url === null || typeof b.foto_url === 'string') pon('foto_url', b.foto_url || null);
      if (!campos.length) throw new Error('Nada que cambiar');
      vals.push(req.params.slug);
      const r = await pool.query(`UPDATE web_marcas SET ${campos.join(', ')}, updated_at = NOW() WHERE slug = $${vals.length}`, vals);
      if (!r.rowCount) throw new Error('Esa marca no existe');
      ok(res);
    } catch (e) { fallo(res, e); }
  });
  app.post('/api/web-admin/marcas', ...P, async (req, res) => {
    try {
      const b = req.body || {};
      const nombre = String(b.nombre || '').trim();
      const proveedor = String(b.proveedor || '').trim();
      if (!nombre || !proveedor) throw new Error('Pon el nombre de la marca y elige su proveedor');
      const slug = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'y').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
      await pool.query(`INSERT INTO web_marcas (slug, nombre, descripcion, familias, patrones, visible)
        VALUES ($1,$2,$3,$4,$5,TRUE)`, [slug, nombre, String(b.descripcion || '').slice(0, 400), JSON.stringify(Array.isArray(b.familias) ? b.familias : []), JSON.stringify([{ campo: 'proveedor', texto: proveedor }])]);
      ok(res, { slug });
    } catch (e: any) { fallo(res, e.code === '23505' ? new Error('Ya hay una marca con ese nombre') : e); }
  });
  app.delete('/api/web-admin/marcas/:slug', ...P, async (req, res) => {
    try { await pool.query('DELETE FROM web_marcas WHERE slug = $1', [req.params.slug]); ok(res); } catch (e) { fallo(res, e); }
  });
  /** Proveedores vivos de Sage, para el desplegable «Añadir marca». */
  app.get('/api/web-admin/proveedores', ...P, async (_req, res) => {
    try {
      const r = await pool.query(`SELECT p.proveedor, COUNT(*)::int n FROM products p WHERE ${VIVO} AND p.proveedor IS NOT NULL
        AND p.proveedor NOT ILIKE '%BETER%' GROUP BY 1 ORDER BY 2 DESC`);
      res.json({ proveedores: r.rows });
    } catch (e) { fallo(res, e); }
  });

  // ---------- Artículos (buscar, ocultar) ----------
  app.get('/api/web-admin/articulos', ...P, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) { res.json({ articulos: [] }); return; }
      const r = await pool.query(`SELECT ${CAMPOS_ARTICULO}, (o.product_id IS NOT NULL) AS oculto
        FROM products p LEFT JOIN web_ocultos o ON o.product_id = p.id
        WHERE ${VIVO} AND (p.nombre ILIKE $1 OR p.ean = $2 OR p.codigo = $2 OR COALESCE(p.proveedor,'') ILIKE $1)
        ORDER BY p.nombre LIMIT 40`, ['%' + q + '%', q]);
      res.json({ articulos: r.rows });
    } catch (e) { fallo(res, e); }
  });
  app.get('/api/web-admin/ocultos', ...P, async (_req, res) => {
    try {
      const r = await pool.query(`SELECT o.product_id AS id, o.motivo, o.created_at, p.nombre, p.proveedor
        FROM web_ocultos o LEFT JOIN products p ON p.id = o.product_id ORDER BY o.created_at DESC`);
      res.json({ ocultos: r.rows });
    } catch (e) { fallo(res, e); }
  });
  app.post('/api/web-admin/ocultos/:id', ...P, async (req, res) => {
    try {
      await pool.query(`INSERT INTO web_ocultos (product_id, motivo) VALUES ($1,$2) ON CONFLICT (product_id) DO NOTHING`,
        [Number(req.params.id), String(req.body?.motivo || '').slice(0, 200)]);
      ok(res);
    } catch (e) { fallo(res, e); }
  });
  app.delete('/api/web-admin/ocultos/:id', ...P, async (req, res) => {
    try { await pool.query('DELETE FROM web_ocultos WHERE product_id = $1', [Number(req.params.id)]); ok(res); } catch (e) { fallo(res, e); }
  });

  // ---------- Novedades ----------
  app.get('/api/web-admin/novedades', ...P, async (_req, res) => {
    try {
      const r = await pool.query(`SELECT n.*, (p.id IS NOT NULL AND ${VIVO}) AS vivo
        FROM web_novedades n LEFT JOIN products p ON p.id = n.product_id ORDER BY n.orden, n.id`);
      res.json({ novedades: r.rows });
    } catch (e) { fallo(res, e); }
  });
  app.post('/api/web-admin/novedades', ...P, async (req, res) => {
    try {
      const b = req.body || {};
      const titulo = String(b.titulo || '').trim();
      if (!titulo) throw new Error('Falta el nombre del producto');
      const max = (await pool.query('SELECT COALESCE(MAX(orden),0)+1 AS o FROM web_novedades')).rows[0].o;
      const r = await pool.query(`INSERT INTO web_novedades (product_id, titulo, marca, imagen_url, texto_alt, orden)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.product_id ? Number(b.product_id) : null, titulo.slice(0, 160), String(b.marca || '').slice(0, 120), b.imagen_url || null, String(b.texto_alt || titulo).slice(0, 240), max]);
      ok(res, { id: r.rows[0].id });
    } catch (e) { fallo(res, e); }
  });
  app.put('/api/web-admin/novedades/:id', ...P, async (req, res) => {
    try {
      const b = req.body || {};
      const campos: string[] = []; const vals: unknown[] = [];
      const pon = (c: string, v: unknown) => { vals.push(v); campos.push(`${c} = $${vals.length}`); };
      if (typeof b.titulo === 'string' && b.titulo.trim()) pon('titulo', b.titulo.trim().slice(0, 160));
      if (typeof b.marca === 'string') pon('marca', b.marca.trim().slice(0, 120));
      if (typeof b.texto_alt === 'string') pon('texto_alt', b.texto_alt.trim().slice(0, 240));
      if (b.imagen_url === null || typeof b.imagen_url === 'string') pon('imagen_url', b.imagen_url || null);
      if (typeof b.visible === 'boolean') pon('visible', b.visible);
      if (Number.isInteger(b.orden)) pon('orden', b.orden);
      if (!campos.length) throw new Error('Nada que cambiar');
      vals.push(Number(req.params.id));
      await pool.query(`UPDATE web_novedades SET ${campos.join(', ')} WHERE id = $${vals.length}`, vals);
      ok(res);
    } catch (e) { fallo(res, e); }
  });
  app.delete('/api/web-admin/novedades/:id', ...P, async (req, res) => {
    try { await pool.query('DELETE FROM web_novedades WHERE id = $1', [Number(req.params.id)]); ok(res); } catch (e) { fallo(res, e); }
  });

  // ---------- Ajustes (contacto, título de novedades) ----------
  app.get('/api/web-admin/ajustes', ...P, async (_req, res) => {
    try { res.json({ ajustes: await leerAjustes(pool) }); } catch (e) { fallo(res, e); }
  });
  app.put('/api/web-admin/ajustes', ...P, async (req, res) => {
    try {
      const b = req.body || {};
      for (const clave of Object.keys(AJUSTES_POR_DEFECTO)) {
        if (typeof b[clave] !== 'string') continue;
        const v = b[clave].trim().slice(0, 200);
        if (clave === 'whatsapp' && !/^\d{9,15}$/.test(v.replace(/\D/g, ''))) throw new Error('El WhatsApp tiene que ser un número de teléfono');
        await pool.query(`INSERT INTO web_ajustes (clave, valor) VALUES ($1,$2)
          ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [clave, clave === 'whatsapp' ? v.replace(/\D/g, '') : v]);
      }
      ok(res);
    } catch (e) { fallo(res, e); }
  });

  // ---------- Fotos (subida → WebP de calidad) ----------
  const dirWeb = path.join(d.uploadsDir, 'web');
  try { fs.mkdirSync(dirWeb, { recursive: true }); } catch { /* el volumen aún no está */ }
  app.post('/api/web-admin/foto', ...P, d.upload.single('foto'), async (req: Request, res: Response) => {
    const f = (req as any).file;
    try {
      if (!f) throw new Error('No ha llegado ninguna foto');
      fs.mkdirSync(dirWeb, { recursive: true });
      const nombre = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webp`;
      await sharp(f.path).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toFile(path.join(dirWeb, nombre));
      res.json({ ok: true, url: `/uploads/web/${nombre}` });
    } catch (e) { fallo(res, e); }
    finally { if (f?.path) fs.promises.unlink(f.path).catch(() => {}); }
  });
}
