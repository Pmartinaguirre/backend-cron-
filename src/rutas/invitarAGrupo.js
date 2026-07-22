// POST /invitar-a-grupo — invita a un amigo a un grupo (sala privada), tanto
// si ya tiene cuenta en la app como si no.
//
// Body: { salaId, email, invitadorId }
//   - salaId: id de la sala (salas_privadas_mvp)
//   - email: mail del amigo a invitar
//   - invitadorId: id de usuarios del que está invitando — se verifica acá
//     mismo que sea el admin de esa sala, para que nadie pueda agregar
//     miembros a un grupo ajeno con solo saber su id.
//
// A propósito NO exige el header X-Cron-Secret (como /equipos): lo llama
// directo el navegador del jugador (admin de su grupo) desde Perfil.jsx —
// pedirle el secreto obligaría a exponerlo en el código del frontend.
// La verificación de que quien invita es el admin de la sala hace de
// autorización en su lugar (mismo criterio "cliente confía, backend
// verifica lo mínimo" que ya usa el resto de esta app, ej. isAdmin en el
// frontend para el panel Admin).
//
// Necesita SUPABASE_SERVICE_KEY (ya configurada en este backend) porque
// invitar a alguien SIN cuenta todavía usa supabase.auth.admin.inviteUserByEmail
// — una llamada de administrador que solo funciona con la service_role key,
// nunca se puede hacer desde el navegador con la clave anon.
const { supabase } = require('../supabaseClient');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://demaster.app';

async function rutaInvitarAGrupo(req, res) {
  const { salaId, email, invitadorId } = req.body || {};
  if (!salaId || !email || !invitadorId) {
    return res.status(400).json({ error: 'Faltan salaId, email o invitadorId.' });
  }
  const emailNormalizado = String(email).trim().toLowerCase();
  if (!emailNormalizado.includes('@')) {
    return res.status(400).json({ error: 'Email inválido.' });
  }

  try {
    // 1. Verificar que quien invita es el admin de esa sala.
    const { data: sala, error: errSala } = await supabase
      .from('salas_privadas_mvp')
      .select('id, nombre, admin_id')
      .eq('id', salaId)
      .single();
    if (errSala || !sala) {
      return res.status(404).json({ error: 'No se encontró el grupo.' });
    }
    if (sala.admin_id !== invitadorId) {
      return res.status(403).json({ error: 'Solo el administrador del grupo puede invitar.' });
    }

    // 2. ¿El mail ya es de un jugador registrado? Se busca case-insensitive
    // porque el mail se guarda tal cual lo escribió cada uno al registrarse.
    const { data: usuarioExistente, error: errUsuario } = await supabase
      .from('usuarios')
      .select('id, nombre, email')
      .ilike('email', emailNormalizado)
      .maybeSingle();
    if (errUsuario) throw errUsuario;

    // 3. ¿Ya es miembro (o ya está invitado) de esta sala? Evita duplicados
    // tanto por usuario_id (ya registrado) como por email_invitado
    // (invitación pendiente repetida).
    const { data: yaMiembro } = await supabase
      .from('salas_privadas_miembros_mvp')
      .select('id')
      .eq('sala_id', salaId)
      .or(
        usuarioExistente
          ? `usuario_id.eq.${usuarioExistente.id}`
          : `email_invitado.eq.${emailNormalizado}`
      )
      .maybeSingle();
    if (yaMiembro) {
      return res.status(409).json({ error: 'Esa persona ya está invitada o es miembro de este grupo.' });
    }

    if (usuarioExistente) {
      // Ya tiene cuenta: se agrega directo como miembro. invitacion_vista
      // queda en false (default) para que le salga el popup "Te invitaron a
      // jugar a X" la próxima vez que entre — mismo mecanismo que ya usa el
      // resto de la app para esto.
      const { error: errInsert } = await supabase
        .from('salas_privadas_miembros_mvp')
        .insert([{ sala_id: salaId, usuario_id: usuarioExistente.id, invitacion_vista: false }]);
      if (errInsert) throw errInsert;
      return res.json({ ok: true, tipo: 'usuario_existente', nombre: usuarioExistente.nombre });
    }

    // No tiene cuenta todavía: se manda la invitación nativa de Supabase
    // (mismo Resend ya configurado en Supabase Auth) y se guarda una fila
    // "pendiente" (sin usuario_id) para vincularla sola cuando complete su
    // registro (ver Registro.jsx).
    const { error: errInvite } = await supabase.auth.admin.inviteUserByEmail(emailNormalizado, {
      redirectTo: `${FRONTEND_URL}/registro`,
    });
    if (errInvite) throw errInvite;

    const { error: errInsertPendiente } = await supabase
      .from('salas_privadas_miembros_mvp')
      .insert([{ sala_id: salaId, email_invitado: emailNormalizado, invitacion_vista: false }]);
    if (errInsertPendiente) throw errInsertPendiente;

    return res.json({ ok: true, tipo: 'invitacion_nueva', email: emailNormalizado });
  } catch (e) {
    console.error('[/invitar-a-grupo] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaInvitarAGrupo };
