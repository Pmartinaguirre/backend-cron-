# demaster-cron-backend

Backend chico (Node/Express) con los 4 endpoints que `cron-job.org` llama por horario, para automatizar lo que hasta ahora se hacía a mano: actualizar cuotas, marcador en vivo, resolver partidos terminados (pagar diamantes), y (pendiente) crear partidos nuevos solos.

## Qué hace cada endpoint

- **`/cuotas`** — busca partidos Cat.4/5 activos sin cuota guardada y les pide la cuota "Match Winner" a API-Football. Igual que `actualizar_cuotas.js`, pero como endpoint HTTP. Idempotente: correr cada 30-60 min alcanza.
- **`/vivo`** — cada 1 minuto, actualiza minuto de juego, marcador parcial y goleadores de los partidos que ya arrancaron. Solo lectura/display, no paga nada.
- **`/resolver`** — cada 5-15 min, detecta partidos que ya terminaron (estado FT en API-Football) y paga diamantes a los jugadores (misma lógica que los botones "Pagar" del Admin).
- **`/crear-partidos`** — trae partidos nuevos de cada liga (excepto Mundial 2026, que se cargó completo a mano) dentro de los próximos `DIAS_ANTICIPACION` días (default 10). Solo trae partidos donde ambos equipos están en la lista Tier A de esa competencia (tabla `equipos_tier_a_mvp`), EXCEPTO en instancias finales (octavos/round of 16 en adelante), donde trae todos los partidos de esa fase sin filtrar. De cada lote nuevo, ~25% sale al azar en Categoría 4 (el resto, Categoría 5). No duplica: se salta los partidos que ya existen por `fixture_id_api`.
- **`/equipos?competencia=<nombre>`** — de solo lectura: devuelve la lista real de equipos de esa competencia, tal como los tiene API-Football (mismo texto exacto que usa `/crear-partidos`). La usa el selector "Equipos Tier A" del Admin en el frontend, para que el nombre elegido SIEMPRE calce con el que trae el cron (antes el admin tipeaba el nombre a mano o lo elegía de partidos ya cargados, y nombres como "U. Catolica" no calzaban con "Universidad Catolica" de la API). No aplica a Mundial 2026 (no tiene id de liga configurado, queda fuera del automatismo).
- **`/refrescar-planteles`** — base propia de jugadores (a pedido, para no depender de una consulta en caliente a API-Football en la pestaña "Plantel" de la ficha de equipo). Recorre los equipos "controlables" (los que tienen al menos un desafío Cat.4/5 activo), guarda su plantel completo (`plantel_jugadores`, se reemplaza entero por equipo en cada corrida) y su entrenador (`entrenadores_equipo`), y resuelve el nombre "primer nombre + primer apellido" bien cortado (usando el firstname/lastname real de API-Football, no adivinando por posición de palabra), guardándolo para siempre en `jugadores_perfil`. Correr antes `../crear_tablas_plantel.sql` en Supabase.
  - **Responde al toque** ("fire and forget"): la respuesta HTTP es solo un ACK, el trabajo real sigue corriendo en el proceso después de responder — así el timeout de cron-job.org (~30s) nunca más corta la corrida a la mitad. El resultado de cada corrida (equipos revisados, jugadores, nombres resueltos, errores) queda en los **logs de Render** (Dashboard → tu servicio → Logs), no en la respuesta HTTP.
  - Procesa varios equipos/jugadores **en simultáneo** (no uno por uno) para ir más rápido — configurable con `CONCURRENCIA_EQUIPOS_PLANTELES`/`CONCURRENCIA_PERFILES_PLANTELES` (default 4 cada uno).
  - Los equipos se recorren rotando por "el que hace más tiempo que no se toca" (usa `entrenadores_equipo.actualizado_en` como marca), así que cada corrida avanza a equipos distintos en vez de repetir siempre los mismos.
  - Topes por corrida (`MAX_EQUIPOS_POR_CORRIDA_PLANTELES` default 60, `MAX_JUGADORES_NUEVOS_POR_CORRIDA_PLANTELES` default 1500) — ya no existen por el timeout (eso lo resuelve el fire-and-forget), son solo un techo de cordura y para cuidar la cuota de API-Football.
  - Para ver el progreso real acumulado (no corrida por corrida), consultá directo en el SQL Editor de Supabase:
    ```sql
    select
      count(*) as jugadores_totales,
      count(nombre_corto) as nombres_resueltos,
      count(*) - count(nombre_corto) as pendientes,
      (select count(distinct equipo_id) from plantel_jugadores) as equipos_con_plantel
    from jugadores_perfil;
    ```
  - Para el backfill inicial (cientos de equipos/jugadores nunca vistos) conviene dispararlo varias veces seguidas a mano, esperando ~1-2 minutos entre una y otra para que la corrida anterior termine en el servidor, hasta que la consulta de arriba muestre `pendientes = 0` y `equipos_con_plantel = 159` (o el total real de equipos controlables).

- **`/invitar-a-grupo`** (POST) — invita a un amigo a un grupo (sala privada). Body: `{ salaId, email, invitadorId }`. Verifica que `invitadorId` sea el admin de esa sala. Si el mail ya es de un jugador registrado, lo agrega directo como miembro; si no, manda la invitación nativa de Supabase (mismo Resend ya configurado en Auth) y guarda una fila pendiente que se vincula sola cuando esa persona termine de registrarse (ver Registro.jsx).

Todos exigen el header `X-Cron-Secret` con el valor de tu `CRON_SECRET` (ver abajo) — sin eso, responden 401 — EXCEPTO `/equipos` e `/invitar-a-grupo`, que los llama directo el navegador del jugador (pedirles el secreto obligaría a exponerlo en el código del frontend); `/invitar-a-grupo` verifica la autorización de otra forma (ver arriba).

## 1. Antes de desplegar: correr la migración SQL

En el editor SQL de Supabase, corre `../agregar_columnas_en_vivo.sql` (agrega las columnas de marcador en vivo que usa `/vivo`) y `../agregar_invitacion_email_grupos.sql` (agrega `email_invitado` a `salas_privadas_miembros_mvp`, para invitar por mail a amigos que todavía no tienen cuenta — lo usa `/invitar-a-grupo`). Si todavía no lo hiciste, también corre `../agregar_columna_perfil_completo.sql` y `../agregar_columna_email.sql` de sesiones anteriores.

También revisá en Supabase → Authentication → Email Templates la plantilla **"Invite user"** — es la que se manda cuando invitás a alguien sin cuenta desde `/invitar-a-grupo` (separada de la de "Confirm signup"), para que tenga un diseño/texto decente.

## 2. Desplegar en Render

1. Sube esta carpeta (`backend-cron/`) a un repo de GitHub (puede ser el mismo repo del frontend, en una subcarpeta, o uno aparte — lo que prefieras).
2. En Render: **New > Web Service**, conecta el repo.
   - Root Directory: `backend-cron` (si va en el mismo repo que el frontend).
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: el gratis alcanza para esto (no es un servicio que necesite estar despierto todo el tiempo por sí solo, cron-job.org lo va a "despertar" en cada llamada — aunque en el plan gratis de Render el servicio se duerme tras un rato sin tráfico y la primera llamada después de dormido tarda más, ver nota abajo).
3. En la sección **Environment** de Render, carga las variables (mismas que `.env.example`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` (la *service_role*, no la anon)
   - `API_FOOTBALL_KEY`
   - `CRON_SECRET` (invéntate algo largo y random, ej. con `openssl rand -hex 32`)
   - `DIAS_ANTICIPACION` (opcional, default 10) — cuántos días hacia adelante busca partidos nuevos `/crear-partidos`.
   - `API_FOOTBALL_SEASON` (opcional, default 2026) — temporada que se consulta en API-Football.
   - `FRONTEND_URL` (opcional, default `https://demaster.app`) — a dónde manda Supabase al amigo invitado por `/invitar-a-grupo` para que complete su registro.
4. Deploy. Cuando termine, Render te da una URL tipo `https://demaster-cron-backend.onrender.com`. Probá que responda: `https://demaster-cron-backend.onrender.com/` debería devolver `{"ok":true,...}` sin necesitar el secreto.

**Nota sobre el plan gratis de Render:** si el servicio se "duerme" por inactividad, la primera llamada después de dormido puede tardar 30-60 segundos en responder (arranca el contenedor). Para un cron de 1 minuto (`/vivo`) esto puede ser un problema — si te pasa, conviene el plan pago más barato de Render (no se duerme) o agregar un 5º cron en cron-job.org que solo pegue a `/` cada 10 minutos para mantenerlo despierto.

## 3. Configurar los cron jobs en cron-job.org

Crea un cron job por endpoint:

| Endpoint | Frecuencia sugerida | Método |
|---|---|---|
| `/vivo` | Cada 1 minuto | GET |
| `/resolver` | Cada 5-15 minutos | GET |
| `/cuotas` | Cada 30-60 minutos | GET |
| `/crear-partidos` | Cada 6-12 horas | GET |
| `/refrescar-planteles` | 1 vez al día | GET |

En cada cron job de cron-job.org, en la sección de headers personalizados (Advanced / Headers), agrega:

```
X-Cron-Secret: <el mismo valor que pusiste en CRON_SECRET en Render>
```

## 4. Probar a mano antes de dejarlo en automático

Con `curl` (cambiando la URL y el secreto):

```bash
curl -H "X-Cron-Secret: tu-secreto" https://demaster-cron-backend.onrender.com/cuotas
curl -H "X-Cron-Secret: tu-secreto" https://demaster-cron-backend.onrender.com/vivo
curl -H "X-Cron-Secret: tu-secreto" https://demaster-cron-backend.onrender.com/resolver
```

Cada uno devuelve un JSON con lo que hizo (`revisados`, `actualizados`, `resueltos`, `errores`, etc.) — revisa esos números antes de dejarlo corriendo solo, sobre todo `/resolver` la primera vez (que de verdad paga diamantes).

## Nota importante: la fórmula de diamantes está duplicada

`src/diamantes.js` es una copia a mano de la misma lógica que vive en `sementomvp.jsx` (frontend). Si el día de mañana ajustas la fórmula de diamantes ahí (como pasó con el rango 5-12), hay que copiar el mismo cambio acá también — si no, el Admin (manual) y este backend (automático) van a pagar distinto por el mismo resultado.

## Antes de activar /crear-partidos: configura Tier A

Para que `/crear-partidos` traiga partidos de temporada regular en una competencia, esa competencia necesita al menos un equipo cargado en "Equipos Tier A" (panel Admin de la app). Si una competencia no tiene ningún equipo Tier A configurado, `/crear-partidos` NO trae nada de su temporada regular (para evitar traer la liga completa por accidente si te olvidaste de configurarla) — sí sigue trayendo instancias finales igual, porque esas no dependen de Tier A.

Desde este cambio, el panel "Equipos Tier A" del Admin trae el listado de equipos directo de `/equipos` (este backend) en vez de basarse en partidos ya cargados o en texto tipeado a mano — asegurate de que la URL del backend en `sementomvp.jsx` (`https://backend-cron-qqwt.onrender.com`) sea la correcta antes de usarlo, y que el servicio esté desplegado (si Render lo tiene dormido, el primer fetch puede tardar unos segundos).
