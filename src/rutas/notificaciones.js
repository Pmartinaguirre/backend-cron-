// Mails de "hitos" del jugador (a pedido: "armar el flujo básico de email
// para los hitos de los jugadores"): 4 rutas, una por hito. Mismo criterio
// de autorización mínima que /invitar-a-grupo y /enviar-resumen-mesa (sin
// X-Cron-Secret, las llama directo el navegador del jugador) — acá no hace
// falta ni eso: lo peor que puede pasar si alguien llama a estas rutas con
// ids inventados es que Resend intente mandar un mail a una dirección que
// de verdad existe en la base, nunca se escribe ni se borra nada.
//
// A propósito NINGUNA de estas rutas devuelve error 5xx si el mail falla
// (Resend caído, dominio sin verificar, etc.) — siempre responden 200 con
// { ok:false, motivo } en ese caso. Quien llama desde el frontend lo hace
// "fire and forget" (no espera ni bloquea la operación real: registrarse,
// crear grupo, activar grupo, agregar jugador), así que un mail que no
// sale nunca debe frenar ni mostrar error de esa operación.
const { supabase } = require('../supabaseClient');
const { enviarMail, plantillaBase, FRONTEND_URL } = require('../emailHelper');

// 1) POST /notificar-registro — a pedido: "Cuando un jugador se registra
// en la plataforma". Se llama desde Registro.jsx justo después de crear la
// fila en `usuarios` (finalizarCuenta), que es el primer momento en que
// hay nombre+email confirmados.
async function rutaNotificarRegistro(req, res) {
  const { usuarioId } = req.body || {};
  if (!usuarioId) return res.status(400).json({ error: 'Falta usuarioId.' });
  try {
    const { data: usuario } = await supabase
      .from('usuarios').select('nombre, email').eq('id', usuarioId).single();
    if (!usuario || !usuario.email) return res.json({ ok: false, motivo: 'sin_email' });

    const html = plantillaBase({
      titulo: `¡Bienvenido a Demaster.app, ${usuario.nombre || 'jugador'}! ⚽`,
      cuerpoHtml: `
        <p>Ya tienes tu cuenta lista. Demaster.app es el juego de pronósticos para jugar con tus amigos: creas o te unes a un grupo, pronosticas los partidos de la semana y sumas diamantes 💎 por cada acierto.</p>
        <p>Cuando quieras, crea tu primer grupo o pídele a un amigo que te invite al suyo.</p>
      `,
      botonTexto: 'Entrar a jugar',
      botonUrl: `${FRONTEND_URL}/home-app`,
    });
    const resultado = await enviarMail({ to: usuario.email, subject: 'Bienvenido a Demaster.app', html });
    return res.json(resultado);
  } catch (e) {
    console.error('[/notificar-registro] Error:', e);
    return res.json({ ok: false, motivo: e.message });
  }
}

// 2) POST /notificar-invitado-grupo — a pedido: "Invitacion a grupo: Te
// han invitado al grupo X". Se llama desde MisGrupos.jsx (agregarJugador),
// cuando el admin agrega a alguien que YA tiene cuenta a su grupo desde el
// buscador — no desde /invitar-a-grupo (esa ruta es para gente sin cuenta
// todavía, se deja para una segunda etapa).
async function rutaNotificarInvitadoGrupo(req, res) {
  const { usuarioId, salaId } = req.body || {};
  if (!usuarioId || !salaId) return res.status(400).json({ error: 'Faltan usuarioId o salaId.' });
  try {
    const [{ data: usuario }, { data: sala }] = await Promise.all([
      supabase.from('usuarios').select('nombre, email').eq('id', usuarioId).single(),
      supabase.from('salas_privadas_mvp').select('nombre').eq('id', salaId).single(),
    ]);
    if (!usuario || !usuario.email) return res.json({ ok: false, motivo: 'sin_email' });
    if (!sala) return res.json({ ok: false, motivo: 'sin_grupo' });

    const html = plantillaBase({
      titulo: `Te han invitado al grupo "${sala.nombre}"`,
      cuerpoHtml: `<p>Hola ${usuario.nombre || 'jugador'}, ya eres parte del grupo <strong>${sala.nombre}</strong> en Demaster.app. Cuando el administrador lo active vas a poder empezar a pronosticar los partidos junto al resto del grupo.</p>`,
      botonTexto: 'Ver el grupo',
      botonUrl: `${FRONTEND_URL}/grupos/${salaId}`,
    });
    const resultado = await enviarMail({ to: usuario.email, subject: `Te han invitado al grupo "${sala.nombre}"`, html });
    return res.json(resultado);
  } catch (e) {
    console.error('[/notificar-invitado-grupo] Error:', e);
    return res.json({ ok: false, motivo: e.message });
  }
}

// 3) POST /notificar-grupo-creado — a pedido: "Grupo creado: Haz creado un
// nuevo grupo". Se llama desde MisGrupos.jsx (handleCrearGrupo) al admin
// recién creado el grupo.
async function rutaNotificarGrupoCreado(req, res) {
  const { salaId } = req.body || {};
  if (!salaId) return res.status(400).json({ error: 'Falta salaId.' });
  try {
    const { data: sala } = await supabase
      .from('salas_privadas_mvp').select('nombre, admin_id').eq('id', salaId).single();
    if (!sala) return res.json({ ok: false, motivo: 'sin_grupo' });
    const { data: admin } = await supabase
      .from('usuarios').select('nombre, email').eq('id', sala.admin_id).single();
    if (!admin || !admin.email) return res.json({ ok: false, motivo: 'sin_email' });

    const html = plantillaBase({
      titulo: `Creaste el grupo "${sala.nombre}" 🎉`,
      cuerpoHtml: `<p>Hola ${admin.nombre || 'jugador'}, tu grupo <strong>${sala.nombre}</strong> ya está listo. Invita a tus amigos y, cuando estén todos adentro, actívalo para empezar a jugar.</p>`,
      botonTexto: 'Invitar amigos',
      botonUrl: `${FRONTEND_URL}/grupos/${salaId}`,
    });
    const resultado = await enviarMail({ to: admin.email, subject: `Creaste el grupo "${sala.nombre}"`, html });
    return res.json(resultado);
  } catch (e) {
    console.error('[/notificar-grupo-creado] Error:', e);
    return res.json({ ok: false, motivo: e.message });
  }
}

// 4) POST /notificar-grupo-activado — a pedido: "Grupo en juego: El
// administrador ha activado el grupo X ya puede ingresar tus pronósticos
// aquí". Se llama desde MisGrupos.jsx (activarGrupo) — a TODOS los
// miembros del grupo (incluido el propio admin), no solo a quien activó.
async function rutaNotificarGrupoActivado(req, res) {
  const { salaId } = req.body || {};
  if (!salaId) return res.status(400).json({ error: 'Falta salaId.' });
  try {
    const { data: sala } = await supabase
      .from('salas_privadas_mvp').select('nombre').eq('id', salaId).single();
    if (!sala) return res.json({ ok: false, motivo: 'sin_grupo' });

    const { data: miembros } = await supabase
      .from('salas_privadas_miembros_mvp').select('usuario_id').eq('sala_id', salaId);
    const idsUsuarios = [...new Set((miembros || []).map((m) => m.usuario_id).filter(Boolean))];
    if (idsUsuarios.length === 0) return res.json({ ok: true, enviados: 0 });

    const { data: usuariosData } = await supabase
      .from('usuarios').select('id, nombre, email').in('id', idsUsuarios);

    const resultados = [];
    for (const usuario of usuariosData || []) {
      if (!usuario.email) { resultados.push({ id: usuario.id, ok: false, motivo: 'sin_email' }); continue; }
      const html = plantillaBase({
        titulo: `¡"${sala.nombre}" ya está en juego! ▶`,
        cuerpoHtml: `<p>Hola ${usuario.nombre || 'jugador'}, el administrador activó el grupo <strong>${sala.nombre}</strong>. Ya puedes ingresar tus pronósticos de la semana.</p>`,
        botonTexto: 'Pronosticar ahora',
        botonUrl: `${FRONTEND_URL}/sementomvp?tab=futbol&vista=pronostico`,
      });
      const r = await enviarMail({ to: usuario.email, subject: `"${sala.nombre}" ya está en juego`, html });
      resultados.push({ id: usuario.id, ...r });
    }
    const enviados = resultados.filter((r) => r.ok).length;
    return res.json({ ok: true, enviados, fallidos: resultados.filter((r) => !r.ok) });
  } catch (e) {
    console.error('[/notificar-grupo-activado] Error:', e);
    return res.json({ ok: false, motivo: e.message });
  }
}

module.exports = {
  rutaNotificarRegistro,
  rutaNotificarInvitadoGrupo,
  rutaNotificarGrupoCreado,
  rutaNotificarGrupoActivado,
};
