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
const DB_VERSION = 2;

let _db = null;

function abrirDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;
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
      // I.3: Clientes descargados para uso offline
      if (!db.objectStoreNames.contains('clients')) {
        const s = db.createObjectStore('clients', { keyPath: 'id' });
        s.createIndex('razon_social', 'razon_social');
        s.createIndex('municipio', 'municipio');
        s.createIndex('sage_code', 'sage_code');
      }
      // I.3: Visitas creadas offline (clave = id local temporal tipo "local_xxx")
      if (!db.objectStoreNames.contains('visits_offline')) {
        const s = db.createObjectStore('visits_offline', { keyPath: 'local_id' });
        s.createIndex('estado_sync', 'estado_sync');
        s.createIndex('client_id', 'client_id');
        s.createIndex('created_at', 'created_at');
      }
      // I.3: Anotaciones offline (referencia a visits_offline.local_id O a visita real id si era online)
      if (!db.objectStoreNames.contains('annotations_offline')) {
        const s = db.createObjectStore('annotations_offline', { keyPath: 'local_id' });
        s.createIndex('visit_local_id', 'visit_local_id');
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
  },

  // ============================================================================
  // I.3 - CLIENTES OFFLINE
  // ============================================================================
  async guardarClientesBatch(clientes) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('clients', 'readwrite');
      const store = t.objectStore('clients');
      clientes.forEach(c => store.put(c));
      t.oncomplete = () => resolve(clientes.length);
      t.onerror = () => reject(t.error);
    });
  },
  async listarClientes(query) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction('clients').objectStore('clients').getAll();
      r.onsuccess = () => {
        let arr = r.result || [];
        if (query) {
          const q = String(query).toLowerCase();
          arr = arr.filter(c =>
            (c.razon_social || '').toLowerCase().includes(q) ||
            (c.sage_code || '').toLowerCase().includes(q) ||
            (c.municipio || '').toLowerCase().includes(q) ||
            (c.cif || '').toLowerCase().includes(q)
          );
        }
        // Orden alfabético
        arr.sort((a, b) => (a.razon_social || '').localeCompare(b.razon_social || ''));
        resolve(arr);
      };
      r.onerror = () => reject(r.error);
    });
  },
  async obtenerCliente(id) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction('clients').objectStore('clients').get(Number(id));
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  },
  async contarClientes() {
    const db = await abrirDB();
    return new Promise((resolve) => {
      const r = db.transaction('clients').objectStore('clients').count();
      r.onsuccess = () => resolve(r.result || 0);
      r.onerror = () => resolve(0);
    });
  },

  // ============================================================================
  // I.3 - VISITAS OFFLINE
  // ============================================================================
  // Crear una visita offline (recibe objeto sin local_id, lo genera aquí)
  async crearVisitaOffline(visita) {
    const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const visitaCompleta = {
      ...visita,
      local_id: localId,
      estado_sync: 'pendiente',  // pendiente | sincronizando | error | ok
      created_at: visita.created_at || new Date().toISOString()
    };
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('visits_offline', 'readwrite');
      t.objectStore('visits_offline').put(visitaCompleta);
      t.oncomplete = () => resolve(visitaCompleta);
      t.onerror = () => reject(t.error);
    });
  },
  async actualizarVisitaOffline(localId, cambios) {
    const db = await abrirDB();
    const store = db.transaction('visits_offline', 'readwrite').objectStore('visits_offline');
    return new Promise((resolve, reject) => {
      const getReq = store.get(localId);
      getReq.onsuccess = () => {
        const actual = getReq.result;
        if (!actual) { resolve(null); return; }
        const nueva = { ...actual, ...cambios };
        const putReq = store.put(nueva);
        putReq.onsuccess = () => resolve(nueva);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },
  async obtenerVisitaOffline(localId) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction('visits_offline').objectStore('visits_offline').get(localId);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  },
  async listarVisitasOffline(filtroEstado) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction('visits_offline').objectStore('visits_offline').getAll();
      r.onsuccess = () => {
        let arr = r.result || [];
        if (filtroEstado) arr = arr.filter(v => v.estado_sync === filtroEstado);
        arr.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        resolve(arr);
      };
      r.onerror = () => reject(r.error);
    });
  },
  async contarVisitasPendientes() {
    const lista = await this.listarVisitasOffline('pendiente');
    return lista.length;
  },
  async borrarVisitaOffline(localId) {
    // Borra visita + sus anotaciones offline
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['visits_offline', 'annotations_offline'], 'readwrite');
      t.objectStore('visits_offline').delete(localId);
      // Borrar anotaciones de esa visita
      const annStore = t.objectStore('annotations_offline');
      const idx = annStore.index('visit_local_id');
      const req = idx.openCursor(IDBKeyRange.only(localId));
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { annStore.delete(cur.primaryKey); cur.continue(); }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  // ============================================================================
  // I.3 - ANOTACIONES OFFLINE
  // ============================================================================
  async crearAnotacionOffline(anotacion) {
    const localId = 'ann_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const completa = {
      ...anotacion,
      local_id: localId,
      created_at: anotacion.created_at || new Date().toISOString()
    };
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('annotations_offline', 'readwrite');
      t.objectStore('annotations_offline').put(completa);
      t.oncomplete = () => resolve(completa);
      t.onerror = () => reject(t.error);
    });
  },
  async listarAnotacionesDeVisitaOffline(visitLocalId) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const idx = db.transaction('annotations_offline').objectStore('annotations_offline').index('visit_local_id');
      const r = idx.getAll(IDBKeyRange.only(visitLocalId));
      r.onsuccess = () => {
        const arr = r.result || [];
        arr.sort((a, b) => (a.orden_en_visita || 0) - (b.orden_en_visita || 0));
        resolve(arr);
      };
      r.onerror = () => reject(r.error);
    });
  },
  async borrarAnotacionOffline(localId) {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('annotations_offline', 'readwrite');
      t.objectStore('annotations_offline').delete(localId);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
};
