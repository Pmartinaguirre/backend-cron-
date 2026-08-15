// GET /diagnostico-partido?competencia=Copa%20Chile&fecha=2026-08-06 — a
// pedido, para revisar un partido puntual SIN pasar por nuestra base de
// datos: busca los fixtures de esa liga en esa fecha directo en
// API-Football y devuelve, para cada uno, si la respuesta CRUDA trae
// alineaciones/eventos/estadísticas — así se distingue si el dato "no
// llegó" porque API-Football no lo tiene (nada que hacer) o porque nuestro
// backend/frontend no lo está agarrando bien (bug real, a corregir).
//
// Sin exigirSecreto (mismo criterio que /diagnostico-cobertura): de solo
// lectura, pensado para pegarle directo desde el navegador.
const { TEMPORADA, leagueIdDeCompetencia } = require('../ligas');
const { obtenerEstadisticasJugadores } = require('../apiFootball');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const headers = { 'x-apisports-key': API_FOOTBALL_KEY };

async function rutaDiagnosticoPartido(req, res) {
  // Atajo por fixtureId (a pedido): cuando ya sabemos el fixture_id_api
  // puntual (ej. sacado de la tabla desafios_mvp) y no vale la pena
  // adivinar competencia/fecha/liga — pega directo a /fixtures?id= y
  // devuelve la respuesta CRUDA de árbitro/estadio para ESE fixture.
  const fixtureId = req.query.fixtureId;
  if (fixtureId) {
    try {
      const resp = await fetch(`${BASE}/fixtures?id=${fixtureId}`, { headers });
      const data = await resp.json();
      const fx = data?.response?.[0];
      if (!fx) {
        return res.json({ fixtureId, mensaje: `API-Football no devolvió ningún fixture con id ${fixtureId}.`, crudo: data });
      }

      // Nota Demaster.app (a pedido: "veamos el cálculo de ese partido en
      // particular para ver dónde está el error"): se pide el mismo
      // /fixtures/players que usa obtenerDetalleFixture, pero acá se
      // devuelve CRUDO (rating, goles, minutos, posición tal cual los manda
      // la API) para poder comparar a ojo si el número que ve el jugador en
      // la cancha corresponde a lo que de verdad mandó API-Football, o si el
      // problema está en cómo se cruza/calcula acá.
      const idLocal = fx.teams?.home?.id;
      const statsJugadores = await obtenerEstadisticasJugadores(fixtureId);
      const jugadoresPorEquipo = (fx.lineups || []).map((l) => ({
        equipo: l.team?.name || '',
        esLocal: l.team?.id === idLocal,
        titulares: (l.startXI || []).map((x) => {
          const id = x.player?.id ?? null;
          const s = id != null ? statsJugadores.get(id) : null;
          return {
            id,
            nombre: x.player?.name || '',
            posicionLineup: x.player?.pos || null,
            statsCrudas: s || 'SIN estadísticas de /fixtures/players para este id',
          };
        }),
        suplentesQueEntraron: (l.substitutes || [])
          .map((x) => {
            const id = x.player?.id ?? null;
            const s = id != null ? statsJugadores.get(id) : null;
            return s && (s.minutos || 0) > 0 ? { id, nombre: x.player?.name || '', statsCrudas: s } : null;
          })
          .filter(Boolean),
      }));

      return res.json({
        fixtureId,
        local: fx.teams?.home?.name || null,
        visita: fx.teams?.away?.name || null,
        golesLocal: fx.goals?.home ?? null,
        golesVisita: fx.goals?.away ?? null,
        liga: fx.league?.name || null,
        ronda: fx.league?.round || null,
        estado: fx.fixture?.status?.short || null,
        fechaISO: fx.fixture?.date || null,
        estadio: fx.fixture?.venue?.name || null,
        estadioId: fx.fixture?.venue?.id || null,
        estadioCiudad: fx.fixture?.venue?.city || null,
        arbitro: fx.fixture?.referee || null,
        jugadoresPorEquipo,
      });
    } catch (e) {
      console.error(`[/diagnostico-partido] Error con fixtureId ${fixtureId}:`, e);
      return res.status(500).json({ error: e.message });
    }
  }

  const competencia = req.query.competencia;
  const fecha = req.query.fecha; // YYYY-MM-DD
  if (!competencia || !fecha) {
    return res.status(400).json({ error: 'Faltan parámetros: "competencia" y "fecha" (YYYY-MM-DD), o "fixtureId".' });
  }

  const leagueId = leagueIdDeCompetencia(competencia);
  if (!leagueId) {
    return res.status(404).json({ error: `No conozco la competencia "${competencia}".` });
  }

  try {
    const resp = await fetch(`${BASE}/fixtures?league=${leagueId}&season=${TEMPORADA}&date=${fecha}`, { headers });
    const data = await resp.json();
    const fixtures = data?.response || [];

    if (fixtures.length === 0) {
      return res.json({
        competencia, leagueId, fecha,
        mensaje: `API-Football no tiene ningún fixture de "${competencia}" para el ${fecha} (temporada ${TEMPORADA}). Puede ser que la temporada no sea "${TEMPORADA}" para esta liga — probar sin fecha o con otra temporada.`,
        partidos: [],
      });
    }

    const partidos = fixtures.map((fx) => ({
      fixtureId: fx.fixture?.id ?? null,
      local: fx.teams?.home?.name || null,
      visita: fx.teams?.away?.name || null,
      estado: fx.fixture?.status?.short || null,
      fechaISO: fx.fixture?.date || null,
      // Esto es lo que importa: ¿la respuesta CRUDA de API-Football trae
      // algo en estos campos para ESTE partido puntual, más allá de lo que
      // diga el "coverage" general de la liga?
      tieneAlineaciones: Array.isArray(fx.lineups) && fx.lineups.length > 0,
      cantidadAlineaciones: Array.isArray(fx.lineups) ? fx.lineups.length : 0,
      tieneEventos: Array.isArray(fx.events) && fx.events.length > 0,
      cantidadEventos: Array.isArray(fx.events) ? fx.events.length : 0,
      tieneEstadisticas: Array.isArray(fx.statistics) && fx.statistics.length > 0,
      estadio: fx.fixture?.venue?.name || null,
      arbitro: fx.fixture?.referee || null,
    }));

    res.json({ competencia, leagueId, fecha, partidos });
  } catch (e) {
    console.error(`[/diagnostico-partido] Error con "${competencia}" ${fecha}:`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaDiagnosticoPartido };
