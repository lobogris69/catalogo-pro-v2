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
// Un bloque = la tabla de UNA hoja del Excel. Un libro con varias hojas
// ("Emuliquen" y "Lactulosa", "Tabla 1" y "Tabla 2") produce varios bloques,
// que se dibujan uno debajo de otro — antes solo se quedaba una hoja.
export interface BloqueTabla { titulo: string; cabeceras: string[]; filas: FilaFiel[]; numericas: boolean[]; }
export interface DatosTabla {
  titulo?: string;
  bloques?: BloqueTabla[];   // formato actual: una tabla por hoja del Excel
  // --- formato de una sola hoja (tablas guardadas con v110) ---
  cabeceras?: string[];
  filas?: FilaFiel[];
  numericas?: boolean[];     // que columnas son numericas (se centran)
  // --- formato antiguo calculado, solo para tablas aun mas viejas ---
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
  // Pueden ser VARIAS lineas de titulo (caso Carmex: nombre del expositor y
  // debajo la campana). Se recogen todas las de una sola celda de texto, de
  // arriba a abajo, y se paran al topar con una fila de datos o un hueco doble.
  const titulos: string[] = [];
  let huecos = 0;
  for (let r = rCab - 1; r >= 0 && r >= rCab - 6; r--) {
    const f = (rows[r] || []).map(txt);
    const conTexto = f.filter(Boolean).length;
    if (!conTexto) { if (++huecos >= 2) break; continue; }
    huecos = 0;
    const idx = f.findIndex(Boolean);
    if (conTexto === 1 && !numericas[idx - c0]) titulos.unshift(f[idx]);
    else break;
  }
  if (titulos.length) {
    for (const t of titulos) {
      const celdas = new Array(nCols).fill('');
      celdas[0] = t;
      filas.push({ tipo: 'seccion', celdas });
    }
    // ...y justo debajo iba la fila de cabeceras: se conserva ese orden.
    filas.push({ tipo: 'cabecera', celdas: new Array(nCols).fill('') });
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

  // La cabecera puede ocupar VARIAS filas ("Precio" / "Final"): se unen, pero
  // SOLO sobre columnas que ya tienen cabecera principal. Si la celda cae en una
  // columna sin cabecera es una NOTA AL MARGEN del usuario ("Descuento %  15"):
  // fusionarla convertia su columna de trabajo en una columna "inventada".
  const cabeceras: string[] = [];
  for (let c = c0; c <= c1; c++) cabeceras.push(cabRow[c] || '');
  for (let k = 0; k < iDatos; k++) {
    bruto[k].forEach((v, i) => { if (v && cabeceras[i]) cabeceras[i] += ' ' + v; });
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
    else if (conTexto === 1) {
      // Celda unica: es un subtotal si su columna es numerica O si su contenido
      // parece un importe ("317,16 €"); si no, es un titulo de apartado.
      const pareceImporte = /^-?[\d.,]+\s*(€|%)?$/.test(primero);
      tipo = (numericas[idxUnico] || pareceImporte) ? 'total' : 'seccion';
    }
    else if (conTexto < umbral && celdas.some((v, i) => v && numericas[i])) tipo = 'total';
    else tipo = 'datos';
    filas.push({ tipo, celdas });
  }
  if (!filas.length) return null;

  // La tabla ACABA en su fila "TOTAL": lo que el usuario apunta debajo (otro
  // precio de trabajo, notas) no forma parte de ella. Solo se respeta contenido
  // posterior si mas abajo empieza otra tabla (fila de cabeceras repetida).
  const iTotal = filas.findIndex(f => f.tipo === 'total' && /^total/i.test(f.celdas.find(Boolean) || ''));
  if (iTotal >= 0 && !filas.slice(iTotal + 1).some(f => f.tipo === 'cabecera')) {
    filas.length = iTotal + 1;
  }

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

// Lee el .xlsx entero: TODAS las hojas con tabla entran, cada una como un
// bloque (antes se quedaba solo la hoja con mas filas y se perdian las demas).
export function parseExcelTabla(buffer: Buffer): DatosTabla {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const bloques: BloqueTabla[] = [];
  for (const nombre of wb.SheetNames) {
    const ws = wb.Sheets[nombre];
    if (!ws) continue;
    const e = extraerHoja(ws);
    if (e) bloques.push({ titulo: nombre, cabeceras: e.cabeceras, filas: e.filas, numericas: e.numericas });
  }
  return { bloques };
}

// Normaliza cualquier formato guardado a la lista de bloques que dibuja render.
function bloquesDe(datos: DatosTabla): BloqueTabla[] {
  if (datos.bloques && datos.bloques.length) return datos.bloques;
  if (datos.cabeceras && datos.cabeceras.length) {
    return [{ titulo: '', cabeceras: datos.cabeceras, filas: datos.filas || [], numericas: datos.numericas || [] }];
  }
  return [];
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
  const bloques = datos ? bloquesDe(datos) : [];
  if (bloques.length) {
    const todas = bloques.reduce((a: FilaFiel[], b) => a.concat(b.filas), []);
    return {
      titulo: datos.titulo,
      fiel: true,
      bloques,
      n_filas: todas.filter(f => f.tipo === 'datos').length,
      n_secciones: todas.filter(f => f.tipo === 'seccion').length + (bloques.length > 1 ? bloques.length : 0),
      n_columnas: Math.max(...bloques.map(b => b.cabeceras.length)),
      n_hojas: bloques.length,
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

// DOS EJES INDEPENDIENTES, como espera el usuario al colocar la tabla:
//   - el ANCHO del hueco reparte las COLUMNAS (estirar de lado no toca la letra),
//   - el ALTO del hueco decide el TAMANO DE LETRA (estirar hacia abajo agranda).
// opts.alto = alto del hueco en px; opts.fs fuerza un tamano concreto de letra.
export async function renderTablaExpositor(datos: DatosTabla, opts?: { width?: number; alto?: number; fondo?: string; fs?: number }): Promise<{ buffer: Buffer; width: number; height: number }> {
  const calc: any = computarTabla(datos);
  if (!calc.fiel) return renderLegado(calc, opts);   // tablas guardadas antes del cambio

  const W = Math.max(200, Math.min(1600, opts?.width || 1040));   // se respeta el ancho pedido (el hueco): forzar un minimo de 700 hacia dibujar la tabla MAS ancha que el hueco
  const M = 24;
  const cw = W - M * 2;
  const bloques: BloqueTabla[] = calc.bloques || [];
  if (!bloques.length) {
    const vacio = await sharp({ create: { width: W, height: 60, channels: 3, background: '#fff' } }).png().toBuffer();
    return { buffer: vacio, width: W, height: 60 };
  }

  let y = M, els = '';
  // Letra a partir del ALTO del hueco: se estima cuánto ocupa cada fila en
  // función de la letra (cabecera ~1,76·fs, fila ~1,52·fs, banda de apartado
  // ~2,0·fs) y se despeja la letra que hace que la tabla mida ese alto.
  let fsPorAlto = 0;
  if (opts?.alto && opts.alto > 20) {
    let k = 0;
    for (const b of bloques) {
      if (!b.cabeceras.length || !b.filas.length) continue;
      k += 1.76;                                   // cabecera de arriba
      for (const f of b.filas) k += f.tipo === 'seccion' ? 2.1 : (f.tipo === 'cabecera' ? 1.76 : 1.52);
      k += 1.1;                                    // aire entre bloques
    }
    if (k > 0) fsPorAlto = (opts.alto - 2 * M) / k;
  }
  const fsBase = Math.max(5, Math.round(opts?.fs || fsPorAlto || W * 0.0145));
  if (calc.titulo) {
    els += `<text x="${M}" y="${y + fsBase}" font-family="${FUENTE}" font-weight="700" font-size="${Math.round(fsBase * 1.4)}" fill="${BRAND2}">${esc(calc.titulo)}</text>`;
    y += Math.round(fsBase * 2.2);
  }
  // El nombre de la hoja (lo puso el usuario en su Excel) encabeza cada bloque,
  // pero solo si hay varias hojas y el nombre no es el generico de Excel.
  const nombreUtil = (t: string) => t && !/^(hoja|sheet)\s*\d*$/i.test(t.trim());

  // --- PASO 1: calcular la disposicion de cada bloque -----------------------
  // Regla de tamano: la tabla ocupa lo que OCUPA SU CONTENIDO. Una tabla pequena
  // NO se estira al ancho pedido (dejaba huecos enormes entre columnas y ocupaba
  // media lamina); una grande encoge la letra hasta caber. Compacto: la letra
  // marca el alto de fila, sin aire de sobra, pero sin montar una fila en otra.
  interface Layout { b: BloqueTabla; fs: number; pad: number; lineH: number; anchos: number[]; tw: number; centrar: boolean[]; }
  const layouts: Layout[] = [];
  for (const b of bloques) {
    const { cabeceras, filas, numericas } = b;
    if (!cabeceras.length || !filas.length) continue;
    // Centrado: numeros y tambien columnas de fichas cortas sin espacios
    // ("5+5", "10+2", tallas) — lo que NO se centra es el texto largo
    // (articulo, descripcion), que va a la izquierda.
    const centrar = cabeceras.map((_, i) => {
      if (numericas[i]) return true;
      const vals = filas.filter(f => f.tipo === 'datos').map(f => f.celdas[i]).filter(Boolean);
      return vals.length > 0 && vals.every(v => v.length <= 10 && !v.includes(' '));
    });
    const medir = (tam: number) => cabeceras.map((h, i) => {
      let mx = anchoTexto(h, tam * 0.92);
      // Cuentan tambien subtotales y TOTAL (si no, salia "TOTA…").
      for (const f of filas) if (f.tipo !== 'seccion' && f.tipo !== 'cabecera') mx = Math.max(mx, anchoTexto(f.celdas[i] || '', tam));
      return mx + tam * 1.3;
    });
    // LA LETRA NO CRECE CON EL ANCHO. La tabla llena el hueco SEPARANDO las
    // columnas, no agrandando la letra: por eso estirar de lado ensancha las
    // columnas y NO cambia el alto (antes todo crecía junto, en diagonal).
    // La letra solo se ENCOGE si el contenido no cabe de ninguna manera.
    let fs = fsBase;
    let naturales = medir(fs);
    let suma = naturales.reduce((a, x) => a + x, 0) || 1;
    if (suma > cw) {
      fs = Math.max(6, fs * (cw / suma));
      naturales = medir(fs);
      suma = naturales.reduce((a, x) => a + x, 0) || 1;
    }
    // El ancho sobrante se reparte entre las columnas (proporcional a lo que
    // ocupa cada una), de modo que la tabla mide justo el ancho del hueco.
    const anchos = naturales.map(x => (x / suma) * cw);
    layouts.push({ b, fs, pad: Math.round(fs * 0.6), lineH: Math.round(fs * 1.22), anchos, tw: Math.round(cw), centrar });
  }
  if (!layouts.length) {
    const vacio = await sharp({ create: { width: 300, height: 60, channels: 3, background: '#fff' } }).png().toBuffer();
    return { buffer: vacio, width: 300, height: 60 };
  }
  // La imagen final mide lo que su tabla mas ancha, no el ancho pedido.
  const Wout = Math.min(W, Math.max(...layouts.map(l => l.tw)) + M * 2);

  // --- PASO 2: dibujar ------------------------------------------------------
  for (let nb = 0; nb < layouts.length; nb++) {
    const { b, fs, pad, lineH, anchos, tw, centrar } = layouts[nb];
    const { cabeceras, filas, numericas } = b;
    const xs: number[] = []; let acc = M;
    for (const a of anchos) { xs.push(acc); acc += a; }

    const texto = (x: number, yy: number, s: string, o: { a?: string; b?: boolean; c?: string; sz?: number } = {}) =>
      `<text x="${x}" y="${yy}" font-family="${FUENTE}" font-weight="${o.b ? 700 : 400}" font-size="${o.sz || fs}" fill="${o.c || PLOMO}" text-anchor="${o.a || 'start'}">${esc(s)}</text>`;
    const posX = (i: number, c: boolean) => c ? xs[i] + anchos[i] / 2 : xs[i] + pad;
    const ancla = (c: boolean) => c ? 'middle' : 'start';

    if (layouts.length > 1 && nombreUtil(b.titulo)) {
      const h = Math.round(fs * 2.0);
      els += `<rect x="${M}" y="${y + 3}" width="${tw}" height="${h - 3}" rx="5" fill="${BRAND}"/>`;
      els += texto(M + pad, y + 3 + (h - 3) / 2 + fs * 0.35, b.titulo, { b: true, c: '#fff', sz: Math.round(fs * 1.03) });
      y += h + 2;
    }

    // Cabecera del Excel. Se dibuja arriba y, si el usuario la repite en cada
    // apartado, se vuelve a dibujar en ese sitio (fila de tipo 'cabecera').
    const lineasCab = cabeceras.map((h, i) => partirTexto(h, fs * 0.92, anchos[i] - pad * 2, 2));
    const hCab = Math.max(...lineasCab.map(l => l.length)) * lineH + Math.round(pad * 0.9);
    const pintarCabecera = () => {
      els += `<rect x="${M}" y="${y}" width="${tw}" height="${hCab}" fill="${HEAD_BG}"/>`;
      lineasCab.forEach((ls, i) => {
        ls.forEach((l, k) => {
          els += texto(posX(i, centrar[i]), y + pad * 0.6 + (k + 1) * lineH - lineH * 0.25, l,
            { b: true, c: BRAND2, a: ancla(centrar[i]), sz: Math.round(fs * 0.92) });
        });
      });
      y += hCab;
    };
    // Si el Excel ya repite la cabecera en cada apartado y empieza por el titulo
    // de uno, se respeta ese orden (titulo -> cabecera) y no se duplica.
    const repiteCabecera = filas.some(f => f.tipo === 'cabecera');
    if (!(repiteCabecera && filas[0] && filas[0].tipo === 'seccion')) pintarCabecera();

    // Filas, respetando el tipo que traia el Excel
    let z = 0;
    filas.forEach(f => {
      if (f.tipo === 'cabecera') { pintarCabecera(); z = 0; return; }
      if (f.tipo === 'seccion') {
        const t = f.celdas.find(Boolean) || '';
        const h = Math.round(fs * 2.0);
        els += `<rect x="${M}" y="${y + 2}" width="${tw}" height="${h - 2}" rx="5" fill="${BRAND}"/>`;
        els += texto(M + pad, y + 2 + (h - 2) / 2 + fs * 0.35, t, { b: true, c: '#fff', sz: Math.round(fs * 1.03) });
        y += h + 1; z = 0;
        return;
      }
      const lineas = f.celdas.map((c, i) => partirTexto(c || '', fs, anchos[i] - pad * 2, numericas[i] ? 1 : 2));
      const h = Math.max(...lineas.map(l => l.length)) * lineH + Math.round(pad * 0.5);
      const esTotal = f.tipo === 'total';
      if (esTotal) els += `<rect x="${M}" y="${y}" width="${tw}" height="${h}" fill="#f7edf3"/>`;
      else if (z % 2 === 1) els += `<rect x="${M}" y="${y}" width="${tw}" height="${h}" fill="${ZEBRA}"/>`;
      lineas.forEach((ls, i) => {
        ls.forEach((l, k) => {
          els += texto(posX(i, centrar[i]), y + pad * 0.25 + (k + 1) * lineH - lineH * 0.22, l,
            { a: ancla(centrar[i]), b: esTotal, c: esTotal ? BRAND2 : PLOMO });
        });
      });
      els += `<line x1="${M}" y1="${y + h}" x2="${M + tw}" y2="${y + h}" stroke="${esTotal ? BRAND : LINEA}" stroke-width="${esTotal ? 1.5 : 1}"/>`;
      y += h; z++;
    });
    if (nb < layouts.length - 1) y += Math.round(fsBase * 1.1);   // aire entre hojas
  }
  y += M;

  const H = Math.ceil(y);
  // FONDO. Sin `fondo` sale TRANSPARENTE (vista previa: no se pinta un blanco de
  // sobra). Al pegarla en la lamina se pasa el color de fondo muestreado de la
  // propia lamina: asi tapa la tabla vieja del todo (transparente dejaba verla
  // entre fila y fila) y a la vez se funde con la lamina en vez de un bloque
  // blanco. El fondo ocupa solo lo que ocupa la tabla.
  const fondo = opts?.fondo ? `<rect width="100%" height="100%" fill="${opts.fondo}"/>` : '';
  const svg = `<svg width="${Wout}" height="${H}" xmlns="http://www.w3.org/2000/svg">${fondo}${els}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: Wout, height: H };
}

// Dibujo de las tablas guardadas con el formato antiguo (secciones/filas
// calculadas). Se mantiene para no romper las laminas ya montadas; al volver a
// subir el Excel, la tabla pasa al formato fiel.
async function renderLegado(calc: any, opts?: { width?: number }): Promise<{ buffer: Buffer; width: number; height: number }> {
  const W = Math.max(200, Math.min(1600, opts?.width || 1040));   // se respeta el ancho pedido (el hueco): forzar un minimo de 700 hacia dibujar la tabla MAS ancha que el hueco
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
