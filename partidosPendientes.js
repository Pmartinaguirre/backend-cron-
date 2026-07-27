// ============================================================
// QUÉ PARTIDOS VALE LA PENA SEGUIR CONSULTÁNDOLE A API-FOOTBALL
// ============================================================
// Lo usan /vivo (cada 1 min) y /resolver (cada 5-15 min). Vive en un archivo
// aparte a propósito: cuando el criterio estaba duplicado en los dos
// endpoints, /resolver se quedó atrás (ni siquiera excluía los FT) y cada uno
// terminó consultando un conjunto distinto de partidos.
//
// EL PROBLEMA QUE RESUELVE
//
// Los dos crons buscaban "partidos cuya fecha ya pasó y que todavía no están
// resueltos". Un partido POSTERGADO cumple las dos condiciones para siempre:
// su fecha_expiracion vieja ya pasó, su estado es PST/CANC/ABD (nunca llega a
// FT) y nunca se resuelve. Resultado: quedaba en la lista de pendientes de
// forma indefinida, consumiendo
//
//     1.440 llamadas/día  (/vivo, cada minuto)
//     +  144 llamadas/día (/resolver, cada 10 min)
//     = 1.584 llamadas/día, por un partido que nadie va a jugar.
//
// Hay una salvaguarda en /vivo que reprograma la fecha cuando la API publica
// una nueva, pero solo se activa si esa fecha es futura. Un partido postergado
// sin fecha nueva, o cancelado de verdad, nunca sale por ahí.

// Estados en los que ya no hay nada más que preguntar:
//   FT / AET / PEN → terminó (normal, tras alargue, tras penales).
//   CANC / ABD / AWD / WO → no se jugó ni se va a jugar (cancelado,
//     abandonado, ganado en escritorio, walkover).
// PST, SUSP y TBD NO están acá a propósito: esos sí se pueden reprogramar, y
// mientras estén dentro de la ventana de días conviene seguir mirándolos por
// si la API publica la fecha nueva. De limitarlos se encarga DIAS_GRACIA.
const ESTADOS_TERMINADOS = ['FT', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO'];

// Red de seguridad por tiempo. Si pasaron más de 3 días desde la fecha del
// partido y sigue sin resolverse, algo salió mal (la API perdió el fixture, el
// partido se canceló sin avisar, el id quedó mal vinculado). Sea lo que sea,
// no se arregla insistiendo cada minuto: se corta y queda para revisar a mano
// desde el Admin.
//
// Por qué 3 días y no menos: un partido suspendido al minuto 60 por lluvia se
// suele completar dentro de las 48 horas siguientes, y en ese caso el mismo
// fixture cambia a FT sin cambiar de fecha. Con una ventana más corta lo
// perderíamos y habría que resolverlo a mano.
const DIAS_GRACIA = 3;

// `partidos` son las filas de desafios_mvp que ya trajo el endpoint.
// Devuelve solo aquellas por las que todavía tiene sentido gastar una llamada.
function filtrarPendientes(partidos) {
  const limiteViejo = Date.now() - DIAS_GRACIA * 24 * 60 * 60 * 1000;

  return (partidos || []).filter((p) => {
    // OJO: este filtro va en memoria y no en la consulta a Supabase. En SQL,
    // "estado_partido <> 'FT'" excluye también las filas donde la columna es
    // NULL, y los partidos recién activados todavía no tienen estado puesto:
    // quedarían fuera para siempre y nunca se actualizarían.
    if (ESTADOS_TERMINADOS.includes(p.estado_partido)) return false;

    const fecha = p.fecha_expiracion ? new Date(p.fecha_expiracion).getTime() : null;
    if (fecha != null && Number.isFinite(fecha) && fecha < limiteViejo) return false;

    // Ya resuelto por /resolver: Cat.5 guarda resultado_oficial, Cat.4 guarda
    // el marcador. Si ya está, no hay nada que actualizar ni que pagar.
    return Number(p.categoria) === 5 ? !p.resultado_oficial : p.goles_local_oficial == null;
  });
}

// Los que quedaron fuera por viejos, para poder reportarlos en la respuesta
// del endpoint. Sin esto un partido mal vinculado desaparece en silencio y no
// hay forma de darse cuenta salvo notando que nunca se resolvió.
function partidosAbandonados(partidos) {
  const limiteViejo = Date.now() - DIAS_GRACIA * 24 * 60 * 60 * 1000;
  return (partidos || [])
    .filter((p) => {
      if (ESTADOS_TERMINADOS.includes(p.estado_partido)) return false;
      const fecha = p.fecha_expiracion ? new Date(p.fecha_expiracion).getTime() : null;
      if (fecha == null || !Number.isFinite(fecha) || fecha >= limiteViejo) return false;
      return Number(p.categoria) === 5 ? !p.resultado_oficial : p.goles_local_oficial == null;
    })
    .map((p) => ({ id: p.id, estado: p.estado_partido, fecha: p.fecha_expiracion }));
}

module.exports = { filtrarPendientes, partidosAbandonados, ESTADOS_TERMINADOS, DIAS_GRACIA };
