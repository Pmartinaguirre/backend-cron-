// GET/POST /cuotas — mismo trabajo que hacía actualizar_cuotas.js a mano:
// busca partidos Cat.4/5 activos sin cuota guardada, les pide la cuota
// "Match Winner" a API-Football, y guarda cuota_local/empate/visita.
// Idempotente: los partidos que ya tienen cuota se saltan siempre, así que
// no hay problema en llamarlo seguido (ej. cada 30-60 min).
const { supabase } = require('../supabaseClient');
const { obtenerCuotas } = require('../apiFootball');

async function rutaCuotas(req, res) {
  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, fixture_id_api, categoria')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .is('cuota_local', null)
    .not('fixture_id_api', 'is', null);

  if (error) {
    console.error('[/cuotas] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  const resultado = { revisados: partidos.length, actualizados: 0, sinCuotaTodavia: 0, errores: [] };

  for (const partido of partidos) {
    try {
      const cuotas = await obtenerCuotas(partido.fixture_id_api);
      if (!cuotas) {
        resultado.sinCuotaTodavia++;
        continue;
      }
      const { error: errUpdate } = await supabase
        .from('desafios_mvp')
        .update({
          cuota_local: cuotas.cuota_local,
          cuota_empate: cuotas.cuota_empate,
          cuota_visita: cuotas.cuota_visita,
        })
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

  console.log(`[/cuotas] ${resultado.actualizados} actualizados, ${resultado.sinCuotaTodavia} sin cuota todavía, ${resultado.errores.length} errores.`);
  res.json(resultado);
}

module.exports = { rutaCuotas };
