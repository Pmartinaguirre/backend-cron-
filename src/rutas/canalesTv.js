// GET/POST /canales-tv — llena AUTOMÁTICO los canales de TV de cada
// partido próximo (a pedido: "quiero mejorar la búsqueda de los canales de
// TV... actualmente lo estoy haciendo manual mirando cada partido en
// Wosti"). Reemplazado por dos reglas más simples y confiables que Pablo
// confirmó a mano (ver src/scraperTv.js para el detalle de cada una):
//
//   - CHILE (Primera, Copa Chile, Copa de la Liga): "siempre son los
//     mismos" — canal FIJO (CANALES_CHILE_DEFAULT), sin scraping.
//   - ARGENTINA (Primera División): se scrapea la ficha de "Disney+
//     Premium Chile" en livesoccertv.com (URL fija, a diferencia del
//     artículo semanal de ESPN.cl que cambia de id cada semana) — si el
//     partido aparece ahí, el canal es ESPN/Disney+; si no aparece, se
//     asume TyC Sports Internacional (regla de Pablo: "los demás partidos
//     los da TyC Sports Internacional, siempre es así").
//
// Requiere X-Cron-Secret porque escribe en la base (mismo criterio que
// /cuotas, /resolver, etc.).
const { supabase } = require('../supabaseClient');
const {
  obtenerAgendaDisneyArgentina,
  coincideEquipo,
  CANALES_CHILE_DEFAULT,
  COMPETENCIAS_CHILE,
  CANALES_ESPN_DISNEY,
  CANALES_TYC_DEFAULT,
} = require('../scraperTv');

const ZONA_CHILE = 'America/Santiago';
const TEMA_ARGENTINA = 'Primera División Argentina';

// livesoccertv.com solo publica unos pocos días hacia adelante en la
// primera página de la ficha del canal (después hay que paginar con
// "Next »", que todavía no está integrado acá) — con 6 días alcanza para
// que el cron lo vaya completando de a poco en cada corrida, sin quedar
// partidos "flotando" mucho tiempo esperando su canal.
const DIAS_VENTANA = Number(process.env.DIAS_VENTANA_CANALES_TV) || 6;

async function rutaCanalesTv(req, res) {
  const ahora = new Date();
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_VENTANA);

  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, tema, equipo_local, equipo_visitante, fecha_expiracion, canales_tv')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .in('tema', [...COMPETENCIAS_CHILE, TEMA_ARGENTINA])
    .is('canales_tv', null)
    .gte('fecha_expiracion', ahora.toISOString())
    .lte('fecha_expiracion', limite.toISOString());

  if (error) {
    console.error('[/canales-tv] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  const resultado = { revisados: (partidos || []).length, actualizados: 0, errores: [] };
  if (!partidos || partidos.length === 0) {
    return res.json(resultado);
  }

  const partidosChile = partidos.filter((p) => COMPETENCIAS_CHILE.includes(p.tema));
  const partidosArgentina = partidos.filter((p) => p.tema === TEMA_ARGENTINA);

  // CHILE: canal fijo, sin pedirle nada a nadie.
  for (const partido of partidosChile) {
    const { error: errUpdate } = await supabase
      .from('desafios_mvp')
      .update({ canales_tv: CANALES_CHILE_DEFAULT })
      .eq('id', partido.id);
    if (errUpdate) {
      resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
    } else {
      resultado.actualizados++;
    }
  }

  // ARGENTINA: se pide la agenda de Disney+ Chile UNA sola vez (no por
  // partido) y se cruza acá — si no matchea con ningún partido de la
  // agenda, cae al default de TyC (nunca queda "sin canal", que es
  // justo la regla que confirmó Pablo).
  if (partidosArgentina.length > 0) {
    let agenda = [];
    try {
      agenda = await obtenerAgendaDisneyArgentina();
    } catch (e) {
      console.error('[/canales-tv] Error scrapeando agenda Disney+ Argentina:', e);
      resultado.errores.push({ fuente: 'livesoccertv.com', error: e.message });
    }

    for (const partido of partidosArgentina) {
      const claveFechaPartido = new Date(partido.fecha_expiracion)
        .toLocaleDateString('en-CA', { timeZone: ZONA_CHILE }); // 'YYYY-MM-DD'

      // Orden local/visita a veces viene invertido en la URL del sitio (visto
      // en un caso real) — se prueba en los dos sentidos para no perder el
      // cruce por eso.
      const enAgenda = agenda.some((c) =>
        c.fecha === claveFechaPartido
        && (
          (coincideEquipo(c.equipoLocal, partido.equipo_local) && coincideEquipo(c.equipoVisita, partido.equipo_visitante))
          || (coincideEquipo(c.equipoLocal, partido.equipo_visitante) && coincideEquipo(c.equipoVisita, partido.equipo_local))
        )
      );

      const { error: errUpdate } = await supabase
        .from('desafios_mvp')
        .update({ canales_tv: enAgenda ? CANALES_ESPN_DISNEY : CANALES_TYC_DEFAULT })
        .eq('id', partido.id);
      if (errUpdate) {
        resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
      } else {
        resultado.actualizados++;
      }
    }
  }

  console.log(`[/canales-tv] ${resultado.actualizados} actualizados, ${resultado.errores.length} errores.`);
  res.json(resultado);
}

module.exports = { rutaCanalesTv };
