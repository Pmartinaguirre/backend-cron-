// GET/POST /crear-partidos — crea partidos nuevos solos, según los criterios
// que definiste:
//   1) De cada liga, solo se traen partidos donde AMBOS equipos están en la
//      lista de "Tier A" de esa competencia (tabla equipos_tier_a_mvp, la
//      misma que llenas en el Admin) — no se trae la liga completa.
//   2) EXCEPCIÓN: en instancias finales (octavos/round of 16, cuartos,
//      semifinal, final, playoffs) se traen TODOS los partidos de esa fase,
//      sin filtrar por Tier A. Se detecta solo, mirando el nombre de la
//      fase que entrega la propia API-Football (ver KEYWORDS_KNOCKOUT).
//   3) De cada lote de partidos nuevos que se crean (Tier A + instancias
//      finales incluidas), un ~25% sale al azar como Categoría 4
//      (pronóstico de marcador exacto) — el resto, Categoría 5 (solo LEV).
//
// Mundial 2026 queda AFUERA de este proceso a propósito (ya se cargó
// completo a mano, ver fixtures_mundial.sql).
//
// Dedupe: se identifica qué partidos ya existen por fixture_id_api, así que
// correr este endpoint varias veces no duplica nada — los que ya están se
// saltan. Las cuotas de los partidos recién creados las llena el cron
// /cuotas por separado en su próxima corrida (no hace falta pedirlas acá).
const { supabase } = require('../supabaseClient');
const { obtenerFixturesDeLiga } = require('../apiFootball');
const { esMismoEquipo } = require('../normalizar');
const { subtituloFecha, tiempoCorto } = require('../utilFechas');

// Mismos ids que usa vincular_fixtures.js, más Champions League (2) que no
// estaba en ese mapa viejo. Mundial 2026 (id 1) queda afuera a propósito.
const LIGAS = [
  { competencia: 'Copa Libertadores', leagueId: 13 },
  { competencia: 'Copa Sudamericana', leagueId: 11 },
  { competencia: 'Primera División Argentina', leagueId: 128 },
  { competencia: 'Serie A Italia', leagueId: 135 },
  { competencia: 'LALIGA España', leagueId: 140 },
  { competencia: 'Premier League Inglaterra', leagueId: 39 },
  { competencia: 'Primera División Chile', leagueId: 265 },
  { competencia: 'Ligue 1 Francia', leagueId: 61 },
  { competencia: 'Champions League', leagueId: 2 },
];

const TEMPORADA = process.env.API_FOOTBALL_SEASON || '2026';
// Cuántos días hacia adelante se buscan partidos nuevos. Con esto no hace
// falta la lógica vieja de "activar la próxima fecha a mano": el cron solo
// trae lo que ya está por jugarse pronto, y lo crea directo con
// esta_activo = true.
const DIAS_ANTICIPACION = Number(process.env.DIAS_ANTICIPACION) || 60;
const PROBABILIDAD_CAT4 = 0.25;

// Nombres de fase de API-Football que cuentan como "instancia final" — si
// el texto de la ronda contiene alguna de estas palabras (sin importar
// mayúsculas), se trae el partido completo sin filtrar por Tier A.
const KEYWORDS_KNOCKOUT = [
  'round of', // "Round of 16", "Round of 32"
  'quarter', // "Quarter-finals"
  'semi', // "Semi-finals"
  'final', // "Final", ojo que también calza con "Semi-finals" (correcto: es knockout igual)
  'play-off',
  'playoff',
  '3rd place',
  'third place',
];

function esInstanciaFinal(nombreRonda) {
  const texto = String(nombreRonda || '').toLowerCase();
  return KEYWORDS_KNOCKOUT.some((k) => texto.includes(k));
}

function equipoEnTierA(nombreEquipo, listaTierA) {
  return listaTierA.some((tierA) => esMismoEquipo(tierA, nombreEquipo));
}

async function rutaCrearPartidos(req, res) {
  const ahora = new Date();
  const limite = new Date(ahora.getTime() + DIAS_ANTICIPACION * 24 * 60 * 60 * 1000);

  // Trae TODOS los equipos Tier A de una sola vez y los agrupa por
  // competencia (mismo shape que usa el frontend: { [competencia]: [equipo, ...] }).
  const { data: tierAData, error: errTierA } = await supabase.from('equipos_tier_a_mvp').select('competencia, equipo');
  if (errTierA) {
    console.error('[/crear-partidos] Error leyendo equipos_tier_a_mvp:', errTierA);
    return res.status(500).json({ error: errTierA.message });
  }
  const tierAPorCompetencia = {};
  (tierAData || []).forEach((e) => {
    if (!tierAPorCompetencia[e.competencia]) tierAPorCompetencia[e.competencia] = [];
    tierAPorCompetencia[e.competencia].push(e.equipo);
  });

  const resultadoGeneral = { porLiga: {}, totalCreados: 0, errores: [] };

  for (const { competencia, leagueId } of LIGAS) {
    const listaTierA = tierAPorCompetencia[competencia] || [];
    const resumenLiga = { revisados: 0, creados: 0, saltadosPorTierA: 0 };

    try {
      const fixtures = await obtenerFixturesDeLiga(leagueId, TEMPORADA);

      // Solo fixtures dentro de la ventana de anticipación, todavía no
      // jugados (NS = Not Started).
      const candidatos = fixtures.filter((fx) => {
        const fecha = new Date(fx.fixture?.date);
        return fx.fixture?.status?.short === 'NS' && fecha >= ahora && fecha <= limite;
      });
      resumenLiga.revisados = candidatos.length;
      if (candidatos.length === 0) {
        resultadoGeneral.porLiga[competencia] = resumenLiga;
        continue;
      }

      // Dedupe: qué fixture_id_api de ESTOS candidatos ya existen en la BD.
      const idsCandidatos = candidatos.map((fx) => fx.fixture.id);
      const { data: yaExistentes, error: errExistentes } = await supabase
        .from('desafios_mvp')
        .select('fixture_id_api')
        .in('fixture_id_api', idsCandidatos);
      if (errExistentes) throw errExistentes;
      const idsYaExistentes = new Set((yaExistentes || []).map((d) => d.fixture_id_api));

      const filasNuevas = [];
      for (const fx of candidatos) {
        if (idsYaExistentes.has(fx.fixture.id)) continue;

        const nombreRonda = fx.league?.round || '';
        const equipoLocal = fx.teams?.home?.name;
        const equipoVisita = fx.teams?.away?.name;
        if (!equipoLocal || !equipoVisita) continue;

        const esFinal = esInstanciaFinal(nombreRonda);
        if (!esFinal) {
          // No es instancia final: exige Tier A configurado Y ambos
          // equipos en la lista. Si la competencia no tiene Tier A
          // cargado todavía, no se trae nada de temporada regular (para
          // no traer la liga completa por accidente si se olvidó
          // configurar la lista).
          if (listaTierA.length === 0) {
            resumenLiga.saltadosPorTierA++;
            continue;
          }
          const ambosTierA = equipoEnTierA(equipoLocal, listaTierA) && equipoEnTierA(equipoVisita, listaTierA);
          if (!ambosTierA) {
            resumenLiga.saltadosPorTierA++;
            continue;
          }
        }

        const categoria = Math.random() < PROBABILIDAD_CAT4 ? 4 : 5;
        const fechaISO = new Date(fx.fixture.date).toISOString();

        filasNuevas.push({
          pregunta: `${equipoLocal} vs ${equipoVisita}`,
          subtitulo: subtituloFecha(fechaISO),
          tipo: 'simple',
          categoria,
          tema: competencia,
          subtema: nombreRonda || 'Fecha',
          // Columna jsonb: se pasa el array tal cual (NO stringify) — el
          // cliente de supabase-js ya lo serializa solo para columnas jsonb;
          // stringificarlo a mano lo dejaría guardado como texto plano
          // dentro del jsonb en vez de como array real (mismo problema que
          // si se hiciera con goleadores_local/visita en vivo.js).
          opciones: [`Gana ${equipoLocal}`, 'Empate', `Gana ${equipoVisita}`],
          equipo_local: equipoLocal,
          equipo_visitante: equipoVisita,
          recompensa: 120,
          esta_activo: true,
          tiempo: tiempoCorto(fechaISO),
          fecha_expiracion: fechaISO,
          fixture_id_api: fx.fixture.id,
        });
      }

      if (filasNuevas.length > 0) {
        const { error: errInsert } = await supabase.from('desafios_mvp').insert(filasNuevas);
        if (errInsert) throw errInsert;
        resumenLiga.creados = filasNuevas.length;
        resultadoGeneral.totalCreados += filasNuevas.length;
      }
    } catch (e) {
      console.error(`[/crear-partidos] Error en liga "${competencia}":`, e);
      resultadoGeneral.errores.push({ competencia, error: e.message });
    }

    resultadoGeneral.porLiga[competencia] = resumenLiga;
  }

  console.log('[/crear-partidos]', resultadoGeneral);
  res.json(resultadoGeneral);
}

module.exports = { rutaCrearPartidos };
