// Compara nombres de equipo entre lo que el admin escribió en "Equipos Tier
// A" (ej. "U. Catolica") y lo que devuelve API-Football (ej. "Universidad
// Catolica"). MISMA lógica que ya usa vincular_fixtures.js para pegar
// fixtures (alias manuales + similitud por palabras compartidas) — se copió
// a propósito en vez de exigir que el admin reescriba cada nombre de equipo
// para que calce exacto con la API, que sería frágil y habría que mantener
// para siempre. OJO: como con diamantes.js, esto vive duplicado en dos
// archivos (vincular_fixtures.js y acá) — si agregas un alias nuevo acá
// porque un equipo no calza, conviene agregarlo también allá.
const ALIAS_EQUIPO = {
  'u catolica': 'universidad catolica',
  'a italiano': 'audax italiano',
  'd la serena': 'deportes la serena',
  'gimnasia l p': 'gimnasia la plata',
  'estudiantes l p': 'estudiantes de la plata',
};

function normalizar(texto) {
  let n = String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca tildes (rango Unicode de acentos combinados)
    .replace(/\./g, ' ') // "U." -> "U " antes de sacar el punto, para no pegar letras
    .replace(/[^a-z0-9\s]/g, ' ') // guiones, etc. -> espacio
    .replace(/\s+/g, ' ')
    .trim();
  if (ALIAS_EQUIPO[n]) n = ALIAS_EQUIPO[n];
  return n;
}

function tokens(texto) {
  return new Set(normalizar(texto).split(' ').filter(Boolean));
}

// Similitud por palabras compartidas (Jaccard) — ej. "gimnasia la plata" vs
// "gimnasia l p" (ya traducido por el alias a "gimnasia la plata") calzan
// perfecto; "Colo Colo" vs "Universidad de Chile" no comparten nada.
function similitud(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let interseccion = 0;
  for (const t of ta) if (tb.has(t)) interseccion++;
  return interseccion / Math.max(ta.size, tb.size);
}

const UMBRAL_ACEPTAR = 0.5;

function esMismoEquipo(nombreTierA, nombreApi) {
  return similitud(nombreTierA, nombreApi) >= UMBRAL_ACEPTAR;
}

module.exports = { normalizar, esMismoEquipo };
