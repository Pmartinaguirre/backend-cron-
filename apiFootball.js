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
  const bookmakers = data?.response?.[0]?.bookmakers || [];

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
  //     lo hizo en contra, pero el gol cuenta para el RIVAL. Antes se
  //     asignaba al equipo del jugador, o sea al equipo equivocado. Ahora se
  //     invierte el lado.
  //
  // Se guarda además "tipo" ('normal' | 'penal' | 'autogol') para que la
  // tarjeta pueda marcarlos distinto, y el minuto suma el tiempo añadido
  // (ev.time.extra) para que un gol al 90+3 salga como 93' y quede bien
  // ordenado en la línea de tiempo.
  const idEquipoLocal = fixture.teams?.home?.id;
  const eventos = fixture.events || [];
  const goleadoresLocal = [];
  const goleadoresVisita = [];
  eventos
    .filter((ev) => ev.type === 'Goal' && ev.detail !== 'Missed Penalty')
    .forEach((ev) => {
      const esAutogol = ev.detail === 'Own Goal';
      const esPenal = ev.detail === 'Penalty';
      const minutoBase = ev.time?.elapsed ?? null;
      const entrada = {
        nombre: ev.player?.name || 'Gol',
        minuto: minutoBase != null ? minutoBase + (ev.time?.extra || 0) : null,
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

  return {
    estado,
    minuto,
    minutoExtra,
    fechaISO,
    golesLocal,
    golesVisita,
    goleadoresLocal,
    goleadoresVisita,
  };
}

// ---------- Fixtures de una liga completa (usado por /crear-partidos) ----------
async function obtenerFixturesDeLiga(leagueId, season) {
  const resp = await fetch(`${BASE}/fixtures?league=${leagueId}&season=${season}`, { headers });
  const data = await resp.json();
  return data?.response || [];
}

// ---------- Equipos de una liga (usado por /equipos, para el selector Tier A del Admin) ----------
async function obtenerEquiposDeLiga(leagueId, season) {
  const resp = await fetch(`${BASE}/teams?league=${leagueId}&season=${season}`, { headers });
  const data = await resp.json();
  const equipos = (data?.response || []).map((r) => r.team?.name).filter(Boolean);
  return equipos.sort((a, b) => a.localeCompare(b, 'es'));
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

  return { liga: league.name, logo: league.logo, temporada: league.season, grupos };
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
  const eventos = (fx.events || []).map((ev) => {
    const tipo = (ev.type || '').toLowerCase();
    const detalle = ev.detail || '';
    let clase = 'otro';
    if (tipo === 'goal') clase = detalle === 'Missed Penalty' ? 'penal_errado' : detalle === 'Own Goal' ? 'autogol' : detalle === 'Penalty' ? 'penal' : 'gol';
    else if (tipo === 'card') clase = detalle === 'Red Card' ? 'roja' : 'amarilla';
    else if (tipo === 'subst') clase = 'cambio';
    else if (tipo === 'var') clase = 'var';
    return {
      minuto: ev.time?.elapsed != null ? ev.time.elapsed + (ev.time?.extra || 0) : null,
      clase,
      detalle,
      // En un cambio, "player" es el que ENTRA y "assist" el que sale.
      jugador: ev.player?.name || null,
      secundario: ev.assist?.name || null,
      esLocal: ev.team?.id === idLocal,
      equipo: ev.team?.name || null,
    };
  }).sort((a, b) => (a.minuto ?? 999) - (b.minuto ?? 999));

  const armarAlineacion = (l) => l ? {
    equipo: l.team?.name || '',
    escudo: l.team?.logo || null,
    formacion: l.formation || null,
    entrenador: l.coach?.name || null,
    titulares: (l.startXI || []).map((x) => ({
      nombre: x.player?.name || '', numero: x.player?.number ?? null, posicion: x.player?.pos || null,
    })),
    suplentes: (l.substitutes || []).map((x) => ({
      nombre: x.player?.name || '', numero: x.player?.number ?? null, posicion: x.player?.pos || null,
    })),
  } : null;

  const lineups = fx.lineups || [];
  const alineacionLocal = armarAlineacion(lineups.find((l) => l.team?.id === idLocal));
  const alineacionVisita = armarAlineacion(lineups.find((l) => l.team?.id !== idLocal));

  // Estadísticas (tiros, posesión, corners...): vienen como pares
  // {type, value} por equipo. Se cruzan en una sola lista para que la app
  // pinte "local | concepto | visita" sin tener que emparejar nada.
  const statsLocal = (fx.statistics || []).find((s) => s.team?.id === idLocal)?.statistics || [];
  const statsVisita = (fx.statistics || []).find((s) => s.team?.id !== idLocal)?.statistics || [];
  const estadisticas = statsLocal.map((s) => ({
    concepto: s.type,
    local: s.value,
    visita: statsVisita.find((x) => x.type === s.type)?.value ?? null,
  }));

  return {
    equipoLocal: fx.teams?.home?.name || '',
    equipoVisita: fx.teams?.away?.name || '',
    eventos,
    alineacionLocal,
    alineacionVisita,
    estadisticas,
  };
}

module.exports = { obtenerCuotas, obtenerEstadoFixture, obtenerFixturesDeLiga, obtenerEquiposDeLiga, obtenerPosicionesDeLiga, obtenerDetalleFixture };
