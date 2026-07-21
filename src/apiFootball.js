// Cliente chico para API-Football (api-sports.io) — centraliza las llamadas
// que necesitan los distintos cron endpoints, para no repetir headers/base
// URL en cada archivo.
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';

if (!API_FOOTBALL_KEY) {
  throw new Error('Falta API_FOOTBALL_KEY en las variables de entorno.');
}

const headers = { 'x-apisports-key': API_FOOTBALL_KEY };

// Bet id 1 = "Match Winner" (Local / Empate / Visita) en API-Football.
const BET_ID_MATCH_WINNER = 1;

// ---------- Cuotas (usado por /cuotas) ----------
// No anclamos a una casa de apuestas específica (no hay dinero real de por
// medio) — se toma la primera casa que tenga el mercado "Match Winner"
// completo para ese fixture.
async function obtenerCuotas(fixtureId) {
  const resp = await fetch(`${BASE}/odds?fixture=${fixtureId}`, { headers });
  const data = await resp.json();
  const bookmakers = data?.response?.[0]?.bookmakers || [];

  for (const bk of bookmakers) {
    const bet = (bk.bets || []).find((b) => b.id === BET_ID_MATCH_WINNER);
    if (!bet) continue;
    const home = bet.values.find((v) => v.value === 'Home');
    const draw = bet.values.find((v) => v.value === 'Draw');
    const away = bet.values.find((v) => v.value === 'Away');
    if (!home || !draw || !away) continue;
    return {
      cuota_local: parseFloat(home.odd),
      cuota_empate: parseFloat(draw.odd),
      cuota_visita: parseFloat(away.odd),
      casa: bk.name,
    };
  }
  return null; // todavía no hay cuotas cargadas para este fixture
}

// ---------- Estado del partido + marcador + goleadores (usado por /vivo y /resolver) ----------
// Devuelve null si la API no tiene datos para ese fixture (raro, pero por
// las dudas no se rompe el cron completo por un solo partido con problemas).
async function obtenerEstadoFixture(fixtureId) {
  const resp = await fetch(`${BASE}/fixtures?id=${fixtureId}`, { headers });
  const data = await resp.json();
  const fixture = data?.response?.[0];
  if (!fixture) return null;

  const estado = fixture.fixture?.status?.short || null; // NS, 1H, HT, 2H, FT, etc.
  const minuto = fixture.fixture?.status?.elapsed ?? null;
  const golesLocal = fixture.goals?.home ?? null;
  const golesVisita = fixture.goals?.away ?? null;

  // Eventos tipo "Goal" -> lista de {nombre, minuto} separada por equipo
  // local/visita (se compara el id del equipo del evento contra el id del
  // equipo local del fixture).
  const idEquipoLocal = fixture.teams?.home?.id;
  const eventos = fixture.events || [];
  const goleadoresLocal = [];
  const goleadoresVisita = [];
  eventos
    .filter((ev) => ev.type === 'Goal')
    .forEach((ev) => {
      const entrada = { nombre: ev.player?.name || 'Gol', minuto: ev.time?.elapsed ?? null };
      if (ev.team?.id === idEquipoLocal) goleadoresLocal.push(entrada);
      else goleadoresVisita.push(entrada);
    });

  return {
    estado,
    minuto,
    golesLocal,
    golesVisita,
    goleadoresLocal,
    goleadoresVisita,
  };
}

// ---------- Fixtures de una liga completa (usado por /crear-partidos) ----------
async function obtenerFixturesDeLiga(leagueId, season) {
  const resp = await fetch(`${BASE}/fixtures?league=${leagueId}&season=${season}`, { headers });
  const data = await resp.json();
  return data?.response || [];
}

module.exports = { obtenerCuotas, obtenerEstadoFixture, obtenerFixturesDeLiga };
