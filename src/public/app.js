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
  visitaVerId: null           // B6: si !=null se muestra detalle de una visita pasada
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
          ${adminReal && !impersonando ? `<button class="topbar-action" onclick="abrirSelectorImpersonacion()" title="Ver como un comercial">👁 Ver como…</button>` : ''}
          <button class="topbar-logout" onclick="logout()">Salir</button>
        </div>
      </div>
      <div class="navtabs">
        <button class="navtab ${appState.vista === 'catalogos' ? 'navtab-activa' : ''}" onclick="irA('catalogos')">📚 Catálogos</button>
        <button class="navtab ${appState.vista === 'clientes' ? 'navtab-activa' : ''}" onclick="irA('clientes')">🏥 Clientes</button>
        ${esAdmin ? `<button class="navtab ${appState.vista === 'comerciales' ? 'navtab-activa' : ''}" onclick="irA('comerciales')">👥 Comerciales</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'plantillas' ? 'navtab-activa' : ''}" onclick="irA('plantillas')">🏷️ Plantillas</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'configuracion' ? 'navtab-activa' : ''}" onclick="irA('configuracion')">⚙️ Configuración</button>` : ''}
        <button class="navtab ${appState.vista === 'cuenta' ? 'navtab-activa' : ''}" onclick="irA('cuenta')" style="margin-left:auto">⚙️ Mi cuenta</button>
      </div>
      <div id="vista-contenido"></div>
    </div>
  `;
  routerVista();
}

function routerVista() {
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
  } else if (appState.vista === 'plantillas') {
    renderListaPlantillas();
  } else if (appState.vista === 'configuracion') {
    renderConfiguracion();
  } else if (appState.vista === 'cuenta') {
    renderMiCuenta();
  } else if (appState.catalogoActual) {
    // Si admin → editor. Si comercial (o admin impersonando) → visor
    if (rolEfectivo() === 'admin') {
      renderEditorCatalogo(appState.catalogoActual);
    } else {
      renderVisorComercial(appState.catalogoActual);
    }
  } else {
    renderListaCatalogos();
  }
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
  try {
    const r = await api('/api/catalogs');
    const catalogos = r.catalogs || [];
    const esAdmin = rolEfectivo() === 'admin';

    let html = `
      <div class="contenedor">
        <div class="titulo-pagina">
          <h2>Catálogos</h2>
          ${esAdmin ? `<button class="btn btn-primary btn-pequeno" onclick="abrirModalNuevoCatalogo()">+ Nuevo catálogo</button>` : ''}
        </div>
    `;

    if (catalogos.length === 0) {
      html += `
        <div class="empty-state">
          <div class="empty-state-icono">📚</div>
          <h3>No hay catálogos todavía</h3>
          <p>${esAdmin ? 'Crea tu primer catálogo maestro para empezar a subir láminas.' : 'Aún no tienes catálogos asignados.'}</p>
          ${esAdmin ? `<button class="btn btn-primary" style="max-width:280px;margin:0 auto" onclick="abrirModalNuevoCatalogo()">+ Crear primer catálogo</button>` : ''}
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
        html += `
          <div class="catalogo-card" onclick="abrirCatalogo(${c.id})">
            <div class="catalogo-card-header">
              <span class="catalogo-card-tipo ${tipoClase}">${badgeTxt}</span>
              <span class="catalogo-card-estado ${estadoClase}">${c.estado}</span>
            </div>
            <div class="catalogo-card-nombre">${escape(c.name)}</div>
            ${parentLine}
            <div class="catalogo-card-info">${c.sheet_count || 0} láminas · V${c.version}</div>
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
  render();
}

function volverACatalogos() {
  appState.catalogoActual = null;
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
              ${sheets.length > 0 ? `<button class="btn btn-danger btn-pequeno" onclick="borrarTodasLaminas(${id}, ${sheets.length})">🗑️ Borrar todas</button>` : ''}
            </div>
          ` : ''}
        </div>

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
      </div>
    `;
    $v.innerHTML = html;

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
    const params = new URLSearchParams({
      page: appState.clientesPagina,
      limit: 50,
      search: appState.clientesBusqueda || ''
    });
    const r = await api('/api/clients?' + params.toString());

    // Si esta no es la búsqueda más reciente, ignoramos
    if (miToken !== _busquedaTokenActual) return;
    if ($spinner) $spinner.style.display = 'none';

    const clientes = r.clients || [];
    const esAdmin = rolEfectivo() === 'admin';

    $resumen.textContent = `${r.total} ${appState.clientesBusqueda ? 'resultados' : 'clientes'} · página ${r.page} de ${r.pages || 1}`;

    let html = '';
    if (clientes.length === 0) {
      html = `
        <div class="empty-state">
          <div class="empty-state-icono">🏥</div>
          <h3>${appState.clientesBusqueda ? 'Sin resultados' : 'No hay clientes todavía'}</h3>
          <p>${appState.clientesBusqueda ? 'Prueba con otra búsqueda.' : esAdmin ? 'Importa el Excel de Sage para empezar.' : 'Aún no tienes clientes asignados.'}</p>
          ${esAdmin && !appState.clientesBusqueda ? `<button class="btn btn-primary" style="max-width:280px;margin:0 auto" onclick="abrirModalImportarSage()">📊 Importar Excel de Sage</button>` : ''}
        </div>
      `;
    } else {
      html = '<div class="clientes-tabla">';
      clientes.forEach(c => {
        const inactive = !c.is_active ? ' cliente-fila-baja' : '';
        html += `
          <div class="cliente-fila cliente-fila-clickable${inactive}" onclick="abrirDetalleCliente(${c.id})">
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

      if (r.pages > 1) {
        html += `<div class="paginacion">
          <button class="btn btn-pequeno btn-secondary" ${r.page <= 1 ? 'disabled' : ''} onclick="paginaClientes(${r.page - 1})">← Anterior</button>
          <span style="font-size:12px;color:var(--gris-texto);align-self:center">Página ${r.page} de ${r.pages}</span>
          <button class="btn btn-pequeno btn-secondary" ${r.page >= r.pages ? 'disabled' : ''} onclick="paginaClientes(${r.page + 1})">Siguiente →</button>
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
    const r = await api('/api/catalogs/' + catalogId);
    _visorCatalog = r.catalog;
    _visorSheets = (r.sheets || []).filter(s => !s.oculta);

    // B6: si hay visita activa, cargar anotaciones para pintarlas en el visor
    if (appState.visitaActiva) {
      await cargarAnotacionesDeVisita();
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
            <p>El administrador aún no ha subido láminas.</p>
          </div>
        </div>
      `;
      return;
    }

    // Si el indice esta fuera de rango, reset
    if (appState.visorIndice >= _visorSheets.length) appState.visorIndice = 0;

    pintarVisor();
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

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
      <div class="visor-cabecera-fila">
        <button class="btn-icon-volver" onclick="volverACatalogos()" title="Volver a catálogos">←</button>
        <div class="visor-titulo-bloque">
          <div class="visor-titulo">${escape(_visorCatalog.name)}</div>
          <div class="visor-subtitulo">${totalReal} láminas${busca ? ` · ${visibles.length} resultados` : ''}</div>
        </div>
        <div class="visor-modo-switch">
          ${appState.visitaActiva ? `<button class="visor-modo-btn visor-modo-btn-notas" onclick="abrirModalUltimaVisita(${appState.visitaActiva.client_id})" title="Ver notas privadas de la última visita con este cliente">📋</button>` : ''}
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

  return `
    <div class="visor-presentacion">
      <div class="visor-nav-superior">
        <button class="visor-nav-btn" ${prevDisabled} onclick="visorAnterior()">◀ Anterior</button>
        <div class="visor-contador">
          <span class="visor-contador-num">${numeroOriginal}</span>
          <span class="visor-contador-total">/ ${_visorSheets.length}</span>
        </div>
        <button class="visor-nav-btn" ${nextDisabled} onclick="visorSiguiente()">Siguiente ▶</button>
      </div>

      <div class="visor-imagen-contenedor" id="visor-img-contenedor">
        <div class="visor-imagen-zoom" id="visor-img-zoom" style="transform: scale(${appState.visorZoom})">
          <img src="${escape(sheet.imagen_path)}" class="visor-imagen" id="visor-imagen" alt="${escape(sheet.titulo || '')}" draggable="false">
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
        💡 Pellizca con 2 dedos para hacer zoom · doble toque para zoom rápido · desliza para navegar
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
    });
  }
}

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

        <!-- ACCIONES -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:14px">
          <button class="btn btn-secondary" onclick="enviarEmailPrueba()">📨 Enviar email de prueba</button>
          <button class="btn btn-primary" onclick="guardarConfiguracion()">💾 Guardar cambios</button>
        </div>

        <div id="config-msg"></div>
      </div>
    `;
    $v.innerHTML = html;
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
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
    'firma_html'
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

  // Cabecera distinta según modo (más sobria en modal del visor por privacidad)
  let cabecera;
  if (modo === 'visor') {
    cabecera = `
      <div class="uv-cabecera-privada">
        <div class="uv-titulo-privada">📋 NOTAS PRIVADAS — NO MOSTRAR AL CLIENTE</div>
        <div style="font-size:12px;color:#92400e;margin-top:2px">Resumen de la última visita con este cliente</div>
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
    <div class="ultima-visita-panel ${modo === 'visor' ? 'ultima-visita-panel-privada' : ''}">
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
        <h3 style="color:#92400e">📋 Notas privadas</h3>
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
              ${campo('Ciclo visita (días)', c.ciclo_visita_dias)}
              ${campo('Última visita', c.ultima_visita_at ? new Date(c.ultima_visita_at).toLocaleString('es-ES') : '—')}
              ${c.notas_internas ? `<div class="kv-row"><div class="kv-label">Notas internas</div><div class="kv-val">${escape(c.notas_internas)}</div></div>` : ''}
            </div>
          </div>

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
  } catch (err) {
    $v.innerHTML = `<div class="contenedor"><div class="error-msg">${escape(err.message)}</div></div>`;
  }
}

// ----- INICIAR VISITA DESDE FICHA DE CLIENTE -----
async function iniciarVisitaParaCliente(clientId) {
  // Si ya hay visita activa con OTRO cliente, avisar
  if (appState.visitaActiva && appState.visitaActiva.client_id !== clientId) {
    if (!confirm('Ya tienes una visita en curso con otro cliente. Si quieres iniciar una nueva, primero cierra o descarta la actual.')) return;
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

// ----- CERRAR VISITA ACTIVA (confirmar) -----
async function cerrarVisitaActiva() {
  if (!appState.visitaActiva) return;
  const notas = prompt('Notas generales de la visita (opcional):', '');
  if (notas === null) return; // canceló
  try {
    await api('/api/visits/' + appState.visitaActiva.id + '/confirm', {
      method: 'POST',
      body: { notas_generales: notas || '' }
    });
    const visitaId = appState.visitaActiva.id;
    appState.visitaActiva = null;
    // Llevar al detalle de la visita recién cerrada
    appState.vista = 'clientes';
    appState.catalogoActual = null;
    appState.clienteActual = null;
    appState.visitaVerId = visitaId;
    render();
  } catch (err) {
    alert('Error al cerrar visita: ' + err.message);
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

  const modal = document.createElement('div');
  modal.className = 'modal-bg';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>Anotar lámina ${sheetNumero}</h3>
        <button class="modal-cerrar" onclick="this.closest('.modal-bg').remove()">×</button>
      </div>
      <div style="font-size:13px;color:var(--gris-texto);margin-bottom:8px">${escape(sheetTitulo || 'Sin título')}</div>
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
      await api('/api/visits/' + appState.visitaActiva.id + '/annotations', {
        method: 'POST',
        body: { sheet_id: sheetId, texto_libre: texto, tipo }
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

// ===== ARRANQUE =====
render();
