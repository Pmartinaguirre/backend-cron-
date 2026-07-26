// GET/POST /vivo — pensado para correr cada 1 minuto (igual que en la app
// del Mundial). Busca partidos Cat.4/5 activos, ya arrancados (fecha_expiracion
// <= ahora) y todavía no resueltos, y actualiza minuto/marcador
// parcial/goleadores/estado consultando API-Football. NO paga diamantes ni
// escribe resultado_oficial/goles_*_oficial — eso lo hace /resolver, que
// corre aparte y sí puede ser menos frecuente (cada 5-15 min alcanza).
const { supabase } = require('../supabaseClient');
const { obtenerEstadoFixture } = require('../apiFootball');

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

  // Filtra en memoria (ojo: NO se puede hacer ".neq('estado_partido','FT')"
  // en la consulta de arriba porque en SQL "columna <> 'FT'" excluye las
  // filas con NULL, y los partidos recién activados todavía no tienen
  // estado_partido puesto — quedarían afuera para siempre) los que:
  //  - ya vimos terminados (estado_partido === 'FT'), no vale la pena
  //    seguir gastando consultas en ellos, y
  //  - los que ya están resueltos de verdad (Cat.5: resultado_oficial;
  //    Cat.4: goles_local_oficial) — si /resolver ya los cerró, tampoco
  //    hace falta seguir actualizando su marcador en vivo.
  const pendientes = (partidos || []).filter((p) => {
    if (p.estado_partido === 'FT') return false;
    return Number(p.categoria) === 5 ? !p.resultado_oficial : p.goles_local_oficial == null;
  });

  const resultado = { revisados: pendientes.length, actualizados: 0, errores: [] };

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
    } catch (e) {
      resultado.errores.push({ id: partido.id, error: e.message });
    }
  }

  res.json(resultado);
}

module.exports = { rutaVivo };
