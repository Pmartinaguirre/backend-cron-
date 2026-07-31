// GET/POST /crear-partidos — crea partidos nuevos solos, según los criterios
// que definiste:
//   1) Cada competencia tiene un MODO (ver src/ligas.js):
//      - 'completa' → se traen TODOS los partidos de la fecha. Es el caso de
//        la liga chilena, la Libertadores y la Sudamericana: son las que el
//        jugador sigue enteras y no se le puede esconder media fecha.
//      - 'tier_a'   → solo partidos donde AMBOS equipos están en la lista
//        Tier A de esa competencia (tabla equipos_tier_a_mvp, la que llenas
//        en el Admin). Es el caso de las ligas europeas y Argentina, con 18-20
//        partidos por fecha de los que solo un puñado interesa acá.
//   2) EXCEPCIÓN: en instancias finales (octavos/round of 16, cuartos,
//      semifinal, final, playoffs) se traen TODOS los partidos de esa fase,
//      sin filtrar por Tier A, sea cual sea el modo. Se detecta solo, mirando
//      el nombre de la fase que entrega API-Football (ver KEYWORDS_KNOCKOUT).
//   3) CAMBIO IMPORTANTE (a pedido): antes, de cada lote de partidos nuevos
//      que se crean (Tier A + instancias finales incluidas), solo un ~25%
//      salía al azar como Categoría 4 (pronóstico de marcador exacto) — el
//      resto quedaba en Categoría 5 (solo LEV, sin marcador). Eso se
//      eliminó por completo: TODO partido nuevo se crea ahora como
//      Categoría 4, con marcador exacto SIEMPRE disponible. Lo que decide
//      si un grupo particular le pide o no el marcador exacto a sus
//      jugadores para una competencia dada ya no es este sorteo — es la
//      configuración `modo_marcador` que el admin del grupo define en
//      MisGrupos.jsx (mismo patrón que `modo_competencias`/Tier A), leída
//      en tiempo de pantalla por sementomvp.jsx. Este endpoint ya no tiene
//      que saber nada de eso: solo garantiza que el dato (marcador exacto)
//      esté siempre disponible para quien lo quiera pedir.
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
const { LIGAS, TEMPORADA, modoDeCompetencia, MODO_TIER_A } = require('../ligas');

// Cuántos días hacia adelante se buscan partidos nuevos. Con esto no hace
// falta la lógica vieja de "activar la próxima fecha a mano": el cron solo
// trae lo que ya está por jugarse pronto, y lo crea directo con
// esta_activo = true.
//
// SESENTA días (a pedido, antes 7, luego 14, luego 21): con 21 días las
// ligas europeas grandes (Premier, LALIGA, Serie A, Ligue 1) quedaban
// afuera porque su temporada 2026/27 recién arranca el 21 de agosto —
// ningún fixture de fecha 1 en adelante entraba en la ventana. 60 días la
// cubre completa. Las cuotas no son requisito para crear: si el partido no
// tiene cuotas aún, se crea igual (las llena el cron /cuotas aparte, ver
// nota de cabecera del archivo) — así que ampliar la ventana no deja
// partidos "a medias".
//
// OJO: si en Render está definida la variable de entorno DIAS_ANTICIPACION,
// ESA manda por sobre este valor. Si el cambio no se nota, revisa ahí.
const DIAS_ANTICIPACION = Number(process.env.DIAS_ANTICIPACION) || 60;
// PROBABILIDAD_CAT4 se eliminó (a pedido) — todo partido nuevo es ahora
// Categoría 4 siempre, ver nota de cabecera del archivo.

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
  // El día +7 entra COMPLETO, hasta las 23:59:59. Antes el límite era
  // "ahora + 7×24h", que corta a la hora a la que corre el cron: corriendo un
  // martes a las 09:00, un partido del lunes siguiente a las 21:15 quedaba
  // fuera y recién entraba al día siguiente. La regla acordada es "hoy martes
  // ve hasta el lunes entero" — mismo fix inclusive que ya tiene la ventana
  // del frontend (VENTANA_PARTIDOS_DIAS en sementomvp.jsx).
  const limite = new Date(ahora);
  limite.setDate(limite.getDate() + DIAS_ANTICIPACION);
  limite.setHours(23, 59, 59, 999);

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

  // `version` sube a mano con cada cambio de este endpoint. Su única función
  // es poder mirar la respuesta del cron y saber SI EL DEPLOY REALMENTE
  // CORRIÓ: en la depuración del filtro Tier A se perdió tiempo sin poder
  // distinguir "el fix no funciona" de "Render sigue sirviendo el código
  // viejo".
  const resultadoGeneral = { version: 'tier-v3-asimetrico', porLiga: {}, totalCreados: 0, errores: [] };

  for (const { competencia, leagueId } of LIGAS) {
    const listaTierA = tierAPorCompetencia[competencia] || [];
    // saltadosPorYaExistente / saltadosPorEquiposSinDefinir son solo para
    // diagnóstico (por qué un partido "revisado" no terminó ni creado ni
    // saltado por Tier A) — ninguno de los dos bloquea nada, son informativos.
    const resumenLiga = {
      modo: modoDeCompetencia(competencia),
      // Cuántos equipos tiene configurados la lista Tier A de esta liga. Si
      // acá dice 0 en una liga en modo tier_a, TODO se va a saltar y la causa
      // es la lista, no el matcher — este número existe para distinguir esos
      // dos diagnósticos de un vistazo.
      equiposTierAConfigurados: listaTierA.length,
      revisados: 0,
      creados: 0,
      saltadosPorTierA: 0,
      // Los primeros saltados POR NOMBRE, tal como los escribe la API. Para
      // depurar el matcher hay que ver los nombres reales que no calzaron —
      // sin esto, "saltadosPorTierA: 24" obliga a adivinar cuáles fueron.
      ejemplosSaltadosPorTierA: [],
      saltadosPorYaExistente: 0,
      saltadosPorEquiposSinDefinir: 0,
    };

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

      // Diagnóstico: nombres de ronda tal cual los devuelve API-Football
      // para esta liga en este lote — sirve para confirmar si el texto real
      // calza con KEYWORDS_KNOCKOUT (ej. "Round of 16" vs "Octavos de
      // Final") sin tener que adivinar.
      resumenLiga.rondasVistas = Array.from(new Set(candidatos.map((fx) => fx.league?.round).filter(Boolean)));

      const filasNuevas = [];
      for (const fx of candidatos) {
        if (idsYaExistentes.has(fx.fixture.id)) {
          resumenLiga.saltadosPorYaExistente++;
          continue;
        }

        const nombreRonda = fx.league?.round || '';
        const equipoLocal = fx.teams?.home?.name;
        const equipoVisita = fx.teams?.away?.name;
        // En fases eliminatorias sorteadas por resultado (ej. definir rival
        // de Round of 16 según quién gane la fase anterior), API-Football a
        // veces todavía no tiene los dos equipos confirmados — el fixture
        // existe (con fecha) pero sin nombre de equipo. Ahí no hay nada que
        // crear todavía; se vuelve a intentar solo en la próxima corrida.
        if (!equipoLocal || !equipoVisita) {
          resumenLiga.saltadosPorEquiposSinDefinir++;
          continue;
        }

        const esFinal = esInstanciaFinal(nombreRonda);
        // Competencias en modo COMPLETA (liga chilena, Libertadores,
        // Sudamericana): se crean todos los partidos de la fecha, sin filtro
        // de Tier A. Antes esto no existía y por eso faltaba media fecha del
        // campeonato chileno — un Unión La Calera vs Everton no pasaba el
        // filtro y simplemente nunca se creaba, así que la app no tenía cómo
        // mostrarlo.
        //
        // El recorte por Tier A en estas competencias pasa a ser una decisión
        // de cada GRUPO, y filtra lo que se muestra. Para poder ocultar un
        // partido primero hay que tenerlo.
        const modo = modoDeCompetencia(competencia);
        if (!esFinal && modo === MODO_TIER_A) {
          // Si la competencia no tiene Tier A cargado todavía, no se trae
          // nada de temporada regular (para no traer la liga completa por
          // accidente si se olvidó configurar la lista).
          if (listaTierA.length === 0) {
            resumenLiga.saltadosPorTierA++;
            if (resumenLiga.ejemplosSaltadosPorTierA.length < 5) {
              resumenLiga.ejemplosSaltadosPorTierA.push(`${equipoLocal} vs ${equipoVisita} (lista Tier A vacía)`);
            }
            continue;
          }
          // BASTA CON QUE **UNO** DE LOS DOS SEA TIER A.
          //
          // Antes se exigían LOS DOS (&&), y esa era la contradicción que
          // dejaba la liga argentina a medias: la definición de "partido
          // destacado" en toda la app es "juega ALGUNO de los equipos Tier A"
          // (ver esPartidoDestacado en sementomvp.jsx, que usa .some()). El
          // frontend filtraba con esa regla, pero este endpoint creaba con la
          // otra: un San Lorenzo vs Gimnasia (Mendoza) era destacado para la
          // app... sobre un partido que nunca llegó a existir. De 11 partidos
          // Tier A de una semana se creaban solo los 3 en que se cruzaban dos
          // grandes entre sí.
          const algunoTierA = equipoEnTierA(equipoLocal, listaTierA) || equipoEnTierA(equipoVisita, listaTierA);
          if (!algunoTierA) {
            resumenLiga.saltadosPorTierA++;
            if (resumenLiga.ejemplosSaltadosPorTierA.length < 5) {
              resumenLiga.ejemplosSaltadosPorTierA.push(`${equipoLocal} vs ${equipoVisita}`);
            }
            continue;
          }
        }

        // Categoría 4 siempre (a pedido) — ver nota de cabecera. tipo:'doble'
        // es lo que hace que sementomvp.jsx le pida al jugador el marcador
        // exacto como SEGUNDO paso después de elegir L/E/V (ver handleVotar,
        // que decide el paso 2 mirando justo este campo) — con 'simple'
        // quedaba SOLO en L/E/V aunque la categoría dijera "con marcador".
        const categoria = 4;
        const fechaISO = new Date(fx.fixture.date).toISOString();

        filasNuevas.push({
          pregunta: `${equipoLocal} vs ${equipoVisita}`,
          subtitulo: subtituloFecha(fechaISO),
          tipo: 'doble',
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
          // Los IDs de API-Football, además de los nombres. Son los que
          // permiten después pedir la ficha del club y sus últimos
          // resultados: cruzar por nombre no sirve, la API dice
          // "Universidad Catolica" donde la app dice "U. Catolica".
          equipo_local_id: fx.teams?.home?.id ?? null,
          equipo_visita_id: fx.teams?.away?.id ?? null,
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
