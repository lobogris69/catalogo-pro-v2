// ============================================================================
// TABLAS DE EXPOSITOR — leer el Excel del usuario, calcular importes/totales y
// dibujar una tabla profesional (SVG -> PNG con sharp) para incrustar en la lamina.
// Estructura del Excel (plantilla Leukoplast/Essity): secciones ("90 Tiras", ...)
// con filas Producto | Medidas | C.N. | Uds | pvl | Dto. Lo unico que cambia al
// actualizar es 'pvl'; todo lo demas se calcula: pvl_neto = pvl*(1-dto),
// importe = pvl_neto*uds, subtotal = suma, total = suma de subtotales.
// ============================================================================
import * as XLSX from 'xlsx';
import sharp from 'sharp';

export interface FilaTabla { producto: string; medidas: string; cn: string; uds: number; pvl: number; dto: number; }
export interface SeccionTabla { titulo: string; filas: FilaTabla[]; }
export interface DatosTabla { titulo?: string; secciones: SeccionTabla[]; }

const num = (v: any): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Lee el .xlsx y devuelve la estructura de secciones/filas.
// --- Lectura FLEXIBLE ------------------------------------------------------
// El primer lector exigia columnas fijas B..G en la primera hoja. Con eso, un
// Excel que empezara en A, con una columna de mas o con la tabla en la segunda
// pestana daba "no se reconocieron filas". Ahora buscamos la fila de cabeceras
// y mapeamos cada columna POR SU NOMBRE, en cualquier hoja del libro.

// Normaliza un titulo de columna: minusculas, sin acentos, sin espacios ni signos.
const norm = (s: any) => String(s == null ? '' : s)
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[\s._%º°ª()\/-]/g, '').trim();

// Sinonimos aceptados para cada campo (coincidencia EXACTA tras normalizar, para
// que "pvl dto" -> "pvldto" no se confunda con "pvl").
const SINONIMOS: { [campo: string]: string[] } = {
  producto: ['producto', 'productos', 'descripcion', 'articulo', 'articulos', 'denominacion', 'nombre', 'referencia', 'ref', 'concepto'],
  medidas:  ['medidas', 'medida', 'formato', 'tamano', 'presentacion', 'modelo', 'variedad', 'color'],
  cn:       ['cn', 'codigonacional', 'codnacional', 'codigo', 'cod', 'ean', 'codigoean', 'codean', 'codart'],
  uds:      ['uds', 'ud', 'unidades', 'unid', 'cantidad', 'cant', 'ctd', 'cajas', 'nunidades'],
  pvl:      ['pvl', 'precio', 'preciopvl', 'preciounitario', 'pvlunitario', 'pvf', 'tarifa', 'preciolista'],
  dto:      ['dto', 'dtos', 'descuento', 'desc', 'dscto', 'dcto'],
};

type Mapa = { [campo: string]: number };

// Busca en las primeras filas una que parezca la cabecera de la tabla.
function detectarCabecera(rows: any[][]): { fila: number; mapa: Mapa } | null {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const fila = rows[r] || [];
    const mapa: Mapa = {};
    for (let c = 0; c < fila.length; c++) {
      const v = norm(fila[c]);
      if (!v) continue;
      for (const campo of Object.keys(SINONIMOS)) {
        if (mapa[campo] === undefined && SINONIMOS[campo].includes(v)) { mapa[campo] = c; break; }
      }
    }
    // Vale como cabecera si hay precio y algo que identifique el producto.
    if (mapa.pvl !== undefined && (mapa.cn !== undefined || mapa.producto !== undefined)) return { fila: r, mapa };
  }
  return null;
}

const txt = (v: any) => String(v == null ? '' : v).trim();

// Lee las filas usando el mapa de columnas detectado.
function leerConMapa(rows: any[][], desde: number, mapa: Mapa): SeccionTabla[] {
  const secciones: SeccionTabla[] = [];
  let actual: SeccionTabla | null = null;
  const cel = (f: any[], i: number | undefined) => (i === undefined ? null : f[i]);
  for (let r = desde + 1; r < rows.length; r++) {
    const f = rows[r] || [];
    const pvl = num(cel(f, mapa.pvl));
    const cn = txt(cel(f, mapa.cn));
    const prod = txt(cel(f, mapa.producto));
    // Fila de DATOS: precio numerico + algo que identifique el producto.
    if (pvl != null && (cn || prod) && !/^(sub)?total/i.test(prod)) {
      if (!actual) { actual = { titulo: 'Productos', filas: [] }; secciones.push(actual); }
      let dto = num(cel(f, mapa.dto)) ?? 0; dto = Math.abs(dto); if (dto > 1) dto = dto / 100;
      actual.filas.push({ producto: prod, medidas: txt(cel(f, mapa.medidas)), cn, uds: num(cel(f, mapa.uds)) ?? 0, pvl, dto });
      continue;
    }
    // Titulo de SECCION: primera celda con texto, sin precio y que no sea un total.
    const primero = f.map(txt).find(x => x);
    if (primero && pvl == null && !/^(sub)?total/i.test(primero)) {
      actual = { titulo: primero, filas: [] };
      secciones.push(actual);
    }
  }
  return secciones.filter(s => s.filas.length > 0);
}

// Lector antiguo de columnas fijas B..G: se conserva como respaldo para los
// Excel sin fila de cabeceras (los 12 ya subidos siguen leyendose igual).
function leerColumnasFijas(rows: any[][]): SeccionTabla[] {
  const secciones: SeccionTabla[] = [];
  let actual: SeccionTabla | null = null;
  for (const r of rows) {
    const B = r[1], C = r[2], D = r[3], E = r[4], F = r[5], G = r[6];
    const bTxt = txt(B);
    const cn = txt(D);
    const pvl = num(F), uds = num(E);
    if (cn && pvl != null) {
      if (!actual) { actual = { titulo: 'Productos', filas: [] }; secciones.push(actual); }
      let dto = num(G) ?? 0; dto = Math.abs(dto); if (dto > 1) dto = dto / 100;
      actual.filas.push({ producto: bTxt, medidas: txt(C), cn, uds: uds ?? 0, pvl, dto });
      continue;
    }
    if (bTxt.toLowerCase() === 'producto') continue;
    if (bTxt && !cn && pvl == null && uds == null && !/^total/i.test(bTxt)) {
      actual = { titulo: bTxt, filas: [] };
      secciones.push(actual);
    }
  }
  return secciones.filter(s => s.filas.length > 0);
}

const cuentaFilas = (ss: SeccionTabla[]) => ss.reduce((a, s) => a + s.filas.length, 0);

// Lee el .xlsx probando TODAS las hojas y se queda con la que mas productos da.
export function parseExcelTabla(buffer: Buffer): DatosTabla {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let mejor: SeccionTabla[] = [];
  for (const nombreHoja of wb.SheetNames) {
    const ws = wb.Sheets[nombreHoja];
    if (!ws) continue;
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const cab = detectarCabecera(rows);
    const cand = cab ? leerConMapa(rows, cab.fila, cab.mapa) : leerColumnasFijas(rows);
    if (cuentaFilas(cand) > cuentaFilas(mejor)) mejor = cand;
  }
  return { secciones: mejor };
}

// Explica QUE se ha leido del libro, para que un fallo sea accionable y no
// un "no se reconocieron filas" a ciegas.
export function resumenExcel(buffer: Buffer): string {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const partes = wb.SheetNames.slice(0, 5).map(n => {
      const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true });
      const cab = detectarCabecera(rows);
      if (!cab) {
        const primera = (rows.find(f => (f || []).some(c => txt(c))) || []).map(txt).filter(Boolean).slice(0, 8).join(' | ');
        return `"${n}": sin fila de cabeceras reconocible. Primera fila con texto: ${primera || '(vacía)'}`;
      }
      const letra = (i: number) => String.fromCharCode(65 + i);
      const cols = Object.keys(cab.mapa).map(k => `${k}=col ${letra(cab.mapa[k])}`).join(', ');
      const faltan = ['producto', 'cn', 'uds', 'pvl', 'dto'].filter(k => cab.mapa[k] === undefined);
      const nFilas = cuentaFilas(leerConMapa(rows, cab.fila, cab.mapa));
      return `"${n}": cabeceras en la fila ${cab.fila + 1} (${cols})` +
        (faltan.length ? `; NO encuentro la columna de: ${faltan.join(', ')}` : '') +
        `; ${nFilas} filas de producto leídas`;
    });
    return partes.join(' · ');
  } catch { return ''; }
}

// Calcula pvl_neto, importe, subtotales y total. round2 = redondeo espanol a 2 decimales.
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function computarTabla(datos: DatosTabla) {
  let total = 0;
  const secciones = (datos.secciones || []).map(s => {
    let subtotal = 0;
    const filas = s.filas.map(f => {
      const netoRaw = f.pvl * (1 - f.dto);
      const importe = r2(netoRaw * (f.uds || 0));
      subtotal += importe;
      return { ...f, pvl_neto: r2(netoRaw), importe };
    });
    subtotal = r2(subtotal); total += subtotal;
    return { titulo: s.titulo, filas, subtotal };
  });
  return { titulo: datos.titulo, secciones, total: r2(total),
    n_filas: secciones.reduce((a, s) => a + s.filas.length, 0) };
}

const esc = (s: any) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const eur = (n: number | null | undefined) => (n == null) ? '' : n.toFixed(2).replace('.', ',') + '€';
const FUENTE = 'Liberation Sans, Arial, DejaVu Sans, sans-serif';

// Dibuja la tabla como PNG. Estetica profesional y clara (magenta de la marca).
export async function renderTablaExpositor(datos: DatosTabla, opts?: { width?: number }): Promise<{ buffer: Buffer; width: number; height: number }> {
  const calc = computarTabla(datos);
  const W = Math.max(700, Math.min(1600, opts?.width || 1040));
  const M = 24;                        // margen exterior
  const cw = W - M * 2;                // ancho de contenido
  const fs = Math.round(W * 0.0145);   // tamano de fuente base
  const rowH = Math.round(fs * 2.0);   // alto de fila
  const secH = Math.round(fs * 2.3);   // alto de banda de seccion
  const headH = Math.round(fs * 1.9);  // alto de cabecera de columnas
  // Columnas (fraccion del ancho de contenido) + alineacion
  const cols = [
    { k: 'producto', t: 'Producto', w: 0.25, a: 'start' },
    { k: 'medidas', t: 'Medidas', w: 0.17, a: 'start' },
    { k: 'cn', t: 'C.N.', w: 0.12, a: 'start' },
    { k: 'uds', t: 'Uds.', w: 0.07, a: 'middle' },
    { k: 'pvl', t: 'P.V.L.', w: 0.11, a: 'end' },
    { k: 'dto', t: 'Dto.', w: 0.08, a: 'middle' },
    { k: 'neto', t: 'Neto', w: 0.10, a: 'end' },
    { k: 'imp', t: 'Importe', w: 0.10, a: 'end' },
  ];
  const xs: number[] = []; let acc = M;
  for (const c of cols) { xs.push(acc); acc += c.w * cw; }
  const cellX = (i: number, a: string) => a === 'start' ? xs[i] + 8 : a === 'end' ? xs[i] + cols[i].w * cw - 8 : xs[i] + cols[i].w * cw / 2;

  const BRAND = '#d80a6b', BRAND2 = '#9a1259', PLOMO = '#3a2b33';
  const HEAD_BG = '#f3e3ec', ZEBRA = '#faf5f8', LINEA = '#ead9e3';
  let y = M;
  let els = '';
  // Titulo opcional
  if (calc.titulo) {
    els += `<text x="${M}" y="${y + fs}" font-family="${FUENTE}" font-weight="700" font-size="${Math.round(fs * 1.4)}" fill="${BRAND2}">${esc(calc.titulo)}</text>`;
    y += Math.round(fs * 2.2);
  }
  const txt = (x: number, yy: number, s: string, o: { a?: string; b?: boolean; c?: string; sz?: number } = {}) =>
    `<text x="${x}" y="${yy}" font-family="${FUENTE}" font-weight="${o.b ? 700 : 400}" font-size="${o.sz || fs}" fill="${o.c || PLOMO}" text-anchor="${o.a || 'start'}">${esc(s)}</text>`;

  for (const s of calc.secciones) {
    // Banda de seccion
    els += `<rect x="${M}" y="${y}" width="${cw}" height="${secH}" rx="6" fill="${BRAND}"/>`;
    els += txt(M + 12, y + secH / 2 + fs * 0.35, s.titulo, { b: true, c: '#fff', sz: Math.round(fs * 1.05) });
    y += secH + 3;
    // Cabecera de columnas
    els += `<rect x="${M}" y="${y}" width="${cw}" height="${headH}" fill="${HEAD_BG}"/>`;
    cols.forEach((c, i) => { els += txt(cellX(i, c.a), y + headH / 2 + fs * 0.32, c.t, { b: true, c: BRAND2, a: c.a, sz: Math.round(fs * 0.9) }); });
    y += headH;
    // Filas
    s.filas.forEach((f: any, idx: number) => {
      if (idx % 2 === 1) els += `<rect x="${M}" y="${y}" width="${cw}" height="${rowH}" fill="${ZEBRA}"/>`;
      const vals: any = {
        producto: f.producto, medidas: f.medidas, cn: f.cn, uds: f.uds || '',
        pvl: eur(f.pvl), dto: '-' + Math.round(f.dto * 100) + '%', neto: eur(f.pvl_neto), imp: eur(f.importe),
      };
      cols.forEach((c, i) => {
        const b = (c.k === 'imp'); const col = c.k === 'imp' ? BRAND2 : c.k === 'dto' ? '#b45309' : PLOMO;
        els += txt(cellX(i, c.a), y + rowH / 2 + fs * 0.34, String(vals[c.k]), { a: c.a, b, c: col });
      });
      els += `<line x1="${M}" y1="${y + rowH}" x2="${M + cw}" y2="${y + rowH}" stroke="${LINEA}" stroke-width="1"/>`;
      y += rowH;
    });
    // Subtotal de seccion
    els += txt(M + cw - 8, y + rowH * 0.72, 'Subtotal  ' + eur(s.subtotal), { a: 'end', b: true, c: PLOMO });
    y += Math.round(rowH * 1.05);
    y += Math.round(fs * 0.6); // separacion entre secciones
  }
  // TOTAL general
  const totH = Math.round(fs * 2.4);
  els += `<rect x="${M}" y="${y}" width="${cw}" height="${totH}" rx="6" fill="${BRAND2}"/>`;
  els += txt(M + 14, y + totH / 2 + fs * 0.35, 'TOTAL', { b: true, c: '#fff', sz: Math.round(fs * 1.1) });
  els += txt(M + cw - 12, y + totH / 2 + fs * 0.35, eur(calc.total), { a: 'end', b: true, c: '#fff', sz: Math.round(fs * 1.2) });
  y += totH + M;

  const H = Math.ceil(y);
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ffffff"/>${els}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: W, height: H };
}
