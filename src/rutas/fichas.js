// GET /jugador?id=123   — ficha de un jugador + su historial de transferencias
// GET /club?id=456       — ficha de un club + sus últimos 5 partidos
//
// Las abre el jugador al tocar una foto en la cancha de alineaciones o el
// escudo de un equipo. Mismo criterio que /detalle-partido y /posiciones-liga:
// NO exigen X-Cron-Secret porque son de solo lectura y las llama directo el
// navegador.
//
// SOBRE LA CACHÉ Y LA CUOTA
//
// Estos endpoints los dispara un toque del usuario, o sea que la cantidad de
// llamadas no la controlamos nosotros: la controla cuánta gente ande curiosa.
// Sin caché, veinte personas tocando el mismo jugador durante un partido son
// cuarenta llamadas a API-Football (dos por ficha). Con caché, son dos.
//
// Los tiempos son largos a propósito, porque el dato casi no cambia:
//   - Ficha de jugador: 24 h. La altura, el pie hábil y la nacionalidad no
//     cambian nunca; las transferencias, un par de veces al año.
//   - Ficha de club: 30 min. Los últimos 5 partidos sí se mueven, pero solo
//     cuando termina uno.
const { obtenerFichaJugador, obtenerFichaClub, obtenerPlantelClub } = require('../apiFootball');

const CACHE_JUGADOR_MS = 24 * 60 * 60 * 1000;

const cacheJugador = new Map(); // id -> { datos, expira }
// OJO: los clubes ya NO se cachean acá. Su caché se mudó adentro de
// obtenerFichaClub (src/apiFootball.js) porque /forma también la necesita, y
// desde una ruta no la podía aprovechar.

// El caché vive en memoria del proceso y Render reinicia el servicio cada
// tanto (y lo duerme en el plan gratis), así que se vacía solo. Aun así se le
// pone un tope: si alguien recorre 5.000 jugadores distintos, no queremos que
// el proceso se quede sin memoria por guardarlos todos.
const MAX_ENTRADAS = 500;
function guardarEnCache(cache, clave, datos, ms) {
  if (cache.size >= MAX_ENTRADAS) {
    // Se borra la entrada más vieja (Map conserva el orden de inserción).
    cache.delete(cache.keys().next().value);
  }
  cache.set(clave, { datos, expira: Date.now() + ms });
}

async function rutaJugador(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta el parámetro "id".' });

  const enCache = cacheJugador.get(String(id));
  if (enCache && enCache.expira > Date.now()) {
    return res.json({ ...enCache.datos, deCache: true });
  }

  try {
    const ficha = await obtenerFichaJugador(id);
    if (!ficha) {
      return res.status(404).json({ error: `API-Football no tiene datos del jugador ${id}.` });
    }
    guardarEnCache(cacheJugador, String(id), ficha, CACHE_JUGADOR_MS);
    res.json(ficha);
  } catch (e) {
    console.error(`[/jugador] Error con el jugador ${id}:`, e);
    res.status(500).json({ error: e.message });
  }
}

async function rutaClub(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta el parámetro "id".' });

  try {
    // obtenerFichaClub ya cachea 30 min por su cuenta (ver apiFootball.js).
    const ficha = await obtenerFichaClub(id);
    if (!ficha) {
      return res.status(404).json({ error: `API-Football no tiene datos del club ${id}.` });
    }
    res.json(ficha);
  } catch (e) {
    console.error(`[/club] Error con el club ${id}:`, e);
    res.status(500).json({ error: e.message });
  }
}

// GET /plantel?id=456 — plantel completo del club (entrenador + jugadores
// agrupados por posición), para la pestaña "Plantel" de la ficha de equipo
// (a pedido). obtenerPlantelClub ya cachea 12 h por su cuenta.
async function rutaPlantel(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta el parámetro "id".' });

  try {
    const plantel = await obtenerPlantelClub(id);
    if (!plantel) {
      return res.status(404).json({ error: `API-Football no tiene plantel cargado para el club ${id}.` });
    }
    res.json(plantel);
  } catch (e) {
    console.error(`[/plantel] Error con el club ${id}:`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaJugador, rutaClub, rutaPlantel };
