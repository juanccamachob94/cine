/**
 * Cinemex: API REST del sitio (api.cinemex.com). A diferencia de Cinépolis,
 * aquí basta el fetch nativo de Node — no hay Cloudflare de por medio.
 *
 * La consumer key sale del bundle público del sitio; es la misma para todos
 * los visitantes.
 *
 * Nota de rendimiento, que aquí manda el diseño: la cartelera por estado
 * (`cinemas/state/8/movies/?date=…`) devuelve ~7.6 MB y tarda ~27 s por
 * fecha, así que es inservible para sondear. En cambio `cinemas/{cine}/movies/
 * {peli}` responde en ~200 ms con 19 KB. Por eso el detalle de funciones se
 * arma preguntando cine por cine en paralelo, y no por fechas.
 */
const BASE = 'https://api.cinemex.com/rest/v2.37.2/';
const HEADERS = {
 'X-API-Consumer-Key': '',
 origin: 'https://cinemex.com',
 referer: 'https://cinemex.com/',
};
const STATE_CDMX = 8; // "CDMX y Área Metropolitana"
const TIMEOUT_MS = 45_000;
const CONCURRENCY = 10;
const CINEMAS_TTL_MS = 6 * 60 * 60 * 1000;

async function get(path, params = {}) {
 const url = new URL(path, BASE);
 for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
 const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
 if (!res.ok) throw new Error(`Cinemex: HTTP ${res.status} en ${path}`);
 return res.json();
}

// El catálogo de cines cambia como mucho un par de veces al año: pedirlo en
// cada consulta serían 223 KB tirados a la basura.
let cinemasCache = { at: 0, list: [] };

async function cdmxCinemas() {
 if (Date.now() - cinemasCache.at < CINEMAS_TTL_MS && cinemasCache.list.length) {
  return cinemasCache.list;
 }
 const all = await get('cinemas');
 const list = all
  .filter((c) => c.state?.id === STATE_CDMX && c.status === 'open')
  .map((c) => ({ id: c.id, name: c.name }));
 cinemasCache = { at: Date.now(), list };
 return list;
}

const ribbonLabels = (movie) => (movie.ribbons ?? []).map((r) => r?.label).filter(Boolean);

/**
 * Catálogo vigente de Cinemex.
 *
 * Es nacional, pero Cinemex solo publica aquí lo que ya se puede comprar —
 * incluida la preventa, marcada con el ribbon "Preventa". Es decir: que un
 * título aparezca en esta lista ES la señal de venta abierta. Son 26 títulos
 * y una sola petición, así que se puede sondear cada pocos segundos.
 */
export async function snapshot() {
 const catalogue = await get('movies');
 const movies = catalogue.map((m) => {
  const labels = ribbonLabels(m);
  return {
   chain: 'Cinemex',
   id: String(m.id),
   title: m.name,
   originalTitle: m.info?.original_title ?? '',
   releaseDate: m.date_created ?? '',
   categories: labels,
   presale: labels.some((l) => /preventa/i.test(l)),
   comingSoon: false,
   availableForSale: true,
   inCdmx: true, // se confirma de verdad en showtimes()
   url: m.url?.startsWith('//') ? `https:${m.url}` : (m.url ?? 'https://cinemex.com/'),
  };
 });
 return { chain: 'Cinemex', movies };
}

/** Corre `task` sobre `items` con concurrencia acotada, ignorando los fallos sueltos. */
async function mapLimit(items, limit, task) {
 const results = [];
 let cursor = 0;
 const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
  while (cursor < items.length) {
   const item = items[cursor++];
   try {
    results.push(await task(item));
   } catch {
    // Un cine que falla no puede invalidar la consulta entera.
   }
  }
 });
 await Promise.all(workers);
 return results;
}

/**
 * Funciones de una película en los cines de CDMX, con el enlace directo de
 * compra que Cinemex expone por sesión (checkout/<sessionId>) — el atajo real
 * para ser el primero en pagar.
 */
export async function showtimes(movieId) {
 const cinemas = await cdmxCinemas();
 const wanted = String(movieId);
 const sessions = [];
 let buyUrl = null;

 const perCinema = await mapLimit(cinemas, CONCURRENCY, async (cinema) => {
  const movie = await get(`cinemas/${cinema.id}/movies/${wanted}`);
  return { cinema, versions: movie?.versions ?? [] };
 });

 for (const { cinema, versions } of perCinema) {
  for (const version of versions) {
   for (const session of version.sessions ?? []) {
    buyUrl ??= session.url;
    sessions.push({
     cinema: cinema.name,
     date: String(session.datetime).slice(0, 10),
     datetime: session.datetime,
     language: version.attributes?.primary_label ?? version.label ?? '',
     format: version.label ?? '',
     sessionId: String(session.id),
     availability: session.availability ?? '',
     url: session.url,
    });
   }
  }
 }

 sessions.sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
 return {
  chain: 'Cinemex',
  movieId: wanted,
  dates: [...new Set(sessions.map((s) => s.date))].sort(),
  cinemas: new Set(sessions.map((s) => s.cinema)).size,
  count: sessions.length,
  sessions: sessions.slice(0, 40),
  url: buyUrl ?? `https://cinemex.com/pelicula/${wanted}`,
 };
}
