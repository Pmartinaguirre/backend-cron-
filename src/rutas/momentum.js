// GET /momentum?desafioId=<uuid> — devuelve la serie de snapshots de
// estadísticas que fue guardando /vivo mientras el partido estaba en curso
// (ver momentum_partido_mvp / crear_tabla_momentum.sql). Es lo que la app
// usa para armar el gráfico de "quién domina" (aproximación de momentum, ya
// que API-Football no entrega ese dato armado — ver el comentario grande en
// vivo.js sobre por qué se arma así).
//
// Mismo criterio que /equipos y /posiciones-liga: sin X-Cron-Secret, es de
// solo lectura y la llama directo el navegador del jugador.
const { supabase } = require('../supabaseClient');

async function rutaMomentum(req, res) {
  const desafioId = req.query.desafioId;
  if (!desafioId) {
    return res.status(400).json({ error: 'Falta el parámetro "desafioId".' });
  }

  const { data, error } = await supabase
    .from('momentum_partido_mvp')
    .select('minuto, minuto_extra, marcador_local, marcador_visita, estadisticas, creado_en')
    .eq('desafio_id', desafioId)
    .order('creado_en', { ascending: true });

  if (error) {
    console.error('[/momentum] Error leyendo snapshots:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ snapshots: data || [] });
}

module.exports = { rutaMomentum };
