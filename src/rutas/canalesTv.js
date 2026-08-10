// GET/POST /canales-tv — busca AUTOMÁTICO en futbolenvivochile.com los
// canales de TV que transmiten cada partido próximo (a pedido: "quiero
// mejorar la búsqueda de los canales de TV... actualmente lo estoy haciendo
// manual mirando cada partido en Wosti, quiero ver como podemos hacer algo
// similar a lo que hacemos con YouTube").
//
// A DIFERENCIA de /media (YouTube, API oficial), esto es HTML scraping de
// una web de terceros sin API — más frágil, ver la nota grande en
// src/scraperTv.js. Requiere X-Cron-Secret porque escribe en la base
// (mismo criterio que /cuotas, /resolver, etc.).
//
// Alcance inicial (a pedido): solo Chile + Argentina — las mismas 4
// competencias que ya cubre la búsqueda automática de YouTube en media.js
// (ver SLUGS_POR_COMPETENCIA en scraperTv.js). Sumar otra competencia acá
// es agregar su slug ahí, nada más.
const { supabase } = require('../supabaseClient');
const { obtenerCanalesTv, coincideEquipo, SLUGS_POR_COMPETENCIA } = require('../scraperTv');

// Misma ventana que /cuotas por defecto: no tiene sentido revisar partidos
// muy lejos en el futuro — la web todavía no publica canal para esos, así
// que salen todos "sin canal todavía" y se gasta la corrida en vano.
const DIAS_VENTANA = Number(process.env.DIAS_VENTANA_CANALES_TV) || 10;

async function rutaCanalesTv(req, res) {
  const ahora = new Date();
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_VENTANA);

  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, tema, equipo_local, equipo_visitante, fecha_expiracion, canales_tv')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .in('tema', Object.keys(SLUGS_POR_COMPETENCIA))
    .is('canales_tv', null)
    .gte('fecha_expiracion', ahora.toISOString())
    .lte('fecha_expiracion', limite.toISOString());

  if (error) {
    console.error('[/canales-tv] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  const resultado = { revisados: (partidos || []).length, actualizados: 0, sinCanalTodavia: 0, errores: [] };
  if (!partidos || partidos.length === 0) {
    return res.json(resultado);
  }

  // Se scrapea UNA sola vez por competencia (no por partido) — mismo
  // criterio que media.js con los canales de YouTube: pedirle a la web una
  // vez la tabla completa de la competencia y cruzar acá adentro es mucho
  // más liviano que pedir partido por partido.
  const temas = [...new Set(partidos.map((p) => p.tema))];
  const scrapeadoPorTema = {};
  for (const tema of temas) {
    const slug = SLUGS_POR_COMPETENCIA[tema];
    try {
      scrapeadoPorTema[tema] = await obtenerCanalesTv(slug);
    } catch (e) {
      console.error(`[/canales-tv] Error scrapeando "${tema}" (${slug}):`, e);
      scrapeadoPorTema[tema] = [];
      resultado.errores.push({ tema, error: e.message });
    }
  }

  // ?diagnostico=1 (a pedido, "0 de 11 matchearon" — para ver SIN adivinar
  // si el scraper está trayendo filas de la web y, si las trae, por qué no
  // calzan contra nuestros partidos): responde lo que se scrapeó de cada
  // competencia + los partidos de la base tal como quedaron para comparar,
  // SIN escribir nada en la base. Sacar de la URL una vez resuelto.
  if (req.query.diagnostico === '1') {
    return res.json({
      scrapeadoPorTema,
      partidosBase: partidos.map((p) => ({
        id: p.id,
        tema: p.tema,
        equipo_local: p.equipo_local,
        equipo_visitante: p.equipo_visitante,
        fecha_chile: new Date(p.fecha_expiracion).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }),
      })),
    });
  }

  for (const partido of partidos) {
    const candidatos = scrapeadoPorTema[partido.tema] || [];
    // Fecha del partido en huso de Chile (America/Santiago), para
    // comparar contra la fecha que trae la web (que también publica en
    // hora de Chile) — comparar en UTC podría correr un partido nocturno
    // al día siguiente y perder el cruce.
    const claveFechaPartido = new Date(partido.fecha_expiracion)
      .toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }); // 'YYYY-MM-DD'

    const match = candidatos.find((c) =>
      c.fecha === claveFechaPartido
      && coincideEquipo(c.equipoLocal, partido.equipo_local)
      && coincideEquipo(c.equipoVisita, partido.equipo_visitante)
    );

    if (!match) {
      resultado.sinCanalTodavia++;
      continue;
    }

    const { error: errUpdate } = await supabase
      .from('desafios_mvp')
      .update({ canales_tv: match.canales })
      .eq('id', partido.id);
    if (errUpdate) {
      resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
    } else {
      resultado.actualizados++;
    }
  }

  console.log(`[/canales-tv] ${resultado.actualizados} actualizados, ${resultado.sinCanalTodavia} sin canal todavía, ${resultado.errores.length} errores.`);
  res.json(resultado);
}

module.exports = { rutaCanalesTv };
