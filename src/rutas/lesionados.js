// GET /lesionados?fixtureId=123456 — jugadores lesionados o suspendidos para
// ESE partido puntual, de los dos equipos — para el módulo de abajo de la
// pestaña "Alineaciones" de la tarjeta de partido (a pedido: "Agrega abajo
// jugadores lesionados o suspendidos para este partido").
//
// Mismo criterio que /equipos, /posiciones-liga y /historial-enfrentamientos:
// NO exige X-Cron-Secret (solo lectura, la llama directo el navegador del
// jugador) y cachea en memoria — la lista de bajas de un partido no cambia
// de un minuto a otro, así que 30 minutos alcanza de sobra sin pedirle a
// API-Football en cada apertura de la tarjeta.
const { obtenerLesionados } = require('../apiFootball');

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map(); // fixtureId -> { datos, expira }

async function rutaLesionados(req, res) {
  const fixtureId = req.query.fixtureId;
  if (!fixtureId) {
    return res.status(400).json({ error: 'Falta el parámetro "fixtureId".' });
  }

  const enCache = cache.get(String(fixtureId));
  if (enCache && enCache.expira > Date.now()) {
    return res.json({ ...enCache.datos, deCache: true });
  }

  try {
    const jugadores = await obtenerLesionados(fixtureId);
    const datos = { jugadores };
    cache.set(String(fixtureId), { datos, expira: Date.now() + CACHE_MS });
    res.json(datos);
  } catch (e) {
    console.error(`[/lesionados] Error con el fixture ${fixtureId}:`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaLesionados };
