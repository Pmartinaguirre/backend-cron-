// GET/POST /media — pestaña "Media" (a pedido, mockup sofascore): busca
// AUTOMÁTICO en YouTube (canal oficial de TNT Sports Chile) el resumen de
// cada partido de FÚTBOL CHILENO ya terminado, y guarda el link en
// desafios_mvp.media_video_url. SOLO fútbol chileno por ahora (a pedido) —
// otras ligas no tienen a TNT Sports como fuente.
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
const CANAL_TNT_SPORTS_CHILE = 'UChCovZlgNh2x6Z57MJ5fhFw';
// Las 3 competencias chilenas (a pedido: Copa Chile y Copa de la Liga
// quedaron afuera del alcance original, que solo miraba Primera División —
// TNT Sports Chile también sube resúmenes de las copas nacionales).
const COMPETENCIAS_CHILE = ['Primera División Chile', 'Copa Chile', 'Copa de la Liga'];
// No busca partidos de hace más de esto (a pedido implícito: no tiene
// sentido seguir gastando cuota de YouTube en partidos viejos que TNT
// Sports nunca subió, o que Pablo directamente no va a revisar).
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
function normalizar(txt) {
  return decodificarEntidadesHtml(txt)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
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
  return normalizar(nombre)
    .split(/\s+/)
    .filter((p) => p.length >= 4 && !PALABRAS_CONECTORAS.has(p));
}

async function buscarVideoResumen(equipoLocal, equipoVisitante, fechaPartidoISO) {
  const q = encodeURIComponent(`${equipoLocal} ${equipoVisitante} resumen`);
  // BUG encontrado (a pedido, "0 encontrados" en TODAS las corridas): la
  // API de YouTube exige el timestamp en formato RFC3339 completo,
  // terminado en "Z" o con offset de zona horaria — `fecha_expiracion` en
  // la base no siempre viene así (a veces sin la Z), y mandado tal cual
  // rompía CADA búsqueda con un error de formato antes de buscar nada. Se
  // fuerza acá con .toISOString(), que siempre da el formato válido.
  const fechaValida = fechaPartidoISO ? new Date(fechaPartidoISO) : null;
  const publishedAfter = fechaValida && !isNaN(fechaValida.getTime()) ? fechaValida.toISOString() : null;
  const parametroFecha = publishedAfter ? `&publishedAfter=${publishedAfter}` : '';
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${CANAL_TNT_SPORTS_CHILE}&q=${q}&type=video&order=date&maxResults=5${parametroFecha}&key=${YOUTUBE_API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) {
    console.error('[/media] Error de YouTube API:', data.error.message);
    return { videoId: null, candidatos: [], errorApi: data.error.message };
  }
  const items = data.items || [];
  // decodificar acá también (a pedido): los candidatos que se devuelven
  // para diagnóstico deben verse legibles ("O'Higgins"), no con el código
  // HTML crudo que manda la API.
  const candidatos = items.map((it) => decodificarEntidadesHtml(it.snippet?.title) || '(sin título)');

  const nl = normalizar(equipoLocal);
  const nv = normalizar(equipoVisitante);
  const palabrasLocal = palabrasSignificativas(equipoLocal);
  const palabrasVisita = palabrasSignificativas(equipoVisitante);

  // Dos pasadas: primero el nombre completo (más estricta), y si nada
  // matchea así, alguna palabra significativa de cada equipo (nombre corto
  // real del club, no necesariamente la última palabra) — así "Everton 3-4
  // Colo Colo" matchea contra "Everton de Viña" por "everton", y "Santiago
  // Wanderers 2-1 U. La Calera" matchea por "wanderers"+"calera".
  const match = items.find((it) => {
    const titulo = normalizar(it.snippet?.title);
    return titulo.includes(nl) && titulo.includes(nv);
  }) || items.find((it) => {
    const titulo = normalizar(it.snippet?.title);
    const tieneLocal = palabrasLocal.some((p) => titulo.includes(p));
    const tieneVisita = palabrasVisita.some((p) => titulo.includes(p));
    return tieneLocal && tieneVisita;
  });

  return { videoId: match?.id?.videoId || null, candidatos };
}

async function rutaMedia(req, res) {
  if (!YOUTUBE_API_KEY) {
    console.log('[/media] Sin YOUTUBE_API_KEY configurada, se saltea.');
    return res.json({ revisados: 0, encontrados: 0, mensaje: 'Falta YOUTUBE_API_KEY' });
  }

  const limite = new Date();
  limite.setDate(limite.getDate() - DIAS_VENTANA_MEDIA);

  // Terminados (Cat.4 con marcador oficial ya cargado por /resolver), fútbol
  // chileno, sin video guardado, y sin corrección manual previa.
  const { data: partidos, error } = await supabase
    .from('desafios_mvp')
    .select('id, pregunta, equipo_local, equipo_visitante, fecha_expiracion, goles_local_oficial, goles_visitante_oficial')
    .eq('categoria', 4)
    .in('tema', COMPETENCIAS_CHILE)
    .eq('esta_activo', true)
    .eq('media_video_corregido', false)
    .is('media_video_url', null)
    .not('goles_local_oficial', 'is', null)
    .gte('fecha_expiracion', limite.toISOString());

  if (error) {
    console.error('[/media] Error leyendo desafios_mvp:', error);
    return res.status(500).json({ error: error.message });
  }

  // detalle (a pedido, diagnóstico): para cada partido revisado, qué títulos
  // encontró en el canal aunque no hayan matcheado — así se distingue "TNT
  // todavía no subió nada" (candidatos: []) de "subió algo pero el nombre no
  // calzó" (candidatos con títulos, encontrado: false).
  const resultado = { revisados: (partidos || []).length, encontrados: 0, errores: [], detalle: [] };

  for (const partido of partidos || []) {
    try {
      const { videoId, candidatos, errorApi } = await buscarVideoResumen(partido.equipo_local, partido.equipo_visitante, partido.fecha_expiracion);
      resultado.detalle.push({
        id: partido.id,
        partido: `${partido.equipo_local} vs ${partido.equipo_visitante}`,
        encontrado: !!videoId,
        candidatos,
        ...(errorApi ? { errorApi } : {}),
      });
      if (videoId) {
        const { error: errUpdate } = await supabase
          .from('desafios_mvp')
          .update({ media_video_url: `https://www.youtube.com/watch?v=${videoId}` })
          .eq('id', partido.id);
        if (errUpdate) {
          resultado.errores.push({ id: partido.id, error: errUpdate.message });
        } else {
          resultado.encontrados++;
          console.log(`[/media] Partido ${partido.id} (${partido.pregunta}) -> video ${videoId}`);
        }
      }
    } catch (e) {
      resultado.errores.push({ id: partido.id, error: e.message });
    }
    // Pausa chica para no pasarse de cuota de YouTube en poco tiempo.
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[/media] ${resultado.encontrados} video(s) encontrados de ${resultado.revisados} revisados.`);
  res.json(resultado);
}

module.exports = { rutaMedia };
