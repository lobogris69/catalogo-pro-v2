/**
 * Zona de clientes de lomhifar.es: CATÁLOGO y PEDIDO (24-nov-2026).
 *
 * Fernando: la farmacia ve los catálogos LOMHIFAR, VCS, Essity y Navidad, con el PVF y el PVP recomendado pintados en
 * las láminas (lo mismo que le enseña el comercial; NUNCA costes). Hace su pedido y este llega, mientras se prueba,
 * a la oficina y a Fernando; la lista de destinatarios se cambia en el panel (pestaña «Pedidos web») para poder añadir
 * más adelante al comercial u otras personas.
 *
 * Todo pasa por la sesión de la web (cookie de la farmacia → CatalogPRO), que vuelve a comprobar en cada llamada que
 * es una farmacia cliente y no un proveedor (clienteDeSesion). Nada de esto es público.
 */
import type { Express, Request, Response, RequestHandler, NextFunction } from 'express';
import type { Pool } from 'pg';
import sharp from 'sharp';
import crypto from 'crypto';
import { clienteDeSesion, type EnviarCorreo } from './area-clientes';

type Deps = {
  pool: Pool; verifyToken: RequestHandler; enviarCorreo: EnviarCorreo; adminIds: () => number[];
  recomponer: (sheetId: number, tarifa: number) => Promise<Buffer | null>;
};

/** Artículo vivo en Sage y que es mercancía para la farmacia (mismo criterio que la web pública). */
const VIVO = `p.activo IS TRUE AND COALESCE(p.es_baja,false)=false AND COALESCE(p.obsoleto_lc,false)=false
  AND p.descatalogado_at IS NULL AND COALESCE(p.proveedor,'') NOT ILIKE 'BAJA%'
  AND COALESCE(p.proveedor,'') NOT ILIKE 'PRODUCTOS ELIMINADOS%'
  AND COALESCE(p.proveedor,'') !~* 'BETER|GALIFARMA|JAHISIL' AND p.nombre !~* 'BETER'`;

/** Catálogos que ve la farmacia, en este orden, con el nombre que se le enseña. */
const CATALOGOS_DEFECTO = [
  { id: 4, nombre: 'Catálogo general' },
  { id: 27, nombre: 'VCS' },
  { id: 5, nombre: 'Essity' },
  { id: 24, nombre: 'Regalos de Navidad' },
];
const DESTINATARIOS_DEFECTO = ['lomhifar@lomhifar.com', 'f.ayllon66@gmail.com'];
const MAX_LINEAS = 300, MAX_CANT = 9999;
const TARIFA = 1; // CatalogPRO trabaja con una sola tarifa (app_config.num_tarifas = 1)

type Linea = { k: string; product_id?: number; codigo?: string; nombre: string; cantidad: number; quien?: string; lamina_id?: number; at?: string };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const correoValido = (e: string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i.test(e);
/** «2 LABEL ROBOT FARMACIA 17 NOVIEMBRE 2025» → «Label robot farmacia»: fuera números de orden, fechas y notas internas. */
export function tituloLimpio(t: unknown) {
  let s = String(t || '').replace(/\.(png|jpe?g|webp)$/i, '').replace(/_/g, ' ');
  s = s.replace(/^\s*\d+\s+/, '')
    .replace(/\b\d{1,2}\s+(DE\s+)?(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)(\s+(DE\s+)?\d{4})?\b/gi, '')
    .replace(/\b(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+\d{4}\b/gi, '')
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, '')
    .replace(/\b(CON TARIFAS?|SIN TARIFAS?|HD|NUEVA?|V\d+)\b/gi, '')
    .replace(/\s+\d+\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Lámina';
  // Si viene todo en mayúsculas, se pasa a frase normal.
  if (s === s.toUpperCase()) s = s.charAt(0) + s.slice(1).toLowerCase();
  return s;
}

export function registrarPedidoClientes(app: Express, d: Deps) {
  const { pool } = d;
  pool.query(`CREATE TABLE IF NOT EXISTS web_pedidos (
      id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL, estado VARCHAR(12) NOT NULL DEFAULT 'abierto',
      lineas JSONB NOT NULL DEFAULT '[]'::jsonb, nota TEXT,
      creado_at TIMESTAMP DEFAULT NOW(), actualizado_at TIMESTAMP DEFAULT NOW(),
      enviado_at TIMESTAMP, enviado_por VARCHAR(80), destinatarios TEXT, envio_ok BOOLEAN)`)
    .then(() => pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS web_pedidos_abierto ON web_pedidos (client_id) WHERE estado = 'abierto'`))
    .catch((e) => console.error('[pedido] migración', e.message));

  const ajuste = async (k: string) => (await pool.query('SELECT valor FROM web_ajustes WHERE clave = $1', [k]).catch(() => ({ rows: [] as any[] }))).rows[0]?.valor || '';
  const ponAjuste = (k: string, v: string) => pool.query(`INSERT INTO web_ajustes (clave, valor) VALUES ($1,$2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [k, v]);
  const catalogos = async (): Promise<{ id: number; nombre: string }[]> => {
    try { const v = JSON.parse(await ajuste('clientes_catalogos')); if (Array.isArray(v) && v.length) return v; } catch { /* por defecto */ }
    return CATALOGOS_DEFECTO;
  };
  const destinatarios = async (): Promise<string[]> => {
    try { const v = JSON.parse(await ajuste('pedido_destinatarios')); if (Array.isArray(v)) return v.filter((e) => correoValido(String(e))); } catch { /* por defecto */ }
    return DESTINATARIOS_DEFECTO;
  };

  /** Precio de HOY (tarifa única) de varios productos: cambio programado ya vigente o, si no, el de Sage. Solo PVF y PVP. */
  async function precios(ids: number[]) {
    const out: Record<number, { pvf: number | null; pvpr: number | null }> = {};
    const u = Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n > 0)));
    if (!u.length) return out;
    const prog = await pool.query(`SELECT DISTINCT ON (product_id) product_id, pvf, pvpr FROM precio_programado
      WHERE product_id = ANY($1::int[]) AND tarifa = $2 AND fecha_vigencia <= CURRENT_DATE ORDER BY product_id, fecha_vigencia DESC, id DESC`, [u, TARIFA]);
    const pm = new Map(prog.rows.map((r: any) => [r.product_id, r]));
    const base = await pool.query(`SELECT id, precio_pvf_${TARIFA} pvf, precio_pvpr_${TARIFA} pvpr, precio_pvf pvf_l, precio_pvp pvpr_l FROM products WHERE id = ANY($1::int[])`, [u]);
    for (const b of base.rows) {
      const p: any = pm.get(b.id);
      const pvf = p ? p.pvf : (b.pvf ?? b.pvf_l), pvpr = p ? p.pvpr : (b.pvpr ?? b.pvpr_l);
      out[b.id] = { pvf: pvf == null ? null : Number(pvf), pvpr: pvpr == null ? null : Number(pvpr) };
    }
    return out;
  }
  async function articulos(ids: number[]) {
    if (!ids.length) return new Map<number, any>();
    const r = await pool.query(`SELECT p.id, p.codigo, p.nombre FROM products p WHERE p.id = ANY($1::int[]) AND ${VIVO}`, [ids]);
    const pr = await precios(r.rows.map((x: any) => x.id));
    return new Map(r.rows.map((x: any) => [x.id, { id: x.id, codigo: x.codigo, nombre: x.nombre, ...(pr[x.id] || { pvf: null, pvpr: null }) }]));
  }

  /** ¿Pertenece la lámina a uno de los catálogos de la farmacia y está visible? */
  async function laminaPermitida(id: number) {
    const cats = (await catalogos()).map((c) => c.id);
    const r = await pool.query(`SELECT s.id, s.catalog_id, s.titulo, s.orden FROM sheets s WHERE s.id = $1 AND NOT COALESCE(s.oculta,false) AND s.catalog_id = ANY($2::int[])`, [id, cats]);
    return r.rows[0] || null;
  }

  // Láminas compuestas con los precios de hoy: caché en memoria (los precios no cambian de un minuto a otro).
  const cacheImg = new Map<number, { t: number; buf: Buffer; w: number; h: number }>();
  async function imagenLamina(id: number) {
    const c = cacheImg.get(id);
    if (c && Date.now() - c.t < 30 * 60_000) return c;
    const png = await d.recomponer(id, TARIFA);
    if (!png) return null;
    const { data, info } = await sharp(png).resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
    const v = { t: Date.now(), buf: data, w: info.width, h: info.height };
    cacheImg.set(id, v);
    if (cacheImg.size > 120) cacheImg.delete(cacheImg.keys().next().value as number);
    return v;
  }

  /** Middleware: la farmacia de la sesión (o 401). */
  const conCliente = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cli = await clienteDeSesion(pool, req.body?.sesion);
      if (!cli) { res.status(401).json({ ok: false }); return; }
      (req as any).cliente = cli; next();
    } catch (e: any) { console.error('[pedido] sesión', e.message); res.status(500).json({ ok: false }); }
  };
  const R = '/api/area-clientes';

  /** Catálogos y sus láminas (miniaturas públicas de CatalogPRO). */
  app.post(`${R}/catalogos`, conCliente, async (_req, res) => {
    try {
      const cats = await catalogos();
      const filas = (await pool.query(`SELECT id, catalog_id, titulo, miniatura_path, orden FROM sheets
        WHERE catalog_id = ANY($1::int[]) AND NOT COALESCE(oculta,false) ORDER BY catalog_id, orden, id`, [cats.map((c) => c.id)])).rows;
      const conProd = new Set((await pool.query(`SELECT DISTINCT z.sheet_id FROM sheet_zones z JOIN sheets s ON s.id = z.sheet_id
        WHERE s.catalog_id = ANY($1::int[]) AND (z.product_id IS NOT NULL OR z.familia_skus IS NOT NULL OR z.familia_ref IS NOT NULL)`, [cats.map((c) => c.id)])).rows.map((r: any) => r.sheet_id));
      res.json({ ok: true, catalogos: cats.map((c) => ({ id: c.id, nombre: c.nombre,
        laminas: filas.filter((f: any) => f.catalog_id === c.id).map((f: any) => ({ id: f.id, titulo: tituloLimpio(f.titulo), mini: f.miniatura_path || null, pedible: conProd.has(f.id) })) })) });
    } catch (e: any) { console.error('[pedido] catalogos', e.message); res.status(500).json({ ok: false }); }
  });

  /** Una lámina: sus zonas pulsables (producto, familia de variantes o enlace a otra lámina) y la anterior y la siguiente. */
  app.post(`${R}/lamina`, conCliente, async (req, res) => {
    try {
      const s = await laminaPermitida(Number(req.body?.id));
      if (!s) { res.status(404).json({ ok: false }); return; }
      const img = await imagenLamina(s.id);
      const hermanas = (await pool.query(`SELECT id FROM sheets WHERE catalog_id = $1 AND NOT COALESCE(oculta,false) ORDER BY orden, id`, [s.catalog_id])).rows.map((r: any) => r.id);
      const i = hermanas.indexOf(s.id);
      const zonas = (await pool.query(`SELECT id, product_id, familia_skus, familia_ref, etiqueta, link_sheet_id, es_comision, x, y, ancho, alto
        FROM sheet_zones WHERE sheet_id = $1 ORDER BY orden, id`, [s.id])).rows;
      const ids: number[] = [];
      zonas.forEach((z: any) => { if (z.product_id) ids.push(z.product_id); if (Array.isArray(z.familia_skus)) ids.push(...z.familia_skus.map(Number)); });
      const arts = await articulos(ids);
      const out: any[] = [];
      for (const z of zonas) {
        const caja = { x: Number(z.x), y: Number(z.y), ancho: Number(z.ancho), alto: Number(z.alto) };
        if (z.link_sheet_id && (await laminaPermitida(z.link_sheet_id))) { out.push({ ...caja, tipo: 'enlace', lamina: z.link_sheet_id, etiqueta: z.etiqueta || 'Ver lámina' }); continue; }
        if (z.product_id && arts.has(z.product_id)) { out.push({ ...caja, tipo: 'producto', producto: arts.get(z.product_id) }); continue; }
        let opciones: any[] = Array.isArray(z.familia_skus) ? z.familia_skus.map(Number).filter((n: number) => arts.has(n)).map((n: number) => arts.get(n)) : [];
        if (!opciones.length && z.familia_ref) {
          const pal = String(z.familia_ref).split(/\s+/).filter((w: string) => w.length > 2).slice(0, 4);
          if (pal.length) {
            const r = await pool.query(`SELECT p.id FROM products p WHERE ${VIVO} AND ${pal.map((_, k) => `p.nombre ILIKE $${k + 1}`).join(' AND ')} ORDER BY p.nombre LIMIT 40`, pal.map((w) => `%${w}%`));
            const extra = await articulos(r.rows.map((x: any) => x.id));
            opciones = Array.from(extra.values());
          }
        }
        if (opciones.length === 1) out.push({ ...caja, tipo: 'producto', producto: opciones[0] });
        else if (opciones.length) out.push({ ...caja, tipo: 'familia', etiqueta: z.etiqueta || z.familia_ref || 'Elige el modelo', opciones });
      }
      res.json({ ok: true, lamina: { id: s.id, titulo: tituloLimpio(s.titulo), catalogo: s.catalog_id, ancho: img?.w || 1600, alto: img?.h || 2000,
        anterior: i > 0 ? hermanas[i - 1] : null, siguiente: i >= 0 && i < hermanas.length - 1 ? hermanas[i + 1] : null, numero: i + 1, total: hermanas.length, zonas: out } });
    } catch (e: any) { console.error('[pedido] lamina', e.message); res.status(500).json({ ok: false }); }
  });

  /** La imagen de la lámina con los precios de hoy (WebP). */
  app.post(`${R}/lamina-imagen`, conCliente, async (req, res) => {
    try {
      const s = await laminaPermitida(Number(req.body?.id));
      if (!s) { res.status(404).end(); return; }
      const img = await imagenLamina(s.id);
      if (!img) { res.status(404).end(); return; }
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'private, max-age=900');
      res.send(img.buf);
    } catch (e: any) { console.error('[pedido] imagen', e.message); res.status(500).end(); }
  });

  /** Buscador de artículos (nombre, código o código de barras), con la lámina donde sale si la hay. */
  app.post(`${R}/buscar`, conCliente, async (req, res) => {
    try {
      const q = String(req.body?.q || '').trim().slice(0, 80);
      if (q.length < 2) { res.json({ ok: true, articulos: [] }); return; }
      const pal = q.split(/\s+/).filter(Boolean).slice(0, 6);
      const r = await pool.query(`SELECT p.id FROM products p WHERE ${VIVO} AND (UPPER(p.codigo) = UPPER($1) OR p.ean = $1 OR (${pal.map((_, k) => `p.nombre ILIKE $${k + 2}`).join(' AND ')}))
        ORDER BY (UPPER(p.codigo) = UPPER($1) OR p.ean = $1) DESC, p.nombre LIMIT 40`, [q, ...pal.map((w) => `%${w}%`)]);
      const ids = r.rows.map((x: any) => x.id);
      const arts = await articulos(ids);
      const cats = (await catalogos()).map((c) => c.id);
      const lam = await pool.query(`SELECT DISTINCT ON (z.product_id) z.product_id, s.id, s.titulo FROM sheet_zones z JOIN sheets s ON s.id = z.sheet_id
        WHERE z.product_id = ANY($1::int[]) AND s.catalog_id = ANY($2::int[]) AND NOT COALESCE(s.oculta,false) ORDER BY z.product_id, s.catalog_id, s.orden`, [ids, cats]);
      const lm = new Map(lam.rows.map((x: any) => [x.product_id, { id: x.id, titulo: tituloLimpio(x.titulo) }]));
      res.json({ ok: true, articulos: ids.filter((id) => arts.has(id)).map((id) => ({ ...arts.get(id), lamina: lm.get(id) || null })) });
    } catch (e: any) { console.error('[pedido] buscar', e.message); res.status(500).json({ ok: false }); }
  });

  // ---------- El pedido de la farmacia (uno abierto por farmacia, compartido por quien entre de esa farmacia) ----------
  async function pedidoAbierto(clientId: number, cx: { query: Pool['query'] } = pool) {
    await cx.query(`INSERT INTO web_pedidos (client_id) VALUES ($1) ON CONFLICT (client_id) WHERE estado = 'abierto' DO NOTHING`, [clientId]);
    return (await cx.query(`SELECT * FROM web_pedidos WHERE client_id = $1 AND estado = 'abierto'`, [clientId])).rows[0];
  }
  async function vista(p: any) {
    const lineas: Linea[] = Array.isArray(p.lineas) ? p.lineas : [];
    const pr = await precios(lineas.map((l) => l.product_id || 0));
    const con = lineas.map((l) => ({ ...l, ...(l.product_id ? pr[l.product_id] || { pvf: null, pvpr: null } : { pvf: null, pvpr: null }) }));
    const total = con.reduce((s, l) => s + (l.pvf != null ? l.pvf * l.cantidad : 0), 0);
    return { id: p.id, lineas: con, nota: p.nota || '', total: Math.round(total * 100) / 100, actualizado: p.actualizado_at };
  }
  const enviados = async (clientId: number) => (await pool.query(`SELECT id, enviado_at, enviado_por, jsonb_array_length(lineas) n FROM web_pedidos
    WHERE client_id = $1 AND estado = 'enviado' ORDER BY enviado_at DESC LIMIT 10`, [clientId])).rows;

  app.post(`${R}/pedido`, conCliente, async (req, res) => {
    try {
      const cli = (req as any).cliente;
      res.json({ ok: true, pedido: await vista(await pedidoAbierto(cli.id)), enviados: await enviados(cli.id) });
    } catch (e: any) { console.error('[pedido] ver', e.message); res.status(500).json({ ok: false }); }
  });

  /** Pone la cantidad de un artículo (o de una línea a mano). cantidad 0 = quitar. sumar = añadir a lo que ya hay. */
  app.post(`${R}/pedido/poner`, conCliente, async (req, res) => {
    const cli = (req as any).cliente;
    const c = await pool.connect();
    try {
      const b = req.body || {};
      const quien = String(b.quien || '').trim().slice(0, 40);
      let cant = Math.round(Number(b.cantidad));
      if (!Number.isFinite(cant)) throw new Error('Cantidad no válida');
      await c.query('BEGIN');
      const p = await pedidoAbierto(cli.id, c);
      await c.query('SELECT id FROM web_pedidos WHERE id = $1 FOR UPDATE', [p.id]);
      const lineas: Linea[] = (await c.query('SELECT lineas FROM web_pedidos WHERE id = $1', [p.id])).rows[0].lineas || [];
      let k = String(b.k || '');
      let nueva: Linea | null = null;
      if (!k && b.product_id) {
        const a = (await articulos([Number(b.product_id)])).get(Number(b.product_id));
        if (!a) throw new Error('Ese artículo ya no está disponible');
        k = 'p' + a.id;
        nueva = { k, product_id: a.id, codigo: a.codigo, nombre: a.nombre, cantidad: 0, quien, lamina_id: Number(b.lamina_id) || undefined };
      } else if (!k && b.texto) {
        k = 't' + crypto.randomBytes(5).toString('hex');
        nueva = { k, nombre: String(b.texto).trim().slice(0, 200), cantidad: 0, quien, lamina_id: Number(b.lamina_id) || undefined };
        if (!nueva.nombre) throw new Error('Escribe qué quieres pedir');
      }
      let l = lineas.find((x) => x.k === k);
      if (!l && nueva) { if (lineas.length >= MAX_LINEAS) throw new Error('El pedido ya tiene demasiadas líneas'); lineas.push(nueva); l = nueva; }
      if (!l) throw new Error('Esa línea ya no está en el pedido');
      cant = b.sumar ? l.cantidad + cant : cant;
      if (cant <= 0) lineas.splice(lineas.indexOf(l), 1);
      else { l.cantidad = Math.min(cant, MAX_CANT); if (quien) l.quien = quien; l.at = new Date().toISOString(); }
      await c.query(`UPDATE web_pedidos SET lineas = $1::jsonb, actualizado_at = NOW() WHERE id = $2`, [JSON.stringify(lineas), p.id]);
      await c.query('COMMIT');
      res.json({ ok: true, pedido: await vista({ ...p, lineas, actualizado_at: new Date() }) });
    } catch (e: any) {
      await c.query('ROLLBACK').catch(() => {});
      res.status(400).json({ ok: false, error: e.message });
    } finally { c.release(); }
  });

  app.post(`${R}/pedido/nota`, conCliente, async (req, res) => {
    try {
      const cli = (req as any).cliente; const p = await pedidoAbierto(cli.id);
      await pool.query('UPDATE web_pedidos SET nota = $1, actualizado_at = NOW() WHERE id = $2', [String(req.body?.nota || '').slice(0, 1000), p.id]);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
  });

  /** Enviar: correo a los destinatarios del panel (mientras se prueba, la oficina y Fernando) y se abre un pedido nuevo. */
  app.post(`${R}/pedido/enviar`, conCliente, async (req, res) => {
    const cli = (req as any).cliente;
    try {
      const quien = String(req.body?.quien || '').trim().slice(0, 40);
      if (req.body?.nota !== undefined) await pool.query(`UPDATE web_pedidos SET nota = $1 WHERE client_id = $2 AND estado = 'abierto'`, [String(req.body.nota).slice(0, 1000), cli.id]);
      const p = await pedidoAbierto(cli.id);
      const v = await vista(p);
      if (!v.lineas.length) throw new Error('El pedido está vacío');
      // Sesión de PRUEBA (enlace sacado desde el panel, sin correo): el pedido va solo a Fernando y marcado, nunca a la oficina.
      const para = cli.prueba ? ['f.ayllon66@gmail.com'] : await destinatarios();
      if (!para.length) throw new Error('No hay a quién mandar el pedido. Llámanos al 943 371 549.');
      const nombre = String(cli.nombre_comercial || cli.razon_social || '').trim();
      const eur = (n: number | null) => (n == null ? '—' : n.toFixed(2).replace('.', ',') + ' €');
      const filas = v.lineas.map((l) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace">${esc(l.codigo || '—')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(l.nombre)}${l.product_id ? '' : ' <em style="color:#a0006a">(escrito a mano)</em>'}${l.quien ? `<br><small style="color:#777">${esc(l.quien)}</small>` : ''}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:bold">${l.cantidad}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${eur(l.pvf)}</td></tr>`).join('');
      const html = `<p><strong>Pedido desde la zona de clientes de la web</strong></p>
        <p><strong>${esc(nombre)}</strong> · código de cliente ${esc(cli.sage_code)}${cli.provincia ? ' · ' + esc(cli.provincia) : ''}${cli.commercial_code ? ' · comercial ' + esc(cli.commercial_code) : ''}<br>
        Enviado${quien ? ' por ' + esc(quien) : ''} el ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}</p>
        <table style="border-collapse:collapse;font-size:14px"><thead><tr style="background:#f4f1ec"><th style="padding:6px 10px;text-align:left">Código</th><th style="padding:6px 10px;text-align:left">Artículo</th><th style="padding:6px 10px">Uds.</th><th style="padding:6px 10px">PVF</th></tr></thead><tbody>${filas}</tbody></table>
        <p>Total orientativo a PVF: <strong>${eur(v.total)}</strong> (sin IVA, sin descuentos ni bonificaciones).</p>
        ${v.nota ? `<p><strong>Nota de la farmacia:</strong><br>${esc(v.nota).replace(/\n/g, '<br>')}</p>` : ''}
        <p style="color:#777;font-size:12px">Pedido web nº ${p.id}. Los destinatarios de este correo se cambian en el panel de la web de CatalogPRO, pestaña «Pedidos web».</p>`;
      const envio = await d.enviarCorreo({ rol: 'oficina', destinatarioReal: para.join(', '), asunto: `${cli.prueba ? '[PRUEBA] ' : ''}Pedido web · ${nombre || 'cliente ' + cli.sage_code} (${cli.sage_code}) · ${v.lineas.length} líneas`, html, forzarReal: true });
      if (!envio.ok) { console.error('[pedido] correo', envio.error); throw new Error('No hemos podido enviar el pedido ahora. Inténtalo de nuevo en un momento o llámanos al 943 371 549.'); }
      await pool.query(`UPDATE web_pedidos SET estado = 'enviado', enviado_at = NOW(), enviado_por = $1, destinatarios = $2, envio_ok = TRUE WHERE id = $3`, [quien || null, para.join(', '), p.id]);
      res.json({ ok: true, numero: p.id, enviados: await enviados(cli.id) });
    } catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ---------- Panel del administrador (pestaña «Pedidos web») ----------
  const esAdminTecnico = (req: Request) => { const u = (req as any).user; return !!u && u.role === 'admin' && !u._realAdminId && d.adminIds().includes(Number(u.id)); };
  const P = [d.verifyToken, (req: Request, res: Response, next: NextFunction) => {
    if (!esAdminTecnico(req)) { res.status(403).json({ error: 'Este apartado es solo para el administrador de la web.' }); return; }
    next();
  }];
  app.get('/api/web-admin/pedidos', ...P, async (_req: Request, res: Response) => {
    try {
      const filas = (await pool.query(`SELECT w.id, w.estado, w.enviado_at, w.actualizado_at, w.enviado_por, w.destinatarios, jsonb_array_length(w.lineas) n,
          c.sage_code, COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) nombre
        FROM web_pedidos w LEFT JOIN clients c ON c.id = w.client_id
        WHERE w.estado = 'enviado' OR jsonb_array_length(w.lineas) > 0 ORDER BY COALESCE(w.enviado_at, w.actualizado_at) DESC LIMIT 60`)).rows;
      res.json({ destinatarios: await destinatarios(), catalogos: await catalogos(), pedidos: filas });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/web-admin/pedidos/:id', ...P, async (req: Request, res: Response) => {
    try {
      const p = (await pool.query('SELECT * FROM web_pedidos WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!p) { res.status(404).json({ error: 'No existe' }); return; }
      res.json({ pedido: await vista(p) });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/web-admin/pedidos-destinatarios', ...P, async (req: Request, res: Response) => {
    try {
      const lista = Array.isArray(req.body?.destinatarios) ? req.body.destinatarios.map((e: any) => String(e).trim().toLowerCase()).filter(Boolean) : null;
      if (!lista) throw new Error('Lista no válida');
      const malos = lista.filter((e: string) => !correoValido(e));
      if (malos.length) throw new Error('Correo no válido: ' + malos.join(', '));
      if (!lista.length) throw new Error('Tiene que quedar al menos un destinatario');
      const unicos = Array.from(new Set(lista)).slice(0, 20) as string[];
      await ponAjuste('pedido_destinatarios', JSON.stringify(unicos));
      res.json({ ok: true, destinatarios: unicos });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
}
