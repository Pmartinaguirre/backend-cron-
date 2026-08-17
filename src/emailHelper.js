// Helper compartido para mandar mails transaccionales de "hitos" del
// jugador (a pedido: "armar el flujo básico de email para los hitos de los
// jugadores... sin gastar dinero en mailing"). Usa Resend con el mismo
// mecanismo (fetch directo a su API, sin SDK) que ya usa
// enviarResumenMesa.js para el resumen de Check! — reutiliza las mismas
// variables de entorno (RESEND_API_KEY / RESEND_FROM_EMAIL), así que no
// hace falta configurar nada nuevo si ya estaban seteadas. Plan gratis de
// Resend: 3.000 mails/mes / 100 por día, alcanza de sobra para esto.
//
// OJO dominio: RESEND_FROM_EMAIL tiene que ser un remitente de un dominio
// VERIFICADO en la cuenta de Resend (Settings → Domains). Sin verificar,
// Resend solo deja mandar al mail con el que te registraste (modo prueba)
// — cualquier otro destinatario rebota. Si las pruebas fallan raro (mails
// que no llegan a jugadores que no sean vos), lo primero es revisar eso.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://demaster.app';

// Envía un mail simple. Nunca tira excepción hacia arriba (a propósito: un
// mail de "hito" que falla NUNCA debe romper la operación real — crear un
// grupo, activar un grupo, etc. — así que quien llama a esto siempre debe
// tratarlo como "mejor esfuerzo", ver las rutas de notificaciones.js).
async function enviarMail({ to, subject, html }) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.warn('[emailHelper] Falta RESEND_API_KEY / RESEND_FROM_EMAIL, no se mandó el mail:', subject);
    return { ok: false, motivo: 'falta_configuracion' };
  }
  if (!to) return { ok: false, motivo: 'sin_email' };
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [to], subject, html }),
    });
    if (!resp.ok) {
      const texto = await resp.text();
      console.error('[emailHelper] Resend respondió error:', texto);
      return { ok: false, motivo: texto };
    }
    return { ok: true };
  } catch (e) {
    console.error('[emailHelper] Error de red mandando mail:', e.message);
    return { ok: false, motivo: e.message };
  }
}

// Plantilla base (a pedido, mismo estilo visual simple/tabla que ya usa
// enviarResumenMesa.js — Arial, verde de marca #047857/#059669) para que
// los 4 mails de hitos se vean parecidos entre sí sin repetir el HTML
// completo en cada ruta.
function plantillaBase({ titulo, cuerpoHtml, botonTexto, botonUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">
    <p style="color:#059669;font-size:12px;font-weight:bold;letter-spacing:0.5px;text-transform:uppercase;margin:0 0 8px;">Demaster.app</p>
    <h2 style="color:#111827;margin:0 0 14px;font-size:20px;">${titulo}</h2>
    <div style="font-size:14px;color:#374151;line-height:1.5;">${cuerpoHtml}</div>
    ${botonTexto && botonUrl ? `
    <div style="margin-top:22px;">
      <a href="${botonUrl}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;padding:11px 22px;border-radius:24px;font-size:13px;font-weight:bold;">
        ${botonTexto}
      </a>
    </div>` : ''}
    <p style="color:#aaa;font-size:11px;margin-top:28px;">Recibiste este mail porque tienes una cuenta en Demaster.app.</p>
  </div>`;
}

module.exports = { enviarMail, plantillaBase, FRONTEND_URL };
