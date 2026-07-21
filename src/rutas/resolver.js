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
const {
  cuotaDelResultado,
  calcularDiamantesPorCuota,
  calcularDiamantesCat4,
  parsearMarcador,
  construirTextoLEV,
  signoDeGoles,
} = require('../diamantes');

const DIAMANTES_BASE_SIN_CUOTA = 120; // mismo fallback que en sementomvp.jsx

async function resolverCat5(partido, golesLocal, golesVisita) {
  const respuestaGanadora = construirTextoLEV(partido.equipo_local, partido.equipo_visitante, golesLocal, golesVisita);

  await supabase.from('desafios_mvp').update({ resultado_oficial: respuestaGanadora }).eq('id', partido.id);

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

async function resolverCat4(partido, golesLocal, golesVisita) {
  await supabase
    .from('desafios_mvp')
    .update({ goles_local_oficial: golesLocal, goles_visitante_oficial: golesVisita })
    .eq('id', partido.id);

  const { data: predicciones, error } = await supabase
    .from('predicciones_mvp')
    .select('usuario_id, respuesta_extra')
    .eq('desafio_id', partido.id);
  if (error) throw error;

  let pagados = 0;
  for (const p of predicciones || []) {
    const marcador = parsearMarcador(p.respuesta_extra);
    if (!marcador) continue;
    const monto = calcularDiamantesCat4(marcador[0], marcador[1], golesLocal, golesVisita, partido);
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
      'id, categoria, fixture_id_api, equipo_local, equipo_visitante, cuota_local, cuota_empate, cuota_visita, resultado_oficial, goles_local_oficial, fecha_expiracion'
    )
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('fixture_id_api', 'is', null)
    .lte('fecha_expiracion', ahoraISO);

  if (error) {
    console.error('[/resolver] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  const pendientes = (partidos || []).filter((p) =>
    Number(p.categoria) === 5 ? !p.resultado_oficial : p.goles_local_oficial == null
  );

  const resultado = { revisados: pendientes.length, resueltos: 0, todaviaJugando: 0, errores: [] };

  for (const partido of pendientes) {
    try {
      const estado = await obtenerEstadoFixture(partido.fixture_id_api);
      if (!estado || estado.estado !== 'FT') {
        resultado.todaviaJugando++;
        continue;
      }
      if (estado.golesLocal == null || estado.golesVisita == null) {
        // Raro: la API dice FT pero no trae marcador todavía — se reintenta
        // en la próxima corrida en vez de resolver con datos incompletos.
        resultado.todaviaJugando++;
        continue;
      }

      const pago =
        Number(partido.categoria) === 5
          ? await resolverCat5(partido, estado.golesLocal, estado.golesVisita)
          : await resolverCat4(partido, estado.golesLocal, estado.golesVisita);

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
