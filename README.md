# demaster-cron-backend

Backend chico (Node/Express) con los 4 endpoints que `cron-job.org` llama por horario, para automatizar lo que hasta ahora se hacía a mano: actualizar cuotas, marcador en vivo, resolver partidos terminados (pagar diamantes), y (pendiente) crear partidos nuevos solos.

## Qué hace cada endpoint

- **`/cuotas`** — busca partidos Cat.4/5 activos sin cuota guardada y les pide la cuota "Match Winner" a API-Football. Igual que `actualizar_cuotas.js`, pero como endpoint HTTP. Idempotente: correr cada 30-60 min alcanza.
- **`/vivo`** — cada 1 minuto, actualiza minuto de juego, marcador parcial y goleadores de los partidos que ya arrancaron. Solo lectura/display, no paga nada.
- **`/resolver`** — cada 5-15 min, detecta partidos que ya terminaron (estado FT en API-Football) y paga diamantes a los jugadores (misma lógica que los botones "Pagar" del Admin).
- **`/crear-partidos`** — todavía sin implementar del todo. Falta que me mandes los criterios (qué ligas, cuántas fechas por adelantado, etc.) para completar la lógica de creación automática.

Todos exigen el header `X-Cron-Secret` con el valor de tu `CRON_SECRET` (ver abajo) — sin eso, responden 401.

## 1. Antes de desplegar: correr la migración SQL

En el editor SQL de Supabase, corre `../agregar_columnas_en_vivo.sql` (agrega las columnas de marcador en vivo que usa `/vivo`). Si todavía no lo hiciste, también corre `../agregar_columna_perfil_completo.sql` y `../agregar_columna_email.sql` de sesiones anteriores.

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
4. Deploy. Cuando termine, Render te da una URL tipo `https://demaster-cron-backend.onrender.com`. Probá que responda: `https://demaster-cron-backend.onrender.com/` debería devolver `{"ok":true,...}` sin necesitar el secreto.

**Nota sobre el plan gratis de Render:** si el servicio se "duerme" por inactividad, la primera llamada después de dormido puede tardar 30-60 segundos en responder (arranca el contenedor). Para un cron de 1 minuto (`/vivo`) esto puede ser un problema — si te pasa, conviene el plan pago más barato de Render (no se duerme) o agregar un 5º cron en cron-job.org que solo pegue a `/` cada 10 minutos para mantenerlo despierto.

## 3. Configurar los cron jobs en cron-job.org

Crea 3 (o 4, cuando esté `/crear-partidos`) cron jobs nuevos, uno por endpoint:

| Endpoint | Frecuencia sugerida | Método |
|---|---|---|
| `/vivo` | Cada 1 minuto | GET |
| `/resolver` | Cada 5-15 minutos | GET |
| `/cuotas` | Cada 30-60 minutos | GET |
| `/crear-partidos` | Cada 6-12 horas (cuando esté listo) | GET |

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

## Pendiente

`/crear-partidos` está sin implementar — en cuanto me mandes los criterios (qué ligas, cuántas fechas por adelantado activar, etc.) lo completo.
