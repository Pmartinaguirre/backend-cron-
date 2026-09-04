// "Baby" — nuevo modo de juego GLOBAL (a pedido, cambio "LETALES"
// 30-ago-2026): adivinar el GANADOR (local/empate/visita, NUNCA marcador
// exacto — esa es la diferencia con Polla) de 5 partidos que el ADMIN elige
// cada semana para TODA la app (no es por grupo, como El Aguante). Los
// partidos de Baby son filas reales de desafios_mvp (ver
// baby_semana_partidos en agregar_modo_baby.sql) — así se resuelven
// cruzando contra las mismas columnas oficiales que ya llena /resolver.
//
// Tres rutas en este archivo (mismo patrón que aguante.js):
//   GET  /baby-estado    — arma la pantalla del jugador (partidos de la
//                          semana, mi elección de cada uno, ranking global).
//                          Solo lectura, sin secreto.
//   POST /baby-elegir    — el jugador elige local/empate/visita para un
//                          partido. Sin secreto (autorización adentro,
//                          mismo patrón que /aguante-elegir), CORS igual.
//   GET  /baby-resolver  — cron (mismo horario que /resolver): paga
//                          diamantes a quien acertó, para todo partido de
//                          Baby que ya tenga marcador oficial. Con
//                          X-Cron-Secret.
const { supabase } = require('../supabaseClient');
const { signoDeGoles, cuotaDelResultado, calcularDiamantesCat5 } = require('../diamantes');

const SIGNO_POR_ELECCION = { local: 1, empate: 0, visita: -1 };

// ============================================================
// GET /baby-estado?usuario_id=...&semana=...
// ============================================================
async function rutaBabyEstado(req, res) {
  const usuarioId = req.query.usuario_id || null;
  const semanaPedida = req.query.semana ? Number(req.query.semana) : null;

  try {
    // Semanas disponibles (todas las que el admin ya cargó, para los chips
    // de semana en la pantalla) — la "actual" es la de número más alto,
    // salvo que el jugador pida explícitamente otra con ?semana=.
    const { data: semanasData, error: errSemanas } = await supabase
      .from('baby_semana_partidos')
      .select('numero_semana')
      .order('numero_semana', { ascending: true });
    if (errSemanas) return res.status(500).json({ error: errSemanas.message });
    const semanasDisponibles = [...new Set((semanasData || []).map((s) => s.numero_semana))];

    if (semanasDisponibles.length === 0) {
      return res.json({ numeroSemana: null, semanasDisponibles: [], partidos: [], ranking: [] });
    }

    const numeroSemana = semanaPedida && semanasDisponibles.includes(semanaPedida)
      ? semanaPedida
      : semanasDisponibles[semanasDisponibles.length - 1];

    const { data: babyPartidos, error: errBaby } = await supabase
      .from('baby_semana_partidos')
      .select('id, desafio_id, orden')
      .eq('numero_semana', numeroSemana)
      .order('orden', { ascending: true });
    if (errBaby) return res.status(500).json({ error: errBaby.message });

    const idsDesafios = (babyPartidos || []).map((b) => b.desafio_id);
    const { data: desafios, error: errDesafios } = idsDesafios.length
      ? await supabase
          .from('desafios_mvp')
          .select('id, tema, subtema, equipo_local, equipo_visitante, fecha_expiracion, goles_local_oficial, goles_visitante_oficial, cuota_local, cuota_empate, cuota_visita')
          .in('id', idsDesafios)
      : { data: [] };
    if (errDesafios) return res.status(500).json({ error: errDesafios.message });
    const desafioPorId = {};
    (desafios || []).forEach((d) => { desafioPorId[d.id] = d; });

    const idsBabyPartidos = (babyPartidos || []).map((b) => b.id);
    const { data: misElecciones } = usuarioId && idsBabyPartidos.length
      ? await supabase
          .from('baby_elecciones')
          .select('baby_partido_id, eleccion, resultado, diamantes_otorgados')
          .eq('usuario_id', usuarioId)
          .in('baby_partido_id', idsBabyPartidos)
      : { data: [] };
    const miEleccionPorPartido = {};
    (misElecciones || []).forEach((e) => { miEleccionPorPartido[e.baby_partido_id] = e; });

    const partidos = (babyPartidos || [])
      .map((b) => {
        const d = desafioPorId[b.desafio_id];
        if (!d) return null;
        return {
          babyPartidoId: b.id,
          desafioId: d.id,
          orden: b.orden,
          competencia: d.tema,
          jornada: d.subtema,
          equipoLocal: d.equipo_local,
          equipoVisitante: d.equipo_visitante,
          fechaExpiracion: d.fecha_expiracion,
          empezado: d.fecha_expiracion ? new Date(d.fecha_expiracion).getTime() <= Date.now() : false,
          golesLocalOficial: d.goles_local_oficial,
          golesVisitanteOficial: d.goles_visitante_oficial,
          resuelto: d.goles_local_oficial != null && d.goles_visitante_oficial != null,
          miEleccion: miEleccionPorPartido[b.id]?.eleccion || null,
          miResultado: miEleccionPorPartido[b.id]?.resultado || null,
          misDiamantes: miEleccionPorPartido[b.id]?.diamantes_otorgados || 0,
        };
      })
      .filter(Boolean);

    // Ranking global (a pedido, "sube en la tabla de posiciones" — Baby
    // tiene la suya propia, separada del ranking de Polla): suma de
    // diamantes_otorgados de TODA la historia de Baby, agrupado por
    // usuario. Se trae en JS (tablas chicas, sin paginar todavía) en vez de
    // una función SQL aparte, mismo criterio simple que el resto del cron.
    const { data: todasElecciones } = await supabase
      .from('baby_elecciones')
      .select('usuario_id, diamantes_otorgados')
      .gt('diamantes_otorgados', 0);
    const diamantesPorUsuario = {};
    (todasElecciones || []).forEach((e) => {
      diamantesPorUsuario[e.usuario_id] = (diamantesPorUsuario[e.usuario_id] || 0) + e.diamantes_otorgados;
    });
    const idsRanking = Object.keys(diamantesPorUsuario);
    const { data: usuariosRanking } = idsRanking.length
      ? await supabase.from('usuarios').select('id, nombre, avatar_url').in('id', idsRanking)
      : { data: [] };
    const usuarioPorId = {};
    (usuariosRanking || []).forEach((u) => { usuarioPorId[u.id] = u; });
    const ranking = idsRanking
      .map((uid) => ({
        usuarioId: uid,
        nombre: usuarioPorId[uid]?.nombre || 'Jugador',
        avatarUrl: usuarioPorId[uid]?.avatar_url || null,
        diamantes: diamantesPorUsuario[uid],
      }))
      .sort((a, b) => b.diamantes - a.diamantes)
      .slice(0, 20);

    res.json({ numeroSemana, semanasDisponibles, partidos, ranking });
  } catch (e) {
    console.error('[baby-estado] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ============================================================
// POST /baby-elegir  { usuario_id, baby_partido_id, eleccion }
// ============================================================
async function rutaBabyElegir(req, res) {
  const { usuario_id, baby_partido_id, eleccion } = req.body || {};
  if (!usuario_id || !baby_partido_id || !eleccion) {
    return res.status(400).json({ error: 'Faltan usuario_id, baby_partido_id o eleccion.' });
  }
  if (!['local', 'empate', 'visita'].includes(eleccion)) {
    return res.status(400).json({ error: 'eleccion debe ser "local", "empate" o "visita".' });
  }
  try {
    const { data: babyPartido, error: errBaby } = await supabase
      .from('baby_semana_partidos')
      .select('id, desafio_id')
      .eq('id', baby_partido_id)
      .single();
    if (errBaby || !babyPartido) return res.status(404).json({ error: 'Partido de Baby no encontrado.' });

    const { data: desafio, error: errDesafio } = await supabase
      .from('desafios_mvp')
      .select('id, fecha_expiracion, goles_local_oficial, goles_visitante_oficial')
      .eq('id', babyPartido.desafio_id)
      .single();
    if (errDesafio || !desafio) return res.status(404).json({ error: 'Partido no encontrado.' });

    // Plazo: mismo criterio que /aguante-elegir — no se puede elegir (ni
    // cambiar la elección) una vez que arrancó el partido.
    if (desafio.fecha_expiracion && new Date(desafio.fecha_expiracion).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Este partido ya empezó — no se puede elegir.' });
    }

    // Upsert: si ya había elegido antes para este partido, lo reemplaza — el
    // unique (usuario_id, baby_partido_id) es lo que hace que esto sea "la
    // elección de ese partido".
    const { error: errUpsert } = await supabase
      .from('baby_elecciones')
      .upsert(
        { usuario_id, baby_partido_id, eleccion, resultado: 'pendiente', diamantes_otorgados: 0 },
        { onConflict: 'usuario_id,baby_partido_id' }
      );
    if (errUpsert) return res.status(500).json({ error: errUpsert.message });

    res.json({ ok: true, usuario_id, baby_partido_id, eleccion });
  } catch (e) {
    console.error('[baby-elegir] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ============================================================
// GET /baby-resolver  (cron, con X-Cron-Secret)
// ============================================================
async function rutaBabyResolver(req, res) {
  try {
    const { data: pendientes, error: errPend } = await supabase
      .from('baby_elecciones')
      .select('id, usuario_id, baby_partido_id, eleccion')
      .eq('resultado', 'pendiente');
    if (errPend) return res.status(500).json({ error: errPend.message });

    if (!pendientes || pendientes.length === 0) {
      return res.json({ procesados: 0, sinResolverTodavia: 0 });
    }

    const idsBabyPartidos = [...new Set(pendientes.map((p) => p.baby_partido_id))];
    const { data: babyPartidos } = await supabase
      .from('baby_semana_partidos')
      .select('id, desafio_id')
      .in('id', idsBabyPartidos);
    const desafioIdPorBabyPartido = {};
    (babyPartidos || []).forEach((b) => { desafioIdPorBabyPartido[b.id] = b.desafio_id; });

    const idsDesafios = [...new Set(Object.values(desafioIdPorBabyPartido))];
    const { data: desafios } = idsDesafios.length
      ? await supabase
          .from('desafios_mvp')
          .select('id, goles_local_oficial, goles_visitante_oficial, cuota_local, cuota_empate, cuota_visita')
          .in('id', idsDesafios)
      : { data: [] };
    const desafioPorId = {};
    (desafios || []).forEach((d) => { desafioPorId[d.id] = d; });

    let procesados = 0;
    let sinResolverTodavia = 0;
    for (const p of pendientes) {
      const desafioId = desafioIdPorBabyPartido[p.baby_partido_id];
      const desafio = desafioId ? desafioPorId[desafioId] : null;
      if (!desafio || desafio.goles_local_oficial == null || desafio.goles_visitante_oficial == null) {
        sinResolverTodavia++;
        continue; // el partido real todavía no tiene marcador oficial — se reintenta en la próxima corrida
      }

      const signoReal = signoDeGoles(desafio.goles_local_oficial, desafio.goles_visitante_oficial);
      const acerto = SIGNO_POR_ELECCION[p.eleccion] === signoReal;
      const monto = acerto ? calcularDiamantesCat5(signoReal, desafio) : 0;

      if (monto > 0) {
        const { error: errPago } = await supabase.rpc('pagar_diamantes_cron', {
          p_usuario: p.usuario_id,
          p_monto: monto,
          p_desafio: desafioId,
          p_motivo: 'baby',
        });
        if (errPago) {
          console.error(`[baby-resolver] Error pagando diamantes a ${p.usuario_id}:`, errPago.message);
        }
      }

      await supabase
        .from('baby_elecciones')
        .update({ resultado: acerto ? 'acierto' : 'fallo', diamantes_otorgados: monto })
        .eq('id', p.id);
      procesados++;
    }

    res.json({ procesados, sinResolverTodavia });
  } catch (e) {
    console.error('[baby-resolver] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaBabyEstado, rutaBabyElegir, rutaBabyResolver };
