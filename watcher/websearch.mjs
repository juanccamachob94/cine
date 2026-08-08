/**
 * Búsqueda web hecha por la propia Pi, sin API key ni proveedor de IA.
 *
 * Existe por una razón concreta: cuando ni Gemini ni Groq pueden buscar en
 * internet (cuota agotada, límite por minuto), la alternativa NO puede ser
 * que un modelo conteste de memoria. Una preventa se anuncia esta semana; el
 * modelo se entrenó hace meses. Una respuesta así se lee igual de segura que
 * una buena y es exactamente lo que no sirve aquí.
 *
 * Así que el último escalón de `/investiga` es este: buscamos nosotros, traemos
 * el texto real de las notas, y lo que haga la IA después es resumir fuentes
 * que están a la vista. Sin fuentes no hay respuesta.
 *
 * Se complementa con `news.mjs` (que sirve a `/noticias` con un término): aquí
 * la consulta es una pregunta en lenguaje natural, no un título de película.
 *
 * - Google News RSS da titulares mexicanos con fecha y medio, muy al grano.
 *  Sus enlaces son redirecciones que solo resuelve JavaScript, así que de ahí
 *  salen titulares, no cuerpos.
 * - DuckDuckGo HTML sí da URLs directas, y de esas sí se puede leer el texto,
 *  que es donde están las fechas concretas.
 */
const NEWS_RSS = 'https://news.google.com/rss/search';
const DDG_HTML = 'https://html.duckduckgo.com/html/';
const TIMEOUT_MS = 20_000;
// Google News acepta que nos identifiquemos como lo que somos. DuckDuckGo y
// varios medios no: con un user-agent de bot devuelven 202 y una página de
// "anomaly" sin resultados (comprobado desde la Pi), así que ahí va uno de
// navegador. Mismo criterio que ya se sigue con Cinépolis en `scraper/`.
const UA_BOT = 'Mozilla/5.0 (compatible; jc-cine-bot/1.0; aviso personal de preventas)';
const UA_BROWSER =
 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const EXCERPT_CHARS = 900;
const MAX_PAGES = 4;

const strip = (html) =>
 html
  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ')
  // Los buscadores devuelven los apóstrofos y acentos como entidades
  // numéricas (&#x27;, &#243;); sin esto los títulos llegan ilegibles.
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

async function fetchText(url, ua = UA_BROWSER) {
 const res = await fetch(url, {
  headers: { 'user-agent': ua, 'accept-language': 'es-MX,es;q=0.9' },
  signal: AbortSignal.timeout(TIMEOUT_MS),
 });
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 return res.text();
}

/** Titulares de prensa (con medio y fecha) para una pregunta en libre. */
async function newsResults(query) {
 const url = `${NEWS_RSS}?q=${encodeURIComponent(query)}&hl=es-419&gl=MX&ceid=MX:es-419`;
 const xml = await fetchText(url, UA_BOT);
 return [...xml.matchAll(/<item>(.*?)<\/item>/gs)].slice(0, 8).map((item) => {
  const field = (tag) => strip(item[1].match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'))?.[1] ?? '');
  return { source: 'Google News', title: field('title'), url: field('link'), date: field('pubDate') };
 });
}

/**
 * Resultados de buscador con URL directa (la única vía para leer el cuerpo).
 * Los anuncios se cuelan como enlaces a duckduckgo.com/y.js: se descartan.
 */
async function ddgResults(query) {
 const html = await fetchText(`${DDG_HTML}?q=${encodeURIComponent(query)}&kl=mx-es`);
 const out = [];
 for (const m of html.matchAll(/class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs)) {
  const target = decodeURIComponent(m[1].match(/[?&]uddg=([^&]+)/)?.[1] ?? '');
  if (!/^https?:\/\//.test(target)) continue;
  if (/(^|\.)duckduckgo\.com$/.test(new URL(target).hostname)) continue; // anuncio
  // El resumen del propio buscador ya adelanta si la nota trae fecha.
  const after = html.slice(m.index + m[0].length, m.index + m[0].length + 3000);
  const snippet = strip(after.match(/class="result__snippet"[^>]*>(.*?)<\/a>/s)?.[1] ?? '');
  out.push({ source: new URL(target).hostname.replace(/^www\./, ''), title: strip(m[2]), url: target, snippet });
  if (out.length >= 8) break;
 }
 return out;
}

/**
 * Texto legible de una nota. Se arma con los párrafos largos en vez de con
 * todo el HTML: los sitios de espectáculos traen menús y "lo más leído" que,
 * en crudo, ocupan el recorte entero y desplazan la nota real.
 */
async function readPage(url) {
 const html = await fetchText(url);
 const body = html.replace(/<(script|style|nav|footer|header|aside)[^>]*>.*?<\/\1>/gis, ' ');
 const paragraphs = [...body.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
  .map((m) => strip(m[1]))
  .filter((t) => t.length > 80);
 const meta = strip(
  html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)?.[1] ??
   html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i)?.[1] ??
   ''
 );
 const published = html.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]*)"/i)?.[1] ?? '';
 const text = [meta, ...paragraphs].filter(Boolean).join(' ').slice(0, EXCERPT_CHARS);
 return { text, published };
}

/**
 * Todo lo que la Pi puede averiguar por su cuenta sobre una pregunta.
 * Tolerante a fallos: cada fuente que se caiga simplemente no aporta.
 */
export async function gatherSources(query, { maxPages = MAX_PAGES } = {}) {
 const [news, ddg] = await Promise.allSettled([newsResults(query), ddgResults(query)]);
 const headlines = news.status === 'fulfilled' ? news.value : [];
 const links = ddg.status === 'fulfilled' ? ddg.value : [];

 // Solo los enlaces directos se pueden leer; los titulares entran tal cual.
 const read = await Promise.allSettled(links.slice(0, maxPages).map((r) => readPage(r.url)));
 const pages = links.slice(0, maxPages).map((r, i) => ({
  ...r,
  excerpt: read[i].status === 'fulfilled' ? read[i].value.text : r.snippet,
  date: read[i].status === 'fulfilled' ? read[i].value.published : '',
 }));

 return [...pages, ...links.slice(maxPages).map((r) => ({ ...r, excerpt: r.snippet })), ...headlines];
}

/**
 * Las fuentes tal cual, para meterlas en el prompt de un modelo.
 *
 * Las URL de Google News son redirecciones de ~450 caracteres: puestas en el
 * prompt se comían la cuarta parte del límite por minuto de Groq sin aportar
 * nada (esos titulares no traen texto y sus medios ya salen del buscador). Al
 * usuario sí se le dan enteras, que ahí sí funcionan al tocarlas.
 */
export function sourcesBlock(sources) {
 return sources
  .map((s, i) => {
   const lines = [`[${i + 1}] ${s.title}`, `  fuente: ${s.source}${s.date ? ` · ${s.date}` : ''}`];
   if (!isRedirect(s.url)) lines.push(`  url: ${s.url}`);
   if (s.excerpt) lines.push(`  texto: ${s.excerpt}`);
   return lines.join('\n');
  })
  .join('\n\n');
}

const isRedirect = (url) => /(^|\/\/)news\.google\.com\//.test(url);
