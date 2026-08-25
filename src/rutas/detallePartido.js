// GET /detalle-partido?fixtureId=123456 — devuelve el detalle completo de un
// partido para las pestañas "Resumen" y "Alineaciones" de la tarjeta:
// eventos (goles, tarjetas, cambios, VAR), formaciones con titulares y
// suplentes, y estadísticas (tiros, posesión, corners...).
//
// Mismo criterio que /equipos y /posiciones-liga: NO exige X-Cron-Secret
// porque es de solo lectura y lo llama directo el navegador del jugador.
//
// SNAPSHOT FIJO en Supabase (a pedido: "cuando un partido está terminado que
// la data quede fija, no consultando siempre — a veces no carga y es pésima
// experiencia"). Antes de esto, un partido TERMINADO se guardaba 6 horas en
// un caché EN MEMORIA de este mismo proceso — que se pierde cada vez que
// Render reinicia el servicio, y que igual vuelve a pedirle el dato a
// API-Football pasadas esas 6 horas, aunque el partido ya nunca más vaya a
// cambiar. Ese repedido es justo el momento en que la vista fallaba si
// API-Football estaba teniendo un mal día (visto de cerca esta misma sesión
// con varios partidos de Sudamérica).
//
// Ahora, para un partido terminado, la respuesta se guarda PARA SIEMPRE en
// la columna `desafios_mvp.detalle_snapshot` la primera vez que sale
// completa — de ahí en adelante esa fila nunca más le vuelve a preguntar
// nada a API-Football, sin importar cuánto tiempo pase ni cuántas veces se
// reinicie el servidor.
//
// OJO con guardarlo de más: un partido recién llegado a FT a veces todavía
// no tiene alineaciones/estadísticas completas en API-Football (visto hoy
// con Huachipato-Limache) — grabar ESE estado incompleto como fijo lo
// dejaría roto para siempre. Por eso solo se persiste si la respuesta trae
// AL MENOS UNA de las tres cosas (eventos, alineaciones o estadísticas) —
// una respuesta totalmente vacía se sirve una vez pero no se fija, así la
// próxima visita vuelve a intentar en vez de quedar vacía por siempre.
//
// Sigue existiendo &refrescar=1 para forzar un re-pedido a API-Football
// incluso con snapshot ya guardado (por si hace falta corregir algo a mano,
// mismo mecanismo que ya usaba el caché en memoria para formatos viejos).
const { obtenerDetalleFixture } = require('../apiFootball');
const { supabase } = require('../supabaseClient');

const CACHE_EN_VIVO_MS = 60 * 1000;
const CACHE_TERMINADO_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // fixtureId -> { datos, expira }

// Un detalle "sirve" para guardarse fijo si trae contenido real en al menos
// uno de los tres bloques — si los tres vienen vacíos, probablemente
// API-Football todavía no terminó de publicar el partido.
function tieneContenido(detalle) {
  return (Array.isArray(detalle.eventos) && detalle.eventos.length > 0)
    || !!detalle.alineacionLocal
    || !!detalle.alineacionVisita
    || (Array.isArray(detalle.estadisticas) && detalle.estadisticas.length > 0);
}

async function rutaDetallePartido(req, res) {
  const fixtureId = req.query.fixtureId;
  if (!fixtureId) {
    return res.status(400).json({ error: 'Falta el parámetro "fixtureId".' });
  }

  // &refrescar=1 salta TANTO el caché en memoria como el snapshot fijo de
  // Supabase — hace falta cada vez que se agrega un campo nuevo al detalle,
  // o para corregir a mano un partido que quedó con un snapshot incompleto.
  const forzar = req.query.refrescar === '1';
  const esTerminado = req.query.terminado === '1';

  // 1) Snapshot fijo en Supabase — SOLO tiene sentido buscarlo para
  //    partidos terminados (uno en vivo no puede tener snapshot todavía).
  if (esTerminado && !forzar) {
    const { data: filaSnapshot, error: errSnapshot } = await supabase
      .from('desafios_mvp')
      .select('detalle_snapshot')
      .eq('fixture_id_api', Number(fixtureId))
      .not('detalle_snapshot', 'is', null)
      .limit(1)
      .maybeSingle();
    if (errSnapshot) {
      console.error(`[/detalle-partido] Error leyendo snapshot del fixture ${fixtureId}:`, errSnapshot);
      // No corta acá — si falla la lectura del snapshot, sigue de largo y
      // pide a API-Football como si no hubiera snapshot, en vez de romper
      // la pantalla del jugador por un problema de Supabase.
    } else if (filaSnapshot?.detalle_snapshot) {
      return res.json({ ...filaSnapshot.detalle_snapshot, deCache: true, snapshotFijo: true });
    }
  }

  // 2) Caché en memoria (partidos en vivo, o terminados sin snapshot
  //    todavía — mientras tanto amortigua pedidos repetidos).
  const enCache = cache.get(String(fixtureId));
  if (!forzar && enCache && enCache.expira > Date.now()) {
    return res.json({ ...enCache.datos, deCache: true });
  }

  try {
    const detalle = await obtenerDetalleFixture(fixtureId);
    if (!detalle) {
      return res.status(404).json({ error: `API-Football no tiene datos del partido ${fixtureId}.` });
    }
    cache.set(String(fixtureId), {
      datos: detalle,
      expira: Date.now() + (esTerminado ? CACHE_TERMINADO_MS : CACHE_EN_VIVO_MS),
    });

    // 3) Si es un partido terminado y la respuesta trae contenido real,
    //    se fija PARA SIEMPRE — se actualizan TODAS las filas con este
    //    fixture_id_api (Cat.4 y Cat.5 son partidos separados pero comparten
    //    el mismo fixture real, así que comparten el mismo snapshot).
    if (esTerminado && tieneContenido(detalle)) {
      const { error: errGuardar } = await supabase
        .from('desafios_mvp')
        .update({ detalle_snapshot: detalle })
        .eq('fixture_id_api', Number(fixtureId));
      if (errGuardar) {
        console.error(`[/detalle-partido] Error guardando snapshot del fixture ${fixtureId}:`, errGuardar);
      }
    }

    res.json(detalle);
  } catch (e) {
    console.error(`[/detalle-partido] Error con el fixture ${fixtureId}:`, e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaDetallePartido };
