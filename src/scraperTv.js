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
//
// YA NO SE USA para Chile (ver CANALES_CHILE_DEFAULT más abajo) ni para
// Argentina (ver obtenerAgendaDisneyArgentina) — el scraping de
// futbolenvivochile.com quedó solo como respaldo/referencia por si algún
// día se agrega otra competencia que no tenga una fuente mejor.
const SLUGS_POR_COMPETENCIA = {
  'Primera División Chile': 'primera-division-chile',
  'Copa Chile': 'copa-chile',
  'Copa de la Liga': 'copa-de-la-liga-chile',
  'Primera División Argentina': 'liga-argentina',
};

// FÚTBOL CHILENO (a pedido: "para el fútbol chileno siempre son los mismos,
// no hay que buscar nada") — canal fijo, sin scraping. Confirmado a mano
// mirando varias fechas en futbolenvivochile.com: TNT Sports tiene los
// derechos de la Primera División chilena completa, con HBO Max como
// streaming adicional. Si algún día cambia el paquete de derechos de TV,
// esta lista se edita a mano acá — no depende de ningún scraper.
const CANALES_CHILE_DEFAULT = ['TNT Sports Premium HD', 'TNT Sports Premium', 'HBO MAX'];
const COMPETENCIAS_CHILE = ['Primera División Chile', 'Copa Chile', 'Copa de la Liga'];

// FÚTBOL ARGENTINO (a pedido: "en ESPN.cl se publica la agenda semanal de
// lo que transmite ESPN/Disney+ en Chile... los demás partidos los da
// TyC Sports Internacional, siempre es así"): en vez de scrapear el
// artículo semanal de ESPN.cl (su URL cambia cada semana — id de nota
// nuevo, no hay forma de adivinarlo sin buscarlo primero), se usa
// livesoccertv.com/channels/starpluscl/ — la ficha de "Disney+ Premium
// Chile" de un sitio que agrega guías de canales por país. Misma
// información (qué partidos pasa ESPN/Disney+ en Chile) pero con URL FIJA,
// que es justo lo que necesita un cron: no hay que descubrir nada cada
// semana. Cualquier partido de Primera Argentina que NO aparezca ahí se
// asume TyC Sports Internacional (regla de Pablo, confirmada: "siempre es
// así" para lo que no está en la agenda de ESPN).
const CANALES_ESPN_DISNEY = ['ESPN', 'Disney+ Premium'];
const CANALES_TYC_DEFAULT = ['TyC Sports Internacional'];

// FANATIZ (a pedido: "falta agregar Fanatiz, va en TODOS los partidos de
// Argentina siempre"): es un streaming que retransmite la Primera División
// Argentina completa, partido por partido, sin excepción — a diferencia de
// ESPN/Disney+/TyC (que se reparten los partidos entre sí), Fanatiz va
// SIEMPRE, así que no depende de ningún scraping ni matching: se agrega a
// mano en el backend a cualquier canal de Argentina, sin importar de qué
// fuente haya salido el resto de la lista (Wosti exacto, agenda genérica,
// o default TyC). Wosti sí lo trae en su HTML, pero como link de afiliado
// (fanatiz.jbbfvx.net, no /canal/...) que el parser de obtenerCanalesTv no
// captura — más simple y confiable garantizarlo acá que ajustar el parser
// para un caso que de todos modos siempre es "sí".
const CANAL_FANATIZ = 'Fanatiz';
function conFanatiz(canales) {
  const lista = Array.isArray(canales) ? canales.filter(Boolean) : [];
  return lista.includes(CANAL_FANATIZ) ? lista : [CANAL_FANATIZ, ...lista];
}

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

// Ficha de canal de livesoccertv.com (Disney+ Premium Chile): una tabla con
// filas de encabezado de fecha (1 sola celda, con un link a
// /schedules/YYYY-MM-DD/ — de ahí se saca la fecha, sin tener que parsear
// "Monday, 10 August" a mano) seguidas de filas de partido (hora/estado,
// link al partido con el cruce en la URL tipo "equipo-a-vs-equipo-b", link
// a la competencia). Acá SOLO se quedan las filas cuya competencia sea
// justo Primera División Argentina (href con "/argentina/primera-division/")
// — de todos los partidos que este canal transmite en el mundo, es lo único
// que nos importa. El nombre de cada equipo se saca del SLUG de la URL del
// partido (ej. "union-santa-fe-vs-central-cordoba-sde"), no del texto
// visible: el texto cambia de formato entre "Equipo A vs Equipo B" (por
// jugar) y "Equipo A 2 - 1 Equipo B" (en vivo/terminado), pero el slug de
// la URL usa siempre el mismo separador "-vs-", así que es más confiable
// parsear ahí.
async function obtenerAgendaDisneyArgentina() {
  const resp = await fetch('https://www.livesoccertv.com/channels/starpluscl/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; demasterapp-bot/1.0; +https://demaster.app)' },
  });
  if (!resp.ok) return [];
  const html = await resp.text();
  const $ = cheerio.load(html);
  const partidos = [];
  let fechaActual = null; // 'YYYY-MM-DD'

  $('table tr').each((_, tr) => {
    const $tr = $(tr);
    const celdas = $tr.find('td');

    if (celdas.length <= 1) {
      const hrefFecha = $tr.find('a[href*="/schedules/"]').attr('href') || '';
      const m = hrefFecha.match(/\/schedules\/(\d{4}-\d{2}-\d{2})/);
      if (m) fechaActual = m[1];
      return;
    }

    if (!fechaActual) return;

    // Filtro por competencia PRIMERO (más barato y más preciso que tratar
    // de adivinar por nombre de equipo): si esta fila no es de Primera
    // Argentina, ni vale la pena mirarla.
    const esArgentina = $tr.find('a[href*="/competitions/argentina/primera-division/"]').length > 0;
    if (!esArgentina) return;

    const hrefMatch = $tr.find('a[href*="/match/"]').first().attr('href') || '';
    const m2 = hrefMatch.match(/\/match\/([^/]+)\//);
    if (!m2) return;
    const partes = m2[1].split('-vs-');
    if (partes.length !== 2) return;

    partidos.push({
      fecha: fechaActual,
      equipoLocal: partes[0].replace(/-/g, ' '),
      equipoVisita: partes[1].replace(/-/g, ' '),
    });
  });

  return partidos;
}

module.exports = {
  obtenerCanalesTv,
  obtenerAgendaDisneyArgentina,
  coincideEquipo,
  normalizarEquipo,
  conFanatiz,
  SLUGS_POR_COMPETENCIA,
  CANALES_CHILE_DEFAULT,
  COMPETENCIAS_CHILE,
  CANALES_ESPN_DISNEY,
  CANALES_TYC_DEFAULT,
};
