// GET /ranking-grupo-historial?sala_id=<id>&usuario_id=<id> — a pedido: "en
// el modal de ficha de un jugador del grupo, corrige el Historial de
// diamantes del grupo: hazlo tabla con fecha, partido, tipo de acierto
// (LEV/DIF/EXA) y diamantes ganados, con TODAS sus apuestas del grupo —
// cuando ganó o cuando no ganó diamantes — en orden por fecha". Antes esto
// solo traía diamantes_historial_mvp (pagos), es decir solo las jugadas
// GANADORAS. Ahora recorre predicciones_mvp (TODOS los votos del jugador,
// ganados y perdidos) con la MISMA ventana de fechas y el MISMO filtro por
// competencia/equipos_seguidos que /ranking-grupo (ver rankingGrupo.js) —
// así el total de diamantes de este historial siempre coincide con
// diamantesGrupo — y clasifica cada pronóstico resuelto con la misma lógica
// que statsPorUsuario en sementomvp.jsx (Ranking global): LEV = acertó
// ganador/empate, DIF = además acertó la diferencia de gol (solo Cat.4),
// EXA = además acertó el marcador exacto (solo Cat.4).
//
// Sin exigirSecreto (mismo criterio que /ranking-grupo): de solo lectura,
// la llama directo el navegador del jugador.
const { supabase } = require('../supabaseClient');
const { parsearMarcador } = require('../diamantes');

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
    .select('id, admin_id, juego_activo, fecha_inicio_conteo, fecha_fin_conteo, competencias, equipos_seguidos, modo_competencias, competencias_fechas')
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

  // Mismo filtro por competencia/equipos_seguidos que /ranking-grupo — ver
  // el comentario largo en rankingGrupo.js sobre por qué existe.
  const competenciasGrupo = sala.competencias || [];
  const equiposSeguidosGrupo = sala.equipos_seguidos || [];
  const hayRestriccion = competenciasGrupo.length > 0 || equiposSeguidosGrupo.length > 0;
  const equiposSeguidosNorm = equiposSeguidosGrupo.map(normEquipo);

  // "Solo partidos destacados" (mismo fix que /ranking-grupo — bug
  // reportado: "el partido Everton vs U. de Concepción no debería contar,
  // ese grupo solo sigue los partidos destacados"). modo_competencias
  // (tema -> 'todos' | 'tier_a') no se estaba mirando acá tampoco.
  const modoCompetencias = sala.modo_competencias || {};
  const competenciasTierA = competenciasGrupo.filter((c) => modoCompetencias[c] === 'tier_a');
  const equiposTierAPorCompetencia = {};
  if (competenciasTierA.length > 0) {
    const { data: tierAData, error: errTierA } = await supabase
      .from('equipos_tier_a_mvp')
      .select('competencia, equipo')
      .in('competencia', competenciasTierA);
    if (errTierA) return res.status(500).json({ error: errTierA.message });
    (tierAData || []).forEach((fila) => {
      if (!equiposTierAPorCompetencia[fila.competencia]) equiposTierAPorCompetencia[fila.competencia] = [];
      equiposTierAPorCompetencia[fila.competencia].push(fila.equipo);
    });
  }
  const esPartidoDestacado = (d) => {
    if (d?.es_destacado) return true;
    const listaTierA = (d?.tema && equiposTierAPorCompetencia[d.tema]) || [];
    if (listaTierA.length === 0) return false;
    const equipos = [d?.equipo_local, d?.equipo_visitante].filter(Boolean).map((e) => e.toLowerCase());
    const fase = String(d?.subtema || '').trim().toLowerCase();
    const coincideEquipo = equipos.some((eq) => listaTierA.some((t) => eq.includes(t.toLowerCase())));
    const coincideFase = fase && listaTierA.some((t) => fase.includes(t.toLowerCase()));
    return coincideEquipo || coincideFase;
  };
  // "No retroactivo" (a pedido: "si yo edito las competencias es para
  // adelante en el tiempo, no retroactivo" — mismo fix que rankingGrupo.js/
  // ganadorSemanal.js, ver el comentario grande ahí).
  const competenciasFechas = sala.competencias_fechas || {};
  const fechaValidaParaTema = (tema, fechaComparar) => {
    const fechaAlta = competenciasFechas[tema];
    if (!fechaAlta || !fechaComparar) return true;
    return new Date(fechaComparar).getTime() >= new Date(fechaAlta).getTime();
  };
  const temaCalzaConGrupo = (d, fechaComparar) => {
    if (!d?.tema || !competenciasGrupo.includes(d.tema)) return false;
    if (modoCompetencias[d.tema] === 'tier_a' && !esPartidoDestacado(d)) return false;
    if (!fechaValidaParaTema(d.tema, fechaComparar)) return false;
    return true;
  };

  // Diamantes REALES pagados por partido (para no recalcular el monto con
  // una fórmula — mismo motivo que en rankingGrupo.js: un reset de
  // diamantes no debe volver a aparecer acá). resolver.js paga como máximo
  // UNA vez por (usuario, desafío), así que alcanza con el último monto por
  // desafio_id. Los pagos SIN desafio_id (bono a mano de un admin, sin
  // partido asociado) no son una "apuesta" — se listan aparte, al final.
  const { data: pagos, error: errPagos } = await supabase
    .from('diamantes_historial_mvp')
    .select('id, monto, desafio_id, motivo, fecha_creacion')
    .eq('usuario_id', usuarioId)
    .gte('fecha_creacion', desde)
    .lte('fecha_creacion', hasta);
  if (errPagos) return res.status(500).json({ error: errPagos.message });

  const montoPorDesafio = {};
  const bonosSinDesafio = [];
  (pagos || []).forEach((p) => {
    if (p.desafio_id) {
      montoPorDesafio[p.desafio_id] = (montoPorDesafio[p.desafio_id] || 0) + (p.monto || 0);
    } else {
      bonosSinDesafio.push({ id: `bono-${p.id}`, fecha: p.fecha_creacion, partido: p.motivo || 'Diamantes', equipoLocal: null, equipoVisitante: null, tipoAcierto: [], diamantes: p.monto || 0, esApuesta: false });
    }
  });

  // TODAS las predicciones del jugador (ganadas y perdidas) — predicciones_
  // mvp no tiene fecha_creacion propia (el insert de votos no la guarda),
  // así que la ventana/orden se filtra por desafio.fecha_expiracion.
  const { data: votos, error: errVotos } = await supabase
    .from('predicciones_mvp')
    .select('id, desafio_id, eleccion, respuesta_extra')
    .eq('usuario_id', usuarioId);
  if (errVotos) return res.status(500).json({ error: errVotos.message });

  const idsDesafios = [...new Set((votos || []).map((v) => v.desafio_id).filter(Boolean))];
  const desafioPorId = {};
  if (idsDesafios.length > 0) {
    const { data: desafios, error: errDesafios } = await supabase
      .from('desafios_mvp')
      .select('id, categoria, es_general, tema, subtema, equipo_local, equipo_visitante, es_destacado, fecha_expiracion, resultado_oficial, goles_local_oficial, goles_visitante_oficial')
      .in('id', idsDesafios);
    if (errDesafios) return res.status(500).json({ error: errDesafios.message });
    (desafios || []).forEach((d) => { desafioPorId[d.id] = d; });
  }

  const filas = [];
  (votos || []).forEach((v) => {
    const desafio = desafioPorId[v.desafio_id];
    if (!desafio || desafio.es_general) return;
    const cat = Number(desafio.categoria) || 1;
    if (cat !== 4 && cat !== 5) return;
    if (!desafio.fecha_expiracion || desafio.fecha_expiracion < desde || desafio.fecha_expiracion > hasta) return;

    if (hayRestriccion) {
      const temaCalza = temaCalzaConGrupo(desafio, desafio.fecha_expiracion);
      const equipoCalza = equiposSeguidosNorm.length > 0 && (
        equiposSeguidosNorm.includes(normEquipo(desafio.equipo_local)) ||
        equiposSeguidosNorm.includes(normEquipo(desafio.equipo_visitante))
      );
      if (!temaCalza && !equipoCalza) return;
    }

    const resueltoCat4 = cat === 4 && desafio.goles_local_oficial != null && desafio.goles_visitante_oficial != null;
    const resueltoCat5 = cat === 5 && !!desafio.resultado_oficial;
    if (!resueltoCat4 && !resueltoCat5) return; // partido aún no resuelto, no cuenta como jugada en el historial

    // equipoLocal/equipoVisitante SEPARADOS (a pedido: "columna 2 fila 1:
    // Equipo A, columna 2 fila 2: Equipo B") — antes se mandaba un solo
    // string "Local vs Visita" y el frontend lo truncaba con "..." al no
    // caber en una línea. partido (combinado) se deja también, solo como
    // fallback para los bonos sin desafío asociado (ver bonosSinDesafio).
    const partido = desafio.equipo_local && desafio.equipo_visitante
      ? `${desafio.equipo_local} vs ${desafio.equipo_visitante}`
      : (desafio.tema || 'Partido');

    // Tipo de acierto, en orden LEV / DIF / EXA (solo los que aplican).
    const tipoAcierto = [];
    if (resueltoCat5) {
      if (v.eleccion === desafio.resultado_oficial) tipoAcierto.push('LEV');
    } else {
      const marcador = parsearMarcador(v.respuesta_extra);
      if (marcador) {
        const realLocal = Number(desafio.goles_local_oficial);
        const realVisita = Number(desafio.goles_visitante_oficial);
        const signoPred = Math.sign(marcador[0] - marcador[1]);
        const signoReal = Math.sign(realLocal - realVisita);
        if (signoPred === signoReal) {
          tipoAcierto.push('LEV');
          if ((marcador[0] - marcador[1]) === (realLocal - realVisita)) {
            tipoAcierto.push('DIF');
            if (marcador[0] === realLocal && marcador[1] === realVisita) tipoAcierto.push('EXA');
          }
        }
      }
    }

    // Marcador real + apuesta del jugador (a pedido: "saca el vs y agrega
    // el marcador real... y pones (tú: 3-1)") — antes esta fila solo traía
    // tipoAcierto (LEV/DIF/EXA), sin los números reales para armar ese
    // formato en el frontend.
    const marcadorApostado = !resueltoCat5 ? parsearMarcador(v.respuesta_extra) : null;

    filas.push({
      id: v.id,
      fecha: desafio.fecha_expiracion,
      tema: desafio.tema || null,
      partido,
      equipoLocal: desafio.equipo_local || null,
      equipoVisitante: desafio.equipo_visitante || null,
      golesLocalOficial: resueltoCat4 ? Number(desafio.goles_local_oficial) : null,
      golesVisitaOficial: resueltoCat4 ? Number(desafio.goles_visitante_oficial) : null,
      resultadoOficial: resueltoCat5 ? desafio.resultado_oficial : null,
      tuApuesta: marcadorApostado ? `${marcadorApostado[0]}-${marcadorApostado[1]}` : (v.eleccion || null),
      tipoAcierto,
      diamantes: montoPorDesafio[v.desafio_id] || 0,
      esApuesta: true,
    });
  });

  const todasLasFilas = [...filas, ...bonosSinDesafio].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  const total = todasLasFilas.reduce((acc, f) => acc + (f.diamantes || 0), 0);

  res.json({ salaId, usuarioId, desde, hasta, total, filas: todasLasFilas });
}

module.exports = { rutaRankingGrupoHistorial };
