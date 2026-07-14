// ============================================================================
// AI-ZONES - Detecta productos en una lamina de catalogo y devuelve bounding
// boxes normalizadas + codigos legibles (Codigo Nacional espanol, codigo del
// fabricante, precios). Usa gpt-4o Vision (no mini) con detail=high para
// tener suficiente precision en las coordenadas del recuadro.
//
// Formato tipico de nuestro catalogo (Beter, Essity, Onevit, Lomhifar):
// - Cada producto en su recuadro claro con foto + texto abajo
// - Codigo Nacional (CN xxx xxx.x) que coincide con codigo_sage en la BD
// - Codigo del fabricante (24.xxx en Beter, etc.)
// - PVL (sin IVA) y PVPR (con IVA)
// - Descripcion bilingue
// ============================================================================
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  if (!_client) _client = new OpenAI({ apiKey });
  return _client;
}

const PROMPT = `Eres experto en catalogos de parafarmacia y distribucion sanitaria en Espana.

Tu tarea: analizar esta imagen de una lamina de catalogo comercial y localizar cada producto individual visible.

Para CADA producto identifica:
1. **Bounding box** que lo contiene ENTERO (imagen + textos + precios asociados). Coordenadas en % del ancho/alto TOTAL de la imagen (0-100).
2. **Codigo Nacional** ("CN xxx xxx.x") si aparece. Devuelve solo los digitos SIN puntos ni espacios (ej. "239939" o "2399396").
3. **Codigo del fabricante** (ej. "24.110" en Beter). Devuelve tal cual, con puntos si los tiene.
4. **Descripcion** del producto (usa la version en espanol si la hay).
5. **Formato** (unidades por caja, ej. "6 u. / B").
6. **PVL** (precio sin IVA), como numero decimal (ej. 5.96).
7. **PVPR** (precio con IVA), como numero decimal (ej. 10.50).
8. **Tamano/medida** si aparece (ej. "9 cm").

REGLAS IMPORTANTES:
- Si algun campo NO es visible, usa null. No inventes.
- Ignora encabezados, logos de seccion (SCISSORS, MANICURA, etc.), decoraciones, numeros de pagina.
- Los iconos con dibujos esquematicos (CURVA/RECTA/ROMA) NO son productos.
- Si la lamina es una portada o separador sin productos individuales, devuelve productos: [].
- Si un producto grande "ambiental" ocupa la mayor parte de la lamina, tambien cuenta como 1 producto.

Devuelve SOLO JSON valido con este formato exacto:
{
  "productos": [
    {
      "x": 6.5, "y": 8.0, "width": 18.0, "height": 25.0,
      "codigo_nacional": "239939",
      "codigo_fabricante": "24.110",
      "descripcion": "Manicura pieles, cromada",
      "formato": "6 u. / B",
      "pvl": 5.96,
      "pvpr": 10.50,
      "tamano": "9 cm"
    }
  ]
}

Sin explicaciones, sin markdown, sin comentarios. Solo el JSON.`;

export interface ZonaDetectada {
  x: number;
  y: number;
  width: number;
  height: number;
  codigo_nacional: string | null;
  codigo_fabricante: string | null;
  descripcion: string | null;
  formato: string | null;
  pvl: number | null;
  pvpr: number | null;
  tamano: string | null;
}

// Variable global que guarda el ultimo error de la IA (para debug en el endpoint)
let _ultimoError: string | null = null;
export function ultimoErrorIA(): string | null { return _ultimoError; }

/**
 * Llama a GPT-4o Vision y extrae los productos de una lamina.
 * Devuelve array vacio si no hay productos, o null si falla la IA.
 */
export async function detectarZonasIA(rutaImagenAbs: string): Promise<ZonaDetectada[] | null> {
  _ultimoError = null;
  const client = getClient();
  if (!client) { _ultimoError = 'OPENAI_API_KEY no configurada'; return null; }
  if (!fs.existsSync(rutaImagenAbs)) { _ultimoError = 'archivo no existe: ' + rutaImagenAbs; return null; }

  try {
    const buf = fs.readFileSync(rutaImagenAbs);
    const ext = path.extname(rutaImagenAbs).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
               : ext === 'webp' ? 'image/webp'
               : ext === 'gif' ? 'image/gif'
               : 'image/png';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

    // Reintento interno: OpenAI puede tirar rate-limit o 500 puntual
    let resp: any = null;
    let ultimoError: any = null;
    for (let intento = 0; intento < 3; intento++) {
      try {
        resp = await client.chat.completions.create({
          model: 'gpt-4o',
          max_tokens: 16000, // subido de 4000 (algunas laminas grandes lo truncaban)
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: dataUrl, detail: 'high' }
                }
              ]
            }
          ]
        });
        break; // exito
      } catch (e: any) {
        ultimoError = e;
        const msg = String(e?.message || e);
        // No reintentar si es error de auth o modelo mal
        if (/invalid api key|401|unauthorized|model_not_found|invalid_request/i.test(msg)) {
          console.warn('[ai-zones] error no reintentable:', msg);
          return null;
        }
        // Esperar antes de reintentar (backoff exponencial)
        const espera = 1500 * Math.pow(2, intento);
        console.warn(`[ai-zones] intento ${intento + 1} fallo (${msg.substring(0, 100)}), reintento en ${espera}ms`);
        await new Promise(r => setTimeout(r, espera));
      }
    }
    if (!resp) {
      _ultimoError = String(ultimoError?.message || ultimoError || 'sin resp');
      console.warn('[ai-zones] agotados 3 reintentos:', _ultimoError);
      return null;
    }

    const texto = resp.choices?.[0]?.message?.content?.trim() || '';
    let parsed: any;
    try {
      parsed = JSON.parse(texto);
    } catch (e) {
      _ultimoError = 'JSON invalido de OpenAI: ' + texto.substring(0, 200);
      console.warn('[ai-zones]', _ultimoError);
      return null;
    }

    const raw = Array.isArray(parsed?.productos) ? parsed.productos : [];
    // Sanear cada zona
    const zonas: ZonaDetectada[] = [];
    for (const p of raw) {
      const x = typeof p?.x === 'number' ? Math.max(0, Math.min(100, p.x)) : NaN;
      const y = typeof p?.y === 'number' ? Math.max(0, Math.min(100, p.y)) : NaN;
      const width = typeof p?.width === 'number' ? Math.max(0, Math.min(100 - (isFinite(x) ? x : 0), p.width)) : NaN;
      const height = typeof p?.height === 'number' ? Math.max(0, Math.min(100 - (isFinite(y) ? y : 0), p.height)) : NaN;
      if (!isFinite(x) || !isFinite(y) || !isFinite(width) || !isFinite(height) || width < 1 || height < 1) continue;

      // Normalizar codigo nacional: quitar CN, puntos, espacios
      let cn: string | null = null;
      if (p?.codigo_nacional) {
        cn = String(p.codigo_nacional).replace(/[^\d]/g, '');
        if (cn.length < 5) cn = null; // demasiado corto para ser CN valido
      }

      zonas.push({
        x, y, width, height,
        codigo_nacional: cn,
        codigo_fabricante: p?.codigo_fabricante ? String(p.codigo_fabricante).trim().substring(0, 30) : null,
        descripcion: p?.descripcion ? String(p.descripcion).trim().substring(0, 250) : null,
        formato: p?.formato ? String(p.formato).trim().substring(0, 50) : null,
        pvl: typeof p?.pvl === 'number' ? p.pvl : null,
        pvpr: typeof p?.pvpr === 'number' ? p.pvpr : null,
        tamano: p?.tamano ? String(p.tamano).trim().substring(0, 30) : null
      });
    }
    return zonas;
  } catch (e: any) {
    _ultimoError = String(e?.message || e);
    console.warn('[ai-zones] error llamando a OpenAI:', _ultimoError);
    return null;
  }
}

// ============================================================================
// F3 PRECIOS DINAMICOS - fidelidad "tapar y reescribir"
// ============================================================================

export interface RecuadroRefinado {
  x: number; y: number; ancho: number; alto: number; // % del ancho/alto de la imagen (caja tapa)
  color_fondo: string;   // rgb(...) muestreado -> el rectangulo tapa queda invisible
  color_texto: string;   // rgb(...) de la tinta del numero
  tam_rel: number;       // font-size como % del ANCHO de la imagen
  alinear: 'left' | 'center' | 'right';
}

/**
 * Dada una caja APROXIMADA (en %) donde hay un precio impreso, muestrea el PNG real
 * y devuelve la caja AJUSTADA + color de fondo + color de tinta + tamano de fuente,
 * para tapar el numero viejo y reescribir el actual de forma indistinguible.
 * Es la generalizacion del prototipo validado sobre la lamina 47.
 */
export async function refinarRecuadroPrecio(
  rutaImagenAbs: string,
  cajaPct: { x: number; y: number; ancho: number; alto: number }
): Promise<RecuadroRefinado | null> {
  try {
    if (!fs.existsSync(rutaImagenAbs)) return null;
    const img = sharp(rutaImagenAbs).ensureAlpha();
    const meta = await img.metadata();
    const W = meta.width || 0, H = meta.height || 0;
    if (!W || !H) return null;

    // Caja aproximada -> px, con un margen para no perder digitos si la IA se queda corta
    const padX = Math.max(6, cajaPct.ancho * W / 100 * 0.35);
    const padY = Math.max(6, cajaPct.alto * H / 100 * 0.45);
    let cx = Math.round(cajaPct.x * W / 100 - padX);
    let cy = Math.round(cajaPct.y * H / 100 - padY);
    let cw = Math.round(cajaPct.ancho * W / 100 + padX * 2);
    let ch = Math.round(cajaPct.alto * H / 100 + padY * 2);
    cx = Math.max(0, cx); cy = Math.max(0, cy);
    cw = Math.min(W - cx, Math.max(4, cw)); ch = Math.min(H - cy, Math.max(4, ch));
    if (cw < 4 || ch < 4) return null;

    const { data, info } = await img.extract({ left: cx, top: cy, width: cw, height: ch })
      .raw().toBuffer({ resolveWithObject: true });
    const C = info.channels;
    const lum = (px: number, py: number) => {
      const i = (py * cw + px) * C;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    };
    // Color de fondo = media de lo claro (lum>225) de TODO el crop
    let br = 0, bg = 0, bb = 0, bn = 0;
    // Cuenta de pixeles oscuros por FILA -> para segmentar en LINEAS de texto y
    // no fundir dos precios contiguos (P.V.L. y P.V.P.R.) en un unico recuadro gigante.
    const rowDark = new Array(ch).fill(0);
    for (let py = 0; py < ch; py++) for (let px = 0; px < cw; px++) {
      const i = (py * cw + px) * C;
      const l = lum(px, py);
      if (l < 110) rowDark[py]++;
      else if (l > 225) { br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++; }
    }
    // Umbral de fila "con tinta": al menos 2px o 2% del ancho del crop
    const rowMin = Math.max(2, Math.floor(cw * 0.02));
    // Bandas = tramos consecutivos de filas con tinta (permitiendo huecos de 1px)
    const bandas: { y0: number; y1: number; peso: number }[] = [];
    let by0 = -1, hueco = 0, peso = 0;
    for (let py = 0; py < ch; py++) {
      if (rowDark[py] >= rowMin) {
        if (by0 < 0) { by0 = py; peso = 0; }
        peso += rowDark[py]; hueco = 0;
      } else if (by0 >= 0) {
        if (++hueco > 1) { bandas.push({ y0: by0, y1: py - hueco, peso }); by0 = -1; }
      }
    }
    if (by0 >= 0) bandas.push({ y0: by0, y1: ch - 1, peso });
    if (!bandas.length) return null;
    // Elegir la banda cuyo centro este mas cerca del centro de la caja que dio la IA;
    // si no hay pista fiable, la de mas tinta.
    const hintCy = (cajaPct.y + cajaPct.alto / 2) * H / 100 - cy;
    let banda = bandas[0];
    if (Number.isFinite(hintCy) && hintCy >= 0 && hintCy <= ch) {
      let bestD = 1e9;
      for (const b of bandas) { const c = (b.y0 + b.y1) / 2; const d = Math.abs(c - hintCy); if (d < bestD) { bestD = d; banda = b; } }
    } else {
      for (const b of bandas) if (b.peso > banda.peso) banda = b;
    }
    // Dentro de la banda elegida: bbox horizontal ajustado + color de tinta
    let minX = 1e9, minY = banda.y0, maxX = 0, maxY = banda.y1, dark = 0;
    let tr = 0, tg = 0, tb = 0, tn = 0;
    for (let py = banda.y0; py <= banda.y1; py++) for (let px = 0; px < cw; px++) {
      const i = (py * cw + px) * C;
      const l = lum(px, py);
      if (l < 110) {
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        dark++;
        if (l < 90) { tr += data[i]; tg += data[i + 1]; tb += data[i + 2]; tn++; }
      }
    }
    if (dark < 4 || minX > maxX) return null; // no encontramos texto: mejor no crear recuadro
    // Ajuste fino: pequeno padding alrededor del texto detectado (2px) sin salir del crop
    const pad2 = 2;
    minX = Math.max(0, minX - pad2); minY = Math.max(0, minY - pad2);
    maxX = Math.min(cw - 1, maxX + pad2); maxY = Math.min(ch - 1, maxY + pad2);
    const tightW = maxX - minX + 1, tightH = maxY - minY + 1;
    // De crop-coords a px absolutos y a %
    const absX = cx + minX, absY = cy + minY;
    const color_texto = tn ? `rgb(${Math.round(tr / tn)},${Math.round(tg / tn)},${Math.round(tb / tn)})` : 'rgb(43,42,41)';
    const color_fondo = bn ? `rgb(${Math.round(br / bn)},${Math.round(bg / bn)},${Math.round(bb / bn)})` : 'rgb(255,255,255)';
    // font-size ~= alto_del_texto * 1.29 (calibrado en el prototipo); en % del ANCHO de imagen
    const fontPx = tightH * 1.29;
    return {
      x: +(absX / W * 100).toFixed(3),
      y: +(absY / H * 100).toFixed(3),
      ancho: +(tightW / W * 100).toFixed(3),
      alto: +(tightH / H * 100).toFixed(3),
      color_fondo, color_texto,
      tam_rel: +(fontPx / W * 100).toFixed(3),
      alinear: 'left',
    };
  } catch (e: any) {
    console.warn('[precio-fidelidad] refinar fallo:', String(e?.message || e));
    return null;
  }
}

const PROMPT_PRECIOS = `Eres experto en catalogos de parafarmacia espanoles.
Analiza esta lamina y, para CADA producto con precio visible, localiza el RECUADRO EXACTO
que envuelve SOLO el NUMERO del precio (los digitos + el simbolo de moneda), NO la etiqueta
("P.V.L.", "PVP", "P.V.P.R.", etc.) ni la descripcion.

Un producto puede tener DOS precios (ej. "P.V.L. 5.96 EUR" y "P.V.P.R. 10.50 EUR"): devuelve
una caja para cada uno.

Para cada precio devuelve:
- codigo_nacional: digitos del CN del producto sin puntos/espacios (para casar con la BD). null si no se ve.
- codigo_fabricante: ej. "24.110". null si no se ve.
- tipo: "pvl" para el precio menor/sin IVA (P.V.L./PVL/PVF), "pvpr" para el mayor/con IVA (P.V.P.R./PVP/PVPR).
- valor: el numero impreso como decimal (ej. 5.96).
- sep_decimal: "." o "," segun lo que use la imagen.
- box: {x,y,width,height} en % del ancho/alto TOTAL de la imagen, envolviendo SOLO el numero+moneda.

Devuelve SOLO JSON valido:
{"precios":[{"codigo_nacional":"239939","codigo_fabricante":"24.110","tipo":"pvl","valor":5.96,"sep_decimal":".","box":{"x":11.5,"y":34.5,"width":6.5,"height":1.6}}]}
Sin markdown ni explicaciones.`;

export interface PrecioDetectado {
  codigo_nacional: string | null;
  codigo_fabricante: string | null;
  tipo: 'pvl' | 'pvpr';
  valor: number | null;
  sep_decimal: string;
  box: { x: number; y: number; width: number; height: number };
}

/** Vision: localiza la caja de cada NUMERO de precio en la lamina. */
export async function detectarPreciosIA(rutaImagenAbs: string): Promise<PrecioDetectado[] | null> {
  _ultimoError = null;
  const client = getClient();
  if (!client) { _ultimoError = 'OPENAI_API_KEY no configurada'; return null; }
  if (!fs.existsSync(rutaImagenAbs)) { _ultimoError = 'archivo no existe'; return null; }
  try {
    const buf = fs.readFileSync(rutaImagenAbs);
    const ext = path.extname(rutaImagenAbs).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    let resp: any = null, ultimoError: any = null;
    for (let intento = 0; intento < 3; intento++) {
      try {
        resp = await client.chat.completions.create({
          model: 'gpt-4o', max_tokens: 16000, temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PROMPT_PRECIOS },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }
          ]
        });
        break;
      } catch (e: any) {
        ultimoError = e;
        const msg = String(e?.message || e);
        if (/invalid api key|401|unauthorized|model_not_found|invalid_request/i.test(msg)) return null;
        await new Promise(r => setTimeout(r, 1500 * Math.pow(2, intento)));
      }
    }
    if (!resp) { _ultimoError = String(ultimoError?.message || 'sin resp'); return null; }
    const texto = resp.choices?.[0]?.message?.content?.trim() || '';
    let parsed: any;
    try { parsed = JSON.parse(texto); } catch { _ultimoError = 'JSON invalido: ' + texto.slice(0, 200); return null; }
    const raw = Array.isArray(parsed?.precios) ? parsed.precios : [];
    const out: PrecioDetectado[] = [];
    for (const p of raw) {
      const b = p?.box || {};
      const x = Math.max(0, Math.min(100, Number(b.x)));
      const y = Math.max(0, Math.min(100, Number(b.y)));
      const width = Math.max(0, Math.min(100 - x, Number(b.width)));
      const height = Math.max(0, Math.min(100 - y, Number(b.height)));
      if (![x, y, width, height].every(Number.isFinite) || width < 0.5 || height < 0.3) continue;
      const tipo = String(p?.tipo || '').toLowerCase() === 'pvpr' ? 'pvpr' : 'pvl';
      let cn: string | null = p?.codigo_nacional ? String(p.codigo_nacional).replace(/\D/g, '') : null;
      if (cn && cn.length < 5) cn = null;
      out.push({
        codigo_nacional: cn,
        codigo_fabricante: p?.codigo_fabricante ? String(p.codigo_fabricante).trim().slice(0, 30) : null,
        tipo, valor: typeof p?.valor === 'number' ? p.valor : null,
        sep_decimal: p?.sep_decimal === ',' ? ',' : (p?.sep_decimal === '.' ? '.' : ','),
        box: { x, y, width, height },
      });
    }
    return out;
  } catch (e: any) {
    _ultimoError = String(e?.message || e);
    return null;
  }
}
