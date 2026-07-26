// GET /posiciones-liga?competencia=Primera%20División%20Chile — trae la tabla
// de posiciones real de esa competencia desde API-Football (puntos, PJ,
// diferencia de gol, etc.). La usa la app cuando el jugador toca el
// título/subtítulo de una tarjeta de partido.
//
// Mismo criterio que /equipos: NO exige el header X-Cron-Secret porque es de
// solo lectura y la llama directo el navegador del jugador — pedirle el
// secreto obligaría a exponerlo en el código del frontend, que es peor.
//
// Cachea en memoria por 10 minutos: una tabla de posiciones no cambia entre
// un partido y otro, y sin caché cada jugador que abre una tarjeta gastaría
// una consulta de la cuota de API-Football.
const { obtenerPosicionesDeLiga } = require('../apiFootball');
const { TEMPORADA, leagueIdDeCompetencia } = require('../ligas');

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // competencia -> { datos, expira }

async function rutaPosicionesLiga(req, res) {
  const competencia = req.query.competencia;
  if (!competencia) {
    return res.status(400).json({ error: 'Falta el parámetro "competencia".' });
  }

  const leagueId = leagueIdDeCompetencia(competencia);
  if (!leagueId) {
    return res.status(404).json({ error: `No hay tabla de posiciones para "${competencia}".` });
  }

  const enCache = cache.get(competencia);
  if (enCache && enCache.expira > Date.now()) {
    return res.json({ ...enCache.datos, deCache: true });
  }

  try {
    const posiciones = await obtenerPosicionesDeLiga(leagueId, TEMPORADA);
    if (!posiciones) {
      return res.status(404).json({ error: `API-Football no tiene tabla para "${competencia}" en ${TEMPORADA}.` });
    }
    const datos = { competencia, ...posiciones };
    cache.set(competencia, { datos, expira: Date.now() + CACHE_MS });
    res.json(datos);
  } catch (e) {
    console.error(`[/posiciones-liga] Error trayendo posiciones de "${competencia}":`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaPosicionesLiga };
