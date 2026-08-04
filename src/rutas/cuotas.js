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
const { obtenerCuotas, obtenerEstadoFixture } = require('../apiFootball');

async function rutaCuotas(req, res) {
  const ahora = new Date();
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_VENTANA_CUOTAS);

  // Estadio + árbitro (a pedido, "Información del partido" en la app): se
  // traen JUNTO con las cuotas, en la misma corrida — mismo criterio que
  // pidió Pablo ("como 7 días antes cuando llegan las ODDS"). Por eso el
  // filtro de abajo ya no es solo "sin cuota": también entra un partido que
  // YA tiene cuota pero le sigue faltando estadio o árbitro (el árbitro en
  // particular suele confirmarse más tarde que las cuotas — con el filtro
  // viejo, ese partido dejaba de revisarse apenas llegaba la cuota y el
  // árbitro se quedaba en "No disponible" para siempre).
  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, fixture_id_api, categoria, fecha_expiracion, cuota_local, estadio, arbitro')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('fixture_id_api', 'is', null)
    .or('cuota_local.is.null,estadio.is.null,arbitro.is.null')
    .gte('fecha_expiracion', ahora.toISOString())
    .lte('fecha_expiracion', limite.toISOString());

  if (error) {
    console.error('[/cuotas] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  const resultado = { revisados: partidos.length, actualizados: 0, sinCuotaTodavia: 0, errores: [] };

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
      // Estadio/árbitro: solo se pide si falta alguno de los dos. Comparten
      // la misma llamada a /fixtures?id= que ya usa obtenerEstadoFixture
      // (la reaprovecha /vivo y /resolver), así que no es una consulta
      // nueva a la cuota de API-Football, solo un uso más de un endpoint
      // que ya existía.
      if (partido.estadio == null || partido.arbitro == null) {
        const info = await obtenerEstadoFixture(partido.fixture_id_api);
        if (info?.estadio != null) payload.estadio = info.estadio;
        if (info?.arbitro != null) payload.arbitro = info.arbitro;
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

  console.log(`[/cuotas] ${resultado.actualizados} actualizados, ${resultado.sinCuotaTodavia} sin cambios todavía, ${resultado.errores.length} errores.`);
  res.json(resultado);
}

module.exports = { rutaCuotas };
