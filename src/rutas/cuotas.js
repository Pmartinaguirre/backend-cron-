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

  const columnas = 'id, pregunta, fixture_id_api, categoria, fecha_expiracion, estado_partido, cuota_local, estadio, estadio_ciudad, estadio_pais, estadio_capacidad, estadio_cesped, estadio_venue_id, estadio_imagen, arbitro, arbitro_pais';

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
  const todosLosPartidos = [...porId.values()];

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
  const partidos = todosLosPartidos.slice(0, MAX_PARTIDOS_POR_CORRIDA);

  const resultado = {
    revisados: partidos.length,
    pendientesProximaCorrida: Math.max(0, todosLosPartidos.length - partidos.length),
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
      if (partido.estadio == null || partido.arbitro == null || partido.estadio_capacidad == null || partido.estadio_imagen == null || partido.estado_partido === 'TBD') {
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
        // FALLBACK por nombre (a pedido, bug reportado: "no aparece ningún
        // estadio" — diagnosticado que en ligas sudamericanas API-Football
        // casi nunca manda venue.id, aunque sí manda el nombre): sin
        // venueId, se intenta encontrar el estadio buscándolo por nombre
        // (ver obtenerDatosVenuePorNombre). Si lo encuentra, además guarda
        // su id en estadio_venue_id para que la PRÓXIMA corrida ya pueda
        // usar obtenerDatosVenue directo, sin repetir la búsqueda.
        //
        // OJO (bug encontrado con log real: partido de Vasco da Gama, la
        // búsqueda usó "Rio de Janeiro" —la CIUDAD, guardada como
        // `partido.estadio` por una versión vieja del código, antes de
        // separar nombre/ciudad— y devolvió un estadio cualquiera de otro
        // barrio, dato incorrecto y peor que no mostrar nada): por eso acá
        // SOLO se busca por el nombre que la API devuelve EN ESTA MISMA
        // corrida (`info.estadioNombre`) — nunca por `partido.estadio`
        // guardado de antes, que puede ser en realidad una ciudad vieja.
        const nombreEstadioParaBuscar = info?.estadioNombre || null;
        if (partido.estadio_capacidad == null || partido.estadio_imagen == null) {
          const venue = venueId
            ? await obtenerDatosVenue(venueId)
            : await obtenerDatosVenuePorNombre(nombreEstadioParaBuscar);
          if (venue) {
            if (!venueId && venue.venueId != null) payload.estadio_venue_id = venue.venueId;
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
