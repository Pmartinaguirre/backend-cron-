// GET/POST /cuotas — mismo trabajo que hacía actualizar_cuotas.js a mano:
// busca partidos Cat.4/5 activos sin cuota guardada, les pide la cuota
// "Match Winner" a API-Football, y guarda cuota_local/empate/visita.
// Idempotente: los partidos que ya tienen cuota se saltan siempre, así que
// no hay problema en llamarlo seguido (ej. cada 30-60 min).
//
// VENTANA DE CUOTAS (a pedido, control de consumo de API-Football): antes
// esto revisaba TODOS los partidos activos sin cuota, sin importar cuán
// lejos estuviera la fecha — con /crear-partidos trayendo partidos hasta
// 60 días antes (DIAS_ANTICIPACION, ver ese archivo), un partido recién
// creado podía quedar "sin cuota todavía" semanas enteras, cobrando una
// llamada a la API en CADA corrida de este cron (cada 30-60 min) hasta que
// la cuota apareciera — y API-Football no publica cuotas de partidos tan
// lejos en el futuro, así que esas llamadas salían siempre en blanco. Acá
// se filtra a solo los partidos dentro de los próximos DIAS_VENTANA_CUOTAS
// días: no tiene sentido consultar la cuota de un partido a 60 días si de
// todos modos va a estar disponible recién ~7 días antes.
const DIAS_VENTANA_CUOTAS = Number(process.env.DIAS_VENTANA_CUOTAS) || 10;

const { supabase } = require('../supabaseClient');
const { obtenerCuotas, obtenerEstadoFixture, obtenerDatosVenue, obtenerDatosVenuePorNombre } = require('../apiFootball');

// HORARIOS "TBD" SIN CONFIRMAR (a pedido, bug reportado: Libertadores del
// 11 y 18 de agosto ya tenían horario publicado en API-Football y la app
// seguía mostrando 16hrs para todos).
//
// Causa real: cuando se crea un partido y la TV/organizador todavía no fijó
// la hora, API-Football lo manda con estado 'TBD' y una fecha PLACEHOLDER
// (acá cae siempre a las 16hrs). `/vivo` es quien reprograma la fecha
// cuando la API la actualiza — pero `/vivo` SOLO mira partidos cuya
// fecha_expiracion YA PASÓ (`.lte(fecha_expiracion, ahora)`), y una fecha
// placeholder futura (el mismo día, solo con la hora mal) nunca "pasa" a
// tiempo, así que esos partidos son invisibles para esa corrección — se
// quedan en 16hrs para siempre aunque la hora real ya esté publicada.
//
// La corrección de estado_partido/fecha_expiracion para los 'TBD' vive acá
// (no en /vivo) porque ya se estaba pidiendo lo mismo (obtenerEstadoFixture)
// para estadio/árbitro — no es una llamada nueva a la cuota de API-Football,
// solo se aprovecha para chequear la fecha también. A diferencia de la
// ventana de cuotas (10 días, porque ahí no hay nada que pedir todavía),
// acá se usa una ventana propia y más ancha: nada impide que un TBD se
// confirme con semanas de anticipación.
const DIAS_VENTANA_TBD = Number(process.env.DIAS_VENTANA_TBD) || 45;

async function rutaCuotas(req, res) {
  const ahora = new Date();
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_VENTANA_CUOTAS);
  const limiteTBD = new Date(ahora);
  limiteTBD.setDate(limiteTBD.getDate() + DIAS_VENTANA_TBD);

  const columnas = 'id, pregunta, fixture_id_api, categoria, fecha_expiracion, estado_partido, cuota_local, estadio, estadio_ciudad, estadio_pais, estadio_capacidad, estadio_cesped, estadio_venue_id, estadio_imagen, arbitro, arbitro_pais, equipo_local_id, info_partido_corregida';

  // Estadio + árbitro (a pedido, "Información del partido" en la app): se
  // traen JUNTO con las cuotas, en la misma corrida — mismo criterio que
  // pidió Pablo ("como 7 días antes cuando llegan las ODDS"). Por eso el
  // filtro de abajo ya no es solo "sin cuota": también entra un partido que
  // YA tiene cuota pero le sigue faltando estadio o árbitro (el árbitro en
  // particular suele confirmarse más tarde que las cuotas — con el filtro
  // viejo, ese partido dejaba de revisarse apenas llegaba la cuota y el
  // árbitro se quedaba en "No disponible" para siempre).
  const { data: partidosVentana, error } = await supabase
    .from('desafios_mvp')
    .select(columnas)
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('fixture_id_api', 'is', null)
    .or('cuota_local.is.null,estadio.is.null,arbitro.is.null,estadio_capacidad.is.null,estadio_imagen.is.null')
    .gte('fecha_expiracion', ahora.toISOString())
    .lte('fecha_expiracion', limite.toISOString())
    // Los partidos que juegan más pronto primero (a pedido, junto con el
    // tope por corrida de más abajo: si hay que repartir el trabajo en
    // varias corridas, que le toque antes al que menos tiempo tiene para
    // conseguir su cuota/estadio/árbitro, no a uno cualquiera).
    .order('fecha_expiracion', { ascending: true });

  if (error) {
    console.error('[/cuotas] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  // Segunda lista, aparte: los 'TBD' dentro de la ventana más ancha, sin
  // importar si ya tienen cuota/estadio/árbitro — lo único que puede faltarles
  // es la fecha real, y ESE chequeo no depende de esos otros campos.
  const { data: partidosTBD, error: errorTBD } = await supabase
    .from('desafios_mvp')
    .select(columnas)
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .eq('estado_partido', 'TBD')
    .not('fixture_id_api', 'is', null)
    .lte('fecha_expiracion', limiteTBD.toISOString())
    .order('fecha_expiracion', { ascending: true });

  if (errorTBD) {
    console.error('[/cuotas] Error leyendo TBD de desafios_mvp:', errorTBD);
  }

  // Merge sin duplicados (un partido puede caer en las dos listas).
  const porId = new Map();
  [...(partidosVentana || []), ...(partidosTBD || [])].forEach((p) => porId.set(p.id, p));
  const todosLosPartidosSinOrden = [...porId.values()];

  // PRIORIDAD (a pedido, bug reportado: "no busca los estadios, se quedan
  // trabados los mismos" — diagnosticado con logs reales: Sevilla, Celta
  // Vigo, Colo Colo nunca aparecían ni intentados). Causa: antes esta lista
  // solo se ordenaba por fecha más próxima, y el tope por corrida (ver
  // abajo) se comía siempre los mismos 15 partidos más próximos — que
  // resulta que son justo los que están esperando cuota_local/arbitro, un
  // dato que la API todavía no publicó y que NO se arregla reintentando
  // (se arregla solo, cuando se acerque la fecha). Esos partidos se quedan
  // "incompletos" corrida tras corrida y ocupan el cupo para siempre, sin
  // dejar lugar a partidos MÁS LEJANOS a los que solo les falta el
  // ESTADIO — algo que sí se puede resolver ahora mismo, no depende de
  // esperar nada.
  //
  // Por eso ahora se prioriza así: primero los partidos a los que les
  // falta el estadio (arreglable YA), después el resto por fecha más
  // próxima (cuota/árbitro, que solo se resuelve con el tiempo). Dentro de
  // cada grupo, más próximo primero.
  // URGENTES (a pedido, bug reportado: "partido de HOY no tiene árbitro y
  // todas las apps ya lo tienen" — la prioridad por estadio de arriba tuvo
  // un efecto colateral: un partido de HOY que solo espera árbitro/cuota
  // ahora podía quedar afuera de la corrida entera si había 15+ partidos
  // más lejanos sin estadio, porque esos SIEMPRE pasaban primero sin
  // importar la fecha. El árbitro en particular se confirma horas antes del
  // partido — si se pierde la corrida justo antes del horario, se pierde el
  // dato para todo el partido. Por eso los partidos dentro de las próximas
  // 48h van SIEMPRE primero (les falte lo que les falte), y recién después
  // se prioriza estadio-faltante sobre el resto.
  const HORAS_VENTANA_URGENTE = 48;
  const limiteUrgente = new Date(ahora.getTime() + HORAS_VENTANA_URGENTE * 60 * 60 * 1000);
  const faltaEstadio = (p) => p.estadio_capacidad == null || p.estadio_imagen == null;
  const horario = (p) => p.fecha_expiracion ? new Date(p.fecha_expiracion).getTime() : Infinity;
  const esUrgente = (p) => horario(p) <= limiteUrgente.getTime();

  // TOPE POR CORRIDA (a pedido, bug reportado: cron-job.org viene fallando
  // por "tiempo de espera agotado" varios días seguidos, siempre justo en
  // los 30s del timeout configurado). Causa: este endpoint procesaba TODOS
  // los partidos de la ventana en una sola corrida, en serie, con hasta 3
  // llamadas a API-Football por partido + una pausa fija de 300ms entre
  // cada uno — con la Champions arrancando (muchos partidos entrando de
  // golpe a la ventana de 10 días), esa cuenta pasa fácil los 30s. Ahora se
  // procesa como máximo esta cantidad por corrida; el resto queda para la
  // PRÓXIMA corrida (cada 10 min, según cron-job.org) — es seguro porque el
  // query de arriba ya es idempotente (siempre trae primero lo que todavía
  // le falta algo), así que no hay riesgo de dejar un partido colgado para
  // siempre, solo tarda una corrida más en completarse.
  const MAX_PARTIDOS_POR_CORRIDA = Number(process.env.MAX_PARTIDOS_POR_CORRIDA_CUOTAS) || 15;

  // CUPO RESERVADO por categoría (a pedido, bug reportado: "los próximos 84
  // partidos vienen todos con árbitro null" — diagnosticado: la prioridad
  // "falta estadio primero" (ver más abajo) no tenía ningún tope, así que
  // si había 15+ partidos NO urgentes con estadio incompleto (algo común:
  // fixtures lejanos que todavía no tienen venue.id en API-Football), esos
  // se comían el cupo COMPLETO de la corrida, corrida tras corrida — el
  // resto de los partidos (a los que solo les faltaba árbitro/cuota, con el
  // estadio ya completo) nunca llegaban ni a intentarse mientras ese
  // backlog de estadios no bajara de 15. Antes esto molestaba menos porque
  // el árbitro igual no se confirma con tanta anticipación, pero un backlog
  // de estadios grande y persistente podía dejar la búsqueda de árbitro
  // COMPLETAMENTE trabada para todo partido no-urgente, no solo demorada.
  // Ahora, fuera de los urgentes (que siguen yendo TODOS primero, sin
  // tope entre ellos más que el cupo total), el cupo restante se reparte
  // MITAD Y MITAD entre "falta estadio" y "el resto" — así ningún backlog
  // de una categoría puede dejar a la otra sin ninguna corrida.
  const urgentes = todosLosPartidosSinOrden
    .filter(esUrgente)
    .sort((a, b) => horario(a) - horario(b));
  const noUrgentes = todosLosPartidosSinOrden.filter((p) => !esUrgente(p));
  const noUrgentesFaltaEstadio = noUrgentes
    .filter(faltaEstadio)
    .sort((a, b) => horario(a) - horario(b));
  const noUrgentesResto = noUrgentes
    .filter((p) => !faltaEstadio(p))
    .sort((a, b) => horario(a) - horario(b));

  let partidos = urgentes.slice(0, MAX_PARTIDOS_POR_CORRIDA);
  const cupoRestante = MAX_PARTIDOS_POR_CORRIDA - partidos.length;
  if (cupoRestante > 0) {
    const cupoEstadio = Math.ceil(cupoRestante / 2);
    const tomadosEstadio = noUrgentesFaltaEstadio.slice(0, cupoEstadio);
    partidos = partidos.concat(tomadosEstadio);
    // Si "falta estadio" no llenó su mitad (backlog chico), el sobrante de
    // cupo pasa a "el resto" — no se pierde cupo por repartir en partes
    // iguales cuando una de las dos categorías tiene menos partidos que su
    // mitad asignada.
    const cupoRestoAjustado = cupoRestante - tomadosEstadio.length;
    partidos = partidos.concat(noUrgentesResto.slice(0, cupoRestoAjustado));
  }

  // Estadio HABITUAL corregido a mano por Pablo (a pedido: "cómo cambio
  // para siempre el estadio típico de un club, para no tener que editarlo
  // partido por partido" — ver crear_tabla_equipos_estadio_corregido.sql y
  // el checkbox "Guardar como estadio habitual" en ModuloAdminEstadio,
  // sementomvp.jsx). Se trae UNA sola vez para todos los equipos de esta
  // corrida, no partido por partido. Si el equipo LOCAL de un partido tiene
  // fila acá, ese estadio manda SIEMPRE por sobre lo que diga la API —
  // Pablo lo confirmó a mano, así que es el dato de más confianza que
  // existe (más que el propio fixture puntual, que en copas internacionales
  // puede venir con el estadio de siempre del club aunque ese partido en
  // particular se juegue en otro lado).
  const idsEquiposLocal = [...new Set(partidos.map((p) => p.equipo_local_id).filter(Boolean))];
  const estadiosCorregidosPorEquipo = new Map();
  if (idsEquiposLocal.length > 0) {
    const { data: corregidos, error: errorCorregidos } = await supabase
      .from('equipos_estadio_corregido')
      .select('equipo_id, estadio, estadio_ciudad, estadio_pais, estadio_capacidad, estadio_cesped, estadio_imagen')
      .in('equipo_id', idsEquiposLocal);
    if (errorCorregidos) {
      console.error('[/cuotas] Error leyendo equipos_estadio_corregido:', errorCorregidos);
    } else {
      (corregidos || []).forEach((c) => estadiosCorregidosPorEquipo.set(c.equipo_id, c));
    }
  }

  const resultado = {
    revisados: partidos.length,
    pendientesProximaCorrida: Math.max(0, todosLosPartidosSinOrden.length - partidos.length),
    actualizados: 0,
    sinCuotaTodavia: 0,
    errores: [],
  };

  for (const partido of partidos) {
    try {
      const payload = {};
      // Cuotas: solo se pide si todavía no las tiene (ya idempotente antes).
      if (partido.cuota_local == null) {
        const cuotas = await obtenerCuotas(partido.fixture_id_api);
        if (cuotas) {
          payload.cuota_local = cuotas.cuota_local;
          payload.cuota_empate = cuotas.cuota_empate;
          payload.cuota_visita = cuotas.cuota_visita;
        }
      }
      // Estadio/árbitro/fecha real: se pide si falta alguno de los datos, O
      // si el partido sigue en 'TBD' (hora sin confirmar). Comparte la misma
      // llamada a /fixtures?id= que ya usa obtenerEstadoFixture (la
      // reaprovecha /vivo y /resolver), así que no es una consulta nueva a
      // la cuota de API-Football.
      // "info_partido_corregida" (a pedido: "como corrijo estadios y
      // árbitros con el admin, mientras tanto?" — ver ModuloAdminEstadio en
      // sementomvp.jsx y agregar_columna_info_partido_corregida.sql): si
      // Pablo ya corrigió a mano estadio/árbitro de ESTE partido puntual,
      // el cron nunca más los vuelve a pisar — mismo criterio que
      // media_video_corregido usa para el video de YouTube. Sin este
      // chequeo, la corrección manual duraría hasta la próxima corrida,
      // que la volvería a sobrescribir con el dato (posiblemente
      // equivocado, o simplemente inexistente) de API-Football.
      if (!partido.info_partido_corregida && (partido.estadio == null || partido.arbitro == null || partido.estadio_capacidad == null || partido.estadio_imagen == null || partido.estado_partido === 'TBD')) {
        const info = await obtenerEstadoFixture(partido.fixture_id_api);
        if (info?.estadioNombre != null) payload.estadio = info.estadioNombre;
        if (info?.estadioCiudad != null) payload.estadio_ciudad = info.estadioCiudad;
        if (info?.estadioVenueId != null) payload.estadio_venue_id = info.estadioVenueId;
        if (info?.arbitro != null) payload.arbitro = info.arbitro;
        if (info?.arbitroPais != null) payload.arbitro_pais = info.arbitroPais;
        // Fecha/hora real (mismo criterio que /vivo al reprogramar un PST):
        // si la API ya no dice 'TBD' o la fecha cambió de verdad, se corrige
        // acá — así el horario placeholder (16hrs) se reemplaza por el real
        // apenas la organización/TV lo confirma, sin esperar a que la fecha
        // vieja "pase" (que es lo que /vivo necesita para mirarlo).
        if (info?.estado && info.estado !== partido.estado_partido) {
          payload.estado_partido = info.estado;
        }
        if (info?.fechaISO) {
          const fechaNueva = new Date(info.fechaISO);
          const fechaActual = partido.fecha_expiracion ? new Date(partido.fecha_expiracion) : null;
          const cambio = !fechaActual || Math.abs(fechaNueva.getTime() - fechaActual.getTime()) > 60000;
          if (cambio) {
            payload.fecha_expiracion = fechaNueva.toISOString();
            console.log(`[/cuotas] Partido ${partido.id} (${partido.pregunta}) horario corregido: ${partido.fecha_expiracion} -> ${fechaNueva.toISOString()}`);
          }
        }
        // Capacidad/césped/país del estadio (a pedido): pide /venues?id=
        // SOLO si todavía falta la capacidad — es una llamada aparte, no
        // vale la pena repetirla una vez que el estadio ya está completo
        // (a diferencia de estadio/árbitro/fecha, que pueden llegar tarde
        // y conviene reintentar). El "año de fundación" que también se
        // pidió NO lo entrega este endpoint de API-Football (solo trae
        // name/city/country/capacity/surface/image) — queda pendiente si
        // alguna vez aparece en la API.
        const venueId = info?.estadioVenueId || partido.estadio_venue_id;
        // (a pedido, bug reportado: "no imprime la foto del estadio" —
        // partidos que ya tenían estadio_capacidad guardado de ANTES de que
        // existiera esta columna nunca volvían a pedir /venues, así que se
        // quedaban sin imagen para siempre. Ahora también reintenta si falta
        // la imagen, aunque la capacidad ya esté.)
        //
        // TRES INTENTOS EN ORDEN (a pedido: "mira cómo lo hace Forza
        // Football, se conecta a la misma API y tiene todo bien"):
        //   1) venueId del fixture — el más preciso cuando existe, pero en
        //      ligas fuera de las top-5 europeas casi nunca viene.
        //   2) Búsqueda por el nombre de estadio QUE TRAE ESTE FIXTURE
        //      puntual (fresco, de esta corrida — nunca el guardado de
        //      antes). Va ANTES que el estadio fijo del equipo porque un
        //      partido puede jugarse en un estadio distinto al habitual del
        //      equipo (bug encontrado: U. Católica vs Estudiantes jugado en
        //      Claro Arena, no en su Santa Laura/San Carlos de siempre — el
        //      fallback por equipo pisaba el dato correcto del fixture con
        //      el estadio incorrecto "de siempre").
        //   3) [SACADO a pedido, ver más abajo] Antes había un tercer
        //      intento acá — Estadio PROPIO del equipo local (/teams?id=,
        //      obtenerVenueDeEquipo) cuando el fixture no traía NINGÚN
        //      nombre de estadio propio. Bug reportado: "hay por lo menos
        //      un 30% de los estadios mal ingresados" — el estadio FIJO del
        //      equipo es el dato habitual, pero en copas internacionales
        //      (Sudamericana/Libertadores) los equipos chicos suelen jugar
        //      esos partidos puntuales en un estadio DISTINTO al de
        //      siempre (más grande, neutral) y esta app lo mostraba con el
        //      estadio de siempre como si fuera un hecho confirmado — caso
        //      real: Recoleta vs Boca mostraba "Roque Battilana" (estadio
        //      habitual de Recoleta) cuando en realidad se jugó en
        //      "Defensores del Chaco". Sin ninguna señal PROPIA del
        //      fixture, adivinar así tiene demasiado riesgo de estar mal —
        //      mejor dejar el estadio vacío (como ya se hacía con árbitro
        //      cuando falta, ver ModuloAdminEstadio: "Ocultar sección
        //      árbitro si no hay dato") y que Pablo lo complete a mano
        //      desde el Admin, que ahora además permite subir la foto
        //      directo (ver comprimirFotoEstadio/bucket "fotos-estadios").
        // RECHEQUEO POR NOMBRE DISTINTO (a pedido, bug reportado: "sigue sin
        // cambiar el estadio de U. Católica" — una vez que capacidad/imagen
        // quedaban guardadas (aunque fuera con el estadio EQUIVOCADO del
        // fallback por equipo), esta sección nunca se volvía a ejecutar, así
        // que un dato malo quedaba pegado para siempre aunque la API después
        // sí publicara el estadio correcto del fixture puntual. Ahora,
        // aunque ya haya capacidad/imagen guardada, si el fixture trae ESTA
        // corrida un nombre de estadio distinto al que ya tenemos guardado,
        // se reintenta igual — es la señal de que el partido se juega en un
        // estadio distinto al que asumimos antes.
        const nombreFixtureFresco = info?.estadioNombre || null;
        const nombreDistinto = nombreFixtureFresco && partido.estadio
          && nombreFixtureFresco.trim().toLowerCase() !== partido.estadio.trim().toLowerCase();
        // PASO 0, máxima prioridad: estadio HABITUAL corregido a mano por
        // Pablo para el equipo LOCAL (ver estadiosCorregidosPorEquipo más
        // arriba). Si existe, gana por sobre CUALQUIER dato de la API —
        // ni siquiera se llama a obtenerDatosVenue/obtenerDatosVenuePorNombre,
        // no hace falta: el override es la fuente de verdad.
        const estadioCorregidoEquipo = partido.equipo_local_id
          ? estadiosCorregidosPorEquipo.get(partido.equipo_local_id)
          : null;
        if (estadioCorregidoEquipo) {
          if (estadioCorregidoEquipo.estadio != null) payload.estadio = estadioCorregidoEquipo.estadio;
          if (estadioCorregidoEquipo.estadio_ciudad != null) payload.estadio_ciudad = estadioCorregidoEquipo.estadio_ciudad;
          if (estadioCorregidoEquipo.estadio_pais != null) payload.estadio_pais = estadioCorregidoEquipo.estadio_pais;
          if (estadioCorregidoEquipo.estadio_capacidad != null) payload.estadio_capacidad = estadioCorregidoEquipo.estadio_capacidad;
          if (estadioCorregidoEquipo.estadio_cesped != null) payload.estadio_cesped = estadioCorregidoEquipo.estadio_cesped;
          if (estadioCorregidoEquipo.estadio_imagen != null) payload.estadio_imagen = estadioCorregidoEquipo.estadio_imagen;
        } else if (partido.estadio_capacidad == null || partido.estadio_imagen == null || nombreDistinto) {
          let venue = null;
          if (venueId) {
            venue = await obtenerDatosVenue(venueId);
          } else if (info?.estadioNombre) {
            venue = await obtenerDatosVenuePorNombre(info.estadioNombre);
          }
          // Sin venueId Y sin nombre de estadio propio del fixture: no hay
          // ninguna señal de ESTE partido puntual, así que no se adivina más
          // (antes acá caía a obtenerVenueDeEquipo — ver comentario arriba).
          // Queda sin estadio hasta que la API lo publique o el admin lo
          // complete a mano.
          if (venue) {
            if (!venueId && venue.venueId != null) payload.estadio_venue_id = venue.venueId;
            // Nombre/ciudad del estadio (a pedido, bug encontrado: "en
            // Sevilla sale Sevilla" — el fixture a veces trae solo la
            // CIUDAD como si fuera el nombre del estadio, ej. "Sevilla",
            // "Vigo", "Córdoba". Antes acá NO se pisaba ese nombre porque
            // ya "tenía algo" — ahora, cuando el fallback viene del equipo
            // (venue.nombre existe), ese SIEMPRE manda por sobre lo que
            // haya traído el fixture — es la fuente más confiable (mismo
            // criterio que usa Forza Football).
            if (venue.nombre != null) payload.estadio = venue.nombre;
            if (venue.ciudad != null) payload.estadio_ciudad = venue.ciudad;
            if (venue.pais != null) payload.estadio_pais = venue.pais;
            if (venue.capacidad != null) payload.estadio_capacidad = venue.capacidad;
            if (venue.cesped != null) payload.estadio_cesped = venue.cesped;
            // Foto del estadio (a pedido: "agrega una foto del estadio").
            if (venue.imagen != null) payload.estadio_imagen = venue.imagen;
          }
        }
      }
      if (Object.keys(payload).length === 0) {
        resultado.sinCuotaTodavia++;
        continue;
      }
      const { error: errUpdate } = await supabase
        .from('desafios_mvp')
        .update(payload)
        .eq('id', partido.id);
      if (errUpdate) {
        resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
      } else {
        resultado.actualizados++;
      }
    } catch (e) {
      resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: e.message });
    }
    // Pausa chica entre llamadas para no pasarse de los límites por minuto
    // del plan de API-Football.
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[/cuotas] ${resultado.actualizados} actualizados, ${resultado.sinCuotaTodavia} sin cambios todavía, ${resultado.errores.length} errores, ${resultado.pendientesProximaCorrida} quedan para la próxima corrida.`);
  res.json(resultado);
}

module.exports = { rutaCuotas };
