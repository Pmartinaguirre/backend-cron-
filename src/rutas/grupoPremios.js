// Premios de grupo (a pedido, cambio "LETALES" 30-ago-2026): estado del
// nuevo menú "Premios" del panel de admin de grupo — el admin decide si
// juega con premios reales del Fan Market (calcula una cuota por jugador y
// tiene 24h para depositar) o si no, se le regala PRIME al 1er lugar de la
// Polla. Sin pasarela de pago real: el depósito se hace fuera de la app y
// Pablo lo constata a mano desde el admin general (rutaMarcarPagado).
const { supabase } = require('../supabaseClient');

const HORAS_VENTANA_PAGO = 24;

// Cuenta miembros de un grupo (mismo criterio que rankingGrupo.js: el admin
// cuenta aunque no tenga fila propia en salas_privadas_miembros_mvp).
async function contarMiembros(salaId, adminId) {
  const { data, error } = await supabase
    .from('salas_privadas_miembros_mvp')
    .select('usuario_id')
    .eq('sala_id', salaId);
  if (error) throw error;
  const ids = new Set((data || []).map((m) => m.usuario_id));
  if (adminId) ids.add(adminId);
  return ids.size;
}

// GET /grupo-premios?salaId=X — trae el estado actual (o uno "vacío" en
// borrador si el grupo todavía no lo tocó).
async function rutaObtenerPremios(req, res) {
  const salaId = req.query.salaId;
  if (!salaId) return res.status(400).json({ error: 'Falta "salaId".' });
  try {
    const { data, error } = await supabase
      .from('grupo_premios')
      .select('*')
      .eq('sala_id', salaId)
      .maybeSingle();
    if (error) throw error;
    res.json({
      premios: data || {
        sala_id: salaId,
        quiere_premios: null,
        modo_premiacion: null,
        productos_elegidos: [],
        costo_total: 0,
        cuota_por_jugador: 0,
        estado: 'borrador',
        fecha_limite_pago: null,
      },
    });
  } catch (e) {
    console.error('[/grupo-premios GET] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// POST /grupo-premios/guardar — borrador: guarda quiere_premios/modo/
// productos elegidos y recalcula costo_total/cuota_por_jugador en vivo
// (para que el admin vea la cuota mientras arma el pack). NO confirma
// todavía — eso es rutaConfirmarPremios.
async function rutaGuardarPremios(req, res) {
  const { salaId, adminId, quierePremios, modoPremiacion, productosElegidos } = req.body || {};
  if (!salaId || !adminId) return res.status(400).json({ error: 'Falta "salaId" o "adminId".' });
  try {
    // Solo el admin del grupo puede tocar esto (mismo criterio que el resto
    // del panel de admin: se valida contra la fila real de salas_privadas_mvp).
    const { data: sala, error: errSala } = await supabase
      .from('salas_privadas_mvp')
      .select('id, admin_id')
      .eq('id', salaId)
      .single();
    if (errSala) throw errSala;
    if (!sala || sala.admin_id !== adminId) {
      return res.status(403).json({ error: 'No eres admin de este grupo.' });
    }

    let costoTotal = 0;
    let cuotaPorJugador = 0;
    const lista = Array.isArray(productosElegidos) ? productosElegidos : [];
    if (quierePremios && lista.length > 0) {
      const ids = lista.map((p) => p.producto_id);
      const { data: productos, error: errProd } = await supabase
        .from('fan_market_productos')
        .select('id, nombre, precio_interno')
        .in('id', ids);
      if (errProd) throw errProd;
      const precioPorId = Object.fromEntries((productos || []).map((p) => [p.id, p]));
      costoTotal = lista.reduce((acc, p) => {
        const prod = precioPorId[p.producto_id];
        if (!prod) return acc;
        return acc + Number(prod.precio_interno) * (Number(p.cantidad) || 1);
      }, 0);
      const cantidadJugadores = await contarMiembros(salaId, sala.admin_id);
      cuotaPorJugador = cantidadJugadores > 0 ? Math.ceil(costoTotal / cantidadJugadores) : 0;
      // Snapshot de nombres (por si el producto se edita/desactiva después).
      lista.forEach((p) => {
        p.nombre = precioPorId[p.producto_id]?.nombre || p.nombre || '';
      });
    }

    const payload = {
      sala_id: salaId,
      quiere_premios: quierePremios ?? null,
      modo_premiacion: modoPremiacion || null,
      productos_elegidos: lista,
      costo_total: costoTotal,
      cuota_por_jugador: cuotaPorJugador,
      estado: 'borrador',
      actualizado_en: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('grupo_premios')
      .upsert(payload, { onConflict: 'sala_id' })
      .select()
      .single();
    if (error) throw error;
    res.json({ premios: data });
  } catch (e) {
    console.error('[/grupo-premios/guardar] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// POST /grupo-premios/confirmar — "Agregar los premios al campeonato":
// pasa a estado pendiente_pago y fija fecha_limite_pago = ahora+24h.
async function rutaConfirmarPremios(req, res) {
  const { salaId, adminId } = req.body || {};
  if (!salaId || !adminId) return res.status(400).json({ error: 'Falta "salaId" o "adminId".' });
  try {
    const { data: sala, error: errSala } = await supabase
      .from('salas_privadas_mvp')
      .select('id, admin_id')
      .eq('id', salaId)
      .single();
    if (errSala) throw errSala;
    if (!sala || sala.admin_id !== adminId) {
      return res.status(403).json({ error: 'No eres admin de este grupo.' });
    }
    const limite = new Date(Date.now() + HORAS_VENTANA_PAGO * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('grupo_premios')
      .update({ estado: 'pendiente_pago', fecha_limite_pago: limite, actualizado_en: new Date().toISOString() })
      .eq('sala_id', salaId)
      .select()
      .single();
    if (error) throw error;
    res.json({ premios: data });
  } catch (e) {
    console.error('[/grupo-premios/confirmar] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

// POST /grupo-premios/admin/marcar-pagado — solo Pablo, desde el admin
// general, una vez que constata el depósito fuera de la app.
async function rutaMarcarPagado(req, res) {
  const { salaId } = req.body || {};
  if (!salaId) return res.status(400).json({ error: 'Falta "salaId".' });
  try {
    const { data, error } = await supabase
      .from('grupo_premios')
      .update({ estado: 'pagado', actualizado_en: new Date().toISOString() })
      .eq('sala_id', salaId)
      .select()
      .single();
    if (error) throw error;
    res.json({ premios: data });
  } catch (e) {
    console.error('[/grupo-premios/admin/marcar-pagado] Error:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  rutaObtenerPremios,
  rutaGuardarPremios,
  rutaConfirmarPremios,
  rutaMarcarPagado,
};
