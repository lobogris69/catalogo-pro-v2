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

// Lo que se esta anotando ahora mismo. Vive fuera del modal a proposito: el cuadro se
// puede cerrar o solaparse con otro y el guardado no debe depender de encontrarlo.
let _simpleZona = null, _simpleAnot = null, _simpleSheet = null;

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
      <div class="simple-saludo">Hola, ${escape((nombreEfectivo() || '').split(' ')[0] || '')}</div>
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
    if (!navigator.onLine) {
      // Sin cobertura: las farmacias que estén descargadas en la tablet.
      todos = (await CpDB.listarClientes('')).filter(c => !/^\s*-?\s*(baja|anulad)/i.test(c.razon_social || ''));
    } else {
      // Sus farmacias, todas. El servidor pagina de 200 en 200: seguimos pidiendo hasta
      // agotar (un comercial tiene cientos, no miles) y solo las de alta.
      for (let pag = 1; pag <= 10; pag++) {
        const r = await api('/api/clients?active=1&limit=200&page=' + pag);
        const lote = r.clientes || r.clients || [];
        todos = todos.concat(lote);
        if (lote.length < 200 || todos.length >= (r.total || 0)) break;
      }
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
      <button class="simple-item" onclick="simpleElegirCatalogo(${c.id})">
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

// ===== 2b. ELEGIR CATÁLOGO =====
// Un comercial puede llevar varios: el suyo, uno común, el de promociones de regalos…
// Si solo tiene uno, no se le pregunta: entra directo. Si tiene varios, botones
// grandes con el nombre y cuántas láminas trae.
async function simpleElegirCatalogo(clientId) {
  const $l = document.getElementById('simple-lista');
  if ($l) $l.innerHTML = `<div class="loading">Un momento…</div>`;
  const cats = await simpleCatalogosDelComercial();
  if (!cats.length) {
    simpleAviso('No tienes ningún catálogo. Avisa a Fernando.');
    renderSimpleInicio();
    return;
  }
  if (cats.length === 1) return simpleEmpezarVisita(clientId, cats[0].id);

  const $v = document.getElementById('vista-contenido');
  $v.innerHTML = `
    <div class="simple-pantalla simple-lista-pantalla">
      <div class="simple-cabecera">
        <button class="simple-atras" onclick="simpleElegirFarmacia()">←</button>
        <span>¿Qué catálogo le enseñas?</span>
      </div>
      <div class="simple-lista">
        ${cats.map(c => `
          <button class="simple-item simple-item-catalogo" onclick="simpleEmpezarVisita(${clientId}, ${c.id})">
            <span class="simple-item-nombre">📚 ${escape(c.name || '')}</span>
            <span class="simple-item-sub">${c.sheet_count || 0} láminas${c.tipo === 'express' ? ' · ofertas' : ''}</span>
          </button>`).join('')}
      </div>
      <div class="simple-vacio" style="font-size:15px">Luego puedes cambiar de catálogo sin perder el pedido.</div>
    </div>`;
}

async function simpleEmpezarVisita(clientId, catalogId) {
  const $l = document.getElementById('simple-lista');
  if ($l) $l.innerHTML = `<div class="loading">Abriendo la visita…</div>`;
  try {
    const cat = catalogId || await simpleCatalogoDelComercial();
    if (!cat) { alert('No tienes ningún catálogo asignado. Avisa a Fernando.'); renderSimpleInicio(); return; }
    let visita;
    try {
      visita = await vIniciarVisita(clientId, cat, false);
    } catch (e) {
      // El servidor avisa de que hay otra visita a medias. Que decida él, en cristiano.
      if (/sin terminar/i.test(e.message || '')) {
        if (!confirm(e.message + '.\n\nSi sigues, esa visita se queda como está y empiezas una nueva.\n\n¿Empiezo la nueva?')) {
          renderSimpleInicio();
          return;
        }
        visita = await vIniciarVisita(clientId, cat, true);
      } else throw e;
    }
    appState.visitaActiva = visita;
    if (!navigator.onLine) simpleAviso('📴 Sin cobertura: se guarda en la tablet');
    simpleSeguirVisita();
  } catch (e) {
    alert(e.message);
    renderSimpleInicio();
  }
}

// Los catálogos que lleva, sin archivar y con láminas dentro (uno vacío solo estorba).
async function simpleCatalogosDelComercial() {
  try {
    if (!navigator.onLine) {
      // Sin cobertura solo valen los descargados: son los únicos que puede enseñar.
      const descargados = await CpDB.listarCatalogosDescargados();
      return (descargados || []).map(c => ({ ...c, sheet_count: c.sheet_count || c.num_laminas || 0 }));
    }
    const r = await api('/api/catalogs');
    return (r.catalogs || []).filter(c => c.estado !== 'archivado' && (c.sheet_count || 0) > 0);
  } catch (_) { return []; }
}

async function simpleCatalogoDelComercial() {
  const cs = await simpleCatalogosDelComercial();
  return cs.length ? cs[0].id : null;
}

// CAMBIAR DE CATÁLOGO EN MITAD DE LA VISITA. El pedido es UNO solo: enseña el general,
// luego el de promociones, y todo lo anotado se junta en el mismo pedido.
async function simpleCambiarCatalogo() {
  const cats = await simpleCatalogosDelComercial();
  if (cats.length <= 1) { simpleAviso('Solo tienes un catálogo'); return; }
  const m = document.createElement('div');
  m.className = 'modal-bg simple-modal-bg';
  m.innerHTML = `
    <div class="simple-modal">
      <div class="simple-modal-cab"><div class="simple-modal-nombre">¿Qué catálogo le enseñas ahora?</div></div>
      ${cats.map(c => `
        <button class="simple-item simple-item-catalogo${Number(c.id) === Number(appState.catalogoActual) ? ' simple-item-activo' : ''}"
                onclick="simpleAbrirCatalogo(${c.id})">
          <span class="simple-item-nombre">📚 ${escape(c.name || '')}</span>
          <span class="simple-item-sub">${c.sheet_count || 0} láminas${Number(c.id) === Number(appState.catalogoActual) ? ' · lo estás viendo' : ''}</span>
        </button>`).join('')}
      <button class="simple-cancelar" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
    </div>`;
  document.body.appendChild(m);
}

function simpleAbrirCatalogo(catalogId) {
  document.querySelectorAll('.modal-bg').forEach(x => x.remove());
  appState.vista = 'catalogos';
  appState.catalogoActual = catalogId;
  appState.visorIndice = 0;   // el catálogo nuevo empieza por su primera lámina
  render();
  setTimeout(simpleBarraPedido, 400);
}

function simpleSeguirVisita() {
  if (!appState.visitaActiva) { renderSimpleInicio(); return; }
  appState.vista = 'catalogos';
  appState.clienteActual = null;
  appState.visitaVerId = null;
  // Si ya estaba viendo otro catálogo (los cambió a media visita), se respeta.
  appState.catalogoActual = appState.catalogoActual || appState.visitaActiva.catalog_id;
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
  // La MISMA cuenta que el carrito del modo normal: si los dos números bailasen,
  // el comercial no sabría cuál creerse.
  const n = (typeof carritoContarLineas === 'function') ? carritoContarLineas() : 0;
  let b = document.getElementById('simple-barra');
  if (!b) {
    b = document.createElement('div');
    b.id = 'simple-barra';
    b.className = 'simple-barra';
    document.body.appendChild(b);
  }
  b.innerHTML = `
    <button class="simple-barra-cat" onclick="simpleCambiarCatalogo()" title="Ver otro catálogo sin perder el pedido">📚</button>
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
  // Además en variables: si por lo que sea hay otro cuadro abierto (el de cambiar de
  // catálogo, por ejemplo), buscar el modal por clase cogía el equivocado y al guardar
  // reventaba sin decir por qué.
  _simpleZona = zona;
  _simpleAnot = anotExistente;
  _simpleSheet = sheetId;
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
  const zona = _simpleZona, anot = _simpleAnot;
  if (!zona) return;
  const m = document.querySelector('.simple-modal-bg');
  const cant = Number((document.getElementById('simple-cant') || {}).textContent) || 1;
  const cod = zona.producto_codigo || '';
  const nom = zona.producto_nombre || '';
  let texto = cant + ' uds · ' + cod + ' ' + nom;
  if (zona.ref_modelo) texto += ' ref. ' + zona.ref_modelo;
  try {
    if (anot) {
      await vEditarAnotacion(anot.id, { texto_libre: texto, tipo: 'pedido', cantidad: cant });
    } else {
      await vAnotar({
          sheet_id: sheetId, texto_libre: texto, tipo: 'pedido',
          product_id: zona.product_id, cantidad: cant, zone_id: zona.id,
          referencia: zona.ref_modelo || null,
          pos_x: (zona.x + zona.ancho / 2) / 100, pos_y: (zona.y + zona.alto / 2) / 100
      });
    }
    if (m) m.remove();
    _simpleZona = null; _simpleAnot = null;
    await refrescarAnotacionesVisor(sheetId);
    simpleBarraPedido();
    simpleAviso('✔ ' + cant + ' uds añadidas');
  } catch (e) { alert(e.message); }
}

async function simpleQuitarProducto(anotId) {
  try {
    await vBorrarAnotacion(anotId);
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
    const r = visitaEsLocal()
      ? { annotations: await CpDB.listarAnotacionesDeVisitaOffline(appState.visitaActiva.local_id) }
      : await api('/api/visits/' + appState.visitaActiva.id);
    const anots = (r.anotaciones || r.annotations || []).filter(a => a.tipo === 'pedido');
    const filas = anots.map(a => `
      <div class="simple-repaso-linea">
        <div>
          <div class="simple-repaso-nombre">${escape(a.producto_nombre || a.texto_libre || '')}</div>
          <div class="simple-repaso-sub">${a.cantidad || 1} unidades${a.bonificacion ? ' · ' + escape(a.bonificacion) : ''}</div>
        </div>
        <button class="simple-repaso-quitar" onclick="simpleQuitarYRepasar(${a.id})">🗑</button>
      </div>`).join('');
    // SIN PEDIDO: el cliente no ha comprado nada esta vez. La visita se cierra igual y
    // queda contada: has ido, le has enseñado el catálogo. Lo que no se manda es un
    // pedido vacío a la oficina ni al cliente.
    const vacio = anots.length === 0;
    $v.innerHTML = `
      <div class="simple-pantalla simple-lista-pantalla">
        <div class="simple-cabecera">
          <button class="simple-atras" onclick="simpleSeguirVisita()">←</button>
          <span>${vacio ? 'Terminar la visita' : 'Repasa el pedido'}</span>
        </div>
        <div class="simple-lista">
          ${filas || `<div class="simple-vacio">Esta vez no te ha comprado nada.<br><br>
            Puedes <b>cerrar la visita igual</b>: queda apuntada como visita hecha sin pedido.</div>`}
        </div>
        <div class="simple-abajo">
          ${vacio ? `
            <button class="simple-boton-gigante" style="background:linear-gradient(135deg,#475569,#334155);box-shadow:0 12px 28px -10px rgba(51,65,85,.7)" onclick="simpleEnviar(this)">
              <span class="simple-icono">✔</span>
              CERRAR SIN PEDIDO
            </button>` : `
            <button class="simple-boton-gigante verde" onclick="simpleEnviar(this)">
              <span class="simple-icono">📨</span>
              ENVIAR PEDIDO
            </button>`}
          <button class="simple-boton-secundario" onclick="simpleSeguirVisita()">Volver al catálogo</button>
        </div>
      </div>`;
  } catch (e) {
    $v.innerHTML = `<div class="simple-pantalla"><div class="error-msg">${escape(e.message)}</div>
      <button class="simple-boton-secundario" onclick="simpleSeguirVisita()">Volver</button></div>`;
  }
}

async function simpleQuitarYRepasar(anotId) {
  try { await vBorrarAnotacion(anotId); } catch (_) {}
  simpleTerminar();
}

async function simpleEnviar(btn) {
  // Sin líneas se cierra la visita igual (queda contada como visita sin pedido), pero
  // el mensaje tiene que decir la verdad: aquí no se envía nada a nadie.
  const sinPedido = (typeof carritoContarLineas === 'function') ? carritoContarLineas() === 0 : false;
  if (!confirm(sinPedido
    ? '¿Cerrar la visita sin pedido?\n\nQueda apuntada como visita hecha. No se envía nada a la oficina.'
    : '¿Enviar el pedido a la oficina?')) return;
  btn.disabled = true;
  btn.innerHTML = sinPedido ? 'Cerrando…' : 'Enviando…';
  try {
    const res = await vConfirmarVisita({});
    const sinLinea = !!(res && res.offline);
    appState.visitaActiva = null;
    _anotacionesVisita = {};
    document.getElementById('simple-barra')?.remove();
    const $v = document.getElementById('vista-contenido');
    $v.innerHTML = `
      <div class="simple-pantalla">
        <div class="simple-exito">${sinLinea ? '📴' : (sinPedido ? '✔' : '✅')}</div>
        <div class="simple-exito-txt">${sinLinea
          ? 'Pedido guardado<br><span>Sin cobertura. Se envía solo en cuanto tengas línea: no tienes que hacer nada.</span>'
          : (sinPedido
            ? 'Visita cerrada<br><span>Queda apuntada aunque esta vez no te haya comprado nada.</span>'
            : 'Pedido enviado<br><span>Ya lo tienen en la oficina</span>')}</div>
        <button class="simple-boton-gigante" onclick="renderSimpleInicio()">
          <span class="simple-icono">🏥</span>
          OTRA VISITA
        </button>
      </div>`;
  } catch (e) {
    alert('No se ha podido enviar: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = sinPedido
      ? '<span class="simple-icono">✔</span> CERRAR SIN PEDIDO'
      : '<span class="simple-icono">📨</span> ENVIAR PEDIDO';
  }
}

async function simpleDescartarVisita() {
  if (!confirm('¿Descartar esta visita?\n\nSe pierde lo que hayas anotado y no se envía nada.')) return;
  try { await vDescartarVisita(); } catch (_) {}
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
