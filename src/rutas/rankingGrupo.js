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
    .select('id, nombre')
    .in('id', idsUnicos);
  if (errUsuarios) {
    return res.status(500).json({ error: errUsuarios.message });
  }
  const nombrePorId = {};
  (usuarios || []).forEach((u) => { nombrePorId[u.id] = u.nombre; });

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

  const jugadores = idsUnicos
    .map((id) => ({
      usuarioId: id,
      nombre: nombrePorId[id] || 'Jugador',
      diamantesGrupo: sumaPorUsuario[id] || 0,
      desde: inicioPorUsuario[id],
    }))
    .sort((a, b) => b.diamantesGrupo - a.diamantesGrupo);

  // Posición de cada uno (empate = misma posición, mismo criterio que ya
  // usa el resto de la app).
  jugadores.forEach((j, i) => {
    j.posicion = jugadores.filter((x) => x.diamantesGrupo > j.diamantesGrupo).length + 1;
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
