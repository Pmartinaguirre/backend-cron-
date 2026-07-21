// Mapa único de competencia -> id de liga en API-Football, compartido por
// /crear-partidos y /equipos (antes vivía duplicado dentro de
// crearPartidos.js). Mismos ids que usa vincular_fixtures.js, más Champions
// League (2) que no estaba en ese mapa viejo. Mundial 2026 (id 1) queda
// afuera a propósito — ver nota en crearPartidos.js.
const LIGAS = [
  { competencia: 'Copa Libertadores', leagueId: 13 },
  { competencia: 'Copa Sudamericana', leagueId: 11 },
  { competencia: 'Primera División Argentina', leagueId: 128 },
  { competencia: 'Serie A Italia', leagueId: 135 },
  { competencia: 'LALIGA España', leagueId: 140 },
  { competencia: 'Premier League Inglaterra', leagueId: 39 },
  { competencia: 'Primera División Chile', leagueId: 265 },
  { competencia: 'Ligue 1 Francia', leagueId: 61 },
  { competencia: 'Champions League', leagueId: 2 },
];

const TEMPORADA = process.env.API_FOOTBALL_SEASON || '2026';

function leagueIdDeCompetencia(competencia) {
  const liga = LIGAS.find((l) => l.competencia === competencia);
  return liga ? liga.leagueId : null;
}

module.exports = { LIGAS, TEMPORADA, leagueIdDeCompetencia };
