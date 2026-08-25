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
//
// A pedido: "cuando termina una semana envía un mail a todos los jugadores
// del grupo" con la tabla de esa semana, el ganador+medalla, el anuncio de
// la semana nueva en juego y los partidos para pronosticar — ver
// enviarRecapSemanal() más abajo. El mail es "mejor esfuerzo" (mismo
// criterio que el resto de los mails de hitos en notificaciones.js): si
// falla, se loguea y se sigue, nunca rompe el cálculo del premio.
const { supabase } = require('../supabaseClient');
const { calcularTablaGrupo } = require('./rankingGrupo');
const { enviarMail, plantillaBase, FRONTEND_URL } = require('../emailHelper');

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

const fmtFecha = (t) => new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'long', timeZone: 'America/Santiago' }).format(new Date(t));
const fmtFechaHoraPartido = (iso) => new Intl.DateTimeFormat('es-CL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' }).format(new Date(iso));

// Arma el filtro "¿este partido pertenece a lo que sigue el grupo?" (mismo
// criterio que /ranking-grupo — competencias/equipos_seguidos, con el fix
// de "solo partidos destacados" vía modo_competencias/equipos_tier_a_mvp).
// Extraído a función propia (antes vivía inline más abajo) para poder
// armarlo ANTES de saber si la semana ya está calculada — así, si alguien
// pide reenviar el mail (?reenviar=1) para una semana que el cron ya
// procesó, igual se puede filtrar qué partidos de la semana entrante le
// corresponden a este grupo sin repetir el cálculo del ganador.
async function construirCalzaConGrupo(grupo) {
  const competenciasGrupo = grupo.competencias || [];
  const equiposSeguidosGrupo = grupo.equipos_seguidos || [];
  const hayRestriccion = competenciasGrupo.length > 0 || equiposSeguidosGrupo.length > 0;
  const normEquipo = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
  const equiposSeguidosNorm = equiposSeguidosGrupo.map(normEquipo);
  const modoCompetencias = grupo.modo_competencias || {};
  const competenciasTierA = competenciasGrupo.filter((c) => modoCompetencias[c] === 'tier_a');
  const equiposTierAPorCompetencia = {};
  if (competenciasTierA.length > 0) {
    const { data: tierAData, error: errTierA } = await supabase
      .from('equipos_tier_a_mvp')
      .select('competencia, equipo')
      .in('competencia', competenciasTierA);
    if (errTierA) throw errTierA;
    (tierAData || []).forEach((fila) => {
      if (!equiposTierAPorCompetencia[fila.competencia]) equiposTierAPorCompetencia[fila.competencia] = [];
      equiposTierAPorCompetencia[fila.competencia].push(fila.equipo);
    });
  }
  const esPartidoDestacado = (d) => {
    if (d?.es_destacado) return true;
    const listaTierA = (d?.tema && equiposTierAPorCompetencia[d.tema]) || [];
    if (listaTierA.length === 0) return false;
    const equipos = [d?.equipo_local, d?.equipo_visitante].filter(Boolean).map((e) => e.toLowerCase());
    const fase = String(d?.subtema || '').trim().toLowerCase();
    const coincideEquipo = equipos.some((eq) => listaTierA.some((t) => eq.includes(t.toLowerCase())));
    const coincideFase = fase && listaTierA.some((t) => fase.includes(t.toLowerCase()));
    return coincideEquipo || coincideFase;
  };
  // "No retroactivo" (a pedido: "si yo edito las competencias es para
  // adelante en el tiempo, no retroactivo" — bug reportado: agregar LaLiga
  // a un grupo DESPUÉS de cerrada la semana 35 infló esa semana ya cerrada
  // con diamantes de LaLiga ganados ANTES de agregarla). Mismo criterio
  // que rankingGrupo.js: competencias_fechas guarda desde cuándo cuenta
  // cada competencia AGREGADA (no las que el grupo ya tenía desde el
  // principio, esas quedan sin tope).
  const competenciasFechas = grupo.competencias_fechas || {};
  const fechaValidaParaTema = (tema, fechaComparar) => {
    const desde = competenciasFechas[tema];
    if (!desde || !fechaComparar) return true;
    return new Date(fechaComparar).getTime() >= new Date(desde).getTime();
  };
  const partidoCalzaConGrupo = (d, fechaComparar) => {
    if (!hayRestriccion) return true;
    const temaCalza = d.tema && competenciasGrupo.includes(d.tema)
      && (modoCompetencias[d.tema] !== 'tier_a' || esPartidoDestacado(d))
      && fechaValidaParaTema(d.tema, fechaComparar);
    const equipoCalza = equiposSeguidosNorm.length > 0 && (
      equiposSeguidosNorm.includes(normEquipo(d.equipo_local)) ||
      equiposSeguidosNorm.includes(normEquipo(d.equipo_visitante))
    );
    return temaCalza || equipoCalza;
  };
  return { partidoCalzaConGrupo };
}

// Mail de recap semanal (a pedido): tabla de posiciones de la semana que
// terminó, ganador+medalla, anuncio de la semana que arranca hoy y sus
// partidos para pronosticar, botón "Ir a pronosticar partidos" y un deseo
// de suerte. Se manda a TODOS los miembros del grupo (incluido el admin,
// aunque no tenga fila propia en salas_privadas_miembros_mvp — mismo
// criterio que /ranking-grupo). "Mejor esfuerzo": cualquier error acá se
// loguea y no se propaga, así nunca hace fallar el cálculo del premio.
async function enviarRecapSemanal({
  grupo, semanaObjetivo, rangoObjetivo, semanaSiguiente, rangoSiguiente,
  tablaSemana, ganadorId, diamantesGanador, partidosSemanaEntrante,
}) {
  try {
    const { data: miembrosData } = await supabase
      .from('salas_privadas_miembros_mvp')
      .select('usuario_id')
      .eq('sala_id', grupo.id);
    const idsDestinatarios = new Set((miembrosData || []).map((m) => m.usuario_id));
    if (grupo.admin_id) idsDestinatarios.add(grupo.admin_id);
    if (idsDestinatarios.size === 0) return;

    const { data: usuariosData } = await supabase
      .from('usuarios')
      .select('id, nombre, email')
      .in('id', [...idsDestinatarios]);
    if (!usuariosData || usuariosData.length === 0) return;

    const nombrePorId = {};
    (tablaSemana?.jugadores || []).forEach((j) => { nombrePorId[j.usuarioId] = j.nombre; });

    // Tabla de posiciones DE LA SEMANA que terminó (a pedido: "tabla de
    // posiciones de la semana jugada"), con el ganador resaltado.
    const filasTabla = (tablaSemana?.jugadores || []).map((j) => {
      const esGanador = j.usuarioId === ganadorId;
      return `
        <tr style="${esGanador ? 'background:#ecfdf5;font-weight:bold;' : ''}">
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${j.posicion}º${esGanador ? ' 🏅' : ''}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${j.nombre}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">${j.pj}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">${j.pa}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:#059669;">💎 ${j.diamantesGrupo}</td>
        </tr>`;
    }).join('');
    const tablaHtml = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:10px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:6px 8px;text-align:left;">#</th>
            <th style="padding:6px 8px;text-align:left;">Jugador</th>
            <th style="padding:6px 8px;">PJ</th>
            <th style="padding:6px 8px;">PA</th>
            <th style="padding:6px 8px;text-align:right;">💎</th>
          </tr>
        </thead>
        <tbody>${filasTabla || '<tr><td colspan="5" style="padding:10px;text-align:center;color:#999;">Sin pronósticos esta semana.</td></tr>'}</tbody>
      </table>`;

    // Ganador semanal + medalla (a pedido: "destacar el jugador ganador
    // semanal y su medalla").
    const nombreGanador = ganadorId ? (nombrePorId[ganadorId] || 'un jugador') : null;
    const bloqueGanador = nombreGanador
      ? `<p style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 14px;"><strong>🏅 Ganador de la semana ${semanaObjetivo}:</strong> ${nombreGanador}, con 💎 ${diamantesGanador} diamantes.</p>`
      : `<p style="color:#6b7280;">Nadie sumó diamantes esta semana en el grupo.</p>`;

    // Partidos de la semana entrante (a pedido: "mostrar los partidos que
    // se van a pronosticar en la semana entrante").
    const filasPartidos = (partidosSemanaEntrante || []).slice(0, 10).map((d) => `
      <tr>
        <td style="padding:5px 8px;border-bottom:1px solid #eee;color:#6b7280;font-size:12px;white-space:nowrap;">${fmtFechaHoraPartido(d.fecha_expiracion)}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #eee;font-weight:bold;">${d.equipo_local} vs ${d.equipo_visitante}</td>
      </tr>`).join('');
    const restantes = (partidosSemanaEntrante || []).length - 10;
    const extraPartidos = restantes > 0 ? `<p style="font-size:12px;color:#6b7280;">y ${restantes} partido${restantes === 1 ? '' : 's'} más...</p>` : '';
    const partidosHtml = filasPartidos
      ? `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:10px 0;"><tbody>${filasPartidos}</tbody></table>${extraPartidos}`
      : `<p style="color:#6b7280;">Todavía no hay partidos programados para esta semana — vuelve a mirar más tarde.</p>`;

    const cuerpoComun = `
      <p>La semana ${semanaObjetivo} (${fmtFecha(rangoObjetivo.inicio)} al ${fmtFecha(rangoObjetivo.fin - 1)}) ya terminó en <strong>${grupo.nombre}</strong>. Así quedó la tabla de esa semana:</p>
      ${tablaHtml}
      ${bloqueGanador}
      <p style="margin-top:18px;">🟢 <strong>Ya está en juego la semana ${semanaSiguiente}</strong>, del ${fmtFecha(rangoSiguiente.inicio)} al ${fmtFecha(rangoSiguiente.fin - 1)}.</p>
      <p style="margin-top:10px;font-weight:bold;">Partidos para pronosticar esta semana:</p>
      ${partidosHtml}
      <p style="margin-top:18px;">¡Mucha suerte a todos esta semana! ⚽🍀</p>
    `;

    for (const usuario of usuariosData) {
      if (!usuario.email) continue;
      const html = plantillaBase({
        titulo: `"${grupo.nombre}" — Resumen semana ${semanaObjetivo} y arranca la ${semanaSiguiente}`,
        cuerpoHtml: `<p>Hola ${usuario.nombre || 'jugador'},</p>${cuerpoComun}`,
        botonTexto: 'Ir a pronosticar partidos',
        botonUrl: `${FRONTEND_URL}/sementomvp?tab=futbol&vista=pronostico`,
      });
      await enviarMail({ to: usuario.email, subject: `"${grupo.nombre}": resumen semana ${semanaObjetivo} y arranca la ${semanaSiguiente}`, html });
    }
  } catch (e) {
    console.error('[ganadorSemanal] Error mandando el mail de recap semanal:', e.message);
  }
}

async function rutaGanadorSemanal(req, res) {
  // ?reenviar=1 (a pedido: "cómo hacemos para forzar el envío de este mail
  // ahora" — el push del mail de recap llegó DESPUÉS de que esa semana ya
  // se había calculado a mano, así que el cron normal no manda nada, solo
  // ve yaCalculado y sigue de largo). Con esto, para una semana YA
  // calculada, en vez de saltarla vuelve a mandar el mail de recap usando
  // el ganador que ya está guardado — no vuelve a tocar
  // grupo_ganadores_semanales ni recalcula diamantes, solo reenvía el mail.
  const forzarReenvio = req.query?.reenviar === '1' || req.query?.reenviar === 'true';

  // Semana a calcular: por default, la que acaba de cerrar (la anterior a
  // la actual). ?semana=N para recalcular una puntual a mano.
  const semanaActual = numeroSemanaDe(Date.now());
  const semanaObjetivo = req.query?.semana ? Number(req.query.semana) : semanaActual - 1;
  if (!Number.isFinite(semanaObjetivo) || semanaObjetivo < 1) {
    return res.status(400).json({ error: 'Número de semana inválido.' });
  }
  const { inicio, fin } = rangoDeSemana(semanaObjetivo);

  // Semana que queda EN JUEGO al momento de correr este cron (a pedido:
  // "informar que está en juego la semana 36 a partir de hoy") — se basa
  // en la fecha real de HOY, no en semanaObjetivo+1, para que un
  // recálculo manual de una semana vieja (?semana=N) no anuncie una
  // semana "actual" equivocada en el mail.
  const rangoNuevaSemana = rangoDeSemana(semanaActual);

  // Partidos reales (Cat.4/5, no generales) dentro del rango de la semana
  // que queda en juego — se trae UNA vez para todos los grupos y se
  // filtra por grupo más abajo (competencias/equipos_seguidos/tier_a).
  const { data: partidosSemanaEntranteTodos } = await supabase
    .from('desafios_mvp')
    .select('id, tema, subtema, equipo_local, equipo_visitante, fecha_expiracion, categoria, es_general')
    .gte('fecha_expiracion', new Date(rangoNuevaSemana.inicio).toISOString())
    .lt('fecha_expiracion', new Date(rangoNuevaSemana.fin).toISOString())
    .order('fecha_expiracion', { ascending: true });
  // FIX de duplicados (a pedido: el mail mostraba "Real Madrid vs Malaga" y
  // "Sevilla vs Atletico Madrid" dos veces cada uno — mismo bug conocido de
  // sementomvp.jsx: un mismo partido real puede existir DOS veces en
  // desafios_mvp, uno Cat.4 con marcador exacto y otro Cat.5 solo-LEV. Se
  // dedupica por equipos+día normalizados (no por fixture_id: las copias
  // duplicadas pueden traer fixture_id distinto o vacío).
  const normEqSemanal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const partidosPorClave = {};
  (partidosSemanaEntranteTodos || [])
    .filter((d) => !d.es_general && [4, 5].includes(Number(d.categoria)))
    .forEach((d) => {
      const clave = `${normEqSemanal(d.equipo_local)}|${normEqSemanal(d.equipo_visitante)}|${String(d.fecha_expiracion || '').slice(0, 10)}`;
      if (!partidosPorClave[clave]) partidosPorClave[clave] = d;
    });
  const partidosSemanaEntranteReales = Object.values(partidosPorClave);

  const { data: grupos, error: errGrupos } = await supabase
    .from('salas_privadas_mvp')
    .select('id, nombre, admin_id, competencias, equipos_seguidos, modo_competencias, competencias_fechas');
  if (errGrupos) {
    return res.status(500).json({ error: errGrupos.message });
  }

  const resultado = { semana: semanaObjetivo, desde: new Date(inicio).toISOString(), hasta: new Date(fin).toISOString(), grupos: [], errores: [] };

  for (const grupo of grupos || []) {
    try {
      const { partidoCalzaConGrupo } = await construirCalzaConGrupo(grupo);
      const partidosGrupoSemanaEntrante = partidosSemanaEntranteReales.filter((d) => partidoCalzaConGrupo(d, d.fecha_expiracion));

      // Ya calculado antes para este grupo+semana — no lo repite. Si viene
      // ?reenviar=1, en vez de saltarlo reenvía el mail de recap con el
      // ganador que ya está guardado (sin tocar el cálculo ni el insert).
      const { data: yaExiste } = await supabase
        .from('grupo_ganadores_semanales')
        .select('id, usuario_id, diamantes_semana')
        .eq('sala_id', grupo.id)
        .eq('numero_semana', semanaObjetivo)
        .maybeSingle();
      if (yaExiste) {
        if (forzarReenvio) {
          let tablaSemana = null;
          try {
            tablaSemana = await calcularTablaGrupo(grupo.id, { periodo: 'semana', semana: semanaObjetivo });
          } catch (eTabla) {
            console.error('[ganadorSemanal] No se pudo calcular la tabla de la semana para el reenvío:', eTabla.message);
          }
          await enviarRecapSemanal({
            grupo, semanaObjetivo, rangoObjetivo: { inicio, fin },
            semanaSiguiente: semanaActual, rangoSiguiente: rangoNuevaSemana,
            tablaSemana, ganadorId: yaExiste.usuario_id, diamantesGanador: yaExiste.diamantes_semana,
            partidosSemanaEntrante: partidosGrupoSemanaEntrante,
          });
          resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, yaCalculado: true, mailReenviado: true });
        } else {
          resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, yaCalculado: true });
        }
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
          .select('id, tema, subtema, equipo_local, equipo_visitante, es_destacado')
          .in('id', idsDesafiosReferenciados);
        if (errDesafiosRef) throw errDesafiosRef;
        (desafiosRef || []).forEach((d) => { desafioPorId[d.id] = d; });
      }
      // (competenciasGrupo/tier_a/partidoCalzaConGrupo ya se calcularon más
      // arriba, vía construirCalzaConGrupo, antes de saber si esta semana ya
      // estaba calculada — se reutiliza el mismo `partidoCalzaConGrupo` acá.)

      const sumaPorUsuario = {};
      (historial || []).forEach((h) => {
        if (h.desafio_id) {
          const d = desafioPorId[h.desafio_id];
          if (d && !partidoCalzaConGrupo(d, h.fecha_creacion)) return;
        }
        sumaPorUsuario[h.usuario_id] = (sumaPorUsuario[h.usuario_id] || 0) + (h.monto || 0);
      });

      // Tabla de posiciones DE LA SEMANA que acaba de cerrar (a pedido: mail
      // de recap con "tabla de posiciones de la semana jugada") — mismo
      // cálculo exacto que usa MisGrupos.jsx con el filtro Semana, así el
      // mail y la app siempre muestran el mismo número.
      let tablaSemana = null;
      try {
        tablaSemana = await calcularTablaGrupo(grupo.id, { periodo: 'semana', semana: semanaObjetivo });
      } catch (eTabla) {
        console.error('[ganadorSemanal] No se pudo calcular la tabla de la semana para el mail:', eTabla.message);
      }
      // (partidosGrupoSemanaEntrante ya se calculó más arriba.)

      const entradas = Object.entries(sumaPorUsuario);
      if (entradas.length === 0) {
        resultado.grupos.push({ sala_id: grupo.id, nombre: grupo.nombre, sinDiamantesEsaSemana: true });
        await enviarRecapSemanal({
          grupo, semanaObjetivo, rangoObjetivo: { inicio, fin },
          semanaSiguiente: semanaActual, rangoSiguiente: rangoNuevaSemana,
          tablaSemana, ganadorId: null, diamantesGanador: 0,
          partidosSemanaEntrante: partidosGrupoSemanaEntrante,
        });
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
      await enviarRecapSemanal({
        grupo, semanaObjetivo, rangoObjetivo: { inicio, fin },
        semanaSiguiente: semanaActual, rangoSiguiente: rangoNuevaSemana,
        tablaSemana, ganadorId: usuarioGanadorId, diamantesGanador,
        partidosSemanaEntrante: partidosGrupoSemanaEntrante,
      });
    } catch (e) {
      resultado.errores.push({ sala_id: grupo.id, error: e.message });
    }
  }

  res.json(resultado);
}

module.exports = { rutaGanadorSemanal };
