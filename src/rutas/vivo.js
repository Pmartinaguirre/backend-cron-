// GET/POST /vivo — pensado para correr cada 1 minuto (igual que en la app
// del Mundial). Busca partidos Cat.4/5 activos, ya arrancados (fecha_expiracion
// <= ahora) y todavía no resueltos, y actualiza minuto/marcador
// parcial/goleadores/estado consultando API-Football. NO paga diamantes ni
// escribe resultado_oficial/goles_*_oficial — eso lo hace /resolver, que
// corre aparte y sí puede ser menos frecuente (cada 5-15 min alcanza).
const { supabase } = require('../supabaseClient');
const { obtenerEstadoFixture } = require('../apiFootball');
const { filtrarPendientes, partidosAbandonados } = require('../partidosPendientes');

async function rutaVivo(req, res) {
  const ahoraISO = new Date().toISOString();

  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select('id, categoria, fixture_id_api, resultado_oficial, goles_local_oficial, fecha_expiracion, estado_partido')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('fixture_id_api', 'is', null)
    .lte('fecha_expiracion', ahoraISO);

  if (error) {
    console.error('[/vivo] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  // El criterio de "a quién todavía vale la pena preguntarle" vive en
  // src/partidosPendientes.js, compartido con /resolver — ver ahí el detalle
  // de por qué un partido postergado se quedaba consultando para siempre.
  const pendientes = filtrarPendientes(partidos);
  const abandonados = partidosAbandonados(partidos);

  const resultado = {
    revisados: pendientes.length,
    actualizados: 0,
    // Se reportan en la respuesta del cron para que un partido mal vinculado
    // no desaparezca en silencio: si esta lista crece, hay algo que revisar
    // a mano en el Admin.
    abandonados,
    errores: [],
  };

  for (const partido of pendientes) {
    try {
      const estado = await obtenerEstadoFixture(partido.fixture_id_api);
      if (!estado) continue;

      const cambios = {
        minuto_partido: estado.minuto,
        minuto_extra: estado.minutoExtra,
        marcador_parcial_local: estado.golesLocal,
        marcador_parcial_visita: estado.golesVisita,
        estado_partido: estado.estado,
        goleadores_local: estado.goleadoresLocal,
        goleadores_visita: estado.goleadoresVisita,
        // Tanda de penales (a pedido): null hasta que arranca la definición,
        // así que solo se pisa el valor guardado cuando la API ya trae algo
        // — si se guardara siempre (incluso null), un partido que ya venía
        // con penales cargados podría "perderlos" en una corrida rara donde
        // la API devuelva null por un instante.
        ...(estado.penalesLocal != null ? { penales_local: estado.penalesLocal } : {}),
        ...(estado.penalesVisita != null ? { penales_visita: estado.penalesVisita } : {}),
      };

      // PARTIDO REPROGRAMADO: cuando se posterga (PST) o se suspende, la
      // API le pone al MISMO fixture una fecha nueva. Sin esto, el partido
      // quedaba clavado para siempre en "En vivo": su fecha_expiracion vieja
      // ya pasó (así que no vuelve a "Partidos"), pero nunca llega a FT
      // (así que /resolver tampoco lo cierra). Al copiar la fecha nueva, el
      // partido vuelve solo a la lista de "por jugar" con su horario
      // corregido y se puede pronosticar de nuevo.
      const ESTADOS_NO_JUGADO = ['PST', 'SUSP', 'CANC', 'ABD', 'TBD', 'NS'];
      if (ESTADOS_NO_JUGADO.includes(estado.estado) && estado.fechaISO) {
        const fechaNueva = new Date(estado.fechaISO);
        const fechaActual = partido.fecha_expiracion ? new Date(partido.fecha_expiracion) : null;
        // Solo si de verdad se movió hacia adelante (evita reescribir la
        // misma fecha en cada corrida del cron).
        const esFuturo = fechaNueva.getTime() > Date.now();
        const cambio = !fechaActual || Math.abs(fechaNueva.getTime() - fechaActual.getTime()) > 60000;
        if (esFuturo && cambio) {
          cambios.fecha_expiracion = fechaNueva.toISOString();
          console.log(`[/vivo] Partido ${partido.id} reprogramado (${estado.estado}) para ${fechaNueva.toISOString()}`);
        }
      }

      const { error: errUpdate } = await supabase
        .from('desafios_mvp')
        .update(cambios)
        .eq('id', partido.id);

      if (errUpdate) {
        resultado.errores.push({ id: partido.id, error: errUpdate.message });
      } else {
        resultado.actualizados++;
      }

      // MOMENTUM (a pedido): guardar un snapshot de las estadísticas de este
      // instante, con su minuto — la serie completa de snapshots de un
      // partido es lo que después arma el gráfico de "quién domina" (ver
      // momentum_partido_mvp / crear_tabla_momentum.sql). Solo si hay algo
      // que guardar (antes del pitazo inicial estadisticas viene vacío) y
      // solo mientras el partido está EN JUEGO (no tiene sentido seguir
      // sumando snapshots idénticos durante HT, o después de FT).
      const ESTADOS_EN_JUEGO = ['1H', '2H', 'ET', 'P', 'BT'];
      if ((estado.estadisticas || []).length > 0 && ESTADOS_EN_JUEGO.includes(estado.estado)) {
        const { error: errMomentum } = await supabase.from('momentum_partido_mvp').insert({
          desafio_id: partido.id,
          minuto: estado.minuto,
          minuto_extra: estado.minutoExtra,
          marcador_local: estado.golesLocal,
          marcador_visita: estado.golesVisita,
          estadisticas: estado.estadisticas,
        });
        if (errMomentum) {
          console.error(`[/vivo] Error guardando snapshot de momentum ${partido.id}:`, errMomentum.message);
        }
      }
    } catch (e) {
      resultado.errores.push({ id: partido.id, error: e.message });
    }
  }

  res.json(resultado);
}

module.exports = { rutaVivo };
