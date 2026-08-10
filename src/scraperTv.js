// Scraper de futbolenvivochile.com — a pedido: "quiero mejorar la búsqueda
// de los canales de TV, actualmente lo estoy haciendo manual mirando cada
// partido en Wosti (futbolenvivochile.com), ver cómo hacer algo similar a
// lo que hacemos con YouTube".
//
// OJO, diferencia importante con media.js: YouTube tiene una API OFICIAL
// (YouTube Data API v3) con contrato estable. futbolenvivochile.com NO
// tiene API pública — esto es HTML SCRAPING de una web de terceros. Es más
// frágil: si el sitio cambia el diseño de su tabla de partidos, este
// archivo deja de encontrar filas y /canales-tv simplemente deja de
// actualizar canales (no revienta, pero tampoco avisa solo). Si algún día
// "dejaron de llegar los canales", revisar PRIMERO si cambió el HTML de esa
// página antes de sospechar de otra cosa.
//
// Cada página de competencia (ej. /competicion/primera-division-chile) trae
// una tabla larga con TODOS los próximos partidos de ese torneo, agrupados
// por fecha: filas de 1 sola celda con el encabezado de fecha ("Lunes,
// 10-08-2026", o "Partidos de hoy lunes, ..."), seguidas de filas de
// partido (hora, escudo+nombre local, escudo+nombre visita, lista de
// canales). Se pide UNA vez por competencia (no por partido), igual
// criterio que ya usa media.js con los canales de YouTube.
const cheerio = require('cheerio');

// Slugs confirmados a mano navegando el sitio (a pedido, alcance inicial:
// "Chile + Argentina", las mismas 4 competencias que ya cubre la búsqueda
// automática de YouTube en media.js). Agregar acá cualquier competencia
// nueva que se quiera sumar más adelante.
const SLUGS_POR_COMPETENCIA = {
  'Primera División Chile': 'primera-division-chile',
  'Copa Chile': 'copa-chile',
  'Copa de la Liga': 'copa-de-la-liga-chile',
  'Primera División Argentina': 'liga-argentina',
};

// Normaliza un nombre de equipo para poder comparar el de nuestra base
// (viene de API-Football) contra el que usa futbolenvivochile.com — casi
// nunca son IDÉNTICOS letra por letra ("CDU Católica" vs "Universidad
// Católica", "U de Chile" vs "Universidad de Chile"), así que se sacan
// tildes, mayúsculas, espacios y palabras genéricas que no aportan (club,
// deportivo, fc, cd) y se compara lo que queda.
function normalizarEquipo(nombre) {
  return (nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(cd|cf|fc|club|deportivo|deportes|atletico|de|del|la|el)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Coincidencia por CONTENCIÓN, no igualdad exacta: "udechile" (nuestro
// nombre normalizado) debe calzar con "udechile" o similar del sitio, y
// "universidadcatolica" con "cducatolica" ya no matchea ni por contención
// (por eso el nombre corto "U Católica" en nuestra base es más seguro que
// el largo) — es una heurística, no un cruce perfecto; ver nota de riesgo
// arriba del archivo.
function coincideEquipo(a, b) {
  const na = normalizarEquipo(a);
  const nb = normalizarEquipo(b);
  if (!na || !nb || na.length < 3 || nb.length < 3) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function obtenerCanalesTv(slug) {
  const resp = await fetch(`https://www.futbolenvivochile.com/competicion/${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; demasterapp-bot/1.0; +https://demaster.app)' },
  });
  if (!resp.ok) return [];
  const html = await resp.text();
  const $ = cheerio.load(html);
  const partidos = [];
  let fechaActual = null; // 'YYYY-MM-DD', se actualiza en cada fila de encabezado de fecha

  $('table tr').each((_, tr) => {
    const $tr = $(tr);
    const celdas = $tr.find('td');

    // Fila de encabezado de fecha: 1 sola celda con texto tipo "Lunes,
    // 10-08-2026" o "Partidos de hoy lunes, 10-08-2026".
    if (celdas.length <= 1) {
      const texto = $tr.text().trim();
      const m = texto.match(/(\d{2})-(\d{2})-(\d{4})/);
      if (m) fechaActual = `${m[3]}-${m[2]}-${m[1]}`;
      return;
    }

    if (!fechaActual) return; // fila rara antes del primer encabezado de fecha

    const hora = $(celdas[0]).text().trim();
    if (!/^\d{1,2}:\d{2}$/.test(hora)) return; // no es una fila de partido

    const equipos = $tr.find('a[href*="/equipo/"]');
    if (equipos.length < 2) return;
    const equipoLocal = $(equipos[0]).text().trim();
    const equipoVisita = $(equipos[1]).text().trim();

    const canales = [];
    $tr.find('a[href*="/canal/"]').each((__, a) => {
      const nombreCanal = $(a).text().trim();
      if (nombreCanal) canales.push(nombreCanal);
    });
    // Solo se toman los canales que vienen como link — algunas filas traen
    // un canal más suelto como texto plano sin <a> (sin separador
    // confiable entre nombres); mejor traer ALGUNOS canales bien que
    // inventar un separador y partir mal un nombre.
    if (canales.length === 0) return;

    partidos.push({ fecha: fechaActual, hora, equipoLocal, equipoVisita, canales });
  });

  return partidos;
}

module.exports = { obtenerCanalesTv, coincideEquipo, normalizarEquipo, SLUGS_POR_COMPETENCIA };
