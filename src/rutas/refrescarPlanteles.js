// GET/POST /refrescar-planteles — a pedido ("tenemos un total de equipos y
// jugadores controlable, me gustaría tener la bbdd de los jugadores con
// datos nuestros"). Pensado para correr 1 vez al día.
//
// Qué hace, en orden:
//   1) Junta el universo de equipos "controlables": los que tienen al
//      menos un desafío Cat.4/5 activo en desafios_mvp — el mismo criterio
//      que ya usa el resto del backend, no todo el fútbol mundial.
//   2) Para cada equipo, pide su plantel completo (obtenerPlantelClub, ya
//      cacheado 12h en apiFootball.js) y guarda:
//        - plantel_jugadores: se reemplaza ENTERO por equipo (borra +
//          inserta) — así un jugador transferido no queda pegado a un
//          equipo viejo. Esta tabla NO guarda nombre/foto (ver por qué en
//          el punto 3).
//        - entrenadores_equipo: upsert simple, 1 fila por equipo (también
//          sirve de "marcador de intento", ver ORDEN más abajo).
//   3) Resuelve el "nombre_corto" (primer nombre + primer apellido, bien
//      cortado) de los jugadores que todavía no lo tienen — ver el bug
//      real que motivó esto: adivinar por posición de palabra sobre el
//      nombre plano de /players/squads falla siempre ("Fernando Matías
//      Zampedri" -> "Fernando Matías", "Diego Jose Valencia Morello" ->
//      "Diego Morello"). La solución de verdad es pedirle a la API el
//      nombre YA separado (/players/profiles, vía obtenerPerfilBasicoJugador)
//      y guardarlo UNA sola vez por jugador en jugadores_perfil — de ahí en
//      más se lee de la base, nunca más se le vuelve a preguntar a la API
//      por ese mismo jugador. Por eso esto vive en jugadores_perfil (que
//      NUNCA se borra en bloque) y no en plantel_jugadores (que sí se
//      reemplaza entero cada corrida).
//
// FIRE-AND-FORGET (a pedido, bug reportado: "no aguanto más de 70 [nombres
// por corrida], con 100 se caía" — con 4200+ jugadores pendientes, a 70 por
// corrida hacían falta ~60 corridas manuales solo para el backfill inicial).
// El techo real NUNCA fue "cuánto podemos procesar" — era el timeout propio
// de cron-job.org (~30s), que corta la conexión si la respuesta HTTP tarda
// de más. La solución de fondo es dejar de atar el trabajo real a esa
// respuesta: acá se responde 200 OK de inmediato (cron-job.org queda
// contento) y TODO el trabajo (equipos + nombres) sigue corriendo en el
// mismo proceso de Node después de responder — Express no mata la función
// solo porque ya mandó la respuesta. El resultado final de cada corrida
// queda en los logs de Render (Dashboard → Logs), no en la respuesta HTTP
// (que ahora es solo un "recibido, arrancando"). Para ver el progreso real
// acumulado, la fuente de verdad es Supabase directo — ver el SELECT de
// ejemplo en el README.
//
// CONCURRENCIA (mismo pedido): además de sacarle el techo del timeout, se
// paraleliza el trabajo (varios equipos/jugadores a la vez en vez de uno
// por uno) para que además sea varias veces más rápido en tiempo real, no
// solo "sin límite de tiempo". Se mantiene una pausa chica entre pedidos de
// cada carril para no ráfaguear a API-Football de golpe.
const { supabase } = require('../supabaseClient');
const { obtenerPlantelClub, obtenerPerfilBasicoJugador, nombreCortoDesdeFirstLast } = require('../apiFootball');

// Ya no hace falta que estos topes quepan en 30s (ver FIRE-AND-FORGET
// arriba) — quedan como salvavidas de cordura (no procesar un volumen
// disparatado en una sola corrida) y para cuidar la cuota de API-Football,
// no por el timeout. Configurables por variable de entorno sin redeploy.
const MAX_EQUIPOS_POR_CORRIDA = Number(process.env.MAX_EQUIPOS_POR_CORRIDA_PLANTELES) || 60;
const MAX_JUGADORES_NUEVOS_POR_CORRIDA = Number(process.env.MAX_JUGADORES_NUEVOS_POR_CORRIDA_PLANTELES) || 1500;
const CONCURRENCIA_EQUIPOS = Number(process.env.CONCURRENCIA_EQUIPOS_PLANTELES) || 4;
const CONCURRENCIA_PERFILES = Number(process.env.CONCURRENCIA_PERFILES_PLANTELES) || 4;
const PAUSA_ENTRE_EQUIPOS_MS = 200;
const PAUSA_ENTRE_PERFILES_MS = 200;

// Log de arranque (bug real: "no puedo bajar de los 890 pendientes" — los
// números de la corrida mostraban que solo se procesaban ~90 jugadores por
// corrida en vez de hasta 1500, y la única explicación era una variable de
// entorno vieja en Render pisando el default sin que se viera desde ningún
// lado). Esto imprime el valor EFECTIVO de cada tope apenas arranca el
// proceso, así una variable de entorno colgada de una prueba vieja se detecta
// mirando los logs de Render, sin tener que adivinar comparando números.
console.log(
  `[/refrescar-planteles] Config efectiva al arrancar: MAX_EQUIPOS_POR_CORRIDA=${MAX_EQUIPOS_POR_CORRIDA} ` +
  `MAX_JUGADORES_NUEVOS_POR_CORRIDA=${MAX_JUGADORES_NUEVOS_POR_CORRIDA} CONCURRENCIA_EQUIPOS=${CONCURRENCIA_EQUIPOS} ` +
  `CONCURRENCIA_PERFILES=${CONCURRENCIA_PERFILES}`
);

function pausa(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// LIMITADOR DE RITMO GLOBAL (bug real, confirmado en logs de Render:
// "rateLimit: Too many requests. You have reached your per-minute request
// limit" — con concurrencia 4 y una pausa fija de 200ms POR CARRIL, esta
// corrida sola manda varios cientos de pedidos por minuto a API-Football,
// muy por encima de lo que el plan permite. Una vez que se pisa el límite,
// TODOS los pedidos del resto de esa ventana de 1 minuto fallan igual —por
// eso salieron 0 de 875 resueltos: el primero pisó el límite y arrastró a
// todo el resto). Además, esto le come cupo A LOS OTROS crons (/cuotas,
// /vivo, /resolver) que comparten la misma cuenta de API-Football.
//
// A diferencia de la pausa fija por carril (que solo espacia CADA CARRIL
// por separado, así que 4 carriles en paralelo igual pueden mandar 4
// pedidos casi juntos), esto es una cola COMPARTIDA entre todos los
// carriles: cada pedido, sin importar de qué carril venga, espera su turno
// en la MISMA fila antes de salir — así el total combinado nunca supera
// MAX_REQUESTS_POR_MINUTO, venga de donde venga.
//
// El default (120/min = 1 cada 500ms) es deliberadamente conservador
// porque no sabemos el límite real del plan — hay margen para subirlo por
// variable de entorno una vez confirmado cuánto permite de verdad (lo dice
// el mensaje de error de la API, o el soporte/dashboard de API-Football).
const MAX_REQUESTS_POR_MINUTO = Number(process.env.MAX_REQUESTS_POR_MINUTO_PLANTELES) || 120;
const INTERVALO_ENTRE_REQUESTS_MS = Math.max(50, Math.ceil(60000 / MAX_REQUESTS_POR_MINUTO));
let colaLimitador = Promise.resolve();
function limitarRitmo() {
  const turno = colaLimitador.then(() => pausa(INTERVALO_ENTRE_REQUESTS_MS));
  // No encadenar el rechazo (si lo hubiera) para que un turno no tumbe la
  // cola entera — pausa() nunca rechaza, así que esto es solo defensivo.
  colaLimitador = turno.catch(() => {});
  return turno;
}

// Mapea `items` con como mucho `concurrencia` tareas en simultáneo (patrón
// "pool de trabajadores": cada carril va tomando el siguiente item libre no
// bien termina el anterior, en vez de esperar a que TODOS terminen antes de
// arrancar el próximo lote como haría trocear en bloques fijos). Sin
// dependencias externas, a propósito — es lo único que hacía falta acá.
async function pMap(items, concurrencia, fn) {
  let siguiente = 0;
  async function trabajador() {
    while (siguiente < items.length) {
      const i = siguiente++;
      await fn(items[i], i);
    }
  }
  const carriles = Array.from({ length: Math.max(1, Math.min(concurrencia, items.length)) }, trabajador);
  await Promise.all(carriles);
}

// Si `fn` tira un error marcado `.esRateLimit` (ver obtenerPerfilBasicoJugador
// / obtenerPlantelClub en apiFootball.js), espera un buen rato y reintenta
// UNA vez — a diferencia de darlo por perdido, esto asume que el jugador/
// equipo SÍ existe y el problema fue puramente de ritmo, así que vale la
// pena esperar a que se libere la ventana de 1 minuto en vez de sumarlo a
// "sin resolver" para siempre.
async function conReintentoRateLimit(fn, esperaMs = 10000) {
  try {
    return await fn();
  } catch (e) {
    if (e.esRateLimit) {
      console.warn(`[/refrescar-planteles] Rate limit — esperando ${esperaMs}ms antes de reintentar...`);
      await pausa(esperaMs);
      return fn();
    }
    throw e;
  }
}

// Universo de equipos controlables: local + visita de todo desafío Cat.4/5
// activo con id de equipo ya resuelto (ver /backfill-equipos). Se juntan en
// un Map por id para no repetir el mismo equipo si aparece como local en un
// desafío y como visita en otro.
//
// ORDEN (bug encontrado en la primera corrida real: con 159 equipos
// controlables y un tope de 8 por corrida, sin ningún orden explícito
// Supabase devuelve siempre la MISMA lista — así que cada corrida procesaba
// una y otra vez los mismos 8 primeros y los otros 151 nunca se llegaban a
// tocar). Ahora se ordena por "hace más tiempo que no se lo INTENTA
// primero": se cruza contra entrenadores_equipo.actualizado_en, que ahora
// se escribe SIEMPRE que se procesa un equipo (más abajo, en el loop
// principal) — tenga o no entrenador la API, y aunque el plantel entero
// haya fallado ("Sin plantel en API-Football"). Esto último importa: en la
// 2da corrida real, 8 equipos sin datos de plantel en la API se repitieron
// SIEMPRE porque antes solo se marcaba como "refrescado" cuando SÍ había
// datos que guardar — un equipo sin plantel en la API nunca dejaba rastro,
// así que quedaba con prioridad máxima para siempre y bloqueaba la
// rotación del resto. Los equipos que TODAVÍA no se intentaron ni una vez
// van primero de todos. Así cada corrida avanza siempre a equipos nuevos
// (les vaya bien o mal), y una vez completada una vuelta entera, sigue
// rotando y reintenta al que quedó más viejo — correcto tanto para el
// backfill inicial como para el refresco diario en régimen.
async function equiposControlables() {
  const { data, error } = await supabase
    .from('desafios_mvp')
    .select('equipo_local_id, equipo_local, equipo_visita_id, equipo_visitante')
    .in('categoria', [4, 5])
    .eq('esta_activo', true)
    .not('equipo_local_id', 'is', null);
  if (error) throw error;

  const equipos = new Map(); // id -> nombre
  (data || []).forEach((d) => {
    if (d.equipo_local_id != null) equipos.set(d.equipo_local_id, d.equipo_local || null);
    if (d.equipo_visita_id != null) equipos.set(d.equipo_visita_id, d.equipo_visitante || null);
  });
  const lista = [...equipos.entries()].map(([id, nombre]) => ({ id, nombre }));
  if (lista.length === 0) return lista;

  const { data: intentos, error: errIntentos } = await supabase
    .from('entrenadores_equipo')
    .select('equipo_id, actualizado_en')
    .in('equipo_id', lista.map((e) => e.id));
  if (errIntentos) throw errIntentos;

  const ultimoIntentoPorEquipo = new Map(
    (intentos || []).map((r) => [r.equipo_id, new Date(r.actualizado_en).getTime()])
  );
  // Nunca intentado (sin fila todavía) = prioridad máxima, antes que
  // cualquier fecha real.
  lista.sort((a, b) => (ultimoIntentoPorEquipo.get(a.id) ?? -Infinity) - (ultimoIntentoPorEquipo.get(b.id) ?? -Infinity));
  return lista;
}

// Acá vive TODO el trabajo real — se llama SIN esperar su resultado desde
// rutaRefrescarPlanteles (ver nota FIRE-AND-FORGET arriba del archivo), así
// que ninguna de sus promesas pendientes bloquea la respuesta HTTP.
async function ejecutarRefresco() {
  const resultado = {
    equiposControlables: 0,
    equiposRevisados: 0,
    jugadoresEnPlanteles: 0,
    entrenadoresGuardados: 0,
    nombresYaResueltos: 0,
    nombresNuevosResueltos: 0,
    errores: [],
  };

  try {
    const equipos = await equiposControlables();
    resultado.equiposControlables = equipos.length;
    const lote = equipos.slice(0, MAX_EQUIPOS_POR_CORRIDA);

    const jugadoresVistos = new Map(); // id -> {id, nombre, foto} (deduplicado entre equipos)

    await pMap(lote, CONCURRENCIA_EQUIPOS, async (equipo) => {
      try {
        const plantel = await conReintentoRateLimit(async () => {
          // obtenerPlantelClub hace 2 pedidos internos (squad + coach) en
          // paralelo — se pide turno dos veces para que el limitador los
          // cuente a ambos, no solo a uno.
          await limitarRitmo();
          await limitarRitmo();
          return obtenerPlantelClub(equipo.id);
        });

        // Marcador de "intentado ahora" (a pedido, ver nota de ORDEN más
        // arriba) — se escribe SIEMPRE, exista o no entrenador, e incluso
        // si el plantel entero vino vacío. Es lo único que evita que un
        // equipo problemático bloquee la rotación reintentándose para
        // siempre en cada corrida.
        const { error: errMarca } = await supabase.from('entrenadores_equipo').upsert({
          equipo_id: equipo.id,
          equipo_nombre: equipo.nombre,
          nombre: plantel?.entrenador?.nombre ?? null,
          foto: plantel?.entrenador?.foto ?? null,
          actualizado_en: new Date().toISOString(),
        });
        if (errMarca) throw errMarca;
        if (plantel?.entrenador) resultado.entrenadoresGuardados++;

        if (!plantel) {
          resultado.errores.push({ equipoId: equipo.id, error: 'Sin plantel en API-Football' });
          resultado.equiposRevisados++;
          await pausa(PAUSA_ENTRE_EQUIPOS_MS);
          return;
        }

        const filasPlantel = [];
        // Dedupe DENTRO de este equipo (bug real: "duplicate key value
        // violates unique constraint plantel_jugadores_pkey" para
        // equipo_id+jugador_id ya existentes — no era una carrera entre
        // corridas, era la propia API-Football devolviendo al mismo jugador
        // dos veces en el plantel del mismo equipo, p.ej. listado en dos
        // grupos de posición. Sin este control, el insert en lote choca
        // contra sí mismo aunque no haya ninguna otra corrida corriendo en
        // paralelo).
        const idsYaEnEsteEquipo = new Set();
        ['delanteros', 'mediocampistas', 'defensas', 'arqueros'].forEach((grupo) => {
          (plantel[grupo] || []).forEach((j) => {
            if (j.id == null) return;
            if (idsYaEnEsteEquipo.has(j.id)) return;
            idsYaEnEsteEquipo.add(j.id);
            filasPlantel.push({
              equipo_id: equipo.id,
              jugador_id: j.id,
              equipo_nombre: equipo.nombre,
              numero: j.numero ?? null,
              grupo_posicion: grupo,
              actualizado_en: new Date().toISOString(),
            });
            if (!jugadoresVistos.has(j.id)) {
              jugadoresVistos.set(j.id, { id: j.id, nombre: j.nombre || null, foto: j.foto || null });
            }
          });
        });

        // Reemplazo entero de la membresía de ESTE equipo (borra + inserta):
        // así un jugador que salió del club no queda pegado para siempre.
        // La identidad (jugadores_perfil) no se toca acá.
        await supabase.from('plantel_jugadores').delete().eq('equipo_id', equipo.id);
        if (filasPlantel.length > 0) {
          const { error: errIns } = await supabase.from('plantel_jugadores').insert(filasPlantel);
          if (errIns) throw errIns;
        }
        resultado.jugadoresEnPlanteles += filasPlantel.length;

        resultado.equiposRevisados++;
      } catch (e) {
        console.error(`[/refrescar-planteles] Error con el equipo ${equipo.id}:`, e);
        resultado.errores.push({ equipoId: equipo.id, error: e.message });
      }
      await pausa(PAUSA_ENTRE_EQUIPOS_MS);
    });

    // De todos los jugadores vistos esta corrida, ¿cuáles YA tienen
    // nombre_corto resuelto en jugadores_perfil? El resto son "pendientes".
    const idsVistos = [...jugadoresVistos.keys()];
    let idsYaResueltos = new Set();
    if (idsVistos.length > 0) {
      const { data: perfilesExistentes, error: errSel } = await supabase
        .from('jugadores_perfil')
        .select('jugador_id, nombre_corto')
        .in('jugador_id', idsVistos);
      if (errSel) throw errSel;
      idsYaResueltos = new Set(
        (perfilesExistentes || []).filter((p) => p.nombre_corto).map((p) => p.jugador_id)
      );
    }
    // Informativo nomás (cuántos de LOS EQUIPOS DE ESTA CORRIDA ya tenían
    // nombre resuelto de antes) — ya no se usa para decidir a quién
    // resolver, ver nota de PENDIENTES GLOBAL más abajo.
    resultado.nombresYaResueltos = idsYaResueltos.size;

    // Igual guardamos nombre/foto de TODOS los vistos (aunque el nombre_corto
    // ya esté resuelto) — así jugadores_perfil también sirve como respaldo de
    // nombre/foto para jugadores nuevos que todavía no llegaron a resolverse.
    // OJO: este upsert NO incluye nombre_corto a propósito — si lo
    // incluyéramos con null pisaría (con NULL) el valor ya resuelto de una
    // corrida anterior. Postgrest respeta "columna ausente" ≠ "columna null".
    const filasIdentidadSinResolver = idsVistos.map((id) => {
      const j = jugadoresVistos.get(id);
      return { jugador_id: id, nombre: j.nombre, foto: j.foto, actualizado_en: new Date().toISOString() };
    });
    if (filasIdentidadSinResolver.length > 0) {
      const { error: errUpsertBase } = await supabase.from('jugadores_perfil').upsert(filasIdentidadSinResolver);
      if (errUpsertBase) throw errUpsertBase;
    }

    // PENDIENTES GLOBAL (bug real, reportado: "va super lento sube de a 50
    // nombres por corrida" — con la cobertura de equipos ya casi completa
    // (158/159), cada corrida solo re-visita una porción ROTATIVA de 60
    // equipos, y antes acá solo se resolvían nombres de los jugadores
    // VISTOS en ESOS 60 equipos puntuales — la inmensa mayoría de los
    // pendientes reales (3289) pertenecían a equipos que esa corrida ni
    // siquiera tocaba, así que el tope de 1500 nunca se llegaba a usar de
    // verdad). Ahora se consulta directo el total de jugadores_perfil con
    // nombre_corto pendiente EN TODA LA BASE, sin importar en qué equipo
    // estén ni si ese equipo se procesó en esta corrida — así el tope por
    // corrida se aplica sobre el backlog real completo.
    const { count: totalPendientesAntes, error: errCountPend } = await supabase
      .from('jugadores_perfil')
      .select('jugador_id', { count: 'exact', head: true })
      .is('nombre_corto', null);
    if (errCountPend) throw errCountPend;
    resultado.nombresPendientesGlobalAntes = totalPendientesAntes ?? 0;

    const { data: filasPendientes, error: errPend } = await supabase
      .from('jugadores_perfil')
      .select('jugador_id')
      .is('nombre_corto', null)
      .order('actualizado_en', { ascending: true })
      .limit(MAX_JUGADORES_NUEVOS_POR_CORRIDA);
    if (errPend) throw errPend;
    const pendientes = (filasPendientes || []).map((p) => p.jugador_id);
    console.log(
      `[/refrescar-planteles] Seleccionados para resolver esta corrida: ${pendientes.length} ` +
      `(tope configurado MAX_JUGADORES_NUEVOS_POR_CORRIDA=${MAX_JUGADORES_NUEVOS_POR_CORRIDA}, pendientes reales=${resultado.nombresPendientesGlobalAntes})`
    );

    // Diagnóstico (bug real: 3 corridas seguidas resolviendo 0 nombres de
    // 874 pendientes, sin ningún error) — antes acá un perfil/nombreCorto
    // que diera null en silencio (sin tirar excepción) no dejaba NINGÚN
    // rastro en el resultado, así que no había forma de distinguir "cuota
    // de API-Football agotada" de "estos jugadores puntuales no tienen
    // perfil en la API" con solo mirar la respuesta del endpoint. Ahora se
    // cuentan aparte y se guarda una muestra de ids para poder diagnosticar
    // sin tener que ir a buscar en los logs línea por línea.
    const filasResueltas = [];
    let sinPerfilONombre = 0;
    const muestraSinResolver = [];
    await pMap(pendientes, CONCURRENCIA_PERFILES, async (id) => {
      try {
        const perfil = await conReintentoRateLimit(async () => {
          await limitarRitmo();
          return obtenerPerfilBasicoJugador(id);
        });
        const nombreCorto = perfil ? nombreCortoDesdeFirstLast(perfil.firstname, perfil.lastname) : null;
        if (nombreCorto) {
          filasResueltas.push({ jugador_id: id, nombre_corto: nombreCorto, actualizado_en: new Date().toISOString() });
        } else {
          sinPerfilONombre++;
          if (muestraSinResolver.length < 10) muestraSinResolver.push(id);
        }
      } catch (e) {
        console.error(`[/refrescar-planteles] Error resolviendo nombre del jugador ${id}:`, e);
        resultado.errores.push({ jugadorId: id, error: e.message });
      }
      await pausa(PAUSA_ENTRE_PERFILES_MS);
    });
    resultado.sinPerfilONombre = sinPerfilONombre;
    resultado.muestraSinResolver = muestraSinResolver;
    if (filasResueltas.length > 0) {
      // Upsert PARCIAL a propósito (solo jugador_id + nombre_corto): no toca
      // nombre/foto, que ya se guardaron arriba en el upsert de identidad
      // base — evita pisarlos con menos datos si por algo llegaran distinto.
      const { error: errUpsertNombre } = await supabase.from('jugadores_perfil').upsert(filasResueltas);
      if (errUpsertNombre) throw errUpsertNombre;
    }
    resultado.nombresNuevosResueltos = filasResueltas.length;
    resultado.jugadoresPendientesDeNombre = Math.max(0, resultado.nombresPendientesGlobalAntes - filasResueltas.length);

    console.log('[/refrescar-planteles] Corrida terminada:', JSON.stringify(resultado));
  } catch (e) {
    console.error('[/refrescar-planteles] Error general:', e, JSON.stringify(resultado));
  }
}

// CANDADO (bug real, visto en producción): el fire-and-forget responde tan
// rápido que invita a disparar el endpoint de nuevo antes de que la corrida
// anterior termine — y como cada disparo arranca su PROPIO
// ejecutarRefresco() en el mismo proceso, dos corridas superpuestas podían
// terminar eligiendo el MISMO equipo (equiposControlables() decide en base
// a lo que YA esté guardado, y una corrida en curso todavía no terminó de
// guardar nada) y las dos intentaban el mismo `delete + insert` en
// plantel_jugadores a la vez — la segunda chocaba con un
// "duplicate key value violates unique constraint" porque la primera ya
// había insertado esas filas. Con este candado, si ya hay una corrida en
// curso, el disparo nuevo no arranca una segunda en paralelo: solo avisa
// que ya hay una corriendo.
let corridaEnCurso = false;

async function rutaRefrescarPlanteles(req, res) {
  if (corridaEnCurso) {
    return res.json({
      iniciado: false,
      mensaje: 'Ya hay una corrida en curso en este mismo proceso — esperá a que termine (mirá los logs de Render) antes de disparar otra.',
    });
  }
  corridaEnCurso = true;

  // Fire-and-forget (ver nota arriba del archivo): se responde YA, antes de
  // hacer ningún trabajo pesado, así cron-job.org nunca más ve un timeout
  // acá — el trabajo real sigue corriendo en este mismo proceso después de
  // esta línea. Resultado final: logs de Render, o consultar Supabase
  // directo (ver README) para el progreso acumulado real.
  res.json({
    iniciado: true,
    mensaje: 'Refresco de planteles arrancó en segundo plano. Resultado final en los logs de Render (no en esta respuesta) — o consultá jugadores_perfil/plantel_jugadores en Supabase para ver el progreso acumulado.',
  });

  try {
    await ejecutarRefresco();
  } finally {
    corridaEnCurso = false;
  }
}

module.exports = { rutaRefrescarPlanteles };
