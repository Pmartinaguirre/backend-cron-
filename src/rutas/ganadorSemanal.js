// GET/POST /ganador-semanal — pensado para correr UNA vez por semana, poco
// después de que cierra la semana (a pedido: "la competencia es por
// semanas, que van de un Martes a Lunes de la semana siguiente. Cuando en
// un grupo se termina una semana, se debe condecorar al jugador que
// resultó primero esa semana con un premio de 'Ganador semanal'").
//
// Sugerencia de horario en cron-job.org: Martes 00:10 (hora Chile) —
// justo después de que cierra la semana anterior (Martes 00:00), con
// margen para que /resolver ya haya pagado los últimos partidos del lunes.
//
// Por cada grupo (sala_privada), suma cuántos diamantes ganó cada
// miembro DURANTE la semana recién cerrada (diamantes_historial_mvp —
// ver agregar_ganador_semanal_y_historial_diamantes.sql), solo contando a
// quien ya era miembro del grupo esa semana (fecha_union), y guarda al
// que más sumó en grupo_ganadores_semanales. Si ya existe un registro para
// ese grupo+semana (unique constraint), no hace nada — así no importa si
// el cron corre más de una vez.
const { supabase } = require('../supabaseClient');

// Mismo anclaje de semana que usa sementomvp.jsx (ANCLA_SEMANA_1) — martes
// 21/jul 2026 00:00 hora Chile. Si cambia allá, hay que cambiarlo acá
// también para que ambos coincidan en qué semana es cada fecha.
const ANCLA_SEMANA_1 = new Date('2026-07-21T04:00:00.000Z').getTime();
const MS_SEMANA = 7 * 24 * 60 * 60 * 1000;
const numeroSemanaDe = (t) => Math.floor((t - ANCLA_SEMANA_1) / MS_SEMANA) + 1;
const rangoDeSemana = (n) => {
  const inicio = ANCLA_SEMANA_1 + (n - 1) * MS_SEMANA;
  return { inicio, fin: inicio + MS_SEMANA };
};

async function rutaGanadorSemanal(req, res) {
  // Semana a calcular: por default, la que acaba de cerrar (la anterior a
  // la actual). ?semana=N para recalcular una puntual a mano.
  const semanaActual = numeroSemanaDe(Date.now());
  const semanaObjetivo = req.query?.semana ? Number(req.query.semana) : semanaActual - 1;
  if (!Number.isFinite(semanaObjetivo) || semanaObjetivo < 1) {
    return res.status(400).json({ error: 'Número de semana inválido.' });
  }
  const { inicio, fin } = rangoDeSemana(semanaObjetivo);

  const { data: grupos, error: errGrupos } = await supabase
    .from('salas_privadas_mvp')
    .select('id, nombre');
  if (errGrupos) {
    return res.status(500).json({ error: errGrupos.message });
  }

  const resultado = { semana: semanaObjetivo, desde: new Date(inicio).toISOString(), hasta: new Date(fin).toISOString(), grupos: [], errores: [] };

  for (const grupo of grupos || []) {
    try {
      // Ya calculado antes para este grupo+semana — no lo repite.
      const { data: yaExiste } = await supabase
        .from('grupo_ganadores_semanales')
        .select('id')
        .eq('sala_id', grupo.id)
        .eq('numero_semana', semanaObjetivo)
        .maybeSingle();
      if (yaExiste) {
        resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, yaCalculado: true });
        continue;
      }

      // Miembros que YA estaban en el grupo antes de que cerrara la semana
      // (fecha_union <= fin de la semana) — si alguien entró a mitad o
      // después, esa semana no le cuenta para el premio en este grupo.
      const { data: miembros } = await supabase
        .from('salas_privadas_miembros_mvp')
        .select('usuario_id, fecha_union')
        .eq('sala_id', grupo.id);
      const idsElegibles = (miembros || [])
        .filter((m) => !m.fecha_union || new Date(m.fecha_union).getTime() < fin)
        .map((m) => m.usuario_id);
      if (idsElegibles.length === 0) {
        resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, sinMiembrosElegibles: true });
        continue;
      }

      const { data: historial, error: errHist } = await supabase
        .from('diamantes_historial_mvp')
        .select('usuario_id, monto, fecha_creacion')
        .in('usuario_id', idsElegibles)
        .gte('fecha_creacion', new Date(inicio).toISOString())
        .lt('fecha_creacion', new Date(fin).toISOString());
      if (errHist) throw errHist;

      const sumaPorUsuario = {};
      (historial || []).forEach((h) => {
        sumaPorUsuario[h.usuario_id] = (sumaPorUsuario[h.usuario_id] || 0) + (h.monto || 0);
      });

      const entradas = Object.entries(sumaPorUsuario);
      if (entradas.length === 0) {
        resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, sinDiamantesEsaSemana: true });
        continue;
      }
      entradas.sort((a, b) => b[1] - a[1]);
      const [usuarioGanadorId, diamantesGanador] = entradas[0];

      const { error: errInsert } = await supabase.from('grupo_ganadores_semanales').insert({
        sala_id: grupo.id,
        numero_semana: semanaObjetivo,
        usuario_id: usuarioGanadorId,
        diamantes_semana: diamantesGanador,
      });
      if (errInsert) throw errInsert;

      resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, ganador: usuarioGanadorId, diamantes: diamantesGanador });
    } catch (e) {
      resultado.errores.push({ sala_id: grupo.id, error: e.message });
    }
  }

  res.json(resultado);
}

module.exports = { rutaGanadorSemanal };
