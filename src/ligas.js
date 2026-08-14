// Mapa único de competencia -> id de liga en API-Football, compartido por
// /crear-partidos y /equipos (antes vivía duplicado dentro de
// crearPartidos.js). Mismos ids que usa vincular_fixtures.js, más Champions
// League (2) que no estaba en ese mapa viejo. Mundial 2026 (id 1) queda
// afuera a propósito — ver nota en crearPartidos.js.
// MODO DE CADA COMPETENCIA
//
//   'completa' → se crean TODOS los partidos de la fecha.
//   'tier_a'   → solo los partidos entre dos equipos de la lista Tier A.
//
// La diferencia no es un detalle de configuración, es de producto. Las ligas
// grandes de Europa y Argentina tienen 18-20 partidos por fecha, y traerlos
// todos ahogaría la lista: nadie pronostica un Getafe vs Alavés a las 4 de la
// mañana. Ahí solo interesan los partidos grandes.
//
// En cambio la liga chilena y las dos copas son las que el jugador sigue
// completas — no se le puede esconder media fecha de su propio campeonato.
//
// OJO: en estas tres, el GRUPO va a poder elegir después si juega la
// competencia completa o solo los Tier A. Esa elección filtra lo que se
// MUESTRA; para que pueda existir, los partidos tienen que estar creados. Por
// eso acá se crean todos: quitar un partido de la vista es fácil, inventarlo
// después no.
const MODO_COMPLETA = 'completa';
const MODO_TIER_A = 'tier_a';

const LIGAS = [
  { competencia: 'Copa Libertadores', leagueId: 13, modo: MODO_COMPLETA },
  { competencia: 'Copa Sudamericana', leagueId: 11, modo: MODO_COMPLETA },
  { competencia: 'Primera División Chile', leagueId: 265, modo: MODO_COMPLETA },
  // Copas nacionales de Chile (a pedido): mismo criterio que la liga chilena
  // — el jugador sigue completo su propio campeonato, no solo los partidos
  // entre grandes.
  { competencia: 'Copa Chile', leagueId: 267, modo: MODO_COMPLETA },
  { competencia: 'Copa de la Liga', leagueId: 1220, modo: MODO_COMPLETA },
  // Argentina pasó a COMPLETA (igual que Chile): se crean TODOS los partidos
  // de cada fecha, y el recorte a "solo grandes" es una decisión de cada
  // grupo (modo_competencias) o del jugador (filtro personal) — filtra lo que
  // se MUESTRA, no lo que existe. Para poder ocultar un partido primero hay
  // que tenerlo.
  // OJO: al cambiar una liga a completa hay que agregarla también a
  // COMPETENCIAS_CON_MODO en MisGrupos.jsx, si no el grupo no tiene dónde
  // elegir entre "Completa" y "Solo grandes".
  { competencia: 'Primera División Argentina', leagueId: 128, modo: MODO_COMPLETA },
  // Ligas de Europa pasaron a COMPLETA (a pedido): antes solo se creaban los
  // partidos Tier A, así que un grupo nunca podía elegir "completa" para
  // estas — no había nada más que mostrar. Ahora se crean TODOS los partidos
  // de la fecha y el recorte a "solo grandes" queda, igual que en Chile y
  // Argentina, como una elección de cada grupo (modo_competencias) o del
  // jugador (filtro personal). OJO: esto multiplica varias veces la cantidad
  // de partidos creados por semana (18-20 por fecha en vez de un puñado) —
  // más cuota de API-Football gastada en /crear-partidos y /cuotas.
  { competencia: 'Serie A Italia', leagueId: 135, modo: MODO_COMPLETA },
  { competencia: 'LALIGA España', leagueId: 140, modo: MODO_COMPLETA },
  { competencia: 'Premier League Inglaterra', leagueId: 39, modo: MODO_COMPLETA },
  { competencia: 'Ligue 1 Francia', leagueId: 61, modo: MODO_COMPLETA },
  { competencia: 'Champions League', leagueId: 2, modo: MODO_COMPLETA },
];

function modoDeCompetencia(competencia) {
  const liga = LIGAS.find((l) => l.competencia === competencia);
  // Por defecto tier_a: si alguien agrega una liga nueva y se olvida del
  // modo, es preferible que traiga de menos y no que inunde la app.
  return liga?.modo || MODO_TIER_A;
}

const TEMPORADA = process.env.API_FOOTBALL_SEASON || '2026';

function leagueIdDeCompetencia(competencia) {
  const liga = LIGAS.find((l) => l.competencia === competencia);
  return liga ? liga.leagueId : null;
}

module.exports = { LIGAS, TEMPORADA, leagueIdDeCompetencia, modoDeCompetencia, MODO_COMPLETA, MODO_TIER_A };
