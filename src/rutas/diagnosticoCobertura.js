// GET /diagnostico-cobertura?competencia=Copa%20Chile — a pedido de Pablo,
// para saber CON CERTEZA qué datos trae realmente API-Football para cada
// competencia (alineaciones, estadísticas, eventos, tabla de posiciones,
// jugadores, árbitro no está acá porque API-Football no lo separa como
// "coverage", viene siempre que el fixture lo tenga cargado).
//
// El plan pago de API-Football (Pro/Ultra/Mega) HABILITA estos datos en
// general, pero la cobertura real es POR LIGA Y POR TEMPORADA — el propio
// endpoint /leagues devuelve un objeto "coverage" con true/false para cada
// competencia. Sin este chequeo, un partido sin alineaciones/estadísticas se
// ve igual desde la app tanto si es un bug nuestro como si la liga
// simplemente no está cubierta — este endpoint separa las dos cosas.
//
// Sin exigirSecreto (mismo criterio que /equipos, /posiciones-liga): es de
// solo lectura, no gasta cuota más que una consulta chica, y así Pablo puede
// pegarle directo desde el navegador para revisar una competencia.
const { TEMPORADA, leagueIdDeCompetencia, LIGAS } = require('../ligas');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const headers = { 'x-apisports-key': API_FOOTBALL_KEY };

async function obtenerCoberturaDeLiga(leagueId, season) {
  const resp = await fetch(`${BASE}/leagues?id=${leagueId}&season=${season}`, { headers });
  const data = await resp.json();
  const liga = data?.response?.[0];
  if (!liga) return null;
  const cobertura = liga.seasons?.find((s) => String(s.year) === String(season))?.coverage || null;
  return {
    liga: liga.league?.name || null,
    pais: liga.country?.name || null,
    temporada: season,
    // Tal cual lo manda API-Football: fixtures.{events, lineups, statistics_fixtures,
    // statistics_players}, standings, players, top_scorers, top_assists,
    // top_cards, injuries, predictions, odds.
    cobertura,
  };
}

async function rutaDiagnosticoCobertura(req, res) {
  const competencia = req.query.competencia;

  // Sin ?competencia= : chequea TODAS las ligas conocidas de una sola vez,
  // para tener el panorama completo en un solo llamado en vez de una
  // consulta por competencia.
  if (!competencia) {
    try {
      const resultados = await Promise.all(
        LIGAS.map(async (l) => {
          try {
            const info = await obtenerCoberturaDeLiga(l.leagueId, TEMPORADA);
            return { competencia: l.competencia, leagueId: l.leagueId, ...info };
          } catch (e) {
            return { competencia: l.competencia, leagueId: l.leagueId, error: e.message };
          }
        })
      );
      return res.json({ temporada: TEMPORADA, resultados });
    } catch (e) {
      console.error('[/diagnostico-cobertura] Error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  const leagueId = leagueIdDeCompetencia(competencia);
  if (!leagueId) {
    return res.status(404).json({ error: `No conozco la competencia "${competencia}". Revisa el nombre exacto en ligas.js.` });
  }

  try {
    const info = await obtenerCoberturaDeLiga(leagueId, TEMPORADA);
    if (!info) {
      return res.status(404).json({ error: `API-Football no devolvió datos para league id ${leagueId} en la temporada ${TEMPORADA}.` });
    }
    res.json({ competencia, leagueId, ...info });
  } catch (e) {
    console.error(`[/diagnostico-cobertura] Error trayendo cobertura de "${competencia}":`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaDiagnosticoCobertura };
