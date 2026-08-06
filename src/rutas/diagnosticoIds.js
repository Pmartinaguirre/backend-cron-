// GET /diagnostico-ids?ids=id1,id2,id3 — a pedido: varios partidos de la
// fecha 2 del Clausura de Argentina que Pablo confirma que NO tienen video
// no aparecían NI en "detalle" NI en "excluidos" de /media, es decir, ni
// siquiera entraban a la consulta base (categoria=4 + tema='Primera
// División Argentina'). Esta ruta trae la fila CRUDA de esos ids puntuales
// desde desafios_mvp, para ver el valor real de categoria/tema/esta_activo
// — así se distingue un dato con typo (tema mal escrito, categoria
// distinta) de un id que directamente no existe (partido duplicado
// borrado, etc.).
//
// Sin exigirSecreto (mismo criterio que /diagnostico-cobertura y
// /diagnostico-partido): de solo lectura, pensado para pegarle directo
// desde el navegador.
const { supabase } = require('../supabaseClient');

async function rutaDiagnosticoIds(req, res) {
  const idsParam = req.query.ids;
  if (!idsParam) {
    return res.status(400).json({ error: 'Falta el parámetro "ids" (separados por coma).' });
  }
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);

  const { data, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, tema, subtema, categoria, esta_activo, media_video_url, media_video_corregido, goles_local_oficial, goles_visitante_oficial, fecha_expiracion, equipo_local, equipo_visitante')
    .in('id', ids);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const encontrados = (data || []).map((d) => d.id);
  const noEncontrados = ids.filter((id) => !encontrados.includes(id));

  res.json({
    pedidos: ids.length,
    encontrados: data?.length || 0,
    // Si un id queda acá, la fila NO existe en desafios_mvp con ese id
    // exacto (borrada, o el id que Pablo tiene en su planilla ya no es el
    // vigente — por ejemplo si el partido se recreó).
    idsQueNoExisten: noEncontrados,
    partidos: data || [],
  });
}

module.exports = { rutaDiagnosticoIds };
