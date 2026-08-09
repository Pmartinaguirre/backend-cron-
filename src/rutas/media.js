// GET/POST /media — pestaña "Media" (a pedido, mockup sofascore): busca
// AUTOMÁTICO en YouTube el resumen de cada partido ya terminado, y guarda el
// link en desafios_mvp.media_video_url. Cada competencia tiene su propia
// FUENTE (canal oficial de YouTube donde de verdad sube resúmenes) — ver
// FUENTES más abajo. Competencias que no están en ninguna fuente simplemente
// no se buscan acá (la pestaña Media igual se muestra en la app para
// cualquier partido, a pedido — sin video automático, el admin lo puede
// pegar a mano desde ModuloMediaPartido).
//
// Requiere la env var YOUTUBE_API_KEY (YouTube Data API v3, se saca gratis
// en Google Cloud Console — activar "YouTube Data API v3" y generar una API
// key). Sin esa key, esta ruta no hace nada (log y responde igual, no
// revienta el cron).
//
// "media_video_corregido" (a pedido: "yo pueda corregirlo si está mal
// subido") — si Pablo pega un link a mano desde la app (ver
// ModuloMediaPartido en sementomvp.jsx), esa fila queda con
// media_video_corregido=true y esta búsqueda automática NUNCA la vuelve a
// tocar, para no pisarle la corrección.
const { supabase } = require('../supabaseClient');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || null;

// Una fuente = un canal de YouTube que sube resúmenes de una o más
// competencias. Se agrega acá la que corresponda a cada liga nueva (a
// pedido: "los videos del fútbol argentino quedan en la página de la Liga
// Profesional de Fútbol de la AFA, podemos hacer lo mismo que con TNT
// Sports?").
//
// DOS FUENTES PARA ARGENTINA (a pedido: "ESPN Fans sube más rápido los
// resúmenes"): cada partido de Primera Argentina ahora se busca en LAS DOS
// — cada una guarda su link en su propia columna (`campo`), así ninguna le
// pisa el video a la otra. `prioridad` (1 = más alta) es la que usa el
// frontend para decidir cuál mostrar primero en la pestaña Media y cuál va
// solo en el Resumen (ver ModuloMediaPartido en sementomvp.jsx) — acá en el
// backend no se usa para nada, cada fuente simplemente busca y guarda.
const FUENTES = [
  {
    nombre: 'TNT Sports Chile',
    channelId: 'UChCovZlgNh2x6Z57MJ5fhFw',
    // Las 3 competencias chilenas (Copa Chile y Copa de la Liga se sumaron
    // después de la Primera División — TNT Sports Chile también sube
    // resúmenes de las copas nacionales, no solo del torneo local).
    competencias: ['Primera División Chile', 'Copa Chile', 'Copa de la Liga'],
    campo: 'media_video_url',
    prioridad: 1,
  },
  {
    nombre: 'Liga Profesional de Fútbol de la AFA',
    channelId: 'UCJmCVoUfCBQb9lcfXIS8nXQ', // @LigaProfesional
    competencias: ['Primera División Argentina'],
    campo: 'media_video_url',
    prioridad: 1,
  },
  {
    nombre: 'ESPN Fans',
    // Sin channelId fijo a mano (a diferencia de las otras dos fuentes): no
    // se pudo confirmar el UC... exacto del canal @ESPNFans desde acá, así
    // que se resuelve UNA vez por corrida via channels.list?forHandle= (ver
    // resolverChannelId más abajo) y se cachea en memoria — mismo criterio
    // de "una sola llamada extra por corrida, no por partido" que ya usa
    // traerUploadsRecientes.
    handle: '@ESPNFans',
    competencias: ['Primera División Argentina'],
    campo: 'media_video_url_espn',
    prioridad: 2,
  },
];
// Índice competencia -> LISTA de fuentes (a pedido: Argentina ahora tiene
// dos). Antes era una fuente por competencia; con las dos de Argentina, se
// recorren TODAS las que apliquen y cada una busca/guarda en su propio
// campo.
const FUENTES_POR_COMPETENCIA = {};
FUENTES.forEach((f) => f.competencias.forEach((c) => {
  if (!FUENTES_POR_COMPETENCIA[c]) FUENTES_POR_COMPETENCIA[c] = [];
  FUENTES_POR_COMPETENCIA[c].push(f);
}));
const TODAS_LAS_COMPETENCIAS_CON_FUENTE = Object.keys(FUENTES_POR_COMPETENCIA);

// Resuelve el channelId de una fuente que solo tiene `handle` (ESPN Fans),
// cacheado en la propia fuente para no volver a pedirlo en cada partido ni
// en cada corrida (mutación intencional del objeto de FUENTES — vive
// mientras el proceso de Node esté arriba, se vuelve a pedir en el próximo
// deploy/restart, que es exactamente lo que se quiere).
async function resolverChannelId(fuente) {
  if (fuente.channelId) return fuente.channelId;
  if (!fuente.handle) return null;
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(fuente.handle)}&key=${YOUTUBE_API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  const id = data?.items?.[0]?.id || null;
  if (data.error) {
    console.error(`[/media] Error resolviendo channelId de ${fuente.handle}:`, data.error.message);
  }
  if (id) fuente.channelId = id; // cache en memoria para el resto de esta corrida (y las siguientes, mientras el proceso siga arriba)
  return id;
}

// No busca partidos de hace más de esto (a pedido implícito: no tiene
// sentido seguir gastando cuota de YouTube en partidos viejos que la fuente
// nunca subió, o que Pablo directamente no va a revisar).
const DIAS_VENTANA_MEDIA = Number(process.env.DIAS_VENTANA_MEDIA) || 10;

// Entidades HTML que manda la API de YouTube en snippet.title (a pedido,
// bug encontrado: "O'Higgins" llega como "O&#39;Higgins" — con el apóstrofe
// codificado — así que nunca calzaba contra el nombre normal del equipo).
// Solo las que de verdad pueden aparecer en nombres de club/competencia;
// no hace falta una librería de decodificado completa para esto.
function decodificarEntidadesHtml(txt) {
  return String(txt || '')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Normaliza nombres para comparar contra el título del video de YouTube
// (saca tildes/mayúsculas/espacios de más) — mismo criterio liviano que se
// usa en otras partes del frontend para comparar nombres de equipo.
// BUG encontrado (a pedido, diagnóstico Liga Profesional Argentina: "Newells
// Old Boys" en la base vs "NEWELL'S" en el título de YouTube — el apóstrofe
// hacía que nunca calzaran, ni siquiera por palabra significativa, porque
// "newells" no es substring de "newell's"). Se saca cualquier apóstrofe acá
// (no solo el decodificado de &#39; — YouTube también manda el carácter
// literal ' en texto plano), así "newell's" y "newells" quedan iguales.
function normalizar(txt) {
  return decodificarEntidadesHtml(txt)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’´`]/g, '')
    .toLowerCase().trim();
}

// Palabras "conectoras" que aparecen en un montón de nombres de club
// chilenos y no sirven para identificar a NINGUNO en particular — si se
// usaran como apodo corto, "Everton de Viña" matchearía por "vina" en vez
// de por "everton" (el nombre real que usa TNT Sports), y "Unión San
// Felipe" o "Deportes Iquique" chocarían entre sí por "union"/"deportes".
const PALABRAS_CONECTORAS = new Set([
  'de', 'del', 'la', 'las', 'los', 'san', 'santa', 'santo',
  'union', 'unión', 'deportes', 'deportivo', 'club', 'cd', 'cf',
]);

// Palabras significativas del nombre (a pedido, diagnóstico: "0
// encontrados" con la búsqueda funcionando bien apuntaba a que el título de
// YouTube usa el nombre CORTO del equipo — "Wanderers" en vez de "Santiago
// Wanderers", o directo "Everton" en vez de "Everton de Viña" — y el match
// exigía el nombre completo adentro del título). En vez de asumir que
// SIEMPRE es la última palabra (fallaba con "Everton de Viña" -> tomaba
// "viña"), se prueban TODAS las palabras de 4+ letras que no sean
// conectoras — cualquiera de ellas que aparezca en el título cuenta.
function palabrasSignificativas(nombre) {
  const palabras = normalizar(nombre).split(/\s+/).filter(Boolean);
  const sinConectoras = palabras.filter((p) => p.length >= 4 && !PALABRAS_CONECTORAS.has(p));
  // BUG encontrado (a pedido, diagnóstico Liga Profesional Argentina: "Union
  // Santa Fe" nunca matcheaba): "Unión", "Santa" son conectoras (correcto
  // para casos como "Unión San Felipe" o "Everton de Viña", donde esas
  // palabras NO identifican al club), pero acá son literalmente EL NOMBRE
  // del club — filtrarlas dejaba la lista vacía y un `.some()` sobre []
  // siempre da false, así que ese equipo nunca podía matchear nada. Si
  // filtrar conectoras deja la lista vacía, se usa la lista sin filtrar
  // (mejor arriesgarse a una palabra genérica que garantizar cero matches).
  return sinConectoras.length > 0 ? sinConectoras : palabras.filter((p) => p.length >= 3);
}

// BUG encontrado (a pedido: "en la Liga Profesional Argentina encontró 4 de
// 16, si yo busco directo en YouTube lo encuentro inmediato"): antes se
// usaba /search?q=equipoLocal+equipoVisitante+resumen contra el canal. El
// buscador de YouTube filtra por relevancia de TEXTO COMPLETO — nuestra
// query mandaba el nombre completo de la base ("Talleres Cordoba Velez
// Sarsfield resumen"), pero el video real se titula "TALLERES 1 - 3 VÉLEZ",
// sin "Cordoba" ni "Sarsfield" en ningún lado (ni título ni descripción). Al
// no calzar esas palabras extra, YouTube devolvía CERO resultados (no un
// resultado con el nombre mal escrito: directamente ninguno), aunque el
// video estuviera publicado. /search también cuesta 100 unidades de cuota
// por llamada (cara).
// Arreglo: en vez de pedirle a YouTube que "adivine" con una query de texto,
// se trae la lista de subidas recientes del canal (uploadsPlaylist, barato:
// 1 unidad) y la comparación de nombres se hace ACÁ, con la misma lógica que
// ya funciona bien (nombre completo primero, después palabra significativa
// de cada equipo) — así no importa qué palabras extra tenga el nombre en la
// base, ni cómo haya rankeado YouTube la relevancia.
// 150 uploads (3 llamadas de a 50, ~3 unidades de cuota — carísimo comparado
// con 1, pero regalado comparado con las 100 unidades que costaba UNA sola
// llamada a /search): estos canales suben mucho más que resúmenes de
// partidos (vivo, highlights, conferencias), así que hay que traer bastante
// margen para que la ventana de DIAS_VENTANA_MEDIA (10 días) esté cubierta.
async function traerUploadsRecientes(channelId, maxResults = 150) {
  // Convención estable de YouTube: la playlist de "todo lo subido" por un
  // canal tiene el mismo ID que el canal, cambiando el prefijo "UC" por
  // "UU". No hace falta pedir el channels.list para sacarla.
  const uploadsPlaylistId = channelId.replace(/^UC/, 'UU');
  const videos = [];
  let pageToken = '';
  while (videos.length < maxResults) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}&key=${YOUTUBE_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) {
      console.error('[/media] Error trayendo uploads del canal:', data.error.message);
      return { videos, errorApi: data.error.message };
    }
    const items = data.items || [];
    items.forEach((it) => {
      videos.push({
        videoId: it.snippet?.resourceId?.videoId || null,
        titulo: decodificarEntidadesHtml(it.snippet?.title) || '(sin título)',
        publicadoEn: it.snippet?.publishedAt || null,
      });
    });
    if (!data.nextPageToken || items.length === 0) break;
    pageToken = data.nextPageToken;
  }
  return { videos };
}

// Videos de categorías/ramas que NO son la Primera División (a pedido, bug
// encontrado: "Vélez vs Talleres" trajo el resumen de Reserva/Proyección de
// esos mismos clubes, con marcador 0-1, en vez del de Primera con el 1-3
// real) — se descartan de entrada, ni siquiera entran a la comparación de
// nombres, porque casi nunca es lo que se quiere.
const PALABRAS_EXCLUYEN_VIDEO = /reserva|proyecci[oó]n|sub\s?-?\d{1,2}\b|femenin|juvenil/i;

// Saca el marcador (dos números separados por guion) de un título de video,
// tipo "VÉLEZ 2 - 1 TALLERES" -> [2, 1]. Sirve para descartar un candidato
// cuyo nombre matchea pero el marcador NO corresponde al resultado real ya
// cargado (mismo bug de Reserva/Proyección: nombre igual, división distinta,
// marcador distinto).
function extraerMarcadorDeTitulo(titulo) {
  const m = String(titulo || '').match(/(\d{1,2})\s*[-–—:]\s*(\d{1,2})/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

// TABLA DE ALIAS POR EQUIPO (a pedido, "los patrones de los títulos son
// similares y sabemos el canal... te puedo dar el patrón exacto"): cada canal
// tiene un apodo FIJO por equipo, casi siempre distinto del nombre completo
// que guardamos en la base (ej.: "Independ. Rivadavia" en la base, pero el
// canal siempre lo titula "IND. RIVADAVIA"). El método viejo (por palabras
// significativas del nombre completo) fallaba justo en estos casos: el
// título nunca tiene la palabra completa, tiene la abreviatura del canal.
// Armada a mano revisando videos reales de cada canal (título → equipo) —
// ver conversación con Pablo. Los pares marcados "sin confirmar" en el chat
// quedan afuera de esta tabla a propósito: si un equipo no está acá, cae al
// método viejo (palabras significativas), no se rompe nada, solo no se
// beneficia de la búsqueda directa hasta que se confirme su apodo real.
//
// Clave = equipo_local/equipo_visitante TAL CUAL está en desafios_mvp.
// Valor = lista de apodos posibles que ese canal usó alguna vez (a veces un
// mismo equipo aparece con más de un apodo entre distintos videos).
const ALIASES_POR_EQUIPO = {
  // ---- Liga Profesional de Fútbol de la AFA (Primera División Argentina) ----
  'Boca Juniors': ['Boca'],
  'River Plate': ['River'],
  'Racing Club': ['Racing'],
  'Independiente': ['Independiente'],
  'San Lorenzo': ['San Lorenzo'],
  'Huracan': ['Huracán'],
  'Velez Sarsfield': ['Vélez'],
  'Argentinos JRS': ['Argentinos'],
  'Talleres Cordoba': ['Talleres'],
  'Belgrano Cordoba': ['Belgrano'],
  'Instituto Cordoba': ['Instituto'],
  'Central Cordoba de Santiago': ['Central Córdoba'],
  'Rosario Central': ['Rosario Central'],
  'Newells Old Boys': ["Newell's", 'Newells'],
  'Union Santa Fe': ['Unión'],
  // "Estudiantes" a secas choca con "Estudiantes (RC)" de Río Cuarto (ver
  // exclusión en aliasApareceEnTitulo más abajo).
  'Estudiantes L.P.': ['Estudiantes'],
  'Gimnasia L.P.': ['Gimnasia'],
  'Platense': ['Platense'],
  'Banfield': ['Banfield'],
  'Lanus': ['Lanús'],
  'Tigre': ['Tigre'],
  'Barracas Central': ['Barracas Central'],
  'Defensa Y Justicia': ['Defensa y Justicia', 'Defensa'],
  'Sarmiento Junin': ['Sarmiento'],
  'Atletico Tucuman': ['Atl. Tucumán', 'Atlético Tucumán'],
  'Independ. Rivadavia': ['Ind. Rivadavia', 'Independiente Rivadavia'],
  'Deportivo Riestra': ['Deportivo Riestra'],
  'Estudiantes de Rio Cuarto': ['Estudiantes (RC)'],
  'Aldosivi': ['Aldosivi'],
  // 'Gimnasia M.' queda sin alias a propósito (sin confirmar cómo lo titula
  // el canal, y choca con "Gimnasia" de Gimnasia L.P.) — cae al método viejo.

  // ---- TNT Sports Chile (Primera Chile / Copa Chile / Copa de la Liga) ----
  'Colo Colo': ['Colo-Colo', 'Colo Colo'],
  'Universidad de Chile': ['Universidad de Chile', 'U. de Chile'],
  'U. Catolica': ['U. Católica'],
  "O'Higgins": ["O'Higgins"],
  'Palestino': ['Palestino'],
  'Union Espanola': ['U. Española'],
  'Nublense': ['Ñublense'],
  'A. Italiano': ['A. Italiano', 'Audax Italiano'],
  'Cobresal': ['Cobresal'],
  'Coquimbo Unido': ['Coquimbo Unido'],
  'Concepción': ['Deportes Concepción', 'Concepción'],
  'Universidad de Concepcion': ['U. de Concepción', 'Universidad de Concepción'],
  'D. La Serena': ['D. La Serena', 'Deportes La Serena'],
  'Huachipato': ['Huachipato'],
  'Everton de Vina': ['Everton'],
  'Santiago Wanderers': ['S. Wanderers'],
  'Union La Calera': ['Unión La Calera', 'U. La Calera'],
  'Deportes Limache': ['Limache', 'Deportes Limache'],
  'Deportes Iquique': ['Iquique', 'Deportes Iquique'],
  'Union San Felipe': ['U. San Felipe', 'Unión San Felipe'],
  'San Marcos de Arica': ['San Marcos de Arica'],
  'Deportes Recoleta': ['Dep. Recoleta'],
  'Deportes Santa Cruz': ['D. Santa Cruz'],
  'Deportes Puerto Montt': ['D. Puerto Montt'],
  'Deportes Antofagasta': ['Dep. Antofagasta'],
};

// Un alias aparece en el título si calza como palabra/frase completa (no
// como pedazo suelto de otra palabra). BUG evitado a propósito acá: el alias
// "Estudiantes" (de Estudiantes L.P.) es substring literal de "ESTUDIANTES
// (RC)" (de Estudiantes de Río Cuarto) — sin este chequeo, un partido de
// Estudiantes L.P. podría "encontrar" por accidente el video de Estudiantes
// de Río Cuarto. Se excluye la coincidencia de "estudiantes" cuando el
// título trae el calificador "(rc)" pegado al lado.
function aliasApareceEnTitulo(alias, tituloNormalizado) {
  const na = normalizar(alias);
  if (!na) return false;
  const re = new RegExp(`\\b${na.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  if (!re.test(tituloNormalizado)) return false;
  if (na === 'estudiantes' && /estudiantes\s*\(\s*rc\s*\)/.test(tituloNormalizado)) return false;
  return true;
}

// Busca por la tabla de alias (a pedido, primera opción antes que el método
// viejo de palabras significativas): mucho más preciso porque compara contra
// el apodo REAL que usa el canal, no contra el nombre completo de la base.
// Devuelve null (no undefined) si algún equipo del partido no está en la
// tabla — así el llamador sabe que tiene que caer al método viejo.
function buscarPorAlias(equipoLocal, equipoVisitante, candidatosVideos, marcadorCoincide) {
  const aliasesLocal = ALIASES_POR_EQUIPO[equipoLocal];
  const aliasesVisita = ALIASES_POR_EQUIPO[equipoVisitante];
  if (!aliasesLocal || !aliasesVisita) return null;
  return candidatosVideos.find((v) => {
    const titulo = normalizar(v.titulo);
    const tieneLocal = aliasesLocal.some((a) => aliasApareceEnTitulo(a, titulo));
    const tieneVisita = aliasesVisita.some((a) => aliasApareceEnTitulo(a, titulo));
    return tieneLocal && tieneVisita && marcadorCoincide(v.titulo);
  }) || null;
}

// Busca el resumen de UN partido adentro de la lista de uploads YA TRAÍDA
// del canal (ver traerUploadsRecientes) — sin pega la red por partido.
// golesOficiales: [golesLocal, golesVisitante] si el partido es Cat.4 y ya
// tiene marcador exacto cargado — se usa para verificar que el video
// encontrado sea DE VERDAD ese partido (ver PALABRAS_EXCLUYEN_VIDEO y bug de
// Reserva/Proyección más arriba). null si es Cat.5 o todavía no hay marcador
// (en ese caso no se puede verificar por marcador, solo por nombre).
function buscarVideoResumenEnLista(equipoLocal, equipoVisitante, fechaPartidoISO, videos, golesOficiales = null) {
  const fechaValida = fechaPartidoISO ? new Date(fechaPartidoISO) : null;
  // Solo videos publicados DESPUÉS del partido (con 3hs de margen para
  // partidos que ya estaban en tiempo de descuento cuando se guardó la
  // fecha) — evita que un resumen viejo de otro cruce entre los mismos dos
  // equipos, de una fecha anterior del campeonato, se cuele como si fuera
  // el de este partido.
  const desde = fechaValida && !isNaN(fechaValida.getTime()) ? fechaValida.getTime() - 3 * 3600 * 1000 : null;
  const candidatosVideos = (desde
    ? videos.filter((v) => !v.publicadoEn || new Date(v.publicadoEn).getTime() >= desde)
    : videos
  ).filter((v) => !PALABRAS_EXCLUYEN_VIDEO.test(v.titulo));
  const candidatos = candidatosVideos.map((v) => v.titulo);

  const nl = normalizar(equipoLocal);
  const nv = normalizar(equipoVisitante);
  const palabrasLocal = palabrasSignificativas(equipoLocal);
  const palabrasVisita = palabrasSignificativas(equipoVisitante);

  // Si hay marcador oficial cargado, el título tiene que traer ESE marcador
  // (como conjunto, sin importar el orden en que aparezcan los equipos) —
  // así se descarta un video con nombre parecido pero de otra categoría/
  // división (bug de Reserva/Proyección: mismo nombre de club, marcador
  // distinto). Si el título no trae ningún marcador reconocible, no se
  // descarta (mejor no perder el video por no poder leerle el marcador).
  const marcadorCoincide = (titulo) => {
    if (!golesOficiales) return true;
    const extraido = extraerMarcadorDeTitulo(titulo);
    if (!extraido) return true;
    const [a, b] = extraido;
    const [x, y] = golesOficiales;
    return (a === x && b === y) || (a === y && b === x);
  };

  // 1) Por ALIAS del canal (a pedido, primera prioridad): el apodo real que
  // usa el canal para cada equipo, tabla armada a mano con Pablo mirando
  // videos reales — mucho más preciso que adivinar por palabras del nombre
  // completo. Si alguno de los dos equipos no está en la tabla, devuelve
  // null y se sigue de largo a los métodos viejos de abajo.
  // 2) Nombre completo tal cual está en la base (por si algún día coincide).
  // 3) BUG encontrado (a pedido: "Rosario Central vs Racing" trajo el video
  // de "Barracas Central vs Racing" — matcheaba por la palabra suelta
  // "central", que las dos tienen): si el equipo tiene más de una palabra
  // significativa, TIENEN que calzar TODAS, no cualquiera.
  const match = buscarPorAlias(equipoLocal, equipoVisitante, candidatosVideos, marcadorCoincide)
    || candidatosVideos.find((v) => {
      const titulo = normalizar(v.titulo);
      return titulo.includes(nl) && titulo.includes(nv) && marcadorCoincide(v.titulo);
    })
    || candidatosVideos.find((v) => {
      const titulo = normalizar(v.titulo);
      const tieneLocal = palabrasLocal.every((p) => titulo.includes(p));
      const tieneVisita = palabrasVisita.every((p) => titulo.includes(p));
      return tieneLocal && tieneVisita && marcadorCoincide(v.titulo);
    });

  return { videoId: match?.videoId || null, candidatos };
}

async function rutaMedia(req, res) {
  if (!YOUTUBE_API_KEY) {
    console.log('[/media] Sin YOUTUBE_API_KEY configurada, se saltea.');
    return res.json({ revisados: 0, encontrados: 0, mensaje: 'Falta YOUTUBE_API_KEY' });
  }

  const limite = new Date();
  limite.setDate(limite.getDate() - DIAS_VENTANA_MEDIA);

  // ?competencia=... (a pedido, para probar UNA liga sin tocar las demás:
  // "no busques partidos de otras ligas, veamos bien cómo funciona"). Sin el
  // parámetro, se comporta como siempre (todas las competencias con fuente).
  const competenciaFiltro = req.query?.competencia || null;
  if (competenciaFiltro && !FUENTES_POR_COMPETENCIA[competenciaFiltro]) {
    return res.status(400).json({
      error: `"${competenciaFiltro}" no tiene fuente de YouTube configurada.`,
      competenciasDisponibles: TODAS_LAS_COMPETENCIAS_CON_FUENTE,
    });
  }
  const competenciasABuscar = competenciaFiltro ? [competenciaFiltro] : TODAS_LAS_COMPETENCIAS_CON_FUENTE;

  // BUG encontrado (a pedido: "salida demasiado grande", cron-job.org corta
  // la respuesta): con más partidos entrando a la búsqueda de una, el
  // detalle completo (candidatos = TODOS los títulos del canal, por
  // partido) se volvió gigante. Por default la respuesta ahora es liviana
  // (solo lo que hace falta para el cron real: cuántos se revisaron/
  // encontraron). El detalle completo (candidatos, excluidos) solo se arma
  // con ?diagnostico=1 en la URL, para cuando de verdad hace falta
  // investigar un caso puntual a mano.
  const modoDiagnostico = ['1', 'true'].includes(String(req.query?.diagnostico || ''));

  // BUG confirmado con datos reales (a pedido, vía /diagnostico-ids sobre los
  // 10 partidos de la fecha 2 del Clausura Argentina que no aparecían en
  // ningún lado): los 10 tienen `categoria: 5` en la base — NO todos los
  // partidos son Cat.4 por default, hay Cat.5 real y actual conviviendo con
  // Cat.4. Por eso `categoria = 4` los dejaba afuera de la consulta entera,
  // ni siquiera llegaban a "excluidos". Vuelve `categoria IN (4, 5)`.
  //
  // Para entender por qué "encontró 4 de 16" (a pedido, diagnóstico): en vez
  // de aplicar TODOS los filtros de una y perder de vista a los que quedan
  // afuera, se trae primero TODA la competencia (solo categoria+tema+activo)
  // y acá abajo se clasifica cada partido: cuál de los filtros (ya tiene
  // video, corrección manual, sin resultado oficial cargado, fuera de la
  // ventana de días) lo saca de la búsqueda — así se ve la razón real en vez
  // de adivinar.
  const { data: candidatosBrutos, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, tema, equipo_local, equipo_visitante, fecha_expiracion, goles_local_oficial, goles_visitante_oficial, resultado_oficial, media_video_url, media_video_url_espn, media_video_corregido, esta_activo')
    .in('categoria', [4, 5])
    .in('tema', competenciasABuscar);

  if (error) {
    console.error('[/media] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  // BUG encontrado (a pedido, diagnóstico ids fecha 2 Argentina: 9 partidos
  // en estado_partido='FT' con fixture_id_api cargado — o sea, YA
  // terminados y procesados — que igual quedaban "sin resultado" para
  // /media): /resolver.js guarda el resultado en un campo DISTINTO según la
  // categoría — Cat.4 en goles_local_oficial (marcador exacto), Cat.5 en
  // resultado_oficial (texto tipo "Gana Talleres", sin marcador). Acá solo
  // se miraba goles_local_oficial, así que TODO partido Cat.5 quedaba
  // marcado "sin resultado" para siempre, ya estuviera resuelto o no. Ahora
  // cuenta como resuelto si tiene CUALQUIERA de los dos.
  //
  // DOS FUENTES POR PARTIDO (a pedido, Argentina: AFA + ESPN Fans): un
  // partido ya no se excluye entero solo porque UNA de sus fuentes ya tiene
  // video — se calcula, por partido, la lista de fuentes que TODAVÍA le
  // faltan (`fuentesPendientes`, campo `d[fuente.campo]` vacío, y para el
  // campo principal `media_video_url` que además no esté corregido a mano)
  // y solo se excluye si esa lista queda vacía (las dos fuentes que
  // aplican, o la única, ya están completas).
  const excluidos = [];
  const partidos = (candidatosBrutos || [])
    .map((d) => {
      const fuentesDeEsteTema = FUENTES_POR_COMPETENCIA[d.tema] || [];
      const fuentesPendientes = fuentesDeEsteTema.filter((f) => {
        if (d[f.campo]) return false; // esta fuente ya tiene su video guardado
        if (f.campo === 'media_video_url' && d.media_video_corregido) return false; // admin lo corrigió a mano, no tocar
        return true;
      });
      return { ...d, fuentesPendientes };
    })
    .filter((d) => {
      const motivos = [];
      if (!d.esta_activo) motivos.push('esta_activo = false');
      if (d.fuentesPendientes.length === 0) {
        motivos.push('todas sus fuentes de video ya están completas (o corregidas a mano)');
      }
      if (d.goles_local_oficial == null && !d.resultado_oficial) {
        motivos.push('sin resultado oficial cargado (ni goles_local_oficial ni resultado_oficial, ver /resolver)');
      }
      if (d.fecha_expiracion && new Date(d.fecha_expiracion).getTime() < limite.getTime()) {
        motivos.push(`fuera de la ventana de ${DIAS_VENTANA_MEDIA} días (DIAS_VENTANA_MEDIA)`);
      }
      if (motivos.length > 0) {
        if (modoDiagnostico) excluidos.push({ id: d.id, partido: `${d.equipo_local} vs ${d.equipo_visitante}`, motivos });
        return false;
      }
      return true;
    });

  // detalle (a pedido, diagnóstico): para cada partido revisado, qué títulos
  // encontró en el canal aunque no hayan matcheado — así se distingue "el
  // canal todavía no subió nada" (candidatos: []) de "subió algo pero el
  // nombre no calzó" (candidatos con títulos, encontrado: false). Recortado
  // a los primeros 8 títulos en modo diagnóstico (igual alcanza para
  // reconocer el patrón) y directamente ausente fuera de modo diagnóstico.
  const resultado = { revisados: (partidos || []).length, encontrados: 0, errores: [], detalle: [], ...(modoDiagnostico ? { excluidos } : {}) };

  // Uploads del canal, UNA sola vez por fuente (no por partido): varios
  // partidos comparten la misma fuente, y esta lista no cambia entre uno y
  // otro dentro de la misma corrida del cron. Se resuelve el channelId ANTES
  // de cachear (ver resolverChannelId — solo hace falta para ESPN Fans, que
  // no tiene channelId fijo a mano) para no repetir esa llamada tampoco.
  const uploadsPorFuente = {};
  const obtenerUploads = async (fuente) => {
    const channelId = await resolverChannelId(fuente);
    if (!channelId) return { videos: [], errorApi: `No se pudo resolver el channelId de ${fuente.nombre}` };
    if (!uploadsPorFuente[channelId]) {
      uploadsPorFuente[channelId] = await traerUploadsRecientes(channelId);
    }
    return uploadsPorFuente[channelId];
  };

  for (const partido of partidos || []) {
    // Un partido de Argentina ahora puede tener DOS fuentes pendientes (AFA
    // + ESPN Fans) — se buscan las dos, cada una guarda en su propio campo.
    // Un error o "no encontrado" en una fuente no frena la búsqueda de la
    // otra (por eso este bucle interno vive DENTRO del try/catch de más
    // abajo, uno por fuente en vez de uno por partido).
    for (const fuente of partido.fuentesPendientes) {
      try {
        const { videos, errorApi: errorUploads } = await obtenerUploads(fuente);
        if (errorUploads) {
          resultado.detalle.push({
            id: partido.id,
            partido: `${partido.equipo_local} vs ${partido.equipo_visitante}`,
            fuente: fuente.nombre,
            encontrado: false,
            errorApi: errorUploads,
          });
          continue;
        }
        // Marcador oficial (solo si es Cat.4 y ya está cargado) — se usa para
        // verificar el video encontrado, ver nota de PALABRAS_EXCLUYEN_VIDEO /
        // marcadorCoincide en buscarVideoResumenEnLista.
        const golesOficiales = (partido.goles_local_oficial != null && partido.goles_visitante_oficial != null)
          ? [partido.goles_local_oficial, partido.goles_visitante_oficial]
          : null;
        const { videoId, candidatos } = buscarVideoResumenEnLista(partido.equipo_local, partido.equipo_visitante, partido.fecha_expiracion, videos, golesOficiales);
        resultado.detalle.push({
          id: partido.id,
          partido: `${partido.equipo_local} vs ${partido.equipo_visitante}`,
          fuente: fuente.nombre,
          encontrado: !!videoId,
          // SIN candidatos fuera de diagnóstico (a pedido, bug reportado:
          // "salida demasiado grande", cron-job.org corta la respuesta):
          // antes acá quedaban hasta 8 TÍTULOS completos por fuente — con
          // Argentina ahora teniendo DOS fuentes por partido (AFA + ESPN
          // Fans), esa lista se duplicó y volvió a pasarse del límite. Fuera
          // de diagnóstico solo queda el número (candidatosCount), sin
          // texto — el detalle completo de títulos sigue disponible con
          // ?diagnostico=1 para cuando de verdad hace falta investigar.
          ...(modoDiagnostico ? { candidatos } : { candidatosCount: candidatos.length }),
        });
        if (videoId) {
          const { error: errUpdate } = await supabase
            .from('desafios_mvp')
            .update({ [fuente.campo]: `https://www.youtube.com/watch?v=${videoId}` })
            .eq('id', partido.id);
          if (errUpdate) {
            resultado.errores.push({ id: partido.id, fuente: fuente.nombre, error: errUpdate.message });
          } else {
            resultado.encontrados++;
            console.log(`[/media] Partido ${partido.id} (${partido.pregunta}) -> video ${videoId} (${fuente.nombre})`);
          }
        }
      } catch (e) {
        resultado.errores.push({ id: partido.id, fuente: fuente.nombre, error: e.message });
      }
    }
  }

  console.log(`[/media] ${resultado.encontrados} video(s) encontrados de ${resultado.revisados} revisados.`);
  res.json(resultado);
}

module.exports = { rutaMedia };
