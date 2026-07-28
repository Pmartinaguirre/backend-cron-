// Compara nombres de equipo entre lo que el admin escribió en "Equipos Tier
// A" (ej. "U. Catolica", "D. La Serena") y lo que devuelve API-Football (ej.
// "Universidad Catolica", "Deportes La Serena").
//
// CAMBIO IMPORTANTE (v2): la primera versión usaba una lista de alias a mano
// por equipo ('u catolica' -> 'universidad catolica', etc.) — no escala a
// cientos de equipos de 9 competencias distintas, cada alias nuevo que
// aparezca habría que agregarlo a mano de nuevo. En vez de eso, esto aplica
// una REGLA GENERAL: cada palabra corta (2 letras o menos, típicamente la
// abreviatura de la primera palabra: "U." de "Universidad", "D." de
// "Deportes", "A." de "Audax", "L."/"P." de "La"/"Plata") se acepta si es
// PREFIJO de alguna palabra del otro nombre — no hace falta que alguien haya
// anotado ese equipo en particular antes. El resto de las palabras (las que
// no son abreviatura, ej. "Catolica", "Serena", "Italiano") tienen que
// calzar exacto — eso es lo que evita falsos positivos entre equipos
// distintos de la misma liga (ej. "U. Catolica" no calza con "Universidad de
// Chile" ni "Universidad Concepcion", porque "catolica" no calza con "de
// chile" ni con "concepcion").
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca tildes (rango Unicode de acentos combinados)
    .replace(/['’´]/g, '') // el apóstrofe se BORRA (no se vuelve espacio): "O'Higgins" -> "ohiggins", una sola palabra — si se volviera espacio quedaría "o higgins" y no calzaría con como lo escribe la API.
    .replace(/\./g, ' ') // "U." -> "U " antes de sacar el punto, para no pegar letras
    .replace(/[^a-z0-9\s]/g, ' ') // guiones, etc. -> espacio
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(texto) {
  return normalizar(texto).split(' ').filter(Boolean);
}

const LARGO_ABREVIATURA = 2; // "u", "d", "a", "l", "p" cuentan; "de", "la" (con 2 letras) también, ok

function tokenCompatible(t1, t2) {
  if (t1 === t2) return true;
  if (t1.length <= LARGO_ABREVIATURA && t2.startsWith(t1)) return true;
  if (t2.length <= LARGO_ABREVIATURA && t1.startsWith(t2)) return true;
  return false;
}

// Palabras que pueden "sobrar" en el nombre largo sin que eso signifique que
// es OTRO club: artículos, conectores y las siglas/adornos institucionales
// que la API a veces agrega y la gente omite ("Racing" ↔ "Racing Club").
//
// La lista es corta A PROPÓSITO. Cada palabra que se agrega acá relaja la
// guardia de abajo; "juniors", "rivadavia" o "cordoba" NO van, porque son
// justamente las palabras que distinguen a un club de otro.
const PALABRAS_RELLENO = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'y',
  'club', 'fc', 'cf', 'ca', 'cd', 'afc', 'csd',
]);

// TODAS las palabras de `cortas` tienen que encontrar una palabra compatible
// en `largas` (exacta o abreviatura-prefijo), con al menos UNA coincidencia
// exacta de respaldo (ej. "Ajax" no debe hacer match con "A. Italiano" solo
// porque "a" es prefijo de "ajax" — ahí no hay ninguna palabra exacta).
//
// `sobrantesLibres` controla qué pasa con las palabras de `largas` que
// quedaron sin pareja:
//   true  → dan lo mismo (puede sobrar cualquier cosa)
//   false → tienen que ser relleno (artículos, "club", siglas)
function cubreTodasLasPalabras(cortas, largas, sobrantesLibres) {
  if (!cortas.every((t1) => largas.some((t2) => tokenCompatible(t1, t2)))) return false;
  if (!cortas.some((t1) => largas.includes(t1))) return false;
  if (sobrantesLibres) return true;
  const sobrantes = largas.filter((t2) => !cortas.some((t1) => tokenCompatible(t1, t2)));
  return sobrantes.every((t2) => PALABRAS_RELLENO.has(t2));
}

// LA REGLA ES ASIMÉTRICA, y esa asimetría es la corrección de dos bugs que
// tiraban para lados opuestos. Los dos nombres NO son intercambiables:
//
//   nombreLista → lo escribió el ADMIN a mano en "Equipos Tier A"
//   nombreApi   → lo dice API-Football en el fixture
//
// 1. Lo que SOBRA EN LA LISTA es inofensivo. Si el admin escribió "Racing
//    Club de Avellaneda" o "Independiente Avellaneda", las palabras extra
//    son detalle suyo — el club es el mismo. La versión anterior (v2) exigía
//    relleno en AMBOS lados, y con eso ningún nombre escrito a mano con una
//    palabra de más volvía a calzar: se cayeron las 10 ligas de una sola vez
//    (saltadosPorTierA = todos los candidatos, totalCreados = 0).
//
// 2. Lo que SOBRA EN EL NOMBRE DE LA API es sospechoso. "Rivadavia" en
//    "Independiente Rivadavia" es exactamente lo que lo distingue de
//    "Independiente": si la API agrega una palabra con contenido que la
//    lista no tiene, lo más probable es que sea OTRO club. Solo se toleran
//    sobras de relleno ("club", "fc", artículos) — así "Racing" del admin
//    sigue calzando con "Racing Club" de la API, pero "Boca" no calza con
//    "Boca Unidos" ni "Independiente" con "Independiente Rivadavia".
//
// Las abreviaturas ("U. Catolica" ↔ "Universidad Catolica") funcionan igual
// que siempre, en las dos direcciones.
function esMismoEquipo(nombreLista, nombreApi) {
  const tl = tokens(nombreLista);
  const ta = tokens(nombreApi);
  if (tl.length === 0 || ta.length === 0) return false;
  // (a) Todo lo que dice la API está en el nombre de la lista → mismo club,
  //     sin importar cuánto detalle extra haya escrito el admin.
  if (cubreTodasLasPalabras(ta, tl, true)) return true;
  // (b) Todo lo de la lista está en el nombre de la API → mismo club SOLO si
  //     lo que le sobra a la API es relleno.
  return cubreTodasLasPalabras(tl, ta, false);
}

module.exports = { normalizar, esMismoEquipo };
