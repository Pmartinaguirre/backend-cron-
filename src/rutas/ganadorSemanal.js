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

// Misma numeración de semana que usa sementomvp.jsx (ver comentario ahí) —
// una semana futbolera (martes 00:00 Chile a martes siguiente 00:00) se
// numera con el ISO-8601 de su LUNES DE CIERRE, no con un ancla fija. Si
// cambia allá, hay que cambiarlo acá también para que ambos coincidan en
// qué semana es cada fecha. La grilla de martes/lunes en sí (qué fecha
// exacta abre y cierra cada semana) es la misma de siempre — el ancla
// vieja (2026-07-21T04:00:00.000Z, martes 21/jul 00:00 Chile) cae justo en
// esa misma grilla, así que rangoDeSemana(n) sigue devolviendo el rango de
// fechas correcto para records ya guardados con el número viejo.
const MS_SEMANA = 7 * 24 * 60 * 60 * 1000;
const ANCLA_MARTES_GRILLA = new Date('2026-07-21T04:00:00.000Z').getTime(); // cualquier martes de la grilla futbolera sirve de referencia
function numeroSemanaISOde(fechaMediodiaUTC) {
  const dUTC = new Date(fechaMediodiaUTC);
  const diaISO = (dUTC.getUTCDay() + 6) % 7;
  dUTC.setUTCDate(dUTC.getUTCDate() - diaISO + 3);
  const primerJueves = new Date(Date.UTC(dUTC.getUTCFullYear(), 0, 4));
  const diaPrimerJueves = (primerJueves.getUTCDay() + 6) % 7;
  primerJueves.setUTCDate(primerJueves.getUTCDate() - diaPrimerJueves + 3);
  return 1 + Math.round((dUTC - primerJueves) / (7 * 24 * 60 * 60 * 1000));
}
function martesAperturaMasCercano(t) {
  // Redondea `t` hacia abajo al martes de apertura de la grilla futbolera
  // (misma grilla de siempre, alineada con ANCLA_MARTES_GRILLA).
  const semanasDesdeAncla = Math.floor((t - ANCLA_MARTES_GRILLA) / MS_SEMANA);
  return ANCLA_MARTES_GRILLA + semanasDesdeAncla * MS_SEMANA;
}
const numeroSemanaDe = (t) => {
  const inicio = martesAperturaMasCercano(t);
  const lunesCierre = inicio + 6 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000; // mediodía del lunes de cierre
  return numeroSemanaISOde(lunesCierre);
};
const rangoDeSemana = (n) => {
  // Busca, dentro de la grilla ya alineada con ANCLA_MARTES_GRILLA, el
  // martes cuyo número de semana ISO (lunes de cierre) es `n`.
  let inicio = martesAperturaMasCercano(Date.now());
  let intento = numeroSemanaDe(inicio);
  // Ajuste lineal simple (la numeración ISO avanza de a 1 por semana casi
  // siempre, salvo el corte de año — con desplazar semana a semana converge).
  let guardia = 0;
  while (intento !== n && guardia < 60) {
    inicio += (n > intento ? 1 : -1) * MS_SEMANA;
    intento = numeroSemanaDe(inicio);
    guardia++;
  }
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
    .select('id, nombre, competencias, equipos_seguidos');
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
        .select('usuario_id, monto, fecha_creacion, desafio_id')
        .in('usuario_id', idsElegibles)
        .gte('fecha_creacion', new Date(inicio).toISOString())
        .lt('fecha_creacion', new Date(fin).toISOString());
      if (errHist) throw errHist;

      // Mismo filtro por competencia/equipos del grupo que /ranking-grupo
      // (ver nota grande ahí, incluye el fix de "equipos_seguidos" — antes
      // solo miraba `competencias`, así que un grupo que solo sigue equipos
      // sueltos, sin ninguna competencia marcada, caía en "sin restricción,
      // cuenta todo" en vez de filtrar por esos equipos) — si no, el
      // "Ganador semanal" podía salir premiado por diamantes ganados en una
      // liga/partido que ese grupo ni sigue.
      const idsDesafiosReferenciados = [...new Set((historial || []).map((h) => h.desafio_id).filter(Boolean))];
      const desafioPorId = {};
      if (idsDesafiosReferenciados.length > 0) {
        const { data: desafiosRef, error: errDesafiosRef } = await supabase
          .from('desafios_mvp')
          .select('id, tema, equipo_local, equipo_visitante')
          .in('id', idsDesafiosReferenciados);
        if (errDesafiosRef) throw errDesafiosRef;
        (desafiosRef || []).forEach((d) => { desafioPorId[d.id] = d; });
      }
      const competenciasGrupo = grupo.competencias || [];
      const equiposSeguidosGrupo = grupo.equipos_seguidos || [];
      const hayRestriccion = competenciasGrupo.length > 0 || equiposSeguidosGrupo.length > 0;
      const normEquipo = (s) => String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().trim();
      const equiposSeguidosNorm = equiposSeguidosGrupo.map(normEquipo);

      const sumaPorUsuario = {};
      (historial || []).forEach((h) => {
        if (h.desafio_id && hayRestriccion) {
          const d = desafioPorId[h.desafio_id];
          if (d) {
            const temaCalza = d.tema && competenciasGrupo.includes(d.tema);
            const equipoCalza = equiposSeguidosNorm.length > 0 && (
              equiposSeguidosNorm.includes(normEquipo(d.equipo_local)) ||
              equiposSeguidosNorm.includes(normEquipo(d.equipo_visitante))
            );
            if (!temaCalza && !equipoCalza) return;
          }
        }
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
