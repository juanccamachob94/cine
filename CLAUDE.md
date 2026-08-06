# Notas para trabajar en este proyecto

Contexto operativo y decisiones que no se deducen del código. Para qué hace el
proyecto y cómo se usa, ver `README.md`.

## Dónde vive

- Fuente en el Mac: `~/cine`. Producción en la Pi: `/home/developer/cine`
 (`ssh developer@192.168.0.95`, alias `bot`), como `cine-bot.service`.
- Se despliega con `rsync` (ver README). **`data/` y `.env` no se sincronizan**:
 son estado y secretos de la Pi.
- Mismo patrón que los proyectos `cv` y `credito` de la misma Pi: Node + grammY,
 long polling, systemd, Gemini con respaldo en Groq.

## Lo que hay que entender antes de tocar nada

**El estado es la lógica.** `data/state.json` guarda la última señal conocida de
cada película. Las alertas nacen de comparar el sondeo actual contra eso, no de
mirar la cartelera de hoy. Borrar ese archivo hace que todo lo vigilado se
reporte como recién detectado.

**El commit diferido no es un adorno.** `detect()` devuelve un `commit(entregadas)`
en vez de guardar. Si Telegram falla, la película no avanza de estado y el
siguiente ciclo reintenta. Si alguien "simplifica" eso guardando dentro de
`detect()`, un error de red hace perder la alerta para siempre — que es
justo el único fallo inaceptable aquí.

**`markSeen` va después del envío,** por lo mismo.

## Las APIs de las cadenas

Ambas claves salen de los bundles JS públicos de cada sitio. Si una cadena las
rota, se sacan otra vez desde el bundle (buscar `x-apikey` en el `_app` de
Cinépolis, `X-API-Consumer-Key` en el `main.chunk` de Cinemex).

- **Cinépolis**: `countryId` va en **MAYÚSCULAS** (`MX`); con `mx` responde
 `INTERNAL_ERROR` y parece un fallo del servidor. La query `billboard` rechaza
 más de **30 cines** por llamada (CDMX tiene 74 → 3 lotes). La introspección de
 GraphQL está deshabilitada: el esquema se lee del bundle.
- **Cinemex**: `cinemas/state/8/movies/?date=…` (la cartelera de todo CDMX)
 devuelve **~7.6 MB y tarda ~27 s**. Es inservible para sondear; por eso el
 detalle se arma con `cinemas/{cine}/movies/{peli}` (~200 ms, 19 KB) en
 paralelo sobre los 87 cines. No volver a la ruta por estado.
- CDMX = estado **8** en Cinemex, ciudad **`cdmx`** en Cinépolis.

## Sondeo

Ver la tabla del README. Lo que no es obvio y conviene no "optimizar":

**Un término sin coincidencias va al ritmo máximo (20 s), no al mínimo.** Parece
al revés, pero Cinemex solo publica en su catálogo lo que ya se puede comprar:
una película pasa de invisible a comprable sin estado intermedio. Sondear
despacio justo ahí sería el peor error posible. La versión original tenía este
fallo y se corrigió el 06/ago/2026.

El decaimiento a 30 s tras 30 días sin aparecer existe solo para que un título
mal escrito no deje el sistema acelerado para siempre. Ante la duda, ir rápido:
un sondeo de más no cuesta nada, llegar tarde cuesta el boleto.

`check-cadence.mjs` reproduce la decisión de un ciclo sin escribir nada;
`test-cadence.mjs` cubre la tabla completa sin tocar la red.

## Cosas que ya se probaron y no funcionan

- `fetch` de Node y `curl` normal contra Cinépolis: **403 de Cloudflare**, sin
 importar las cabeceras. Es fingerprint TLS. Por eso `scraper/cinepolis_fetch.py`
 con `curl_cffi`. No intentar "arreglarlo" pasándolo a Node.
- Raspar `cinemex.com` con HTTP directo: el sitio devuelve el shell de la SPA
 (378 KB idénticos para cualquier ruta). Los datos solo salen por su API REST.
- X/Twitter e Instagram: hoy no hay camino gratuito y estable sin credenciales.
 `watcher/news.mjs` usa Google News RSS y Reddit, que sí tienen feed abierto y
 en la práctica recogen lo que publican las cuentas oficiales.

## Telegram

- Bot **@jc_cine_bot**, nombre visible "Boletos Cine CDMX".
- Privacy mode **desactivado** en BotFather: si no, el bot no lee el texto libre
 del grupo y solo respondería a comandos.
- Grupo `-5184466429` con Juan Camilo, y el bot.
- `TELEGRAM_ALLOWED_USER_IDS` son los mismos dos IDs que usa `credito`.
