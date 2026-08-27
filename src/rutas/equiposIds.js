// GET /backfill-equipos — completa equipo_local_id / equipo_visita_id en los
//                         partidos que ya existían. Lleva X-Cron-Secret.
// GET /forma?ids=1-2-3    — últimos 5 resultados de varios equipos de una vez.
//                         Solo lectura, la llama el navegador.
const { supabase } = require('../supabaseClient');
const { obtenerFichaClub, obtenerPerfilBasicoJugador, nombreCortoDesdeFirstLast } = require('../apiFootball');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const headers = { 'x-apisports-key': API_FOOTBALL_KEY };

// /fixtures?ids= acepta como máximo 20 ids por llamada. Es el límite de la
// API, no una elección nuestra.
const MAX_IDS_POR_LLAMADA = 20;
// Tope por corrida, para que el endpoint responda antes del timeout de
// Render aunque falten cientos de partidos. Se vuelve a llamar y sigue.
const MAX_POR_CORRIDA = 200;

async function rutaBackfillEquipos(req, res) {
  // Solo las filas incompletas: el endpoint es idempotente y se puede correr
  // las veces que haga falta sin volver a gastar llamadas en lo ya hecho.
  const { data: pendientes, error } = await supabase
    .from('desafios_mvp')
    .select('id, fixture_id_api')
    .not('fixture_id_api', 'is', null)
    .is('equipo_local_id', null)
    .limit(MAX_POR_CORRIDA);

  if (error) {
    console.error('[/backfill-equipos] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }
  if (!pendientes || pendientes.length === 0) {
    return res.json({ actualizados: 0, pendientes: 0, mensaje: 'No queda nada por completar.' });
  }

  // Un fixture puede repetirse entre desafíos (Cat.4 y Cat.5 del mismo
  // partido), así que se piden los ids ÚNICOS: pedir dos veces el mismo
  // fixture sería pagar dos llamadas por el mismo dato.
  const fixturesUnicos = [...new Set(pendientes.map((p) => p.fixture_id_api))];

  const equiposPorFixture = {};
  const errores = [];
  for (let i = 0; i < fixturesUnicos.length; i += MAX_IDS_POR_LLAMADA) {
    const lote = fixturesUnicos.slice(i, i + MAX_IDS_POR_LLAMADA);
    try {
      const resp = await fetch(`${BASE}/fixtures?ids=${lote.join('-')}`, { headers });
      const data = await resp.json();
      (data?.response || []).forEach((fx) => {
        equiposPorFixture[fx.fixture?.id] = {
          local: fx.teams?.home?.id ?? null,
          visita: fx.teams?.away?.id ?? null,
        };
      });
    } catch (e) {
      errores.push({ lote: lote.join('-'), error: e.message });
    }
  }

  let actualizados = 0;
  for (const p of pendientes) {
    const eq = equiposPorFixture[p.fixture_id_api];
    if (!eq || eq.local == null) continue;
    const { error: errUpd } = await supabase
      .from('desafios_mvp')
      .update({ equipo_local_id: eq.local, equipo_visita_id: eq.visita })
      .eq('id', p.id);
    if (errUpd) errores.push({ id: p.id, error: errUpd.message });
    else actualizados++;
  }

  // Cuántos quedan para la próxima corrida, así se sabe si hay que volver a
  // llamar sin tener que ir a mirar la tabla.
  const { count } = await supabase
    .from('desafios_mvp')
    .select('id', { count: 'exact', head: true })
    .not('fixture_id_api', 'is', null)
    .is('equipo_local_id', null);

  res.json({
    actualizados,
    llamadasApi: Math.ceil(fixturesUnicos.length / MAX_IDS_POR_LLAMADA),
    pendientes: (count ?? 0) - actualizados < 0 ? 0 : count ?? 0,
    errores,
  });
}

// ============================================================
// /forma?ids=1-2-3
// ============================================================
// Devuelve, por equipo, sus últimos 5 resultados como una tira de V/E/P.
// Es lo que se dibuja bajo cada equipo en la tarjeta de partido.
//
// SOBRE EL COSTO: API-Football no tiene un endpoint que traiga la forma de
// varios equipos de una vez, así que internamente es una llamada por equipo.
// Lo que hace que esto no sea un problema es la caché de obtenerFichaClub
// (30 min): una pantalla de Partidos con 20 partidos toca ~30 equipos
// distintos, y esos 30 se piden una vez cada media hora sin importar cuántos
// jugadores estén mirando.
//
// El tope de 40 ids por llamada es para que un request malicioso o un bug del
// frontend no dispare cientos de consultas de una.
const MAX_EQUIPOS = 40;

async function rutaForma(req, res) {
  const crudo = String(req.query.ids || '').trim();
  if (!crudo) return res.status(400).json({ error: 'Falta el parámetro "ids".' });

  const ids = [...new Set(
    crudo.split('-').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
  )].slice(0, MAX_EQUIPOS);

  if (ids.length === 0) return res.status(400).json({ error: 'Ningún id válido en "ids".' });

  const forma = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const ficha = await obtenerFichaClub(id);
      if (!ficha) { forma[id] = null; return; }
      // Solo lo mínimo que dibuja la tira: resultado, rival y marcador para
      // el tooltip. Mandar los partidos completos sería inflar la respuesta
      // por datos que la tarjeta no usa.
      forma[id] = ficha.partidos
        .filter((p) => p.resultado)   // fuera los cancelados/sin marcador
        .slice(0, 5)
        .map((p) => ({
          r: p.resultado,
          rival: p.rival,
          gf: p.golesPropios,
          gc: p.golesRival,
          local: p.esLocal,
        }));
    } catch (e) {
      console.error(`[/forma] Error con el equipo ${id}:`, e);
      forma[id] = null;
    }
  }));

  res.json({ forma });
}

// ============================================================
// /jugadores-perfil?ids=1-2-3
// ============================================================
// Devuelve, por jugador, solo edad + nacionalidad — para los filtros de
// "nacionalidad" y "edad" en la cancha de Alineaciones (a pedido). La
// alineación en sí (/fixtures) no trae ese dato, solo /players/profiles,
// jugador por jugador — por eso esto se cachea 30 días en
// obtenerPerfilBasicoJugador (la edad de un jugador no cambia entre
// partidos) y se pide en paralelo acá.
//
// Tope de 40 ids por llamada por lo mismo que en /forma: una alineación
// completa (titulares + banca de ambos equipos) son ~36-40 jugadores, así
// que alcanza para pedirlos todos de una vez sin abrir la puerta a abuso.
const MAX_JUGADORES = 40;

async function rutaPerfilesJugadores(req, res) {
  const crudo = String(req.query.ids || '').trim();
  if (!crudo) return res.status(400).json({ error: 'Falta el parámetro "ids".' });

  const ids = [...new Set(
    crudo.split('-').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
  )].slice(0, MAX_JUGADORES);

  if (ids.length === 0) return res.status(400).json({ error: 'Ningún id válido en "ids".' });

  const perfiles = {};
  // APROVECHAR EL VIAJE (a pedido, backlog de 955 nombres pendientes que no
  // baja): cada perfil que este endpoint trae de la API incluye firstname/
  // lastname — exactamente el dato que /refrescar-planteles necesita para
  // resolver nombre_corto. Antes se tiraba a la basura; ahora se junta y se
  // guarda en jugadores_perfil al final (upsert parcial: solo jugador_id +
  // nombre_corto, mismo criterio que refrescarPlanteles.js para no pisar
  // nombre/foto). Cada vez que alguien abre una alineación en la app, hasta
  // 40 pendientes se resuelven gratis, sin gastar cuota extra (el pedido a
  // la API ya se hacía igual).
  const filasNombre = [];
  await Promise.all(ids.map(async (id) => {
    try {
      const p = await obtenerPerfilBasicoJugador(id);
      perfiles[id] = p ? { edad: p.edad, nacionalidad: p.nacionalidad } : null;
      const nombreCorto = p ? nombreCortoDesdeFirstLast(p.firstname, p.lastname) : null;
      if (nombreCorto) filasNombre.push({ jugador_id: id, nombre_corto: nombreCorto, actualizado_en: new Date().toISOString() });
    } catch (e) {
      console.error(`[/jugadores-perfil] Error con el jugador ${id}:`, e);
      perfiles[id] = null;
    }
  }));

  // Responder primero, guardar después: el navegador no tiene por qué
  // esperar al upsert. OJO: solo se actualizan filas que YA existen con
  // nombre_corto null — un upsert ciego crearía filas huérfanas para
  // jugadores que no son de nuestros planteles controlables.
  res.json({ perfiles });

  if (filasNombre.length > 0) {
    try {
      const idsConNombre = filasNombre.map((f) => f.jugador_id);
      const { data: existentes } = await supabase
        .from('jugadores_perfil')
        .select('jugador_id')
        .in('jugador_id', idsConNombre)
        .is('nombre_corto', null);
      const idsPendientes = new Set((existentes || []).map((r) => r.jugador_id));
      const filasAGuardar = filasNombre.filter((f) => idsPendientes.has(f.jugador_id));
      if (filasAGuardar.length > 0) {
        const { error: errUp } = await supabase.from('jugadores_perfil').upsert(filasAGuardar);
        if (errUp) throw errUp;
        console.log(`[/jugadores-perfil] De paso se resolvieron ${filasAGuardar.length} nombres pendientes en jugadores_perfil.`);
      }
    } catch (e) {
      console.error('[/jugadores-perfil] Error guardando nombres de paso (no afecta la respuesta):', e);
    }
  }
}

module.exports = { rutaBackfillEquipos, rutaForma, rutaPerfilesJugadores };
