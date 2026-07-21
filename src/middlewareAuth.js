// Protege cada endpoint de cron: exige el header "X-Cron-Secret" con el
// mismo valor que CRON_SECRET (variable de entorno). Sin esto, cualquiera
// que encuentre la URL del backend (que va a estar expuesta en internet
// para que cron-job.org la pueda llamar) podría disparar los jobs sin
// permiso — por ejemplo, forzar el pago de diamantes o crear partidos falsos.
const CRON_SECRET = process.env.CRON_SECRET;

if (!CRON_SECRET) {
  throw new Error('Falta CRON_SECRET en las variables de entorno.');
}

function exigirSecreto(req, res, next) {
  const secretoRecibido = req.get('X-Cron-Secret');
  if (secretoRecibido !== CRON_SECRET) {
    return res.status(401).json({ error: 'Falta o es incorrecto el header X-Cron-Secret.' });
  }
  next();
}

module.exports = { exigirSecreto };
