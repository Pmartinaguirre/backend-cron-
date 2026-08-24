// Cliente chico para API-Football (api-sports.io) — centraliza las llamadas
// que necesitan los distintos cron endpoints, para no repetir headers/base
// URL en cada archivo.
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';

if (!API_FOOTBALL_KEY) {
  throw new Error('Falta API_FOOTBALL_KEY en las variables de entorno.');
}

const headers = { 'x-apisports-key': API_FOOTBALL_KEY };

// Bet id 1 = "Match Winner" (Local / Empate / Visita) en API-Football.
const BET_ID_MATCH_WINNER = 1;

// ---------- Cuotas (usado por /cuotas) ----------
// No anclamos a una casa de apuestas específica (no hay dinero real de por
// medio) — se toma la primera casa que tenga el mercado "Match Winner"
// completo para ese fixture.
async function obtenerCuotas(fixtureId) {
  const resp = await fetch(`${BASE}/odds?fixture=${fixtureId}`, { headers });
  const data = await resp.json();

  // DEBUG (a pedido: "no tiene cuota, es muy raro" en varios partidos de
  // Libertadores/Sudamericana/Liga Profesional el mismo día — competencias
  // que sí tienen casas de apuestas siempre): antes acá no se revisaba si
  // la API devolvió un ERROR (límite de plan, cuota agotada, parámetro
  // inválido...) — un error se veía IGUAL que "todavía no hay cuota
  // cargada" (mismo `response: []`), así que un fallo sistemático de la
  // API quedaba invisible, disfrazado de "esperando a que la casa publique
  // la cuota". Esto imprime el motivo real en los logs de Render.
  const errores = data?.errors;
  const hayError = errores && (Array.isArray(errores) ? errores.length > 0 : Object.keys(errores).length > 0);
  if (!resp.ok || hayError) {
    console.error(`[obtenerCuotas] Fixture ${fixtureId}: la API devolvió un error — status ${resp.status}, errors:`, errores, '— resultados restantes hoy:', data?.['results'], '/', data?.paging?.total);
  }

  const bookmakers = data?.response?.[0]?.bookmakers || [];
  if (!hayError && bookmakers.length === 0) {
    console.log(`[obtenerCuotas] Fixture ${fixtureId}: la API respondió OK pero sin bookmakers todavía (response.length=${(data?.response || []).length}).`);
  }

  for (const bk of bookmakers) {
    const bet = (bk.bets || []).find((b) => b.id === BET_ID_MATCH_WINNER);
    if (!bet) continue;
    const home = bet.values.find((v) => v.value === 'Home');
    const draw = bet.values.find((v) => v.value === 'Draw');
    const away = bet.values.find((v) => v.value === 'Away');
    if (!home || !draw || !away) continue;
    return {
      cuota_local: parseFloat(home.odd),
      cuota_empate: parseFloat(draw.odd),
      cuota_visita: parseFloat(away.odd),
      casa: bk.name,
    };
  }
  return null; // todavía no hay cuotas cargadas para este fixture
}

// Estadísticas (tiros, posesión, corners...) de un fixture ya traído de
// /fixtures?id= — factorizado acá porque tanto obtenerDetalleFixture como
// obtenerEstadoFixture pegan a ESE MISMO endpoint (que ya trae statistics
// adentro de la respuesta) y hasta ahora solo el primero lo aprovechaba.
// Vienen como pares {type, value} por equipo; se cruzan en una sola lista
// para que quien la use pinte "local | concepto | visita" sin emparejar.
// Tanda de penales (a pedido): API-Football manda los penales del alargue
// como eventos "Goal" normales, con el `time.elapsed` siguiendo la cuenta
// donde quedó el partido (121, 122, 123...) en vez de un dato propio de
// "kick de la tanda". Como el partido real (90' + alargue) nunca pasa de
// 120', cualquier evento con elapsed > 120 es un pateo de la definición, no
// un gol de tiempo de juego — así se separan de los goles reales tanto en
// la lista de goleadores (obtenerEstadoFixture) como en la línea de tiempo
// del resumen (obtenerDetalleFixture), y de paso se arma la lista propia de
// "quién pateó y si convirtió" para mostrar la tanda aparte.
const MINUTO_MAX_TIEMPO_REAL = 120;
function esEventoDeTandaPenales(ev) {
  const min = ev.time?.elapsed;
  return ev.type === 'Goal' && Number.isFinite(min) && min > MINUTO_MAX_TIEMPO_REAL;
}

// GOL ANULADO POR VAR (a pedido, bug reportado: "el sistema edita el
// marcador pero deja el gol impreso en la tarjeta, en el resumen y en el
// momentum, lo tiene que eliminar de los tres"): cuando el VAR anula un gol,
// API-Football NO borra el evento original "Goal" — lo deja tal cual estaba
// y agrega, APARTE, un evento type: "Var" con detail tipo "Goal Cancelled -
// Offside" al MISMO minuto y equipo. Sin cruzar los dos, el gol anulado
// seguía contando como gol real en todos lados (goleadores de la tarjeta,
// resumen del partido y el gráfico de momentum, que se arma a partir del
// mismo resumen). Acá se arma el set de "goles anulados" (clave equipo+
// minuto) para poder EXCLUIR el evento "Goal" original en los tres lugares
// que lo usan — el evento "Var" en sí se mantiene y sigue mostrando el
// aviso de gol anulado.
//
// GOL CONFIRMADO POR VAR (a pedido: "revisa si la API da la info cuando hay
// VAR... gol validado por el VAR"): mismo mecanismo, pero cuando la revisión
// CONFIRMA el gol, API-Football manda el evento "Var" con detail tipo "Goal
// confirmed" — acá se distingue de un gol anulado para que el frontend
// pueda pintar "Gol validado por el VAR" en vez de tratarlo como una
// revisión genérica.
function claveEventoGolVar(ev) {
  return `${ev.team?.id}-${ev.time?.elapsed}`;
}
function esVarSobreGol(ev, patronDetalle) {
  return ev.type === 'Var' && /goal/i.test(ev.detail || '') && patronDetalle.test(ev.detail || '');
}
const PATRON_GOL_ANULADO = /(disallow|cancel|anulad)/i;
const PATRON_GOL_CONFIRMADO = /(confirm|valid)/i;
function construirSetGolesAnulados(eventos) {
  const set = new Set();
  (eventos || [])
    .filter((ev) => esVarSobreGol(ev, PATRON_GOL_ANULADO))
    .forEach((ev) => set.add(claveEventoGolVar(ev)));
  return set;
}

// TARJETA ROJA A JUGADOR DE CANCHA (a pedido: "cuando le sacan una roja a un
// jugador de campo... la api tb marca las rojas a la banca del equipo pero
// esa no las consideres"): API-Football no distingue "roja a un jugador en
// cancha" de "roja al banco de suplentes/cuerpo técnico" con un campo propio
// — hay que deducirlo cruzando el evento de tarjeta con la alineación
// (lineups, que ya viene en esta misma llamada a /fixtures?id=).
//
// Se arman, por equipo, DOS sets de ids: `enCancha` (arranca con el 11
// titular, lineups[].startXI) y `banca` (arranca con los suplentes,
// lineups[].substitutes). Los dos se actualizan con cada cambio ("subst":
// `player` es el que ENTRA, `assist` el que SALE — mismo criterio que usa
// obtenerDetalleFixture más abajo): al entrar, un suplente pasa de `banca` a
// `enCancha`.
//
// BUG encontrado (a pedido, caso real: Coquimbo Unido vs D. La Serena — dos
// rojas del visitante en los events, "S. Diaz" y "F. Gutierrez", con
// jugadorId que NO aparece ni en titulares ni en suplentes de NINGÚN equipo):
// API-Football a veces manda un jugadorId en el evento de tarjeta que no
// calza con ningún id de la alineación (dato inconsistente de la propia API,
// no un bug nuestro — pasa sobre todo en ligas chicas). Con la lógica vieja
// (¿está en el set de "en cancha"? si no, se descarta) estos casos se
// perdían SIEMPRE, aunque fueran rojas reales a jugadores de campo. Ahora se
// distinguen 3 casos:
//   1) El id está en `enCancha` -> roja de cancha (cuenta).
//   2) El id está en `banca` (suplente conocido que NUNCA entró) -> roja a
//      la banca, se descarta (esto es justo lo que pidió Pablo).
//   3) El id no aparece en NINGUNO de los dos sets (dato inconsistente de la
//      API) -> se cuenta igual. Mejor mostrar de más una roja rara que
//      ocultar una real — el caso 2, que sí se conoce con certeza, sigue
//      excluido.
// Sin ficha de jugador (jugadorId null — típico de una roja al CUERPO
// TÉCNICO, ej. el entrenador expulsado) se descarta directo, no entra a
// ninguno de los 3 casos de arriba.
//
// Se recorren los eventos en orden cronológico (elapsed+extra) para que un
// cambio anterior a la roja ya haya movido al jugador correspondiente.
function huboRojaDeCancha(fx) {
  const idLocal = fx.teams?.home?.id;
  const enCanchaLocal = new Set();
  const enCanchaVisita = new Set();
  const bancaLocal = new Set();
  const bancaVisita = new Set();
  (fx.lineups || []).forEach((l) => {
    const esLocal = l.team?.id === idLocal;
    const enCancha = esLocal ? enCanchaLocal : enCanchaVisita;
    const banca = esLocal ? bancaLocal : bancaVisita;
    (l.startXI || []).forEach((x) => { if (x.player?.id != null) enCancha.add(x.player.id); });
    (l.substitutes || []).forEach((x) => { if (x.player?.id != null) banca.add(x.player.id); });
  });
  const eventosOrdenados = [...(fx.events || [])].sort((a, b) => {
    const ea = (a.time?.elapsed ?? 0) + (a.time?.extra ?? 0) / 100;
    const eb = (b.time?.elapsed ?? 0) + (b.time?.extra ?? 0) / 100;
    return ea - eb;
  });
  // CONTADOR, no booleano (a pedido: "cuando un equipo tiene dos tarjetas
  // rojas en la mini tarjeta debes poner dos iconos de tarjeta roja,
  // actualmente pones solo 1" — antes esto era true/false, así que un
  // segundo expulsado del mismo equipo no sumaba nada nuevo).
  let rojaLocal = 0;
  let rojaVisita = 0;
  eventosOrdenados.forEach((ev) => {
    const esDelLocal = ev.team?.id === idLocal;
    const enCancha = esDelLocal ? enCanchaLocal : enCanchaVisita;
    const banca = esDelLocal ? bancaLocal : bancaVisita;
    if (ev.type === 'subst') {
      if (ev.assist?.id != null) enCancha.delete(ev.assist.id); // sale
      if (ev.player?.id != null) { enCancha.add(ev.player.id); banca.delete(ev.player.id); } // entra
      return;
    }
    if (ev.type === 'Card' && (ev.detail === 'Red Card' || ev.detail === 'Second Yellow card')) {
      const jugadorId = ev.player?.id;
      if (jugadorId == null) return; // sin ficha de jugador -> cuerpo técnico, se descarta
      const esDeCancha = enCancha.has(jugadorId)
        ? true
        : banca.has(jugadorId)
          ? false // suplente conocido que nunca entró -> banca
          : true; // id no aparece en la alineación (dato inconsistente de la api) -> se asume cancha
      if (esDeCancha) {
        if (esDelLocal) rojaLocal += 1; else rojaVisita += 1;
      }
    }
  });
  return { rojaLocal, rojaVisita };
}

function extraerEstadisticas(fx, idLocal) {
  const statsLocal = (fx.statistics || []).find((s) => s.team?.id === idLocal)?.statistics || [];
  const statsVisita = (fx.statistics || []).find((s) => s.team?.id !== idLocal)?.statistics || [];
  return statsLocal.map((s) => ({
    concepto: s.type,
    local: s.value,
    visita: statsVisita.find((x) => x.type === s.type)?.value ?? null,
  }));
}

// ---------- Estado del partido + marcador + goleadores (usado por /vivo y /resolver) ----------
// Devuelve null si la API no tiene datos para ese fixture (raro, pero por
// las dudas no se rompe el cron completo por un solo partido con problemas).
async function obtenerEstadoFixture(fixtureId) {
  const resp = await fetch(`${BASE}/fixtures?id=${fixtureId}`, { headers });
  const data = await resp.json();
  const fixture = data?.response?.[0];
  if (!fixture) return null;

  const estado = fixture.fixture?.status?.short || null; // NS, 1H, HT, 2H, FT, PST, etc.
  const minuto = fixture.fixture?.status?.elapsed ?? null;
  // Estadio + árbitro (a pedido, "Información del partido" en la app): la
  // misma llamada a /fixtures?id= ya trae estos datos, así que no hace
  // falta pegarle a otro endpoint aparte para nombre/ciudad — se reaprovecha
  // acá y /cuotas los guarda junto con las cuotas (ver rutas/cuotas.js). El
  // árbitro suele confirmarse recién unos días antes del partido (a veces
  // sigue null hasta último momento, incluso con el estadio ya cargado), así
  // que puede llegar en null por un tiempo — no es un error, es que la
  // propia API-Football todavía no lo tiene asignado.
  //
  // Nombre/ciudad SEPARADOS (antes venían combinados en un solo string "Name
  // — City") para poder armar el formato pedido "Nombre estadio, ciudad,
  // país" en el frontend. venueId se guarda para poder pedir capacidad/
  // césped/año de fundación al endpoint /venues (ver obtenerDatosVenue más
  // abajo) — /fixtures no trae esos tres datos.
  const estadioNombre = fixture.fixture?.venue?.name || null;
  const estadioCiudad = fixture.fixture?.venue?.city || null;
  const estadioVenueId = fixture.fixture?.venue?.id || null;
  // Árbitro: API-Football en varias ligas manda "Nombre Apellido, País" en
  // un solo string (no hay un campo de nacionalidad separado) — se separa
  // acá por la coma para poder mostrar la bandera del país aparte en el
  // frontend. Si no hay coma (algunas ligas mandan solo el nombre), queda
  // arbitroPais en null y el frontend simplemente no muestra bandera.
  const arbitroCrudo = fixture.fixture?.referee || null;
  const [arbitroNombreRaw, arbitroPaisRaw] = arbitroCrudo ? arbitroCrudo.split(',').map((s) => s.trim()) : [null, null];
  const arbitro = arbitroNombreRaw || null;
  const arbitroPais = arbitroPaisRaw || null;
  // Tiempo de descuento: API-Football lo manda aparte de "elapsed" (en un
  // 90+5, elapsed=90 y extra=5). Se guarda separado para poder mostrar
  // "90'+5'" en vez de sumarlos y perder la distinción.
  const minutoExtra = fixture.fixture?.status?.extra ?? null;
  // Fecha del fixture según la API. Importa para los partidos POSTERGADOS:
  // API-Football mantiene el mismo fixture id y le cambia la fecha a la
  // nueva, así que comparándola con la que tenemos guardada se puede
  // reprogramar el partido solo (ver /vivo).
  const fechaISO = fixture.fixture?.date || null;
  const golesLocal = fixture.goals?.home ?? null;
  // Tanda de penales (a pedido): API-Football la manda APARTE de "goals" —
  // "goals" siempre queda con el resultado de 90'+alargue (el que define
  // Local/Empate/Visita para los pronósticos, sin tocar por los penales).
  // score.penalty es null hasta que arranca la definición; se guarda tal
  // cual para mostrar la línea "Penales: X-Y" en la tarjeta y para que la
  // barra de progreso muestre "Penales" en vez de un minuto sin sentido
  // mientras se juega esa tanda (estado 'P').
  const penalesLocal = fixture.score?.penalty?.home ?? null;
  const penalesVisita = fixture.score?.penalty?.away ?? null;
  const golesVisita = fixture.goals?.away ?? null;

  // Eventos tipo "Goal" -> lista de {nombre, minuto, tipo} separada por
  // equipo local/visita (se compara el id del equipo del evento contra el id
  // del equipo local del fixture).
  //
  // OJO con dos trampas de API-Football acá:
  //
  //  1) "Missed Penalty" (penal ERRADO) viene con type === 'Goal' — solo se
  //     distingue por el campo "detail". Antes se filtraba solo por
  //     type === 'Goal', así que un penal errado se mostraba como gol y el
  //     marcador de la tarjeta no calzaba con la lista de goleadores. Ahora
  //     se descarta explícitamente.
  //
  //  2) En un "Own Goal" (autogol), ev.team es el equipo del JUGADOR que se
  //     lo hizo en contra, pero el gol cuenta para el RIVAL — hay que
  //     invertir el lado. CONFIRMADO con prueba real (a pedido, caso
  //     River-Vélez, 23/08/2026): se probó sacando el invertido (asumiendo
  //     que `ev.team` ya venía con el equipo beneficiado) y el resultado, tras
  //     forzar el refresco del partido con /vivo?id=, siguió cayendo del lado
  //     de Vélez — o sea que `ev.team` SÍ es el equipo del jugador (T.
  //     Silvero, de Vélez), confirmando que hay que invertir. Si algún día
  //     esto vuelve a fallar, no asumir de nuevo — probar con /vivo?id= en un
  //     partido real con autogol antes de tocar esto.
  //
  // Se guarda además "tipo" ('normal' | 'penal' | 'autogol') para que la
  // tarjeta pueda marcarlos distinto, y el minuto suma el tiempo añadido
  // (ev.time.extra) para que un gol al 90+3 salga como 93' y quede bien
  // ordenado en la línea de tiempo.
  const idEquipoLocal = fixture.teams?.home?.id;
  const eventos = fixture.events || [];
  const golesAnulados = construirSetGolesAnulados(eventos);
  const goleadoresLocal = [];
  const goleadoresVisita = [];
  eventos
    .filter((ev) => ev.type === 'Goal' && ev.detail !== 'Missed Penalty' && !esEventoDeTandaPenales(ev)
      // Gol anulado por VAR (a pedido): se saca acá para que no quede
      // impreso en la tarjeta de partido aunque el marcador ya esté
      // corregido — ver construirSetGolesAnulados más arriba.
      && !golesAnulados.has(claveEventoGolVar(ev)))
    .forEach((ev) => {
      const esAutogol = ev.detail === 'Own Goal';
      const esPenal = ev.detail === 'Penalty';
      const minutoBase = ev.time?.elapsed ?? null;
      const entrada = {
        nombre: ev.player?.name || 'Gol',
        minuto: minutoBase != null ? minutoBase + (ev.time?.extra || 0) : null,
        // BUG (reportado): un gol al 45+1 se guardaba solo como minuto=46
        // (elapsed + extra, para que ordene bien en la línea de tiempo —
        // ver comentario de arriba), pero el frontend usaba ese mismo 46
        // para decidir si el gol fue ANTES o DESPUÉS del entretiempo
        // ("> 45" = segundo tiempo), así que un gol de descuento del PRIMER
        // tiempo aparecía debajo del separador "MT" como si fuera del
        // segundo. Se guarda además el elapsed SIN el agregado — ese es el
        // que hay que usar para decidir de qué mitad es, nunca el que
        // suma el descuento.
        minutoBase,
        tipo: esAutogol ? 'autogol' : esPenal ? 'penal' : 'normal',
      };
      const esDelLocal = ev.team?.id === idEquipoLocal;
      // El autogol se le cuenta al rival del jugador que lo marcó.
      const cuentaParaLocal = esAutogol ? !esDelLocal : esDelLocal;
      if (cuentaParaLocal) goleadoresLocal.push(entrada);
      else goleadoresVisita.push(entrada);
    });
  const porMinuto = (a, b) => (a.minuto ?? 999) - (b.minuto ?? 999);
  goleadoresLocal.sort(porMinuto);
  goleadoresVisita.sort(porMinuto);

  // MOMENTUM (a pedido): esta misma llamada a /fixtures?id= ya trae
  // "statistics" adentro — no cuesta una consulta extra de cuota aprovechar
  // eso acá para ir guardando snapshots de tiros/corners/posesión con el
  // minuto de cada corrida de /vivo, y así poder armar un gráfico de
  // "quién domina" sin depender de un dato de momentum que la API no tiene.
  const estadisticas = extraerEstadisticas(fixture, idEquipoLocal);

  // Roja a jugador de cancha (a pedido, mini tarjeta): ver huboRojaDeCancha
  // más arriba. Se calcula acá porque esta misma llamada ya trae lineups +
  // events juntos — no hace falta pegarle a otro endpoint aparte.
  const { rojaLocal, rojaVisita } = huboRojaDeCancha(fixture);

  return {
    estado,
    minuto,
    minutoExtra,
    fechaISO,
    golesLocal,
    golesVisita,
    goleadoresLocal,
    goleadoresVisita,
    estadisticas,
    penalesLocal,
    penalesVisita,
    estadioNombre,
    estadioCiudad,
    estadioVenueId,
    arbitro,
    arbitroPais,
    rojaLocal,
    rojaVisita,
  };
}

// ---------- Datos del estadio (capacidad/césped/año, usado por /cuotas ----------
// junto con estadioVenueId de obtenerEstadoFixture) ----------
// API-Football separa esto del fixture: /venues?id= trae name/city/country/
// capacity/surface/image/address — antes solo se usaban capacity/surface/
// country (el "año de fundación" NO lo entrega este endpoint pese a que a
// veces se pide; si en el futuro aparece en la respuesta se puede sumar,
// por ahora queda null). `imagen` se suma acá (a pedido: "agrega una foto
// del estadio") — API-Football ya la traía en este mismo llamado, solo no
// se estaba leyendo. Se llama solo cuando falta alguno de estos datos (ver
// cuotas.js), no en cada corrida, para no gastar cuota de más.
async function obtenerDatosVenue(venueId) {
  if (!venueId) return null;
  const resp = await fetch(`${BASE}/venues?id=${venueId}`, { headers });
  const data = await resp.json();
  const venue = data?.response?.[0];
  if (!venue) return null;
  return {
    pais: venue.country || null,
    capacidad: venue.capacity ?? null,
    cesped: venue.surface || null,
    imagen: venue.image || null,
  };
}

// FALLBACK sin venueId (a pedido, bug reportado: "no aparece ningún
// estadio en la columna estadio_imagen"): diagnosticado que, para la
// mayoría de las ligas sudamericanas (Argentina, Chile, Brasil, Paraguay,
// Ecuador...), API-Football manda el NOMBRE del estadio en el fixture
// (fixture.venue.name) pero deja fixture.venue.id en null — sin ese id,
// obtenerDatosVenue de arriba nunca se podía llamar, así que esos partidos
// se quedaban sin capacidad/césped/foto para siempre, aunque sí tuvieran
// el nombre del estadio guardado.
//
// Acá se intenta encontrar el venue buscándolo por NOMBRE con
// /venues?search= (mismo endpoint /venues, pero por texto en vez de id).
//
// VALIDACIÓN DE MATCH (a pedido, bug reportado: "el estadio de Palmeiras vs
// Cerro Porteño tiene el nombre bien pero la foto carga incorrectamente" —
// venue id 258, "Estadio Nu Bank Parque"): antes se tomaba el PRIMER
// resultado de /venues?search= a ciegas, sin comprobar que de verdad fuera
// el mismo estadio. Como el NOMBRE que se muestra en la app viene del
// fixture (no de este resultado — ver cuotas.js, `venue.nombre` de acá casi
// nunca se usa para pisar el nombre), un match flojo/equivocado quedaba
// invisible: el nombre en pantalla seguía siendo el correcto, pero la
// capacidad/césped/FOTO que sí vienen de este resultado eran de OTRO
// estadio. Ahora se exige que el nombre devuelto por la API comparta
// alguna palabra significativa (4+ letras, sin tildes) con lo buscado — si
// no hay ninguna coincidencia, se descarta el resultado en vez de usarlo
// "total, algo es mejor que nada": mejor no traer capacidad/foto que traer
// la de un estadio distinto.
function normalizarNombreEstadio(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function palabrasSignificativasEstadio(nombre) {
  return normalizarNombreEstadio(nombre)
    .split(' ')
    .filter((p) => p.length >= 4 && !['estadio', 'stadium', 'arena', 'municipal', 'parque', 'park'].includes(p));
}
function nombresDeEstadioCalzan(buscado, encontrado) {
  const a = palabrasSignificativasEstadio(buscado);
  const b = palabrasSignificativasEstadio(encontrado);
  if (a.length === 0 || b.length === 0) return true; // sin palabras significativas de ningún lado, no se puede descartar con este método
  return a.some((p) => b.includes(p));
}
// No es infalible — nombres repetidos, tildes, "Estadio X" vs "X Arena"
// pueden no calzar exacto igual pasando el chequeo de arriba — así que
// entre los candidatos que SÍ calzan se toma el primero nomás. Si
// encuentra un venue, se devuelve también su `id` para que cuotas.js lo
// guarde en estadio_venue_id — así, en corridas futuras, ese partido ya
// tiene id propio y puede usar obtenerDatosVenue directo, sin repetir esta
// búsqueda por nombre.
async function obtenerDatosVenuePorNombre(nombre) {
  if (!nombre) return null;
  const resp = await fetch(`${BASE}/venues?search=${encodeURIComponent(nombre)}`, { headers });
  const data = await resp.json();
  // DEBUG (a pedido, bug reportado: "no actualiza bien los estadios" — los
  // mismos partidos se quedaban trabados corrida tras corrida sin avisar
  // por qué): antes, si /venues?search= no encontraba nada o la API
  // devolvía un error (límite de plan, rate-limit, parámetro mal armado),
  // acá se devolvía `null` en silencio — indistinguible entre "este
  // estadio no existe en API-Football" y "algo falló al preguntar". Estos
  // logs (visibles en Render → Logs) permiten diferenciar los dos casos.
  const errores = data?.errors;
  const hayError = errores && (Array.isArray(errores) ? errores.length > 0 : Object.keys(errores).length > 0);
  if (!resp.ok || hayError) {
    console.error(`[obtenerDatosVenuePorNombre] Búsqueda "${nombre}": la API devolvió un error — status ${resp.status}, errors:`, errores);
    return null;
  }
  const candidatos = data?.response || [];
  if (candidatos.length === 0) {
    console.log(`[obtenerDatosVenuePorNombre] Búsqueda "${nombre}": sin resultados (results=${data?.results ?? 0}).`);
    return null;
  }
  const venue = candidatos.find((v) => nombresDeEstadioCalzan(nombre, v.name)) || null;
  if (!venue) {
    console.log(`[obtenerDatosVenuePorNombre] Búsqueda "${nombre}": ${candidatos.length} resultado(s), pero NINGUNO calza por nombre (ej. "${candidatos[0]?.name}") — se descarta, mejor no traer nada que traer el estadio equivocado.`);
    return null;
  }
  console.log(`[obtenerDatosVenuePorNombre] Búsqueda "${nombre}" -> encontrado "${venue.name}" (id ${venue.id}, ${venue.city || 'sin ciudad'}).`);
  return {
    venueId: venue.id ?? null,
    pais: venue.country || null,
    capacidad: venue.capacity ?? null,
    cesped: venue.surface || null,
    imagen: venue.image || null,
  };
}

// ---------- Estadio PROPIO del equipo (usado por /cuotas como fallback
// principal, a pedido: "mira como Forza Football lo hace, se conecta a la
// misma API y tiene todos los estadios bien") ----------
//
// La diferencia clave: Forza (y cualquier app parecida) no depende de que
// CADA fixture puntual traiga venue.id cargado — usa el estadio FIJO del
// equipo, que en API-Football vive en la ficha del club (/teams?id=), no
// en el partido. Ese dato es información de club (nombre, dirección,
// capacidad, césped, foto), no algo que dependa de que la organización
// confirme partido por partido — por eso está completo para prácticamente
// cualquier equipo, a diferencia de fixture.venue (que en ligas fuera de
// las top-5 europeas suele llegar sin id, y a veces sin nombre siquiera,
// ver obtenerEstadoFixture más arriba).
//
// Se pide el estadio del equipo LOCAL porque, salvo alguna final/copa a
// sede neutral (caso borde, poco frecuente en las ligas que trackeamos),
// el partido se juega en SU cancha.
async function obtenerVenueDeEquipo(teamId) {
  if (!teamId) return null;
  const resp = await fetch(`${BASE}/teams?id=${teamId}`, { headers });
  const data = await resp.json();
  const errores = data?.errors;
  const hayError = errores && (Array.isArray(errores) ? errores.length > 0 : Object.keys(errores).length > 0);
  if (!resp.ok || hayError) {
    console.error(`[obtenerVenueDeEquipo] Equipo ${teamId}: la API devolvió un error — status ${resp.status}, errors:`, errores);
    return null;
  }
  const entrada = data?.response?.[0];
  const venue = entrada?.venue;
  if (!venue || !venue.id) {
    console.log(`[obtenerVenueDeEquipo] Equipo ${teamId} (${entrada?.team?.name || '?'}): la ficha del equipo no tiene estadio cargado.`);
    return null;
  }
  console.log(`[obtenerVenueDeEquipo] Equipo ${teamId} (${entrada?.team?.name || '?'}) -> estadio "${venue.name}" (id ${venue.id}).`);
  return {
    venueId: venue.id,
    nombre: venue.name || null,
    ciudad: venue.city || null,
    // /teams no separa el país del venue; el país del CLUB es la mejor
    // aproximación disponible (su estadio casi siempre está en el mismo
    // país, salvo casos rarísimos).
    pais: entrada?.team?.country || null,
    capacidad: venue.capacity ?? null,
    cesped: venue.surface || null,
    imagen: venue.image || null,
  };
}

// ---------- Fixtures de una liga completa (usado por /crear-partidos) ----------
// Devuelve también `errores`/`resultsRestantes` (además del array de
// fixtures) porque un "revisados: 0" puede significar dos cosas muy
// distintas: "no hay partidos" o "la API respondió con error/rate-limit y
// devolvió el response vacío" — sin esto último a la vista, las dos se ven
// idénticas desde /crear-partidos y no hay cómo distinguirlas de afuera.
async function obtenerFixturesDeLiga(leagueId, season) {
  const resp = await fetch(`${BASE}/fixtures?league=${leagueId}&season=${season}`, { headers });
  const data = await resp.json();
  const errores = data?.errors;
  // API-Football a veces manda `errors` como array vacío y a veces como
  // objeto {} vacío (según el endpoint) — solo cuenta si tiene contenido real.
  const tieneErrores = errores && (Array.isArray(errores) ? errores.length > 0 : Object.keys(errores).length > 0);
  return {
    fixtures: data?.response || [],
    errores: tieneErrores ? errores : null,
    // `results` es el contador que manda la propia API-Football — si algún
    // día difiere de `fixtures.length` (el array que realmente llegó), es
    // señal de paginación cortada a mitad de camino.
    resultsApi: data?.results ?? null,
  };
}

// ---------- Historial de enfrentamientos (usado por /historial-enfrentamientos,
// módulo "Historial de enfrentamientos" de la tarjeta de partido) ----------
// /fixtures/headtohead?h2h=idA-idB trae TODOS los cruces históricos entre
// dos equipos (cualquier competencia, cualquier temporada) — se pide con
// status=FT-AET-PEN (solo terminados, nunca partidos futuros/pospuestos que
// no aportan resultado) y se recorta acá a los últimos 5, más recientes
// primero (la API los devuelve de más viejo a más nuevo).
async function obtenerHeadToHead(idLocal, idVisita, limite = 5) {
  if (!idLocal || !idVisita) return [];
  const resp = await fetch(`${BASE}/fixtures/headtohead?h2h=${idLocal}-${idVisita}&status=FT-AET-PEN`, { headers });
  const data = await resp.json();
  const partidos = (data?.response || [])
    .map((fx) => ({
      fixtureId: fx.fixture?.id ?? null,
      fecha: fx.fixture?.date || null,
      competencia: fx.league?.name || null,
      equipoLocal: fx.teams?.home?.name || null,
      equipoVisita: fx.teams?.away?.name || null,
      golesLocal: fx.goals?.home ?? null,
      golesVisita: fx.goals?.away ?? null,
    }))
    .filter((p) => p.fecha)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  return partidos.slice(0, limite);
}

// ---------- Lesionados/suspendidos de un partido (usado por /lesionados,
// módulo "Alineaciones" de la tarjeta de partido) ----------
// /injuries?fixture=ID trae los jugadores que quedan afuera de ESE partido
// puntual (lesión o suspensión), con el motivo tal como lo manda la API
// ("Injury"/"Suspended" + un texto libre en "player.reason", ej. "Knee
// Injury", "Red Card"). No hace falta pedir por equipo por separado: el
// filtro por fixture ya trae a los dos equipos juntos.
async function obtenerLesionados(fixtureId) {
  if (!fixtureId) return [];
  const resp = await fetch(`${BASE}/injuries?fixture=${fixtureId}`, { headers });
  const data = await resp.json();
  return (data?.response || []).map((r) => ({
    jugadorId: r.player?.id ?? null,
    jugador: r.player?.name || '',
    tipo: r.player?.type || null, // "Missing Fixture" | "Questionable" (según la API)
    motivo: r.player?.reason || null,
    equipoId: r.team?.id ?? null,
    equipo: r.team?.name || null,
  }));
}

// ---------- Equipos de una liga (usado por /equipos, para el selector Tier A
// del Admin, "Equipos que sigue el grupo" de MisGrupos.jsx, y Equipos
// favoritos de Perfil.jsx) ----------
// Devuelve OBJETOS {nombre, logo, pais} (antes solo el nombre) — a pedido:
// "falto a agregar a los equipos y competencias sus logos, y abajo del
// nombre escribe... el país donde juega". API-Football ya trae logo y país
// gratis en el mismo /teams, así que no hace falta una llamada aparte.
async function obtenerEquiposDeLiga(leagueId, season) {
  const resp = await fetch(`${BASE}/teams?league=${leagueId}&season=${season}`, { headers });
  const data = await resp.json();
  const equipos = (data?.response || [])
    .map((r) => ({
      // `id` (a pedido, fix: "cuando seleccionas un equipo [en el buscador
      // de Partidos] no te lleva a la página del equipo"): faltaba el id
      // de API-Football acá, así que abrirFichaClub({ equipoId: item.id })
      // recibía siempre undefined y no hacía nada (return early). Con el id
      // puesto, EscudoEquipo también puede armar el logo del CDN si el
      // local no matchea.
      id: r.team?.id || null,
      nombre: r.team?.name || null,
      logo: r.team?.logo || null,
      pais: r.team?.country || null,
    }))
    .filter((e) => e.nombre);
  return equipos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// ---------- Tabla de posiciones de una liga (usado por /posiciones-liga) ----------
// Devuelve la tabla ya normalizada a lo que necesita la app, para no mandarle
// al navegador el JSON crudo de API-Football (que trae muchísimo más).
// Ojo con dos particularidades del endpoint /standings:
//   - response[0].league.standings es un ARREGLO DE ARREGLOS: los torneos por
//     grupos (Libertadores, Champions en fase de grupos, Mundial) devuelven
//     una tabla por grupo; las ligas normales devuelven una sola.
//   - "all" son los partidos totales; también vienen "home"/"away" aparte.
async function obtenerPosicionesDeLiga(leagueId, season) {
  const resp = await fetch(`${BASE}/standings?league=${leagueId}&season=${season}`, { headers });
  const data = await resp.json();
  const league = data?.response?.[0]?.league;
  if (!league) return null;

  const grupos = (league.standings || []).map((tabla) => ({
    // En ligas simples el "group" suele repetir el nombre de la liga; en
    // copas trae "Group A", "Group B", etc.
    nombre: tabla?.[0]?.group || league.name || '',
    equipos: (tabla || []).map((fila) => ({
      puesto: fila.rank,
      equipo: fila.team?.name || '',
      escudo: fila.team?.logo || null,
      pj: fila.all?.played ?? 0,
      g: fila.all?.win ?? 0,
      e: fila.all?.draw ?? 0,
      p: fila.all?.lose ?? 0,
      gf: fila.all?.goals?.for ?? 0,
      gc: fila.all?.goals?.against ?? 0,
      dg: fila.goalsDiff ?? 0,
      pts: fila.points ?? 0,
      forma: fila.form || null,
      // "description" es el texto de zona que trae API-Football por equipo:
      // "Promotion - Copa Libertadores (Group Stage)", "Relegation", etc.
      // Con eso la app dibuja los separadores de clasificación/descenso sin
      // tener que hardcodear cuántos cupos da cada liga (que además cambian
      // temporada a temporada).
      zona: fila.description || null,
    })),
  }));

  // pais/bandera: para el encabezado de la pantalla de competencia en la app
  // (escudo de la liga + bandera del país). Vienen gratis en la misma
  // respuesta de standings, no cuesta ninguna llamada extra.
  return {
    liga: league.name,
    logo: league.logo,
    pais: league.country || null,
    bandera: league.flag || null,
    temporada: league.season,
    grupos,
  };
}

// ============================================================
// NOTA DEMASTER.APP (a pedido: "agregar a cada jugador de los partidos una
// nota demaster.app" — sistema calcado del de Comunio, mostrado en las 3
// capturas que mandó Pablo). Dos capas:
//
//  1) Una base según el rating de 0 a 10 que ya trae API-Football por
//     jugador y partido (mismo concepto que la nota de SofaScore que usa
//     Comunio — no es SofaScore, pero se lee igual y se pasa por la MISMA
//     tabla de conversión a puntos que la captura 2).
//  2) Bonos/descuentos discretos encima: gol según posición, asistencia,
//     penales, tarjetas, autogol, portería a cero — igual que "Puntos
//     extra" de la captura 2.
//
// Solo se calcula cuando el partido YA ARRANCÓ (alineación oficial, no
// probable) — antes de eso no hay minutos ni rating que traer.
// ============================================================

// CAMBIO DE FONDO (a pedido, con la planilla de ratings del 15 de agosto
// como evidencia: "con la tabla que me diste es evidente que el rating de
// la api es el final, no hay que agregarle nada, solo poner el número de
// cada jugador... la api ya discrimina por la cantidad de minutos mínimos,
// así que si el jugador tiene el dato de su rating en la api lo imprimes").
// Antes esta función convertía el rating a "puntos" por una tabla, le sumaba
// bonos propios por gol/asistencia/tarjeta/penal/portería a cero, y volvía a
// convertir a nota — calcado del sistema de puntos de Comunio. El caso
// Tenaglia (rating 8.9, que YA traía su gol de defensor adentro, terminaba
// en nota 10.0 al sumarle el bono de gol OTRA VEZ) mostró que el rating de
// API-Football ya viene con las incidencias del partido reflejadas, así que
// nuestros bonos estaban duplicando el efecto. Ahora la nota Demaster.app ES
// el rating de la API, sin tocar — solo se redondea a 1 decimal por las
// dudas de que venga con más precisión.
function calcularNotaDemaster({ rating }) {
  if (rating == null || Number.isNaN(rating)) return null;
  return Math.round(rating * 10) / 10;
}

// /fixtures/players?fixture=ID trae, por jugador, el bloque "statistics" con
// rating/posición/minutos + goles/asistencias/penales/tarjetas de ESE
// partido puntual — es el endpoint que le falta a esta app para calcular la
// nota (hasta ahora solo se usaba /fixtures?id= para la alineación, que NO
// trae estadísticas, solo nombre/número/posición/grid).
async function obtenerEstadisticasJugadores(fixtureId) {
  const mapa = new Map();
  if (!fixtureId) return mapa;
  const resp = await fetch(`${BASE}/fixtures/players?fixture=${fixtureId}`, { headers });
  const data = await resp.json();
  const errores = data?.errors;
  const hayError = errores && (Array.isArray(errores) ? errores.length > 0 : Object.keys(errores).length > 0);
  if (!resp.ok || hayError) {
    console.error(`[obtenerEstadisticasJugadores] Fixture ${fixtureId}: la API devolvió un error — status ${resp.status}, errors:`, errores);
    return mapa;
  }
  (data?.response || []).forEach((equipo) => {
    (equipo.players || []).forEach((p) => {
      const id = p.player?.id;
      const s = p.statistics?.[0];
      if (id == null || !s) return;
      const ratingCrudo = s.games?.rating;
      mapa.set(id, {
        rating: ratingCrudo != null ? parseFloat(ratingCrudo) : null,
        posicion: s.games?.position || null,
        minutos: s.games?.minutes ?? 0,
        golesTotal: s.goals?.total ?? 0,
        asistencias: s.goals?.assists ?? 0,
        golesConcedidos: s.goals?.conceded ?? 0,
        penalScored: s.penalty?.scored ?? 0,
        penalMissed: s.penalty?.missed ?? 0,
        penalSaved: s.penalty?.saved ?? 0,
        // Capitán (a pedido: "agrega el capitan ese dato si lo manda con una
        // (c) en las alineaciones") — sí lo manda, en games.captain, un
        // booleano propio de este partido puntual (no es un dato fijo del
        // jugador: el capitán puede cambiar partido a partido).
        capitan: s.games?.captain ?? false,
      });
    });
  });
  return mapa;
}

// Doble amarilla / roja directa / autogol por jugador, a partir de la misma
// lista `eventos` que ya arma obtenerDetalleFixture (evita pedir el partido
// de nuevo). Se usa el texto crudo `detalle` (no la `clase` ya simplificada)
// porque "Second Yellow card" y "Red Card" necesitan tratamiento DISTINTO acá
// (-2 vs -4) aunque en el resumen del partido las dos se pinten como roja.
function marcasDisciplinariasPorJugador(eventos) {
  const dobleAmarilla = new Set();
  const rojaDirecta = new Set();
  const autogoles = new Map();
  (eventos || []).forEach((ev) => {
    if (ev.jugadorId == null) return;
    if (ev.detalle === 'Second Yellow card') dobleAmarilla.add(ev.jugadorId);
    else if (ev.detalle === 'Red Card') rojaDirecta.add(ev.jugadorId);
    else if (ev.clase === 'autogol') autogoles.set(ev.jugadorId, (autogoles.get(ev.jugadorId) || 0) + 1);
  });
  return { dobleAmarilla, rojaDirecta, autogoles };
}

// ---------- Alineación PROBABLE (a pedido: "cuando el partido no ha
// empezado, cargar aquí las alineaciones probables, la última alineación
// que jugó el equipo") ----------
// API-Football no publica la alineación oficial hasta ~1h antes del
// partido (a veces más tarde). Mientras tanto, se usa como estimación la
// alineación del ÚLTIMO partido jugado por el equipo. Dos llamadas: 1)
// /fixtures?team=&last= para encontrar cuál fue ese último partido
// (last=8 por el mismo motivo que obtenerFichaClub: puede haber uno en
// vivo/programado mezclado que hay que descartar), 2) /fixtures?id= de
// ESE fixture puntual para sacar su alineación (la primera llamada no
// trae lineups). Se cachea por equipo: la alineación de un partido ya
// jugado no cambia nunca.
const CACHE_PROBABLE_MS = 6 * 60 * 60 * 1000; // 6 horas
const cacheProbable = new Map(); // teamId -> { datos, expira }

async function obtenerAlineacionProbable(teamId) {
  const clave = String(teamId);
  const enCache = cacheProbable.get(clave);
  if (enCache && enCache.expira > Date.now()) return enCache.datos;

  try {
    const resp = await fetch(`${BASE}/fixtures?team=${teamId}&last=8`, { headers });
    const data = await resp.json();
    const ESTADOS_FINALIZADO = new Set(['FT', 'AET', 'PEN']);
    const anteriores = (data?.response || [])
      .filter((fx) => ESTADOS_FINALIZADO.has(fx.fixture?.status?.short))
      .sort((a, b) => String(b.fixture?.date || '').localeCompare(String(a.fixture?.date || '')));
    const ultimoFixtureId = anteriores[0]?.fixture?.id;
    if (!ultimoFixtureId) return null;

    const resp2 = await fetch(`${BASE}/fixtures?id=${ultimoFixtureId}`, { headers });
    const data2 = await resp2.json();
    const fx = data2?.response?.[0];
    const lineup = (fx?.lineups || []).find((l) => l.team?.id === Number(teamId));
    if (!lineup) return null;

    const armarJugadorProbable = (x) => ({
      id: x.player?.id ?? null,
      nombre: x.player?.name || '',
      numero: x.player?.number ?? null,
      posicion: x.player?.pos || null,
      grid: x.player?.grid || null,
    });
    const resultado = {
      equipoId: lineup.team?.id ?? null,
      equipo: lineup.team?.name || '',
      escudo: lineup.team?.logo || null,
      formacion: lineup.formation || null,
      entrenador: lineup.coach?.name || null,
      titulares: (lineup.startXI || []).map(armarJugadorProbable),
      suplentes: (lineup.substitutes || []).map(armarJugadorProbable),
      // Marca para que el frontend avise "alineación probable" en vez de
      // dar a entender que es la oficial confirmada de este partido.
      probable: true,
    };
    cacheProbable.set(clave, { datos: resultado, expira: Date.now() + CACHE_PROBABLE_MS });
    return resultado;
  } catch (e) {
    console.error(`[obtenerAlineacionProbable] Error con el equipo ${teamId}:`, e);
    return null;
  }
}

// ---------- Detalle completo de un partido (usado por /detalle-partido) ----------
// Una sola llamada a /fixtures?id= ya trae events + lineups + statistics, así
// que no hace falta pegarle a tres endpoints distintos (y gastar 3 consultas
// de la cuota) para armar las pestañas Resumen y Alineaciones de la app.
async function obtenerDetalleFixture(fixtureId) {
  const resp = await fetch(`${BASE}/fixtures?id=${fixtureId}`, { headers });
  const data = await resp.json();
  const fx = data?.response?.[0];
  if (!fx) return null;

  const idLocal = fx.teams?.home?.id;

  // Eventos ordenados cronológicamente, ya traducidos a algo que la app
  // pueda pintar directo (tipo + texto), en vez del vocabulario crudo de la
  // API ("Goal"/"subst"/"Card"/"Var").
  const golesAnuladosDetalle = construirSetGolesAnulados(fx.events || []);
  const eventos = (fx.events || [])
    // Tanda de penales (a pedido): estos pateos NO van en la línea de tiempo
    // del partido — "acá solo van goles en tiempo de juego con o sin
    // alargue". Se sacan de acá y se arman aparte más abajo (tandaPenales).
    .filter((ev) => !esEventoDeTandaPenales(ev))
    // Gol anulado por VAR (a pedido, bug reportado: "queda el gol impreso
    // en el resumen del partido, lo tiene que eliminar"): se saca el evento
    // "Goal" original — el evento "Var" que lo anuló se mantiene y es el
    // que el frontend expande en "Revisando gol por el VAR" + "Gol anulado
    // por el VAR" (ver ResumenEventos en sementomvp.jsx).
    .filter((ev) => !(ev.type === 'Goal' && golesAnuladosDetalle.has(claveEventoGolVar(ev))))
    .map((ev) => {
      const tipo = (ev.type || '').toLowerCase();
      const detalle = ev.detail || '';
      let clase = 'otro';
      if (tipo === 'goal') clase = detalle === 'Missed Penalty' ? 'penal_errado' : detalle === 'Own Goal' ? 'autogol' : detalle === 'Penalty' ? 'penal' : 'gol';
      else if (tipo === 'card') clase = detalle === 'Red Card' ? 'roja' : 'amarilla';
      else if (tipo === 'subst') clase = 'cambio';
      // VAR (a pedido): cuando la revisión es sobre un gol, se distingue si
      // terminó ANULADO ("Goal Disallowed - Offside", "Goal cancelled",
      // etc.) o CONFIRMADO ("Goal confirmed") — cada uno con su propia
      // clase para que el frontend pinte las dos líneas correspondientes
      // ("Revisando gol por el VAR" + "Gol anulado/validado por el VAR")
      // en vez de la genérica "Revisión". Cualquier otra revisión VAR (de
      // un penal, una tarjeta) que no sea sobre un gol queda como 'var'
      // genérica, tal como antes.
      else if (tipo === 'var') {
        clase = esVarSobreGol(ev, PATRON_GOL_ANULADO) ? 'gol_anulado'
          : esVarSobreGol(ev, PATRON_GOL_CONFIRMADO) ? 'gol_confirmado'
          : 'var';
      }
      return {
        minuto: ev.time?.elapsed != null ? ev.time.elapsed + (ev.time?.extra || 0) : null,
        clase,
        detalle,
        // En un cambio, "player" es el que ENTRA y "assist" el que sale.
        jugador: ev.player?.name || null,
        secundario: ev.assist?.name || null,
        // Los ids son lo que permite cruzar el evento con el jugador de la
        // alineación. Cruzar por NOMBRE no sirve: API-Football manda
        // "G. Ávalos" en la alineación y "Gabriel Ávalos" en el evento según
        // el caso, y con acentos y apellidos compuestos eso falla seguido.
        jugadorId: ev.player?.id ?? null,
        secundarioId: ev.assist?.id ?? null,
        esLocal: ev.team?.id === idLocal,
        equipo: ev.team?.name || null,
      };
    }).sort((a, b) => (a.minuto ?? 999) - (b.minuto ?? 999));

  // Tanda de penales, aparte (a pedido: "los goleadores de los penales van
  // abajo en el resumen del partido"). Orden = el mismo que mandó la API
  // (elapsed creciente 121, 122, 123...), que es el orden real de los
  // pateos.
  const tandaPenales = (fx.events || [])
    .filter(esEventoDeTandaPenales)
    .map((ev) => ({
      jugador: ev.player?.name || null,
      convertido: ev.detail !== 'Missed Penalty',
      esLocal: ev.team?.id === idLocal,
      orden: ev.time?.elapsed ?? 999,
    }))
    .sort((a, b) => a.orden - b.orden);

  // Alineación PROBABLE (a pedido): si el partido todavía no arrancó,
  // API-Football todavía no publicó la oficial — se completa con la última
  // alineación jugada por cada equipo (ver obtenerAlineacionProbable más
  // arriba). Se calcula ACÁ arriba (antes de armar jugadores) porque
  // `partidoNoArranco` también decide si tiene sentido pedir estadísticas
  // para la nota Demaster.app (ver bloque siguiente): sin alineación
  // oficial no hay minutos/rating que traer todavía.
  const idVisita = fx.teams?.away?.id;
  const estadoCorto = fx.fixture?.status?.short || null;
  const partidoNoArranco = ['NS', 'TBD', 'PST'].includes(estadoCorto);

  // Nota Demaster.app (a pedido: "agregar a cada jugador de los partidos una
  // nota demaster.app en base a esto" — sistema de Comunio, ver
  // calcularNotaDemaster más arriba). Se pide UNA vez para todo el partido
  // (no por jugador) y se cruza acá con cada ficha.
  const statsJugadores = partidoNoArranco ? new Map() : await obtenerEstadisticasJugadores(fixtureId);
  const marcasDisciplinarias = marcasDisciplinariasPorJugador(eventos);

  // El id de cada jugador vale triple: cruza los eventos (goles, tarjetas,
  // cambios) con su ficha en la cancha, arma la URL de su foto en el CDN de
  // API-Football (media.api-sports.io/football/players/<id>.png, estático,
  // no gasta cuota), y cruza con `statsJugadores` para la nota.
  //
  // `idsQueEntraron`: ids de los suplentes que SÍ pisaron la cancha (mismo
  // cálculo que usa el frontend en JugadoresSinEntrar/CambiosDelPartido:
  // el que entra en un evento "cambio" es `secundarioId`) — hace falta para
  // saber a quién de los suplentes le corresponde el 6.5 de abajo. Al que
  // se quedó en el banco sin jugar nunca no se le inventa nota.
  const idsQueEntraron = new Set(
    eventos.filter((ev) => ev.clase === 'cambio' && ev.secundarioId != null).map((ev) => ev.secundarioId)
  );

  // `hayDatosRating`: si NINGÚN jugador de todo el partido tiene rating,
  // API-Football directamente no tiene datos de este partido (a pedido:
  // "cuando la api no tiene el rating del partido no pongas nada de notas y
  // tampoco imprimas el jugador del partido, no hay datos" — visto en
  // Belgrano-Independiente Rivadavia y Newell's-Riestra, FT pero con
  // stats.rating null para TODOS). En ese caso no se inventa ningún 6.5 —
  // ni para titulares ni para los que entraron — para no simular datos que
  // no existen. Con todos en null, jugadorDestacadoId más abajo también
  // queda en null solo, así que el módulo "Jugador del partido" del
  // frontend ya no se muestra sin tocar nada ahí.
  const hayDatosRating = [...statsJugadores.values()].some((s) => s.rating != null);

  // `esTitular` / `idsQueEntraron` (a pedido, corrección: "cuando un jugador
  // no tiene nota de la api dale el 6.5... todos los jugadores que aparecen
  // en la api tienen nota" — antes el 6.5 de arranque solo se aplicaba a
  // titulares; ahora también a un suplente que entró y a quien se le perdió
  // el rating individual, ej. A. Manas). El 6.5 (mismo valor que usa Comunio,
  // "todos los jugadores empiezan los partidos con una nota de 6,5") NO se
  // aplica a un suplente que nunca entró — no hay forma de saber si jugó o
  // no, mejor no inventarle nota a quien quizás ni pisó la cancha.
  const armarJugador = (x, esTitular) => {
    const id = x.player?.id ?? null;
    const posicion = x.player?.pos || null;
    const stats = id != null ? statsJugadores.get(id) : null;
    // Ya no se filtra por minutos acá (a pedido: "la api ya discrimina por
    // la cantidad de minutos mínimos, así que si el jugador tiene el dato
    // de su rating en la api lo imprimes") — si API-Football mandó un
    // rating es porque decidió que jugó lo suficiente; confiamos en eso.
    let notaDemaster = null;
    if (stats && stats.rating != null) {
      notaDemaster = calcularNotaDemaster({ rating: stats.rating });
    } else if (hayDatosRating && (esTitular || idsQueEntraron.has(id))) {
      notaDemaster = 6.5;
    }
    return {
      id,
      nombre: x.player?.name || '',
      numero: x.player?.number ?? null,
      posicion,
      grid: x.player?.grid || null,
      notaDemaster,
      // Capitán (a pedido: "agrega el capitan ese dato si lo manda con una
      // (c) en las alineaciones") — sale de /fixtures/players (ver
      // obtenerEstadisticasJugadores), por eso solo se sabe una vez que el
      // partido arrancó y hay stats; antes de eso (alineación probable)
      // queda en false, ya que ese dato es específico de ESTE partido.
      capitan: stats?.capitan || false,
      // Jugador destacado del partido (ver más abajo, después de armar las
      // dos alineaciones) — arranca en false acá, se corrige a true en el
      // ganador una vez que se conocen todas las notas del partido.
      destacado: false,
    };
  };

  const armarAlineacion = (l) => l ? {
    equipoId: l.team?.id ?? null,
    equipo: l.team?.name || '',
    escudo: l.team?.logo || null,
    formacion: l.formation || null,
    entrenador: l.coach?.name || null,
    // `grid` viene como "fila:columna" (ej. "1:1" el arquero, "2:3" el tercer
    // defensor contando desde un costado). Es lo que permite dibujar la
    // alineación sobre una cancha en vez de listarla en texto: el string de
    // formación ("4-4-2") dice cuántos van en cada línea pero no ubica a
    // nadie, y hay esquemas donde no alcanza (un 4-2-3-1 con un enganche
    // corrido, por ejemplo). API-Football no siempre lo manda —en ligas
    // chicas suele venir null—, así que el frontend cae al string de
    // formación cuando falta.
    titulares: (l.startXI || []).map((x) => armarJugador(x, true)),
    suplentes: (l.substitutes || []).map((x) => armarJugador(x, false)),
  } : null;

  const lineups = fx.lineups || [];
  let alineacionLocal = armarAlineacion(lineups.find((l) => l.team?.id === idLocal));
  let alineacionVisita = armarAlineacion(lineups.find((l) => l.team?.id !== idLocal));

  if (partidoNoArranco) {
    if (!alineacionLocal && idLocal) {
      alineacionLocal = await obtenerAlineacionProbable(idLocal);
    }
    if (!alineacionVisita && idVisita) {
      alineacionVisita = await obtenerAlineacionProbable(idVisita);
    }
  }

  const estadisticas = extraerEstadisticas(fx, idLocal);

  // JUGADOR DESTACADO / MVP del partido (a pedido: "el jugador del partido
  // me parece que lo informa la api, debes marcarlo en alineaciones con un
  // icono destacado" — se revisó con /diagnostico-partido el objeto CRUDO
  // que manda /fixtures/players y API-Football NO trae ningún campo propio
  // de "jugador destacado"/MVP, así que se calcula acá: uno solo por
  // partido, el de mayor notaDemaster entre los dos equipos, titular o
  // suplente que haya entrado (confirmado con Pablo — la otra opción era
  // uno por equipo). Ante empate gana el primero encontrado.
  let jugadorDestacadoId = null;
  const todosLosJugadores = [
    ...(alineacionLocal?.titulares || []),
    ...(alineacionLocal?.suplentes || []),
    ...(alineacionVisita?.titulares || []),
    ...(alineacionVisita?.suplentes || []),
  ];

  // Candidatos a destacado (a pedido, captura Limache 1-3 U. de Chile: "no
  // puede ser el mejor jugador del partido uno del equipo que pierde,
  // corregir" — salía elegido un jugador de Limache, el que perdió). Con
  // ganador claro, se descarta directo al equipo que pierde de la elección;
  // en empate (o sin marcador todavía) se sigue mirando a los dos equipos,
  // como antes.
  const golesLocalFinal = fx.goals?.home;
  const golesVisitaFinal = fx.goals?.away;
  const hayGanador = golesLocalFinal != null && golesVisitaFinal != null && golesLocalFinal !== golesVisitaFinal;
  const candidatosDestacado = hayGanador
    ? (golesLocalFinal > golesVisitaFinal
        ? [...(alineacionLocal?.titulares || []), ...(alineacionLocal?.suplentes || [])]
        : [...(alineacionVisita?.titulares || []), ...(alineacionVisita?.suplentes || [])])
    : todosLosJugadores;

  let mejorNota = null;
  candidatosDestacado.forEach((j) => {
    if (j.notaDemaster != null && (mejorNota == null || j.notaDemaster > mejorNota)) {
      mejorNota = j.notaDemaster;
      jugadorDestacadoId = j.id;
    }
  });
  if (jugadorDestacadoId != null) {
    todosLosJugadores.forEach((j) => { j.destacado = j.id === jugadorDestacadoId; });
  }

  return {
    equipoLocal: fx.teams?.home?.name || '',
    equipoVisita: fx.teams?.away?.name || '',
    // Ids de equipo: los usa la app para abrir la ficha del club y para el
    // escudo del CDN (media.api-sports.io/football/teams/<id>.png).
    equipoLocalId: fx.teams?.home?.id ?? null,
    equipoVisitaId: fx.teams?.away?.id ?? null,
    eventos,
    tandaPenales,
    alineacionLocal,
    alineacionVisita,
    estadisticas,
    jugadorDestacadoId,
  };
}

// ============================================================
// FICHA DE JUGADOR
// ============================================================
// Dos llamadas: el perfil (/players/profiles) y el historial de traspasos
// (/transfers). Se piden en PARALELO con Promise.all — en serie la ficha
// tardaría el doble en abrirse, y son independientes entre sí.
//
// Se usa /players/profiles y no /players?id=&season= porque este último
// obliga a mandar una temporada y devuelve las estadísticas de ESA temporada;
// para la ficha solo se necesitan los datos personales, que no dependen del
// año, y así no hay que adivinar en qué temporada está jugando.
async function obtenerFichaJugador(playerId) {
  const [respPerfil, respTransferencias] = await Promise.all([
    fetch(`${BASE}/players/profiles?player=${playerId}`, { headers }),
    fetch(`${BASE}/transfers?player=${playerId}`, { headers }),
  ]);
  const dataPerfil = await respPerfil.json();
  const dataTransferencias = await respTransferencias.json();

  const p = dataPerfil?.response?.[0]?.player;
  if (!p) return null;

  // Los traspasos vienen agrupados por jugador, y adentro una lista por
  // fecha. Se aplanan y se ordenan del más nuevo al más viejo, que es como
  // se lee un historial.
  const transferencias = (dataTransferencias?.response || [])
    .flatMap((r) => r.transfers || [])
    .map((t) => ({
      fecha: t.date || null,
      // "type" trae el monto cuando la operación fue con dinero ("€ 2.5M"),
      // o "Free"/"Loan" cuando no. Se pasa tal cual: traducirlo acá sería
      // adivinar formatos de una API que no los documenta del todo.
      tipo: t.type || null,
      desde: t.teams?.out?.name || null,
      desdeId: t.teams?.out?.id ?? null,
      hasta: t.teams?.in?.name || null,
      hastaId: t.teams?.in?.id ?? null,
    }))
    .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));

  return {
    id: p.id,
    nombre: p.name || [p.firstname, p.lastname].filter(Boolean).join(' '),
    nombreCompleto: [p.firstname, p.lastname].filter(Boolean).join(' '),
    foto: p.photo || null,
    edad: p.age ?? null,
    nacimiento: p.birth?.date || null,
    paisNacimiento: p.birth?.country || null,
    nacionalidad: p.nationality || null,
    altura: p.height || null,
    peso: p.weight || null,
    posicion: p.position || null,
    numero: p.number ?? null,
    transferencias,
  };
}

// ============================================================
// PERFIL BÁSICO DE JUGADOR (solo edad + nacionalidad, en lote)
// ============================================================
// Para los filtros de "nacionalidad" y "edad" sobre la cancha (a pedido):
// la alineación de /fixtures NO trae ni edad ni nacionalidad (armarJugador
// más arriba solo tiene id/nombre/número/posición/grid) — ese dato solo
// sale de /players/profiles, UN jugador a la vez. Con 18-20 jugadores por
// equipo eso son hasta 40 llamadas por partido, así que se cachea agresivo
// (30 días: la edad de un jugador no cambia de un partido a otro) y se
// pide en paralelo — ver rutaPerfilesJugadores en rutas/equiposIds.js.
const CACHE_PERFIL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JUGADORES_EN_CACHE = 3000;
const cachePerfilesJugador = new Map(); // playerId -> { datos, expira }

async function obtenerPerfilBasicoJugador(playerId) {
  const clave = String(playerId);
  const enCache = cachePerfilesJugador.get(clave);
  if (enCache && enCache.expira > Date.now()) return enCache.datos;

  const resp = await fetch(`${BASE}/players/profiles?player=${playerId}`, { headers });
  const data = await resp.json();
  const p = data?.response?.[0]?.player;
  if (!p) {
    // Diagnóstico (bug real, confirmado en logs: "rateLimit: Too many
    // requests. You have reached your per-minute request limit") — antes
    // acá se devolvía null en silencio para CUALQUIER motivo, mezclando
    // "este jugador puntual no tiene perfil en la API" (definitivo, no
    // tiene sentido reintentar) con "nos pasamos del límite por minuto de
    // API-Football" (transitorio — el jugador SÍ tiene perfil, solo hay que
    // esperar y volver a pedirlo). Sin esta distinción, /refrescar-planteles
    // marcaba como "sin resolver" a jugadores que en realidad solo cayeron
    // en la ventana de 1 minuto equivocada. Ahora el caso de rate limit
    // tira una excepción marcada (`.esRateLimit`) para que el que llama
    // pueda esperar y reintentar en vez de darlo por perdido.
    const restante = resp.headers.get('x-ratelimit-requests-remaining');
    const erroresApi = data?.errors;
    const esRateLimit = !!(erroresApi && (erroresApi.rateLimit || erroresApi.requests));
    console.error(
      `[obtenerPerfilBasicoJugador] Sin perfil para el jugador ${playerId}. ` +
      `errors=${JSON.stringify(erroresApi ?? null)} results=${data?.results ?? 'n/a'} ` +
      `cuotaRestante=${restante ?? 'desconocida'}`
    );
    if (esRateLimit) {
      const err = new Error('API-Football: límite de pedidos por minuto alcanzado.');
      err.esRateLimit = true;
      throw err;
    }
    return null;
  }

  const perfil = {
    id: p.id,
    edad: p.age ?? null,
    nacionalidad: p.nationality || null,
    // firstname/lastname (a pedido, base propia de jugadores): a diferencia
    // de /players/squads (que solo trae un `name` plano, imposible de
    // partir en nombre/apellido a ciegas — ver nombreCortoDesdeFirstLast
    // más abajo), /players/profiles SÍ separa nombre de apellido. Ya
    // veníamos pidiendo este mismo endpoint acá, así que sumar estos dos
    // campos no cuesta ninguna llamada extra.
    firstname: p.firstname || null,
    lastname: p.lastname || null,
  };

  if (cachePerfilesJugador.size >= MAX_JUGADORES_EN_CACHE) {
    cachePerfilesJugador.delete(cachePerfilesJugador.keys().next().value);
  }
  cachePerfilesJugador.set(clave, { datos: perfil, expira: Date.now() + CACHE_PERFIL_MS });

  return perfil;
}

// "Primer nombre + primer apellido" calculado desde el firstname/lastname
// YA SEPARADOS por API-Football (/players/profiles) — a diferencia de
// adivinar por posición de palabra sobre un nombre plano (bug reportado:
// "Fernando Matías Zampedri" -> "Fernando Matías", "Diego Jose Valencia
// Morello" -> "Diego Morello"), esto no puede fallar por ambigüedad porque
// la API ya nos dice dónde termina el nombre y dónde empieza el apellido.
// Solo nos quedamos con la PRIMERA palabra de cada lado, por si alguno
// trae compuesto ("Diego Jose" / "Valencia Morello") — así el resultado
// siempre son dos palabras, prolijo para la pestaña Plantel y la ficha.
function nombreCortoDesdeFirstLast(firstname, lastname) {
  const primerNombre = String(firstname || '').trim().split(/\s+/)[0] || '';
  const primerApellido = String(lastname || '').trim().split(/\s+/)[0] || '';
  const resultado = [primerNombre, primerApellido].filter(Boolean).join(' ');
  return resultado || null;
}

// ============================================================
// FICHA DE CLUB
// ============================================================
// Una sola llamada: /fixtures?team=&last=5 ya trae los últimos 5 partidos
// jugados con marcador y rival. El escudo y los datos del club vienen dentro
// de esos mismos fixtures, así que no hace falta pedir /teams aparte y gastar
// una segunda consulta.
// La caché vive ACÁ y no en la ruta a propósito: la usan dos endpoints
// distintos (/club, que abre la ficha, y /forma, que dibuja la tira de
// últimos resultados en cada tarjeta de partido). Si estuviera en /club,
// /forma la saltaría y una sola pantalla de Partidos dispararía 30 consultas
// a API-Football cada vez que alguien la abre.
//
// 30 minutos: los últimos 5 partidos solo cambian cuando termina uno.
const CACHE_CLUB_MS = 30 * 60 * 1000;
const MAX_CLUBES_EN_CACHE = 500;
const cacheClubes = new Map(); // teamId -> { datos, expira }

async function obtenerFichaClub(teamId) {
  const clave = String(teamId);
  const enCache = cacheClubes.get(clave);
  if (enCache && enCache.expira > Date.now()) return enCache.datos;

  // Se pide de a 15 (no 5): "last=5" de API-Football cuenta por fecha de
  // partido, así que si hay uno en vivo o recién terminado sin resultado
  // todavía cargado, entra en el lote y desplaza a uno de verdad jugado.
  // Acá abajo se filtra a solo los FINALIZADOS y recién ahí se cortan los
  // últimos 5 reales.
  const resp = await fetch(`${BASE}/fixtures?team=${teamId}&last=15`, { headers });
  const data = await resp.json();
  const todosFixtures = data?.response || [];
  if (todosFixtures.length === 0) return null;

  // Solo partidos ya TERMINADOS (FT = tiempo reglamentario, AET = alargue,
  // PEN = penales). Uno en vivo (1H/2H/HT/ET/LIVE/BT/P) o programado (NS,
  // TBD) no es un resultado real todavía y no debe aparecer en "Últimos 5".
  const ESTADOS_FINALIZADO = new Set(['FT', 'AET', 'PEN']);
  const fixtures = todosFixtures
    .filter((fx) => ESTADOS_FINALIZADO.has(fx.fixture?.status?.short))
    .sort((a, b) => String(b.fixture?.date || '').localeCompare(String(a.fixture?.date || '')))
    .slice(0, 5);
  if (fixtures.length === 0) return null;

  const idNum = Number(teamId);
  // El nombre y el escudo salen del primer partido: en todos aparece el
  // equipo, sea de local o de visita.
  const primero = fixtures[0];
  const esLocalEnPrimero = primero.teams?.home?.id === idNum;
  const propio = esLocalEnPrimero ? primero.teams?.home : primero.teams?.away;

  // País del club. Se saca de la competencia de sus últimos partidos, que ya
  // vienen en esta misma respuesta — pedir /teams?id= sería una llamada extra
  // por el mismo dato.
  // Se descartan los torneos internacionales (Libertadores, Sudamericana,
  // Champions), donde league.country es "World" y no dice de dónde es el
  // equipo. Entre los que quedan se toma el más frecuente.
  const conteoPaises = {};
  fixtures.forEach((fx) => {
    const p = fx.league?.country;
    if (!p || p === 'World') return;
    conteoPaises[p] = (conteoPaises[p] || 0) + 1;
  });
  const pais = Object.entries(conteoPaises).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const partidos = fixtures.map((fx) => {
    const esLocal = fx.teams?.home?.id === idNum;
    const golesPropios = esLocal ? fx.goals?.home : fx.goals?.away;
    const golesRival = esLocal ? fx.goals?.away : fx.goals?.home;
    const rival = esLocal ? fx.teams?.away : fx.teams?.home;
    // Resultado desde el punto de vista de ESTE club: V / E / P. Calcularlo
    // acá y no en el frontend evita repetir la lógica de "¿era local?" en
    // cada lugar donde se muestre.
    let resultado = null;
    if (golesPropios != null && golesRival != null) {
      resultado = golesPropios > golesRival ? 'V' : golesPropios < golesRival ? 'P' : 'E';
    }
    return {
      // fixtureId (a pedido, ficha de club -> gráfico de momentum): el id de
      // API-Football de ESTE partido puntual — el frontend lo cruza contra
      // desafios_mvp.fixture_id_api para encontrar el desafio_id y así poder
      // pedir /momentum?desafioId=. Puede no calzar con ningún desafio
      // nuestro (partidos que Demaster-app nunca trackeó): en ese caso el
      // frontend simplemente no dibuja el gráfico para esa fila.
      fixtureId: fx.fixture?.id ?? null,
      fecha: fx.fixture?.date || null,
      estado: fx.fixture?.status?.short || null,
      competencia: fx.league?.name || null,
      esLocal,
      rival: rival?.name || null,
      rivalId: rival?.id ?? null,
      golesPropios: golesPropios ?? null,
      golesRival: golesRival ?? null,
      // Los dos equipos en su orden real (local primero), además del punto de
      // vista propio de arriba. Sin esto, la app no puede mostrar el partido
      // como se lee en cualquier diario —"Rosario Central 1-2 Belgrano"—:
      // tendría que deducir el orden y a veces lo daría vuelta.
      local: (esLocal ? propio : rival)?.name || null,
      visita: (esLocal ? rival : propio)?.name || null,
      localId: (esLocal ? propio : rival)?.id ?? null,
      visitaId: (esLocal ? rival : propio)?.id ?? null,
      golesLocal: fx.goals?.home ?? null,
      golesVisita: fx.goals?.away ?? null,
      resultado,
    };
  }).sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));

  const ficha = {
    id: idNum,
    nombre: propio?.name || '',
    escudo: propio?.logo || null,
    pais,
    partidos,
  };

  // Tope de entradas para que el proceso no crezca sin límite si alguien
  // recorre cientos de clubes. Map conserva el orden de inserción, así que
  // se descarta el más viejo.
  if (cacheClubes.size >= MAX_CLUBES_EN_CACHE) {
    cacheClubes.delete(cacheClubes.keys().next().value);
  }
  cacheClubes.set(clave, { datos: ficha, expira: Date.now() + CACHE_CLUB_MS });

  return ficha;
}

// ---------- Plantel de un club (a pedido, ficha de equipo -> pestaña
// "Plantel"): entrenador actual + jugadores agrupados por posición. Dos
// llamadas en paralelo — /players/squads?team= (plantilla completa, con
// foto/dorsal/posición) y /coachs?team= (historial de entrenadores de ese
// club; nos quedamos con el que tiene la carrera ahí ABIERTA, sin `end`,
// que es el vigente). Caché larga (12 h): un plantel casi no cambia de una
// consulta a otra salvo ventana de pases, mucho menos frecuente que un
// resultado de partido.
const CACHE_PLANTEL_MS = 12 * 60 * 60 * 1000;
const MAX_PLANTELES_EN_CACHE = 300;
const cachePlanteles = new Map(); // teamId -> { datos, expira }

// Traduce la posición cruda de API-Football (siempre en inglés) al grupo en
// español que pide el diseño de la pestaña Plantel — en ESE orden:
// "delanteros, mediocampistas, defensas y arqueros".
const GRUPO_POR_POSICION = {
  Attacker: 'delanteros',
  Midfielder: 'mediocampistas',
  Defender: 'defensas',
  Goalkeeper: 'arqueros',
};

async function obtenerPlantelClub(teamId) {
  const clave = String(teamId);
  const enCache = cachePlanteles.get(clave);
  if (enCache && enCache.expira > Date.now()) return enCache.datos;

  // Secuencial a propósito (bug real: API-Football puede activar un BLOQUEO
  // TEMPORAL de la IP/API key si detecta ráfagas de pedidos simultáneos,
  // aunque el promedio por minuto esté bajo el límite del plan — ver
  // "how-ratelimit-works" en su doc. Antes acá se pedían squad + entrenador
  // EN PARALELO con Promise.all, lo que generaba justamente ese patrón de
  // ráfaga en cada equipo procesado. Ahora van uno después del otro).
  const respSquad = await fetch(`${BASE}/players/squads?team=${teamId}`, { headers });
  const dataSquad = await respSquad.json();
  const respCoach = await fetch(`${BASE}/coachs?team=${teamId}`, { headers });
  const dataCoach = await respCoach.json();

  // Diagnóstico + distinción rate-limit vs. sin-datos (mismo bug real que
  // obtenerPerfilBasicoJugador — ver esa función para el detalle completo):
  // varios de los "Sin plantel en API-Football" que salían en
  // /refrescar-planteles probablemente eran en realidad el límite de
  // pedidos por minuto, no equipos sin plantel de verdad.
  const erroresSquad = dataSquad?.errors;
  if (erroresSquad && (erroresSquad.rateLimit || erroresSquad.requests)) {
    console.error(`[obtenerPlantelClub] Rate limit pidiendo el plantel del equipo ${teamId}: ${JSON.stringify(erroresSquad)}`);
    const err = new Error('API-Football: límite de pedidos por minuto alcanzado.');
    err.esRateLimit = true;
    throw err;
  }

  const jugadoresCrudos = dataSquad?.response?.[0]?.players || [];
  if (jugadoresCrudos.length === 0) return null;

  const grupos = { delanteros: [], mediocampistas: [], defensas: [], arqueros: [] };
  jugadoresCrudos.forEach((j) => {
    const grupo = GRUPO_POR_POSICION[j.position] || null;
    // Posición desconocida/no mapeada (rarísimo, pero puede pasar con
    // datos incompletos de la API): mejor no imprimir ese jugador que
    // reventar el módulo entero con un grupo inexistente.
    if (!grupo) return;
    grupos[grupo].push({
      id: j.id,
      nombre: j.name || null,
      numero: j.number ?? null,
      foto: j.photo || null,
    });
  });
  // Orden por dorsal dentro de cada grupo (sin número quedan al final).
  Object.values(grupos).forEach((lista) => lista.sort((a, b) => (a.numero ?? 999) - (b.numero ?? 999)));

  const coachesCrudos = dataCoach?.response || [];
  const idNum = Number(teamId);
  const coachActual = coachesCrudos.find((c) =>
    Array.isArray(c.career) && c.career.some((ce) => ce.team?.id === idNum && !ce.end)
  ) || coachesCrudos[0] || null;

  const entrenador = coachActual ? {
    nombre: [coachActual.firstname, coachActual.lastname].filter(Boolean).join(' ') || coachActual.name || null,
    foto: coachActual.photo || null,
  } : null;

  const plantel = { entrenador, ...grupos };

  if (cachePlanteles.size >= MAX_PLANTELES_EN_CACHE) {
    cachePlanteles.delete(cachePlanteles.keys().next().value);
  }
  cachePlanteles.set(clave, { datos: plantel, expira: Date.now() + CACHE_PLANTEL_MS });

  return plantel;
}

module.exports = { obtenerCuotas, obtenerEstadoFixture, obtenerDatosVenue, obtenerDatosVenuePorNombre, obtenerVenueDeEquipo, obtenerFixturesDeLiga, obtenerEquiposDeLiga, obtenerPosicionesDeLiga, obtenerDetalleFixture, obtenerFichaJugador, obtenerFichaClub, obtenerPlantelClub, obtenerPerfilBasicoJugador, nombreCortoDesdeFirstLast, obtenerHeadToHead, obtenerLesionados,
  // Exportados para /diagnostico-partido (a pedido: "veamos el cálculo de
  // ese partido en particular para ver dónde está el error") — sin esto no
  // hay forma de ver desde afuera los números CRUDOS que arma la nota.
  obtenerEstadisticasJugadores, calcularNotaDemaster, marcasDisciplinariasPorJugador };
