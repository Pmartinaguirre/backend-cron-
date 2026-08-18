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
//        - entrenadores_equipo: upsert simple, 1 fila por equipo.
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
// TOPES (para que cada corrida responda antes de que cron-job.org/Render
// corten la conexión por timeout, aunque la primera vez haya cientos de
// equipos/jugadores nunca vistos): un tope de equipos por corrida y un tope
// de jugadores NUEVOS a resolver por corrida. Lo que sobra queda pendiente
// para la próxima corrida — mismo criterio "idempotente, se puede volver a
// llamar las veces que haga falta" que /cuotas y /backfill-equipos. Para el
// backfill inicial, disparar este endpoint varias veces seguidas a mano.
const { supabase } = require('../supabaseClient');
const { obtenerPlantelClub, obtenerPerfilBasicoJugador, nombreCortoDesdeFirstLast } = require('../apiFootball');

const MAX_EQUIPOS_POR_CORRIDA = 40;
const MAX_JUGADORES_NUEVOS_POR_CORRIDA = 80;
const PAUSA_ENTRE_EQUIPOS_MS = 300;
const PAUSA_ENTRE_PERFILES_MS = 300;

function pausa(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Universo de equipos controlables: local + visita de todo desafío Cat.4/5
// activo con id de equipo ya resuelto (ver /backfill-equipos). Se juntan en
// un Map por id para no repetir el mismo equipo si aparece como local en un
// desafío y como visita en otro.
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
  return [...equipos.entries()].map(([id, nombre]) => ({ id, nombre }));
}

async function rutaRefrescarPlanteles(req, res) {
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

    for (const equipo of lote) {
      try {
        const plantel = await obtenerPlantelClub(equipo.id);
        if (!plantel) { resultado.errores.push({ equipoId: equipo.id, error: 'Sin plantel en API-Football' }); continue; }

        const filasPlantel = [];
        ['delanteros', 'mediocampistas', 'defensas', 'arqueros'].forEach((grupo) => {
          (plantel[grupo] || []).forEach((j) => {
            if (j.id == null) return;
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

        if (plantel.entrenador) {
          const { error: errCoach } = await supabase.from('entrenadores_equipo').upsert({
            equipo_id: equipo.id,
            equipo_nombre: equipo.nombre,
            nombre: plantel.entrenador.nombre,
            foto: plantel.entrenador.foto,
            actualizado_en: new Date().toISOString(),
          });
          if (errCoach) throw errCoach;
          resultado.entrenadoresGuardados++;
        }

        resultado.equiposRevisados++;
      } catch (e) {
        console.error(`[/refrescar-planteles] Error con el equipo ${equipo.id}:`, e);
        resultado.errores.push({ equipoId: equipo.id, error: e.message });
      }
      await pausa(PAUSA_ENTRE_EQUIPOS_MS);
    }

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

    // Pendientes de resolver nombre_corto, con tope por corrida (ver nota de
    // timeout arriba del archivo).
    const pendientes = idsVistos.filter((id) => !idsYaResueltos.has(id)).slice(0, MAX_JUGADORES_NUEVOS_POR_CORRIDA);

    const filasResueltas = [];
    for (const id of pendientes) {
      try {
        const perfil = await obtenerPerfilBasicoJugador(id);
        const nombreCorto = perfil ? nombreCortoDesdeFirstLast(perfil.firstname, perfil.lastname) : null;
        if (nombreCorto) {
          filasResueltas.push({ jugador_id: id, nombre_corto: nombreCorto, actualizado_en: new Date().toISOString() });
        }
      } catch (e) {
        console.error(`[/refrescar-planteles] Error resolviendo nombre del jugador ${id}:`, e);
        resultado.errores.push({ jugadorId: id, error: e.message });
      }
      await pausa(PAUSA_ENTRE_PERFILES_MS);
    }
    if (filasResueltas.length > 0) {
      // Upsert PARCIAL a propósito (solo jugador_id + nombre_corto): no toca
      // nombre/foto, que ya se guardaron arriba en el upsert de identidad
      // base — evita pisarlos con menos datos si por algo llegaran distinto.
      const { error: errUpsertNombre } = await supabase.from('jugadores_perfil').upsert(filasResueltas);
      if (errUpsertNombre) throw errUpsertNombre;
    }
    resultado.nombresNuevosResueltos = filasResueltas.length;
    resultado.jugadoresPendientesDeNombre = idsVistos.length - idsYaResueltos.size - filasResueltas.length;

    res.json(resultado);
  } catch (e) {
    console.error('[/refrescar-planteles] Error general:', e);
    res.status(500).json({ error: e.message, ...resultado });
  }
}

module.exports = { rutaRefrescarPlanteles };
