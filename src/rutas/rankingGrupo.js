// GET /ranking-grupo?sala_id=<id> — a pedido: "cada jugador parte de cero
// diamantes en el grupo desde su fecha de ingreso. El grupo cuando se crea
// parte por default en 'En Juego': las apuestas de los jugadores a partir
// de ese minuto valen diamantes para el grupo. El admin puede parar el
// juego o programar el inicio para el día X. Los jugadores desde que se
// registran ganan sus diamantes igual (eso no se toca, sigue en el ranking
// general) — pero la tabla DEL GRUPO solo cuenta lo ganado durante la
// ventana en que el grupo estuvo en juego, desde que cada uno se sumó."
//
// Centralizado ACÁ (en vez de repetir el cálculo en MisGrupos.jsx,
// sementomvp.jsx y la lista de Mis Grupos) para que los 3 lugares que
// muestran "tu posición en el grupo" usen siempre el mismo número — ver
// agregar_estado_juego_grupo.sql y agregar_ganador_semanal_y_historial_
// diamantes.sql para las tablas/columnas que esto necesita.
//
// Sin exigirSecreto (mismo criterio que /equipos, /posiciones-liga): de
// solo lectura, lo llama directo el navegador del jugador.
const { supabase } = require('../supabaseClient');
const { parsearMarcador } = require('../diamantes');

// Orden de la tabla de posiciones del grupo (a pedido: "ante igualdad de
// puntos pon primero a los que tengan más marcador exacto, luego dif, luego
// PA y luego PJ") — desempate en cascada: 💎 diamantesGrupo, luego EX
// (marcador exacto), luego DG (diferencia de gol), luego PA (acertó
// ganador/empate), luego PJ (partidos jugados) como último criterio.
function compararJugadoresGrupo(a, b) {
  return (b.diamantesGrupo - a.diamantesGrupo)
    || (b.ex - a.ex)
    || (b.dg - a.dg)
    || (b.pa - a.pa)
    || (b.pj - a.pj);
}

async function rutaRankingGrupo(req, res) {
  const salaId = req.query?.sala_id;
  if (!salaId) {
    return res.status(400).json({ error: 'Falta el parámetro "sala_id".' });
  }

  const { data: sala, error: errSala } = await supabase
    .from('salas_privadas_mvp')
    .select('id, nombre, admin_id, juego_activo, fecha_inicio_conteo, fecha_fin_conteo, competencias, equipos_seguidos')
    .eq('id', salaId)
    .single();
  if (errSala || !sala) {
    return res.status(404).json({ error: 'Grupo no encontrado.' });
  }

  const { data: miembrosData, error: errMiembros } = await supabase
    .from('salas_privadas_miembros_mvp')
    .select('usuario_id, fecha_union')
    .eq('sala_id', salaId);
  if (errMiembros) {
    return res.status(500).json({ error: errMiembros.message });
  }

  // El admin cuenta como miembro aunque no tenga fila en
  // salas_privadas_miembros_mvp (mismo criterio que ya usa MisGrupos.jsx
  // para la tabla de posiciones) — si no tiene fecha_union propia, usa la
  // fecha de inicio del grupo.
  const miembros = [...miembrosData || []];
  if (sala.admin_id && !miembros.some((m) => m.usuario_id === sala.admin_id)) {
    miembros.push({ usuario_id: sala.admin_id, fecha_union: null });
  }
  const idsUnicos = [...new Set(miembros.map((m) => m.usuario_id))];
  if (idsUnicos.length === 0) {
    return res.json({ salaId, juegoActivo: sala.juego_activo, fechaInicioGrupo: sala.fecha_inicio_conteo, fechaFinGrupo: sala.fecha_fin_conteo, jugadores: [] });
  }

  const { data: usuarios, error: errUsuarios } = await supabase
    .from('usuarios')
    .select('id, nombre, avatar_url')
    .in('id', idsUnicos);
  if (errUsuarios) {
    return res.status(500).json({ error: errUsuarios.message });
  }
  const nombrePorId = {};
  const avatarUrlPorId = {};
  (usuarios || []).forEach((u) => { nombrePorId[u.id] = u.nombre; avatarUrlPorId[u.id] = u.avatar_url || null; });

  // Fin de la ventana: si el grupo está pausado, fecha_fin_conteo (quedó
  // congelado ahí); si está en juego, ahora mismo.
  const finVentana = sala.juego_activo ? new Date().toISOString() : (sala.fecha_fin_conteo || new Date().toISOString());

  // Inicio POR JUGADOR: el más tardío entre "cuándo arrancó a contar el
  // grupo" y "cuándo se sumó este jugador al grupo" — así alguien que entra
  // después no se lleva diamantes de partidos anteriores a que existiera
  // para el grupo, y alguien que ya estaba antes de que el grupo arrancara
  // a contar tampoco se lleva diamantes de antes de esa fecha.
  const inicioPorUsuario = {};
  miembros.forEach((m) => {
    const fechaUnion = m.fecha_union ? new Date(m.fecha_union).getTime() : 0;
    const fechaInicioGrupo = new Date(sala.fecha_inicio_conteo).getTime();
    inicioPorUsuario[m.usuario_id] = new Date(Math.max(fechaUnion, fechaInicioGrupo)).toISOString();
  });

  // Trae TODO el historial de estos jugadores desde el inicio más temprano
  // de cualquiera de ellos, y filtra el resto en JS por jugador — más
  // simple que 1 query por jugador, y estos historiales no son enormes.
  const inicioMasTemprano = Object.values(inicioPorUsuario).sort()[0];
  const { data: historial, error: errHist } = await supabase
    .from('diamantes_historial_mvp')
    .select('usuario_id, monto, fecha_creacion, desafio_id')
    .in('usuario_id', idsUnicos)
    .gte('fecha_creacion', inicioMasTemprano)
    .lte('fecha_creacion', finVentana);
  if (errHist) {
    return res.status(500).json({ error: errHist.message });
  }

  // FILTRO POR COMPETENCIA/EQUIPOS DEL GRUPO (a pedido, bug reportado: "creé
  // un grupo hoy que juega solo la liga chilena y ya tengo 5 puntos, sin que
  // se haya jugado ningún partido de esa liga todavía"). Antes esto sumaba
  // TODO el historial de diamantes del jugador dentro de la ventana de
  // fechas, sin mirar a qué competencia pertenecía cada pago — un diamante
  // ganado hoy en OTRA liga (o en otro grupo) contaba igual acá, con tal de
  // que la fecha cayera dentro de la ventana.
  //
  // BUG #2 corregido (a pedido, reportado con el grupo "Vamos UC" — solo
  // sigue a Universidad Católica vía `equipos_seguidos`, sin ninguna
  // competencia marcada en `competencias`): el filtro de acá SOLO miraba
  // `competencias`, nunca `equipos_seguidos` — así que un grupo que solo
  // sigue equipos sueltos (competencias = []) caía en "sin restricción,
  // cuenta todo" en vez de "restringido a los partidos de esos equipos". Un
  // diamante ganado en OTRO partido de OTRA competencia (ej. Copa
  // Libertadores, cuando el grupo solo sigue a la UC en el torneo local)
  // contaba igual, apareciendo en la tabla de posiciones del grupo sin
  // corresponder.
  //
  // Regla nueva: un pago cuenta si...
  //   a) no está atado a ningún partido (desafio_id NULL — diamante a mano
  //      por un admin, sin partido asociado), o
  //   b) el partido pertenece a una de las competencias del grupo, o
  //   c) juega alguno de los equipos sueltos que sigue el grupo
  //      (`equipos_seguidos`, independiente de la competencia — mismo
  //      criterio que `esDeMisGrupos` en sementomvp.jsx).
  // Si el grupo NO tiene NI competencias NI equipos_seguidos configurados
  // (grupo sin ninguna restricción, ej. "Jugar todo"), no se filtra nada —
  // eso sigue igual que antes.
  const idsDesafiosReferenciados = [...new Set((historial || []).map((h) => h.desafio_id).filter(Boolean))];
  const desafioPorId = {};
  if (idsDesafiosReferenciados.length > 0) {
    const { data: desafiosRef, error: errDesafiosRef } = await supabase
      .from('desafios_mvp')
      .select('id, tema, equipo_local, equipo_visitante')
      .in('id', idsDesafiosReferenciados);
    if (errDesafiosRef) {
      return res.status(500).json({ error: errDesafiosRef.message });
    }
    (desafiosRef || []).forEach((d) => { desafioPorId[d.id] = d; });
  }
  const competenciasGrupo = sala.competencias || [];
  const equiposSeguidosGrupo = sala.equipos_seguidos || [];
  const hayRestriccion = competenciasGrupo.length > 0 || equiposSeguidosGrupo.length > 0;
  const normEquipo = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
  const equiposSeguidosNorm = equiposSeguidosGrupo.map(normEquipo);

  const sumaPorUsuario = {};
  idsUnicos.forEach((id) => { sumaPorUsuario[id] = 0; });
  (historial || []).forEach((h) => {
    const desde = inicioPorUsuario[h.usuario_id];
    if (!desde || h.fecha_creacion < desde) return;
    if (h.desafio_id && hayRestriccion) {
      const d = desafioPorId[h.desafio_id];
      // Si el desafío referenciado no se pudo cargar, se cuenta igual
      // (mejor sumar de más un caso raro que restarle diamantes reales a un
      // jugador por un dato faltante).
      if (d) {
        const temaCalza = d.tema && competenciasGrupo.includes(d.tema);
        const equipoCalza = equiposSeguidosNorm.length > 0 && (
          equiposSeguidosNorm.includes(normEquipo(d.equipo_local)) ||
          equiposSeguidosNorm.includes(normEquipo(d.equipo_visitante))
        );
        if (!temaCalza && !equipoCalza) return;
      }
    }
    sumaPorUsuario[h.usuario_id] = (sumaPorUsuario[h.usuario_id] || 0) + (h.monto || 0);
  });

  // PJ/PA/DG/EX/REN — a pedido: "en los grupos, cuando muestra la tabla de
  // posiciones del grupo agrega todas las columnas de la tabla ranking (PJ,
  // PA, DG, EX, REN y diamantes)". MISMA lógica que statsPorUsuario en
  // sementomvp.jsx (Ranking global, ver comentario grande ahí): PJ = partido
  // ya resuelto con pronóstico hecho; PA = acertó ganador/empate; DG =
  // además acertó la diferencia de gol (solo Cat.4, tiene marcador); EX =
  // además acertó el marcador exacto (solo Cat.4). Se aplica la MISMA
  // ventana por jugador (inicioPorUsuario/finVentana) y el MISMO filtro de
  // competencia/equipos_seguidos (hayRestriccion) que ya se usa arriba para
  // los diamantes, así todas las columnas de esta tabla salen de la misma
  // regla del grupo. predicciones_mvp no tiene fecha_creacion propia (el
  // insert de votos no la guarda) — la ventana se mira contra
  // desafio.fecha_expiracion (fecha del partido), igual que hace el
  // Ranking global.
  const { data: votos, error: errVotos } = await supabase
    .from('predicciones_mvp')
    .select('usuario_id, desafio_id, eleccion, respuesta_extra')
    .in('usuario_id', idsUnicos);
  if (errVotos) {
    return res.status(500).json({ error: errVotos.message });
  }

  const idsDesafiosVotos = [...new Set((votos || []).map((v) => v.desafio_id).filter(Boolean))];
  const desafioStatsPorId = {};
  if (idsDesafiosVotos.length > 0) {
    const { data: desafiosVotos, error: errDesafiosVotos } = await supabase
      .from('desafios_mvp')
      .select('id, categoria, es_general, tema, equipo_local, equipo_visitante, fecha_expiracion, resultado_oficial, goles_local_oficial, goles_visitante_oficial')
      .in('id', idsDesafiosVotos);
    if (errDesafiosVotos) {
      return res.status(500).json({ error: errDesafiosVotos.message });
    }
    (desafiosVotos || []).forEach((d) => { desafioStatsPorId[d.id] = d; });
  }

  const statsPorUsuario = {};
  const obtenerStats = (uid) => {
    if (!statsPorUsuario[uid]) statsPorUsuario[uid] = { pj: 0, pa: 0, dg: 0, ex: 0 };
    return statsPorUsuario[uid];
  };
  (votos || []).forEach((v) => {
    const desafio = desafioStatsPorId[v.desafio_id];
    if (!desafio || desafio.es_general) return;
    const cat = Number(desafio.categoria) || 1;
    if (cat !== 4 && cat !== 5) return;

    const desde = inicioPorUsuario[v.usuario_id];
    if (!desde || !desafio.fecha_expiracion || desafio.fecha_expiracion < desde || desafio.fecha_expiracion > finVentana) return;

    if (hayRestriccion) {
      const temaCalza = desafio.tema && competenciasGrupo.includes(desafio.tema);
      const equipoCalza = equiposSeguidosNorm.length > 0 && (
        equiposSeguidosNorm.includes(normEquipo(desafio.equipo_local)) ||
        equiposSeguidosNorm.includes(normEquipo(desafio.equipo_visitante))
      );
      if (!temaCalza && !equipoCalza) return;
    }

    const resueltoCat4 = cat === 4 && desafio.goles_local_oficial != null && desafio.goles_visitante_oficial != null;
    const resueltoCat5 = cat === 5 && !!desafio.resultado_oficial;
    if (!resueltoCat4 && !resueltoCat5) return;

    const stats = obtenerStats(v.usuario_id);
    stats.pj += 1;

    if (resueltoCat5) {
      if (v.eleccion === desafio.resultado_oficial) stats.pa += 1;
      return;
    }

    const marcador = parsearMarcador(v.respuesta_extra);
    if (!marcador) return;
    const realLocal = Number(desafio.goles_local_oficial);
    const realVisita = Number(desafio.goles_visitante_oficial);
    const signoPred = Math.sign(marcador[0] - marcador[1]);
    const signoReal = Math.sign(realLocal - realVisita);
    if (signoPred !== signoReal) return;
    stats.pa += 1;
    if ((marcador[0] - marcador[1]) !== (realLocal - realVisita)) return;
    stats.dg += 1;
    if (marcador[0] === realLocal && marcador[1] === realVisita) stats.ex += 1;
  });

  const jugadores = idsUnicos
    .map((id) => {
      const s = statsPorUsuario[id] || { pj: 0, pa: 0, dg: 0, ex: 0 };
      return {
        usuarioId: id,
        nombre: nombrePorId[id] || 'Jugador',
        avatarUrl: avatarUrlPorId[id] || null,
        diamantesGrupo: sumaPorUsuario[id] || 0,
        desde: inicioPorUsuario[id],
        pj: s.pj,
        pa: s.pa,
        dg: s.dg,
        ex: s.ex,
        ren: s.pj > 0 ? Math.round((s.pa / s.pj) * 100) : 0,
      };
    })
    .sort(compararJugadoresGrupo);

  // Posición de cada uno (empate = misma posición) — usa el MISMO criterio
  // de desempate que el orden de arriba (compararJugadoresGrupo), así un
  // jugador solo comparte posición con otro si de verdad están empatados en
  // los 5 criterios, no solo en diamantes.
  jugadores.forEach((j) => {
    j.posicion = jugadores.filter((x) => compararJugadoresGrupo(x, j) < 0).length + 1;
  });

  res.json({
    salaId,
    juegoActivo: sala.juego_activo,
    fechaInicioGrupo: sala.fecha_inicio_conteo,
    fechaFinGrupo: sala.fecha_fin_conteo,
    total: jugadores.length,
    jugadores,
  });
}

module.exports = { rutaRankingGrupo };
