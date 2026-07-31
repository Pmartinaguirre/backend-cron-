// GET/POST /resolver — pensado para correr cada 5-15 min. Busca partidos
// Cat.4/5 activos, ya arrancados y todavía sin resultado real guardado,
// pregunta a API-Football si ya terminaron (estado FT), y si es así:
//   - Cat.5: arma el texto LEV ("Gana X"/"Empate"/"Gana Y") a partir del
//     marcador real, lo guarda en resultado_oficial, y paga diamantes a
//     todos los que acertaron (misma cuota para todos, la del resultado
//     real que ocurrió).
//   - Cat.4: guarda goles_local_oficial/goles_visitante_oficial, y paga a
//     CADA jugador según su propio pronóstico (respuesta_extra) — el monto
//     lo decide calcularDiamantesCat4 (base por cuota + bonos de precisión).
//
// Esto es exactamente lo mismo que hacen los botones "Pagar"/"Pagar a
// todos" del panel de Admin en sementomvp.jsx, solo que disparado por cron
// en vez de por un clic — ver src/diamantes.js para la nota de que esa
// lógica está duplicada a mano y hay que mantenerla igual en ambos lados.
const { supabase } = require('../supabaseClient');
const { obtenerEstadoFixture } = require('../apiFootball');
const { filtrarPendientes, partidosAbandonados } = require('../partidosPendientes');
const {
  cuotaDelResultado,
  calcularDiamantesPorCuota,
  calcularDiamantesCat4,
  calcularDiamantesCat4PorDireccion,
  parsearMarcador,
  construirTextoLEV,
  signoDeGoles,
  signoDeResultadoLEV,
} = require('../diamantes');

const DIAMANTES_BASE_SIN_CUOTA = 120; // mismo fallback que en sementomvp.jsx

async function resolverCat5(partido, golesLocal, golesVisita, penalesLocal, penalesVisita) {
  const respuestaGanadora = construirTextoLEV(partido.equipo_local, partido.equipo_visitante, golesLocal, golesVisita);

  // Penales (bug encontrado, caso O'Higgins vs Boca): /vivo deja de tocar un
  // partido apenas su estado pasa a ser "terminado" (FT/AET/PEN), así que si
  // la corrida exacta en que la API pasó de "P" a "PEN" no trajo todavía el
  // resultado de la tanda, penales_local/penales_visita se quedaban en null
  // PARA SIEMPRE — nadie más los volvía a pedir. Ahora /resolver también los
  // guarda acá, en el mismo momento en que cierra el partido, así que aunque
  // /vivo lo haya perdido, esto lo rescata.
  await supabase.from('desafios_mvp').update({
    resultado_oficial: respuestaGanadora,
    ...(penalesLocal != null ? { penales_local: penalesLocal } : {}),
    ...(penalesVisita != null ? { penales_visita: penalesVisita } : {}),
  }).eq('id', partido.id);

  const { data: ganadores, error } = await supabase
    .from('predicciones_mvp')
    .select('usuario_id')
    .eq('desafio_id', partido.id)
    .eq('eleccion', respuestaGanadora);
  if (error) throw error;

  const signoGanador = signoDeGoles(golesLocal, golesVisita);
  const cuotaGanadora = cuotaDelResultado(partido, signoGanador);
  const diamantesGanados = cuotaGanadora != null ? calcularDiamantesPorCuota(cuotaGanadora) : DIAMANTES_BASE_SIN_CUOTA;

  const usuariosUnicos = [...new Set((ganadores || []).map((g) => g.usuario_id))];
  for (const uid of usuariosUnicos) {
    const { data: u } = await supabase.from('usuarios').select('puntos').eq('id', uid).single();
    if (u) {
      await supabase.from('usuarios').update({ puntos: (u.puntos || 0) + diamantesGanados }).eq('id', uid);
    }
  }
  return { tipo: 'cat5', respuestaGanadora, diamantesGanados, ganadores: usuariosUnicos.length };
}

async function resolverCat4(partido, golesLocal, golesVisita, penalesLocal, penalesVisita) {
  // Ver nota de penales en resolverCat5 — mismo rescate acá para Cat.4.
  await supabase
    .from('desafios_mvp')
    .update({
      goles_local_oficial: golesLocal,
      goles_visitante_oficial: golesVisita,
      ...(penalesLocal != null ? { penales_local: penalesLocal } : {}),
      ...(penalesVisita != null ? { penales_visita: penalesVisita } : {}),
    })
    .eq('id', partido.id);

  const { data: predicciones, error } = await supabase
    .from('predicciones_mvp')
    .select('usuario_id, eleccion, respuesta_extra')
    .eq('desafio_id', partido.id);
  if (error) throw error;

  const signoReal = signoDeGoles(golesLocal, golesVisita);

  let pagados = 0;
  for (const p of predicciones || []) {
    const marcador = parsearMarcador(p.respuesta_extra);
    // Sin marcador exacto pero con L/E/V elegido (a pedido, bug reportado:
    // un jugador acertó "gana local" en Cat.4 y cobró 0 porque nunca cargó
    // el marcador exacto) — ahora paga la base por acertar la dirección en
    // vez de saltarlo entero.
    const monto = marcador
      ? calcularDiamantesCat4(marcador[0], marcador[1], golesLocal, golesVisita, partido)
      : calcularDiamantesCat4PorDireccion(signoDeResultadoLEV(partido.equipo_local, partido.equipo_visitante, p.eleccion), signoReal, partido);
    if (monto <= 0) continue;
    const { data: u } = await supabase.from('usuarios').select('puntos').eq('id', p.usuario_id).single();
    if (u) {
      await supabase.from('usuarios').update({ puntos: (u.puntos || 0) + monto }).eq('id', p.usuario_id);
      pagados++;
    }
  }
  return { tipo: 'cat4', golesLocal, golesVisita, pagados };
}

async function rutaResolver(req, res) {
  const ahoraISO = new Date().toISOString();

  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select(
      // estado_partido es imprescindible acá: filtrarPendientes lo usa para
      // descartar los partidos cancelados/abandonados. Antes no se pedía, y
      // por eso este endpoint no tenía forma de saber que un partido ya no
      // se iba a jugar nunca.
      'id, categoria, fixture_id_api, equipo_local, equipo_visitante, cuota_local, cuota_empate, cuota_visita, resultado_oficial, goles_local_oficial, fecha_expiracion, estado_partido, marcador_parcial_local, marcador_parcial_visita, penales_local, penales_visita'
    )
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('fixture_id_api', 'is', null)
    .lte('fecha_expiracion', ahoraISO);

  if (error) {
    console.error('[/resolver] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  // Antes este filtro era solo "todavía no tiene resultado oficial", sin mirar
  // el estado ni la antigüedad. Con eso, cada partido postergado o cancelado
  // se quedaba en la lista de forma indefinida y consumía una llamada a
  // API-Football en cada corrida del cron, para siempre. Ahora el criterio es
  // el mismo que usa /vivo (ver src/partidosPendientes.js).
  // 'resolver' — el modo importa: a diferencia de /vivo, acá los partidos en
  // FT son justamente los que hay que procesar. Con el modo por defecto se
  // descartaban y quedaban sin pagar para siempre.
  const pendientes = filtrarPendientes(partidos, 'resolver');
  const abandonados = partidosAbandonados(partidos);

  const resultado = {
    revisados: pendientes.length,
    resueltos: 0,
    todaviaJugando: 0,
    abandonados,
    errores: [],
  };

  // BUG encontrado (a pedido, caso O'Higgins vs Boca): acá solo se aceptaba
  // estado === 'FT', así que un partido que se definía en el alargue (AET) o
  // por penales (PEN) NUNCA se resolvía — se quedaba para siempre sin
  // goles_local_oficial/resultado_oficial y sin pagar diamantes, aunque el
  // marcador ya estuviera cerrado hace rato. Eso es lo que hacía que
  // marcadorFinalDe() (sementomvp.jsx) nunca encontrara un resultado final
  // para esos partidos y la página de competencia lo siguiera mostrando
  // como "Hoy 20:30", como si todavía se fuera a jugar.
  const ESTADOS_FINALIZADOS_RESOLVER = ['FT', 'AET', 'PEN'];

  for (const partido of pendientes) {
    try {
      const estado = await obtenerEstadoFixture(partido.fixture_id_api);

      // API INCONSISTENTE (bug encontrado, caso O'Higgins vs Boca): la API
      // ya nos había dicho una vez que este fixture estaba en 'PEN'
      // (terminado) — así quedó guardado en estado_partido — pero al
      // volver a preguntarle HORAS después, devolvió 'P' (tanda todavía en
      // curso) de nuevo. Es un dato viejo/inconsistente del lado de
      // API-Football, no un partido que de verdad siga jugándose. Si
      // NUESTRA base ya lo tenía marcado como terminado, se confía en eso
      // en vez de quedar esperando para siempre a que la API se ponga de
      // acuerdo consigo misma.
      const yaTerminadoEnBD = ESTADOS_FINALIZADOS_RESOLVER.includes(partido.estado_partido);
      const apiConfirmaFinal = estado && ESTADOS_FINALIZADOS_RESOLVER.includes(estado.estado);

      if (!apiConfirmaFinal && !yaTerminadoEnBD) {
        // Diagnóstico (a pedido, caso O'Higgins vs Boca que se quedaba en
        // "todaviaJugando" sin ninguna pista de por qué): antes esto no
        // dejaba rastro, así que no había forma de saber si la API no
        // encontró el fixture, devolvió otro estado, o qué. Ahora queda en
        // la respuesta misma del endpoint, sin tener que ir a buscar los
        // logs de Render.
        resultado.todaviaJugando++;
        resultado.diagnostico = resultado.diagnostico || [];
        resultado.diagnostico.push({ id: partido.id, fixtureId: partido.fixture_id_api, motivo: 'estado_no_finalizado', estadoApi: estado?.estado ?? null, estadoBD: partido.estado_partido });
        continue;
      }

      // Goles: preferí el dato fresco de la API; si vino incompleto (el
      // caso de arriba, API inconsistente) cae al último marcador parcial
      // que /vivo dejó guardado — que para un partido ya terminado en
      // nuestra base es el resultado real de los 90'/alargue.
      const golesLocal = estado?.golesLocal ?? partido.marcador_parcial_local;
      const golesVisita = estado?.golesVisita ?? partido.marcador_parcial_visita;
      if (golesLocal == null || golesVisita == null) {
        // Raro: ni la API ni lo que teníamos guardado tienen marcador —
        // se reintenta en la próxima corrida en vez de resolver con datos
        // incompletos.
        resultado.todaviaJugando++;
        resultado.diagnostico = resultado.diagnostico || [];
        resultado.diagnostico.push({ id: partido.id, fixtureId: partido.fixture_id_api, motivo: 'sin_goles', estadoApi: estado?.estado ?? null, golesLocal, golesVisita });
        continue;
      }
      // Penales: mismo criterio — dato fresco de la API si lo trae, si no
      // lo que ya teníamos guardado (puede haber quedado de una corrida
      // vieja de /vivo).
      const penalesLocal = estado?.penalesLocal ?? partido.penales_local ?? null;
      const penalesVisita = estado?.penalesVisita ?? partido.penales_visita ?? null;

      const pago =
        Number(partido.categoria) === 5
          ? await resolverCat5(partido, golesLocal, golesVisita, penalesLocal, penalesVisita)
          : await resolverCat4(partido, golesLocal, golesVisita, penalesLocal, penalesVisita);

      console.log(`[/resolver] Partido ${partido.id} resuelto:`, pago);
      resultado.resueltos++;
    } catch (e) {
      console.error(`[/resolver] Error resolviendo partido ${partido.id}:`, e);
      resultado.errores.push({ id: partido.id, error: e.message });
    }
  }

  res.json(resultado);
}

module.exports = { rutaResolver };
