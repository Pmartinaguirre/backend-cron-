// GET/POST /info-partido — separado de /cuotas (a pedido de Pablo: "no
// deberíamos tener cron jobs independientes para cuota y estadio/árbitro
// para que no entorpezca?"). Antes vivían en el mismo endpoint compartiendo
// el mismo cupo por corrida — y CADA VEZ que se agregaba un tipo de dato
// nuevo (árbitro, validación de equipos, estadio) terminaba compitiendo por
// ese cupo con los demás, dejando a alguno starving corrida tras corrida
// (pasó 3 veces: árbitro vs estadio, validación de equipos vs cuota, estadio
// vs cuota — ver historial de cuotas.js). La solución estructural es
// separarlos: este endpoint SOLO se ocupa de estadio/árbitro/validación de
// equipos/fecha TBD, con su propio cupo por corrida — nunca vuelve a
// competir con la cuota (que es el dato más importante, el que necesitan los
// jugadores para pronosticar) por el mismo cupo.
//
// Se llama por separado desde cron-job.org (mismo secreto, misma frecuencia
// sugerida: cada 10 min), apuntando a esta URL en vez de /cuotas.
const DIAS_VENTANA_ESTADIO = Number(process.env.DIAS_VENTANA_ESTADIO) || 10;

const { supabase } = require('../supabaseClient');
const { obtenerEstadoFixture, obtenerDatosVenue, obtenerDatosVenuePorNombre } = require('../apiFootball');

// VALIDACIÓN LOCAL/VISITANTE — SOLO contra teams.home/away de API-Football,
// NUNCA por estadio (a pedido, corrección real de Pablo: hubo un caso —
// Santos vs Atlético-MG — donde teams.home SÍ decía bien "Santos" para la
// ida, pero el campo de estadio de esa consulta puntual venía con la cancha
// de Atlético-MG. Cruzar por estadio ahí habría invertido un partido que en
// realidad estaba BIEN. El campo de venue puede venir mal aunque
// teams.home/away esté correcto — así que el único criterio de verdad acá es
// teams.home/away, tal como lo pidió Pablo: "límitate a lo que trae la
// api"). Se re-valida CADA CIERTOS DÍAS (no una sola vez) porque API-Football
// puede tardar en corregir sus propios datos, y los jugadores empiezan a
// pronosticar mucho antes de que arranque el partido — no alcanza con
// validar una vez cerca del partido y quedarse tranquilo.
const DIAS_REVALIDAR_EQUIPOS = 2;

// HORARIOS "TBD" SIN CONFIRMAR (a pedido, bug reportado: Libertadores del
// 11 y 18 de agosto ya tenían horario publicado en API-Football y la app
// seguía mostrando 16hrs para todos). Ver explicación completa en el
// historial de cuotas.js — se movió acá porque comparte la misma llamada
// (/fixtures?id=) que estadio/árbitro, no la de cuota.
const DIAS_VENTANA_TBD = Number(process.env.DIAS_VENTANA_TBD) || 45;

const TEMAS_CON_RIESGO_INVERTIDO = ['Copa Libertadores', 'Copa Sudamericana'];

async function rutaInfoPartido(req, res) {
  const ahora = new Date();
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_VENTANA_ESTADIO);
  const limiteTBD = new Date(ahora);
  limiteTBD.setDate(limiteTBD.getDate() + DIAS_VENTANA_TBD);

  const columnas = 'id, pregunta, fixture_id_api, categoria, tema, fecha_expiracion, estado_partido, estadio, estadio_ciudad, estadio_pais, estadio_capacidad, estadio_cesped, estadio_venue_id, estadio_imagen, arbitro, arbitro_pais, equipo_local_id, equipo_visita_id, info_partido_corregida, equipo_local, equipo_visitante, goles_local_oficial, goles_visitante_oficial, resultado_oficial, equipos_local_visita_ultima_validacion';
  const fechaLimiteRevalidar = new Date(ahora);
  fechaLimiteRevalidar.setDate(fechaLimiteRevalidar.getDate() - DIAS_REVALIDAR_EQUIPOS);
  const temasInFilter = TEMAS_CON_RIESGO_INVERTIDO.map((t) => `"${t}"`).join(',');

  const { data: partidosVentana, error } = await supabase
    .from('desafios_mvp')
    .select(columnas)
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('fixture_id_api', 'is', null)
    .or(`estadio.is.null,arbitro.is.null,estadio_capacidad.is.null,estadio_imagen.is.null,and(tema.in.(${temasInFilter}),equipos_local_visita_ultima_validacion.is.null),and(tema.in.(${temasInFilter}),equipos_local_visita_ultima_validacion.lt.${fechaLimiteRevalidar.toISOString()})`)
    .gte('fecha_expiracion', ahora.toISOString())
    .lte('fecha_expiracion', limite.toISOString())
    .order('fecha_expiracion', { ascending: true });

  if (error) {
    console.error('[/info-partido] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  // TBD dentro de la ventana más ancha, aparte (mismo criterio que tenía
  // /cuotas): lo único que puede faltarles es la fecha real.
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
    console.error('[/info-partido] Error leyendo TBD de desafios_mvp:', errorTBD);
  }

  const porId = new Map();
  [...(partidosVentana || []), ...(partidosTBD || [])].forEach((p) => porId.set(p.id, p));
  const todosLosPartidosSinOrden = [...porId.values()];

  // Misma prioridad que tenía /cuotas para esta parte: urgentes (48h)
  // primero (el árbitro se confirma horas antes del partido, no se puede
  // perder esa ventana), después "falta estadio" (arreglable ya) por sobre
  // "el resto", con un cupo mínimo reservado entre grupos para que un
  // backlog grande de una categoría no deje a la otra en cero.
  const HORAS_VENTANA_URGENTE = 48;
  const limiteUrgente = new Date(ahora.getTime() + HORAS_VENTANA_URGENTE * 60 * 60 * 1000);
  const faltaEstadio = (p) => p.estadio_capacidad == null || p.estadio_imagen == null;
  const horario = (p) => p.fecha_expiracion ? new Date(p.fecha_expiracion).getTime() : Infinity;
  const esUrgente = (p) => horario(p) <= limiteUrgente.getTime();

  const MAX_PARTIDOS_POR_CORRIDA = Number(process.env.MAX_PARTIDOS_POR_CORRIDA_INFO) || 15;
  const CUPO_MINIMO_NO_URGENTE = 3;

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

  let partidos = urgentes.slice(0, Math.max(0, MAX_PARTIDOS_POR_CORRIDA - CUPO_MINIMO_NO_URGENTE));
  let cupoRestante = MAX_PARTIDOS_POR_CORRIDA - partidos.length;
  if (cupoRestante > 0) {
    const cupoEstadio = Math.ceil(cupoRestante / 2);
    const tomadosEstadio = noUrgentesFaltaEstadio.slice(0, cupoEstadio);
    partidos = partidos.concat(tomadosEstadio);
    const cupoRestoAjustado = cupoRestante - tomadosEstadio.length;
    partidos = partidos.concat(noUrgentesResto.slice(0, cupoRestoAjustado));
  }

  // Estadio HABITUAL corregido a mano por Pablo — gana por sobre cualquier
  // dato de la API (ver crear_tabla_equipos_estadio_corregido.sql).
  const idsEquiposLocal = [...new Set(partidos.map((p) => p.equipo_local_id).filter(Boolean))];
  const estadiosCorregidosPorEquipo = new Map();
  if (idsEquiposLocal.length > 0) {
    const { data: corregidos, error: errorCorregidos } = await supabase
      .from('equipos_estadio_corregido')
      .select('equipo_id, estadio, estadio_ciudad, estadio_pais, estadio_capacidad, estadio_cesped, estadio_imagen')
      .in('equipo_id', idsEquiposLocal);
    if (errorCorregidos) {
      console.error('[/info-partido] Error leyendo equipos_estadio_corregido:', errorCorregidos);
    } else {
      (corregidos || []).forEach((c) => estadiosCorregidosPorEquipo.set(c.equipo_id, c));
    }
  }

  const resultado = {
    revisados: partidos.length,
    pendientesProximaCorrida: Math.max(0, todosLosPartidosSinOrden.length - partidos.length),
    actualizados: 0,
    sinCambiosTodavia: 0,
    errores: [],
  };

  for (const partido of partidos) {
    try {
      const payload = {};
      const necesitaValidarEquipos = !partido.resultado_oficial
        && TEMAS_CON_RIESGO_INVERTIDO.includes(partido.tema)
        && (!partido.equipos_local_visita_ultima_validacion || new Date(partido.equipos_local_visita_ultima_validacion) < fechaLimiteRevalidar);

      const info = await obtenerEstadoFixture(partido.fixture_id_api);

      if (necesitaValidarEquipos && info) {
        payload.equipos_local_visita_ultima_validacion = new Date().toISOString();
        const localApiNorm = (info.equipoLocalApi || '').trim().toLowerCase();
        const localGuardadoNorm = (partido.equipo_local || '').trim().toLowerCase();
        const visitaApiNorm = (info.equipoVisitaApi || '').trim().toLowerCase();
        const visitaGuardadoNorm = (partido.equipo_visitante || '').trim().toLowerCase();
        const estanInvertidos = localApiNorm && visitaApiNorm && localGuardadoNorm && visitaGuardadoNorm
          && localApiNorm !== localGuardadoNorm
          && localApiNorm === visitaGuardadoNorm
          && visitaApiNorm === localGuardadoNorm;
        if (estanInvertidos) {
          payload.equipo_local = info.equipoLocalApi;
          payload.equipo_visitante = info.equipoVisitaApi;
          if (partido.goles_local_oficial != null || partido.goles_visitante_oficial != null) {
            payload.goles_local_oficial = partido.goles_visitante_oficial;
            payload.goles_visitante_oficial = partido.goles_local_oficial;
          }
          console.error(`[/info-partido] ¡CORREGIDO! Partido ${partido.id} tenía local/visitante invertidos: "${partido.equipo_local}" (guardado) vs "${info.equipoLocalApi}" (API-Football) — ahora local=${info.equipoLocalApi}, visita=${info.equipoVisitaApi}.`);
          resultado.equiposInvertidosCorregidos = (resultado.equiposInvertidosCorregidos || []);
          resultado.equiposInvertidosCorregidos.push({ id: partido.id, antes: `${partido.equipo_local} vs ${partido.equipo_visitante}`, ahora: `${info.equipoLocalApi} vs ${info.equipoVisitaApi}` });
        }
      }

      if (!partido.info_partido_corregida) {
        if (info?.estadioNombre != null) payload.estadio = info.estadioNombre;
        if (info?.estadioCiudad != null) payload.estadio_ciudad = info.estadioCiudad;
        if (info?.estadioVenueId != null) payload.estadio_venue_id = info.estadioVenueId;
        if (info?.arbitro != null) payload.arbitro = info.arbitro;
        if (info?.arbitroPais != null) payload.arbitro_pais = info.arbitroPais;
      }

      if (info?.estado && info.estado !== partido.estado_partido) {
        payload.estado_partido = info.estado;
      }
      if (info?.fechaISO) {
        const fechaNueva = new Date(info.fechaISO);
        const fechaActual = partido.fecha_expiracion ? new Date(partido.fecha_expiracion) : null;
        const cambio = !fechaActual || Math.abs(fechaNueva.getTime() - fechaActual.getTime()) > 60000;
        if (cambio) {
          payload.fecha_expiracion = fechaNueva.toISOString();
          console.log(`[/info-partido] Partido ${partido.id} (${partido.pregunta}) horario corregido: ${partido.fecha_expiracion} -> ${fechaNueva.toISOString()}`);
        }
      }

      if (!partido.info_partido_corregida) {
        const venueId = info?.estadioVenueId || partido.estadio_venue_id;
        const nombreFixtureFresco = info?.estadioNombre || null;
        const nombreDistinto = nombreFixtureFresco && partido.estadio
          && nombreFixtureFresco.trim().toLowerCase() !== partido.estadio.trim().toLowerCase();
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
          if (venue) {
            if (!venueId && venue.venueId != null) payload.estadio_venue_id = venue.venueId;
            if (venue.nombre != null) payload.estadio = venue.nombre;
            if (venue.ciudad != null) payload.estadio_ciudad = venue.ciudad;
            if (venue.pais != null) payload.estadio_pais = venue.pais;
            if (venue.capacidad != null) payload.estadio_capacidad = venue.capacidad;
            if (venue.cesped != null) payload.estadio_cesped = venue.cesped;
            if (venue.imagen != null) payload.estadio_imagen = venue.imagen;
          }
        }
      }

      if (Object.keys(payload).length === 0) {
        resultado.sinCambiosTodavia++;
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
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[/info-partido] ${resultado.actualizados} actualizados, ${resultado.sinCambiosTodavia} sin cambios todavía, ${resultado.errores.length} errores, ${resultado.pendientesProximaCorrida} quedan para la próxima corrida.`);
  res.json(resultado);
}

module.exports = { rutaInfoPartido };
