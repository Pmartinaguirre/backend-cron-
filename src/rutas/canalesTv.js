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

// SOLO partidos de HOY (a pedido, tras diagnosticar): futbolenvivochile.com
// arma la agenda de "hoy" directo en el HTML, pero los días siguientes los
// agrega con JavaScript en el navegador (scroll infinito) — nuestro backend
// pide el HTML crudo sin ejecutar JS, así que nunca los ve (confirmado con
// ?diagnosticoRaw=1: la respuesta cruda solo trae los partidos de hoy). Para
// partidos de días siguientes, Pablo sigue cargando el canal a mano hasta
// que se acerque la fecha — ahí este cron lo agarra solo.
const ZONA_CHILE = 'America/Santiago';

// ?diagnosticoRaw=1&slug=liga-argentina (a pedido, "encontró 2 partidos de
// HOY pero ninguno de los días siguientes" — para descartar de una que el
// fetch le esté llegando recortado/bloqueado por el sitio, ANTES de tocar
// el parser): pide el HTML crudo tal cual y cuenta tablas/filas, sin pasar
// por cheerio ni por la base. Sacar de la URL una vez resuelto.
async function rutaDiagnosticoRaw(req, res) {
  const slug = req.query.slug || 'liga-argentina';
  try {
    const resp = await fetch(`https://www.futbolenvivochile.com/competicion/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; demasterapp-bot/1.0; +https://demaster.app)' },
    });
    const html = await resp.text();
    res.json({
      status: resp.status,
      largoHtml: html.length,
      cantidadTablas: (html.match(/<table/gi) || []).length,
      cantidadFilas: (html.match(/<tr/gi) || []).length,
      primeros1000: html.slice(0, 1000),
      // Un pedazo del medio también, por si el recorte pasa a mitad de
      // camino (ej. un límite de tamaño de respuesta) en vez de al final.
      mitad1000: html.slice(Math.floor(html.length / 2), Math.floor(html.length / 2) + 1000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function rutaCanalesTv(req, res) {
  if (req.query.diagnosticoRaw === '1') return rutaDiagnosticoRaw(req, res);

  const ahora = new Date();
  const fechaHoyChile = ahora.toLocaleDateString('en-CA', { timeZone: ZONA_CHILE }); // 'YYYY-MM-DD'
  // Ventana amplia de 2 días alrededor de "ahora" en la consulta SQL (evita
  // calcular el límite exacto de medianoche en huso de Chile a mano) — el
  // filtro FINO por "es hoy en Chile" se hace más abajo, en JS, comparando
  // contra fechaHoyChile.
  const desde = new Date(ahora); desde.setDate(desde.getDate() - 1);
  const hasta = new Date(ahora); hasta.setDate(hasta.getDate() + 1);

  const { data: partidosVentana, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, tema, equipo_local, equipo_visitante, fecha_expiracion, canales_tv')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .in('tema', Object.keys(SLUGS_POR_COMPETENCIA))
    .is('canales_tv', null)
    .gte('fecha_expiracion', desde.toISOString())
    .lte('fecha_expiracion', hasta.toISOString());

  if (error) {
    console.error('[/canales-tv] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  const partidos = (partidosVentana || []).filter(
    (p) => new Date(p.fecha_expiracion).toLocaleDateString('en-CA', { timeZone: ZONA_CHILE }) === fechaHoyChile
  );

  const resultado = { revisados: partidos.length, actualizados: 0, sinCanalTodavia: 0, errores: [] };
  if (partidos.length === 0) {
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
