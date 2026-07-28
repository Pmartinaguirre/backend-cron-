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

// TODAS las palabras del nombre más corto tienen que encontrar una palabra
// compatible en el nombre más largo (exacta o abreviatura-prefijo). Las
// palabras "de más" del nombre largo (ej. "de" en "Estudiantes de la Plata")
// no molestan — no se exige que TODO calce en ambos sentidos, solo que el
// nombre corto esté completamente cubierto por el largo.
//
// DOS protecciones contra falsos positivos:
//
// 1. No basta con que TODO calce si TODO calce es solo por abreviatura (ej.
//    "Ajax" no debe hacer match con "A. Italiano" solo porque "a" es prefijo
//    de "ajax"). Se exige al menos UNA coincidencia exacta de respaldo.
//
// 2. Las palabras del nombre LARGO que quedaron sin pareja tienen que ser
//    relleno (artículos, "club", siglas). Sin esta regla, "Independiente"
//    quedaba totalmente cubierto por "Independiente Rivadavia" —con
//    coincidencia exacta y todo— y el matcher daba por Tier A a un club que
//    es OTRO. Mismo caso: "Gimnasia" contra las dos Gimnasias, "Boca" contra
//    "Boca Unidos". La palabra sobrante ("rivadavia") es exactamente lo que
//    distingue a los clubes, así que si sobra algo que no es relleno, NO son
//    el mismo equipo.
//
//    Consecuencia deliberada: en la lista Tier A los equipos van con su
//    nombre completo tal como los escribe API-Football (el selector del
//    panel de Admin ya los carga así). "Racing" sigue calzando con "Racing
//    Club" porque "club" es relleno; "Talleres" a secas ya NO calza con
//    "Talleres Cordoba" — se elige del selector y listo.
function cubreTodasLasPalabras(cortas, largas) {
  if (!cortas.every((t1) => largas.some((t2) => tokenCompatible(t1, t2)))) return false;
  if (!cortas.some((t1) => largas.includes(t1))) return false;
  const sobrantes = largas.filter((t2) => !cortas.some((t1) => tokenCompatible(t1, t2)));
  return sobrantes.every((t2) => PALABRAS_RELLENO.has(t2));
}

function esMismoEquipo(nombreA, nombreB) {
  const ta = tokens(nombreA);
  const tb = tokens(nombreB);
  if (ta.length === 0 || tb.length === 0) return false;
  // Se prueba en los dos sentidos (no se sabe de antemano cuál de los dos
  // nombres es el "abreviado") — si cualquiera de los dos queda totalmente
  // cubierto por el otro (con al menos una palabra exacta de respaldo), se
  // considera el mismo equipo.
  return cubreTodasLasPalabras(ta, tb) || cubreTodasLasPalabras(tb, ta);
}

module.exports = { normalizar, esMismoEquipo };
