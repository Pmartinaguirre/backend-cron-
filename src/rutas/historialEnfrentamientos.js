// GET /historial-enfrentamientos?local=ID&visita=ID — trae los últimos
// cruces YA TERMINADOS entre dos equipos (cualquier competencia), para el
// módulo "Historial de enfrentamientos" de la tarjeta de partido (a pedido,
// va después de "Últimos partidos"). ID = equipo_local_id/equipo_visita_id
// de desafios_mvp (id de API-Football, no el nombre).
//
// Mismo criterio que /equipos y /posiciones-liga: NO exige X-Cron-Secret
// (solo lectura, la llama directo el navegador del jugador) y cachea en
// memoria por par de equipos — un cruce histórico no cambia de un partido a
// otro entre los mismos dos equipos en el mismo día.
const { obtenerHeadToHead } = require('../apiFootball');

const CACHE_MS = 60 * 60 * 1000; // 1 hora — más largo que /posiciones-liga porque esto cambia MUCHO menos seguido
const cache = new Map(); // "idLocal-idVisita" -> { datos, expira }

async function rutaHistorialEnfrentamientos(req, res) {
  const idLocal = req.query.local;
  const idVisita = req.query.visita;
  if (!idLocal || !idVisita) {
    return res.status(400).json({ error: 'Faltan los parámetros "local" y "visita" (ids de equipo de API-Football).' });
  }

  const clave = `${idLocal}-${idVisita}`;
  const enCache = cache.get(clave);
  if (enCache && enCache.expira > Date.now()) {
    return res.json({ ...enCache.datos, deCache: true });
  }

  try {
    const partidos = await obtenerHeadToHead(idLocal, idVisita);
    const datos = { partidos };
    cache.set(clave, { datos, expira: Date.now() + CACHE_MS });
    res.json(datos);
  } catch (e) {
    console.error(`[/historial-enfrentamientos] Error trayendo h2h ${idLocal} vs ${idVisita}:`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaHistorialEnfrentamientos };
