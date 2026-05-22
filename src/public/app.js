// ============================================================================
// CatalogPRO v2 - Frontend
// ============================================================================
const API = '';
let token = localStorage.getItem('cpv2_token');
let user = JSON.parse(localStorage.getItem('cpv2_user') || 'null');
let appState = {
  vista: 'catalogos',
  catalogoActual: null,
  clientesPagina: 1,
  clientesBusqueda: ''
};

const $app = document.getElementById('app');

// ===== HELPERS =====
function api(endpoint, options = {}) {
  const headers = options.headers || {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData) && options.body) {
    headers['Content-Type'] = 'application/json';
    if (typeof options.body !== 'string') options.body = JSON.stringify(options.body);
  }
  return fetch(API + endpoint, { ...options, headers })
    .then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
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
  token = null;
  user = null;
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
function renderApp() {
  const esAdmin = user.role === 'admin';
  $app.innerHTML = `
    <div class="app-shell">
      <div class="topbar">
        <div>
          <div class="topbar-titulo">CatalogPRO v2</div>
          <div class="topbar-usuario">${escape(user.name)} · ${user.role}</div>
        </div>
        <button class="topbar-logout" onclick="logout()">Salir</button>
      </div>
      <div class="navtabs">
        <button class="navtab ${appState.vista === 'catalogos' ? 'navtab-activa' : ''}" onclick="irA('catalogos')">📚 Catálogos</button>
        ${esAdmin ? `<button class="navtab ${appState.vista === 'clientes' ? 'navtab-activa' : ''}" onclick="irA('clientes')">🏥 Clientes</button>` : ''}
        ${esAdmin ? `<button class="navtab ${appState.vista === 'comerciales' ? 'navtab-activa' : ''}" onclick="irA('comerciales')">👥 Comerciales</button>` : ''}
        <button class="navtab ${appState.vista === 'cuenta' ? 'navtab-activa' : ''}" onclick="irA('cuenta')" style="margin-left:auto">⚙️ Mi cuenta</button>
      </div>
      <div id="vista-contenido"></div>
    </div>
  `;
  routerVista();
}

function routerVista() {
  if (appState.vista === 'clientes') {
    renderListaClientes();
  } else if (appState.vista === 'comerciales') {
    renderListaComerciales();
  } else if (appState.vista === 'cuenta') {
    renderMiCuenta();
  } else if (appState.catalogoActual) {
    renderEditorCatalogo(appState.catalogoActual);
  } else {
    renderListaCatalogos();
  }
}

function irA(vista) {
  appState.vista = vista;
  appState.catalogoActual = null;
  render();
}

// ===== LISTA DE CATALOGOS =====
async function renderListaCatalogos() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `<div class="contenedor"><div class="loading">Cargando catálogos…</div></div>`;
  try {
    const r = await api('/api/catalogs');
    const catalogos = r.catalogs || [];
    const esAdmin = user.role === 'admin';

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
        html += `
          <div class="catalogo-card" onclick="abrirCatalogo(${c.id})">
            <div class="catalogo-card-header">
              <span class="catalogo-card-tipo ${tipoClase}">${c.tipo}</span>
              <span class="catalogo-card-estado ${estadoClase}">${c.estado}</span>
            </div>
            <div class="catalogo-card-nombre">${escape(c.name)}</div>
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
function abrirModalNuevoCatalogo() {
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
          <label>Nombre</label>
          <input type="text" id="cat-name" required placeholder="Ej: Catálogo General Mayo 2026">
        </div>
        <div class="form-group">
          <label>Descripción (opcional)</label>
          <textarea id="cat-desc" rows="2" placeholder="Notas internas..."></textarea>
        </div>
        <div class="form-group">
          <label>Tipo</label>
          <select id="cat-tipo">
            <option value="maestro">Maestro (catálogo principal)</option>
            <option value="express">Express (campaña/novedades)</option>
          </select>
        </div>
        <div class="modal-acciones">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Crear</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('form-nuevo-cat').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = {
        name: document.getElementById('cat-name').value.trim(),
        description: document.getElementById('cat-desc').value.trim(),
        tipo: document.getElementById('cat-tipo').value
      };
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
    const sheets = r.sheets || [];
    const esAdmin = user.role === 'admin';

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
            <h3>Láminas (${sheets.length})</h3>
            <div id="laminas-lista">
              ${sheets.length === 0 ? `<p style="color:var(--gris-texto);font-size:13px;text-align:center;padding:1rem">Sin láminas todavía. ${esAdmin ? 'Sube la primera con el panel de la izquierda.' : ''}</p>` : ''}
              ${sheets.map((s, idx) => `
                <div class="lamina-fila" data-id="${s.id}">
                  <div class="lamina-numero">${idx + 1}</div>
                  <img src="${escape(s.imagen_path)}" class="lamina-mini" alt="" onerror="this.style.background='#f3f4f6';this.style.objectFit='contain'">
                  <div class="lamina-info">
                    <div class="lamina-titulo">${escape(s.titulo || 'Sin título')}</div>
                    <div class="lamina-notas">${escape(s.notas || s.tags || 'Sin notas')}</div>
                  </div>
                  ${esAdmin ? `
                  <div class="lamina-acciones">
                    <button onclick="editarLamina(${s.id})" title="Editar">✏️</button>
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
  const esAdmin = user.role === 'admin';

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
    const esAdmin = user.role === 'admin';

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
          <div class="cliente-fila${inactive}">
            <div class="cliente-fila-codigo">${escape(c.sage_code || '?')}</div>
            <div class="cliente-fila-info">
              <div class="cliente-fila-nombre">${escape(c.razon_social)} ${!c.is_active ? '<span class="cliente-baja-badge">BAJA</span>' : ''}</div>
              <div class="cliente-fila-detalles">
                ${c.cif ? `CIF: ${escape(c.cif)} · ` : ''}${c.municipio ? escape(c.municipio) + ' · ' : ''}${c.provincia ? escape(c.provincia) : ''}
                ${c.commercial_code ? ` · Com.${escape(c.commercial_code)}` : ''}
              </div>
            </div>
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

// ===== ARRANQUE =====
render();
