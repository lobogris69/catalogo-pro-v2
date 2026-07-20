// ============================================================================
// CatalogPRO v2 - Frontend
// ============================================================================
// Versión visible de la app. IMPORTANTE: subirla a la vez que CACHE_VERSION en
// sw.js (app.js y sw.js se cachean juntos en el shell del SW, así que esta
// constante refleja la versión REALMENTE cargada, no la última del servidor).
const APP_VERSION = 'v100 · 20 jul 2026';
const API = '';

// ============================================================================
// AVISO DE NUEVA VERSIÓN — fiable e INDEPENDIENTE del ciclo del Service Worker.
// Compara la versión del sw.js del SERVIDOR con la que está corriendo (APP_VERSION);
// si difiere, muestra el banner "Actualizar". Se comprueba al abrir, al volver a la
// pestaña y cada 5 min. Antes dependíamos solo del evento updatefound del SW, que a
// veces no dispara en algunos navegadores → el usuario no se enteraba de la versión nueva.
const _APP_VER_NUM = (APP_VERSION.match(/v\d+/) || [''])[0]; // 'v72'
async function comprobarNuevaVersionServidor() {
  try {
    const r = await fetch('/sw.js', { cache: 'no-store' });
    if (!r.ok) return;
    const t = await r.text();
    const m = t.match(/cpv2-shell-(v\d+)/);
    const servidor = m ? m[1] : '';
    if (servidor && _APP_VER_NUM && servidor !== _APP_VER_NUM && typeof mostrarBannerActualizacion === 'function') {
      mostrarBannerActualizacion();
    }
  } catch (e) { /* sin red: se reintenta luego */ }
}
window.addEventListener('load', () => setTimeout(comprobarNuevaVersionServidor, 2500));
document.addEventListener('visibilitychange', () => { if (!document.hidden) comprobarNuevaVersionServidor(); });
setInterval(comprobarNuevaVersionServidor, 5 * 60 * 1000);
let token = localStorage.getItem('cpv2_token');
let user = JSON.parse(localStorage.getItem('cpv2_user') || 'null');
let impersonating = JSON.parse(localStorage.getItem('cpv2_impersonate') || 'null');
let appState = {
  vista: 'catalogos',
  catalogoActual: null,
  clienteActual: null,        // B6: ficha de cliente abierta
  clientesPagina: 1,
  clientesBusqueda: '',
  visorModo: 'presentacion', // 'presentacion' | 'mosaico'
  visorIndice: 0,
  visorBusqueda: '',
  visorFiltroCat: null,        // categoría filtrada en visor (id) o null
  visorZoom: 1,
  visorPanX: 0,                // pan horizontal cuando hay zoom
  visorPanY: 0,                // pan vertical cuando hay zoom
  visitaActiva: null,         // B6: { id, client_id, cliente_nombre, catalog_id, ... } o null
  visitaVerId: null,          // B6: si !=null se muestra detalle de una visita pasada
  editorPestana: 'laminas'    // E: 'laminas' | 'historial' - pestaña activa en editor catálogo
};

const $app = document.getElementById('app');

// ===== HELPERS =====
// El "rol efectivo" tiene en cuenta si admin esta impersonando a un comercial
function rolEfectivo() {
  if (impersonating && user && user.role === 'admin') return 'sales';
  return user ? user.role : null;
}
function codigoSageEfectivo() {
  if (impersonating && user && user.role === 'admin') return impersonating.sage_commercial_code;
  return user ? user.sage_commercial_code : null;
}
function esAdminReal() {
  return user && user.role === 'admin';
}
function nombreEfectivo() {
  if (impersonating && user && user.role === 'admin') return impersonating.name;
  return user ? user.name : '';
}

function api(endpoint, options = {}) {
  const headers = options.headers || {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Si admin esta impersonando a otro usuario, le decimos al backend
  if (impersonating && user && user.role === 'admin') {
    headers['X-Impersonate-User'] = String(impersonating.id);
  }
  if (!(options.body instanceof FormData) && options.body) {
    headers['Content-Type'] = 'application/json';
    if (typeof options.body !== 'string') options.body = JSON.stringify(options.body);
  }
  return fetch(API + endpoint, { ...options, headers })
    .then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Cualquier 401 = sesión no válida/caducada → logout limpio y aviso claro,
        // en vez de un "no autorizado" críptico en medio de cualquier pantalla.
        if (r.status === 401) {
          setTimeout(() => {
            alert('Tu sesión ha caducado. Vuelve a iniciar sesión.');
            logout();
          }, 0);
          throw new Error('Sesión caducada');
        }
        throw new Error(data.error || `Error ${r.status}`);
      }
      return data;
    });
}

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Helper: versiona una URL de imagen de lámina con ?v=<updated_at> para ROMPER la caché
// cuando el archivo se reprocesa in-place (mismo nombre) — p.ej. la corrección de color PNG.
// Las imágenes se sirven con Cache-Control immutable 1 año + el SW las cachea; sin versionar,
// el navegador seguiría mostrando la versión antigua tras un reproceso. Con blob:/data: no toca.
function vurl(pathImg, sheet) {
  if (!pathImg) return pathImg;
  if (pathImg.startsWith('blob:') || pathImg.startsWith('data:')) return pathImg;
  if (pathImg.indexOf('/uploads/') === -1) return pathImg;
  let v = 0;
  if (sheet && sheet.updated_at) { const t = Date.parse(sheet.updated_at); if (!isNaN(t)) v = t; }
  if (!v && sheet && sheet.id) return pathImg + (pathImg.indexOf('?') >= 0 ? '&' : '?') + 'v=s' + sheet.id;
  if (!v) return pathImg;
  return pathImg + (pathImg.indexOf('?') >= 0 ? '&' : '?') + 'v=' + v;
}

// Helper: genera tooltip contextual (?). Posición opcional: '', 'abajo', 'izq'
function ayuda(texto, posicion) {
  const clase = posicion === 'abajo' ? 'ayuda-tip tip-abajo'
              : posicion === 'izq' ? 'ayuda-tip tip-izq'
              : 'ayuda-tip';
  return `<span class="${clase}" tabindex="0" data-tip="${escape(texto)}">?</span>`;
}

function logout() {
  localStorage.removeItem('cpv2_token');
  localStorage.removeItem('cpv2_user');
  localStorage.removeItem('cpv2_impersonate');
  token = null;
  user = null;
  impersonating = null;
  appState.visitaActiva = null;
  appState.clienteActual = null;
  appState.visitaVerId = null;
  window._visitaCargada = false;
  render();
}

// ===== RENDER PRINCIPAL =====
function render() {
  if (!token || !user) {
    renderLogin();
  } else {
    renderApp();
  }
}

// ===== PANTALLA LOGIN =====
function renderLogin() {
  $app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">
          <h1>CatalogPRO v2</h1>
          <p>LOMHIFAR S.L.</p>
        </div>
        <div id="login-error"></div>
        <div style="text-align:center;font-size:12px;color:#9ca3af;margin:-4px 0 10px">Versión ${APP_VERSION}</div>
        <form id="login-form">
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="login-email" required autocomplete="username" value="f.ayllon66@gmail.com">
          </div>
          <div class="form-group">
            <label>Contraseña</label>
            <input type="password" id="login-password" required autocomplete="current-password">
          </div>
          <button type="submit" class="btn btn-primary">Entrar</button>
        </form>
      </div>
    </div>
  `;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      token = r.token;
      user = r.user;
      localStorage.setItem('cpv2_token', token);
      localStorage.setItem('cpv2_user', JSON.stringify(user));
      render();
    } catch (err) {
      document.getElementById('login-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

// ===== APP PRINCIPAL =====
async function renderApp() {
  // B6: cargar visita activa una vez al arrancar la sesión.
  // _visitaCargada=true en window para no volver a pedirla en cada render.
  if (!window._visitaCargada) {
    window._visitaCargada = true;
    try {
      const r = await api('/api/visits/current');
      appState.visitaActiva = r.visit || null;
    } catch (e) { /* sin visita o sin red */ }
  }

  const esAdmin = rolEfectivo() === 'admin';
  const adminReal = esAdminReal();
  const impersonando = !!impersonating && user && user.role === 'admin';

  // Banner de impersonación (si admin esta viendo como otro)
  const bannerImpersonacion = impersonando ? `
    <div class="banner-impersonacion">
      <span>👁 Estás viendo CatalogPRO como <b>${escape(impersonating.name)}</b> (comercial)</span>
      <button onclick="dejarImpersonacion()" class="btn-volver-admin">← Volver a Admin</button>
    </div>
  ` : '';

  // B6: Barra de visita activa (si el usuario tiene una visita en curso)
  const va = appState.visitaActiva;
  const barraVisita = va ? `
    <div class="banner-visita">
      <span>🛒 Visita en curso: <b>${escape(va.cliente_nombre || ('Cliente #' + va.client_id))}</b></span>
      <div style="display:flex; gap:6px">
        <button class="btn btn-secondary btn-pequeno" onclick="abrirVisitaActiva()">Ver visita</button>
        <button class="btn btn-primary btn-pequeno" onclick="cerrarVisitaActiva()">Cerrar visita</button>
        <button class="btn btn-danger btn-pequeno" onclick="descartarVisitaActiva()">Descartar</button>
      </div>
    </div>
  ` : '';

  $app.innerHTML = `
    <div class="app-shell">
      ${bannerImpersonacion}
      ${barraVisita}
      <div class="topbar">
        <div>
          <div class="topbar-titulo">CatalogPRO v2</div>
          <div class="topbar-usuario">
            ${escape(nombreEfectivo())} · ${rolEfectivo() === 'admin' ? 'Administrador' : 'Comercial'}
            ${impersonando ? ` <span style="opacity:0.7">(real: ${escape(user.name)})</span>` : ''}
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <div id="indicador-online" class="indicador-online" title="Estado de conexión"></div>
          ${adminReal && !impersonando ? `<button class="topbar-action" onclick="abrirSelectorImpersonacion()" title="Ver como un comercial">👁 Ver como…</button>` : ''}
          <button class="topbar-action" id="btn-tema" onclick="alternarTema()" title="Cambiar tema claro / oscuro">${document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'}</button>
          <button class="topbar-logout" onclick="logout()">Salir</button>
        </div>
      </div>
      <div class="navtabs">
        ${esAdmin ? `<button class="navtab ${appState.vista === 'dashboard' ? 'navtab-activa' : ''}" onclick="irA('dashboard')">🏠 Dashboard</button>` : ''}
        <button class="navtab ${appState.vista === 'catalogos' ? 'navtab-activa' : ''}" onclick="irA('catalogos')">📚 Catálogos</button>
        <button class="navtab ${appState.vista === 'clientes' ? 'navtab-activa' : ''}" onclick="irA('clientes')">🏥 Clientes</button>
        <button class="navtab ${appState.vista === 'planning' ? 'navtab-activa' : ''}" onclick="irA('planning')">🗓️ Planning</button>
        <button class="navtab ${appState.vista === 'aula' ? 'navtab-activa' : ''}" onclick="irA('aula')">🎓 Aula</button>
        <button class="navtab ${appState.vista === 'mapa' ? 'navtab-activa' : ''}" onclick="irA('mapa')">🗺️ Mapa</button>
        ${esAdmin ? `<button class="navtab ${appState.vista === 'productos' ? 'navtab-activa' : ''}" onclick="irA('productos')">📦 Productos</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'comerciales' ? 'navtab-activa' : ''}" onclick="irA('comerciales')">👥 Comerciales</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'plantillas' ? 'navtab-activa' : ''}" onclick="irA('plantillas')">🏷️ Plantillas</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'configuracion' ? 'navtab-activa' : ''}" onclick="irA('configuracion')">⚙️ Configuración</button>` : ''}
        <button class="navtab ${appState.vista === 'pedidos-guardados' ? 'navtab-activa' : ''}" onclick="irA('pedidos-guardados')" title="Pedidos guardados localmente">📁 Mis pedidos</button>
        <button class="navtab navtab-lupa" onclick="abrirBusquedaGlobal()" title="Buscar (Ctrl+K)" style="margin-left:auto">🔍</button>
        <button class="navtab ${appState.vista === 'cuenta' ? 'navtab-activa' : ''}" onclick="irA('cuenta')">⚙️ Mi cuenta</button>
      </div>
      <div id="vista-contenido"></div>
      <div style="text-align:center;font-size:11px;color:#9ca3af;padding:14px 0 8px">CatalogPRO ${APP_VERSION}</div>
    </div>
  `;
  routerVista();
  // I: re-aplicar estado del indicador online tras cada render
  if (typeof actualizarIndicadorOnline === 'function') actualizarIndicadorOnline();
}

// Alterna tema claro/oscuro y lo recuerda. El tema se aplica en <head> (index.html)
// antes del CSS para no parpadear; aquí solo lo cambia el usuario con el botón 🌙/☀️.
function alternarTema() {
  const esOscuroAhora = document.documentElement.dataset.theme === 'dark';
  const nuevo = esOscuroAhora ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem('cpv2_theme', nuevo); } catch (e) {}
  const b = document.getElementById('btn-tema');
  if (b) b.textContent = nuevo === 'dark' ? '☀️' : '🌙';
}

function routerVista() {
  // I.2: vistas que NO funcionan offline (requieren API y no tienen cache offline)
  // Clientes y Planning SÍ funcionan offline (I.3 + I-Planning) leyendo desde IndexedDB
  const vistasOnlineOnly = ['comerciales', 'mapa', 'plantillas', 'configuracion', 'productos', 'dashboard', 'aula'];
  if (!navigator.onLine && vistasOnlineOnly.includes(appState.vista)) {
    renderVistaNoDisponibleOffline(appState.vista);
    return;
  }

  if (appState.vista === 'dashboard') {
    renderDashboard();
    return;
  }
  if (appState.vista === 'aula') {
    renderAula();
    return;
  }
  if (appState.vista === 'pedidos-guardados') {
    renderMisPedidosGuardados();
    return;
  }
  if (appState.vista === 'clientes') {
    if (appState.clienteActual) {
      renderDetalleCliente(appState.clienteActual);
    } else if (appState.visitaVerId) {
      renderDetalleVisita(appState.visitaVerId);
    } else {
      renderListaClientes();
    }
  } else if (appState.vista === 'comerciales') {
    renderListaComerciales();
  } else if (appState.vista === 'planning') {
    renderPlanning();
  } else if (appState.vista === 'mapa') {
    renderMapa();
  } else if (appState.vista === 'productos') {
    renderListaProductos();
  } else if (appState.vista === 'plantillas') {
    renderListaPlantillas();
  } else if (appState.vista === 'configuracion') {
    renderConfiguracion();
  } else if (appState.vista === 'cuenta') {
    renderMiCuenta();
  } else if (appState.catalogoActual) {
    // Si admin → editor. Si comercial (o admin impersonando) → visor
    // I.2: si offline, siempre visor (el editor requiere API)
    if (rolEfectivo() === 'admin' && navigator.onLine) {
      renderEditorCatalogo(appState.catalogoActual);
    } else {
      renderVisorComercial(appState.catalogoActual);
    }
  } else {
    renderListaCatalogos();
  }
}

// I.2: pantalla "esta vista necesita conexión" cuando estás offline en una vista que la requiere
function renderVistaNoDisponibleOffline(vista) {
  const nombres = {
    'clientes': '🏥 Clientes',
    'comerciales': '👥 Comerciales',
    'planning': '🗓️ Planning',
    'mapa': '🗺️ Mapa',
    'plantillas': '🏷️ Plantillas',
    'configuracion': '⚙️ Configuración',
    'productos': '📦 Productos'
  };
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `
    <div class="contenedor">
      <div class="empty-state">
        <div class="empty-state-icono">📡</div>
        <h3>${nombres[vista] || vista} no disponible offline</h3>
        <p style="max-width:500px;margin:1rem auto;color:var(--gris-texto)">
          Esta sección necesita conexión a internet. Cuando recuperes la conexión podrás volver a usarla.
        </p>
        <p style="font-size:13px;color:var(--gris-texto);max-width:500px;margin:1rem auto">
          Mientras tanto, puedes consultar los <b>catálogos descargados</b> que tienes en este dispositivo.
        </p>
        <button class="btn btn-primary" style="max-width:280px;margin:1rem auto 0" onclick="irA('catalogos')">
          📚 Ver catálogos descargados
        </button>
      </div>
    </div>
  `;
}

function irA(vista) {
  // Comerciales (incluido admin impersonando) NO pueden entrar a comerciales (gestión users)
  // Plantillas solo admin REAL (no impersonando)
  if (rolEfectivo() === 'sales' && (vista === 'comerciales' || vista === 'plantillas' || vista === 'configuracion')) {
    vista = 'catalogos';
  }
  appState.vista = vista;
  appState.catalogoActual = null;
  appState.clienteActual = null;
  appState.visitaVerId = null;
  render();
}

// ===== LISTA DE CATALOGOS =====
async function renderListaCatalogos() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando catálogos…</div></div>`;
  // I: refrescar cache de catálogos descargados offline para mostrar badges correctos
  try { if (typeof refrescarCacheCatalogosDescargados === 'function') await refrescarCacheCatalogosDescargados(); } catch (_) {}
  try {
    // I.2: si estamos offline, ir directos a IndexedDB sin intentar la API
    let catalogos = [];
    let modoOffline = false;
    if (!navigator.onLine) {
      modoOffline = true;
      const descargados = await CpDB.listarCatalogosDescargados();
      catalogos = descargados.map(c => ({ ...c, _offline: true }));
    } else {
      try {
        const r = await api('/api/catalogs');
        catalogos = r.catalogs || [];
      } catch (err) {
        // Si falla la API pero el navegador dice online, intentar IndexedDB como fallback
        console.warn('[I.2] API falló, usando IndexedDB:', err.message);
        modoOffline = true;
        const descargados = await CpDB.listarCatalogosDescargados();
        catalogos = descargados.map(c => ({ ...c, _offline: true }));
      }
    }
    const esAdmin = rolEfectivo() === 'admin';

    let html = `
      <div class="contenedor">
        <div class="titulo-pagina">
          <h2>Catálogos${modoOffline ? ' <span style="font-size:13px;color:var(--gris-texto);font-weight:normal">(modo offline)</span>' : ''}</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${esAdmin && !modoOffline ? `<button class="btn btn-primary btn-pequeno" onclick="abrirModalNuevoCatalogo()">+ Nuevo catálogo</button>${ayuda('Crea un catálogo nuevo. Tipo "Maestro" = catálogo principal con todas las láminas. Tipo "Express" = subcatálogo de ofertas que selecciona algunas láminas del maestro (ej: ofertas verano).', 'izq')}` : ''}
            ${!modoOffline ? `<button class="btn btn-secondary btn-pequeno" onclick="descargarMisClientes()" title="Descargar tu lista de clientes a este dispositivo para uso offline">👥 Descargar clientes</button>` : ''}
          </div>
        </div>
        ${modoOffline ? `
          <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#78350f">
            📲 <b>Modo offline:</b> mostrando solo los catálogos descargados a este dispositivo.
          </div>
        ` : ''}
    `;

    if (catalogos.length === 0) {
      html += `
        <div class="empty-state">
          <div class="empty-state-icono">📚</div>
          <h3>${modoOffline ? 'Sin catálogos descargados' : 'No hay catálogos todavía'}</h3>
          <p>${modoOffline
            ? 'Cuando recuperes la conexión, podrás descargar catálogos para usarlos offline.'
            : (esAdmin ? 'Crea tu primer catálogo maestro para empezar a subir láminas.' : 'Aún no tienes catálogos asignados.')}</p>
          ${esAdmin && !modoOffline ? `<button class="btn btn-primary" style="max-width:280px;margin:0 auto" onclick="abrirModalNuevoCatalogo()">+ Crear primer catálogo</button>` : ''}
        </div>
      `;
    } else {
      html += `<div class="catalogos-grid">`;
      catalogos.forEach(c => {
        const tipoClase = c.tipo === 'maestro' ? 'tipo-maestro' : c.tipo === 'clon' ? 'tipo-clon' : 'tipo-express';
        const estadoClase = c.estado === 'publicado' ? 'estado-publicado' : 'estado-borrador';
        // Badge: para express usamos icono y texto explicito; para el resto solo el tipo
        const badgeTxt = c.tipo === 'express' ? '📗 Express' : c.tipo === 'maestro' ? '📕 Maestro' : '📘 Clon';
        // Linea con el maestro padre (solo express)
        const parentLine = (c.tipo === 'express' && c.parent_name)
          ? `<div class="catalogo-card-parent">de: ${escape(c.parent_name)}</div>`
          : '';
        const esOfflineDescargado = estaDescargadoOffline(c.id);
        html += `
          <div class="catalogo-card" onclick="abrirCatalogo(${c.id})">
            <div class="catalogo-card-header">
              <span class="catalogo-card-tipo ${tipoClase}">${badgeTxt}</span>
              <span class="catalogo-card-estado ${estadoClase}">${c.estado}</span>
              ${esOfflineDescargado ? `<span class="catalogo-card-offline" title="Disponible offline">📲</span>` : ''}
            </div>
            <div class="catalogo-card-nombre">${escape(c.name)}</div>
            ${parentLine}
            <div class="catalogo-card-info">${c.sheet_count || 0} láminas · V${c.version}</div>
            <div class="catalogo-card-acciones">
              <button class="btn-card-mini" onclick="event.stopPropagation();abrirModalDescargarCatalogo(${c.id}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Descargar catálogo">
                📥 PDF/ZIP
              </button>
              ${esOfflineDescargado
                ? `<button class="btn-card-mini btn-card-offline-on" onclick="event.stopPropagation();borrarCatalogoOffline(${c.id}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Borrar copia offline">
                    ✅ Offline
                  </button>`
                : `<button class="btn-card-mini" onclick="event.stopPropagation();descargarCatalogoOffline(${c.id}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Descargar al móvil para uso sin internet">
                    📲 Offline
                  </button>`
              }
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }
    html += `</div>`;
    $v.innerHTML = html;
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

// ===== MODAL: NUEVO CATALOGO =====
async function abrirModalNuevoCatalogo() {
  // Antes de abrir el modal cargamos la lista de maestros disponibles (para el selector de padre)
  let maestros = [];
  try {
    const r = await api('/api/catalogs');
    maestros = (r.catalogs || []).filter(c => c.tipo === 'maestro');
  } catch (err) {
    alert('No se pudieron cargar los maestros: ' + err.message);
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>Nuevo catálogo</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="modal-error"></div>
      <form id="form-nuevo-cat">
        <div class="form-group">
          <label>Tipo</label>
          <select id="cat-tipo">
            <option value="maestro">📕 Maestro (catálogo principal)</option>
            <option value="express">📗 Express (selección del maestro para una campaña)</option>
          </select>
        </div>
        <div class="form-group" id="grupo-maestro-padre" style="display:none">
          <label>Maestro padre <span style="color:var(--rosa)">*</span></label>
          <select id="cat-parent-id">
            ${maestros.length === 0
              ? `<option value="">— No hay maestros aún, crea uno primero —</option>`
              : maestros.map(m => `<option value="${m.id}">${escape(m.name)}</option>`).join('')
            }
          </select>
          <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">
            El Express seleccionará láminas de este maestro. Es un espejo en vivo: si actualizas la lámina en el maestro, el Express lo refleja.
          </div>
        </div>
        <div class="form-group">
          <label>Nombre</label>
          <input type="text" id="cat-name" required placeholder="Ej: Catálogo General Mayo 2026">
        </div>
        <div class="form-group">
          <label>Descripción (opcional)</label>
          <textarea id="cat-desc" rows="2" placeholder="Notas internas..."></textarea>
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Crear</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  // Mostrar/ocultar selector de maestro padre segun el tipo elegido
  const tipoSel = document.getElementById('cat-tipo');
  const grupoPadre = document.getElementById('grupo-maestro-padre');
  function actualizarVisibilidadPadre() {
    grupoPadre.style.display = tipoSel.value === 'express' ? '' : 'none';
  }
  tipoSel.addEventListener('change', actualizarVisibilidadPadre);
  actualizarVisibilidadPadre();

  document.getElementById('form-nuevo-cat').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const tipo = tipoSel.value;
      const data = {
        name: document.getElementById('cat-name').value.trim(),
        description: document.getElementById('cat-desc').value.trim(),
        tipo: tipo
      };
      if (tipo === 'express') {
        const parentId = document.getElementById('cat-parent-id').value;
        if (!parentId) {
          document.getElementById('modal-error').innerHTML = `<div class="error-msg">Tienes que elegir un maestro padre. Si no hay ninguno, crea primero un Maestro.</div>`;
          return;
        }
        data.parent_id = Number(parentId);
      }
      const r = await api('/api/catalogs', { method: 'POST', body: data });
      modal.remove();
      appState.catalogoActual = r.catalog.id;
      render();
    } catch (err) {
      document.getElementById('modal-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

// ===== ABRIR CATALOGO =====
function abrirCatalogo(id) {
  appState.catalogoActual = id;
  appState.editorPestana = 'laminas'; // E: siempre abre en láminas
  render();
}

function volverACatalogos() {
  appState.catalogoActual = null;
  appState.editorPestana = 'laminas';
  _navStack = [];
  if (typeof actualizarBotonVolverEnlace === 'function') actualizarBotonVolverEnlace();
  render();
}

// Tras re-renderizar el editor, vuelve a la lámina que se estaba editando (guardada en
// appState.editorRestoreSheetId) en vez de dejar la lista arriba del todo. Se consume una vez.
function _restaurarScrollLamina() {
  const id = appState.editorRestoreSheetId;
  if (!id) return;
  appState.editorRestoreSheetId = null;
  // Reintentos cortos: las miniaturas cargan lazy y el layout tarda un pelín en asentarse.
  let intentos = 0;
  const ir = () => {
    const el = document.querySelector('.lamina-fila[data-id="' + id + '"], .express-fila[data-id="' + id + '"]');
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'auto' }); el.classList.add('lamina-fila-vuelta'); setTimeout(() => el.classList.remove('lamina-fila-vuelta'), 1600); return; }
    if (intentos++ < 10) setTimeout(ir, 80);
  };
  setTimeout(ir, 50);
}

// ===== EDITOR DE CATALOGO =====
async function renderEditorCatalogo(id) {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando catálogo…</div></div>`;
  try {
    const r = await api('/api/catalogs/' + id);
    const c = r.catalog;
    // Si es Express, llevamos al editor específico (selector del maestro + lista del Express)
    if (c.tipo === 'express') {
      renderEditorExpress(id, r);
      return;
    }
    const sheets = r.sheets || [];
    const esAdmin = rolEfectivo() === 'admin';

    let html = `
      <div class="contenedor">
        <div class="titulo-pagina">
          <div>
            <button class="btn btn-secondary btn-pequeno" onclick="volverACatalogos()">← Catálogos</button>
            <h2 style="margin-top:8px">${escape(c.name)}</h2>
            <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
              ${c.tipo} · ${sheets.length} láminas · V${c.version} · ${c.estado}
            </div>
          </div>
          ${esAdmin ? `
            <div style="display:flex;gap:6px;align-self:flex-start;flex-wrap:wrap">
              <button class="btn btn-secondary btn-pequeno" onclick="abrirAsignacionComerciales(${id})">👥 Asignar a comerciales</button>
              ${sheets.length > 1 ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirMosaicoLaminas(${id})" title="Reordenar láminas en mosaico visual">🔲 Mosaico</button>${ayuda('Vista en cuadrícula para reordenar las láminas. Arrastra y suelta o escribe el número de orden.')}` : ''}
              ${sheets.length > 0 ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirModalDescargarPdf(${id}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Descargar PDF del catálogo">📥 Descargar PDF</button>${ayuda('Genera el PDF del catálogo en alta calidad (impresión) o pequeño (para enviar por WhatsApp/email a clientes).')}` : ''}
              ${sheets.length > 0 && esAdminReal() ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirInformePrecios(${id}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Informe de qué láminas hay que revisar/actualizar a mano en precios dinámicos">📋 Informe precios</button>` : ''}
              ${sheets.length > 0 && esAdminReal() ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirBackupMega(${id}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Copia de respaldo en MEGA como fotos sueltas para cada comercial">☁️ Backup MEGA</button>${ayuda('Sube todas las láminas como PNG sueltos a MEGA en la carpeta de cada comercial (o en /General si el catálogo está asignado a todos). Sistema de respaldo por si la app falla: los comerciales abren la carpeta con el visor de fotos del móvil.', 'izq')}` : ''}
              ${sheets.length > 0 ? `<button class="btn btn-primary btn-pequeno" onclick="abrirCerrarVersion(${id}, ${c.version || 1}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Cerrar versión actual y empezar la siguiente">📌 Cerrar versión</button>${ayuda('Guarda una "foto" del catálogo actual: genera PDF + ZIP de respaldo descargables, queda registrado en el historial, y la versión sube V1→V2. Útil al final de cada temporada.', 'izq')}` : ''}
              ${sheets.length > 0 ? `<button class="btn btn-danger btn-pequeno" onclick="borrarTodasLaminas(${id}, ${sheets.length})">🗑️ Borrar todas</button>` : ''}
            </div>
          ` : ''}
        </div>

        <!-- Pestañas Láminas / Historial -->
        <div class="editor-pestanas">
          <button class="editor-pestana ${appState.editorPestana !== 'historial' ? 'editor-pestana-activa' : ''}" onclick="cambiarPestanaEditor('laminas')">📄 Láminas (${sheets.length})</button>
          <button class="editor-pestana ${appState.editorPestana === 'historial' ? 'editor-pestana-activa' : ''}" onclick="cambiarPestanaEditor('historial')">📚 Historial</button>
        </div>

        <div id="editor-pestana-contenido">
          <!-- Se rellena según pestaña activa -->
        </div>
      </div>
    `;
    $v.innerHTML = html;
    // Pintar contenido de la pestaña activa
    if (appState.editorPestana === 'historial') {
      pintarPestanaHistorial(id);
      return;
    }

    // Pintar pestaña láminas (contenido normal)
    const htmlContenido = `
        <div class="editor-grid">
          ${esAdmin ? `
          <div class="editor-panel">
            <h3>Subir láminas</h3>
            <div class="upload-zona" id="upload-zona" onclick="document.getElementById('upload-input').click()">
              <div class="upload-zona-icono">📄</div>
              <div class="upload-zona-texto">Pulsa para elegir archivo</div>
              <div class="upload-zona-sub">JPG · PNG (una lámina)</div>
            </div>
            <input type="file" id="upload-input" accept="image/*" style="display:none">

            <div style="text-align:center; margin:14px 0 10px; color:var(--gris-texto); font-size:11px;">— o —</div>

            <div class="upload-zona upload-zona-multi" id="upload-zona-multi" onclick="abrirModalSubidaMasiva(${id})">
              <div class="upload-zona-icono">📚</div>
              <div class="upload-zona-texto">Subida masiva</div>
              <div class="upload-zona-sub">varias láminas a la vez (ordenadas por nombre)</div>
            </div>

            <div style="text-align:center; margin:14px 0 10px; color:var(--gris-texto); font-size:11px;">— o —</div>

            <div class="upload-zona upload-zona-pdf" id="upload-zona-pdf" onclick="document.getElementById('upload-pdf-input').click()">
              <div class="upload-zona-icono">📕</div>
              <div class="upload-zona-texto">Subir PDF completo</div>
              <div class="upload-zona-sub">se trocea en láminas automáticamente</div>
            </div>
            <input type="file" id="upload-pdf-input" accept="application/pdf" style="display:none">

            <div id="upload-progreso"></div>
          </div>
          ` : ''}

          <div class="editor-panel">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:1rem; flex-wrap:wrap">
              <h3 style="margin-bottom:0">Láminas (${sheets.length})</h3>
              ${esAdmin ? `
                <button onclick="insertarHojaEnBlanco(null, ${id})" class="btn btn-pequeno btn-secondary" title="Insertar una hoja en blanco al principio del catálogo">📄➕ Hoja al principio</button>
                <input type="text" id="filtro-laminas" placeholder="🔍 Filtrar (número o palabra)..."
                       style="flex:1; min-width:200px; padding:8px 12px; border:1px solid var(--gris-borde); border-radius:8px; font-size:13px; font-family:inherit; outline:none;">
              ` : ''}
            </div>
            <div id="laminas-lista">
              ${sheets.length === 0 ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">Sin láminas todavía. ${esAdmin ? 'Sube la primera con el panel de la izquierda.' : ''}</p>` : ''}
              ${sheets.map((s, idx) => {
                const catsIds = (s.categorias || []).map(c => c.id).join(',');
                const catsChips = (s.categorias || []).map(c =>
                  `<span class="lamina-cat-chip" style="background:${escape(c.color || '#cc007a')}20;color:${escape(c.color || '#cc007a')};border:1px solid ${escape(c.color || '#cc007a')}40">${escape(c.nombre)}</span>`
                ).join('');
                return `
                <div class="lamina-fila" data-id="${s.id}" data-titulo="${escape((s.titulo || '').toLowerCase())}" data-tags="${escape((s.tags || '').toLowerCase())}" data-cats="${catsIds}" data-numero="${idx + 1}" ${esAdmin ? 'draggable="true"' : ''}>
                  ${esAdmin ? `<div class="drag-handle" title="Arrastra para reordenar">⋮⋮</div>` : ''}
                  <div class="lamina-numero">${idx + 1}</div>
                  <img src="${escape(vurl(s.miniatura_path || s.imagen_path, s))}" class="lamina-mini" alt="" loading="lazy" decoding="async" onerror="this.style.background='#f3f4f6';this.style.objectFit='contain'" onclick="abrirLightbox('${escape(vurl(s.imagen_path, s))}', '${escape((s.titulo || 'Lámina ' + (idx + 1)).replace(/'/g, '\\\''))}', ${idx + 1})">
                  <div class="lamina-info">
                    <div class="lamina-titulo">${escape(s.titulo || 'Sin título')}</div>
                    ${esAdmin ? (
                      s.zonas_aprobadas_at
                        ? `<span class="lamina-estado-zonas ok">✅ Revisada (${s.num_zonas || 0} zonas)</span>`
                        : (s.num_zonas > 0
                            ? `<span class="lamina-estado-zonas auto">🤖 Auto · sin revisar (${s.num_zonas})</span>`
                            : `<span class="lamina-estado-zonas none">⚪ Sin zonas</span>`)
                    ) : ''}
                    ${esAdmin ? (
                      s.precios_excluida
                        ? `<span class="lamina-estado-precios excl" title="Excluida de los precios dinámicos: se ve y exporta tal cual (se rehace a mano)">🔒 Precios a mano</span>`
                        : (s.num_recuadros > 0
                          ? `<span class="lamina-estado-precios ${s.num_recuadros_pend > 0 ? 'pend' : 'ok'}" title="${s.num_recuadros_pend > 0 ? s.num_recuadros_pend + ' de ' + s.num_recuadros + ' pendientes de aprobar (no se muestran al cliente)' : 'Los ' + s.num_recuadros + ' precios se reescriben con el de la base de datos'}">💶 ${s.num_recuadros} precio${s.num_recuadros === 1 ? '' : 's'}${s.num_recuadros_pend > 0 ? ' · ⚠️ ' + s.num_recuadros_pend + ' sin aprobar' : ''}</span>`
                          : `<span class="lamina-estado-precios none" title="Esta lámina aún no tiene precios dinámicos asignados">💶 Sin precios</span>`)
                    ) : ''}
                    ${catsChips ? `<div class="lamina-cats">${catsChips}</div>` : ''}
                    ${esAdmin ? `
                      <input type="text" class="lamina-tags-input" value="${escape(s.tags || '')}"
                             placeholder="🏷️ tags (ej: gafas, sol, coronation, oferta 12+12)"
                             data-id="${s.id}" data-original="${escape(s.tags || '')}">
                    ` : `
                      <div class="lamina-notas">${escape(s.notas || s.tags || 'Sin notas')}</div>
                    `}
                  </div>
                  ${esAdmin ? `
                  <div class="lamina-acciones">
                    <button class="btn-guardar-tags" data-id="${s.id}" style="display:none" title="Guardar tags">💾</button>
                    <button onclick="insertarHojaEnBlanco(${s.id}, ${id})" title="Insertar hoja en blanco debajo">➕</button>
                    <button onclick="regenerarTagsIA(${s.id}, this)" title="Generar tags con IA (GPT-4 Vision)">🤖</button>
                    <button onclick="sustituirImagenLamina(${s.id})" title="Sustituir imagen">🔄</button>
                    <button onclick="editarLamina(${s.id})" title="Editar todo">✏️</button>
                    <button class="btn-borrar" onclick="borrarLamina(${s.id}, ${id})" title="Borrar">🗑️</button>
                  </div>
                  ` : ''}
                </div>
              `;}).join('')}
            </div>
          </div>
        </div>
    `;
    // Pintamos el contenido en la pestaña láminas (el contenedor exterior ya está en $v)
    const $pestContenido = document.getElementById('editor-pestana-contenido');
    if ($pestContenido) $pestContenido.innerHTML = htmlContenido;
    // Si venimos de editar una lámina, volver a ella (no al principio de la lista)
    _restaurarScrollLamina();

    // Listeners para la edición inline de tags
    if (esAdmin) {
      // Inputs de tags
      document.querySelectorAll('.lamina-tags-input').forEach(input => {
        const id = Number(input.dataset.id);
        const fila = input.closest('.lamina-fila');
        const btnGuardar = fila.querySelector('.btn-guardar-tags');
        input.addEventListener('input', () => {
          if (input.value !== input.dataset.original) {
            btnGuardar.style.display = 'inline-block';
            input.classList.add('lamina-tags-dirty');
          } else {
            btnGuardar.style.display = 'none';
            input.classList.remove('lamina-tags-dirty');
          }
        });
        // Guardar al pulsar Enter
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            guardarTagsLamina(id);
          } else if (e.key === 'Escape') {
            input.value = input.dataset.original;
            btnGuardar.style.display = 'none';
            input.classList.remove('lamina-tags-dirty');
          }
        });
      });
      // Botones de guardar
      document.querySelectorAll('.btn-guardar-tags').forEach(btn => {
        btn.addEventListener('click', () => guardarTagsLamina(Number(btn.dataset.id)));
      });
      // Filtro
      const filtro = document.getElementById('filtro-laminas');
      if (filtro) {
        let t;
        filtro.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => filtrarLaminasEditor(filtro.value), 200);
        });
      }
      // Drag & drop
      activarDragDropLaminas(id);
    }

    if (esAdmin) {
      const input = document.getElementById('upload-input');
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await subirLamina(id, file);
        input.value = '';
      });

      const inputPdf = document.getElementById('upload-pdf-input');
      inputPdf.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await subirPDF(id, file);
        inputPdf.value = '';
      });
    }
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

// ============================================================================
// ===== EDITOR ESPECÍFICO DE CATÁLOGO EXPRESS (B5) =====
// ============================================================================
// Un Express selecciona láminas de su maestro padre (espejo en vivo).
// La pantalla muestra DOS columnas:
//  - Izquierda: láminas disponibles en el maestro (con checkbox)
//  - Derecha: láminas que ya están en el Express (orden + quitar)
// Estado local del editor (solo mientras renderiza esta vista).
let _expressEditor = {
  catalogId: null,
  expressData: null,    // { catalog, sheets } del Express
  masterSheets: [],     // láminas del maestro padre
  filtroMaestro: '',
  filtroExpress: '',
  seleccionMaestro: new Set(),
};

async function renderEditorExpress(id, expressData) {
  _expressEditor.catalogId = id;
  _expressEditor.expressData = expressData;
  _expressEditor.seleccionMaestro = new Set();

  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando catálogo Express…</div></div>`;

  try {
    const r = await api('/api/catalogs/' + id + '/master-sheets');
    _expressEditor.masterSheets = r.sheets || [];
    pintarEditorExpress();
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

function pintarEditorExpress() {
  const id = _expressEditor.catalogId;
  const c = _expressEditor.expressData.catalog;
  const sheetsExpress = _expressEditor.expressData.sheets || [];
  const masterSheets = _expressEditor.masterSheets;
  const fM = (_expressEditor.filtroMaestro || '').toLowerCase().trim();
  const fE = (_expressEditor.filtroExpress || '').toLowerCase().trim();

  // Filtrar maestro y express
  const masterFiltradas = !fM ? masterSheets : masterSheets.filter(s => {
    const hay = (s.titulo || '').toLowerCase() + ' ' + (s.tags || '').toLowerCase();
    return hay.includes(fM);
  });
  const expressFiltradas = !fE ? sheetsExpress : sheetsExpress.filter(s => {
    const hay = (s.titulo || '').toLowerCase() + ' ' + (s.tags || '').toLowerCase();
    return hay.includes(fE);
  });

  const $v = document.getElementById('vista-contenido');
  // Por defecto, abrir en pestaña láminas
  const pestanaActual = appState.editorPestana || 'laminas';

  $v.innerHTML = `
    <div class="contenedor">
      <div class="titulo-pagina">
        <div>
          <button class="btn btn-secondary btn-pequeno" onclick="volverACatalogos()">← Catálogos</button>
          <h2 style="margin-top:8px">📗 ${escape(c.name)}</h2>
          <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
            Express · ${sheetsExpress.length} láminas seleccionadas · V${c.version} · ${c.estado}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-self:flex-start;flex-wrap:wrap">
          <button class="btn btn-secondary btn-pequeno" onclick="abrirAsignacionComerciales(${id})">👥 Asignar a comerciales</button>
          ${sheetsExpress.length > 1 ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirMosaicoLaminas(${id})" title="Reordenar láminas en mosaico visual">🔲 Mosaico</button>${ayuda('Vista en cuadrícula para reordenar las láminas. Arrastra y suelta o escribe el número de orden.')}` : ''}
          ${sheetsExpress.length > 0 ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirModalDescargarPdf(${id}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Descargar PDF del catálogo">📥 Descargar PDF</button>${ayuda('Genera el PDF del catálogo Express en alta calidad o pequeño (para enviar por WhatsApp/email a clientes).')}` : ''}
          ${sheetsExpress.length > 0 ? `<button class="btn btn-primary btn-pequeno" onclick="abrirCerrarVersion(${id}, ${c.version || 1}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Cerrar versión actual y empezar la siguiente">📌 Cerrar versión</button>${ayuda('Guarda una "foto" del catálogo Express actual: PDF+ZIP descargables, queda en historial, V1→V2. Útil para archivar ofertas pasadas (ej: ofertas mayo, ofertas verano).', 'izq')}` : ''}
          ${sheetsExpress.length > 0 ? `<button class="btn btn-danger btn-pequeno" onclick="vaciarExpress(${id}, ${sheetsExpress.length})">🗑️ Vaciar Express</button>` : ''}
        </div>
      </div>

      <!-- Pestañas Láminas / Historial (igual que el editor maestro) -->
      <div class="editor-pestanas">
        <button class="editor-pestana ${pestanaActual !== 'historial' ? 'editor-pestana-activa' : ''}" onclick="cambiarPestanaEditorExpress('laminas')">📄 Láminas (${sheetsExpress.length})</button>
        <button class="editor-pestana ${pestanaActual === 'historial' ? 'editor-pestana-activa' : ''}" onclick="cambiarPestanaEditorExpress('historial')">📚 Historial</button>
      </div>

      <div id="editor-pestana-contenido">
        ${pestanaActual === 'historial' ? '<div class="loading">Cargando historial…</div>' : ''}
      </div>
    </div>
  `;

  // Si la pestaña activa es Historial, cargarlo y salir (no pintamos las columnas)
  if (pestanaActual === 'historial') {
    pintarPestanaHistorial(id);
    return;
  }

  // Pestaña Láminas: pintar las 2 columnas dentro del contenedor de la pestaña
  const $cont = document.getElementById('editor-pestana-contenido');
  $cont.innerHTML = `
      <div class="express-grid">
        <!-- COLUMNA IZQUIERDA: laminas del maestro -->
        <div class="editor-panel express-panel">
          <div class="express-panel-header">
            <h3 style="margin:0">Láminas del maestro (${masterSheets.length})</h3>
            <button class="btn btn-primary btn-pequeno" id="btn-anadir-seleccionadas" disabled
                    onclick="anadirSeleccionadasAlExpress(${id})">
              Añadir → (<span id="contador-sel">0</span>)
            </button>
          </div>
          <input type="text" id="filtro-maestro" placeholder="🔍 Buscar en maestro (número, título o tag)..."
                 value="${escape(_expressEditor.filtroMaestro)}"
                 style="width:100%;padding:8px 12px;border:1px solid var(--gris-borde);border-radius:8px;font-size:13px;margin-bottom:8px;outline:none">
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <button class="btn btn-secondary btn-pequeno" onclick="seleccionarMaestroTodos()">Marcar todos visibles</button>
            <button class="btn btn-secondary btn-pequeno" onclick="limpiarSeleccionMaestro()">Limpiar selección</button>
          </div>
          <div class="express-lista" id="lista-maestro">
            ${masterFiltradas.length === 0
              ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">${masterSheets.length === 0 ? 'El maestro padre no tiene láminas todavía.' : 'No hay resultados con ese filtro.'}</p>`
              : masterFiltradas.map((s, idx) => {
                const yaEsta = !!s.ya_en_express;
                const seleccionada = _expressEditor.seleccionMaestro.has(s.id);
                return `
                  <div class="express-fila ${yaEsta ? 'express-fila-en-express' : ''}" data-id="${s.id}">
                    <input type="checkbox" class="express-check"
                           data-id="${s.id}"
                           ${yaEsta ? 'disabled' : ''}
                           ${seleccionada ? 'checked' : ''}
                           title="${yaEsta ? 'Ya está en el Express' : 'Seleccionar para añadir'}">
                    <div class="lamina-numero" style="font-size:11px">${s.orden}</div>
                    <img src="${escape(vurl(s.miniatura_path || s.imagen_path, s))}" class="lamina-mini" alt="" loading="lazy" decoding="async"
                         onclick="abrirLightbox('${escape(vurl(s.imagen_path, s))}', '${escape((s.titulo || 'Lámina').replace(/'/g, '\\\''))}', ${s.orden})">
                    <div class="lamina-info">
                      <div class="lamina-titulo">${escape(s.titulo || 'Sin título')}</div>
                      <div class="lamina-notas" style="font-size:11px">${escape(s.tags || '—')}</div>
                    </div>
                    ${yaEsta ? '<span class="express-badge-ya">✓ ya está</span>' : ''}
                  </div>
                `;
              }).join('')
            }
          </div>
        </div>

        <!-- COLUMNA DERECHA: laminas en el Express -->
        <div class="editor-panel express-panel">
          <div class="express-panel-header">
            <h3 style="margin:0">En este Express (${sheetsExpress.length})</h3>
            <div style="font-size:11px;color:var(--gris-texto)">arrastra ⋮⋮ para reordenar</div>
          </div>
          <input type="text" id="filtro-express" placeholder="🔍 Buscar en este Express..."
                 value="${escape(_expressEditor.filtroExpress)}"
                 style="width:100%;padding:8px 12px;border:1px solid var(--gris-borde);border-radius:8px;font-size:13px;margin-bottom:8px;outline:none">
          <div class="express-lista" id="lista-express">
            ${expressFiltradas.length === 0
              ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">${sheetsExpress.length === 0 ? 'El Express aún no tiene láminas. Marca alguna del maestro y pulsa "Añadir →".' : 'No hay resultados con ese filtro.'}</p>`
              : expressFiltradas.map((s, idx) => `
                <div class="express-fila lamina-fila" data-id="${s.id}" draggable="true">
                  <div class="drag-handle" title="Arrastra para reordenar">⋮⋮</div>
                  <div class="lamina-numero">${idx + 1}</div>
                  <img src="${escape(vurl(s.miniatura_path || s.imagen_path, s))}" class="lamina-mini" alt="" loading="lazy" decoding="async"
                       onclick="abrirLightbox('${escape(vurl(s.imagen_path, s))}', '${escape((s.titulo || 'Lámina').replace(/'/g, '\\\''))}', ${idx + 1})">
                  <div class="lamina-info">
                    <div class="lamina-titulo">${escape(s.titulo || 'Sin título')}</div>
                    <div class="lamina-notas" style="font-size:11px">${escape(s.tags || '—')}</div>
                  </div>
                  <div class="lamina-acciones">
                    <button class="btn-borrar" onclick="quitarDelExpress(${id}, ${s.id})" title="Quitar del Express">✖</button>
                  </div>
                </div>
              `).join('')
            }
          </div>
        </div>
      </div>
  `;

  // Listeners de checkboxes (maestro)
  document.querySelectorAll('#lista-maestro .express-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const sid = Number(cb.dataset.id);
      if (cb.checked) _expressEditor.seleccionMaestro.add(sid);
      else _expressEditor.seleccionMaestro.delete(sid);
      actualizarContadorSeleccion();
    });
  });
  actualizarContadorSeleccion();

  // Filtros con debounce
  const fMaestro = document.getElementById('filtro-maestro');
  if (fMaestro) {
    let t1;
    fMaestro.addEventListener('input', () => {
      clearTimeout(t1);
      t1 = setTimeout(() => {
        _expressEditor.filtroMaestro = fMaestro.value;
        pintarEditorExpress();
        // Re-poner el foco en el input
        const nv = document.getElementById('filtro-maestro');
        if (nv) { nv.focus(); nv.setSelectionRange(nv.value.length, nv.value.length); }
      }, 250);
    });
  }
  const fExpress = document.getElementById('filtro-express');
  if (fExpress) {
    let t2;
    fExpress.addEventListener('input', () => {
      clearTimeout(t2);
      t2 = setTimeout(() => {
        _expressEditor.filtroExpress = fExpress.value;
        pintarEditorExpress();
        const nv = document.getElementById('filtro-express');
        if (nv) { nv.focus(); nv.setSelectionRange(nv.value.length, nv.value.length); }
      }, 250);
    });
  }

  // Drag & drop en la lista del Express (reordenar)
  activarDragDropExpress(id);
}

function actualizarContadorSeleccion() {
  const n = _expressEditor.seleccionMaestro.size;
  const c = document.getElementById('contador-sel');
  if (c) c.textContent = n;
  const btn = document.getElementById('btn-anadir-seleccionadas');
  if (btn) btn.disabled = (n === 0);
}

function seleccionarMaestroTodos() {
  // Solo los visibles (segun filtro) Y que no esten ya en el express
  document.querySelectorAll('#lista-maestro .express-check').forEach(cb => {
    if (!cb.disabled) {
      cb.checked = true;
      _expressEditor.seleccionMaestro.add(Number(cb.dataset.id));
    }
  });
  actualizarContadorSeleccion();
}

function limpiarSeleccionMaestro() {
  _expressEditor.seleccionMaestro = new Set();
  document.querySelectorAll('#lista-maestro .express-check').forEach(cb => {
    if (!cb.disabled) cb.checked = false;
  });
  actualizarContadorSeleccion();
}

async function anadirSeleccionadasAlExpress(expressId) {
  const ids = Array.from(_expressEditor.seleccionMaestro);
  if (ids.length === 0) return;
  try {
    const r = await api('/api/catalogs/' + expressId + '/express-sheets', {
      method: 'POST',
      body: { sheet_ids: ids }
    });
    // Recargar todo
    _expressEditor.seleccionMaestro = new Set();
    const fresco = await api('/api/catalogs/' + expressId);
    _expressEditor.expressData = fresco;
    const ms = await api('/api/catalogs/' + expressId + '/master-sheets');
    _expressEditor.masterSheets = ms.sheets || [];
    pintarEditorExpress();
  } catch (err) {
    alert('Error al añadir: ' + err.message);
  }
}

async function quitarDelExpress(expressId, sheetId) {
  if (!confirm('¿Quitar esta lámina del Express? La lámina seguirá en el maestro.')) return;
  try {
    await api('/api/catalogs/' + expressId + '/express-sheets/' + sheetId, { method: 'DELETE' });
    const fresco = await api('/api/catalogs/' + expressId);
    _expressEditor.expressData = fresco;
    const ms = await api('/api/catalogs/' + expressId + '/master-sheets');
    _expressEditor.masterSheets = ms.sheets || [];
    pintarEditorExpress();
  } catch (err) {
    alert('Error al quitar: ' + err.message);
  }
}

async function vaciarExpress(expressId, total) {
  if (!confirm(`¿Quitar TODAS las ${total} láminas del Express?\n\nLas láminas seguirán en el maestro, solo se borran las referencias en este Express.`)) return;
  if (!confirm(`Confirmación final: ¿seguro?`)) return;
  try {
    await api('/api/catalogs/' + expressId + '/sheets/all', { method: 'DELETE' });
    const fresco = await api('/api/catalogs/' + expressId);
    _expressEditor.expressData = fresco;
    const ms = await api('/api/catalogs/' + expressId + '/master-sheets');
    _expressEditor.masterSheets = ms.sheets || [];
    pintarEditorExpress();
  } catch (err) {
    alert('Error al vaciar: ' + err.message);
  }
}

// Drag & drop dentro de la lista del Express (reordena la tabla express_sheets)
function activarDragDropExpress(expressId) {
  const lista = document.getElementById('lista-express');
  if (!lista) return;
  let draggedEl = null;

  lista.querySelectorAll('.lamina-fila[draggable="true"]').forEach(fila => {
    fila.addEventListener('dragstart', (e) => {
      draggedEl = fila;
      fila.classList.add('lamina-arrastrando');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', fila.dataset.id);
    });
    fila.addEventListener('dragend', () => {
      fila.classList.remove('lamina-arrastrando');
      draggedEl = null;
    });
    fila.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedEl || draggedEl === fila) return;
      // Defensa: ambos nodos tienen que ser hijos directos de la misma lista
      if (fila.parentNode !== lista || draggedEl.parentNode !== lista) return;
      const rect = fila.getBoundingClientRect();
      const mitad = rect.top + rect.height / 2;
      try {
        if (e.clientY < mitad) {
          if (fila.previousSibling !== draggedEl) {
            lista.insertBefore(draggedEl, fila);
          }
        } else {
          const ref = fila.nextSibling;
          if (ref === draggedEl) {
            // ya está en posición
          } else if (ref && ref.parentNode === lista) {
            lista.insertBefore(draggedEl, ref);
          } else {
            lista.appendChild(draggedEl);
          }
        }
      } catch (_) { /* defensa silenciosa */ }
    });
    fila.addEventListener('drop', async (e) => {
      e.preventDefault();
      // Recopilar nuevo orden
      const nuevoOrden = Array.from(lista.querySelectorAll('.lamina-fila[draggable="true"]'))
        .map(f => Number(f.dataset.id));
      try {
        await api('/api/catalogs/' + expressId + '/express-sheets/reorder', {
          method: 'PUT',
          body: { sheet_ids: nuevoOrden }
        });
        // Actualizar estado local (sin recargar todo)
        const byId = {};
        (_expressEditor.expressData.sheets || []).forEach(s => byId[s.id] = s);
        _expressEditor.expressData.sheets = nuevoOrden.map(sid => byId[sid]).filter(Boolean);
        pintarEditorExpress();
      } catch (err) {
        alert('Error al reordenar: ' + err.message);
      }
    });
  });
}

// ===== SUBIR LAMINA =====
async function subirLamina(catalogId, file) {
  const $prog = document.getElementById('upload-progreso');
  $prog.innerHTML = `<div class="subida-progreso"><span class="spinner"></span> Subiendo ${escape(file.name)}…</div>`;
  try {
    const fd = new FormData();
    fd.append('imagen', file);
    fd.append('titulo', file.name.replace(/\.[^.]+$/, '').substring(0, 100));
    await api(`/api/catalogs/${catalogId}/sheets`, { method: 'POST', body: fd });
    $prog.innerHTML = `<div class="exito-msg">✓ Lámina añadida</div>`;
    setTimeout(() => renderEditorCatalogo(catalogId), 600);
  } catch (err) {
    $prog.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

// ===== SUBIDA MASIVA (multi-archivo con renombrado automático) =====
let _bulkFiles = [];      // archivos seleccionados (con posible renombrado)
let _bulkCatalogId = null;

function abrirModalSubidaMasiva(catalogId) {
  _bulkFiles = [];
  _bulkCatalogId = catalogId;
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.id = 'modal-bulk';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:720px;max-height:90vh;overflow-y:auto">
      <div class="modal-header">
        <h3>📚 Subida masiva de láminas</h3>
        <button class="modal-cerrar" onclick="cerrarModalBulk()">×</button>
      </div>

      <div style="background:var(--surface-2);border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:14px;font-size:13px;color:#4b5563">
        <b>📋 Cómo funciona:</b>
        <ol style="margin:6px 0 0 18px;padding:0">
          <li>Selecciona varias imágenes (PNG, JPG) — hasta 50 a la vez</li>
          <li>Se ordenarán <b>alfabéticamente por nombre</b> de archivo</li>
          <li>Recomendado: numera los archivos como <code>001.png</code>, <code>002.png</code>… (ceros a la izquierda)</li>
          <li>Si no están bien numerados, marca <b>"Renombrar automáticamente"</b> abajo</li>
        </ol>
      </div>

      <div class="upload-zona" id="bulk-drop" onclick="document.getElementById('bulk-input').click()" style="margin-bottom:14px">
        <div class="upload-zona-icono">📂</div>
        <div class="upload-zona-texto">Pulsa para elegir archivos</div>
        <div class="upload-zona-sub">o arrastra y suelta aquí</div>
      </div>
      <input type="file" id="bulk-input" accept="image/*" multiple style="display:none">

      <label style="display:flex;align-items:center;gap:8px;padding:10px;background:#fef3f9;border:1px solid #f9a8d4;border-radius:8px;margin-bottom:14px;cursor:pointer">
        <input type="checkbox" id="bulk-renombrar">
        <div>
          <div style="font-weight:600;font-size:13px">Renombrar automáticamente</div>
          <div style="font-size:11px;color:#6b7280">Los renombrará a 001, 002, 003… según el orden en que los selecciones (no por su nombre original)</div>
        </div>
      </label>

      <div id="bulk-lista" style="display:none">
        <h4 style="margin:0 0 8px 0;font-size:14px">📋 Archivos seleccionados (<span id="bulk-count">0</span>)</h4>
        <div id="bulk-preview" style="max-height:300px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px;padding:6px"></div>
      </div>

      <div id="bulk-msg"></div>

      <div class="modal-acciones">
        <button type="button" class="btn btn-secondary" onclick="cerrarModalBulk()">Cancelar</button>
        <button type="button" class="btn btn-primary" id="bulk-submit" onclick="ejecutarSubidaMasiva()" disabled>📤 Subir todas</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('bulk-input').addEventListener('change', (e) => {
    procesarArchivosBulk(Array.from(e.target.files));
  });

  // Drag & drop
  const $drop = document.getElementById('bulk-drop');
  $drop.addEventListener('dragover', (e) => { e.preventDefault(); $drop.style.background = '#fef3f9'; });
  $drop.addEventListener('dragleave', () => { $drop.style.background = ''; });
  $drop.addEventListener('drop', (e) => {
    e.preventDefault();
    $drop.style.background = '';
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    procesarArchivosBulk(files);
  });

  // Listener para renombrado auto (re-pintar preview)
  document.getElementById('bulk-renombrar').addEventListener('change', pintarPreviewBulk);
}

function cerrarModalBulk() {
  _bulkFiles = [];
  _bulkCatalogId = null;
  const m = document.getElementById('modal-bulk');
  if (m) m.remove();
}

function procesarArchivosBulk(nuevos) {
  // Validar que son imágenes
  const validos = nuevos.filter(f => f.type.startsWith('image/'));
  const rechazados = nuevos.length - validos.length;
  // Acumular (permitir varias selecciones)
  _bulkFiles = _bulkFiles.concat(validos);
  // Ordenar por nombre (orden natural: "img2" antes que "img10")
  _bulkFiles.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  pintarPreviewBulk();
  if (rechazados > 0) {
    document.getElementById('bulk-msg').innerHTML =
      `<div class="error-msg">${rechazados} archivos descartados (no son imágenes).</div>`;
    setTimeout(() => { document.getElementById('bulk-msg').innerHTML = ''; }, 3000);
  }
}

function pintarPreviewBulk() {
  const $lista = document.getElementById('bulk-lista');
  const $count = document.getElementById('bulk-count');
  const $prev = document.getElementById('bulk-preview');
  const $btn = document.getElementById('bulk-submit');
  if (_bulkFiles.length === 0) {
    $lista.style.display = 'none';
    $btn.disabled = true;
    return;
  }
  $lista.style.display = 'block';
  $count.textContent = _bulkFiles.length;
  $btn.disabled = false;
  const renombrar = document.getElementById('bulk-renombrar').checked;
  // Calcular padding del número
  const pad = String(_bulkFiles.length).length;
  $prev.innerHTML = _bulkFiles.map((f, idx) => {
    const numero = String(idx + 1).padStart(pad, '0');
    const nombreFinal = renombrar
      ? `${numero}.${(f.name.split('.').pop() || 'png').toLowerCase()}`
      : f.name;
    const tamMB = (f.size / 1024 / 1024).toFixed(2);
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:6px;border-bottom:1px solid #f3f4f6">
        <span style="font-family:monospace;font-size:12px;color:#9ca3af;min-width:30px">${numero}</span>
        <span style="flex:1;font-size:13px">${escape(nombreFinal)}</span>
        <span style="font-size:11px;color:#6b7280">${tamMB} MB</span>
        <button class="btn-borrar" onclick="quitarArchivoBulk(${idx})" title="Quitar">✖</button>
      </div>
    `;
  }).join('');
  // Indicador de tamaño total
  const totalMB = (_bulkFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1);
  $prev.insertAdjacentHTML('beforeend',
    `<div style="padding:8px;text-align:right;font-size:12px;color:#6b7280;font-weight:600">Total: ${totalMB} MB</div>`
  );
}

function quitarArchivoBulk(idx) {
  _bulkFiles.splice(idx, 1);
  pintarPreviewBulk();
}

async function ejecutarSubidaMasiva() {
  if (_bulkFiles.length === 0) return;
  const $btn = document.getElementById('bulk-submit');
  const $msg = document.getElementById('bulk-msg');
  const renombrar = document.getElementById('bulk-renombrar').checked;
  const pad = String(_bulkFiles.length).length;

  $btn.disabled = true;
  // Trocear en lotes de 25 (50 es el máximo del backend, pero 25 es más estable en móvil)
  const TAMANO_LOTE = 25;
  const totalLotes = Math.ceil(_bulkFiles.length / TAMANO_LOTE);
  let subidasOK = 0;
  let erroresTotales = [];

  for (let lote = 0; lote < totalLotes; lote++) {
    const desde = lote * TAMANO_LOTE;
    const hasta = Math.min(desde + TAMANO_LOTE, _bulkFiles.length);
    const archivosLote = _bulkFiles.slice(desde, hasta);

    $msg.innerHTML = `
      <div class="subida-progreso">
        <span class="spinner"></span>
        Subiendo lote ${lote + 1} de ${totalLotes} (${archivosLote.length} archivos)…
        <br><small>Total subidas hasta ahora: ${subidasOK} de ${_bulkFiles.length}</small>
      </div>
    `;

    const fd = new FormData();
    archivosLote.forEach((f, i) => {
      let archivoFinal = f;
      if (renombrar) {
        const numero = String(desde + i + 1).padStart(pad, '0');
        const ext = (f.name.split('.').pop() || 'png').toLowerCase();
        archivoFinal = new File([f], `${numero}.${ext}`, { type: f.type });
      }
      fd.append('imagenes', archivoFinal);
    });

    // Reintento automático: hasta 3 intentos por lote
    let exitoLote = false;
    for (let intento = 1; intento <= 3 && !exitoLote; intento++) {
      try {
        const token = localStorage.getItem('cpv2_token') || '';
        const resp = await fetch(`/api/catalogs/${_bulkCatalogId}/sheets/bulk`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: fd
        });
        const json = await resp.json();
        if (json.insertadas !== undefined) {
          subidasOK += json.insertadas;
          if (json.errores && json.errores.length > 0) {
            erroresTotales = erroresTotales.concat(json.errores);
          }
          exitoLote = true;
        } else {
          throw new Error(json.error || 'Error desconocido');
        }
      } catch (err) {
        if (intento === 3) {
          erroresTotales.push({
            archivo: `Lote ${lote + 1} (${archivosLote.length} archivos)`,
            error: err.message
          });
        } else {
          // Esperar 2 segundos antes de reintentar
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  }

  // Resultado final
  if (erroresTotales.length === 0) {
    $msg.innerHTML = `
      <div class="exito-msg" style="padding:12px;font-size:14px">
        ✅ Todas las láminas subidas correctamente (${subidasOK} de ${_bulkFiles.length})
      </div>
    `;
    // Guardar el catalogId ANTES de cerrar (cerrarModalBulk lo pone a null)
    const catIdParaRecargar = _bulkCatalogId;
    setTimeout(() => {
      cerrarModalBulk();
      renderEditorCatalogo(catIdParaRecargar);
    }, 1500);
  } else {
    $msg.innerHTML = `
      <div class="error-msg" style="padding:12px;font-size:13px">
        ⚠️ ${subidasOK} de ${_bulkFiles.length} subidas. Hubo ${erroresTotales.length} errores:
        <ul style="margin:6px 0 0 16px;padding:0">
          ${erroresTotales.slice(0, 5).map(e => `<li>${escape(e.archivo)}: ${escape(e.error)}</li>`).join('')}
        </ul>
      </div>
    `;
    $btn.disabled = false;
    $btn.textContent = '📤 Reintentar fallidos';
  }
}

// ===== SUBIR PDF Y TROCEAR =====
async function subirPDF(catalogId, file) {
  const $prog = document.getElementById('upload-progreso');
  const mb = (file.size / 1024 / 1024).toFixed(1);
  if (!confirm(`Vas a subir un PDF de ${mb} MB y trocearlo en láminas automáticamente.\n\nEsto puede tardar varios minutos si el PDF es largo (cada página = 1 lámina).\n\n¿Continuar?`)) {
    return;
  }
  $prog.innerHTML = `<div class="subida-progreso"><span class="spinner"></span> Subiendo PDF de ${mb} MB y troceando… (puede tardar varios minutos)</div>`;
  try {
    const fd = new FormData();
    fd.append('pdf', file);
    const r = await api(`/api/catalogs/${catalogId}/sheets/from-pdf`, { method: 'POST', body: fd });
    $prog.innerHTML = `<div class="exito-msg">✓ ${r.laminas_creadas} láminas creadas desde el PDF</div>`;
    setTimeout(() => renderEditorCatalogo(catalogId), 800);
  } catch (err) {
    $prog.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

// ===== BORRAR LAMINA =====
async function borrarLamina(sheetId, catalogId) {
  if (!confirm('¿Borrar esta lámina? Esta acción no se puede deshacer.')) return;
  try {
    await api('/api/sheets/' + sheetId, { method: 'DELETE' });
    renderEditorCatalogo(catalogId);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Inserta una HOJA EN BLANCO justo debajo de la lámina indicada (o al principio si afterSheetId=null)
async function insertarHojaEnBlanco(afterSheetId, catalogId) {
  try {
    const r = await api('/api/catalogs/' + catalogId + '/sheets/insert-blank', {
      method: 'POST',
      body: { after_sheet_id: afterSheetId || null }
    });
    appState.editorRestoreSheetId = r.sheet.id; // volver a la hoja recién insertada
    await renderEditorCatalogo(catalogId);
    // Ofrecer DESHACER durante unos segundos
    mostrarToastDeshacer('📄 Hoja en blanco insertada', () => deshacerInsertarHoja(r.sheet.id, catalogId));
  } catch (err) {
    alert('Error al insertar hoja: ' + err.message);
  }
}

async function deshacerInsertarHoja(sheetId, catalogId) {
  try {
    await api('/api/sheets/' + sheetId, { method: 'DELETE' });
    await renderEditorCatalogo(catalogId);
    mostrarNotificacionOnline('↩️ Hoja en blanco deshecha', '#6b7280');
  } catch (err) {
    alert('Error al deshacer: ' + err.message);
  }
}

// Toast con botón "Deshacer" (se auto-cierra a los 9 s)
function mostrarToastDeshacer(texto, onDeshacer) {
  const prev = document.getElementById('toast-deshacer');
  if (prev) prev.remove();
  const t = document.createElement('div');
  t.id = 'toast-deshacer';
  t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111827;color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,0.35);z-index:99500;display:flex;align-items:center;gap:14px;font-size:14px;max-width:92vw';
  const span = document.createElement('span');
  span.textContent = texto;
  const btn = document.createElement('button');
  btn.textContent = '↩️ Deshacer';
  btn.style.cssText = 'background:#374151;color:#fff;border:0;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer;white-space:nowrap';
  btn.addEventListener('click', () => { t.remove(); onDeshacer(); });
  t.appendChild(span);
  t.appendChild(btn);
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 9000);
}

// ===== GUARDAR TAGS INLINE =====
async function guardarTagsLamina(sheetId) {
  const input = document.querySelector(`.lamina-tags-input[data-id="${sheetId}"]`);
  if (!input) return;
  const fila = input.closest('.lamina-fila');
  const btnGuardar = fila.querySelector('.btn-guardar-tags');
  const nuevoValor = input.value.trim();
  // Guardar usando endpoint que solo actualiza tags
  input.disabled = true;
  btnGuardar.disabled = true;
  btnGuardar.textContent = '⏳';
  try {
    // Cogemos titulo/notas actuales (no los tocamos)
    const titulo = fila.querySelector('.lamina-titulo').textContent.trim();
    const tituloLimpio = titulo === 'Sin título' ? '' : titulo;
    await api('/api/sheets/' + sheetId, {
      method: 'PUT',
      body: {
        titulo: tituloLimpio,
        notas: '',
        tags: nuevoValor
      }
    });
    input.dataset.original = nuevoValor;
    input.classList.remove('lamina-tags-dirty');
    btnGuardar.style.display = 'none';
    btnGuardar.textContent = '💾';
    // Actualizar los data-attrs del filtro
    fila.dataset.tags = nuevoValor.toLowerCase();
    // Feedback visual
    input.classList.add('lamina-tags-saved');
    setTimeout(() => input.classList.remove('lamina-tags-saved'), 1500);
  } catch (err) {
    alert('Error guardando tags: ' + err.message);
    btnGuardar.textContent = '💾';
  } finally {
    input.disabled = false;
    btnGuardar.disabled = false;
  }
}

// ===== FILTRAR LAMINAS EN EL EDITOR =====
function filtrarLaminasEditor(texto) {
  const t = texto.trim().toLowerCase();
  const numero = parseInt(t);
  // Si el texto empieza por #, filtra por categoría (ej: "#verano")
  const filtroCat = t.startsWith('#') ? t.substring(1) : '';
  document.querySelectorAll('#laminas-lista .lamina-fila').forEach(fila => {
    if (!t) {
      fila.style.display = '';
      return;
    }
    const titulo = fila.dataset.titulo || '';
    const tags = fila.dataset.tags || '';
    const num = fila.dataset.numero || '';
    // Nombres de categorías de esta lámina (extraídos del DOM)
    const catChipsTexto = Array.from(fila.querySelectorAll('.lamina-cat-chip'))
      .map(el => (el.textContent || '').toLowerCase()).join(' ');
    let coincide = false;
    if (filtroCat) {
      // Solo categoría
      if (catChipsTexto.includes(filtroCat)) coincide = true;
    } else {
      if (!isNaN(numero) && String(numero) === num) coincide = true;
      if (titulo.includes(t)) coincide = true;
      if (tags.includes(t)) coincide = true;
      if (catChipsTexto.includes(t)) coincide = true;
    }
    fila.style.display = coincide ? '' : 'none';
  });
}

// ===== DRAG & DROP REORDENAR LAMINAS =====
function activarDragDropLaminas(catalogId) {
  const lista = document.getElementById('laminas-lista');
  if (!lista) return;
  let arrastrando = null;
  let cambios = false;

  lista.addEventListener('dragstart', (e) => {
    const fila = e.target.closest('.lamina-fila');
    if (!fila) return;
    arrastrando = fila;
    fila.classList.add('lamina-arrastrando');
    e.dataTransfer.effectAllowed = 'move';
    // Algunos navegadores necesitan setData para que el drag funcione
    try { e.dataTransfer.setData('text/plain', String(fila.dataset.id || '')); } catch(_) {}
  });

  lista.addEventListener('dragend', async (e) => {
    const fila = e.target.closest('.lamina-fila');
    if (fila) fila.classList.remove('lamina-arrastrando');
    document.querySelectorAll('.lamina-arrastrando-target').forEach(f => f.classList.remove('lamina-arrastrando-target'));
    if (cambios) {
      cambios = false;
      // Recalcular números visibles + enviar al backend
      const filas = Array.from(lista.querySelectorAll('.lamina-fila'));
      const ids = filas.map(f => Number(f.dataset.id));
      // Actualizar UI inmediato
      filas.forEach((f, i) => {
        f.dataset.numero = String(i + 1);
        const num = f.querySelector('.lamina-numero');
        if (num) num.textContent = String(i + 1);
      });
      try {
        await api(`/api/catalogs/${catalogId}/sheets/reorder`, {
          method: 'PUT',
          body: { sheet_ids: ids }
        });
        // Pequeño feedback visual
        const $cont = document.querySelector('.editor-panel');
        if ($cont) {
          const $msg = document.createElement('div');
          $msg.className = 'exito-msg';
          $msg.style.marginBottom = '10px';
          $msg.textContent = '✓ Orden guardado';
          $cont.insertBefore($msg, lista);
          setTimeout(() => $msg.remove(), 1500);
        }
      } catch (err) {
        alert('Error guardando el orden: ' + err.message + '\n\nRecargo la lista.');
        renderEditorCatalogo(catalogId);
      }
    }
    arrastrando = null;
  });

  // Mover EN dragover (mas fiable que en drop). Pintar guia visual solo.
  lista.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!arrastrando) return;
    const target = e.target.closest('.lamina-fila');
    if (!target || target === arrastrando) return;
    // Defensa: ambos nodos tienen que ser hijos directos de la misma lista.
    // Si no, no hacemos nada (evita el error insertBefore).
    if (target.parentNode !== lista || arrastrando.parentNode !== lista) return;
    // Determinar si insertar antes o después según posición del cursor
    const rect = target.getBoundingClientRect();
    const insertarAntes = (e.clientY - rect.top) < rect.height / 2;
    try {
      if (insertarAntes) {
        // Si arrastrando ya está justo antes de target, no hacer nada
        if (target.previousSibling !== arrastrando) {
          lista.insertBefore(arrastrando, target);
          cambios = true;
        }
      } else {
        // Insertar después de target = antes de target.nextSibling.
        // Si nextSibling es null, appendChild lo pone al final.
        const ref = target.nextSibling;
        if (ref === arrastrando) {
          // ya está en posición
        } else if (ref && ref.parentNode === lista) {
          lista.insertBefore(arrastrando, ref);
          cambios = true;
        } else {
          lista.appendChild(arrastrando);
          cambios = true;
        }
      }
    } catch (_) {
      // Defensa contra cualquier caso raro de cross-browser: no rompemos la UI.
    }
    // Guia visual de "estoy sobre este target"
    document.querySelectorAll('.lamina-arrastrando-target').forEach(f => f.classList.remove('lamina-arrastrando-target'));
    target.classList.add('lamina-arrastrando-target');
  });

  // El drop solo confirma que se soltó aquí (no movemos nada, ya está movido en dragover)
  lista.addEventListener('drop', (e) => {
    e.preventDefault();
  });
}

// ===== SUSTITUIR IMAGEN (mantiene tags, orden, etc.) =====
async function sustituirImagenLamina(sheetId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm(`Sustituir la imagen de esta lámina por "${file.name}"?\n\nSe mantiene el orden, los tags y demás datos.`)) return;
    try {
      const fd = new FormData();
      fd.append('imagen', file);
      await api('/api/sheets/' + sheetId + '/image', { method: 'PUT', body: fd });
      // Refrescar la lámina visible sin recargar todo
      const fila = document.querySelector(`.lamina-fila[data-id="${sheetId}"]`);
      if (fila) {
        const img = fila.querySelector('.lamina-mini');
        // Forzar refresh visual
        const orig = img.src;
        img.src = orig + (orig.includes('?') ? '&' : '?') + 't=' + Date.now();
      }
      // Feedback
      const $cont = fila ? fila : document.querySelector('.editor-panel');
      const $msg = document.createElement('div');
      $msg.className = 'exito-msg';
      $msg.style.cssText = 'margin: 6px 0; font-size: 12px;';
      $msg.textContent = '✓ Imagen sustituida';
      $cont.parentNode.insertBefore($msg, $cont);
      setTimeout(() => $msg.remove(), 1500);
    } catch (err) {
      alert('Error sustituyendo imagen: ' + err.message);
    }
  });
  input.click();
}

// ===== BORRAR TODAS LAS LAMINAS DE UN CATALOGO =====
async function borrarTodasLaminas(catalogId, total) {
  if (!confirm(`⚠️ ATENCIÓN\n\nVas a borrar TODAS las ${total} láminas de este catálogo.\n\nEsta acción NO se puede deshacer.\n\n¿Continuar?`)) return;
  const escribe = prompt(`Para confirmar, escribe la palabra: BORRAR`);
  if (escribe !== 'BORRAR') {
    alert('No has escrito "BORRAR" correctamente. Operación cancelada.');
    return;
  }
  try {
    const r = await api(`/api/catalogs/${catalogId}/sheets/all`, { method: 'DELETE' });
    alert(`✓ ${r.eliminadas} láminas eliminadas.\n${r.archivos_borrados} archivos borrados del disco.`);
    renderEditorCatalogo(catalogId);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ===== LIGHTBOX (ver lámina grande) =====
function abrirLightbox(imagenPath, titulo, numero) {
  const div = document.createElement('div');
  div.className = 'lightbox-bg';
  div.innerHTML = `
    <button class="lightbox-cerrar" onclick="this.closest('.lightbox-bg').remove()" title="Cerrar">✕</button>
    <div class="lightbox-info">${numero}. ${escape(titulo)}</div>
    <img src="${escape(imagenPath)}" class="lightbox-img" alt="">
  `;
  div.addEventListener('click', (e) => {
    if (e.target === div) div.remove();
  });
  // Cerrar con Escape
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      div.remove();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
  document.body.appendChild(div);
}

// ===== EDITAR LAMINA =====
async function editarLamina(sheetId) {
  const cid = appState.catalogoActual;
  // Coger la lamina actual
  try {
    const r = await api('/api/catalogs/' + cid);
    const sheet = r.sheets.find(s => s.id === sheetId);
    if (!sheet) return;
    abrirModalEditarLamina(sheet, cid);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Excluir/incluir una lámina de los precios dinámicos. Se guarda AL VUELO (no espera al
// "Guardar" del formulario, que solo toca título/notas/tags).
async function togglePreciosExcluida(sheetId, chk) {
  const $m = document.getElementById('ed-precios-excluida-msg');
  const val = chk.checked;
  chk.disabled = true;
  try {
    await api('/api/sheets/' + sheetId + '/precios-modo', { method: 'PUT', body: { excluida: val } });
    if ($m) { $m.innerHTML = val ? '<span style="color:#b45309">🔒 Excluida — se exporta tal cual.</span>' : '<span style="color:#16a34a">✅ Incluida en precios dinámicos.</span>'; }
  } catch (e) { chk.checked = !val; if ($m) $m.innerHTML = '<span style="color:#dc2626">Error: ' + escape(e.message) + '</span>'; }
  chk.disabled = false;
}

function abrirModalEditarLamina(sheet, catalogId) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>Editar lámina</h3>
        <button class="modal-cerrar" onclick="cerrarEditarLaminaConAviso(this)">×</button>
      </div>
      <div id="modal-edit-error"></div>
      <div style="text-align:center;margin-bottom:1rem">
        <img src="${escape(vurl(sheet.imagen_path, sheet))}" style="max-width:200px;max-height:260px;border:1px solid var(--gris-borde);border-radius:8px">
      </div>
      <form id="form-edit-lamina">
        <div class="form-group">
          <label>Título</label>
          <input type="text" id="ed-titulo" value="${escape(sheet.titulo || '')}">
        </div>
        <div class="form-group">
          <label>Notas (oferta, condiciones...)</label>
          <textarea id="ed-notas" rows="2">${escape(sheet.notas || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Tags de búsqueda (separadas por comas)</label>
          <input type="text" id="ed-tags" value="${escape(sheet.tags || '')}" placeholder="ej: gafas, sol, coronation, oferta 12+12">
        </div>
        <div class="form-group">
          <label>🏷️ Categorías</label>
          <div id="ed-cats-cont" style="border:1px solid #d1d5db;border-radius:6px;padding:8px;min-height:42px;max-height:200px;overflow-y:auto;background:var(--surface)">
            <div style="font-size:12px;color:#9ca3af">Cargando categorías…</div>
          </div>
          <small style="color:var(--gris-texto);display:block;margin-top:4px">Gestiona las categorías en ⚙️ Configuración.</small>
        </div>
        <div class="form-group">
          <label style="display:flex;justify-content:space-between;align-items:center">
            <span>Sustituir imagen</span>
            <span style="font-size:11px;color:var(--gris-texto)">opcional</span>
          </label>
          <input type="file" id="ed-imagen" accept="image/*,application/pdf">
        </div>
        <div class="form-group">
          <button type="button" class="btn" style="width:100%;background:#0ea5e9;color:#fff"
                  onclick="abrirEditorZonas(${sheet.id}, ${catalogId})">
            🎯 Definir zonas de productos
          </button>
          <small style="color:var(--gris-texto);display:block;margin-top:4px">
            Dibuja rectángulos sobre la lámina y asigna un producto a cada uno. Los comerciales podrán pulsarlos en la visita.
          </small>
        </div>
        <div class="form-group" style="border-top:1px solid var(--gris-borde);padding-top:12px">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin:0">
            <input type="checkbox" id="ed-precios-excluida" ${sheet.precios_excluida ? 'checked' : ''} onchange="togglePreciosExcluida(${sheet.id}, this)" style="margin-top:3px;width:18px;height:18px;flex:0 0 auto">
            <span>
              <b>🔒 Excluir de los precios dinámicos</b>
              <small style="color:var(--gris-texto);display:block;margin-top:2px">Para láminas complejas (expositores con muchas referencias) que prefieres rehacer a mano. Marcada: se ve y se exporta <b>tal cual</b>, sin tocar ningún precio.</small>
            </span>
          </label>
          <div id="ed-precios-excluida-msg" style="font-size:12px;margin-top:6px"></div>
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="cerrarEditarLaminaConAviso(this)">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  // Cargar categorías disponibles + las que tiene esta lámina
  (async () => {
    try {
      const [todasR, asignadasR] = await Promise.all([
        api('/api/categorias'),
        api(`/api/sheets/${sheet.id}/categorias`)
      ]);
      const todas = todasR.categorias || [];
      const asignadasIds = new Set((asignadasR.categorias || []).map(c => c.id));
      const $cont = document.getElementById('ed-cats-cont');
      if (todas.length === 0) {
        $cont.innerHTML = `<div style="font-size:12px;color:#9ca3af">Sin categorías definidas. <a href="#" onclick="event.preventDefault();this.closest('.modal-bg').remove();irA('configuracion');">Crear categorías →</a></div>`;
        return;
      }
      $cont.innerHTML = todas.map(c => `
        <label class="cat-chip-edit">
          <input type="checkbox" name="ed-cat" value="${c.id}" ${asignadasIds.has(c.id) ? 'checked' : ''}>
          <span class="cat-chip-color" style="background:${escape(c.color || '#cc007a')}"></span>
          <span>${escape(c.nombre)}</span>
        </label>
      `).join('');
    } catch (err) {
      const $cont = document.getElementById('ed-cats-cont');
      if ($cont) $cont.innerHTML = `<div style="font-size:12px;color:#dc2626">Error: ${escape(err.message)}</div>`;
    }
  })();

  document.getElementById('form-edit-lamina').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      // 1) Actualizar texto
      await api('/api/sheets/' + sheet.id, {
        method: 'PUT',
        body: {
          titulo: document.getElementById('ed-titulo').value.trim(),
          notas: document.getElementById('ed-notas').value.trim(),
          tags: document.getElementById('ed-tags').value.trim()
        }
      });
      // 2) Guardar categorías seleccionadas
      const catIds = Array.from(document.querySelectorAll('input[name="ed-cat"]:checked')).map(i => Number(i.value));
      await api(`/api/sheets/${sheet.id}/categorias`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoria_ids: catIds })
      });
      // 3) Si hay imagen nueva, sustituirla
      const fileInput = document.getElementById('ed-imagen');
      if (fileInput.files.length > 0) {
        const fd = new FormData();
        fd.append('imagen', fileInput.files[0]);
        await api('/api/sheets/' + sheet.id + '/image', { method: 'PUT', body: fd });
      }
      modal.remove();
      appState.editorRestoreSheetId = sheet.id; // volver a esta lámina en la lista (no al principio)
      renderEditorCatalogo(catalogId);
    } catch (err) {
      document.getElementById('modal-edit-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

// Cierra el modal de editar lámina, pero avisa si hay cambios sin guardar
function cerrarEditarLaminaConAviso(btn) {
  const modal = btn.closest('.modal-bg');
  if (!modal) return;
  let hayCambios = false;
  // Comparar cada campo con su valor inicial (defaultValue)
  ['ed-titulo', 'ed-notas', 'ed-tags'].forEach(id => {
    const el = modal.querySelector('#' + id);
    if (el && el.value !== el.defaultValue) hayCambios = true;
  });
  // ¿Se ha elegido una imagen nueva sin guardar?
  const file = modal.querySelector('#ed-imagen');
  if (file && file.files && file.files.length > 0) hayCambios = true;
  if (hayCambios && !confirm('⚠️ Tienes cambios sin guardar en esta lámina.\n\n¿Cerrar sin guardar? Se perderán esos cambios.')) return;
  modal.remove();
}

// ============================================================================
// CLIENTES
// ============================================================================
let _busquedaTimer = null;
let _busquedaTokenActual = 0;

async function renderListaClientes() {
  const $v = document.getElementById('vista-contenido');
  const esAdmin = rolEfectivo() === 'admin';

  // Estructura HTML fija (no se vuelve a renderizar al buscar)
  $v.innerHTML = `
    <div class="contenedor">
      <div class="titulo-pagina">
        <div>
          <h2>Clientes ${ayuda('Cada cliente tiene un semáforo de planning: 🔴 Urgente = visita atrasada (>90 días desde última visita). 🟡 Próxima = visita pronto (entre 75-90 días). 🟢 Al día = visitado recientemente. ⚪ Sin historial = nunca visitado. El ciclo se configura en ⚙️ Configuración.')}</h2>
          <div id="clientes-resumen" style="font-size:12px;color:var(--gris-texto);margin-top:4px">cargando…</div>
        </div>
        ${esAdmin ? `<button class="btn btn-primary btn-pequeno" onclick="abrirModalImportarSage()">📊 Importar Excel Sage</button>` : ''}
      </div>

      <div style="background:var(--surface);border:1px solid var(--gris-borde);border-radius:12px;padding:1rem;margin-bottom:1rem;position:relative">
        <input type="text" id="clientes-buscar" placeholder="🔍 Buscar por nombre, CIF, código Sage o municipio (min. 2 letras)..."
               value="${escape(appState.clientesBusqueda)}"
               style="width:100%;padding:10px 14px;border:1px solid var(--gris-borde);border-radius:10px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box">
        <div id="clientes-spinner" style="position:absolute;right:24px;top:50%;transform:translateY(-50%);display:none">
          <span class="spinner"></span>
        </div>
      </div>

      <div id="clientes-lista-contenedor">
        <div class="loading">Cargando clientes…</div>
      </div>
    </div>
  `;

  // Listener del input — buscamos con debounce
  const $busca = document.getElementById('clientes-buscar');
  $busca.focus();

  $busca.addEventListener('input', () => {
    clearTimeout(_busquedaTimer);
    const valor = $busca.value.trim();

    // Si vacío → buscar al instante
    if (valor === '') {
      _busquedaTimer = setTimeout(() => {
        appState.clientesBusqueda = '';
        appState.clientesPagina = 1;
        cargarClientesYRefrescarLista();
      }, 200);
      return;
    }

    // Si menos de 2 caracteres → no buscar
    if (valor.length < 2) return;

    // Debounce 600ms
    _busquedaTimer = setTimeout(() => {
      appState.clientesBusqueda = valor;
      appState.clientesPagina = 1;
      cargarClientesYRefrescarLista();
    }, 600);
  });

  // Primera carga
  cargarClientesYRefrescarLista();
}

async function cargarClientesYRefrescarLista() {
  const $resumen = document.getElementById('clientes-resumen');
  const $contenedor = document.getElementById('clientes-lista-contenedor');
  const $spinner = document.getElementById('clientes-spinner');
  if (!$resumen || !$contenedor) return; // se cambió de pantalla

  // Marcar token de búsqueda — solo procesamos la última
  _busquedaTokenActual++;
  const miToken = _busquedaTokenActual;
  if ($spinner) $spinner.style.display = 'block';

  try {
    let clientes;
    let total;
    let pagina = appState.clientesPagina;
    let totalPaginas = 1;
    let modoOffline = false;

    // I.3: si offline, leer de IndexedDB
    if (!navigator.onLine) {
      modoOffline = true;
      try {
        clientes = await CpDB.listarClientes(appState.clientesBusqueda || '');
        total = clientes.length;
        totalPaginas = 1; // sin paginación offline
      } catch (errOff) {
        clientes = [];
        total = 0;
      }
    } else {
      const params = new URLSearchParams({
        page: appState.clientesPagina,
        limit: 50,
        search: appState.clientesBusqueda || ''
      });
      try {
        const r = await api('/api/clients?' + params.toString());
        clientes = r.clients || [];
        total = r.total;
        pagina = r.page;
        totalPaginas = r.pages || 1;
      } catch (err) {
        // Si online API falla, fallback IndexedDB
        console.warn('[I.3] API clients falló, usando IndexedDB:', err.message);
        modoOffline = true;
        try {
          clientes = await CpDB.listarClientes(appState.clientesBusqueda || '');
          total = clientes.length;
          totalPaginas = 1;
        } catch (errOff) {
          clientes = [];
          total = 0;
        }
      }
    }

    // Si esta no es la búsqueda más reciente, ignoramos
    if (miToken !== _busquedaTokenActual) return;
    if ($spinner) $spinner.style.display = 'none';

    const esAdmin = rolEfectivo() === 'admin';

    $resumen.innerHTML = `${total} ${appState.clientesBusqueda ? 'resultados' : 'clientes'}${modoOffline ? ' · <span style="color:#d97706">📲 offline (descargados)</span>' : ` · página ${pagina} de ${totalPaginas}`}`;

    let html = '';
    if (clientes.length === 0) {
      html = `
        <div class="empty-state">
          <div class="empty-state-icono">🏥</div>
          <h3>${modoOffline && !appState.clientesBusqueda ? 'Sin clientes descargados' : (appState.clientesBusqueda ? 'Sin resultados' : 'No hay clientes todavía')}</h3>
          <p>${modoOffline && !appState.clientesBusqueda
            ? 'Vuelve a conectarte e usa el botón "👥 Descargar clientes" en la pestaña Catálogos.'
            : (appState.clientesBusqueda ? 'Prueba con otra búsqueda.' : esAdmin ? 'Importa el Excel de Sage para empezar.' : 'Aún no tienes clientes asignados.')}</p>
          ${esAdmin && !appState.clientesBusqueda && !modoOffline ? `<button class="btn btn-primary" style="max-width:280px;margin:0 auto" onclick="abrirModalImportarSage()">📊 Importar Excel de Sage</button>` : ''}
        </div>
      `;
    } else {
      html = '<div class="clientes-tabla">';
      clientes.forEach(c => {
        const inactive = !c.is_active ? ' cliente-fila-baja' : '';
        html += `
          <div class="cliente-fila cliente-fila-clickable${inactive}" onclick="abrirDetalleCliente(${c.id})">
            <div class="planning-chip-mini" id="estado-cli-${c.id}" title="Estado pendiente de cargar...">${modoOffline ? '📲' : '⏳'}</div>
            <div class="cliente-fila-codigo">${escape(c.sage_code || '?')}</div>
            <div class="cliente-fila-info">
              <div class="cliente-fila-nombre">${escape(c.razon_social)} ${!c.is_active ? '<span class="cliente-baja-badge">BAJA</span>' : ''}</div>
              <div class="cliente-fila-detalles">
                ${c.cif ? `CIF: ${escape(c.cif)} · ` : ''}${c.municipio ? escape(c.municipio) + ' · ' : ''}${c.provincia ? escape(c.provincia) : ''}
                ${c.commercial_code ? ` · Com.${escape(c.commercial_code)}` : ''}
              </div>
            </div>
            <div class="cliente-fila-chevron">›</div>
          </div>
        `;
      });
      html += '</div>';

      // Cargar estados planning para esta página (async, no bloquea)
      // I.3: solo si estamos online — offline no tiene endpoint de estados
      if (!modoOffline) {
        cargarEstadosClientesEnFondo(clientes.filter(c => c.is_active).map(c => c.id));
      }

      // Paginación (solo online, offline muestra todo de IndexedDB sin paginar)
      if (!modoOffline && totalPaginas > 1) {
        html += `<div class="paginacion">
          <button class="btn btn-pequeno btn-secondary" ${pagina <= 1 ? 'disabled' : ''} onclick="paginaClientes(${pagina - 1})">← Anterior</button>
          <span style="font-size:12px;color:var(--gris-texto);align-self:center">Página ${pagina} de ${totalPaginas}</span>
          <button class="btn btn-pequeno btn-secondary" ${pagina >= totalPaginas ? 'disabled' : ''} onclick="paginaClientes(${pagina + 1})">Siguiente →</button>
        </div>`;
      }
    }
    $contenedor.innerHTML = html;
  } catch (err) {
    if (miToken !== _busquedaTokenActual) return;
    if ($spinner) $spinner.style.display = 'none';
    $contenedor.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

function paginaClientes(p) {
  appState.clientesPagina = p;
  cargarClientesYRefrescarLista();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== MODAL: IMPORTAR EXCEL SAGE =====
function abrirModalImportarSage() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>📊 Importar clientes desde Excel de Sage</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="modal-import-msg"></div>
      <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:11px;margin-bottom:1rem;font-size:12px;color:#855900;line-height:1.5">
        <b>💡 Cómo funciona:</b><br>
        El sistema lee el Excel y para cada fila:<br>
        • Si el cliente NO existe → lo crea<br>
        • Si ya existe (por código Sage) → lo actualiza<br>
        • Si empieza por "BAJA-" → lo marca como inactivo<br>
        • "CLIENTES VARIOS" se ignora
      </div>
      <div class="upload-zona" id="upload-excel-zona" onclick="document.getElementById('upload-excel-input').click()">
        <div class="upload-zona-icono">📊</div>
        <div class="upload-zona-texto">Pulsa para elegir el Excel</div>
        <div class="upload-zona-sub">.xlsx o .xls (máx 20 MB)</div>
      </div>
      <input type="file" id="upload-excel-input" accept=".xlsx,.xls" style="display:none">
      <div id="import-progreso"></div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('upload-excel-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm(`Importar "${file.name}" (${(file.size / 1024).toFixed(0)} KB)?\n\nEsto puede tardar 30-60 segundos para 3000 clientes.`)) return;
    const $prog = document.getElementById('import-progreso');
    $prog.innerHTML = `<div class="subida-progreso"><span class="spinner"></span> Importando clientes desde Excel…</div>`;
    try {
      const fd = new FormData();
      fd.append('excel', file);
      const r = await api('/api/clients/import-sage', { method: 'POST', body: fd });
      $prog.innerHTML = `
        <div class="exito-msg" style="text-align:left;line-height:1.7">
          ✅ ${escape(r.mensaje)}<br>
          • Nuevos: <b>${r.nuevos}</b><br>
          • Actualizados: <b>${r.actualizados}</b><br>
          • Dados de baja: <b>${r.dados_de_baja}</b><br>
          • Ignorados: ${r.ignorados}<br>
          • Errores: ${r.errores}<br>
          <br><b>Total clientes en BD: ${r.total_en_bd}</b>
        </div>
      `;
      setTimeout(() => {
        modal.remove();
        renderListaClientes();
      }, 2500);
    } catch (err) {
      $prog.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

// ============================================================================
// COMERCIALES (admin only)
// ============================================================================
async function renderListaComerciales() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando comerciales…</div></div>`;
  try {
    const r = await api('/api/users');
    const usuarios = r.users || [];

    let html = `
      <div class="contenedor">
        <div class="titulo-pagina">
          <div>
            <h2>Comerciales y usuarios</h2>
            <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
              ${usuarios.length} usuarios · ${usuarios.filter(u => u.role === 'admin').length} admin · ${usuarios.filter(u => u.role === 'sales').length} comerciales
            </div>
          </div>
          <button class="btn btn-primary btn-pequeno" onclick="abrirModalNuevoUsuario()">+ Nuevo usuario</button>
        </div>

        <div class="comerciales-lista">
    `;

    usuarios.forEach(u => {
      const esYo = u.id === user.id;
      const inactiveCls = !u.is_active ? ' comercial-inactivo' : '';
      const rolBadge = u.role === 'admin'
        ? '<span class="rol-badge rol-admin">ADMIN</span>'
        : '<span class="rol-badge rol-sales">COMERCIAL</span>';
      html += `
        <div class="comercial-card${inactiveCls}">
          <div class="comercial-card-info">
            <div class="comercial-card-cabecera">
              <span class="comercial-nombre">${escape(u.name)}</span>
              ${rolBadge}
              ${esYo ? '<span class="rol-badge rol-yo">TÚ</span>' : ''}
              ${!u.is_active ? '<span class="rol-badge rol-baja">INACTIVO</span>' : ''}
            </div>
            <div class="comercial-card-detalles">
              📧 ${escape(u.email)}
              ${u.sage_commercial_code ? ` · 🏷️ Sage: ${escape(u.sage_commercial_code)}` : ' · <span style="color:#999">sin código Sage</span>'}
            </div>
          </div>
          <div class="comercial-card-acciones">
            <button class="btn btn-pequeno btn-secondary" onclick="editarUsuario(${u.id})" title="Editar">✏️ Editar</button>
            <button class="btn btn-pequeno btn-secondary" onclick="cambiarContraseñaUsuario(${u.id}, '${escape(u.name)}')" title="Cambiar contraseña">🔑 Contraseña</button>
            ${!esYo ? `<button class="btn btn-pequeno btn-danger" onclick="desactivarUsuario(${u.id}, '${escape(u.name)}')" title="${u.is_active ? 'Desactivar' : 'Ya inactivo'}" ${!u.is_active ? 'disabled' : ''}>🗑️</button>` : ''}
          </div>
        </div>
      `;
    });

    html += '</div></div>';
    $v.innerHTML = html;
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

function abrirModalNuevoUsuario() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>+ Nuevo usuario</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="modal-user-error"></div>
      <form id="form-nuevo-user">
        <div class="form-group">
          <label>Nombre completo</label>
          <input type="text" id="u-name" required placeholder="Ej: Iván García">
        </div>
        <div class="form-group">
          <label>Email</label>
          <input type="email" id="u-email" required placeholder="ivan@lomhifar.com">
        </div>
        <div class="form-group">
          <label>Contraseña inicial</label>
          <input type="text" id="u-password" required placeholder="Ej: lomhifar2026" value="lomhifar2026">
          <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">El usuario la podrá cambiar después.</div>
        </div>
        <div class="form-group">
          <label>Rol</label>
          <select id="u-role">
            <option value="sales">Comercial</option>
            <option value="admin">Administrador</option>
          </select>
        </div>
        <div class="form-group">
          <label>Código comercial Sage</label>
          <input type="text" id="u-sage" placeholder="Ej: 1, 2, 6...">
          <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Necesario para que vea solo SUS clientes. Mira el Excel de Sage para identificarlo.</div>
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Crear</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('form-nuevo-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = {
        name: document.getElementById('u-name').value.trim(),
        email: document.getElementById('u-email').value.trim(),
        password: document.getElementById('u-password').value,
        role: document.getElementById('u-role').value,
        sage_commercial_code: document.getElementById('u-sage').value.trim()
      };
      await api('/api/users', { method: 'POST', body: data });
      modal.remove();
      renderListaComerciales();
    } catch (err) {
      document.getElementById('modal-user-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

async function editarUsuario(id) {
  try {
    const r = await api('/api/users');
    const u = (r.users || []).find(x => x.id === id);
    if (!u) return;

    const modal = document.createElement('div');
    modal.className = 'modal-bg';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h3>Editar usuario</h3>
          <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
        </div>
        <div id="modal-edit-user-error"></div>
        <form id="form-edit-user">
          <div class="form-group">
            <label>Nombre completo</label>
            <input type="text" id="eu-name" required value="${escape(u.name)}">
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="eu-email" required value="${escape(u.email)}">
          </div>
          <div class="form-group">
            <label>Rol</label>
            <select id="eu-role" ${u.id === user.id ? 'disabled' : ''}>
              <option value="sales" ${u.role === 'sales' ? 'selected' : ''}>Comercial</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option>
            </select>
            ${u.id === user.id ? '<div style="font-size:11px;color:var(--gris-texto);margin-top:4px">No puedes cambiar tu propio rol.</div>' : ''}
          </div>
          <div class="form-group">
            <label>Código comercial Sage</label>
            <input type="text" id="eu-sage" value="${escape(u.sage_commercial_code || '')}">
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="eu-active" ${u.is_active ? 'checked' : ''} style="width:auto">
              <span>Usuario activo</span>
            </label>
          </div>
          <div class="modal-acciones">
            <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
            <button type="submit" class="btn btn-primary">Guardar</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('form-edit-user').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = {
          name: document.getElementById('eu-name').value.trim(),
          email: document.getElementById('eu-email').value.trim(),
          role: document.getElementById('eu-role').value,
          sage_commercial_code: document.getElementById('eu-sage').value.trim(),
          is_active: document.getElementById('eu-active').checked
        };
        await api('/api/users/' + id, { method: 'PUT', body: data });
        modal.remove();
        renderListaComerciales();
      } catch (err) {
        document.getElementById('modal-edit-user-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
      }
    });
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function cambiarContraseñaUsuario(id, nombre) {
  const nueva = prompt(`Nueva contraseña para ${nombre}:\n(mínimo 4 caracteres)`);
  if (!nueva) return;
  if (nueva.length < 4) {
    alert('La contraseña debe tener al menos 4 caracteres');
    return;
  }
  api('/api/users/' + id + '/password', { method: 'PUT', body: { new_password: nueva } })
    .then(() => alert(`Contraseña de ${nombre} cambiada correctamente.\n\nNueva contraseña: ${nueva}\n\nApúntala bien antes de cerrar.`))
    .catch(err => alert('Error: ' + err.message));
}

function desactivarUsuario(id, nombre) {
  if (!confirm(`¿Desactivar a "${nombre}"?\n\nEl usuario no podrá entrar más, pero su historial se conserva.\n\nPuedes reactivarlo desde el botón Editar.`)) return;
  api('/api/users/' + id, { method: 'DELETE' })
    .then(() => renderListaComerciales())
    .catch(err => alert('Error: ' + err.message));
}

// ============================================================================
// MI CUENTA
// ============================================================================
async function renderMiCuenta() {
  const $v = document.getElementById('vista-contenido');
  // Refrescar perfil del usuario para tener el toggle de notificaciones al día
  try {
    const r = await api('/api/users/me');
    if (r.user) {
      user.recibir_notificaciones = r.user.recibir_notificaciones !== false;
      try { localStorage.setItem('cpv2_user', JSON.stringify(user)); } catch (_) {}
    }
  } catch (_) { /* no bloquea si falla */ }
  $v.innerHTML = `
    <div class="contenedor" style="max-width:600px">
      <div class="titulo-pagina">
        <div>
          <h2>⚙️ Mi cuenta</h2>
          <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">${escape(user.name)} · ${user.role === 'admin' ? 'Administrador' : 'Comercial'}</div>
        </div>
      </div>

      <div class="editor-panel" style="margin-bottom:1rem">
        <h3>🔑 Cambiar mi contraseña</h3>
        <div id="cuenta-pass-msg"></div>
        <form id="form-mi-pass">
          <div class="form-group">
            <label>Contraseña actual</label>
            <input type="password" id="mp-actual" required autocomplete="current-password">
          </div>
          <div class="form-group">
            <label>Contraseña nueva (mín. 4 caracteres)</label>
            <input type="password" id="mp-nueva" required autocomplete="new-password">
          </div>
          <div class="form-group">
            <label>Repite la contraseña nueva</label>
            <input type="password" id="mp-confirma" required autocomplete="new-password">
          </div>
          <button type="submit" class="btn btn-primary">Cambiar contraseña</button>
        </form>
      </div>

      <div class="editor-panel">
        <h3>🏷️ Mi código comercial Sage</h3>
        <div id="cuenta-sage-msg"></div>
        <form id="form-mi-sage">
          <div class="form-group">
            <label>Código actual</label>
            <input type="text" id="ms-sage" placeholder="Ej: 1, 2, 6..." value="${escape(user.sage_commercial_code || '')}">
            <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">
              Es el número que te identifica como comercial en Sage. Si tienes dudas, pregunta al administrador.
            </div>
          </div>
          <button type="submit" class="btn btn-primary">Guardar código Sage</button>
        </form>
      </div>

      ${user.role === 'sales' ? `
      <div class="editor-panel" style="margin-top:1rem">
        <h3>🔔 Notificaciones por email ${ayuda('Si está activado, recibirás emails cuando: (1) se cierre una versión de un catálogo asignado a ti, (2) se suba o reemplace una formación en el aula a la que tengas acceso. Si está desactivado, no recibes ningún email.')}</h3>
        <p style="font-size:13px;color:var(--gris-texto);margin:0 0 12px 0">
          Recibe un email cuando se publique una nueva versión de un catálogo asignado a ti.
        </p>
        <div id="cuenta-notif-msg"></div>
        <label class="notif-toggle">
          <input type="checkbox" id="notif-toggle" ${(user.recibir_notificaciones !== false) ? 'checked' : ''}>
          <span class="notif-toggle-text"><b id="notif-toggle-label">${(user.recibir_notificaciones !== false) ? '✓ Activadas' : '✗ Desactivadas'}</b></span>
        </label>
      </div>
      ` : ''}
    </div>
  `;

  document.getElementById('form-mi-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const actual = document.getElementById('mp-actual').value;
    const nueva = document.getElementById('mp-nueva').value;
    const confirma = document.getElementById('mp-confirma').value;
    const $msg = document.getElementById('cuenta-pass-msg');
    if (nueva !== confirma) {
      $msg.innerHTML = '<div class="error-msg">Las contraseñas nuevas no coinciden</div>';
      return;
    }
    if (nueva.length < 4) {
      $msg.innerHTML = '<div class="error-msg">La nueva contraseña debe tener al menos 4 caracteres</div>';
      return;
    }
    try {
      await api('/api/users/me/password', { method: 'PUT', body: { current_password: actual, new_password: nueva } });
      $msg.innerHTML = '<div class="exito-msg">✓ Contraseña cambiada correctamente</div>';
      document.getElementById('form-mi-pass').reset();
    } catch (err) {
      $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });

  document.getElementById('form-mi-sage').addEventListener('submit', async (e) => {
    e.preventDefault();
    const valor = document.getElementById('ms-sage').value.trim();
    const $msg = document.getElementById('cuenta-sage-msg');
    try {
      await api('/api/users/me/sage-code', { method: 'PUT', body: { sage_commercial_code: valor } });
      // Actualizar el user local
      user.sage_commercial_code = valor;
      localStorage.setItem('cpv2_user', JSON.stringify(user));
      $msg.innerHTML = '<div class="exito-msg">✓ Código Sage actualizado</div>';
    } catch (err) {
      $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });

  // Toggle notificaciones email (solo si es comercial)
  const $notif = document.getElementById('notif-toggle');
  if ($notif) {
    $notif.addEventListener('change', async () => {
      const $msg = document.getElementById('cuenta-notif-msg');
      const $label = document.getElementById('notif-toggle-label');
      const recibir = $notif.checked;
      try {
        await api('/api/users/me/notificaciones', { method: 'PUT', body: { recibir } });
        user.recibir_notificaciones = recibir;
        localStorage.setItem('cpv2_user', JSON.stringify(user));
        $label.textContent = recibir ? '✓ Activadas' : '✗ Desactivadas';
        $msg.innerHTML = '<div class="exito-msg" style="margin-bottom:8px">✓ Guardado</div>';
        setTimeout(() => { if ($msg) $msg.innerHTML = ''; }, 2000);
      } catch (err) {
        // Revertir el toggle
        $notif.checked = !recibir;
        $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
      }
    });
  }
}

// ============================================================================
// VISOR COMERCIAL (tablet vertical, modo presentacion + mosaico + zoom)
// ============================================================================
let _visorSheets = []; // cache de laminas del catalogo actual
let _visorCatalog = null;

async function renderVisorComercial(catalogId) {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando catálogo…</div></div>`;
  try {
    let catalog, sheets;
    let modoOffline = false;

    // I.2: si offline o si la API falla, intentar cargar desde IndexedDB
    if (!navigator.onLine) {
      modoOffline = true;
      catalog = await CpDB.obtenerCatalogo(catalogId);
      if (!catalog) throw new Error('Este catálogo no está descargado offline. Vuelve a conectarte para usarlo.');
      const laminasDB = await CpDB.obtenerLaminasDeCatalogo(catalogId);
      // Convertir Blobs a URLs object para que las <img> los muestren
      sheets = laminasDB.map(s => ({
        ...s,
        imagen_path: s.imagen_blob ? URL.createObjectURL(s.imagen_blob) : s.imagen_path_original,
        _es_blob_url: !!s.imagen_blob
      }));
    } else {
      try {
        const r = await api('/api/catalogs/' + catalogId);
        catalog = r.catalog;
        sheets = (r.sheets || []).filter(s => !s.oculta);
      } catch (err) {
        // Si la API falla pero navegador dice online, intentar IndexedDB
        console.warn('[I.2] API falló en visor, probando IndexedDB:', err.message);
        catalog = await CpDB.obtenerCatalogo(catalogId);
        if (!catalog) throw err; // sin copia offline, devuelve el error original
        modoOffline = true;
        const laminasDB = await CpDB.obtenerLaminasDeCatalogo(catalogId);
        sheets = laminasDB.map(s => ({
          ...s,
          imagen_path: s.imagen_blob ? URL.createObjectURL(s.imagen_blob) : s.imagen_path_original,
          _es_blob_url: !!s.imagen_blob
        }));
      }
    }

    _visorCatalog = catalog;
    _visorSheets = sheets;
    // I.2: guardar flag de offline para mostrar aviso en cabecera
    _visorModoOffline = modoOffline;

    // B6: si hay visita activa, cargar anotaciones para pintarlas en el visor
    if (appState.visitaActiva) {
      // En offline las anotaciones también vienen de IndexedDB (próxima sesión I.3)
      // De momento: si offline, dejar vacío. Si online, cargar normalmente.
      if (!modoOffline) {
        await cargarAnotacionesDeVisita();
      } else {
        _anotacionesVisita = {};
      }
    } else {
      _anotacionesVisita = {};
    }

    if (_visorSheets.length === 0) {
      $v.innerHTML = `
        <div class="contenedor">
          <div class="titulo-pagina">
            <button class="btn btn-secondary btn-pequeno" onclick="volverACatalogos()">← Catálogos</button>
          </div>
          <div class="empty-state">
            <div class="empty-state-icono">📄</div>
            <h3>Este catálogo está vacío</h3>
            <p>${modoOffline ? 'No hay láminas descargadas para uso offline.' : 'El administrador aún no ha subido láminas.'}</p>
          </div>
        </div>
      `;
      return;
    }

    // Si el indice esta fuera de rango, reset
    if (appState.visorIndice >= _visorSheets.length) appState.visorIndice = 0;

    pintarVisor();
  } catch (err) {
    $v.innerHTML = `
      <div class="contenedor">
        <div class="titulo-pagina">
          <button class="btn btn-secondary btn-pequeno" onclick="volverACatalogos()">← Catálogos</button>
        </div>
        <div class="error-msg" style="margin-top:1rem">${escape(err.message)}</div>
      </div>
    `;
  }
}

// I.2: flag global del visor offline
let _visorModoOffline = false;

// I.3: precarga de laminas vecinas (anterior, siguiente, +2) para navegacion instantanea
// Solo crea Image() en memoria; el navegador la descarga en background y la cachea.
function precargarVecinasVisor(sheets, idx) {
  if (!Array.isArray(sheets) || sheets.length === 0) return;
  [idx - 1, idx + 1, idx + 2].forEach(i => {
    if (i >= 0 && i < sheets.length && sheets[i] && sheets[i].imagen_path) {
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = vurl(sheets[i].imagen_path, sheets[i]);
      } catch (_) {}
    }
  });
}

function pintarVisor() {
  const $v = document.getElementById('vista-contenido');
  const totalReal = _visorSheets.length;
  const busca = appState.visorBusqueda.trim().toLowerCase();
  const filtroCatId = appState.visorFiltroCat || null;

  // Filtrar por búsqueda Y/O filtro de categoría
  let visibles = _visorSheets;
  if (filtroCatId) {
    visibles = visibles.filter(s => (s.categorias || []).some(c => c.id === filtroCatId));
  }
  if (busca) {
    // Búsqueda por número de lámina o por texto (incluye nombres de categorías)
    const numero = parseInt(busca);
    visibles = visibles.filter((s, i) => {
      if (!isNaN(numero) && (i + 1) === numero) return true;
      const catsNombres = (s.categorias || []).map(c => c.nombre).join(' ');
      const blob = [s.titulo, s.notas, s.tags, catsNombres].filter(Boolean).join(' ').toLowerCase();
      return blob.includes(busca);
    });
  }

  // Cabecera (común a los dos modos)
  const cabecera = `
    <div class="visor-cabecera">
      ${_visorModoOffline ? `
        <div class="visor-aviso-offline">
          📲 Estás viendo este catálogo <b>desde la copia descargada en este dispositivo</b> (modo offline)
        </div>
      ` : ''}
      <div class="visor-cabecera-fila">
        <button class="btn-icon-volver" onclick="volverACatalogos()" title="Volver a catálogos">←</button>
        <div class="visor-titulo-bloque">
          <div class="visor-titulo">${escape(_visorCatalog.name)}</div>
          <div class="visor-subtitulo">${totalReal} láminas${busca ? ` · ${visibles.length} resultados` : ''}</div>
        </div>
        ${appState.visitaActiva ? `<div style="display:flex;align-items:center">${ayuda('Estás en visita. Toca las zonas marcadas sobre las láminas para añadir productos al pedido (aparecen al pasar el dedo o ratón). También puedes anotar manualmente con el icono ✏️. Al terminar, pulsa "Cerrar visita" para enviar el pedido.', 'abajo')}</div>` : ''}
        <div class="visor-modo-switch">
          ${appState.visitaActiva ? `<button class="visor-modo-btn" onclick="abrirModalUltimaVisita(${appState.visitaActiva.client_id})" title="Última visita con este cliente">📋</button>` : ''}
          <button class="visor-modo-btn" onclick="abrirModalDescargarCatalogo(${_visorCatalog.id}, '${escape((_visorCatalog.name || '').replace(/'/g, "\\'"))}')" title="Descargar catálogo">📥</button>
          <button class="visor-modo-btn ${appState.visorModo === 'presentacion' ? 'activo' : ''}" onclick="cambiarVisorModo('presentacion')" title="Modo presentación">
            📺
          </button>
          <button class="visor-modo-btn ${appState.visorModo === 'mosaico' ? 'activo' : ''}" onclick="cambiarVisorModo('mosaico')" title="Modo mosaico">
            ▦
          </button>
        </div>
      </div>
      <div class="visor-buscador-fila">
        <input type="text" id="visor-buscar" placeholder="🔍 Buscar (nombre, oferta, número de lámina, categoría…)"
               value="${escape(appState.visorBusqueda)}"
               class="visor-buscador">
        ${appState.visorBusqueda ? '<button class="visor-buscador-clear" onclick="limpiarVisorBusqueda()">✕</button>' : ''}
      </div>
      ${(() => {
        // Recopilar todas las categorías que aparecen en este catálogo
        const catsMap = {};
        _visorSheets.forEach(s => (s.categorias || []).forEach(c => { catsMap[c.id] = c; }));
        const cats = Object.values(catsMap);
        if (cats.length === 0) return '';
        return `
          <div class="visor-chips-cats">
            <button class="visor-chip-cat ${!appState.visorFiltroCat ? 'visor-chip-cat-activo' : ''}" onclick="filtrarVisorPorCategoria(null)">
              Todas (${_visorSheets.length})
            </button>
            ${cats.map(c => {
              const num = _visorSheets.filter(s => (s.categorias || []).some(sc => sc.id === c.id)).length;
              return `<button class="visor-chip-cat ${appState.visorFiltroCat === c.id ? 'visor-chip-cat-activo' : ''}"
                       style="${appState.visorFiltroCat === c.id ? `background:${escape(c.color || '#cc007a')};color:#fff;border-color:${escape(c.color || '#cc007a')}` : `color:${escape(c.color || '#cc007a')};border-color:${escape(c.color || '#cc007a')}40`}"
                       onclick="filtrarVisorPorCategoria(${c.id})">${escape(c.nombre)} (${num})</button>`;
            }).join('')}
          </div>
        `;
      })()}
    </div>
  `;

  // Cuerpo según el modo
  let cuerpo = '';
  if (appState.visorModo === 'mosaico') {
    cuerpo = pintarMosaico(visibles);
  } else {
    cuerpo = pintarPresentacion(visibles);
  }

  // Botón flotante del CARRITO de la visita (acceso rápido al pedido en curso)
  let carritoFab = '';
  if (appState.visitaActiva) {
    const n = carritoContarLineas();
    carritoFab = `<button class="carrito-fab" onclick="abrirCarritoVisita()" title="Ver el pedido de esta visita">🛒 Pedido${n > 0 ? ` <span class="carrito-fab-badge">${n}</span>` : ''}</button>`;
  }

  $v.innerHTML = `<div class="visor-shell">${cabecera}${cuerpo}${carritoFab}</div>`;

  // Si el carrito estaba abierto (p.ej. tras editar una línea), refrescar su contenido
  if (_carritoAbierto) renderCarritoContenido();

  // Listener de búsqueda con debounce
  const $busca = document.getElementById('visor-buscar');
  if ($busca) {
    let timer;
    $busca.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        appState.visorBusqueda = $busca.value;
        if (appState.visorModo === 'presentacion') {
          appState.visorIndice = 0;
        }
        pintarVisor();
        // Mantener foco
        setTimeout(() => {
          const $b = document.getElementById('visor-buscar');
          if ($b) {
            $b.focus();
            const len = $b.value.length;
            $b.setSelectionRange(len, len);
          }
        }, 0);
      }, 400);
    });
  }

  // Engancha controles del modo presentacion
  if (appState.visorModo === 'presentacion') {
    engancharGestosPresentacion();
  }
}

function pintarPresentacion(visibles) {
  if (visibles.length === 0) {
    return `
      <div class="visor-vacio">
        <div class="empty-state-icono">🔍</div>
        <h3>Sin resultados</h3>
        <p>No hay láminas que coincidan con "${escape(appState.visorBusqueda)}"</p>
      </div>
    `;
  }

  if (appState.visorIndice >= visibles.length) appState.visorIndice = 0;
  const sheet = visibles[appState.visorIndice];
  const numeroOriginal = _visorSheets.indexOf(sheet) + 1;
  const prevDisabled = appState.visorIndice === 0 ? 'disabled' : '';
  const nextDisabled = appState.visorIndice === visibles.length - 1 ? 'disabled' : '';

  // B7: pins X+Y sobre la imagen (solo si hay visita activa y la anotacion tiene pos)
  const anots = appState.visitaActiva ? (_anotacionesVisita[sheet.id] || []) : [];
  const pins = anots
    .filter(a => a.pos_x != null && a.pos_y != null)
    .map((a, idx) => {
      const num = idx + 1;
      const icon = a.tipo === 'pedido' ? '🛒' : a.tipo === 'devolucion' ? '↩️' : '📝';
      const colorPin = a.tipo === 'pedido' ? '#166534' : a.tipo === 'devolucion' ? '#92400e' : '#374151';
      const xPct = (a.pos_x * 100).toFixed(2);
      const yPct = (a.pos_y * 100).toFixed(2);
      return `<button class="visor-pin" style="left:${xPct}%;top:${yPct}%;background:${colorPin}"
              onclick="event.stopPropagation();abrirDetallePin(${a.id})"
              title="${escape(a.texto_libre)}">
              <span class="visor-pin-num">${num}</span>
              <span class="visor-pin-icon">${icon}</span>
            </button>`;
    }).join('');

  // Precargar laminas vecinas para que el deslizar siguiente/anterior sea instantaneo
  precargarVecinasVisor(visibles, appState.visorIndice);

  return `
    <div class="visor-presentacion">
      <div class="visor-nav-superior">
        <button class="visor-nav-btn" ${prevDisabled} onclick="visorAnterior()">◀ Anterior</button>
        <div class="visor-contador">
          <span class="visor-contador-num">${numeroOriginal}</span>
          <span class="visor-contador-total">/ ${_visorSheets.length}</span>
        </div>
        <button class="visor-nav-btn" ${nextDisabled} onclick="visorSiguiente()">Siguiente ▶</button>
        <button class="visor-fullscreen-btn" onclick="entrarPantallaCompleta()" title="Modo pantalla completa">⛶<span class="visor-fullscreen-btn-texto"> Pantalla completa</span></button>
      </div>

      <div class="visor-imagen-contenedor" id="visor-img-contenedor">
        <div class="visor-imagen-zoom" id="visor-img-zoom" style="transform: translate(${appState.visorPanX||0}px, ${appState.visorPanY||0}px) scale(${appState.visorZoom})">
          <div class="visor-imagen-wrapper" id="visor-imagen-wrapper" data-sheet-id="${sheet.id}">
            <img src="${escape(vurl(sheet.imagen_path, sheet))}" class="visor-imagen" id="visor-imagen" alt="${escape(sheet.titulo || '')}" draggable="false" onload="pintarRecuadrosPrecio()">
            ${pins}
            <div class="visor-recuadros-capa" id="visor-recuadros-capa"></div>
            <div class="visor-zonas-capa" id="visor-zonas-capa"></div>
          </div>
        </div>
        ${appState.visorZoom > 1 ? `
          <button class="visor-zoom-reset" onclick="visorZoomReset()" title="Quitar zoom">
            🔍 Reset zoom (${appState.visorZoom.toFixed(1)}×)
          </button>
        ` : ''}
      </div>

      ${(sheet.titulo || sheet.notas) ? `
        <div class="visor-info-lamina">
          ${sheet.titulo ? `<div class="visor-info-titulo">${escape(sheet.titulo)}</div>` : ''}
          ${sheet.notas ? `<div class="visor-info-notas">${escape(sheet.notas)}</div>` : ''}
        </div>
      ` : ''}

      <!-- F5 export: compartir con precios de HOY + ofertas horneados -->
      <div class="visor-export-bar">
        <button class="btn btn-secondary btn-pequeno" onclick="descargarLaminaHoy(${sheet.id})" title="Descarga esta lámina con los precios de hoy y las ofertas ya pintados (para WhatsApp, email...)">📥 Lámina con precios de hoy</button>
        <button class="btn btn-secondary btn-pequeno" onclick="descargarPdfCatalogoHoy(${_visorCatalog ? _visorCatalog.id : 'null'}, this)" title="Genera un PDF de TODO el catálogo con los precios de hoy y las ofertas">📄 PDF del catálogo (hoy)</button>
      </div>

      ${appState.visitaActiva ? pintarPanelAnotaciones(sheet, numeroOriginal) : ''}

      <div class="visor-zoom-hint">
        💡 Pellizca con 2 dedos para hacer zoom · doble toque para zoom rápido · desliza para navegar${appState.visitaActiva ? ' · <b>mantén pulsado para crear un pin</b> 📍' : ''}
      </div>
    </div>
  `;
}

// B6: panel de anotaciones de una lámina dentro del visor (solo si visita activa)
function pintarPanelAnotaciones(sheet, numero) {
  const sid = sheet.id;
  const anots = _anotacionesVisita[sid] || [];
  return `
    <div class="visor-anotaciones">
      <div class="visor-anotaciones-header">
        <span>📝 Anotaciones para esta lámina (${anots.length})</span>
        <button class="btn btn-primary btn-pequeno" onclick="abrirModalAnotar(${sid}, ${JSON.stringify(sheet.titulo || '').replace(/"/g,'&quot;')}, ${numero})">+ Anotar</button>
      </div>
      ${anots.length === 0
        ? `<div class="visor-anotaciones-vacio">Aún no has anotado nada en esta lámina.</div>`
        : `<div class="visor-anotaciones-lista">
            ${anots.map(a => {
              const icon = a.tipo === 'pedido' ? '🛒' : a.tipo === 'devolucion' ? '↩️' : '📝';
              return `
                <div class="anot-chip">
                  <span class="anot-chip-icon">${icon}</span>
                  <span class="anot-chip-texto">${escape(a.texto_libre)}</span>
                  <button class="anot-chip-btn" onclick="editarAnotacion(${a.id}, ${sid}, ${JSON.stringify(a.texto_libre).replace(/"/g,'&quot;')}, '${a.tipo}')" title="Editar">✏️</button>
                  <button class="anot-chip-btn anot-chip-btn-borrar" onclick="borrarAnotacion(${a.id}, ${sid})" title="Borrar">🗑️</button>
                </div>
              `;
            }).join('')}
          </div>`
      }
    </div>
  `;
}

function pintarMosaico(visibles) {
  if (visibles.length === 0) {
    return `
      <div class="visor-vacio">
        <div class="empty-state-icono">🔍</div>
        <h3>Sin resultados</h3>
        <p>No hay láminas que coincidan con "${escape(appState.visorBusqueda)}"</p>
      </div>
    `;
  }
  return `
    <div class="visor-mosaico">
      ${visibles.map((s) => {
        const idxOriginal = _visorSheets.indexOf(s);
        const numeroOriginal = idxOriginal + 1;
        const anots = (appState.visitaActiva && _anotacionesVisita[s.id]) ? _anotacionesVisita[s.id].length : 0;
        return `
          <div class="visor-mosaico-celda" onclick="abrirLaminaDesdeMosaico(${idxOriginal})">
            <img src="${escape(vurl(s.miniatura_path || s.imagen_path, s))}" class="visor-mosaico-img" alt="" loading="lazy" decoding="async">
            <div class="visor-mosaico-num">${numeroOriginal}</div>
            ${anots > 0 ? `<div class="visor-mosaico-anots" title="${anots} anotaciones">📝 ${anots}</div>` : ''}
            ${s.titulo ? `<div class="visor-mosaico-titulo">${escape(s.titulo)}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function cambiarVisorModo(modo) {
  appState.visorModo = modo;
  appState.visorZoom = 1;
  appState.visorPanX = 0;
  appState.visorPanY = 0;
  pintarVisor();
}

function visorAnterior() {
  if (appState.visorIndice > 0) {
    appState.visorIndice--;
    appState.visorZoom = 1;
    appState.visorPanX = 0;
    appState.visorPanY = 0;
    pintarVisor();
  }
}

function visorSiguiente() {
  const busca = appState.visorBusqueda.trim().toLowerCase();
  const visibles = busca ? _visorSheets.filter((s, i) => {
    const numero = parseInt(busca);
    if (!isNaN(numero) && (i + 1) === numero) return true;
    const blob = [s.titulo, s.notas, s.tags].filter(Boolean).join(' ').toLowerCase();
    return blob.includes(busca);
  }) : _visorSheets;

  if (appState.visorIndice < visibles.length - 1) {
    appState.visorIndice++;
    appState.visorZoom = 1;
    appState.visorPanX = 0;
    appState.visorPanY = 0;
    pintarVisor();
  }
}

function visorZoomReset() {
  appState.visorZoom = 1;
  appState.visorPanX = 0;
  appState.visorPanY = 0;
  pintarVisor();
}

function abrirLaminaDesdeMosaico(idx) {
  appState.visorIndice = idx;
  appState.visorModo = 'presentacion';
  appState.visorZoom = 1;
  appState.visorPanX = 0;
  appState.visorPanY = 0;
  pintarVisor();
}

function limpiarVisorBusqueda() {
  appState.visorBusqueda = '';
  appState.visorIndice = 0;
  pintarVisor();
}

function filtrarVisorPorCategoria(catId) {
  // Toggle: si pulsas la categoría ya activa, se quita el filtro
  if (appState.visorFiltroCat === catId) {
    appState.visorFiltroCat = null;
  } else {
    appState.visorFiltroCat = catId;
  }
  appState.visorIndice = 0;
  pintarVisor();
}

// ----- Gestos: pinch-zoom, doble-tap, swipe, pan (arrastre con zoom) -----
function engancharGestosPresentacion() {
  const $cont = document.getElementById('visor-img-contenedor');
  const $zoom = document.getElementById('visor-img-zoom');
  if (!$cont || !$zoom) return;

  let lastTap = 0;
  let touchStartX = null;
  let touchStartY = null;
  let initialPinchDist = null;
  let zoomAlInicioPinch = 1;

  // PAN: estado de desplazamiento al hacer zoom (translate en píxeles)
  if (!appState.visorPanX) appState.visorPanX = 0;
  if (!appState.visorPanY) appState.visorPanY = 0;
  let panInicioX = 0;
  let panInicioY = 0;
  let panActivo = false;

  // Función helper: actualiza el transform combinando zoom + pan
  function aplicarTransform() {
    $zoom.style.transform = `translate(${appState.visorPanX}px, ${appState.visorPanY}px) scale(${appState.visorZoom})`;
  }
  // Aplicar transform inicial (por si hay zoom guardado)
  aplicarTransform();

  // Función helper: limitar el pan a los bordes de la imagen ampliada
  function limitarPan() {
    if (appState.visorZoom <= 1) {
      appState.visorPanX = 0;
      appState.visorPanY = 0;
      return;
    }
    // Tamaño del contenedor
    const w = $cont.clientWidth;
    const h = $cont.clientHeight;
    // Margen máximo de pan (cuanto puede salirse la imagen ampliada)
    const maxX = (w * (appState.visorZoom - 1)) / 2;
    const maxY = (h * (appState.visorZoom - 1)) / 2;
    appState.visorPanX = Math.max(-maxX, Math.min(maxX, appState.visorPanX));
    appState.visorPanY = Math.max(-maxY, Math.min(maxY, appState.visorPanY));
  }

  // Doble tap (touch + click): zoom rápido
  $cont.addEventListener('click', (e) => {
    if (e.target.closest('.visor-zoom-reset')) return;
    // Si estabamos en medio de un pan, ignorar el click
    if (panActivo) { panActivo = false; return; }
    const ahora = Date.now();
    if (ahora - lastTap < 350) {
      if (appState.visorZoom < 1.5) {
        appState.visorZoom = 2.5;
      } else {
        appState.visorZoom = 1;
        appState.visorPanX = 0;
        appState.visorPanY = 0;
      }
      aplicarTransform();
      pintarVisor();
    }
    lastTap = ahora;
  });

  // TOUCH START: detectar pinch o pan
  $cont.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // PINCH ZOOM
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialPinchDist = Math.hypot(dx, dy);
      zoomAlInicioPinch = appState.visorZoom;
    } else if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      // Si hay zoom activo, este 1-dedo es PAN
      if (appState.visorZoom > 1.05) {
        panActivo = true;
        panInicioX = appState.visorPanX;
        panInicioY = appState.visorPanY;
      }
    }
  }, { passive: true });

  // TOUCH MOVE: pinch o pan
  $cont.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialPinchDist !== null) {
      // PINCH ZOOM
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const factor = dist / initialPinchDist;
      let nuevoZoom = zoomAlInicioPinch * factor;
      nuevoZoom = Math.max(1, Math.min(6, nuevoZoom));
      appState.visorZoom = nuevoZoom;
      // Si pasa a zoom 1 reseteamos pan
      if (nuevoZoom <= 1.05) {
        appState.visorPanX = 0;
        appState.visorPanY = 0;
      }
      limitarPan();
      aplicarTransform();
    } else if (e.touches.length === 1 && panActivo && touchStartX !== null) {
      // PAN con 1 dedo (solo si hay zoom)
      e.preventDefault();
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      appState.visorPanX = panInicioX + dx;
      appState.visorPanY = panInicioY + dy;
      limitarPan();
      aplicarTransform();
    }
  }, { passive: false });

  // TOUCH END
  $cont.addEventListener('touchend', (e) => {
    if (initialPinchDist !== null) {
      initialPinchDist = null;
      pintarVisor();
      return;
    }
    // Si fue pan, no procesar swipe (esperamos al click para resetear panActivo)
    if (panActivo) {
      touchStartX = null;
      touchStartY = null;
      // panActivo se resetea en el siguiente click o nuevo touch
      // Forzar repintado de boton reset zoom
      const $reset = $cont.querySelector('.visor-zoom-reset');
      if (!$reset && appState.visorZoom > 1) pintarVisor();
      return;
    }
    // Si fue 1 dedo sin zoom, ver si es swipe
    if (touchStartX !== null && e.changedTouches.length === 1 && appState.visorZoom < 1.2) {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx > 0) visorAnterior();
        else visorSiguiente();
      }
    }
    touchStartX = null;
    touchStartY = null;
  });

  // MOUSE DRAG (escritorio): pan cuando hay zoom
  let mouseDragActivo = false;
  let mouseStartX = 0;
  let mouseStartY = 0;
  let mousePanInicioX = 0;
  let mousePanInicioY = 0;

  $cont.addEventListener('mousedown', (e) => {
    if (appState.visorZoom > 1.05 && e.button === 0) {
      mouseDragActivo = true;
      mouseStartX = e.clientX;
      mouseStartY = e.clientY;
      mousePanInicioX = appState.visorPanX;
      mousePanInicioY = appState.visorPanY;
      $cont.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  $cont.addEventListener('mousemove', (e) => {
    if (mouseDragActivo) {
      const dx = e.clientX - mouseStartX;
      const dy = e.clientY - mouseStartY;
      appState.visorPanX = mousePanInicioX + dx;
      appState.visorPanY = mousePanInicioY + dy;
      limitarPan();
      aplicarTransform();
    } else if (appState.visorZoom > 1.05) {
      $cont.style.cursor = 'grab';
    } else {
      $cont.style.cursor = '';
    }
  });

  $cont.addEventListener('mouseup', () => {
    if (mouseDragActivo) {
      mouseDragActivo = false;
      $cont.style.cursor = appState.visorZoom > 1.05 ? 'grab' : '';
    }
  });
  $cont.addEventListener('mouseleave', () => {
    if (mouseDragActivo) {
      mouseDragActivo = false;
      $cont.style.cursor = '';
    }
  });

  // Wheel zoom (escritorio con rueda + Ctrl)
  $cont.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      let nuevoZoom = appState.visorZoom * factor;
      nuevoZoom = Math.max(1, Math.min(6, nuevoZoom));
      appState.visorZoom = nuevoZoom;
      if (nuevoZoom <= 1.05) {
        appState.visorPanX = 0;
        appState.visorPanY = 0;
      }
      limitarPan();
      aplicarTransform();
      const $reset = $cont.querySelector('.visor-zoom-reset');
      if (nuevoZoom > 1 && !$reset) pintarVisor();
      else if (nuevoZoom <= 1 && $reset) pintarVisor();
    }
  }, { passive: false });

  // Teclado: flechas izquierda/derecha
  if (!window._visorTeclasEnganchadas) {
    window._visorTeclasEnganchadas = true;
    document.addEventListener('keydown', (e) => {
      if (!appState.catalogoActual || rolEfectivo() === 'admin') return;
      if (appState.visorModo !== 'presentacion') return;
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); visorAnterior(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); visorSiguiente(); }
      else if (e.key === 'Escape' && appState.visorZoom > 1) {
        appState.visorZoom = 1;
        appState.visorPanX = 0;
        appState.visorPanY = 0;
        pintarVisor();
      }
      else if (e.key === 'Escape' && _fullscreenActivo) { salirPantallaCompleta(); }
    });
  }

  // B7: Long-press sobre la imagen para crear pin de anotación (solo si hay visita activa)
  engancharLongPressParaPin();
  // Zonas clicables: en visita se pintan todas (producto/familia/comisión). Los ENLACES
  // a otros catálogos se pintan SIEMPRE (también al previsualizar): son navegación pura.
  cargarZonasComercial();
}

// ============================================================================
// FASE 2.c' — COMERCIAL pulsa zonas de productos
// ============================================================================
let _zonasComercial = []; // zonas de la lámina actual en el visor
let _preciosVigentes = {}; // FASE 1: precio de hoy por product_id, para pintar sobre la zona

async function cargarZonasComercial() {
  const $wrapper = document.getElementById('visor-imagen-wrapper');
  if (!$wrapper) return;
  const sheetId = Number($wrapper.dataset.sheetId);
  if (!sheetId) return;
  // origen_sheet_id: si es lámina espejo de express, las zonas están en la lámina maestra.
  // Pero el endpoint usa el sheet_id directo; las zonas se definen en el maestro y el
  // visor del comercial muestra la lámina del maestro vía JOIN, así que el id ya es correcto.
  try {
    const r = await api('/api/sheets/' + sheetId + '/zones');
    // Zonas "accionables": producto Sage, familia, comisión o enlace a otro catálogo.
    _zonasComercial = (r.zones || []).filter(z => z.product_id || z.familia_ref || (z.familia_skus && z.familia_skus.length) || z.es_comision || z.link_catalog_id || z.permite_sueltas);
    pintarZonasComercial();
    cargarRecuadrosLamina(sheetId);   // F3: recuadros tapar-reescribir
    cargarPreciosVigentesLamina(); // en segundo plano; repinta al llegar
    cargarOfertasLamina();         // F4: etiqueta de oferta vigente
  } catch (e) {
    _zonasComercial = [];
  }
}

// F3 (precios dinámicos): recuadros que TAPAN el precio impreso y lo REESCRIBEN.
let _recuadrosLamina = []; // recuadros activos de la lámina actual
function _laminaVisorExcluida(sheetId) {
  const s = (_visorSheets || []).find(x => x.id === sheetId);
  return !!(s && s.precios_excluida);
}
async function cargarRecuadrosLamina(sheetId) {
  try {
    await cargarConfigPrecios(); // ANTES de pintar: si el interruptor está apagado, ni se piden
    // Interruptor maestro apagado O lámina EXCLUIDA -> lámina tal cual, sin reescribir.
    if (!_preciosDinamicosOn || _laminaVisorExcluida(sheetId)) { _recuadrosLamina = []; pintarRecuadrosPrecio(); return; }
    const r = await api('/api/sheets/' + sheetId + '/recuadros');
    // SEGURIDAD: solo se reescribe un precio si el recuadro está activo Y NO marcado para
    // revisar. Los dudosos (confianza baja) se dejan con el precio impreso hasta que el
    // admin los apruebe → nunca se muestra un precio mal a un cliente.
    _recuadrosLamina = (r.recuadros || []).filter(x => x.activo && !x.revisar);
    cargarConfigPrecios(); // una vez: fuente + factor de tamaño
    pintarRecuadrosPrecio();
  } catch (e) { _recuadrosLamina = []; }
}

// Fuente por defecto para reescribir precios (config una vez; la real de BETER es tipo Helvetica).
const RECUADRO_FUENTE_DEFECTO = 'Arial, Helvetica, sans-serif';
// Config de render de precios (fuente + factor de tamaño), cargada una vez del servidor.
let _cfgPrecioFuente = 'Liberation Sans';
let _cfgPrecioTamFactor = 1;
let _cfgPreciosCargada = false;
let _preciosDinamicosOn = true; // interruptor maestro (Configuración). OFF = lámina original.
async function cargarConfigPrecios() {
  if (_cfgPreciosCargada) return;
  _cfgPreciosCargada = true;
  try {
    const r = await api('/api/config');
    const c = r.config || {};
    _preciosDinamicosOn = (c.precios_dinamicos_activo ?? '1') !== '0';
    if (c.precio_fuente) _cfgPrecioFuente = c.precio_fuente;
    const tf = parseFloat(c.precio_tam_factor);
    if (Number.isFinite(tf) && tf >= 0.5 && tf <= 2) _cfgPrecioTamFactor = tf;
    if (!_preciosDinamicosOn) { _recuadrosLamina = []; _preciosVigentes = {}; }
    pintarRecuadrosPrecio();
    pintarZonasComercial();
  } catch (e) { /* usa valores por defecto */ }
}

function _formatearPrecioRecuadro(rec, pr) {
  if (!pr) return null;
  let val = null;
  if (rec.campo === 'pvf') val = pr.pvf;
  else if (rec.campo === 'pvpr') val = pr.pvpr;
  if (val == null || val === '') return null;
  const dec = (rec.decimales == null) ? 2 : rec.decimales;
  let s = Number(val).toFixed(dec);
  if (rec.sep_decimal === ',' || rec.sep_decimal == null) s = s.replace('.', ',');
  return (rec.prefijo || '') + s + (rec.sufijo == null ? '€' : rec.sufijo);
}

// Pinta los recuadros sobre la imagen. font-size en px = tam_rel% del ancho RENDERIZADO
// de la imagen (así casa con la lámina y escala con el zoom, que es un transform del ancestro).
function pintarRecuadrosPrecio() {
  const capa = document.getElementById('visor-recuadros-capa');
  if (!capa) return;
  const wrapper = document.getElementById('visor-imagen-wrapper');
  const anchoPx = wrapper ? wrapper.clientWidth : 0;
  capa.innerHTML = '';
  // Interruptor maestro apagado -> lámina TAL CUAL, no se reescribe ningún precio.
  if (!_preciosDinamicosOn) return;
  if (!anchoPx || !_recuadrosLamina.length) return;
  _recuadrosLamina.forEach(rec => {
    const pr = rec.product_id ? _preciosVigentes[rec.product_id] : null;
    const texto = _formatearPrecioRecuadro(rec, pr);
    if (!texto) return; // sin precio de BD todavía: no tapamos (mejor dejar el impreso)
    const div = document.createElement('div');
    div.className = 'visor-recuadro-precio';
    div.style.left = rec.x + '%';
    div.style.top = rec.y + '%';
    // Tapa un poco MÁS ancha que el número viejo (cubre restos aunque la fuente nueva
    // sea algo más estrecha) y un pelín más alta; el texto puede desbordar a la derecha
    // (cae en el hueco blanco antes de la siguiente columna) sin recortarse.
    div.style.width = (rec.ancho * 1.15) + '%';
    div.style.height = (rec.alto * 1.25) + '%';
    div.style.marginTop = (-rec.alto * 0.12) + '%';
    div.style.background = rec.color_fondo || '#fff';
    const span = document.createElement('span');
    span.className = 'visor-recuadro-txt';
    span.textContent = texto;
    span.style.color = rec.color_texto || '#2b2a29';
    // Fuente configurada (Liberation Sans ≈ Arial en el navegador); factor de tamaño fino.
    span.style.fontFamily = rec.fuente || (_cfgPrecioFuente + ', Arial, Helvetica, sans-serif');
    span.style.fontWeight = rec.negrita === false ? '400' : '700';
    span.style.fontSize = (rec.tam_rel * anchoPx / 100 * _cfgPrecioTamFactor).toFixed(1) + 'px';
    span.style.justifyContent = rec.alinear === 'right' ? 'flex-end' : (rec.alinear === 'center' ? 'center' : 'flex-start');
    div.appendChild(span);
    capa.appendChild(div);
  });
}
// Repintar al rotar/redimensionar (el px de la fuente depende del ancho renderizado).
window.addEventListener('resize', () => { clearTimeout(window._recuadroResizeT); window._recuadroResizeT = setTimeout(pintarRecuadrosPrecio, 120); });

// F5 export: descarga un recurso protegido (con token) como archivo. El backend hornea
// los precios de hoy + ofertas en la imagen/PDF antes de enviarlo.
async function _descargarBlobAuth(url, filename) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (impersonating && user && user.role === 'admin') headers['X-Impersonate-User'] = String(impersonating.id);
  const r = await fetch(API + url, { headers });
  if (!r.ok) { let e = 'Error ' + r.status; try { e = (await r.json()).error || e; } catch {} throw new Error(e); }
  const blob = await r.blob();
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}

function _tarifaVisor() {
  return (appState.visitaActiva && appState.visitaActiva.tarifa_precio) ? appState.visitaActiva.tarifa_precio : 1;
}

async function descargarLaminaHoy(sheetId) {
  try {
    await _descargarBlobAuth('/api/sheets/' + sheetId + '/recompuesta?tarifa=' + _tarifaVisor(), 'lamina_' + sheetId + '_precios_hoy.png');
  } catch (e) { alert('No se pudo generar la lámina: ' + e.message); }
}

async function descargarPdfCatalogoHoy(catalogId, btn) {
  if (!catalogId) { alert('No hay catálogo activo'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generando PDF…'; }
  try {
    await _descargarBlobAuth('/api/catalogs/' + catalogId + '/pdf-hoy?tarifa=' + _tarifaVisor(), 'catalogo_' + catalogId + '_precios_hoy.pdf');
  } catch (e) { alert('No se pudo generar el PDF: ' + e.message); }
  if (btn) { btn.disabled = false; btn.textContent = orig; }
}

// FASE 1 (precios dinámicos): trae el precio de HOY de los productos de la lámina y repinta.
async function cargarPreciosVigentesLamina() {
  await cargarConfigPrecios();
  const $w = document.getElementById('visor-imagen-wrapper');
  const sid = $w ? Number($w.dataset.sheetId) : null;
  if (!_preciosDinamicosOn || (sid && _laminaVisorExcluida(sid))) { _preciosVigentes = {}; return; }
  const ids = _zonasComercial.filter(z => z.product_id).map(z => Number(z.product_id));
  if (!ids.length) { _preciosVigentes = {}; return; }
  try {
    // tarifa del cliente de la visita si existe; si no, 1 (Lomhifar = tarifa única)
    const tarifa = (appState.visitaActiva && appState.visitaActiva.tarifa_precio) ? appState.visitaActiva.tarifa_precio : 1;
    const r = await api('/api/precios/vigentes', { method: 'POST', body: { product_ids: ids, tarifa } });
    _preciosVigentes = r.precios || {};
    pintarZonasComercial();
    pintarRecuadrosPrecio(); // F3: ya tenemos precios de BD → tapar y reescribir
  } catch (e) { /* si falla, el visor sigue funcionando sin la etiqueta */ }
}

// F4 (ofertas/campañas): trae la oferta vigente HOY de los productos de la lámina.
let _ofertasVigentes = {};
async function cargarOfertasLamina() {
  const ids = _zonasComercial.filter(z => z.product_id).map(z => Number(z.product_id));
  if (!ids.length) { _ofertasVigentes = {}; return; }
  try {
    const r = await api('/api/ofertas/vigentes', { method: 'POST', body: { product_ids: ids } });
    _ofertasVigentes = r.ofertas || {};
    pintarZonasComercial();
  } catch (e) { /* el visor sigue sin la etiqueta de oferta */ }
}

function pintarZonasComercial() {
  const capa = document.getElementById('visor-zonas-capa');
  if (!capa) return;
  capa.innerHTML = '';
  const enVisita = !!appState.visitaActiva;
  _zonasComercial.forEach((z) => {
    // Fuera de una visita solo mostramos los ENLACES (el resto requiere visita para anotar)
    if (!enVisita && !z.link_catalog_id) return;
    const div = document.createElement('div');
    div.className = 'visor-zona';
    div.style.left = z.x + '%';
    div.style.top = z.y + '%';
    div.style.width = z.ancho + '%';
    div.style.height = z.alto + '%';
    div.dataset.zoneId = z.id;
    if (z.link_catalog_id) {
      // Zona-ENLACE: se pinta como BOTON visible con texto (deliberado, no se toca sin querer)
      div.classList.add('visor-zona-enlace');
      const txt = z.link_label || ('🔗 ' + (z.link_catalog_nombre || 'Ver catálogo') + ' →');
      div.innerHTML = '<span class="visor-zona-enlace-txt">' + escape(txt) + '</span>';
      div.title = 'Ir a ' + (z.link_catalog_nombre || 'otro catálogo');
    } else if (z.product_id && _preciosVigentes[z.product_id]) {
      // FASE 1 precios dinámicos: etiqueta con el precio de HOY (de la BD) sobre la zona.
      // La imagen puede tener el número viejo; la app enseña el correcto.
      const pr = _preciosVigentes[z.product_id];
      const pvf = (pr.pvf != null && pr.pvf !== '') ? Number(pr.pvf).toFixed(2).replace('.', ',') + '€' : null;
      if (pvf) {
        const chip = document.createElement('span');
        chip.className = 'visor-zona-precio' + (pr.pendiente ? ' tiene-pendiente' : '');
        chip.textContent = 'PVF ' + pvf;
        if (pr.pendiente && pr.pendiente.fecha) {
          const f = String(pr.pendiente.fecha).slice(0, 10).split('-').reverse().join('/');
          const npvf = pr.pendiente.pvf != null ? Number(pr.pendiente.pvf).toFixed(2).replace('.', ',') + '€' : '';
          chip.title = 'Precio de hoy. Cambia a ' + npvf + ' el ' + f;
        } else {
          chip.title = 'Precio actual (base de datos)';
        }
        div.appendChild(chip);
      }
    }
    // F4 ofertas: etiqueta de campaña vigente HOY sobre la zona (independiente del precio).
    if (z.product_id && _ofertasVigentes[z.product_id]) {
      const of = _ofertasVigentes[z.product_id];
      const chipO = document.createElement('span');
      chipO.className = 'visor-zona-oferta';
      chipO.textContent = of.label || 'Oferta';
      chipO.style.background = of.color || '#dc2626';
      if (of.fecha_fin) chipO.title = 'Oferta hasta ' + String(of.fecha_fin).slice(0, 10).split('-').reverse().join('/');
      div.appendChild(chipO);
    }
    div.addEventListener('click', (e) => {
      e.stopPropagation();
      pulsarZonaComercial(z);
    });
    capa.appendChild(div);
  });
}

// E3: iluminar brevemente las zonas al tocar la lámina, luego desvanecer
function iluminarZonas() {
  const capa = document.getElementById('visor-zonas-capa');
  if (!capa) return;
  if (_zonasComercial.length === 0) return;
  capa.classList.add('visor-zonas-iluminadas');
  clearTimeout(window._zonasIluminarTimer);
  window._zonasIluminarTimer = setTimeout(() => {
    capa.classList.remove('visor-zonas-iluminadas');
  }, 1500);
}

// Recuerda el ultimo almacen + nº socio tecleados (el pedido de comision va a un mismo almacen)
let _comisionUltimo = { almacen: '', num_socio: '' };

async function pulsarZonaComercial(zona) {
  // Zona-ENLACE: saltar a otro catálogo (funciona con o sin visita activa)
  if (zona.link_catalog_id) { return navegarAEnlaceCatalogo(zona); }
  if (!appState.visitaActiva) return;
  // Zona con REFERENCIAS SUELTAS (expositor de gafas): gestor propio de líneas a mano.
  // Gana sobre el resto de tipos; desde su modal se puede pedir el expositor completo.
  if (zona.permite_sueltas && !zona.__forzarNormal) { return pulsarZonaSueltas(zona); }
  // Zona de COMISION: formulario propio (unidades + descuento + almacen + socio)
  if (zona.es_comision) { return pulsarZonaComision(zona); }
  const $wrapper = document.getElementById('visor-imagen-wrapper');
  const sheetId = $wrapper ? Number($wrapper.dataset.sheetId) : null;

  // D2: ¿ya existe una anotación de esta zona en esta visita? → editamos esa
  let anotExistente = null;
  const anotsSheet = _anotacionesVisita[sheetId] || [];
  anotExistente = anotsSheet.find(a => a.zone_id === zona.id) || null;

  // Asegurar plantillas cargadas
  if (_plantillasCache === null) { await cargarPlantillas(); }
  const plantillas = _plantillasCache || [];

  const cantidadInicial = anotExistente && anotExistente.cantidad ? anotExistente.cantidad : 1;

  // ¿Es una zona-FAMILIA (gafas de presbicia: color x graduacion)? Cargamos variantes.
  // Si hay lista curada de códigos (familia_skus) manda esa; si no, se resuelve por el modelo.
  const tieneSkus = Array.isArray(zona.familia_skus) && zona.familia_skus.length > 0;
  const esFamilia = !!zona.familia_ref || tieneSkus;
  let familia = null;
  if (esFamilia) {
    try {
      const q = tieneSkus
        ? '/api/families/resolve?ids=' + zona.familia_skus.join(',')
        : '/api/families/resolve?ref=' + encodeURIComponent(zona.familia_ref);
      const rf = await api(q);
      familia = rf && rf.familia ? rf.familia : null;
    } catch (_) { familia = null; }
  }
  // Estado del SKU seleccionado: para zona simple es fijo; para familia se resuelve al elegir.
  let skuSel = esFamilia ? null : {
    product_id: zona.product_id,
    codigo: zona.producto_codigo || '',
    nombre: zona.producto_nombre || '',
    pvf: zona.producto_pvf != null ? Number(zona.producto_pvf) : null
  };
  let pvf = skuSel && skuSel.pvf != null ? skuSel.pvf : null;

  // Selectores de familia: un grupo de chips por cada EJE (color, talla, graduacion, formato)
  const ejesFamilia = (esFamilia && familia && Array.isArray(familia.ejes)) ? familia.ejes : [];
  const familiaHTML = (esFamilia && familia) ? `
    <div class="zona-familia-selector" style="margin-top:14px">
      <div style="font-weight:700;font-size:14px;margin-bottom:8px">👓 ${escape(familia.modelo || 'Familia')} — elige opciones</div>
      ${ejesFamilia.map(eje => `
        <div class="form-group" style="margin-bottom:10px">
          <label>${escape(eje.label)}</label>
          <div class="fam-chips" data-eje="${escape(eje.key).replace(/"/g,'&quot;')}">
            ${eje.valores.map(v => `<button type="button" class="fam-chip" data-valor="${escape(v).replace(/"/g,'&quot;')}">${escape(v)}</button>`).join('')}
          </div>
        </div>
      `).join('')}
      ${ejesFamilia.length === 0 && Array.isArray(familia.variantes) && familia.variantes.length ? `
        <div class="form-group">
          <label>Elige la variante</label>
          <select id="fam-select-directo" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px">
            <option value="">— elige —</option>
            ${familia.variantes.map((v, i) => `<option value="${i}">${escape(v.codigo || '')} · ${escape(v.nombre || '')}</option>`).join('')}
          </select>
        </div>
      ` : ''}
    </div>
  ` : (esFamilia ? `<div class="error-msg" style="margin-top:12px">No se pudieron cargar las variantes de esta familia.</div>` : '');

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>${anotExistente ? '✏️ Editar' : '🛒 Anotar'} producto</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div class="zona-modal-producto" id="zona-modal-producto">
        ${esFamilia ? `
          <span class="ac-badge-sage">🏷️ Sage</span>
          <b id="zona-prod-codigo">—</b>
          <div id="zona-prod-nombre" style="font-size:13px;color:#374151;margin-top:2px">Elige color y graduación</div>
          <div id="zona-prod-pvf" style="font-size:12px;color:#6b7280;margin-top:2px"></div>
        ` : `
          <span class="ac-badge-${zona.producto_tipo === 'comercial' ? 'promo' : 'sage'}">
            ${zona.producto_tipo === 'comercial' ? '🎁 Promo' : '🏷️ Sage'}
          </span>
          <b>${escape(zona.producto_codigo || '')}</b>
          <div style="font-size:13px;color:#374151;margin-top:2px">${escape(zona.producto_nombre || '')}</div>
          ${pvf !== null ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">PVF ${pvf.toFixed(2)}€</div>` : ''}
        `}
      </div>
      ${familiaHTML}

      <div class="form-group" style="margin-top:14px">
        <label>Cantidad</label>
        <div class="zona-cantidad-rapida">
          <button type="button" class="zona-cant-btn" data-cant="1">1</button>
          <button type="button" class="zona-cant-btn" data-cant="6">6</button>
          <button type="button" class="zona-cant-btn" data-cant="12">12</button>
          <button type="button" class="zona-cant-btn" data-cant="24">24</button>
        </div>
        <input type="number" id="zona-cantidad" min="1" value="${cantidadInicial}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;box-sizing:border-box;margin-top:8px">
        <div id="zona-subtotal" style="font-size:13px;color:#16a34a;font-weight:600;margin-top:6px;text-align:right"></div>
      </div>

      ${plantillas.length > 0 ? (() => {
        const g = _ordenarPlantillas(plantillas);
        const clsDe = p => (p.tipo === 'pedido' && p.clase === 'descuento') ? ' zona-tpl-descuento'
          : (p.tipo === 'pedido' && p.clase === 'bonificacion') ? ' zona-tpl-bonif' : '';
        const chip = p => `<button type="button" class="zona-tpl-chip${clsDe(p)}" data-texto="${escape(p.texto).replace(/"/g,'&quot;')}">${escape(p.texto)}</button>`;
        const grupo = (titulo, arr) => arr.length ? `
          <div class="zona-tpl-grupo">
            <div class="zona-tpl-grupo-tit">${titulo} <span class="zona-tpl-cuenta">${arr.length}</span></div>
            <div class="zona-plantillas">${arr.map(chip).join('')}</div>
          </div>` : '';
        // Con muchas plantillas, un buscador acelera muchísimo (escribe "12" → 12+1, 12+2…)
        const buscador = plantillas.length > 12
          ? `<input type="search" id="tpl-filtro" class="zona-tpl-filtro" placeholder="🔍 Filtrar (ej: 12, 15%, 3+1…)" autocomplete="off">`
          : '';
        return `<div class="form-group">
          <label>Selección rápida</label>
          ${buscador}
          <div class="zona-tpl-scroll">
            ${g.frecuentes.length ? grupo('⭐ Frecuentes', g.frecuentes) : ''}
            ${grupo('🏷️ Descuentos', g.dtos)}
            ${grupo('🎁 Bonificaciones', g.bons)}
            ${grupo('Otras', g.otros)}
            <div id="tpl-sin-resultados" class="zona-tpl-vacio" style="display:none">Sin coincidencias</div>
          </div>
        </div>`;
      })() : ''}

      <div class="form-group">
        <label>Nota adicional <small style="color:#9ca3af">opcional</small></label>
        <textarea id="zona-nota" rows="2" placeholder="ej: oferta especial, revisar caducidad…" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box">${anotExistente && anotExistente.nota_extra ? escape(anotExistente.nota_extra) : ''}</textarea>
      </div>

      <div id="zona-modal-msg"></div>
      <div class="modal-acciones">
        ${anotExistente ? `<button type="button" class="btn" style="background:#dc2626;color:#fff" onclick="borrarAnotacionZona(${anotExistente.id}, ${sheetId})">🗑️ Quitar</button>` : ''}
        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button type="button" class="btn btn-primary" id="zona-guardar">${anotExistente ? 'Actualizar' : 'Anotar'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const $cant = modal.querySelector('#zona-cantidad');
  const $subtotal = modal.querySelector('#zona-subtotal');
  const $nota = modal.querySelector('#zona-nota');

  function actualizarSubtotal() {
    const c = Number($cant.value) || 0;
    if (pvf !== null && c > 0) {
      $subtotal.textContent = 'Subtotal PVF: ' + (pvf * c).toFixed(2) + '€';
    } else {
      $subtotal.textContent = '';
    }
  }
  actualizarSubtotal();
  $cant.addEventListener('input', actualizarSubtotal);

  // Botones de cantidad rápida (J1)
  modal.querySelectorAll('.zona-cant-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $cant.value = btn.dataset.cant;
      actualizarSubtotal();
    });
  });

  // Plantillas de selección rápida → conmutan (marcar/desmarcar) y sincronizan la nota.
  // Como una plantilla puede salir en "Frecuentes" y en su grupo, sincronizamos TODAS
  // las instancias con el mismo texto para que el estado sea coherente.
  const marcarTodas = (txt, sel) => modal.querySelectorAll('.zona-tpl-chip').forEach(c => {
    if (c.dataset.texto === txt) c.classList.toggle('seleccionada', sel);
  });
  modal.querySelectorAll('.zona-tpl-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const txt = chip.dataset.texto;
      const sel = !chip.classList.contains('seleccionada');
      marcarTodas(txt, sel);
      let partes = $nota.value ? $nota.value.split(' · ').map(s => s.trim()).filter(Boolean) : [];
      if (sel) { if (!partes.includes(txt)) partes.push(txt); _tplUsoInc(txt); }
      else { partes = partes.filter(s => s !== txt); }
      $nota.value = partes.join(' · ');
    });
  });
  // Marcar como seleccionadas las plantillas cuyo texto ya está en la nota (al editar).
  if ($nota.value) {
    const partes = $nota.value.split(' · ').map(s => s.trim());
    modal.querySelectorAll('.zona-tpl-chip').forEach(chip => {
      if (partes.includes(chip.dataset.texto)) chip.classList.add('seleccionada');
    });
  }
  // Buscador en vivo: filtra chips por texto y oculta grupos vacíos.
  const $filtro = modal.querySelector('#tpl-filtro');
  if ($filtro) {
    const $vacio = modal.querySelector('#tpl-sin-resultados');
    $filtro.addEventListener('input', () => {
      const q = ($filtro.value || '').toLowerCase().trim();
      let totalVis = 0;
      modal.querySelectorAll('.zona-tpl-grupo').forEach(g => {
        let vis = 0;
        g.querySelectorAll('.zona-tpl-chip').forEach(ch => {
          const ok = !q || ch.dataset.texto.toLowerCase().includes(q);
          ch.style.display = ok ? '' : 'none'; if (ok) vis++;
        });
        g.style.display = vis ? '' : 'none'; totalVis += vis;
      });
      if ($vacio) $vacio.style.display = totalVis ? 'none' : '';
    });
  }

  // ---- FAMILIA: selectores genericos (N ejes) que resuelven al SKU ----
  const $guardar = modal.querySelector('#zona-guardar');
  if (esFamilia && familia && Array.isArray(familia.variantes)) {
    const seleccion = {};                 // { color:'NEGRA', graduacion:'+2.5', ... }
    const $prodCodigo = modal.querySelector('#zona-prod-codigo');
    const $prodNombre = modal.querySelector('#zona-prod-nombre');
    const $prodPvf = modal.querySelector('#zona-prod-pvf');

    const resolverSku = () => {
      const faltan = ejesFamilia.filter(e => !seleccion[e.key]);
      if (faltan.length > 0) {
        skuSel = ejesFamilia.length === 0 && familia.variantes.length === 1 ? familia.variantes[0] : null;
      } else {
        skuSel = familia.variantes.find(v => ejesFamilia.every(e => (v.ejes || {})[e.key] === seleccion[e.key])) || null;
      }
      if (skuSel) {
        pvf = skuSel.pvf != null ? Number(skuSel.pvf) : null;
        if ($prodCodigo) $prodCodigo.textContent = skuSel.codigo || '';
        if ($prodNombre) $prodNombre.textContent = skuSel.nombre || '';
        if ($prodPvf) $prodPvf.textContent = pvf != null && pvf > 0 ? ('PVF ' + pvf.toFixed(2) + '€') : '';
        if ($guardar) { $guardar.disabled = false; $guardar.style.opacity = '1'; }
      } else {
        pvf = null;
        if ($prodCodigo) $prodCodigo.textContent = '—';
        if ($prodNombre) $prodNombre.textContent = 'Elige ' + faltan.map(e => e.label.toLowerCase()).join(' y ');
        if ($prodPvf) $prodPvf.textContent = '';
        if ($guardar) { $guardar.disabled = true; $guardar.style.opacity = '0.5'; }
      }
      actualizarSubtotal();
    };

    modal.querySelectorAll('.fam-chips').forEach(grp => {
      const key = grp.dataset.eje;
      grp.querySelectorAll('.fam-chip').forEach(ch => {
        ch.addEventListener('click', () => {
          seleccion[key] = ch.dataset.valor;
          grp.querySelectorAll('.fam-chip').forEach(x => x.classList.remove('sel'));
          ch.classList.add('sel');
          resolverSku();
        });
      });
    });
    // Familia SIN ejes legibles → desplegable directo de variantes (elige código exacto)
    const $selDirecto = modal.querySelector('#fam-select-directo');
    if ($selDirecto) {
      if ($guardar) { $guardar.disabled = true; $guardar.style.opacity = '0.5'; }
      $selDirecto.addEventListener('change', () => {
        skuSel = $selDirecto.value !== '' ? familia.variantes[Number($selDirecto.value)] : null;
        if (skuSel) {
          pvf = skuSel.pvf != null ? Number(skuSel.pvf) : null;
          if ($prodCodigo) $prodCodigo.textContent = skuSel.codigo || '';
          if ($prodNombre) $prodNombre.textContent = skuSel.nombre || '';
          if ($prodPvf) $prodPvf.textContent = pvf != null && pvf > 0 ? ('PVF ' + pvf.toFixed(2) + '€') : '';
          if ($guardar) { $guardar.disabled = false; $guardar.style.opacity = '1'; }
        } else {
          pvf = null;
          if ($prodCodigo) $prodCodigo.textContent = '—';
          if ($prodNombre) $prodNombre.textContent = 'Elige la variante';
          if ($guardar) { $guardar.disabled = true; $guardar.style.opacity = '0.5'; }
        }
        actualizarSubtotal();
      });
    } else {
      resolverSku(); // con chips: estado inicial (deshabilita guardar hasta elegir todo)
    }
  }

  // Guardar
  modal.querySelector('#zona-guardar').addEventListener('click', async () => {
    const $msg = modal.querySelector('#zona-modal-msg');
    // Para familias hay que haber resuelto el SKU (color + graduacion)
    if (esFamilia && !skuSel) {
      $msg.innerHTML = `<div class="error-msg">Elige color y graduación antes de anotar.</div>`;
      return;
    }
    const cantidad = Number($cant.value) || 1;
    const notaExtra = $nota.value.trim();
    // Codigo/nombre/product_id del SKU final (familia o zona simple)
    const codFinal = skuSel ? (skuSel.codigo || '') : (zona.producto_codigo || '');
    const nomFinal = skuSel ? (skuSel.nombre || '') : (zona.producto_nombre || '');
    const prodIdFinal = skuSel ? skuSel.product_id : zona.product_id;
    // Montar el texto_libre automático: "6 uds · 1243441 NOMBRE [· nota]"
    let texto = cantidad + ' uds · ' + codFinal + ' ' + nomFinal;
    if (notaExtra) texto += ' · ' + notaExtra;
    try {
      if (anotExistente) {
        // D2: editar la existente
        await api('/api/annotations/' + anotExistente.id, {
          method: 'PUT',
          body: { texto_libre: texto, tipo: 'pedido', cantidad }
        });
      } else {
        // crear nueva, vinculada a zona + producto
        await api('/api/visits/' + appState.visitaActiva.id + '/annotations', {
          method: 'POST',
          body: {
            sheet_id: sheetId,
            texto_libre: texto,
            tipo: 'pedido',
            product_id: prodIdFinal,
            cantidad,
            zone_id: zona.id,
            pos_x: (zona.x + zona.ancho / 2) / 100,  // centro de la zona como pin
            pos_y: (zona.y + zona.alto / 2) / 100
          }
        });
      }
      modal.remove();
      refrescarAnotacionesVisor(sheetId);
      mostrarNotificacionOnline('✅ ' + texto, '#16a34a');
    } catch (err) {
      $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

async function borrarAnotacionZona(anotId, sheetId) {
  try {
    await api('/api/annotations/' + anotId, { method: 'DELETE' });
    document.querySelectorAll('.modal-bg').forEach(m => m.remove());
    refrescarAnotacionesVisor(sheetId);
    mostrarNotificacionOnline('Anotación quitada', '#6b7280');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ----- ENLACES ENTRE CATALOGOS (pila de navegación ir/volver) -----
let _navStack = [];
async function navegarAEnlaceCatalogo(zona) {
  // Guardar de dónde venimos (para la barra "volver a X pág. N")
  // backSheetId: si el enlace define una página de regreso, al volver iremos ahí
  // (para saltarse las hojas restantes del laboratorio) en vez de a la página del botón.
  _navStack.push({
    catalogoActual: appState.catalogoActual,
    visorIndice: appState.visorIndice || 0,
    nombreOrigen: _enlaceCatalogoNombre || null,
    backSheetId: zona.link_back_sheet_id || null
  });
  appState.vista = 'catalogos';
  appState.catalogoActual = zona.link_catalog_id;
  _enlaceCatalogoNombre = zona.link_catalog_nombre || 'Catálogo enlazado';
  // Página destino: si el enlace apunta a una lámina concreta, abrir por ahí
  let indice = 0;
  if (zona.link_sheet_id) {
    try {
      const r = await api('/api/catalogs/' + zona.link_catalog_id);
      const idx = (r.sheets || []).findIndex(s => Number(s.id) === Number(zona.link_sheet_id));
      if (idx >= 0) indice = idx;
    } catch (_) { /* si falla, abre por la 1 */ }
  }
  appState.visorIndice = indice;
  render();
  actualizarBarraEnlace();
}
async function volverDeEnlaceCatalogo() {
  const prev = _navStack.pop();
  if (prev) {
    appState.vista = 'catalogos';
    appState.catalogoActual = prev.catalogoActual;
    _enlaceCatalogoNombre = prev.nombreOrigen || null;
    // Si el enlace definió una página de regreso, aterrizar ahí (saltando las hojas
    // restantes del laboratorio). Si no, volver a la página del botón.
    let indice = prev.visorIndice || 0;
    if (prev.backSheetId) {
      try {
        const r = await api('/api/catalogs/' + prev.catalogoActual);
        const idx = (r.sheets || []).findIndex(s => Number(s.id) === Number(prev.backSheetId));
        if (idx >= 0) indice = idx;
      } catch (_) { /* si falla, vuelve a donde estaba */ }
    }
    appState.visorIndice = indice;
    render();
  }
  actualizarBarraEnlace();
}
// Nombre del catálogo enlazado en el que estamos ahora (para la barra)
let _enlaceCatalogoNombre = null;
// Barra FIJA arriba mientras estás en un catálogo enlazado: "🔗 Estás en X · ← Volver"
function actualizarBarraEnlace() {
  let bar = document.getElementById('barra-enlace');
  if (_navStack.length > 0) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'barra-enlace';
      bar.className = 'barra-enlace';
      document.body.appendChild(bar);
    }
    const prev = _navStack[_navStack.length - 1];
    const volverA = prev && prev.nombreOrigen ? ('a ' + prev.nombreOrigen) : 'atrás';
    // Solo mostramos el nº de página si volvemos a donde estábamos; si el enlace tiene
    // página de regreso propia, se resuelve al pulsar (no mostramos un número engañoso).
    const pag = (prev && !prev.backSheetId) ? (' (pág. ' + ((prev.visorIndice || 0) + 1) + ')') : '';
    bar.innerHTML = '';
    const info = document.createElement('span');
    info.className = 'barra-enlace-info';
    info.innerHTML = '🔗 Estás en <b>' + escape(_enlaceCatalogoNombre || 'catálogo enlazado') + '</b>';
    const btn = document.createElement('button');
    btn.className = 'barra-enlace-btn';
    btn.textContent = '← Volver ' + volverA + pag;
    btn.addEventListener('click', volverDeEnlaceCatalogo);
    bar.appendChild(info);
    bar.appendChild(btn);
  } else if (bar) {
    bar.remove();
  }
}
// Alias por compatibilidad (se llamaba así en volverACatalogos)
function actualizarBotonVolverEnlace() { actualizarBarraEnlace(); }

// Modal para anotar un producto de COMISION (Lainco…): unidades + descuento + almacen + socio.
// El almacen y el nº socio se recuerdan durante la visita (el pedido va a un mismo almacen).
async function pulsarZonaComision(zona) {
  if (!appState.visitaActiva) return;
  const $wrapper = document.getElementById('visor-imagen-wrapper');
  const sheetId = $wrapper ? Number($wrapper.dataset.sheetId) : null;
  const anotsSheet = _anotacionesVisita[sheetId] || [];
  const anotExistente = anotsSheet.find(a => a.zone_id === zona.id) || null;

  const nombre = zona.etiqueta || 'Producto de comisión';
  const variantes = Array.isArray(zona.comision_variantes) ? zona.comision_variantes.filter(v => String(v).trim()) : [];
  const uds0 = anotExistente && anotExistente.cantidad ? anotExistente.cantidad : 1;
  const dto0 = anotExistente && anotExistente.descuento != null ? anotExistente.descuento : '';
  const alm0 = (anotExistente && anotExistente.almacen) || _comisionUltimo.almacen || '';
  const soc0 = (anotExistente && anotExistente.num_socio) || _comisionUltimo.num_socio || '';

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>${anotExistente ? '✏️ Editar' : '🤝 Anotar'} comisión</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div class="zona-modal-producto" style="background:#fff7ed;border:1px solid #fed7aa">
        <span style="font-size:11px;color:#ea580c;font-weight:600">🤝 Comisión (no se factura)</span>
        <div style="font-size:14px;color:#374151;margin-top:2px;font-weight:600">${escape(nombre)}</div>
      </div>
      ${variantes.length ? `
        <div class="form-group" style="margin-top:12px">
          <label>Variante / referencia</label>
          <select id="com-variante" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box">
            ${variantes.map(v => `<option value="${escape(String(v)).replace(/"/g,'&quot;')}">${escape(String(v))}</option>`).join('')}
          </select>
        </div>
      ` : ''}
      <div style="display:flex;gap:10px;margin-top:14px">
        <div class="form-group" style="flex:1;margin:0">
          <label>Unidades</label>
          <input type="number" id="com-uds" min="1" value="${uds0}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;box-sizing:border-box">
        </div>
        <div class="form-group" style="flex:1;margin:0">
          <label>Descuento %</label>
          <input type="number" id="com-dto" min="0" max="100" step="0.5" value="${dto0}" placeholder="ej: 15" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;box-sizing:border-box">
        </div>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label>Almacén de envío <small style="color:#9ca3af">lo indica el cliente</small></label>
        <input type="text" id="com-almacen" value="${escape(alm0).replace(/"/g,'&quot;')}" placeholder="Nombre del almacén" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box">
      </div>
      <div class="form-group">
        <label>Nº de socio</label>
        <input type="text" id="com-socio" value="${escape(soc0).replace(/"/g,'&quot;')}" placeholder="Número de socio del cliente" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box">
      </div>
      <div id="com-msg"></div>
      <div class="modal-acciones">
        ${anotExistente ? `<button type="button" class="btn" style="background:#dc2626;color:#fff" onclick="borrarAnotacionZona(${anotExistente.id}, ${sheetId})">🗑️ Quitar</button>` : ''}
        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button type="button" class="btn btn-primary" id="com-guardar">${anotExistente ? 'Actualizar' : 'Anotar'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#com-guardar').addEventListener('click', async () => {
    const $msg = modal.querySelector('#com-msg');
    const unidades = Number(modal.querySelector('#com-uds').value) || 1;
    const dtoRaw = modal.querySelector('#com-dto').value;
    const descuento = dtoRaw === '' ? null : Number(dtoRaw);
    const almacen = modal.querySelector('#com-almacen').value.trim();
    const numSocio = modal.querySelector('#com-socio').value.trim();
    if (!almacen) { $msg.innerHTML = `<div class="error-msg">Indica el almacén de envío.</div>`; return; }
    // Recordar para las siguientes lineas de comision de esta visita
    _comisionUltimo = { almacen, num_socio: numSocio };
    // Si es una familia de comisión, el nombre es la variante elegida en el desplegable.
    const selVar = modal.querySelector('#com-variante');
    const nombreFinal = (selVar && selVar.value) ? selVar.value : nombre;
    // texto legible: "6 uds · NOMBRE · dto 15% · almacén X · socio Y"
    let texto = unidades + ' uds · ' + nombreFinal;
    if (descuento != null) texto += ' · dto ' + descuento + '%';
    texto += ' · almacén: ' + almacen;
    if (numSocio) texto += ' · socio: ' + numSocio;
    try {
      if (anotExistente) {
        await api('/api/annotations/' + anotExistente.id, {
          method: 'PUT',
          body: { texto_libre: texto, tipo: 'pedido', cantidad: unidades, descuento, almacen, num_socio: numSocio }
        });
      } else {
        await api('/api/visits/' + appState.visitaActiva.id + '/annotations', {
          method: 'POST',
          body: {
            sheet_id: sheetId, texto_libre: texto, tipo: 'pedido',
            cantidad: unidades, zone_id: zona.id,
            es_comision: true, descuento, almacen, num_socio: numSocio,
            pos_x: (zona.x + zona.ancho / 2) / 100, pos_y: (zona.y + zona.alto / 2) / 100
          }
        });
      }
      modal.remove();
      refrescarAnotacionesVisor(sheetId);
      mostrarNotificacionOnline('✅ ' + texto, '#ea580c');
    } catch (err) {
      $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

// ============================================================================
// REFERENCIAS SUELTAS DEL EXPOSITOR
// Un expositor (ej. de gafas) dado de alta como UNA sola zona; el cliente pide
// gafas SUELTAS que NO están en Sage. El comercial anota cada referencia +
// unidades a mano, sin dar de alta cada artículo. Cada línea es una anotación
// normal (zone_id + referencia) → sale en el carrito y en el resumen.
// ============================================================================
function pulsarZonaSueltas(zona) {
  if (!appState.visitaActiva) return;
  const $wrapper = document.getElementById('visor-imagen-wrapper');
  const sheetId = $wrapper ? Number($wrapper.dataset.sheetId) : null;
  document.querySelectorAll('#sueltas-modal').forEach(m => m.remove());
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.id = 'sueltas-modal';
  modal.dataset.zoneId = String(zona.id);
  modal.dataset.sheetId = String(sheetId);
  document.body.appendChild(modal);
  renderModalSueltas();
  setTimeout(() => { const r = document.getElementById('suelta-ref'); if (r) r.focus(); }, 60);
}

function renderModalSueltas() {
  const modal = document.getElementById('sueltas-modal');
  if (!modal) return;
  const zoneId = modal.dataset.zoneId;
  const sheetId = Number(modal.dataset.sheetId);
  const zona = (_zonasComercial || []).find(z => String(z.id) === String(zoneId)) || {};
  const nombre = zona.producto_nombre || zona.etiqueta || 'Expositor';
  const anotsSheet = _anotacionesVisita[sheetId] || [];
  const lineas = anotsSheet.filter(a => String(a.zone_id) === String(zoneId) && a.referencia);
  const tieneCompleto = !!(zona.product_id || zona.es_comision);
  const totalUds = lineas.reduce((s, a) => s + (Number(a.cantidad) || 1), 0);
  const listaHtml = lineas.length === 0
    ? `<div style="color:#9ca3af;font-size:13px;padding:8px 0">Aún no has anotado ninguna gafa suelta. Escribe la referencia y las unidades abajo.</div>`
    : lineas.map(a => `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f1f5f9">
          <span style="flex:1;font-size:14px;color:#374151"><b>${escape(a.referencia)}</b> · ${Number(a.cantidad) || 1} ud${(Number(a.cantidad) || 1) === 1 ? '' : 's'}</span>
          <button class="btn" style="width:auto;flex:0 0 auto;background:#fee2e2;color:#b91c1c;padding:4px 10px;font-size:12px" onclick="borrarLineaSuelta(${a.id})">Quitar</button>
        </div>`).join('');
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>🕶️ Referencias sueltas</h3>
        <button class="modal-cerrar" onclick="document.getElementById('sueltas-modal').remove()">×</button>
      </div>
      <div class="zona-modal-producto" style="background:#f0fdfa;border:1px solid #99f6e4">
        <span style="font-size:11px;color:#0d9488;font-weight:600">🕶️ Expositor — gafas sueltas (no están en Sage)</span>
        <div style="font-size:14px;color:#374151;margin-top:2px;font-weight:600">${escape(nombre)}</div>
      </div>
      <div style="margin-top:12px">${listaHtml}</div>
      ${lineas.length ? `<div style="text-align:right;font-size:12px;color:#0d9488;font-weight:600;margin-top:4px">${lineas.length} línea${lineas.length === 1 ? '' : 's'} · ${totalUds} ud${totalUds === 1 ? '' : 's'}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:14px;align-items:flex-end">
        <div class="form-group" style="flex:1 1 auto;margin:0">
          <label style="font-size:12px">Referencia de la gafa</label>
          <input type="text" id="suelta-ref" placeholder="ej: 14302, mod. Verona negra" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box" onkeydown="if(event.key==='Enter'){event.preventDefault();anadirLineaSuelta()}">
        </div>
        <div class="form-group" style="flex:0 0 74px;margin:0">
          <label style="font-size:12px">Uds</label>
          <input type="number" id="suelta-uds" min="1" value="1" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box" onkeydown="if(event.key==='Enter'){event.preventDefault();anadirLineaSuelta()}">
        </div>
      </div>
      <div id="suelta-msg"></div>
      <div class="modal-acciones">
        ${tieneCompleto ? `<button type="button" class="btn btn-secondary" onclick="pedirExpositorCompleto('${String(zoneId).replace(/'/g, "\\'")}')">Pedir expositor completo</button>` : ''}
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('sueltas-modal').remove()">Cerrar</button>
        <button type="button" class="btn btn-primary" onclick="anadirLineaSuelta()">➕ Añadir gafa</button>
      </div>
    </div>`;
}

async function anadirLineaSuelta() {
  const modal = document.getElementById('sueltas-modal');
  if (!modal) return;
  const zoneId = modal.dataset.zoneId;
  const sheetId = Number(modal.dataset.sheetId);
  const zona = (_zonasComercial || []).find(z => String(z.id) === String(zoneId)) || {};
  const nombre = zona.producto_nombre || zona.etiqueta || 'Expositor';
  const ref = (modal.querySelector('#suelta-ref')?.value || '').trim();
  const uds = Number(modal.querySelector('#suelta-uds')?.value) || 1;
  const $msg = modal.querySelector('#suelta-msg');
  if (!ref) { if ($msg) $msg.innerHTML = `<div class="error-msg">Escribe la referencia de la gafa.</div>`; return; }
  const texto = uds + ' ud' + (uds === 1 ? '' : 's') + ' · ref ' + ref + ' · expositor ' + nombre;
  try {
    await api('/api/visits/' + appState.visitaActiva.id + '/annotations', {
      method: 'POST',
      body: {
        sheet_id: sheetId, texto_libre: texto, tipo: 'pedido',
        cantidad: uds, zone_id: Number(zoneId), referencia: ref,
        pos_x: (zona.x + zona.ancho / 2) / 100, pos_y: (zona.y + zona.alto / 2) / 100
      }
    });
    await cargarAnotacionesDeVisita();
    if (typeof pintarVisor === 'function') pintarVisor();
    if (_carritoAbierto) renderCarritoContenido();
    renderModalSueltas();
    const r2 = document.getElementById('suelta-ref'); if (r2) r2.focus();
    mostrarNotificacionOnline('✅ ' + texto, '#0d9488');
  } catch (err) {
    if ($msg) $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

async function borrarLineaSuelta(anotId) {
  try {
    await api('/api/annotations/' + anotId, { method: 'DELETE' });
    await cargarAnotacionesDeVisita();
    if (typeof pintarVisor === 'function') pintarVisor();
    if (_carritoAbierto) renderCarritoContenido();
    renderModalSueltas();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Desde el modal de sueltas, pedir el expositor entero (producto Sage o comisión).
function pedirExpositorCompleto(zoneId) {
  const zona = (_zonasComercial || []).find(z => String(z.id) === String(zoneId));
  const m = document.getElementById('sueltas-modal'); if (m) m.remove();
  if (!zona) return;
  pulsarZonaComercial(Object.assign({}, zona, { __forzarNormal: true }));
}

// B7: ----- LONG-PRESS para crear PIN sobre la lámina -----
function engancharLongPressParaPin() {
  if (!appState.visitaActiva) return;
  const $wrapper = document.getElementById('visor-imagen-wrapper');
  if (!$wrapper) return;
  const sheetId = Number($wrapper.dataset.sheetId);
  if (!sheetId) return;

  let pressTimer = null;
  let pressStartX = 0, pressStartY = 0;
  let pressed = false;

  // Helper: calcular pos_x/pos_y relativos al wrapper (0-1)
  function getRelPos(clientX, clientY) {
    const rect = $wrapper.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  function iniciar(clientX, clientY) {
    cancelar();
    pressStartX = clientX;
    pressStartY = clientY;
    pressed = true;
    // Fase 2.c' E3: iluminar brevemente las zonas al tocar la lámina
    iluminarZonas();
    pressTimer = setTimeout(() => {
      if (!pressed) return;
      // Vibración como feedback haptico (si soportado)
      try { if (navigator.vibrate) navigator.vibrate(50); } catch (_) {}
      const pos = getRelPos(clientX, clientY);
      abrirModalAnotarConPin(sheetId, pos.x, pos.y);
      pressed = false;
      pressTimer = null;
    }, 550);
  }

  function cancelar() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    pressed = false;
  }

  function mover(clientX, clientY) {
    // Si el dedo se mueve > 10px, cancelar (es swipe, no long-press)
    if (!pressed) return;
    const dx = Math.abs(clientX - pressStartX);
    const dy = Math.abs(clientY - pressStartY);
    if (dx > 10 || dy > 10) cancelar();
  }

  // Touch
  $wrapper.addEventListener('touchstart', (e) => {
    // Solo si 1 dedo (multitouch = pinch, no nos interesa)
    if (e.touches.length !== 1) { cancelar(); return; }
    // Si toca un pin o una zona existente, no crear nuevo pin
    if (e.target.closest('.visor-pin')) return;
    if (e.target.closest('.visor-zona')) return;
    iniciar(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });

  $wrapper.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) {
      mover(e.touches[0].clientX, e.touches[0].clientY);
    } else {
      cancelar();
    }
  }, { passive: true });

  $wrapper.addEventListener('touchend', cancelar, { passive: true });
  $wrapper.addEventListener('touchcancel', cancelar, { passive: true });

  // Mouse (desktop) — equivalente: pulsar y mantener
  $wrapper.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // solo botón izquierdo
    if (e.target.closest('.visor-pin')) return;
    if (e.target.closest('.visor-zona')) return;
    iniciar(e.clientX, e.clientY);
  });
  $wrapper.addEventListener('mousemove', (e) => mover(e.clientX, e.clientY));
  $wrapper.addEventListener('mouseup', cancelar);
  $wrapper.addEventListener('mouseleave', cancelar);
}

// B7: abrir modal de anotar con pos_x/pos_y prerellenadas + cabecera roja PRIVADO si pantalla completa
async function abrirModalAnotarConPin(sheetId, posX, posY) {
  // Necesitamos info de la lamina actual
  const sheet = _visorSheets.find(s => s.id === sheetId);
  const numeroOriginal = _visorSheets.indexOf(sheet) + 1;
  const titulo = sheet && sheet.titulo || '';
  // Almacenar pos en variables globales para el modal
  window._pendingPinPos = { x: posX, y: posY };
  abrirModalAnotar(sheetId, titulo, numeroOriginal);
}

// B7: abrir detalle de un pin (al pulsarlo)
async function abrirDetallePin(annotationId) {
  // Buscar la anotacion en todas las del visita
  let anot = null;
  for (const sid in _anotacionesVisita) {
    const found = _anotacionesVisita[sid].find(a => a.id === annotationId);
    if (found) { anot = found; break; }
  }
  if (!anot) return;
  // Mostrar modal pequeño con detalle y acciones
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  const icon = anot.tipo === 'pedido' ? '🛒' : anot.tipo === 'devolucion' ? '↩️' : '📝';
  const tipoLabel = anot.tipo === 'pedido' ? 'Pedido' : anot.tipo === 'devolucion' ? 'Devolución' : 'Nota';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>${icon} ${escape(tipoLabel)}</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:14px;white-space:pre-wrap;margin:0 0 16px">${escape(anot.texto_libre)}</p>
      <div class="modal-acciones">
        <button class="btn btn-secondary btn-pequeno" onclick="this.closest('.modal-bg').remove();editarAnotacion(${anot.id}, ${anot.sheet_id}, ${JSON.stringify(anot.texto_libre).replace(/"/g,'&quot;')}, '${anot.tipo}')">✏️ Editar</button>
        <button class="btn btn-secondary btn-pequeno" onclick="if(confirm('¿Borrar este pin?')){this.closest('.modal-bg').remove();borrarAnotacion(${anot.id}, ${anot.sheet_id});}">🗑️ Borrar</button>
        <button class="btn btn-primary btn-pequeno" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

// B7: ----- PANTALLA COMPLETA con controles auto-ocultos -----
let _fullscreenActivo = false;
let _fullscreenHideTimer = null;

function entrarPantallaCompleta() {
  _fullscreenActivo = true;
  // Intentar pantalla completa del navegador (si soportado)
  try {
    const elem = document.documentElement;
    if (elem.requestFullscreen) elem.requestFullscreen().catch(()=>{});
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
  } catch (_) {}
  document.body.classList.add('visor-fullscreen-activo');
  // Inyectar controles flotantes (se ocultan/muestran via CSS según clase del body)
  let $ctrl = document.getElementById('fullscreen-controles');
  if (!$ctrl) {
    $ctrl = document.createElement('div');
    $ctrl.id = 'fullscreen-controles';
    $ctrl.className = 'fullscreen-controles';
    document.body.appendChild($ctrl);
  }
  $ctrl.innerHTML = `
    <button class="fs-btn fs-btn-salir" onclick="salirPantallaCompleta()" title="Salir (ESC)" style="position:fixed;top:16px;right:16px">×</button>
    <button class="fs-btn fs-btn-anterior" onclick="visorAnterior()" title="Anterior" style="position:fixed;top:50%;left:16px;transform:translateY(-50%)">◀</button>
    <button class="fs-btn fs-btn-siguiente" onclick="visorSiguiente()" title="Siguiente" style="position:fixed;top:50%;right:16px;transform:translateY(-50%)">▶</button>
  `;
  mostrarControlesFullscreen();
  // Re-enganchar long-press en la nueva imagen (porque el wrapper se redibuja)
  // No es necesario porque pintarVisor reengancha, pero por seguridad:
  setTimeout(() => engancharLongPressParaPin(), 50);
}

function salirPantallaCompleta() {
  _fullscreenActivo = false;
  try {
    if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (_) {}
  document.body.classList.remove('visor-fullscreen-activo');
  document.body.classList.remove('visor-fullscreen-controles-visibles');
  if (_fullscreenHideTimer) { clearTimeout(_fullscreenHideTimer); _fullscreenHideTimer = null; }
  // Limpiar controles inyectados
  const $ctrl = document.getElementById('fullscreen-controles');
  if ($ctrl) $ctrl.remove();
}

function mostrarControlesFullscreen() {
  if (!_fullscreenActivo) return;
  document.body.classList.add('visor-fullscreen-controles-visibles');
  if (_fullscreenHideTimer) clearTimeout(_fullscreenHideTimer);
  _fullscreenHideTimer = setTimeout(() => {
    document.body.classList.remove('visor-fullscreen-controles-visibles');
  }, 2800);
}

// Cualquier toque/click reactiva los controles fullscreen
document.addEventListener('click', () => {
  if (_fullscreenActivo) mostrarControlesFullscreen();
}, true);

// Detectar salida de fullscreen del navegador (ESC, gesto del sistema)
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && _fullscreenActivo) {
    _fullscreenActivo = false;
    document.body.classList.remove('visor-fullscreen-activo');
    document.body.classList.remove('visor-fullscreen-controles-visibles');
  }
});

// ============================================================================
async function abrirSelectorImpersonacion() {
  try {
    const r = await api('/api/users');
    const comerciales = (r.users || []).filter(u => u.role === 'sales' && u.is_active);

    const modal = document.createElement('div');
    modal.className = 'modal-bg';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h3>👁 Ver CatalogPRO como…</h3>
          <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
        </div>
        <div style="background:#fffaf0;border:1px solid #ffe4b3;border-radius:10px;padding:11px;margin-bottom:1rem;font-size:12px;color:#856404;line-height:1.5">
          <b>💡 Modo "Ver como":</b><br>
          Verás la app como si fueras ese comercial: solo SUS catálogos asignados, SUS clientes, etc.<br>
          Útil para soporte ("¿qué ve Iván en su tablet?") y para usar tu propia faceta de comercial.
        </div>
        ${comerciales.length === 0 ? `
          <div style="text-align:center;padding:2rem;color:var(--gris-texto)">
            <p>Aún no hay comerciales creados.</p>
            <button class="btn btn-primary" style="margin-top:1rem" onclick="this.closest('.modal-bg').remove(); irA('comerciales'); abrirModalNuevoUsuario();">+ Crear primer comercial</button>
          </div>
        ` : `
          <div class="comerciales-lista" style="gap:6px">
            ${comerciales.map(c => `
              <button class="comercial-impersonar" onclick="impersonar(${c.id}, '${escape(c.name)}', '${escape(c.sage_commercial_code || '')}')">
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--texto)">${escape(c.name)}</div>
                  <div style="font-size:11px;color:var(--gris-texto)">
                    📧 ${escape(c.email)}
                    ${c.sage_commercial_code ? ` · 🏷️ Sage: ${escape(c.sage_commercial_code)}` : ' · <span style="color:#c33">⚠ sin código Sage</span>'}
                  </div>
                </div>
                <span style="color:var(--rosa);font-size:18px">👁</span>
              </button>
            `).join('')}
          </div>
        `}
      </div>
    `;
    document.body.appendChild(modal);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function impersonar(userId, userName, sageCode) {
  impersonating = {
    id: userId,
    name: userName,
    sage_commercial_code: sageCode || null
  };
  localStorage.setItem('cpv2_impersonate', JSON.stringify(impersonating));
  // Cerrar modal
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());
  // Reset estado de vista
  appState.vista = 'catalogos';
  appState.catalogoActual = null;
  render();
}

function dejarImpersonacion() {
  impersonating = null;
  localStorage.removeItem('cpv2_impersonate');
  appState.vista = 'catalogos';
  appState.catalogoActual = null;
  render();
}

// ============================================================================
// ASIGNAR CATALOGO A COMERCIALES
// ============================================================================
async function abrirAsignacionComerciales(catalogId) {
  try {
    const [catR, asgR] = await Promise.all([
      api('/api/catalogs/' + catalogId),
      api('/api/catalogs/' + catalogId + '/assignments')
    ]);
    const catalog = catR.catalog;
    const usuarios = (asgR.users || []).filter(u => u.role === 'sales' && u.is_active);

    const modal = document.createElement('div');
    modal.className = 'modal-bg';
    modal.innerHTML = `
      <div class="modal-card" style="max-width:520px">
        <div class="modal-header">
          <h3>👥 Asignar catálogo a comerciales</h3>
          <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
        </div>
        <div style="background:#fffaf0;border:1px solid #ffe4b3;border-radius:10px;padding:11px;margin-bottom:1rem;font-size:12px;color:#856404;line-height:1.5">
          <b>📚 ${escape(catalog.name)}</b><br>
          Marca los comerciales que deben ver este catálogo. Solo verán los catálogos que tú les asignes.
        </div>

        ${usuarios.length === 0 ? `
          <div style="text-align:center;padding:1.5rem;color:var(--gris-texto)">
            <p>No hay comerciales activos.</p>
            <button class="btn btn-primary" style="margin-top:1rem;max-width:280px;margin:1rem auto 0" onclick="this.closest('.modal-bg').remove(); irA('comerciales'); abrirModalNuevoUsuario();">+ Crear comercial</button>
          </div>
        ` : `
          <div class="asignaciones-lista" id="asignaciones-lista">
            ${usuarios.map(u => {
              const asignado = !!u.assignment_id;
              return `
                <label class="asignacion-fila ${asignado ? 'asignacion-activa' : ''}">
                  <input type="checkbox" class="asg-check" data-uid="${u.id}" ${asignado ? 'checked' : ''}>
                  <div class="asignacion-info">
                    <div class="asignacion-nombre">${escape(u.name)}</div>
                    <div class="asignacion-meta">
                      📧 ${escape(u.email)}
                      ${u.sage_commercial_code ? ` · 🏷️ Sage: ${escape(u.sage_commercial_code)}` : ''}
                    </div>
                  </div>
                  <span class="asg-status">${asignado ? '✓ asignado' : ''}</span>
                </label>
              `;
            }).join('')}
          </div>
          <div id="asg-msg" style="margin-top:0.8rem"></div>
          <div class="modal-acciones">
            <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
          </div>
        `}
      </div>
    `;
    document.body.appendChild(modal);

    // Listener para cada checkbox: asigna/desasigna en cuanto cambia
    modal.querySelectorAll('.asg-check').forEach(cb => {
      cb.addEventListener('change', async () => {
        const uid = Number(cb.dataset.uid);
        const $fila = cb.closest('.asignacion-fila');
        const $status = $fila.querySelector('.asg-status');
        const $msg = document.getElementById('asg-msg');
        $msg.innerHTML = '';
        cb.disabled = true;
        try {
          if (cb.checked) {
            await api('/api/catalogs/' + catalogId + '/assignments', {
              method: 'POST',
              body: { user_id: uid }
            });
            $fila.classList.add('asignacion-activa');
            $status.textContent = '✓ asignado';
          } else {
            await api('/api/catalogs/' + catalogId + '/assignments/' + uid, {
              method: 'DELETE'
            });
            $fila.classList.remove('asignacion-activa');
            $status.textContent = '';
          }
        } catch (err) {
          $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
          cb.checked = !cb.checked; // revertir
        } finally {
          cb.disabled = false;
        }
      });
    });
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ============================================================================
// ===== D - PLANTILLAS DE ANOTACION (admin) =====
// ============================================================================

let _plantillasCache = null; // se rellena al cargar; null = aún no cargadas

// Uso de plantillas POR DISPOSITIVO (localStorage): cada comercial acumula en su tablet
// las que más usa → sección "Frecuentes". No necesita backend ni tocar la BD.
function _tplUso() { try { return JSON.parse(localStorage.getItem('cpv2_tpl_uso') || '{}'); } catch { return {}; } }
function _tplUsoInc(txt) { const u = _tplUso(); u[txt] = (u[txt] || 0) + 1; try { localStorage.setItem('cpv2_tpl_uso', JSON.stringify(u)); } catch {} }

// Agrupa y ORDENA las plantillas para la selección rápida del comercial. Con muchas
// (p.ej. 52 bonificaciones) esto + el buscador es lo que la hace usable:
//  - Frecuentes: las más usadas en esta tablet (atajo).
//  - Descuentos: por % ascendente.
//  - Bonificaciones: agrupadas por su número BASE (12+1, 12+2… juntas), base asc.
function _ordenarPlantillas(plantillas) {
  const numDto = t => { const m = String(t.texto || '').match(/(\d+(?:[.,]\d+)?)\s*%/); return m ? parseFloat(m[1].replace(',', '.')) : 1e9; };
  const nums = t => { const a = (String(t.texto || '').match(/\d+/g) || []).map(Number); return [a[0] ?? 1e9, a[1] ?? 1e9]; };
  const esDto = p => p.tipo === 'pedido' && p.clase === 'descuento';
  const esBon = p => p.tipo === 'pedido' && p.clase === 'bonificacion';
  const dtos = plantillas.filter(esDto).sort((a, b) => numDto(a) - numDto(b));
  const bons = plantillas.filter(esBon).sort((a, b) => { const na = nums(a), nb = nums(b); return na[0] - nb[0] || na[1] - nb[1]; });
  const otros = plantillas.filter(p => !esDto(p) && !esBon(p));
  const uso = _tplUso();
  const frecuentes = plantillas.filter(p => uso[p.texto]).sort((a, b) => uso[b.texto] - uso[a.texto]).slice(0, 8);
  return { frecuentes, dtos, bons, otros };
}

async function cargarPlantillas() {
  try {
    const r = await api('/api/annotation-templates');
    _plantillasCache = r.templates || [];
  } catch (e) {
    _plantillasCache = [];
  }
  return _plantillasCache;
}

function invalidarPlantillasCache() {
  _plantillasCache = null;
}

// Pantalla de gestión de plantillas (admin REAL)
async function renderListaPlantillas() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando plantillas…</div></div>`;
  try {
    await cargarPlantillas();
    const tpls = _plantillasCache || [];

    const iconoTipo = (t) => t === 'pedido' ? '🛒' : t === 'devolucion' ? '↩️' : '📝';
    const colorTipo = (t) => t === 'pedido' ? 'tipo-pedido' : t === 'devolucion' ? 'tipo-devolucion' : 'tipo-nota';

    let html = `
      <div class="contenedor" style="max-width:780px">
        <div class="titulo-pagina">
          <div>
            <h2>🏷️ Plantillas de anotación</h2>
            <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
              Frases rápidas que los comerciales pueden insertar de un toque mientras anotan en una visita.
            </div>
          </div>
          <button class="btn btn-primary btn-pequeno" onclick="abrirModalNuevaPlantilla()">+ Nueva plantilla</button>
        </div>

        <div class="editor-panel">
          ${tpls.length === 0
            ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">No hay plantillas. Crea la primera con el botón "+ Nueva plantilla".</p>`
            : `<div class="plantilla-lista" id="plantilla-lista">
                ${tpls.map(t => `
                  <div class="plantilla-fila" data-id="${t.id}" draggable="true">
                    <div class="drag-handle" title="Arrastra para reordenar">⋮⋮</div>
                    ${(t.tipo === 'pedido' && t.clase === 'descuento')
                      ? '<span class="plantilla-tipo-badge tpl-badge-descuento">🏷️ descuento %</span>'
                      : (t.tipo === 'pedido' && t.clase === 'bonificacion')
                        ? '<span class="plantilla-tipo-badge tpl-badge-bonif">🎁 bonificación</span>'
                        : `<span class="plantilla-tipo-badge ${colorTipo(t.tipo)}">${iconoTipo(t.tipo)} ${t.tipo}</span>`}
                    <span class="plantilla-texto">${escape(t.texto)}</span>
                    <div class="plantilla-acciones">
                      <button onclick="editarPlantilla(${t.id})" title="Editar">✏️</button>
                      <button class="btn-borrar" onclick="borrarPlantilla(${t.id})" title="Borrar">🗑️</button>
                    </div>
                  </div>
                `).join('')}
              </div>`
          }
        </div>
      </div>
    `;
    $v.innerHTML = html;

    activarDragDropPlantillas();
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

// Muestra el selector "Condición del pedido" solo cuando el tipo es "pedido".
function _toggleCondicionPlantilla() {
  const tipo = document.getElementById('tpl-tipo');
  const grupo = document.getElementById('tpl-condicion-grupo');
  if (grupo) grupo.style.display = (tipo && tipo.value === 'pedido') ? '' : 'none';
}

function abrirModalNuevaPlantilla() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>Nueva plantilla</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="modal-error"></div>
      <form id="form-nueva-plantilla">
        <div class="form-group">
          <label>Tipo</label>
          <select id="tpl-tipo" onchange="_toggleCondicionPlantilla()">
            <option value="pedido">🛒 Pedido</option>
            <option value="devolucion">↩️ Devolución</option>
            <option value="nota">📝 Nota</option>
          </select>
        </div>
        <div class="form-group" id="tpl-condicion-grupo">
          <label>Condición del pedido</label>
          <select id="tpl-clase">
            <option value="normal">🛒 Pedido normal</option>
            <option value="descuento">🏷️ Descuento en %</option>
            <option value="bonificacion">🎁 Bonificación en género (12+1…)</option>
          </select>
          <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Solo para distinguirlas de un vistazo (color/etiqueta). No cambia el pedido.</div>
        </div>
        <div class="form-group">
          <label>Texto (máx 150 caracteres)</label>
          <input type="text" id="tpl-texto" required maxlength="150" placeholder="Ej: 12+1 oferta">
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Crear</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => { const t = document.getElementById('tpl-texto'); if (t) t.focus(); _toggleCondicionPlantilla(); }, 50);
  document.getElementById('form-nueva-plantilla').addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = document.getElementById('tpl-texto').value.trim();
    const tipo = document.getElementById('tpl-tipo').value;
    const clase = tipo === 'pedido' ? document.getElementById('tpl-clase').value : null;
    try {
      await api('/api/annotation-templates', { method: 'POST', body: { texto, tipo, clase } });
      modal.remove();
      invalidarPlantillasCache();
      renderListaPlantillas();
    } catch (err) {
      document.getElementById('modal-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

async function editarPlantilla(id) {
  const tpl = (_plantillasCache || []).find(t => t.id === id);
  if (!tpl) return;
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>Editar plantilla</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="modal-error"></div>
      <form id="form-editar-plantilla">
        <div class="form-group">
          <label>Tipo</label>
          <select id="tpl-tipo" onchange="_toggleCondicionPlantilla()">
            <option value="pedido" ${tpl.tipo === 'pedido' ? 'selected' : ''}>🛒 Pedido</option>
            <option value="devolucion" ${tpl.tipo === 'devolucion' ? 'selected' : ''}>↩️ Devolución</option>
            <option value="nota" ${tpl.tipo === 'nota' ? 'selected' : ''}>📝 Nota</option>
          </select>
        </div>
        <div class="form-group" id="tpl-condicion-grupo">
          <label>Condición del pedido</label>
          <select id="tpl-clase">
            <option value="normal" ${(!tpl.clase || tpl.clase === 'normal') ? 'selected' : ''}>🛒 Pedido normal</option>
            <option value="descuento" ${tpl.clase === 'descuento' ? 'selected' : ''}>🏷️ Descuento en %</option>
            <option value="bonificacion" ${tpl.clase === 'bonificacion' ? 'selected' : ''}>🎁 Bonificación en género (12+1…)</option>
          </select>
          <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Solo para distinguirlas de un vistazo (color/etiqueta). No cambia el pedido.</div>
        </div>
        <div class="form-group">
          <label>Texto</label>
          <input type="text" id="tpl-texto" required maxlength="150" value="${escape(tpl.texto)}">
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => _toggleCondicionPlantilla(), 30);
  document.getElementById('form-editar-plantilla').addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = document.getElementById('tpl-texto').value.trim();
    const tipo = document.getElementById('tpl-tipo').value;
    const clase = tipo === 'pedido' ? document.getElementById('tpl-clase').value : null;
    try {
      await api('/api/annotation-templates/' + id, { method: 'PUT', body: { texto, tipo, clase } });
      modal.remove();
      invalidarPlantillasCache();
      renderListaPlantillas();
    } catch (err) {
      document.getElementById('modal-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

async function borrarPlantilla(id) {
  if (!confirm('¿Borrar esta plantilla? Los comerciales ya no la verán.')) return;
  try {
    await api('/api/annotation-templates/' + id, { method: 'DELETE' });
    invalidarPlantillasCache();
    renderListaPlantillas();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function activarDragDropPlantillas() {
  const lista = document.getElementById('plantilla-lista');
  if (!lista) return;
  let dragged = null;
  lista.querySelectorAll('.plantilla-fila').forEach(fila => {
    fila.addEventListener('dragstart', () => {
      dragged = fila;
      fila.classList.add('lamina-arrastrando');
    });
    fila.addEventListener('dragend', () => {
      fila.classList.remove('lamina-arrastrando');
      dragged = null;
    });
    fila.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragged || dragged === fila) return;
      if (fila.parentNode !== lista || dragged.parentNode !== lista) return;
      const rect = fila.getBoundingClientRect();
      const mitad = rect.top + rect.height / 2;
      try {
        if (e.clientY < mitad) {
          if (fila.previousSibling !== dragged) lista.insertBefore(dragged, fila);
        } else {
          const ref = fila.nextSibling;
          if (ref === dragged) {
            // ya está en posición
          } else if (ref && ref.parentNode === lista) {
            lista.insertBefore(dragged, ref);
          } else {
            lista.appendChild(dragged);
          }
        }
      } catch (_) { /* defensa silenciosa */ }
    });
    fila.addEventListener('drop', async (e) => {
      e.preventDefault();
      const ids = Array.from(lista.querySelectorAll('.plantilla-fila')).map(f => Number(f.dataset.id));
      try {
        await api('/api/annotation-templates/reorder', { method: 'PUT', body: { ids } });
        invalidarPlantillasCache();
      } catch (err) {
        alert('Error al reordenar: ' + err.message);
      }
    });
  });
}

// ============================================================================
// ===== C - CONFIGURACION DE EMAILS (admin real) =====
// ============================================================================

async function renderConfiguracion() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando configuración…</div></div>`;
  try {
    const r = await api('/api/email-config');
    const cfg = {};
    (r.config || []).forEach(row => { cfg[row.clave] = { valor: row.valor || '', descripcion: row.descripcion || '' }; });

    const modoActual = (cfg.modo && cfg.modo.valor) || 'pruebas';
    const esProd = modoActual === 'produccion';

    let html = `
      <div class="contenedor" style="max-width:780px">
        <div class="titulo-pagina">
          <div>
            <h2>⚙️ Configuración de emails</h2>
            <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
              Controla cómo se envían los emails automáticos al cerrar una visita.
            </div>
          </div>
        </div>

        <!-- BLOQUE 1: Modo (interruptor pruebas/producción) -->
        <div class="editor-panel" style="margin-bottom:14px">
          <h3 style="margin-top:0">Modo de envío ${ayuda('PRUEBAS = los emails se redirigen a las direcciones de prueba (no llegan al cliente real). Sirve para probar sin spamear. PRODUCCIÓN = los emails se envían a destinatarios reales (oficina, cliente, comerciales). Cambia a PRODUCCIÓN solo cuando estés seguro.')}</h3>
          <div class="modo-switch-bg" id="modo-switch-bg">
            <button class="modo-btn ${!esProd ? 'modo-btn-activo modo-btn-pruebas' : ''}" onclick="cambiarModo('pruebas')">🔴 MODO PRUEBAS</button>
            <button class="modo-btn ${esProd ? 'modo-btn-activo modo-btn-prod' : ''}" onclick="cambiarModo('produccion')">🟢 MODO PRODUCCIÓN</button>
          </div>
          <div style="font-size:13px;color:var(--gris-texto);margin-top:10px">
            ${esProd
              ? '🟢 <b>PRODUCCIÓN</b>: cada visita cerrada envía los 3 emails reales (oficina, cliente, comercial). ⚠️ Estás en modo real.'
              : '🔴 <b>PRUEBAS</b>: todos los emails se redirigen a los emails de prueba configurados abajo. El destinatario real aparece en el asunto. Seguro para desarrollar.'
            }
          </div>
        </div>

        <!-- BLOQUE 2: Emails de oficina (producción) -->
        <div class="editor-panel" style="margin-bottom:14px">
          <h3 style="margin-top:0">📧 Emails de oficina <span style="font-size:11px;font-weight:normal;color:var(--gris-texto)">(modo producción)</span></h3>
          <p style="font-size:13px;color:var(--gris-texto)">Direcciones que reciben el resumen + PDF al cerrar cada visita. Separa con comas.</p>
          <input type="text" id="cfg-oficina_emails" value="${escape(cfg.oficina_emails && cfg.oficina_emails.valor || '')}"
                 placeholder="pedidos@lomhifar.net, eva@lomhifar.net" style="width:100%;padding:8px 12px;border:1px solid var(--gris-borde);border-radius:8px;font-size:14px;outline:none">
        </div>

        <!-- BLOQUE 3: Emails de prueba -->
        <div class="editor-panel" style="margin-bottom:14px">
          <h3 style="margin-top:0">🧪 Emails de prueba <span style="font-size:11px;font-weight:normal;color:var(--gris-texto)">(modo pruebas)</span></h3>
          <p style="font-size:13px;color:var(--gris-texto)">A donde se redirigen los emails cuando el modo es PRUEBAS. Puedes poner el mismo email en los tres para recibir todo.</p>
          <div class="form-group">
            <label>📧 Para "oficina"</label>
            <input type="email" id="cfg-pruebas_email_oficina" value="${escape(cfg.pruebas_email_oficina && cfg.pruebas_email_oficina.valor || '')}" placeholder="tucorreo@gmail.com">
          </div>
          <div class="form-group">
            <label>👤 Para "cliente"</label>
            <input type="email" id="cfg-pruebas_email_cliente" value="${escape(cfg.pruebas_email_cliente && cfg.pruebas_email_cliente.valor || '')}" placeholder="tucorreo+cliente@gmail.com">
          </div>
          <div class="form-group">
            <label>👨‍💼 Para "comercial"</label>
            <input type="email" id="cfg-pruebas_email_comercial" value="${escape(cfg.pruebas_email_comercial && cfg.pruebas_email_comercial.valor || '')}" placeholder="tucorreo+comercial@gmail.com">
          </div>
          <div style="font-size:11px;color:var(--gris-texto);margin-top:6px">
            💡 Truco: en Gmail, "tucorreo+algo@gmail.com" llega al mismo buzón pero se puede filtrar. Útil para distinguir los 3 tipos durante pruebas.
          </div>
        </div>

        <!-- BLOQUE 4: Remitente y firma -->
        <div class="editor-panel" style="margin-bottom:14px">
          <h3 style="margin-top:0">✍️ Remitente y firma</h3>
          <div class="form-group">
            <label>Remitente FROM (visible en el "De:")</label>
            <input type="text" id="cfg-remitente_from" value="${escape(cfg.remitente_from && cfg.remitente_from.valor || '')}" placeholder='"CatalogPRO LOMHIFAR" <f.ayllon66@gmail.com>'>
            <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">
              ⚠️ Si está configurado SMTP_FROM en Railway, ese tiene prioridad sobre este campo.
            </div>
          </div>
          <div class="form-group">
            <label>Firma HTML al pie de los emails</label>
            <textarea id="cfg-firma_html" rows="3">${escape(cfg.firma_html && cfg.firma_html.valor || '')}</textarea>
          </div>
        </div>

        <!-- BLOQUE 5: Planning de visitas -->
        <div class="editor-panel" style="margin-bottom:14px">
          <h3 style="margin-top:0">🗓️ Planning de visitas</h3>
          <p style="font-size:13px;color:var(--gris-texto)">Reglas globales para calcular cuándo un cliente está al día, próximo o urgente. Cada cliente puede tener su propio ciclo (sobrescribe estos valores).</p>
          <div class="form-group">
            <label>Ciclo por defecto (días)</label>
            <input type="number" id="cfg-planning_ciclo_default" value="${escape(cfg.planning_ciclo_default && cfg.planning_ciclo_default.valor || '90')}" min="1" max="730">
            <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Cada cuántos días se debe visitar a un cliente que NO tenga ciclo propio. Por defecto: 90 días.</div>
          </div>
          <div class="form-group">
            <label>Ventana "próxima" (días antes del ciclo)</label>
            <input type="number" id="cfg-planning_ventana_proxima_dias" value="${escape(cfg.planning_ventana_proxima_dias && cfg.planning_ventana_proxima_dias.valor || '15')}" min="0" max="365">
            <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Cuando faltan estos días para cumplir el ciclo, el cliente pasa a 🟡 amarillo. Ej: ciclo 90d + ventana 15d → amarillo desde día 75.</div>
          </div>
          <div class="form-group">
            <label>Ventana "urgente" (días después del ciclo)</label>
            <input type="number" id="cfg-planning_ventana_urgente_dias" value="${escape(cfg.planning_ventana_urgente_dias && cfg.planning_ventana_urgente_dias.valor || '15')}" min="0" max="365">
            <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Cuando pasan estos días por encima del ciclo sin visitar, el cliente pasa a 🔴 rojo (urgente). Ej: ciclo 90d + ventana 15d → rojo a partir de día 106.</div>
          </div>
        </div>

        <!-- BLOQUE 6: Geocoding -->
        <div class="editor-panel" style="margin-bottom:14px">
          <h3 style="margin-top:0">🌍 Geocoding de clientes</h3>
          <p style="font-size:13px;color:var(--gris-texto)">
            Calcula las coordenadas GPS de cada cliente a partir de su dirección, CP, municipio y provincia.
            Es necesario para mostrar clientes en el mapa.
            <br><br>
            <b>⚠️ Importante:</b> el proceso tarda aproximadamente <b>1 segundo por cliente</b> (límite del servicio gratuito de OpenStreetMap).
            Para 2949 clientes son ~50 minutos. Puedes dejarlo corriendo en segundo plano mientras haces otras cosas.
          </p>
          <div id="geocoding-stats" style="background:var(--surface-2);padding:12px;border-radius:8px;margin:12px 0;font-size:13px">
            Cargando estado…
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="iniciarGeocoding(true)" id="btn-geo-faltantes">🌍 Geocodificar pendientes</button>
            <button class="btn btn-secondary" onclick="iniciarGeocoding(false)" id="btn-geo-todos">🔄 Re-geocodificar TODOS</button>
            <button class="btn btn-secondary" onclick="cancelarGeocoding()" id="btn-geo-cancelar" style="display:none">⏹️ Cancelar</button>
          </div>
        </div>

        <!-- BLOQUE 7: Zona de peligro -->
        <div class="editor-panel" style="margin-bottom:14px;border:2px solid #fecaca;background:#fef2f2">
          <h3 style="margin-top:0;color:#b91c1c">🗑️ Zona de peligro — Limpiar datos de prueba</h3>
          <p style="font-size:13px;color:#7f1d1d">
            Borra <b>todos los catálogos, láminas, visitas, anotaciones y versiones</b> para empezar de cero
            con el catálogo definitivo.
            <br><br>
            <b>✅ NO se tocan:</b> los 10.607 productos, los clientes, los usuarios, las plantillas de anotación
            ni la configuración de emails.
            <br>
            <b>⚠️ Esta acción es irreversible.</b> Asegúrate de tener descargada cualquier versión que quieras conservar.
          </p>
          <div id="limpiar-pruebas-stats" style="background:var(--surface);padding:12px;border-radius:8px;margin:12px 0;font-size:13px;border:1px solid #fecaca">
            Cargando recuento…
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn" style="background:#dc2626;color:#fff" onclick="abrirModalLimpiarPruebas()">🗑️ Limpiar datos de prueba</button>
          </div>
        </div>

        <!-- ACCIONES -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:14px">
          <button class="btn btn-secondary" onclick="enviarEmailPrueba()">📨 Enviar email de prueba</button>
          <button class="btn btn-primary" onclick="guardarConfiguracion()">💾 Guardar cambios</button>
        </div>

        <!-- PANEL CATEGORÍAS / TAGS -->
        <div class="editor-panel" style="margin-bottom:14px">
          <h3 style="margin-top:0">🏷️ Categorías de láminas ${ayuda('Define las categorías que se podrán asignar a cada lámina (ej: Verano, Promo, Vista, Presbicia, Higiene). Una lámina puede tener varias categorías. Sirven para filtrar en el editor y en el visor de los comerciales, y para buscar con Ctrl+K.')}</h3>
          <div style="font-size:13px;color:var(--gris-texto);margin-bottom:12px">
            Las categorías ayudan a organizar las láminas. Cada lámina puede tener varias.
          </div>
          <div id="categorias-lista" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
            <div class="loading" style="padding:1rem">Cargando categorías…</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid #e5e7eb;padding-top:12px">
            <input type="text" id="cat-nueva-nombre" placeholder="Nueva categoría (ej: Verano)" maxlength="80" style="flex:1;min-width:160px;padding:8px;border:1px solid #d1d5db;border-radius:6px">
            <input type="color" id="cat-nueva-color" value="#cc007a" title="Color" style="width:50px;height:36px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer">
            <button class="btn btn-primary btn-pequeno" onclick="crearCategoria()">+ Crear</button>
          </div>
          <div id="cat-msg" style="margin-top:8px"></div>
        </div>

        <!-- BLOQUE: Carpetas MEGA (sistema de respaldo) -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">☁️ Carpetas MEGA (sistema de respaldo)
            ${ayuda('Carpetas raíz en tu cuenta MEGA donde se suben los backups de catálogos como fotos sueltas. Cada carpeta debe compartirse manualmente desde MEGA (clic derecho → Obtener enlace) y pegar el enlace público aquí.', 'izq')}
          </h3>
          <div style="font-size:12px;color:var(--gris-texto);margin-bottom:10px">
            El sistema sube las láminas correctamente pero MEGA <b>no permite generar el enlace público desde el servidor</b>.
            La solución: tú compartes cada carpeta manualmente en MEGA una vez y pegas el enlace aquí.
          </div>
          <div id="mega-folders-lista">
            <div style="color:var(--gris-texto);font-size:13px;padding:12px;text-align:center">Cargando carpetas…</div>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gris-borde)">
            <button class="btn btn-primary btn-pequeno" onclick="abrirNuevaCarpetaMega()">+ Nueva carpeta MEGA</button>
            <button class="btn btn-secondary btn-pequeno" onclick="seedCarpetasMega(this)" style="margin-left:8px">🌱 Crear las 6 carpetas iniciales</button>
          </div>
        </div>

        <!-- BLOQUE: Ofertas / Campañas (F4 precios dinámicos) -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">🎯 Ofertas y campañas
            ${ayuda('Ofertas con fecha de inicio y fin que se muestran sobre los productos en el visor comercial. Caducan solas. Pueden aplicar a un producto, a todos los de una marca/laboratorio o familia, o a todo el catálogo.', 'izq')}
          </h3>
          <div style="font-size:12px;color:var(--gris-texto);margin-bottom:10px">
            Descuento %, bonificación en género (ej. "3+1") o texto libre. Se pintan como etiqueta sobre la zona del producto durante la vigencia.
          </div>
          <div id="ofertas-lista">
            <div style="color:var(--gris-texto);font-size:13px;padding:12px;text-align:center">Cargando ofertas…</div>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gris-borde)">
            <button class="btn btn-primary btn-pequeno" onclick="abrirNuevaOferta()">+ Nueva oferta</button>
          </div>
        </div>

        <!-- BLOQUE: Interruptor maestro de precios dinámicos -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">💶 Precios dinámicos en las láminas
            ${ayuda('Interruptor general. Encendido: las láminas muestran el precio de la BD (tapando el impreso) en el visor y en las exportaciones. Apagado: las láminas se ven y se exportan TAL CUAL, como siempre. No borra nada: los recuadros se conservan para volver a encenderlo.', 'izq')}
          </h3>
          <div id="pd-estado" style="font-size:13px;color:var(--gris-texto);margin-bottom:10px">Cargando…</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button class="btn" id="pd-toggle" onclick="togglePreciosDinamicos(this)">Cargando…</button>
            <span style="font-size:12px;color:var(--gris-texto)">Si la primera prueba real no convence, apágalo y todo vuelve a la forma original al instante.</span>
          </div>
        </div>

        <!-- BLOQUE: Fuente de precios reescritos (F3/F5) -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">🔤 Tipografía de precios reescritos
            ${ayuda('Fuente y tamaño con los que la app reescribe los precios de hoy sobre la lámina (visor y export PDF/WhatsApp). Se configura UNA vez. Liberation Sans es idéntica a Arial; ajusta el factor de tamaño si hiciera falta afinar.', 'izq')}
          </h3>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <div class="form-group" style="margin:0"><label>Fuente</label>
              <select id="cfg-precio-fuente" style="padding:8px;border:1px solid #d1d5db;border-radius:6px">
                <option value="Liberation Sans">Liberation Sans (= Arial)</option>
                <option value="Liberation Serif">Liberation Serif (= Times)</option>
                <option value="Liberation Mono">Liberation Mono</option>
                <option value="DejaVu Sans">DejaVu Sans</option>
                <option value="DejaVu Serif">DejaVu Serif</option>
              </select></div>
            <div class="form-group" style="margin:0"><label>Factor de tamaño</label>
              <input type="number" id="cfg-precio-tam" min="0.5" max="2" step="0.02" value="1" style="width:90px;padding:8px;border:1px solid #d1d5db;border-radius:6px"></div>
            <button class="btn btn-primary btn-pequeno" onclick="guardarConfigPreciosAdmin(this)">Guardar</button>
            <span id="cfg-precio-msg" style="font-size:12px;color:var(--gris-texto)"></span>
          </div>
        </div>

        <!-- BLOQUE: IA Tags -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">🤖 Tags automáticos con IA
            ${ayuda('Cada lámina que subes recibe automáticamente etiquetas de búsqueda generadas por GPT-4 Vision (analiza la imagen y el título). Aquí puedes generar tags también para las láminas antiguas que no los tengan.', 'izq')}
          </h3>
          <div style="font-size:12px;color:var(--gris-texto);margin-bottom:10px">
            Al subir una lámina, la IA genera 5-12 palabras clave analizando la imagen (marcas, categorías, ofertas...).<br>
            En cada lámina existente hay un botón 🤖 para regenerar los tags de esa lámina en concreto.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-primary btn-pequeno" onclick="backfillTagsIA(this)">🤖 Generar tags de todas las láminas sin tags</button>
          </div>
          <div id="backfill-tags-out" style="font-size:12px;color:var(--gris-texto);margin-top:8px"></div>
        </div>

        <!-- BLOQUE: Detección masiva de zonas con IA -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">🎯 Detección automática de zonas con IA
            ${ayuda('Procesa TODAS las láminas del catálogo que aún no tienen zonas ni han pasado por la IA. Detecta los productos, dibuja las zonas y asocia el producto de Sage cuando el CN coincide. Las láminas que ya tienen zonas dibujadas se saltan.', 'izq')}
          </h3>
          <div style="font-size:12px;color:var(--gris-texto);margin-bottom:10px">
            Solo procesa láminas <b>nuevas</b> o <b>que no hayan sido analizadas antes</b>.<br>
            Coste: ~$0.02 (2 céntimos) por lámina. Se procesa lámina a lámina con reintento automático.<br>
            Puedes cerrar esta pantalla y volver más tarde: se reanuda desde donde iba.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-primary btn-pequeno" onclick="backfillZonasIA(this)">🎯 Detectar zonas en todas las láminas pendientes</button>
          </div>
          <div id="backfill-zonas-out" style="font-size:12px;color:var(--gris-texto);margin-top:8px"></div>
        </div>

        <!-- BLOQUE: Corrección perfil color PNG -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">🎨 Corregir colores oscuros de PNG
            ${ayuda('Algunos PNG traen un perfil ICC embebido que los navegadores interpretan más oscuro que un visor de fotos. Este proceso quita ese perfil y fuerza sRGB estándar. Sin pérdida de calidad ni de resolución.', 'izq')}
          </h3>
          <div style="font-size:12px;color:var(--gris-texto);margin-bottom:10px">
            Si las láminas se ven oscuras al presentarlas, pulsa este botón para corregir los perfiles.
            Solo tocará los PNG que tengan perfil ICC embebido (los ya normalizados se saltan).
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-primary btn-pequeno" onclick="backfillColorPerfil(this)">🎨 Corregir perfiles de color de todas las láminas</button>
          </div>
          <div id="backfill-color-out" style="font-size:12px;color:var(--gris-texto);margin-top:8px"></div>
        </div>

        <!-- BLOQUE: Sincronización Sage -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">🔄 Sincronización con Sage
            ${ayuda('Un programa en el PC de la oficina lee la base de datos de Sage y empuja los datos a esta app por HTTPS. Aquí ves cuándo llegó el último batch de cada tipo y cuántos registros trajo.', 'izq')}
          </h3>
          <div id="sync-sage-resumen" style="font-size:13px;color:var(--gris-texto);padding:12px;background:var(--surface-2);border-radius:8px">
            Cargando…
          </div>
          <div style="margin-top:10px">
            <button class="btn btn-secondary btn-pequeno" onclick="verHistorialSyncSage()">📋 Ver historial completo</button>
          </div>
        </div>

        <!-- BLOQUE: Resumen a oficina -->
        <div class="editor-panel" style="margin-top:14px">
          <h3 style="margin-top:0">📊 Resumen a oficina
            ${ayuda('Botón manual (no automático) para enviar a los emails de la oficina un resumen con: los links MEGA a los catálogos actualizados + una lista de las láminas que se han creado, modificado o eliminado desde el último envío. Sirve para que la oficina actualice el programa de gestión (precios, altas, bajas).', 'izq')}
          </h3>
          <div style="font-size:12px;color:var(--gris-texto);margin-bottom:10px">
            Cuando termines de actualizar los catálogos, pulsa el botón para enviar el resumen.
            El sistema calcula automáticamente lo que ha cambiado desde el último envío.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <button class="btn btn-primary" onclick="abrirEnviarResumenOficina()">✉️ Enviar resumen a oficina</button>
            <button class="btn btn-secondary btn-pequeno" onclick="verHistorialResumenes()">📋 Ver últimos envíos</button>
          </div>
          <div style="font-size:12px;font-weight:600;margin-top:16px;margin-bottom:6px">Destinatarios (oficina):</div>
          <div id="office-recipients-lista">
            <div style="color:var(--gris-texto);font-size:12px;padding:8px">Cargando…</div>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn btn-secondary btn-pequeno" onclick="abrirNuevoDestinatarioOficina()">+ Nuevo destinatario</button>
            <button class="btn btn-secondary btn-pequeno" onclick="seedDestinatariosOficina(this)">🌱 Añadir los 4 iniciales</button>
          </div>
        </div>

        <div id="config-msg"></div>
      </div>
    `;
    $v.innerHTML = html;
    // Cargar stats geocoding tras pintar
    actualizarStatsGeocoding();
    // Cargar recuento de datos de prueba
    cargarStatsLimpiarPruebas();
    // Cargar lista de categorías
    cargarListaCategorias();
    // Cargar carpetas MEGA
    cargarCarpetasMega();
    // Cargar destinatarios oficina
    cargarDestinatariosOficina();
    // Cargar resumen sync Sage
    cargarResumenSyncSage();
    // Cargar ofertas / campañas (F4)
    cargarOfertasAdmin();
    // Cargar config de tipografía de precios (F5 remate)
    cargarConfigPreciosAdmin();
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

// ===== F4 OFERTAS / CAMPAÑAS (gestión admin) =====
function _ofertaResumen(o) {
  const amb = o.ambito === 'producto' ? ('Producto ' + (o.producto_codigo || o.product_id || ''))
    : o.ambito === 'marca' ? ('Marca: ' + (o.marca || '—'))
    : o.ambito === 'familia' ? ('Familia: ' + (o.familia || '—'))
    : 'Todo el catálogo';
  const et = o.texto ? o.texto : (o.tipo === 'descuento' && o.valor != null ? '-' + o.valor + '%' : (o.tipo === 'bonificacion' ? 'Bonificación' : 'Oferta'));
  const f = s => String(s || '').slice(0, 10).split('-').reverse().join('/');
  const hoy = new Date().toISOString().slice(0, 10);
  const vig = o.activo && String(o.fecha_inicio).slice(0, 10) <= hoy && String(o.fecha_fin).slice(0, 10) >= hoy;
  return { amb, et, fechas: f(o.fecha_inicio) + ' → ' + f(o.fecha_fin), vig };
}

async function cargarOfertasAdmin() {
  const $l = document.getElementById('ofertas-lista');
  if (!$l) return;
  try {
    const r = await api('/api/ofertas');
    const ofertas = r.ofertas || [];
    if (!ofertas.length) {
      $l.innerHTML = `<div style="padding:1rem;background:var(--surface-2);border-radius:8px;color:#6b7280;font-size:13px;text-align:center">Aún no hay ofertas. Crea la primera abajo.</div>`;
      return;
    }
    $l.innerHTML = ofertas.map(o => {
      const s = _ofertaResumen(o);
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--gris-borde);border-radius:8px;margin-bottom:8px">
        <span style="background:${escape(o.color || '#dc2626')};color:#fff;font-weight:800;font-size:12px;padding:2px 8px;border-radius:6px;white-space:nowrap">${escape(s.et)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">${escape(o.nombre || s.amb)}</div>
          <div style="font-size:12px;color:var(--gris-texto)">${escape(s.amb)} · ${escape(s.fechas)} ${s.vig ? '· <b style="color:#16a34a">VIGENTE</b>' : '· <span style="color:#9ca3af">no vigente hoy</span>'}</div>
        </div>
        <button class="btn-borrar" onclick="borrarOferta(${o.id})" title="Eliminar oferta">✖</button>
      </div>`;
    }).join('');
  } catch (e) {
    $l.innerHTML = `<div class="error-msg">${escape(e.message)}</div>`;
  }
}

function abrirNuevaOferta() {
  const hoy = new Date().toISOString().slice(0, 10);
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal" style="max-width:520px">
      <h3 style="margin-top:0">🎯 Nueva oferta / campaña</h3>
      <div class="form-group"><label>Nombre (interno)</label>
        <input type="text" id="of-nombre" placeholder="Ej: Campaña verano BETER" maxlength="120"></div>
      <div class="form-group"><label>Ámbito</label>
        <select id="of-ambito" onchange="_ofToggleAmbito()">
          <option value="producto">Un producto (por código)</option>
          <option value="marca">Marca / laboratorio</option>
          <option value="familia">Familia</option>
          <option value="todos">Todo el catálogo</option>
        </select></div>
      <div class="form-group" id="of-g-producto"><label>Código de producto</label>
        <input type="text" id="of-producto" placeholder="Código Sage / CN"></div>
      <div class="form-group" id="of-g-marca" style="display:none"><label>Marca / laboratorio</label>
        <input type="text" id="of-marca" placeholder="Ej: BETER"></div>
      <div class="form-group" id="of-g-familia" style="display:none"><label>Familia</label>
        <input type="text" id="of-familia" placeholder="Ej: Manicura"></div>
      <div class="form-group"><label>Tipo</label>
        <select id="of-tipo" onchange="_ofToggleTipo()">
          <option value="descuento">Descuento (%)</option>
          <option value="bonificacion">Bonificación en género</option>
          <option value="texto">Texto libre</option>
        </select></div>
      <div class="form-group" id="of-g-valor"><label>Descuento %</label>
        <input type="number" id="of-valor" min="0" max="100" step="0.5" placeholder="Ej: 15"></div>
      <div class="form-group" id="of-g-texto" style="display:none"><label>Texto de la etiqueta</label>
        <input type="text" id="of-texto" placeholder='Ej: "3+1" o "2ª unidad -50%"' maxlength="120"></div>
      <div style="display:flex;gap:10px">
        <div class="form-group" style="flex:1"><label>Inicio</label>
          <input type="date" id="of-inicio" value="${hoy}"></div>
        <div class="form-group" style="flex:1"><label>Fin</label>
          <input type="date" id="of-fin" value="${hoy}"></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <div class="form-group" style="flex:1"><label>Color etiqueta</label>
          <input type="color" id="of-color" value="#dc2626" style="width:60px;height:36px"></div>
        <div class="form-group" style="flex:1"><label>Prioridad (desempate)</label>
          <input type="number" id="of-prioridad" value="0" step="1"></div>
      </div>
      <div id="of-msg"></div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarOferta(this)">Crear oferta</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function _ofToggleAmbito() {
  const a = document.getElementById('of-ambito').value;
  document.getElementById('of-g-producto').style.display = a === 'producto' ? '' : 'none';
  document.getElementById('of-g-marca').style.display = a === 'marca' ? '' : 'none';
  document.getElementById('of-g-familia').style.display = a === 'familia' ? '' : 'none';
}
function _ofToggleTipo() {
  const t = document.getElementById('of-tipo').value;
  document.getElementById('of-g-valor').style.display = t === 'descuento' ? '' : 'none';
  document.getElementById('of-g-texto').style.display = t === 'descuento' ? 'none' : '';
}

async function guardarOferta(btn) {
  const $msg = document.getElementById('of-msg');
  const ambito = document.getElementById('of-ambito').value;
  const tipo = document.getElementById('of-tipo').value;
  const body = {
    nombre: document.getElementById('of-nombre').value.trim() || null,
    ambito, tipo,
    fecha_inicio: document.getElementById('of-inicio').value,
    fecha_fin: document.getElementById('of-fin').value,
    color: document.getElementById('of-color').value,
    prioridad: document.getElementById('of-prioridad').value,
  };
  if (tipo === 'descuento') body.valor = document.getElementById('of-valor').value;
  else body.texto = document.getElementById('of-texto').value.trim();
  if (ambito === 'marca') body.marca = document.getElementById('of-marca').value.trim();
  if (ambito === 'familia') body.familia = document.getElementById('of-familia').value.trim();
  // Ámbito producto: resolver el código → product_id
  if (ambito === 'producto') {
    const cod = document.getElementById('of-producto').value.trim();
    if (!cod) { $msg.innerHTML = `<div class="error-msg">Escribe el código del producto</div>`; return; }
    try {
      const r = await api('/api/products/search?q=' + encodeURIComponent(cod));
      const prods = r.products || r.results || [];
      const exacto = prods.find(p => String(p.codigo) === cod) || prods[0];
      if (!exacto) { $msg.innerHTML = `<div class="error-msg">No se encontró ese producto</div>`; return; }
      body.product_id = exacto.id;
    } catch (e) { $msg.innerHTML = `<div class="error-msg">${escape(e.message)}</div>`; return; }
  }
  if (!body.fecha_inicio || !body.fecha_fin) { $msg.innerHTML = `<div class="error-msg">Pon fecha de inicio y fin</div>`; return; }
  btn.disabled = true;
  try {
    await api('/api/ofertas', { method: 'POST', body });
    btn.closest('.modal-bg').remove();
    cargarOfertasAdmin();
  } catch (e) { $msg.innerHTML = `<div class="error-msg">${escape(e.message)}</div>`; btn.disabled = false; }
}

async function borrarOferta(id) {
  if (!confirm('¿Eliminar esta oferta?')) return;
  try { await api('/api/ofertas/' + id, { method: 'DELETE' }); cargarOfertasAdmin(); }
  catch (e) { alert(e.message); }
}

// ===== Interruptor maestro de precios dinámicos =====
function _pintarEstadoPD(on) {
  const $e = document.getElementById('pd-estado');
  const $b = document.getElementById('pd-toggle');
  if ($e) $e.innerHTML = on
    ? '<b style="color:#16a34a">✅ ENCENDIDO</b> — las láminas muestran el precio de la base de datos (tapando el impreso) en el visor y al exportar.'
    : '<b style="color:#b45309">⛔ APAGADO</b> — las láminas se ven y se exportan <b>tal cual</b>, como siempre. Los recuadros creados se conservan.';
  if ($b) {
    $b.textContent = on ? '⛔ Apagar precios dinámicos' : '✅ Encender precios dinámicos';
    $b.style.background = on ? '#fee2e2' : '#dcfce7';
    $b.style.color = on ? '#b91c1c' : '#15803d';
    $b.dataset.on = on ? '1' : '0';
  }
}

async function togglePreciosDinamicos(btn) {
  const on = btn.dataset.on === '1';
  if (on && !confirm('¿Apagar los precios dinámicos?\n\nLas láminas volverán a verse y exportarse TAL CUAL (con el precio impreso), como siempre.\n\nNo se borra nada: los recuadros se conservan para volver a encenderlo cuando quieras.')) return;
  btn.disabled = true;
  try {
    await api('/api/config', { method: 'PUT', body: { precios_dinamicos_activo: on ? '0' : '1' } });
    _pintarEstadoPD(!on);
    _cfgPreciosCargada = false; // que el visor recargue el estado
    mostrarNotificacionOnline(on ? '⛔ Precios dinámicos apagados' : '✅ Precios dinámicos encendidos', on ? '#b45309' : '#16a34a');
  } catch (e) { alert('Error: ' + e.message); }
  btn.disabled = false;
}

// ===== F5 remate: tipografía de precios reescritos =====
async function cargarConfigPreciosAdmin() {
  try {
    const r = await api('/api/config');
    const c = r.config || {};
    _pintarEstadoPD((c.precios_dinamicos_activo ?? '1') !== '0');
    const sel = document.getElementById('cfg-precio-fuente');
    const tam = document.getElementById('cfg-precio-tam');
    if (sel && c.precio_fuente) sel.value = c.precio_fuente;
    if (tam && c.precio_tam_factor) tam.value = c.precio_tam_factor;
  } catch (e) { /* usa valores por defecto del select */ }
}

async function guardarConfigPreciosAdmin(btn) {
  const $msg = document.getElementById('cfg-precio-msg');
  const fuente = document.getElementById('cfg-precio-fuente').value;
  const factor = document.getElementById('cfg-precio-tam').value;
  btn.disabled = true;
  try {
    await api('/api/config', { method: 'PUT', body: { precio_fuente: fuente, precio_tam_factor: factor } });
    if ($msg) { $msg.textContent = '✅ Guardado'; setTimeout(() => { $msg.textContent = ''; }, 2500); }
    _cfgPreciosCargada = false; // recargar en el visor la próxima vez
  } catch (e) { if ($msg) $msg.textContent = 'Error: ' + e.message; }
  btn.disabled = false;
}

// ===== CATEGORÍAS / TAGS =====
let _categoriasCache = [];

async function cargarListaCategorias() {
  const $lista = document.getElementById('categorias-lista');
  if (!$lista) return;
  try {
    const r = await api('/api/categorias');
    _categoriasCache = r.categorias || [];
    if (_categoriasCache.length === 0) {
      $lista.innerHTML = `<div style="padding:1rem;background:var(--surface-2);border-radius:8px;color:#6b7280;font-size:13px;text-align:center">
        Aún no hay categorías. Crea la primera abajo (ej: "Verano", "Promo", "Vista", "Presbicia").
      </div>`;
      return;
    }
    $lista.innerHTML = _categoriasCache.map(c => `
      <div class="cat-fila" data-cat-id="${c.id}">
        <span class="cat-color-dot" style="background:${escape(c.color || '#cc007a')}"></span>
        <input type="text" class="cat-nombre-input" value="${escape(c.nombre)}" maxlength="80" onchange="actualizarCategoria(${c.id}, this.value, document.querySelector('[data-cat-id=\\'${c.id}\\'] .cat-color-input').value)">
        <input type="color" class="cat-color-input" value="${escape(c.color || '#cc007a')}" onchange="actualizarCategoria(${c.id}, document.querySelector('[data-cat-id=\\'${c.id}\\'] .cat-nombre-input').value, this.value)">
        <span class="cat-cuenta">${c.num_laminas || 0} láminas</span>
        <button class="btn-borrar" onclick="borrarCategoria(${c.id}, '${escape((c.nombre || '').replace(/'/g, "\\'"))}', ${c.num_laminas || 0})" title="Eliminar categoría">✖</button>
      </div>
    `).join('');
  } catch (err) {
    $lista.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

async function crearCategoria() {
  const $nombre = document.getElementById('cat-nueva-nombre');
  const $color = document.getElementById('cat-nueva-color');
  const $msg = document.getElementById('cat-msg');
  const nombre = ($nombre.value || '').trim();
  if (!nombre) {
    $msg.innerHTML = `<div class="error-msg">Escribe un nombre para la categoría</div>`;
    return;
  }
  try {
    await api('/api/categorias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, color: $color.value, orden: _categoriasCache.length })
    });
    $nombre.value = '';
    $msg.innerHTML = `<div class="exito-msg">✓ Categoría creada</div>`;
    setTimeout(() => { $msg.innerHTML = ''; }, 2000);
    cargarListaCategorias();
  } catch (err) {
    $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

async function actualizarCategoria(id, nombre, color) {
  try {
    await api(`/api/categorias/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: (nombre || '').trim(), color })
    });
  } catch (err) {
    alert('Error actualizando: ' + err.message);
    cargarListaCategorias();
  }
}

async function borrarCategoria(id, nombre, numLaminas) {
  let msg = `¿Eliminar la categoría "${nombre}"?`;
  if (numLaminas > 0) {
    msg += `\n\n⚠️ Está asignada a ${numLaminas} láminas. Si la borras, se quitará de esas láminas (pero las láminas se mantienen).`;
  }
  if (!confirm(msg)) return;
  try {
    await api(`/api/categorias/${id}`, { method: 'DELETE' });
    cargarListaCategorias();
  } catch (err) {
    alert('Error borrando: ' + err.message);
  }
}

// ===== Limpiar datos de prueba =====
async function cargarStatsLimpiarPruebas() {
  const $stats = document.getElementById('limpiar-pruebas-stats');
  if (!$stats) return;
  try {
    const r = await api('/api/admin/limpiar-pruebas/preview');
    const c = r.counts;
    $stats.innerHTML = `
      Actualmente hay:
      <b>${c.catalogs.n}</b> catálogos ·
      <b>${c.sheets.n}</b> láminas ·
      <b>${c.visits.n}</b> visitas ·
      <b>${c.annotations.n}</b> anotaciones ·
      <b>${c.catalog_versions.n}</b> versiones
    `;
  } catch (e) {
    $stats.innerHTML = `<span style="color:#b91c1c">No se pudo cargar el recuento: ${escape(e.message)}</span>`;
  }
}

function abrirModalLimpiarPruebas() {
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3 style="color:#b91c1c">🗑️ Limpiar datos de prueba</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div style="background:#fef2f2;border:1px solid #fecaca;padding:12px;border-radius:8px;margin-bottom:14px;font-size:13px;color:#7f1d1d">
        Elige <b>qué borrar</b>. Esto <b>NO</b> afecta a productos, clientes, usuarios, plantillas ni configuración. <b>No se puede deshacer.</b>
      </div>
      <div class="form-group" style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;align-items:flex-start;gap:9px;font-weight:500;cursor:pointer">
          <input type="checkbox" class="limpiar-grupo" value="visitas" checked style="margin-top:2px">
          <span>🛒 <b>Visitas y pedidos</b> (anotaciones)<br><small style="color:var(--gris-texto)">Borra las visitas de prueba y sus pedidos/notas. Deja los catálogos intactos.</small></span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:9px;font-weight:500;cursor:pointer">
          <input type="checkbox" class="limpiar-grupo" value="catalogos" style="margin-top:2px">
          <span>📚 <b>Catálogos, láminas y versiones</b><br><small style="color:var(--gris-texto)">Borra catálogos, láminas, zonas y versiones. <b>Al marcarlo se borran también las visitas/pedidos</b> (sus pedidos apuntan a esas láminas).</small></span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:9px;font-weight:500;cursor:pointer">
          <input type="checkbox" class="limpiar-grupo" value="aula" style="margin-top:2px">
          <span>🎓 <b>Aula (formaciones)</b><br><small style="color:var(--gris-texto)">Borra las formaciones subidas y sus versiones.</small></span>
        </label>
      </div>
      <div class="form-group">
        <label>Para confirmar, escribe <b>BORRAR</b> en mayúsculas:</label>
        <input type="text" id="limpiar-confirm-input" placeholder="BORRAR" autocomplete="off"
               style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box" />
      </div>
      <div id="limpiar-modal-msg"></div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn" style="background:#dc2626;color:#fff" onclick="confirmarLimpiarPruebas()">🗑️ Borrar definitivamente</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => { const i = document.getElementById('limpiar-confirm-input'); if (i) i.focus(); }, 100);
}

async function confirmarLimpiarPruebas() {
  const $input = document.getElementById('limpiar-confirm-input');
  const $msg = document.getElementById('limpiar-modal-msg');
  const confirmacion = ($input.value || '').trim();
  const grupos = Array.from(document.querySelectorAll('.limpiar-grupo:checked')).map(c => c.value);
  if (grupos.length === 0) {
    $msg.innerHTML = `<div class="error-msg">Marca al menos una cosa que borrar.</div>`;
    return;
  }
  if (confirmacion !== 'BORRAR') {
    $msg.innerHTML = `<div class="error-msg">Debes escribir exactamente BORRAR (en mayúsculas).</div>`;
    return;
  }
  $msg.innerHTML = `<div style="color:#6b7280;font-size:13px">Borrando lo seleccionado…</div>`;
  try {
    const r = await api('/api/admin/limpiar-pruebas', {
      method: 'POST',
      body: { confirmacion: 'BORRAR', grupos }
    });
    document.querySelector('.modal-bg').remove();
    const b = r.borrados || {};
    const partes = [];
    if (typeof b.catalogs === 'number') partes.push(b.catalogs + ' catálogos');
    if (typeof b.sheets === 'number') partes.push(b.sheets + ' láminas');
    if (typeof b.visits === 'number') partes.push(b.visits + ' visitas');
    if (typeof b.annotations === 'number') partes.push(b.annotations + ' anotaciones');
    if (typeof b.formaciones === 'number') partes.push(b.formaciones + ' formaciones');
    if (r.archivos_fisicos_borrados) partes.push(r.archivos_fisicos_borrados + ' archivos');
    mostrarNotificacionOnline('✅ Limpiado: ' + (partes.join(' · ') || 'nada'), '#16a34a');
    cargarStatsLimpiarPruebas();
  } catch (err) {
    $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

// H: Funciones de geocoding
let _geocodingPoll = null;

async function actualizarStatsGeocoding() {
  const $stats = document.getElementById('geocoding-stats');
  if (!$stats) return;
  try {
    const r = await api('/api/geocode-status');
    const s = r.stats;
    const p = r.proceso;
    const $btnFalt = document.getElementById('btn-geo-faltantes');
    const $btnTodos = document.getElementById('btn-geo-todos');
    const $btnCancel = document.getElementById('btn-geo-cancelar');

    if (p.running) {
      // Proceso en curso: mostrar progreso
      const pct = p.total > 0 ? ((p.procesados / p.total) * 100).toFixed(1) : 0;
      $stats.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px">🌍 Proceso en curso…</div>
        <div style="background:#e5e7eb;height:20px;border-radius:10px;overflow:hidden;margin-bottom:8px">
          <div style="background:linear-gradient(90deg,#cc007a,#dc2675);height:100%;width:${pct}%;transition:width 0.5s"></div>
        </div>
        <div style="font-size:12px">
          <b>${p.procesados}/${p.total}</b> procesados (${pct}%) ·
          ✓ ${p.ok} ok · ⚠️ ${p.no_encontrados} no encontrados · ❌ ${p.errores} errores
        </div>
        ${p.ultimoError ? `<div style="font-size:11px;color:#dc2626;margin-top:4px">Último error: ${escape(p.ultimoError)}</div>` : ''}
      `;
      if ($btnFalt) $btnFalt.disabled = true;
      if ($btnTodos) $btnTodos.disabled = true;
      if ($btnCancel) $btnCancel.style.display = 'inline-block';
      // Volver a actualizar en 2 segundos
      if (_geocodingPoll) clearTimeout(_geocodingPoll);
      _geocodingPoll = setTimeout(actualizarStatsGeocoding, 2000);
    } else {
      // Sin proceso: mostrar estado actual
      const conPct = s.total > 0 ? ((s.con_coords / s.total) * 100).toFixed(1) : 0;
      $stats.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px">📊 Estado actual</div>
        <div style="background:#e5e7eb;height:14px;border-radius:7px;overflow:hidden;margin-bottom:8px">
          <div style="background:#16a34a;height:100%;width:${conPct}%"></div>
        </div>
        <div style="font-size:12px">
          ✓ <b>${s.con_coords}/${s.total}</b> clientes geolocalizados (${conPct}%)<br>
          ⏳ <b>${s.sin_coords}</b> pendientes ·
          ⚠️ <b>${s.no_encontrados}</b> no encontrados ·
          ❌ <b>${s.con_error}</b> con error
        </div>
      `;
      if ($btnFalt) $btnFalt.disabled = false;
      if ($btnTodos) $btnTodos.disabled = false;
      if ($btnCancel) $btnCancel.style.display = 'none';
      if (_geocodingPoll) { clearTimeout(_geocodingPoll); _geocodingPoll = null; }
    }
  } catch (err) {
    $stats.innerHTML = `<div class="error-msg">Error: ${escape(err.message)}</div>`;
  }
}

async function iniciarGeocoding(soloFaltantes) {
  const msg = soloFaltantes
    ? '¿Iniciar geocoding de los clientes pendientes?\n\nTarda ~1 segundo por cliente.'
    : '⚠️ ¿Re-geocodificar TODOS los clientes?\n\nEsto sobrescribirá las coordenadas existentes. Tarda ~1 segundo por cliente.';
  if (!confirm(msg)) return;
  try {
    await api('/api/geocode-start', { method: 'POST', body: { soloFaltantes } });
    actualizarStatsGeocoding();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function cancelarGeocoding() {
  if (!confirm('¿Cancelar el proceso de geocoding?\n\nSe detendrá tras el cliente actual. Lo ya geocodificado se conserva.')) return;
  try {
    await api('/api/geocode-cancel', { method: 'POST' });
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function cambiarModo(nuevoModo) {
  // Confirmar si pasamos a producción
  if (nuevoModo === 'produccion') {
    if (!confirm('⚠️ Vas a activar MODO PRODUCCIÓN.\n\nLos próximos cierres de visita enviarán emails REALES a oficina, cliente y comercial.\n\n¿Estás seguro?')) return;
  }
  try {
    await api('/api/email-config', {
      method: 'PUT',
      body: { values: { modo: nuevoModo } }
    });
    renderConfiguracion();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function guardarConfiguracion() {
  const claves = [
    'oficina_emails',
    'pruebas_email_oficina',
    'pruebas_email_cliente',
    'pruebas_email_comercial',
    'remitente_from',
    'firma_html',
    'planning_ciclo_default',
    'planning_ventana_proxima_dias',
    'planning_ventana_urgente_dias'
  ];
  const values = {};
  claves.forEach(k => {
    const el = document.getElementById('cfg-' + k);
    if (el) values[k] = el.value.trim();
  });
  try {
    await api('/api/email-config', { method: 'PUT', body: { values } });
    const $msg = document.getElementById('config-msg');
    if ($msg) {
      $msg.innerHTML = '<div class="exito-msg">✓ Configuración guardada</div>';
      setTimeout(() => { $msg.innerHTML = ''; }, 2500);
    }
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}

async function enviarEmailPrueba() {
  const to = prompt('Email donde quieres recibir el mensaje de prueba:', user && user.email || '');
  if (!to) return;
  try {
    const r = await api('/api/email-config/test', { method: 'POST', body: { to } });
    alert('✅ Email de prueba enviado a ' + to + '\n\nRevisa la bandeja en unos segundos. Si no llega en 1-2 minutos, revisa configuración SMTP en Railway o la carpeta de spam.');
  } catch (err) {
    alert('❌ Error enviando prueba:\n\n' + err.message + '\n\nVerifica que SMTP_HOST, SMTP_USER y SMTP_PASS estén configurados en Railway.');
  }
}

// ============================================================================
// ===== PWA UPDATE BANNER - aviso "hay actualización disponible" =====
// ============================================================================
// Se llama desde index.html cuando el Service Worker detecta una versión nueva.
// Muestra un banner rosa fijo arriba de la app pidiendo al usuario que actualice.

let _bannerActualizacionVisible = false;

function mostrarBannerActualizacion() {
  if (_bannerActualizacionVisible) return; // ya visible, no duplicar
  _bannerActualizacionVisible = true;

  // Crear elemento si no existe
  let $banner = document.getElementById('pwa-update-banner');
  if (!$banner) {
    $banner = document.createElement('div');
    $banner.id = 'pwa-update-banner';
    $banner.className = 'pwa-update-banner';
    $banner.innerHTML = `
      <div class="pwa-update-banner-texto">
        🔔 Hay una nueva versión de CatalogPRO disponible
      </div>
      <button class="pwa-update-banner-btn" onclick="pulsarActualizarPWA()">
        Actualizar ahora
      </button>
      <button class="pwa-update-banner-cerrar" onclick="cerrarBannerActualizacion()" title="Recordar después">×</button>
    `;
    document.body.appendChild($banner);
  }
  $banner.classList.add('pwa-update-banner-visible');
  // También añadimos padding al body para que el banner no tape contenido
  document.body.classList.add('con-banner-update');
}

function cerrarBannerActualizacion() {
  const $banner = document.getElementById('pwa-update-banner');
  if ($banner) $banner.classList.remove('pwa-update-banner-visible');
  document.body.classList.remove('con-banner-update');
  _bannerActualizacionVisible = false;
  // No tocamos el SW — sigue esperando. Si el usuario refresca o vuelve mañana,
  // volverá a salir el banner. La detección de updatefound se re-disparará al
  // próximo control de updates (cada 10 min) y volverá a llamar mostrarBannerActualizacion.
}

function pulsarActualizarPWA() {
  // Cambiar UI a "actualizando..."
  const $banner = document.getElementById('pwa-update-banner');
  if ($banner) {
    $banner.innerHTML = `
      <div class="pwa-update-banner-texto">
        ⏳ Actualizando…
      </div>
    `;
  }
  // Llamar a la función global del index.html que envía SKIP_WAITING al SW
  if (typeof window.aplicarActualizacionPWA === 'function') {
    window.aplicarActualizacionPWA();
  } else {
    // Fallback: recargar
    window.location.reload();
  }
}

// ============================================================================
// ===== I - MODO OFFLINE (PWA + IndexedDB) =====
// ============================================================================
// Esta sesión I.1: indicador online/offline + descargar catálogo a IndexedDB
// Próximas sesiones: visitas offline, sync queue, conflictos.

// Estado offline global
let _estaOnline = navigator.onLine;

// Actualizar el indicador visual cuando cambia el estado de conexión
function actualizarIndicadorOnline() {
  _estaOnline = navigator.onLine;
  const $ind = document.getElementById('indicador-online');
  if (!$ind) return;
  const pendientes = _visitasPendientes || 0;
  let badgePendientes = '';
  if (pendientes > 0) {
    badgePendientes = `<span class="indicador-pendientes" onclick="event.stopPropagation();abrirModalPendientes()" title="${pendientes} visita(s) pendiente(s) de sincronizar">⏳ ${pendientes}</span>`;
  }
  if (_estaOnline) {
    $ind.className = 'indicador-online indicador-online-on';
    $ind.innerHTML = `🟢 Online${badgePendientes}`;
    $ind.title = 'Conectado a internet';
  } else {
    $ind.className = 'indicador-online indicador-online-off';
    $ind.innerHTML = `🔴 Sin conexión${badgePendientes}`;
    $ind.title = 'Sin conexión a internet. Trabajando offline.';
  }
}

// Escuchar cambios de conexión a nivel ventana
window.addEventListener('online', () => {
  console.log('[I] Conexión recuperada');
  actualizarIndicadorOnline();
  mostrarNotificacionOnline('🟢 Conexión recuperada', '#16a34a');
  // I.2: re-renderizar para volver a cargar de la API
  if (typeof render === 'function') setTimeout(() => render(), 500);
});
window.addEventListener('offline', () => {
  console.log('[I] Conexión perdida');
  actualizarIndicadorOnline();
  mostrarNotificacionOnline('🔴 Sin conexión — trabajando offline', '#dc2626');
  // I.2: re-renderizar para activar fallbacks IndexedDB
  if (typeof render === 'function') setTimeout(() => render(), 500);
});

// Mostrar notificación in-app (banner que aparece y desaparece)
function mostrarNotificacionOnline(texto, color) {
  // Quitar la anterior si existe
  const ant = document.getElementById('notif-online');
  if (ant) ant.remove();
  const div = document.createElement('div');
  div.id = 'notif-online';
  div.className = 'notif-online';
  div.style.background = color;
  div.textContent = texto;
  document.body.appendChild(div);
  // Animación entrada
  setTimeout(() => div.classList.add('notif-online-visible'), 10);
  // Auto-quitar en 3.5 seg
  setTimeout(() => {
    div.classList.remove('notif-online-visible');
    setTimeout(() => div.remove(), 400);
  }, 3500);
}

// Descargar un catálogo completo (con imágenes) a IndexedDB para uso offline
async function descargarCatalogoOffline(catalogId, nombreCatalogo) {
  if (!window.CpDB) {
    alert('IndexedDB no disponible en este navegador.');
    return;
  }
  if (!navigator.onLine) {
    alert('Necesitas conexión a internet para descargar el catálogo para uso offline.');
    return;
  }

  // Modal con progreso
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>📲 Descargando para offline</h3>
      </div>
      <p style="font-size:13px;color:var(--gris-texto);margin-bottom:14px">
        <b>${escape(nombreCatalogo)}</b><br>
        Descargando catálogo + láminas al móvil…
      </p>
      <div id="offline-dl-progreso" style="background:#e5e7eb;height:20px;border-radius:10px;overflow:hidden;margin-bottom:10px">
        <div id="offline-dl-barra" style="background:linear-gradient(90deg,#cc007a,#dc2675);height:100%;width:0%;transition:width 0.3s"></div>
      </div>
      <div id="offline-dl-estado" style="font-size:13px;text-align:center">Cargando metadatos…</div>
      <div id="offline-dl-error"></div>
    </div>
  `;
  document.body.appendChild(modal);

  const $barra = document.getElementById('offline-dl-barra');
  const $estado = document.getElementById('offline-dl-estado');
  const $error = document.getElementById('offline-dl-error');

  try {
    // 1. Bajar metadatos del catálogo (catálogo + láminas)
    const r = await api('/api/catalogs/' + catalogId);
    const catalog = r.catalog;
    const sheets = r.sheets || [];

    if (sheets.length === 0) {
      $error.innerHTML = '<div class="error-msg">Este catálogo no tiene láminas.</div>';
      setTimeout(() => modal.remove(), 2500);
      return;
    }

    // 2. Guardar catálogo en IndexedDB
    await CpDB.guardarCatalogo(catalog);

    // 3. Descargar cada lámina (imagen como Blob)
    const total = sheets.length;
    let okCount = 0;
    let errCount = 0;
    const token = localStorage.getItem('cpv2_token');

    for (let i = 0; i < total; i++) {
      const sheet = sheets[i];
      const pct = ((i + 1) / total * 100).toFixed(1);
      $barra.style.width = pct + '%';
      $estado.textContent = `Descargando lámina ${i + 1}/${total}...`;
      try {
        const imgUrl = sheet.imagen_path;
        const respImg = await fetch(imgUrl, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!respImg.ok) throw new Error('HTTP ' + respImg.status);
        const blob = await respImg.blob();
        await CpDB.guardarLamina({
          id: sheet.id,
          catalog_id: catalog.id,
          orden: sheet.orden,
          titulo: sheet.titulo,
          notas: sheet.notas,
          tags: sheet.tags,
          imagen_path_original: sheet.imagen_path,
          imagen_blob: blob,
          imagen_size: blob.size
        });
        okCount++;
      } catch (err) {
        console.warn('[I] Error descargando lámina ' + sheet.id + ':', err.message);
        errCount++;
      }
    }

    // 4. Resumen final
    const tamanoMB = ((await CpDB.tamanoAproximado()) / 1024 / 1024).toFixed(1);
    $barra.style.width = '100%';
    $estado.innerHTML = `
      ✅ <b>${okCount}/${total}</b> láminas guardadas offline
      ${errCount > 0 ? `<br><span style="color:#dc2626">⚠️ ${errCount} con error</span>` : ''}
      <br><span style="color:var(--gris-texto);font-size:11px">~${tamanoMB} MB en el dispositivo</span>
    `;
    setTimeout(() => {
      modal.remove();
      mostrarNotificacionOnline(`📲 "${nombreCatalogo}" disponible offline`, '#16a34a');
      // Refrescar lista si estamos en catálogos para mostrar el nuevo badge
      if (appState.vista === 'catalogos' && !appState.catalogoActual) {
        renderListaCatalogos();
      }
    }, 2500);
  } catch (err) {
    $error.innerHTML = `<div class="error-msg">Error: ${escape(err.message)}</div>`;
    setTimeout(() => modal.remove(), 4000);
  }
}

// Borrar un catálogo descargado offline (libera espacio)
async function borrarCatalogoOffline(catalogId, nombreCatalogo) {
  if (!confirm(`¿Borrar la copia offline de "${nombreCatalogo}"?\n\nEl catálogo seguirá disponible online, pero no podrás verlo sin conexión hasta que lo vuelvas a descargar.`)) return;
  try {
    await CpDB.borrarCatalogoOffline(catalogId);
    mostrarNotificacionOnline(`🗑️ Copia offline de "${nombreCatalogo}" borrada`, '#6b7280');
    if (appState.vista === 'catalogos' && !appState.catalogoActual) {
      renderListaCatalogos();
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Cache global con IDs de catálogos descargados (para badges en lista)
let _catalogosDescargadosCache = new Set();
async function refrescarCacheCatalogosDescargados() {
  try {
    const lista = await CpDB.listarCatalogosDescargados();
    _catalogosDescargadosCache = new Set(lista.map(c => c.id));
  } catch (_) {
    _catalogosDescargadosCache = new Set();
  }
}
function estaDescargadoOffline(catalogId) {
  return _catalogosDescargadosCache.has(catalogId);
}

// Inicialización al cargar la app
async function inicializarOffline() {
  if (!window.CpDB) return;
  try {
    await refrescarCacheCatalogosDescargados();
  } catch (_) {}
  actualizarIndicadorOnline();
  // I.3: refrescar contador de visitas pendientes
  refrescarContadorPendientes();
}

// ============================================================================
// ===== I.3 - VISITAS Y CLIENTES OFFLINE + SINCRONIZACIÓN =====
// ============================================================================

// Descargar lista de clientes asignados a IndexedDB
async function descargarMisClientes() {
  if (!navigator.onLine) {
    alert('Necesitas conexión para descargar tus clientes.');
    return;
  }
  // Modal con progreso
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>👥 Descargando clientes</h3>
      </div>
      <p style="font-size:13px;color:var(--gris-texto);margin-bottom:14px">
        Bajando lista de tus clientes asignados al dispositivo para uso sin conexión…
      </p>
      <div class="loading">Descargando…</div>
      <div id="dl-clientes-msg" style="font-size:13px;text-align:center;margin-top:10px"></div>
    </div>
  `;
  document.body.appendChild(modal);
  try {
    const r = await api('/api/sync/my-clients');
    const clientes = r.clientes || [];
    if (clientes.length === 0) {
      document.getElementById('dl-clientes-msg').textContent = 'No tienes clientes asignados.';
      setTimeout(() => modal.remove(), 2500);
      return;
    }
    await CpDB.guardarClientesBatch(clientes);
    // Planning offline: guardar config del planning en localStorage para usar al calcular estados sin conexión
    if (r.planning_config) {
      try {
        localStorage.setItem('cpv2_planning_config', JSON.stringify(r.planning_config));
      } catch (_) {}
    }
    document.getElementById('dl-clientes-msg').innerHTML = `✅ <b>${clientes.length}</b> clientes guardados offline`;
    setTimeout(() => {
      modal.remove();
      mostrarNotificacionOnline(`👥 ${clientes.length} clientes descargados`, '#16a34a');
    }, 2500);
  } catch (err) {
    document.getElementById('dl-clientes-msg').innerHTML = `<div class="error-msg">Error: ${escape(err.message)}</div>`;
    setTimeout(() => modal.remove(), 4000);
  }
}

// I-Planning: calcular estado del cliente OFFLINE, reproduce la lógica del backend.
// Tiene en cuenta también las visitas locales pendientes de sync (sync_queue).
// Devuelve { estado: 'urgente'|'proxima'|'al_dia'|'sin_historial', dias_desde_ultima, dias_retraso }
async function calcularEstadoClienteOffline(cliente, visitasOfflinePorCliente) {
  // Cargar config del planning del último download
  let cfg = { ciclo_default: 90, ventana_proxima_dias: 15, ventana_urgente_dias: 15 };
  try {
    const stored = localStorage.getItem('cpv2_planning_config');
    if (stored) cfg = { ...cfg, ...JSON.parse(stored) };
  } catch (_) {}

  const ciclo = Number(cliente.ciclo_visita_dias || cfg.ciclo_default);

  // Determinar la fecha de la última visita: la más reciente entre ultima_visita_at del backend
  // y las visitas locales offline pendientes que aún no se han sincronizado.
  let ultimaFecha = null;
  if (cliente.ultima_visita_at) {
    ultimaFecha = new Date(cliente.ultima_visita_at);
  }
  const visitasLocales = visitasOfflinePorCliente && visitasOfflinePorCliente[cliente.id];
  if (visitasLocales && visitasLocales.length > 0) {
    visitasLocales.forEach(v => {
      // El campo confirmed_at o created_at de la visita offline
      const fechaVisitaOffline = v.confirmed_at || v.created_at;
      if (fechaVisitaOffline) {
        const f = new Date(fechaVisitaOffline);
        if (!ultimaFecha || f > ultimaFecha) ultimaFecha = f;
      }
    });
  }

  if (!ultimaFecha) {
    return { estado: 'sin_historial', dias_desde_ultima: null, dias_retraso: 0, ciclo_efectivo: ciclo };
  }

  const ahora = new Date();
  const ms = ahora - ultimaFecha;
  const dias = Math.floor(ms / (1000 * 60 * 60 * 24));

  let estado;
  if (dias > (ciclo + cfg.ventana_urgente_dias)) estado = 'urgente';
  else if (dias >= (ciclo - cfg.ventana_proxima_dias)) estado = 'proxima';
  else estado = 'al_dia';

  return { estado, dias_desde_ultima: dias, dias_retraso: dias - ciclo, ciclo_efectivo: ciclo };
}

// Cargar mapa de visitas offline pendientes agrupadas por client_id
// Útil para que el cálculo de estados considere visitas que aún no se han subido
async function obtenerVisitasOfflinePorCliente() {
  const mapa = {};
  try {
    const visitas = await CpDB.listarVisitasOffline();
    visitas.forEach(v => {
      if (!v.client_id) return;
      if (!mapa[v.client_id]) mapa[v.client_id] = [];
      mapa[v.client_id].push(v);
    });
  } catch (_) {}
  return mapa;
}

// Contador de visitas pendientes de sincronizar (lo refresca el indicador)
let _visitasPendientes = 0;
async function refrescarContadorPendientes() {
  try {
    _visitasPendientes = await CpDB.contarVisitasPendientes();
  } catch (_) {
    _visitasPendientes = 0;
  }
  // Repintar indicador si está visible
  actualizarIndicadorOnline();
  // Indicador en navtabs
  const $badge = document.getElementById('badge-pendientes-sync');
  if ($badge) {
    if (_visitasPendientes > 0) {
      $badge.style.display = 'inline-flex';
      $badge.textContent = _visitasPendientes;
    } else {
      $badge.style.display = 'none';
    }
  }
}

// Iniciar una visita offline (cliente debe estar en IndexedDB)
async function iniciarVisitaOffline(clientId, catalogId) {
  const cliente = await CpDB.obtenerCliente(clientId);
  if (!cliente) {
    alert('Este cliente no está descargado offline. Conéctate a internet o descarga tus clientes primero.');
    return null;
  }
  const catalog = await CpDB.obtenerCatalogo(catalogId);
  if (!catalog) {
    alert('Este catálogo no está descargado offline. No puedes iniciar visita sin catálogo descargado.');
    return null;
  }
  // Crear visita local
  const visita = await CpDB.crearVisitaOffline({
    client_id: clientId,
    catalog_id: catalogId,
    cliente_nombre: cliente.razon_social,
    catalog_nombre: catalog.name,
    status: 'draft',
    estado_sync: 'pendiente'
  });
  await refrescarContadorPendientes();
  return visita;
}

// Crear anotación offline (en una visita offline)
async function crearAnotacionOfflineAPI(visitLocalId, sheetId, texto_libre, tipo, pos_x, pos_y) {
  // Buscar orden actual
  const existentes = await CpDB.listarAnotacionesDeVisitaOffline(visitLocalId);
  const orden = existentes.length + 1;
  const ann = await CpDB.crearAnotacionOffline({
    visit_local_id: visitLocalId,
    sheet_id: sheetId,
    texto_libre,
    tipo,
    pos_x: pos_x != null ? pos_x : null,
    pos_y: pos_y != null ? pos_y : null,
    orden_en_visita: orden
  });
  return ann;
}

// SINCRONIZACIÓN automática + manual
let _syncEnCurso = false;
async function sincronizarPendientes(esManual = false) {
  if (_syncEnCurso) {
    if (esManual) alert('Ya hay una sincronización en curso.');
    return;
  }
  if (!navigator.onLine) {
    if (esManual) alert('Necesitas conexión a internet para sincronizar.');
    return;
  }
  const pendientes = await CpDB.listarVisitasOffline('pendiente');
  if (pendientes.length === 0) {
    if (esManual) alert('No hay visitas pendientes de sincronizar.');
    return;
  }
  _syncEnCurso = true;
  mostrarNotificacionOnline(`🔄 Sincronizando ${pendientes.length} visita(s)…`, '#3b82f6');

  let okCount = 0;
  let errCount = 0;
  for (const visita of pendientes) {
    try {
      // Marcar como "sincronizando"
      await CpDB.actualizarVisitaOffline(visita.local_id, { estado_sync: 'sincronizando' });
      // Obtener anotaciones de esta visita
      const anots = await CpDB.listarAnotacionesDeVisitaOffline(visita.local_id);
      // Llamar al endpoint batch
      const r = await api('/api/sync/visit-batch', {
        method: 'POST',
        body: {
          client_id: visita.client_id,
          catalog_id: visita.catalog_id,
          created_at: visita.created_at,
          notas_generales: visita.notas_generales || null,
          confirm: visita.status === 'confirmed' || visita.cerrar_al_sincronizar === true,
          annotations: anots.map(a => ({
            local_id: a.local_id,
            sheet_id: a.sheet_id,
            texto_libre: a.texto_libre,
            tipo: a.tipo,
            pos_x: a.pos_x,
            pos_y: a.pos_y,
            orden_en_visita: a.orden_en_visita
          }))
        }
      });
      if (r.success) {
        // Borrar visita local + anotaciones (ya está en servidor)
        await CpDB.borrarVisitaOffline(visita.local_id);
        okCount++;
      } else {
        await CpDB.actualizarVisitaOffline(visita.local_id, { estado_sync: 'error', error_msg: r.error || 'Error desconocido' });
        errCount++;
      }
    } catch (err) {
      console.error('[SYNC] Error en visita ' + visita.local_id + ':', err.message);
      await CpDB.actualizarVisitaOffline(visita.local_id, { estado_sync: 'error', error_msg: err.message });
      errCount++;
    }
  }

  _syncEnCurso = false;
  await refrescarContadorPendientes();

  // Notificación final
  if (errCount === 0) {
    mostrarNotificacionOnline(`✅ ${okCount} visita(s) sincronizada(s) correctamente`, '#16a34a');
  } else if (okCount === 0) {
    mostrarNotificacionOnline(`⚠️ ${errCount} visita(s) con error — revisa la cola`, '#dc2626');
  } else {
    mostrarNotificacionOnline(`✅ ${okCount} OK · ⚠️ ${errCount} con error`, '#d97706');
  }
}

// Pantalla de visitas pendientes (modal con lista + acciones)
async function abrirModalPendientes() {
  const pendientes = await CpDB.listarVisitasOffline();
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>🔄 Visitas pendientes de sincronizar (${pendientes.length})</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      ${pendientes.length === 0 ? `
        <p style="text-align:center;color:var(--gris-texto);padding:2rem">
          ✅ No hay visitas pendientes — todo sincronizado.
        </p>
      ` : `
        <div style="max-height:400px;overflow-y:auto">
          ${pendientes.map(v => {
            const fecha = new Date(v.created_at).toLocaleString('es-ES');
            const colorEstado = v.estado_sync === 'pendiente' ? '#d97706' :
                                v.estado_sync === 'error' ? '#dc2626' :
                                v.estado_sync === 'sincronizando' ? '#3b82f6' : '#16a34a';
            const iconoEstado = v.estado_sync === 'pendiente' ? '⏳' :
                                v.estado_sync === 'error' ? '⚠️' :
                                v.estado_sync === 'sincronizando' ? '🔄' : '✅';
            return `
              <div class="visita-pendiente-fila">
                <div class="visita-pendiente-info">
                  <div style="font-weight:600">${escape(v.cliente_nombre || 'Cliente ' + v.client_id)}</div>
                  <div style="font-size:12px;color:var(--gris-texto)">${escape(fecha)} · ${escape(v.catalog_nombre || '')}</div>
                  ${v.error_msg ? `<div style="font-size:11px;color:#dc2626;margin-top:4px">⚠️ ${escape(v.error_msg)}</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  <span style="color:${colorEstado};font-size:12px;font-weight:600">${iconoEstado} ${v.estado_sync}</span>
                  <button class="btn-card-mini" onclick="if(confirm('¿Borrar esta visita offline? No se subirá al servidor.')){CpDB.borrarVisitaOffline('${v.local_id}').then(()=>{this.closest('.modal-bg').remove();refrescarContadorPendientes();});}" title="Borrar definitivamente">🗑️</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        <div class="modal-acciones" style="margin-top:14px">
          <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
          ${navigator.onLine ? `<button class="btn btn-primary" onclick="this.closest('.modal-bg').remove();sincronizarPendientes(true);">🔄 Sincronizar ahora</button>` : `<span style="color:#dc2626;font-size:12px">Sin conexión — no se puede sincronizar</span>`}
        </div>
      `}
    </div>
  `;
  document.body.appendChild(modal);
}

// Hook: cuando se recupera conexión, intentar sincronizar automáticamente
window.addEventListener('online', async () => {
  // Esperar 2 segundos por estabilidad de red antes de intentar
  setTimeout(async () => {
    const pendientes = await CpDB.contarVisitasPendientes();
    if (pendientes > 0) {
      console.log('[I.3] Sincronización automática: ' + pendientes + ' pendientes');
      sincronizarPendientes(false);
    }
  }, 2000);
});

// ============================================================================
// ===== E - VERSIONES V1/V2/V3 CON HISTORIAL =====
// ============================================================================

// Cambia entre pestañas del editor de catálogo (Láminas / Historial)
function cambiarPestanaEditor(pestana) {
  appState.editorPestana = pestana;
  if (appState.catalogoActual) renderEditorCatalogo(appState.catalogoActual);
}

// Cambiar pestaña en el editor Express (Láminas/Historial)
function cambiarPestanaEditorExpress(pestana) {
  appState.editorPestana = pestana;
  pintarEditorExpress();
}

// Pinta la pestaña Historial dentro del editor de catálogo
async function pintarPestanaHistorial(catalogId) {
  const $cont = document.getElementById('editor-pestana-contenido');
  if (!$cont) return;
  $cont.innerHTML = '<div class="loading">Cargando historial…</div>';
  try {
    const r = await api('/api/catalogs/' + catalogId + '/versions');
    const versions = r.versions || [];
    const esAdmin = rolEfectivo() === 'admin';

    if (versions.length === 0) {
      $cont.innerHTML = `
        <div class="editor-panel">
          <div class="empty-state" style="padding:2rem 1rem">
            <div class="empty-state-icono">📚</div>
            <h3>Sin versiones cerradas todavía</h3>
            <p style="font-size:13px;color:var(--gris-texto);max-width:480px;margin:1rem auto">
              ${esAdmin
                ? 'Cuando termines una temporada o quieras dejar constancia del catálogo actual, pulsa <b>📌 Cerrar versión</b> arriba. Se guardará un PDF y un ZIP de respaldo que podrás descargar en cualquier momento.'
                : 'Aún no hay versiones cerradas de este catálogo.'}
            </p>
          </div>
        </div>
      `;
      return;
    }

    $cont.innerHTML = `
      <div class="editor-panel">
        <h3 style="margin-top:0">📚 Historial de versiones</h3>
        <p style="font-size:12px;color:var(--gris-texto);margin-bottom:14px">
          Cada versión es una "foto" del catálogo en el momento de cerrarla. Los PDF y ZIP están conservados en el servidor.
        </p>
        <div class="versiones-lista">
          ${versions.map(v => {
            const fecha = new Date(v.published_at).toLocaleString('es-ES');
            const pdfSizeMB = v.pdf_size_bytes ? (v.pdf_size_bytes / 1024 / 1024).toFixed(1) : null;
            const zipSizeMB = v.zip_size_bytes ? (v.zip_size_bytes / 1024 / 1024).toFixed(1) : null;
            return `
              <div class="version-fila">
                <div class="version-badge">V${v.version_number}</div>
                <div class="version-info">
                  <div class="version-cabecera">
                    <span class="version-titulo">Versión ${v.version_number}</span>
                    <span class="version-meta">${v.total_laminas || '?'} láminas</span>
                  </div>
                  <div class="version-fecha">
                    📅 Cerrada el ${escape(fecha)}${v.published_by_name ? ' · por ' + escape(v.published_by_name) : ''}
                  </div>
                  ${v.notas_version ? `<div class="version-notas">"${escape(v.notas_version)}"</div>` : ''}
                </div>
                <div class="version-acciones">
                  ${v.tiene_pdf ? `<button class="btn-card-mini" onclick="descargarVersionPDF(${v.id})" title="${pdfSizeMB ? pdfSizeMB + ' MB' : ''}">📕 PDF${pdfSizeMB ? ` <span style="color:var(--gris-texto);font-weight:normal">(${pdfSizeMB} MB)</span>` : ''}</button>` : ''}
                  ${v.tiene_zip ? `<button class="btn-card-mini" onclick="descargarVersionZIP(${v.id})" title="${zipSizeMB ? zipSizeMB + ' MB' : ''}">📦 ZIP${zipSizeMB ? ` <span style="color:var(--gris-texto);font-weight:normal">(${zipSizeMB} MB)</span>` : ''}</button>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    $cont.innerHTML = `<div class="error-msg">Error: ${escape(err.message)}</div>`;
  }
}

// Modal selector calidad PDF: alta (original) o pequeño (WhatsApp/email)
function abrirModalDescargarPdf(catalogId, nombreCatalogo) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95vw;max-height:90vh;overflow-y:auto">
      <div class="modal-header">
        <h3 style="margin:0">📥 Descargar PDF</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="color:#6b7280;font-size:13px;margin:0 0 14px 0">
        Catálogo: <b>${escape(nombreCatalogo)}</b>
      </p>
      <p style="margin:0 0 12px 0;font-size:14px">Elige la calidad según el uso:</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="btn-calidad-pdf" onclick="descargarPdfCalidad(${catalogId}, 'alta', this)">
          <div class="bcp-icono">🖨️</div>
          <div class="bcp-cuerpo">
            <div class="bcp-titulo">Alta calidad</div>
            <div class="bcp-sub">Original · para impresión o archivo</div>
            <div class="bcp-tam">Tamaño grande (>100 MB en catálogos extensos)</div>
          </div>
        </button>
        <button class="btn-calidad-pdf" onclick="descargarPdfCalidad(${catalogId}, 'pequena', this)">
          <div class="bcp-icono">📱</div>
          <div class="bcp-cuerpo">
            <div class="bcp-titulo">Calidad reducida</div>
            <div class="bcp-sub">Optimizado · para WhatsApp / email</div>
            <div class="bcp-tam">Tamaño pequeño · imágenes a 1200px</div>
          </div>
        </button>
      </div>
      <div id="dl-pdf-msg" style="margin-top:12px"></div>
      <div class="modal-acciones">
        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function descargarPdfCalidad(catalogId, calidad, btnEl) {
  const $msg = document.getElementById('dl-pdf-msg');
  // Deshabilitar ambos botones mientras genera
  const $btns = document.querySelectorAll('.btn-calidad-pdf');
  $btns.forEach(b => b.disabled = true);
  if (btnEl) btnEl.style.opacity = '0.6';
  $msg.innerHTML = `<div style="color:#6b7280;font-size:13px">⏳ Generando PDF (${calidad === 'pequena' ? 'calidad reducida, puede tardar 1-3 min según número de láminas' : 'alta calidad'})…</div>`;

  try {
    const token = localStorage.getItem('cpv2_token') || '';
    const url = `/api/catalogs/${catalogId}/download-pdf?calidad=${calidad}`;
    const resp = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!resp.ok) {
      try {
        const json = await resp.json();
        throw new Error(json.error || 'Error ' + resp.status);
      } catch (_) {
        throw new Error('Error ' + resp.status);
      }
    }
    const blob = await resp.blob();
    const tamMB = (blob.size / 1024 / 1024).toFixed(1);
    // Forzar descarga
    const urlBlob = URL.createObjectURL(blob);
    // Sacar el nombre del header si existe, sino usar fallback
    const disp = resp.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="?([^"]+)"?/);
    const filename = m ? m[1] : `catalogo${calidad === 'pequena' ? '_pequeno' : ''}.pdf`;
    const a = document.createElement('a');
    a.href = urlBlob;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(urlBlob), 5000);
    $msg.innerHTML = `<div class="exito-msg">✅ PDF descargado (${tamMB} MB)</div>`;
    $btns.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
  } catch (err) {
    $msg.innerHTML = `<div class="error-msg">Error: ${escape(err.message)}</div>`;
    $btns.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
  }
}

// ============================================================================
// MEGA FOLDERS - gestion admin (Configuracion → Carpetas MEGA)
// ============================================================================
let _megaComerciales = []; // cache de comerciales para el dropdown de user_id

async function cargarCarpetasMega() {
  const $lista = document.getElementById('mega-folders-lista');
  if (!$lista) return;
  try {
    const [r, ru] = await Promise.all([
      api('/api/admin/mega-folders'),
      api('/api/users')
    ]);
    _megaComerciales = (ru.users || []).filter(u => u.role === 'sales' && u.is_active);
    const folders = r.folders || [];
    if (folders.length === 0) {
      $lista.innerHTML = `<div style="color:var(--gris-texto);font-size:13px;padding:12px;text-align:center;background:var(--surface-2);border-radius:8px">
        Todavía no hay carpetas configuradas. Pulsa "🌱 Crear las 6 carpetas iniciales" para empezar.
      </div>`;
      return;
    }
    $lista.innerHTML = `
      <div style="overflow-x:auto">
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <thead>
          <tr style="background:var(--surface-2);text-align:left">
            <th style="padding:8px;border-bottom:1px solid var(--gris-borde)">Nombre carpeta MEGA</th>
            <th style="padding:8px;border-bottom:1px solid var(--gris-borde)">Enlace público</th>
            <th style="padding:8px;border-bottom:1px solid var(--gris-borde)">Email a</th>
            <th style="padding:8px;border-bottom:1px solid var(--gris-borde)">Estado</th>
            <th style="padding:8px;border-bottom:1px solid var(--gris-borde)"></th>
          </tr>
        </thead>
        <tbody>
          ${folders.map(f => `
            <tr data-folder-id="${f.id}" style="border-bottom:1px solid var(--gris-borde);${!f.is_active ? 'opacity:0.5' : ''}">
              <td style="padding:8px;vertical-align:top">
                <div style="font-weight:600">${escape(f.nombre)}</div>
                ${f.descripcion ? `<div style="font-size:11px;color:var(--gris-texto);margin-top:2px">${escape(f.descripcion)}</div>` : ''}
              </td>
              <td style="padding:8px;vertical-align:top;min-width:200px">
                <input type="text" class="mega-url-input" value="${escape(f.mega_url || '')}" placeholder="Pega aquí el enlace https://mega.nz/..." data-folder-id="${f.id}"
                       style="width:100%;padding:4px 8px;border:1px solid var(--gris-borde);border-radius:4px;font-size:12px;font-family:monospace">
                ${!f.mega_url ? `<div style="font-size:10px;color:#dc2626;margin-top:2px">⚠️ Sin enlace</div>` : ''}
              </td>
              <td style="padding:8px;vertical-align:top">
                <select class="mega-user-select" data-folder-id="${f.id}" style="padding:4px 6px;border:1px solid var(--gris-borde);border-radius:4px;font-size:12px">
                  <option value="">— sin destinatario —</option>
                  ${_megaComerciales.map(u => `<option value="${u.id}" ${f.user_id === u.id ? 'selected' : ''}>${escape(u.name)}</option>`).join('')}
                </select>
              </td>
              <td style="padding:8px;vertical-align:top">
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
                  <input type="checkbox" class="mega-active-check" data-folder-id="${f.id}" ${f.is_active ? 'checked' : ''}>
                  ${f.is_active ? 'Activa' : 'Oculta'}
                </label>
              </td>
              <td style="padding:8px;vertical-align:top;white-space:nowrap">
                <button class="btn btn-primary btn-pequeno" onclick="guardarCarpetaMega(${f.id}, this)">💾</button>
                <button class="btn btn-danger btn-pequeno" onclick="borrarCarpetaMega(${f.id}, '${escape(f.nombre)}', this)">🗑️</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `;
  } catch (e) {
    $lista.innerHTML = `<div class="error-msg">Error cargando carpetas: ${escape(e.message)}</div>`;
  }
}

async function guardarCarpetaMega(folderId, boton) {
  const $url = document.querySelector('.mega-url-input[data-folder-id="' + folderId + '"]');
  const $user = document.querySelector('.mega-user-select[data-folder-id="' + folderId + '"]');
  const $active = document.querySelector('.mega-active-check[data-folder-id="' + folderId + '"]');
  const t = boton.textContent;
  boton.disabled = true;
  boton.textContent = '⏳';
  try {
    const r = await api('/api/admin/mega-folders/' + folderId, {
      method: 'PUT',
      body: JSON.stringify({
        mega_url: ($url.value || '').trim(),
        user_id: $user.value ? Number($user.value) : null,
        is_active: $active.checked
      })
    });
    if (r.success) {
      boton.textContent = '✅';
      setTimeout(() => { boton.textContent = t; boton.disabled = false; cargarCarpetasMega(); }, 1200);
    } else {
      boton.textContent = '❌';
      setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 2000);
      alert('Error: ' + (r.error || 'no se pudo guardar'));
    }
  } catch (e) {
    boton.textContent = '❌';
    setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 2000);
    alert('Error: ' + e.message);
  }
}

async function borrarCarpetaMega(folderId, nombre, boton) {
  if (!confirm(`¿Borrar la carpeta "${nombre}" de la app?\n\n⚠️ NO borra la carpeta de MEGA (los archivos se conservan). Solo la elimina de esta lista.`)) return;
  boton.disabled = true;
  try {
    const r = await api('/api/admin/mega-folders/' + folderId, { method: 'DELETE' });
    if (r.success) cargarCarpetasMega();
    else alert('Error: ' + (r.error || 'no se pudo borrar'));
  } catch (e) {
    alert('Error: ' + e.message);
    boton.disabled = false;
  }
}

async function abrirNuevaCarpetaMega() {
  const nombre = prompt('Nombre exacto de la carpeta en MEGA:\n(se creará automáticamente si no existe)');
  if (!nombre || !nombre.trim()) return;
  try {
    const r = await api('/api/admin/mega-folders', {
      method: 'POST',
      body: JSON.stringify({ nombre: nombre.trim() })
    });
    if (r.success) {
      cargarCarpetasMega();
    } else {
      alert('Error: ' + (r.error || 'no se pudo crear'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function seedCarpetasMega(boton) {
  if (!confirm('¿Crear las 6 carpetas iniciales en MEGA?\n\n• Catalogo Lomhifar Fernando 2026 (Comercial Fernando)\n• Catalogo Lomhifar Eva 2026 (Comercial Eva)\n• Catalogo Lomhifar Duofarma 2026 (Miguel Ángel)\n• Catalogo Essity 2026 (Laboratorio)\n• Catalogo Beter 2026 (Laboratorio)\n• Catalogo Onevit 2026 (Laboratorio)\n\nPuede tardar 1-2 minutos.')) return;
  const t = boton.textContent;
  boton.disabled = true;
  boton.textContent = '⏳ Creando en MEGA (hasta 2 min)…';
  try {
    const r = await api('/api/admin/mega-folders/seed', { method: 'POST' });
    if (r.success) {
      const ok = r.resultados.filter(x => x.creada_en_mega).length;
      alert(`✅ Listo. ${ok}/6 creadas en MEGA.\n\nAhora ve a MEGA → clic derecho en cada una → "Obtener enlace" → pégalo en la tabla.`);
      cargarCarpetasMega();
    } else {
      alert('Error: ' + (r.error || 'seed falló'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    boton.textContent = t;
    boton.disabled = false;
  }
}

// ============================================================================
// IA TAGS - regenerar de una lamina o backfill masivo
// ============================================================================
async function regenerarTagsIA(sheetId, boton) {
  const orig = boton.textContent;
  boton.disabled = true;
  boton.textContent = '⏳';
  try {
    const r = await api('/api/sheets/' + sheetId + '/regenerate-tags', { method: 'POST' });
    if (r.success && r.tags) {
      // Actualizar el input de tags visible en la fila
      const fila = document.querySelector('.lamina-fila[data-id="' + sheetId + '"]');
      const input = fila?.querySelector('.lamina-tags-input');
      if (input) {
        input.value = r.tags;
        input.classList.remove('lamina-tags-dirty');
      } else {
        // Vista sin edicion inline: recargar el editor
        // (nada crítico si no encontramos el input)
      }
      boton.textContent = '✅';
      setTimeout(() => { boton.textContent = orig; boton.disabled = false; }, 1500);
    } else {
      boton.textContent = '❌';
      alert('Error: ' + (r.error || 'sin tags'));
      setTimeout(() => { boton.textContent = orig; boton.disabled = false; }, 2500);
    }
  } catch (e) {
    boton.textContent = '❌';
    alert('Error: ' + e.message);
    setTimeout(() => { boton.textContent = orig; boton.disabled = false; }, 2500);
  }
}

async function backfillTagsIA(boton) {
  if (!confirm('¿Generar tags con IA para todas las láminas que no tienen tags?\n\nSe procesa en lotes de 20. Coste estimado: ~$0.0001 por lámina (~4 céntimos para 400 láminas).')) return;
  const orig = boton.textContent;
  boton.disabled = true;
  const $out = document.getElementById('backfill-tags-out');
  let totalOk = 0, totalKo = 0, ronda = 0;
  try {
    while (ronda < 60) { // seguridad: max 60 lotes = 1200 laminas
      ronda++;
      boton.textContent = '⏳ Lote ' + ronda + '...';
      const r = await api('/api/admin/backfill-tags?limit=20', { method: 'POST' });
      if (!r.success) throw new Error(r.error || 'sin exito');
      totalOk += r.ok || 0;
      totalKo += r.fallidas || 0;
      if ($out) $out.innerHTML = `Procesadas: ${totalOk + totalKo} · OK: ${totalOk} · fallidas: ${totalKo} · restantes: ${r.restantes}`;
      if (r.procesadas === 0 || r.restantes === 0) break;
    }
    boton.textContent = '✅ Terminado';
    setTimeout(() => { boton.textContent = orig; boton.disabled = false; }, 3000);
  } catch (e) {
    boton.textContent = '❌ Error';
    alert('Error: ' + e.message);
    setTimeout(() => { boton.textContent = orig; boton.disabled = false; }, 2500);
  }
}

let _backfillZonasStop = false;
let _backfillZonasEnCurso = false;

async function backfillZonasIA(boton) {
  // Si YA está corriendo, este mismo botón sirve como "Detener"
  if (_backfillZonasEnCurso) {
    _backfillZonasStop = true;
    boton.textContent = '⏳ Deteniendo...';
    return;
  }
  if (!confirm('¿Detectar zonas con IA en todas las láminas pendientes?\n\n• Solo procesa láminas NUEVAS o que aún no han pasado por la IA.\n• Las que ya tienen zonas dibujadas se saltan.\n• Coste: ~$0.02 (2 céntimos) por lámina.\n\nPuedes detener el proceso en cualquier momento pulsando el mismo botón.')) return;
  const orig = '🎯 Detectar zonas en todas las láminas pendientes';
  _backfillZonasStop = false;
  _backfillZonasEnCurso = true;
  boton.classList.add('btn-danger');
  boton.classList.remove('btn-primary');
  const $out = document.getElementById('backfill-zonas-out');
  let totalProc = 0, totalZonas = 0, totalMatch = 0, totalErr = 0, ronda = 0;
  let restantesInicial = null; // se fija con la primera respuesta, para calcular el total real
  const llamarLote = async (intentos = 3) => {
    let ultErr = null;
    for (let i = 0; i < intentos; i++) {
      if (_backfillZonasStop) throw new Error('detenido por el usuario');
      try {
        // Lote de 2 laminas por llamada (~16s): 2x mas rapido que 1, y seguro por debajo
        // del timeout de red/Railway aunque caiga alguna lamina grande de expositor.
        return await api('/api/admin/backfill-detect-zones?limit=2', { method: 'POST' });
      } catch (e) {
        ultErr = e;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    throw ultErr || new Error('sin exito tras varios intentos');
  };
  try {
    while (ronda < 1000 && !_backfillZonasStop) {
      ronda++;
      const r = await llamarLote(3);
      if (!r.success) throw new Error(r.error || 'sin éxito');
      totalProc += r.procesadas || 0;
      totalZonas += r.zonas_creadas || 0;
      totalMatch += r.con_match || 0;
      totalErr += r.errores || 0;
      // Total real = las que ya procesamos en esta sesion + las que quedaban al empezar
      if (restantesInicial === null) restantesInicial = (r.restantes || 0) + (r.procesadas || 0);
      const totalReal = restantesInicial;
      const hechas = totalReal - (r.restantes || 0);
      boton.textContent = `🛑 Detener (${hechas}/${totalReal}…)`;
      if ($out) {
        $out.innerHTML = `Progreso: <b>${hechas}/${totalReal}</b> láminas · zonas creadas esta sesión: <b>${totalZonas}</b> · con match Sage: <b>${totalMatch}</b> · errores: ${totalErr} · <b>quedan ${r.restantes}</b>`;
      }
      if ((r.procesadas || 0) === 0 || r.restantes === 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (_backfillZonasStop) {
      boton.textContent = '🛑 Detenido';
      if ($out) $out.innerHTML += `<br><span style="color:#ca8a04">Proceso detenido. Puedes reanudar pulsando el botón otra vez — continúa desde donde iba.</span>`;
    } else {
      boton.textContent = '✅ Terminado';
    }
  } catch (e) {
    if (String(e.message).includes('detenido por el usuario')) {
      boton.textContent = '🛑 Detenido';
      if ($out) $out.innerHTML += `<br><span style="color:#ca8a04">Detenido. Reanuda pulsando otra vez.</span>`;
    } else {
      boton.textContent = '❌ Error';
      if ($out) $out.innerHTML += `<br><span style="color:#dc2626">Error tras ${totalProc} láminas: ${escape(e.message)}. Vuelve a pulsar el botón para continuar donde se paró.</span>`;
    }
  } finally {
    _backfillZonasEnCurso = false;
    _backfillZonasStop = false;
    setTimeout(() => {
      boton.textContent = orig;
      boton.classList.remove('btn-danger');
      boton.classList.add('btn-primary');
    }, 3000);
  }
}

async function backfillColorPerfil(boton) {
  if (!confirm('¿Corregir el perfil de color de todos los PNG con perfil ICC embebido?\n\nSe procesa en lotes de 40 láminas. Sin pérdida de calidad, misma resolución.\nPuede tardar unos minutos según el número de láminas.')) return;
  const orig = boton.textContent;
  boton.disabled = true;
  const $out = document.getElementById('backfill-color-out');
  let totalCorregidas = 0, totalSinPerfil = 0, totalErrores = 0, offset = 0, ronda = 0;
  try {
    while (ronda < 40) { // seguridad: max 40 lotes de 40 = 1600 laminas
      ronda++;
      boton.textContent = '⏳ Lote ' + ronda + '...';
      const r = await api('/api/admin/backfill-color-profile?limit=40&offset=' + offset, { method: 'POST' });
      if (!r.success) throw new Error(r.error || 'sin exito');
      totalCorregidas += r.corregidas || 0;
      totalSinPerfil += r.sin_perfil || 0;
      totalErrores += r.errores || 0;
      offset += r.procesadas || 0;
      if ($out) $out.innerHTML = `Recorridas: ${offset} / ${r.total} · Corregidas: ${totalCorregidas} · Ya OK: ${totalSinPerfil} · Errores: ${totalErrores}`;
      if ((r.procesadas || 0) === 0 || offset >= r.total) break;
    }
    boton.textContent = '✅ Terminado';
    setTimeout(() => { boton.textContent = orig; boton.disabled = false; }, 3000);
  } catch (e) {
    boton.textContent = '❌ Error';
    alert('Error: ' + e.message);
    setTimeout(() => { boton.textContent = orig; boton.disabled = false; }, 2500);
  }
}

// ============================================================================
// SINCRONIZACION SAGE (resumen y historial)
// ============================================================================
async function cargarResumenSyncSage() {
  const $r = document.getElementById('sync-sage-resumen');
  if (!$r) return;
  try {
    const d = await api('/api/admin/sync-batches');
    const ultimos = d.ultimo_por_tipo || [];
    if (ultimos.length === 0) {
      $r.innerHTML = 'Todavía no ha llegado ningún batch de sincronización.';
      return;
    }
    const bloque = (tipo, emoji, label) => {
      const u = ultimos.find(x => x.tipo === tipo);
      if (!u) return `
        <div style="padding:10px;border:1px dashed var(--gris-borde);border-radius:8px;background:var(--surface);flex:1;min-width:170px">
          <div style="font-size:12px;font-weight:600">${emoji} ${label}</div>
          <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Sin datos todavía</div>
        </div>`;
      const fecha = new Date(u.received_at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const err = u.error ? `<div style="font-size:10px;color:#dc2626;margin-top:2px">❌ ${escape(u.error)}</div>` : '';
      return `
        <div style="padding:10px;border:1px solid ${u.error ? '#fecaca' : 'var(--gris-borde)'};border-radius:8px;background:${u.error ? '#fef2f2' : '#fff'};flex:1;min-width:170px">
          <div style="font-size:12px;font-weight:600">${emoji} ${label}</div>
          <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">Último: ${fecha}</div>
          <div style="font-size:11px;margin-top:2px">${u.num_recibidos || 0} recibidos</div>
          <div style="font-size:10px;color:var(--gris-texto)">${u.num_nuevos || 0} nuevos · ${u.num_actualizados || 0} act · ${u.num_marcados_inactivos || 0} inact</div>
          ${err}
        </div>`;
    };
    $r.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${bloque('products', '📦', 'Artículos')}
        ${bloque('clients',  '🏥', 'Clientes')}
        ${bloque('stock',    '📊', 'Stock')}
      </div>
    `;
  } catch (e) {
    $r.innerHTML = `<div class="error-msg">Error: ${escape(e.message)}</div>`;
  }
}

async function verHistorialSyncSage() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h3>📋 Historial sincronización Sage</h3><button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button></div><div id="sync-hist-content">Cargando…</div></div>`;
  document.body.appendChild(modal);
  try {
    const d = await api('/api/admin/sync-batches');
    const $c = document.getElementById('sync-hist-content');
    if ((d.batches || []).length === 0) {
      $c.innerHTML = '<div style="color:var(--gris-texto);font-size:13px;padding:12px;text-align:center">Sin batches todavía.</div>';
      return;
    }
    const emoji = { products: '📦', clients: '🏥', stock: '📊' };
    $c.innerHTML = `
      <div style="max-height:500px;overflow-y:auto">
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2);text-align:left">
            <th style="padding:6px 8px">Tipo</th>
            <th style="padding:6px 8px">Recibido</th>
            <th style="padding:6px 8px">Filas</th>
            <th style="padding:6px 8px">Nuevos</th>
            <th style="padding:6px 8px">Act.</th>
            <th style="padding:6px 8px">Inact.</th>
            <th style="padding:6px 8px">Duración</th>
            <th style="padding:6px 8px">Error</th>
          </tr></thead>
          <tbody>
            ${d.batches.map(b => `
              <tr style="border-bottom:1px solid var(--gris-borde)">
                <td style="padding:6px 8px">${emoji[b.tipo] || ''} ${b.tipo}</td>
                <td style="padding:6px 8px">${new Date(b.received_at).toLocaleString('es-ES')}</td>
                <td style="padding:6px 8px">${b.num_recibidos || 0}</td>
                <td style="padding:6px 8px">${b.num_nuevos || 0}</td>
                <td style="padding:6px 8px">${b.num_actualizados || 0}</td>
                <td style="padding:6px 8px">${b.num_marcados_inactivos || 0}</td>
                <td style="padding:6px 8px">${b.duracion_ms || 0} ms</td>
                <td style="padding:6px 8px;color:#dc2626">${b.error ? escape(b.error.substring(0, 60)) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    document.getElementById('sync-hist-content').innerHTML = `<div class="error-msg">Error: ${escape(e.message)}</div>`;
  }
}

// ============================================================================
// RESUMEN A OFICINA
// ============================================================================
async function cargarDestinatariosOficina() {
  const $lista = document.getElementById('office-recipients-lista');
  if (!$lista) return;
  try {
    const r = await api('/api/admin/office-recipients');
    const recs = r.recipients || [];
    if (recs.length === 0) {
      $lista.innerHTML = `<div style="color:var(--gris-texto);font-size:12px;padding:8px;background:var(--surface-2);border-radius:6px">
        No hay destinatarios. Pulsa "🌱 Añadir los 4 iniciales" para configurar los emails de oficina.
      </div>`;
      return;
    }
    $lista.innerHTML = `
      <div style="border:1px solid var(--gris-borde);border-radius:6px;overflow:hidden">
        ${recs.map(r => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #f3f4f6;${!r.is_active ? 'opacity:0.5' : ''}">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
              <input type="checkbox" ${r.is_active ? 'checked' : ''} onchange="toggleDestinatarioOficina(${r.id}, this.checked)">
              ${r.is_active ? '✅' : '⚪'}
            </label>
            <div style="flex:1">
              <div style="font-size:13px;font-weight:600">${escape(r.email)}</div>
              ${r.nombre ? `<div style="font-size:11px;color:var(--gris-texto)">${escape(r.nombre)}</div>` : ''}
            </div>
            <button class="btn btn-danger btn-pequeno" onclick="borrarDestinatarioOficina(${r.id}, '${escape(r.email)}', this)">🗑️</button>
          </div>
        `).join('')}
      </div>
    `;
  } catch (e) {
    $lista.innerHTML = `<div class="error-msg">Error: ${escape(e.message)}</div>`;
  }
}

async function toggleDestinatarioOficina(id, isActive) {
  try {
    await api('/api/admin/office-recipients/' + id, {
      method: 'PUT',
      body: JSON.stringify({ is_active: isActive })
    });
    cargarDestinatariosOficina();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function borrarDestinatarioOficina(id, email, boton) {
  if (!confirm('¿Borrar el destinatario "' + email + '"?')) return;
  boton.disabled = true;
  try {
    await api('/api/admin/office-recipients/' + id, { method: 'DELETE' });
    cargarDestinatariosOficina();
  } catch (e) {
    alert('Error: ' + e.message);
    boton.disabled = false;
  }
}

async function abrirNuevoDestinatarioOficina() {
  const email = prompt('Email de oficina:');
  if (!email || !email.includes('@')) return;
  const nombre = prompt('Nombre (opcional):') || '';
  try {
    await api('/api/admin/office-recipients', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), nombre: nombre.trim() })
    });
    cargarDestinatariosOficina();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function seedDestinatariosOficina(boton) {
  if (!confirm('¿Añadir los 4 emails iniciales de oficina?\n\n• lomhifar@comercial.com\n• administracion@comercial.com\n• comercial@lomhifar.com\n• lomhifartablet@lomhifar.com')) return;
  boton.disabled = true;
  const t = boton.textContent;
  boton.textContent = '⏳';
  try {
    await api('/api/admin/office-recipients/seed', { method: 'POST' });
    cargarDestinatariosOficina();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    boton.textContent = t;
    boton.disabled = false;
  }
}

async function abrirEnviarResumenOficina() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:820px">
      <div class="modal-header">
        <h3>✉️ Enviar resumen a oficina</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="office-preview-cargando" style="padding:20px;text-align:center;color:var(--gris-texto)">Calculando cambios…</div>
      <div id="office-preview-contenido" style="display:none"></div>
    </div>
  `;
  document.body.appendChild(modal);
  try {
    const p = await api('/api/admin/office-summary/preview');
    document.getElementById('office-preview-cargando').style.display = 'none';
    const $c = document.getElementById('office-preview-contenido');
    $c.style.display = 'block';
    const total = p.resumen.nuevas + p.resumen.modificadas + p.resumen.eliminadas;
    $c.innerHTML = `
      <div style="background:var(--surface-2);padding:12px;border-radius:8px;margin-bottom:14px">
        <div style="font-size:12px;color:var(--gris-texto)">Periodo: ${new Date(p.desde).toLocaleDateString('es-ES')} → hoy</div>
        <div style="font-size:14px;font-weight:600;margin-top:4px">
          ${total === 0 ? '✅ Sin cambios' : `${total} cambio${total > 1 ? 's' : ''} en láminas`}
        </div>
        <div style="font-size:11px;color:var(--gris-texto);margin-top:4px">
          ➕ ${p.resumen.nuevas} nuevas · ✏️ ${p.resumen.modificadas} modificadas · 🗑️ ${p.resumen.eliminadas} eliminadas
        </div>
      </div>

      ${p.laminas_nuevas.length > 0 ? `
        <div style="font-size:12px;font-weight:600;color:#16a34a;margin:10px 0 4px 0">➕ Láminas nuevas (${p.laminas_nuevas.length})</div>
        <div style="max-height:150px;overflow-y:auto;font-size:11px;border:1px solid var(--gris-borde);border-radius:6px;padding:8px">
          ${p.laminas_nuevas.map(l => `<div style="padding:2px 0">• <b>${escape(l.titulo || '')}</b> · ${escape(l.catalog_name || '')} · ${new Date(l.created_at).toLocaleDateString('es-ES')}</div>`).join('')}
        </div>
      ` : ''}

      ${p.laminas_modificadas.length > 0 ? `
        <div style="font-size:12px;font-weight:600;color:#ca8a04;margin:10px 0 4px 0">✏️ Láminas modificadas (${p.laminas_modificadas.length})</div>
        <div style="max-height:150px;overflow-y:auto;font-size:11px;border:1px solid var(--gris-borde);border-radius:6px;padding:8px">
          ${p.laminas_modificadas.map(l => `<div style="padding:2px 0">• <b>${escape(l.titulo || '')}</b> · ${escape(l.catalog_name || '')} · ${new Date(l.created_at).toLocaleDateString('es-ES')}</div>`).join('')}
        </div>
      ` : ''}

      ${p.laminas_eliminadas.length > 0 ? `
        <div style="font-size:12px;font-weight:600;color:#dc2626;margin:10px 0 4px 0">🗑️ Láminas eliminadas (${p.laminas_eliminadas.length})</div>
        <div style="max-height:150px;overflow-y:auto;font-size:11px;border:1px solid var(--gris-borde);border-radius:6px;padding:8px">
          ${p.laminas_eliminadas.map(l => `<div style="padding:2px 0">• <b>${escape(l.titulo || '')}</b> · ${escape(l.catalog_name || '')} · ${new Date(l.created_at).toLocaleDateString('es-ES')}</div>`).join('')}
        </div>
      ` : ''}

      <div style="font-size:12px;font-weight:600;margin:14px 0 4px 0">📚 Catálogos MEGA que se incluirán (${p.mega_carpetas.length})</div>
      <div style="max-height:120px;overflow-y:auto;font-size:11px;border:1px solid var(--gris-borde);border-radius:6px;padding:8px">
        ${p.mega_carpetas.map(f => `<div style="padding:2px 0">• <b>${escape(f.nombre)}</b>${f.ultimo_catalogo ? ` · último: ${escape(f.ultimo_catalogo)} V${f.ultima_version}` : ' · sin backups'}</div>`).join('')}
      </div>

      <div style="font-size:12px;font-weight:600;margin:14px 0 4px 0">📧 Destinatarios (${p.destinatarios.length})</div>
      <div style="font-size:11px;background:var(--surface-2);padding:8px;border-radius:6px">
        ${p.destinatarios.map(d => escape(d.email)).join(' · ') || '<span style="color:#dc2626">⚠️ Sin destinatarios configurados</span>'}
      </div>

      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button id="office-btn-enviar" class="btn btn-primary" ${p.destinatarios.length === 0 ? 'disabled' : ''} onclick="enviarResumenOficinaConfirmar(this)">✉️ Enviar ahora</button>
      </div>
      <div id="office-envio-result" style="margin-top:12px"></div>
    `;
  } catch (e) {
    document.getElementById('office-preview-cargando').innerHTML = `<div class="error-msg">Error: ${escape(e.message)}</div>`;
  }
}

async function enviarResumenOficinaConfirmar(boton) {
  if (!confirm('¿Confirmar envío del resumen a la oficina?\n\nSe registrará como enviado y el próximo resumen incluirá solo los cambios posteriores a este.')) return;
  boton.disabled = true;
  const t = boton.textContent;
  boton.textContent = '⏳ Enviando…';
  try {
    const r = await api('/api/admin/office-summary/send', { method: 'POST' });
    const $res = document.getElementById('office-envio-result');
    if (r.success) {
      $res.innerHTML = `<div style="padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;color:#166534;font-size:13px">
        ✅ Enviado a ${r.enviados} destinatarios (${r.resumen.nuevas} nuevas, ${r.resumen.modificadas} modificadas, ${r.resumen.eliminadas} eliminadas).
      </div>`;
      boton.textContent = '✅ Enviado';
    } else {
      $res.innerHTML = `<div class="error-msg">Envío parcial. Fallos: ${(r.fallos || []).join(', ')}</div>`;
      boton.textContent = t;
      boton.disabled = false;
    }
  } catch (e) {
    document.getElementById('office-envio-result').innerHTML = `<div class="error-msg">Error: ${escape(e.message)}</div>`;
    boton.textContent = t;
    boton.disabled = false;
  }
}

async function verHistorialResumenes() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `<div class="modal-card"><div class="modal-header"><h3>📋 Últimos envíos</h3><button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button></div><div id="hist-content">Cargando…</div></div>`;
  document.body.appendChild(modal);
  try {
    const r = await api('/api/admin/office-summary/history');
    const $c = document.getElementById('hist-content');
    if ((r.history || []).length === 0) {
      $c.innerHTML = '<div style="color:var(--gris-texto);font-size:13px;padding:12px;text-align:center">No hay envíos todavía.</div>';
      return;
    }
    $c.innerHTML = `
      <div style="max-height:400px;overflow-y:auto">
        ${r.history.map(h => `
          <div style="padding:10px;border-bottom:1px solid var(--gris-borde);font-size:12px">
            <div style="font-weight:600">📅 ${new Date(h.sent_at).toLocaleString('es-ES')}</div>
            <div style="color:var(--gris-texto);margin-top:4px">
              ${h.num_nuevas + h.num_modificadas + h.num_eliminadas} cambios ·
              ${h.num_nuevas} nuevas · ${h.num_modificadas} mod · ${h.num_eliminadas} elim
            </div>
            <div style="color:var(--gris-texto);font-size:11px;margin-top:2px">
              A: ${(h.destinatarios || []).join(', ')}
            </div>
            ${h.sent_by_name ? `<div style="color:var(--gris-texto);font-size:11px">Por: ${escape(h.sent_by_name)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } catch (e) {
    document.getElementById('hist-content').innerHTML = `<div class="error-msg">Error: ${escape(e.message)}</div>`;
  }
}

// ============================================================================
// MEGA BACKUP - modal que arranca el job asincrono + polling con progreso
// ============================================================================
// Informe de precios dinámicos del catálogo: qué láminas revisar/actualizar a mano.
async function abrirInformePrecios(catalogId, nombreCatalogo) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `<div class="modal-card" style="max-width:680px;max-height:88vh;display:flex;flex-direction:column">
    <div class="modal-header"><h3>📋 Informe de precios · ${escape(nombreCatalogo || '')}</h3>
      <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button></div>
    <div id="informe-cuerpo" style="overflow-y:auto"><div class="loading" style="padding:24px">Analizando el catálogo…</div></div>
  </div>`;
  document.body.appendChild(modal);
  let inf;
  try { inf = (await api('/api/catalogs/' + catalogId + '/informe-precios')).informe; }
  catch (e) { document.getElementById('informe-cuerpo').innerHTML = `<div class="error-msg" style="margin:16px">${escape(e.message)}</div>`; return; }
  const irA = (sid) => { modal.remove(); abrirEditorZonas(sid, catalogId); };
  window._informeIr = irA;
  const lista = (arr, extra) => arr.map(x => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--gris-borde)">
      <span style="background:#111827;color:#fff;border-radius:6px;padding:1px 8px;font-size:12px;font-weight:700;flex:0 0 auto">${x.numero}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">${escape(x.titulo)}</div>
        ${extra ? extra(x) : ''}
      </div>
      <button class="btn btn-secondary btn-pequeno" onclick="_informeIr(${x.sheet_id})">Abrir</button>
    </div>`).join('');
  const bloque = (icono, titulo, color, arr, desc, extra) => `
    <details ${arr.length ? 'open' : ''} style="margin:0 0 6px">
      <summary style="cursor:pointer;padding:10px 12px;font-weight:700;background:${color};border-radius:8px;list-style:none">
        ${icono} ${titulo} <span style="background:#fff;border-radius:10px;padding:0 8px;font-size:12px">${arr.length}</span>
      </summary>
      ${arr.length ? `<div style="font-size:12px;color:var(--gris-texto);padding:6px 12px">${desc}</div>${lista(arr, extra)}` : `<div style="font-size:12px;color:var(--gris-texto);padding:8px 12px">Ninguna 👍</div>`}
    </details>`;
  const notasHtml = x => x.notas && x.notas.length
    ? `<div style="font-size:12px;color:#b45309;margin-top:2px">⚠️ ${x.pendientes}/${x.total} sin aprobar · ${escape(x.notas.slice(0, 3).join(' · '))}${x.notas.length > 3 ? '…' : ''}</div>`
    : `<div style="font-size:12px;color:#b45309;margin-top:2px">⚠️ ${x.pendientes}/${x.total} sin aprobar</div>`;
  document.getElementById('informe-cuerpo').innerHTML = `
    <div style="padding:12px 16px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <span class="lamina-estado-precios ok">✅ ${inf.ok} al día</span>
        <span class="lamina-estado-precios pend">⚠️ ${inf.anomalas.length} con avisos</span>
        <span class="lamina-estado-precios none">💶 ${inf.pendientes.length} sin precios</span>
        <span class="lamina-estado-precios excl">🔒 ${inf.excluidas.length} excluidas</span>
        <span style="font-size:12px;color:var(--gris-texto);align-self:center">de ${inf.total} láminas</span>
      </div>
      ${bloque('⚠️', 'Con precios anómalos (revisar)', '#fef3c7', inf.anomalas, 'Tienen precios detectados pero con avisos (PVPR dudoso, valor lejos del impreso…). No se muestran al cliente hasta aprobarlos.', notasHtml)}
      ${bloque('💶', 'Sin precios (pendientes)', '#f3f4f6', inf.pendientes, 'Tienen productos/familias pero aún no se les han asignado precios. Ábrelas y detecta/dibuja.', null)}
      ${bloque('🔒', 'Excluidas (a mano)', '#e5e7eb', inf.excluidas, 'Marcadas para hacer a mano; el sistema no las toca.', null)}
      ${bloque('🧾', 'De comisión (no aplica)', '#f5f3ff', inf.comision, 'Productos de laboratorios a comisión: no están en Sage, no hay precio de BD que reescribir.', null)}
    </div>`;
}

async function abrirBackupMega(catalogId, nombreCatalogo) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:640px">
      <div class="modal-header">
        <h3>☁️ Backup en MEGA</h3>
        <button class="modal-cerrar" onclick="if(!window._megaJobRunning)this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:13px;color:var(--gris-texto);margin-bottom:14px">
        <b>${escape(nombreCatalogo)}</b><br>
        Elige a qué carpetas de MEGA quieres subir las láminas como fotos sueltas.
        Cada carpeta seleccionada recibirá una subcarpeta con este catálogo (nombre y fecha).
      </p>
      <div id="mega-cargando" style="text-align:center;padding:20px;color:var(--gris-texto)">Cargando carpetas MEGA…</div>
      <div id="mega-pre-confirm" style="display:none"></div>
      <div id="mega-progreso" style="display:none">
        <div id="mega-fase" style="font-size:13px;margin-bottom:8px">Iniciando...</div>
        <div style="background:#e5e7eb;height:20px;border-radius:10px;overflow:hidden;margin-bottom:8px">
          <div id="mega-barra" style="background:linear-gradient(90deg,#cc007a,#dc2675);height:100%;width:0%;transition:width 0.4s"></div>
        </div>
        <div id="mega-contador" style="font-size:12px;color:var(--gris-texto);text-align:center">0 / 0 láminas</div>
      </div>
      <div id="mega-resultados" style="display:none;margin-top:14px"></div>
      <div id="mega-error"></div>
    </div>
  `;
  document.body.appendChild(modal);

  // Cargar carpetas MEGA disponibles
  try {
    const r = await api('/api/admin/mega-folders');
    const activas = (r.folders || []).filter(f => f.is_active);
    document.getElementById('mega-cargando').style.display = 'none';
    const $conf = document.getElementById('mega-pre-confirm');
    $conf.style.display = 'block';
    if (activas.length === 0) {
      $conf.innerHTML = `
        <div style="padding:16px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-size:13px">
          ⚠️ No hay carpetas MEGA configuradas todavía.<br><br>
          Ve a <b>⚙️ Configuración → Carpetas MEGA</b> para configurarlas antes de hacer backups.
        </div>
        <div style="margin-top:14px">
          <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
        </div>
      `;
      return;
    }
    const sinLink = activas.filter(f => !f.mega_url);
    $conf.innerHTML = `
      ${sinLink.length > 0 ? `<div style="padding:10px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-size:12px;margin-bottom:14px">
        ⚠️ ${sinLink.length} carpeta(s) sin enlace público configurado. Ve a Configuración → Carpetas MEGA para pegar los enlaces.
      </div>` : ''}
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">📁 Selecciona destinos:</div>
      <div style="max-height:280px;overflow-y:auto;border:1px solid var(--gris-borde);border-radius:8px;padding:8px">
        ${activas.map(f => `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px;cursor:${f.mega_url ? 'pointer' : 'not-allowed'};border-radius:6px;${!f.mega_url ? 'opacity:0.5' : ''}">
            <input type="checkbox" class="mega-folder-check" data-folder-id="${f.id}" ${!f.mega_url ? 'disabled' : ''} style="margin-top:3px">
            <div style="flex:1">
              <div style="font-weight:600;font-size:13px">${escape(f.nombre)}</div>
              ${f.descripcion ? `<div style="font-size:11px;color:var(--gris-texto)">${escape(f.descripcion)}</div>` : ''}
              ${f.user_name ? `<div style="font-size:11px;color:var(--gris-texto)">✉️ Email a: ${escape(f.user_name)}</div>` : `<div style="font-size:11px;color:var(--gris-texto)">🌐 Sin destinatario (envío manual)</div>`}
              ${!f.mega_url ? `<div style="font-size:11px;color:#dc2626">⚠️ Sin enlace público</div>` : ''}
            </div>
          </label>
        `).join('')}
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="mega-con-precios" style="margin:0">
        <span>💶 Subir con <b>precios de hoy</b> y ofertas (recompone cada lámina; tarda algo más)</span>
      </label>
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="btn btn-primary" onclick="lanzarBackupMega(${catalogId})">☁️ Empezar backup</button>
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
      </div>
    `;
  } catch (e) {
    document.getElementById('mega-cargando').innerHTML = `<div class="error-msg">Error cargando carpetas: ${escape(e.message)}</div>`;
  }
}

async function lanzarBackupMega(catalogId) {
  const seleccionadas = Array.from(document.querySelectorAll('.mega-folder-check:checked'))
    .map(c => Number(c.dataset.folderId));
  if (seleccionadas.length === 0) {
    alert('Selecciona al menos una carpeta MEGA de destino');
    return;
  }
  const conPrecios = !!(document.getElementById('mega-con-precios') && document.getElementById('mega-con-precios').checked);
  document.getElementById('mega-pre-confirm').style.display = 'none';
  document.getElementById('mega-progreso').style.display = 'block';
  window._megaJobRunning = true;
  try {
    const r = await api('/api/admin/mega-backup/' + catalogId, {
      method: 'POST',
      body: JSON.stringify({ mega_folder_ids: seleccionadas, con_precios: conPrecios })
    });
    if (!r.job_id) throw new Error(r.error || 'No se pudo iniciar el backup');
    seguirBackupMega(r.job_id);
  } catch (e) {
    window._megaJobRunning = false;
    document.getElementById('mega-error').innerHTML = `<div class="error-msg">❌ ${escape(e.message)}</div>`;
  }
}

async function seguirBackupMega(jobId) {
  const $fase = document.getElementById('mega-fase');
  const $barra = document.getElementById('mega-barra');
  const $cont = document.getElementById('mega-contador');
  const $err = document.getElementById('mega-error');
  const $res = document.getElementById('mega-resultados');
  let ticks = 0;
  const interval = setInterval(async () => {
    ticks++;
    try {
      const r = await api('/api/admin/mega-backup/status/' + jobId);
      if (!r.job) throw new Error('sin job');
      const j = r.job;
      $fase.textContent = j.fase || 'Trabajando...';
      const pct = j.total_laminas > 0 ? Math.round((j.subidas / j.total_laminas) * 100) : 0;
      $barra.style.width = pct + '%';
      $cont.textContent = `${j.subidas} / ${j.total_laminas} láminas${j.fallidas ? ' · ' + j.fallidas + ' fallidas' : ''}${j.duracion_s ? ' · ' + j.duracion_s + 's' : ''}`;
      if (j.status === 'done') {
        clearInterval(interval);
        window._megaJobRunning = false;
        $barra.style.width = '100%';
        $fase.innerHTML = '✅ Completado en ' + j.duracion_s + 's';
        $res.style.display = 'block';
        $res.innerHTML = pintarResultadosBackupMega(j);
      } else if (j.status === 'error') {
        clearInterval(interval);
        window._megaJobRunning = false;
        $err.innerHTML = `<div class="error-msg">❌ ${escape(j.error || 'Error desconocido')}</div>`;
      }
    } catch (e) {
      // fallo puntual -> reintenta
      if (ticks > 200) { // ~10 min max
        clearInterval(interval);
        window._megaJobRunning = false;
        $err.innerHTML = `<div class="error-msg">Timeout esperando al servidor: ${escape(e.message)}</div>`;
      }
    }
  }, 3000);
}

function pintarResultadosBackupMega(job) {
  const dests = job.destinos || [];
  const items = dests.map((d) => {
    const rutaInterna = d.subcarpeta_creada || '';
    if (!d.mega_url) {
      return `
        <div style="border:1px solid #ef4444;border-radius:8px;padding:12px;margin-bottom:8px;background:#fef2f2">
          <b>📁 ${escape(d.folder_nombre)}</b>
          <div style="font-size:11px;color:#dc2626;margin-top:4px">
            ⚠️ ${escape(d.error || 'Esta carpeta no tiene enlace público configurado')}
          </div>
        </div>
      `;
    }
    return `
      <div style="border:1px solid var(--gris-borde);border-radius:8px;padding:12px;margin-bottom:8px">
        <b>📁 ${escape(d.folder_nombre)}</b>
        <div style="font-size:11px;color:var(--gris-texto);margin:4px 0">
          El nuevo backup está en la subcarpeta 📂 <b>${escape(rutaInterna)}</b>
        </div>
        <input type="text" value="${escape(d.mega_url)}" readonly onclick="this.select()"
               style="width:100%;padding:6px 10px;border:1px solid var(--gris-borde);border-radius:6px;font-size:12px;font-family:monospace;background:var(--surface-2)">
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-pequeno" onclick="copiarAlPortapapeles('${escape(d.mega_url)}', this)">📋 Copiar link</button>
          <a href="${escape(d.mega_url)}" target="_blank" class="btn btn-secondary btn-pequeno" style="text-decoration:none">🔗 Abrir en MEGA</a>
          ${d.user_id ? `<button class="btn btn-primary btn-pequeno" onclick="enviarLinkMegaEmail(${d.user_id}, '${escape(d.mega_url)}', '${escape(job.catalog_name)}', ${job.catalog_version}, '${escape(rutaInterna)}', this)">✉️ Enviar por email a ${escape(d.user_name || '')}</button>` : `<span style="font-size:11px;color:var(--gris-texto);padding:6px">🌐 Sin destinatario configurado</span>`}
        </div>
      </div>
    `;
  }).join('');
  return `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px">📤 Resultado (${dests.length} carpeta${dests.length > 1 ? 's' : ''})</div>
    ${items}
  `;
}

async function reintentarLinkMega(backupId, boton) {
  boton.disabled = true;
  const t = boton.textContent;
  boton.textContent = '⏳ Iniciando reintento...';
  try {
    // Disparar el reintento (respuesta inmediata, corre en background)
    await api('/api/admin/mega-backup/regenerate-link/' + backupId, { method: 'POST' });
    // Polling de status (hasta 2 minutos)
    let ticks = 0;
    const finalizarConLink = (megaUrl) => {
      const bloque = boton.closest('div[style*="fef2f2"]');
      if (bloque) {
        bloque.style.background = '#f0fdf4';
        bloque.style.borderColor = '#22c55e';
        bloque.innerHTML = `
          <b>✅ Link generado</b>
          <input type="text" value="${escape(megaUrl)}" readonly onclick="this.select()"
                 style="width:100%;padding:6px 10px;margin-top:8px;border:1px solid var(--gris-borde);border-radius:6px;font-size:12px;font-family:monospace;background:var(--surface)">
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-pequeno" onclick="copiarAlPortapapeles('${escape(megaUrl)}', this)">📋 Copiar link</button>
            <a href="${escape(megaUrl)}" target="_blank" class="btn btn-secondary btn-pequeno" style="text-decoration:none">🔗 Abrir en MEGA</a>
          </div>
        `;
      }
    };
    const poll = setInterval(async () => {
      ticks++;
      try {
        const s = await api('/api/admin/mega-backup/regenerate-link/status/' + backupId);
        if (s.status === 'done' && s.mega_url) {
          clearInterval(poll);
          finalizarConLink(s.mega_url);
          return;
        }
        boton.textContent = `⏳ Reintentando... ${s.duracion_s || ticks * 3}s`;
        if (s.status === 'error') {
          clearInterval(poll);
          boton.textContent = '❌ ' + (s.error || 'falló');
          setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 3500);
          return;
        }
      } catch (_) { /* reintentar */ }
      if (ticks > 40) {
        clearInterval(poll);
        boton.textContent = '❌ timeout (2 min)';
        setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 3500);
      }
    }, 3000);
  } catch (e) {
    boton.textContent = '❌ Error red';
    setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 3000);
  }
}

function copiarAlPortapapeles(texto, boton) {
  navigator.clipboard.writeText(texto).then(() => {
    const t = boton.textContent;
    boton.textContent = '✅ Copiado';
    setTimeout(() => { boton.textContent = t; }, 1500);
  });
}

async function enviarLinkMegaEmail(userId, url, catalogName, version, folderName, boton) {
  boton.disabled = true;
  const t = boton.textContent;
  boton.textContent = '⏳ Enviando...';
  try {
    const r = await api('/api/admin/mega-backup/send-email', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, mega_url: url, catalog_name: catalogName, catalog_version: version, folder_name: folderName })
    });
    if (r.success) {
      boton.textContent = '✅ Enviado';
      setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 2500);
    } else {
      boton.textContent = '❌ ' + (r.error || 'falló');
      setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 3000);
    }
  } catch (e) {
    boton.textContent = '❌ Error red';
    setTimeout(() => { boton.textContent = t; boton.disabled = false; }, 3000);
  }
}

// Modal para confirmar el cierre de versión, con campo opcional de notas
function abrirCerrarVersion(catalogId, versionActual, nombreCatalogo) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>📌 Cerrar versión V${versionActual}</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:13px;margin-bottom:14px;line-height:1.5">
        Vas a cerrar la <b>versión ${versionActual}</b> de <b>${escape(nombreCatalogo)}</b>.<br><br>
        Al cerrarla:<br>
        ✅ Se generará un PDF y un ZIP de respaldo de este momento exacto<br>
        ✅ Quedará en el historial para auditoría<br>
        ✅ El catálogo seguirá editable como <b>V${versionActual + 1}</b><br>
      </p>
      <div class="form-group">
        <label>Notas de esta versión <span style="color:var(--gris-texto);font-weight:normal">(opcional, ej: "Catálogo primavera 2026")</span></label>
        <textarea id="cerrar-version-notas" rows="2" placeholder="Describir brevemente esta versión..."></textarea>
      </div>
      <div id="cerrar-version-error"></div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn btn-primary" id="btn-confirmar-cerrar">📌 Cerrar versión</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('btn-confirmar-cerrar').addEventListener('click', async () => {
    const $btn = document.getElementById('btn-confirmar-cerrar');
    const $err = document.getElementById('cerrar-version-error');
    const notas = (document.getElementById('cerrar-version-notas').value || '').trim();
    $btn.disabled = true;
    $btn.textContent = '⏳ Generando PDF y ZIP…';
    $err.innerHTML = '';
    try {
      const r = await api('/api/catalogs/' + catalogId + '/close-version', {
        method: 'POST',
        body: { notas_version: notas }
      });
      modal.remove();
      // Refrescar editor — ahora mostrando el historial
      appState.editorPestana = 'historial';
      renderEditorCatalogo(catalogId);
      alert(`✅ Versión V${r.version_cerrada} cerrada con éxito.\n\nEl catálogo ahora es V${r.nueva_version} y sigue editable.`);
    } catch (err) {
      $err.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
      $btn.disabled = false;
      $btn.textContent = '📌 Cerrar versión';
    }
  });
}

// Descargar PDF de una versión cerrada
async function descargarVersionPDF(versionId) {
  await iniciarDescargaVersion(versionId, 'pdf');
}
async function descargarVersionZIP(versionId) {
  await iniciarDescargaVersion(versionId, 'zip');
}
async function iniciarDescargaVersion(versionId, formato) {
  const url = '/api/catalog-versions/' + versionId + '/download-' + formato;
  try {
    const token = localStorage.getItem('cpv2_token');
    const resp = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) {
      let errorMsg = 'Error ' + resp.status;
      try { const j = await resp.json(); if (j.error) errorMsg = j.error; } catch (_) {}
      throw new Error(errorMsg);
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : ('version.' + formato);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert('Error en la descarga: ' + err.message);
  }
}

// ============================================================================
// ===== J - DESCARGAR COPIA LOCAL DEL CATALOGO =====
// ============================================================================

// Modal con dos opciones: PDF o ZIP
function abrirModalDescargarCatalogo(catalogId, nombreCatalogo) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>📥 Descargar catálogo</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:13px;color:var(--gris-texto);margin-bottom:14px">
        <b>${escape(nombreCatalogo)}</b><br>
        Elige el formato de descarga:
      </p>
      <div class="descargar-opciones">
        <button class="descargar-opcion" onclick="descargarCatalogoPDF(${catalogId}, this)">
          <div class="descargar-opcion-icono">📕</div>
          <div class="descargar-opcion-info">
            <div class="descargar-opcion-titulo">PDF</div>
            <div class="descargar-opcion-desc">Un archivo PDF con todas las láminas en orden. Ideal para imprimir o enviar.</div>
          </div>
        </button>
        <button class="descargar-opcion" onclick="descargarCatalogoZIP(${catalogId}, this)">
          <div class="descargar-opcion-icono">📦</div>
          <div class="descargar-opcion-info">
            <div class="descargar-opcion-titulo">ZIP con originales</div>
            <div class="descargar-opcion-desc">Archivo ZIP con las imágenes en alta resolución + manifiesto JSON. Ideal para archivar.</div>
          </div>
        </button>
      </div>
      <div style="font-size:11px;color:var(--gris-texto);margin-top:14px;font-style:italic">
        💡 La descarga puede tardar unos segundos según el tamaño del catálogo. No cierres la ventana hasta que termine.
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function descargarCatalogoPDF(catalogId, botonEl) {
  await iniciarDescargaCatalogo(catalogId, 'pdf', botonEl);
}

async function descargarCatalogoZIP(catalogId, botonEl) {
  await iniciarDescargaCatalogo(catalogId, 'zip', botonEl);
}

// Helper que dispara la descarga real con manejo de loading y errores
async function iniciarDescargaCatalogo(catalogId, formato, botonEl) {
  const url = '/api/catalogs/' + catalogId + '/download-' + formato;
  // Marcar botón como "descargando"
  if (botonEl) {
    botonEl.disabled = true;
    botonEl.style.opacity = '0.6';
    const $titulo = botonEl.querySelector('.descargar-opcion-titulo');
    if ($titulo) $titulo.textContent = (formato === 'pdf' ? 'PDF' : 'ZIP con originales') + ' — preparando…';
  }

  try {
    // Hacer petición con auth (porque api() pone el token automáticamente)
    // Usamos fetch directo para poder manejar el blob
    const token = localStorage.getItem('cpv2_token');
    const resp = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) {
      let errorMsg = 'Error ' + resp.status;
      try {
        const j = await resp.json();
        if (j.error) errorMsg = j.error;
      } catch (_) {}
      throw new Error(errorMsg);
    }
    const blob = await resp.blob();
    // Obtener nombre del fichero del header Content-Disposition
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : ('catalogo.' + formato);
    // Disparar descarga
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    // Cerrar modal
    const modal = botonEl ? botonEl.closest('.modal-bg') : null;
    if (modal) modal.remove();
  } catch (err) {
    alert('Error en la descarga: ' + err.message);
    if (botonEl) {
      botonEl.disabled = false;
      botonEl.style.opacity = '1';
      const $titulo = botonEl.querySelector('.descargar-opcion-titulo');
      if ($titulo) $titulo.textContent = formato === 'pdf' ? 'PDF' : 'ZIP con originales';
    }
  }
}

// ============================================================================
// ===== H - MAPA CON RUTA OPTIMIZADA =====
// ============================================================================

let _mapaState = {
  modo: 'todos',           // 'todos' | 'pendientes' | 'cerca'
  clientes: [],            // clientes cargados
  seleccionados: new Set(),// IDs seleccionados para construir ruta
  mapa: null,              // instancia Leaflet
  marcadores: {},          // id -> marker
  rutaLinea: null,         // polyline de ruta
  miUbicacion: null        // {lat, lng} si el usuario activo "Cerca de aquí"
};

const COLORES_PIN = {
  urgente:       '#dc2626',
  proxima:       '#d97706',
  al_dia:        '#16a34a',
  sin_historial: '#6b7280'
};

async function renderMapa() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `
    <div class="contenedor contenedor-mapa">
      <div class="titulo-pagina">
        <div>
          <h2>🗺️ Mapa de clientes</h2>
          <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
            Selecciona clientes para construir una ruta optimizada
          </div>
        </div>
      </div>

      <div class="mapa-toolbar">
        <div class="mapa-chips-modo">
          <button class="planning-chip ${_mapaState.modo === 'todos' ? 'planning-chip-activo' : ''}" onclick="cambiarModoMapa('todos')">🌍 Todos</button>
          <button class="planning-chip ${_mapaState.modo === 'pendientes' ? 'planning-chip-activo' : ''}" onclick="cambiarModoMapa('pendientes')">⏰ Pendientes</button>
          <button class="planning-chip ${_mapaState.modo === 'cerca' ? 'planning-chip-activo' : ''}" onclick="cambiarModoMapa('cerca')">📍 Cerca de aquí</button>
        </div>
        <div class="mapa-info" id="mapa-info">Cargando…</div>
      </div>

      <div class="mapa-layout">
        <div id="mapa-leaflet" class="mapa-leaflet"></div>
        <div class="mapa-lateral">
          <h4>Seleccionados (<span id="mapa-seleccion-count">0</span>)</h4>
          <div id="mapa-seleccionados-lista" class="mapa-seleccionados-lista">
            <p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">
              Pulsa los pines en el mapa para añadir clientes a tu ruta.
            </p>
          </div>
          <div class="mapa-acciones">
            <button class="btn btn-secondary btn-pequeno" onclick="limpiarSeleccionMapa()" id="btn-limpiar-seleccion" disabled>🧹 Limpiar</button>
            <button class="btn btn-primary btn-pequeno" onclick="construirRutaMapa()" id="btn-ruta" disabled>🛣️ Ruta óptima</button>
          </div>
          <div id="mapa-ruta-info" class="mapa-ruta-info"></div>
        </div>
      </div>
    </div>
  `;

  // Esperar a que Leaflet esté cargado (el script tiene defer)
  let intentos = 0;
  while (typeof L === 'undefined' && intentos < 40) {
    await new Promise(r => setTimeout(r, 100));
    intentos++;
  }
  if (typeof L === 'undefined') {
    document.getElementById('mapa-leaflet').innerHTML = '<div class="error-msg">No se pudo cargar Leaflet. Revisa tu conexión a internet.</div>';
    return;
  }

  // Crear mapa centrado en España (zoom amplio)
  _mapaState.mapa = L.map('mapa-leaflet', { zoomControl: true }).setView([42.5, -2.5], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(_mapaState.mapa);

  // Cargar clientes
  await recargarClientesMapa();
}

async function cambiarModoMapa(modo) {
  _mapaState.modo = modo;
  // Resaltar el chip activo
  document.querySelectorAll('.mapa-chips-modo .planning-chip').forEach(el => {
    el.classList.remove('planning-chip-activo');
  });
  event && event.target && event.target.classList.add('planning-chip-activo');

  if (modo === 'cerca') {
    // Pedir geolocalización
    if (!navigator.geolocation) {
      alert('Tu navegador no soporta geolocalización.');
      return;
    }
    const $info = document.getElementById('mapa-info');
    if ($info) $info.textContent = 'Obteniendo tu ubicación…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        _mapaState.miUbicacion = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        _mapaState.mapa.setView([pos.coords.latitude, pos.coords.longitude], 12);
        // Marcador de "yo" (azul)
        L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
          radius: 8, fillColor: '#3b82f6', color: 'white', weight: 3, fillOpacity: 1
        }).addTo(_mapaState.mapa).bindPopup('📍 Tu ubicación actual').openPopup();
        recargarClientesMapa();
      },
      (err) => {
        alert('No se pudo obtener tu ubicación: ' + err.message);
        _mapaState.modo = 'todos';
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  } else {
    recargarClientesMapa();
  }
}

async function recargarClientesMapa() {
  const $info = document.getElementById('mapa-info');
  if ($info) $info.textContent = 'Cargando clientes…';
  try {
    // Limpiar marcadores anteriores
    Object.values(_mapaState.marcadores).forEach(m => _mapaState.mapa.removeLayer(m));
    _mapaState.marcadores = {};
    if (_mapaState.rutaLinea) {
      _mapaState.mapa.removeLayer(_mapaState.rutaLinea);
      _mapaState.rutaLinea = null;
    }

    // Construir URL con params
    const params = new URLSearchParams();
    if (_mapaState.modo === 'pendientes') {
      params.set('modo', 'pendientes');
    } else if (_mapaState.modo === 'cerca' && _mapaState.miUbicacion) {
      // Bbox aprox: ±0.3° (~33km) alrededor de mi ubicación
      const lat = _mapaState.miUbicacion.lat;
      const lng = _mapaState.miUbicacion.lng;
      params.set('bbox', `${lat-0.3},${lng-0.3},${lat+0.3},${lng+0.3}`);
    }
    const r = await api('/api/map/clients?' + params.toString());
    _mapaState.clientes = r.clientes || [];

    if (_mapaState.clientes.length === 0) {
      if ($info) $info.textContent = '0 clientes geolocalizados. ¿Has lanzado el proceso de geocoding en ⚙️ Configuración?';
      return;
    }

    // Pintar marcadores
    const grupo = L.featureGroup();
    _mapaState.clientes.forEach(c => {
      const color = COLORES_PIN[c.estado] || COLORES_PIN.sin_historial;
      const isSel = _mapaState.seleccionados.has(c.id);
      const marker = L.circleMarker([c.latitude, c.longitude], {
        radius: isSel ? 11 : 8,
        fillColor: color,
        color: isSel ? '#000' : 'white',
        weight: isSel ? 3 : 2,
        fillOpacity: 0.9
      });
      marker.bindPopup(`
        <div style="min-width:200px">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">${escapeHtml(c.razon_social)}</div>
          <div style="font-size:12px;color:#666">${escapeHtml(c.sage_code || '?')} · ${escapeHtml(c.municipio || '')}</div>
          <div style="font-size:11px;margin-top:4px;color:${color};font-weight:500">
            ${c.estado === 'urgente' ? '🔴 Urgente' : c.estado === 'proxima' ? '🟡 Próxima' : c.estado === 'al_dia' ? '🟢 Al día' : '⚪ Sin historial'}
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="leaflet-popup-btn" onclick="toggleSeleccionMapa(${c.id})">${isSel ? '✓ Quitar' : '+ Añadir a ruta'}</button>
            <button class="leaflet-popup-btn leaflet-popup-btn-primary" onclick="iniciarVisitaParaCliente(${c.id})">🛒 Visita</button>
            <button class="leaflet-popup-btn" onclick="abrirDetalleCliente(${c.id})">Ficha →</button>
          </div>
        </div>
      `);
      marker.addTo(_mapaState.mapa);
      grupo.addLayer(marker);
      _mapaState.marcadores[c.id] = marker;
    });

    // Ajustar vista al conjunto si no estamos en "cerca de aquí"
    if (_mapaState.modo !== 'cerca' && _mapaState.clientes.length > 0) {
      try {
        _mapaState.mapa.fitBounds(grupo.getBounds(), { padding: [30, 30], maxZoom: 12 });
      } catch (_) {}
    }

    if ($info) $info.textContent = `${_mapaState.clientes.length} clientes en mapa`;
    actualizarPanelSeleccionados();
  } catch (err) {
    if ($info) $info.textContent = 'Error: ' + err.message;
  }
}

// Función global para escapar HTML en popups de Leaflet
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function toggleSeleccionMapa(clientId) {
  if (_mapaState.seleccionados.has(clientId)) {
    _mapaState.seleccionados.delete(clientId);
  } else {
    _mapaState.seleccionados.add(clientId);
  }
  // Recargar para actualizar visualmente el pin
  recargarClientesMapa();
}

function limpiarSeleccionMapa() {
  _mapaState.seleccionados.clear();
  if (_mapaState.rutaLinea) {
    _mapaState.mapa.removeLayer(_mapaState.rutaLinea);
    _mapaState.rutaLinea = null;
  }
  recargarClientesMapa();
}

function actualizarPanelSeleccionados() {
  const $count = document.getElementById('mapa-seleccion-count');
  const $lista = document.getElementById('mapa-seleccionados-lista');
  const $btnRuta = document.getElementById('btn-ruta');
  const $btnLimpiar = document.getElementById('btn-limpiar-seleccion');
  if (!$count || !$lista) return;

  $count.textContent = _mapaState.seleccionados.size;
  $btnLimpiar.disabled = _mapaState.seleccionados.size === 0;
  $btnRuta.disabled = _mapaState.seleccionados.size < 2;

  if (_mapaState.seleccionados.size === 0) {
    $lista.innerHTML = `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">Pulsa los pines en el mapa para añadir clientes a tu ruta.</p>`;
    return;
  }

  const seleccionados = _mapaState.clientes.filter(c => _mapaState.seleccionados.has(c.id));
  $lista.innerHTML = seleccionados.map((c, idx) => {
    const color = COLORES_PIN[c.estado] || COLORES_PIN.sin_historial;
    return `
      <div class="mapa-sel-fila">
        <div class="mapa-sel-num" style="background:${color}">${idx + 1}</div>
        <div class="mapa-sel-info">
          <div class="mapa-sel-nombre">${escape(c.razon_social)}</div>
          <div class="mapa-sel-meta">${escape(c.sage_code || '?')} · ${escape(c.municipio || '')}</div>
        </div>
        <button class="mapa-sel-quitar" onclick="toggleSeleccionMapa(${c.id})" title="Quitar">×</button>
      </div>
    `;
  }).join('');
}

// Algoritmo "vecino más cercano" para ordenar la ruta
// Si tenemos punto de origen (miUbicacion), empezamos desde ahí.
// Si no, empezamos por el primer cliente seleccionado.
function calcularRutaOptima(puntos, origen) {
  if (puntos.length === 0) return [];
  if (puntos.length === 1) return [puntos[0]];

  const restantes = [...puntos];
  const ruta = [];
  let actual = origen;

  if (!actual) {
    // Si no hay origen, empezar por el primero
    actual = restantes.shift();
    ruta.push(actual);
  }

  while (restantes.length > 0) {
    // Encontrar el más cercano a `actual`
    let mejorIdx = 0;
    let mejorDist = distanciaHaversine(actual.lat || actual.latitude, actual.lng || actual.longitude, restantes[0].latitude, restantes[0].longitude);
    for (let i = 1; i < restantes.length; i++) {
      const d = distanciaHaversine(actual.lat || actual.latitude, actual.lng || actual.longitude, restantes[i].latitude, restantes[i].longitude);
      if (d < mejorDist) {
        mejorDist = d;
        mejorIdx = i;
      }
    }
    const siguiente = restantes.splice(mejorIdx, 1)[0];
    ruta.push(siguiente);
    actual = siguiente;
  }
  return ruta;
}

// Distancia haversine entre dos puntos lat/lng en km
function distanciaHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function construirRutaMapa() {
  const seleccionados = _mapaState.clientes.filter(c => _mapaState.seleccionados.has(c.id));
  if (seleccionados.length < 2) {
    alert('Selecciona al menos 2 clientes para construir una ruta.');
    return;
  }
  // Origen: mi ubicación si está disponible, sino el primero
  const origen = _mapaState.miUbicacion ? { lat: _mapaState.miUbicacion.lat, lng: _mapaState.miUbicacion.lng } : null;
  const ruta = calcularRutaOptima(seleccionados, origen);

  // Actualizar orden en seleccionados según ruta (para mostrar numerado)
  _mapaState.clientes = _mapaState.clientes.map(c => {
    const idx = ruta.findIndex(r => r.id === c.id);
    if (idx >= 0) return { ...c, _ordenRuta: idx + 1 };
    return c;
  });

  // Calcular distancia total
  let distTotal = 0;
  let puntos = [];
  if (origen) {
    puntos.push([origen.lat, origen.lng]);
    distTotal += distanciaHaversine(origen.lat, origen.lng, ruta[0].latitude, ruta[0].longitude);
  }
  ruta.forEach((c, i) => {
    puntos.push([c.latitude, c.longitude]);
    if (i > 0) {
      distTotal += distanciaHaversine(ruta[i-1].latitude, ruta[i-1].longitude, c.latitude, c.longitude);
    }
  });

  // Limpiar ruta anterior
  if (_mapaState.rutaLinea) {
    _mapaState.mapa.removeLayer(_mapaState.rutaLinea);
  }

  // Dibujar polyline
  _mapaState.rutaLinea = L.polyline(puntos, {
    color: '#cc007a',
    weight: 4,
    opacity: 0.7,
    dashArray: '10, 8'
  }).addTo(_mapaState.mapa);

  // Ajustar vista a la ruta
  _mapaState.mapa.fitBounds(_mapaState.rutaLinea.getBounds(), { padding: [40, 40] });

  // Actualizar panel lateral con orden
  const $lista = document.getElementById('mapa-seleccionados-lista');
  if ($lista) {
    $lista.innerHTML = ruta.map((c, idx) => {
      const color = COLORES_PIN[c.estado] || COLORES_PIN.sin_historial;
      return `
        <div class="mapa-sel-fila">
          <div class="mapa-sel-num" style="background:${color}">${idx + 1}</div>
          <div class="mapa-sel-info">
            <div class="mapa-sel-nombre">${escape(c.razon_social)}</div>
            <div class="mapa-sel-meta">${escape(c.sage_code || '?')} · ${escape(c.municipio || '')}</div>
          </div>
          <button class="mapa-sel-quitar" onclick="toggleSeleccionMapa(${c.id})" title="Quitar">×</button>
        </div>
      `;
    }).join('');
  }

  // Info ruta
  const $info = document.getElementById('mapa-ruta-info');
  if ($info) {
    $info.innerHTML = `
      <div class="mapa-ruta-resumen">
        🛣️ <b>Ruta óptima en línea recta</b><br>
        ${ruta.length} paradas · ${distTotal.toFixed(1)} km totales (a vuelo de pájaro)
        ${origen ? '<br><span style="color:#3b82f6">📍 Desde tu ubicación actual</span>' : ''}
        <div style="font-size:11px;color:var(--gris-texto);margin-top:6px;font-style:italic">
          La distancia real por carretera será mayor (curvas, peajes, etc.)
        </div>
      </div>
    `;
  }
}

// ============================================================================
// ===== G - PLANNING / RUTERO DE VISITAS =====
// ============================================================================

let _planningState = {
  estado: 'todos',
  q: '',
  provincia: '',
  municipio: '',
  comercial: '',
  loading: false,
  clientes: [],
  total: 0,
  config: null,
  filtrosCache: null   // {provincias:[], municipios:[], comerciales:[]}
};

const ESTADOS_PLANNING = {
  urgente:       { color: '#dc2626', bg: '#fef2f2', emoji: '🔴', label: 'Urgente' },
  proxima:       { color: '#d97706', bg: '#fffbeb', emoji: '🟡', label: 'Próxima' },
  al_dia:        { color: '#16a34a', bg: '#f0fdf4', emoji: '🟢', label: 'Al día' },
  sin_historial: { color: '#6b7280', bg: '#f9fafb', emoji: '⚪', label: 'Sin historial' }
};

// G: carga estados planning en background y rellena los chips ⏳ de la lista de clientes
async function cargarEstadosClientesEnFondo(ids) {
  if (!ids || ids.length === 0) return;
  try {
    const r = await api('/api/clients/states-batch', { method: 'POST', body: { ids } });
    const states = r.states || {};
    Object.keys(states).forEach(id => {
      const $el = document.getElementById('estado-cli-' + id);
      if ($el) {
        const e = ESTADOS_PLANNING[states[id].estado] || ESTADOS_PLANNING.sin_historial;
        $el.textContent = e.emoji;
        $el.title = e.label + (states[id].dias !== null ? ' · ' + states[id].dias + 'd desde última visita · ciclo ' + states[id].ciclo + 'd' : ' · sin visitas');
        $el.style.background = e.bg;
        $el.style.color = e.color;
      }
    });
  } catch (_) {
    // si falla silenciosamente, los chips se quedan en ⏳
  }
}

async function renderPlanning() {
  const $v = document.getElementById('vista-contenido');
  // Pintar shell con filtros (si no se cargaron filtros, cargarlos)
  // I-Planning: si offline, generar filtros desde clientes en IndexedDB
  if (!navigator.onLine) {
    if (!_planningState.filtrosCache || !_planningState.filtrosCache._fromOffline) {
      try {
        const todos = await CpDB.listarClientes('');
        const provincias = [...new Set(todos.map(c => c.provincia).filter(Boolean))].sort();
        const municipios = [...new Set(todos.map(c => c.municipio).filter(Boolean))].sort();
        _planningState.filtrosCache = { provincias, municipios, comerciales: [], _fromOffline: true };
      } catch (_) {
        _planningState.filtrosCache = { provincias: [], municipios: [], comerciales: [], _fromOffline: true };
      }
    }
  } else if (!_planningState.filtrosCache || _planningState.filtrosCache._fromOffline) {
    // Si veníamos del offline o no hay cache, recargar online
    try {
      const r = await api('/api/planning/filtros');
      _planningState.filtrosCache = r;
    } catch (_) {
      _planningState.filtrosCache = { provincias: [], municipios: [], comerciales: [] };
    }
  }
  pintarPlanning();
  // Cargar lista
  await recargarPlanning();
}

function pintarPlanning() {
  const $v = document.getElementById('vista-contenido');
  const f = _planningState.filtrosCache || { provincias: [], municipios: [], comerciales: [] };
  const s = _planningState;
  const esAdmin = rolEfectivo() === 'admin';

  // Botones de estado (chips)
  const estadosChips = ['todos','urgente','proxima','al_dia','sin_historial'].map(e => {
    const label = e === 'todos' ? 'Todos' : (ESTADOS_PLANNING[e].emoji + ' ' + ESTADOS_PLANNING[e].label);
    const activo = s.estado === e;
    return `<button class="planning-chip ${activo ? 'planning-chip-activo' : ''}" onclick="cambiarFiltroPlanning('estado','${e}')">${label}</button>`;
  }).join('');

  $v.innerHTML = `
    <div class="contenedor">
      <div class="titulo-pagina">
        <div>
          <h2>🗓️ Planning de visitas</h2>
          <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
            Clientes ordenados por urgencia. Pulsa una fila para abrir su ficha.
          </div>
        </div>
      </div>

      <!-- Filtros -->
      <div class="planning-filtros">
        <div class="planning-chips-row">${estadosChips}</div>
        <div class="planning-inputs-row">
          <input type="text" id="planning-q" class="planning-input" placeholder="🔍 Buscar por nombre o código Sage…" value="${escape(s.q)}">
          <select id="planning-provincia" class="planning-input">
            <option value="">📍 Todas las provincias</option>
            ${f.provincias.map(p => `<option value="${escape(p)}" ${p === s.provincia ? 'selected' : ''}>${escape(p)}</option>`).join('')}
          </select>
          <select id="planning-municipio" class="planning-input">
            <option value="">🏘️ Todos los municipios</option>
            ${f.municipios.map(m => `<option value="${escape(m)}" ${m === s.municipio ? 'selected' : ''}>${escape(m)}</option>`).join('')}
          </select>
          ${esAdmin && f.comerciales && f.comerciales.length > 0 ? `
            <select id="planning-comercial" class="planning-input">
              <option value="">👤 Todos los comerciales</option>
              ${f.comerciales.map(c => `<option value="${escape(c)}" ${c === s.comercial ? 'selected' : ''}>${escape(c)}</option>`).join('')}
            </select>
          ` : ''}
        </div>
      </div>

      <!-- Resultado -->
      <div id="planning-resultado">
        ${s.loading ? '<div class="loading">Cargando…</div>' : ''}
      </div>
    </div>
  `;

  // Listeners (debounce en búsqueda)
  const $q = document.getElementById('planning-q');
  if ($q) {
    let t;
    $q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        _planningState.q = $q.value.trim();
        recargarPlanning();
      }, 350);
    });
  }
  const $prov = document.getElementById('planning-provincia');
  if ($prov) $prov.addEventListener('change', () => { _planningState.provincia = $prov.value; recargarPlanning(); });
  const $muni = document.getElementById('planning-municipio');
  if ($muni) $muni.addEventListener('change', () => { _planningState.municipio = $muni.value; recargarPlanning(); });
  const $com = document.getElementById('planning-comercial');
  if ($com) $com.addEventListener('change', () => { _planningState.comercial = $com.value; recargarPlanning(); });
}

function cambiarFiltroPlanning(campo, valor) {
  _planningState[campo] = valor;
  pintarPlanning(); // re-pinta los chips marcando el activo
  recargarPlanning();
}

async function recargarPlanning() {
  const s = _planningState;
  const $res = document.getElementById('planning-resultado');
  if ($res) $res.innerHTML = '<div class="loading">Cargando…</div>';

  // I-Planning: si offline, calcular en local desde IndexedDB
  if (!navigator.onLine) {
    await recargarPlanningOffline();
    return;
  }

  try {
    const params = new URLSearchParams();
    if (s.estado && s.estado !== 'todos') params.set('estado', s.estado);
    if (s.q) params.set('q', s.q.toLowerCase());
    if (s.provincia) params.set('provincia', s.provincia);
    if (s.municipio) params.set('municipio', s.municipio);
    if (s.comercial) params.set('comercial', s.comercial);
    params.set('limit', '200');
    const r = await api('/api/planning?' + params.toString());
    _planningState.clientes = r.clientes || [];
    _planningState.total = r.total || 0;
    _planningState.config = r.config || null;
    _planningState.modoOffline = false;
    pintarPlanningResultado();
  } catch (err) {
    // Si la API falla pero navegador dice online, fallback IndexedDB
    console.warn('[Planning] API falló, usando IndexedDB:', err.message);
    await recargarPlanningOffline();
  }
}

// I-Planning: cargar planning desde IndexedDB calculando estados localmente
async function recargarPlanningOffline() {
  const s = _planningState;
  const $res = document.getElementById('planning-resultado');
  try {
    // Cargar todos los clientes descargados
    const todos = await CpDB.listarClientes('');
    if (todos.length === 0) {
      if ($res) $res.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icono">📲</div>
          <h3>Sin clientes descargados</h3>
          <p>Vuelve a conectarte y usa el botón "👥 Descargar clientes" en la pestaña Catálogos.</p>
        </div>
      `;
      return;
    }

    // Cargar visitas offline pendientes para considerarlas en el cálculo
    const visitasOfflineMapa = await obtenerVisitasOfflinePorCliente();

    // Calcular estado de cada cliente
    const conEstados = [];
    for (const c of todos) {
      const calc = await calcularEstadoClienteOffline(c, visitasOfflineMapa);
      // Calcular fecha última (la mayor entre backend y offline)
      let fechaUlt = c.ultima_visita_at ? new Date(c.ultima_visita_at) : null;
      const visitasLoc = visitasOfflineMapa[c.id];
      if (visitasLoc) {
        visitasLoc.forEach(v => {
          const f = new Date(v.confirmed_at || v.created_at);
          if (!fechaUlt || f > fechaUlt) fechaUlt = f;
        });
      }
      conEstados.push({
        ...c,
        estado: calc.estado,
        dias_desde_ultima: calc.dias_desde_ultima,
        dias_retraso: calc.dias_retraso,
        ciclo_efectivo: calc.ciclo_efectivo,
        fecha_ultima: fechaUlt ? fechaUlt.toISOString() : null
      });
    }

    // Aplicar filtros locales
    let filtrados = conEstados;
    if (s.estado && s.estado !== 'todos') {
      filtrados = filtrados.filter(c => c.estado === s.estado);
    }
    if (s.q) {
      const q = s.q.toLowerCase();
      filtrados = filtrados.filter(c =>
        (c.razon_social || '').toLowerCase().includes(q) ||
        (c.sage_code || '').toLowerCase().includes(q)
      );
    }
    if (s.provincia) {
      filtrados = filtrados.filter(c => c.provincia === s.provincia);
    }
    if (s.municipio) {
      filtrados = filtrados.filter(c => c.municipio === s.municipio);
    }
    // El filtro "comercial" lo ignoramos en offline (el comercial ya solo descargó sus clientes)

    // Ordenar por urgencia: primero urgentes (mayor retraso), luego próximas, al día, sin historial
    const ordenEstado = { urgente: 0, proxima: 1, al_dia: 2, sin_historial: 3 };
    filtrados.sort((a, b) => {
      const oA = ordenEstado[a.estado] ?? 99;
      const oB = ordenEstado[b.estado] ?? 99;
      if (oA !== oB) return oA - oB;
      // Mismo estado: ordenar por días de retraso descendente (más urgente primero)
      return (b.dias_retraso || 0) - (a.dias_retraso || 0);
    });

    _planningState.clientes = filtrados.slice(0, 200); // límite igual al backend
    _planningState.total = filtrados.length;
    _planningState.modoOffline = true;
    pintarPlanningResultado();
  } catch (err) {
    if ($res) $res.innerHTML = `<div class="error-msg">Error offline: ${escape(err.message)}</div>`;
  }
}

function pintarPlanningResultado() {
  const $res = document.getElementById('planning-resultado');
  if (!$res) return;
  const clientes = _planningState.clientes;
  const total = _planningState.total;
  if (clientes.length === 0) {
    $res.innerHTML = '<p style="text-align:center;color:var(--gris-texto);padding:2rem">No hay clientes que coincidan con los filtros.</p>';
    return;
  }
  const conteo = {urgente:0, proxima:0, al_dia:0, sin_historial:0};
  clientes.forEach(c => { conteo[c.estado] = (conteo[c.estado]||0) + 1; });

  // Resumen arriba
  const resumen = `
    ${_planningState.modoOffline ? `
      <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#78350f">
        📲 <b>Planning offline:</b> calculado con los clientes y visitas descargados en este dispositivo. Algunas visitas online recientes pueden no estar reflejadas.
      </div>
    ` : ''}
    <div class="planning-resumen">
      <span>${clientes.length}${total > clientes.length ? '/' + total : ''} clientes</span>
      ${conteo.urgente > 0 ? `<span class="planning-resumen-chip" style="background:${ESTADOS_PLANNING.urgente.bg};color:${ESTADOS_PLANNING.urgente.color}">${ESTADOS_PLANNING.urgente.emoji} ${conteo.urgente} urgentes</span>` : ''}
      ${conteo.proxima > 0 ? `<span class="planning-resumen-chip" style="background:${ESTADOS_PLANNING.proxima.bg};color:${ESTADOS_PLANNING.proxima.color}">${ESTADOS_PLANNING.proxima.emoji} ${conteo.proxima} próximas</span>` : ''}
      ${conteo.al_dia > 0 ? `<span class="planning-resumen-chip" style="background:${ESTADOS_PLANNING.al_dia.bg};color:${ESTADOS_PLANNING.al_dia.color}">${ESTADOS_PLANNING.al_dia.emoji} ${conteo.al_dia} al día</span>` : ''}
      ${conteo.sin_historial > 0 ? `<span class="planning-resumen-chip" style="background:${ESTADOS_PLANNING.sin_historial.bg};color:${ESTADOS_PLANNING.sin_historial.color}">${ESTADOS_PLANNING.sin_historial.emoji} ${conteo.sin_historial} sin historial</span>` : ''}
    </div>
  `;

  const filas = clientes.map(c => {
    const e = ESTADOS_PLANNING[c.estado] || ESTADOS_PLANNING.sin_historial;
    let infoTiempo;
    if (c.estado === 'sin_historial') {
      infoTiempo = 'Sin visitas previas';
    } else if (c.dias_retraso > 0) {
      infoTiempo = `Retraso ${c.dias_retraso}d · ciclo ${c.ciclo_efectivo}d`;
    } else {
      const dias = c.dias_desde_ultima;
      infoTiempo = `Hace ${dias}d · ciclo ${c.ciclo_efectivo}d`;
    }
    const fechaUlt = c.fecha_ultima ? new Date(c.fecha_ultima).toLocaleDateString('es-ES') : '—';
    return `
      <div class="planning-fila" onclick="abrirDetalleCliente(${c.id})" style="border-left-color:${e.color}">
        <div class="planning-chip-estado" style="background:${e.bg};color:${e.color}" title="${e.label}">${e.emoji}</div>
        <div class="planning-fila-info">
          <div class="planning-fila-nombre">${escape(c.razon_social)}</div>
          <div class="planning-fila-meta">
            <span><b>${escape(c.sage_code || '?')}</b></span>
            ${c.municipio ? `<span>· ${escape(c.municipio)}</span>` : ''}
            ${c.provincia && c.provincia !== c.municipio ? `<span>· ${escape(c.provincia)}</span>` : ''}
            ${c.commercial_code ? `<span>· Com.${escape(c.commercial_code)}</span>` : ''}
            ${c.categoria ? `<span>· cat.${escape(c.categoria)}</span>` : ''}
          </div>
          <div class="planning-fila-tiempo">
            🕐 Última visita: <b>${escape(fechaUlt)}</b> · ${escape(infoTiempo)}
          </div>
        </div>
        ${(esAdminReal() && !impersonating) ? '' : `<button class="btn btn-primary btn-pequeno planning-btn-visita" onclick="event.stopPropagation();iniciarVisitaParaCliente(${c.id})" title="Empezar visita">🛒</button>`}
      </div>
    `;
  }).join('');

  $res.innerHTML = `${resumen}<div class="planning-lista">${filas}</div>`;
}

// G: editar ciclo individual de un cliente (prompt simple)
async function editarCicloCliente(clientId, cicloActual) {
  const txt = prompt(
    'Ciclo de visita en días para este cliente.\n\n' +
    '• Deja vacío para usar el ciclo global por defecto.\n' +
    '• Mínimo 1, máximo 730 días.\n\n' +
    'Ciclo actual: ' + (cicloActual === null || cicloActual === 'null' ? 'por defecto (global)' : cicloActual + ' días'),
    cicloActual === null || cicloActual === 'null' ? '' : String(cicloActual)
  );
  if (txt === null) return; // canceló
  const valor = txt.trim() === '' ? null : Number(txt.trim());
  if (valor !== null && (!Number.isFinite(valor) || valor < 1 || valor > 730)) {
    alert('Valor inválido. Debe ser un número entre 1 y 730, o vacío para usar el global.');
    return;
  }
  try {
    await api('/api/clients/' + clientId + '/ciclo', { method: 'PUT', body: { ciclo_visita_dias: valor } });
    renderDetalleCliente(clientId);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ============================================================================
// ===== B6 - VISITAS Y ANOTACIONES =====
// ============================================================================

// F: Helper reutilizable que pinta el "resumen de última visita".
// Se usa en 3 sitios: ficha cliente, modal iniciar visita, modal del visor.
// modo: 'ficha' | 'modal' | 'visor' - solo cambia un poco el estilo de cabecera
function renderPanelUltimaVisita(data, modo) {
  if (!data || !data.visit) return '';
  const v = data.visit;
  const anots = data.annotations || [];
  const fecha = v.confirmed_at
    ? new Date(v.confirmed_at).toLocaleString('es-ES')
    : new Date(v.created_at).toLocaleString('es-ES');

  // Calcular dias desde la visita para chip visual
  const fechaVisita = v.confirmed_at ? new Date(v.confirmed_at) : new Date(v.created_at);
  const ahora = new Date();
  const diasAtras = Math.floor((ahora - fechaVisita) / (1000 * 60 * 60 * 24));
  const chipDias = diasAtras === 0 ? 'hoy'
    : diasAtras === 1 ? 'ayer'
    : diasAtras < 30 ? `hace ${diasAtras} días`
    : diasAtras < 60 ? `hace 1 mes`
    : diasAtras < 365 ? `hace ${Math.floor(diasAtras/30)} meses`
    : `hace ${Math.floor(diasAtras/365)} año${Math.floor(diasAtras/365) === 1 ? '' : 's'}`;

  const peds = anots.filter(a => a.tipo === 'pedido');
  const devs = anots.filter(a => a.tipo === 'devolucion');
  const nots = anots.filter(a => a.tipo === 'nota');

  const pintarLista = (items, color, titulo, icono) => {
    if (items.length === 0) return '';
    return `
      <div class="uv-grupo">
        <div class="uv-grupo-titulo" style="color:${color}">${icono} ${titulo} (${items.length})</div>
        <ul class="uv-grupo-lista">
          ${items.map(a => `
            <li>
              <b>${a.sheet_orden ? 'Lám.' + a.sheet_orden : '—'}${a.sheet_titulo ? ' · ' + escape(a.sheet_titulo) : ''}</b>
              <span class="uv-grupo-texto">${escape(a.texto_libre)}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  };

  // Cabecera distinta según modo
  let cabecera;
  if (modo === 'visor') {
    // Modal abierto por el comercial desde el visor: cabecera neutra, sin avisos rojos
    // que puedan generar desconfianza si el cliente ve la pantalla por accidente
    cabecera = `
      <div class="uv-cabecera-modal">
        <div class="uv-titulo">🕐 Última visita con este cliente</div>
        <div style="font-size:12px;color:var(--gris-texto)">${escape(fecha)} · <b>${escape(chipDias)}</b></div>
      </div>
    `;
  } else if (modo === 'modal') {
    cabecera = `
      <div class="uv-cabecera-modal">
        <div class="uv-titulo">🕐 Última visita con este cliente</div>
        <div style="font-size:12px;color:var(--gris-texto)">${escape(fecha)} · <b>${escape(chipDias)}</b></div>
      </div>
    `;
  } else {
    cabecera = `
      <div class="uv-cabecera">
        <div>
          <div class="uv-titulo">🕐 Última visita</div>
          <div style="font-size:12px;color:var(--gris-texto)">${escape(fecha)} · <b>${escape(chipDias)}</b> · ${escape(v.comercial_nombre || '?')} · ${escape(v.catalog_nombre || '—')}</div>
        </div>
        <button class="btn btn-secondary btn-pequeno" onclick="abrirDetalleVisita(${v.id})">Ver visita completa →</button>
      </div>
    `;
  }

  return `
    <div class="ultima-visita-panel">
      ${cabecera}
      ${anots.length === 0
        ? `<div style="color:var(--gris-texto);font-size:13px;padding:8px 0;font-style:italic">Esta visita no tuvo anotaciones registradas.</div>`
        : `
          ${pintarLista(peds, '#166534', 'Pedidos', '🛒')}
          ${pintarLista(devs, '#92400e', 'Devoluciones', '↩️')}
          ${pintarLista(nots, '#374151', 'Notas', '📝')}
        `
      }
      ${v.notas_generales ? `
        <div class="uv-notas-generales">
          <div class="uv-grupo-titulo" style="color:#374151">💬 Notas generales</div>
          <div style="font-size:13px;white-space:pre-wrap;color:#444">${escape(v.notas_generales)}</div>
        </div>
      ` : ''}
    </div>
  `;
}

async function cargarResumenUltimaVisita(clientId) {
  try {
    const r = await api('/api/clients/' + clientId + '/last-visit-summary');
    if (r.visit) return { visit: r.visit, annotations: r.annotations || [] };
  } catch (_) {}
  return null;
}

// F: Abre un modal con notas privadas de la última visita (botón 📋 del visor)
async function abrirModalUltimaVisita(clientId) {
  // Crear modal con loading
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>🕐 Última visita</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="uv-modal-contenido" class="loading">Cargando…</div>
    </div>
  `;
  document.body.appendChild(modal);
  // Cargar y pintar
  const resumen = await cargarResumenUltimaVisita(clientId);
  const $c = document.getElementById('uv-modal-contenido');
  if (!$c) return;
  if (!resumen) {
    $c.innerHTML = `
      <div style="text-align:center;padding:1rem;color:var(--gris-texto);font-size:14px">
        Este cliente no tiene visitas anteriores cerradas registradas.
      </div>
      <div class="modal-acciones">
        <button class="btn btn-primary" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
      </div>
    `;
    return;
  }
  $c.innerHTML = `
    ${renderPanelUltimaVisita(resumen, 'visor')}
    <div class="modal-acciones">
      <button class="btn btn-primary" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
    </div>
  `;
}

// ----- ABRIR DETALLE CLIENTE -----
function abrirDetalleCliente(id) {
  appState.clienteActual = id;
  appState.visitaVerId = null;
  appState.vista = 'clientes';
  render();
}

function volverAClientes() {
  appState.clienteActual = null;
  appState.visitaVerId = null;
  render();
}

// ----- RENDER DETALLE CLIENTE -----
async function renderDetalleCliente(id) {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando cliente…</div></div>`;
  try {
    const r = await api('/api/clients/' + id);
    const c = r.client;
    const visitas = r.visitas || [];

    // F: cargar resumen de última visita (en paralelo con datos cliente)
    let ultimaVisitaResumen = null;
    try {
      const rl = await api('/api/clients/' + id + '/last-visit-summary');
      if (rl.visit) ultimaVisitaResumen = { visit: rl.visit, annotations: rl.annotations || [] };
    } catch (_) {}

    // Fila auxiliar para imprimir un campo si existe
    const campo = (label, val) => val
      ? `<div class="kv-row"><div class="kv-label">${label}</div><div class="kv-val">${escape(String(val))}</div></div>`
      : '';

    // Construir HTML
    let html = `
      <div class="contenedor">
        <div class="titulo-pagina">
          <div>
            <button class="btn btn-secondary btn-pequeno" onclick="volverAClientes()">← Clientes</button>
            <h2 style="margin-top:8px">🏥 ${escape(c.razon_social)} ${!c.is_active ? '<span class="cliente-baja-badge">BAJA</span>' : ''}</h2>
            <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
              Código Sage: <b>${escape(c.sage_code || '—')}</b>
              ${c.commercial_code ? ` · Comercial asignado: ${escape(c.commercial_code)}` : ''}
              ${c.categoria ? ` · Categoría ${escape(c.categoria)}` : ''}
            </div>
          </div>
          <div style="display:flex; gap:6px; align-self:flex-start; flex-wrap:wrap; align-items:center">
            ${esAdminReal() && !impersonating
              ? `<div style="font-size:12px;color:#9ca3af;font-style:italic;max-width:260px">Como administrador no puedes hacer visitas. Usa <b>"Ver como"</b> para impersonar a un comercial, o entra con tu cuenta comercial.</div>`
              : `<button class="btn btn-primary" onclick="iniciarVisitaParaCliente(${c.id})">🛒 Empezar visita</button>${ayuda('Inicia una visita comercial al cliente. Abre el visor del catálogo para que añadas productos pulsando las zonas clicables o anotando. Al cerrar la visita, se envía un email a la oficina con el pedido y opcional al cliente.', 'izq')}`
            }
          </div>
        </div>

        ${ultimaVisitaResumen ? renderPanelUltimaVisita(ultimaVisitaResumen, 'ficha') : ''}

        <div class="cliente-detalle-grid">
          <!-- Ficha de datos -->
          <div class="editor-panel">
            <h3>Datos</h3>
            <div class="kv-tabla">
              ${campo('Razón social', c.razon_social)}
              ${campo('CIF', c.cif)}
              ${campo('Dirección', c.direccion)}
              ${campo('CP', c.cp)}
              ${campo('Municipio', c.municipio)}
              ${campo('Provincia', c.provincia)}
              ${campo('Teléfono', c.telefono)}
              ${campo('WhatsApp', c.whatsapp)}
              ${campo('Email', c.email)}
              ${campo('Email alternativo', c.email_alternativo)}
              ${campo('Nº cuenta', c.numero_cuenta)}
              <div class="kv-row">
                <div class="kv-label">Ciclo visita (días)</div>
                <div class="kv-val">
                  ${c.ciclo_visita_dias ? `<b>${c.ciclo_visita_dias}</b> días`
                    : `<span style="color:var(--gris-texto);font-style:italic">por defecto (global)</span>`}
                  <button class="btn-link" onclick="editarCicloCliente(${c.id}, ${c.ciclo_visita_dias || 'null'})">✏️ cambiar</button>
                </div>
              </div>
              ${campo('Última visita', c.ultima_visita_at ? new Date(c.ultima_visita_at).toLocaleString('es-ES') : '—')}
              ${c.notas_internas ? `<div class="kv-row"><div class="kv-label">Notas internas</div><div class="kv-val">${escape(c.notas_internas)}</div></div>` : ''}
            </div>
          </div>

          <!-- Estadísticas (se rellenan al cargar) -->
          <div id="cliente-stats-wrap"></div>

          <!-- Historial de visitas -->
          <div class="editor-panel">
            <h3>Historial de visitas (${visitas.length})</h3>
            ${visitas.length === 0
              ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">Aún no hay visitas registradas con este cliente.</p>`
              : `<div class="historial-visitas">
                  ${visitas.map(v => {
                    const fecha = new Date(v.created_at).toLocaleString('es-ES');
                    const badge = v.status === 'draft'
                      ? '<span class="visita-badge visita-badge-draft">borrador</span>'
                      : v.status === 'confirmed'
                        ? '<span class="visita-badge visita-badge-confirmed">cerrada</span>'
                        : '<span class="visita-badge">enviada</span>';
                    return `
                      <div class="visita-fila" onclick="abrirDetalleVisita(${v.id})">
                        <div class="visita-fecha">${fecha}</div>
                        <div class="visita-info">
                          <div class="visita-titulo">
                            ${badge}
                            ${v.hubo_pedido ? '<span class="visita-badge visita-badge-pedido">🛒 con pedido</span>' : '<span class="visita-badge visita-badge-sin">sin pedido</span>'}
                            <span style="font-size:11px;color:var(--gris-texto)">· ${v.num_anotaciones} anotaciones</span>
                          </div>
                          <div style="font-size:12px;color:var(--gris-texto);margin-top:2px">
                            ${escape(v.comercial_nombre || '?')} · ${escape(v.catalog_nombre || 'sin catálogo')}
                          </div>
                        </div>
                        <div class="visita-chevron">›</div>
                      </div>
                    `;
                  }).join('')}
                </div>`
            }
          </div>
        </div>
      </div>
    `;
    $v.innerHTML = html;
    // Cargar estadísticas en paralelo (no bloquea el render principal)
    cargarStatsCliente(id);
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

// ============================================================================
// Estadísticas por cliente — bloque modular en la ficha del cliente
// Cada métrica es independiente y opcional. Las "sensibles" sólo para admin.
// ============================================================================
async function cargarStatsCliente(clientId) {
  const $wrap = document.getElementById('cliente-stats-wrap');
  if (!$wrap) return;
  $wrap.innerHTML = `
    <div class="editor-panel">
      <h3>📊 Estadísticas</h3>
      <p style="font-size:13px;color:var(--gris-texto);margin:0">Cargando…</p>
    </div>
  `;
  try {
    const r = await api('/api/clients/' + clientId + '/stats');
    const s = r.stats || {};
    const esAdmin = (user?.role === 'admin');
    $wrap.innerHTML = renderBloqueStatsCliente(s, esAdmin);
  } catch (e) {
    $wrap.innerHTML = `<div class="editor-panel"><h3>📊 Estadísticas</h3><div class="error-msg">${escape(e.message)}</div></div>`;
  }
}

function renderBloqueStatsCliente(s, esAdmin) {
  const fmtEur = (n) => n != null ? Number(n).toFixed(2) + '€' : '—';
  const fmtFecha = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const diasDesde = (iso) => {
    if (!iso) return null;
    return Math.floor((new Date() - new Date(iso)) / (1000 * 60 * 60 * 24));
  };
  const diasUltima = diasDesde(s.ultima_visita);
  const diasHastaProxima = s.proxima_visita_estimada
    ? Math.floor((new Date(s.proxima_visita_estimada) - new Date()) / (1000 * 60 * 60 * 24))
    : null;

  // Color semáforo según proximidad
  let colorProxima = '#6b7280';
  if (diasHastaProxima !== null) {
    if (diasHastaProxima < 0) colorProxima = '#dc2626';
    else if (diasHastaProxima <= 7) colorProxima = '#f59e0b';
    else colorProxima = '#16a34a';
  }

  let html = `
    <div class="editor-panel">
      <h3 style="margin-top:0">📊 Estadísticas</h3>
      <div class="stats-grid">

        <div class="stat-card">
          <div class="stat-label">Total visitas</div>
          <div class="stat-valor">${s.total_visitas || 0}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Última visita</div>
          <div class="stat-valor" style="font-size:15px">${fmtFecha(s.ultima_visita)}</div>
          ${diasUltima !== null ? `<div class="stat-sub">hace ${diasUltima} días</div>` : ''}
        </div>

        <div class="stat-card">
          <div class="stat-label">Próxima visita estimada</div>
          <div class="stat-valor" style="font-size:15px;color:${colorProxima}">${fmtFecha(s.proxima_visita_estimada)}</div>
          ${diasHastaProxima !== null
            ? (diasHastaProxima < 0
                ? `<div class="stat-sub" style="color:#dc2626">vencida hace ${-diasHastaProxima} d</div>`
                : `<div class="stat-sub">en ${diasHastaProxima} d (ciclo ${s.ciclo_dias}d)</div>`)
            : ''}
        </div>

        <div class="stat-card">
          <div class="stat-label">Total pedido acumulado (PVF)</div>
          <div class="stat-valor" style="color:#16a34a">${fmtEur(s.total_pedido_acumulado)}</div>
        </div>
  `;

  // Métricas SOLO ADMIN
  if (esAdmin) {
    if (s.comercial_top) {
      html += `
        <div class="stat-card">
          <div class="stat-label">Comercial que más le visita</div>
          <div class="stat-valor" style="font-size:14px">${escape(s.comercial_top.comercial)}</div>
          <div class="stat-sub">${s.comercial_top.visitas} visitas</div>
        </div>
      `;
    }
    if (s.pct_con_pedido != null) {
      const colorPct = s.pct_con_pedido >= 70 ? '#16a34a' : s.pct_con_pedido >= 40 ? '#f59e0b' : '#dc2626';
      html += `
        <div class="stat-card">
          <div class="stat-label">% visitas con pedido</div>
          <div class="stat-valor" style="color:${colorPct}">${s.pct_con_pedido}%</div>
          <div class="stat-sub">${s.visitas_con_pedido} con · ${s.visitas_sin_pedido} sin</div>
        </div>
      `;
    }
    if (s.tendencia) {
      const t = s.tendencia;
      const colorTend = t.direccion === 'sube' ? '#16a34a' : t.direccion === 'baja' ? '#dc2626' : '#6b7280';
      const flecha = t.direccion === 'sube' ? '↗' : t.direccion === 'baja' ? '↘' : '→';
      html += `
        <div class="stat-card">
          <div class="stat-label">Tendencia último pedido</div>
          <div class="stat-valor" style="color:${colorTend}">${flecha} ${t.variacion_pct > 0 ? '+' : ''}${t.variacion_pct}%</div>
          <div class="stat-sub">${fmtEur(t.ultimo_pedido)} vs media ${fmtEur(t.media_anteriores)}</div>
        </div>
      `;
    }
  }

  html += `</div>`; // fin stats-grid

  // Top productos
  if (s.top_productos && s.top_productos.length > 0) {
    html += `
      <h4 style="margin-top:18px;margin-bottom:8px;font-size:13px;color:#374151">🏆 Top productos pedidos</h4>
      <table class="stats-top-tabla">
        <thead>
          <tr>
            <th style="text-align:left">Código</th>
            <th style="text-align:left">Producto</th>
            <th style="width:80px;text-align:right">Total uds</th>
            <th style="width:70px;text-align:right">Veces</th>
          </tr>
        </thead>
        <tbody>
          ${s.top_productos.map(p => `
            <tr>
              <td><b>${escape(p.codigo || '—')}</b></td>
              <td style="color:#374151">${escape(p.nombre || '')}</td>
              <td style="text-align:right">${p.cant_total}</td>
              <td style="text-align:right;color:#6b7280">${p.veces}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else if ((s.total_visitas || 0) > 0) {
    html += `<p style="font-size:12px;color:var(--gris-texto);margin-top:12px">Aún no hay productos registrados en visitas confirmadas.</p>`;
  }

  html += `</div>`;
  return html;
}

// ----- INICIAR VISITA DESDE FICHA DE CLIENTE -----
async function iniciarVisitaParaCliente(clientId) {
  // Admin real (sin impersonar) NO puede hacer visitas: usar "Ver como" o cuenta comercial
  if (esAdminReal() && !impersonating) {
    alert('Como administrador no puedes hacer visitas.\n\nUsa "Ver como" para impersonar a un comercial, o entra con tu cuenta comercial.');
    return;
  }
  // Si ya hay visita activa con OTRO cliente, mostrar modal informativo
  if (appState.visitaActiva && appState.visitaActiva.client_id !== clientId) {
    mostrarModalVisitaEnCurso();
    return;
  }
  if (appState.visitaActiva && appState.visitaActiva.client_id === clientId) {
    alert('Ya tienes una visita en curso con este cliente. Continúa donde la dejaste.');
    abrirVisitaActiva();
    return;
  }
  // Pedir al usuario que elija el catálogo (de su cartera) y cargar resumen ultima visita en paralelo
  try {
    const [r, resumen] = await Promise.all([
      api('/api/catalogs'),
      cargarResumenUltimaVisita(clientId)
    ]);
    const cats = (r.catalogs || []);
    if (cats.length === 0) {
      alert('No tienes catálogos disponibles para iniciar la visita.');
      return;
    }
    abrirModalElegirCatalogoVisita(clientId, cats, resumen);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function abrirModalElegirCatalogoVisita(clientId, cats, resumenUltima) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>Elige catálogo para la visita</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      ${resumenUltima ? renderPanelUltimaVisita(resumenUltima, 'modal') : ''}
      <p style="font-size:13px;color:var(--gris-texto);margin:12px 0">Selecciona el catálogo que vas a mostrar durante esta visita. Podrás añadir anotaciones lámina por lámina mientras navegas.</p>
      <div class="lista-catalogos-visita">
        ${cats.map(c => {
          const icono = c.tipo === 'express' ? '📗' : c.tipo === 'maestro' ? '📕' : '📘';
          return `
            <button class="btn-elegir-cat" onclick="confirmarIniciarVisita(${clientId}, ${c.id})">
              <div style="font-size:18px">${icono}</div>
              <div style="flex:1;text-align:left">
                <div style="font-weight:500">${escape(c.name)}</div>
                <div style="font-size:11px;color:var(--gris-texto)">${c.sheet_count || 0} láminas · V${c.version}${c.parent_name ? ' · de: ' + escape(c.parent_name) : ''}</div>
              </div>
            </button>
          `;
        }).join('')}
      </div>
      <div class="modal-acciones">
        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function confirmarIniciarVisita(clientId, catalogId) {
  // Cerrar modal si está abierto
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());
  try {
    const r = await api('/api/visits/start', {
      method: 'POST',
      body: { client_id: clientId, catalog_id: catalogId }
    });
    // Refrescar la visita activa con datos completos
    const cur = await api('/api/visits/current');
    appState.visitaActiva = cur.visit || null;
    // Llevar al visor comercial del catálogo elegido
    appState.vista = 'catalogos';
    appState.clienteActual = null;
    appState.visitaVerId = null;
    appState.catalogoActual = catalogId;
    appState.visorIndice = 0;
    render();
  } catch (err) {
    alert('Error al iniciar visita: ' + err.message);
  }
}

// ----- ABRIR VISITA ACTIVA (botón "Ver visita" de la barra) -----
// Admin → detalle informativo de la visita (resumen, anotaciones)
// Comercial → visor del catálogo de la visita (para seguir anotando)
function abrirVisitaActiva() {
  if (!appState.visitaActiva) return;
  const esAdminReal_ = (typeof esAdminReal === 'function') ? esAdminReal() : false;
  if (esAdminReal_) {
    // Admin: ver detalle informativo de la visita
    appState.vista = 'clientes';
    appState.clienteActual = null;
    appState.catalogoActual = null;
    appState.visitaVerId = appState.visitaActiva.id;
  } else {
    // Comercial (o admin impersonando): ir al visor del catálogo para anotar
    appState.vista = 'catalogos';
    appState.clienteActual = null;
    appState.visitaVerId = null;
    appState.catalogoActual = appState.visitaActiva.catalog_id;
  }
  render();
}

// Modal informativo cuando el comercial intenta iniciar visita y ya hay otra abierta.
// Muestra qué cliente, cuándo se inició, y ofrece "Ir a la visita" o "Cancelar".
function mostrarModalVisitaEnCurso() {
  const va = appState.visitaActiva;
  if (!va) return;
  const clienteNombre = va.cliente_nombre || ('Cliente #' + va.client_id);
  // Calcular cuándo se inició
  let cuando = '';
  if (va.created_at) {
    const inicio = new Date(va.created_at);
    const ahora = new Date();
    const ms = ahora - inicio;
    const minutos = Math.round(ms / 60000);
    if (minutos < 1) cuando = 'hace menos de un minuto';
    else if (minutos < 60) cuando = 'hace ' + minutos + ' min';
    else if (minutos < 24 * 60) {
      const h = Math.floor(minutos / 60);
      cuando = 'hace ' + h + ' h ' + (minutos % 60) + ' min';
    } else {
      cuando = 'el ' + inicio.toLocaleDateString('es-ES') + ' a las ' + inicio.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    }
  }

  // Contar anotaciones ya hechas en esa visita (desde memoria local)
  let totalAnots = 0;
  Object.keys(_anotacionesVisita || {}).forEach(sid => {
    totalAnots += (_anotacionesVisita[sid] || []).length;
  });

  document.querySelectorAll('.modal-bg').forEach(m => m.remove());
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>🛒 Ya tienes una visita en curso</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;padding:12px 14px;border-radius:8px;font-size:14px;color:#1e40af;margin-bottom:14px">
        <div style="margin-bottom:4px"><b>Cliente:</b> ${escape(clienteNombre)}</div>
        ${cuando ? `<div style="margin-bottom:4px"><b>Iniciada:</b> ${escape(cuando)}</div>` : ''}
        <div><b>Anotaciones:</b> ${totalAnots}</div>
      </div>
      <p style="font-size:13px;color:#374151;margin:0 0 14px 0">
        Para iniciar una visita nueva con otro cliente, primero ciérrala o descártala desde su visor.
      </p>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="this.closest('.modal-bg').remove(); abrirVisitaActiva()">→ Ir a la visita</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

// ============================================================================
// AULA DE FORMACIÓN (Bloque 1: vista admin + listado)
// ============================================================================
let _aulaCache = null;

async function renderAula() {
  const $v = document.getElementById('vista-contenido');
  if (!$v) return;
  const esAdmin = (typeof user !== 'undefined' && user && user.role === 'admin');

  $v.innerHTML = `
    <div class="contenedor">
      <div class="titulo-pagina">
        <div>
          <h2 style="margin:0">🎓 Aula de formación ${ayuda(esAdmin ? 'Sube material de formación de los laboratorios (PDF, imágenes, vídeos, PowerPoint). Los comerciales podrán verlo y descargarlo. Si marcas una formación como "Restringida", solo los comerciales que selecciones podrán acceder. Cuando subes o reemplazas un archivo, los comerciales con acceso reciben un email automático.' : 'Material de formación de los laboratorios. Pulsa "Ver / Descargar" en cada tarjeta: los PDFs, imágenes y vídeos se abren en pestaña nueva; los Word y PowerPoint se descargan. Si tienes notificaciones activadas, recibirás un email cuando haya material nuevo.')}</h2>
          <p style="color:var(--gris-texto);font-size:13px;margin:4px 0 0 0">
            ${esAdmin
              ? 'Sube y gestiona el material de formación de los laboratorios.'
              : 'Materiales de formación disponibles para tu consulta.'}
          </p>
        </div>
        ${esAdmin ? `
          <button class="btn btn-primary" onclick="abrirModalSubirFormacion()">
            + Nueva formación
          </button>
        ` : ''}
      </div>

      <div id="aula-filtros" style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" id="aula-filtro-texto" placeholder="🔍 Buscar (nombre, temática, laboratorio)…"
               style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--gris-borde);border-radius:8px;font-size:13px">
        <select id="aula-filtro-lab" style="padding:8px 12px;border:1px solid var(--gris-borde);border-radius:8px;font-size:13px">
          <option value="">Todos los laboratorios</option>
        </select>
      </div>

      <div id="aula-contenido">
        <p style="text-align:center;color:var(--gris-texto);padding:24px">Cargando…</p>
      </div>
    </div>
  `;

  try {
    const r = await api('/api/formaciones');
    _aulaCache = r.formaciones || [];
    const labs = [...new Set(_aulaCache.map(f => f.laboratorio).filter(Boolean))].sort();
    const $selLab = document.getElementById('aula-filtro-lab');
    if ($selLab) {
      labs.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l;
        $selLab.appendChild(opt);
      });
      $selLab.addEventListener('change', pintarAula);
    }
    const $txt = document.getElementById('aula-filtro-texto');
    if ($txt) {
      let t;
      $txt.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(pintarAula, 200);
      });
    }
    pintarAula();
  } catch (e) {
    document.getElementById('aula-contenido').innerHTML =
      `<div class="error-msg">${escape(e.message)}</div>`;
  }
}

function pintarAula() {
  const $c = document.getElementById('aula-contenido');
  if (!$c || !_aulaCache) return;
  const fTexto = (document.getElementById('aula-filtro-texto')?.value || '').toLowerCase().trim();
  const fLab = document.getElementById('aula-filtro-lab')?.value || '';
  const esAdmin = (typeof user !== 'undefined' && user && user.role === 'admin');

  let filtradas = _aulaCache;
  if (fLab) filtradas = filtradas.filter(f => f.laboratorio === fLab);
  if (fTexto) {
    filtradas = filtradas.filter(f => {
      const hay = (f.nombre + ' ' + (f.tematica || '') + ' ' + f.laboratorio + ' ' + (f.descripcion || '')).toLowerCase();
      return hay.includes(fTexto);
    });
  }

  if (filtradas.length === 0) {
    $c.innerHTML = `
      <div style="background:var(--surface);border:1px solid #e5e7eb;border-radius:8px;padding:32px;text-align:center;color:#6b7280">
        ${_aulaCache.length === 0
          ? (esAdmin
              ? '🎓 Aún no hay formaciones subidas. Pulsa <b>"+ Nueva formación"</b> para empezar.'
              : '🎓 Aún no hay formaciones disponibles.')
          : 'Sin resultados con esos filtros.'}
      </div>
    `;
    return;
  }

  const porLab = {};
  filtradas.forEach(f => {
    if (!porLab[f.laboratorio]) porLab[f.laboratorio] = [];
    porLab[f.laboratorio].push(f);
  });

  let html = '';
  Object.keys(porLab).sort().forEach(lab => {
    html += `<h3 style="margin:18px 0 8px 0;font-size:15px;color:#374151;border-bottom:2px solid #f3f4f6;padding-bottom:6px">🧪 ${escape(lab)} <span style="color:#9ca3af;font-weight:400;font-size:12px">(${porLab[lab].length})</span></h3>`;
    html += `<div class="aula-grid">`;
    porLab[lab].forEach(f => {
      html += renderTarjetaFormacion(f, esAdmin);
    });
    html += `</div>`;
  });
  $c.innerHTML = html;
}

function renderTarjetaFormacion(f, esAdmin) {
  const icono = iconoFormacion(f.archivo_mime);
  const tamano = formatearTamano(f.archivo_size);
  const fecha = f.fecha_formacion
    ? new Date(f.fecha_formacion).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
    : new Date(f.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
  return `
    <div class="aula-card">
      <div class="aula-card-icono">${icono}</div>
      <div class="aula-card-cuerpo">
        <div class="aula-card-titulo">${escape(f.nombre)}</div>
        ${f.tematica ? `<div class="aula-card-tematica">${escape(f.tematica)}</div>` : ''}
        <div class="aula-card-meta">
          📅 ${escape(fecha)} · 📦 ${tamano}
          ${!f.publico ? ' · 🔒 Restringido' : ''}
        </div>
        ${f.descripcion ? `<div class="aula-card-desc">${escape(f.descripcion.substring(0, 120))}${f.descripcion.length > 120 ? '…' : ''}</div>` : ''}
      </div>
      <div class="aula-card-acciones">
        <button class="btn btn-primary btn-pequeno" onclick="abrirFormacion(${f.id}, '${escape((f.archivo_nombre || '').replace(/'/g, "\\'"))}', '${escape(f.archivo_mime || '')}')">📥 Ver / Descargar</button>
        ${esAdmin ? `
          <button class="btn btn-secondary btn-pequeno" onclick="abrirModalEditarFormacion(${f.id})">✏️ Editar</button>
          ${(f.num_versiones_archivadas || 0) > 0 ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirModalVersionesFormacion(${f.id})" title="Ver versiones anteriores">📚 ${f.num_versiones_archivadas}</button>` : ''}
          <button class="btn btn-danger btn-pequeno" onclick="borrarFormacion(${f.id})">🗑️</button>
        ` : ''}
      </div>
    </div>
  `;
}

function iconoFormacion(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('word')) return '📘';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📙';
  return '📄';
}

function formatearTamano(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function abrirModalSubirFormacion() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;max-height:90vh;overflow-y:auto">
      <div class="modal-header">
        <h3>+ Nueva formación</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <form id="form-nueva-formacion">
        <div class="form-group">
          <label>Laboratorio <span style="color:#dc2626">*</span></label>
          <input type="text" id="nf-laboratorio" required placeholder="Ej: Cantabria Labs, Bayer, ISDIN…" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
        </div>
        <div class="form-group">
          <label>Nombre de la formación <span style="color:#dc2626">*</span></label>
          <input type="text" id="nf-nombre" required placeholder="Ej: Heliocare 360 - Nueva gama 2026" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-group">
            <label>Temática</label>
            <input type="text" id="nf-tematica" placeholder="Solar, Dermatología…" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
          </div>
          <div class="form-group">
            <label>Fecha</label>
            <input type="date" id="nf-fecha" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
          </div>
        </div>
        <div class="form-group">
          <label>Descripción <small style="color:#9ca3af">opcional</small></label>
          <textarea id="nf-descripcion" rows="2" placeholder="Breve descripción del contenido…" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-family:inherit;font-size:14px;box-sizing:border-box"></textarea>
        </div>
        <div class="form-group">
          <label>Archivo <span style="color:#dc2626">*</span></label>
          <input type="file" id="nf-archivo" required
                 accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.ppt,.pptx,.mp4,.webm,.mov"
                 style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
          <small style="color:#6b7280">PDF, imágenes, Word, PowerPoint o vídeo. Máx 50 MB (200 MB vídeo).</small>
        </div>

        <!-- Bloque 3 HH1: Visibilidad / Permisos -->
        <div class="form-group" style="background:var(--surface-2);border:1px solid #e5e7eb;border-radius:8px;padding:12px">
          <label style="font-weight:600;margin-bottom:8px;display:block">Visibilidad ${ayuda('Pública = todos los comerciales pueden ver y descargar la formación. Restringida = solo los comerciales que marques abajo podrán verla. Útil para material confidencial de un laboratorio concreto.')}</label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;margin-bottom:6px">
            <input type="radio" name="nf-visibilidad" value="publico" checked onchange="cambiarVisibilidadNF()">
            <span>🔓 <b>Pública</b> — todos los comerciales pueden verla</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
            <input type="radio" name="nf-visibilidad" value="restringido" onchange="cambiarVisibilidadNF()">
            <span>🔒 <b>Restringida</b> — solo comerciales seleccionados</span>
          </label>
          <div id="nf-comerciales" style="display:none;margin-top:10px;background:var(--surface);border:1px solid #e5e7eb;border-radius:6px;padding:10px;max-height:200px;overflow-y:auto">
            <p style="font-size:12px;color:#6b7280;margin:0 0 6px 0">Cargando comerciales…</p>
          </div>
        </div>

        <div id="nf-msg"></div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary" id="nf-submit">📤 Subir</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  // Cargar lista de comerciales en background (solo se mostrará si elige Restringida)
  cargarComercialesParaPermisos('nf-comerciales', []);

  document.getElementById('form-nueva-formacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const $msg = document.getElementById('nf-msg');
    const $btn = document.getElementById('nf-submit');
    const archivo = document.getElementById('nf-archivo').files[0];
    if (!archivo) {
      $msg.innerHTML = '<div class="error-msg">Selecciona un archivo</div>';
      return;
    }
    const esRestringido = document.querySelector('input[name="nf-visibilidad"]:checked')?.value === 'restringido';
    let permisosIds = [];
    if (esRestringido) {
      permisosIds = Array.from(document.querySelectorAll('#nf-comerciales input[type="checkbox"]:checked'))
        .map(cb => Number(cb.value));
      if (permisosIds.length === 0) {
        $msg.innerHTML = '<div class="error-msg">Marca al menos un comercial o vuelve a "Pública"</div>';
        return;
      }
    }
    const formData = new FormData();
    formData.append('archivo', archivo);
    formData.append('laboratorio', document.getElementById('nf-laboratorio').value);
    formData.append('nombre', document.getElementById('nf-nombre').value);
    formData.append('tematica', document.getElementById('nf-tematica').value);
    formData.append('descripcion', document.getElementById('nf-descripcion').value);
    formData.append('publico', esRestringido ? 'false' : 'true');
    const fecha = document.getElementById('nf-fecha').value;
    if (fecha) formData.append('fecha_formacion', fecha);

    $btn.disabled = true;
    $btn.textContent = '⏳ Subiendo…';
    $msg.innerHTML = '<div style="color:#6b7280;font-size:13px">Subiendo archivo, puede tardar según tamaño…</div>';

    try {
      const token = localStorage.getItem('cpv2_token') || '';
      const resp = await fetch('/api/formaciones', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: formData
      });
      const json = await resp.json();
      if (!json.success) throw new Error(json.error || 'Error subiendo');

      // Si es restringida, mandar permisos
      if (esRestringido && json.formacion && permisosIds.length > 0) {
        await api('/api/formaciones/' + json.formacion.id + '/permisos', {
          method: 'PUT',
          body: { user_ids: permisosIds }
        });
      }

      modal.remove();
      mostrarNotificacionOnline('✅ Formación subida', '#16a34a');
      renderAula();
    } catch (err) {
      $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
      $btn.disabled = false;
      $btn.textContent = '📤 Subir';
    }
  });
}

// Helper: cargar lista de comerciales con checkboxes
async function cargarComercialesParaPermisos(contenedorId, idsMarcados) {
  const $c = document.getElementById(contenedorId);
  if (!$c) return;
  try {
    const r = await api('/api/users');
    const comerciales = (r.users || []).filter(u => u.role === 'sales' && u.is_active);
    if (comerciales.length === 0) {
      $c.innerHTML = '<p style="font-size:12px;color:#6b7280;margin:0">No hay comerciales activos.</p>';
      return;
    }
    const set = new Set((idsMarcados || []).map(Number));
    $c.innerHTML = comerciales.map(c => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;font-weight:normal">
        <input type="checkbox" value="${c.id}" ${set.has(Number(c.id)) ? 'checked' : ''}>
        <span style="font-size:13px">${escape(c.name)} <small style="color:#9ca3af">${escape(c.email)}</small></span>
      </label>
    `).join('');
  } catch (e) {
    $c.innerHTML = `<p style="font-size:12px;color:#dc2626;margin:0">Error: ${escape(e.message)}</p>`;
  }
}

// Toggle visibilidad nueva formación
function cambiarVisibilidadNF() {
  const restringido = document.querySelector('input[name="nf-visibilidad"]:checked')?.value === 'restringido';
  const $cont = document.getElementById('nf-comerciales');
  if ($cont) $cont.style.display = restringido ? 'block' : 'none';
}

async function abrirModalEditarFormacion(id) {
  const f = (_aulaCache || []).find(x => x.id === id);
  if (!f) return;

  // Cargar permisos actuales si es restringida
  let permisosActuales = [];
  if (!f.publico) {
    try {
      const r = await api('/api/formaciones/' + id + '/permisos');
      permisosActuales = r.user_ids || [];
    } catch (_) {}
  }

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;max-height:90vh;overflow-y:auto">
      <div class="modal-header">
        <h3>✏️ Editar formación</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <form id="form-editar-formacion">
        <div class="form-group">
          <label>Laboratorio</label>
          <input type="text" id="ef-laboratorio" required value="${escape(f.laboratorio || '')}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
        </div>
        <div class="form-group">
          <label>Nombre</label>
          <input type="text" id="ef-nombre" required value="${escape(f.nombre || '')}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-group">
            <label>Temática</label>
            <input type="text" id="ef-tematica" value="${escape(f.tematica || '')}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
          </div>
          <div class="form-group">
            <label>Fecha</label>
            <input type="date" id="ef-fecha" value="${f.fecha_formacion ? new Date(f.fecha_formacion).toISOString().substring(0,10) : ''}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box">
          </div>
        </div>
        <div class="form-group">
          <label>Descripción</label>
          <textarea id="ef-descripcion" rows="2" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-family:inherit;font-size:14px;box-sizing:border-box">${escape(f.descripcion || '')}</textarea>
        </div>

        <!-- Bloque 3 HH1: Visibilidad / Permisos -->
        <div class="form-group" style="background:var(--surface-2);border:1px solid #e5e7eb;border-radius:8px;padding:12px">
          <label style="font-weight:600;margin-bottom:8px;display:block">Visibilidad</label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;margin-bottom:6px">
            <input type="radio" name="ef-visibilidad" value="publico" ${f.publico ? 'checked' : ''} onchange="cambiarVisibilidadEF()">
            <span>🔓 <b>Pública</b> — todos los comerciales pueden verla</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
            <input type="radio" name="ef-visibilidad" value="restringido" ${!f.publico ? 'checked' : ''} onchange="cambiarVisibilidadEF()">
            <span>🔒 <b>Restringida</b> — solo comerciales seleccionados</span>
          </label>
          <div id="ef-comerciales" style="display:${f.publico ? 'none' : 'block'};margin-top:10px;background:var(--surface);border:1px solid #e5e7eb;border-radius:6px;padding:10px;max-height:200px;overflow-y:auto">
            <p style="font-size:12px;color:#6b7280;margin:0 0 6px 0">Cargando comerciales…</p>
          </div>
        </div>

        <!-- Bloque 3 JJ1: Reemplazar archivo (opcional) -->
        <div class="form-group" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px">
          <label style="font-weight:600;margin-bottom:6px;display:block">📎 Archivo</label>
          <div style="font-size:12px;color:#6b7280;margin-bottom:8px">
            Actual: <b>${escape(f.archivo_nombre)}</b> (${formatearTamano(f.archivo_size)})
          </div>
          <label style="font-size:13px;font-weight:normal;margin-bottom:4px;display:block">Reemplazar (opcional)</label>
          <input type="file" id="ef-archivo-nuevo"
                 accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.ppt,.pptx,.mp4,.webm,.mov"
                 style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;background:var(--surface)">
          <input type="text" id="ef-notas-version" placeholder="Notas (opcional): qué cambia respecto a la anterior" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;font-size:13px;margin-top:6px;background:var(--surface)">
          <small style="color:#6b7280">Si subes un nuevo archivo, el actual pasa al historial de versiones.</small>
        </div>

        <div id="ef-msg"></div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary" id="ef-submit">💾 Guardar cambios</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  // Cargar comerciales con permisos actuales marcados
  cargarComercialesParaPermisos('ef-comerciales', permisosActuales);

  document.getElementById('form-editar-formacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const $msg = document.getElementById('ef-msg');
    const $btn = document.getElementById('ef-submit');
    const esRestringido = document.querySelector('input[name="ef-visibilidad"]:checked')?.value === 'restringido';
    let permisosIds = [];
    if (esRestringido) {
      permisosIds = Array.from(document.querySelectorAll('#ef-comerciales input[type="checkbox"]:checked'))
        .map(cb => Number(cb.value));
      if (permisosIds.length === 0) {
        $msg.innerHTML = '<div class="error-msg">Marca al menos un comercial o vuelve a "Pública"</div>';
        return;
      }
    }

    $btn.disabled = true;
    $btn.textContent = '⏳ Guardando…';
    try {
      // 1) Actualizar metadatos + flag publico
      await api('/api/formaciones/' + id, {
        method: 'PUT',
        body: {
          laboratorio: document.getElementById('ef-laboratorio').value,
          nombre: document.getElementById('ef-nombre').value,
          tematica: document.getElementById('ef-tematica').value,
          descripcion: document.getElementById('ef-descripcion').value,
          fecha_formacion: document.getElementById('ef-fecha').value || null,
          publico: !esRestringido
        }
      });

      // 2) Si es restringida, actualizar permisos (II2: si pasa a pública NO los borramos, pero tampoco los enviamos)
      if (esRestringido) {
        await api('/api/formaciones/' + id + '/permisos', {
          method: 'PUT',
          body: { user_ids: permisosIds }
        });
      }

      // 3) Si hay archivo nuevo, reemplazarlo (esto disparará email automático)
      const archivoNuevo = document.getElementById('ef-archivo-nuevo').files[0];
      if (archivoNuevo) {
        $btn.textContent = '⏳ Subiendo archivo…';
        const fd = new FormData();
        fd.append('archivo', archivoNuevo);
        const notas = document.getElementById('ef-notas-version').value;
        if (notas) fd.append('notas', notas);
        const token = localStorage.getItem('cpv2_token') || '';
        const resp = await fetch('/api/formaciones/' + id + '/reemplazar-archivo', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: fd
        });
        const json = await resp.json();
        if (!json.success) throw new Error(json.error || 'Error reemplazando archivo');
      }

      modal.remove();
      mostrarNotificacionOnline('✅ Cambios guardados', '#16a34a');
      renderAula();
    } catch (err) {
      $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
      $btn.disabled = false;
      $btn.textContent = '💾 Guardar cambios';
    }
  });
}

// Toggle visibilidad editar formación
function cambiarVisibilidadEF() {
  const restringido = document.querySelector('input[name="ef-visibilidad"]:checked')?.value === 'restringido';
  const $cont = document.getElementById('ef-comerciales');
  if ($cont) $cont.style.display = restringido ? 'block' : 'none';
}

async function borrarFormacion(id) {
  const f = (_aulaCache || []).find(x => x.id === id);
  if (!f) return;
  if (!confirm(`¿Eliminar la formación "${f.nombre}"?\n\nSe borrará el archivo del servidor.\nEsta acción no se puede deshacer.`)) return;
  try {
    await api('/api/formaciones/' + id, { method: 'DELETE' });
    mostrarNotificacionOnline('Formación eliminada', '#6b7280');
    renderAula();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Abrir/descargar archivo de formación (fetch con token, sin exponer credenciales en URL)
async function abrirFormacion(id, nombreArchivo, mime) {
  try {
    const token = localStorage.getItem('cpv2_token') || '';
    const resp = await fetch('/api/formaciones/' + id + '/descargar', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!resp.ok) {
      try {
        const json = await resp.json();
        throw new Error(json.error || 'Error ' + resp.status);
      } catch (_) {
        throw new Error('Error ' + resp.status);
      }
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const visualizable = mime && (
      mime === 'application/pdf' ||
      mime.startsWith('image/') ||
      mime.startsWith('video/')
    );
    if (visualizable) {
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreArchivo || 'formacion';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (err) {
    alert('Error al abrir: ' + err.message);
  }
}

// Bloque 3 KK2: modal con versiones archivadas
async function abrirModalVersionesFormacion(id) {
  const f = (_aulaCache || []).find(x => x.id === id);
  if (!f) return;
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:640px;max-height:90vh;overflow-y:auto">
      <div class="modal-header">
        <h3>📚 Versiones anteriores de "${escape(f.nombre)}"</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="color:#6b7280;font-size:13px;margin:0 0 12px 0">
        Cada vez que reemplazas el archivo, la versión anterior queda aquí archivada.
      </p>
      <div id="versiones-lista"><p style="color:#6b7280;font-size:13px">Cargando…</p></div>
      <div class="modal-acciones">
        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  try {
    const r = await api('/api/formaciones/' + id + '/versiones');
    const versiones = r.versiones || [];
    const $lista = document.getElementById('versiones-lista');
    if (versiones.length === 0) {
      $lista.innerHTML = '<p style="color:#6b7280;font-size:13px">Sin versiones archivadas.</p>';
      return;
    }
    $lista.innerHTML = versiones.map(v => {
      const fecha = new Date(v.archivado_at).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const icono = iconoFormacion(v.archivo_mime);
      return `
        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:8px;background:var(--surface-2)">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
            <div style="flex:1">
              <div style="font-size:14px;font-weight:600;color:#111827">${icono} ${escape(v.archivo_nombre)}</div>
              <div style="font-size:11px;color:#6b7280;margin-top:4px">
                📅 ${escape(fecha)} · 📦 ${formatearTamano(v.archivo_size)}
                ${v.reemplazado_por_nombre ? ` · 👤 ${escape(v.reemplazado_por_nombre)}` : ''}
              </div>
              ${v.notas ? `<div style="font-size:12px;color:#4b5563;margin-top:6px;font-style:italic">"${escape(v.notas)}"</div>` : ''}
            </div>
            <button class="btn btn-primary btn-pequeno" onclick="descargarVersionArchivada(${v.id}, '${escape((v.archivo_nombre || '').replace(/'/g, "\\'"))}', '${escape(v.archivo_mime || '')}')">📥 Descargar</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    document.getElementById('versiones-lista').innerHTML = `<div class="error-msg">${escape(e.message)}</div>`;
  }
}

async function descargarVersionArchivada(versionId, nombreArchivo, mime) {
  try {
    const token = localStorage.getItem('cpv2_token') || '';
    const resp = await fetch('/api/formaciones/versiones/' + versionId + '/descargar', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!resp.ok) {
      try {
        const json = await resp.json();
        throw new Error(json.error || 'Error ' + resp.status);
      } catch (_) {
        throw new Error('Error ' + resp.status);
      }
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const visualizable = mime && (mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('video/'));
    if (visualizable) {
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreArchivo || 'version';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ============================================================================
// DASHBOARD ADMIN — Fase 1 (5 widgets modulares)
// Estructura preparada para añadir los 3 widgets de Fase 2 después
// (ranking comerciales, gráfico semanal, próximas previstas)
// ============================================================================
async function renderDashboard() {
  const $v = document.getElementById('vista-contenido');
  if (!$v) return;
  $v.innerHTML = `
    <div class="contenedor">
      <h2 style="margin-bottom:6px">🏠 Dashboard</h2>
      <p style="color:var(--gris-texto);font-size:13px;margin-top:0;margin-bottom:16px">
        Vista general · ${new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}
      </p>
      <div id="dashboard-contenido">
        <p style="color:var(--gris-texto);text-align:center;padding:24px">Cargando…</p>
      </div>
    </div>
  `;
  try {
    const r = await api('/api/dashboard');
    const d = r.dashboard || {};
    document.getElementById('dashboard-contenido').innerHTML = renderDashboardWidgets(d);
  } catch (e) {
    document.getElementById('dashboard-contenido').innerHTML =
      `<div class="error-msg">${escape(e.message)}</div>`;
  }
}

function renderDashboardWidgets(d) {
  const widgets = [
    widgetResumenMes(d.resumen_mes),
    widgetVisitasHoy(d.visitas_hoy),
    widgetSinVisitar(d.sin_visitar),
    widgetProximasPrevistas(d.proximas_previstas),
    widgetGraficoSemanas(d.visitas_por_semana),
    widgetTopProductos(d.top_productos),
    widgetTopClientes(d.top_clientes),
    widgetRankingComerciales(d.ranking_comerciales)
  ];
  return `<div class="dashboard-grid">${widgets.join('')}</div>`;
}

// --- Widget: Resumen del mes (KPIs grandes arriba) ---
function widgetResumenMes(r) {
  if (!r) return '';
  return `
    <div class="dash-widget dash-widget-full">
      <h3>📊 Resumen del mes</h3>
      <div class="dash-kpis">
        <div class="dash-kpi">
          <div class="dash-kpi-valor">${r.total_visitas}</div>
          <div class="dash-kpi-label">Visitas</div>
          <div class="dash-kpi-sub">${r.confirmadas} confirmadas</div>
        </div>
        <div class="dash-kpi">
          <div class="dash-kpi-valor" style="color:#16a34a">${(r.total_pvf || 0).toFixed(2)}€</div>
          <div class="dash-kpi-label">Total PVF facturado</div>
        </div>
        <div class="dash-kpi">
          <div class="dash-kpi-valor">${r.comerciales_activos}</div>
          <div class="dash-kpi-label">Comerciales activos</div>
        </div>
      </div>
    </div>
  `;
}

// --- Widget: Visitas de hoy ---
function widgetVisitasHoy(visitas) {
  if (!visitas) visitas = [];
  return `
    <div class="dash-widget">
      <h3>📅 Visitas de hoy <span class="dash-badge">${visitas.length}</span></h3>
      ${visitas.length === 0
        ? `<p class="dash-vacio">Sin visitas registradas hoy.</p>`
        : `<ul class="dash-lista">
            ${visitas.slice(0, 8).map(v => {
              const badge = v.status === 'draft'
                ? '<span class="visita-badge visita-badge-draft">borrador</span>'
                : '<span class="visita-badge visita-badge-confirmed">cerrada</span>';
              const pedido = v.hubo_pedido ? '🛒' : '';
              return `
                <li class="dash-item" onclick="abrirVisitaDesdeDashboard(${v.id})">
                  <div class="dash-item-titulo">
                    <b>${escape(v.cliente_nombre || '—')}</b> ${badge} ${pedido}
                  </div>
                  <div class="dash-item-sub">
                    ${escape(v.comercial_nombre || '?')} ·
                    ${v.cliente_municipio ? escape(v.cliente_municipio) + ' · ' : ''}
                    ${v.num_anotaciones} anot.
                  </div>
                </li>
              `;
            }).join('')}
          </ul>${visitas.length > 8 ? `<div class="dash-mas">+${visitas.length - 8} más</div>` : ''}`
      }
    </div>
  `;
}

// --- Widget: Clientes sin visitar ---
function widgetSinVisitar(clientes) {
  if (!clientes) clientes = [];
  return `
    <div class="dash-widget">
      <h3>⏰ Sin visitar <span class="dash-badge">${clientes.length}</span></h3>
      ${clientes.length === 0
        ? `<p class="dash-vacio">Todos los clientes están al día.</p>`
        : `<ul class="dash-lista">
            ${clientes.map(c => {
              const color = c.dias_sin_visitar > c.ciclo * 1.5 ? '#dc2626' : '#f59e0b';
              return `
                <li class="dash-item" onclick="abrirResultadoBusqueda('cliente', ${c.id})">
                  <div class="dash-item-titulo">
                    <b>${escape(c.razon_social || '—')}</b>
                    <span style="color:${color};font-weight:600;font-size:12px">${c.dias_sin_visitar} d</span>
                  </div>
                  <div class="dash-item-sub">
                    ${c.municipio ? escape(c.municipio) + ' · ' : ''}
                    ciclo ${c.ciclo}d
                  </div>
                </li>
              `;
            }).join('')}
          </ul>`
      }
    </div>
  `;
}

// --- Widget: Top productos del mes ---
function widgetTopProductos(productos) {
  if (!productos) productos = [];
  return `
    <div class="dash-widget">
      <h3>📦 Top productos del mes</h3>
      ${productos.length === 0
        ? `<p class="dash-vacio">Sin pedidos registrados este mes.</p>`
        : `<table class="dash-tabla">
            <thead>
              <tr>
                <th style="text-align:left">Código</th>
                <th style="text-align:left">Producto</th>
                <th style="text-align:right">Uds</th>
                <th style="text-align:right">PVF</th>
              </tr>
            </thead>
            <tbody>
              ${productos.map(p => `
                <tr>
                  <td><b>${escape(p.codigo || '—')}</b></td>
                  <td>${escape((p.nombre || '').substring(0, 32))}</td>
                  <td style="text-align:right;font-weight:600">${p.uds_total}</td>
                  <td style="text-align:right;color:#16a34a">${(p.total_pvf || 0).toFixed(0)}€</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
      }
    </div>
  `;
}

// --- Widget: Top clientes del mes ---
function widgetTopClientes(clientes) {
  if (!clientes) clientes = [];
  return `
    <div class="dash-widget">
      <h3>🏆 Top clientes del mes</h3>
      ${clientes.length === 0
        ? `<p class="dash-vacio">Sin pedidos cuantificados este mes.</p>`
        : `<ul class="dash-lista">
            ${clientes.map((c, idx) => `
              <li class="dash-item" onclick="abrirResultadoBusqueda('cliente', ${c.id})">
                <div class="dash-item-titulo">
                  <span class="dash-rank">#${idx + 1}</span>
                  <b>${escape(c.razon_social || '—')}</b>
                </div>
                <div class="dash-item-sub" style="display:flex;justify-content:space-between">
                  <span>${c.municipio ? escape(c.municipio) + ' · ' : ''}${c.visitas} visita${c.visitas !== 1 ? 's' : ''}</span>
                  <span style="color:#16a34a;font-weight:600">${(c.total_pvf || 0).toFixed(2)}€</span>
                </div>
              </li>
            `).join('')}
          </ul>`
      }
    </div>
  `;
}

// --- Widget: Próximas visitas previstas (ciclo vence en próx. 7 días) ---
function widgetProximasPrevistas(clientes) {
  if (!clientes) clientes = [];
  return `
    <div class="dash-widget">
      <h3>🗓️ Próximas visitas previstas <span class="dash-badge">${clientes.length}</span></h3>
      ${clientes.length === 0
        ? `<p class="dash-vacio">Ninguna visita prevista en los próximos 7 días.</p>`
        : `<ul class="dash-lista">
            ${clientes.map(c => {
              const fecha = new Date(c.fecha_prevista).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', weekday: 'short' });
              const color = c.dias_restantes <= 2 ? '#f59e0b' : '#16a34a';
              return `
                <li class="dash-item" onclick="abrirResultadoBusqueda('cliente', ${c.id})">
                  <div class="dash-item-titulo">
                    <b>${escape(c.razon_social || '—')}</b>
                    <span style="color:${color};font-weight:600;font-size:12px;margin-left:auto">${escape(fecha)}</span>
                  </div>
                  <div class="dash-item-sub">
                    ${c.municipio ? escape(c.municipio) + ' · ' : ''}
                    en ${c.dias_restantes} día${c.dias_restantes !== 1 ? 's' : ''}
                  </div>
                </li>
              `;
            }).join('')}
          </ul>`
      }
    </div>
  `;
}

// --- Widget: Gráfico de visitas por semana (SVG nativo, CC1) ---
function widgetGraficoSemanas(semanas) {
  if (!semanas || semanas.length === 0) {
    return `
      <div class="dash-widget">
        <h3>📈 Visitas por semana</h3>
        <p class="dash-vacio">Aún no hay datos suficientes.</p>
      </div>
    `;
  }
  const maxVisitas = Math.max(...semanas.map(s => s.visitas), 1);
  // Dimensiones del SVG
  const w = 100;     // % del ancho
  const h = 140;     // px de alto del gráfico
  const padTop = 10;
  const padBottom = 30;
  const padLeft = 6;
  const padRight = 6;
  const innerH = h - padTop - padBottom;
  const numBarras = semanas.length;
  const espacio = 6;
  const totalEspacios = espacio * (numBarras - 1);
  // Usamos viewBox para que escale: ancho lógico arbitrario 100
  const innerW = 100 - padLeft - padRight;
  const anchoBarra = (innerW - totalEspacios) / numBarras;

  const barras = semanas.map((s, i) => {
    const xBar = padLeft + i * (anchoBarra + espacio);
    const altoBar = (s.visitas / maxVisitas) * innerH;
    const yBar = padTop + innerH - altoBar;
    const fecha = new Date(s.semana_inicio);
    const etiqueta = (fecha.getDate() + '/' + (fecha.getMonth() + 1));
    const color = i === semanas.length - 1 ? '#ec4899' : '#a78bfa'; // última semana destacada
    return `
      <g>
        <rect x="${xBar}" y="${yBar}" width="${anchoBarra}" height="${Math.max(altoBar, 0.5)}"
              fill="${color}" rx="0.6" ry="0.6">
          <title>Semana del ${fecha.toLocaleDateString('es-ES')}: ${s.visitas} visitas${s.con_pedido ? ', ' + s.con_pedido + ' con pedido' : ''}</title>
        </rect>
        ${s.visitas > 0 ? `<text x="${xBar + anchoBarra / 2}" y="${yBar - 1}" text-anchor="middle"
                                font-size="3.2" fill="#374151" font-weight="600">${s.visitas}</text>` : ''}
        <text x="${xBar + anchoBarra / 2}" y="${h - 14}" text-anchor="middle" font-size="3" fill="#6b7280">${etiqueta}</text>
      </g>
    `;
  }).join('');

  const totalVisitas = semanas.reduce((s, x) => s + x.visitas, 0);
  return `
    <div class="dash-widget">
      <h3>📈 Visitas por semana <span class="dash-badge">${totalVisitas} en 8 sem</span></h3>
      <svg viewBox="0 0 100 ${h}" preserveAspectRatio="none" style="width:100%;height:${h * 1.5}px;display:block">
        ${barras}
        <text x="50" y="${h - 4}" text-anchor="middle" font-size="2.8" fill="#9ca3af">Últimas 8 semanas (lunes inicio)</text>
      </svg>
    </div>
  `;
}

// --- Widget: Ranking comerciales del mes ---
function widgetRankingComerciales(comerciales) {
  if (!comerciales) comerciales = [];
  return `
    <div class="dash-widget">
      <h3>👥 Comerciales del mes</h3>
      ${comerciales.length === 0
        ? `<p class="dash-vacio">Sin actividad este mes.</p>`
        : `<table class="dash-tabla">
            <thead>
              <tr>
                <th style="text-align:left">Comercial</th>
                <th style="text-align:right">Visitas</th>
                <th style="text-align:right">C/P</th>
                <th style="text-align:right">PVF</th>
              </tr>
            </thead>
            <tbody>
              ${comerciales.map((c, idx) => `
                <tr>
                  <td>
                    <span class="dash-rank" style="margin-right:6px">#${idx + 1}</span>
                    <b>${escape(c.name || '—')}</b>
                  </td>
                  <td style="text-align:right;font-weight:600">${c.visitas}</td>
                  <td style="text-align:right;color:#6b7280">${c.con_pedido}</td>
                  <td style="text-align:right;color:#16a34a;font-weight:600">${(c.total_pvf || 0).toFixed(0)}€</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
      }
    </div>
  `;
}

// Navegación desde widget de visitas hoy → detalle visita
function abrirVisitaDesdeDashboard(visitId) {
  appState.vista = 'clientes';
  appState.clienteActual = null;
  appState.catalogoActual = null;
  appState.visitaVerId = visitId;
  render();
}

// ============================================================================
// BÚSQUEDA GLOBAL (Q3 lupa + Ctrl+K, R2 agrupado, T1 click va a la ficha)
// ============================================================================
let _busquedaGlobalTimer = null;

function abrirBusquedaGlobal() {
  // Si ya está abierto, cerrar (toggle)
  const existente = document.getElementById('busqueda-global-overlay');
  if (existente) { existente.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'busqueda-global-overlay';
  overlay.className = 'busqueda-global-overlay';
  overlay.innerHTML = `
    <div class="busqueda-global-modal" onclick="event.stopPropagation()">
      <div class="busqueda-global-header">
        <span style="font-size:18px">🔍</span>
        <input type="text" id="busqueda-global-input" placeholder="Buscar clientes, productos o láminas…"
               autocomplete="off" spellcheck="false">
        <span class="busqueda-global-cerrar" onclick="cerrarBusquedaGlobal()" title="Cerrar (Esc)">×</span>
      </div>
      <div class="busqueda-global-resultados" id="busqueda-global-resultados">
        <div class="busqueda-global-hint">Escribe al menos 2 caracteres…</div>
      </div>
    </div>
  `;
  overlay.addEventListener('click', cerrarBusquedaGlobal);
  document.body.appendChild(overlay);

  const $input = document.getElementById('busqueda-global-input');
  setTimeout(() => $input.focus(), 50);

  $input.addEventListener('input', () => {
    clearTimeout(_busquedaGlobalTimer);
    const q = $input.value.trim();
    const $res = document.getElementById('busqueda-global-resultados');
    if (q.length < 2) {
      $res.innerHTML = '<div class="busqueda-global-hint">Escribe al menos 2 caracteres…</div>';
      return;
    }
    $res.innerHTML = '<div class="busqueda-global-hint">Buscando…</div>';
    _busquedaGlobalTimer = setTimeout(async () => {
      try {
        const r = await api('/api/search-global?q=' + encodeURIComponent(q));
        if (q !== $input.value.trim()) return; // resultados obsoletos
        renderResultadosBusquedaGlobal(r);
      } catch (e) {
        $res.innerHTML = `<div class="error-msg">${escape(e.message)}</div>`;
      }
    }, 200);
  });

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrarBusquedaGlobal();
  });
}

function cerrarBusquedaGlobal() {
  const ov = document.getElementById('busqueda-global-overlay');
  if (ov) ov.remove();
}

function renderResultadosBusquedaGlobal(data) {
  const $res = document.getElementById('busqueda-global-resultados');
  if (!$res) return;
  const total = (data.clients?.length || 0) + (data.products?.length || 0) + (data.sheets?.length || 0);
  if (total === 0) {
    $res.innerHTML = '<div class="busqueda-global-hint">Sin resultados.</div>';
    return;
  }
  let html = '';
  if (data.clients?.length > 0) {
    html += `<div class="busqueda-global-seccion">🏥 Clientes (${data.clients.length})</div>`;
    html += data.clients.map(c => `
      <div class="busqueda-global-item" onclick="abrirResultadoBusqueda('cliente', ${c.id})">
        <div class="bg-item-titulo"><b>${escape(c.razon_social || '—')}</b></div>
        <div class="bg-item-subtitulo">
          ${c.cif ? '<span>' + escape(c.cif) + '</span>' : ''}
          ${c.municipio ? '<span> · ' + escape(c.municipio) + '</span>' : ''}
          ${c.sage_code ? '<span> · Sage: ' + escape(c.sage_code) + '</span>' : ''}
        </div>
      </div>
    `).join('');
  }
  if (data.products?.length > 0) {
    html += `<div class="busqueda-global-seccion">📦 Productos (${data.products.length})</div>`;
    html += data.products.map(p => {
      const pvf = p.precio_pvf ? Number(p.precio_pvf).toFixed(2) + '€' : '—';
      const tipoIcon = p.tipo === 'comercial' ? '🎁' : '🏷️';
      return `
        <div class="busqueda-global-item" onclick="abrirResultadoBusqueda('producto', ${p.id})">
          <div class="bg-item-titulo">
            ${tipoIcon} <b>${escape(p.codigo)}</b> · ${escape(p.nombre || '')}
          </div>
          <div class="bg-item-subtitulo">
            ${p.ean ? 'EAN ' + escape(p.ean) + ' · ' : ''}PVF ${pvf}
          </div>
        </div>
      `;
    }).join('');
  }
  if (data.sheets?.length > 0) {
    html += `<div class="busqueda-global-seccion">📄 Láminas (${data.sheets.length})</div>`;
    html += data.sheets.map(s => `
      <div class="busqueda-global-item" onclick="abrirResultadoBusqueda('lamina', ${s.id}, ${s.catalog_id})">
        <div class="bg-item-titulo"><b>${escape(s.titulo || 'Sin título')}</b></div>
        <div class="bg-item-subtitulo">
          ${s.catalog_name ? 'En: ' + escape(s.catalog_name) : ''}
          ${s.tags ? ' · 🏷️ ' + escape(s.tags) : ''}
        </div>
      </div>
    `).join('');
  }
  $res.innerHTML = html;
}

// T1: pulsar resultado lleva a la ficha correspondiente
function abrirResultadoBusqueda(tipo, id, catalogId) {
  cerrarBusquedaGlobal();
  if (tipo === 'cliente') {
    appState.vista = 'clientes';
    appState.clienteActual = id;
    appState.catalogoActual = null;
    appState.visitaVerId = null;
    render();
  } else if (tipo === 'producto') {
    appState.vista = 'productos';
    appState.productoActual = id;
    render();
  } else if (tipo === 'lamina') {
    appState.vista = 'catalogos';
    appState.catalogoActual = catalogId;
    appState.clienteActual = null;
    appState.visitaVerId = null;
    appState.scrollASheetId = id; // si el editor soporta esto
    render();
  }
}

// Atajo de teclado Ctrl+K (o Cmd+K en Mac)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    abrirBusquedaGlobal();
  }
});

// ----- CERRAR VISITA ACTIVA — abre primero el RESUMEN PRE-ENVÍO (M2/N2/O3) -----
async function cerrarVisitaActiva() {
  if (!appState.visitaActiva) return;
  await abrirResumenPreEnvio();
}

// Resumen pre-envío: tabla editable de productos + nota general + email cliente + opciones
async function abrirResumenPreEnvio() {
  const visitId = appState.visitaActiva.id;

  // Recopilar TODAS las anotaciones de la visita desde memoria local
  let anotaciones = [];
  Object.keys(_anotacionesVisita).forEach(sid => {
    (_anotacionesVisita[sid] || []).forEach(a => {
      anotaciones.push({ ...a, sheet_orden: a.sheet_orden });
    });
  });
  // Ordenar por orden_en_visita
  anotaciones.sort((x, y) => (x.orden_en_visita || 0) - (y.orden_en_visita || 0));

  // Cargar info del cliente
  let cliente = null;
  try {
    const rc = await api('/api/clients/' + appState.visitaActiva.client_id);
    cliente = rc.client || null;
  } catch (e) {
    alert('Error cargando cliente: ' + e.message);
    return;
  }

  // Cargar info de producto para cada anotación que tiene product_id
  const idsProductos = [...new Set(anotaciones.filter(a => a.product_id).map(a => a.product_id))];
  const mapaProductos = {};
  if (idsProductos.length > 0) {
    for (const pid of idsProductos) {
      try {
        const rp = await api('/api/products/' + pid);
        if (rp.product) mapaProductos[pid] = rp.product;
      } catch (_) {}
    }
  }
  anotaciones.forEach(a => {
    if (a.product_id && mapaProductos[a.product_id]) {
      a.producto_codigo = mapaProductos[a.product_id].codigo;
      a.producto_nombre = mapaProductos[a.product_id].nombre;
      a.producto_pvf = mapaProductos[a.product_id].precio_pvf;
    }
  });

  // Guardar estado del resumen
  _resumenPreEnvio = {
    visitId,
    anotaciones,
    cliente,
    noEnviarCliente: false
  };
  renderResumenPreEnvio();
}

let _resumenPreEnvio = null;

function renderResumenPreEnvio() {
  document.querySelectorAll('.resumen-preenvio-overlay').forEach(o => o.remove());
  const { anotaciones, cliente } = _resumenPreEnvio;

  const comision = anotaciones.filter(a => a.es_comision);
  const sueltas = anotaciones.filter(a => a.referencia && !a.es_comision && !a.product_id);
  const conProducto = anotaciones.filter(a => a.product_id && !a.es_comision);
  const sinProducto = anotaciones.filter(a => !a.product_id && !a.es_comision && !a.referencia);
  let totalPVF = 0;
  conProducto.forEach(a => {
    const cant = Number(a.cantidad) || 0;
    const pvf = a.producto_pvf != null ? Number(a.producto_pvf) : 0;
    totalPVF += cant * pvf;
  });

  const emailClienteActual = _resumenPreEnvio.cliente?.email || '';
  const emailClienteOverride = _resumenPreEnvio.emailClienteOverride;
  const valorEmailCliente = emailClienteOverride !== undefined ? emailClienteOverride : emailClienteActual;

  const overlay = document.createElement('div');
  overlay.className = 'resumen-preenvio-overlay';
  overlay.innerHTML = `
    <div class="resumen-preenvio-header">
      <div>
        <b>📋 Revisar antes de enviar</b>
        <span style="color:#9ca3af;font-size:13px"> · ${escape(cliente?.razon_social || 'Cliente')}</span>
      </div>
      <button class="btn btn-secondary" onclick="cerrarResumenPreEnvio()">← Volver al visor</button>
    </div>

    <div class="resumen-preenvio-body">
      <div class="resumen-preenvio-info">
        ℹ️ Revisa el pedido antes de enviar los emails. Puedes editar cantidades o eliminar líneas.
      </div>

      ${conProducto.length > 0 ? `
        <h4 style="margin-top:18px;margin-bottom:8px">🛒 Productos pedidos</h4>
        <div class="resumen-tabla-wrap">
          <table class="resumen-tabla">
            <thead>
              <tr>
                <th style="text-align:left">Código</th>
                <th style="text-align:left">Producto</th>
                <th style="width:80px;text-align:center">Cant</th>
                <th style="width:90px;text-align:right">PVF</th>
                <th style="width:100px;text-align:right">Subtotal</th>
                <th style="width:40px"></th>
              </tr>
            </thead>
            <tbody>
              ${conProducto.map(a => {
                const cant = Number(a.cantidad) || 0;
                const pvf = a.producto_pvf != null ? Number(a.producto_pvf) : null;
                const sub = (pvf != null && cant) ? pvf * cant : null;
                return `
                  <tr data-anot-id="${a.id}">
                    <td><b>${escape(a.producto_codigo || '—')}</b></td>
                    <td style="font-size:12px;color:#374151">${escape(a.producto_nombre || '')}</td>
                    <td style="text-align:center">
                      <input type="number" class="resumen-cant-input" min="1" value="${cant}" data-anot-id="${a.id}"
                             style="width:60px;padding:6px;border:1px solid #d1d5db;border-radius:6px;text-align:center;font-size:14px">
                    </td>
                    <td style="text-align:right">${pvf != null ? pvf.toFixed(2) + '€' : '—'}</td>
                    <td style="text-align:right;font-weight:600" class="resumen-subtotal-celda">${sub != null ? sub.toFixed(2) + '€' : '—'}</td>
                    <td style="text-align:center">
                      <button class="resumen-borrar-btn" data-anot-id="${a.id}" title="Quitar línea">🗑️</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" style="text-align:right;font-weight:700;padding-top:10px">TOTAL PVF:</td>
                <td style="text-align:right;font-weight:700;color:#16a34a;font-size:15px;padding-top:10px" id="resumen-total">${totalPVF.toFixed(2)}€</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      ` : ''}

      ${comision.length > 0 ? `
        <h4 style="margin-top:18px;margin-bottom:8px">🤝 Comisión — tramitar al laboratorio (no se factura)</h4>
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px">
          <div style="font-size:13px;color:#374151;margin-bottom:8px">
            Almacén de envío: <b>${escape(comision[0].almacen || '—')}</b> · Nº socio: <b>${escape(comision[0].num_socio || '—')}</b>
          </div>
          <ul class="resumen-otras-lista">
            ${comision.map(a => `
              <li>
                ${escape(a.texto_libre || '')}
                <button class="resumen-borrar-mini" data-anot-id="${a.id}">×</button>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}

      ${sueltas.length > 0 ? `
        <h4 style="margin-top:18px;margin-bottom:8px">🕶️ Referencias sueltas del expositor (anotar a mano — no están en Sage)</h4>
        <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:10px">
          <ul class="resumen-otras-lista">
            ${sueltas.map(a => `
              <li>
                <span style="color:#6b7280;font-size:12px">${a.sheet_orden ? 'Lám.' + a.sheet_orden : '—'}</span>
                <b>${escape(a.referencia || '')}</b> · ${Number(a.cantidad) || 1} ud${(Number(a.cantidad) || 1) === 1 ? '' : 's'}
                <button class="resumen-borrar-mini" data-anot-id="${a.id}">×</button>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}

      ${sinProducto.length > 0 ? `
        <h4 style="margin-top:18px;margin-bottom:8px">📝 Otras anotaciones</h4>
        <ul class="resumen-otras-lista">
          ${sinProducto.map(a => `
            <li>
              <span style="color:#6b7280;font-size:12px">${a.sheet_orden ? 'Lám.' + a.sheet_orden : '—'}</span>
              ${escape(a.texto_libre || '')}
              <button class="resumen-borrar-mini" data-anot-id="${a.id}">×</button>
            </li>
          `).join('')}
        </ul>
      ` : ''}

      ${anotaciones.length === 0 ? `
        <div style="background:#fef3c7;border:1px solid #fcd34d;padding:14px;border-radius:8px;margin-top:10px;color:#78350f">
          ⚠️ Esta visita no tiene ninguna anotación. Si la cierras así, no se generará pedido.
        </div>
      ` : ''}

      <h4 style="margin-top:20px;margin-bottom:8px">📝 Notas generales de la visita</h4>
      <textarea id="resumen-notas" rows="2" placeholder="Observaciones para oficina y tu archivo personal…"
        style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit">${escape(_resumenPreEnvio.notas || '')}</textarea>

      <h4 style="margin-top:20px;margin-bottom:8px">📧 Envío al cliente</h4>
      <div class="form-group" style="margin-bottom:8px">
        <label style="font-size:13px;color:#374151">Email del cliente para esta visita</label>
        <input type="email" id="resumen-email-cliente" value="${escape(valorEmailCliente)}"
          ${_resumenPreEnvio.noEnviarCliente ? 'disabled' : ''}
          style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box"
          placeholder="cliente@email.com">
        <small style="color:#6b7280">${emailClienteActual ? 'Email registrado: ' + escape(emailClienteActual) : 'El cliente no tiene email registrado'}</small>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-top:8px">
        <input type="checkbox" id="resumen-no-enviar" ${_resumenPreEnvio.noEnviarCliente ? 'checked' : ''}>
        <span>No enviar email al cliente esta vez</span>
      </label>

      <div id="resumen-msg" style="margin-top:14px"></div>

      <div class="resumen-acciones">
        <button class="btn btn-secondary" onclick="cerrarResumenPreEnvio()">← Volver al visor</button>
        <button class="btn btn-primary" id="resumen-confirmar-btn" onclick="confirmarEnvioVisita()" style="font-size:15px;padding:12px 22px">
          ✅ Confirmar y enviar
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Enlazar eventos: editar cantidad
  overlay.querySelectorAll('.resumen-cant-input').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const anotId = Number(e.target.dataset.anotId);
      const nuevaCant = Math.max(1, Number(e.target.value) || 1);
      e.target.value = nuevaCant;
      const anot = _resumenPreEnvio.anotaciones.find(a => a.id === anotId);
      if (!anot) return;
      // Reconstruir el texto_libre con la nueva cantidad
      const codigo = anot.producto_codigo || '';
      const nombre = anot.producto_nombre || '';
      let texto = nuevaCant + ' uds · ' + codigo + ' ' + nombre;
      // mantener notas extra del texto_libre antiguo (lo que iba tras " · " adicional)
      try {
        await api('/api/annotations/' + anotId, {
          method: 'PUT',
          body: { texto_libre: texto, tipo: anot.tipo || 'pedido', cantidad: nuevaCant }
        });
        anot.cantidad = nuevaCant;
        anot.texto_libre = texto;
        // Recalcular subtotal y total
        actualizarSubtotalesResumen();
      } catch (err) {
        alert('Error guardando cambio: ' + err.message);
      }
    });
  });

  // Borrar línea (con producto)
  overlay.querySelectorAll('.resumen-borrar-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const anotId = Number(btn.dataset.anotId);
      if (!confirm('¿Quitar esta línea del pedido?')) return;
      try {
        await api('/api/annotations/' + anotId, { method: 'DELETE' });
        _resumenPreEnvio.anotaciones = _resumenPreEnvio.anotaciones.filter(a => a.id !== anotId);
        renderResumenPreEnvio();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });
  });

  // Borrar nota libre (mini)
  overlay.querySelectorAll('.resumen-borrar-mini').forEach(btn => {
    btn.addEventListener('click', async () => {
      const anotId = Number(btn.dataset.anotId);
      if (!confirm('¿Quitar esta anotación?')) return;
      try {
        await api('/api/annotations/' + anotId, { method: 'DELETE' });
        _resumenPreEnvio.anotaciones = _resumenPreEnvio.anotaciones.filter(a => a.id !== anotId);
        renderResumenPreEnvio();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });
  });

  // Checkbox no-enviar deshabilita el email input
  const $chkNoEnv = overlay.querySelector('#resumen-no-enviar');
  const $emailInput = overlay.querySelector('#resumen-email-cliente');
  $chkNoEnv.addEventListener('change', () => {
    _resumenPreEnvio.noEnviarCliente = $chkNoEnv.checked;
    $emailInput.disabled = $chkNoEnv.checked;
  });

  // Guardar notas y email en estado al editarlos
  overlay.querySelector('#resumen-notas').addEventListener('input', (e) => {
    _resumenPreEnvio.notas = e.target.value;
  });
  $emailInput.addEventListener('input', (e) => {
    _resumenPreEnvio.emailClienteOverride = e.target.value;
  });
}

function actualizarSubtotalesResumen() {
  const overlay = document.querySelector('.resumen-preenvio-overlay');
  if (!overlay) return;
  let total = 0;
  _resumenPreEnvio.anotaciones.filter(a => a.product_id).forEach(a => {
    const cant = Number(a.cantidad) || 0;
    const pvf = a.producto_pvf != null ? Number(a.producto_pvf) : 0;
    const sub = cant * pvf;
    total += sub;
    const fila = overlay.querySelector('tr[data-anot-id="' + a.id + '"]');
    if (fila) {
      const celda = fila.querySelector('.resumen-subtotal-celda');
      if (celda) celda.textContent = (pvf > 0 && cant > 0) ? sub.toFixed(2) + '€' : '—';
    }
  });
  const $tot = overlay.querySelector('#resumen-total');
  if ($tot) $tot.textContent = total.toFixed(2) + '€';
}

function cerrarResumenPreEnvio() {
  document.querySelectorAll('.resumen-preenvio-overlay').forEach(o => o.remove());
  _resumenPreEnvio = null;
}

async function confirmarEnvioVisita() {
  if (!_resumenPreEnvio) return;
  const $btn = document.getElementById('resumen-confirmar-btn');
  const $msg = document.getElementById('resumen-msg');
  if ($btn) { $btn.disabled = true; $btn.textContent = 'Enviando…'; }

  const notas = (document.getElementById('resumen-notas')?.value || '').trim();
  const emailOverride = (document.getElementById('resumen-email-cliente')?.value || '').trim();
  const noEnviar = !!document.getElementById('resumen-no-enviar')?.checked;
  const emailOriginal = _resumenPreEnvio.cliente?.email || '';
  const nombreCliente = _resumenPreEnvio.cliente?.razon_social || _resumenPreEnvio.cliente?.nombre_comercial || 'Cliente';
  const visitaIdLocal = _resumenPreEnvio.visitId;

  try {
    await api('/api/visits/' + _resumenPreEnvio.visitId + '/confirm', {
      method: 'POST',
      body: {
        notas_generales: notas,
        email_cliente_override: (emailOverride && emailOverride !== emailOriginal) ? emailOverride : null,
        no_enviar_cliente: noEnviar
      }
    });
    // Backup local del PDF en la tablet (async, no bloquea la UI)
    guardarPdfBackupLocal(visitaIdLocal, nombreCliente).catch(err => {
      console.warn('[backup] no se pudo guardar copia local:', err.message);
    });
    const visitaId = _resumenPreEnvio.visitId;
    cerrarResumenPreEnvio();
    appState.visitaActiva = null;
    appState.vista = 'clientes';
    appState.catalogoActual = null;
    appState.clienteActual = null;
    appState.visitaVerId = visitaId;
    render();
  } catch (err) {
    if ($msg) $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    if ($btn) { $btn.disabled = false; $btn.textContent = '✅ Confirmar y enviar'; }
  }
}

// ============================================================================
// BACKUP LOCAL DE PEDIDOS (File System Access API + fallback a Descargas)
// ============================================================================

// Sanitiza un nombre para usar como nombre de archivo
function _sanitizarNombreArchivo(nombre) {
  return (nombre || 'cliente')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 80);
}

// Genera el nombre del archivo PDF: NombreCliente_AAAA-MM-DD.pdf
function _nombreArchivoBackup(nombreCliente) {
  const ahora = new Date();
  const fecha = ahora.toISOString().substring(0, 10); // AAAA-MM-DD
  return `${_sanitizarNombreArchivo(nombreCliente)}_${fecha}.pdf`;
}

// IndexedDB helper para persistir el directoryHandle entre sesiones
const _BACKUP_DB_NAME = 'cpv2_backup';
const _BACKUP_STORE = 'fs_handles';

function _abrirBackupDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_BACKUP_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(_BACKUP_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _guardarHandleEnDB(handle) {
  const db = await _abrirBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([_BACKUP_STORE], 'readwrite');
    const store = tx.objectStore(_BACKUP_STORE);
    const req = store.put(handle, 'carpeta_pedidos');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function _leerHandleDeDB() {
  try {
    const db = await _abrirBackupDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([_BACKUP_STORE], 'readonly');
      const store = tx.objectStore(_BACKUP_STORE);
      const req = store.get('carpeta_pedidos');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

async function _borrarHandleDeDB() {
  try {
    const db = await _abrirBackupDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([_BACKUP_STORE], 'readwrite');
      const store = tx.objectStore(_BACKUP_STORE);
      const req = store.delete('carpeta_pedidos');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) { /* nada */ }
}

// Verifica que tenemos permiso de lectura/escritura sobre el handle (puede caducar)
async function _verificarPermiso(handle, modo = 'readwrite') {
  if (!handle) return false;
  try {
    const opts = { mode: modo };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch (e) {
    return false;
  }
}

// Pide al usuario que elija una carpeta (UI nativo del SO)
async function configurarCarpetaBackup() {
  if (!('showDirectoryPicker' in window)) {
    alert('Tu navegador no soporta selección de carpeta automática. Los PDFs se guardarán en la carpeta Descargas de Chrome.');
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents'
    });
    await _guardarHandleEnDB(handle);
    return handle;
  } catch (e) {
    if (e.name === 'AbortError') return null; // usuario canceló
    alert('Error eligiendo carpeta: ' + e.message);
    return null;
  }
}

// FUNCIÓN PRINCIPAL: descarga PDF de la visita y lo guarda en carpeta o Descargas
async function guardarPdfBackupLocal(visitId, nombreCliente) {
  // 1) Descargar el PDF del servidor
  const token = localStorage.getItem('cpv2_token') || '';
  const resp = await fetch(`/api/visits/${visitId}/pdf`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!resp.ok) throw new Error('No se pudo descargar PDF: ' + resp.status);
  const blob = await resp.blob();
  const nombreArchivo = _nombreArchivoBackup(nombreCliente);

  // 2) Intentar guardar en carpeta configurada (File System Access API)
  const handle = await _leerHandleDeDB();
  if (handle && ('createWritable' in (await handle.getDirectoryHandle?.bind(handle) || {}) || handle.getFileHandle)) {
    try {
      const ok = await _verificarPermiso(handle, 'readwrite');
      if (ok) {
        const fileHandle = await handle.getFileHandle(nombreArchivo, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        // Guardar metadato en localStorage (última copia)
        localStorage.setItem('cpv2_backup_ultimo', JSON.stringify({
          archivo: nombreArchivo, ts: Date.now()
        }));
        return { metodo: 'carpeta', archivo: nombreArchivo };
      }
    } catch (e) {
      console.warn('[backup] fallo carpeta, fallback Descargas:', e.message);
    }
  }

  // 3) Fallback: descarga normal a carpeta Descargas
  const urlBlob = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = urlBlob;
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(urlBlob), 5000);
  localStorage.setItem('cpv2_backup_ultimo', JSON.stringify({
    archivo: nombreArchivo, ts: Date.now()
  }));
  return { metodo: 'descargas', archivo: nombreArchivo };
}

// Lista PDFs guardados en la carpeta configurada
async function listarPdfsBackup() {
  const handle = await _leerHandleDeDB();
  if (!handle) return { error: 'sin_carpeta', archivos: [] };
  const ok = await _verificarPermiso(handle, 'read');
  if (!ok) return { error: 'sin_permiso', archivos: [] };
  const archivos = [];
  try {
    for await (const [nombre, fileHandle] of handle.entries()) {
      if (fileHandle.kind !== 'file') continue;
      if (!nombre.toLowerCase().endsWith('.pdf')) continue;
      const file = await fileHandle.getFile();
      archivos.push({
        nombre,
        tamano: file.size,
        modificado: file.lastModified,
        handle: fileHandle
      });
    }
    // Ordenar por fecha modificación descendente
    archivos.sort((a, b) => b.modificado - a.modificado);
    return { archivos };
  } catch (e) {
    return { error: e.message, archivos: [] };
  }
}

// Renderiza la pantalla "📁 Mis pedidos guardados"
async function renderMisPedidosGuardados() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando…</div></div>`;

  const handle = await _leerHandleDeDB();
  if (!handle) {
    $v.innerHTML = `
      <div class="contenedor" style="max-width:720px">
        <div class="titulo-pagina">
          <div>
            <h2>📁 Mis pedidos guardados</h2>
            <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
              Backup local de los pedidos en tu tablet.
            </div>
          </div>
        </div>
        <div class="editor-panel">
          <div style="text-align:center;padding:2rem">
            <div style="font-size:48px;margin-bottom:12px">📂</div>
            <h3 style="margin:0 0 8px 0">Configura la carpeta de backup</h3>
            <p style="color:var(--gris-texto);font-size:13px;margin:0 0 20px 0">
              Elige una carpeta (idealmente en la tarjeta SD) donde se guardará automáticamente una copia local de cada pedido que cierres.
            </p>
            <button class="btn btn-primary" onclick="configurarCarpetaYRecargar()">📁 Elegir carpeta</button>
            <p style="color:var(--gris-texto);font-size:11px;margin:14px 0 0 0">
              Si tu navegador no soporta selección de carpeta, los PDFs irán a Descargas de Chrome.
            </p>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const ok = await _verificarPermiso(handle, 'read');
  if (!ok) {
    $v.innerHTML = `
      <div class="contenedor" style="max-width:720px">
        <div class="titulo-pagina"><h2>📁 Mis pedidos guardados</h2></div>
        <div class="editor-panel">
          <div style="text-align:center;padding:2rem">
            <div style="font-size:48px;margin-bottom:12px">🔐</div>
            <h3>Necesito acceso a la carpeta</h3>
            <p style="color:var(--gris-texto);font-size:13px">
              El navegador ha cerrado el permiso (puede pasar tras varios meses). Vuelve a confirmar el acceso a la misma carpeta.
            </p>
            <button class="btn btn-primary" onclick="configurarCarpetaYRecargar()">🔓 Re-autorizar carpeta</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const { archivos } = await listarPdfsBackup();
  _backupArchivos = archivos;
  pintarListaPedidosBackup();
}

let _backupArchivos = [];
let _backupBusqueda = '';

function pintarListaPedidosBackup() {
  const $v = document.getElementById('vista-contenido');
  const filtrados = _backupBusqueda
    ? _backupArchivos.filter(a => a.nombre.toLowerCase().includes(_backupBusqueda.toLowerCase()))
    : _backupArchivos;

  $v.innerHTML = `
    <div class="contenedor" style="max-width:780px">
      <div class="titulo-pagina">
        <div>
          <h2>📁 Mis pedidos guardados ${ayuda('Lista de los PDFs de pedidos guardados en la tarjeta SD de tu tablet. Cada vez que cierras una visita, se guarda una copia local de respaldo aquí. Puedes verlos, enviarlos por email manual o compartirlos.')}</h2>
          <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
            ${_backupArchivos.length} pedido${_backupArchivos.length === 1 ? '' : 's'} en la carpeta de backup local
          </div>
        </div>
        <button class="btn btn-secondary btn-pequeno" onclick="configurarCarpetaYRecargar()" title="Cambiar carpeta">📂 Cambiar carpeta</button>
      </div>

      ${_backupArchivos.length > 0 ? `
        <div class="editor-panel" style="margin-bottom:12px;padding:10px">
          <input type="text" id="backup-busca" placeholder="🔍 Buscar (cliente o fecha AAAA-MM-DD)" value="${escape(_backupBusqueda)}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px">
        </div>
      ` : ''}

      <div class="editor-panel">
        ${filtrados.length === 0 ? `
          <div style="text-align:center;padding:2rem;color:var(--gris-texto);font-size:13px">
            ${_backupArchivos.length === 0
              ? '📭 Aún no hay pedidos guardados. Cierra una visita y aparecerá aquí.'
              : `Sin resultados para "${escape(_backupBusqueda)}"`}
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:6px">
            ${filtrados.map((a, idx) => {
              const fecha = new Date(a.modificado).toLocaleString('es-ES');
              const tamKB = (a.tamano / 1024).toFixed(0);
              return `
                <div class="backup-fila">
                  <div class="backup-icono">📄</div>
                  <div class="backup-info">
                    <div class="backup-nombre">${escape(a.nombre)}</div>
                    <div class="backup-meta">${fecha} · ${tamKB} KB</div>
                  </div>
                  <div class="backup-acciones">
                    <button class="btn btn-secondary btn-pequeno" onclick="verPdfBackup(${idx})" title="Ver">👁️</button>
                    <button class="btn btn-secondary btn-pequeno" onclick="enviarEmailPdfBackup(${idx})" title="Enviar por email">📧</button>
                    <button class="btn btn-secondary btn-pequeno" onclick="compartirPdfBackup(${idx})" title="Compartir">↗️</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;

  const $b = document.getElementById('backup-busca');
  if ($b) {
    let t;
    $b.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        _backupBusqueda = $b.value;
        pintarListaPedidosBackup();
      }, 200);
    });
  }
}

async function configurarCarpetaYRecargar() {
  const h = await configurarCarpetaBackup();
  if (h) {
    renderMisPedidosGuardados();
  }
}

async function verPdfBackup(idx) {
  const a = _backupArchivos[idx];
  if (!a) return;
  try {
    const file = await a.handle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    alert('Error abriendo PDF: ' + e.message);
  }
}

async function compartirPdfBackup(idx) {
  const a = _backupArchivos[idx];
  if (!a) return;
  try {
    const file = await a.handle.getFile();
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: a.nombre,
        text: 'Pedido ' + a.nombre
      });
    } else {
      alert('Tu navegador no soporta compartir archivos. Usa el botón Email o Ver.');
    }
  } catch (e) {
    if (e.name !== 'AbortError') alert('Error compartiendo: ' + e.message);
  }
}

async function enviarEmailPdfBackup(idx) {
  const a = _backupArchivos[idx];
  if (!a) return;
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:520px;width:95vw">
      <div class="modal-header">
        <h3 style="margin:0">📧 Enviar pedido por email</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:13px;color:#6b7280;margin:0 0 12px 0">
        Archivo: <b>${escape(a.nombre)}</b>
      </p>
      <div class="form-group">
        <label>Destinatario (email)</label>
        <input type="email" id="bk-email-dest" placeholder="cliente@ejemplo.com">
      </div>
      <div class="form-group">
        <label>Asunto</label>
        <input type="text" id="bk-email-asunto" value="Pedido LOMHIFAR · ${escape(a.nombre.replace(/\.pdf$/, ''))}">
      </div>
      <div class="form-group">
        <label>Mensaje</label>
        <textarea id="bk-email-msg" rows="4" placeholder="Mensaje opcional…">Hola,&#10;&#10;Adjunto el pedido en PDF.&#10;&#10;Un saludo.</textarea>
      </div>
      <div id="bk-email-msg-out"></div>
      <div class="modal-acciones">
        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button type="button" class="btn btn-primary" id="bk-email-btn" onclick="enviarEmailPdfBackupConfirmar(${idx})">📧 Enviar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function enviarEmailPdfBackupConfirmar(idx) {
  const a = _backupArchivos[idx];
  if (!a) return;
  const dest = (document.getElementById('bk-email-dest')?.value || '').trim();
  const asunto = (document.getElementById('bk-email-asunto')?.value || '').trim();
  const cuerpo = (document.getElementById('bk-email-msg')?.value || '').trim();
  const $out = document.getElementById('bk-email-msg-out');
  const $btn = document.getElementById('bk-email-btn');
  if (!dest || !dest.includes('@')) {
    $out.innerHTML = `<div class="error-msg">Email destinatario no válido</div>`;
    return;
  }
  $btn.disabled = true;
  $btn.textContent = 'Enviando…';
  try {
    const file = await a.handle.getFile();
    const fd = new FormData();
    fd.append('destinatario', dest);
    fd.append('asunto', asunto);
    fd.append('cuerpo', cuerpo);
    fd.append('adjunto', file, a.nombre);
    const token = localStorage.getItem('cpv2_token') || '';
    const resp = await fetch('/api/backup/enviar-email', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd
    });
    const json = await resp.json();
    if (!resp.ok || !json.success) throw new Error(json.error || 'Error ' + resp.status);
    $out.innerHTML = `<div class="exito-msg">✅ Email enviado correctamente</div>`;
    setTimeout(() => document.querySelector('.modal-bg')?.remove(), 1500);
  } catch (e) {
    $out.innerHTML = `<div class="error-msg">${escape(e.message)}</div>`;
    $btn.disabled = false;
    $btn.textContent = '📧 Enviar';
  }
}

// ----- DESCARTAR VISITA ACTIVA -----
async function descartarVisitaActiva() {
  if (!appState.visitaActiva) return;
  if (!confirm('¿Descartar la visita actual? Se perderán todas las anotaciones que has añadido.')) return;
  if (!confirm('Confirmación final: ¿seguro que quieres descartarla?')) return;
  try {
    await api('/api/visits/' + appState.visitaActiva.id + '/discard', { method: 'POST' });
    appState.visitaActiva = null;
    appState.vista = 'catalogos';
    appState.catalogoActual = null;
    render();
  } catch (err) {
    alert('Error al descartar: ' + err.message);
  }
}

// ----- AÑADIR / EDITAR / BORRAR ANOTACIONES -----

// Modal genérico para añadir anotación sobre una lámina
async function abrirModalAnotar(sheetId, sheetTitulo, sheetNumero) {
  if (!appState.visitaActiva) {
    alert('Para anotar, primero inicia una visita desde la ficha del cliente.');
    return;
  }
  // Cargar plantillas si aún no están en caché
  if (_plantillasCache === null) {
    await cargarPlantillas();
  }
  const tpls = _plantillasCache || [];

  // B7: detectar si viene con posición pendiente (long-press)
  const pinPos = window._pendingPinPos;
  window._pendingPinPos = null; // limpiar para que no afecte a la próxima
  const conPin = !!pinPos;
  // Modal completamente normal en cualquier modo (incluido pantalla completa)
  // El cliente ve un formulario profesional rutinario, sin avisos que generen sospechas.

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>${conPin ? '📍 Nuevo pin' : 'Anotar lámina ' + sheetNumero}</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div style="font-size:13px;color:var(--gris-texto);margin-bottom:8px">${escape(sheetTitulo || 'Sin título')}${conPin ? ' · pin posicionado' : ''}</div>
      <div id="modal-error"></div>
      <form id="form-anotar">
        <div class="form-group">
          <label>Tipo</label>
          <select id="anot-tipo">
            <option value="pedido">🛒 Pedido</option>
            <option value="devolucion">↩️ Devolución</option>
            <option value="nota">📝 Nota</option>
          </select>
        </div>
        ${tpls.length > 0 ? `
          <div class="form-group">
            <label style="display:flex;justify-content:space-between;align-items:center">
              <span>Plantillas rápidas</span>
              <span style="font-size:11px;color:var(--gris-texto);font-weight:normal">toca para insertar · arriba elige tipo o lo coge solo</span>
            </label>
            <div class="anot-chips-plantillas">
              ${tpls.map(t => {
                const ic = t.tipo === 'pedido' ? '🛒' : t.tipo === 'devolucion' ? '↩️' : '📝';
                return `<button type="button" class="chip-plantilla" data-tipo="${t.tipo}" data-texto="${escape(t.texto)}">${ic} ${escape(t.texto)}</button>`;
              }).join('')}
            </div>
          </div>
        ` : ''}
        <div class="form-group">
          <label>Texto</label>
          <textarea id="anot-texto" rows="3" required placeholder="Ej: 12+12 oferta · 6 cajas · revisar caducidad..."></textarea>
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => { const t = document.getElementById('anot-texto'); if (t) t.focus(); }, 50);

  // Click en chip de plantilla: inserta el texto y ajusta el tipo
  modal.querySelectorAll('.chip-plantilla').forEach(chip => {
    chip.addEventListener('click', () => {
      const txtArea = document.getElementById('anot-texto');
      const tipoSel = document.getElementById('anot-tipo');
      // Si el textarea está vacío -> reemplaza. Si tiene texto -> añade con separador " · "
      const actual = txtArea.value.trim();
      const nuevoFragmento = chip.dataset.texto;
      txtArea.value = actual ? (actual + ' · ' + nuevoFragmento) : nuevoFragmento;
      // Si el tipo aún es el default (pedido) y la plantilla tiene otro tipo, alinear el tipo
      // (solo cambia automáticamente si el textarea estaba vacío para no contradecir al usuario)
      if (!actual) {
        tipoSel.value = chip.dataset.tipo;
      }
      txtArea.focus();
    });
  });

  document.getElementById('form-anotar').addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = document.getElementById('anot-texto').value.trim();
    const tipo = document.getElementById('anot-tipo').value;
    if (!texto) return;
    try {
      const body = { sheet_id: sheetId, texto_libre: texto, tipo };
      if (conPin) { body.pos_x = pinPos.x; body.pos_y = pinPos.y; }
      await api('/api/visits/' + appState.visitaActiva.id + '/annotations', {
        method: 'POST',
        body
      });
      modal.remove();
      refrescarAnotacionesVisor(sheetId);
    } catch (err) {
      document.getElementById('modal-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

// Cache local de anotaciones por sheet_id de la visita actual (para no pegar a la API por cada repintado)
let _anotacionesVisita = {};

async function cargarAnotacionesDeVisita() {
  if (!appState.visitaActiva) { _anotacionesVisita = {}; return; }
  try {
    const r = await api('/api/visits/' + appState.visitaActiva.id);
    _anotacionesVisita = {};
    (r.annotations || []).forEach(a => {
      const sid = a.sheet_id;
      if (!_anotacionesVisita[sid]) _anotacionesVisita[sid] = [];
      _anotacionesVisita[sid].push(a);
    });
  } catch (e) {
    _anotacionesVisita = {};
  }
}

function refrescarAnotacionesVisor(sheetId) {
  // Pide al backend solo si hay visita activa, y vuelve a pintar el visor entero (más simple)
  cargarAnotacionesDeVisita().then(() => {
    if (typeof pintarVisor === 'function') pintarVisor();
    // pintarVisor ya refresca el carrito si está abierto; por si no se llamó, reforzamos:
    if (_carritoAbierto) renderCarritoContenido();
  });
}

// ============================================================================
// CARRITO DE LA VISITA — acceso rápido al pedido en curso (ver / editar / quitar
// líneas) sin perder el sitio en el catálogo. Reutiliza las anotaciones de la visita.
// ============================================================================
let _carritoAbierto = false;

function carritoContarLineas() {
  let n = 0;
  Object.keys(_anotacionesVisita || {}).forEach(sid => { n += (_anotacionesVisita[sid] || []).length; });
  return n;
}

function _carritoNumLamina(sheetId) {
  const i = (_visorSheets || []).findIndex(s => Number(s.id) === Number(sheetId));
  return i < 0 ? '?' : (i + 1);
}

function _carritoLineasOrdenadas() {
  const lineas = [];
  Object.keys(_anotacionesVisita || {}).forEach(sid => {
    (_anotacionesVisita[sid] || []).forEach(a => lineas.push(a));
  });
  const idxDe = (sheetId) => {
    const i = (_visorSheets || []).findIndex(s => Number(s.id) === Number(sheetId));
    return i < 0 ? 99999 : i;
  };
  lineas.sort((x, y) => (idxDe(x.sheet_id) - idxDe(y.sheet_id)) || ((x.orden_en_visita || 0) - (y.orden_en_visita || 0)));
  return lineas;
}

function abrirCarritoVisita() {
  if (!appState.visitaActiva) return;
  _carritoAbierto = true;
  let ov = document.getElementById('carrito-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'carrito-overlay';
    ov.className = 'carrito-overlay';
    document.body.appendChild(ov);
  }
  renderCarritoContenido();
}

function cerrarCarritoVisita() {
  _carritoAbierto = false;
  const ov = document.getElementById('carrito-overlay');
  if (ov) ov.remove();
}

function renderCarritoContenido() {
  const ov = document.getElementById('carrito-overlay');
  if (!ov) return;
  const lineas = _carritoLineasOrdenadas();
  const cliente = (appState.visitaActiva && appState.visitaActiva.cliente_nombre) ? appState.visitaActiva.cliente_nombre : 'cliente';
  const filas = lineas.length === 0
    ? `<div class="carrito-vacio">Todavía no has añadido nada al pedido.<br>Toca las zonas de las láminas o anota manualmente con ✏️.</div>`
    : lineas.map(a => {
        const icon = a.tipo === 'pedido' ? '🛒' : a.tipo === 'devolucion' ? '↩️' : '📝';
        const num = _carritoNumLamina(a.sheet_id);
        const textoJs = JSON.stringify(a.texto_libre || '').replace(/"/g, '&quot;');
        return `
          <div class="carrito-linea">
            <button class="carrito-linea-ir" onclick="carritoIrALamina(${a.sheet_id})" title="Ir a la lámina ${num}">
              <span class="carrito-linea-icon">${icon}</span>
              <span class="carrito-linea-num">Lám. ${num}</span>
            </button>
            <span class="carrito-linea-texto">${escape(a.texto_libre || '')}</span>
            <span class="carrito-linea-acc">
              <button class="carrito-btn" onclick="editarAnotacion(${a.id}, ${a.sheet_id}, ${textoJs}, '${a.tipo}')" title="Modificar">✏️</button>
              <button class="carrito-btn carrito-btn-quitar" onclick="borrarAnotacion(${a.id}, ${a.sheet_id})" title="Quitar del pedido">🗑️</button>
            </span>
          </div>`;
      }).join('');
  ov.innerHTML = `
    <div class="carrito-panel" onclick="event.stopPropagation()">
      <div class="carrito-header">
        <div class="carrito-titulo">🛒 Pedido de <b>${escape(cliente)}</b></div>
        <button class="carrito-cerrar" onclick="cerrarCarritoVisita()" title="Cerrar">✕</button>
      </div>
      <div class="carrito-sub">${lineas.length} línea${lineas.length === 1 ? '' : 's'}${lineas.length ? ' · pulsa una lámina para ir a ella' : ''}</div>
      <div class="carrito-lista">${filas}</div>
      <div class="carrito-footer">
        <button class="btn btn-secondary carrito-seguir" onclick="cerrarCarritoVisita()">← Seguir en el catálogo</button>
        <button class="btn btn-primary" onclick="cerrarCarritoVisita(); cerrarVisitaActiva()">Cerrar visita y enviar →</button>
      </div>
    </div>`;
  ov.onclick = () => cerrarCarritoVisita();
}

function carritoIrALamina(sheetId) {
  const i = (_visorSheets || []).findIndex(s => Number(s.id) === Number(sheetId));
  cerrarCarritoVisita();
  if (i < 0) return;
  // Limpiar filtros para que visorIndice (que indexa la lista visible) apunte a la lámina exacta
  appState.visorBusqueda = '';
  appState.visorFiltroCat = null;
  appState.visorModo = 'presentacion';
  appState.visorIndice = i;
  appState.visorZoom = 1; appState.visorPanX = 0; appState.visorPanY = 0;
  pintarVisor();
}

async function borrarAnotacion(anotId, sheetId) {
  if (!confirm('¿Borrar esta anotación?')) return;
  try {
    await api('/api/annotations/' + anotId, { method: 'DELETE' });
    refrescarAnotacionesVisor(sheetId);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function editarAnotacion(anotId, sheetId, textoActual, tipoActual) {
  const nuevo = prompt('Editar texto de la anotación:', textoActual);
  if (nuevo === null) return;
  const t = String(nuevo).trim();
  if (!t) return;
  try {
    await api('/api/annotations/' + anotId, {
      method: 'PUT',
      body: { texto_libre: t, tipo: tipoActual }
    });
    refrescarAnotacionesVisor(sheetId);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ----- RENDER DETALLE DE UNA VISITA (pasada o recién cerrada) -----
async function renderDetalleVisita(visitId) {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando visita…</div></div>`;
  try {
    const r = await api('/api/visits/' + visitId);
    const v = r.visit;
    const anots = r.annotations || [];
    const fecha = new Date(v.created_at).toLocaleString('es-ES');
    const cerrada = v.confirmed_at ? new Date(v.confirmed_at).toLocaleString('es-ES') : null;
    const statusBadge = v.status === 'draft'
      ? '<span class="visita-badge visita-badge-draft">borrador</span>'
      : v.status === 'confirmed'
        ? '<span class="visita-badge visita-badge-confirmed">cerrada</span>'
        : '<span class="visita-badge">enviada</span>';

    // C: cargar log de emails (solo si visita confirmada)
    let emailsLog = [];
    if (v.status === 'confirmed' || v.status === 'sent') {
      try {
        const re = await api('/api/visits/' + visitId + '/emails');
        emailsLog = re.emails || [];
      } catch (_) {}
    }

    let html = `
      <div class="contenedor">
        <div class="titulo-pagina">
          <div>
            <button class="btn btn-secondary btn-pequeno" onclick="volverDesdeVisita(${v.client_id})">← Volver al cliente</button>
            <h2 style="margin-top:8px">Visita del ${escape(fecha)} ${statusBadge}</h2>
            <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
              Cliente: <b>${escape(v.cliente_nombre || ('#' + v.client_id))}</b>
              · Comercial: ${escape(v.comercial_nombre || '?')}
              · Catálogo: ${escape(v.catalog_nombre || '—')}
              ${cerrada ? ` · Cerrada: ${escape(cerrada)}` : ''}
            </div>
          </div>
          <div style="display:flex; gap:6px; align-self:flex-start; flex-wrap:wrap">
            <button class="btn btn-primary btn-pequeno" onclick="descargarPdfVisita(${v.id})">📄 Descargar PDF</button>
            ${(v.status === 'confirmed' || v.status === 'sent') ? `<button class="btn btn-secondary btn-pequeno" onclick="reenviarEmailsVisita(${v.id})">📧 Reenviar emails</button>` : ''}
            ${(v.status === 'confirmed' || v.status === 'sent') ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirModalReenviarOtro(${v.id}, ${v.client_id})">✉️ Enviar a otro email</button>` : ''}
          </div>
        </div>

        ${v.notas_generales ? `
          <div class="editor-panel" style="margin-bottom:16px">
            <h3>Notas generales</h3>
            <p style="white-space:pre-wrap; font-size:14px">${escape(v.notas_generales)}</p>
          </div>
        ` : ''}

        ${(v.status === 'confirmed' || v.status === 'sent') ? `
          <div class="editor-panel" style="margin-bottom:16px">
            <h3>📧 Emails enviados (${emailsLog.length})</h3>
            ${emailsLog.length === 0
              ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">Aún no hay emails registrados. Si la visita se cerró hace poco, espera unos segundos y refresca la página.</p>`
              : `<div class="emails-lista">
                  ${emailsLog.map(e => {
                    const rolIcon = e.rol === 'oficina' ? '🏢' : e.rol === 'cliente' ? '👤' : '👨‍💼';
                    const okBadge = e.ok ? '<span class="email-badge email-badge-ok">✓ enviado</span>' : '<span class="email-badge email-badge-fail">✗ falló</span>';
                    const modoBadge = e.modo === 'pruebas' ? '<span class="email-badge email-badge-pruebas">🔴 prueba</span>' : '<span class="email-badge email-badge-prod">🟢 prod</span>';
                    const fechaE = new Date(e.sent_at).toLocaleString('es-ES');
                    return `
                      <div class="email-fila ${e.ok ? '' : 'email-fila-error'}">
                        <div style="font-size:18px">${rolIcon}</div>
                        <div style="flex:1;min-width:0">
                          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px">
                            <b style="font-size:13px">${escape(e.rol)}</b>
                            ${okBadge} ${modoBadge}
                          </div>
                          <div style="font-size:12px;color:#444">→ <b>${escape(e.destinatario)}</b>${e.destinatario_real && e.destinatario_real !== e.destinatario ? ` <span style="color:#888">(real: ${escape(e.destinatario_real)})</span>` : ''}</div>
                          ${e.asunto ? `<div style="font-size:11px;color:#666;margin-top:2px">${escape(e.asunto)}</div>` : ''}
                          ${e.error ? `<div style="font-size:11px;color:#c00;margin-top:4px;background:#fee;padding:4px 6px;border-radius:4px">⚠️ ${escape(e.error)}</div>` : ''}
                          <div style="font-size:10px;color:#999;margin-top:2px">${escape(fechaE)}</div>
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>`
            }
          </div>
        ` : ''}

        <div class="editor-panel">
          <h3>Anotaciones (${anots.length})</h3>
          ${anots.length === 0
            ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">No hay anotaciones en esta visita.</p>`
            : anots.map(a => {
              const tipoIcon = a.tipo === 'pedido' ? '🛒' : a.tipo === 'devolucion' ? '↩️' : '📝';
              return `
                <div class="anot-fila">
                  ${a.sheet_imagen ? `<img src="${escape(a.sheet_imagen)}" class="lamina-mini" onclick="abrirLightbox('${escape(a.sheet_imagen)}','${escape((a.sheet_titulo || 'Lámina').replace(/'/g,'\\\''))}', ${a.sheet_orden || 0})">` : `<div class="lamina-mini" style="background:#eee"></div>`}
                  <div class="anot-info">
                    <div class="anot-titulo">${tipoIcon} ${escape(a.sheet_titulo || ('Lámina #' + (a.sheet_orden || '?')))}</div>
                    <div class="anot-texto">${escape(a.texto_libre)}</div>
                  </div>
                </div>
              `;
            }).join('')
          }
        </div>
      </div>
    `;
    $v.innerHTML = html;
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

async function reenviarEmailsVisita(visitId) {
  if (!confirm('¿Reenviar los 3 emails de esta visita?\n\nSe volverán a enviar al destinatario actual (depende del modo Pruebas/Producción).')) return;
  try {
    await api('/api/visits/' + visitId + '/resend-emails', { method: 'POST' });
    alert('✅ Reenvío en curso. Refresca la página en unos segundos para ver el resultado.');
    // Refrescar tras 3 segundos para que dé tiempo a que se actualice el log
    setTimeout(() => renderDetalleVisita(visitId), 3000);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Modal: reenviar el email del cliente a una direccion puntual.
// Caso de uso: el cliente llama y dice "no me ha llegado, mándalo a X@Y.com".
async function abrirModalReenviarOtro(visitId, clientId) {
  // Cargar email_alternativo actual del cliente para pre-rellenar
  let alternativoActual = '';
  let nombreCliente = '';
  try {
    const r = await api('/api/clients/' + clientId);
    alternativoActual = (r.client && r.client.email_alternativo) || '';
    nombreCliente = (r.client && r.client.razon_social) || '';
  } catch (_) {}

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>✉️ Enviar a otro email</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      ${nombreCliente ? `<div style="font-size:13px;color:var(--gris-texto);margin-bottom:8px">Cliente: <b>${escape(nombreCliente)}</b></div>` : ''}
      <p style="font-size:13px;color:#444;margin-bottom:12px">
        Se enviará el resumen de la visita (con el PDF adjunto) a la dirección que indiques.
        Útil cuando el cliente llama diciendo que no le ha llegado al correo habitual.
      </p>
      <div id="modal-error"></div>
      <form id="form-reenviar-otro">
        <div class="form-group">
          <label>Email destinatario</label>
          <input type="email" id="reenv-email" required placeholder="cliente@otra-direccion.com"
                 value="${escape(alternativoActual)}">
          ${alternativoActual ? `<div style="font-size:11px;color:var(--gris-texto);margin-top:4px">📌 Pre-rellenado con el "email alternativo" actual del cliente</div>` : ''}
        </div>
        <div class="form-group">
          <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
            <input type="checkbox" id="reenv-guardar" checked style="margin-top:3px;width:18px;height:18px;flex-shrink:0">
            <span>
              💾 <b>Guardar este email para futuras visitas</b> con este cliente
              <div style="font-size:11px;color:var(--gris-texto);font-weight:normal;margin-top:2px">
                Se guardará en el campo "email alternativo" del cliente. La próxima visita irá automáticamente a esta dirección además del email principal del Sage.
              </div>
            </span>
          </label>
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">📧 Enviar</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => { const i = document.getElementById('reenv-email'); if (i && !alternativoActual) i.focus(); }, 50);

  document.getElementById('form-reenviar-otro').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('reenv-email').value.trim();
    const guardar = document.getElementById('reenv-guardar').checked;
    if (!email) return;
    const $err = document.getElementById('modal-error');
    $err.innerHTML = `<div style="background:#eff6ff;color:#1e3a8a;padding:8px;border-radius:6px;font-size:13px">Enviando…</div>`;
    try {
      const r = await api('/api/visits/' + visitId + '/resend-to-custom', {
        method: 'POST',
        body: { email, guardar_en_cliente: guardar }
      });
      modal.remove();
      let msg = '✅ Email reenviado correctamente a ' + (r.destinatario || email);
      if (r.modo === 'pruebas') msg += '\n\n⚠️ Estás en MODO PRUEBAS — el destinatario real (' + email + ') NO ha recibido nada. Llegó al email de prueba configurado.';
      if (r.guardado) msg += '\n\n💾 Guardado como email alternativo del cliente para futuras visitas.';
      alert(msg);
      setTimeout(() => renderDetalleVisita(visitId), 1500);
    } catch (err) {
      $err.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

function abrirDetalleVisita(visitId) {
  appState.vista = 'clientes';
  appState.catalogoActual = null;
  appState.clienteActual = null;
  appState.visitaVerId = visitId;
  render();
}

function volverDesdeVisita(clientId) {
  appState.visitaVerId = null;
  appState.clienteActual = clientId;
  render();
}

// D: descargar PDF de visita
async function descargarPdfVisita(visitId) {
  try {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (impersonating && user && user.role === 'admin') {
      headers['X-Impersonate-User'] = String(impersonating.id);
    }
    const r = await fetch('/api/visits/' + visitId + '/pdf', { headers });
    if (!r.ok) {
      const txt = await r.text();
      try { const data = JSON.parse(txt); throw new Error(data.error || 'Error ' + r.status); }
      catch(e) { throw new Error('Error ' + r.status); }
    }
    // Obtener filename de Content-Disposition si existe
    const cd = r.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : ('visita_' + visitId + '.pdf');
    const blob = await r.blob();
    // Forzar descarga
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);
  } catch (err) {
    alert('Error al descargar PDF: ' + err.message);
  }
}

// ============================================================================
// ===== FASE 1 - PRODUCTOS (catálogo maestro + importador Sage + expositores) =====
// ============================================================================

let _productosState = {
  tipo: 'todos',       // 'todos' | 'sage' | 'comercial'
  activo: 'true',      // 'true' | 'false' | 'todos'
  q: '',
  productos: [],
  total: 0,
  loading: false
};

async function renderListaProductos() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `
    <div class="contenedor">
      <div class="titulo-pagina">
        <div>
          <h2>📦 Productos</h2>
          <div style="font-size:12px;color:var(--gris-texto);margin-top:4px">
            Catálogo maestro de productos. Sirve para vincular láminas y emitir pedidos con códigos exactos.
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-secondary btn-pequeno" onclick="abrirModalImportarProductos()">📊 Importar Excel Sage</button>${ayuda('Sube el Excel exportado de Sage. Detecta productos nuevos, cambios de precio y bajas. Muestra un resumen ANTES de aplicar para que revises los cambios. Idempotente: puedes subir el mismo Excel varias veces sin duplicar.')}
          <button class="btn btn-primary btn-pequeno" onclick="abrirModalNuevoProducto()">+ Nuevo (expositor/promo)</button>${ayuda('Crea productos manuales que no vienen del Excel de Sage (expositores, promociones internas, etc).')}
        </div>
      </div>

      <!-- Filtros -->
      <div class="planning-filtros">
        <div class="planning-chips-row">
          <button class="planning-chip ${_productosState.tipo === 'todos' ? 'planning-chip-activo' : ''}" onclick="cambiarFiltroProductos('tipo','todos')">Todos los tipos</button>
          <button class="planning-chip ${_productosState.tipo === 'sage' ? 'planning-chip-activo' : ''}" onclick="cambiarFiltroProductos('tipo','sage')">🏷️ Sage</button>
          <button class="planning-chip ${_productosState.tipo === 'comercial' ? 'planning-chip-activo' : ''}" onclick="cambiarFiltroProductos('tipo','comercial')">🎁 Expositores/Promos</button>
        </div>
        <div class="planning-chips-row">
          <button class="planning-chip ${_productosState.activo === 'true' ? 'planning-chip-activo' : ''}" onclick="cambiarFiltroProductos('activo','true')">✅ Activos</button>
          <button class="planning-chip ${_productosState.activo === 'false' ? 'planning-chip-activo' : ''}" onclick="cambiarFiltroProductos('activo','false')">⚠️ Descatalogados</button>
          <button class="planning-chip ${_productosState.activo === 'todos' ? 'planning-chip-activo' : ''}" onclick="cambiarFiltroProductos('activo','todos')">📋 Todos</button>
        </div>
        <div class="planning-inputs-row">
          <input type="text" id="productos-q" class="planning-input" placeholder="🔍 Buscar por código, nombre, EAN, marca…" value="${escape(_productosState.q)}">
        </div>
      </div>

      <div id="productos-resultado"><div class="loading">Cargando…</div></div>
    </div>
  `;

  // Listener búsqueda con debounce
  const $q = document.getElementById('productos-q');
  if ($q) {
    let t;
    $q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        _productosState.q = $q.value.trim();
        recargarProductos();
      }, 350);
    });
  }

  await recargarProductos();
}

function cambiarFiltroProductos(campo, valor) {
  _productosState[campo] = valor;
  renderListaProductos(); // re-pinta el shell con chips actualizados
}

async function recargarProductos() {
  const $res = document.getElementById('productos-resultado');
  if ($res) $res.innerHTML = '<div class="loading">Cargando…</div>';
  try {
    const params = new URLSearchParams();
    params.set('tipo', _productosState.tipo);
    params.set('activo', _productosState.activo);
    if (_productosState.q) params.set('q', _productosState.q);
    params.set('limit', '500');
    const r = await api('/api/products?' + params.toString());
    _productosState.productos = r.products || [];
    _productosState.total = r.total || 0;
    pintarListaProductos();
  } catch (err) {
    if ($res) $res.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

function pintarListaProductos() {
  const $res = document.getElementById('productos-resultado');
  if (!$res) return;
  const productos = _productosState.productos;
  const total = _productosState.total;

  if (productos.length === 0) {
    $res.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icono">📦</div>
        <h3>${_productosState.q ? 'Sin resultados' : 'No hay productos todavía'}</h3>
        <p>${_productosState.q
          ? 'Prueba con otra búsqueda o cambia los filtros.'
          : 'Importa el Excel de Sage para empezar, o crea expositores manualmente.'}</p>
      </div>
    `;
    return;
  }

  const filas = productos.map(p => {
    const badge = p.tipo === 'sage'
      ? `<span class="prod-badge prod-badge-sage" title="Producto de Sage">🏷️ Sage</span>`
      : `<span class="prod-badge prod-badge-comercial" title="Expositor o promo creado manualmente">🎁 Promo</span>`;
    const inactiveCls = !p.activo ? ' producto-fila-inactivo' : '';
    return `
      <div class="producto-fila${inactiveCls}" onclick="abrirDetalleProducto(${p.id})">
        ${badge}
        <div class="producto-codigo">${escape(p.codigo)}</div>
        <div class="producto-info">
          <div class="producto-nombre">${escape(p.nombre)}${!p.activo ? ' <span style="color:#dc2626;font-size:11px">(descatalogado)</span>' : ''}</div>
          <div class="producto-meta">
            ${p.ean ? `<span>EAN: ${escape(p.ean)}</span>` : ''}
            ${p.marca ? `<span>· ${escape(p.marca)}</span>` : ''}
            ${p.categoria ? `<span>· ${escape(p.categoria)}</span>` : ''}
          </div>
        </div>
        <div class="producto-precios">
          ${p.precio_pvp != null ? `<div class="producto-precio-pvp">PVP ${Number(p.precio_pvp).toFixed(2)}€</div>` : ''}
          ${p.precio_pvf != null ? `<div class="producto-precio-pvf">PVF ${Number(p.precio_pvf).toFixed(2)}€</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  $res.innerHTML = `
    <div style="font-size:13px;color:var(--gris-texto);margin-bottom:8px">
      ${productos.length}${total > productos.length ? '/' + total : ''} productos
    </div>
    <div class="productos-lista">${filas}</div>
  `;
}

// Modal de detalle/edición de producto
async function abrirDetalleProducto(id) {
  try {
    const r = await api('/api/products/' + id);
    const p = r.product;
    const history = r.price_history || [];
    const esExpositor = p.tipo === 'comercial';
    const modal = document.createElement('div');
    modal.className = 'modal-bg';
    modal.innerHTML = `
      <div class="modal-card modal-card-ancho">
        <div class="modal-header">
          <h3>${esExpositor ? '🎁' : '🏷️'} ${escape(p.nombre)} <span style="font-size:11px;color:#9ca3af;font-weight:400">✥ arrastra para mover</span></h3>
          <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
        </div>
        <div class="form-group">
          <label>Código ${esExpositor ? '(interno)' : 'Sage'}</label>
          <input type="text" id="prod-codigo" value="${escape(p.codigo)}" ${!esExpositor ? 'readonly' : ''}>
        </div>
        <div class="form-group">
          <label>Nombre completo</label>
          <input type="text" id="prod-nombre" value="${escape(p.nombre)}">
        </div>
        <div class="form-group">
          <label>Descripción <span style="color:var(--gris-texto);font-weight:normal">(opcional, para corregir/ampliar)</span></label>
          <textarea id="prod-descripcion" rows="2" placeholder="Descripción del producto">${escape(p.descripcion || '')}</textarea>
          ${!esExpositor ? `<small style="color:#b45309">⚠️ Este producto viene de Sage: si editas su texto, la próxima sincronización lo sobrescribirá. Para textos fijos usa un producto comercial.</small>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-group">
            <label>EAN / Cód. nacional</label>
            <input type="text" id="prod-ean" value="${escape(p.ean || '')}">
          </div>
          <div class="form-group">
            <label>Marca</label>
            <input type="text" id="prod-marca" value="${escape(p.marca || '')}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-group">
            <label>PVP (€)</label>
            <input type="number" step="0.01" id="prod-pvp" value="${p.precio_pvp || ''}">
          </div>
          <div class="form-group">
            <label>PVF / PVL (€)</label>
            <input type="number" step="0.01" id="prod-pvf" value="${p.precio_pvf || ''}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-group">
            <label>Categoría</label>
            <input type="text" id="prod-categoria" value="${escape(p.categoria || '')}">
          </div>
          <div class="form-group">
            <label>Familia</label>
            <input type="text" id="prod-familia" value="${escape(p.familia || '')}">
          </div>
        </div>
        ${esExpositor ? `
          <div class="form-group">
            <label>Notas para administración <span style="color:var(--gris-texto);font-weight:normal">(opcional)</span></label>
            <textarea id="prod-notas-admin" rows="2" placeholder="Ej: Equivale a 24 unidades del código Sage 12345">${escape(p.notas_admin || '')}</textarea>
          </div>
        ` : ''}
        <div class="form-group">
          <label>
            <input type="checkbox" id="prod-activo" ${p.activo ? 'checked' : ''}>
            Activo
          </label>
        </div>

        ${history.length > 0 ? `
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gris-borde)">
            <h4 style="margin:0 0 8px">📈 Historial de cambios de precio</h4>
            <div style="max-height:160px;overflow-y:auto;font-size:12px">
              ${history.map(h => `
                <div style="padding:6px 0;border-bottom:1px solid #f3f4f6">
                  📅 ${escape(new Date(h.changed_at).toLocaleString('es-ES'))} · ${escape(h.origen)}
                  ${h.precio_pvp_old != null || h.precio_pvp_new != null ? `<br>PVP: ${h.precio_pvp_old != null ? Number(h.precio_pvp_old).toFixed(2) + '€' : '—'} → ${h.precio_pvp_new != null ? Number(h.precio_pvp_new).toFixed(2) + '€' : '—'}` : ''}
                  ${h.precio_pvf_old != null || h.precio_pvf_new != null ? `<br>PVF: ${h.precio_pvf_old != null ? Number(h.precio_pvf_old).toFixed(2) + '€' : '—'} → ${h.precio_pvf_new != null ? Number(h.precio_pvf_new).toFixed(2) + '€' : '—'}` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div id="prod-error"></div>
        <div class="modal-acciones">
          <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button class="btn" style="background:#0ea5e9;color:#fff" onclick="duplicarProductoActual(${p.id})" title="Crear un producto nuevo copiando estos datos (para gafas de sol, packs con solo el modelo distinto…)">⧉ Duplicar</button>
          <button class="btn btn-primary" onclick="guardarProducto(${p.id})">💾 Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    // Ventana FLOTANTE + arrastrable: fondo transparente y sin bloquear, para poder
    // ver/leer la lámina de debajo mientras se modifican los datos del producto.
    modal.style.background = 'transparent';
    modal.style.pointerEvents = 'none';
    const cardEl = modal.querySelector('.modal-card');
    const headerEl = modal.querySelector('.modal-header');
    if (cardEl) {
      cardEl.style.pointerEvents = 'auto';
      cardEl.style.boxShadow = '0 12px 45px rgba(0,0,0,0.35)';
      cardEl.style.border = '1px solid #e5e7eb';
    }
    if (typeof hacerVentanaArrastrable === 'function') hacerVentanaArrastrable(cardEl, headerEl);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function guardarProducto(id) {
  const $err = document.getElementById('prod-error');
  $err.innerHTML = '';
  try {
    const $desc = document.getElementById('prod-descripcion');
    const body = {
      codigo: document.getElementById('prod-codigo').value.trim(),
      nombre: document.getElementById('prod-nombre').value.trim(),
      descripcion: $desc ? ($desc.value.trim() || null) : undefined,
      ean: document.getElementById('prod-ean').value.trim() || null,
      precio_pvp: document.getElementById('prod-pvp').value || null,
      precio_pvf: document.getElementById('prod-pvf').value || null,
      categoria: document.getElementById('prod-categoria').value.trim() || null,
      familia: document.getElementById('prod-familia').value.trim() || null,
      marca: document.getElementById('prod-marca').value.trim() || null,
      activo: document.getElementById('prod-activo').checked
    };
    const $notas = document.getElementById('prod-notas-admin');
    if ($notas) body.notas_admin = $notas.value.trim() || null;
    await api('/api/products/' + id, { method: 'PUT', body });
    // Si el editor de zonas está abierto, refrescar en el acto los datos de TODAS las
    // zonas que usan este producto (la panel derecha mostraba datos cacheados antiguos).
    if (typeof _zonasEditor !== 'undefined' && _zonasEditor && Array.isArray(_zonasEditor.zonas)) {
      let tocado = false;
      _zonasEditor.zonas.forEach(z => {
        if (Number(z.product_id) === Number(id)) {
          z.producto_codigo = body.codigo;
          z.producto_nombre = body.nombre;
          z.producto_ean = body.ean;
          if (body.precio_pvf != null && body.precio_pvf !== '') z.producto_pvf = body.precio_pvf;
          tocado = true;
        }
      });
      if (tocado) {
        if (typeof renderListaZonas === 'function') renderListaZonas();
        if (typeof renderZonasEnCapa === 'function') renderZonasEnCapa();
      }
      // Si hay una zona-FAMILIA seleccionada, refrescar su preview (el producto editado
      // puede ser un miembro de la familia y su precio/nombre debe verse actualizado).
      const selZona = _zonasEditor.zonas.find(z => String(z.id) === String(_zonasEditor.zonaSeleccionadaId));
      if (selZona && (selZona.familia_ref || (Array.isArray(selZona.familia_skus) && selZona.familia_skus.length))
          && typeof cargarPreviewFamiliaAdmin === 'function') {
        cargarPreviewFamiliaAdmin(selZona);
      }
    }
    // Cerrar modal y recargar
    const $modal = document.querySelector('.modal-bg');
    if ($modal) $modal.remove();
    if (typeof recargarProductos === 'function') recargarProductos();
    mostrarNotificacionOnline('✅ Producto actualizado', '#16a34a');
  } catch (err) {
    $err.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

// prefill (opcional) rellena los campos al DUPLICAR un producto existente.
function abrirModalNuevoProducto(prefill) {
  const p = prefill || {};
  const esDup = !!prefill;
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>${esDup ? '⧉ Duplicar producto' : '🎁 Nuevo expositor / promo'}</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:13px;color:var(--gris-texto);margin-bottom:12px">
        ${esDup
          ? 'Copia de otro producto. <b>Cambia el código (debe ser único)</b> y lo que varíe (p. ej. el modelo), y crea.'
          : 'Crea un producto que <b>no está en Sage</b> (expositores, packs, gafas de sol…). Define un código interno único.'}
      </p>
      <div class="form-group">
        <label>Código interno *</label>
        <input type="text" id="new-prod-codigo" value="${escape(p.codigo || '')}" placeholder="Ej: EXPO-GEL-24" required>
        <small style="color:var(--gris-texto)">${esDup ? '⚠️ Debe ser DISTINTO al original.' : 'Algo único. Sugerencia: EXPO-XXX o PROMO-XXX.'}</small>
      </div>
      <div class="form-group">
        <label>Nombre completo *</label>
        <input type="text" id="new-prod-nombre" value="${escape(p.nombre || '')}" placeholder="Ej: GAFA SOL ADULTOS MODELO X" required>
      </div>
      <div class="form-group">
        <label>Descripción <span style="color:var(--gris-texto);font-weight:normal">(opcional)</span></label>
        <textarea id="new-prod-descripcion" rows="2" placeholder="Descripción del producto">${escape(p.descripcion || '')}</textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group">
          <label>EAN / Cód. nacional</label>
          <input type="text" id="new-prod-ean" value="${escape(p.ean || '')}">
        </div>
        <div class="form-group">
          <label>Marca</label>
          <input type="text" id="new-prod-marca" value="${escape(p.marca || '')}">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group">
          <label>PVP orientativo (€)</label>
          <input type="number" step="0.01" id="new-prod-pvp" value="${p.precio_pvp || ''}">
        </div>
        <div class="form-group">
          <label>PVF / PVL (€)</label>
          <input type="number" step="0.01" id="new-prod-pvf" value="${p.precio_pvf || ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Notas para administración <span style="color:var(--gris-texto);font-weight:normal">(opcional)</span></label>
        <textarea id="new-prod-notas-admin" rows="2" placeholder="Ej: Equivale a 24 unidades del código Sage 12345">${escape(p.notas_admin || '')}</textarea>
      </div>
      <div id="new-prod-error"></div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="crearNuevoProducto()">${esDup ? '+ Crear copia' : '+ Crear'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Al duplicar, foco en el código (lo primero que hay que cambiar); si es nuevo, igual
  setTimeout(() => { const c = document.getElementById('new-prod-codigo'); if (c) { c.focus(); if (esDup) c.select(); } }, 50);
}

// Desde la ventana de detalle: recarga los datos del producto y abre el duplicar.
async function duplicarProductoActual(id) {
  try {
    const r = await api('/api/products/' + id);
    document.querySelectorAll('.modal-bg').forEach(m => m.remove()); // cerrar el detalle
    duplicarProducto(r.product);
  } catch (e) {
    alert('Error al duplicar: ' + e.message);
  }
}

// Duplica un producto existente: abre el crear-nuevo con sus datos ya rellenos.
function duplicarProducto(p) {
  abrirModalNuevoProducto({
    codigo: (p.codigo || '') + '-2',   // punto de partida; el usuario lo cambia
    nombre: p.nombre || '',
    descripcion: p.descripcion || '',
    ean: p.ean || '',
    marca: p.marca || '',
    precio_pvp: p.precio_pvp || '',
    precio_pvf: p.precio_pvf || '',
    notas_admin: p.notas_admin || ''
  });
}

async function crearNuevoProducto() {
  const $err = document.getElementById('new-prod-error');
  $err.innerHTML = '';
  const codigo = document.getElementById('new-prod-codigo').value.trim();
  const nombre = document.getElementById('new-prod-nombre').value.trim();
  if (!codigo || !nombre) {
    $err.innerHTML = `<div class="error-msg">Código y nombre son obligatorios.</div>`;
    return;
  }
  try {
    const $d = document.getElementById('new-prod-descripcion');
    const $e = document.getElementById('new-prod-ean');
    const $m = document.getElementById('new-prod-marca');
    await api('/api/products', {
      method: 'POST',
      body: {
        codigo,
        nombre,
        descripcion: $d ? ($d.value.trim() || null) : null,
        ean: $e ? ($e.value.trim() || null) : null,
        marca: $m ? ($m.value.trim() || null) : null,
        precio_pvp: document.getElementById('new-prod-pvp').value || null,
        precio_pvf: document.getElementById('new-prod-pvf').value || null,
        notas_admin: document.getElementById('new-prod-notas-admin').value.trim() || null,
        tipo: 'comercial'
      }
    });
    document.querySelector('.modal-bg').remove();
    recargarProductos();
    mostrarNotificacionOnline('✅ Producto creado', '#16a34a');
  } catch (err) {
    $err.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

// Modal de importación Excel Sage con PRE-REVISIÓN
function abrirModalImportarProductos() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>📊 Importar Excel de Sage</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:13px;color:var(--gris-texto);margin-bottom:12px">
        Sube el Excel exportado de Sage con tus productos. Antes de aplicar nada, te enseñaré un <b>resumen</b> de qué va a cambiar.
      </p>
      <p style="font-size:12px;color:var(--gris-texto);margin-bottom:12px">
        El sistema detecta automáticamente columnas con nombres tipo: <code>codigo, nombre, ean, pvp, pvf, categoria, familia, marca</code>.
      </p>
      <div class="form-group">
        <label>Archivo Excel (.xlsx)</label>
        <input type="file" id="excel-prod-file" accept=".xlsx,.xls">
      </div>
      <div id="imp-prod-msg"></div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="subirExcelProductosPreview()">📋 Analizar Excel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function subirExcelProductosPreview() {
  const $msg = document.getElementById('imp-prod-msg');
  const file = document.getElementById('excel-prod-file').files[0];
  if (!file) {
    $msg.innerHTML = `<div class="error-msg">Selecciona un archivo Excel.</div>`;
    return;
  }
  $msg.innerHTML = `<div class="loading">Analizando Excel…</div>`;
  try {
    const fd = new FormData();
    fd.append('excel', file);
    const token = localStorage.getItem('cpv2_token');
    const resp = await fetch('/api/products/import-preview', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    const r = await resp.json();
    if (!r.success) throw new Error(r.error || 'Error en el análisis');
    mostrarPreviewImportProductos(r.preview);
  } catch (err) {
    $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

function mostrarPreviewImportProductos(preview) {
  // Cerrar modal anterior y mostrar pre-revisión
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());
  // Guardar payload para usarlo al confirmar
  window._importProductosPayload = {
    filas: preview.filas_payload,
    codigos_desaparecidos: preview.codigos_desaparecidos
  };

  const cps = preview.cambios_precio_significativos || [];
  const headers = preview.headers_detectados || {};
  const muestraDescartados = preview.muestra_descartados || [];

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>📊 Pre-revisión de importación</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>

      <div style="background:#eff6ff;border:1px solid #bfdbfe;padding:10px 12px;border-radius:8px;margin-bottom:14px;font-size:12px">
        <div style="font-weight:600;margin-bottom:6px;color:#1e40af">🔎 Columnas detectadas en tu Excel</div>
        <div style="color:#1e40af">
          <b>Código:</b> ${escape(headers.colCodigo || '?')} · 
          <b>Nombre:</b> ${escape(headers.colNombre || '?')} · 
          <b>EAN:</b> ${escape(headers.colEAN || '?')} · 
          <b>PVF:</b> ${escape(headers.colPVF || '?')} · 
          <b>Categoría:</b> ${escape(headers.colCategoria || '?')} · 
          <b>Familia:</b> ${escape(headers.colFamilia || '?')} · 
          <b>Proveedor:</b> ${escape(headers.colProveedor || '?')} · 
          <b>Tipo art.:</b> ${escape(headers.colTipoArt || '?')}
        </div>
      </div>

      <div style="background:var(--surface-2);padding:14px;border-radius:8px;margin-bottom:14px;font-size:13px">
        <div style="font-weight:600;margin-bottom:8px">📋 Resumen</div>
        <div>📄 Total productos válidos en el Excel: <b>${preview.total_excel}</b></div>
        ${preview.descartados_basura > 0 ? `
          <div>🗑️ Descartados (notas/comentarios del Sage): <b style="color:#6b7280">${preview.descartados_basura}</b></div>
        ` : ''}
        <div>🆕 Nuevos a crear: <b style="color:#16a34a">${preview.nuevos}</b>${preview.nuevos_descatalogados > 0 ? ` <span style="color:#dc2626">(de los cuales ${preview.nuevos_descatalogados} entran ya como BAJA/ANULADO)</span>` : ''}</div>
        <div>🔄 A actualizar: <b style="color:#d97706">${preview.actualizaciones}</b>${preview.actuales_descatalogados > 0 ? ` <span style="color:#dc2626">(${preview.actuales_descatalogados} se marcan ahora como BAJA/ANULADO)</span>` : ''}</div>
        <div>= Sin cambios: <b style="color:#6b7280">${preview.sin_cambio}</b></div>
        <div>👻 Desaparecidos (estaban antes, ya no): <b style="color:#dc2626">${preview.desaparecidos}</b></div>
      </div>

      ${muestraDescartados.length > 0 ? `
        <details style="margin-bottom:14px">
          <summary style="cursor:pointer;font-size:12px;color:#6b7280">Ver muestra de filas descartadas (notas operativas del Sage)</summary>
          <div style="background:#f3f4f6;padding:10px;border-radius:6px;margin-top:6px;font-size:11px;max-height:140px;overflow-y:auto">
            ${muestraDescartados.map(d => `<div><b>${escape(d.codigo)}</b> · ${escape(d.nombre)}</div>`).join('')}
          </div>
        </details>
      ` : ''}

      ${cps.length > 0 ? `
        <div style="background:#fef3c7;border:1px solid #fcd34d;padding:12px;border-radius:8px;margin-bottom:14px;font-size:13px">
          <div style="font-weight:600;margin-bottom:6px;color:#78350f">⚠️ Cambios de precio significativos (>20%)</div>
          <div style="max-height:160px;overflow-y:auto">
            ${cps.map(c => `
              <div style="padding:4px 0;border-bottom:1px solid #fcd34d">
                <b>${escape(c.codigo)}</b> ${escape(c.nombre)}<br>
                <span style="color:#78350f">${Number(c.pvp_old).toFixed(2)}€ → ${Number(c.pvp_new).toFixed(2)}€ (${c.pct}%)</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${preview.desaparecidos > 0 ? `
        <div class="form-group">
          <label>
            <input type="checkbox" id="imp-descatalogar" checked>
            <b>Descatalogar</b> los ${preview.desaparecidos} productos que ya no están en el Excel
            <br><small style="color:var(--gris-texto);margin-left:24px">(No se borran. Quedan marcados como inactivos. Anotaciones antiguas siguen funcionando.)</small>
          </label>
        </div>
      ` : ''}

      <div id="imp-prod-confirm-msg"></div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="confirmarImportProductos()">✅ Aplicar cambios</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function confirmarImportProductos() {
  const $msg = document.getElementById('imp-prod-confirm-msg');
  $msg.innerHTML = '<div class="loading">Aplicando cambios…</div>';
  try {
    const payload = window._importProductosPayload;
    if (!payload) throw new Error('Datos perdidos. Vuelve a subir el Excel.');
    const descatalogar = document.getElementById('imp-descatalogar');
    const body = {
      filas: payload.filas,
      codigos_desaparecidos: payload.codigos_desaparecidos,
      descatalogar_desaparecidos: descatalogar ? descatalogar.checked : false
    };
    const r = await api('/api/products/import-confirm', { method: 'POST', body });
    document.querySelector('.modal-bg').remove();
    window._importProductosPayload = null;
    const msgBaja = r.marcados_baja > 0 ? ` · 🔴 ${r.marcados_baja} marcados como BAJA/ANULADO` : '';
    mostrarNotificacionOnline(`✅ ${r.creados} creados · ${r.actualizados} actualizados · ${r.descatalogados} descatalogados${msgBaja}`, '#16a34a');
    recargarProductos();
  } catch (err) {
    $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

// ============================================================================
// FASE 2.a — Búsqueda de productos (autocomplete reusable)
// ============================================================================
// Función para buscar productos en vivo. Devuelve array de productos.
// Cache simple en memoria para que escribir "BET" → "BETE" → "BETER" no
// dispare 3 fetches al servidor en menos de 1 segundo.
const _cacheBusquedaProductos = new Map(); // key: query, value: { ts, results }
const _CACHE_TTL_MS = 30000; // 30 segundos

async function buscarProductos(query) {
  const q = (query || '').trim();
  if (q.length < 2) return [];

  // Mirar cache
  const cached = _cacheBusquedaProductos.get(q.toLowerCase());
  if (cached && (Date.now() - cached.ts) < _CACHE_TTL_MS) {
    return cached.results;
  }

  try {
    const r = await api('/api/products/search?q=' + encodeURIComponent(q));
    const products = r.products || [];
    _cacheBusquedaProductos.set(q.toLowerCase(), { ts: Date.now(), results: products });
    return products;
  } catch (e) {
    console.error('Error buscando productos:', e);
    return [];
  }
}

// Componente reusable: monta un autocomplete dentro de un contenedor.
// Uso:
//   const ac = montarAutocompleteProducto(elemento_contenedor, {
//     placeholder: 'Buscar producto…',
//     onSelect: (producto) => { ... },
//     productoInicial: null  // opcional: producto ya seleccionado
//   });
//   ac.destroy()           // limpiar al cerrar modal
//   ac.getSeleccionado()   // devuelve el producto seleccionado o null
//   ac.setSeleccionado(p)  // asignar uno desde fuera
function montarAutocompleteProducto(contenedor, opts) {
  opts = opts || {};
  const placeholder = opts.placeholder || 'Buscar producto (nombre, código o EAN)…';
  const onSelect = opts.onSelect || (() => {});
  let seleccionado = opts.productoInicial || null;
  let timer = null;
  let ultimaQuery = '';

  contenedor.innerHTML = `
    <div class="ac-producto-wrap">
      <input type="text" class="ac-producto-input" placeholder="${escape(placeholder)}"
             value="${seleccionado ? escape((seleccionado.codigo || '') + ' · ' + (seleccionado.nombre || '')) : ''}"
             autocomplete="off" />
      <button type="button" class="ac-producto-clear" title="Limpiar selección"
              style="${seleccionado ? '' : 'display:none'}">×</button>
      <div class="ac-producto-resultados" style="display:none"></div>
      <div class="ac-producto-seleccionado" style="${seleccionado ? '' : 'display:none'}"></div>
    </div>
  `;

  const $input = contenedor.querySelector('.ac-producto-input');
  const $resultados = contenedor.querySelector('.ac-producto-resultados');
  const $seleccionado = contenedor.querySelector('.ac-producto-seleccionado');
  const $clear = contenedor.querySelector('.ac-producto-clear');

  function renderSeleccionado() {
    if (!seleccionado) {
      $seleccionado.style.display = 'none';
      $clear.style.display = 'none';
      return;
    }
    $clear.style.display = '';
    $seleccionado.style.display = '';
    const pvf = seleccionado.precio_pvf ? Number(seleccionado.precio_pvf).toFixed(2) + '€' : '—';
    const ean = seleccionado.ean ? ' · EAN ' + escape(seleccionado.ean) : '';
    const badgeTipo = seleccionado.tipo === 'comercial'
      ? '<span class="ac-badge-promo">🎁 Promo</span>'
      : '<span class="ac-badge-sage">🏷️ Sage</span>';
    $seleccionado.innerHTML = `
      <div class="ac-producto-card">
        <div class="ac-producto-card-row1">
          ${badgeTipo}
          <b>${escape(seleccionado.codigo)}</b>
          <span class="ac-pvf">PVF ${pvf}</span>
        </div>
        <div class="ac-producto-card-row2">${escape(seleccionado.nombre)}${ean}</div>
      </div>
    `;
  }
  renderSeleccionado();

  function mostrarResultados(productos) {
    const queryActual = $input.value.trim();
    // Bloque "+ Crear producto" que se muestra si hay callback onCrear
    const bloqueCrear = opts.onCrear ? `
      <div class="ac-crear" data-crear="1">
        ➕ Crear producto nuevo${queryActual ? ': "' + escape(queryActual) + '"' : ''}
      </div>
    ` : '';

    if (productos.length === 0) {
      $resultados.innerHTML = '<div class="ac-empty">No se encontraron productos activos</div>' + bloqueCrear;
      $resultados.style.display = '';
      enlazarBotonCrear(queryActual);
      return;
    }
    $resultados.innerHTML = productos.map((p, idx) => {
      const pvf = p.precio_pvf ? Number(p.precio_pvf).toFixed(2) + '€' : '—';
      const ean = p.ean ? ' · EAN ' + escape(p.ean) : '';
      const tipoBadge = p.tipo === 'comercial' ? '🎁' : '🏷️';
      return `
        <div class="ac-item" data-idx="${idx}">
          <div class="ac-item-row1">
            <span class="ac-item-tipo">${tipoBadge}</span>
            <b>${escape(p.codigo)}</b>
            <span class="ac-item-pvf">${pvf}</span>
          </div>
          <div class="ac-item-row2">${escape(p.nombre)}${ean}</div>
        </div>
      `;
    }).join('') + bloqueCrear;
    $resultados.style.display = '';

    // Hacer cada item clickable
    $resultados.querySelectorAll('.ac-item').forEach($item => {
      $item.addEventListener('click', () => {
        const idx = Number($item.getAttribute('data-idx'));
        seleccionado = productos[idx];
        $input.value = (seleccionado.codigo || '') + ' · ' + (seleccionado.nombre || '');
        $resultados.style.display = 'none';
        $resultados.innerHTML = '';
        renderSeleccionado();
        onSelect(seleccionado);
      });
    });
    enlazarBotonCrear(queryActual);
  }

  function enlazarBotonCrear(queryActual) {
    const $crear = $resultados.querySelector('.ac-crear');
    if ($crear && opts.onCrear) {
      $crear.addEventListener('click', (e) => {
        e.stopPropagation();
        $resultados.style.display = 'none';
        // Llamar al callback de creación pasándole el texto buscado como nombre sugerido
        opts.onCrear(queryActual, (productoCreado) => {
          // callback cuando se crea: seleccionarlo automáticamente
          seleccionado = productoCreado;
          $input.value = (productoCreado.codigo || '') + ' · ' + (productoCreado.nombre || '');
          renderSeleccionado();
          onSelect(productoCreado);
        });
      });
    }
  }

  // Debounce de teclas
  $input.addEventListener('input', () => {
    const q = $input.value.trim();
    // Si el usuario empieza a escribir y había selección, limpiarla
    if (seleccionado && q !== ((seleccionado.codigo || '') + ' · ' + (seleccionado.nombre || ''))) {
      seleccionado = null;
      renderSeleccionado();
      onSelect(null);
    }
    if (q === ultimaQuery) return;
    ultimaQuery = q;
    clearTimeout(timer);
    if (q.length < 2) {
      $resultados.style.display = 'none';
      $resultados.innerHTML = '';
      return;
    }
    $resultados.innerHTML = '<div class="ac-loading">Buscando…</div>';
    $resultados.style.display = '';
    timer = setTimeout(async () => {
      const productos = await buscarProductos(q);
      // Solo aplicar si la query sigue siendo la misma (evita race conditions)
      if (q === $input.value.trim()) {
        mostrarResultados(productos);
      }
    }, 250);
  });

  // Cerrar resultados al hacer click fuera
  function onDocClick(e) {
    if (!contenedor.contains(e.target)) {
      $resultados.style.display = 'none';
    }
  }
  document.addEventListener('click', onDocClick);

  // Botón limpiar selección
  $clear.addEventListener('click', () => {
    seleccionado = null;
    $input.value = '';
    $input.focus();
    renderSeleccionado();
    onSelect(null);
  });

  return {
    getSeleccionado: () => seleccionado,
    setSeleccionado: (p) => {
      seleccionado = p;
      $input.value = p ? ((p.codigo || '') + ' · ' + (p.nombre || '')) : '';
      renderSeleccionado();
    },
    destroy: () => {
      document.removeEventListener('click', onDocClick);
      contenedor.innerHTML = '';
    }
  };
}

// Helper para probar manualmente la búsqueda desde la consola del navegador.
// Uso desde consola: testBuscarProductos('beter')
window.testBuscarProductos = async function(q) {
  const r = await buscarProductos(q);
  console.table(r.map(p => ({ codigo: p.codigo, nombre: p.nombre, ean: p.ean, pvf: p.precio_pvf, tipo: p.tipo })));
  return r;
};

// ============================================================================
// FASE 2.b' — EDITOR DE ZONAS sobre láminas (admin dibuja + asigna producto)
// ============================================================================
// Estado del editor de zonas (mientras está abierto)
let _zonasEditor = {
  sheetId: null,
  catalogId: null,
  zonas: [],          // zonas cargadas del servidor
  dibujando: false,   // está arrastrando para crear una zona nueva
  inicioX: 0, inicioY: 0,
  zonaSeleccionadaId: null,
  acProducto: null    // instancia del autocomplete activo
};

// ============================================================================
// DETECCION DE ZONAS CON IA
// Envia la lamina a GPT-4o Vision, recibe zonas propuestas con producto sugerido,
// las anade al editor actual como propuestas (color naranja) que el usuario
// puede aceptar (verde) o borrar.
// ============================================================================
async function detectarZonasConIA(sheetId, boton) {
  if (!confirm('¿Detectar productos con IA en esta lámina?\n\n• Añadirá los productos detectados como zonas nuevas al editor.\n• NO borra las zonas que ya tengas.\n• Coste: ~$0.02 (2 céntimos) por lámina.')) return;
  const orig = boton.textContent;
  boton.disabled = true;
  boton.textContent = '⏳ Analizando lámina...';
  try {
    const t0 = Date.now();
    const r = await api('/api/sheets/' + sheetId + '/detect-zones-ia', { method: 'POST' });
    const dt = Math.round((Date.now() - t0) / 1000);
    if (!r.success || !Array.isArray(r.zonas)) {
      throw new Error(r.error || 'La IA no devolvió resultados');
    }
    if (r.zonas.length === 0) {
      alert(`La IA no ha detectado productos en esta lámina (${dt}s).\n\nProbablemente es una portada, separador de sección o no tiene productos individuales identificables.`);
      boton.textContent = orig;
      boton.disabled = false;
      return;
    }
    // Anadir cada zona detectada al editor
    let anadidas = 0;
    let matcheadas = 0;
    for (const z of r.zonas) {
      const producto = z.producto_sugerido;
      const etiqueta = z.descripcion || (z.codigo_fabricante || z.codigo_nacional || '');
      const zonaNueva = {
        id: 'ia-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), // id temporal
        x: z.x, y: z.y, ancho: z.width, alto: z.height,
        product_id: producto ? producto.id : null,
        // Usar los MISMOS nombres de campo que el resto del editor (producto_*), si no
        // el panel muestra el nombre vacío ("·") y "PVF —" aunque haya match.
        producto_codigo: producto ? producto.codigo : null,
        producto_nombre: producto ? producto.nombre : null,
        producto_pvf: producto ? (producto.precio_pvf_1 != null ? producto.precio_pvf_1 : (producto.precio_pvf != null ? producto.precio_pvf : null)) : null,
        etiqueta: etiqueta,
        propuesta_ia: true,   // marca visual (color distinto)
        ai_meta: {
          codigo_nacional: z.codigo_nacional,
          codigo_fabricante: z.codigo_fabricante,
          descripcion: z.descripcion,
          pvl: z.pvl, pvpr: z.pvpr,
          formato: z.formato, tamano: z.tamano
        }
      };
      _zonasEditor.zonas.push(zonaNueva);
      anadidas++;
      if (producto) matcheadas++;
    }
    // Repintar la capa de zonas + panel lateral
    if (typeof renderZonasEnCapa === 'function') renderZonasEnCapa();
    if (typeof renderListaZonas === 'function') renderListaZonas();
    // Actualizar contador
    const $c = document.getElementById('zonas-contador');
    if ($c) $c.textContent = _zonasEditor.zonas.length + ' zonas';
    alert(`✅ IA lista (${dt}s)\n\n${anadidas} productos detectados\n${matcheadas} con match automático a Sage\n${anadidas - matcheadas} sin match (asigna producto a mano)\n\nRevisa las zonas naranjas: acepta las buenas, borra las malas, ajusta las que necesiten.`);
    boton.textContent = orig;
    boton.disabled = false;
  } catch (e) {
    alert('Error: ' + e.message);
    boton.textContent = orig;
    boton.disabled = false;
  }
}

// ============================================================================
// F3 precios dinámicos — detección de PRECIOS por IA + revisión en el lienzo.
// La IA localiza cada precio impreso, sharp lo afina (color de fondo/tinta + caja),
// se casa con un producto y se crea un recuadro que TAPA y REESCRIBE con el precio BD.
// ============================================================================
async function detectarPreciosConIA(sheetId, boton) {
  if (!confirm('¿Detectar los PRECIOS de esta lámina con IA?\n\n• Localiza cada precio impreso y crea un recuadro que lo TAPA y lo REESCRIBE con el precio actual de la base de datos.\n• Reemplaza los recuadros que la IA creó antes en esta lámina (respeta los que hayas hecho a mano).\n• Coste: ~$0.02 (2 céntimos) por lámina.')) return;
  const orig = boton.textContent;
  boton.disabled = true; boton.textContent = '⏳ Analizando precios...';
  try {
    const t0 = Date.now();
    const r = await api('/api/sheets/' + sheetId + '/detect-precios-ia', { method: 'POST' });
    const dt = Math.round((Date.now() - t0) / 1000);
    if (!r.success) throw new Error(r.error || 'La IA no respondió');
    await renderRecuadrosEnLienzo(sheetId);
    const ok = r.creados - (r.con_revisar || 0);
    alert(`✅ Precios detectados (${dt}s)\n\n${r.creados} recuadros sobre ${r.zonas_producto} productos (de ${r.total_detectados} precios vistos)\n✔️ ${ok} de confianza alta (se reescriben ya)\n⚠️ ${r.con_revisar || 0} para revisar (NO se muestran al cliente hasta que los apruebes)\n${r.descartados_fuera ? '🗑️ ' + r.descartados_fuera + ' fuera de zona descartados\\n' : ''}\nEn el lienzo: morado = OK, ámbar = revisar (pasa el ratón para ver el motivo). ✓ aprobar · ✕ borrar.`);
  } catch (e) {
    alert('Error: ' + e.message);
  }
  boton.textContent = orig; boton.disabled = false;
}

// Borrado MASIVO de recuadros de una lámina (paridad con "Borrar todas" de zonas):
// si la detección IA no convence, se limpia de golpe en vez de ir uno por uno.
// Si hay recuadros hechos a mano, ofrece respetarlos y borrar solo los de la IA.
async function borrarTodosLosRecuadros(sheetId, boton) {
  const recs = _zonasEditor.recuadros || [];
  if (!recs.length) { alert('Esta lámina no tiene recuadros de precio.'); return; }
  const nIA = recs.filter(r => r.origen === 'ia').length;
  const nMano = recs.length - nIA;
  let soloIA = false;
  if (nIA > 0 && nMano > 0) {
    // Hay de los dos tipos: preguntamos para no cargarnos el trabajo manual sin querer.
    soloIA = confirm(`Esta lámina tiene ${nIA} recuadro(s) de IA y ${nMano} hecho(s) a mano.\n\n• Aceptar = borrar SOLO los ${nIA} de la IA (respeta los tuyos)\n• Cancelar = elegir borrarlos TODOS`);
    if (!soloIA && !confirm(`¿Borrar los ${recs.length} recuadros de precio de esta lámina, incluidos los ${nMano} hechos a mano?`)) return;
  } else if (!confirm(`¿Borrar los ${recs.length} recuadro(s) de precio de esta lámina?\n\nLas zonas y los productos NO se tocan; solo se quitan los precios reescritos.`)) return;
  const orig = boton ? boton.textContent : '';
  if (boton) { boton.disabled = true; boton.textContent = '⏳ Borrando…'; }
  try {
    const r = await api('/api/sheets/' + sheetId + '/recuadros' + (soloIA ? '?solo_ia=true' : ''), { method: 'DELETE' });
    await renderRecuadrosEnLienzo(sheetId);
    mostrarNotificacionOnline('🗑️ ' + (r.borrados || 0) + ' recuadros borrados', '#6b7280');
  } catch (e) { alert('Error: ' + e.message); }
  if (boton) { boton.disabled = false; boton.textContent = orig; }
}

// ---- Salto a la SIGUIENTE lámina pendiente de precios (repaso de 350+ láminas) ----
// Pendiente = tiene zonas dibujadas (hay productos que precificar) pero 0 recuadros.
// Así se saltan portadas y separadores, que no tienen precios que asignar.
// Pendiente = zonas dibujadas, 0 recuadros y NO excluida (las excluidas son a mano aposta).
function _pendientePrecios(s) { return (s.num_zonas || 0) > 0 && !(s.num_recuadros > 0) && !s.precios_excluida; }
function _laminasPendientesPrecios() {
  return (_zonasEditor.sheets || []).filter(s => !s.oculta && _pendientePrecios(s));
}
function _siguienteSinPrecios() {
  const list = (_zonasEditor.sheets || []).filter(s => !s.oculta);
  if (!list.length) return null;
  const i = list.findIndex(s => s.id === _zonasEditor.sheetId);
  for (let k = 1; k <= list.length; k++) {           // desde la siguiente, dando la vuelta
    const s = list[(Math.max(0, i) + k) % list.length];
    if (s.id !== _zonasEditor.sheetId && _pendientePrecios(s)) return s;
  }
  return null;
}
async function irSiguienteSinPrecios() {
  const sig = _siguienteSinPrecios();
  if (!sig) { alert('🎉 No queda ninguna lámina pendiente de precios en este catálogo.\n\n(Solo se cuentan las que tienen zonas dibujadas; las portadas y separadores se saltan.)'); return; }
  const cid = _zonasEditor.catalogId;
  await cerrarEditorZonas();
  if (document.getElementById('zonas-editor-overlay')) return; // el usuario canceló al cerrar
  await abrirEditorZonas(sig.id, cid);
}

// Modo "dibujar recuadro de precio" a mano (para corregir lo que la IA no clavó).
function toggleModoRecuadro(btn) {
  _zonasEditor.modoRecuadro = !_zonasEditor.modoRecuadro;
  const on = _zonasEditor.modoRecuadro;
  if (btn) {
    btn.style.background = on ? '#7c3aed' : '#f3e8ff';
    btn.style.color = on ? '#fff' : '#7c3aed';
    btn.textContent = on ? '✏️ Dibujando… (pulsa para salir)' : '✏️ Dibujar recuadro';
  }
  const ayuda = document.getElementById('zonas-ayuda');
  if (ayuda) ayuda.innerHTML = on
    ? '✏️ <b>MODO DIBUJAR RECUADRO activo:</b> arrastra una caja SOBRE un número de precio. Mientras esté activo, las zonas y los recuadros quedan <b>atenuados y no se pueden tocar</b> (para poder dibujar encima). Pulsa otra vez el botón para salir y volver a moverlos.'
    : '✏️ <b>Arrastra</b> sobre la lámina para dibujar un rectángulo. Luego asígnale un producto en el panel derecho.';
  const wrap = document.getElementById('zonas-lienzo-wrap');
  if (wrap) {
    wrap.style.cursor = on ? 'cell' : 'crosshair';
    // Marca el lienzo: atenúa zonas/recuadros y los hace inertes (ver CSS). Así se VE
    // que están desactivados a propósito y no parece que la app se haya bloqueado.
    wrap.classList.toggle('modo-recuadro', on);
  }
}

// Diálogo para elegir el campo del recuadro. NO usamos confirm(): "Aceptar/Cancelar" es
// ambiguo (Cancelar parece abortar, no "es P.V.P.R.") y se presta a equivocarse.
// Devuelve 'pvf' | 'pvpr' | null (cancelar). Muestra también a qué producto se asignará.
function _pedirCampoPrecio(etiqueta, porCercania, notaFamilia) {
  return new Promise(resolve => {
    const et = etiqueta;
    const m = document.createElement('div');
    m.className = 'modal-bg';
    m.innerHTML = `
      <div class="modal" style="max-width:460px">
        <h3 style="margin-top:0">🏷️ ¿Qué precio es este recuadro?</h3>
        <div style="font-size:12px;color:var(--gris-texto)">Se asignará a:</div>
        <div style="font-weight:600;font-size:14px;margin:4px 0 12px">${escape(et || '(sin código)')}</div>
        ${notaFamilia ? `<div style="background:#ede9fe;color:#5b21b6;font-size:12px;padding:8px 10px;border-radius:8px;margin-bottom:12px">👓 ${escape(notaFamilia)}</div>` : ''}
        ${porCercania ? `<div style="background:#fef3c7;color:#92400e;font-size:12px;padding:8px 10px;border-radius:8px;margin-bottom:12px">
          ⚠️ El recuadro no cae dentro de ninguna zona: se ha cogido lo <b>más cercano</b>. Si no es eso, cancela y dibuja dentro de su zona.</div>` : ''}
        <div style="display:flex;flex-direction:column;gap:8px">
          <button type="button" class="btn zona-campo-op" data-campo="pvf" style="background:color-mix(in srgb, var(--amber) 14%, var(--surface));color:var(--amber);border:1.5px solid var(--amber);font-weight:800;padding:14px;font-size:15px">P.V.F. · precio de farmacia (sin IVA)</button>
          <button type="button" class="btn zona-campo-op" data-campo="pvpr" style="background:color-mix(in srgb, var(--violet) 14%, var(--surface));color:var(--violet);border:1.5px solid var(--violet);font-weight:800;padding:14px;font-size:15px">P.V.P.R. · precio público (con IVA)</button>
        </div>
        <div class="modal-acciones" style="margin-top:14px">
          <button type="button" class="btn btn-secondary zona-campo-op" data-campo="">Cancelar (no crear nada)</button>
        </div>
      </div>`;
    m.querySelectorAll('.zona-campo-op').forEach(b => b.addEventListener('click', () => {
      const c = b.dataset.campo; m.remove(); resolve(c || null);
    }));
    document.body.appendChild(m);
  });
}

// Crea un recuadro a partir de una caja dibujada: muestrea colores/afina la caja en el
// servidor, ancla al producto de la zona que la contiene y pregunta el campo.
// Diálogo: elegir DE QUÉ variante/formato es el precio dibujado (familias con precios
// distintos). Muestra el precio de cada formato para no equivocarse. Devuelve variante | null.
function _pedirVarianteFamilia(variantes, campo) {
  return new Promise(resolve => {
    const fmt = v => (v == null || v === '') ? '—' : Number(v).toFixed(2).replace('.', ',') + '€';
    const et = campo === 'pvpr' ? 'P.V.P.R.' : 'P.V.F.';
    const m = document.createElement('div');
    m.className = 'modal-bg';
    m.innerHTML = `
      <div class="modal" style="max-width:480px">
        <h3 style="margin-top:0">👓 ¿De qué formato es este precio?</h3>
        <div style="font-size:12px;color:var(--gris-texto);margin-bottom:10px">Esta familia tiene variantes con <b>${et} distinto</b>. Elige a cuál corresponde el precio que has dibujado, para que se reescriba el correcto.</div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto">
          ${variantes.map((v, i) => `<button type="button" class="btn zona-var-op" data-i="${i}" style="text-align:left;display:flex;justify-content:space-between;gap:10px;padding:12px;border:1.5px solid var(--gris-borde)">
              <span><b>${escape(v.codigo || '')}</b><br><small style="color:var(--gris-texto)">${escape(v.nombre || '')}</small></span>
              <span style="white-space:nowrap;font-weight:800;color:${campo === 'pvpr' ? 'var(--violet)' : 'var(--amber)'}">${fmt(campo === 'pvpr' ? v.pvpr : v.pvf)}</span>
            </button>`).join('')}
        </div>
        <div class="modal-acciones" style="margin-top:12px"><button type="button" class="btn btn-secondary zona-var-op" data-i="-1">Cancelar</button></div>
      </div>`;
    m.querySelectorAll('.zona-var-op').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.i); m.remove(); resolve(i >= 0 ? variantes[i] : null);
    }));
    document.body.appendChild(m);
  });
}

// Resuelve las variantes de una zona-FAMILIA (por lista curada o por modelo).
async function _resolverVariantesFamilia(zona) {
  try {
    const q = (Array.isArray(zona.familia_skus) && zona.familia_skus.length)
      ? '/api/families/resolve?ids=' + zona.familia_skus.join(',')
      : '/api/families/resolve?ref=' + encodeURIComponent(zona.familia_ref || '');
    const r = await api(q);
    return (r.familia && Array.isArray(r.familia.variantes)) ? r.familia.variantes : [];
  } catch { return []; }
}

async function crearRecuadroDibujado(x, y, ancho, alto) {
  const sheetId = _zonasEditor.sheetId;
  const cxp = x + ancho / 2, cyp = y + alto / 2;
  // Zonas "precificables": producto individual O FAMILIA con variantes (comparten precio impreso).
  // Las de COMISIÓN y REFERENCIAS SUELTAS no valen: esos productos NO están en Sage, así que
  // no hay precio de BD que reescribir (Combe, Lainco... son labs a comisión).
  const esFam = z => !!(z.familia_ref || (Array.isArray(z.familia_skus) && z.familia_skus.length));
  const zonas = _zonasEditor.zonas || [];
  const cand = zonas.filter(z => z.product_id || esFam(z));
  if (!cand.length) {
    const hayComision = zonas.some(z => z.es_comision || z.permite_sueltas);
    if (hayComision) {
      alert('Esta lámina es de COMISIÓN o de referencias sueltas.\n\nEsos productos NO están en Sage, así que NO tienen precio en la base de datos que reescribir. Los precios dinámicos no se pueden aplicar aquí.\n\n👉 Lo mejor: en «Editar lámina» marca «🔒 Excluir de los precios dinámicos» y déjala tal cual / hazla a mano.');
    } else {
      alert('Esta lámina no tiene ninguna zona con producto ni familia.\n\nPrimero asigna productos/familias a las zonas; el recuadro de precio necesita saber de qué producto es.');
    }
    return;
  }
  // 1º la zona que CONTIENE el recuadro; 2º la MÁS CERCANA (el precio suele caer fuera del recuadro).
  let zona = cand.find(z => cxp >= z.x && cxp <= z.x + z.ancho && cyp >= z.y && cyp <= z.y + z.alto);
  let porCercania = false;
  if (!zona) {
    let best = null, bestD = Infinity;
    for (const z of cand) {
      const d = ((z.x + z.ancho / 2) - cxp) ** 2 + ((z.y + z.alto / 2) - cyp) ** 2;
      if (d < bestD) { bestD = d; best = z; }
    }
    zona = best; porCercania = true;
  }
  // Resolver el PRODUCTO al que va el precio.
  let productId = zona.product_id || null;
  let etiqueta, variantesFam = null;
  if (!productId && esFam(zona)) {
    variantesFam = await _resolverVariantesFamilia(zona);
    if (!variantesFam.length) { alert('No se pudieron resolver las variantes de esta familia. Revisa la zona.'); return; }
    etiqueta = 'Familia «' + (zona.familia_ref || zona.etiqueta || 'variantes') + '» · ' + variantesFam.length + ' variantes';
  } else {
    etiqueta = (zona.producto_codigo || '') + (zona.producto_nombre ? ' · ' + zona.producto_nombre : '');
  }
  // 1) qué precio es (PVF/PVPR).
  const campo = await _pedirCampoPrecio(etiqueta, porCercania, '');
  if (!campo) return;
  // 2) si es familia: ¿todas las variantes comparten ese precio? Si SÍ, cualquiera vale.
  //    Si NO (p.ej. 100 ml a 5,07€ y 500 ml a 12,94€), preguntamos DE QUÉ formato es este
  //    precio, para enlazarlo al producto correcto (si no, el otro saldría mal).
  if (!productId && variantesFam) {
    const precioDe = v => campo === 'pvpr' ? v.pvpr : v.pvf;
    const distintos = Array.from(new Set(variantesFam.map(v => precioDe(v)).filter(x => x != null && x !== '')));
    if (distintos.length <= 1) {
      productId = (variantesFam.find(v => precioDe(v) != null) || variantesFam[0]).product_id;
    } else {
      const elegido = await _pedirVarianteFamilia(variantesFam, campo);
      if (!elegido) return; // cancelado
      productId = elegido.product_id;
    }
  }
  let sug = null;
  try {
    const r = await api('/api/sheets/' + sheetId + '/recuadros/muestrear', { method: 'POST', body: { x, y, ancho, alto } });
    sug = r.sugerencia;
  } catch (e) { /* si no detecta texto, usamos la caja dibujada tal cual */ }
  const esPVF = campo === 'pvf';
  const body = {
    product_id: productId,
    zone_id: zona ? zona.id : null,
    campo: esPVF ? 'pvf' : 'pvpr',
    x: sug ? sug.x : x, y: sug ? sug.y : y, ancho: sug ? sug.ancho : ancho, alto: sug ? sug.alto : alto,
    color_fondo: sug ? sug.color_fondo : 'rgb(255,255,255)',
    color_texto: sug ? sug.color_texto : 'rgb(43,42,41)',
    tam_rel: sug ? sug.tam_rel : Math.max(1, alto * 0.9),
    alinear: sug ? sug.alinear : 'left',
    sep_decimal: '.', origen: 'manual'
  };
  try {
    await api('/api/sheets/' + sheetId + '/recuadros', { method: 'POST', body });
    await renderRecuadrosEnLienzo(sheetId);
  } catch (e) { alert('Error creando recuadro: ' + e.message); }
}

// Ficha de un recuadro: al pulsarlo (sin arrastrar) cuenta QUÉ tiene asignado y qué
// precio va a escribir. Antes solo habia un tooltip al pasar el raton (invisible en tablet).
async function abrirInfoRecuadro(rec, sheetId) {
  const m = document.createElement('div');
  m.className = 'modal-bg';
  m.innerHTML = `<div class="modal" style="max-width:470px">
    <h3 style="margin-top:0">🏷️ Recuadro de precio</h3>
    <div id="rec-info-cuerpo" style="font-size:14px"><div class="loading" style="padding:12px">Consultando precio…</div></div>
  </div>`;
  document.body.appendChild(m);
  // Precio que ESCRIBIRÁ hoy (el dato clave): se consulta a la BD como en el visor.
  let hoy = null, pend = null;
  if (rec.product_id) {
    try {
      const r = await api('/api/precios/vigente?product_id=' + rec.product_id + '&tarifa=1');
      hoy = r.hoy || null; pend = r.pendiente || null;
    } catch (e) { /* seguimos mostrando el resto */ }
  }
  const esPVPR = rec.campo === 'pvpr';
  const val = hoy ? (esPVPR ? hoy.pvpr : hoy.pvf) : null;
  const fmt = v => (v == null || v === '') ? '—' : Number(v).toFixed(2).replace('.', ',') + '€';
  const fila = (k, v) => `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--gris-borde)">
      <div style="width:150px;color:var(--gris-texto);flex:0 0 150px">${k}</div><div style="flex:1">${v}</div></div>`;
  const cuerpo = document.getElementById('rec-info-cuerpo');
  if (!cuerpo) return;
  cuerpo.innerHTML = `
    ${fila('Campo', `<span style="background:${esPVPR ? 'var(--violet)' : 'var(--amber)'};color:#fff;font-weight:800;padding:2px 8px;border-radius:6px">${esPVPR ? 'P.V.P.R. (con IVA)' : 'P.V.F. (sin IVA)'}</span>`)}
    ${fila('Producto', rec.product_id
      ? `<b>${escape(rec.producto_codigo || '')}</b>${rec.producto_nombre ? '<br><span style="color:var(--gris-texto);font-size:13px">' + escape(rec.producto_nombre) + '</span>' : ''}`
      : `<span style="color:#b45309;font-weight:600">⚠️ Sin producto asignado</span><br><span style="font-size:12px;color:var(--gris-texto)">No se reescribirá nada. Bórralo y vuelve a dibujarlo dentro de la zona del producto.</span>`)}
    ${fila('Escribirá hoy', val != null
      ? `<b style="font-size:17px;color:#16a34a">${fmt(val)}</b>${hoy && hoy.fuente ? ' <span style="font-size:12px;color:var(--gris-texto)">(' + escape(hoy.fuente) + ')</span>' : ''}`
      : `<span style="color:#b45309">— sin precio en la BD para este campo</span>`)}
    ${rec.valor_impreso != null ? fila('Impreso en la lámina', fmt(rec.valor_impreso) + ' <span style="font-size:12px;color:var(--gris-texto)">(lo que leyó la IA)</span>') : ''}
    ${pend && pend.fecha_vigencia ? fila('Cambio programado', `${fmt(esPVPR ? pend.pvpr : pend.pvf)} el ${String(pend.fecha_vigencia).slice(0, 10).split('-').reverse().join('/')}`) : ''}
    ${fila('Origen', rec.origen === 'ia' ? '🤖 Detectado por IA' : '✏️ Dibujado a mano')}
    ${fila('Estado', rec.revisar
      ? `<span style="color:#b45309;font-weight:700">⚠️ Pendiente de aprobar</span> <span style="font-size:12px;color:var(--gris-texto)">(no se muestra al cliente)</span>${rec.nota ? '<br><span style="font-size:12px;color:var(--gris-texto)">' + escape(rec.nota) + '</span>' : ''}`
      : `<span style="color:#16a34a;font-weight:700">✅ Activo</span> <span style="font-size:12px;color:var(--gris-texto)">(se muestra al cliente)</span>`)}
    ${fila('Confianza', (rec.confianza != null ? rec.confianza : 100) + '%')}
    <div class="modal-acciones" style="margin-top:14px;flex-wrap:wrap;gap:8px">
      <button type="button" class="btn" id="rec-i-campo" style="background:#ede9fe;color:#6d28d9">🔄 Cambiar a ${esPVPR ? 'P.V.F.' : 'P.V.P.R.'}</button>
      ${rec.revisar ? `<button type="button" class="btn" id="rec-i-ap" style="background:#16a34a;color:#fff">✓ Aprobar</button>` : ''}
      <button type="button" class="btn" id="rec-i-del" style="background:#dc2626;color:#fff">🗑️ Borrar</button>
      <button type="button" class="btn btn-secondary" id="rec-i-cerrar">Cerrar</button>
    </div>`;
  const cerrar = () => m.remove();
  document.getElementById('rec-i-cerrar').onclick = cerrar;
  document.getElementById('rec-i-campo').onclick = async () => {
    try { await api('/api/recuadros/' + rec.id, { method: 'PUT', body: { campo: esPVPR ? 'pvf' : 'pvpr' } }); cerrar(); await renderRecuadrosEnLienzo(sheetId); }
    catch (e) { alert(e.message); }
  };
  const ap = document.getElementById('rec-i-ap');
  if (ap) ap.onclick = async () => {
    try { await api('/api/recuadros/' + rec.id, { method: 'PUT', body: { revisar: false } }); cerrar(); await renderRecuadrosEnLienzo(sheetId); }
    catch (e) { alert(e.message); }
  };
  document.getElementById('rec-i-del').onclick = async () => {
    if (!confirm('¿Borrar este recuadro de precio?')) return;
    try { await api('/api/recuadros/' + rec.id, { method: 'DELETE' }); cerrar(); await renderRecuadrosEnLienzo(sheetId); }
    catch (e) { alert(e.message); }
  };
}

// Arrastrar un recuadro para MOVERLO sobre el precio (guarda al soltar).
function _hacerRecuadroArrastrable(d, rec, sheetId) {
  const wrap = document.getElementById('zonas-lienzo-wrap');
  if (!wrap) return;
  let st = null;
  const rel = (e) => {
    const r = wrap.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return { x: cx / r.width * 100, y: cy / r.height * 100 };
  };
  const move = (e) => {
    if (!st) return;
    e.preventDefault();
    const p = rel(e);
    const dx = p.x - st.px, dy = p.y - st.py;
    if (st.modo === 'mover') {
      st.nx = Math.max(0, Math.min(100 - st.w0, st.x0 + dx));
      st.ny = Math.max(0, Math.min(100 - st.h0, st.y0 + dy));
      d.style.left = st.nx + '%'; d.style.top = st.ny + '%';
    } else if (st.modo === 'se') {           // estirar por abajo-derecha
      st.nw = Math.max(0.3, Math.min(100 - st.x0, st.w0 + dx));
      st.nh = Math.max(0.2, Math.min(100 - st.y0, st.h0 + dy));
      d.style.width = st.nw + '%'; d.style.height = st.nh + '%';
    } else if (st.modo === 'nw') {           // estirar por arriba-izquierda
      st.nx = Math.max(0, Math.min(st.x0 + st.w0 - 0.3, st.x0 + dx));
      st.ny = Math.max(0, Math.min(st.y0 + st.h0 - 0.2, st.y0 + dy));
      st.nw = st.w0 + (st.x0 - st.nx);
      st.nh = st.h0 + (st.y0 - st.ny);
      d.style.left = st.nx + '%'; d.style.top = st.ny + '%';
      d.style.width = st.nw + '%'; d.style.height = st.nh + '%';
    }
  };
  const up = async () => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up);
    if (!st) return;
    const s = st; st = null;
    // Clic SIN arrastrar (solo en modo mover) -> abrir la ficha del recuadro
    const movido = (s.nx != null && (Math.abs(s.nx - s.x0) > 0.05 || Math.abs(s.ny - s.y0) > 0.05));
    const estirado = (s.nw != null && (Math.abs(s.nw - s.w0) > 0.05 || Math.abs(s.nh - s.h0) > 0.05));
    if (!movido && !estirado) {
      if (s.modo === 'mover') return abrirInfoRecuadro(rec, sheetId);
      return;
    }
    const body = {};
    if (s.nx != null) { body.x = s.nx; body.y = s.ny; }
    if (s.nw != null) { body.ancho = s.nw; body.alto = s.nh; }
    try {
      await api('/api/recuadros/' + rec.id, { method: 'PUT', body });
      if (body.x != null) { rec.x = body.x; rec.y = body.y; }
      if (body.ancho != null) { rec.ancho = body.ancho; rec.alto = body.alto; }
    } catch (e) { alert('No se pudo guardar: ' + e.message); renderRecuadrosEnLienzo(sheetId); }
  };
  const down = (e) => {
    if (e.target.tagName === 'BUTTON') return; // los botones ✓/✕/F no arrastran
    // ¿Se ha agarrado un asa de redimensionar o el cuerpo (mover)?
    const asa = e.target.classList && e.target.classList.contains('zona-recuadro-asa')
      ? (e.target.classList.contains('se') ? 'se' : 'nw') : 'mover';
    e.preventDefault(); e.stopPropagation();
    const p = rel(e);
    st = { modo: asa, px: p.x, py: p.y, x0: rec.x, y0: rec.y, w0: rec.ancho, h0: rec.alto, nx: null, ny: null, nw: null, nh: null };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
  };
  d.addEventListener('mousedown', down);
  d.addEventListener('touchstart', down, { passive: false });
  d.style.cursor = 'move';
  d.title = (d.title ? d.title + '\n' : '') + '👆 Pulsa para ver qué lleva · ↔ Arrastra para mover · ⤡ Asas de las esquinas para estirar';
}

async function renderRecuadrosEnLienzo(sheetId) {
  try {
    const r = await api('/api/sheets/' + sheetId + '/recuadros');
    _zonasEditor.recuadros = r.recuadros || [];
  } catch { _zonasEditor.recuadros = []; }
  const capa = document.getElementById('zonas-recuadros-capa');
  if (!capa) return;
  capa.innerHTML = '';
  (_zonasEditor.recuadros || []).forEach(rec => {
    const d = document.createElement('div');
    d.className = 'zona-recuadro-ov' + (rec.revisar ? ' revisar' : '') + (rec.product_id ? '' : ' sin-producto');
    d.style.left = rec.x + '%'; d.style.top = rec.y + '%';
    d.style.width = rec.ancho + '%'; d.style.height = rec.alto + '%';
    const et = (rec.campo === 'pvpr' ? 'P.V.P.R.' : 'P.V.F.') + ' · ' + (rec.producto_codigo || 'SIN producto');
    d.title = et + ' · confianza ' + rec.confianza + '%' + (rec.valor_impreso != null ? ' · impreso ' + rec.valor_impreso : '') + (rec.nota ? '\n⚠️ ' + rec.nota : '');
    if (rec.revisar) {
      const ap = document.createElement('button');
      ap.type = 'button'; ap.textContent = '✓'; ap.className = 'zona-recuadro-ap';
      ap.title = 'Aprobar: se mostrará al cliente';
      ap.onclick = async (ev) => {
        ev.stopPropagation();
        try { await api('/api/recuadros/' + rec.id, { method: 'PUT', body: { revisar: false } }); await renderRecuadrosEnLienzo(sheetId); }
        catch (e) { alert(e.message); }
      };
      d.appendChild(ap);
    }
    // Toggle de campo (P.V.F. ⇄ P.V.P.R.) por si la IA acertó la caja pero no el campo.
    const sw = document.createElement('button');
    sw.type = 'button'; sw.textContent = rec.campo === 'pvpr' ? 'PR' : 'F';
    sw.className = 'zona-recuadro-campo'; sw.title = 'Cambiar a ' + (rec.campo === 'pvpr' ? 'P.V.F.' : 'P.V.P.R.');
    sw.onclick = async (ev) => {
      ev.stopPropagation();
      const nuevo = rec.campo === 'pvpr' ? 'pvf' : 'pvpr';
      try { await api('/api/recuadros/' + rec.id, { method: 'PUT', body: { campo: nuevo } }); await renderRecuadrosEnLienzo(sheetId); }
      catch (e) { alert(e.message); }
    };
    d.appendChild(sw);
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.className = 'zona-recuadro-del';
    x.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('¿Borrar este recuadro de precio?')) return;
      try { await api('/api/recuadros/' + rec.id, { method: 'DELETE' }); await renderRecuadrosEnLienzo(sheetId); }
      catch (e) { alert(e.message); }
    };
    d.appendChild(x);
    // Asas para ESTIRAR el recuadro (la IA no siempre clava la caja; hay que poder ajustarla)
    ['nw', 'se'].forEach(pos => {
      const a = document.createElement('div');
      a.className = 'zona-recuadro-asa ' + pos;
      a.title = 'Estirar';
      d.appendChild(a);
    });
    _hacerRecuadroArrastrable(d, rec, sheetId);
    capa.appendChild(d);
  });
}

async function abrirEditorZonas(sheetId, catalogId) {
  // Cerrar el modal de editar lámina
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());

  _zonasEditor.sheetId = sheetId;
  _zonasEditor.catalogId = catalogId;
  _zonasEditor.zonaSeleccionadaId = null;
  _zonasEditor.modoRecuadro = false;

  // Cargar la lámina y sus zonas
  let sheet, zonas;
  try {
    const rCat = await api('/api/catalogs/' + catalogId);
    sheet = rCat.sheets.find(s => s.id === sheetId);
    if (!sheet) { alert('Lámina no encontrada'); return; }
    // Guardamos las láminas del catálogo (con num_zonas/num_recuadros) para poder saltar
    // directo a la SIGUIENTE pendiente sin cerrar y volver a buscarla en la rejilla.
    _zonasEditor.sheets = rCat.sheets || [];
    const rZonas = await api('/api/sheets/' + sheetId + '/zones');
    zonas = rZonas.zones || [];
  } catch (e) {
    alert('Error cargando datos: ' + e.message);
    return;
  }
  _zonasEditor.zonas = zonas;
  _zonasEditor.aprobada = !!sheet.zonas_aprobadas_at;
  _zonasEditor.aprobacionCambiada = false;

  const overlay = document.createElement('div');
  overlay.className = 'zonas-editor-overlay';
  overlay.id = 'zonas-editor-overlay';
  overlay.innerHTML = `
    <div class="zonas-editor-header">
      <div>
        <b>🎯 Zonas de productos</b>
        <span style="color:#9ca3af;font-size:13px">${escape(sheet.titulo || 'Lámina')}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="zonas-contador" id="zonas-contador">${zonas.length} zonas</span>
        <button class="btn" id="btn-borrar-todas-zonas" onclick="borrarTodasLasZonas(${sheet.id}, this)" style="background:#fee2e2;color:#b91c1c" title="Borra TODAS las zonas de esta lámina de golpe (ej. expositor grande que es 1 solo producto)">🗑️ Borrar todas</button>
        <button class="btn" id="btn-aprobar-zonas" onclick="toggleAprobarZonas(${sheet.id}, this)" style="background:${_zonasEditor.aprobada ? '#16a34a' : '#e5e7eb'};color:${_zonasEditor.aprobada ? '#fff' : '#374151'}" title="Marca esta lámina como revisada y aprobada por ti">${_zonasEditor.aprobada ? '✅ Revisada' : '☐ Marcar revisada'}</button>
        <button class="btn btn-primary" id="btn-detectar-zonas-ia" onclick="detectarZonasConIA(${sheet.id}, this)" title="La IA detecta los productos de la lámina y propone recuadros">🤖 Detectar productos con IA</button>
        <button class="btn" id="btn-detectar-precios-ia" onclick="detectarPreciosConIA(${sheet.id}, this)" style="background:#ede9fe;color:#6d28d9" title="La IA localiza los precios impresos y crea recuadros que los tapan y reescriben con el precio de la BD">🏷️ Detectar precios (IA)</button>
        <button class="btn" id="btn-modo-recuadro" onclick="toggleModoRecuadro(this)" style="background:#f3e8ff;color:#7c3aed" title="Dibuja a mano una caja sobre un precio para taparlo y reescribirlo (si la IA lo olvidó o falló)">✏️ Dibujar recuadro</button>
        <button class="btn" id="btn-borrar-recuadros" onclick="borrarTodosLosRecuadros(${sheet.id}, this)" style="background:#fee2e2;color:#b91c1c" title="Borra de golpe los recuadros de precio de esta lámina (por si la detección con IA no convence y quieres empezar de cero)">🗑️ Borrar precios</button>
        <button class="btn" id="btn-sig-sin-precios" onclick="irSiguienteSinPrecios()" style="background:#ede9fe;color:#6d28d9;font-weight:700" title="Cierra esta y abre directamente la siguiente lámina que tiene zonas pero aún no tiene precios asignados">⏭️ Siguiente sin precios${(() => { const n = _laminasPendientesPrecios().length; return n ? ' (' + n + ')' : ''; })()}</button>
        <button class="btn btn-secondary" onclick="cerrarEditorZonas()">Cerrar</button>
      </div>
    </div>
    <div class="zonas-editor-body">
      <div class="zonas-editor-lienzo-col">
        <div class="zonas-ayuda" id="zonas-ayuda">
          ✏️ <b>Arrastra</b> sobre la lámina para dibujar un rectángulo. Luego asígnale un producto en el panel derecho.
        </div>
        <div class="zonas-zoom-ctrl">
          🔍 <button type="button" onclick="zoomLienzo(-0.25)" title="Alejar">−</button>
          <span id="zonas-zoom-label">100%</span>
          <button type="button" onclick="zoomLienzo(0.25)" title="Acercar">+</button>
          <button type="button" onclick="zoomLienzoReset()" title="Ajustar a la ventana">Ajustar</button>
          <span style="font-size:11px;color:#9ca3af;margin-left:6px">🖱️ Rueda del ratón sobre la lámina = ampliar/reducir donde apuntas; arrastra las barras para moverte.</span>
        </div>
        <div class="zonas-lienzo-wrap" id="zonas-lienzo-wrap">
          <img src="${escape(vurl(sheet.imagen_path, sheet))}" class="zonas-lienzo-img" id="zonas-lienzo-img" draggable="false" alt="">
          <div class="zonas-recuadros-capa" id="zonas-recuadros-capa"></div>
          <div class="zonas-capa" id="zonas-capa"></div>
        </div>
      </div>
      <div class="zonas-editor-panel" id="zonas-panel">
        <!-- aquí va el detalle de la zona seleccionada o la lista -->
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Esperar a que la imagen cargue para montar los eventos de dibujo
  const img = document.getElementById('zonas-lienzo-img');
  if (img.complete) {
    montarLienzoZonas();
  } else {
    img.onload = () => montarLienzoZonas();
  }
  renderListaZonas();
  renderRecuadrosEnLienzo(sheetId); // F3: pintar recuadros de precio existentes
}

async function cerrarEditorZonas() {
  // Si hay zonas detectadas por IA SIN GUARDAR (id temporal "ia-..."), avisar para no perderlas.
  const nProp = (_zonasEditor.zonas || []).filter(z => typeof z.id === 'string' && z.id.startsWith('ia-')).length;
  if (nProp > 0) {
    const guardar = confirm('Tienes ' + nProp + ' zona' + (nProp === 1 ? '' : 's') + ' detectada' + (nProp === 1 ? '' : 's') + ' por IA SIN GUARDAR.\n\n• Aceptar = guardarlas ahora y cerrar\n• Cancelar = seguir en el editor (no se cierra)');
    if (!guardar) return; // no cerrar: el usuario sigue editando
    await guardarZonasDetectadas();
  }
  if (_zonasEditor.acProducto) { try { _zonasEditor.acProducto.destroy(); } catch {} _zonasEditor.acProducto = null; }
  const ov = document.getElementById('zonas-editor-overlay');
  if (ov) ov.remove();
  // SIEMPRE refrescamos la rejilla al cerrar. Antes solo se hacía si habías tocado
  // "Revisada", así que los precios/zonas creados (sobre todo saltando con "Siguiente
  // sin precios", que edita VARIAS láminas sin cerrar) seguían saliendo como "Sin
  // precios": la rejilla conservaba los datos de antes de editar.
  _zonasEditor.aprobacionCambiada = false;
  appState.editorRestoreSheetId = _zonasEditor.sheetId; // volver a esta lámina, no al principio
  if (typeof render === 'function') render();
}

// ----- ZOOM del lienzo del editor de zonas (para dibujar zonas pequeñas) -----
function aplicarZoomLienzo() {
  const img = document.getElementById('zonas-lienzo-img');
  const wrap = document.getElementById('zonas-lienzo-wrap');
  const lbl = document.getElementById('zonas-zoom-label');
  if (!img) return;
  const z = _zonasEditor.zoom || 1;
  if (z <= 1.001 || !_zonasEditor.baseW) {
    // Volver al ajuste natural (que la CSS mande)
    img.style.width = ''; img.style.height = ''; img.style.maxWidth = ''; img.style.maxHeight = '';
    if (wrap) { wrap.style.maxWidth = ''; wrap.style.width = ''; }
  } else {
    // Agrandar: quitamos los topes de img Y del wrap (si no, la capa de zonas se recorta)
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.width = Math.round(_zonasEditor.baseW * z) + 'px';
    img.style.height = 'auto';
    if (wrap) { wrap.style.maxWidth = 'none'; wrap.style.width = Math.round(_zonasEditor.baseW * z) + 'px'; }
  }
  if (lbl) lbl.textContent = Math.round(z * 100) + '%';
}
function zoomLienzo(delta) {
  const z = Math.max(1, Math.min(5, (_zonasEditor.zoom || 1) + delta));
  _zonasEditor.zoom = z;
  aplicarZoomLienzo();
}
function zoomLienzoReset() {
  _zonasEditor.zoom = 1;
  aplicarZoomLienzo();
}

// Borra TODAS las zonas de la lámina de golpe (expositor grande = 1 producto)
async function borrarTodasLasZonas(sheetId, boton) {
  const n = _zonasEditor.zonas.length;
  if (n === 0) { alert('Esta lámina no tiene zonas.'); return; }
  if (!confirm('¿Borrar las ' + n + ' zonas de esta lámina de golpe?\n\nÚtil cuando un expositor grande se detectó como muchas zonas pero en realidad es un solo producto. Los productos NO se borran, solo las zonas.')) return;
  const orig = boton ? boton.textContent : '';
  if (boton) { boton.disabled = true; boton.textContent = '⏳ Borrando…'; }
  try {
    await api('/api/sheets/' + sheetId + '/zones', { method: 'DELETE' });
    _zonasEditor.zonas = [];
    _zonasEditor.zonaSeleccionadaId = null;
    renderZonasEnCapa();
    renderListaZonas();
    actualizarContadorZonas();
    mostrarNotificacionOnline('🗑️ ' + n + ' zonas borradas', '#6b7280');
  } catch (err) {
    alert('Error borrando zonas: ' + err.message);
  } finally {
    if (boton) { boton.disabled = false; boton.textContent = orig; }
  }
}

// Marca/desmarca la lámina como revisada y aprobada por el admin
async function toggleAprobarZonas(sheetId, boton) {
  const nuevoEstado = !_zonasEditor.aprobada;
  try {
    await api('/api/sheets/' + sheetId + '/aprobar-zonas', { method: 'POST', body: { aprobada: nuevoEstado } });
    _zonasEditor.aprobada = nuevoEstado;
    _zonasEditor.aprobacionCambiada = true;
    if (boton) {
      boton.style.background = nuevoEstado ? '#16a34a' : '#e5e7eb';
      boton.style.color = nuevoEstado ? '#fff' : '#374151';
      boton.textContent = nuevoEstado ? '✅ Revisada' : '☐ Marcar revisada';
    }
    mostrarNotificacionOnline(nuevoEstado ? '✅ Lámina marcada como revisada' : 'Marca de revisada quitada', nuevoEstado ? '#16a34a' : '#6b7280');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function montarLienzoZonas() {
  const capa = document.getElementById('zonas-capa');
  const wrap = document.getElementById('zonas-lienzo-wrap');
  if (!capa || !wrap) return;

  // Guardar el ancho "ajustado" (zoom 1) para escalar desde ahí
  const imgBase = document.getElementById('zonas-lienzo-img');
  _zonasEditor.baseW = imgBase ? imgBase.clientWidth : 0;
  _zonasEditor.zoom = 1;
  const lbl = document.getElementById('zonas-zoom-label');
  if (lbl) lbl.textContent = '100%';

  renderZonasEnCapa();

  // Eventos de dibujo (ratón y táctil unificados)
  let rectTemp = null;

  function getRel(e) {
    const rect = wrap.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return {
      x: Math.max(0, Math.min(100, (cx / rect.width) * 100)),
      y: Math.max(0, Math.min(100, (cy / rect.height) * 100))
    };
  }

  function onDown(e) {
    // Si se pulsa sobre una zona existente, no dibujar (se gestiona con su propio click).
    // EXCEPCIÓN: en modo recuadro sí dibujamos encima de la zona (el precio está dentro).
    if (!_zonasEditor.modoRecuadro && e.target.classList.contains('zona-rect')) return;
    e.preventDefault();
    const p = getRel(e);
    _zonasEditor.dibujando = true;
    _zonasEditor.inicioX = p.x;
    _zonasEditor.inicioY = p.y;
    rectTemp = document.createElement('div');
    rectTemp.className = 'zona-rect zona-rect-temp';
    rectTemp.style.left = p.x + '%';
    rectTemp.style.top = p.y + '%';
    rectTemp.style.width = '0%';
    rectTemp.style.height = '0%';
    capa.appendChild(rectTemp);
  }

  function onMove(e) {
    if (!_zonasEditor.dibujando || !rectTemp) return;
    e.preventDefault();
    const p = getRel(e);
    const x = Math.min(p.x, _zonasEditor.inicioX);
    const y = Math.min(p.y, _zonasEditor.inicioY);
    const w = Math.abs(p.x - _zonasEditor.inicioX);
    const h = Math.abs(p.y - _zonasEditor.inicioY);
    rectTemp.style.left = x + '%';
    rectTemp.style.top = y + '%';
    rectTemp.style.width = w + '%';
    rectTemp.style.height = h + '%';
  }

  async function onUp(e) {
    if (!_zonasEditor.dibujando || !rectTemp) return;
    _zonasEditor.dibujando = false;
    const x = parseFloat(rectTemp.style.left);
    const y = parseFloat(rectTemp.style.top);
    const w = parseFloat(rectTemp.style.width);
    const h = parseFloat(rectTemp.style.height);
    rectTemp.remove();
    rectTemp = null;
    // En modo recuadro de precio: la caja dibujada crea un RECUADRO (tapar+reescribir),
    // no una zona. Umbral más bajo porque los precios son pequeños.
    if (_zonasEditor.modoRecuadro) {
      if (w < 0.6 || h < 0.4) return;
      return crearRecuadroDibujado(x, y, w, h);
    }
    // Ignorar rectángulos minúsculos (clicks accidentales)
    if (w < 2 || h < 2) return;
    // Crear la zona en el servidor
    try {
      const r = await api('/api/sheets/' + _zonasEditor.sheetId + '/zones', {
        method: 'POST',
        body: { x, y, ancho: w, alto: h }
      });
      _zonasEditor.zonas.push(r.zone);
      _zonasEditor.zonaSeleccionadaId = r.zone.id;
      renderZonasEnCapa();
      renderListaZonas();
      actualizarContadorZonas();
    } catch (err) {
      alert('Error creando zona: ' + err.message);
    }
  }

  wrap.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  wrap.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);

  // Listeners globales para mover / redimensionar zonas ya existentes
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragUp);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('touchend', onDragUp);

  // ZOOM CON LA RUEDA del ratón, centrado en el cursor (sin subir a los botones +/−).
  // Ampliamos hacia el punto donde está el cursor recolocando el scroll del contenedor.
  const col = wrap.closest('.zonas-editor-lienzo-col');
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const z0 = _zonasEditor.zoom || 1;
    const z1 = Math.max(1, Math.min(5, z0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    if (Math.abs(z1 - z0) < 0.001) return;
    let r = null, cx = 0, cy = 0;
    if (col) {
      r = col.getBoundingClientRect();
      cx = e.clientX - r.left + col.scrollLeft;   // punto del contenido bajo el cursor
      cy = e.clientY - r.top + col.scrollTop;
    }
    _zonasEditor.zoom = z1;
    aplicarZoomLienzo();
    if (col && r) {
      const k = z1 / z0;  // el contenido escala desde su esquina sup-izq
      col.scrollLeft = cx * k - (e.clientX - r.left);
      col.scrollTop = cy * k - (e.clientY - r.top);
    }
  }, { passive: false });
}

function renderZonasEnCapa() {
  const capa = document.getElementById('zonas-capa');
  if (!capa) return;
  capa.innerHTML = '';
  _zonasEditor.zonas.forEach((z, idx) => {
    const div = document.createElement('div');
    const asignada = !!z.product_id;
    const propuestaIA = !!z.propuesta_ia;
    const seleccionada = z.id === _zonasEditor.zonaSeleccionadaId;
    div.className = 'zona-rect' +
                    (propuestaIA ? ' zona-rect-ia' : (asignada ? ' zona-rect-asignada' : ' zona-rect-vacia')) +
                    (seleccionada ? ' zona-rect-sel' : '') +
                    (z.id === _zonaRecienCreadaId ? ' zona-rect-nueva' : '');
    div.style.left = z.x + '%';
    div.style.top = z.y + '%';
    div.style.width = z.ancho + '%';
    div.style.height = z.alto + '%';
    div.dataset.zoneId = z.id;
    // Handles solo en la zona seleccionada (4 esquinas para redimensionar)
    const handles = seleccionada
      ? `<div class="zona-handle zona-handle-nw" data-dir="nw"></div>
         <div class="zona-handle zona-handle-ne" data-dir="ne"></div>
         <div class="zona-handle zona-handle-se" data-dir="se"></div>
         <div class="zona-handle zona-handle-sw" data-dir="sw"></div>`
      : '';
    div.innerHTML = `<span class="zona-num">${idx + 1}</span>${handles}`;
    div.addEventListener('mousedown', (e) => onZonaMouseDown(e, z));
    div.addEventListener('touchstart', (e) => onZonaMouseDown(e, z), { passive: false });
    capa.appendChild(div);
  });
}

// Estado del arrastre en curso
const _dragZona = { activo: false, zonaId: null, tipo: null, inicioX: 0, inicioY: 0, origX: 0, origY: 0, origW: 0, origH: 0 };

function onZonaMouseDown(e, zona) {
  // En modo recuadro no interactuamos con la zona: dejamos que el lienzo dibuje encima.
  if (_zonasEditor.modoRecuadro) return;
  // Click derecho o modificadores: ignorar
  if (e.button != null && e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  // Seleccionar zona (siempre)
  _zonasEditor.zonaSeleccionadaId = zona.id;
  renderZonasEnCapa();
  renderListaZonas();
  // Detectar si es click sobre un handle (redimensionar) o sobre el cuerpo (mover)
  const dir = e.target?.dataset?.dir;
  _dragZona.activo = true;
  _dragZona.zonaId = zona.id;
  _dragZona.tipo = dir || 'move';
  const pt = getPuntoEvento(e);
  _dragZona.inicioX = pt.x;
  _dragZona.inicioY = pt.y;
  _dragZona.origX = zona.x;
  _dragZona.origY = zona.y;
  _dragZona.origW = zona.ancho;
  _dragZona.origH = zona.alto;
}

function getPuntoEvento(e) {
  const wrap = document.getElementById('zonas-lienzo-wrap');
  const rect = wrap.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  return {
    x: (cx / rect.width) * 100,
    y: (cy / rect.height) * 100
  };
}

function onDragMove(e) {
  if (!_dragZona.activo) return;
  const zona = _zonasEditor.zonas.find(z => z.id === _dragZona.zonaId);
  if (!zona) return;
  e.preventDefault();
  const p = getPuntoEvento(e);
  const dx = p.x - _dragZona.inicioX;
  const dy = p.y - _dragZona.inicioY;
  const t = _dragZona.tipo;
  if (t === 'move') {
    zona.x = Math.max(0, Math.min(100 - _dragZona.origW, _dragZona.origX + dx));
    zona.y = Math.max(0, Math.min(100 - _dragZona.origH, _dragZona.origY + dy));
  } else {
    // Redimensionar según esquina
    let nx = _dragZona.origX, ny = _dragZona.origY;
    let nw = _dragZona.origW, nh = _dragZona.origH;
    if (t.includes('e')) nw = Math.max(1, Math.min(100 - _dragZona.origX, _dragZona.origW + dx));
    if (t.includes('w')) {
      nx = Math.max(0, Math.min(_dragZona.origX + _dragZona.origW - 1, _dragZona.origX + dx));
      nw = _dragZona.origW - (nx - _dragZona.origX);
    }
    if (t.includes('s')) nh = Math.max(1, Math.min(100 - _dragZona.origY, _dragZona.origH + dy));
    if (t.includes('n')) {
      ny = Math.max(0, Math.min(_dragZona.origY + _dragZona.origH - 1, _dragZona.origY + dy));
      nh = _dragZona.origH - (ny - _dragZona.origY);
    }
    zona.x = nx; zona.y = ny; zona.ancho = nw; zona.alto = nh;
  }
  // Repintar solo la posición (sin re-render entero para fluidez)
  const div = document.querySelector('.zona-rect[data-zone-id="' + CSS.escape(String(zona.id)) + '"]');
  if (div) {
    div.style.left = zona.x + '%';
    div.style.top = zona.y + '%';
    div.style.width = zona.ancho + '%';
    div.style.height = zona.alto + '%';
  }
}

async function onDragUp() {
  if (!_dragZona.activo) return;
  const zonaId = _dragZona.zonaId;
  _dragZona.activo = false;
  const zona = _zonasEditor.zonas.find(z => z.id === zonaId);
  if (!zona) return;
  // Si es propuesta IA (id string), no persistir todavía
  const esPropuestaIA = typeof zona.id === 'string' && zona.id.startsWith('ia-');
  if (esPropuestaIA) return;
  // Persistir en BD
  try {
    await api('/api/zones/' + zona.id, {
      method: 'PUT',
      body: { x: zona.x, y: zona.y, ancho: zona.ancho, alto: zona.alto }
    });
  } catch (err) {
    console.warn('Fallo guardando coords zona:', err);
  }
}

function actualizarContadorZonas() {
  const c = document.getElementById('zonas-contador');
  if (c) c.textContent = _zonasEditor.zonas.length + ' zonas';
}

function renderListaZonas() {
  const panel = document.getElementById('zonas-panel');
  if (!panel) return;

  const sel = _zonasEditor.zonas.find(z => z.id === _zonasEditor.zonaSeleccionadaId);

  // Botón "Guardar detectadas" — visible SIEMPRE que haya zonas propuestas por IA (ia-),
  // tanto en la lista como en el detalle, para que no se pierdan al cerrar.
  const nProp = _zonasEditor.zonas.filter(z => typeof z.id === 'string' && z.id.startsWith('ia-')).length;
  const btnGuardarDet = nProp > 0
    ? `<button onclick="guardarZonasDetectadas()" style="width:100%;margin-bottom:10px;background:#16a34a;color:#fff;padding:9px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700">💾 Guardar ${nProp} zona${nProp === 1 ? '' : 's'} detectada${nProp === 1 ? '' : 's'}</button>`
    : '';

  if (!sel) {
    // Vista de lista general
    panel.innerHTML = `
      ${btnGuardarDet}
      ${nProp > 0 ? `<div style="font-size:11px;color:#6b7280;margin-bottom:10px">Las zonas naranjas son propuestas de la IA. Al asignarles producto o pulsar Guardar se fijan en la lámina.</div>` : ''}
      <h4 style="margin-top:0">Zonas dibujadas</h4>
      ${_zonasEditor.zonas.length === 0
        ? '<p style="color:#9ca3af;font-size:13px">Aún no hay zonas. Arrastra sobre la lámina para crear la primera.</p>'
        : _zonasEditor.zonas.map((z, idx) => `
          <div class="zona-lista-item" onclick="seleccionarZona('${String(z.id).replace(/'/g, "\\'")}')">
            <span class="zona-lista-num">${idx + 1}</span>
            <span class="zona-lista-info">
              ${z.product_id
                ? `<b>${escape(z.producto_codigo || '')}</b> ${escape(z.producto_nombre || '')}`
                : z.familia_ref
                  ? `<span style="color:#a855f7">👓 Familia: ${escape(z.familia_ref)}</span>`
                  : z.es_comision
                    ? `<span style="color:#ea580c">🤝 Comisión: ${escape(z.etiqueta || '(sin nombre)')}</span>`
                    : z.link_catalog_id
                      ? `<span style="color:#2563eb">🔗 Enlace: ${escape(z.link_catalog_nombre || ('catálogo #' + z.link_catalog_id))}</span>`
                      : '<span style="color:#f59e0b">⚠️ Sin producto asignado</span>'}
              ${z.permite_sueltas ? '<span style="color:#0d9488" title="Permite referencias sueltas (expositor)"> · 🕶️ sueltas</span>' : ''}
            </span>
          </div>
        `).join('')}
    `;
    return;
  }

  // Vista de detalle de zona seleccionada
  const idx = _zonasEditor.zonas.indexOf(sel) + 1;
  panel.innerHTML = `
    ${btnGuardarDet}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h4 style="margin:0">Zona ${idx}</h4>
      <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="deseleccionarZona()">← Volver</button>
    </div>
    ${sel.link_catalog_id ? `
      <div class="zona-producto-actual" style="background:#eff6ff;border-color:#bfdbfe">
        <div style="font-size:11px;color:#2563eb;font-weight:600;margin-bottom:4px">🔗 Enlace a otro catálogo</div>
        Destino: <b>${escape(sel.link_catalog_nombre || ('catálogo #' + sel.link_catalog_id))}</b>
        ${sel.link_sheet_id ? `<div style="font-size:12px;color:#374151;margin-top:2px">Página: <b>${escape(sel.link_sheet_titulo || ('lámina #' + sel.link_sheet_id))}</b></div>` : `<div style="font-size:12px;color:#6b7280;margin-top:2px">Abre por la página 1</div>`}
        <div style="font-size:12px;color:#374151;margin-top:2px">Botón: <b>${escape(sel.link_label || ('🔗 ' + (sel.link_catalog_nombre || 'Ver catálogo') + ' →'))}</b></div>
      </div>
    ` : sel.es_comision ? `
      <div class="zona-producto-actual" style="background:#fff7ed;border-color:#fed7aa">
        <div style="font-size:11px;color:#ea580c;font-weight:600;margin-bottom:4px">🤝 Producto de comisión (no se factura)</div>
        Producto: <b>${escape(sel.etiqueta || '(sin nombre)')}</b>${(sel.comision_variantes && sel.comision_variantes.length) ? ` · <span style="color:#ea580c">${sel.comision_variantes.length} variante${sel.comision_variantes.length === 1 ? '' : 's'}</span>` : ''}
        <div style="font-size:12px;color:#6b7280;margin-top:4px">El comercial ${(sel.comision_variantes && sel.comision_variantes.length) ? 'elige variante y ' : ''}anota unidades + descuento + almacén + nº socio.</div>
      </div>
    ` : sel.familia_ref ? `
      <div class="zona-producto-actual" style="background:#faf5ff;border-color:#e9d5ff">
        <div style="font-size:11px;color:#a855f7;font-weight:600;margin-bottom:4px">👓 Familia con variantes</div>
        Modelo: <b>${escape(sel.familia_ref)}</b>
        <div id="fam-preview-${sel.id}" style="font-size:12px;color:#6b7280;margin-top:4px">Cargando variantes…</div>
        <button class="btn" style="width:auto;flex:0 0 auto;background:#a855f7;color:#fff;padding:5px 10px;font-size:12px;margin-top:8px" onclick="copiarFamiliaPortapapeles('${String(sel.id).replace(/'/g, "\\'")}')" title="Copiar esta familia para pegarla en una zona de OTRA lámina">📋 Copiar familia (para otra lámina)</button>
      </div>
    ` : sel.product_id ? `
      <div class="zona-producto-actual">
        <div style="font-size:11px;color:#16a34a;font-weight:600;margin-bottom:4px">✅ Producto asignado</div>
        <b>${escape(sel.producto_codigo || '')}</b> · ${escape(sel.producto_nombre || '')}<br>
        <span style="font-size:12px;color:#6b7280">PVF ${sel.producto_pvf ? Number(sel.producto_pvf).toFixed(2) + '€' : '—'}</span>
      </div>
    ` : `
      <div style="background:#fef3c7;border:1px solid #fcd34d;padding:8px;border-radius:6px;font-size:12px;color:#78350f;margin-bottom:10px">
        ⚠️ Esta zona no tiene producto. Asigna un producto suelto, una familia o márcala de comisión (abajo).
      </div>
    `}
    <button onclick="enfocarEdicionZona()" style="width:100%;margin-bottom:12px;background:#111827;color:#fff;padding:9px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700">${sel.product_id ? '✏️ Editar datos del producto' : '✏️ Editar esta zona'}</button>
    ${(!sel.familia_ref && !sel.es_comision && !sel.link_catalog_id) ? `
      <div class="form-group">
        <label style="font-size:13px">${sel.product_id ? '🔄 Cambiar producto' : '➕ Asignar producto suelto'}</label>
        <div style="font-size:11px;color:#6b7280;margin:2px 0 6px">Escribe el nombre o código y <b>elígelo de la lista</b> que aparece.</div>
        <div id="zona-ac-contenedor"></div>
      </div>
    ` : ''}
    ${(!sel.es_comision && !sel.link_catalog_id) ? `
      <div class="form-group" style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:10px">
        <label style="font-size:13px;font-weight:600">👓 ${sel.familia_ref ? 'Editar' : 'Marcar como'} familia (gafas, guantes, tapes…)</label>
        ${_familiaPortapapeles ? `<button class="btn" style="width:100%;background:#7c3aed;color:#fff;padding:8px;font-size:12px;font-weight:700;margin:2px 0 8px" onclick="pegarFamiliaPortapapeles('${String(sel.id).replace(/'/g, "\\'")}')" title="Aplicar aquí la familia que copiaste en otra lámina">📋 Pegar familia copiada: ${escape(_familiaPortapapeles.familia_ref || '(sin nombre)')}${_familiaPortapapeles.n ? ' · ' + _familiaPortapapeles.n + ' variantes' : ''}</button>` : ''}
        <div style="font-size:11px;color:#6b7280;margin:4px 0 6px">Escribe el <b>modelo</b> (ej: Verona) y pulsa Buscar. Te muestro sus variantes (color/graduación) para que <b>elijas cuáles van</b>; también puedes añadir códigos a mano.</div>
        <input type="text" id="fam-input-${sel.id}" value="${sel.familia_ref ? escape(sel.familia_ref).replace(/"/g,'&quot;') : ''}" placeholder="ej: Verona, Aspen, Guantes nitrilo azul" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:6px">
        <button class="btn btn-primary" style="width:100%;padding:9px;font-size:13px;font-weight:700" onclick="abrirSelectorVariantesFamilia('${String(sel.id).replace(/'/g, "\\'")}')">🔍 Buscar y elegir variantes</button>
        ${sel.familia_ref ? `<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;margin-top:6px" onclick="quitarFamiliaZona('${String(sel.id).replace(/'/g, "\\'")}')">Quitar familia (volver a producto suelto)</button>` : ''}
      </div>
    ` : ''}
    ${!sel.link_catalog_id ? `
      <div class="form-group" style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:10px">
        <label style="font-size:13px;font-weight:600">🕶️ Referencias sueltas (expositor de gafas…)</label>
        <div style="font-size:11px;color:#6b7280;margin:4px 0 6px">Si esta zona es un <b>expositor</b> del que el cliente puede pedir <b>unidades sueltas que NO están en Sage</b>, actívalo. En la visita el comercial anotará cada referencia + unidades a mano, sin dar de alta cada artículo. ${(sel.product_id || sel.es_comision) ? 'Se conserva el pedido del expositor completo.' : ''}</div>
        <button class="btn" style="width:auto;flex:0 0 auto;background:${sel.permite_sueltas ? '#0d9488' : '#6b7280'};color:#fff;padding:7px 12px;font-size:12px" onclick="toggleSueltasZona('${String(sel.id).replace(/'/g, "\\'")}')">${sel.permite_sueltas ? '✓ Activado — desactivar' : 'Activar referencias sueltas'}</button>
      </div>
    ` : ''}
    ${(!sel.familia_ref && !sel.link_catalog_id) ? `
      <div class="form-group" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px">
        <label style="font-size:13px;font-weight:600">🤝 ${sel.es_comision ? 'Editar' : 'Marcar como'} producto de comisión (Lainco…)</label>
        <div style="font-size:11px;color:#6b7280;margin:4px 0 6px">Productos que NO facturamos. El comercial anota unidades + descuento + almacén + nº socio.</div>
        <input type="text" id="com-nombre-${sel.id}" value="${escape(sel.etiqueta || '').replace(/"/g,'&quot;')}" placeholder="Nombre del producto (ej: Emulquien Laxante 230 ml)" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:6px">
        <button class="btn" style="background:#ea580c;color:#fff;padding:7px 12px;font-size:12px" onclick="marcarComisionZona('${String(sel.id).replace(/'/g, "\\'")}')">${sel.es_comision ? 'Guardar nombre' : 'Marcar de comisión'}</button>
        ${sel.es_comision ? `
          <div style="margin-top:10px;border-top:1px dashed #fed7aa;padding-top:8px">
            <label style="font-size:12px;font-weight:600;color:#ea580c">Variantes / referencias (opcional) · ${(sel.comision_variantes || []).length}</label>
            <div style="font-size:11px;color:#6b7280;margin:2px 0 6px">Si tiene varias (colores, referencias…), añádelas. El comercial elegirá una en un desplegable durante la visita.</div>
            <div id="com-var-lista-${sel.id}" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
              ${(sel.comision_variantes || []).map((v, idx) => `<span class="fam-chip" style="background:var(--surface);border:1px solid #fed7aa">${escape(String(v))} <button onclick="quitarVarianteComision('${String(sel.id).replace(/'/g, "\\'")}',${idx})" style="border:none;background:none;color:#dc2626;cursor:pointer;font-weight:700;padding:0 2px">×</button></span>`).join('')}
            </div>
            <label style="font-size:11px;color:#374151;font-weight:600">Buscar producto y añadir</label>
            <div id="com-var-ac-${sel.id}" style="margin:2px 0 8px"></div>
            <div style="font-size:11px;color:#9ca3af;margin-bottom:2px">…o escribe una variante a mano:</div>
            <div style="display:flex;gap:6px;align-items:stretch">
              <input type="text" id="com-var-input-${sel.id}" placeholder="ej: Loción roja ref 12" onkeydown="if(event.key==='Enter'){event.preventDefault();anadirVarianteComision('${String(sel.id).replace(/'/g, "\\'")}')}" style="flex:1 1 auto;min-width:0;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">
              <button class="btn" style="width:auto;flex:0 0 auto;background:#ea580c;color:#fff;padding:8px 14px;font-size:12px;white-space:nowrap" onclick="anadirVarianteComision('${String(sel.id).replace(/'/g, "\\'")}')">+ Añadir</button>
            </div>
          </div>
          <button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;margin-top:8px" onclick="quitarComisionZona('${String(sel.id).replace(/'/g, "\\'")}')">Quitar comisión (volver a producto suelto)</button>
        ` : ''}
      </div>
    ` : ''}
    ${(!sel.familia_ref && !sel.es_comision) ? `
      <div class="form-group" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px">
        <label style="font-size:13px;font-weight:600">🔗 ${sel.link_catalog_id ? 'Editar' : 'Convertir en'} enlace a otro catálogo</label>
        <div style="font-size:11px;color:#6b7280;margin:4px 0 6px">El comercial verá un <b>botón</b> aquí; solo salta si lo pulsa (no se toca sin querer).</div>
        <label style="font-size:12px;color:#374151">Catálogo destino</label>
        <select id="link-sel-${sel.id}" onchange="cargarPaginasDestino('${String(sel.id).replace(/'/g, "\\'")}')" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:6px"><option value="">Cargando catálogos…</option></select>
        <label style="font-size:12px;color:#374151">Página destino</label>
        <select id="link-pag-${sel.id}" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:6px"><option value="">Todo el catálogo (empieza en la pág. 1)</option></select>
        <label style="font-size:12px;color:#374151">Al volver, ir a…</label>
        <select id="link-back-${sel.id}" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:2px"><option value="">Donde estaba (la página del botón)</option></select>
        <div style="font-size:10px;color:#9ca3af;margin-bottom:6px">Útil para <b>saltarte las hojas que quedan</b> de este laboratorio al regresar.</div>
        <label style="font-size:12px;color:#374151">Texto del botón</label>
        <input type="text" id="link-lbl-${sel.id}" value="${escape(sel.link_label || '').replace(/"/g,'&quot;')}" placeholder="ej: Ver Catálogo BSN" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;margin-bottom:6px">
        <button class="btn btn-primary" style="padding:7px 12px;font-size:12px" onclick="aplicarEnlaceZona('${String(sel.id).replace(/'/g, "\\'")}')">${sel.link_catalog_id ? 'Guardar enlace' : 'Crear enlace'}</button>
        ${sel.link_catalog_id ? `<button class="btn btn-secondary" style="padding:5px 10px;font-size:12px;margin-top:6px" onclick="quitarEnlaceZona('${String(sel.id).replace(/'/g, "\\'")}')">Quitar enlace (volver a producto suelto)</button>` : ''}
      </div>
    ` : ''}
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn" style="background:#0ea5e9;color:#fff;flex:1" onclick="duplicarZona('${String(sel.id).replace(/'/g, "\\'")}')" title="Crea una copia del MISMO tamaño SIN producto (para rejillas/expositores); luego la mueves y le asignas su producto">⧉ Duplicar</button>
      <button class="btn" style="background:#7c3aed;color:#fff;flex:1" onclick="clonarZona('${String(sel.id).replace(/'/g, "\\'")}')" title="Crea una copia con TODOS los datos (producto/familia/comisión/enlace); luego la mueves a su sitio">🧬 Clonar</button>
    </div>
    <div style="margin-top:8px">
      <button class="btn" style="background:#dc2626;color:#fff;width:100%" onclick="borrarZona('${String(sel.id).replace(/'/g, "\\'")}')">🗑️ Borrar zona</button>
    </div>
  `;

  // Cargar preview de variantes si la zona es familia
  if (sel.familia_ref || (Array.isArray(sel.familia_skus) && sel.familia_skus.length)) cargarPreviewFamiliaAdmin(sel);
  // Cargar catálogos en el desplegable de enlace (si el bloque está visible)
  if (!sel.familia_ref && !sel.es_comision) {
    cargarCatalogosEnSelectEnlace(sel.id, sel.link_catalog_id, sel.link_sheet_id);
    cargarPaginasRegreso(sel.id, sel.link_back_sheet_id);
  }

  // Buscador de producto para AÑADIR VARIANTES a una familia de comisión.
  if (sel.es_comision) {
    if (_zonasEditor.acComisionVar) { try { _zonasEditor.acComisionVar.destroy(); } catch {} _zonasEditor.acComisionVar = null; }
    const contCV = document.getElementById('com-var-ac-' + sel.id);
    if (contCV && typeof montarAutocompleteProducto === 'function') {
      _zonasEditor.acComisionVar = montarAutocompleteProducto(contCV, {
        placeholder: 'Buscar por código o nombre (ej: emuliquen)…',
        onSelect: async (p) => { if (!p) return; await _anadirVarianteComisionValor(sel.id, (p.codigo ? p.codigo + ' · ' : '') + (p.nombre || '')); },
        onCrear: (nom, alCrear) => abrirModalCrearProductoVuelo(nom, alCrear)
      });
    }
  }

  // Montar el autocomplete dentro del panel
  if (_zonasEditor.acProducto) { try { _zonasEditor.acProducto.destroy(); } catch {} }
  const cont = document.getElementById('zona-ac-contenedor');
  if (!cont) return; // zona-familia/comision: no hay buscador de producto suelto
  _zonasEditor.acProducto = montarAutocompleteProducto(cont, {
    placeholder: 'Buscar producto…',
    onSelect: async (producto) => {
      if (!producto) return;
      try {
        await _persistirZonaSiPropuesta(sel.id); // si es propuesta IA, crearla en BD primero
        await api('/api/zones/' + sel.id, {
          method: 'PUT',
          body: { product_id: producto.id }
        });
        // Actualizar en memoria
        sel.product_id = producto.id;
        sel.producto_codigo = producto.codigo;
        sel.producto_nombre = producto.nombre;
        sel.producto_pvf = producto.precio_pvf;
        renderZonasEnCapa();
        renderListaZonas();
        mostrarNotificacionOnline('✅ Producto asignado a la zona', '#16a34a');
      } catch (err) {
        alert('Error asignando producto: ' + err.message);
      }
    },
    onCrear: (nombreSugerido, alCrear) => {
      abrirModalCrearProductoVuelo(nombreSugerido, alCrear);
    }
  });
}

// Muestra un resumen de las variantes que resuelve una familia (en el editor admin).
// Si la zona tiene lista curada (familia_skus) usa esa; si no, resuelve por el modelo.
async function cargarPreviewFamiliaAdmin(sel) {
  const el = document.getElementById('fam-preview-' + sel.id);
  if (!el) return;
  try {
    const curada = Array.isArray(sel.familia_skus) && sel.familia_skus.length;
    const q = curada
      ? '/api/families/resolve?ids=' + sel.familia_skus.join(',')
      : '/api/families/resolve?ref=' + encodeURIComponent(sel.familia_ref || '');
    const r = await api(q);
    if (r && r.familia) {
      const ejes = (r.familia.ejes || []).map(e => e.label + ': ' + e.valores.join('/')).join(' · ');
      const zidJs = String(sel.id).replace(/'/g, "\\'");
      const cab = '<b>' + r.familia.n_variantes + '</b> variantes' + (curada ? ' (elegidas a mano)' : '') + (ejes ? ' — ' + escape(ejes) : ' (sin ejes a elegir)')
        + '<div style="font-size:11px;color:#9ca3af;margin-top:2px">✏️ = editar datos/precio de ese producto · 🔄 = cambiarlo por otro de la base de datos.</div>'
        + '<button class="btn" style="width:100%;background:#7c3aed;color:#fff;padding:7px;font-size:12px;font-weight:700;margin-top:6px" onclick="abrirSelectorVariantesFamilia(\'' + zidJs + '\')">🔄 Cambiar / quitar / añadir miembros</button>';
      // Lista de variantes CON PRECIO (PVF/PVPR). ✏️ edita ese producto; 🔄 abre el
      // selector para SUSTITUIR ese miembro por otro de la BD (sin crear referencia nueva).
      const vs = r.familia.variantes || [];
      const filas = vs.map(v => {
        const detalle = (v.ejes && (v.ejes.color || v.ejes.graduacion || v.ejes.talla || v.ejes.formato))
          ? ' <span style="color:#a855f7">(' + escape([v.ejes.color, v.ejes.graduacion, v.ejes.talla, v.ejes.formato].filter(Boolean).join(' · ')) + ')</span>' : '';
        const pvf = (v.pvf != null && v.pvf !== '') ? Number(v.pvf).toFixed(2) + '€' : '—';
        const pvpr = (v.pvpr != null && v.pvpr !== '') ? Number(v.pvpr).toFixed(2) + '€' : null;
        const precioSospechoso = (v.pvf == null || Number(v.pvf) === 0);
        // Layout en DOS LÍNEAS: nombre (a lo ancho, puede envolver) y debajo precio +
        // botones. Antes iban en un flex de una línea y con nombres largos el precio se
        // montaba encima del nombre.
        return '<div style="padding:6px 4px;border-bottom:1px solid #f3e8ff">'
          + '<div style="word-break:break-word"><b>' + escape(v.codigo || '') + '</b> · ' + escape(v.nombre || '') + detalle + '</div>'
          + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px">'
          +   '<span style="white-space:nowrap;color:' + (precioSospechoso ? '#dc2626' : '#16a34a') + ';font-weight:600">PVF ' + pvf
          +     (pvpr ? '<span style="color:#6b7280;font-weight:400"> · PVPR ' + pvpr + '</span>' : '') + '</span>'
          +   '<span style="display:flex;gap:6px;flex:0 0 auto">'
          +     '<button class="btn" style="width:auto;flex:0 0 auto;background:#eef2ff;color:#4338ca;padding:2px 8px;font-size:12px" onclick="abrirDetalleProducto(' + Number(v.product_id) + ')" title="Editar datos/precio de este producto">✏️</button>'
          +     '<button class="btn" style="width:auto;flex:0 0 auto;background:#f3e8ff;color:#7c3aed;padding:2px 8px;font-size:12px" onclick="abrirSelectorVariantesFamilia(\'' + zidJs + '\')" title="Cambiar este miembro por otro de la base de datos">🔄</button>'
          +   '</span>'
          + '</div>'
          + '</div>';
      }).join('');
      el.innerHTML = cab
        + '<div style="max-height:34vh;overflow-y:auto;margin-top:6px;background:var(--surface);border:1px solid #e9d5ff;border-radius:6px;padding:6px;font-size:12px">'
        + (filas || '<span style="color:#9ca3af">Sin variantes que mostrar</span>')
        + '</div>';
    } else {
      el.innerHTML = '<span style="color:#dc2626">⚠️ No encuentra variantes</span>';
    }
  } catch { el.textContent = 'Error cargando variantes'; }
}

// ============================================================================
// SELECTOR DE VARIANTES DE FAMILIA (curado a mano) — el admin escribe el modelo,
// el sistema propone las variantes (por nombre) con casillas, y puede añadir
// códigos a mano. Se guarda la lista exacta en familia_skus.
// ============================================================================
let _famSelector = null; // { zoneId, items: [{product_id, codigo, nombre, color, graduacion, checked}] }
let _famAddTimer = null;
let _famAddResultados = []; // últimos resultados del buscador "añadir a mano" (para no meter el nombre en el onclick)

async function abrirSelectorVariantesFamilia(zoneId) {
  const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
  if (!sel) return;
  _famSelector = { zoneId, items: [] };
  // Si la zona ya tiene lista curada, cargarla (marcada)
  if (Array.isArray(sel.familia_skus) && sel.familia_skus.length) {
    try {
      const r = await api('/api/families/resolve?ids=' + sel.familia_skus.join(','));
      if (r.familia) _famSelector.items = r.familia.variantes.map(v => ({ product_id: v.product_id, codigo: v.codigo, nombre: v.nombre, color: (v.ejes && v.ejes.color) || '', graduacion: (v.ejes && v.ejes.graduacion) || '', pvf: (v.pvf != null ? v.pvf : null), checked: true }));
    } catch (_) {}
  }
  const modeloInicial = ((document.getElementById('fam-input-' + zoneId) || {}).value || sel.familia_ref || '').trim();
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.id = 'fam-selector-modal';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>👓 Elegir variantes de la familia</h3>
        <button class="modal-cerrar" onclick="cerrarSelectorFamilia()">×</button>
      </div>
      <div class="form-group">
        <label style="font-size:13px;font-weight:600">Modelo</label>
        <div style="font-size:11px;color:#6b7280;margin:2px 0 6px">Escríbelo como aparece en la lámina (ej: Verona) y pulsa Buscar.</div>
        <div style="display:flex;gap:6px">
          <input id="fam-modelo-buscar" value="${escape(modeloInicial).replace(/"/g,'&quot;')}" placeholder="ej: Verona, Aspen" style="flex:1;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:6px" onkeydown="if(event.key==='Enter'){event.preventDefault();buscarVariantesFamilia();}">
          <button class="btn btn-primary" style="padding:8px 14px" onclick="buscarVariantesFamilia()">🔍 Buscar</button>
        </div>
        <div id="fam-buscar-msg" style="font-size:12px;color:#6b7280;margin-top:4px"></div>
      </div>
      <div style="font-size:13px;font-weight:600;margin:8px 0 4px">Variantes (marca las que van): <span style="font-size:10px;color:#9ca3af;font-weight:400">🔄 Cambiar = sustituir por otro · ✕ = quitar · ↕ arrastra el borde para agrandar</span></div>
      <div id="fam-lista-variantes" style="min-height:90px;max-height:70vh;overflow:auto;resize:vertical;border:1px solid #eee;border-radius:8px;padding:6px"></div>
      <div class="form-group" style="margin-top:12px">
        <label style="font-size:13px;font-weight:600">➕ Añadir otro producto a mano</label>
        <div style="font-size:11px;color:#6b7280;margin:2px 0 6px">Por si algún código está escrito raro en Sage. Busca por nombre o código. <span style="color:#9ca3af">↕ arrastra el borde inferior de la lista para ver más.</span></div>
        <input id="fam-add-buscar" placeholder="Buscar producto…" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:6px" oninput="buscarProductoParaFamilia(this.value)">
        <div id="fam-add-resultados" style="max-height:70vh;overflow:auto;resize:vertical;margin-top:4px"></div>
      </div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="cerrarSelectorFamilia()">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarFamiliaCurada()">💾 Guardar familia (<span id="fam-count">0</span>)</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  // Ventana FLOTANTE + arrastrable por la cabecera (para apartarla y ver la lámina)
  modal.style.background = 'transparent';
  modal.style.pointerEvents = 'none';
  const cardEl = modal.querySelector('.modal-card');
  const headerEl = modal.querySelector('.modal-header');
  if (cardEl) {
    cardEl.style.pointerEvents = 'auto';
    cardEl.style.boxShadow = '0 12px 45px rgba(0,0,0,0.35)';
    cardEl.style.border = '1px solid #e5e7eb';
  }
  if (headerEl) headerEl.insertAdjacentHTML('afterbegin', '<span style="font-size:11px;color:#9ca3af;font-weight:400;margin-right:6px">✥ arrastra</span>');
  if (typeof hacerVentanaArrastrable === 'function') hacerVentanaArrastrable(cardEl, headerEl);
  renderFamSelectorLista();
  // Si no había lista previa y hay modelo, buscar automáticamente
  if (_famSelector.items.length === 0 && modeloInicial) buscarVariantesFamilia();
}

function renderFamSelectorLista() {
  const cont = document.getElementById('fam-lista-variantes');
  if (!cont || !_famSelector) return;
  const items = _famSelector.items;
  cont.innerHTML = items.length === 0
    ? '<div style="color:#9ca3af;font-size:13px;padding:10px">Escribe el modelo y pulsa Buscar, o añade productos a mano abajo.</div>'
    : items.map(it => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid #f3f4f6">
        <input type="checkbox" ${it.checked ? 'checked' : ''} onchange="toggleVarFamilia(${it.product_id})" title="Marca = forma parte de la familia">
        <span style="flex:1;min-width:0;font-size:13px"><b>${escape(it.codigo || '')}</b> · ${escape(it.nombre || '')}${(it.color || it.graduacion) ? `<span style="color:#a855f7"> (${escape([it.color, it.graduacion].filter(Boolean).join(' · '))})</span>` : ''}</span>
        <span style="flex:0 0 auto;white-space:nowrap;font-size:11.5px;font-weight:600;color:${(it.pvf == null || Number(it.pvf) === 0) ? '#dc2626' : '#16a34a'}">${(it.pvf != null && it.pvf !== '') ? ('PVF ' + Number(it.pvf).toFixed(2) + '€') : '—'}</span>
        <button class="btn" style="width:auto;flex:0 0 auto;background:#7c3aed;color:#fff;padding:3px 8px;font-size:11px;white-space:nowrap" onclick="cambiarVarFamilia(${it.product_id})" title="Sustituir este miembro por otro producto de la base de datos">🔄 Cambiar</button>
        <button class="btn" style="width:auto;flex:0 0 auto;background:#fee2e2;color:#b91c1c;padding:3px 8px;font-size:11px" onclick="cambiarVarFamilia(${it.product_id}, true)" title="Quitar este miembro de la familia">✕</button>
      </div>`).join('');
  const c = document.getElementById('fam-count');
  if (c) c.textContent = items.filter(x => x.checked).length;
}

// Quita un miembro de la familia (para sustituirlo). Si soloQuitar=false, además lleva
// el foco al buscador de "Añadir a mano" para poner el producto correcto en su lugar.
function cambiarVarFamilia(pid, soloQuitar) {
  if (!_famSelector) return;
  _famSelector.items = _famSelector.items.filter(x => Number(x.product_id) !== Number(pid));
  renderFamSelectorLista();
  if (!soloQuitar) {
    const b = document.getElementById('fam-add-buscar');
    if (b) { if (b.scrollIntoView) b.scrollIntoView({ block: 'center' }); b.focus(); }
    mostrarNotificacionOnline('Miembro quitado. Busca abajo el producto correcto, márcalo y pulsa "Añadir marcados".', '#7c3aed');
  }
}

async function buscarVariantesFamilia() {
  if (!_famSelector) return;
  const ref = ((document.getElementById('fam-modelo-buscar') || {}).value || '').trim();
  const msg = document.getElementById('fam-buscar-msg');
  if (!ref) { if (msg) msg.textContent = 'Escribe un modelo.'; return; }
  if (msg) msg.textContent = 'Buscando…';
  try {
    const r = await api('/api/families/resolve?ref=' + encodeURIComponent(ref));
    const fam = r.familia;
    if (!fam || !fam.variantes || !fam.variantes.length) { if (msg) msg.textContent = 'No encontré variantes para "' + ref + '". Prueba otro texto o añádelas a mano.'; return; }
    const yaIds = new Set(_famSelector.items.map(x => x.product_id));
    let nuevas = 0;
    for (const v of fam.variantes) {
      if (yaIds.has(v.product_id)) continue;
      _famSelector.items.push({ product_id: v.product_id, codigo: v.codigo, nombre: v.nombre, color: (v.ejes && v.ejes.color) || '', graduacion: (v.ejes && v.ejes.graduacion) || '', pvf: (v.pvf != null ? v.pvf : null), checked: true });
      nuevas++;
    }
    if (msg) msg.textContent = fam.variantes.length + ' variantes (modelo: ' + fam.modelo + '). Desmarca las que no vayan.';
    renderFamSelectorLista();
  } catch (e) { if (msg) msg.textContent = 'Error: ' + e.message; }
}

function toggleVarFamilia(pid) {
  if (!_famSelector) return;
  const it = _famSelector.items.find(x => x.product_id === pid);
  if (it) it.checked = !it.checked;
  const c = document.getElementById('fam-count');
  if (c) c.textContent = _famSelector.items.filter(x => x.checked).length;
}

function buscarProductoParaFamilia(q) {
  clearTimeout(_famAddTimer);
  const cont = document.getElementById('fam-add-resultados');
  if (!q || q.trim().length < 2) { if (cont) cont.innerHTML = ''; return; }
  _famAddTimer = setTimeout(async () => {
    try {
      const r = await api('/api/products?q=' + encodeURIComponent(q.trim()) + '&limit=40');
      const ps = r.products || [];
      _famAddResultados = ps; // guardar para el lookup (evita meter el nombre en el onclick)
      if (!cont) return;
      if (!ps.length) { cont.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px">Sin resultados</div>'; return; }
      // Resultados con CASILLAS: marca varios y añádelos de golpe (evita ir uno a uno).
      // Los ya presentes en la familia se marcan y deshabilitan.
      const yaIds = new Set((_famSelector ? _famSelector.items : []).map(x => Number(x.product_id)));
      cont.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px;position:sticky;top:0;background:var(--surface);border-bottom:1px solid #e5e7eb;z-index:1">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer">
            <input type="checkbox" id="fam-add-todos" onchange="famAddMarcarTodos(this.checked)"> Marcar todos
          </label>
          <button class="btn btn-primary" style="width:auto;flex:0 0 auto;padding:5px 12px;font-size:12px" onclick="anadirVarFamiliaMarcados()">➕ Añadir marcados (<span id="fam-add-nsel">0</span>)</button>
        </div>
        ` + ps.map(p => {
          const dentro = yaIds.has(Number(p.id));
          const pvfNum = (p.precio_pvf != null && p.precio_pvf !== '') ? Number(p.precio_pvf) : null;
          const pvf = pvfNum != null ? pvfNum.toFixed(2) + '€' : '—';
          const pvfCol = (pvfNum == null || pvfNum === 0) ? '#dc2626' : '#16a34a';
          return `
          <label style="display:flex;align-items:flex-start;gap:8px;padding:7px 6px;border-bottom:1px solid #f3f4f6;font-size:13px;cursor:${dentro ? 'default' : 'pointer'};opacity:${dentro ? '0.5' : '1'}">
            <input type="checkbox" class="fam-add-chk" value="${p.id}" ${dentro ? 'checked disabled' : ''} onchange="famAddActualizarContador()" style="width:auto;flex:0 0 auto;margin-top:2px">
            <span style="flex:1;min-width:0">
              <span style="display:block;word-break:break-word"><b>${escape(p.codigo || '')}</b> · ${escape((p.nombre || '').slice(0, 60))}${dentro ? ' <span style="color:#16a34a;font-size:11px">✓ ya está</span>' : ''}</span>
              <span style="display:inline-block;margin-top:2px;white-space:nowrap;color:${pvfCol};font-weight:600;font-size:12px">PVF ${pvf}</span>
            </span>
          </label>`;
        }).join('');
      famAddActualizarContador();
    } catch (_) {}
  }, 300);
}

// Cuenta las casillas marcadas (no deshabilitadas) y actualiza el botón + "marcar todos".
function famAddActualizarContador() {
  const chks = Array.from(document.querySelectorAll('.fam-add-chk')).filter(c => !c.disabled);
  const marcadas = chks.filter(c => c.checked);
  const nsel = document.getElementById('fam-add-nsel');
  if (nsel) nsel.textContent = marcadas.length;
  const todos = document.getElementById('fam-add-todos');
  if (todos) todos.checked = chks.length > 0 && marcadas.length === chks.length;
}

function famAddMarcarTodos(on) {
  document.querySelectorAll('.fam-add-chk').forEach(c => { if (!c.disabled) c.checked = on; });
  famAddActualizarContador();
}

// Añade de GOLPE todos los productos marcados en el buscador a mano.
function anadirVarFamiliaMarcados() {
  if (!_famSelector) return;
  const ids = Array.from(document.querySelectorAll('.fam-add-chk'))
    .filter(c => c.checked && !c.disabled)
    .map(c => Number(c.value));
  if (!ids.length) return;
  let anadidos = 0;
  for (const pid of ids) {
    const p = (_famAddResultados || []).find(x => Number(x.id) === Number(pid)) || {};
    const ya = _famSelector.items.find(x => Number(x.product_id) === pid);
    if (ya) { ya.checked = true; }
    else { _famSelector.items.push({ product_id: pid, codigo: p.codigo || '', nombre: p.nombre || '', color: '', graduacion: '', pvf: (p.precio_pvf != null ? p.precio_pvf : null), checked: true }); anadidos++; }
  }
  renderFamSelectorLista();
  const q = document.getElementById('fam-add-buscar'); if (q) q.value = '';
  const cont = document.getElementById('fam-add-resultados'); if (cont) cont.innerHTML = '';
  mostrarNotificacionOnline('➕ ' + anadidos + ' producto' + (anadidos === 1 ? '' : 's') + ' añadido' + (anadidos === 1 ? '' : 's') + ' a la familia', '#a855f7');
}

// (compat) añadir uno solo — ya no se usa desde la UI, pero lo dejamos por si acaso.
function anadirVarFamilia(pid) {
  if (!_famSelector) return;
  const p = (_famAddResultados || []).find(x => Number(x.id) === Number(pid)) || {};
  const ya = _famSelector.items.find(x => x.product_id === pid);
  if (ya) { ya.checked = true; }
  else _famSelector.items.push({ product_id: pid, codigo: p.codigo || '', nombre: p.nombre || '', color: '', graduacion: '', pvf: (p.precio_pvf != null ? p.precio_pvf : null), checked: true });
  renderFamSelectorLista();
  const q = document.getElementById('fam-add-buscar'); if (q) q.value = '';
  const cont = document.getElementById('fam-add-resultados'); if (cont) cont.innerHTML = '';
}

function cerrarSelectorFamilia() {
  const m = document.getElementById('fam-selector-modal'); if (m) m.remove();
  _famSelector = null;
}

async function guardarFamiliaCurada() {
  if (!_famSelector) return;
  const ids = _famSelector.items.filter(x => x.checked).map(x => x.product_id);
  if (ids.length === 0) { alert('Marca al menos una variante (o pulsa Cancelar).'); return; }
  const zoneId = _famSelector.zoneId;
  const modelo = (((document.getElementById('fam-modelo-buscar') || {}).value) || ((document.getElementById('fam-input-' + zoneId) || {}).value) || 'familia').trim();
  try {
    const realId = await _persistirZonaSiPropuesta(zoneId); // por si es propuesta IA
    await api('/api/zones/' + realId, { method: 'PUT', body: { familia_ref: modelo, familia_skus: ids } });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(realId));
    if (sel) {
      sel.familia_ref = modelo; sel.familia_skus = ids;
      sel.product_id = null; sel.es_comision = false; sel.link_catalog_id = null;
      sel.producto_codigo = null; sel.producto_nombre = null; sel.producto_pvf = null;
    }
    cerrarSelectorFamilia();
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('👓 Familia guardada: ' + ids.length + ' variantes elegidas', '#16a34a');
  } catch (err) { alert('Error guardando familia: ' + err.message); }
}

// Marca/actualiza una zona como familia (valida contra Sage antes de guardar)
// Las zonas propuestas por la IA viven solo en memoria con un id temporal "ia-...".
// Antes de editarlas (asignar producto/familia/comisión/enlace) hay que CREARLAS en BD
// (POST) para obtener un id real; si no, el PUT /api/zones/ia-... da "zoneId invalido".
async function _persistirZonaSiPropuesta(zoneId) {
  const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
  if (!sel) return zoneId;
  if (typeof sel.id !== 'string' || !sel.id.startsWith('ia-')) return sel.id; // ya es real
  const r = await api('/api/sheets/' + _zonasEditor.sheetId + '/zones', {
    method: 'POST',
    body: { x: sel.x, y: sel.y, ancho: sel.ancho, alto: sel.alto, etiqueta: sel.etiqueta || null }
  });
  const viejo = sel.id;
  sel.id = r.zone.id;
  sel.propuesta_ia = false;
  if (_zonasEditor.zonaSeleccionadaId === viejo) _zonasEditor.zonaSeleccionadaId = r.zone.id;
  return r.zone.id;
}

// Guarda en BD TODAS las zonas detectadas por IA que sigan pendientes (id "ia-..."),
// conservando su producto/familia si la IA los sugirió. Convierte cada una en zona real.
async function guardarZonasDetectadas() {
  const propuestas = _zonasEditor.zonas.filter(z => typeof z.id === 'string' && z.id.startsWith('ia-'));
  if (propuestas.length === 0) { mostrarNotificacionOnline('No hay zonas detectadas pendientes de guardar', '#6b7280'); return; }
  let ok = 0, fallos = 0;
  for (const z of propuestas) {
    try {
      const r = await api('/api/sheets/' + _zonasEditor.sheetId + '/zones', {
        method: 'POST',
        body: { x: z.x, y: z.y, ancho: z.ancho, alto: z.alto, product_id: z.product_id || null, etiqueta: z.etiqueta || null }
      });
      z.id = r.zone.id; z.propuesta_ia = false;
      if (z.familia_ref) { try { await api('/api/zones/' + z.id, { method: 'PUT', body: { familia_ref: z.familia_ref } }); } catch (_) {} }
      ok++;
    } catch (e) { fallos++; }
  }
  renderZonasEnCapa(); renderListaZonas(); actualizarContadorZonas();
  mostrarNotificacionOnline('💾 ' + ok + ' zonas detectadas guardadas' + (fallos ? ' · ' + fallos + ' con error' : ''), fallos ? '#b45309' : '#16a34a');
}

async function aplicarFamiliaZona(zoneId) {
  const inp = document.getElementById('fam-input-' + zoneId);
  const ref = inp ? inp.value.trim() : '';
  if (!ref) { alert('Escribe el modelo (ej: Verona, Guantes nitrilo azul).'); return; }
  try {
    const r = await api('/api/families/resolve?ref=' + encodeURIComponent(ref));
    if (!r || !r.familia) {
      alert('No encontré variantes para "' + ref + '" en Sage. Prueba con otro texto (el nombre como aparece en Sage).');
      return;
    }
    zoneId = await _persistirZonaSiPropuesta(zoneId); // si es propuesta IA, crearla en BD primero
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { familia_ref: ref } });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    if (sel) { sel.familia_ref = ref; sel.product_id = null; sel.producto_codigo = null; sel.producto_nombre = null; sel.producto_pvf = null; }
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('✅ Familia asignada: ' + r.familia.modelo + ' (' + r.familia.n_variantes + ' variantes)', '#16a34a');
  } catch (err) {
    alert('Error asignando familia: ' + err.message);
  }
}

// Quita la familia de una zona (vuelve a ser producto suelto sin asignar)
async function quitarFamiliaZona(zoneId) {
  if (!confirm('¿Quitar la familia de esta zona? Volverá a ser una zona sin producto para asignar uno suelto.')) return;
  try {
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { familia_ref: null } });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    if (sel) sel.familia_ref = null;
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('Familia quitada', '#6b7280');
  } catch (err) {
    alert('Error quitando familia: ' + err.message);
  }
}

// ============================================================================
// PORTAPAPELES DE FAMILIA — copiar una familia (modelo + variantes curadas) de
// una zona para PEGARLA en una zona de OTRA lámina, sin volver a curarla.
// Se guarda en localStorage → sobrevive al cambiar de lámina/catálogo.
// ============================================================================
let _familiaPortapapeles = (() => { try { return JSON.parse(localStorage.getItem('cpv2_fam_clip') || 'null'); } catch { return null; } })();

function copiarFamiliaPortapapeles(zoneId) {
  const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
  if (!sel || !sel.familia_ref) return;
  const skus = Array.isArray(sel.familia_skus) ? sel.familia_skus.slice() : null;
  _familiaPortapapeles = {
    familia_ref: sel.familia_ref,
    familia_skus: skus,
    n: skus ? skus.length : null
  };
  try { localStorage.setItem('cpv2_fam_clip', JSON.stringify(_familiaPortapapeles)); } catch {}
  renderListaZonas(); // para que aparezca el botón "Pegar" en el bloque de familia
  mostrarNotificacionOnline('📋 Familia copiada: ' + sel.familia_ref + (skus ? ' (' + skus.length + ' variantes)' : '') + '. Ve a otra lámina, abre una zona y pulsa "Pegar familia".', '#a855f7');
}

// Aplica la familia copiada a esta zona (en cualquier lámina).
async function pegarFamiliaPortapapeles(zoneId) {
  if (!_familiaPortapapeles || !_familiaPortapapeles.familia_ref) return;
  try {
    zoneId = await _persistirZonaSiPropuesta(zoneId); // si es propuesta IA, fijarla primero
    const body = { familia_ref: _familiaPortapapeles.familia_ref };
    if (Array.isArray(_familiaPortapapeles.familia_skus) && _familiaPortapapeles.familia_skus.length) {
      body.familia_skus = _familiaPortapapeles.familia_skus;
    }
    const r = await api('/api/zones/' + zoneId, { method: 'PUT', body });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    if (sel) {
      sel.familia_ref = _familiaPortapapeles.familia_ref;
      sel.familia_skus = body.familia_skus || null;
      sel.product_id = null; sel.es_comision = false; sel.link_catalog_id = null;
      sel.producto_codigo = null; sel.producto_nombre = null;
    }
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('✅ Familia pegada: ' + _familiaPortapapeles.familia_ref, '#16a34a');
  } catch (err) {
    alert('Error pegando familia: ' + err.message);
  }
}

// Marca una zona como producto de COMISION (Lainco…) con su nombre editable
async function marcarComisionZona(zoneId) {
  const inp = document.getElementById('com-nombre-' + zoneId);
  const nombre = inp ? inp.value.trim() : '';
  if (!nombre) { alert('Escribe el nombre del producto de comisión.'); return; }
  try {
    zoneId = await _persistirZonaSiPropuesta(zoneId); // si es propuesta IA, crearla en BD primero
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { es_comision: true, etiqueta: nombre } });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    if (sel) { sel.es_comision = true; sel.etiqueta = nombre; sel.product_id = null; sel.familia_ref = null; sel.producto_codigo = null; sel.producto_nombre = null; }
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('🤝 Producto de comisión: ' + nombre, '#ea580c');
  } catch (err) {
    alert('Error marcando comisión: ' + err.message);
  }
}

// Añade un VALOR (venga del buscador de producto o del input a mano) a la lista de
// variantes de comisión y lo persiste. Evita duplicados.
async function _anadirVarianteComisionValor(zoneId, valor) {
  const v = String(valor || '').trim();
  if (!v) return;
  const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
  if (!sel) return;
  const lista = Array.isArray(sel.comision_variantes) ? sel.comision_variantes.slice() : [];
  if (lista.some(x => String(x).toLowerCase() === v.toLowerCase())) return; // no duplicar
  lista.push(v);
  try {
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { es_comision: true, comision_variantes: lista } });
    sel.comision_variantes = lista;
    renderListaZonas();
  } catch (err) {
    alert('Error añadiendo variante: ' + err.message);
  }
}

// Añade la variante escrita a mano en el input.
async function anadirVarianteComision(zoneId) {
  const inp = document.getElementById('com-var-input-' + zoneId);
  const v = inp ? inp.value.trim() : '';
  if (!v) return;
  await _anadirVarianteComisionValor(zoneId, v);
  setTimeout(() => { const i2 = document.getElementById('com-var-input-' + zoneId); if (i2) { i2.value = ''; i2.focus(); } }, 50);
}

// Quita una variante de la familia de comisión.
async function quitarVarianteComision(zoneId, idx) {
  const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
  if (!sel || !Array.isArray(sel.comision_variantes)) return;
  const lista = sel.comision_variantes.slice();
  lista.splice(idx, 1);
  try {
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { es_comision: true, comision_variantes: lista } });
    sel.comision_variantes = lista;
    renderListaZonas();
  } catch (err) {
    alert('Error quitando variante: ' + err.message);
  }
}

// Activa/desactiva las "referencias sueltas" (expositor) en una zona. Es una
// capacidad ADICIONAL: convive con producto Sage / comisión / familia.
async function toggleSueltasZona(zoneId) {
  try {
    zoneId = await _persistirZonaSiPropuesta(zoneId); // si es propuesta IA, fijarla primero
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    if (!sel) return;
    const nuevo = !sel.permite_sueltas;
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { permite_sueltas: nuevo } });
    sel.permite_sueltas = nuevo;
    renderListaZonas();
    mostrarNotificacionOnline(nuevo ? '🕶️ Referencias sueltas activadas' : 'Referencias sueltas desactivadas', '#0d9488');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Quita el estado de comisión de una zona
async function quitarComisionZona(zoneId) {
  if (!confirm('¿Quitar la comisión de esta zona? Volverá a ser una zona sin producto.')) return;
  try {
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { es_comision: false } });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    if (sel) { sel.es_comision = false; sel.comision_variantes = null; }
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('Comisión quitada', '#6b7280');
  } catch (err) {
    alert('Error quitando comisión: ' + err.message);
  }
}

// Rellena el desplegable de "enlace a catálogo" con todos los catálogos (menos el actual)
let _catalogosCacheEnlace = null;
// Cache de las láminas del catálogo de ORIGEN (para el selector de "página de regreso")
let _paginasOrigenCacheEnlace = null;
async function cargarCatalogosEnSelectEnlace(zoneId, seleccionadoId, sheetIdPreset) {
  const sel = document.getElementById('link-sel-' + zoneId);
  if (!sel) return;
  try {
    if (_catalogosCacheEnlace === null) {
      const r = await api('/api/catalogs');
      _catalogosCacheEnlace = r.catalogs || r.rows || [];
    }
    const actual = _zonasEditor.catalogId;
    const opts = ['<option value="">— Elige catálogo destino —</option>'];
    _catalogosCacheEnlace
      .filter(c => Number(c.id) !== Number(actual))
      .forEach(c => {
        const nom = c.name || c.nombre || ('Catálogo #' + c.id);
        opts.push(`<option value="${c.id}" ${Number(c.id) === Number(seleccionadoId) ? 'selected' : ''}>${escape(nom)}</option>`);
      });
    sel.innerHTML = opts.join('');
    // Si ya hay catálogo destino, cargar sus páginas y preseleccionar la actual
    if (seleccionadoId) cargarPaginasDestino(zoneId, sheetIdPreset);
  } catch (e) {
    sel.innerHTML = '<option value="">Error cargando catálogos</option>';
  }
}

// Rellena el desplegable de "página destino" con las láminas del catálogo elegido
async function cargarPaginasDestino(zoneId, sheetIdPreset) {
  const catSel = document.getElementById('link-sel-' + zoneId);
  const pagSel = document.getElementById('link-pag-' + zoneId);
  if (!catSel || !pagSel) return;
  const catId = Number(catSel.value);
  if (!catId) { pagSel.innerHTML = '<option value="">Todo el catálogo (empieza en la pág. 1)</option>'; return; }
  pagSel.innerHTML = '<option value="">Cargando páginas…</option>';
  try {
    const r = await api('/api/catalogs/' + catId);
    const sheets = r.sheets || [];
    const opts = ['<option value="">Todo el catálogo (empieza en la pág. 1)</option>'];
    sheets.forEach((s, idx) => {
      const t = s.titulo || ('Lámina ' + (idx + 1));
      opts.push(`<option value="${s.id}" ${Number(s.id) === Number(sheetIdPreset) ? 'selected' : ''}>Pág. ${idx + 1} · ${escape(t)}</option>`);
    });
    pagSel.innerHTML = opts.join('');
  } catch (e) {
    pagSel.innerHTML = '<option value="">Todo el catálogo (empieza en la pág. 1)</option>';
  }
}

// Rellena el desplegable de "página de regreso" con las láminas del catálogo de ORIGEN
// (el que se está editando). Al volver del enlace, se aterriza en esta lámina en vez de
// en la página del botón (para saltarse las hojas restantes del laboratorio).
async function cargarPaginasRegreso(zoneId, backSheetIdPreset) {
  const backSel = document.getElementById('link-back-' + zoneId);
  if (!backSel) return;
  const catId = Number(_zonasEditor && _zonasEditor.catalogId);
  if (!catId) { backSel.innerHTML = '<option value="">Donde estaba (la página del botón)</option>'; return; }
  try {
    if (!_paginasOrigenCacheEnlace || _paginasOrigenCacheEnlace.catId !== catId) {
      const r = await api('/api/catalogs/' + catId);
      _paginasOrigenCacheEnlace = { catId, sheets: r.sheets || [] };
    }
    const opts = ['<option value="">Donde estaba (la página del botón)</option>'];
    _paginasOrigenCacheEnlace.sheets.forEach((s, idx) => {
      const t = s.titulo || ('Lámina ' + (idx + 1));
      opts.push(`<option value="${s.id}" ${Number(s.id) === Number(backSheetIdPreset) ? 'selected' : ''}>Pág. ${idx + 1} · ${escape(t)}</option>`);
    });
    backSel.innerHTML = opts.join('');
  } catch (e) {
    backSel.innerHTML = '<option value="">Donde estaba (la página del botón)</option>';
  }
}

// Crea/actualiza el enlace de una zona: catálogo + página opcional + página de regreso + texto
async function aplicarEnlaceZona(zoneId) {
  const catSel = document.getElementById('link-sel-' + zoneId);
  const pagSel = document.getElementById('link-pag-' + zoneId);
  const backSel = document.getElementById('link-back-' + zoneId);
  const lblEl = document.getElementById('link-lbl-' + zoneId);
  const destino = catSel ? Number(catSel.value) : 0;
  if (!destino) { alert('Elige el catálogo destino.'); return; }
  const paginaId = pagSel && pagSel.value ? Number(pagSel.value) : null;
  const regresoId = backSel && backSel.value ? Number(backSel.value) : null;
  const label = lblEl ? lblEl.value.trim() : '';
  try {
    zoneId = await _persistirZonaSiPropuesta(zoneId); // si es propuesta IA, crearla en BD primero
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { link_catalog_id: destino, link_sheet_id: paginaId, link_back_sheet_id: regresoId, link_label: label || null } });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    const cat = (_catalogosCacheEnlace || []).find(c => Number(c.id) === destino);
    if (sel) {
      sel.link_catalog_id = destino;
      sel.link_catalog_nombre = cat ? (cat.name || cat.nombre) : null;
      sel.link_sheet_id = paginaId;
      sel.link_back_sheet_id = regresoId;
      sel.link_label = label || null;
      sel.product_id = null; sel.familia_ref = null; sel.es_comision = false;
      sel.producto_codigo = null; sel.producto_nombre = null;
    }
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('🔗 Enlace guardado' + (regresoId ? ' (con página de regreso)' : (paginaId ? ' (a una página concreta)' : '')), '#2563eb');
  } catch (err) {
    alert('Error guardando enlace: ' + err.message);
  }
}

// Quita el enlace de una zona
async function quitarEnlaceZona(zoneId) {
  if (!confirm('¿Quitar el enlace de esta zona? Volverá a ser una zona sin producto.')) return;
  try {
    await api('/api/zones/' + zoneId, { method: 'PUT', body: { link_catalog_id: null, link_sheet_id: null, link_back_sheet_id: null, link_label: null } });
    const sel = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
    if (sel) { sel.link_catalog_id = null; sel.link_catalog_nombre = null; sel.link_sheet_id = null; sel.link_back_sheet_id = null; sel.link_label = null; }
    renderZonasEnCapa();
    renderListaZonas();
    mostrarNotificacionOnline('Enlace quitado', '#6b7280');
  } catch (err) {
    alert('Error quitando enlace: ' + err.message);
  }
}

// ¿Se solapan dos rectángulos (en %)?
function _zonasSolapan(a, b) {
  return !(a.x + a.ancho <= b.x || b.x + b.ancho <= a.x || a.y + a.alto <= b.y || b.y + b.alto <= a.y);
}
// Busca un hueco LIBRE (sin solapar otras zonas) del tamaño w×h cerca de (refX,refY).
// Prueba derecha/abajo/izquierda/arriba y, si no, barre toda la lámina. Así la copia
// nunca cae encima de otra caja y se puede coger/editar sin líos.
function _buscarHuecoZona(w, h, refX, refY) {
  const gap = 0.6;
  const zonas = _zonasEditor.zonas || [];
  const cabe = (x, y) => x >= 0 && y >= 0 && x + w <= 100.001 && y + h <= 100.001;
  const libre = (x, y) => zonas.every(z => !_zonasSolapan({ x, y, ancho: w, alto: h }, { x: Number(z.x), y: Number(z.y), ancho: Number(z.ancho), alto: Number(z.alto) }));
  const cand = [
    { x: refX + w + gap, y: refY },       // derecha
    { x: refX,           y: refY + h + gap }, // abajo
    { x: refX - w - gap, y: refY },       // izquierda
    { x: refX,           y: refY - h - gap }  // arriba
  ];
  for (const c of cand) if (cabe(c.x, c.y) && libre(c.x, c.y)) return { x: Math.max(0, Math.min(100 - w, c.x)), y: Math.max(0, Math.min(100 - h, c.y)) };
  // Barrido en rejilla por toda la lámina
  const step = Math.max(2, Math.min(w, h) / 2);
  for (let y = 0; y <= 100 - h; y += step) {
    for (let x = 0; x <= 100 - w; x += step) {
      if (libre(x, y)) return { x, y };
    }
  }
  // Sin hueco: offset visible a la derecha/abajo aunque solape (clampeado)
  return { x: Math.max(0, Math.min(100 - w, refX + Math.min(w, 6) + gap)), y: Math.max(0, Math.min(100 - h, refY + Math.min(h, 6))) };
}
// Zona recién creada (duplicar/clonar): se resalta con un parpadeo para localizarla al instante.
let _zonaRecienCreadaId = null;
function _resaltarZonaNueva(id) {
  _zonaRecienCreadaId = id;
  renderZonasEnCapa();
  setTimeout(() => { if (_zonaRecienCreadaId === id) { _zonaRecienCreadaId = null; renderZonasEnCapa(); } }, 2600);
}

// Duplica una zona con el MISMO tamaño (para rejillas/expositores de celdas iguales).
// La copia se coloca en un HUECO LIBRE cercano (sin solapar), sin producto asignado, y
// queda seleccionada y resaltada para moverla/asignarle su producto.
async function duplicarZona(zoneId) {
  const orig = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
  if (!orig) return;
  const w = Number(orig.ancho), h = Number(orig.alto);
  const { x: nx, y: ny } = _buscarHuecoZona(w, h, Number(orig.x), Number(orig.y));
  try {
    const r = await api('/api/sheets/' + _zonasEditor.sheetId + '/zones', {
      method: 'POST',
      body: { x: nx, y: ny, ancho: w, alto: h }
    });
    _zonasEditor.zonas.push(r.zone);
    _zonasEditor.zonaSeleccionadaId = r.zone.id;
    renderZonasEnCapa();
    renderListaZonas();
    actualizarContadorZonas();
    _resaltarZonaNueva(r.zone.id);
    mostrarNotificacionOnline('⧉ Zona duplicada (mismo tamaño) — muévela y asígnale su producto', '#0ea5e9');
  } catch (err) {
    alert('Error duplicando zona: ' + err.message);
  }
}

// Clona una zona con el MISMO tamaño Y todos sus datos (producto / familia / comisión /
// enlace). La copia se coloca en la celda de al lado y queda seleccionada para moverla.
// Útil cuando el mismo producto aparece varias veces en el expositor.
async function clonarZona(zoneId) {
  const orig = _zonasEditor.zonas.find(z => String(z.id) === String(zoneId));
  if (!orig) return;
  const w = Number(orig.ancho), h = Number(orig.alto);
  const { x: nx, y: ny } = _buscarHuecoZona(w, h, Number(orig.x), Number(orig.y));
  try {
    // 1) Crear la zona con geometría + producto + etiqueta (lo que acepta el POST)
    const r = await api('/api/sheets/' + _zonasEditor.sheetId + '/zones', {
      method: 'POST',
      body: { x: nx, y: ny, ancho: w, alto: h, product_id: orig.product_id || null, etiqueta: orig.etiqueta || null }
    });
    let nueva = r.zone;
    // 2) Si el original es familia / comisión / enlace / con sueltas, aplicarlo con un PUT
    if (orig.familia_ref || orig.es_comision || orig.link_catalog_id || orig.permite_sueltas) {
      const body = {};
      if (orig.familia_ref) {
        body.familia_ref = orig.familia_ref;
        if (Array.isArray(orig.familia_skus) && orig.familia_skus.length) body.familia_skus = orig.familia_skus;
      } else if (orig.es_comision) {
        body.es_comision = true;
        if (orig.etiqueta) body.etiqueta = orig.etiqueta;
        if (Array.isArray(orig.comision_variantes) && orig.comision_variantes.length) body.comision_variantes = orig.comision_variantes;
      } else if (orig.link_catalog_id) {
        body.link_catalog_id = orig.link_catalog_id;
        body.link_sheet_id = orig.link_sheet_id || null;
        body.link_back_sheet_id = orig.link_back_sheet_id || null;
        body.link_label = orig.link_label || null;
      }
      if (orig.permite_sueltas) body.permite_sueltas = true; // capacidad adicional, convive con lo anterior
      const r2 = await api('/api/zones/' + nueva.id, { method: 'PUT', body });
      if (r2.zone) nueva = r2.zone;
    }
    // Copiar los campos de "display" (que vienen por JOIN y el POST/PUT no devuelve)
    nueva.producto_codigo = orig.producto_codigo;
    nueva.producto_nombre = orig.producto_nombre;
    nueva.producto_ean = orig.producto_ean;
    nueva.link_catalog_nombre = orig.link_catalog_nombre;
    nueva.link_back_sheet_orden = orig.link_back_sheet_orden;
    _zonasEditor.zonas.push(nueva);
    _zonasEditor.zonaSeleccionadaId = nueva.id;
    renderZonasEnCapa();
    renderListaZonas();
    actualizarContadorZonas();
    _resaltarZonaNueva(nueva.id);
    mostrarNotificacionOnline('🧬 Zona clonada con todos sus datos — muévela a su sitio', '#7c3aed');
  } catch (err) {
    alert('Error clonando zona: ' + err.message);
  }
}

// Lleva el foco al primer control de EDICIÓN de la zona (buscador de producto, o el
// campo de familia/comisión/enlace) y lo trae a la vista. Así, al ver los datos de la
// caja (que son de solo lectura), un toque en "✏️ Cambiar / editar" te deja escribiendo.
function enfocarEdicionZona() {
  const sel = _zonasEditor.zonas.find(z => z.id === _zonasEditor.zonaSeleccionadaId);
  // Si la zona tiene un PRODUCTO asignado, abrir la ventana completa con TODOS sus datos
  // (código, nombre, precios, EAN, descripción…) para modificar lo que haga falta.
  if (sel && sel.product_id && typeof abrirDetalleProducto === 'function') {
    abrirDetalleProducto(sel.product_id);
    return;
  }
  // Zonas sin producto (familia/comisión/enlace/vacía): llevar el foco a su control de edición.
  const panel = document.getElementById('zonas-panel');
  if (!panel) return;
  const cont = document.getElementById('zona-ac-contenedor');
  const target = (cont && cont.querySelector('input, textarea'))
    || panel.querySelector('input, textarea, select');
  if (!target) return;
  // Resaltar el BLOQUE de edición (para que se vea claramente qué se toca) y traerlo al centro
  const bloque = target.closest('.form-group') || target.parentElement || target;
  try { bloque.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { try { bloque.scrollIntoView(); } catch (_) {} }
  bloque.classList.add('zona-edit-flash');
  setTimeout(() => bloque.classList.remove('zona-edit-flash'), 1700);
  setTimeout(() => { try { target.focus({ preventScroll: true }); } catch (_) { try { target.focus(); } catch (_) {} } }, 320);
}

function seleccionarZona(zoneId) {
  // Normalizar: usar el id REAL del objeto (numérico para zonas guardadas, string "ia-…"
  // para propuestas) para que la comparación z.id === seleccionada funcione en ambos casos.
  const z = _zonasEditor.zonas.find(zz => String(zz.id) === String(zoneId));
  _zonasEditor.zonaSeleccionadaId = z ? z.id : zoneId;
  renderZonasEnCapa();
  renderListaZonas();
  const panel = document.getElementById('zonas-panel');
  if (panel) panel.scrollTop = 0; // empezar arriba, en los datos + botón de editar
}

function deseleccionarZona() {
  _zonasEditor.zonaSeleccionadaId = null;
  renderZonasEnCapa();
  renderListaZonas();
}

async function borrarZona(zoneId) {
  if (!confirm('¿Borrar esta zona? El producto NO se borra, solo la zona sobre la lámina.')) return;
  try {
    // Las zonas propuestas por IA tienen id temporal string ("ia-XXX-YYY") y no
    // están en BD todavía: solo se eliminan del array local. Las guardadas (id
    // numérico) sí requieren DELETE en backend.
    const zoneIdStr = String(zoneId);
    const esPropuestaIA = zoneIdStr.startsWith('ia-');
    if (!esPropuestaIA) {
      await api('/api/zones/' + zoneIdStr, { method: 'DELETE' });
    }
    // Comparar como string para que funcione con id numerico (BD) o string (IA)
    _zonasEditor.zonas = _zonasEditor.zonas.filter(z => String(z.id) !== zoneIdStr);
    _zonasEditor.zonaSeleccionadaId = null;
    renderZonasEnCapa();
    renderListaZonas();
    actualizarContadorZonas();
  } catch (err) {
    alert('Error borrando zona: ' + err.message);
  }
}

// Tecla Supr/Del: borra la zona seleccionada (si hay editor de zonas abierto)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== 'Del') return;
  // Solo si estamos en el editor de zonas y hay una seleccionada
  const editorAbierto = document.getElementById('zonas-editor-overlay');
  if (!editorAbierto) return;
  if (_zonasEditor.zonaSeleccionadaId == null) return;
  // No disparar si estamos en un input/textarea (para no interferir con escribir)
  const activo = document.activeElement;
  const tag = activo?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || activo?.isContentEditable) return;
  e.preventDefault();
  borrarZona(_zonasEditor.zonaSeleccionadaId);
});

// Hace una ventana (.modal-card) ARRASTRABLE por su cabecera. Sirve para apartarla
// a una esquina y poder leer/usar lo que hay debajo mientras se rellena.
function hacerVentanaArrastrable(card, handle) {
  if (!card || !handle) return;
  handle.style.cursor = 'move';
  handle.style.userSelect = 'none';
  handle.style.touchAction = 'none';
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  const posActual = () => {
    const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(card.style.transform || '');
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
  };
  const mover = (e) => {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    let nx = ox + (p.clientX - sx);
    let ny = oy + (p.clientY - sy);
    // LIMITAR el arrastre para que la ventana no se salga de la pantalla: la cabecera
    // siempre queda visible arriba (top >= 0) y deja un margen por los otros lados, así
    // NUNCA se pierde y siempre se puede volver a coger para recentrar.
    const cur = posActual();
    const rect = card.getBoundingClientRect();
    const baseTop = rect.top - cur.y;   // posición SIN trasladar
    const baseLeft = rect.left - cur.x;
    const margen = 56;                   // px que deben quedar siempre a la vista
    const minY = -baseTop;                                   // top de la card = 0 (cabecera visible)
    const maxY = window.innerHeight - baseTop - margen;      // deja 56px por abajo
    const minX = -baseLeft - (rect.width - margen);          // deja 56px por la izquierda
    const maxX = window.innerWidth - baseLeft - margen;      // deja 56px por la derecha
    ny = Math.max(minY, Math.min(maxY, ny));
    nx = Math.max(minX, Math.min(maxX, nx));
    card.style.transform = `translate(${nx}px, ${ny}px)`;
    e.preventDefault();
  };
  const soltar = () => {
    dragging = false;
    document.removeEventListener('mousemove', mover);
    document.removeEventListener('mouseup', soltar);
    document.removeEventListener('touchmove', mover);
    document.removeEventListener('touchend', soltar);
  };
  const bajar = (e) => {
    // No arrastrar si se pulsa un control dentro de la cabecera (ej. la X de cerrar)
    if (e.target.closest('button, input, a, select')) return;
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    const c = posActual(); ox = c.x; oy = c.y;
    document.addEventListener('mousemove', mover);
    document.addEventListener('mouseup', soltar);
    document.addEventListener('touchmove', mover, { passive: false });
    document.addEventListener('touchend', soltar);
    e.preventDefault();
  };
  const bindDrag = (h) => {
    if (!h) return;
    h.style.cursor = 'move';
    h.style.userSelect = 'none';
    h.style.touchAction = 'none';
    h.addEventListener('mousedown', bajar);
    h.addEventListener('touchstart', bajar, { passive: false });
  };
  bindDrag(handle);
  // ASA INFERIOR: barra "✥ arrastra" pegada al fondo del cuadro para poder moverlo
  // también desde abajo (no solo por la cabecera), y así recentrarlo con facilidad.
  if (!card.querySelector('.drag-grip-inferior')) {
    const grip = document.createElement('div');
    grip.className = 'drag-grip-inferior';
    grip.textContent = '✥ arrastra para mover';
    grip.style.cssText = 'position:sticky;bottom:0;margin-top:12px;padding:7px;text-align:center;font-size:11px;font-weight:600;color:var(--gris-texto);background:var(--surface-2);border:1px solid var(--gris-borde);border-radius:9px;cursor:move;user-select:none;touch-action:none;z-index:2';
    card.appendChild(grip);
    bindDrag(grip);
  }
}

// FASE 2.b': crear producto al vuelo (tipo comercial) desde el editor de zonas.
// nombreSugerido = lo que el admin tecleó en el buscador. alCrear = callback(producto).
async function abrirModalCrearProductoVuelo(nombreSugerido, alCrear) {
  // Pedir código sugerido EXP-XXXX al servidor
  let codigoSugerido = '';
  try {
    const r = await api('/api/products/sugerir-codigo');
    codigoSugerido = r.codigo || '';
  } catch (e) { /* si falla, dejamos el campo vacío */ }

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.style.zIndex = '21000'; // por encima del editor de zonas
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>➕ Crear producto nuevo <span style="font-size:11px;color:#9ca3af;font-weight:400">✥ arrastra para mover</span></h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;padding:8px 12px;border-radius:8px;margin-bottom:14px;font-size:12px;color:#1e40af">
        Para expositores o promos que no están en Sage. Se marcará como tipo 🎁 comercial. Puedes <b>arrastrar esta ventana</b> a una esquina para leer lo de debajo.
      </div>
      <div class="form-group">
        <label>Código <small style="color:var(--gris-texto)">(puedes cambiarlo)</small></label>
        <input type="text" id="cpv-codigo" value="${escape(codigoSugerido)}" autocomplete="off">
      </div>
      <div class="form-group">
        <label>Nombre *</label>
        <input type="text" id="cpv-nombre" value="${escape(nombreSugerido || '')}" autocomplete="off">
      </div>
      <div class="form-group">
        <label>PVF (precio) <small style="color:var(--gris-texto)">opcional</small></label>
        <input type="number" step="0.01" id="cpv-pvf" placeholder="0.00" autocomplete="off">
      </div>
      <div class="form-group">
        <label>EAN <small style="color:var(--gris-texto)">opcional</small></label>
        <input type="text" id="cpv-ean" autocomplete="off">
      </div>
      <div id="cpv-msg"></div>
      <div class="modal-acciones">
        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button type="button" class="btn btn-primary" id="cpv-guardar">Crear y asignar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Ventana FLOTANTE: fondo transparente y sin bloquear (para ver/leer lo de debajo)
  // + arrastrable por la cabecera para apartarla a una esquina.
  modal.style.background = 'transparent';
  modal.style.pointerEvents = 'none';
  const cardEl = modal.querySelector('.modal-card');
  const headerEl = modal.querySelector('.modal-header');
  if (cardEl) {
    cardEl.style.pointerEvents = 'auto';
    cardEl.style.boxShadow = '0 12px 45px rgba(0,0,0,0.35)';
    cardEl.style.border = '1px solid #e5e7eb';
  }
  hacerVentanaArrastrable(cardEl, headerEl);

  setTimeout(() => { const n = document.getElementById('cpv-nombre'); if (n) n.focus(); }, 100);

  document.getElementById('cpv-guardar').addEventListener('click', async () => {
    const codigo = document.getElementById('cpv-codigo').value.trim();
    const nombre = document.getElementById('cpv-nombre').value.trim();
    const pvf = document.getElementById('cpv-pvf').value.trim();
    const ean = document.getElementById('cpv-ean').value.trim();
    const $msg = document.getElementById('cpv-msg');
    if (!codigo || !nombre) {
      $msg.innerHTML = '<div class="error-msg">Código y nombre son obligatorios.</div>';
      return;
    }
    try {
      const r = await api('/api/products', {
        method: 'POST',
        body: {
          codigo, nombre,
          precio_pvf: pvf || null,
          ean: ean || null,
          tipo: 'comercial'
        }
      });
      modal.remove();
      mostrarNotificacionOnline('✅ Producto creado: ' + r.product.codigo, '#16a34a');
      if (typeof alCrear === 'function') alCrear(r.product);
    } catch (err) {
      $msg.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
}

// ============================================================================
// MOSAICO — reordenar láminas visualmente (cuadrícula drag&drop, elimina PowerPoint)
// ============================================================================
let _mosaicoCatalogId = null;
let _mosaicoSheets = [];
let _mosaicoCambios = false;

async function abrirMosaicoLaminas(catalogId) {
  _mosaicoCatalogId = catalogId;
  _mosaicoCambios = false;
  let sheets = [];
  try {
    const r = await api('/api/catalogs/' + catalogId);
    sheets = r.sheets || [];
  } catch (e) {
    alert('Error cargando láminas: ' + e.message);
    return;
  }
  _mosaicoSheets = sheets;

  const overlay = document.createElement('div');
  overlay.className = 'mosaico-overlay';
  overlay.id = 'mosaico-overlay';
  overlay.innerHTML = `
    <div class="mosaico-header">
      <div>
        <b>🔲 Reordenar catálogo</b>
        <span style="color:#9ca3af;font-size:13px">${sheets.length} láminas · arrastra para reordenar</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span id="mosaico-estado" style="font-size:12px;color:#9ca3af"></span>
        <button class="btn btn-secondary" onclick="cerrarMosaico()">Cerrar</button>
      </div>
    </div>
    <div class="mosaico-ayuda">
      ✋ Arrastra las láminas para cambiar el orden. Los cambios se guardan automáticamente.
    </div>
    <div class="mosaico-grid" id="mosaico-grid"></div>
  `;
  document.body.appendChild(overlay);
  pintarMosaicoReorden();
}

function pintarMosaicoReorden() {
  const grid = document.getElementById('mosaico-grid');
  if (!grid) return;
  grid.innerHTML = '';
  _mosaicoSheets.forEach((s, idx) => {
    const card = document.createElement('div');
    card.className = 'mosaico-card';
    card.draggable = true;
    card.dataset.id = s.id;
    card.innerHTML = `
      <input type="text" class="mosaico-num" value="${idx + 1}" title="Escribe la posición y pulsa Enter"
             inputmode="numeric" draggable="false" data-pos="${idx + 1}">
      <img src="${escape(vurl(s.miniatura_path || s.imagen_path, s))}" class="mosaico-img" alt="" loading="lazy" decoding="async"
           onerror="this.style.background='#374151'">
      <div class="mosaico-titulo">${escape(s.titulo || 'Sin título')}</div>
    `;
    grid.appendChild(card);
  });
  activarDragDropMosaico();
  activarMoverPorNumero();
}

// K1: mover lámina escribiendo la posición destino en el número
function activarMoverPorNumero() {
  const grid = document.getElementById('mosaico-grid');
  if (!grid) return;
  grid.querySelectorAll('.mosaico-num').forEach(input => {
    // Evitar que al pulsar el input se inicie el arrastre de la tarjeta
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => { e.stopPropagation(); input.select(); });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        aplicarMoverPorNumero(input);
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = input.dataset.pos;
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      // Si al perder foco el valor cambió, aplicarlo; si no, restaurar
      if (input.value.trim() !== input.dataset.pos) {
        aplicarMoverPorNumero(input);
      }
    });
  });
}

async function aplicarMoverPorNumero(input) {
  const card = input.closest('.mosaico-card');
  if (!card) return;
  const sheetId = Number(card.dataset.id);
  const total = _mosaicoSheets.length;
  let destino = parseInt(input.value, 10);
  // Validar
  if (isNaN(destino)) { input.value = input.dataset.pos; return; }
  if (destino < 1) destino = 1;
  if (destino > total) destino = total;

  // Posición actual (0-based) por id
  const origenIdx = _mosaicoSheets.findIndex(s => s.id === sheetId);
  const destinoIdx = destino - 1;
  if (origenIdx === -1 || origenIdx === destinoIdx) {
    input.value = input.dataset.pos;
    return;
  }

  // L1: extraer y reinsertar (insertar y desplazar el resto)
  const [movido] = _mosaicoSheets.splice(origenIdx, 1);
  _mosaicoSheets.splice(destinoIdx, 0, movido);

  // Repintar y guardar
  pintarMosaicoReorden();
  await guardarOrdenMosaico();
}

function activarDragDropMosaico() {
  const grid = document.getElementById('mosaico-grid');
  if (!grid) return;
  let arrastrando = null;

  grid.querySelectorAll('.mosaico-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      arrastrando = card;
      card.classList.add('mosaico-arrastrando');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(card.dataset.id || '')); } catch(_) {}
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('mosaico-arrastrando');
      if (_mosaicoCambios) guardarOrdenMosaico();
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!arrastrando || arrastrando === card) return;
      const rect = card.getBoundingClientRect();
      const despues = (e.clientY - rect.top) > rect.height / 2 || (e.clientX - rect.left) > rect.width / 2;
      if (despues) {
        card.parentNode.insertBefore(arrastrando, card.nextSibling);
      } else {
        card.parentNode.insertBefore(arrastrando, card);
      }
      _mosaicoCambios = true;
      Array.from(grid.querySelectorAll('.mosaico-card')).forEach((c, i) => {
        const n = c.querySelector('.mosaico-num');
        if (n) { n.value = String(i + 1); n.dataset.pos = String(i + 1); }
      });
    });
  });
}

async function guardarOrdenMosaico() {
  _mosaicoCambios = false;
  const grid = document.getElementById('mosaico-grid');
  const ids = Array.from(grid.querySelectorAll('.mosaico-card')).map(c => Number(c.dataset.id));
  const $estado = document.getElementById('mosaico-estado');
  if ($estado) $estado.textContent = 'Guardando…';
  try {
    await api(`/api/catalogs/${_mosaicoCatalogId}/sheets/reorder`, {
      method: 'PUT',
      body: { sheet_ids: ids }
    });
    if ($estado) {
      $estado.textContent = '✓ Orden guardado';
      setTimeout(() => { if ($estado) $estado.textContent = ''; }, 1500);
    }
    _mosaicoSheets.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  } catch (err) {
    if ($estado) $estado.textContent = '';
    alert('Error guardando orden: ' + err.message);
  }
}

function cerrarMosaico() {
  const ov = document.getElementById('mosaico-overlay');
  if (ov) ov.remove();
  if (_mosaicoCatalogId) renderEditorCatalogo(_mosaicoCatalogId);
}

// ===== ARRANQUE =====
render();
// I: inicializar modo offline (IndexedDB, indicador online, etc.)
if (typeof inicializarOffline === 'function') {
  inicializarOffline();
}
