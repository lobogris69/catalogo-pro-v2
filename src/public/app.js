// ============================================================================
// CatalogPRO v2 - Frontend
// ============================================================================
const API = '';
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
  visorZoom: 1,
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
        // Si el backend dice que el token caducó/no vale, hacemos logout limpio para que el
        // usuario vea la pantalla de login en vez de un error críptico en cualquier pantalla.
        if (r.status === 401 && data.error && /token/i.test(data.error)) {
          // Avisar y desloguear
          setTimeout(() => {
            alert('Tu sesión ha caducado. Vuelve a iniciar sesión.');
            logout();
          }, 0);
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
          <button class="topbar-logout" onclick="logout()">Salir</button>
        </div>
      </div>
      <div class="navtabs">
        ${esAdmin ? `<button class="navtab ${appState.vista === 'dashboard' ? 'navtab-activa' : ''}" onclick="irA('dashboard')">🏠 Dashboard</button>` : ''}
        <button class="navtab ${appState.vista === 'catalogos' ? 'navtab-activa' : ''}" onclick="irA('catalogos')">📚 Catálogos</button>
        <button class="navtab ${appState.vista === 'clientes' ? 'navtab-activa' : ''}" onclick="irA('clientes')">🏥 Clientes</button>
        <button class="navtab ${appState.vista === 'planning' ? 'navtab-activa' : ''}" onclick="irA('planning')">🗓️ Planning</button>
        <button class="navtab ${appState.vista === 'mapa' ? 'navtab-activa' : ''}" onclick="irA('mapa')">🗺️ Mapa</button>
        ${esAdmin ? `<button class="navtab ${appState.vista === 'productos' ? 'navtab-activa' : ''}" onclick="irA('productos')">📦 Productos</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'comerciales' ? 'navtab-activa' : ''}" onclick="irA('comerciales')">👥 Comerciales</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'plantillas' ? 'navtab-activa' : ''}" onclick="irA('plantillas')">🏷️ Plantillas</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'configuracion' ? 'navtab-activa' : ''}" onclick="irA('configuracion')">⚙️ Configuración</button>` : ''}
        <button class="navtab navtab-lupa" onclick="abrirBusquedaGlobal()" title="Buscar (Ctrl+K)" style="margin-left:auto">🔍</button>
        <button class="navtab ${appState.vista === 'cuenta' ? 'navtab-activa' : ''}" onclick="irA('cuenta')">⚙️ Mi cuenta</button>
      </div>
      <div id="vista-contenido"></div>
    </div>
  `;
  routerVista();
  // I: re-aplicar estado del indicador online tras cada render
  if (typeof actualizarIndicadorOnline === 'function') actualizarIndicadorOnline();
}

function routerVista() {
  // I.2: vistas que NO funcionan offline (requieren API y no tienen cache offline)
  // Clientes y Planning SÍ funcionan offline (I.3 + I-Planning) leyendo desde IndexedDB
  const vistasOnlineOnly = ['comerciales', 'mapa', 'plantillas', 'configuracion', 'productos', 'dashboard'];
  if (!navigator.onLine && vistasOnlineOnly.includes(appState.vista)) {
    renderVistaNoDisponibleOffline(appState.vista);
    return;
  }

  if (appState.vista === 'dashboard') {
    renderDashboard();
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
            ${esAdmin && !modoOffline ? `<button class="btn btn-primary btn-pequeno" onclick="abrirModalNuevoCatalogo()">+ Nuevo catálogo</button>` : ''}
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
  render();
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
              ${sheets.length > 1 ? `<button class="btn btn-secondary btn-pequeno" onclick="abrirMosaicoLaminas(${id})" title="Reordenar láminas en mosaico visual">🔲 Mosaico</button>` : ''}
              ${sheets.length > 0 ? `<button class="btn btn-primary btn-pequeno" onclick="abrirCerrarVersion(${id}, ${c.version || 1}, '${escape((c.name || '').replace(/'/g, "\\'"))}')" title="Cerrar versión actual y empezar la siguiente">📌 Cerrar versión</button>` : ''}
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

            <div class="upload-zona upload-zona-pdf" id="upload-zona-pdf" onclick="document.getElementById('upload-pdf-input').click()">
              <div class="upload-zona-icono">📚</div>
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
                <input type="text" id="filtro-laminas" placeholder="🔍 Filtrar (número o palabra)..."
                       style="flex:1; min-width:200px; padding:8px 12px; border:1px solid var(--gris-borde); border-radius:8px; font-size:13px; font-family:inherit; outline:none;">
              ` : ''}
            </div>
            <div id="laminas-lista">
              ${sheets.length === 0 ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">Sin láminas todavía. ${esAdmin ? 'Sube la primera con el panel de la izquierda.' : ''}</p>` : ''}
              ${sheets.map((s, idx) => `
                <div class="lamina-fila" data-id="${s.id}" data-titulo="${escape((s.titulo || '').toLowerCase())}" data-tags="${escape((s.tags || '').toLowerCase())}" data-numero="${idx + 1}" ${esAdmin ? 'draggable="true"' : ''}>
                  ${esAdmin ? `<div class="drag-handle" title="Arrastra para reordenar">⋮⋮</div>` : ''}
                  <div class="lamina-numero">${idx + 1}</div>
                  <img src="${escape(s.imagen_path)}" class="lamina-mini" alt="" onerror="this.style.background='#f3f4f6';this.style.objectFit='contain'" onclick="abrirLightbox('${escape(s.imagen_path)}', '${escape((s.titulo || 'Lámina ' + (idx + 1)).replace(/'/g, '\\\''))}', ${idx + 1})">
                  <div class="lamina-info">
                    <div class="lamina-titulo">${escape(s.titulo || 'Sin título')}</div>
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
                    <button onclick="sustituirImagenLamina(${s.id})" title="Sustituir imagen">🔄</button>
                    <button onclick="editarLamina(${s.id})" title="Editar todo">✏️</button>
                    <button class="btn-borrar" onclick="borrarLamina(${s.id}, ${id})" title="Borrar">🗑️</button>
                  </div>
                  ` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </div>
    `;
    // Pintamos el contenido en la pestaña láminas (el contenedor exterior ya está en $v)
    const $pestContenido = document.getElementById('editor-pestana-contenido');
    if ($pestContenido) $pestContenido.innerHTML = htmlContenido;

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
          ${sheetsExpress.length > 0 ? `<button class="btn btn-danger btn-pequeno" onclick="vaciarExpress(${id}, ${sheetsExpress.length})">🗑️ Vaciar Express</button>` : ''}
        </div>
      </div>

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
                    <img src="${escape(s.imagen_path)}" class="lamina-mini" alt=""
                         onclick="abrirLightbox('${escape(s.imagen_path)}', '${escape((s.titulo || 'Lámina').replace(/'/g, '\\\''))}', ${s.orden})">
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
                  <img src="${escape(s.imagen_path)}" class="lamina-mini" alt=""
                       onclick="abrirLightbox('${escape(s.imagen_path)}', '${escape((s.titulo || 'Lámina').replace(/'/g, '\\\''))}', ${idx + 1})">
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
  document.querySelectorAll('#laminas-lista .lamina-fila').forEach(fila => {
    if (!t) {
      fila.style.display = '';
      return;
    }
    const titulo = fila.dataset.titulo || '';
    const tags = fila.dataset.tags || '';
    const num = fila.dataset.numero || '';
    let coincide = false;
    if (!isNaN(numero) && String(numero) === num) coincide = true;
    if (titulo.includes(t)) coincide = true;
    if (tags.includes(t)) coincide = true;
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

function abrirModalEditarLamina(sheet, catalogId) {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>Editar lámina</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div id="modal-edit-error"></div>
      <div style="text-align:center;margin-bottom:1rem">
        <img src="${escape(sheet.imagen_path)}" style="max-width:200px;max-height:260px;border:1px solid var(--gris-borde);border-radius:8px">
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
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
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
      // 2) Si hay imagen nueva, sustituirla
      const fileInput = document.getElementById('ed-imagen');
      if (fileInput.files.length > 0) {
        const fd = new FormData();
        fd.append('imagen', fileInput.files[0]);
        await api('/api/sheets/' + sheet.id + '/image', { method: 'PUT', body: fd });
      }
      modal.remove();
      renderEditorCatalogo(catalogId);
    } catch (err) {
      document.getElementById('modal-edit-error').innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
    }
  });
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
          <h2>Clientes</h2>
          <div id="clientes-resumen" style="font-size:12px;color:var(--gris-texto);margin-top:4px">cargando…</div>
        </div>
        ${esAdmin ? `<button class="btn btn-primary btn-pequeno" onclick="abrirModalImportarSage()">📊 Importar Excel Sage</button>` : ''}
      </div>

      <div style="background:white;border:1px solid var(--gris-borde);border-radius:12px;padding:1rem;margin-bottom:1rem;position:relative">
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

function pintarVisor() {
  const $v = document.getElementById('vista-contenido');
  const totalReal = _visorSheets.length;
  const busca = appState.visorBusqueda.trim().toLowerCase();

  // Filtrar por búsqueda
  let visibles = _visorSheets;
  if (busca) {
    // Búsqueda por número de lámina o por texto
    const numero = parseInt(busca);
    visibles = _visorSheets.filter((s, i) => {
      if (!isNaN(numero) && (i + 1) === numero) return true;
      const blob = [s.titulo, s.notas, s.tags].filter(Boolean).join(' ').toLowerCase();
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
        <input type="text" id="visor-buscar" placeholder="🔍 Buscar (nombre, oferta, número de lámina…)"
               value="${escape(appState.visorBusqueda)}"
               class="visor-buscador">
        ${appState.visorBusqueda ? '<button class="visor-buscador-clear" onclick="limpiarVisorBusqueda()">✕</button>' : ''}
      </div>
    </div>
  `;

  // Cuerpo según el modo
  let cuerpo = '';
  if (appState.visorModo === 'mosaico') {
    cuerpo = pintarMosaico(visibles);
  } else {
    cuerpo = pintarPresentacion(visibles);
  }

  $v.innerHTML = `<div class="visor-shell">${cabecera}${cuerpo}</div>`;

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

  return `
    <div class="visor-presentacion">
      <div class="visor-nav-superior">
        <button class="visor-nav-btn" ${prevDisabled} onclick="visorAnterior()">◀ Anterior</button>
        <div class="visor-contador">
          <span class="visor-contador-num">${numeroOriginal}</span>
          <span class="visor-contador-total">/ ${_visorSheets.length}</span>
        </div>
        <button class="visor-nav-btn" ${nextDisabled} onclick="visorSiguiente()">Siguiente ▶</button>
        ${appState.visitaActiva ? `<button class="visor-fullscreen-btn" onclick="entrarPantallaCompleta()" title="Modo presentación pantalla completa">⛶ Pantalla completa</button>` : ''}
      </div>

      <div class="visor-imagen-contenedor" id="visor-img-contenedor">
        <div class="visor-imagen-zoom" id="visor-img-zoom" style="transform: scale(${appState.visorZoom})">
          <div class="visor-imagen-wrapper" id="visor-imagen-wrapper" data-sheet-id="${sheet.id}">
            <img src="${escape(sheet.imagen_path)}" class="visor-imagen" id="visor-imagen" alt="${escape(sheet.titulo || '')}" draggable="false">
            ${pins}
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
            <img src="${escape(s.imagen_path)}" class="visor-mosaico-img" alt="" loading="lazy">
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
  pintarVisor();
}

function visorAnterior() {
  if (appState.visorIndice > 0) {
    appState.visorIndice--;
    appState.visorZoom = 1;
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
    pintarVisor();
  }
}

function visorZoomReset() {
  appState.visorZoom = 1;
  pintarVisor();
}

function abrirLaminaDesdeMosaico(idx) {
  appState.visorIndice = idx;
  appState.visorModo = 'presentacion';
  appState.visorZoom = 1;
  pintarVisor();
}

function limpiarVisorBusqueda() {
  appState.visorBusqueda = '';
  appState.visorIndice = 0;
  pintarVisor();
}

// ----- Gestos: pinch-zoom, doble-tap, swipe -----
function engancharGestosPresentacion() {
  const $cont = document.getElementById('visor-img-contenedor');
  const $zoom = document.getElementById('visor-img-zoom');
  if (!$cont || !$zoom) return;

  let lastTap = 0;
  let touchStartX = null;
  let touchStartY = null;
  let initialPinchDist = null;
  let zoomAlInicioPinch = 1;

  // Doble tap (touch + click)
  $cont.addEventListener('click', (e) => {
    // Solo si NO hubo pinch
    if (e.target.closest('.visor-zoom-reset')) return;
    const ahora = Date.now();
    if (ahora - lastTap < 350) {
      // Doble click/tap: zoom rapido
      if (appState.visorZoom < 1.5) {
        appState.visorZoom = 2.5;
      } else {
        appState.visorZoom = 1;
      }
      $zoom.style.transform = `scale(${appState.visorZoom})`;
      pintarVisor();
    }
    lastTap = ahora;
  });

  // Pinch zoom (touch screens)
  $cont.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialPinchDist = Math.hypot(dx, dy);
      zoomAlInicioPinch = appState.visorZoom;
    } else if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  $cont.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialPinchDist !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const factor = dist / initialPinchDist;
      let nuevoZoom = zoomAlInicioPinch * factor;
      nuevoZoom = Math.max(1, Math.min(4, nuevoZoom));
      appState.visorZoom = nuevoZoom;
      $zoom.style.transform = `scale(${nuevoZoom})`;
    }
  }, { passive: false });

  $cont.addEventListener('touchend', (e) => {
    // Si terminó un pinch, repintar para mostrar boton reset
    if (initialPinchDist !== null) {
      initialPinchDist = null;
      pintarVisor();
      return;
    }
    // Si fue 1 dedo y no zoom, mirar swipe
    if (touchStartX !== null && e.changedTouches.length === 1 && appState.visorZoom < 1.2) {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      // Swipe horizontal claramente más fuerte que vertical
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx > 0) visorAnterior();
        else visorSiguiente();
      }
    }
    touchStartX = null;
    touchStartY = null;
  });

  // Wheel zoom (escritorio con rueda)
  $cont.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      let nuevoZoom = appState.visorZoom * factor;
      nuevoZoom = Math.max(1, Math.min(4, nuevoZoom));
      appState.visorZoom = nuevoZoom;
      $zoom.style.transform = `scale(${nuevoZoom})`;
      // Actualizar boton reset
      const $reset = $cont.querySelector('.visor-zoom-reset');
      if (nuevoZoom > 1 && !$reset) {
        pintarVisor();
      } else if (nuevoZoom <= 1 && $reset) {
        pintarVisor();
      }
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
      else if (e.key === 'Escape' && appState.visorZoom > 1) { appState.visorZoom = 1; pintarVisor(); }
      else if (e.key === 'Escape' && _fullscreenActivo) { salirPantallaCompleta(); }
    });
  }

  // B7: Long-press sobre la imagen para crear pin de anotación (solo si hay visita activa)
  engancharLongPressParaPin();
  // Fase 2.c': cargar y pintar las zonas clicables de productos (solo en visita)
  if (appState.visitaActiva) {
    cargarZonasComercial();
  }
}

// ============================================================================
// FASE 2.c' — COMERCIAL pulsa zonas de productos
// ============================================================================
let _zonasComercial = []; // zonas de la lámina actual en el visor

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
    _zonasComercial = (r.zones || []).filter(z => z.product_id); // solo zonas con producto
    pintarZonasComercial();
  } catch (e) {
    _zonasComercial = [];
  }
}

function pintarZonasComercial() {
  const capa = document.getElementById('visor-zonas-capa');
  if (!capa) return;
  capa.innerHTML = '';
  _zonasComercial.forEach((z) => {
    const div = document.createElement('div');
    div.className = 'visor-zona';
    div.style.left = z.x + '%';
    div.style.top = z.y + '%';
    div.style.width = z.ancho + '%';
    div.style.height = z.alto + '%';
    div.dataset.zoneId = z.id;
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

async function pulsarZonaComercial(zona) {
  if (!appState.visitaActiva) return;
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
  const pvf = zona.producto_pvf ? Number(zona.producto_pvf) : null;

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>${anotExistente ? '✏️ Editar' : '🛒 Anotar'} producto</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div class="zona-modal-producto">
        <span class="ac-badge-${zona.producto_tipo === 'comercial' ? 'promo' : 'sage'}">
          ${zona.producto_tipo === 'comercial' ? '🎁 Promo' : '🏷️ Sage'}
        </span>
        <b>${escape(zona.producto_codigo || '')}</b>
        <div style="font-size:13px;color:#374151;margin-top:2px">${escape(zona.producto_nombre || '')}</div>
        ${pvf !== null ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">PVF ${pvf.toFixed(2)}€</div>` : ''}
      </div>

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

      ${plantillas.length > 0 ? `
        <div class="form-group">
          <label>Plantillas rápidas</label>
          <div class="zona-plantillas">
            ${plantillas.map(p => `
              <button type="button" class="zona-tpl-chip" data-texto="${escape(p.texto).replace(/"/g,'&quot;')}">
                ${escape(p.texto)}
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}

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

  // Plantillas → añaden su texto a la nota
  modal.querySelectorAll('.zona-tpl-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const txt = chip.dataset.texto;
      $nota.value = $nota.value ? ($nota.value + ' · ' + txt) : txt;
    });
  });

  // Guardar
  modal.querySelector('#zona-guardar').addEventListener('click', async () => {
    const cantidad = Number($cant.value) || 1;
    const notaExtra = $nota.value.trim();
    // Montar el texto_libre automático: "6 uds · 1243441 NOMBRE [· nota]"
    let texto = cantidad + ' uds · ' + (zona.producto_codigo || '') + ' ' + (zona.producto_nombre || '');
    if (notaExtra) texto += ' · ' + notaExtra;
    const $msg = modal.querySelector('#zona-modal-msg');
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
            product_id: zona.product_id,
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
  if (!appState.visitaActiva) {
    alert('La pantalla completa solo está disponible durante una visita activa.');
    return;
  }
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
                    <span class="plantilla-tipo-badge ${colorTipo(t.tipo)}">${iconoTipo(t.tipo)} ${t.tipo}</span>
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
          <select id="tpl-tipo">
            <option value="pedido">🛒 Pedido</option>
            <option value="devolucion">↩️ Devolución</option>
            <option value="nota">📝 Nota</option>
          </select>
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
  setTimeout(() => { const t = document.getElementById('tpl-texto'); if (t) t.focus(); }, 50);
  document.getElementById('form-nueva-plantilla').addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = document.getElementById('tpl-texto').value.trim();
    const tipo = document.getElementById('tpl-tipo').value;
    try {
      await api('/api/annotation-templates', { method: 'POST', body: { texto, tipo } });
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
          <select id="tpl-tipo">
            <option value="pedido" ${tpl.tipo === 'pedido' ? 'selected' : ''}>🛒 Pedido</option>
            <option value="devolucion" ${tpl.tipo === 'devolucion' ? 'selected' : ''}>↩️ Devolución</option>
            <option value="nota" ${tpl.tipo === 'nota' ? 'selected' : ''}>📝 Nota</option>
          </select>
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
  document.getElementById('form-editar-plantilla').addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = document.getElementById('tpl-texto').value.trim();
    const tipo = document.getElementById('tpl-tipo').value;
    try {
      await api('/api/annotation-templates/' + id, { method: 'PUT', body: { texto, tipo } });
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
          <h3 style="margin-top:0">Modo de envío</h3>
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
          <div id="geocoding-stats" style="background:#f9fafb;padding:12px;border-radius:8px;margin:12px 0;font-size:13px">
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
          <div id="limpiar-pruebas-stats" style="background:#fff;padding:12px;border-radius:8px;margin:12px 0;font-size:13px;border:1px solid #fecaca">
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

        <div id="config-msg"></div>
      </div>
    `;
    $v.innerHTML = html;
    // Cargar stats geocoding tras pintar
    actualizarStatsGeocoding();
    // Cargar recuento de datos de prueba
    cargarStatsLimpiarPruebas();
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
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
        Vas a borrar <b>todos los catálogos, láminas, visitas, anotaciones y versiones</b>.
        <br><br>
        Esto <b>NO</b> afecta a productos, clientes, usuarios, plantillas ni configuración.
        <br><br>
        <b>Esta acción no se puede deshacer.</b>
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
  if (confirmacion !== 'BORRAR') {
    $msg.innerHTML = `<div class="error-msg">Debes escribir exactamente BORRAR (en mayúsculas).</div>`;
    return;
  }
  $msg.innerHTML = `<div style="color:#6b7280;font-size:13px">Borrando datos de prueba…</div>`;
  try {
    const r = await api('/api/admin/limpiar-pruebas', {
      method: 'POST',
      body: { confirmacion: 'BORRAR' }
    });
    document.querySelector('.modal-bg').remove();
    const b = r.borrados;
    mostrarNotificacionOnline(
      `✅ Limpiado: ${b.catalogs} catálogos · ${b.sheets} láminas · ${b.visits} visitas · ${r.archivos_fisicos_borrados} archivos`,
      '#16a34a'
    );
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
        <button class="btn btn-primary btn-pequeno planning-btn-visita" onclick="event.stopPropagation();iniciarVisitaParaCliente(${c.id})" title="Empezar visita">🛒</button>
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
          <div style="display:flex; gap:6px; align-self:flex-start; flex-wrap:wrap">
            <button class="btn btn-primary" onclick="iniciarVisitaParaCliente(${c.id})">🛒 Empezar visita</button>
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
function abrirVisitaActiva() {
  if (!appState.visitaActiva) return;
  // Llevar al visor del catálogo de la visita
  appState.vista = 'catalogos';
  appState.clienteActual = null;
  appState.visitaVerId = null;
  appState.catalogoActual = appState.visitaActiva.catalog_id;
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
    widgetTopProductos(d.top_productos),
    widgetTopClientes(d.top_clientes)
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

  const conProducto = anotaciones.filter(a => a.product_id);
  const sinProducto = anotaciones.filter(a => !a.product_id);
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

  try {
    await api('/api/visits/' + _resumenPreEnvio.visitId + '/confirm', {
      method: 'POST',
      body: {
        notas_generales: notas,
        email_cliente_override: (emailOverride && emailOverride !== emailOriginal) ? emailOverride : null,
        no_enviar_cliente: noEnviar
      }
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
  });
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
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-pequeno" onclick="abrirModalImportarProductos()">📊 Importar Excel Sage</button>
          <button class="btn btn-primary btn-pequeno" onclick="abrirModalNuevoProducto()">+ Nuevo (expositor/promo)</button>
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
          <h3>${esExpositor ? '🎁' : '🏷️'} ${escape(p.nombre)}</h3>
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
          <button class="btn btn-primary" onclick="guardarProducto(${p.id})">💾 Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function guardarProducto(id) {
  const $err = document.getElementById('prod-error');
  $err.innerHTML = '';
  try {
    const body = {
      codigo: document.getElementById('prod-codigo').value.trim(),
      nombre: document.getElementById('prod-nombre').value.trim(),
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
    // Cerrar modal y recargar
    document.querySelector('.modal-bg').remove();
    recargarProductos();
    mostrarNotificacionOnline('✅ Producto actualizado', '#16a34a');
  } catch (err) {
    $err.innerHTML = `<div class="error-msg">${escape(err.message)}</div>`;
  }
}

function abrirModalNuevoProducto() {
  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card modal-card-ancho">
      <div class="modal-header">
        <h3>🎁 Nuevo expositor / promo</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <p style="font-size:13px;color:var(--gris-texto);margin-bottom:12px">
        Crea un producto que <b>no está en Sage</b> (típicamente expositores, packs promocionales, etc.). Define un código interno único.
      </p>
      <div class="form-group">
        <label>Código interno *</label>
        <input type="text" id="new-prod-codigo" placeholder="Ej: EXPO-GEL-24" required>
        <small style="color:var(--gris-texto)">Algo único que identifique este producto en la app. Sugerencia: EXPO-XXX o PROMO-XXX.</small>
      </div>
      <div class="form-group">
        <label>Nombre completo *</label>
        <input type="text" id="new-prod-nombre" placeholder="Ej: EXPOSITOR PROMO GEL hidratante 24 uds (24+6)" required>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group">
          <label>PVP orientativo (€)</label>
          <input type="number" step="0.01" id="new-prod-pvp">
        </div>
        <div class="form-group">
          <label>PVF / PVL (€)</label>
          <input type="number" step="0.01" id="new-prod-pvf">
        </div>
      </div>
      <div class="form-group">
        <label>Notas para administración <span style="color:var(--gris-texto);font-weight:normal">(opcional)</span></label>
        <textarea id="new-prod-notas-admin" rows="2" placeholder="Ej: Equivale a 24 unidades del código Sage 12345"></textarea>
      </div>
      <div id="new-prod-error"></div>
      <div class="modal-acciones">
        <button class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="crearNuevoProducto()">+ Crear</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('new-prod-codigo').focus(), 50);
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
    await api('/api/products', {
      method: 'POST',
      body: {
        codigo,
        nombre,
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

      <div style="background:#f9fafb;padding:14px;border-radius:8px;margin-bottom:14px;font-size:13px">
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

async function abrirEditorZonas(sheetId, catalogId) {
  // Cerrar el modal de editar lámina
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());

  _zonasEditor.sheetId = sheetId;
  _zonasEditor.catalogId = catalogId;
  _zonasEditor.zonaSeleccionadaId = null;

  // Cargar la lámina y sus zonas
  let sheet, zonas;
  try {
    const rCat = await api('/api/catalogs/' + catalogId);
    sheet = rCat.sheets.find(s => s.id === sheetId);
    if (!sheet) { alert('Lámina no encontrada'); return; }
    const rZonas = await api('/api/sheets/' + sheetId + '/zones');
    zonas = rZonas.zones || [];
  } catch (e) {
    alert('Error cargando datos: ' + e.message);
    return;
  }
  _zonasEditor.zonas = zonas;

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
        <button class="btn btn-secondary" onclick="cerrarEditorZonas()">Cerrar</button>
      </div>
    </div>
    <div class="zonas-editor-body">
      <div class="zonas-editor-lienzo-col">
        <div class="zonas-ayuda" id="zonas-ayuda">
          ✏️ <b>Arrastra</b> sobre la lámina para dibujar un rectángulo. Luego asígnale un producto en el panel derecho.
        </div>
        <div class="zonas-lienzo-wrap" id="zonas-lienzo-wrap">
          <img src="${escape(sheet.imagen_path)}" class="zonas-lienzo-img" id="zonas-lienzo-img" draggable="false" alt="">
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
}

function cerrarEditorZonas() {
  if (_zonasEditor.acProducto) { try { _zonasEditor.acProducto.destroy(); } catch {} _zonasEditor.acProducto = null; }
  const ov = document.getElementById('zonas-editor-overlay');
  if (ov) ov.remove();
  // Reabrir el modal de editar lámina para volver al flujo
  // (opcional: no lo reabrimos para no molestar)
}

function montarLienzoZonas() {
  const capa = document.getElementById('zonas-capa');
  const wrap = document.getElementById('zonas-lienzo-wrap');
  if (!capa || !wrap) return;

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
    // Si se pulsa sobre una zona existente, no dibujar (se gestiona con su propio click)
    if (e.target.classList.contains('zona-rect')) return;
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
}

function renderZonasEnCapa() {
  const capa = document.getElementById('zonas-capa');
  if (!capa) return;
  capa.innerHTML = '';
  _zonasEditor.zonas.forEach((z, idx) => {
    const div = document.createElement('div');
    const asignada = !!z.product_id;
    div.className = 'zona-rect' + (asignada ? ' zona-rect-asignada' : ' zona-rect-vacia') +
                    (z.id === _zonasEditor.zonaSeleccionadaId ? ' zona-rect-sel' : '');
    div.style.left = z.x + '%';
    div.style.top = z.y + '%';
    div.style.width = z.ancho + '%';
    div.style.height = z.alto + '%';
    div.dataset.zoneId = z.id;
    div.innerHTML = `<span class="zona-num">${idx + 1}</span>`;
    div.addEventListener('click', (e) => {
      e.stopPropagation();
      _zonasEditor.zonaSeleccionadaId = z.id;
      renderZonasEnCapa();
      renderListaZonas();
    });
    capa.appendChild(div);
  });
}

function actualizarContadorZonas() {
  const c = document.getElementById('zonas-contador');
  if (c) c.textContent = _zonasEditor.zonas.length + ' zonas';
}

function renderListaZonas() {
  const panel = document.getElementById('zonas-panel');
  if (!panel) return;

  const sel = _zonasEditor.zonas.find(z => z.id === _zonasEditor.zonaSeleccionadaId);

  if (!sel) {
    // Vista de lista general
    panel.innerHTML = `
      <h4 style="margin-top:0">Zonas dibujadas</h4>
      ${_zonasEditor.zonas.length === 0
        ? '<p style="color:#9ca3af;font-size:13px">Aún no hay zonas. Arrastra sobre la lámina para crear la primera.</p>'
        : _zonasEditor.zonas.map((z, idx) => `
          <div class="zona-lista-item" onclick="seleccionarZona(${z.id})">
            <span class="zona-lista-num">${idx + 1}</span>
            <span class="zona-lista-info">
              ${z.product_id
                ? `<b>${escape(z.producto_codigo || '')}</b> ${escape(z.producto_nombre || '')}`
                : '<span style="color:#f59e0b">⚠️ Sin producto asignado</span>'}
            </span>
          </div>
        `).join('')}
    `;
    return;
  }

  // Vista de detalle de zona seleccionada
  const idx = _zonasEditor.zonas.indexOf(sel) + 1;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h4 style="margin:0">Zona ${idx}</h4>
      <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="deseleccionarZona()">← Volver</button>
    </div>
    ${sel.product_id ? `
      <div class="zona-producto-actual">
        <div style="font-size:11px;color:#16a34a;font-weight:600;margin-bottom:4px">✅ Producto asignado</div>
        <b>${escape(sel.producto_codigo || '')}</b> · ${escape(sel.producto_nombre || '')}<br>
        <span style="font-size:12px;color:#6b7280">PVF ${sel.producto_pvf ? Number(sel.producto_pvf).toFixed(2) + '€' : '—'}</span>
      </div>
    ` : `
      <div style="background:#fef3c7;border:1px solid #fcd34d;padding:8px;border-radius:6px;font-size:12px;color:#78350f;margin-bottom:10px">
        ⚠️ Esta zona no tiene producto. Búscalo abajo y asígnalo.
      </div>
    `}
    <div class="form-group">
      <label style="font-size:13px">${sel.product_id ? 'Cambiar producto' : 'Asignar producto'}</label>
      <div id="zona-ac-contenedor"></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn" style="background:#dc2626;color:#fff;flex:1" onclick="borrarZona(${sel.id})">🗑️ Borrar zona</button>
    </div>
  `;

  // Montar el autocomplete dentro del panel
  if (_zonasEditor.acProducto) { try { _zonasEditor.acProducto.destroy(); } catch {} }
  const cont = document.getElementById('zona-ac-contenedor');
  _zonasEditor.acProducto = montarAutocompleteProducto(cont, {
    placeholder: 'Buscar producto…',
    onSelect: async (producto) => {
      if (!producto) return;
      try {
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

function seleccionarZona(zoneId) {
  _zonasEditor.zonaSeleccionadaId = zoneId;
  renderZonasEnCapa();
  renderListaZonas();
}

function deseleccionarZona() {
  _zonasEditor.zonaSeleccionadaId = null;
  renderZonasEnCapa();
  renderListaZonas();
}

async function borrarZona(zoneId) {
  if (!confirm('¿Borrar esta zona? El producto NO se borra, solo la zona sobre la lámina.')) return;
  try {
    await api('/api/zones/' + zoneId, { method: 'DELETE' });
    _zonasEditor.zonas = _zonasEditor.zonas.filter(z => z.id !== zoneId);
    _zonasEditor.zonaSeleccionadaId = null;
    renderZonasEnCapa();
    renderListaZonas();
    actualizarContadorZonas();
  } catch (err) {
    alert('Error borrando zona: ' + err.message);
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
        <h3>➕ Crear producto nuevo</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;padding:8px 12px;border-radius:8px;margin-bottom:14px;font-size:12px;color:#1e40af">
        Para expositores o promos que no están en Sage. Se marcará como tipo 🎁 comercial.
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
  pintarMosaico();
}

function pintarMosaico() {
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
      <img src="${escape(s.imagen_path)}" class="mosaico-img" alt="" loading="lazy"
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
  pintarMosaico();
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
