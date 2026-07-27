// GET /detalle-partido?fixtureId=123456 — devuelve el detalle completo de un
// partido para las pestañas "Resumen" y "Alineaciones" de la tarjeta:
// eventos (goles, tarjetas, cambios, VAR), formaciones con titulares y
// suplentes, y estadísticas (tiros, posesión, corners...).
//
// Mismo criterio que /equipos y /posiciones-liga: NO exige X-Cron-Secret
// porque es de solo lectura y lo llama directo el navegador del jugador.
//
// Caché en memoria con dos tiempos distintos según el estado del partido:
//   - Partido EN CURSO: 60 segundos. Los eventos cambian todo el tiempo, así
//     que se refresca seguido, pero igual se evita que 8 jugadores mirando
//     el mismo partido disparen 8 consultas por segundo.
//   - Partido TERMINADO: 6 horas. Ya no va a cambiar nunca más; volver a
//     pedirlo sería quemar cuota de API-Football al pedo.
const { obtenerDetalleFixture } = require('../apiFootball');

const CACHE_EN_VIVO_MS = 60 * 1000;
const CACHE_TERMINADO_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // fixtureId -> { datos, expira }

async function rutaDetallePartido(req, res) {
  const fixtureId = req.query.fixtureId;
  if (!fixtureId) {
    return res.status(400).json({ error: 'Falta el parámetro "fixtureId".' });
  }

  // &refrescar=1 salta la caché. Hace falta cada vez que se agrega un campo
  // nuevo al detalle (ids de jugador, grid, etc.): los partidos ya
  // terminados quedan guardados 6 horas con el formato VIEJO, así que
  // desplegar el backend no alcanza para verlos actualizados. Mismo
  // mecanismo que ya tiene /posiciones-liga.
  const forzar = req.query.refrescar === '1';
  const enCache = cache.get(String(fixtureId));
  if (!forzar && enCache && enCache.expira > Date.now()) {
    return res.json({ ...enCache.datos, deCache: true });
  }

  try {
    const detalle = await obtenerDetalleFixture(fixtureId);
    if (!detalle) {
      return res.status(404).json({ error: `API-Football no tiene datos del partido ${fixtureId}.` });
    }
    // "terminado" lo decide quien llama (la app manda &terminado=1 para los
    // partidos ya cerrados) — así el backend no tiene que volver a mirar el
    // estado para decidir cuánto cachear.
    const esTerminado = req.query.terminado === '1';
    cache.set(String(fixtureId), {
      datos: detalle,
      expira: Date.now() + (esTerminado ? CACHE_TERMINADO_MS : CACHE_EN_VIVO_MS),
    });
    res.json(detalle);
  } catch (e) {
    console.error(`[/detalle-partido] Error con el fixture ${fixtureId}:`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaDetallePartido };
