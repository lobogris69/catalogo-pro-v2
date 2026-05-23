/* ============================================================================
 * CatalogPRO v2 — IndexedDB wrapper (I - Modo offline)
 *
 * Almacena en el navegador:
 * - catalogs:   catálogos descargados (objetos completos con metadatos)
 * - sheets:     láminas con sus imágenes (Blob)
 * - sync_queue: cola de cambios pendientes de subir cuando vuelva online
 *               (visitas, anotaciones creadas offline)
 *
 * NOTA: las imágenes se guardan como Blob para que funcionen sin red.
 * ============================================================================ */

const DB_NAME = 'catalogpro_v2';
const DB_VERSION = 1;

let _db = null;

function abrirDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Catálogos
      if (!db.objectStoreNames.contains('catalogs')) {
        const s = db.createObjectStore('catalogs', { keyPath: 'id' });
        s.createIndex('descargado_at', 'descargado_at');
      }
      // Láminas (cada lámina con su imagen como Blob)
      if (!db.objectStoreNames.contains('sheets')) {
        const s = db.createObjectStore('sheets', { keyPath: 'id' });
        s.createIndex('catalog_id', 'catalog_id');
      }
      // Cola de sincronización (visitas, anotaciones pendientes)
      if (!db.objectStoreNames.contains('sync_queue')) {
        const s = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
        s.createIndex('estado', 'estado');
        s.createIndex('created_at', 'created_at');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// Helper genérico: ejecutar transacción simple
async function tx(storeName, mode, cb) {
  const db = await abrirDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = cb(store);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// ============================================================================
// API pública del wrapper
// ============================================================================
window.CpDB = {
  // --- Catálogos ---
  async guardarCatalogo(catalog) {
    return tx('catalogs', 'readwrite', (store) => {
      store.put({ ...catalog, descargado_at: new Date().toISOString() });
    });
  },
  async obtenerCatalogo(id) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('catalogs').objectStore('catalogs').get(Number(id));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },
  async listarCatalogosDescargados() {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('catalogs').objectStore('catalogs').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  async borrarCatalogoOffline(id) {
    // Borra catálogo + sus láminas
    await tx('catalogs', 'readwrite', (store) => store.delete(Number(id)));
    // Las láminas del catálogo
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sheets', 'readwrite');
      const store = transaction.objectStore('sheets');
      const idx = store.index('catalog_id');
      const req = idx.openCursor(IDBKeyRange.only(Number(id)));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },

  // --- Láminas ---
  async guardarLamina(sheet) {
    return tx('sheets', 'readwrite', (store) => {
      store.put(sheet);
    });
  },
  async obtenerLaminasDeCatalogo(catalogId) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('sheets').objectStore('sheets').index('catalog_id').getAll(IDBKeyRange.only(Number(catalogId)));
      req.onsuccess = () => {
        const arr = req.result || [];
        arr.sort((a, b) => (a.orden || 0) - (b.orden || 0));
        resolve(arr);
      };
      req.onerror = () => reject(req.error);
    });
  },

  // --- Sync queue (para futuras sesiones I.2) ---
  async encolarSync(item) {
    return tx('sync_queue', 'readwrite', (store) => {
      store.add({ ...item, estado: 'pendiente', created_at: new Date().toISOString() });
    });
  },
  async listarPendientes() {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('sync_queue').objectStore('sync_queue').index('estado').getAll(IDBKeyRange.only('pendiente'));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  async marcarSincronizado(id) {
    return tx('sync_queue', 'readwrite', (store) => store.delete(id));
  },
  async contarPendientes() {
    const lista = await this.listarPendientes();
    return lista.length;
  },

  // --- Utilidades ---
  async limpiarTodo() {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['catalogs', 'sheets', 'sync_queue'], 'readwrite');
      transaction.objectStore('catalogs').clear();
      transaction.objectStore('sheets').clear();
      transaction.objectStore('sync_queue').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },

  // Tamaño aprox en bytes ocupado por la BD (solo láminas con imagen, lo más pesado)
  async tamanoAproximado() {
    const db = await abrirDB();
    return new Promise((resolve) => {
      let total = 0;
      const req = db.transaction('sheets').objectStore('sheets').openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          if (val.imagen_blob && val.imagen_blob.size) total += val.imagen_blob.size;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => resolve(0);
    });
  }
};
