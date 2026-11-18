/**
 * Nombres de artículo para la web pública de Lomhifar (18-nov-2026).
 * Sage guarda los nombres en mayúsculas y con códigos internos (CN, REF, códigos de expositor…).
 * Aquí se limpian para enseñarlos a la farmacia; lo que no es producto (expositores, promos, regalos) se descarta.
 */

/** Artículos que no son producto para la farmacia: material de punto de venta, promociones, regalos. */
const NO_PRODUCTO = /\b(EXPOSITOR\w*|METACRILATO|DISPLAY|PROMO\w*|REGALO\w*|BOMBONERA|MUESTRA\w*|TESTER|CARTEL\w*|FOLLETO\w*|PLV|PORTES|FLETES|ABONO|DESCUENTO|BOLSA\w* PAPEL|TARIFA|PERSONALIZACION\w*|PORTA TARJETAS|LOTE|CAMPA[ÑN]A|BOLSA PLASTICO|^BAJ)\b/i;

const MINUSCULAS = new Set(['de', 'del', 'con', 'para', 'y', 'sin', 'a', 'al', 'el', 'la', 'las', 'los', 'en', 'o', 'por', 'e', 'x']);

const UNIDADES: [RegExp, string][] = [
  [/(\d)\s*(ML|MLS)\b\.?/gi, '$1 ml'],
  [/(\d)\s*(GR|GRS|G)\b\.?/gi, '$1 g'],
  [/(\d)\s*(KG)\b\.?/gi, '$1 kg'],
  [/(\d)\s*(CM)\b\.?/gi, '$1 cm'],
  [/(\d)\s*(MM)\b\.?/gi, '$1 mm'],
  [/(\d)\s*(L|LT|LTS)\b\.?/gi, '$1 l'],
  [/\bUNID(ADES)?\b\.?|\bUDS?\b\.?|\bU\.(?=\s|$)/gi, 'unidades'],
  [/\bS\/A\b/gi, 'sin azúcar'],
  [/\bC\/(?=\w)/gi, 'con '],
  [/\bS\/(?=\w)/gi, 'sin '],
  [/\bT\/(?=\w)/gi, 'talla '],
];

function palabra(w: string, i: number): string {
  if (!w) return w;
  if (/^\d/.test(w)) return w.replace(/\./g, ',').replace(/,$/, ''); // 4.25 → 4,25
  if (/^(ml|g|kg|cm|mm|l|unidades|sin|con|azúcar|talla)$/.test(w)) return w;
  if (/\d/.test(w) || /&/.test(w) || /^[A-Z]{1,3}$/.test(w) && !MINUSCULAS.has(w.toLowerCase()) && w.length <= 3 && /^(SPF|FFP|UV|XL|XXL|XS|S|M|L|N|B|II|III|IV|VI|PH|BIO|VCS|SCR|VP|FD|OTC)$/.test(w))
    return w.toUpperCase();
  const m = w.toLowerCase();
  if (i > 0 && MINUSCULAS.has(m)) return m;
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** Devuelve el nombre limpio, o null si el artículo no se enseña (no es producto). */
export function nombreWeb(bruto: string): string | null {
  let s = String(bruto || '').trim();
  if (!s || NO_PRODUCTO.test(s)) return null;
  // Perfumes de equivalencia: el número y la fragancia de otra marca NO se publican (Nº 4 - 212 CH MUJER → nada).
  s = s.replace(/\s*N[º°]\.?\s*\d*\s*(-.*)?$/i, ' ').replace(/\bN[º°]\s*\d+/gi, ' ');
  s = s
    .replace(/\bEXP\.\s*/gi, ' ')                                     // expositor del producto: se enseña el producto
    .replace(/\(\s*\d+\s*\+\s*\d+\s*\)/g, ' ')                       // (11+1)
    .replace(/\s[+-]\d[.,]\d{1,2}\b/g, ' ')                           // graduación de gafas +2.50
    .replace(/\b(T\.|TALLA\b|T\/)\s*[\w.]+(-\d+)?/gi, ' ')           // tallas
    .replace(/\bM-\d*(?=\s|$)/g, ' ')                                // modelos internos M-346
    .replace(/-(?=SPF|SFP)/gi, ' ').replace(/\bSFP/gi, 'SPF')
    .replace(/\bC\.?\s?N\.?\s*[:.]?\s*[A-Z]?\d[\d.]*/gi, ' ')       // CN.218616, C.N: 189876.0, CN.I00360
    .replace(/\bRE?F\.?\s*:?\s*[\w.\-]*\d[\w.\-]*/gi, ' ')           // REF. 7400, RF: 255501
    .replace(/\(\s*[\d.,]+\s*\)/g, ' ')                              // (135)
    .replace(/\s+R\.?\s?\d+\b/g, ' ')                                // numeración de equivalencia R52 / R.40
    .replace(/\(\s*[.\d]*\s*N?U\)/gi, ' ')                           // ( .2NU)
    .replace(/\s(CN|Ñ)\s*$/i, ' ')
    .replace(/\b\d{4,}(\.\d+)?\b(?!\s*(ML|G|GR|MG|MM|CM)\b)/gi, ' ')  // códigos sueltos 7802.05
    .replace(/[*"“”´`]/g, ' ')
    .replace(/(^|\s)-(?=\s)/g, ' ')
    .replace(/^([A-ZÑ]+)-(?=[A-ZÑ])/, '$1 ')                         // SAWES-ACILAC
    .replace(/\s+-\s*/g, ' ');
  for (const [re, por] of UNIDADES) s = s.replace(re, por);
  s = s.replace(/[\s.,:;-]+$/, '').replace(/-(?=\s)/g, '').replace(/\s{2,}/g, ' ').trim();
  if (s.length < 3) return null;
  return s.split(' ').map(palabra).join(' ').replace(/ ,/g, ',');
}
