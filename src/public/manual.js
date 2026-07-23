/* ============================================================================
   MANUAL DE INSTRUCCIONES  ·  CatalogPRO v2
   ----------------------------------------------------------------------------
   Va en su PROPIO archivo (app.js ya pasa de 15.000 lineas) y es contenido
   estatico: no llama a la API, asi que funciona igual sin cobertura.

   Dos manuales:
     - MANUAL_ADMIN     : todos los procesos, para Fernando / administracion.
     - MANUAL_COMERCIAL : lo justo para el dia a dia del comercial, en corto.

   Cada apartado: { id, icono, titulo, para (para que sirve), pasos[], ojo[] }
   `pasos` y `ojo` admiten <b> y <code>; el resto se escapa.
   ========================================================================== */

const MANUAL_ADMIN = [
  {
    id: 'como-funciona',
    icono: '🧭',
    titulo: 'Cómo está organizado todo (empieza por aquí)',
    para: 'Entender las cuatro piezas del sistema. Si tienes claro esto, el resto del manual se lee solo.',
    pasos: [
      '<b>Catálogo</b> = un libro (ej. "Catálogo general 2026"). Contiene láminas ordenadas.',
      '<b>Lámina</b> = una página del catálogo: la imagen que ve el cliente.',
      '<b>Zona</b> = un rectángulo invisible que dibujas encima de un producto de la lámina. Es lo que hace que el comercial pueda <b>pulsar ese producto y anotarlo en el pedido</b>. Sin zonas, la lámina es solo una foto.',
      '<b>Cuadro de precio</b> = otro rectángulo, pero encima de un <b>precio impreso</b>. Sirve para taparlo y reescribirlo con el precio de hoy, sin rehacer la lámina.',
      'Los productos vienen de <b>Sage</b> (los importas o se sincronizan). Cada zona apunta a un producto de Sage… salvo los casos especiales que verás en "Tipos de zona".'
    ],
    ojo: [
      'Cambiar una lámina <b>no</b> cambia lo que ya vieron los comerciales hasta que <b>cierras versión</b>.',
      'La imagen original de la lámina <b>nunca</b> se modifica: los precios y las tablas se pegan encima al generar la vista.'
    ]
  },
  {
    id: 'crear-catalogo',
    icono: '📚',
    titulo: 'Crear un catálogo y subir láminas',
    para: 'Montar un catálogo nuevo o añadir páginas a uno que ya existe.',
    pasos: [
      'Ve a <b>📚 Catálogos</b> → <b>+ Nuevo catálogo</b>. Ponle nombre y guárdalo.',
      'Entra en el catálogo. Verás la lista de láminas a la izquierda.',
      'Para subir: <b>➕</b> sube una lámina suelta; también puedes <b>arrastrar varias imágenes a la vez</b>; y con un <b>PDF</b> se trocea en una lámina por página.',
      'Cada lámina admite <b>título</b> (lo que se busca), <b>categorías</b> y <b>etiquetas automáticas</b> que genera la IA al subirla.',
      'Con <b>📄➕ Hoja al principio</b> insertas una portada delante de todo.'
    ],
    ojo: [
      'Sube las imágenes lo más grandes que tengas: la app genera sola las miniaturas y las versiones ligeras.',
      'Si sustituyes la imagen de una lámina, la anterior se borra del disco: no ocupa el doble.'
    ]
  },
  {
    id: 'ordenar',
    icono: '🔲',
    titulo: 'Ordenar el catálogo (mosaico)',
    para: 'Cambiar el orden de las páginas viendo todas a la vez.',
    pasos: [
      'Dentro del catálogo pulsa <b>🔲 Mosaico</b>.',
      'Arrastra una lámina hasta el hueco donde la quieras. La <b>línea de inserción</b> te marca dónde va a caer.',
      'Para mover <b>varias de golpe</b>: pulsa las que quieras (o la primera y, con <b>Mayúsculas</b>, la última) y arrastra el bloque completo.'
    ],
    ojo: ['El orden es el que verán los comerciales en cuanto cierres versión.']
  },
  {
    id: 'zonas',
    icono: '🎯',
    titulo: 'Zonas de productos: que el comercial pueda pedir',
    para: 'Marcar qué producto es cada cosa de la lámina. Es el paso que más se repite.',
    pasos: [
      'En la lista de láminas pulsa el <b>🎯</b> de la lámina → se abre el editor de zonas.',
      '<b>🤖 Detectar productos con IA</b>: la IA lee la lámina, propone recuadros y busca el código en Sage. Repasa lo que propone y corrige.',
      'A mano: <b>arrastra</b> sobre la lámina para dibujar un rectángulo y, en el panel de la derecha, escribe el nombre o el código y <b>elige el producto de la lista</b>.',
      'Las zonas se <b>mueven</b> arrastrándolas y se <b>estiran</b> por las esquinas.',
      'Cuando la lámina esté repasada, pulsa <b>☐ Marcar revisada</b>: así sabes en la rejilla cuáles están hechas de verdad.',
      '<b>⏭️ Siguiente sin precios</b> te lleva directo a la próxima lámina pendiente, sin volver a la lista.'
    ],
    ojo: [
      'Un expositor grande que es <b>un solo producto</b> no necesita 20 zonas: usa <b>🗑️ Borrar todas</b> y deja una sola.',
      'La IA acierta mucho pero no siempre: el código que propone hay que mirarlo.'
    ]
  },
  {
    id: 'tipos-zona',
    icono: '🧩',
    titulo: 'Tipos de zona (los casos raros que te vas a encontrar)',
    para: 'No todos los productos son "un código de Sage y ya". Estos son los cinco casos y cuál usar.',
    pasos: [
      '<b>Producto suelto</b> — lo normal: la zona apunta a un código de Sage.',
      '<b>👓 Familia</b> — un mismo modelo con variantes (gafas: color × graduación). Escribes el modelo, eliges qué códigos entran, y el comercial elige color y graduación al anotar.',
      '<b>🤝 Comisión</b> — laboratorios que no facturamos (Lainco). No están en Sage: se anota nombre, unidades, descuento, almacén y nº de socio.',
      '<b>🕶️ Referencias sueltas</b> — expositor del que se piden unidades sueltas que no están en Sage (gafas): el comercial teclea la referencia y las unidades.',
      '<b>🔖 Ref. del modelo</b> — expositor donde <b>todos los artículos comparten un único código en Sage</b> porque valen lo mismo, pero cada modelo lleva su número impreso (pendientes Mimiló: 1094, 1443…). Pon el producto en la zona y escribe el número en "Ref. del modelo". La línea del pedido saldrá como <code>3 uds · 1243441 PENDIENTE MIMILÓ ref. 1094</code>, y así la oficina sabe cuál servir.',
      '<b>🔗 Enlace</b> — la zona no es un producto: salta a otro catálogo (del general al específico de un laboratorio) y vuelve.'
    ],
    ojo: [
      'Familia, comisión y enlace son <b>excluyentes</b> entre sí. "Referencias sueltas" y "Ref. del modelo" conviven con el producto.',
      'En el caso "Ref. del modelo", el botón <b>📌 Poner este producto en TODAS las zonas de la lámina</b> te ahorra repetir la misma búsqueda 16 veces; luego solo pones el número en cada una.'
    ]
  },
  {
    id: 'precios',
    icono: '💶',
    titulo: 'Precios dinámicos: tapar el precio impreso y reescribirlo',
    para: 'Que una lámina de hace un año siga saliendo con el precio de hoy sin rehacerla.',
    pasos: [
      'En el editor de zonas: <b>🏷️ Detectar precios (IA)</b> localiza los precios impresos y crea los cuadros que los tapan.',
      'Si la IA se deja alguno: <b>✏️ Dibujar cuadro de precio</b> y lo dibujas tú encima del precio.',
      'El precio que se pinta sale del producto de la zona. Si un precio va a cambiar en una fecha, prográmalo en <b>Precio programado</b> y se aplicará solo ese día.',
      'El tipo de letra y el tamaño de los precios reescritos se ajustan en <b>⚙️ Configuración → 🔤 Tipografía de precios</b>.',
      'Si una lámina es demasiado enrevesada para tocarla, márcala como <b>excluida de precios</b>: se verá y se exportará tal cual.'
    ],
    ojo: [
      '<b>🗑️ Borrar precios</b> borra los cuadros de esa lámina, no los productos.',
      'Comprueba siempre el resultado con <b>👁️ Ver montada</b> antes de cerrar versión.'
    ]
  },
  {
    id: 'tablas',
    icono: '📊',
    titulo: 'Tablas de expositor (de tu Excel a la lámina)',
    para: 'Sustituir el bloque de precios viejo de un expositor por una tabla nueva hecha desde tu Excel.',
    pasos: [
      '<b>⚙️ Configuración → 📊 Tablas de expositor</b> → sube el Excel (puedes subir <b>varios a la vez</b>).',
      'Si el libro tiene <b>varias hojas</b>, se crea <b>una tabla por hoja</b>, con un nombre lógico sacado de la hoja o del producto: así puedes asociar cada una a una lámina distinta.',
      'La tabla <b>refleja tu Excel tal cual</b>: mismas columnas, mismos totales, sin añadir ni calcular nada. Solo cambia el aspecto.',
      'Para colocarla: abre el <b>🎯 editor de zonas</b> de la lámina → <b>➕ Añadir tabla</b> → elige la tabla (la ves en vista previa antes de decidir).',
      'Ahora arrástrala sobre el bloque de precios viejo. <b>El ancho separa las columnas; el alto marca el tamaño de la letra.</b> Lo que ves en el editor es exactamente lo que se pega.',
      'El botón <b>👁</b> de la caja la pone semitransparente para comprobar qué está tapando.',
      '¿Hacen falta <b>varias tablas</b> en la misma lámina? Con <b>📊 Ajustar tablas</b> activado, arrastra sobre un hueco vacío y elige otra.',
      'Si actualizas el Excel, entra en la tabla y pulsa <b>Actualizar</b> subiendo el archivo nuevo: se mantiene la asociación con las láminas.'
    ],
    ojo: [
      'El fondo de la tabla se toma del color de la lámina, así que tapa el bloque viejo sin dejar un recuadro blanco.',
      'Puedes seleccionar varias tablas de la biblioteca y <b>borrarlas de golpe</b>; si te equivocas, sale el aviso de <b>deshacer</b>.'
    ]
  },
  {
    id: 'reparto',
    icono: '🔀',
    titulo: 'Que cada comercial reciba sus láminas (reparto automático)',
    para: 'Que una lámina nueva llegue sola al catálogo de quien la vende, sin ir uno por uno, y poder hacer excepciones.',
    pasos: [
      'Cada comercial tiene su catálogo <b>📗 Express</b>, que cuelga del maestro: mismas láminas, pero con <b>su orden</b> y sin las que no lleva. Al crearlo viene ya con el maestro entero ordenado; solo quitas lo que sobre.',
      '<b>La regla:</b> en el catálogo maestro pulsa <b>🔀 Reparto automático</b> y define "si la lámina es de <i>Lainco</i> → va al catálogo de <i>Eva</i>". Se define una vez.',
      'A partir de ahí, cuando subas una lámina y le pongas esa <b>categoría</b>, se añade sola al catálogo de ese comercial, <b>en su posición correcta</b> (detrás de la misma lámina que la precede en el maestro).',
      'Con <b>⏩ Aplicar a las que ya hay</b> la regla se aplica también a las láminas antiguas de esa categoría.',
      '<b>La excepción:</b> en una lámina concreta, <b>🔀 ¿A qué comerciales va esta lámina?</b> te deja forzar <b>✅ Sí, siempre</b> o <b>🚫 No, nunca</b> para un comercial. Manda sobre la regla, y puedes anotar el motivo.',
      'La <b>bandeja de láminas sin repartir</b> (en la misma pantalla de reparto) te avisa de las que no han llegado a nadie: casi siempre es que les falta la categoría.'
    ],
    ojo: [
      'El reparto se dispara al <b>guardar las categorías</b> de la lámina, que es cuando se sabe de qué laboratorio es.',
      'Si una lámina ya está en el catálogo de alguien, el reparto <b>no le cambia la posición</b>: respeta el orden que hayas puesto.',
      'Quitar una regla no saca las láminas ya repartidas; para eso usa la excepción <b>🚫 No, nunca</b>.'
    ]
  },
  {
    id: 'zonas',
    icono: '📍',
    titulo: 'Zonas de venta: lo que no se puede vender en un territorio',
    para: 'Que un comercial no ofrezca en una zona algo que ahí no se puede vender, aunque sí pueda venderlo en otra.',
    pasos: [
      'Las zonas son <b>Álava, Gipuzkoa, Vizcaya, Navarra y Aragón</b>. En el catálogo maestro: <b>📍 Zonas de venta</b>.',
      'En cada zona, <b>🚫 Qué no se vende aquí</b>: eliges el <b>laboratorio</b> y, si quieres, el motivo. Se declara <b>una sola vez</b> y vale para todos los comerciales, ahora y en el futuro.',
      'Los laboratorios <b>salen solos</b>: la app sabe de quién es cada lámina por el proveedor que trae Sage en sus productos. No hay que etiquetar nada a mano.',
      'Excepción: en las zonas de <b>comisión</b> (Lainco, Sawes) hay que escribir el <b>laboratorio</b> en su casilla, porque ahí el nombre que se guarda es el del producto, no el del laboratorio. Sin eso, esa zona no se puede vetar por territorio.',
      'Durante la visita, la app mira <b>dónde está la farmacia</b> y oculta esas láminas. En Navarra las ve; en Aragón, no. El comercial no tiene que acordarse de nada.',
      'La zona de cada farmacia sale, por este orden: la que le hayas fijado a mano, su <b>código postal</b>, o su provincia. Si no se sabe, el comercial la elige <b>una vez</b> durante la visita y queda guardada.',
      'Con <b>🧭 Deducir zona de los clientes que faltan</b> se rellenan de golpe los que ya tengan código postal o provincia.'
    ],
    ojo: [
      'Esto va por <b>zona</b>, no por comercial: es lo que permite que el mismo comercial lleve dos territorios con reglas distintas.',
      '<b>El respaldo en PDF también va por zona.</b> Al descargar, elige la zona: si el comercial lleva dos, dale <b>un PDF por zona</b>. El papel no filtra solo, así que un PDF con todo sería justo el agujero por el que puede ofrecer donde no debe.',
      'Si no se sabe la zona de una farmacia, se enseña el catálogo <b>entero</b> y sale un aviso: se prefiere no dejar al comercial sin catálogo, pero conviene decir la zona cuanto antes.',
      '<b>Láminas mixtas:</b> si una lámina lleva productos de varios laboratorios y solo uno está vetado, la lámina <b>NO se oculta</b>. Se enseña, y ese producto sale rayado en rojo con un <b>🚫 aquí no</b>: si lo pulsa, se le avisa y no lo puede anotar. Solo se ocultan enteras las láminas que son <b>todas</b> del laboratorio vetado.',
      'Es distinto del <b>🔀 reparto</b>: el reparto decide <b>quién</b> lleva cada laboratorio; la zona decide <b>dónde</b> se puede vender.'
    ]
  },
  {
    id: 'informe',
    icono: '📋',
    titulo: 'Informe de precios: saber qué falta antes de publicar',
    para: 'Repasar de un vistazo qué láminas están sin terminar.',
    pasos: [
      'Dentro del catálogo pulsa <b>📋 Informe precios</b>.',
      'Te separa las láminas <b>pendientes</b> (tienen zonas pero no precios), las <b>anómalas</b> (algo no cuadra), las de <b>comisión</b>, las <b>excluidas</b> y las que llevan <b>tabla</b>.',
      'Desde ahí saltas directo a la lámina que quieras arreglar.'
    ],
    ojo: ['Es el repaso recomendado justo antes de cerrar versión.']
  },
  {
    id: 'control-cambios',
    icono: '🕒',
    titulo: 'Control de lo que vas modificando (parte semanal)',
    para: 'Saber qué láminas has tocado y cuáles hay que volver a repasar. Pensado para el repaso del viernes.',
    pasos: [
      'En la lista de láminas, cada una lleva un tercer distintivo con <b>cuándo se tocó por última vez</b> ("🕒 hace 3 días").',
      'Si se modificó <b>después</b> de que la dieras por revisada, el distintivo se pone en ámbar: <b>🔄 Cambiada tras revisarla</b>. Eso significa que tu revisión ya no vale y conviene mirarla otra vez.',
      'Pulsa el distintivo y verás el <b>historial</b> de esa lámina: qué se cambió (imagen, título, zonas, precios o tabla), cuándo y quién.',
      'Con <b>🔄 Cambiadas esta semana</b> dejas en la lista solo lo tocado en los últimos 7 días; con <b>⚠️ Pendientes de repasar</b>, solo las que cambiaron tras revisarlas. Se comportan como interruptores: vuelve a pulsar para quitarlos.',
      '<b>🗓️ Parte de cambios</b> abre el resumen del periodo (7, 15 o 30 días) con una línea por lámina y qué se tocó en cada una. Se puede imprimir.'
    ],
    ojo: [
      'El registro guarda cambios de <b>imagen, datos, zonas, cuadros de precio y tablas</b>. Lo anterior a la v137 no aparece porque entonces solo se anotaban la imagen y los datos.',
      'Si trabajas un rato seguido en la misma lámina no salen 40 líneas: los cambios del mismo tipo se agrupan en una con su contador.'
    ]
  },
  {
    id: 'version',
    icono: '📌',
    titulo: 'Cerrar versión y avisar a los comerciales',
    para: 'Publicar los cambios. Hasta que no cierras versión, los comerciales siguen viendo lo anterior.',
    pasos: [
      'Cuando el catálogo esté repasado, pulsa <b>📌 Cerrar versión</b> y escribe qué has cambiado.',
      'Los comerciales con el catálogo asignado reciben un <b>aviso por email</b> (si tienen las notificaciones activadas).',
      'En <b>📚 Historial</b> queda registrado qué cambió en cada versión y quién lo hizo.'
    ],
    ojo: ['Cierra versión de una tacada cuando termines el bloque de cambios, no lámina a lámina.']
  },
  {
    id: 'asignar',
    icono: '👥',
    titulo: 'Asignar catálogos a comerciales',
    para: 'Que cada comercial vea solo lo suyo.',
    pasos: [
      'Dentro del catálogo: <b>👥 Asignar a comerciales</b> y marca quiénes lo llevan.',
      'Las altas y bajas de usuarios se hacen en <b>👥 Comerciales</b> (crear usuario, editar, cambiar contraseña).',
      'Con <b>👁 Ver como…</b> (arriba a la derecha) te metes en la piel de un comercial para comprobar exactamente lo que ve.'
    ],
    ojo: ['Mientras estás en "Ver como", no puedes tocar la administración: es a propósito.']
  },
  {
    id: 'coordinacion',
    icono: '🔄',
    titulo: 'Coordinación con administración (circuito cerrado)',
    para: 'Que administración sepa siempre qué has cambiado y qué altas necesitas, y que tú te enteres en cuanto asignan un código. Sin llamadas ni correos sueltos.',
    pasos: [
      'Dales de alta en <b>👥 Comerciales</b> con el rol <b>Oficina / administración (solo consulta)</b>. Con eso ven los catálogos en su tablet o PC —solo para consultar, no hacen visitas ni pedidos— y su pantalla <b>🔄 Coordinación</b>.',
      'Cada vez que <b>cierras versión</b> de un catálogo les llega un aviso con lo que cambia y <b>lo que hace falta de su parte</b>: las altas que esperas y las láminas que tienen que reflejar en Sage. Si cierras varias versiones seguidas, se agrupa en un solo aviso.',
      'Ellos entran en <b>🔄 Coordinación</b> y ahí: escriben el <b>código que han asignado</b> a cada alta y marcan las láminas como <b>✅ Ya está en Sage</b>.',
      'En cuanto escriben el código, si el producto ya está sincronizado se <b>enlaza solo</b> en todas tus láminas y pedidos. Si aún no ha llegado de Sage, queda guardado y se enlaza en cuanto llegue. <b>Tú no tecleas códigos.</b>',
      'A ti te llega el aviso <b>por Telegram</b> (el mismo bot de las incidencias) y lo ves en tu propia pantalla de Coordinación.',
      '<b>Lo que se atasca se recuerda solo:</b> si algo lleva más de los días que marques (7 por defecto) sin código o sin reflejar en Sage, les sale un email de recordatorio. Como mucho uno al día, y solo si de verdad hay algo parado. Puedes cambiar los días o forzar el envío desde 🔄 Coordinación.'
    ],
    ojo: [
      'Las altas que llevan <b>más de 7 días</b> sin código salen marcadas en rojo, para que se vea lo que se está atascando.',
      'Queda registrado quién respondió y cuándo, y si abrieron el aviso o no. Se acabó el "eso ya te lo dije".'
    ]
  },
  {
    id: 'productos',
    icono: '📦',
    titulo: 'Productos: Sage, expositores y promociones',
    para: 'De dónde salen los códigos y los precios.',
    pasos: [
      '<b>📦 Productos → 📊 Importar Excel Sage</b> para una carga manual.',
      'La <b>sincronización automática</b> con Sage se configura en <b>⚙️ Configuración → 🔄 Sincronización con Sage</b> (la lanza el ordenador de la oficina; ahí ves el historial y si algo falló).',
      'Los <b>expositores y promociones</b> que no existen en Sage se crean a mano con <b>+ Nuevo (expositor/promo)</b>.',
      'Puedes filtrar por tipo (Sage / expositores) y por estado (activos / descatalogados).'
    ],
    ojo: ['Si un producto sale sin precio en la lámina, casi siempre es que en Sage no tiene tarifa: mira la ficha del producto antes de tocar la lámina.']
  },
  {
    id: 'pendientes-alta',
    icono: '⏳',
    titulo: 'Producto que aún no existe en Sage (pendiente de alta)',
    para: 'Montar la lámina de un producto nuevo antes de que administración le dé el alta, sin quedarte a medias ni duplicar códigos después.',
    pasos: [
      'En el editor de zonas, al asignar producto, pulsa <b>⏳ ¿No existe todavía? Producto pendiente de alta</b>.',
      'Pon el <b>nombre</b> y lo que sepas: <b>PVL, PVP, coste y oferta</b> (y el código nacional <b>si lo tienes</b>). Son justo los datos que administración necesita para darlo de alta.',
      'Se crea un producto <b>provisional</b> con código temporal (PEND-3) y queda asignado a la zona. La lámina ya funciona: el comercial puede pedirlo y el precio se pinta con el PVL que has puesto.',
      'En <b>📦 Productos → ⏳ Pendientes de alta</b> ves todo lo que estás esperando, con las láminas donde se usa. Desde ahí, <b>✉️ Enviar la lista a administración</b> les manda la tabla por email.',
      'Cuando lo den de alta y llegue por la sincronización de Sage: si pusiste el código nacional, te aparece <b>✅ Ya está de alta: enlazar</b>. Si no lo pusiste, <b>🔗 Enlazar con…</b> y lo buscas por nombre o código.',
      'Al enlazar, el código real sustituye al provisional <b>en todas las láminas y en los pedidos ya anotados</b>, y el provisional desaparece.'
    ],
    ojo: [
      'En la lista de láminas verás <b>⏳ N sin dar de alta</b>: es el aviso de que esa lámina va con productos provisionales.',
      'No uses <b>+ Nuevo (expositor/promo)</b> para esto: ese tipo es para cosas que <b>nunca</b> estarán en Sage (expositores, promos). Si lo usas para un producto que sí van a dar de alta, acabarás con dos productos para lo mismo.'
    ]
  },
  {
    id: 'clientes',
    icono: '🏥',
    titulo: 'Clientes, planning y mapa',
    para: 'La agenda comercial.',
    pasos: [
      '<b>🏥 Clientes</b>: ficha, histórico de visitas, pedidos y productos más pedidos.',
      '<b>🗓️ Planning</b>: qué visitas tocan y cuándo; la configuración de frecuencias está en Configuración.',
      '<b>🗺️ Mapa</b>: los clientes situados geográficamente. Si alguno no aparece, usa <b>🌍 Geocodificar pendientes</b> en Configuración.'
    ],
    ojo: ['Clientes y planning funcionan también sin cobertura; el mapa no.']
  },
  {
    id: 'ofertas',
    icono: '🎯',
    titulo: 'Ofertas y campañas',
    para: 'Marcar promociones que se pintan sobre las láminas.',
    pasos: [
      '<b>⚙️ Configuración → 🎯 Ofertas y campañas → + Nueva oferta</b>.',
      'Defines el producto o la familia, el tipo de oferta y las fechas.',
      'Durante la campaña, la lámina muestra el distintivo de oferta.'
    ],
    ojo: ['Si una oferta cae dentro del hueco de una tabla de expositor, no se pinta: manda la tabla.']
  },
  {
    id: 'plantillas',
    icono: '🏷️',
    titulo: 'Plantillas de anotación',
    para: 'Frases hechas para que el comercial no escriba siempre lo mismo.',
    pasos: [
      'En <b>🏷️ Plantillas</b> creas los textos habituales.',
      'El comercial los tiene a un toque al anotar; las que más usa le salen primero.'
    ],
    ojo: []
  },
  {
    id: 'aula',
    icono: '🎓',
    titulo: 'Aula: formación de los comerciales',
    para: 'Publicar documentación de producto y que quede constancia de quién la ha visto.',
    pasos: [
      'En <b>🎓 Aula</b> creas la formación y subes el material.',
      'Los comerciales reciben aviso de las nuevas.'
    ],
    ojo: []
  },
  {
    id: 'incidencias',
    icono: '🛟',
    titulo: 'Incidencias de los comerciales',
    para: 'Enterarte de los fallos sin que te llamen por teléfono.',
    pasos: [
      'El comercial pulsa el botón <b>🛟</b> desde cualquier pantalla, escribe y adjunta una captura.',
      'A ti te llega <b>aviso al móvil por Telegram</b> y te aparece el número de avisos sin cerrar en ese mismo botón.',
      'Ábrelo para leer, ver la captura y <b>responder</b>: al responder se marca como resuelta y el comercial ve tu respuesta.'
    ],
    ojo: [
      'Cada aviso guarda la <b>versión de la app</b> y la <b>pantalla</b> desde la que se envió: la mitad de las incidencias se explican porque el comercial tenía una versión vieja.',
      'La captura no viaja por Telegram; se ve en la bandeja de la app.'
    ]
  },
  {
    id: 'backup',
    icono: '☁️',
    titulo: 'Backup en MEGA y resumen a la oficina',
    para: 'Tener el catálogo respaldado fuera y mantener informada a la oficina.',
    pasos: [
      'Dentro del catálogo: <b>☁️ Backup MEGA</b> y eliges a qué carpetas subir.',
      'Las carpetas se gestionan en <b>⚙️ Configuración → ☁️ Carpetas MEGA</b>.',
      'Al terminar, se puede enviar el enlace por email al comercial correspondiente.',
      'Para la oficina: <b>⚙️ Configuración → 📊 Resumen a oficina</b> → previsualizas y envías el resumen de cambios a los destinatarios que tengas dados de alta.'
    ],
    ojo: ['El backup tarda: se hace en segundo plano y puedes seguir trabajando.']
  },
  {
    id: 'emails',
    icono: '📧',
    titulo: 'Emails: modo pruebas y modo producción',
    para: 'No mandarle correos de prueba a un cliente real.',
    pasos: [
      '<b>⚙️ Configuración → Configuración de emails</b>.',
      '<b>🔴 MODO PRUEBAS</b>: todos los correos se desvían a las direcciones de prueba. Úsalo mientras trasteas.',
      '<b>🟢 MODO PRODUCCIÓN</b>: los correos van a los destinatarios reales.',
      'Con <b>📨 Enviar email de prueba</b> compruebas que el envío funciona antes de nada.'
    ],
    ojo: ['Antes de una campaña, mira SIEMPRE en qué modo estás.']
  },
  {
    id: 'sesion',
    icono: '🔐',
    titulo: 'Cada cuánto se pide la contraseña',
    para: 'Decidir cuánto dura la sesión antes de que la app vuelva a pedir la contraseña.',
    pasos: [
      '<b>⚙️ Configuración → 🔐 Duración de la sesión</b>.',
      'Elige el tiempo: desde <b>8 horas</b> (una jornada) hasta <b>30 días</b>. Lo normal para trabajar cómodo son <b>7 días</b>.',
      'Guarda. El cambio se aplica en los <b>próximos inicios de sesión</b>: quien ya está dentro conserva la caducidad que tenía hasta que vuelva a entrar.'
    ],
    ojo: [
      'Cuanto más largo, más cómodo para los comerciales; cuanto más corto, más protegido si se pierde un móvil.',
      'Si un comercial pierde el teléfono, cámbiale la contraseña en <b>👥 Comerciales</b>: eso corta el acceso sin esperar a que caduque.'
    ]
  },
  {
    id: 'mantenimiento',
    icono: '🩺',
    titulo: 'Si algo va mal (mantenimiento)',
    para: 'Los cuatro problemas que más se repiten y cómo salir de ellos.',
    pasos: [
      '<b>"He cambiado algo y no lo veo"</b> → mira la <b>versión</b> abajo del todo. Si no es la última, recarga con <b>Ctrl+F5</b>. Los comerciales, cerrando y abriendo la app.',
      '<b>"Un comercial dice que no le funciona"</b> → pídele que te lo mande por el botón <b>🛟</b>: te llega su versión y su pantalla.',
      '<b>"El precio sale mal"</b> → mira la ficha del producto en <b>📦 Productos</b> antes que la lámina; casi siempre es la tarifa de Sage.',
      '<b>"La app va rara justo después de subir muchas cosas"</b> → espera un minuto y recarga: el servidor puede haberse reiniciado.'
    ],
    ojo: ['La app funciona sin cobertura para lo del comercial (catálogos descargados, clientes, planning y pedidos); la administración necesita conexión.']
  }
];

const MANUAL_COMERCIAL = [
  {
    id: 'c-empezar',
    icono: '🚀',
    titulo: 'Empezar el día',
    para: 'Dos minutos antes de salir a la calle.',
    pasos: [
      'Abre la app y entra con tu email y tu contraseña.',
      'Si sale un aviso de <b>actualización</b>, acéptalo: tendrás los precios del día.',
      'Entra en <b>📚 Catálogos</b> y pulsa <b>descargar</b> en los que vayas a enseñar. Así funcionan aunque te quedes sin cobertura en la farmacia.'
    ],
    ojo: ['Descarga los catálogos con wifi, no con datos: son muchas imágenes.']
  },
  {
    id: 'c-visita',
    icono: '🏥',
    titulo: 'Hacer una visita',
    para: 'El día a día.',
    pasos: [
      'Ve a <b>🏥 Clientes</b>, busca la farmacia y pulsa <b>empezar visita</b>.',
      'Abre el catálogo y ve pasando láminas como si fuera el papel.',
      'Cuando el cliente pida algo, <b>pulsa el producto en la lámina</b>: se abre una ventanita con el precio.',
      'Pon las <b>unidades</b> y guarda. Ya está anotado.',
      'Si el producto tiene <b>variantes</b> (color, graduación), elígelas ahí mismo.',
      'Si ves <b>ref. 1094</b> en azul, es el número de ese modelo concreto: se manda solo, no tienes que apuntarlo.'
    ],
    ojo: ['Puedes añadir una nota a cualquier línea (por ejemplo "urgente" o "para el jueves").']
  },
  {
    id: 'c-expositores',
    icono: '🕶️',
    titulo: 'Expositores',
    para: 'Cuando el cliente pide unidades sueltas, no el expositor entero.',
    pasos: [
      'Pulsa el expositor: te sale la lista de líneas.',
      'Escribe la <b>referencia</b> y las <b>unidades</b>, y añade. Repite por cada una.',
      'Si quiere el <b>expositor completo</b>, tienes el botón para pedirlo de una vez.'
    ],
    ojo: []
  },
  {
    id: 'c-cerrar',
    icono: '✅',
    titulo: 'Cerrar la visita y enviar el pedido',
    para: 'Que llegue a la oficina bien.',
    pasos: [
      'Antes de cerrar, abre el <b>carrito</b> y repasa las líneas: puedes cambiar cantidades o borrar.',
      'Pulsa <b>Cerrar visita</b>. El pedido se envía a la oficina por email.',
      'Si la visita no ha ido a ningún lado, usa <b>Descartar</b> y no se manda nada.'
    ],
    ojo: [
      'Si estás sin cobertura, el pedido se guarda en el móvil y se envía solo cuando vuelvas a tener línea.',
      'En <b>📁 Mis pedidos</b> tienes lo que aún no ha salido.'
    ]
  },
  {
    id: 'c-problemas',
    icono: '🛟',
    titulo: 'Si algo no va o se te ocurre una mejora',
    para: 'No pierdas tiempo peleándote con la app.',
    pasos: [
      'Pulsa el botón <b>🛟</b> (está en todas las pantallas).',
      'Elige si es una <b>incidencia</b>, una <b>sugerencia</b> o una <b>duda</b>, escribe lo que pasa y, si puedes, <b>adjunta una captura</b>.',
      'Envía. Te responderemos ahí mismo: lo verás en "Ver mis avisos anteriores".'
    ],
    ojo: ['La captura ayuda muchísimo: con ella se arregla en minutos lo que por teléfono cuesta media hora.']
  },
  {
    id: 'c-trucos',
    icono: '💡',
    titulo: 'Cuatro trucos',
    para: 'Para ir más rápido.',
    pasos: [
      'La <b>lupa 🔍</b> (o Ctrl+K) busca en todo: productos, láminas y clientes.',
      'Sobre la lámina puedes hacer <b>zoom</b> con dos dedos o con la rueda del ratón.',
      'El botón <b>🌙 / ☀️</b> cambia a modo oscuro, que se ve mejor de noche.',
      'Abajo del todo tienes la <b>versión</b>: si llamas para reportar algo, dila.'
    ],
    ojo: []
  }
];

let _manualCual = 'admin';   // 'admin' | 'comercial'

function _manEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// El contenido lleva <b>/<code> a propósito: se dejan pasar y se escapa el resto.
function _manRico(s) {
  return _manEsc(s)
    .replace(/&lt;(\/?)(b|code)&gt;/g, '<$1$2>');
}

function _manualApartados() {
  return _manualCual === 'admin' ? MANUAL_ADMIN : MANUAL_COMERCIAL;
}

function renderManual() {
  const $v = document.getElementById('vista-contenido');
  if (!$v) return;
  const esAdmin = typeof rolEfectivo === 'function' ? rolEfectivo() === 'admin' : false;
  if (!esAdmin) _manualCual = 'comercial';
  const aps = _manualApartados();
  $v.innerHTML = `
    <div class="contenedor manual-wrap">
      <div class="manual-cabecera">
        <div>
          <h2 style="margin:0">${_manualCual === 'admin' ? '📖 Manual de instrucciones' : '❓ Ayuda rápida'}</h2>
          <p style="margin:4px 0 0;color:var(--gris-texto);font-size:13px">
            ${_manualCual === 'admin'
              ? 'Todos los procesos, paso a paso. Escrito para leerlo dentro de seis meses sin acordarte de nada.'
              : 'Lo que necesitas para el día a día. Cinco minutos de lectura.'}
          </p>
        </div>
        <div class="manual-acciones">
          ${esAdmin ? `
            <button class="btn ${_manualCual === 'admin' ? 'btn-primary' : 'btn-secondary'}" onclick="cambiarManual('admin')">📖 Manual completo</button>
            <button class="btn ${_manualCual === 'comercial' ? 'btn-primary' : 'btn-secondary'}" onclick="cambiarManual('comercial')">🧑‍💼 Guía del comercial</button>
          ` : ''}
          <button class="btn btn-secondary" onclick="window.print()" title="Imprimir o guardar en PDF">🖨️ Imprimir</button>
        </div>
      </div>

      <input type="search" id="manual-buscar" class="manual-buscador" placeholder="🔍 Busca por palabra: tabla, precio, zona, pedido, MEGA…" autocomplete="off">

      <div class="manual-cuerpo">
        <nav class="manual-indice" id="manual-indice">
          ${aps.map(a => `<a href="#man-${a.id}" onclick="irAApartadoManual(event,'${a.id}')">${a.icono} ${_manEsc(a.titulo)}</a>`).join('')}
        </nav>
        <div class="manual-contenido" id="manual-contenido">
          ${aps.map(a => `
            <section class="manual-apartado" id="man-${a.id}" data-buscar="${_manEsc((a.titulo + ' ' + a.para + ' ' + a.pasos.join(' ') + ' ' + (a.ojo || []).join(' ')).toLowerCase().replace(/<[^>]+>/g, ''))}">
              <h3>${a.icono} ${_manEsc(a.titulo)}</h3>
              <p class="manual-para"><b>Para qué sirve:</b> ${_manEsc(a.para)}</p>
              <ol class="manual-pasos">
                ${a.pasos.map(p => `<li>${_manRico(p)}</li>`).join('')}
              </ol>
              ${(a.ojo && a.ojo.length) ? `
                <div class="manual-ojo">
                  <b>⚠️ Ojo</b>
                  <ul>${a.ojo.map(o => `<li>${_manRico(o)}</li>`).join('')}</ul>
                </div>` : ''}
            </section>
          `).join('')}
          <div id="manual-sin-resultados" class="manual-vacio" style="display:none">
            No hay ningún apartado con esa palabra. Prueba con otra (por ejemplo: <b>tabla</b>, <b>precio</b>, <b>zona</b>, <b>pedido</b>).
          </div>
        </div>
      </div>
    </div>`;

  const $b = document.getElementById('manual-buscar');
  if ($b) $b.addEventListener('input', filtrarManual);
}

function cambiarManual(cual) {
  _manualCual = cual;
  renderManual();
}

function irAApartadoManual(ev, id) {
  ev.preventDefault();
  const el = document.getElementById('man-' + id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function filtrarManual() {
  const q = (document.getElementById('manual-buscar').value || '').trim().toLowerCase();
  const secs = document.querySelectorAll('.manual-apartado');
  let visibles = 0;
  secs.forEach(s => {
    const ok = !q || (s.dataset.buscar || '').includes(q);
    s.style.display = ok ? '' : 'none';
    if (ok) visibles++;
  });
  // El índice acompaña al filtro para no dejar enlaces que no llevan a nada
  document.querySelectorAll('#manual-indice a').forEach(a => {
    const id = a.getAttribute('href').replace('#man-', '');
    const s = document.getElementById('man-' + id);
    a.style.display = (s && s.style.display !== 'none') ? '' : 'none';
  });
  const vacio = document.getElementById('manual-sin-resultados');
  if (vacio) vacio.style.display = visibles ? 'none' : '';
}
