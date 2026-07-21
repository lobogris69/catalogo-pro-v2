// ============================================================================
// TABLAS DE EXPOSITOR — leer el Excel del usuario y dibujarlo bonito.
//
// PRINCIPIO (pedido expreso del usuario, 21 jul 2026):
//   "no te inventes nada de calculos ni de totales, simplemente refleja mi Excel
//    original respetando su estructura sin anadir nada mas, solo mejora visual".
//
// Por eso NO se calcula nada: se leen las celdas TAL COMO SE VEN en Excel
// (raw:false respeta sus formatos de euros, % y decimales) y se dibujan con sus
// cabeceras, en su orden. Si su Excel trae Importe/Subtotal/TOTAL, salen porque
// estan en el Excel; si no los trae (una tarifa), no aparecen.
//
// Antes se hacia al reves (importe = pvl x uds, subtotales y TOTAL calculados),
// lo que anadia columnas inexistentes y, en los Excel sin unidades, lo dejaba
// todo a 0. Se conserva el formato antiguo solo para leer las tablas ya
// guardadas en BD (ver renderLegado).
// ============================================================================
import * as XLSX from 'xlsx';
import sharp from 'sharp';

// --- Formato FIEL (el que se usa ahora) ---
export type TipoFila = 'datos' | 'seccion' | 'total' | 'cabecera';
export interface FilaFiel { tipo: TipoFila; celdas: string[]; }
export interface DatosTabla {
  titulo?: string;
  cabeceras?: string[];      // cabeceras del Excel, tal cual
  filas?: FilaFiel[];        // filas del Excel, tal cual
  numericas?: boolean[];     // que columnas son numericas (para alinear a la derecha)
  // --- formato antiguo, solo para tablas ya guardadas ---
  secciones?: any[];
  sin_uds?: boolean;
}

const txt = (v: any) => String(v == null ? '' : v).trim();

// Normaliza un titulo de columna: minusculas, sin acentos, sin espacios ni signos.
const norm = (s: any) => String(s == null ? '' : s)
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[\s._%º°ª()\/-]/g, '').trim();

// Palabras que delatan una fila de cabeceras. No sirven para mapear columnas
// (ya no mapeamos nada): solo para localizar DONDE empieza la tabla.
const PALABRAS_CABECERA = [
  'producto', 'productos', 'descripcion', 'articulo', 'articulos', 'denominacion', 'nombre',
  'referencia', 'ref', 'concepto', 'medidas', 'medida', 'formato', 'presentacion',
  'cn', 'codigonacional', 'codnacional', 'codigo', 'ean', 'uds', 'ud', 'unidades', 'unid',
  'cantidad', 'cant', 'pvl', 'pvp', 'pvf', 'precio', 'tarifa', 'dto', 'descuento', 'desc',
  'importe', 'total', 'neto', 'iva', 'subtotal',
];

// Busca la fila que hace de cabecera: la primera con 2+ celdas reconocibles.
// Si no hay ninguna, cae a la primera fila con 3+ celdas con texto.
function localizarCabecera(rows: string[][]): number {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cel = (rows[r] || []).map(norm).filter(Boolean);
    if (cel.filter(v => PALABRAS_CABECERA.includes(v)).length >= 2) return r;
  }
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    if ((rows[r] || []).map(txt).filter(Boolean).length >= 3) return r;
  }
  return -1;
}

// Excel muestra los numeros con la configuracion regional; SheetJS los devuelve
// con punto decimal ("6.69 €", "211444.9"). Aqui se deja como el usuario lo ve en
// su Excel espanol: coma decimal, conservando el resto del formato (€, %, signo).
function aEspanol(vista: string, crudo: any): string {
  if (typeof crudo !== 'number' || !vista) return vista;
  const m = vista.match(/-?[\d.,]+/);
  if (!m) return vista;
  let t = m[0];
  if (t.includes(',')) return vista;              // ya viene en formato espanol
  if (!t.includes('.')) return vista;             // entero, nada que cambiar
  t = t.replace('.', ',');
  return vista.replace(m[0], t);
}

interface Extraida { cabeceras: string[]; filas: FilaFiel[]; numericas: boolean[]; }

// Extrae la tabla de una hoja respetando columnas, orden y valores tal cual.
function extraerHoja(ws: XLSX.WorkSheet): Extraida | null {
  const vistos: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  const crudos: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const rows = vistos.map(f => (f || []).map(txt));
  const rCab = localizarCabecera(rows);
  if (rCab < 0) return null;

  const cabRow = rows[rCab] || [];
  // Rango de columnas: de la primera a la ultima con algo, mirando cabecera y datos.
  let c0 = Infinity, c1 = -1;
  for (let r = rCab; r < rows.length; r++) {
    const f = rows[r] || [];
    for (let c = 0; c < f.length; c++) if (f[c]) { if (c < c0) c0 = c; if (c > c1) c1 = c; }
  }
  if (c1 < 0) return null;

  // Filas por debajo de la cabecera. Se corta tras 8 filas vacias seguidas
  // (evita arrastrar restos sueltos del final de la hoja).
  const nCols = c1 - c0 + 1;
  // Columnas numericas (para alinear a la derecha), segun los valores CRUDOS.
  const numericas: boolean[] = [];
  for (let i = 0; i < nCols; i++) {
    let num = 0, tot = 0;
    for (let r = rCab + 1; r < Math.min(rows.length, rCab + 200); r++) {
      const v = (crudos[r] || [])[c0 + i];
      if (v == null || v === '') continue;
      tot++; if (typeof v === 'number') num++;
    }
    numericas.push(tot > 0 && num / tot >= 0.6);
  }
  const cabNorm = (cabRow || []).map(norm);

  const filas: FilaFiel[] = [];
  // El titulo del PRIMER apartado suele ir justo ENCIMA de la fila de cabeceras
  // (los siguientes van intercalados). Sin esto se perdia.
  for (let r = rCab - 1; r >= 0 && r >= rCab - 3; r--) {
    const f = (rows[r] || []).map(txt);
    const conTexto = f.filter(Boolean).length;
    if (!conTexto) continue;
    const idx = f.findIndex(Boolean);
    if (conTexto === 1 && !numericas[idx - c0]) {
      const celdas = new Array(nCols).fill('');
      celdas[Math.max(0, idx - c0)] = f[idx];
      filas.push({ tipo: 'seccion', celdas });
      // ...y justo debajo iba la fila de cabeceras: se conserva ese orden.
      filas.push({ tipo: 'cabecera', celdas: new Array(nCols).fill('') });
    }
    break;
  }
  // Se recogen en bruto todas las filas por debajo de la cabecera.
  const bruto: string[][] = [];
  let vacias = 0;
  for (let r = rCab + 1; r < rows.length; r++) {
    const f = rows[r] || [];
    const fc = crudos[r] || [];
    const celdas: string[] = [];
    for (let c = c0; c <= c1; c++) celdas.push(aEspanol(f[c] || '', fc[c]));
    if (!celdas.some(Boolean)) { if (++vacias > 8) break; bruto.push(celdas); continue; }
    vacias = 0;
    bruto.push(celdas);
  }
  const lleno = (c: string[]) => c.filter(Boolean).length;
  const maxLleno = Math.max(1, ...bruto.map(lleno));
  // Primera fila de DATOS de verdad. Lo de arriba (p.ej. "Final | Descuento % | 20")
  // es continuacion de la cabecera o una nota suelta del usuario, NO una fila.
  const umbral = Math.max(2, Math.ceil(maxLleno * 0.5));
  const iDatos = bruto.findIndex(c => lleno(c) >= umbral);
  if (iDatos < 0) return null;

  // La cabecera puede ocupar VARIAS filas ("Precio" / "Final"): se unen.
  const cabeceras: string[] = [];
  for (let c = c0; c <= c1; c++) cabeceras.push(cabRow[c] || '');
  for (let k = 0; k < iDatos; k++) {
    bruto[k].forEach((v, i) => { if (v) cabeceras[i] = (cabeceras[i] ? cabeceras[i] + ' ' : '') + v; });
  }

  for (let k = iDatos; k < bruto.length; k++) {
    const celdas = bruto[k];
    const conTexto = lleno(celdas);
    if (!conTexto) continue;
    const primero = celdas.find(Boolean) || '';
    // El usuario repite la fila de cabeceras en cada apartado: se marca como tal
    // para volver a dibujarla ahi, no para colarla como si fuera un producto.
    const repes = celdas.filter((c, i) => c && cabNorm[c0 + i] && norm(c) === cabNorm[c0 + i]).length;
    // Una fila con UNA sola celda en columna NUMERICA es un subtotal, no un titulo
    // de apartado (asi salian los "198,30 €" sueltos como si fueran secciones).
    const idxUnico = celdas.findIndex(Boolean);
    let tipo: TipoFila;
    if (repes >= 2) tipo = 'cabecera';
    else if (/^(sub)?total/i.test(primero)) tipo = 'total';
    else if (conTexto === 1) tipo = numericas[idxUnico] ? 'total' : 'seccion';
    else if (conTexto < umbral && celdas.some((v, i) => v && numericas[i])) tipo = 'total';
    else tipo = 'datos';
    filas.push({ tipo, celdas });
  }
  if (!filas.length) return null;

  // QUE COLUMNAS FORMAN LA TABLA. La tabla la definen SUS CABECERAS, asi que una
  // columna entra solo si (1) tiene cabecera y (2) tiene datos. Con esto se caen
  // las dos cosas que el usuario veia como "columnas anadidas":
  //   - sus notas al margen ("Descuento %  15"), que tienen cabecera pero no datos,
  //   - sus columnas de trabajo sin cabecera al final de la hoja (Ganeshi).
  const util: number[] = [];
  for (let i = 0; i < nCols; i++) {
    if (cabeceras[i] && filas.some(f => f.tipo === 'datos' && f.celdas[i])) util.push(i);
  }
  if (!util.length) return null;
  const recortadas = filas
    .map(f => ({ tipo: f.tipo, celdas: util.map(i => f.celdas[i]) }))
    // Una fila que se queda sin nada al quitar esas columnas ya no pinta nada.
    .filter(f => f.tipo === 'cabecera' || f.celdas.some(Boolean));
  return {
    cabeceras: util.map(i => cabeceras[i]),
    filas: recortadas,
    numericas: util.map(i => numericas[i]),
  };
}

// Lee el .xlsx probando TODAS las hojas y se queda con la que mas filas da.
export function parseExcelTabla(buffer: Buffer): DatosTabla {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let mejor: Extraida | null = null;
  for (const nombre of wb.SheetNames) {
    const ws = wb.Sheets[nombre];
    if (!ws) continue;
    const e = extraerHoja(ws);
    if (e && (!mejor || e.filas.length > mejor.filas.length)) mejor = e;
  }
  if (!mejor) return { cabeceras: [], filas: [], numericas: [] };
  return { cabeceras: mejor.cabeceras, filas: mejor.filas, numericas: mejor.numericas };
}

// Explica QUE se ha leido, para que un fallo sea accionable.
export function resumenExcel(buffer: Buffer): string {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    return wb.SheetNames.slice(0, 5).map(n => {
      const rows: string[][] = (XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: false }) as any[][])
        .map(f => (f || []).map(txt));
      const rCab = localizarCabecera(rows);
      if (rCab < 0) {
        const primera = (rows.find(f => f.some(Boolean)) || []).filter(Boolean).slice(0, 8).join(' | ');
        return `"${n}": no encuentro la fila de cabeceras. Primera fila con texto: ${primera || '(vacía)'}`;
      }
      const e = extraerHoja(wb.Sheets[n]);
      return `"${n}": cabeceras en la fila ${rCab + 1} → ${(rows[rCab] || []).filter(Boolean).slice(0, 12).join(' | ')}; ${e ? e.filas.filter(f => f.tipo === 'datos').length : 0} filas`;
    }).join(' · ');
  } catch { return ''; }
}

// Resumen para la lista de la biblioteca. NO calcula importes ni totales: solo
// cuenta lo que hay. (Se mantiene el nombre por compatibilidad con el resto.)
export function computarTabla(datos: DatosTabla) {
  if (datos && datos.cabeceras) {
    const filas = datos.filas || [];
    return {
      titulo: datos.titulo,
      fiel: true,
      cabeceras: datos.cabeceras,
      filas,
      n_filas: filas.filter(f => f.tipo === 'datos').length,
      n_secciones: filas.filter(f => f.tipo === 'seccion').length,
      n_columnas: datos.cabeceras.length,
      total: null as number | null,
    };
  }
  // --- formato antiguo (tablas guardadas antes del cambio) ---
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const sinUds = !!(datos && datos.sin_uds);
  let total = 0;
  const secciones = ((datos && datos.secciones) || []).map((s: any) => {
    let subtotal = 0;
    const filas = s.filas.map((f: any) => {
      const netoRaw = f.pvl * (1 - f.dto);
      const importe = sinUds ? null : r2(netoRaw * (f.uds || 0));
      if (importe != null) subtotal += importe;
      return { ...f, pvl_neto: r2(netoRaw), importe };
    });
    subtotal = r2(subtotal); total += subtotal;
    return { titulo: s.titulo, filas, subtotal: sinUds ? null : subtotal };
  });
  return {
    titulo: datos && datos.titulo, fiel: false, secciones, sin_uds: sinUds,
    total: sinUds ? null : r2(total),
    n_secciones: secciones.length,
    n_filas: secciones.reduce((a: number, s: any) => a + s.filas.length, 0),
  } as any;
}

const esc = (s: any) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FUENTE = 'Liberation Sans, Arial, DejaVu Sans, sans-serif';

// Ancho aproximado de un texto en Liberation Sans. Sirve para repartir columnas
// y, sobre todo, para PARTIR el texto en varias lineas: antes una celda larga se
// salia y pisaba la de al lado.
function anchoTexto(s: string, fs: number): number {
  let w = 0;
  for (const ch of s) {
    if ('iljI.,:;\'|! '.includes(ch)) w += 0.30;
    else if ('fjrt()[]-'.includes(ch)) w += 0.36;
    else if ('mwMW@'.includes(ch)) w += 0.86;
    else if (ch >= 'A' && ch <= 'Z') w += 0.68;
    else w += 0.54;
  }
  return w * fs;
}

// Parte un texto en como mucho `maxLineas` que quepan en `ancho`.
function partirTexto(s: string, fs: number, ancho: number, maxLineas: number): string[] {
  if (!s) return [''];
  if (anchoTexto(s, fs) <= ancho) return [s];
  const palabras = s.split(/\s+/);
  const lineas: string[] = [];
  let actual = '';
  for (const p of palabras) {
    const prueba = actual ? actual + ' ' + p : p;
    if (anchoTexto(prueba, fs) <= ancho || !actual) actual = prueba;
    else { lineas.push(actual); actual = p; if (lineas.length === maxLineas) break; }
  }
  if (lineas.length < maxLineas && actual) lineas.push(actual);
  // Si aun asi la ultima linea se pasa, se recorta con puntos suspensivos.
  const ult = lineas.length - 1;
  if (ult >= 0 && anchoTexto(lineas[ult], fs) > ancho) {
    let t = lineas[ult];
    while (t.length > 1 && anchoTexto(t + '…', fs) > ancho) t = t.slice(0, -1);
    lineas[ult] = t + '…';
  }
  return lineas.slice(0, maxLineas);
}

const BRAND = '#d80a6b', BRAND2 = '#9a1259', PLOMO = '#3a2b33';
const HEAD_BG = '#f3e3ec', ZEBRA = '#faf5f8', LINEA = '#ead9e3';

export async function renderTablaExpositor(datos: DatosTabla, opts?: { width?: number }): Promise<{ buffer: Buffer; width: number; height: number }> {
  const calc: any = computarTabla(datos);
  if (!calc.fiel) return renderLegado(calc, opts);   // tablas guardadas antes del cambio

  const W = Math.max(700, Math.min(1600, opts?.width || 1040));
  const M = 24;
  const cw = W - M * 2;
  const cabeceras: string[] = calc.cabeceras;
  const filas: FilaFiel[] = calc.filas;
  const numericas: boolean[] = datos.numericas || cabeceras.map(() => false);
  const n = cabeceras.length;
  if (!n || !filas.length) {
    const vacio = await sharp({ create: { width: W, height: 60, channels: 3, background: '#fff' } }).png().toBuffer();
    return { buffer: vacio, width: W, height: 60 };
  }

  // ANCHOS. Regla: no recortar NADA. Se mide lo que ocupa cada columna de verdad
  // (cabecera + todas sus celdas) y, si no cabe, se REDUCE LA LETRA hasta que
  // quepa. Solo si aun asi no entra se parte en 2 lineas la columna de texto mas
  // larga. Las columnas numericas nunca se parten: por eso el "€" caia solo.
  const medir = (tam: number) => cabeceras.map((h, i) => {
    let mx = anchoTexto(h, tam * 0.92);
    // Cuentan tambien subtotales y TOTAL (si no, salia "TOTA…").
    for (const f of filas) if (f.tipo !== 'seccion' && f.tipo !== 'cabecera') mx = Math.max(mx, anchoTexto(f.celdas[i] || '', tam));
    return mx + tam * 1.4;   // margen interior proporcional a la letra
  });
  let fs = Math.round(W * 0.0145);
  let naturales = medir(fs);
  let suma = naturales.reduce((a, b) => a + b, 0) || 1;
  if (suma > cw) {                       // no cabe: se encoge la letra
    fs = Math.max(9, fs * (cw / suma));
    naturales = medir(fs);
    suma = naturales.reduce((a, b) => a + b, 0) || 1;
  }
  const pad = Math.round(fs * 0.7);
  const lineH = Math.round(fs * 1.35);

  let anchos: number[];
  if (suma <= cw) {
    anchos = naturales.map(x => (x / suma) * cw);   // sobra sitio: se reparte
  } else {
    // Ni con la letra al minimo: las numericas conservan su ancho entero y el
    // resto se reparte entre las de texto, que si pueden ir a dos lineas.
    const anchoNum = naturales.reduce((a, x, i) => a + (numericas[i] ? x : 0), 0);
    const resto = Math.max(cw * 0.25, cw - anchoNum);
    const sumaTxt = naturales.reduce((a, x, i) => a + (numericas[i] ? 0 : x), 0) || 1;
    anchos = naturales.map((x, i) => numericas[i] ? x * Math.min(1, cw / suma) : (x / sumaTxt) * resto);
  }
  const xs: number[] = []; let acc = M;
  for (const a of anchos) { xs.push(acc); acc += a; }

  const texto = (x: number, y: number, s: string, o: { a?: string; b?: boolean; c?: string; sz?: number } = {}) =>
    `<text x="${x}" y="${y}" font-family="${FUENTE}" font-weight="${o.b ? 700 : 400}" font-size="${o.sz || fs}" fill="${o.c || PLOMO}" text-anchor="${o.a || 'start'}">${esc(s)}</text>`;
  const posX = (i: number, der: boolean) => der ? xs[i] + anchos[i] - pad : xs[i] + pad;

  let y = M, els = '';
  if (calc.titulo) {
    els += texto(M, y + fs, calc.titulo, { b: true, c: BRAND2, sz: Math.round(fs * 1.4) });
    y += Math.round(fs * 2.2);
  }

  // Cabecera del Excel. Se dibuja arriba y, si el usuario la repite en cada
  // apartado, se vuelve a dibujar en ese sitio (fila de tipo 'cabecera').
  const lineasCab = cabeceras.map((h, i) => partirTexto(h, fs * 0.92, anchos[i] - pad * 2, 2));
  const hCab = Math.max(...lineasCab.map(l => l.length)) * lineH + pad;
  const pintarCabecera = () => {
    els += `<rect x="${M}" y="${y}" width="${cw}" height="${hCab}" fill="${HEAD_BG}"/>`;
    lineasCab.forEach((ls, i) => {
      ls.forEach((l, k) => {
        els += texto(posX(i, numericas[i]), y + pad * 0.8 + (k + 1) * lineH - lineH * 0.25, l,
          { b: true, c: BRAND2, a: numericas[i] ? 'end' : 'start', sz: Math.round(fs * 0.92) });
      });
    });
    y += hCab;
  };
  // Si el Excel ya repite la cabecera dentro de cada apartado y empieza por el
  // titulo de uno, se respeta ese orden (titulo -> cabecera) y no se duplica.
  const repiteCabecera = filas.some(f => f.tipo === 'cabecera');
  if (!(repiteCabecera && filas[0] && filas[0].tipo === 'seccion')) pintarCabecera();

  // Filas, respetando el tipo que traia el Excel
  let z = 0;
  filas.forEach(f => {
    if (f.tipo === 'cabecera') { pintarCabecera(); z = 0; return; }
    if (f.tipo === 'seccion') {
      const t = f.celdas.find(Boolean) || '';
      const h = Math.round(fs * 2.2);
      els += `<rect x="${M}" y="${y + 3}" width="${cw}" height="${h - 3}" rx="5" fill="${BRAND}"/>`;
      els += texto(M + pad, y + 3 + (h - 3) / 2 + fs * 0.35, t, { b: true, c: '#fff', sz: Math.round(fs * 1.03) });
      y += h + 2; z = 0;
      return;
    }
    const lineas = f.celdas.map((c, i) => partirTexto(c || "", fs, anchos[i] - pad * 2, numericas[i] ? 1 : 2));
    const h = Math.max(...lineas.map(l => l.length)) * lineH + pad * 0.6;
    const esTotal = f.tipo === 'total';
    if (esTotal) els += `<rect x="${M}" y="${y}" width="${cw}" height="${h}" fill="#f7edf3"/>`;
    else if (z % 2 === 1) els += `<rect x="${M}" y="${y}" width="${cw}" height="${h}" fill="${ZEBRA}"/>`;
    lineas.forEach((ls, i) => {
      ls.forEach((l, k) => {
        els += texto(posX(i, numericas[i]), y + pad * 0.3 + (k + 1) * lineH - lineH * 0.22, l,
          { a: numericas[i] ? 'end' : 'start', b: esTotal, c: esTotal ? BRAND2 : PLOMO });
      });
    });
    els += `<line x1="${M}" y1="${y + h}" x2="${M + cw}" y2="${y + h}" stroke="${esTotal ? BRAND : LINEA}" stroke-width="${esTotal ? 1.5 : 1}"/>`;
    y += h; z++;
  });
  y += M;

  const H = Math.ceil(y);
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ffffff"/>${els}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: W, height: H };
}

// Dibujo de las tablas guardadas con el formato antiguo (secciones/filas
// calculadas). Se mantiene para no romper las laminas ya montadas; al volver a
// subir el Excel, la tabla pasa al formato fiel.
async function renderLegado(calc: any, opts?: { width?: number }): Promise<{ buffer: Buffer; width: number; height: number }> {
  const W = Math.max(700, Math.min(1600, opts?.width || 1040));
  const M = 24, cw = W - M * 2;
  const fs = Math.round(W * 0.0145), rowH = Math.round(fs * 2.0);
  const eur = (v: any) => v == null ? '' : Number(v).toFixed(2).replace('.', ',') + '€';
  const filasTodas: any[] = calc.secciones.reduce((a: any[], s: any) => a.concat(s.filas), []);
  const hay = (k: string) => filasTodas.some((f: any) => String(f[k] ?? '').trim() !== '');
  const cols = [
    { k: 'producto', t: 'Producto', w: 0.25, a: 'start', on: hay('producto') },
    { k: 'medidas', t: 'Medidas', w: 0.17, a: 'start', on: hay('medidas') },
    { k: 'cn', t: 'C.N.', w: 0.12, a: 'start', on: hay('cn') },
    { k: 'uds', t: 'Uds.', w: 0.07, a: 'middle', on: !calc.sin_uds },
    { k: 'pvl', t: 'P.V.L.', w: 0.11, a: 'end', on: true },
    { k: 'dto', t: 'Dto.', w: 0.08, a: 'middle', on: filasTodas.some((f: any) => f.dto > 0) },
    { k: 'neto', t: 'Neto', w: 0.10, a: 'end', on: filasTodas.some((f: any) => f.dto > 0) },
    { k: 'imp', t: 'Importe', w: 0.10, a: 'end', on: !calc.sin_uds },
  ].filter(c => c.on);
  const sw = cols.reduce((a, c) => a + c.w, 0) || 1; cols.forEach(c => { c.w = c.w / sw; });
  const xs: number[] = []; let acc = M;
  for (const c of cols) { xs.push(acc); acc += c.w * cw; }
  const cellX = (i: number, a: string) => a === 'start' ? xs[i] + 8 : a === 'end' ? xs[i] + cols[i].w * cw - 8 : xs[i] + cols[i].w * cw / 2;
  const t2 = (x: number, yy: number, s: string, o: any = {}) =>
    `<text x="${x}" y="${yy}" font-family="${FUENTE}" font-weight="${o.b ? 700 : 400}" font-size="${o.sz || fs}" fill="${o.c || PLOMO}" text-anchor="${o.a || 'start'}">${esc(s)}</text>`;
  let y = M, els = '';
  for (const s of calc.secciones) {
    const secH = Math.round(fs * 2.3), headH = Math.round(fs * 1.9);
    els += `<rect x="${M}" y="${y}" width="${cw}" height="${secH}" rx="6" fill="${BRAND}"/>`;
    els += t2(M + 12, y + secH / 2 + fs * 0.35, s.titulo, { b: true, c: '#fff', sz: Math.round(fs * 1.05) });
    y += secH + 3;
    els += `<rect x="${M}" y="${y}" width="${cw}" height="${headH}" fill="${HEAD_BG}"/>`;
    cols.forEach((c, i) => { els += t2(cellX(i, c.a), y + headH / 2 + fs * 0.32, c.t, { b: true, c: BRAND2, a: c.a, sz: Math.round(fs * 0.9) }); });
    y += headH;
    s.filas.forEach((f: any, idx: number) => {
      if (idx % 2 === 1) els += `<rect x="${M}" y="${y}" width="${cw}" height="${rowH}" fill="${ZEBRA}"/>`;
      const vals: any = { producto: f.producto, medidas: f.medidas, cn: f.cn, uds: f.uds || '',
        pvl: eur(f.pvl), dto: f.dto > 0 ? '-' + Math.round(f.dto * 100) + '%' : '', neto: eur(f.pvl_neto), imp: f.importe == null ? '' : eur(f.importe) };
      cols.forEach((c, i) => {
        els += t2(cellX(i, c.a), y + rowH / 2 + fs * 0.34, String(vals[c.k]), { a: c.a, b: c.k === 'imp', c: c.k === 'imp' ? BRAND2 : c.k === 'dto' ? '#b45309' : PLOMO });
      });
      els += `<line x1="${M}" y1="${y + rowH}" x2="${M + cw}" y2="${y + rowH}" stroke="${LINEA}" stroke-width="1"/>`;
      y += rowH;
    });
    if (s.subtotal != null) { els += t2(M + cw - 8, y + rowH * 0.72, 'Subtotal  ' + eur(s.subtotal), { a: 'end', b: true }); y += Math.round(rowH * 1.05); }
    y += Math.round(fs * 0.6);
  }
  if (calc.total != null) {
    const totH = Math.round(fs * 2.4);
    els += `<rect x="${M}" y="${y}" width="${cw}" height="${totH}" rx="6" fill="${BRAND2}"/>`;
    els += t2(M + 14, y + totH / 2 + fs * 0.35, 'TOTAL', { b: true, c: '#fff', sz: Math.round(fs * 1.1) });
    els += t2(M + cw - 12, y + totH / 2 + fs * 0.35, eur(calc.total), { a: 'end', b: true, c: '#fff', sz: Math.round(fs * 1.2) });
    y += totH + M;
  } else y += M;
  const H = Math.ceil(y);
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ffffff"/>${els}</svg>`;
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), width: W, height: H };
}
