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
