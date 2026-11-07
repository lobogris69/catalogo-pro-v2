// ============================================================================
// CatalogPRO · PANTALLAS DE INICIO (v338, 7-nov-2026; traídas de Catalenza v341)
// ----------------------------------------------------------------------------
// Cada papel entra a la pantalla que responde SU pregunta del día:
//  - Comercial → «Hoy» (vista 'hoy'): ¿a quién voy ahora? El cliente más urgente en grande
//    con «Empezar visita» a un toque, los siguientes de su ruta y su catálogo con portada.
//  - Admin → «Resumen» (vista 'dashboard'): ¿cómo va el mes? El panel de siempre sigue
//    entero en «Ver panel completo» (vista 'dashboard-completo').
// Sin cobertura NO se aterriza en «Hoy» (necesita /api/planning): el comercial entra a sus
// catálogos como siempre. Modo sencillo y solo visor no cambian (van por su propio camino).
// Datos: /api/planning, /api/clients/:id/last-visit-summary, /api/catalogs y /api/dashboard.
// También: iconos de línea (icono()) y la barra inferior del móvil (barraInferior()).
// ============================================================================

// Vocabulario: en Catalenza sale de los ajustes de empresa (empresa.js); aquí es fijo.
const empCli = () => 'cliente', empClis = () => 'clientes', empClisM = () => 'Clientes';

// Iconos de línea, una sola familia (24×24, trazo 1,7). Sustituyen a los emojis del menú.
const _ICONOS = {
  hoy: '<path d="M4 7h16M4 7v12a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2M8 2v4M16 2v4"/><path d="M9 14l2 2 4-4"/>',
  resumen: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  catalogo: '<path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2.5z"/><path d="M8 7h7M8 11h5"/>',
  tiendas: '<path d="M3 9l1.5-5h15L21 9M3 9h18M3 9v11h18V9M9 20v-6h6v6"/>',
  ruta: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  equipo: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ayuda: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6V14M12 17.5h.01"/>',
  buscar: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  pedidos: '<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6L5 3H2M9 20.5h.01M18 20.5h.01"/>',
  luna: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ojo: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  salir: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'
};
function icono(nombre) {
  return `<svg class="cz-ico" viewBox="0 0 24 24" aria-hidden="true">${_ICONOS[nombre] || ''}</svg>`;
}
// Para el menú agrupado de app.js: cada grupo / apartado lleva su icono de línea.
const _ICONO_VISTA = { dashboard: 'resumen', hoy: 'hoy', catalogos: 'catalogo', archivo: 'catalogo', productos: 'pedidos', plantillas: 'catalogo',
  clientes: 'tiendas', planning: 'hoy', mapa: 'ruta', 'pedidos-guardados': 'pedidos', comerciales: 'equipo', aula: 'ayuda',
  coordinacion: 'equipo', configuracion: 'ajustes', cuenta: 'equipo', manual: 'ayuda',
  catalogo: 'catalogo', ruta: 'tiendas', equipo: 'equipo', ajustes: 'ajustes', ayuda: 'ayuda' };
function iconoVista(v) { return icono(_ICONO_VISTA[v] || 'catalogo'); }

// Marca de la cabecera: monograma con el rosa de Lomhifar (--brand).
function marcaEmpresaHtml() { return '<span class="cz-marca" aria-hidden="true">L</span>'; }

const _fmtEuro = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const _fmtEuroCorto = n => (Number(n) || 0).toLocaleString('es-ES', { maximumFractionDigits: 0 }) + ' €';
function _hace(dias) {
  if (dias == null) return 'sin visitas aún';
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return 'hace ' + dias + ' días';
}
function _fechaLarga(d) {
  const t = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ===================== COMERCIAL · HOY =====================
async function renderHoy() {
  const $v = document.getElementById('vista-contenido');
  if (!$v) return;
  // Sin cobertura, «Hoy» no puede calcular la ruta: el comercial va a sus catálogos guardados.
  if (!navigator.onLine) { irA('catalogos'); return; }
  $v.innerHTML = `<div class="cz-pantalla"><div class="cz-titulo"><h1>${escape(_fechaLarga(new Date()))}</h1><p>Preparando tu ruta…</p></div>
    <div class="cz-rejilla"><div class="cz-tarjeta"><div class="cz-carga" style="width:60%"></div><div class="cz-carga" style="width:40%;margin-top:12px"></div></div>
    <div class="cz-tarjeta"><div class="cz-carga" style="width:70%"></div></div></div></div>`;

  let tiendas = [], total = 0, cats = [], sinRed = false;
  try {
    const [p, c] = await Promise.all([api('/api/planning?estado=todos&limit=200'), api('/api/catalogs')]);
    tiendas = p.clientes || []; total = p.total || tiendas.length; cats = (c.catalogs || []).filter(x => !x.especial);
  } catch (e) { sinRed = true; }

  // Orden de la ruta: primero las que pasan de su ciclo (más retraso primero), luego las
  // próximas y por último las al día y las nunca visitadas. Es el mismo criterio de colores
  // del planning: urgente > próxima > al día.
  const peso = { urgente: 0, proxima: 1, sin_historial: 2, al_dia: 3 };
  tiendas.sort((a, b) => (peso[a.estado] ?? 2) - (peso[b.estado] ?? 2) || (b.dias_retraso || 0) - (a.dias_retraso || 0) || (b.dias_desde_ultima || 0) - (a.dias_desde_ultima || 0));
  const pasan = tiendas.filter(t => t.estado === 'urgente' || (t.dias_retraso || 0) > 0);
  // Lomhifar: cada comercial tiene cientos de clientes nunca visitados (sin_historial); si
  // entraran en la ruta, «Hoy» llenaría la lista de empresas que no tocan. Primero los que
  // vencen por su ciclo (urgente / próxima); los nunca visitados solo si no hay ninguno.
  const vencen = tiendas.filter(t => t.estado === 'urgente' || t.estado === 'proxima' || (t.dias_retraso || 0) > 0);
  const todasTocan = vencen.length ? vencen : tiendas.filter(t => t.estado !== 'al_dia');
  const tocan = todasTocan.slice(0, 5);   // el número de arriba cuenta todas, no solo las 5 de la lista
  const sig = tocan[0] || tiendas[0] || null;
  const resto = tocan.slice(1, 5);

  let ultima = null;
  if (sig) { try { ultima = await api('/api/clients/' + sig.id + '/last-visit-summary'); } catch (e) { /* sin red */ } }
  const lineas = (ultima && ultima.annotations || []).filter(a => a.tipo === 'pedido').slice(0, 3)
    .map(a => String(a.texto_libre || '').replace(/^(\d+) uds · \S+ /, '$1 ')).join(', ');

  const sub = sinRed ? 'Sin conexión: abre tu catálogo o tus ' + empClis() + ' guardados'
    : (tocan.length ? `${todasTocan.length} ${todasTocan.length === 1 ? empCli() + ' te toca' : empClis() + ' te tocan'}` + (pasan.length ? ` · ${pasan.length} ${pasan.length === 1 ? 'pasa' : 'pasan'} de su ciclo` : '')
      : `Tienes al día a tus ${total} ${empClis()}`);

  const cat = cats[0] || null;
  let portada = '';
  if (cat) {
    try { const d = await api('/api/catalogs/' + cat.id); const s = (d.sheets || []).find(x => !x.oculta); portada = s ? (s.miniatura_path || s.imagen_path) : ''; } catch (e) { /* sin red */ }
  }

  $v.innerHTML = `
    <div class="cz-pantalla">
      <div class="cz-titulo"><h1>${escape(_fechaLarga(new Date()))}</h1><p>${escape(sub)}</p></div>
      <div class="cz-rejilla">
        <div class="cz-col">
          <section class="cz-tarjeta">
            ${sig ? `
              <h2>Siguiente visita <small>${escape([sig.municipio, sig.provincia].filter(Boolean).join(' · '))}</small></h2>
              <div class="cz-siguiente">
                <div class="q">
                  <div class="nombre">${escape(sig.razon_social || '')}</div>
                  <div class="det">${sig.dias_desde_ultima != null ? 'Última visita ' + escape(_hace(sig.dias_desde_ultima)) : 'Todavía no la has visitado'}${(sig.dias_retraso || 0) > 0 ? ' · <b style="color:var(--ui-mal)">' + sig.dias_retraso + ' días tarde</b>' : ''}</div>
                  ${lineas ? `<div class="pidio"><span>La última vez pidió:</span> ${escape(lineas)}</div>` : ''}
                </div>
                <button class="cz-btn" type="button" onclick="iniciarVisitaParaCliente(${Number(sig.id)})">${icono('pedidos')} Empezar visita</button>
              </div>` : `<h2>Tu ruta</h2><p class="cz-vacio">${sinRed ? 'Sin conexión no puedo calcular la ruta. Puedes abrir tu catálogo.' : 'No tienes ' + escape(empClis()) + ' asignados todavía.'}</p>`}
          </section>
          <section class="cz-tarjeta">
            <h2>Después <small>${resto.length ? 'por orden de urgencia' : ''}</small></h2>
            ${resto.length ? `<ul class="cz-lista">${resto.map(t => `
              <li>
                <span class="n">${escape(t.razon_social || '')}<small>${escape(t.municipio || '')}</small></span>
                <span class="d ${(t.dias_retraso || 0) > 0 ? 'tarde' : ''}">${(t.dias_retraso || 0) > 0 ? t.dias_retraso + ' días tarde' : escape(_hace(t.dias_desde_ultima))}</span>
                <button class="cz-btn-sec" type="button" onclick="iniciarVisitaParaCliente(${Number(t.id)})">Visitar</button>
              </li>`).join('')}</ul>`
              : `<p class="cz-vacio">Nada más pendiente: el resto de tus ${escape(empClis())} están al día.</p>`}
            <div class="cz-pie"><button class="cz-enlace" type="button" onclick="irA('planning')">Ver toda la ruta (${total})</button></div>
          </section>
        </div>
        <div class="cz-col">
          <section class="cz-tarjeta">
            <h2>Tu catálogo</h2>
            ${cat ? `<div class="cz-cat" role="button" tabindex="0" onclick="abrirCatalogo(${Number(cat.id)})" onkeydown="if(event.key==='Enter')abrirCatalogo(${Number(cat.id)})">
                ${portada ? `<img src="${escape(portada)}" alt="Portada de ${escape(cat.name)}">` : '<img alt="">'}
                <div><b>${escape(cat.name)}</b><span>${Number(cat.sheet_count) || 0} láminas</span><br><span class="cz-enlace">Abrir catálogo</span></div>
              </div>` : '<p class="cz-vacio">Todavía no tienes ningún catálogo asignado.</p>'}
            ${cats.length > 1 ? `<div class="cz-pie"><button class="cz-enlace" type="button" onclick="irA('catalogos')">Ver tus ${cats.length} catálogos</button></div>` : ''}
          </section>
          <section class="cz-tarjeta">
            <h2>Atajos</h2>
            <ul class="cz-lista">
              <li><span class="n">Mapa de ${escape(empClis())}<small>Para planificar la ruta</small></span><span class="d"></span><button class="cz-btn-sec" type="button" onclick="irA('mapa')">Abrir</button></li>
              <li><span class="n">Mis pedidos guardados<small>Los que hiciste sin cobertura</small></span><span class="d"></span><button class="cz-btn-sec" type="button" onclick="irA('pedidos-guardados')">Abrir</button></li>
            </ul>
          </section>
        </div>
      </div>
    </div>`;
}

// ===================== GERENTE · RESUMEN =====================
async function renderResumen() {
  const $v = document.getElementById('vista-contenido');
  if (!$v) return;
  const mes = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const Mes = mes.charAt(0).toUpperCase() + mes.slice(1);
  $v.innerHTML = `<div class="cz-pantalla"><div class="cz-titulo"><h1>${escape(Mes)}</h1><p>Calculando el mes…</p></div>
    <div class="cz-tira"><div><div class="cz-carga"></div></div><div><div class="cz-carga"></div></div><div><div class="cz-carga"></div></div><div><div class="cz-carga"></div></div></div></div>`;
  let d;
  try { d = (await api('/api/dashboard')).dashboard || {}; }
  catch (e) {
    $v.innerHTML = `<div class="cz-pantalla"><div class="cz-titulo"><h1>${escape(Mes)}</h1></div>
      <section class="cz-tarjeta" style="margin-top:20px"><p class="cz-vacio">No he podido cargar el resumen (${escape(e.message)}).</p>
      <button class="cz-enlace" type="button" onclick="renderResumen()">Reintentar</button></section></div>`;
    return;
  }
  const rm = d.resumen_mes || {};
  // Lomhifar: muchas visitas se registran sin pedido valorado (visita sin pedido, sin precios).
  // Si el mes no tiene importes, el resumen se mide en VISITAS en vez de enseñar «0 €» en grande.
  const conImportes = Number(rm.total_pvf) > 0;
  const medida = r => conImportes ? (Number(r.total_pvf) || 0) : (Number(r.visitas) || 0);
  const ranking = (d.ranking_comerciales || []).slice().sort((a, b) => medida(b) - medida(a));
  // Total y pedidos salen de las mismas filas que se pintan, para que cuadren a la vista.
  const totalMes = Number(rm.total_pvf) || 0;
  const visitas = Number(rm.total_visitas) || 0;
  const ticket = visitas ? totalMes / visitas : 0;
  const pasan = (d.sin_visitar || []).slice().sort((a, b) => (b.dias_sin_visitar || 0) - (a.dias_sin_visitar || 0));
  const maxCom = Math.max(1, ...ranking.map(medida));
  const conPedido = ranking.reduce((n, r) => n + (Number(r.con_pedido) || 0), 0);
  const top = (d.top_productos || []).slice().sort((a, b) => (Number(b.total_pvf) || 0) - (Number(a.total_pvf) || 0)).slice(0, 5);
  const maxTop = Math.max(1, ...top.map(p => Number(p.total_pvf) || 0));
  const semanas = (d.visitas_por_semana || []).slice(-8);
  const maxSem = Math.max(1, ...semanas.map(s => Number(s.visitas) || 0));

  const frase = visitas
    ? `${visitas} ${visitas === 1 ? 'visita' : 'visitas'}` + (conImportes ? ` y ${_fmtEuroCorto(totalMes)} en pedidos` : '') + (pasan.length ? ` · ${pasan.length} ${pasan.length === 1 ? empCli() + ' pasa' : empClis() + ' pasan'} de su ciclo` : '')
    : 'Este mes todavía no hay visitas' + (pasan.length ? ` · ${pasan.length} ${pasan.length === 1 ? empCli() + ' pasa' : empClis() + ' pasan'} de su ciclo` : '');

  $v.innerHTML = `
    <div class="cz-pantalla">
      <div class="cz-titulo"><h1>${escape(Mes)}</h1><p>${escape(frase)}</p></div>
      <div class="cz-tira">
        ${conImportes ? `
        <div><small>Pedidos del mes</small><b class="lider">${_fmtEuro(totalMes)}</b><em>a PVF, sin IVA</em></div>
        <div><small>Visitas</small><b>${visitas}</b><em>${Number(rm.comerciales_activos) || 0} ${Number(rm.comerciales_activos) === 1 ? 'comercial' : 'comerciales'} en la calle</em></div>
        <div><small>Media por visita</small><b>${_fmtEuro(ticket)}</b><em>${escape(_fmtEuro(totalMes)) + ' ÷ ' + visitas}</em></div>` : `
        <div><small>Visitas del mes</small><b class="lider">${visitas}</b><em>${Number(rm.comerciales_activos) || 0} ${Number(rm.comerciales_activos) === 1 ? 'comercial' : 'comerciales'} en la calle</em></div>
        <div><small>Con pedido</small><b>${conPedido}</b><em>de ${visitas} ${visitas === 1 ? 'visita' : 'visitas'}</em></div>
        <div><small>Importe</small><b>—</b><em>sin pedidos valorados este mes</em></div>`}
        <div><small>${escape(empClisM())} sin visitar</small><b>${pasan.length}</b><em>pasan de su ciclo</em></div>
      </div>
      <div class="cz-rejilla">
        <div class="cz-col">
          <section class="cz-tarjeta">
            <h2>Pasan de su ciclo <small>los que más llevan, primero</small></h2>
            ${pasan.length ? `<ul class="cz-lista">${pasan.slice(0, 6).map(c => `
              <li>
                <span class="n">${escape(c.razon_social || '')}<small>${escape(c.municipio || '')} · ciclo de ${Number(c.ciclo) || 30} días</small></span>
                <span class="d tarde">${Number(c.dias_sin_visitar) || 0} días</span>
                <button class="cz-btn-sec" type="button" onclick="abrirDetalleCliente(${Number(c.id)})">Ver ficha</button>
              </li>`).join('')}</ul>${pasan.length > 6 ? `<div class="cz-pie"><button class="cz-enlace" type="button" onclick="irA('planning')">Ver las ${pasan.length}</button></div>` : ''}`
              : `<p class="cz-vacio">Todas tus ${escape(empClis())} están dentro de su ciclo de visita.</p>`}
          </section>
          <section class="cz-tarjeta">
            <h2>Lo más pedido <small>este mes, a PVF</small></h2>
            ${top.length ? `<ul class="cz-barras finas">${top.map(p => `
              <li><div class="l"><span>${escape(p.nombre || p.codigo || '')}</span><span>${_fmtEuro(p.total_pvf)}</span></div>
              <div class="t"><i style="width:${Math.max(2, Math.round((Number(p.total_pvf) || 0) / maxTop * 100))}%"></i></div></li>`).join('')}</ul>`
              : '<p class="cz-vacio">Aún no hay pedidos este mes.</p>'}
          </section>
        </div>
        <div class="cz-col">
          <section class="cz-tarjeta">
            <h2>${conImportes ? 'Pedidos' : 'Visitas'} por comercial <small>este mes</small></h2>
            ${ranking.length ? `<ul class="cz-barras">${ranking.map(r => `
              <li><div class="l"><span>${escape(r.name || '')}</span><span>${conImportes ? _fmtEuro(r.total_pvf) : (Number(r.visitas) || 0) + ' visitas'}</span></div>
              <div class="t"><i style="width:${Math.max(2, Math.round(medida(r) / maxCom * 100))}%"></i></div></li>`).join('')}</ul>`
              : '<p class="cz-vacio">Ningún comercial ha cerrado visitas este mes.</p>'}
          </section>
          <section class="cz-tarjeta">
            <h2>Visitas por semana <small>últimas ${semanas.length}</small></h2>
            ${semanas.length ? `<div class="cz-semanas" role="img" aria-label="Visitas por semana: ${semanas.map(s => Number(s.visitas) || 0).join(', ')}">${semanas.map(s => {
              const v = Number(s.visitas) || 0; const f = new Date(s.semana_inicio);
              return `<div><span>${v}</span><i style="height:${Math.max(v ? 4 : 1, Math.round(v / maxSem * 80))}px"></i><span>${f.getDate()}/${f.getMonth() + 1}</span></div>`; }).join('')}</div>`
              : '<p class="cz-vacio">Sin datos de semanas.</p>'}
          </section>
          <div class="cz-pie"><button class="cz-enlace" type="button" onclick="irA('dashboard-completo')">Ver panel completo</button></div>
        </div>
      </div>
    </div>`;
}

// ===================== MÓVIL · BARRA INFERIOR =====================
// Sustituye a las dos filas de pestañas por debajo de 700 px. 4 destinos para el comercial y
// 5 para el gerente; «Más» no hace falta porque cada grupo abre su primer apartado y desde
// ahí siguen sus subpestañas en la propia pantalla (ver .navtabs-sub).
function barraInferior(esAdmin) {
  const its = esAdmin
    ? [['dashboard', 'resumen', 'Resumen'], ['catalogos', 'catalogo', 'Catálogo'], ['clientes', 'tiendas', empClisM()], ['comerciales', 'equipo', 'Equipo'], ['configuracion', 'ajustes', 'Ajustes']]
    : [['hoy', 'hoy', 'Hoy'], ['catalogos', 'catalogo', 'Catálogo'], ['clientes', 'tiendas', empClisM()], ['pedidos-guardados', 'pedidos', 'Pedidos']];
  const grupoDe = { dashboard: ['dashboard-completo'], catalogos: ['catalogos', 'archivo', 'productos', 'plantillas'], clientes: ['clientes', 'planning', 'mapa', 'pedidos-guardados'],
    comerciales: ['comerciales', 'aula', 'coordinacion'], configuracion: ['configuracion', 'cuenta', 'manual'] };
  const activo = v => appState.vista === v || (grupoDe[v] || []).includes(appState.vista) && !(esAdmin === false && v === 'clientes' && appState.vista === 'pedidos-guardados');
  return `<nav class="cz-barra-inf" aria-label="Menú">${its.map(([v, ic, t]) => `<button type="button" class="${activo(v) ? 'on' : ''}" onclick="irA('${v}')" aria-label="${escape(t)}">${icono(ic)}<span>${escape(t)}</span></button>`).join('')}</nav>`;
}
