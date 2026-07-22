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

app.get('/resolver', exigirSecreto, rutaResolver);
app.post('/resolver', exigirSecreto, rutaResolver);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`demaster-cron-backend escuchando en el puerto ${PORT}`);
});
