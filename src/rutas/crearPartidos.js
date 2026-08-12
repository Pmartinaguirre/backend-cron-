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

// Nombres de equipo más cortos que el que manda API-Football (a pedido).
// Agregar acá cualquier otro caso parecido ("le sobra un apellido") sin
// tocar el resto del archivo.
const NOMBRES_EQUIPO_OVERRIDE = {
  'Central Cordoba de Santiago': 'Central Cordoba',
  'Central Córdoba de Santiago': 'Central Cordoba',
  'Central Córdoba (SdE)': 'Central Cordoba',
};
function renombrarEquipo(nombre) {
  if (!nombre) return nombre;
  return NOMBRES_EQUIPO_OVERRIDE[nombre] || nombre;
}

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

// Rondas que se filtran por Tier A AUNQUE la competencia esté en modo
// COMPLETA (a pedido: "elimina todos los partidos de la Champions League de
// 3rd Qualifying Round, esta ronda no se trae por default, solo se trae un
// partido de esta ronda si hay algún equipo Tier A que juega esta ronda").
// Motivo: Champions League está en MODO_COMPLETA (ver ligas.js) porque una
// vez que arranca la fase de grupos/liga se quiere completa — pero la
// previa (clasificación) mete decenas de equipos chicos de ligas menores
// que nadie va a pronosticar, mezclados en la MISMA competencia. Reutiliza
// la lista Tier A de Champions League que ya carga el admin para marcar
// "Destacados" en el resto del torneo (mismo panel ⭐ Equipos Tier A).
const RONDAS_FORZAR_TIER_A = [
  '3rd qualifying round',
];
function esRondaForzadaTierA(nombreRonda) {
  const texto = String(nombreRonda || '').toLowerCase();
  return RONDAS_FORZAR_TIER_A.some((k) => texto.includes(k));
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
  // apiKeyUsada: solo los últimos 4 caracteres de la key que está usando
  // ESTE deploy en Render, para poder comparar a simple vista contra la key
  // que ves en el dashboard de API-Football/Render sin pegar la key entera
  // en un chat — diagnóstico de "por qué mi curl manual trae 380 partidos y
  // el server trae 0 con la misma consulta exacta".
  const claveApi = process.env.API_FOOTBALL_KEY || '';
  const resultadoGeneral = {
    version: 'tier-v3-asimetrico',
    apiKeyUsada: claveApi ? `...${claveApi.slice(-4)} (${claveApi.length} caracteres)` : '(vacía)',
    porLiga: {},
    totalCreados: 0,
    totalFechasCorregidas: 0,
    errores: [],
  };

  for (let indiceLiga = 0; indiceLiga < LIGAS.length; indiceLiga++) {
    const { competencia, leagueId } = LIGAS[indiceLiga];
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
      // Si esto tiene algo, "revisados: 0" NO significa "no hay partidos" —
      // significa que la API respondió con error (rate-limit u otro) y el
      // response vino vacío. Ver nota en obtenerFixturesDeLiga.
      apiErrores: null,
    };

    try {
      // Espaciado entre ligas para no pisar el límite de requests/minuto de
      // API-Football (independiente del cupo diario — confirmado con Pablo:
      // Ultra Plan, 75.000/día, 17% usado, y aun así "Too many requests" a
      // mitad del loop — es un límite de ráfaga, no de cupo). 1.2s de por sí
      // no alcanzó (probablemente por otro cron —/vivo, /cuotas— pegándole
      // a la API al mismo tiempo), así que además de la pausa se agrega
      // reintento: si la liga vuelve con error de rate-limit, espera más y
      // reintenta hasta 2 veces antes de darse por vencida con esa liga.
      if (indiceLiga > 0) {
        await new Promise((r) => setTimeout(r, 1200));
      }
      let fixtures = [];
      let errores = null;
      let resultsApi = null;
      for (let intento = 1; intento <= 3; intento++) {
        const resultado = await obtenerFixturesDeLiga(leagueId, TEMPORADA);
        fixtures = resultado.fixtures;
        errores = resultado.errores;
        resultsApi = resultado.resultsApi;
        const esRateLimit = errores && JSON.stringify(errores).toLowerCase().includes('too many requests');
        if (!esRateLimit) break;
        if (intento < 3) {
          await new Promise((r) => setTimeout(r, 3000 * intento));
        }
      }
      if (errores) {
        resumenLiga.apiErrores = errores;
      }
      resumenLiga.fixturesRecibidosDeLaApi = fixtures.length;
      resumenLiga.resultsApi = resultsApi;
      // Diagnóstico: rango de fechas que USA el servidor para filtrar (para
      // comparar contra las fechas reales de los fixtures a simple vista) +
      // ejemplos de fixtures en estado NS SIN aplicar el filtro de rango, así
      // se ve si el problema es el rango o el status.
      resumenLiga.rangoUsado = { ahora: ahora.toISOString(), limite: limite.toISOString() };
      resumenLiga.ejemplosFixturesNS = fixtures
        .filter((fx) => fx.fixture?.status?.short === 'NS')
        .slice(0, 3)
        .map((fx) => fx.fixture?.date);

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
      // Se trae también `id` y `fecha_expiracion` (antes solo fixture_id_api)
      // — a pedido, bug reportado: "las fechas de la jornada 1 de LALIGA
      // están mal, el Real Madrid no juega el 16 de agosto, juega el 26".
      // CAUSA: este endpoint solo CREA fixtures nuevos — a uno que YA existe
      // lo salta entero (ver "saltadosPorYaExistente" más abajo) sin volver
      // a mirar si API-Football le cambió la fecha desde que se creó (pasa
      // seguido: al principio de temporada la fecha/hora es provisional
      // hasta que la liga confirma el fixture para TV). Y /vivo (el otro
      // lugar que sí reprograma fechas) solo mira partidos cuya fecha
      // GUARDADA ya pasó — un partido movido hacia ADELANTE (como este caso)
      // nunca entra ahí hasta el día de la fecha vieja, y para entonces ya
      // llevaba días mostrando mal en la app. Acá abajo se corrige eso: si
      // la fecha que trae la API para un fixture ya existente no coincide
      // con la guardada, se actualiza en el momento (ver filasActualizarFecha).
      const idsCandidatos = candidatos.map((fx) => fx.fixture.id);
      const { data: yaExistentes, error: errExistentes } = await supabase
        .from('desafios_mvp')
        .select('id, fixture_id_api, fecha_expiracion')
        .in('fixture_id_api', idsCandidatos);
      if (errExistentes) throw errExistentes;
      const existentePorFixtureId = new Map((yaExistentes || []).map((d) => [d.fixture_id_api, d]));
      const idsYaExistentes = new Set(existentePorFixtureId.keys());
      const filasActualizarFecha = [];

      // Diagnóstico: nombres de ronda tal cual los devuelve API-Football
      // para esta liga en este lote — sirve para confirmar si el texto real
      // calza con KEYWORDS_KNOCKOUT (ej. "Round of 16" vs "Octavos de
      // Final") sin tener que adivinar.
      resumenLiga.rondasVistas = Array.from(new Set(candidatos.map((fx) => fx.league?.round).filter(Boolean)));

      const filasNuevas = [];
      for (const fx of candidatos) {
        if (idsYaExistentes.has(fx.fixture.id)) {
          resumenLiga.saltadosPorYaExistente++;
          // Re-sincronizar la fecha (a pedido, ver comentario grande más
          // arriba): compara la fecha que trae LA API ahora contra la que
          // quedó guardada al crear el partido. Margen de 60s (no un
          // igual estricto) para no generar ruido de updates por
          // redondeos de milisegundos entre llamadas.
          const existente = existentePorFixtureId.get(fx.fixture.id);
          const fechaApiMs = new Date(fx.fixture.date).getTime();
          const fechaGuardadaMs = existente?.fecha_expiracion ? new Date(existente.fecha_expiracion).getTime() : null;
          if (existente && Number.isFinite(fechaApiMs) && (fechaGuardadaMs == null || Math.abs(fechaApiMs - fechaGuardadaMs) > 60000)) {
            const fechaISO = new Date(fx.fixture.date).toISOString();
            filasActualizarFecha.push({
              id: existente.id,
              fecha_expiracion: fechaISO,
              subtitulo: subtituloFecha(fechaISO),
              tiempo: tiempoCorto(fechaISO),
              fechaAnterior: existente.fecha_expiracion,
            });
          }
          continue;
        }

        const nombreRonda = fx.league?.round || '';
        // Nombres cortos (a pedido, "llámalo Central Cordoba" — API-Football
        // manda "Central Cordoba de Santiago" para distinguirlo del Central
        // Córdoba de Rosario, pero para la app ese apellido de más solo
        // ensucia la mini tarjeta): NOMBRES_EQUIPO_OVERRIDE se aplica ACÁ,
        // apenas se lee el nombre de API-Football, así que pregunta/
        // opciones/equipo_local/equipo_visitante quedan todos consistentes
        // desde que se crea el partido — no hay que tocar nada más abajo.
        const equipoLocal = renombrarEquipo(fx.teams?.home?.name);
        const equipoVisita = renombrarEquipo(fx.teams?.away?.name);
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
        //
        // EXCEPCIÓN dentro de la excepción (a pedido, ver RONDAS_FORZAR_TIER_A
        // más arriba): 3rd Qualifying Round de Champions League se filtra por
        // Tier A igual, aunque la competencia esté en modo COMPLETA.
        const modo = modoDeCompetencia(competencia);
        const forzarTierA = esRondaForzadaTierA(nombreRonda);
        if (!esFinal && (modo === MODO_TIER_A || forzarTierA)) {
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

      // Aplicar las correcciones de fecha detectadas (ver comentario grande
      // más arriba) — un UPDATE por fila porque cada una cambia a un valor
      // distinto (Supabase no tiene "bulk update con valores por fila" en una
      // sola llamada). Se reportan ejemplos en la respuesta del cron para
      // poder confirmar de un vistazo que de verdad corrigió algo real.
      if (filasActualizarFecha.length > 0) {
        resumenLiga.fechasCorregidas = filasActualizarFecha.length;
        resumenLiga.ejemplosFechasCorregidas = filasActualizarFecha.slice(0, 5).map((f) => ({
          id: f.id, antes: f.fechaAnterior, ahora: f.fecha_expiracion,
        }));
        // En paralelo (Promise.all), no una por una (a pedido, timeout del
        // cron): son updates independientes (cada uno a un `id` distinto), así
        // que esperarlos de a uno en un for...await sumaba un round-trip a
        // Supabase completo por cada fecha corregida — con varias ligas
        // corrigiendo varias fechas a la vez (ej. la primera corrida después
        // de este fix, con toda la Jornada 1 europea reprogramada) eso solo
        // alcanzaba para empujar la corrida entera por encima de los ~30s de
        // timeout que usa cron-job.org. Lanzarlos todos juntos tarda lo que
        // tarda EL MÁS LENTO de ellos, no la suma de todos.
        const resultados = await Promise.all(filasActualizarFecha.map((f) =>
          supabase
            .from('desafios_mvp')
            .update({ fecha_expiracion: f.fecha_expiracion, subtitulo: f.subtitulo, tiempo: f.tiempo })
            .eq('id', f.id)
            .then(({ error }) => ({ f, error }))
        ));
        for (const { f, error: errUpdateFecha } of resultados) {
          if (errUpdateFecha) {
            resultadoGeneral.errores.push({ competencia, error: `No se pudo corregir fecha del partido ${f.id}: ${errUpdateFecha.message}` });
          } else {
            resultadoGeneral.totalFechasCorregidas++;
          }
        }
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
