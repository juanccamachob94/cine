/**
 * Rastreo de fondo en prensa y redes.
 *
 * Las cadenas son la fuente de la verdad (si hay función, hay boleto), pero
 * casi siempre el anuncio circula antes por prensa de espectáculos y por las
 * cuentas oficiales. Este módulo cubre esa ventana previa.
 *
 * Se usan fuentes con feed abierto a propósito: Google News RSS agrega ya lo
 * que publican los medios *y* lo que replican de las cuentas oficiales, y
 * Reddit expone búsqueda en JSON. Ni X ni Instagram tienen hoy un camino
 * gratuito y estable sin credenciales, así que intentarlos solo añadiría
 * fragilidad; lo que se pierde por ahí suele llegar igual vía Google News.
 */
const NEWS_RSS = 'https://news.google.com/rss/search';
const REDDIT_SEARCH = 'https://www.reddit.com/search.json';
const TIMEOUT_MS = 25_000;
const UA = 'jc-cine-bot/1.0 (aviso personal de preventas)';

// Sin estas palabras, "avatar" trae reseñas y refritos; con ellas, el ruido
// baja muchísimo y quedan las notas que hablan de venta de boletos.
const SIGNALS = ['preventa', 'boletos', 'venta de boletos', 'ya a la venta'];

const decode = (text) =>
 text
  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, '')
  .trim();

async function fetchText(url) {
 const res = await fetch(url, {
  headers: { 'user-agent': UA },
  signal: AbortSignal.timeout(TIMEOUT_MS),
 });
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 return res.text();
}

/** Notas de prensa mexicana sobre la venta de boletos de un término. */
export async function news(term) {
 const query = `"${term}" (${SIGNALS.join(' OR ')}) (Cinépolis OR Cinemex OR México)`;
 const url = `${NEWS_RSS}?q=${encodeURIComponent(query)}&hl=es-419&gl=MX&ceid=MX:es-419`;
 const xml = await fetchText(url);
 return [...xml.matchAll(/<item>(.*?)<\/item>/gs)].slice(0, 8).map((item) => {
  const field = (tag) =>
   decode(item[1].match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'))?.[1] ?? '');
  return {
   source: 'Google News',
   title: field('title'),
   link: field('link'),
   date: field('pubDate'),
  };
 });
}

/** Conversación en Reddit (a menudo se enteran antes que la prensa). */
export async function reddit(term) {
 const url = `${REDDIT_SEARCH}?q=${encodeURIComponent(`${term} preventa boletos`)}&sort=new&limit=8&t=month`;
 const data = JSON.parse(await fetchText(url));
 return (data.data?.children ?? []).map((child) => ({
  source: `r/${child.data.subreddit}`,
  title: child.data.title,
  link: `https://www.reddit.com${child.data.permalink}`,
  date: new Date(child.data.created_utc * 1000).toISOString(),
 }));
}

/**
 * Todas las fuentes de un término. Tolerante a fallos: una fuente caída no
 * puede tumbar el rastreo entero.
 */
export async function research(term) {
 const results = await Promise.allSettled([news(term), reddit(term)]);
 return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
