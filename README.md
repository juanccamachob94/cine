# Boletos Cine CDMX

Aviso inmediato, por Telegram, en cuanto se pueden **comprar boletos en CDMX**
de las películas que Juan Camilo estén esperando. Vigila Cinépolis y
Cinemex de forma continua desde la Raspberry Pi.

Bot: **@jc_cine_bot** ("Boletos Cine CDMX") · Grupo: *Boletos Cine CDMX — Grupo*

## Cómo se usa

Desde el grupo de Telegram, con comandos o en lenguaje natural:

| Comando | Qué hace |
|---|---|
| `/agregar <película>` | Empieza a vigilarla |
| `/eliminar <número>` | Deja de vigilarla (número de `/terminos`, o el título) |
| `/terminos` | Lista de películas vigiladas |
| `/estado` | Cómo va cada término ahora mismo |
| `/buscar <texto>` | Consulta puntual sin registrar nada |
| `/noticias <texto>` | Menciones en prensa mexicana y Reddit |
| `/investiga <texto>` | La IA busca en internet cuándo abre la preventa |

También entiende texto libre: *"avísame de la nueva de Avatar"*, *"¿ya salió
Wicked?"*, *"quita la de Robin Hood"*.

## Cómo detecta la venta

El objetivo no es leer la cartelera, sino detectar el **cambio de estado**: el
instante en que una película pasa de anunciada a comprable en CDMX. Cada sondeo
se compara contra el anterior (`data/state.json`), y solo la transición dispara
la alerta.

- **Cinépolis** — GraphQL en `api-g.cinepolis.com`. La señal es `categories`
 (`coming-soon` → `pre-sale`) junto con `availableForSale` y que la película
 tenga cines de CDMX asignados.
- **Cinemex** — REST en `api.cinemex.com`. Su catálogo `/movies` solo publica lo
 que ya se puede comprar (incluida la preventa, con el ribbon `Preventa`), así
 que aparecer ahí *es* la señal.

Cuando salta la alerta, se consultan las funciones reales y se manda el enlace
de compra. En Cinemex es un enlace directo al checkout de una función concreta.

### Cadencia adaptativa

| Situación | Intervalo |
|---|---|
| Un término todavía no aparece en ningún catálogo | **20 s** |
| Una película vigilada está anunciada pero sin venta | **20 s** |
| Un término lleva más de 30 días sin aparecer nunca | 30 s |
| Nada que esperar | 90 s |
| Tras un error de red o de API | 120 s |

Que un término **sin coincidencias** vaya al ritmo máximo es deliberado: es el
caso de mayor riesgo, no el de menor. Cinemex solo publica en su catálogo lo
que ya se puede comprar, así que ahí una película pasa de invisible a comprable
de golpe, sin estado intermedio que avise.

Un sondeo son 3 peticiones en total, así que ni al ritmo máximo pesa.

Para saber en qué modo está y por qué, sin tocar nada:

```bash
ssh bot 'cd ~/cine && node check-cadence.mjs'
```

### Si falla la entrega

El estado solo se da por bueno cuando Telegram confirma el envío. Si el mensaje
no sale, la película conserva su estado anterior y el siguiente ciclo lo vuelve
a intentar: perder el aviso por un error de red es el único fallo que este
proyecto no se puede permitir.

## Estructura

```
bot/
 index.mjs    Bot de Telegram (grammY) + arranque del vigilante
 ai.mjs     Gemini (principal) con respaldo en Groq
 groq.mjs    Motor de respaldo
 format.mjs   Redacción de los mensajes
 store.mjs    Términos, estado, alertas enviadas, bitácora
watcher/
 poll.mjs    Bucle de vigilancia y detección de cambios
 cinepolis.mjs  Envoltura del fetcher de Python
 cinemex.mjs   Cliente REST
 match.mjs    Emparejamiento término ↔ título
 news.mjs    Google News RSS + Reddit (para /noticias)
 websearch.mjs  Búsqueda web propia de la Pi (respaldo de /investiga)
scraper/
 cinepolis_fetch.py  Cliente de Cinépolis con impersonación TLS
systemd/
 cine-bot.service
```

### Cómo investiga `/investiga`

Tres escalones, y **los tres miran internet**:

1. **Gemini** (`gemini-3.5-flash`) con `google_search`. Requiere billing: en
  los modelos 3.x el grounding con Búsqueda no está en el tier gratuito, así
  que sin tarjeta este escalón siempre falla con 429 y contesta el 2.
2. **Groq** con su agente `compound` (o `compound-mini`, que gasta menos del
  límite por minuto). Ante un 429/413 espera lo que indique la propia API y
  reintenta antes de rendirse.
3. **Búsqueda propia de la Pi** (`watcher/websearch.mjs`): Google News RSS para
  titulares mexicanos con fecha, DuckDuckGo para URLs directas, y de esas se
  lee el texto real de las notas. La IA solo resume esas fuentes. Si no queda
  ninguna IA disponible, se manda la lista de enlaces sin resumir.

Lo que **no** existe es un escalón que conteste de memoria, y es deliberado: la
fecha de una preventa se anuncia esta semana y los modelos se entrenaron hace
meses. Antes había uno, con un aviso al pie que era fácil de pasar por alto, y
el 08/ago/2026 se le vio afirmar que no había fecha de preventa de Avatar
cuando la prensa mexicana llevaba meses publicándola. Si no se puede buscar de
verdad, el comando falla y lo dice.

```bash
ssh bot 'cd ~/cine && node --env-file=.env test-research.mjs "¿cuándo abre la preventa de X?"'
ssh bot 'cd ~/cine && node --env-file=.env test-research.mjs --fuentes "..."'  # solo la búsqueda propia
```

### Por qué Cinépolis va en Python

Cloudflare bloquea a Cinépolis por *fingerprint TLS*, no por cabeceras: el
`fetch` de Node y `curl` reciben 403 aunque manden el User-Agent y el Origin
correctos. `curl_cffi` imita el handshake de Chrome y pasa, así que el bot lo
invoca como subproceso y lee JSON por stdout. Cinemex no necesita nada de esto.

## Despliegue

Corre en la Raspberry Pi (`ssh developer@192.168.0.95`, alias `bot`) como
`cine-bot.service`, en `/home/developer/cine`.

```bash
rsync -az --exclude node_modules --exclude .env --exclude 'data/*' \
 ./ developer@192.168.0.95:/home/developer/cine/
ssh bot 'cd ~/cine && npm install && sudo systemctl restart cine-bot'
```

Requisitos en la Pi: Node 20+, Python 3.11+ y `curl_cffi`
(`pip3 install --break-system-packages curl_cffi`).

Logs: `ssh bot 'journalctl -u cine-bot -f'`

## Configuración

Ver `.env.example`. Las claves de Gemini y Groq se comparten con el proyecto
`credito`. `data/` es estado local y no va a git.

## Límites

- Avisa de la venta; **no compra ni aparta boletos**. El enlace deja el
 navegador en el checkout, el pago lo hacen ustedes.
- Solo CDMX, solo Cinépolis y Cinemex.
- Las claves de API de ambas cadenas salen de sus bundles web públicos: si
 alguna cadena las rota, hay que actualizarlas.
