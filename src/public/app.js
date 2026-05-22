// ============================================================================
// CatalogPRO v2 - Frontend
// ============================================================================
const API = '';
let token = localStorage.getItem('cpv2_token');
let user = JSON.parse(localStorage.getItem('cpv2_user') || 'null');
let appState = {
  vista: 'login',
  catalogoActual: null
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
  $app.innerHTML = `
    <div class="app-shell">
      <div class="topbar">
        <div>
          <div class="topbar-titulo">CatalogPRO v2</div>
          <div class="topbar-usuario">${escape(user.name)} · ${user.role}</div>
        </div>
        <button class="topbar-logout" onclick="logout()">Salir</button>
      </div>
      <div id="vista-contenido"></div>
    </div>
  `;
  if (appState.catalogoActual) {
    renderEditorCatalogo(appState.catalogoActual);
  } else {
    renderListaCatalogos();
  }
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
            <h3>Subir lámina</h3>
            <div class="upload-zona" id="upload-zona" onclick="document.getElementById('upload-input').click()">
              <div class="upload-zona-icono">📄</div>
              <div class="upload-zona-texto">Pulsa para elegir archivo</div>
              <div class="upload-zona-sub">JPG · PNG · PDF (1 página)</div>
            </div>
            <input type="file" id="upload-input" accept="image/*,application/pdf" style="display:none">
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

// ===== ARRANQUE =====
render();
