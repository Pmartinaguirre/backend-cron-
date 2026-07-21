// =========================================================
// LÓGICA DE DIAMANTES — copia exacta de la misma lógica que vive en
// sementomvp.jsx (sección "DIAMANTES POR DIFICULTAD (Cat.4/5)").
//
// OJO MUY IMPORTANTE: esto está DUPLICADO a propósito (el frontend es React/
// JSX y este backend es Node plano, viven en repos/despliegues distintos),
// pero eso significa que si el día de mañana se vuelve a ajustar la fórmula
// de diamantes en sementomvp.jsx (como pasó con el rango 5-12), hay que
// copiar el mismo cambio ACÁ TAMBIÉN a mano — si no, el admin y el cron
// automático van a pagar distinto por el mismo resultado.
// =========================================================

const K_DIAMANTES_DIFICULTAD = 1.5;
const MIN_DIAMANTES_PARTIDO = 5;
const MAX_DIAMANTES_PARTIDO = 12;
const BONUS_DIAMANTES_DIFERENCIA_GOL = 3; // Cat.4 solamente
const BONUS_DIAMANTES_MARCADOR_EXACTO = 2; // Cat.4 solamente
const DIAMANTES_BASE_SIN_CUOTA = 120; // fallback partidos viejos sin cuota
const BONUS_SIN_CUOTA_DIFERENCIA_GOL = 40;
const BONUS_SIN_CUOTA_MARCADOR_EXACTO = 20;

function calcularDiamantesPorCuota(cuota) {
  const c = Number(cuota);
  if (!Number.isFinite(c) || c <= 1) return MIN_DIAMANTES_PARTIDO;
  const bruto = Math.floor(MIN_DIAMANTES_PARTIDO + K_DIAMANTES_DIFICULTAD * (c - 1));
  return Math.min(MAX_DIAMANTES_PARTIDO, Math.max(MIN_DIAMANTES_PARTIDO, bruto));
}

// signoReal: 1 = ganó local, -1 = ganó visita, 0 = empate.
function cuotaDelResultado(desafio, signoReal) {
  const cuota = signoReal > 0 ? desafio?.cuota_local : signoReal < 0 ? desafio?.cuota_visita : desafio?.cuota_empate;
  const c = Number(cuota);
  return Number.isFinite(c) ? c : null;
}

// Cat.4 "Pronóstico privado" (marcador exacto): si no acierta el LEV, 0. Si
// acierta el LEV, la base sale de la cuota del resultado real; si además
// acierta la diferencia de gol suma el bono fijo, y si además acierta el
// marcador exacto suma otro bono fijo.
function calcularDiamantesCat4(predLocal, predVisita, realLocal, realVisita, desafio) {
  if (![predLocal, predVisita, realLocal, realVisita].every(Number.isFinite)) return 0;
  const signoPred = Math.sign(predLocal - predVisita);
  const signoReal = Math.sign(realLocal - realVisita);
  if (signoPred !== signoReal) return 0;

  const cuota = cuotaDelResultado(desafio, signoReal);
  let diamantes = cuota != null ? calcularDiamantesPorCuota(cuota) : DIAMANTES_BASE_SIN_CUOTA;

  if ((predLocal - predVisita) === (realLocal - realVisita)) {
    diamantes += cuota != null ? BONUS_DIAMANTES_DIFERENCIA_GOL : BONUS_SIN_CUOTA_DIFERENCIA_GOL;
    if (predLocal === realLocal && predVisita === realVisita) {
      diamantes += cuota != null ? BONUS_DIAMANTES_MARCADOR_EXACTO : BONUS_SIN_CUOTA_MARCADOR_EXACTO;
    }
  }
  return diamantes;
}

// Cat.5 "Pronóstico LEV" (sin marcador exacto): no acertó -> 0. Acertó -> la
// cuota del resultado real que efectivamente ocurrió.
function calcularDiamantesCat5(signoReal, desafio) {
  const cuota = cuotaDelResultado(desafio, signoReal);
  return cuota != null ? calcularDiamantesPorCuota(cuota) : DIAMANTES_BASE_SIN_CUOTA;
}

// Convierte "2-1" (como se guarda en respuesta_extra, ver parsearMarcador en
// sementomvp.jsx) en [2, 1], o null si el texto no tiene el formato esperado.
function parsearMarcador(texto) {
  if (!texto) return null;
  const partes = String(texto).split('-').map((s) => Number(s.trim()));
  if (partes.length !== 2 || !partes.every(Number.isFinite)) return null;
  return partes;
}

// Cat.5 no tiene marcador, solo texto LEV ("Gana <equipo_local>" / "Empate" /
// "Gana <equipo_visitante>") — esto arma ese mismo texto a partir del
// resultado real (goles), igual al formato que usa signoDeResultadoLEV en
// sementomvp.jsx, para que quede guardado en resultado_oficial exactamente
// como si lo hubiera elegido un admin a mano.
function construirTextoLEV(equipoLocal, equipoVisitante, golesLocal, golesVisita) {
  if (golesLocal === golesVisita) return 'Empate';
  return golesLocal > golesVisita ? `Gana ${equipoLocal}` : `Gana ${equipoVisitante}`;
}

// signo a partir del resultado real (goles) — mismo signo que usa
// cuotaDelResultado (1 = ganó local, -1 = ganó visita, 0 = empate).
function signoDeGoles(golesLocal, golesVisita) {
  return Math.sign(golesLocal - golesVisita);
}

module.exports = {
  calcularDiamantesPorCuota,
  cuotaDelResultado,
  calcularDiamantesCat4,
  calcularDiamantesCat5,
  parsearMarcador,
  construirTextoLEV,
  signoDeGoles,
};
