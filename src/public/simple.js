/* ============================================================================
   MODO SENCILLO  ·  CatalogPRO v2
   ----------------------------------------------------------------------------
   Para los comerciales que vienen del visor de fotos y el talonario de papel.

   Regla de oro: EN CADA PANTALLA SOLO SE PUEDE HACER UNA COSA.
   El camino es siempre el mismo y no tiene desvíos:

     EMPEZAR VISITA → elegir farmacia → catálogo a pantalla completa →
     tocar producto → teclado grande de unidades → TERMINAR → ENVIAR PEDIDO

   No hay menús, ni pestañas, ni campos de texto salvo el buscador de farmacia.
   Todo lo demás (planning, mapa, aula, cuenta…) queda oculto: sigue existiendo
   para quien trabaje en modo normal.

   Reutiliza el visor y la lógica de pedidos que ya funcionan: esto es una CAPA
   por encima, no una app aparte. Así un arreglo vale para los dos modos.
   ========================================================================== */

function esModoSimple() {
  // El usuario "efectivo": si el admin está viendo como un comercial, manda el flag
  // de ese comercial, no el suyo. Así se puede comprobar cómo le queda la app.
  const efectivo = (typeof impersonating !== 'undefined' && impersonating) ? impersonating : user;
  return !!(efectivo && efectivo.modo_simple && rolEfectivo() === 'sales');
}

// ===== 1. PANTALLA DE INICIO: un solo botón =====
function renderSimpleInicio() {
  const $v = document.getElementById('vista-contenido');
  if (!$v) return;
  const va = appState.visitaActiva;
  $v.innerHTML = `
    <div class="simple-pantalla">
      <div class="simple-saludo">Hola, ${escape((user.name || '').split(' ')[0] || '')}</div>
      ${va ? `
        <div class="simple-aviso-visita">
          Tienes una visita empezada en<br><b>${escape(va.cliente_nombre || 'un cliente')}</b>
        </div>
        <button class="simple-boton-gigante" onclick="simpleSeguirVisita()">
          <span class="simple-icono">🛒</span>
          SEGUIR CON LA VISITA
        </button>
        <button class="simple-boton-secundario" onclick="simpleDescartarVisita()">Descartar esta visita</button>
      ` : `
        <button class="simple-boton-gigante" onclick="simpleElegirFarmacia()">
          <span class="simple-icono">🏥</span>
          EMPEZAR VISITA
        </button>
      `}
      <button class="simple-boton-secundario" onclick="simpleMisPedidos()">📁 Mis pedidos enviados</button>
      <div class="simple-pie">
        <button class="simple-enlace" onclick="abrirIncidencia()">🛟 Necesito ayuda</button>
        <span>${APP_VERSION}</span>
      </div>
    </div>`;
}

// ===== 2. ELEGIR FARMACIA =====
async function simpleElegirFarmacia() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `
    <div class="simple-pantalla simple-lista-pantalla">
      <div class="simple-cabecera">
        <button class="simple-atras" onclick="renderSimpleInicio()">←</button>
        <span>¿A qué farmacia vas?</span>
      </div>
      <input type="search" id="simple-buscar" class="simple-buscador" placeholder="🔍 Escribe el nombre…" autocomplete="off">
      <div id="simple-lista" class="simple-lista"><div class="loading">Cargando…</div></div>
    </div>`;
  const $b = document.getElementById('simple-buscar');
  let todos = [];
  try {
    // Sus farmacias, todas. El servidor pagina de 200 en 200: seguimos pidiendo hasta
    // agotar (un comercial tiene cientos, no miles) y solo las de alta.
    for (let pag = 1; pag <= 10; pag++) {
      const r = await api('/api/clients?active=1&limit=200&page=' + pag);
      const lote = r.clientes || r.clients || [];
      todos = todos.concat(lote);
      if (lote.length < 200 || todos.length >= (r.total || 0)) break;
    }
  } catch (e) {
    document.getElementById('simple-lista').innerHTML = `<div class="error-msg">${escape(e.message)}</div>`;
    return;
  }
  const pintar = (lista) => {
    const $l = document.getElementById('simple-lista');
    if (!$l) return;
    if (!lista.length) {
      $l.innerHTML = `<div class="simple-vacio">No encuentro ninguna farmacia con ese nombre.<br>
        <button class="simple-boton-secundario" style="margin-top:14px" onclick="abrirAltaClienteNuevo()">➕ Es una farmacia nueva</button></div>`;
      return;
    }
    $l.innerHTML = lista.slice(0, 60).map(c => `
      <button class="simple-item" onclick="simpleEmpezarVisita(${c.id})">
        <span class="simple-item-nombre">${escape(c.razon_social || '')}</span>
        <span class="simple-item-sub">${escape(c.municipio || '')}</span>
      </button>`).join('') +
      `<button class="simple-boton-secundario" style="margin:16px auto;display:block" onclick="abrirAltaClienteNuevo()">➕ No está: es una farmacia nueva</button>`;
  };
  pintar(todos);
  $b.addEventListener('input', () => {
    const q = $b.value.trim().toLowerCase();
    pintar(!q ? todos : todos.filter(c =>
      (c.razon_social || '').toLowerCase().includes(q) || (c.municipio || '').toLowerCase().includes(q)));
  });
  setTimeout(() => $b.focus(), 100);
}

async function simpleEmpezarVisita(clientId) {
  const $l = document.getElementById('simple-lista');
  if ($l) $l.innerHTML = `<div class="loading">Abriendo la visita…</div>`;
  try {
    // Se abre la visita y se entra DIRECTO al catálogo: un paso menos.
    const cat = await simpleCatalogoDelComercial();
    if (!cat) { alert('No tienes ningún catálogo asignado. Avisa a Fernando.'); renderSimpleInicio(); return; }
    await api('/api/visits/start', { method: 'POST', body: { client_id: clientId, catalog_id: cat } });
    // Igual que el flujo normal: releemos la visita para tener el nombre del cliente.
    const cur = await api('/api/visits/current');
    appState.visitaActiva = cur.visit || null;
    simpleSeguirVisita();
  } catch (e) {
    alert(e.message);
    renderSimpleInicio();
  }
}

// El comercial no elige catálogo: se le abre el suyo. Si tuviera varios, el primero.
async function simpleCatalogoDelComercial() {
  try {
    const r = await api('/api/catalogs');
    const cs = (r.catalogs || []).filter(c => c.estado !== 'archivado');
    return cs.length ? cs[0].id : null;
  } catch (_) { return null; }
}

function simpleSeguirVisita() {
  if (!appState.visitaActiva) { renderSimpleInicio(); return; }
  appState.vista = 'catalogos';
  appState.clienteActual = null;
  appState.visitaVerId = null;
  appState.catalogoActual = appState.visitaActiva.catalog_id;
  appState.visorIndice = appState.visorIndice || 0;
  render();   // el visor de siempre; la barra de abajo la pone simpleBarraPedido()
  setTimeout(simpleBarraPedido, 300);
}

// ===== 3. BARRA FIJA CON EL PEDIDO =====
// Siempre visible mientras dura la visita: cuántos productos lleva y cómo terminar.
function simpleBarraPedido() {
  if (!esModoSimple() || !appState.visitaActiva) {
    document.getElementById('simple-barra')?.remove();
    return;
  }
  let n = 0;
  Object.keys(_anotacionesVisita || {}).forEach(sid => {
    (_anotacionesVisita[sid] || []).forEach(a => { if (a.tipo === 'pedido') n++; });
  });
  let b = document.getElementById('simple-barra');
  if (!b) {
    b = document.createElement('div');
    b.id = 'simple-barra';
    b.className = 'simple-barra';
    document.body.appendChild(b);
  }
  b.innerHTML = `
    <div class="simple-barra-cuenta">🛒 ${n} ${n === 1 ? 'producto' : 'productos'}</div>
    <button class="simple-barra-btn" onclick="simpleTerminar()">TERMINAR ▸</button>`;
}

// ===== 4. AÑADIR UN PRODUCTO: teclado grande y un solo botón =====
function simpleModalProducto(zona, sheetId, anotExistente) {
  const pvf = zona.producto_pvf != null ? Number(zona.producto_pvf) : null;
  const m = document.createElement('div');
  m.className = 'modal-bg simple-modal-bg';
  m.innerHTML = `
    <div class="simple-modal">
      <div class="simple-modal-cab">
        <div class="simple-modal-nombre">${escape(zona.producto_nombre || zona.etiqueta || 'Producto')}</div>
        ${zona.ref_modelo ? `<div class="simple-modal-ref">ref. ${escape(zona.ref_modelo)}</div>` : ''}
        ${pvf !== null && _verImportes() ? `<div class="simple-modal-precio">${pvf.toFixed(2)} €</div>` : ''}
      </div>
      <div class="simple-contador">
        <button class="simple-mas-menos" onclick="simpleCant(-1)">−</button>
        <div class="simple-cantidad" id="simple-cant">${anotExistente && anotExistente.cantidad ? anotExistente.cantidad : 1}</div>
        <button class="simple-mas-menos" onclick="simpleCant(1)">+</button>
      </div>
      <div class="simple-rapidos">
        ${[3, 6, 12, 24].map(x => `<button onclick="simpleCantFija(${x})">${x}</button>`).join('')}
      </div>
      <button class="simple-anadir" onclick="simpleGuardarProducto(${sheetId})">
        ${anotExistente ? '✔ CAMBIAR' : '✔ AÑADIR AL PEDIDO'}
      </button>
      ${anotExistente ? `<button class="simple-quitar" onclick="simpleQuitarProducto(${anotExistente.id})">🗑 Quitarlo del pedido</button>` : ''}
      <button class="simple-cancelar" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
    </div>`;
  document.body.appendChild(m);
  m._zona = zona;
  m._anot = anotExistente;
  hacerDialogoArrastrable(m.querySelector('.simple-modal'), m.querySelector('.simple-modal-cab'), true);
}

function simpleCant(d) {
  const $c = document.getElementById('simple-cant');
  if (!$c) return;
  $c.textContent = Math.max(1, (Number($c.textContent) || 1) + d);
}
function simpleCantFija(v) {
  const $c = document.getElementById('simple-cant');
  if ($c) $c.textContent = v;
}

async function simpleGuardarProducto(sheetId) {
  const m = document.querySelector('.simple-modal-bg');
  if (!m) return;
  const zona = m._zona, anot = m._anot;
  const cant = Number(document.getElementById('simple-cant').textContent) || 1;
  const cod = zona.producto_codigo || '';
  const nom = zona.producto_nombre || '';
  let texto = cant + ' uds · ' + cod + ' ' + nom;
  if (zona.ref_modelo) texto += ' ref. ' + zona.ref_modelo;
  try {
    if (anot) {
      await api('/api/annotations/' + anot.id, { method: 'PUT', body: { texto_libre: texto, tipo: 'pedido', cantidad: cant } });
    } else {
      await api('/api/visits/' + appState.visitaActiva.id + '/annotations', {
        method: 'POST',
        body: {
          sheet_id: sheetId, texto_libre: texto, tipo: 'pedido',
          product_id: zona.product_id, cantidad: cant, zone_id: zona.id,
          referencia: zona.ref_modelo || null,
          pos_x: (zona.x + zona.ancho / 2) / 100, pos_y: (zona.y + zona.alto / 2) / 100
        }
      });
    }
    m.remove();
    await refrescarAnotacionesVisor(sheetId);
    simpleBarraPedido();
    simpleAviso('✔ ' + cant + ' uds añadidas');
  } catch (e) { alert(e.message); }
}

async function simpleQuitarProducto(anotId) {
  try {
    await api('/api/annotations/' + anotId, { method: 'DELETE' });
    document.querySelector('.simple-modal-bg')?.remove();
    const sid = document.getElementById('visor-imagen-wrapper')?.dataset.sheetId;
    if (sid) await refrescarAnotacionesVisor(Number(sid));
    simpleBarraPedido();
    simpleAviso('🗑 Quitado del pedido');
  } catch (e) { alert(e.message); }
}

// Aviso grande y breve: confirma que la acción ha ido bien sin pedir nada a cambio.
function simpleAviso(txt) {
  const d = document.createElement('div');
  d.className = 'simple-aviso';
  d.textContent = txt;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1600);
}

// ===== 5. REPASAR Y ENVIAR =====
async function simpleTerminar() {
  const $v = document.getElementById('vista-contenido');
  document.getElementById('simple-barra')?.remove();
  $v.innerHTML = `<div class="simple-pantalla"><div class="loading">Preparando el pedido…</div></div>`;
  try {
    const r = await api('/api/visits/' + appState.visitaActiva.id);
    const anots = (r.anotaciones || r.annotations || []).filter(a => a.tipo === 'pedido');
    const filas = anots.map(a => `
      <div class="simple-repaso-linea">
        <div>
          <div class="simple-repaso-nombre">${escape(a.producto_nombre || a.texto_libre || '')}</div>
          <div class="simple-repaso-sub">${a.cantidad || 1} unidades${a.bonificacion ? ' · ' + escape(a.bonificacion) : ''}</div>
        </div>
        <button class="simple-repaso-quitar" onclick="simpleQuitarYRepasar(${a.id})">🗑</button>
      </div>`).join('');
    $v.innerHTML = `
      <div class="simple-pantalla simple-lista-pantalla">
        <div class="simple-cabecera">
          <button class="simple-atras" onclick="simpleSeguirVisita()">←</button>
          <span>Repasa el pedido</span>
        </div>
        <div class="simple-lista">
          ${filas || '<div class="simple-vacio">No has añadido ningún producto todavía.</div>'}
        </div>
        <div class="simple-abajo">
          <button class="simple-boton-gigante verde" onclick="simpleEnviar(this)">
            <span class="simple-icono">📨</span>
            ENVIAR PEDIDO
          </button>
          <button class="simple-boton-secundario" onclick="simpleSeguirVisita()">Volver al catálogo</button>
        </div>
      </div>`;
  } catch (e) {
    $v.innerHTML = `<div class="simple-pantalla"><div class="error-msg">${escape(e.message)}</div>
      <button class="simple-boton-secundario" onclick="simpleSeguirVisita()">Volver</button></div>`;
  }
}

async function simpleQuitarYRepasar(anotId) {
  try { await api('/api/annotations/' + anotId, { method: 'DELETE' }); } catch (_) {}
  simpleTerminar();
}

async function simpleEnviar(btn) {
  if (!confirm('¿Enviar el pedido a la oficina?')) return;
  btn.disabled = true;
  btn.innerHTML = 'Enviando…';
  try {
    await api('/api/visits/' + appState.visitaActiva.id + '/confirm', { method: 'POST', body: {} });
    appState.visitaActiva = null;
    _anotacionesVisita = {};
    document.getElementById('simple-barra')?.remove();
    const $v = document.getElementById('vista-contenido');
    $v.innerHTML = `
      <div class="simple-pantalla">
        <div class="simple-exito">✅</div>
        <div class="simple-exito-txt">Pedido enviado<br><span>Ya lo tienen en la oficina</span></div>
        <button class="simple-boton-gigante" onclick="renderSimpleInicio()">
          <span class="simple-icono">🏥</span>
          OTRA VISITA
        </button>
      </div>`;
  } catch (e) {
    alert('No se ha podido enviar: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<span class="simple-icono">📨</span> ENVIAR PEDIDO';
  }
}

async function simpleDescartarVisita() {
  if (!confirm('¿Descartar esta visita?\n\nSe pierde lo que hayas anotado y no se envía nada.')) return;
  try { await api('/api/visits/' + appState.visitaActiva.id + '/discard', { method: 'POST', body: {} }); } catch (_) {}
  appState.visitaActiva = null;
  _anotacionesVisita = {};
  document.getElementById('simple-barra')?.remove();
  renderSimpleInicio();
}

async function simpleMisPedidos() {
  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `
    <div class="simple-pantalla simple-lista-pantalla">
      <div class="simple-cabecera">
        <button class="simple-atras" onclick="renderSimpleInicio()">←</button>
        <span>Mis pedidos enviados</span>
      </div>
      <div id="simple-lista" class="simple-lista"><div class="loading">Cargando…</div></div>
    </div>`;
  try {
    const r = await api('/api/visits/mias?limit=30');
    const vs = (r.visitas || r.visits || []).filter(v => v.status === 'confirmed' || v.status === 'sent');
    document.getElementById('simple-lista').innerHTML = vs.length ? vs.map(v => `
      <div class="simple-item" style="cursor:default">
        <span class="simple-item-nombre">${escape(v.cliente_nombre || 'Cliente')}</span>
        <span class="simple-item-sub">${new Date(v.confirmed_at || v.created_at).toLocaleDateString('es-ES')} · ${v.num_lineas || 0} líneas</span>
      </div>`).join('') : '<div class="simple-vacio">Todavía no has enviado ningún pedido.</div>';
  } catch (e) {
    document.getElementById('simple-lista').innerHTML = `<div class="error-msg">${escape(e.message)}</div>`;
  }
}
