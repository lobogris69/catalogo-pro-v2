/* ============================================================================
 * CatalogPRO v2 — Service Worker
 *
 * Estrategia:
 * 1. App shell (HTML, CSS, JS principal): network-first con fallback a caché.
 *    Así siempre se obtiene la última versión si hay red, pero funciona offline.
 * 2. Imágenes de catálogos descargados (/uploads/...): cache-first.
 *    Las imágenes raramente cambian — si están descargadas, se sirven de caché.
 * 3. APIs (/api/...): network-only. Si falla, el frontend usa IndexedDB.
 *    Las APIs NO se cachean en el SW — eso lo gestiona IndexedDB.
 *
 * SISTEMA "HAY ACTUALIZACIÓN DISPONIBLE":
 * Cada vez que despleguemos algo, cambiamos CACHE_VERSION. El navegador detecta
 * que el sw.js ha cambiado, descarga el nuevo SW, lo deja en estado "waiting".
 * Avisamos a la app via postMessage para mostrar el banner rosa.
 * El usuario decide cuándo activar el nuevo SW pulsando el banner.
 * ============================================================================ */

const CACHE_VERSION = 'cpv2-shell-v4-07jul';
const SHELL_CACHE = 'cpv2-shell';
const IMG_CACHE = 'cpv2-imgs';

// Archivos del "esqueleto" de la app (siempre disponibles offline)
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Leaflet CDN se cacheará en runtime si se accede online primero
];

// ============================================================================
// INSTALL: precachear el app shell
// IMPORTANTE: NO usamos self.skipWaiting() aquí, porque queremos que el SW
// nuevo se quede en estado "waiting" hasta que el usuario decida actualizar
// (pulsando el banner "🔔 Hay actualización disponible").
// ============================================================================
self.addEventListener('install', (event) => {
  console.log('[SW] Install: precacheando shell v' + CACHE_VERSION);
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      // addAll falla si UN archivo falla. Usamos add individualmente para tolerancia.
      return Promise.all(
        SHELL_FILES.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] No se pudo cachear: ' + url, err.message);
          })
        )
      );
    })
    // Sin skipWaiting() — espera que la app llame SKIP_WAITING vía postMessage
  );
});

// ============================================================================
// ACTIVATE: limpiar cachés viejas
// ============================================================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate v' + CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((nombres) => {
      return Promise.all(
        nombres
          .filter((n) => n !== SHELL_CACHE && n !== IMG_CACHE)
          .map((n) => {
            console.log('[SW] Borrando caché vieja: ' + n);
            return caches.delete(n);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================================
// FETCH: enrutar según tipo de petición
// ============================================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo manejamos GET (POST/PUT/DELETE van directo a red)
  if (event.request.method !== 'GET') return;

  // No tocamos peticiones cross-origin críticas (auth, etc.)
  if (url.origin !== self.location.origin) {
    // CDN de Leaflet → cache-first si la tenemos
    if (url.hostname === 'unpkg.com' && url.pathname.includes('leaflet')) {
      event.respondWith(cacheFirst(event.request, SHELL_CACHE));
    }
    return;
  }

  // APIs: NUNCA cacheamos (frontend usa IndexedDB para offline)
  if (url.pathname.startsWith('/api/')) {
    return; // dejamos pasar a la red sin tocar
  }

  // Imágenes de catálogos: cache-first (raramente cambian)
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(cacheFirst(event.request, IMG_CACHE));
    return;
  }

  // Resto (HTML, CSS, JS): network-first con fallback a caché
  event.respondWith(networkFirst(event.request, SHELL_CACHE));
});

// ============================================================================
// HELPERS: estrategias de caché
// ============================================================================
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch (err) {
    // Sin red y sin caché — devolvemos placeholder simple
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Si no tenemos nada cacheado, fallback a la página index
    if (request.mode === 'navigate') {
      const indexCached = await cache.match('/index.html');
      if (indexCached) return indexCached;
    }
    return new Response('Offline y sin caché disponible', { status: 504 });
  }
}

// ============================================================================
// MENSAJES: comunicación con la app (forzar limpieza de caché, etc.)
// ============================================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHES') {
    caches.keys().then((nombres) =>
      Promise.all(nombres.map((n) => caches.delete(n)))
    );
  }
});
