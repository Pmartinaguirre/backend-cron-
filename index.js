// Servidor chico (Express) con los 4 endpoints que cron-job.org llama por
// horario. Cada uno exige el header X-Cron-Secret (ver src/middlewareAuth.js)
// para que nadie más pueda dispararlos encontrando la URL.
//
// Despliegue: Render (Web Service, no "Static Site") — ver README.md para
// los pasos exactos y cómo configurar cron-job.org.
require('dotenv').config();
const express = require('express');
const { exigirSecreto } = require('./src/middlewareAuth');
const { rutaCuotas } = require('./src/rutas/cuotas');
const { rutaVivo } = require('./src/rutas/vivo');
const { rutaResolver } = require('./src/rutas/resolver');
const { rutaCrearPartidos } = require('./src/rutas/crearPartidos');
const { rutaEquipos } = require('./src/rutas/equipos');
const { rutaInvitarAGrupo } = require('./src/rutas/invitarAGrupo');
const { rutaEnviarResumenMesa } = require('./src/rutas/enviarResumenMesa');
const { rutaPosicionesLiga } = require('./src/rutas/posicionesLiga');
const { rutaHistorialEnfrentamientos } = require('./src/rutas/historialEnfrentamientos');
const { rutaDetallePartido } = require('./src/rutas/detallePartido');
const { rutaLesionados } = require('./src/rutas/lesionados');
const { rutaJugador, rutaClub } = require('./src/rutas/fichas');
const { rutaBackfillEquipos, rutaForma, rutaPerfilesJugadores } = require('./src/rutas/equiposIds');
const { rutaMomentum } = require('./src/rutas/momentum');
const { rutaMedia } = require('./src/rutas/media');
const { rutaCanalesTv } = require('./src/rutas/canalesTv');
const { rutaDiagnosticoCobertura } = require('./src/rutas/diagnosticoCobertura');
const { rutaDiagnosticoPartido } = require('./src/rutas/diagnosticoPartido');
const { rutaDiagnosticoIds } = require('./src/rutas/diagnosticoIds');
const { rutaGanadorSemanal } = require('./src/rutas/ganadorSemanal');
const { rutaRankingGrupo } = require('./src/rutas/rankingGrupo');
const { rutaRankingGrupoHistorial } = require('./src/rutas/rankingGrupoHistorial');
const {
  rutaNotificarRegistro,
  rutaNotificarInvitadoGrupo,
  rutaNotificarGrupoCreado,
  rutaNotificarGrupoActivado,
} = require('./src/rutas/notificaciones');

const app = express();
// Necesario para leer req.body en /invitar-a-grupo (POST con JSON) — las
// demás rutas no mandan body, así que esto no les cambia nada.
app.use(express.json());

// Ping simple sin secreto, solo para confirmar que el server está arriba
// (útil para probar el despliegue en Render antes de meter cron-job.org).
app.get('/', (req, res) => res.json({ ok: true, servicio: 'demaster-cron-backend' }));

app.get('/cuotas', exigirSecreto, rutaCuotas);
app.post('/cuotas', exigirSecreto, rutaCuotas);

app.get('/vivo', exigirSecreto, rutaVivo);
app.post('/vivo', exigirSecreto, rutaVivo);

// /media: búsqueda automática en YouTube (TNT Sports Chile) del resumen de
// partidos de fútbol chileno terminados — ver src/rutas/media.js.
app.get('/media', exigirSecreto, rutaMedia);
app.post('/media', exigirSecreto, rutaMedia);

app.get('/resolver', exigirSecreto, rutaResolver);
app.post('/resolver', exigirSecreto, rutaResolver);

// /canales-tv: búsqueda automática (scraping de futbolenvivochile.com) de
// los canales de TV que transmiten cada partido próximo — ver
// src/rutas/canalesTv.js y src/scraperTv.js (nota de riesgo: NO es una API
// oficial). Escribe en la base, así que lleva secreto igual que /cuotas.
app.get('/canales-tv', exigirSecreto, rutaCanalesTv);
app.post('/canales-tv', exigirSecreto, rutaCanalesTv);

// /ganador-semanal: corre 1 vez por semana (a pedido, premio "Ganador
// semanal" por grupo) — ver src/rutas/ganadorSemanal.js.
app.get('/ganador-semanal', exigirSecreto, rutaGanadorSemanal);
app.post('/ganador-semanal', exigirSecreto, rutaGanadorSemanal);

app.get('/crear-partidos', exigirSecreto, rutaCrearPartidos);
app.post('/crear-partidos', exigirSecreto, rutaCrearPartidos);

// /equipos NO lleva exigirSecreto: es de solo lectura y la llama directo el
// navegador del Admin (ver nota en src/rutas/equipos.js). Como el frontend
// (Netlify) y este backend (Render) son orígenes distintos, hace falta CORS
// acá — solo para esta ruta, no para todo el servidor, ya que las demás
// rutas las llama cron-job.org (no un navegador) y no lo necesitan.
app.get('/equipos', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaEquipos);

// /posiciones-liga: mismo caso que /equipos — solo lectura, la llama el
// navegador del jugador al tocar el título de una tarjeta de partido.
app.get('/posiciones-liga', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaPosicionesLiga);

// /historial-enfrentamientos: últimos cruces terminados entre 2 equipos —
// mismo caso que /posiciones-liga, solo lectura, la llama el navegador
// desde el módulo "Historial de enfrentamientos" de la tarjeta de partido.
app.get('/historial-enfrentamientos', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaHistorialEnfrentamientos);

// /detalle-partido: eventos + alineaciones + estadísticas de un partido,
// para las pestañas de la tarjeta. Solo lectura, lo llama el navegador.
app.get('/detalle-partido', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaDetallePartido);

// /lesionados: jugadores lesionados/suspendidos para un partido puntual —
// mismo caso que /detalle-partido, solo lectura, la llama el navegador desde
// la pestaña "Alineaciones" de la tarjeta de partido.
app.get('/lesionados', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaLesionados);

// /jugador y /club: las fichas que se abren al tocar la foto de un jugador o
// el escudo de un equipo en la pestaña Alineaciones. Solo lectura, las llama
// el navegador, con caché largo del lado del backend (ver src/rutas/fichas.js).
app.get('/jugador', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaJugador);

app.get('/club', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaClub);

// /forma: últimos 5 resultados de varios equipos de una vez, para la tira
// V/E/P que va bajo cada equipo en las tarjetas de partido. Solo lectura.
app.get('/forma', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaForma);

// /jugadores-perfil: edad + nacionalidad de varios jugadores de una vez,
// para los filtros de nacionalidad/edad sobre la cancha en Alineaciones.
// Solo lectura, cacheado 30 días del lado del backend.
app.get('/jugadores-perfil', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaPerfilesJugadores);

// /momentum: la serie de snapshots que guardó /vivo para armar el gráfico
// de "quién domina" en la pestaña Resumen. Solo lectura, la llama el
// navegador del jugador.
app.get('/momentum', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaMomentum);

// /diagnostico-cobertura: a pedido, para saber qué datos trae REALMENTE
// API-Football por competencia (alineaciones, estadísticas, tabla de
// posiciones, etc.), antes de asumir que falta algo del lado nuestro.
// Sin ?competencia= chequea todas las ligas de golpe. Solo lectura.
app.get('/diagnostico-cobertura', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaDiagnosticoCobertura);

// /diagnostico-partido: busca un partido puntual (liga + fecha) directo en
// API-Football, sin pasar por nuestra base — para saber si un dato faltante
// en la app es porque la API no lo tiene o porque hay un bug nuestro.
app.get('/diagnostico-partido', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaDiagnosticoPartido);

// /diagnostico-ids: trae la fila cruda de desafios_mvp para ids puntuales
// (separados por coma) — para entender por qué un partido puntual ni
// siquiera aparece en /media (¿existe? ¿tiene el tema/categoria esperados?).
app.get('/diagnostico-ids', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaDiagnosticoIds);

// /ranking-grupo: tabla de posiciones del grupo por ventana de conteo (a
// pedido: "cada jugador parte de cero diamantes en el grupo desde su fecha
// de ingreso") — ver src/rutas/rankingGrupo.js. Solo lectura, la llama
// directo el navegador del jugador desde MisGrupos.jsx y sementomvp.jsx.
// BUG encontrado (a pedido: "Load failed" en el navegador — esta ruta
// nunca quedó registrada acá, solo estaba importada; Express devolvía 404
// sin headers CORS, así que el navegador ni siquiera llegaba a ver el
// error, quedaba como falla de red genérica).
app.get('/ranking-grupo', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaRankingGrupo);

// /ranking-grupo-historial: historial de diamantes de UN jugador, acotado a
// la misma ventana/filtro de competencia que /ranking-grupo — a pedido: "en
// el modal de ficha de un jugador del grupo, mostrar su historial de
// diamantes del grupo". Ver src/rutas/rankingGrupoHistorial.js.
app.get('/ranking-grupo-historial', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, rutaRankingGrupoHistorial);

// /backfill-equipos: completa equipo_local_id / equipo_visita_id en los
// partidos que se crearon antes de que se guardaran esos ids. Escribe en la
// base, así que SÍ lleva secreto. Se corre a mano hasta que devuelva
// "pendientes": 0, y después no se usa nunca más.
app.get('/backfill-equipos', exigirSecreto, rutaBackfillEquipos);

// /invitar-a-grupo tampoco lleva exigirSecreto: la llama directo el
// navegador del jugador (admin de su grupo) desde Perfil.jsx. La
// autorización real pasa DENTRO de la ruta (verifica que invitadorId sea el
// admin_id de esa sala) — ver src/rutas/invitarAGrupo.js.
// OJO: al ser POST con body JSON, el navegador manda antes un preflight
// OPTIONS — hay que responderlo con los mismos headers CORS o el POST real
// nunca sale (queda bloqueado del lado del navegador, antes de llegar acá).
const permitirCorsInvitar = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
};
app.options('/invitar-a-grupo', permitirCorsInvitar, (req, res) => res.sendStatus(204));
app.post('/invitar-a-grupo', permitirCorsInvitar, rutaInvitarAGrupo);

// /enviar-resumen-mesa: mismo criterio que /invitar-a-grupo — lo llama
// directo el navegador del admin desde Check.jsx al cerrar la mesa, sin
// X-Cron-Secret (la autorización real pasa dentro de la ruta, verificando
// que adminId sea el admin de la mesa o de su sala).
app.options('/enviar-resumen-mesa', permitirCorsInvitar, (req, res) => res.sendStatus(204));
app.post('/enviar-resumen-mesa', permitirCorsInvitar, rutaEnviarResumenMesa);

// Mails de "hitos" del jugador (a pedido: "armar el flujo básico de email
// para los hitos de los jugadores" — registro, invitación a grupo, grupo
// creado, grupo activado) — ver src/rutas/notificaciones.js. Mismo
// criterio sin X-Cron-Secret que las dos rutas de arriba: las llama
// directo el navegador del jugador, "fire and forget", nunca bloquean la
// operación real si el mail falla.
app.options('/notificar-registro', permitirCorsInvitar, (req, res) => res.sendStatus(204));
app.post('/notificar-registro', permitirCorsInvitar, rutaNotificarRegistro);
app.options('/notificar-invitado-grupo', permitirCorsInvitar, (req, res) => res.sendStatus(204));
app.post('/notificar-invitado-grupo', permitirCorsInvitar, rutaNotificarInvitadoGrupo);
app.options('/notificar-grupo-creado', permitirCorsInvitar, (req, res) => res.sendStatus(204));
app.post('/notificar-grupo-creado', permitirCorsInvitar, rutaNotificarGrupoCreado);
app.options('/notificar-grupo-activado', permitirCorsInvitar, (req, res) => res.sendStatus(204));
app.post('/notificar-grupo-activado', permitirCorsInvitar, rutaNotificarGrupoActivado);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`demaster-cron-backend escuchando en el puerto ${PORT}`);
});
