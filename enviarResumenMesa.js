// POST /enviar-resumen-mesa — se llama automáticamente cuando el admin
// cierra una mesa de Check! (ver handleCerrarMesa en Check.jsx). Manda un
// mail a cada comensal de la mesa con:
//   - Su propio detalle de consumo (qué pidió, con quién lo compartió).
//   - Su "Total a pagar" (consumo + su parte de la propina - su parte del
//     descuento), igual a la columna que se ve en Check! > Cuenta de la
//     mesa > filtro "Total a pagar".
//   - Un link para volver a Check! y ver las fotos del evento (no se
//     adjuntan las fotos directo al mail: 20-30 fotos de celular pueden
//     superar fácil el límite de adjuntos de Gmail/Outlook y hacer que el
//     mail rebote — mejor un link liviano).
//
// Body: { mesaId, adminId }
//   - mesaId: id de check_mesas que se acaba de cerrar.
//   - adminId: id de usuarios de quien cerró la mesa — se verifica acá
//     mismo que sea el admin de esa mesa o de su sala (mismo criterio
//     esAdminEvento de Check.jsx), para que nadie pueda disparar el envío
//     de mails de una mesa ajena con solo saber su id.
//
// Necesita RESEND_API_KEY y RESEND_FROM_EMAIL en las variables de entorno
// (Resend, no el Supabase Auth que ya usa /invitar-a-grupo — ese solo manda
// los mails fijos de login/registro, no contenido armado a medida como
// este). RESEND_FROM_EMAIL tiene que ser un remitente de un dominio
// verificado en tu cuenta de Resend (ej. "Check! <check@tu-dominio.com>").
const { supabase } = require('../supabaseClient');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://demaster.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;

function formatoCLP(monto) {
  return '$' + Math.round(monto).toLocaleString('es-CL');
}

// Misma lógica que calcularCuentaMesa() en Check.jsx — se duplica acá
// porque este backend no importa el frontend. Si se cambia una, cambiar
// la otra.
function calcularCuenta(pedidos, productosPorId, propinaPct, descuentoPct, descuentoTope) {
  const totalesPorUsuario = {};
  let subtotalMesa = 0;
  const comensalesSet = new Set();

  pedidos.forEach((p) => {
    const producto = productosPorId[p.producto_id];
    if (!producto) return;
    const montoLinea = Number(producto.precio) * (p.cantidad || 1);
    subtotalMesa += montoLinea;
    const comensales = p.comensales && p.comensales.length > 0 ? p.comensales : [p.pedido_por];
    const porCabeza = montoLinea / comensales.length;
    comensales.forEach((uid) => {
      comensalesSet.add(uid);
      totalesPorUsuario[uid] = (totalesPorUsuario[uid] || 0) + porCabeza;
    });
  });

  const propinaTotal = subtotalMesa * ((Number(propinaPct) || 0) / 100);
  const comensalesArr = [...comensalesSet];
  const propinaPorPersona = comensalesArr.length > 0 ? propinaTotal / comensalesArr.length : 0;

  const pctDesc = Number(descuentoPct) || 0;
  const topeDesc = Number(descuentoTope) || 0;
  const descuentoCalculado = subtotalMesa * (pctDesc / 100);
  const descuentoAplicado = topeDesc > 0 ? Math.min(descuentoCalculado, topeDesc) : descuentoCalculado;
  const descuentoPorPersona = comensalesArr.length > 0 ? descuentoAplicado / comensalesArr.length : 0;
  const totalFinal = subtotalMesa + propinaTotal - descuentoAplicado;

  return {
    totalesPorUsuario, subtotalMesa, propinaTotal, propinaPorPersona,
    descuentoAplicado, descuentoPorPersona, totalFinal, comensales: comensalesArr,
  };
}

function armarHtmlMail({ mesa, nombre, lineas, consumo, propinaPorPersona, descuentoPorPersona, totalAPagar, cantidadFotos }) {
  const filasProductos = lineas.map((l) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;">
        ${l.nombreProducto}${l.compartido ? `<br/><span style="color:#999;font-size:11px;">Compartido con ${l.otros.join(', ')}</span>` : ''}
      </td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;white-space:nowrap;">${l.cantidadTexto}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;white-space:nowrap;">${formatoCLP(l.miParte)}</td>
    </tr>`).join('');

  const filaDescuento = descuentoPorPersona > 0 ? `
    <tr>
      <td style="padding:4px 8px;font-size:13px;color:#dc2626;">Descuento (tarjeta especial)</td>
      <td></td>
      <td style="padding:4px 8px;font-size:13px;color:#dc2626;text-align:right;">-${formatoCLP(descuentoPorPersona)}</td>
    </tr>` : '';

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="color:#1e3a8a;margin-bottom:4px;">🧾 ${mesa.nombre}</h2>
    <p style="color:#666;font-size:13px;margin:0 0 16px;">
      ${mesa.fecha_evento ? `📅 ${mesa.fecha_evento}<br/>` : ''}
      ${mesa.restaurante ? `${mesa.restaurante}<br/>` : ''}
      ${mesa.direccion ? `📍 ${mesa.direccion}` : ''}
    </p>
    <p style="font-size:14px;color:#333;">Hola ${nombre}, la mesa ya se cerró. Este es el resumen de lo que consumiste:</p>
    <table style="width:100%;border-collapse:collapse;margin-top:8px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:#64748b;text-transform:uppercase;">Producto</th>
          <th style="text-align:right;padding:6px 8px;font-size:11px;color:#64748b;text-transform:uppercase;">Cant.</th>
          <th style="text-align:right;padding:6px 8px;font-size:11px;color:#64748b;text-transform:uppercase;">Tu parte</th>
        </tr>
      </thead>
      <tbody>
        ${filasProductos}
        <tr>
          <td style="padding:6px 8px;font-size:13px;color:#666;font-weight:bold;">Consumido</td>
          <td></td>
          <td style="padding:6px 8px;font-size:13px;color:#666;text-align:right;font-weight:bold;">${formatoCLP(consumo)}</td>
        </tr>
        <tr>
          <td style="padding:4px 8px;font-size:13px;color:#666;">+Propina</td>
          <td></td>
          <td style="padding:4px 8px;font-size:13px;color:#666;text-align:right;">+${formatoCLP(propinaPorPersona)}</td>
        </tr>
        ${filaDescuento}
        <tr>
          <td style="padding:10px 8px;font-size:16px;color:#047857;font-weight:bold;border-top:2px solid #d1fae5;">Total a pagar</td>
          <td style="border-top:2px solid #d1fae5;"></td>
          <td style="padding:10px 8px;font-size:16px;color:#047857;font-weight:bold;text-align:right;border-top:2px solid #d1fae5;">${formatoCLP(totalAPagar)}</td>
        </tr>
      </tbody>
    </table>
    ${cantidadFotos > 0 ? `
    <div style="margin-top:20px;text-align:center;">
      <a href="${FRONTEND_URL}/check" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:10px 20px;border-radius:24px;font-size:13px;font-weight:bold;">
        📷 Ver las ${cantidadFotos} fotos del evento
      </a>
    </div>` : ''}
    <p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px;">Enviado por Check! desde Demaster-app.</p>
  </div>`;
}

async function rutaEnviarResumenMesa(req, res) {
  const { mesaId, adminId } = req.body || {};
  if (!mesaId || !adminId) {
    return res.status(400).json({ error: 'Faltan mesaId o adminId.' });
  }
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return res.status(500).json({ error: 'Falta configurar RESEND_API_KEY / RESEND_FROM_EMAIL en el backend.' });
  }

  try {
    const { data: mesa, error: errMesa } = await supabase
      .from('check_mesas').select('*').eq('id', mesaId).single();
    if (errMesa || !mesa) return res.status(404).json({ error: 'No se encontró la mesa.' });

    // Autorización: admin de ESTA mesa, o admin de la sala/grupo dueña de
    // la mesa (mismo criterio esAdminEvento de Check.jsx).
    let esAdmin = mesa.admin_id === adminId;
    if (!esAdmin) {
      const { data: sala } = await supabase
        .from('salas_privadas_mvp').select('admin_id').eq('id', mesa.sala_id).single();
      esAdmin = !!sala && sala.admin_id === adminId;
    }
    if (!esAdmin) return res.status(403).json({ error: 'Solo el admin puede mandar el resumen de esta mesa.' });

    const { data: productosData } = await supabase
      .from('check_productos').select('*').eq('mesa_id', mesaId);
    const productosPorId = {};
    (productosData || []).forEach((p) => { productosPorId[p.id] = p; });

    const { data: pedidosData } = await supabase
      .from('check_pedidos').select('*').eq('mesa_id', mesaId);
    const idsPedidos = (pedidosData || []).map((p) => p.id);

    let comensalesData = [];
    if (idsPedidos.length > 0) {
      const { data } = await supabase
        .from('check_pedidos_comensales').select('*').in('pedido_id', idsPedidos);
      comensalesData = data || [];
    }
    const comensalesPorPedido = {};
    comensalesData.forEach((c) => {
      if (!comensalesPorPedido[c.pedido_id]) comensalesPorPedido[c.pedido_id] = [];
      comensalesPorPedido[c.pedido_id].push(c.usuario_id);
    });
    const pedidos = (pedidosData || []).map((p) => ({
      ...p,
      comensales: [...new Set(comensalesPorPedido[p.id] || [])],
    }));

    const { count: cantidadFotos } = await supabase
      .from('check_fotos').select('id', { count: 'exact', head: true }).eq('mesa_id', mesaId);

    const cuenta = calcularCuenta(pedidos, productosPorId, mesa.propina_pct, mesa.descuento_pct, mesa.descuento_tope);
    if (cuenta.comensales.length === 0) {
      return res.json({ ok: true, enviados: 0, mensaje: 'La mesa no tiene pedidos, no se mandó ningún mail.' });
    }

    const { data: usuariosData } = await supabase
      .from('usuarios').select('id, nombre, email').in('id', cuenta.comensales);
    const usuariosPorId = {};
    (usuariosData || []).forEach((u) => { usuariosPorId[u.id] = u; });

    const resultados = [];
    for (const uid of cuenta.comensales) {
      const usuario = usuariosPorId[uid];
      if (!usuario || !usuario.email) {
        resultados.push({ uid, ok: false, motivo: 'sin_email' });
        continue;
      }

      const pedidosDeEstaPersona = pedidos.filter((p) => p.comensales.includes(uid));
      const lineas = pedidosDeEstaPersona.map((p) => {
        const producto = productosPorId[p.producto_id];
        if (!producto) return null;
        const compartido = p.comensales.length > 1;
        const montoLinea = Number(producto.precio) * (p.cantidad || 1);
        const miParte = montoLinea / p.comensales.length;
        const otros = compartido
          ? p.comensales.filter((otroUid) => otroUid !== uid).map((otroUid) => (usuariosPorId[otroUid]?.nombre) || 'Jugador')
          : [];
        return {
          nombreProducto: producto.nombre,
          cantidadTexto: compartido ? `${p.cantidad}/${p.comensales.length}` : `${p.cantidad}`,
          miParte, compartido, otros,
        };
      }).filter(Boolean);

      const consumo = cuenta.totalesPorUsuario[uid] || 0;
      const totalAPagar = consumo + cuenta.propinaPorPersona - cuenta.descuentoPorPersona;

      const html = armarHtmlMail({
        mesa, nombre: usuario.nombre || 'Jugador', lineas, consumo,
        propinaPorPersona: cuenta.propinaPorPersona, descuentoPorPersona: cuenta.descuentoPorPersona,
        totalAPagar, cantidadFotos: cantidadFotos || 0,
      });

      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: [usuario.email],
            subject: `Resumen de tu cuenta — ${mesa.nombre}`,
            html,
          }),
        });
        if (!resp.ok) {
          const textoError = await resp.text();
          resultados.push({ uid, ok: false, motivo: textoError });
        } else {
          resultados.push({ uid, ok: true });
        }
      } catch (e) {
        resultados.push({ uid, ok: false, motivo: e.message });
      }
    }

    const enviados = resultados.filter((r) => r.ok).length;
    const fallidos = resultados.filter((r) => !r.ok);
    return res.json({ ok: true, enviados, fallidos });
  } catch (e) {
    console.error('[/enviar-resumen-mesa] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { rutaEnviarResumenMesa };
