// Normaliza nombres de equipo para comparar sin que importen acentos,
// mayúsculas, puntos o guiones (ej. "Universidad Católica" vs "U. Catolica").
// Mismo criterio que ya usa vincular_fixtures.js para no reinventar la rueda.
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca tildes (rango Unicode de acentos combinados)
    .replace(/[^a-z0-9\s]/g, ' ') // puntos, guiones, etc. -> espacio
    .replace(/\s+/g, ' ')
    .trim();
}

// ¿El equipo de la lista Tier A (admin) hace referencia a este equipo de
// API-Football? Comparación por contención en ambos sentidos (mismo
// criterio que esPartidoDestacado en sementomvp.jsx: "eq.includes(d)") — no
// exige coincidencia exacta, así "Católica" en Tier A calza con "Universidad
// Católica" en la API, y viceversa.
function esMismoEquipo(nombreTierA, nombreApi) {
  const a = normalizar(nombreTierA);
  const b = normalizar(nombreApi);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

module.exports = { normalizar, esMismoEquipo };
