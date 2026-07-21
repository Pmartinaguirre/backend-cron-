// GET /equipos?competencia=Primera%20División%20Chile — trae la lista real
// de equipos de esa competencia directo desde API-Football, con su nombre
// EXACTO (mismo texto que después usa /crear-partidos para armar los
// partidos). El Admin de sementomvp.jsx la usa para poblar el selector de
// "Equipos Tier A" — así lo que el admin elige siempre calza con lo que trae
// el cron, sin depender de que alguien tipeé el nombre igual a mano.
//
// A propósito NO exige el header X-Cron-Secret: es de solo lectura (no
// escribe nada, no cuesta cuota de API-Football sensible) y el navegador del
// Admin la llama directo — pedirle el secreto obligaría a exponerlo en el
// código del frontend, que es peor.
const { obtenerEquiposDeLiga } = require('../apiFootball');
const { TEMPORADA, leagueIdDeCompetencia } = require('../ligas');

async function rutaEquipos(req, res) {
  const competencia = req.query.competencia;
  if (!competencia) {
    return res.status(400).json({ error: 'Falta el parámetro "competencia".' });
  }

  const leagueId = leagueIdDeCompetencia(competencia);
  if (!leagueId) {
    return res.status(404).json({ error: `No conozco el id de liga para "${competencia}".` });
  }

  try {
    const equipos = await obtenerEquiposDeLiga(leagueId, TEMPORADA);
    res.json({ competencia, equipos });
  } catch (e) {
    console.error(`[/equipos] Error trayendo equipos de "${competencia}":`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaEquipos };
