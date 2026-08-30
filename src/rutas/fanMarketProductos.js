// Catálogo del Fan Market (a pedido, cambio "LETALES" 30-ago-2026): Pablo
// carga productos (camisetas, pelotas, entradas, streaming, Demaster PRIME)
// desde un panel de admin general, y los grupos los eligen como premio en
// el nuevo menú "Premios" del panel de admin de grupo.
//
// IMPORTANTE — precio_interno NUNCA sale de rutaListarProductosPublico: es
// el costo real que paga/cobra Pablo, oculto a los jugadores (solo se usa
// para calcular la cuota de inscripción en grupoPremios.js). El panel de
// admin general SÍ lo ve (rutaListarProductosAdmin), protegido con
// exigirSecreto igual que el resto de rutas de escritura sensibles.
const { supabase } = require('../supabaseClient');

// GET /fan-market/productos — lista pública (sin precio), para el flujo de
// elección de premios de un grupo. Solo productos activos.
async function rutaListarProductosPublico(req, res) {
  try {
    const { data, error } = await supabase
      .from('fan_market_productos')
      .select('id, nombre, descripcion, imagen_url, categoria')
      .eq('activo', true)
      .order('categoria', { ascending: true });
    if (error) throw error;
    res.json({ productos: data || [] });
  } catch (e) {
    console.error('[/fan-market/productos] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// GET /fan-market/admin/productos — lista completa CON precio_interno,
// solo para el panel de admin general (protegida con X-Cron-Secret, mismo
// criterio que el resto de rutas de escritura de este backend).
async function rutaListarProductosAdmin(req, res) {
  try {
    const { data, error } = await supabase
      .from('fan_market_productos')
      .select('*')
      .order('creado_en', { ascending: false });
    if (error) throw error;
    res.json({ productos: data || [] });
  } catch (e) {
    console.error('[/fan-market/admin/productos] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// POST /fan-market/admin/productos — crea o edita un producto (si viene
// `id` en el body, actualiza; si no, crea uno nuevo).
async function rutaGuardarProductoAdmin(req, res) {
  const { id, nombre, descripcion, imagen_url, categoria, precio_interno, activo } = req.body || {};
  if (!nombre || precio_interno == null) {
    return res.status(400).json({ error: 'Falta "nombre" o "precio_interno".' });
  }
  try {
    const payload = {
      nombre,
      descripcion: descripcion || null,
      imagen_url: imagen_url || null,
      categoria: categoria || 'otro',
      precio_interno: Number(precio_interno),
      activo: activo !== false,
    };
    let resultado;
    if (id) {
      resultado = await supabase.from('fan_market_productos').update(payload).eq('id', id).select().single();
    } else {
      resultado = await supabase.from('fan_market_productos').insert(payload).select().single();
    }
    if (resultado.error) throw resultado.error;
    res.json({ producto: resultado.data });
  } catch (e) {
    console.error('[/fan-market/admin/productos POST] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  rutaListarProductosPublico,
  rutaListarProductosAdmin,
  rutaGuardarProductoAdmin,
};
