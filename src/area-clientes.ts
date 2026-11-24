/**
 * Zona privada de clientes de lomhifar.es (24-nov-2026).
 *
 * Fernando: «tienen que ser clientes de nuestra base de datos para poder acceder; si no, que nos llamen para darles
 * de alta. Que no pueda entrar ningún proveedor. Garantízalo».
 *
 * La tabla `clients` de Sage MEZCLA farmacias y proveedores (VCS Farma, Combe, Essity, Mogar… están dados de alta
 * como clientes). Por eso el acceso no es «estar en clients», sino que hay que pasar TODAS estas capas:
 *   1. Cliente activo de Sage: is_active, sin es_baja, sin baja_empresa_lc, sin pendiente_alta y sin «BAJA» en el nombre.
 *   2. No es proveedor: su nombre no coincide con ningún proveedor del catálogo (products.proveedor) → bloqueado siempre.
 *   3. Es farmacia o similar: titular persona física (NIF/NIE) o nombre con FARMACIA, ÓPTICA, ORTOPEDIA…
 *      Cualquier otra sociedad queda «por revisar» y NO entra hasta que el administrador la permita en el panel.
 *   4. El enlace de entrada va SOLO al correo que hay en Sage para ese cliente (nunca a uno que escriba la persona).
 * Las decisiones manuales del panel (permitir / bloquear) mandan sobre la regla automática, salvo la capa 1.
 * Cada consulta de sesión vuelve a evaluar las capas: bloquear a alguien le echa en el momento.
 */
import type { Express, Request, Response, RequestHandler, NextFunction } from 'express';
import type { Pool } from 'pg';
import crypto from 'crypto';

export type EnviarCorreo = (o: { rol: 'oficina' | 'cliente' | 'comercial'; destinatarioReal: string; asunto: string; html: string; forzarReal?: boolean }) =>
  Promise<{ ok: boolean; destinatarioFinal: string; error?: string; modo: string; real: boolean }>;

type Deps = { pool: Pool; verifyToken: RequestHandler; enviarCorreo: EnviarCorreo; adminIds: () => number[] };

const ENLACE_MIN = 20;          // el enlace del correo caduca a los 20 minutos y sirve una sola vez
const SESION_DIAS = 30;
const BASES_PERMITIDAS = [/^https:\/\/(www\.)?lomhifar\.es$/, /^https:\/\/even-orange-manatee-77\.hostingersite\.com$/, /^http:\/\/localhost:\d+$/];

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const nuevoToken = () => crypto.randomBytes(32).toString('base64url');
export const normNombre = (s: unknown) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Z0-9 ]/g, ' ').replace(/\b(S L U|S L|S A|SL|SA|SLU|S C|SC|C B|CB|SOCIEDAD LIMITADA|LABORATORIOS?)\b/g, ' ').replace(/\s+/g, ' ').trim();
const normCodigo = (s: unknown) => String(s || '').toUpperCase().replace(/[\s.\-]/g, '').slice(0, 20);
const PALABRAS_FARMACIA = /\b(FARMACIA|FARMACIAS|PARAFARMACIA|BOTICA|OPTICA|OPTICAS|ORTOPEDIA|ORTOPEDIAS|FARMACEUTIC[AO]S?|FARMACEUTIKA|BOTIKA)\b/;
const esPersonaFisica = (cif: unknown) => /^([0-9]{8}[A-Z]|[XYZ][0-9]{7}[A-Z]|[KLM][0-9]{7}[A-Z])$/.test(normCodigo(cif));

export type Motivo = 'ok' | 'baja' | 'proveedor' | 'bloqueado' | 'revisar' | 'sin_email';

export async function migrarAcceso(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS web_acceso_reglas (
    client_id INTEGER PRIMARY KEY, estado VARCHAR(12) NOT NULL CHECK (estado IN ('permitido','bloqueado')),
    nota VARCHAR(200) NOT NULL DEFAULT '', por_user_id INTEGER, updated_at TIMESTAMP NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS web_acceso_enlaces (
    token_hash CHAR(64) PRIMARY KEY, client_id INTEGER NOT NULL, expira TIMESTAMP NOT NULL, usado_at TIMESTAMP,
    ip VARCHAR(60), creado_at TIMESTAMP NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS web_acceso_sesiones (
    token_hash CHAR(64) PRIMARY KEY, client_id INTEGER NOT NULL, expira TIMESTAMP NOT NULL, revocada BOOLEAN NOT NULL DEFAULT FALSE,
    ip VARCHAR(60), ua VARCHAR(200), creado_at TIMESTAMP NOT NULL DEFAULT NOW(), ultima_at TIMESTAMP NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS web_acceso_log (
    id SERIAL PRIMARY KEY, at TIMESTAMP NOT NULL DEFAULT NOW(), ip VARCHAR(60), client_id INTEGER, accion VARCHAR(20) NOT NULL, resultado VARCHAR(20) NOT NULL)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS web_acceso_log_ip ON web_acceso_log (ip, at)`);
}

/** Nombres de proveedores del catálogo, normalizados (caché de 10 minutos). */
let provCache: { t: number; lista: string[] } | null = null;
async function proveedores(pool: Pool) {
  if (provCache && Date.now() - provCache.t < 600_000) return provCache.lista;
  const r = await pool.query('SELECT DISTINCT proveedor FROM products WHERE proveedor IS NOT NULL');
  provCache = { t: Date.now(), lista: r.rows.map((x) => normNombre(x.proveedor)).filter((x) => x.length > 3) };
  return provCache.lista;
}
export function pareceProveedor(cli: { razon_social?: string; nombre_comercial?: string }, provs: string[]) {
  const a = normNombre(cli.razon_social), b = normNombre(cli.nombre_comercial);
  return provs.some((p) => p === a || p === b || (p.length > 6 && ((a && a.includes(p)) || (b && b.includes(p)))));
}

/** Evalúa las capas para un cliente. La regla manual manda sobre las capas 2 y 3, nunca sobre la 1. */
export function evaluar(cli: any, provs: string[], regla?: 'permitido' | 'bloqueado'): Motivo {
  const nombre = normNombre(cli.razon_social) + ' ' + normNombre(cli.nombre_comercial);
  if (!cli.is_active || cli.es_baja || cli.baja_empresa_lc || cli.pendiente_alta || /\bBAJA\b/.test(nombre)) return 'baja';
  if (regla === 'bloqueado') return 'bloqueado';
  if (regla !== 'permitido') {
    if (pareceProveedor(cli, provs)) return 'proveedor';
    if (!esPersonaFisica(cli.cif) && !PALABRAS_FARMACIA.test(nombre)) return 'revisar';
  }
  if (!String(cli.email || '').includes('@')) return 'sin_email';
  return 'ok';
}

const CAMPOS_CLI = 'id, sage_code, razon_social, nombre_comercial, cif, email, is_active, es_baja, baja_empresa_lc, pendiente_alta, commercial_code, provincia';
async function reglaDe(pool: Pool, id: number) {
  return (await pool.query('SELECT estado FROM web_acceso_reglas WHERE client_id = $1', [id])).rows[0]?.estado as 'permitido' | 'bloqueado' | undefined;
}
async function clientePorId(pool: Pool, id: number) {
  return (await pool.query(`SELECT ${CAMPOS_CLI} FROM clients WHERE id = $1`, [id])).rows[0];
}
/** Cliente de una sesión de la web, volviendo a pasar TODAS las capas (lo usa también el catálogo y el pedido). */
export async function clienteDeSesion(pool: Pool, sesion: unknown) {
  const s = String(sesion || '');
  if (s.length < 20) return null;
  const r = await pool.query(`SELECT client_id, ip FROM web_acceso_sesiones WHERE token_hash = $1 AND NOT revocada AND expira > NOW()`, [hash(s)]);
  if (!r.rowCount) return null;
  const cli = await clientePorId(pool, r.rows[0].client_id);
  if (!cli || evaluar(cli, await proveedores(pool), await reglaDe(pool, cli.id)) !== 'ok') return null;
  return { ...cli, prueba: r.rows[0].ip === 'prueba' } as { id: number; sage_code: string; razon_social: string; nombre_comercial: string; email: string; commercial_code: string; provincia: string; prueba: boolean };
}
const ipDe = (req: Request) => String(req.headers['x-cliente-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 60);
const enmascarar = (e: string) => { const [u, d = ''] = e.split('@'); const [dn, ...tld] = d.split('.'); return (u[0] || '') + '•••@' + (dn[0] || '') + '•••.' + tld.join('.'); };

export function registrarAreaClientes(app: Express, d: Deps) {
  const { pool } = d;
  migrarAcceso(pool).catch((e) => console.error('[acceso] migración', e.message));
  const log = (ip: string, client_id: number | null, accion: string, resultado: string) =>
    pool.query('INSERT INTO web_acceso_log (ip, client_id, accion, resultado) VALUES ($1,$2,$3,$4)', [ip, client_id, accion, resultado]).catch(() => {});
  const ajuste = async (k: string) => (await pool.query('SELECT valor FROM web_ajustes WHERE clave = $1', [k]).catch(() => ({ rows: [] as any[] }))).rows[0]?.valor || '';
  const esAdminTecnico = (req: Request) => { const u = (req as any).user; return !!u && u.role === 'admin' && !u._realAdminId && d.adminIds().includes(Number(u.id)); };

  // Mensaje único para todo lo que no entra: no se dice si el código existe ni por qué no entra (un proveedor no aprende nada).
  const CONTACTAR = { estado: 'contactar', mensaje: 'No podemos darte acceso con estos datos. La zona de clientes es solo para farmacias clientes de Lomhifar: llámanos al 943 371 549 y te damos de alta.' };

  /** 1) La farmacia pide entrar con su código de cliente o su NIF/CIF. El enlace va al correo de Sage. */
  app.post('/api/area-clientes/solicitar', async (req: Request, res: Response) => {
    const ip = ipDe(req);
    try {
      const codigo = normCodigo(req.body?.codigo);
      const base = String(req.body?.base || '').replace(/\/+$/, '');
      if (!BASES_PERMITIDAS.some((r) => r.test(base))) { res.status(400).json({ error: 'base no permitida' }); return; }
      // Límite por IP (la que reenvía la web en x-cliente-ip): 20 peticiones cada 15 minutos. El límite fuerte es el de cada cliente.
      const n = (await pool.query(`SELECT COUNT(*)::int n FROM web_acceso_log WHERE ip = $1 AND accion = 'solicitar' AND at > NOW() - INTERVAL '15 minutes'`, [ip])).rows[0].n;
      if (n >= 20) { log(ip, null, 'solicitar', 'limite'); res.status(429).json({ estado: 'espera', mensaje: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' }); return; }
      if (codigo.length < 2) { log(ip, null, 'solicitar', 'vacio'); res.json({ estado: 'falta', mensaje: 'Escribe tu código de cliente o el NIF/CIF de la farmacia.' }); return; }
      const filas = (await pool.query(`SELECT ${CAMPOS_CLI} FROM clients
        WHERE UPPER(TRIM(sage_code)) = $1 OR UPPER(REGEXP_REPLACE(COALESCE(cif,''), '[\\s.\\-]', '', 'g')) = $1 LIMIT 3`, [codigo])).rows;
      if (filas.length !== 1) { log(ip, null, 'solicitar', filas.length ? 'ambiguo' : 'no_cliente'); res.json(CONTACTAR); return; }
      const cli = filas[0];
      const motivo = evaluar(cli, await proveedores(pool), await reglaDe(pool, cli.id));
      if (motivo !== 'ok') { log(ip, cli.id, 'solicitar', motivo); res.json(CONTACTAR); return; }
      // Límite por cliente: 4 enlaces por hora.
      const m = (await pool.query(`SELECT COUNT(*)::int n FROM web_acceso_enlaces WHERE client_id = $1 AND creado_at > NOW() - INTERVAL '1 hour'`, [cli.id])).rows[0].n;
      if (m >= 4) { log(ip, cli.id, 'solicitar', 'limite'); res.status(429).json({ estado: 'espera', mensaje: 'Ya te hemos mandado varios enlaces. Mira tu correo o espera un rato.' }); return; }
      const t = nuevoToken();
      await pool.query(`INSERT INTO web_acceso_enlaces (token_hash, client_id, expira, ip) VALUES ($1,$2,NOW() + INTERVAL '${ENLACE_MIN} minutes',$3)`, [hash(t), cli.id, ip]);
      const enlace = `${base}/area-clientes/entrar/?t=${t}`;
      const nombre = String(cli.nombre_comercial || cli.razon_social || '').trim();
      const html = `<p>Hola:</p><p>Para entrar en la zona de clientes de Lomhifar${nombre ? ` con ${nombre.replace(/[<>&]/g, '')}` : ''}, pulsa este enlace. Sirve una sola vez y caduca en ${ENLACE_MIN} minutos:</p>
        <p><a href="${enlace}">Entrar en la zona de clientes</a></p><p>Si no lo has pedido tú, no hagas nada: sin el enlace nadie puede entrar.</p><p>Lomhifar · 943 371 549</p>`;
      const activo = (await ajuste('acceso_clientes_activo')) === 'si';
      // Mientras Fernando no lo active, el enlace NO va a la farmacia: va al correo de la oficina, marcado como prueba.
      const envio = activo
        ? await d.enviarCorreo({ rol: 'cliente', destinatarioReal: String(cli.email).trim(), asunto: 'Tu enlace para entrar en la zona de clientes de Lomhifar', html, forzarReal: true })
        : await d.enviarCorreo({ rol: 'oficina', destinatarioReal: (await ajuste('correo')) || 'lomhifar@lomhifar.com', asunto: `[PRUEBA zona de clientes] Enlace para ${nombre || 'cliente ' + cli.sage_code}`, html });
      log(ip, cli.id, 'solicitar', envio.ok ? (activo ? 'ok' : 'ok_oficina') : 'fallo_correo');
      if (!envio.ok) { res.status(502).json({ estado: 'error', mensaje: 'No hemos podido mandar el correo ahora. Llámanos al 943 371 549.' }); return; }
      res.json({ estado: 'enviado', mensaje: `Te hemos mandado un enlace a ${enmascarar(String(cli.email).trim())}. Ábrelo desde ese correo para entrar.` });
    } catch (e: any) { console.error('[acceso] solicitar', e.message); res.status(500).json({ estado: 'error', mensaje: 'Ahora no podemos atenderte. Llámanos al 943 371 549.' }); }
  });

  /** 2) La web canjea el enlace del correo por una sesión (una sola vez, dentro de plazo, y volviendo a evaluar las capas). */
  app.post('/api/area-clientes/canjear', async (req: Request, res: Response) => {
    const ip = ipDe(req);
    try {
      const t = String(req.body?.t || '');
      if (t.length < 20) { res.status(400).json({ ok: false, motivo: 'enlace' }); return; }
      const r = await pool.query(`UPDATE web_acceso_enlaces SET usado_at = NOW() WHERE token_hash = $1 AND usado_at IS NULL AND expira > NOW() RETURNING client_id, ip`, [hash(t)]);
      if (!r.rowCount) { log(ip, null, 'canjear', 'enlace_malo'); res.status(401).json({ ok: false, motivo: 'enlace' }); return; }
      const id = r.rows[0].client_id; const cli = await clientePorId(pool, id);
      const motivo = cli ? evaluar(cli, await proveedores(pool), await reglaDe(pool, id)) : 'baja';
      if (motivo !== 'ok') { log(ip, id, 'canjear', motivo); res.status(403).json({ ok: false, motivo: 'contactar' }); return; }
      const s = nuevoToken();
      await pool.query(`INSERT INTO web_acceso_sesiones (token_hash, client_id, expira, ip, ua) VALUES ($1,$2,NOW() + INTERVAL '${SESION_DIAS} days',$3,$4)`,
        // Un enlace sacado con «acceso-prueba» (sin correo) da una sesión de PRUEBA: sus pedidos van solo a Fernando, marcados.
        [hash(s), id, r.rows[0].ip === 'prueba' ? 'prueba' : ip, String(req.headers['x-cliente-ua'] || '').slice(0, 200)]);
      log(ip, id, 'canjear', 'ok');
      res.json({ ok: true, sesion: s, dias: SESION_DIAS, cliente: { nombre: String(cli.nombre_comercial || cli.razon_social || '').trim() } });
    } catch (e: any) { console.error('[acceso] canjear', e.message); res.status(500).json({ ok: false, motivo: 'error' }); }
  });

  /** 3) La web pregunta en cada página privada si la sesión sigue valiendo (y si el cliente sigue pudiendo entrar). */
  app.post('/api/area-clientes/sesion', async (req: Request, res: Response) => {
    try {
      const s = String(req.body?.sesion || '');
      if (s.length < 20) { res.status(401).json({ ok: false }); return; }
      const r = await pool.query(`UPDATE web_acceso_sesiones SET ultima_at = NOW() WHERE token_hash = $1 AND NOT revocada AND expira > NOW() RETURNING client_id`, [hash(s)]);
      if (!r.rowCount) { res.status(401).json({ ok: false }); return; }
      const id = r.rows[0].client_id; const cli = await clientePorId(pool, id);
      const motivo = cli ? evaluar(cli, await proveedores(pool), await reglaDe(pool, id)) : 'baja';
      if (motivo !== 'ok') { await pool.query('UPDATE web_acceso_sesiones SET revocada = TRUE WHERE token_hash = $1', [hash(s)]); res.status(403).json({ ok: false }); return; }
      res.json({ ok: true, cliente: { nombre: String(cli.nombre_comercial || cli.razon_social || '').trim(), codigo: String(cli.sage_code || '') } });
    } catch (e: any) { console.error('[acceso] sesion', e.message); res.status(500).json({ ok: false }); }
  });

  app.post('/api/area-clientes/salir', async (req: Request, res: Response) => {
    const s = String(req.body?.sesion || '');
    if (s.length >= 20) await pool.query('UPDATE web_acceso_sesiones SET revocada = TRUE WHERE token_hash = $1', [hash(s)]).catch(() => {});
    res.json({ ok: true });
  });

  // ---------- Panel del administrador ----------
  const P = [d.verifyToken, (req: Request, res: Response, next: NextFunction) => {
    if (!esAdminTecnico(req)) { res.status(403).json({ error: 'Este apartado es solo para el administrador de la web.' }); return; }
    next();
  }];
  /** Resumen y listas: proveedores bloqueados, sociedades por revisar y decisiones manuales. */
  app.get('/api/web-admin/acceso', ...P, async (_req: Request, res: Response) => {
    try {
      const provs = await proveedores(pool);
      const reglas = new Map((await pool.query('SELECT client_id, estado FROM web_acceso_reglas')).rows.map((r) => [r.client_id, r.estado]));
      const cli = (await pool.query(`SELECT ${CAMPOS_CLI} FROM clients`)).rows;
      const cuenta: Record<string, number> = {}; const lista: any[] = [];
      for (const c of cli) {
        const m = evaluar(c, provs, reglas.get(c.id));
        cuenta[m] = (cuenta[m] || 0) + 1;
        if (m === 'proveedor' || m === 'revisar' || reglas.has(c.id)) lista.push({ id: c.id, codigo: c.sage_code, nombre: String(c.nombre_comercial || c.razon_social || '').trim(), provincia: c.provincia || '', estado: m, regla: reglas.get(c.id) || null });
      }
      const ult = (await pool.query(`SELECT at, accion, resultado FROM web_acceso_log ORDER BY id DESC LIMIT 30`)).rows;
      res.json({ activo: (await ajuste('acceso_clientes_activo')) === 'si', cuenta, lista, ultimos: ult });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  /** Prueba técnica: dice qué pasaría con un código y, si entraría, da el enlace SIN mandar ningún correo. */
  app.post('/api/web-admin/acceso-prueba', ...P, async (req: Request, res: Response) => {
    try {
      const codigo = normCodigo(req.body?.codigo);
      const base = String(req.body?.base || '').replace(/\/+$/, '');
      if (!BASES_PERMITIDAS.some((r) => r.test(base))) throw new Error('base no permitida');
      const filas = (await pool.query(`SELECT ${CAMPOS_CLI} FROM clients
        WHERE UPPER(TRIM(sage_code)) = $1 OR UPPER(REGEXP_REPLACE(COALESCE(cif,''), '[\\s.\\-]', '', 'g')) = $1 LIMIT 3`, [codigo])).rows;
      if (filas.length !== 1) { res.json({ entra: false, motivo: filas.length ? 'ambiguo' : 'no_cliente' }); return; }
      const motivo = evaluar(filas[0], await proveedores(pool), await reglaDe(pool, filas[0].id));
      if (motivo !== 'ok') { res.json({ entra: false, motivo, id: filas[0].id }); return; }
      const t = nuevoToken();
      await pool.query(`INSERT INTO web_acceso_enlaces (token_hash, client_id, expira, ip) VALUES ($1,$2,NOW() + INTERVAL '${ENLACE_MIN} minutes','prueba')`, [hash(t), filas[0].id]);
      log('prueba', filas[0].id, 'prueba', 'ok');
      res.json({ entra: true, id: filas[0].id, enlace: `${base}/area-clientes/entrar/?t=${t}` });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  /** Para las pruebas: códigos de ejemplo de cada caso (sin datos personales). */
  app.get('/api/web-admin/acceso-ejemplos', ...P, async (_req: Request, res: Response) => {
    try {
      const provs = await proveedores(pool);
      const reglas = new Map((await pool.query('SELECT client_id, estado FROM web_acceso_reglas')).rows.map((r) => [r.client_id, r.estado]));
      const cli = (await pool.query(`SELECT ${CAMPOS_CLI} FROM clients ORDER BY id`)).rows;
      const ej: Record<string, string[]> = {};
      for (const c of cli) { const m = evaluar(c, provs, reglas.get(c.id)); (ej[m] ||= []).length < 5 && ej[m].push(String(c.sage_code)); }
      res.json(ej);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  /** estado: 'permitido', 'bloqueado' o null (vuelve a la regla automática). */
  app.put('/api/web-admin/acceso/:id', ...P, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id); const estado = req.body?.estado;
      if (!(id > 0)) throw new Error('Cliente no válido');
      if (estado === null) await pool.query('DELETE FROM web_acceso_reglas WHERE client_id = $1', [id]);
      else if (estado === 'permitido' || estado === 'bloqueado') await pool.query(`INSERT INTO web_acceso_reglas (client_id, estado, nota, por_user_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT (client_id) DO UPDATE SET estado = EXCLUDED.estado, nota = EXCLUDED.nota, por_user_id = EXCLUDED.por_user_id, updated_at = NOW()`,
        [id, estado, String(req.body?.nota || '').slice(0, 200), (req as any).user?.id || null]);
      else throw new Error('Valor no válido');
      if (estado === 'bloqueado') await pool.query('UPDATE web_acceso_sesiones SET revocada = TRUE WHERE client_id = $1', [id]);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  /** Interruptor: mientras esté apagado, los enlaces van al correo de la oficina, no a las farmacias. */
  app.put('/api/web-admin/acceso-activo', ...P, async (req: Request, res: Response) => {
    try {
      const v = req.body?.activo === true ? 'si' : 'no';
      await pool.query(`INSERT INTO web_ajustes (clave, valor) VALUES ('acceso_clientes_activo',$1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`, [v]);
      res.json({ ok: true, activo: v === 'si' });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
}
