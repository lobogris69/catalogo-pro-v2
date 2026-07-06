// ============================================================================
// MEGA - Sistema de respaldo. Sube laminas de un catalogo a MEGA (cuenta
// comercial@lomhifar.com) en carpetas por comercial o en /General/ si el
// catalogo esta asignado a TODOS los comerciales activos.
//
// Credenciales via env vars MEGA_EMAIL / MEGA_PASSWORD (configuradas en Railway).
// Requiere la libreria "megajs" (pure JS, sin binarios).
// ============================================================================
import { Storage } from 'megajs';

// Carpeta raiz dentro de MEGA
export const ROOT_FOLDER = 'CatalogPRO backup';
export const COMERCIALES_FOLDER = 'Comerciales';
export const GENERAL_FOLDER = 'General';

// Cache global de storage abierto (evita re-login en cada operacion).
// MEGA login es lento (varios segundos), asi que compartimos la sesion.
let _storage: any = null;
let _lastLoginAt = 0;
const LOGIN_TTL_MS = 60 * 60 * 1000; // re-login cada 1h

/**
 * Devuelve la instancia de Storage MEGA autenticada (login lazy + cache).
 * Si el login TTL expiro o nunca se hizo, reintenta.
 */
export async function getMegaStorage(): Promise<any> {
  // trim por si al copiar la contrasena en Railway se colaron espacios/newlines
  const email = (process.env.MEGA_EMAIL || '').trim();
  const password = (process.env.MEGA_PASSWORD || '').trim();
  if (!email || !password) {
    throw new Error('MEGA_EMAIL/MEGA_PASSWORD no configuradas en env vars');
  }

  const now = Date.now();
  if (_storage && (now - _lastLoginAt) < LOGIN_TTL_MS) {
    return _storage;
  }

  const storage = new Storage({ email, password, userAgent: 'CatalogPRO/2.0' });
  await storage.ready;
  _storage = storage;
  _lastLoginAt = now;
  return storage;
}

/**
 * Diagnostico de credenciales - devuelve info NO SENSIBLE para verificar
 * que las env vars llegan tal cual el usuario espera.
 */
export function debugCredenciales(): {
  email: string;
  email_len: number;
  password_len: number;
  password_first2: string;
  password_last2: string;
  password_tiene_espacios_raros: boolean;
} {
  const emailRaw = process.env.MEGA_EMAIL || '';
  const passRaw = process.env.MEGA_PASSWORD || '';
  const passwordTrim = passRaw.trim();
  return {
    email: emailRaw.trim(),
    email_len: emailRaw.length,
    password_len: passRaw.length,
    password_first2: passwordTrim.substring(0, 2),
    password_last2: passwordTrim.substring(Math.max(0, passwordTrim.length - 2)),
    password_tiene_espacios_raros: passRaw !== passwordTrim || /\s/.test(passwordTrim)
  };
}

/**
 * Encuentra o crea (idempotente) una subcarpeta con el nombre dado bajo un padre.
 * @param parent nodo padre (root u otra carpeta MEGA)
 * @param name nombre exacto de la carpeta a asegurar
 * @returns nodo de la carpeta (creada o existente)
 */
export async function ensureFolder(parent: any, name: string): Promise<any> {
  // Buscar por nombre exacto entre los hijos que son directorio
  const hijos = parent.children || [];
  const existente = hijos.find((c: any) => c.directory && c.name === name);
  if (existente) return existente;

  // No existe -> crear
  const nueva = await parent.mkdir({ name });
  return nueva;
}

/**
 * Sube un archivo (Buffer) a MEGA con un nombre concreto dentro de una carpeta.
 * Si ya existe un archivo con ese nombre en esa carpeta, se sobreescribe
 * (borrando el anterior primero) para mantener idempotencia.
 */
export async function uploadFileBuffer(
  folder: any,
  name: string,
  buffer: Buffer
): Promise<any> {
  // Borrar el existente si lo hubiera (para regenerar backup limpio)
  const hijos = folder.children || [];
  const previo = hijos.find((c: any) => !c.directory && c.name === name);
  if (previo) {
    try { await previo.delete(true); } catch (_) {}
  }
  const file = await folder.upload({ name, size: buffer.length }, buffer).complete;
  return file;
}

/**
 * Genera un link publico (share link) para una carpeta MEGA.
 * MEGA a veces tira EAGAIN en share operations - reintentamos con backoff.
 */
export async function shareFolderLink(folder: any): Promise<string> {
  const delays = [0, 5000, 15000, 30000]; // total ~50s de reintentos
  let ultimoError: Error | null = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const link = await folder.link({ noKey: false });
      if (link) return link;
    } catch (e: any) {
      ultimoError = e;
      // Si es EAGAIN u otro error transitorio, seguimos reintentando
      const msg = String(e?.message || '');
      if (!/EAGAIN|temporary|congestion|-3|-2|timeout/i.test(msg)) {
        // Error no transitorio -> abortar
        throw e;
      }
    }
  }
  throw ultimoError || new Error('shareFolderLink agoto reintentos');
}

/**
 * Sanitiza un nombre para ser un nombre de archivo/carpeta seguro.
 * Elimina caracteres problematicos en MEGA/filesystems.
 */
export function sanitizeName(name: string): string {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ') // caracteres invalidos
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200) || 'sin-nombre';
}

/**
 * Formatea el nombre de la carpeta de un catalogo: "Nombre · Vn · YYYY-MM-DD"
 */
export function nombreCarpetaCatalogo(catalogoNombre: string, version: number): string {
  const hoy = new Date().toISOString().substring(0, 10);
  return `${sanitizeName(catalogoNombre)} · V${version} · ${hoy}`;
}

/**
 * Formatea el nombre de una lamina: "001 - Titulo.png"
 */
export function nombreLaminaOrdenada(orden: number, titulo: string, extension: string): string {
  const num = String(orden).padStart(3, '0');
  const tit = sanitizeName(titulo || 'Lamina ' + orden);
  const ext = extension.startsWith('.') ? extension : '.' + extension;
  return `${num} - ${tit}${ext}`;
}
