// GET /ranking-grupo-historial?sala_id=<id>&usuario_id=<id> — a pedido: "en
// el modal de ficha de un jugador del grupo, mostrar su historial de
// diamantes del grupo". MISMA ventana de fechas y MISMO filtro por
// competencia/equipos_seguidos que /ranking-grupo (ver rankingGrupo.js) —
// así el total de este historial siempre coincide con el número que ya
// muestra la tabla de posiciones del grupo (diamantesGrupo). No se repite
// el cálculo desde cero: se copia la misma lógica, pero para UN solo
// jugador, trayendo además la fila individual (no solo la suma) — igual
// que cargarHistorialDiamantes de Perfil.jsx, pero acotado a la ventana del
// grupo.
//
// Sin exigirSecreto (mismo criterio que /ranking-grupo): de solo lectura,
// la llama directo el navegador del jugador.
const { supabase } = require('../supabaseClient');

const normEquipo = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim();

async function rutaRankingGrupoHistorial(req, res) {
  const salaId = req.query?.sala_id;
  const usuarioId = req.query?.usuario_id;
  if (!salaId || !usuarioId) {
    return res.status(400).json({ error: 'Faltan los parámetros "sala_id" y/o "usuario_id".' });
  }

  const { data: sala, error: errSala } = await supabase
    .from('salas_privadas_mvp')
    .select('id, admin_id, juego_activo, fecha_inicio_conteo, fecha_fin_conteo, competencias, equipos_seguidos')
    .eq('id', salaId)
    .single();
  if (errSala || !sala) {
    return res.status(404).json({ error: 'Grupo no encontrado.' });
  }

  // ¿Es miembro? (el admin cuenta aunque no tenga fila propia, mismo
  // criterio que rankingGrupo.js).
  let fechaUnion = null;
  if (String(sala.admin_id) === String(usuarioId)) {
    const { data: filaAdmin } = await supabase
      .from('salas_privadas_miembros_mvp')
      .select('fecha_union')
      .eq('sala_id', salaId)
      .eq('usuario_id', usuarioId)
      .maybeSingle();
    fechaUnion = filaAdmin?.fecha_union || null;
  } else {
    const { data: filaMiembro, error: errMiembro } = await supabase
      .from('salas_privadas_miembros_mvp')
      .select('fecha_union')
      .eq('sala_id', salaId)
      .eq('usuario_id', usuarioId)
      .maybeSingle();
    if (errMiembro) return res.status(500).json({ error: errMiembro.message });
    if (!filaMiembro) return res.status(404).json({ error: 'Ese jugador no es miembro de este grupo.' });
    fechaUnion = filaMiembro.fecha_union;
  }

  const fechaUnionMs = fechaUnion ? new Date(fechaUnion).getTime() : 0;
  const fechaInicioGrupoMs = new Date(sala.fecha_inicio_conteo).getTime();
  const desde = new Date(Math.max(fechaUnionMs, fechaInicioGrupoMs)).toISOString();
  const hasta = sala.juego_activo ? new Date().toISOString() : (sala.fecha_fin_conteo || new Date().toISOString());

  const { data: pagos, error: errPagos } = await supabase
    .from('diamantes_historial_mvp')
    .select('id, monto, desafio_id, motivo, fecha_creacion')
    .eq('usuario_id', usuarioId)
    .gte('fecha_creacion', desde)
    .lte('fecha_creacion', hasta)
    .order('fecha_creacion', { ascending: false })
    .limit(500);
  if (errPagos) return res.status(500).json({ error: errPagos.message });

  const idsDesafios = [...new Set((pagos || []).map((p) => p.desafio_id).filter(Boolean))];
  const desafioPorId = {};
  if (idsDesafios.length > 0) {
    const { data: desafios, error: errDesafios } = await supabase
      .from('desafios_mvp')
      .select('id, tema, pregunta, equipo_local, equipo_visitante')
      .in('id', idsDesafios);
    if (errDesafios) return res.status(500).json({ error: errDesafios.message });
    (desafios || []).forEach((d) => { desafioPorId[d.id] = d; });
  }

  // Mismo filtro por competencia/equipos_seguidos que /ranking-grupo — ver
  // el comentario largo en rankingGrupo.js sobre por qué existe.
  const competenciasGrupo = sala.competencias || [];
  const equiposSeguidosGrupo = sala.equipos_seguidos || [];
  const hayRestriccion = competenciasGrupo.length > 0 || equiposSeguidosGrupo.length > 0;
  const equiposSeguidosNorm = equiposSeguidosGrupo.map(normEquipo);

  const filas = [];
  (pagos || []).forEach((p) => {
    const d = p.desafio_id ? desafioPorId[p.desafio_id] : null;
    if (p.desafio_id && hayRestriccion && d) {
      const temaCalza = d.tema && competenciasGrupo.includes(d.tema);
      const equipoCalza = equiposSeguidosNorm.length > 0 && (
        equiposSeguidosNorm.includes(normEquipo(d.equipo_local)) ||
        equiposSeguidosNorm.includes(normEquipo(d.equipo_visitante))
      );
      if (!temaCalza && !equipoCalza) return; // no cuenta para este grupo
    }
    const motivo = d
      ? (d.equipo_local && d.equipo_visitante
          ? `${d.equipo_local} vs ${d.equipo_visitante}`
          : (d.pregunta || d.tema || p.motivo || 'Diamantes'))
      : (p.motivo || 'Diamantes');
    filas.push({ id: p.id, fecha: p.fecha_creacion, monto: p.monto, motivo });
  });

  const total = filas.reduce((acc, f) => acc + (f.monto || 0), 0);

  res.json({ salaId, usuarioId, desde, hasta, total, filas });
}

module.exports = { rutaRankingGrupoHistorial };
