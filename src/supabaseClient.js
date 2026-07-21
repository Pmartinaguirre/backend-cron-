// Cliente de Supabase con la service_role key — este backend corre sin
// usuario logueado (lo dispara cron-job.org, no una persona), así que
// necesita permiso para escribir en desafios_mvp/usuarios/votos_mvp sin
// pelear con las políticas RLS pensadas para el navegador.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en las variables de entorno.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

module.exports = { supabase };
