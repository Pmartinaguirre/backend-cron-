// GET/POST /canales-tv — combina las DOS fuentes (a pedido: "hagamos una
// combinación de las dos soluciones"):
//
//   - CHILE (Primera, Copa Chile, Copa de la Liga): "siempre son los
//     mismos" — canal FIJO (CANALES_CHILE_DEFAULT), sin scraping.
//
//   - ARGENTINA (Primera División), en DOS PASADAS:
//     1) Con anticipación (cualquier día ANTES de hoy dentro de la
//        ventana): se usa livesoccertv.com/channels/starpluscl/ (agenda de
//        Disney+ Chile, URL fija) para dejar un canal GENÉRICO ya cargado
//        ("ESPN"/"Disney+ Premium" si aparece ahí, si no "TyC Sports
//        Internacional") — mejor tener algo genérico con días de
//        anticipación que nada.
//     2) El DÍA DEL PARTIDO: se scrapea futbolenvivochile.com (Wosti), que
//        SÍ trae el canal EXACTO cuando hay varios ESPN en juego (ESPN 2,
//        ESPN 5, ESPN 7...) — si encuentra el partido, PISA lo que haya
//        (genérico o no) con el dato exacto. Si Wosti no lo encuentra ese
//        día (pasa, no es 100% confiable) y todavía no tiene nada cargado,
//        cae al genérico de la pasada 1 como red de respaldo.
//
// Requiere X-Cron-Secret porque escribe en la base (mismo criterio que
// /cuotas, /resolver, etc.). Ver src/scraperTv.js para el detalle de cada
// fuente y sus limitaciones (ninguna es una API oficial).
const { supabase } = require('../supabaseClient');
const {
  obtenerCanalesTv,
  obtenerAgendaDisneyArgentina,
  coincideEquipo,
  SLUGS_POR_COMPETENCIA,
  CANALES_CHILE_DEFAULT,
  COMPETENCIAS_CHILE,
  CANALES_ESPN_DISNEY,
  CANALES_TYC_DEFAULT,
} = require('../scraperTv');

const ZONA_CHILE = 'America/Santiago';
const TEMA_ARGENTINA = 'Primera División Argentina';

// Ventana para la pasada 1 (livesoccertv, genérico con anticipación) — ver
// nota en canalesTv.js viejo: la primera página de esa ficha de canal solo
// trae unos pocos días hacia adelante, esto se va completando de a poco en
// cada corrida del cron.
const DIAS_VENTANA = Number(process.env.DIAS_VENTANA_CANALES_TV) || 6;

function fechaChileDe(fechaISO) {
  return new Date(fechaISO).toLocaleDateString('en-CA', { timeZone: ZONA_CHILE }); // 'YYYY-MM-DD'
}

async function rutaCanalesTv(req, res) {
  const ahora = new Date();
  const fechaHoyChile = fechaChileDe(ahora.toISOString());
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_VENTANA);

  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, tema, equipo_local, equipo_visitante, fecha_expiracion, canales_tv')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .in('tema', [...COMPETENCIAS_CHILE, TEMA_ARGENTINA])
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

  const partidosChile = partidos.filter((p) => COMPETENCIAS_CHILE.includes(p.tema) && p.canales_tv == null);
  const partidosArgentina = partidos.filter((p) => p.tema === TEMA_ARGENTINA);
  const argentinaHoy = partidosArgentina.filter((p) => fechaChileDe(p.fecha_expiracion) === fechaHoyChile);
  const argentinaResto = partidosArgentina.filter((p) => fechaChileDe(p.fecha_expiracion) !== fechaHoyChile && p.canales_tv == null);

  // CHILE: canal fijo, sin pedirle nada a nadie.
  for (const partido of partidosChile) {
    const { error: errUpdate } = await supabase
      .from('desafios_mvp')
      .update({ canales_tv: CANALES_CHILE_DEFAULT })
      .eq('id', partido.id);
    if (errUpdate) resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
    else resultado.actualizados++;
  }

  // PASADA 1 — Argentina, días distintos a hoy: agenda genérica de
  // livesoccertv (ESPN/Disney+ si aparece, si no TyC). Solo se pide si hace
  // falta (hay partidos de Argentina sin canal fuera de hoy).
  let agendaDisney = null; // se carga perezoso, una sola vez
  const cargarAgendaDisney = async () => {
    if (agendaDisney !== null) return agendaDisney;
    try {
      agendaDisney = await obtenerAgendaDisneyArgentina();
    } catch (e) {
      console.error('[/canales-tv] Error scrapeando agenda Disney+ Argentina:', e);
      resultado.errores.push({ fuente: 'livesoccertv.com', error: e.message });
      agendaDisney = [];
    }
    return agendaDisney;
  };

  const enAgendaDisney = (agenda, partido) => {
    const claveFecha = fechaChileDe(partido.fecha_expiracion);
    return agenda.some((c) =>
      c.fecha === claveFecha
      && (
        (coincideEquipo(c.equipoLocal, partido.equipo_local) && coincideEquipo(c.equipoVisita, partido.equipo_visitante))
        || (coincideEquipo(c.equipoLocal, partido.equipo_visitante) && coincideEquipo(c.equipoVisita, partido.equipo_local))
      )
    );
  };

  if (argentinaResto.length > 0) {
    const agenda = await cargarAgendaDisney();
    for (const partido of argentinaResto) {
      const canal = enAgendaDisney(agenda, partido) ? CANALES_ESPN_DISNEY : CANALES_TYC_DEFAULT;
      const { error: errUpdate } = await supabase.from('desafios_mvp').update({ canales_tv: canal }).eq('id', partido.id);
      if (errUpdate) resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
      else resultado.actualizados++;
    }
  }

  // PASADA 2 — Argentina, HOY: Wosti trae el canal EXACTO (ESPN 2/5/7...).
  // Se pisa lo que haya (venga o no de la pasada 1 de una corrida
  // anterior), porque acá el dato es más preciso. Si Wosti no encuentra el
  // partido y todavía no tiene nada cargado, cae al genérico como red de
  // respaldo (nunca debería quedar "sin canal" un partido que juega hoy).
  if (argentinaHoy.length > 0) {
    let scrapeadoWosti = [];
    try {
      scrapeadoWosti = await obtenerCanalesTv(SLUGS_POR_COMPETENCIA[TEMA_ARGENTINA]);
    } catch (e) {
      console.error('[/canales-tv] Error scrapeando Wosti Argentina:', e);
      resultado.errores.push({ fuente: 'futbolenvivochile.com', error: e.message });
    }

    for (const partido of argentinaHoy) {
      const claveFecha = fechaChileDe(partido.fecha_expiracion);
      const matchWosti = scrapeadoWosti.find((c) =>
        c.fecha === claveFecha
        && coincideEquipo(c.equipoLocal, partido.equipo_local)
        && coincideEquipo(c.equipoVisita, partido.equipo_visitante)
      );

      let canal = null;
      if (matchWosti) {
        canal = matchWosti.canales; // exacto, pisa lo que haya
      } else if (partido.canales_tv == null) {
        const agenda = await cargarAgendaDisney();
        canal = enAgendaDisney(agenda, partido) ? CANALES_ESPN_DISNEY : CANALES_TYC_DEFAULT;
      }
      if (canal == null) continue; // ya tenía algo genérico y Wosti no mejoró nada hoy: se deja como está

      const { error: errUpdate } = await supabase.from('desafios_mvp').update({ canales_tv: canal }).eq('id', partido.id);
      if (errUpdate) resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
      else resultado.actualizados++;
    }
  }

  console.log(`[/canales-tv] ${resultado.actualizados} actualizados, ${resultado.errores.length} errores.`);
  res.json(resultado);
}

module.exports = { rutaCanalesTv };
