// Arma el mismo formato de texto que ya usan los SQL de fixtures generados a
// mano (ej. "Viernes 24 de julio, 18:00 hrs (Chile)" y "24 de julio"), para
// que los partidos creados por el cron se vean idénticos a los cargados
// manualmente. Todo en huso horario de Chile (America/Santiago).
const ZONA_CHILE = 'America/Santiago';

function subtituloFecha(fechaISO) {
  const fecha = new Date(fechaISO);
  const diaSemana = new Intl.DateTimeFormat('es-CL', { weekday: 'long', timeZone: ZONA_CHILE }).format(fecha);
  const dia = new Intl.DateTimeFormat('es-CL', { day: 'numeric', timeZone: ZONA_CHILE }).format(fecha);
  const mes = new Intl.DateTimeFormat('es-CL', { month: 'long', timeZone: ZONA_CHILE }).format(fecha);
  const hora = new Intl.DateTimeFormat('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: ZONA_CHILE,
  }).format(fecha);

  const diaSemanaCapitalizado = diaSemana.charAt(0).toUpperCase() + diaSemana.slice(1);
  return `${diaSemanaCapitalizado} ${dia} de ${mes}, ${hora} hrs (Chile)`;
}

function tiempoCorto(fechaISO) {
  const fecha = new Date(fechaISO);
  const dia = new Intl.DateTimeFormat('es-CL', { day: 'numeric', timeZone: ZONA_CHILE }).format(fecha);
  const mes = new Intl.DateTimeFormat('es-CL', { month: 'long', timeZone: ZONA_CHILE }).format(fecha);
  return `${dia} de ${mes}`;
}

module.exports = { subtituloFecha, tiempoCorto };
