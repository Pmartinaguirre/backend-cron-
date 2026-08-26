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
      .select('id, nombre, admin_id, modo_juego, aguante_competencia')
      .eq('id', salaId)
      .single();
    if (errSala || !sala) return res.status(404).json({ error: 'Grupo no encontrado.' });
    if (sala.modo_juego !== 'aguante') {
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

    // Partidos REALES de esta semana para la competencia del grupo (a
    // pedido: el jugador tiene que ver contra quién juega cada equipo antes
    // de elegir, no una lista suelta de nombres) — mismo criterio de
    // esta_activo que el resto de la app usa para no mostrar duplicados
    // huérfanos.
    const { data: partidosSemanaData } = await supabase
      .from('desafios_mvp')
      .select('id, equipo_local, equipo_visitante, fecha_expiracion, goles_local_oficial, goles_visitante_oficial')
      .eq('tema', sala.aguante_competencia)
      .in('categoria', [4, 5])
      .eq('esta_activo', true)
      .gte('fecha_expiracion', new Date(inicio).toISOString())
      .lt('fecha_expiracion', new Date(fin).toISOString())
      .order('fecha_expiracion', { ascending: true });
    const partidosSemana = (partidosSemanaData || []).map((d) => ({
      id: d.id,
      equipoLocal: d.equipo_local,
      equipoVisitante: d.equipo_visitante,
      fechaExpiracion: d.fecha_expiracion,
      empezado: d.fecha_expiracion ? new Date(d.fecha_expiracion).getTime() <= Date.now() : false,
      resuelto: d.goles_local_oficial != null && d.goles_visitante_oficial != null,
    }));

    // La semana "en juego" para elegir es la actual — la anterior ya cerró
    // y se resuelve con /aguante-resolver.
    const equiposUsadosPorUsuario = {};
    (elecciones || []).forEach((e) => {
      if (!equiposUsadosPorUsuario[e.usuario_id]) equiposUsadosPorUsuario[e.usuario_id] = [];
      equiposUsadosPorUsuario[e.usuario_id].push(e.equipo);
    });

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
      modoJuego: sala.modo_juego,
      competencia: sala.aguante_competencia,
      numeroSemana: semanaActual,
      partidosSemana,
      jugadores,
      juegoTerminado,
      ganadores: juegoTerminado ? vivos.map((j) => j.usuarioId) : [],
      miEquiposUsados: usuarioId ? (equiposUsadosPorUsuario[usuarioId] || []) : [],
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
      .select('id, modo_juego, aguante_competencia')
      .eq('id', sala_id)
      .single();
    if (errSala || !sala) return res.status(404).json({ error: 'Grupo no encontrado.' });
    if (sala.modo_juego !== 'aguante' || !sala.aguante_competencia) {
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
    if (participante.eliminado) return res.status(400).json({ error: 'Ya quedaste eliminado — no podés seguir eligiendo.' });

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

    // Plazo: no se puede elegir (ni cambiar la elección) una vez que
    // arrancó el partido de ESE equipo en esta ventana — mismo criterio
    // que el resto de la app usa para cerrar pronósticos.
    const { data: partidoDeEseEquipo } = await supabase
      .from('desafios_mvp')
      .select('id, fecha_expiracion')
      .eq('tema', sala.aguante_competencia)
      .in('categoria', [4, 5])
      .eq('esta_activo', true)
      .gte('fecha_expiracion', new Date(inicio).toISOString())
      .lt('fecha_expiracion', new Date(fin).toISOString())
      .or(`equipo_local.eq.${equipo},equipo_visitante.eq.${equipo}`)
      .order('fecha_expiracion', { ascending: true })
      .limit(1)
      .maybeSingle();
    // El equipo tiene que jugar ESTA semana — no tendría sentido "elegir" un
    // equipo que no tiene partido en la ventana en juego.
    if (!partidoDeEseEquipo) {
      return res.status(400).json({ error: `${equipo} no tiene partido esta semana en ${sala.aguante_competencia}.` });
    }
    if (new Date(partidoDeEseEquipo.fecha_expiracion).getTime() <= Date.now()) {
      return res.status(400).json({ error: `El partido de ${equipo} esta semana ya empezó — no se puede elegir.` });
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

// ============================================================
// GET /aguante-resolver  (cron semanal, con X-Cron-Secret)
// ============================================================
async function rutaAguanteResolver(req, res) {
  const semanaActual = numeroSemanaDe(Date.now());
  const semanaObjetivo = req.query?.semana ? Number(req.query.semana) : semanaActual - 1;
  if (!Number.isFinite(semanaObjetivo) || semanaObjetivo < 1) {
    return res.status(400).json({ error: 'Número de semana inválido.' });
  }
  const { inicio, fin } = rangoDeSemana(semanaObjetivo);

  try {
    const { data: grupos, error: errGrupos } = await supabase
      .from('salas_privadas_mvp')
      .select('id, nombre, aguante_competencia')
      .eq('modo_juego', 'aguante');
    if (errGrupos) return res.status(500).json({ error: errGrupos.message });

    const resultado = { semana: semanaObjetivo, grupos: [] };

    for (const grupo of grupos || []) {
      if (!grupo.aguante_competencia) continue;

      // Todos los partidos YA resueltos de esa competencia esta semana —
      // se trae una vez por grupo y se busca adentro por equipo.
      const { data: partidosSemana } = await supabase
        .from('desafios_mvp')
        .select('equipo_local, equipo_visitante, goles_local_oficial, goles_visitante_oficial, resultado_oficial')
        .eq('tema', grupo.aguante_competencia)
        .in('categoria', [4, 5])
        .gte('fecha_expiracion', new Date(inicio).toISOString())
        .lt('fecha_expiracion', new Date(fin).toISOString());

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
      if (errPart) { resultado.grupos.push({ sala_id: grupo.id, error: errPart.message }); continue; }

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
          // No eligió a tiempo esa semana — mismo castigo que perder.
          const vidasNuevas = p.vidas_restantes - 1;
          await supabase
            .from('aguante_participantes')
            .update({ vidas_restantes: vidasNuevas, eliminado: vidasNuevas <= 0, fecha_eliminacion: vidasNuevas <= 0 ? new Date().toISOString() : null })
            .eq('id', p.id);
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

      resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, procesados, sinResolverTodavia });
    }

    res.json(resultado);
  } catch (e) {
    console.error('[aguante-resolver] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaAguanteEstado, rutaAguanteElegir, rutaAguanteResolver };
