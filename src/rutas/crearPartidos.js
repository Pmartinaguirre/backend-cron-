// GET/POST /crear-partidos — PENDIENTE: acá va la lógica para crear
// partidos nuevos solos (sin generar SQL a mano como hasta ahora), según los
// criterios que definas (qué ligas, cuántas fechas por adelantado, cuándo
// "activar" la próxima fecha de cada competencia, etc.).
//
// Cuando me mandes esos criterios, esta ruta hace 3 cosas en orden:
//   1) Le pregunta a API-Football los próximos fixtures de cada liga (según
//      tus criterios) que todavía NO estén en desafios_mvp (se identifica
//      por fixture_id_api, para no duplicar si el cron corre varias veces).
//   2) Inserta cada uno directo en desafios_mvp con categoria 4 y/o 5, YA
//      con fixture_id_api puesto (a diferencia del proceso viejo, acá no
//      hace falta un vincular_fixtures.js aparte después) y esta_activo
//      según si le toca jugarse pronto o todavía no.
//   3) Llama a la misma lógica de /cuotas para esos partidos recién
//      creados, así ya quedan con cuota apenas la API la tenga disponible,
//      sin depender de que corra otro cron por separado.
//
// Por ahora este endpoint responde sin hacer nada, para que el server
// completo funcione y puedas ir probando /cuotas, /vivo y /resolver
// mientras me mandas los criterios de creación.
async function rutaCrearPartidos(req, res) {
  res.json({
    ok: true,
    mensaje: 'Todavía no implementado — falta definir los criterios de qué partidos crear (ligas, cuántas fechas por adelantado, etc.).',
  });
}

module.exports = { rutaCrearPartidos };
