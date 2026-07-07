// ============================================================================
// IA-TAGS - Genera tags de busqueda automaticos analizando la lamina.
// Usa OpenAI gpt-4o-mini Vision (detail=low): coste tipico ~$0.0001 por lamina.
// Nunca lanza: si no hay OPENAI_API_KEY o falla la llamada, devuelve null y el
// llamador guarda tags vacio. Nada en el flujo de subida se bloquea si esto
// falla.
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

const PROMPT = `Eres experto en catalogos de parafarmacia y distribucion sanitaria.
Analiza esta lamina de catalogo comercial y devuelve palabras clave utiles para busqueda interna.

Devuelve entre 5 y 12 palabras clave separadas por comas, SIN explicaciones, SIN numeracion, SIN comillas.
Prioriza en este orden:
1. Marcas o laboratorios que veas en la lamina
2. Categorias de producto (crema, gafas, vitaminas, cepillos, mascarillas, gel, esmalte...)
3. Formatos u ofertas visibles (12+1, oferta, promo verano, expositor, kit, pack...)
4. Publico o momento (infantil, adulto, verano, escolar...)
5. Uso o zona corporal si es evidente (facial, corporal, capilar, pies...)

Ejemplo de salida correcta:
Beter, uñas, limas, corindon, manicura, oferta 12+1, promo verano, herramientas

Solo palabras clave separadas por comas. Nada mas.`;

/**
 * Genera tags para una lamina llamando a OpenAI Vision.
 * @param imagenPathAbs ruta absoluta del archivo local
 * @param titulo titulo de la lamina (opcional pero recomendado)
 * @returns string de tags separados por comas o null si no se pudo
 */
export async function generarTagsIA(
  imagenPathAbs: string,
  titulo: string | null
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  if (!fs.existsSync(imagenPathAbs)) return null;

  try {
    // Leer imagen y convertir a data URI base64
    const buf = fs.readFileSync(imagenPathAbs);
    const ext = path.extname(imagenPathAbs).toLowerCase().replace('.', '') || 'png';
    // Solo formatos que OpenAI Vision entiende
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
               : ext === 'webp' ? 'image/webp'
               : ext === 'gif' ? 'image/gif'
               : 'image/png';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

    const userContent: any[] = [];
    if (titulo && titulo.trim()) {
      userContent.push({
        type: 'text',
        text: `Titulo interno de la lamina: "${titulo.trim()}"`
      });
    }
    userContent.push({
      type: 'image_url',
      image_url: { url: dataUrl, detail: 'low' } // detail=low: mucho mas barato, suficiente para tags
    });

    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 120,
      temperature: 0.2,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: userContent }
      ]
    });

    let texto = resp.choices?.[0]?.message?.content?.trim() || '';
    // Limpieza: quitar comillas, saltos de linea, numeraciones "1)", "1.", "-", etc.
    texto = texto.replace(/["`]/g, '');
    texto = texto.split('\n').map(l => l.replace(/^\s*[\-\*\d]+[\).\s]*/, '').trim()).join(', ');
    // Deduplicar y limpiar
    const items = texto.split(',').map(t => t.trim().toLowerCase())
      .filter(t => t.length > 0 && t.length < 40)
      .filter((t, i, arr) => arr.indexOf(t) === i)
      .slice(0, 12);
    if (items.length === 0) return null;
    return items.join(', ');
  } catch (e: any) {
    console.warn('[ai-tags] fallo generando tags:', e?.message || e);
    return null;
  }
}

/**
 * Convierte ruta web /uploads/xxx a ruta absoluta en disco.
 * Devuelve null si el path no es reconocible.
 */
export function resolverRutaImagen(imagenPathWeb: string | null | undefined, uploadsDir: string): string | null {
  if (!imagenPathWeb) return null;
  let rel = String(imagenPathWeb);
  if (rel.startsWith('/uploads/')) rel = rel.substring('/uploads/'.length);
  else if (rel.startsWith('uploads/')) rel = rel.substring('uploads/'.length);
  const abs = path.join(uploadsDir, rel);
  if (!abs.startsWith(uploadsDir)) return null; // path traversal check
  return abs;
}
