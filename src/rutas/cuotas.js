// GET/POST /cuotas — mismo trabajo que hacía actualizar_cuotas.js a mano:
// busca partidos Cat.4/5 activos sin cuota guardada, les pide la cuota
// "Match Winner" a API-Football, y guarda cuota_local/empate/visita.
// Idempotente: los partidos que ya tienen cuota se saltan siempre, así que
// no hay problema en llamarlo seguido (ej. cada 10 min).
//
// SEPARADO de estadio/árbitro/validación de equipos (a pedido de Pablo:
// "no deberíamos tener cron jobs independientes para cuota y estadio/árbitro
// para que no entorpezca?" — ver src/rutas/infoPartido.js). Antes vivían
// juntos acá y compartían el mismo cupo por corrida: cada vez que se
// agregaba un tipo de dato nuevo (árbitro, validación de equipos, estadio)
// terminaba compitiendo con la cuota por ese cupo, dejándola starving
// corrida tras corrida (pasó 3 veces seguidas). Ahora este endpoint SOLO se
// ocupa de la cuota — el dato más importante, el que necesitan los
// jugadores para pronosticar — y nunca puede quedar bloqueado por un
// backlog de estadio/árbitro que a veces ni siquiera se puede resolver
// (la API rechaza o no tiene ciertos nombres de estadio).
//
// VENTANA DE CUOTAS (a pedido, control de consumo de API-Football): antes
// esto revisaba TODOS los partidos activos sin cuota, sin importar cuán
// lejos estuviera la fecha — con /crear-partidos trayendo partidos hasta
// 60 días antes (DIAS_ANTICIPACION, ver ese archivo), un partido recién
// creado podía quedar "sin cuota todavía" semanas enteras, cobrando una
// llamada a la API en CADA corrida de este cron hasta que la cuota
// apareciera — y API-Football no publica cuotas de partidos tan lejos en
// el futuro, así que esas llamadas salían siempre en blanco. Acá se filtra
// a solo los partidos dentro de los próximos DIAS_VENTANA_CUOTAS días: no
// tiene sentido consultar la cuota de un partido a 60 días si de todos
// modos va a estar disponible recién ~7 días antes.
const DIAS_VENTANA_CUOTAS = Number(process.env.DIAS_VENTANA_CUOTAS) || 10;

const { supabase } = require('../supabaseClient');
const { obtenerCuotas } = require('../apiFootball');

async function rutaCuotas(req, res) {
  const ahora = new Date();
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_VENTANA_CUOTAS);

  const columnas = 'id, pregunta, fixture_id_api, categoria, fecha_expiracion, cuota_local, cuotas_comparativa, cuota_refrescada_urgente';

  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select(columnas)
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('fixture_id_api', 'is', null)
    // cuotas_comparativa.is.null agregado a pedido (pestaña "Cuotas"): sin
    // esto, un partido que YA tenía cuota_local guardada de antes de que
    // existiera esta columna nunca volvía a pedirse — se quedaba sin
    // comparativa para siempre.
    // cuota_refrescada_urgente.is.null agregado a pedido (caso real: cuota
    // de diamantes 1.28/4.8/12 contra 1.37-1.48/4.2-4.65/6.5-8.1 de las
    // casas el día del partido — la cuota de diamantes es una foto vieja,
    // de cuando se creó el partido, y nunca se refrescaba): sin esto, un
    // partido que YA tiene cuota_local/cuotas_comparativa completos jamás
    // volvía a entrar acá, así que nunca llegaba a la ventana urgente (ver
    // más abajo) para refrescarse una vez antes de arrancar.
    .or('cuota_local.is.null,cuotas_comparativa.is.null,cuota_refrescada_urgente.is.null')
    .gte('fecha_expiracion', ahora.toISOString())
    .lte('fecha_expiracion', limite.toISOString())
    // Los partidos que juegan más pronto primero (a pedido, junto con el
    // tope por corrida de más abajo): si hay que repartir el trabajo en
    // varias corridas, que le toque antes al que menos tiempo tiene para
    // conseguir su cuota.
    .order('fecha_expiracion', { ascending: true });

  if (error) {
    console.error('[/cuotas] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  const todosLosPartidosSinOrden = partidos || [];

  // URGENTES (a pedido: la cuota de diamantes se refresca una sola vez
  // dentro de esta ventana antes de arrancar, ver más abajo).
  const HORAS_VENTANA_URGENTE = 48;
  const limiteUrgente = new Date(ahora.getTime() + HORAS_VENTANA_URGENTE * 60 * 60 * 1000);
  const horario = (p) => p.fecha_expiracion ? new Date(p.fecha_expiracion).getTime() : Infinity;
  const esUrgente = (p) => horario(p) <= limiteUrgente.getTime();

  // TOPE POR CORRIDA (a pedido, bug reportado: cron-job.org viene fallando
  // por "tiempo de espera agotado" — con muchos partidos entrando de golpe
  // a la ventana, procesarlos todos en una sola corrida pasa fácil los 30s
  // de timeout). Se procesa como máximo esta cantidad por corrida; el resto
  // queda para la PRÓXIMA (cada 10 min según cron-job.org) — es seguro
  // porque el query de arriba ya es idempotente.
  const MAX_PARTIDOS_POR_CORRIDA = Number(process.env.MAX_PARTIDOS_POR_CORRIDA_CUOTAS) || 15;

  // Ya no hay ninguna otra categoría de dato compitiendo por este cupo (ver
  // comentario de arriba), así que alcanza con más próximo primero — los
  // urgentes (48h) ya caen naturalmente primero por estar más cerca en
  // fecha, no hace falta separarlos aparte.
  const partidos_a_procesar = todosLosPartidosSinOrden
    .slice()
    .sort((a, b) => horario(a) - horario(b))
    .slice(0, MAX_PARTIDOS_POR_CORRIDA);

  const resultado = {
    revisados: partidos_a_procesar.length,
    pendientesProximaCorrida: Math.max(0, todosLosPartidosSinOrden.length - partidos_a_procesar.length),
    actualizados: 0,
    sinCuotaTodavia: 0,
    errores: [],
  };

  for (const partido of partidos_a_procesar) {
    try {
      const payload = {};
      // Refresco único de la cuota que paga diamantes dentro de la ventana
      // urgente (a pedido, caso real: cuota de diamantes 1.28/4.8/12 contra
      // 1.37-1.48/4.2-4.65/6.5-8.1 de las casas el día del partido — la
      // cuota de diamantes se pedía UNA sola vez, hasta 10 días antes, y
      // quedaba congelada mientras el mercado seguía moviéndose). Se
      // refresca UNA sola vez (cuota_refrescada_urgente marca que ya pasó)
      // para no multiplicar el consumo de API-Football en cada corrida.
      const necesitaRefrescoUrgente = esUrgente(partido) && !partido.cuota_refrescada_urgente;
      if (partido.cuota_local == null || partido.cuotas_comparativa == null || necesitaRefrescoUrgente) {
        const cuotas = await obtenerCuotas(partido.fixture_id_api);
        if (cuotas) {
          if (partido.cuota_local == null || necesitaRefrescoUrgente) {
            payload.cuota_local = cuotas.cuota_local;
            payload.cuota_empate = cuotas.cuota_empate;
            payload.cuota_visita = cuotas.cuota_visita;
          }
          if ((partido.cuotas_comparativa == null || necesitaRefrescoUrgente) && cuotas.comparativa) {
            payload.cuotas_comparativa = cuotas.comparativa;
          }
          if (necesitaRefrescoUrgente) {
            payload.cuota_refrescada_urgente = true;
          }
        }
      }
      if (Object.keys(payload).length === 0) {
        resultado.sinCuotaTodavia++;
        continue;
      }
      const { error: errUpdate } = await supabase
        .from('desafios_mvp')
        .update(payload)
        .eq('id', partido.id);
      if (errUpdate) {
        resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: errUpdate.message });
      } else {
        resultado.actualizados++;
      }
    } catch (e) {
      resultado.errores.push({ id: partido.id, pregunta: partido.pregunta, error: e.message });
    }
    // Pausa chica entre llamadas para no pasarse de los límites por minuto
    // del plan de API-Football.
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[/cuotas] ${resultado.actualizados} actualizados, ${resultado.sinCuotaTodavia} sin cambios todavía, ${resultado.errores.length} errores, ${resultado.pendientesProximaCorrida} quedan para la próxima corrida.`);
  res.json(resultado);
}

module.exports = { rutaCuotas };
