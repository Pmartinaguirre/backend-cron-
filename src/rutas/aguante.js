// "El Aguante" — nuevo modo de juego de grupo (a pedido, alternativa a la
// Polla de siempre): cada jugador elige UN equipo por semana (de la
// competencia única que definió el grupo, ver aguante_competencia en
// salas_privadas_mvp) y sobrevive mientras ese equipo no pierda (empate
// cuenta como sobrevivir). Dos vidas: la primera derrota (o no elegir a
// tiempo) quema una vida y sigue jugando; la segunda lo elimina del todo.
// No se puede repetir un equipo ya elegido antes, para siempre. Gana quien
// quede en pie al final.
//
// Tres rutas en este archivo:
//   GET  /aguante-estado   — arma la pantalla del jugador (vidas, quién
//                            sigue vivo, equipos ya usados, mi elección de
//                            esta semana). Solo lectura, sin secreto.
//   POST /aguante-elegir   — el jugador elige su equipo de la semana. Sin
//                            secreto (autorización adentro, mismo patrón
//                            que /invitar-a-grupo), CORS igual que esa ruta.
//   GET  /aguante-resolver — cron semanal (mismo horario que
//                            /ganador-semanal): resuelve la semana recién
//                            cerrada para todos los grupos en modo Aguante.
//                            Con X-Cron-Secret.
const { supabase } = require('../supabaseClient');
const { obtenerEquiposDeLiga } = require('../apiFootball');
const { TEMPORADA, leagueIdDeCompetencia } = require('../ligas');

// Misma numeración/grilla de semana que ganadorSemanal.js/rankingGrupo.js —
// tiene que coincidir siempre con esos dos y con sementomvp.jsx.
const MS_SEMANA = 7 * 24 * 60 * 60 * 1000;
const ANCLA_MARTES_GRILLA = new Date('2026-07-21T04:00:00.000Z').getTime();
function numeroSemanaISOde(fechaMediodiaUTC) {
  const dUTC = new Date(fechaMediodiaUTC);
  const diaISO = (dUTC.getUTCDay() + 6) % 7;
  dUTC.setUTCDate(dUTC.getUTCDate() - diaISO + 3);
  const primerJueves = new Date(Date.UTC(dUTC.getUTCFullYear(), 0, 4));
  const diaPrimerJueves = (primerJueves.getUTCDay() + 6) % 7;
  primerJueves.setUTCDate(primerJueves.getUTCDate() - diaPrimerJueves + 3);
  return 1 + Math.round((dUTC - primerJueves) / (7 * 24 * 60 * 60 * 1000));
}
function martesAperturaMasCercano(t) {
  const semanasDesdeAncla = Math.floor((t - ANCLA_MARTES_GRILLA) / MS_SEMANA);
  return ANCLA_MARTES_GRILLA + semanasDesdeAncla * MS_SEMANA;
}
const numeroSemanaDe = (t) => {
  const inicio = martesAperturaMasCercano(t);
  const lunesCierre = inicio + 6 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
  return numeroSemanaISOde(lunesCierre);
};
const rangoDeSemana = (n) => {
  let inicio = martesAperturaMasCercano(Date.now());
  let intento = numeroSemanaDe(inicio);
  let guardia = 0;
  while (intento !== n && guardia < 60) {
    inicio += (n > intento ? 1 : -1) * MS_SEMANA;
    intento = numeroSemanaDe(inicio);
    guardia++;
  }
  return { inicio, fin: inicio + MS_SEMANA };
};

// Partidos de la "fecha" (ronda) VIGENTE de una competencia, dentro de la
// ventana de la semana en juego (a pedido, bug reportado: filtrar solo por
// rango de fechas dejaba colarse partidos REPROGRAMADOS de una fecha
// anterior que por casualidad caían en la misma semana — ej. un equipo
// terminaba "jugando dos veces" esa semana, una por su partido real de la
// fecha 21 y otra por un partido pendiente reprogramado de la fecha 15).
// Se identifica la ronda vigente como la que tiene MÁS partidos esa semana
// (`subtema` guarda el nombre de ronda que trae API-Football, ej. "Regular
// Season - 21") — un partido reprogramado suelto es un outlier de a uno
// contra el resto de una ronda completa, así que el conteo lo descarta solo.
async function partidosDeLaRondaVigente(competencia, inicio, fin) {
  const { data } = await supabase
    .from('desafios_mvp')
    .select('id, equipo_local, equipo_visitante, fecha_expiracion, subtema, goles_local_oficial, goles_visitante_oficial, resultado_oficial')
    .eq('tema', competencia)
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .gte('fecha_expiracion', new Date(inicio).toISOString())
    .lt('fecha_expiracion', new Date(fin).toISOString())
    .order('fecha_expiracion', { ascending: true });
  const partidos = data || [];
  const conteoPorRonda = {};
  partidos.forEach((p) => {
    const ronda = p.subtema || '';
    conteoPorRonda[ronda] = (conteoPorRonda[ronda] || 0) + 1;
  });
  let rondaVigente = null;
  let maxConteo = 0;
  Object.entries(conteoPorRonda).forEach(([ronda, conteo]) => {
    if (conteo > maxConteo) { maxConteo = conteo; rondaVigente = ronda; }
  });
  return rondaVigente == null ? partidos : partidos.filter((p) => (p.subtema || '') === rondaVigente);
}

// ============================================================
// GET /aguante-estado?sala_id=...&usuario_id=...
// ============================================================
async function rutaAguanteEstado(req, res) {
  const salaId = req.query.sala_id;
  const usuarioId = req.query.usuario_id;
  if (!salaId) return res.status(400).json({ error: 'Falta sala_id.' });

  try {
    const { data: sala, error: errSala } = await supabase
      .from('salas_privadas_mvp')
      .select('id, nombre, admin_id, juega_aguante, aguante_competencia')
      .eq('id', salaId)
      .single();
    if (errSala || !sala) return res.status(404).json({ error: 'Grupo no encontrado.' });
    // FIX (a pedido, cambio "LETALES": "los modos de juego, si están
    // seteados por el admin, se juegan en paralelo ambos — lo tienes como
    // un switch uno o el otro, modifica"): antes `modo_juego` era un
    // string exclusivo ('polla' XOR 'aguante'), así que un grupo no podía
    // jugar los dos a la vez. Ahora son 2 flags independientes
    // (juega_polla/juega_aguante en salas_privadas_mvp) — este endpoint
    // solo necesita que juega_aguante esté prendido, sin importar si
    // también juega Polla.
    if (!sala.juega_aguante) {
      return res.status(400).json({ error: 'Este grupo no juega en modo Aguante.' });
    }

    // Autocompletado (a propósito, para no depender de enganchar esto en
    // cada lugar donde alguien se une a un grupo o el admin activa el modo
    // Aguante por primera vez): cualquier miembro actual del grupo que
    // todavía no tenga fila en aguante_participantes la recibe acá, con 2
    // vidas — idempotente, no pisa a quien ya estaba jugando.
    const { data: miembrosData } = await supabase
      .from('salas_privadas_miembros_mvp')
      .select('usuario_id')
      .eq('sala_id', salaId);
    const idsMiembros = new Set((miembrosData || []).map((m) => m.usuario_id));
    if (sala.admin_id) idsMiembros.add(sala.admin_id);
    const { data: participantesExistentes } = await supabase
      .from('aguante_participantes')
      .select('usuario_id')
      .eq('sala_id', salaId);
    const idsConFila = new Set((participantesExistentes || []).map((p) => p.usuario_id));
    const faltantes = [...idsMiembros].filter((id) => !idsConFila.has(id));
    if (faltantes.length > 0) {
      await supabase
        .from('aguante_participantes')
        .insert(faltantes.map((usuario_id) => ({ sala_id: salaId, usuario_id, vidas_restantes: 2, eliminado: false })));
    }

    const { data: participantes, error: errPart } = await supabase
      .from('aguante_participantes')
      .select('usuario_id, vidas_restantes, eliminado, fecha_eliminacion')
      .eq('sala_id', salaId);
    if (errPart) return res.status(500).json({ error: errPart.message });

    const idsUsuarios = (participantes || []).map((p) => p.usuario_id);
    const { data: usuarios } = idsUsuarios.length
      ? await supabase.from('usuarios').select('id, nombre, avatar_url').in('id', idsUsuarios)
      : { data: [] };
    const usuarioPorId = {};
    (usuarios || []).forEach((u) => { usuarioPorId[u.id] = u; });

    const { data: elecciones, error: errElec } = await supabase
      .from('aguante_elecciones')
      .select('usuario_id, numero_semana, equipo, resultado')
      .eq('sala_id', salaId)
      .order('numero_semana', { ascending: true });
    if (errElec) return res.status(500).json({ error: errElec.message });

    const semanaActual = numeroSemanaDe(Date.now());
    const { inicio, fin } = rangoDeSemana(semanaActual);

    // Partidos REALES de la fecha vigente para la competencia del grupo (a
    // pedido: el jugador tiene que ver contra quién juega cada equipo antes
    // de elegir, no una lista suelta de nombres — y solo los de la ronda
    // que corresponde, no partidos reprogramados de otra fecha).
    const partidosSemanaData = await partidosDeLaRondaVigente(sala.aguante_competencia, inicio, fin);
    const partidosSemana = partidosSemanaData.map((d) => ({
      id: d.id,
      equipoLocal: d.equipo_local,
      equipoVisitante: d.equipo_visitante,
      fechaExpiracion: d.fecha_expiracion,
      empezado: d.fecha_expiracion ? new Date(d.fecha_expiracion).getTime() <= Date.now() : false,
      resuelto: d.goles_local_oficial != null && d.goles_visitante_oficial != null,
    }));
    // "apuestasCerradas" (a pedido: "se cierran las apuestas cuando parte
    // el primer partido de la semana, no por cada partido") — cierre ÚNICO
    // para toda la fecha, no por equipo: apenas arranca el primero de todos
    // los partidos de esta ronda, nadie puede elegir/cambiar más, aunque su
    // equipo puntual todavía no haya jugado.
    const kickoffsSemana = partidosSemana.map((p) => (p.fechaExpiracion ? new Date(p.fechaExpiracion).getTime() : null)).filter((t) => Number.isFinite(t));
    const primerKickoffSemana = kickoffsSemana.length > 0 ? Math.min(...kickoffsSemana) : null;
    const apuestasCerradas = primerKickoffSemana !== null && primerKickoffSemana <= Date.now();

    // La semana "en juego" para elegir es la actual — la anterior ya cerró
    // y se resuelve con /aguante-resolver.
    const equiposUsadosPorUsuario = {};
    (elecciones || []).forEach((e) => {
      if (!equiposUsadosPorUsuario[e.usuario_id]) equiposUsadosPorUsuario[e.usuario_id] = [];
      equiposUsadosPorUsuario[e.usuario_id].push(e.equipo);
    });

    // Detalle de "equipos ya usados" (a pedido: "cuando pongas los equipos
    // ya usados, agrega al lado de ese equipo usado la fecha (ej fecha 37),
    // el resultado del partido y si pasó o perdió vida por cada fecha") —
    // solo se arma para el jugador que está pidiendo su propio estado
    // (usuarioId), cruzando cada elección YA CERRADA (no la de la semana en
    // curso, esa todavía no tiene partido jugado) contra el partido real de
    // ese equipo en esa semana, para sacar el marcador.
    let miEquiposUsadosDetalle = [];
    if (usuarioId) {
      const misElecciones = (elecciones || []).filter((e) => e.usuario_id === usuarioId && e.numero_semana < semanaActual);
      if (misElecciones.length > 0) {
        const semanasUnicas = [...new Set(misElecciones.map((e) => e.numero_semana))];
        const rangos = semanasUnicas.map((n) => ({ n, ...rangoDeSemana(n) }));
        const inicioMin = Math.min(...rangos.map((r) => r.inicio));
        const finMax = Math.max(...rangos.map((r) => r.fin));
        const { data: partidosHistoricos } = await supabase
          .from('desafios_mvp')
          .select('equipo_local, equipo_visitante, fecha_expiracion, goles_local_oficial, goles_visitante_oficial')
          .eq('tema', sala.aguante_competencia)
          .gte('fecha_expiracion', new Date(inicioMin).toISOString())
          .lt('fecha_expiracion', new Date(finMax).toISOString());
        miEquiposUsadosDetalle = misElecciones.map((e) => {
          const rango = rangos.find((r) => r.n === e.numero_semana);
          const partido = (partidosHistoricos || []).find((d) => {
            if (d.equipo_local !== e.equipo && d.equipo_visitante !== e.equipo) return false;
            const t = new Date(d.fecha_expiracion).getTime();
            return rango && t >= rango.inicio && t < rango.fin;
          }) || null;
          const marcador = partido && partido.goles_local_oficial != null && partido.goles_visitante_oficial != null
            ? `${partido.equipo_local} ${partido.goles_local_oficial}-${partido.goles_visitante_oficial} ${partido.equipo_visitante}`
            : null;
          return {
            equipo: e.equipo,
            numeroSemana: e.numero_semana,
            resultado: e.resultado, // 'pendiente' | 'vivo' | 'muerto'
            marcador,
          };
        }).sort((a, b) => b.numeroSemana - a.numeroSemana);
      }
    }

    const jugadores = (participantes || []).map((p) => ({
      usuarioId: p.usuario_id,
      nombre: usuarioPorId[p.usuario_id]?.nombre || 'Jugador',
      avatarUrl: usuarioPorId[p.usuario_id]?.avatar_url || null,
      vidasRestantes: p.vidas_restantes,
      eliminado: p.eliminado,
      equiposUsados: equiposUsadosPorUsuario[p.usuario_id] || [],
    }));

    const vivos = jugadores.filter((j) => !j.eliminado);
    const juegoTerminado = jugadores.length > 0 && vivos.length <= 1;

    const miEleccion = usuarioId
      ? (elecciones || []).find((e) => e.usuario_id === usuarioId && e.numero_semana === semanaActual) || null
      : null;

    res.json({
      salaId,
      juegaAguante: sala.juega_aguante,
      competencia: sala.aguante_competencia,
      numeroSemana: semanaActual,
      partidosSemana,
      apuestasCerradas,
      jugadores,
      juegoTerminado,
      ganadores: juegoTerminado ? vivos.map((j) => j.usuarioId) : [],
      miEquiposUsados: usuarioId ? (equiposUsadosPorUsuario[usuarioId] || []) : [],
      miEquiposUsadosDetalle,
      miEleccionSemanaActual: miEleccion ? miEleccion.equipo : null,
    });
  } catch (e) {
    console.error('[aguante-estado] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ============================================================
// POST /aguante-elegir  { sala_id, usuario_id, equipo }
// ============================================================
async function rutaAguanteElegir(req, res) {
  const { sala_id, usuario_id, equipo } = req.body || {};
  if (!sala_id || !usuario_id || !equipo) {
    return res.status(400).json({ error: 'Faltan sala_id, usuario_id o equipo.' });
  }
  try {
    const { data: sala, error: errSala } = await supabase
      .from('salas_privadas_mvp')
      .select('id, juega_aguante, aguante_competencia')
      .eq('id', sala_id)
      .single();
    if (errSala || !sala) return res.status(404).json({ error: 'Grupo no encontrado.' });
    if (!sala.juega_aguante || !sala.aguante_competencia) {
      return res.status(400).json({ error: 'Este grupo no juega en modo Aguante.' });
    }

    let { data: participante, error: errPart } = await supabase
      .from('aguante_participantes')
      .select('id, eliminado')
      .eq('sala_id', sala_id)
      .eq('usuario_id', usuario_id)
      .maybeSingle();
    if (errPart) return res.status(500).json({ error: errPart.message });
    if (!participante) {
      // Autocompletado igual que en /aguante-estado — solo si es de verdad
      // miembro del grupo (evita que cualquiera se cree una fila a mano).
      const { data: esMiembro } = await supabase
        .from('salas_privadas_miembros_mvp')
        .select('usuario_id')
        .eq('sala_id', sala_id)
        .eq('usuario_id', usuario_id)
        .maybeSingle();
      const { data: salaAdmin } = await supabase.from('salas_privadas_mvp').select('admin_id').eq('id', sala_id).single();
      if (!esMiembro && salaAdmin?.admin_id !== usuario_id) {
        return res.status(403).json({ error: 'No eres parte de este grupo.' });
      }
      const { data: nuevo, error: errNuevo } = await supabase
        .from('aguante_participantes')
        .insert({ sala_id, usuario_id, vidas_restantes: 2, eliminado: false })
        .select('id, eliminado')
        .single();
      if (errNuevo) return res.status(500).json({ error: errNuevo.message });
      participante = nuevo;
    }
    if (participante.eliminado) return res.status(400).json({ error: 'Ya quedaste eliminado — no puedes seguir eligiendo.' });

    // El equipo tiene que ser de VERDAD un equipo de la competencia del
    // grupo (mismos nombres que trae /equipos, para poder cruzar después
    // contra los resultados reales en desafios_mvp).
    const leagueId = leagueIdDeCompetencia(sala.aguante_competencia);
    if (!leagueId) return res.status(500).json({ error: `No conozco el id de liga para "${sala.aguante_competencia}".` });
    const equiposDetalle = await obtenerEquiposDeLiga(leagueId, TEMPORADA);
    const equiposValidos = new Set(equiposDetalle.map((e) => e.nombre));
    if (!equiposValidos.has(equipo)) {
      return res.status(400).json({ error: `"${equipo}" no es un equipo válido de ${sala.aguante_competencia}.` });
    }

    // No repetir NUNCA un equipo ya elegido antes en este grupo.
    const { data: yaUsado } = await supabase
      .from('aguante_elecciones')
      .select('id')
      .eq('sala_id', sala_id)
      .eq('usuario_id', usuario_id)
      .eq('equipo', equipo)
      .maybeSingle();
    if (yaUsado) return res.status(400).json({ error: `Ya usaste a ${equipo} antes — no se puede repetir.` });

    const semanaActual = numeroSemanaDe(Date.now());
    const { inicio, fin } = rangoDeSemana(semanaActual);

    // Plazo (a pedido: "se cierran las apuestas cuando parte el PRIMER
    // partido de la semana, no por cada partido" — antes esto se fijaba
    // mirando solo el partido del equipo elegido, así que un jugador podía
    // seguir eligiendo (o cambiando de equipo) después de que ya habían
    // arrancado otros partidos de la misma fecha, con la ventaja de ya
    // saber esos resultados). Ahora el cierre es UNO SOLO para toda la
    // ronda: el kickoff más temprano entre TODOS los partidos de la fecha
    // vigente, sin importar el equipo que se esté por elegir.
    const partidosRonda = await partidosDeLaRondaVigente(sala.aguante_competencia, inicio, fin);
    const partidoDeEseEquipo = partidosRonda.find((p) => p.equipo_local === equipo || p.equipo_visitante === equipo) || null;
    // El equipo tiene que jugar ESTA semana — no tendría sentido "elegir" un
    // equipo que no tiene partido en la ventana en juego.
    if (!partidoDeEseEquipo) {
      return res.status(400).json({ error: `${equipo} no tiene partido esta semana en ${sala.aguante_competencia}.` });
    }
    const kickoffsRonda = partidosRonda.map((p) => new Date(p.fecha_expiracion).getTime()).filter(Number.isFinite);
    const primerKickoffRonda = kickoffsRonda.length > 0 ? Math.min(...kickoffsRonda) : null;
    if (primerKickoffRonda !== null && primerKickoffRonda <= Date.now()) {
      return res.status(400).json({ error: 'Ya arrancó el primer partido de esta fecha — se cerraron las apuestas de la semana.' });
    }

    // Upsert: si ya había elegido otro equipo esta semana (antes de que
    // arrancara), lo reemplaza — el unique (sala_id, usuario_id,
    // numero_semana) es lo que hace que esto sea "la elección de la semana".
    const { error: errUpsert } = await supabase
      .from('aguante_elecciones')
      .upsert(
        { sala_id, usuario_id, numero_semana: semanaActual, equipo, resultado: 'pendiente', fecha_eleccion: new Date().toISOString() },
        { onConflict: 'sala_id,usuario_id,numero_semana' }
      );
    if (errUpsert) return res.status(500).json({ error: errUpsert.message });

    res.json({ ok: true, sala_id, usuario_id, numeroSemana: semanaActual, equipo });
  } catch (e) {
    console.error('[aguante-elegir] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// Resuelve UNA semana puntual para UN grupo — extraído a función propia (a
// pedido, bug reportado: "corrí el cron aguante-resolver pero la fecha 36
// sigue en Pendiente" — el cron sin ?semana solo resolvía semanaActual-1,
// así que si el cronjob estuvo semanas sin existir, esas semanas viejas
// quedaban en 'pendiente' PARA SIEMPRE salvo que alguien pidiera a mano
// ?semana=36, ?semana=35, etc., una por una). Devuelve { procesados,
// sinResolverTodavia }.
async function resolverSemanaAguante(grupo, semanaObjetivo) {
  const { inicio, fin } = rangoDeSemana(semanaObjetivo);

  // Todos los partidos de la RONDA VIGENTE de esa competencia esta semana
  // (no cualquier partido reprogramado que caiga en la misma ventana).
  const partidosSemana = await partidosDeLaRondaVigente(grupo.aguante_competencia, inicio, fin);

  const resultadoDeEquipo = (equipo) => {
    const partido = (partidosSemana || []).find(
      (d) => d.equipo_local === equipo || d.equipo_visitante === equipo
    );
    if (!partido) return null; // no jugó esta semana (o no encontramos el partido) — no resolver todavía
    if (partido.goles_local_oficial == null || partido.goles_visitante_oficial == null) return null; // sin resultado aún
    const esLocal = partido.equipo_local === equipo;
    const golesFavor = esLocal ? partido.goles_local_oficial : partido.goles_visitante_oficial;
    const golesContra = esLocal ? partido.goles_visitante_oficial : partido.goles_local_oficial;
    if (golesFavor > golesContra) return 'vivo';
    if (golesFavor === golesContra) return 'vivo'; // empate no mata
    return 'muerto';
  };

  const { data: participantesActivos, error: errPart } = await supabase
    .from('aguante_participantes')
    .select('id, usuario_id, vidas_restantes, eliminado')
    .eq('sala_id', grupo.id)
    .eq('eliminado', false);
  if (errPart) return { error: errPart.message };

  const { data: eleccionesSemana } = await supabase
    .from('aguante_elecciones')
    .select('id, usuario_id, equipo, resultado')
    .eq('sala_id', grupo.id)
    .eq('numero_semana', semanaObjetivo);
  const eleccionPorUsuario = {};
  (eleccionesSemana || []).forEach((e) => { eleccionPorUsuario[e.usuario_id] = e; });

  let procesados = 0;
  let sinResolverTodavia = 0;
  for (const p of participantesActivos || []) {
    const eleccion = eleccionPorUsuario[p.usuario_id];
    if (!eleccion) {
      // No eligió a tiempo esa semana — mismo castigo que perder. Se
      // guarda una fila en aguante_elecciones con equipo "Sin elección" (a
      // pedido de idempotencia: antes esto NO dejaba ningún rastro, así
      // que si el cron se corría dos veces para la misma semana — algo que
      // pasa seguido ahora que /aguante-resolver hace catch-up automático
      // de semanas viejas, ver más abajo — le volvía a quitar una vida de
      // más la segunda vez). Con la fila guardada, la próxima corrida la
      // encuentra en eleccionPorUsuario y no vuelve a entrar acá.
      const vidasNuevas = p.vidas_restantes - 1;
      await Promise.all([
        supabase
          .from('aguante_participantes')
          .update({ vidas_restantes: vidasNuevas, eliminado: vidasNuevas <= 0, fecha_eliminacion: vidasNuevas <= 0 ? new Date().toISOString() : null })
          .eq('id', p.id),
        supabase
          .from('aguante_elecciones')
          .upsert(
            { sala_id: grupo.id, usuario_id: p.usuario_id, numero_semana: semanaObjetivo, equipo: 'Sin elección', resultado: 'muerto', fecha_eleccion: new Date().toISOString() },
            { onConflict: 'sala_id,usuario_id,numero_semana' }
          ),
      ]);
      procesados++;
      continue;
    }
    if (eleccion.resultado !== 'pendiente') continue; // ya resuelta (cron corrió antes)

    const resultadoEquipo = resultadoDeEquipo(eleccion.equipo);
    if (!resultadoEquipo) { sinResolverTodavia++; continue; } // todavía no hay resultado — se reintenta en la próxima corrida

    await supabase.from('aguante_elecciones').update({ resultado: resultadoEquipo }).eq('id', eleccion.id);
    if (resultadoEquipo === 'muerto') {
      const vidasNuevas = p.vidas_restantes - 1;
      await supabase
        .from('aguante_participantes')
        .update({ vidas_restantes: vidasNuevas, eliminado: vidasNuevas <= 0, fecha_eliminacion: vidasNuevas <= 0 ? new Date().toISOString() : null })
        .eq('id', p.id);
    }
    procesados++;
  }

  return { procesados, sinResolverTodavia };
}

// Otorga la medalla de "Ganador de El Aguante" (a pedido: "gané el aguante
// pero no me dio la medalla en mi perfil") cuando el grupo queda con 1 solo
// jugador vivo (o 0, si los últimos 2 caen la misma semana — en ese caso
// nadie sobrevivió, no se premia a nadie salvo que haya quedado un único
// líder con más vidas, que hoy no se distingue, así que se deja sin premiar
// ese caso raro). Se guarda en grupo_ganadores_semanales (misma tabla que
// usa "Premios ganados" en la ficha de jugador) con modo='aguante' — a
// diferencia de Polla/Baby esto NO es semanal, es el campeón de TODA la
// ronda de El Aguante del grupo, así que solo se inserta UNA vez por grupo
// (se revisa que no exista ya una fila modo='aguante' para esta sala antes
// de insertar, para no duplicar si el cron corre de nuevo).
async function otorgarMedallaAguanteSiTermino(grupo, semanaObjetivo) {
  const { data: yaExiste } = await supabase
    .from('grupo_ganadores_semanales')
    .select('id')
    .eq('sala_id', grupo.id)
    .eq('modo', 'aguante')
    .limit(1);
  if (yaExiste && yaExiste.length > 0) return; // ya premiado antes, no duplicar

  const { data: participantes } = await supabase
    .from('aguante_participantes')
    .select('usuario_id, eliminado')
    .eq('sala_id', grupo.id);
  if (!participantes || participantes.length === 0) return;

  const vivos = participantes.filter((p) => !p.eliminado);
  if (vivos.length !== 1) return; // todavía no terminó (o terminó en doble KO, caso no premiado)

  await supabase.from('grupo_ganadores_semanales').insert({
    sala_id: grupo.id,
    numero_semana: semanaObjetivo,
    modo: 'aguante',
    usuario_id: vivos[0].usuario_id,
    diamantes_semana: 0, // El Aguante no paga diamantes, la medalla es solo por sobrevivir
  });
}

// ============================================================
// GET /aguante-resolver  (cron semanal, con X-Cron-Secret)
// ?semana=N: resuelve solo esa semana puntual. Sin ?semana: resuelve
// semanaActual-1 Y hace catch-up de hasta 10 semanas hacia atrás por si
// quedaron sin resolver (a pedido, bug reportado: el cronjob de
// aguante-resolver no existía en cron-job.org durante varias semanas, así
// que semanas viejas quedaron en 'pendiente' para siempre porque nadie las
// pedía explícitamente) — es seguro repetir semanas ya resueltas, no hace
// nada de más (ver idempotencia en resolverSemanaAguante).
// ============================================================
async function rutaAguanteResolver(req, res) {
  const semanaActual = numeroSemanaDe(Date.now());
  const semanaPedida = req.query?.semana ? Number(req.query.semana) : null;
  if (req.query?.semana && (!Number.isFinite(semanaPedida) || semanaPedida < 1)) {
    return res.status(400).json({ error: 'Número de semana inválido.' });
  }
  const CATCHUP_MAX_SEMANAS = 10;
  const semanasAProcesar = semanaPedida
    ? [semanaPedida]
    : Array.from({ length: CATCHUP_MAX_SEMANAS }, (_, i) => semanaActual - 1 - i).filter((n) => n >= 1);

  try {
    const { data: grupos, error: errGrupos } = await supabase
      .from('salas_privadas_mvp')
      .select('id, nombre, aguante_competencia')
      .eq('juega_aguante', true);
    if (errGrupos) return res.status(500).json({ error: errGrupos.message });

    const resultado = { semanasProcesadas: semanasAProcesar, grupos: [] };

    for (const grupo of grupos || []) {
      if (!grupo.aguante_competencia) continue;

      const porSemana = [];
      for (const semanaObjetivo of semanasAProcesar) {
        const r = await resolverSemanaAguante(grupo, semanaObjetivo);
        porSemana.push({ semana: semanaObjetivo, ...r });
      }

      // Después de intentar resolver todas las semanas pedidas, revisa si
      // el grupo ya quedó con un solo jugador en pie — si es así, premia
      // (una sola vez, ver otorgarMedallaAguanteSiTermino).
      try {
        await otorgarMedallaAguanteSiTermino(grupo, semanasAProcesar[0]);
      } catch (eMedalla) {
        console.error('[aguante-resolver] Error otorgando medalla de campeón:', eMedalla.message);
      }

      resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, porSemana });
    }

    res.json(resultado);
  } catch (e) {
    console.error('[aguante-resolver] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaAguanteEstado, rutaAguanteElegir, rutaAguanteResolver };
