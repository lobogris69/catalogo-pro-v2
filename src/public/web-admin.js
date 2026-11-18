// Panel de la web lomhifar.es. Usa la misma sesión de CatalogPRO (cpv2_token).
// Todo el texto se pinta con textContent: nada de lo que venga de la base de datos se interpreta como HTML.
(function () {
  'use strict';
  const token = localStorage.getItem('cpv2_token') || '';
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...hijos) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const h of hijos.flat()) if (h !== null && h !== undefined) e.append(h instanceof Node ? h : String(h));
    return e;
  };

  async function api(ruta, opciones = {}) {
    const headers = { Authorization: 'Bearer ' + token };
    let body = opciones.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch('/api/web-admin' + ruta, { method: opciones.method || 'GET', headers, body });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) { bloquear(); throw new Error(j.error || 'Sin permiso'); }
    if (!r.ok) throw new Error(j.error || 'No se ha podido hacer');
    return j;
  }

  let temporizador;
  function avisar(texto, mal) {
    const a = $('aviso'); a.textContent = texto; a.className = 'aviso' + (mal ? ' mal' : ''); a.hidden = false;
    clearTimeout(temporizador); temporizador = setTimeout(() => { a.hidden = true; }, mal ? 6000 : 2500);
  }
  const intenta = (fn, hecho) => async (...a) => { try { await fn(...a); if (hecho) avisar(hecho); } catch (e) { avisar(e.message, true); } };
  function bloquear() { document.querySelectorAll('[role=tabpanel], .pestanas').forEach((x) => { x.hidden = true; }); $('bloqueo').hidden = false; }

  // ---------- Pestañas ----------
  const tabs = ['marcas', 'novedades', 'articulos', 'contacto'];
  function abrir(n) {
    for (const t of tabs) { $('t-' + t).setAttribute('aria-selected', String(t === n)); $('p-' + t).hidden = t !== n; }
    if (n === 'marcas') cargarMarcas(); if (n === 'novedades') cargarNovedades(); if (n === 'articulos') cargarOcultos(); if (n === 'contacto') cargarContacto();
    try { localStorage.setItem('webadmin_tab', n); } catch (_) {}
  }
  tabs.forEach((t) => $('t-' + t).addEventListener('click', () => abrir(t)));

  async function subirFoto(fichero) {
    const fd = new FormData(); fd.append('foto', fichero);
    const j = await api('/foto', { method: 'POST', body: fd });
    return j.url;
  }
  function botonFoto(texto, alSubir) {
    const inp = el('input', { type: 'file', accept: 'image/*', class: 'oculto' });
    const b = el('button', { class: 'btn-sec', type: 'button', onclick: () => inp.click() }, texto);
    inp.addEventListener('change', intenta(async () => { if (!inp.files[0]) return; b.textContent = 'Subiendo…'; await alSubir(await subirFoto(inp.files[0])); }, 'Foto guardada'));
    return [b, inp];
  }

  // ---------- Marcas ----------
  let marcas = [];
  async function cargarMarcas() { marcas = (await api('/marcas')).marcas; pintarMarcas(); }
  function pintarMarcas() {
    const q = $('buscar-marca').value.trim().toLowerCase();
    const ul = $('lista-marcas'); ul.replaceChildren();
    for (const m of marcas.filter((x) => !q || x.nombre.toLowerCase().includes(q))) {
      const vivo = m.refs > 0;
      const sale = m.visible && vivo;
      const inter = el('button', { class: 'inter', role: 'switch', 'aria-checked': String(m.visible), 'aria-label': (m.visible ? 'Quitar ' : 'Poner ') + m.nombre + ' en la web',
        onclick: intenta(async () => { await api('/marcas/' + m.slug, { method: 'PUT', body: { visible: !m.visible } }); m.visible = !m.visible; pintarMarcas(); }, m.visible ? 'Quitada de la web' : 'Puesta en la web') });
      const estrella = el('button', { class: 'estrella', 'aria-pressed': String(m.destacada), title: 'Destacada en la portada', 'aria-label': 'Destacar ' + m.nombre + ' en la portada',
        onclick: intenta(async () => { await api('/marcas/' + m.slug, { method: 'PUT', body: { destacada: !m.destacada } }); m.destacada = !m.destacada; pintarMarcas(); }) }, '★');
      const estado = !vivo ? el('span', { class: 'estado mal' }, 'Sin artículos vivos en Sage: no sale')
        : sale ? el('span', { class: 'estado bien' }, 'Sale en la web') : el('span', { class: 'estado mal' }, 'Quitada');
      const desc = el('textarea', { rows: '2', maxlength: '400' }); desc.value = m.descripcion || '';
      const [bLogo, iLogo] = botonFoto(m.logo_url ? 'Cambiar logo' : 'Subir logo', async (url) => { await api('/marcas/' + m.slug, { method: 'PUT', body: { logo_url: url } }); m.logo_url = url; pintarMarcas(); });
      const [bFoto, iFoto] = botonFoto(m.foto_url ? 'Cambiar foto' : 'Subir foto de producto', async (url) => { await api('/marcas/' + m.slug, { method: 'PUT', body: { foto_url: url } }); m.foto_url = url; pintarMarcas(); });
      const editar = el('details', { class: 'editar' }, el('summary', {}, 'Cambiar texto, logo o foto'),
        el('label', {}, 'Qué vende, en una frase'), desc,
        el('div', { class: 'fila-btn' },
          el('button', { class: 'btn', type: 'button', onclick: intenta(async () => { await api('/marcas/' + m.slug, { method: 'PUT', body: { descripcion: desc.value } }); m.descripcion = desc.value; }, 'Texto guardado') }, 'Guardar texto'),
          bLogo, iLogo, bFoto, iFoto));
      ul.append(el('li', { class: sale ? '' : 'apagada' },
        inter,
        el('div', {}, el('div', { class: 'nom' }, m.nombre), el('div', { class: 'det' }, (m.refs || 0) + ' artículos vivos en Sage'), estado),
        el('div', { class: 'acciones' }, estrella),
        editar));
    }
  }
  $('buscar-marca').addEventListener('input', pintarMarcas);
  $('abrir-nueva').addEventListener('click', intenta(async () => {
    $('form-nueva').hidden = false;
    const sel = $('nm-prov');
    if (!sel.options.length) {
      const { proveedores } = await api('/proveedores');
      sel.append(el('option', { value: '' }, 'Elige el proveedor…'), ...proveedores.map((p) => el('option', { value: p.proveedor }, p.proveedor + ' (' + p.n + ')')));
    }
    $('nm-nombre').focus();
  }));
  $('cerrar-nueva').addEventListener('click', () => { $('form-nueva').hidden = true; });
  $('form-nueva').addEventListener('submit', intenta(async (ev) => {
    ev.preventDefault();
    await api('/marcas', { method: 'POST', body: { nombre: $('nm-nombre').value, proveedor: $('nm-prov').value, descripcion: $('nm-desc').value } });
    $('form-nueva').reset(); $('form-nueva').hidden = true; await cargarMarcas();
  }, 'Marca añadida'));

  // ---------- Novedades ----------
  async function cargarNovedades() {
    const [{ novedades }, { ajustes }] = await Promise.all([api('/novedades'), api('/ajustes')]);
    $('titulo-mes').value = ajustes.novedades_titulo || '';
    const ul = $('lista-nov'); ul.replaceChildren();
    novedades.forEach((n, i) => {
      const [bFoto, iFoto] = botonFoto(n.imagen_url ? 'Cambiar foto' : 'Poner foto', async (url) => { await api('/novedades/' + n.id, { method: 'PUT', body: { imagen_url: url } }); cargarNovedades(); });
      const mover = (d) => intenta(async () => {
        const otro = novedades[i + d]; if (!otro) return;
        await api('/novedades/' + n.id, { method: 'PUT', body: { orden: otro.orden } });
        await api('/novedades/' + otro.id, { method: 'PUT', body: { orden: n.orden } });
        cargarNovedades();
      });
      const avisoVivo = n.product_id && !n.vivo ? el('span', { class: 'estado mal' }, 'El artículo está de baja en Sage: no sale') : null;
      const sinFoto = !n.imagen_url ? el('span', { class: 'estado mal' }, 'Sin foto: no sale hasta que le pongas una') : null;
      const iTit = el('input', { maxlength: '160' }); iTit.value = n.titulo;
      const iMar = el('input', { maxlength: '120' }); iMar.value = n.marca || '';
      const editar = el('details', { class: 'editar' }, el('summary', {}, 'Cambiar el nombre o la marca'),
        el('label', {}, 'Nombre que se ve en la web'), iTit, el('label', {}, 'Marca'), iMar,
        el('div', { class: 'fila-btn' }, el('button', { class: 'btn', type: 'button', onclick: intenta(async () => { await api('/novedades/' + n.id, { method: 'PUT', body: { titulo: iTit.value, marca: iMar.value } }); cargarNovedades(); }, 'Guardado') }, 'Guardar')));
      ul.append(el('li', {},
        n.imagen_url ? el('img', { class: 'miniatura', src: n.imagen_url, alt: '' }) : el('div', { class: 'sin-foto' }, 'Sin foto'),
        el('div', {}, el('div', { class: 'nom' }, n.titulo), el('div', { class: 'det' }, n.marca), avisoVivo, sinFoto),
        el('div', { class: 'acciones' },
          el('button', { class: 'btn-sec', type: 'button', 'aria-label': 'Subir', disabled: i === 0, onclick: mover(-1) }, '▲'),
          el('button', { class: 'btn-sec', type: 'button', 'aria-label': 'Bajar', disabled: i === novedades.length - 1, onclick: mover(1) }, '▼'),
          bFoto, iFoto,
          el('button', { class: 'btn-sec btn-peligro', type: 'button', onclick: intenta(async () => { await api('/novedades/' + n.id, { method: 'DELETE' }); cargarNovedades(); }, 'Novedad quitada') }, 'Quitar')),
        editar));
    });
    if (!novedades.length) ul.append(el('li', {}, el('span', {}), el('div', { class: 'det' }, 'Todavía no hay novedades. Busca un artículo arriba para añadir la primera.')));
  }
  $('guardar-mes').addEventListener('click', intenta(() => api('/ajustes', { method: 'PUT', body: { novedades_titulo: $('titulo-mes').value } }), 'Título guardado'));

  function buscador(inputId, listaId, accion) {
    let t;
    $(inputId).addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(intenta(async () => {
        const q = $(inputId).value.trim();
        const ul = $(listaId); ul.replaceChildren();
        if (q.length < 2) return;
        const { articulos } = await api('/articulos?q=' + encodeURIComponent(q));
        if (!articulos.length) ul.append(el('li', {}, 'No encuentro ningún artículo vivo con eso.'));
        for (const a of articulos) ul.append(el('li', {}, el('div', {}, el('b', {}, a.nombre), el('div', { class: 'det' }, (a.proveedor || '') + (a.ean ? ' · ' + a.ean : ''))), accion(a)));
      }), 300);
    });
  }
  buscador('buscar-nov', 'res-nov', (a) => el('button', { class: 'btn', type: 'button', onclick: intenta(async () => {
    const marca = (marcas.find((m) => (a.proveedor || '').toUpperCase().includes(m.nombre.toUpperCase())) || {}).nombre || '';
    const titulo = a.nombre.charAt(0) + a.nombre.slice(1).toLowerCase();
    await api('/novedades', { method: 'POST', body: { product_id: a.id, titulo, marca } });
    $('buscar-nov').value = ''; $('res-nov').replaceChildren(); cargarNovedades();
  }, 'Añadida. Ahora ponle una foto y revisa el nombre.') }, 'Añadir'));

  // ---------- Artículos quitados ----------
  async function cargarOcultos() {
    const { ocultos } = await api('/ocultos');
    const ul = $('lista-ocultos'); ul.replaceChildren();
    for (const o of ocultos) ul.append(el('li', {}, el('span', {}),
      el('div', {}, el('div', { class: 'nom' }, o.nombre || ('Artículo ' + o.id)), el('div', { class: 'det' }, o.proveedor || '')),
      el('div', { class: 'acciones' }, el('button', { class: 'btn-sec', type: 'button', onclick: intenta(async () => { await api('/ocultos/' + o.id, { method: 'DELETE' }); cargarOcultos(); }, 'Vuelve a salir en la web') }, 'Volver a poner'))));
    if (!ocultos.length) ul.append(el('li', {}, el('span', {}), el('div', { class: 'det' }, 'No has quitado ningún artículo.')));
  }
  buscador('buscar-art', 'res-art', (a) => a.oculto ? el('span', { class: 'estado mal' }, 'Ya quitado')
    : el('button', { class: 'btn-sec btn-peligro', type: 'button', onclick: intenta(async () => { await api('/ocultos/' + a.id, { method: 'POST', body: {} }); $('buscar-art').dispatchEvent(new Event('input')); cargarOcultos(); }, 'Quitado de la web') }, 'Quitar de la web'));

  // ---------- Contacto ----------
  const CLAVES = ['telefono', 'whatsapp', 'correo', 'horario_dias', 'horario_abre', 'horario_cierra'];
  async function cargarContacto() { const { ajustes } = await api('/ajustes'); for (const k of CLAVES) $('a-' + k).value = ajustes[k] || ''; }
  $('form-contacto').addEventListener('submit', intenta(async (ev) => {
    ev.preventDefault();
    const b = {}; for (const k of CLAVES) b[k] = $('a-' + k).value; await api('/ajustes', { method: 'PUT', body: b });
  }, 'Datos guardados'));

  // ---------- Arranque ----------
  if (!token) { bloquear(); return; }
  api('/yo').then(() => {
    let t = 'marcas'; try { t = localStorage.getItem('webadmin_tab') || 'marcas'; } catch (_) {}
    abrir(tabs.includes(t) ? t : 'marcas');
  }).catch(() => {});
})();
