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

// Hay DOS listas de estados y la diferencia entre ellas es la corrección de
// un bug real, así que conviene entenderla bien.
//
// Partido TERMINADO (FT / AET / PEN): el resultado ya existe.
//   - /vivo NO tiene nada que hacer con él: no hay minuto ni marcador que
//     actualizar.
//   - /resolver SÍ lo necesita: es EXACTAMENTE el partido que está buscando
//     para pagar los diamantes.
//
// Al principio los dos endpoints compartían una sola lista que incluía FT, y
// eso rompió la cadena: /vivo marcaba el partido como FT y desde ese momento
// /resolver dejaba de verlo. El partido quedaba para siempre en "En vivo",
// con su FT puesto y sin pagar nunca (caso Boca Juniors vs Deportivo
// Riestra).
const ESTADOS_YA_JUGADO = ['FT', 'AET', 'PEN'];

// Partido que NO se jugó ni se va a jugar. Para los dos endpoints es igual:
// no hay nada que actualizar ni nada que pagar.
// PST, SUSP y TBD NO están acá a propósito: esos sí se pueden reprogramar, y
// mientras estén dentro de la ventana de días conviene seguir mirándolos por
// si la API publica la fecha nueva. De limitarlos se encarga DIAS_GRACIA.
const ESTADOS_SIN_PARTIDO = ['CANC', 'ABD', 'AWD', 'WO'];

const ESTADOS_TERMINADOS = [...ESTADOS_YA_JUGADO, ...ESTADOS_SIN_PARTIDO];

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
// `para` dice quién pregunta: 'vivo' o 'resolver'. NO es un detalle — es la
// diferencia entre incluir o excluir los partidos ya terminados (ver la nota
// de las dos listas de estados, más arriba).
function filtrarPendientes(partidos, para = 'vivo') {
  const limiteViejo = Date.now() - DIAS_GRACIA * 24 * 60 * 60 * 1000;
  const estadosADescartar = para === 'resolver'
    ? ESTADOS_SIN_PARTIDO            // /resolver quiere los FT
    : ESTADOS_TERMINADOS;            // /vivo no tiene nada que hacer con ellos

  return (partidos || []).filter((p) => {
    // OJO: este filtro va en memoria y no en la consulta a Supabase. En SQL,
    // "estado_partido <> 'FT'" excluye también las filas donde la columna es
    // NULL, y los partidos recién activados todavía no tienen estado puesto:
    // quedarían fuera para siempre y nunca se actualizarían.
    if (estadosADescartar.includes(p.estado_partido)) return false;

    // UN PARTIDO EN FT NUNCA SE ABANDONA POR VIEJO.
    //
    // DIAS_GRACIA existe para dejar de perseguir zombis: partidos que nunca
    // van a terminar (mal vinculados, cancelados sin avisar, postergados sin
    // fecha nueva). Pero un partido con FT no es un zombi — es un PAGO
    // PENDIENTE, y ya sabemos su resultado.
    //
    // Aplicarle el corte de 3 días fue un error con consecuencia visible:
    // /resolver lo abandonaba, nadie cobraba sus diamantes, y como el
    // frontend define "En vivo" como "cerrado y sin resolver", el partido se
    // quedaba ahí para siempre. Fue el caso de Boca Juniors vs Deportivo
    // Riestra: FT hacía días, en la lista de partidos en vivo.
    const yaTerminado = ESTADOS_YA_JUGADO.includes(p.estado_partido);
    if (!yaTerminado) {
      const fecha = p.fecha_expiracion ? new Date(p.fecha_expiracion).getTime() : null;
      if (fecha != null && Number.isFinite(fecha) && fecha < limiteViejo) return false;
    }

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
      // Coherente con filtrarPendientes: un FT nunca se abandona, así que
      // tampoco se reporta como abandonado. Si no, el endpoint diría que
      // dejó de mirar un partido que en realidad sigue procesando.
      if (ESTADOS_YA_JUGADO.includes(p.estado_partido)) return false;
      const fecha = p.fecha_expiracion ? new Date(p.fecha_expiracion).getTime() : null;
      if (fecha == null || !Number.isFinite(fecha) || fecha >= limiteViejo) return false;
      return Number(p.categoria) === 5 ? !p.resultado_oficial : p.goles_local_oficial == null;
    })
    .map((p) => ({ id: p.id, estado: p.estado_partido, fecha: p.fecha_expiracion }));
}

module.exports = { filtrarPendientes, partidosAbandonados, ESTADOS_TERMINADOS, ESTADOS_YA_JUGADO, ESTADOS_SIN_PARTIDO, DIAS_GRACIA };
