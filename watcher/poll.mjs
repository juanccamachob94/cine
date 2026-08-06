/**
 * El vigilante: sondea Cinépolis y Cinemex y decide cuándo hay algo que avisar.
 *
 * La idea de fondo es que el objetivo no es "leer la cartelera" sino detectar
 * un *cambio de estado*: el instante en que una película pasa de anunciada a
 * comprable en CDMX. Por eso todo gira alrededor de comparar el sondeo actual
 * contra el anterior (data/state.json), no de mirar la foto de hoy.
 *
 * Cadencia adaptativa: el intervalo baja a segundos siempre que haya algo que
 * pueda abrir venta en cualquier momento. Son dos casos, y el segundo es el
 * que más importa:
 *
 * 1. Una película vigilada ya anunciada pero todavía sin venta.
 * 2. Un término que NO coincide con nada del catálogo — se está esperando a
 *   que aparezca. Es el caso de mayor riesgo, porque Cinemex solo publica lo
 *   que ya se puede comprar: ahí una película pasa de invisible a comprable
 *   de golpe, sin estado intermedio que avise. Sondear esto despacio sería
 *   justo lo contrario de lo que hace falta.
 *
 * Un sondeo son 3 peticiones en total, así que ni en modo turbo pesa.
 */
import * as cinemex from './cinemex.mjs';
import * as cinepolis from './cinepolis.mjs';
import { findMatches } from './match.mjs';
import { listWatches, loadState, markSeen, saveState, wasSeen } from '../bot/store.mjs';

const IDLE_MS = 90_000;  // nada que esperar: ritmo de crucero
const TURBO_MS = 20_000; // hay algo que puede abrir venta en cualquier momento
const STALE_WATCH_MS = 30_000; // término viejo que nunca ha aparecido
const ERROR_BACKOFF_MS = 120_000;

// A partir de aquí, un término que jamás coincidió con nada se considera frío
// (título mal escrito, o una película que no va a llegar): sigue vigilado, pero
// deja de justificar el ritmo máximo.
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Clave estable de una película entre sondeos. */
const keyOf = (movie) => `${movie.chain}:${movie.id}`;

/**
 * ¿Se puede comprar YA en CDMX?
 *
 * Cada cadena lo dice a su manera: Cinépolis expone `availableForSale` y si la
 * película tiene cines de CDMX asignados; Cinemex solo publica en su catálogo
 * lo que ya está a la venta, así que basta con que aparezca.
 */
const isOnSale = (movie) =>
 movie.chain === 'Cinépolis'
  ? Boolean(movie.availableForSale && movie.inCdmx)
  : Boolean(movie.availableForSale);

/** Sondea ambas cadenas. Si una falla, se sigue con la otra: media señal es mejor que ninguna. */
export async function snapshotAll() {
 const [cx, cp] = await Promise.allSettled([cinemex.snapshot(), cinepolis.snapshot()]);
 const movies = [];
 const errors = [];
 for (const [name, result] of [['Cinemex', cx], ['Cinépolis', cp]]) {
  if (result.status === 'fulfilled') movies.push(...result.value.movies);
  else errors.push(`${name}: ${result.reason.message}`);
 }
 if (!movies.length && errors.length) throw new Error(errors.join(' | '));
 return { movies, errors };
}

/** Funciones y enlace de compra de una película concreta. */
export const showtimesOf = (movie) =>
 movie.chain === 'Cinépolis' ? cinepolis.showtimes(movie.id) : cinemex.showtimes(movie.id);

/**
 * Compara el sondeo con el estado guardado y devuelve las alertas nuevas.
 *
 * Dos señales, con prioridades distintas:
 * - `onsale`: se puede comprar. Es LA alerta.
 * - `announced`: apareció en el catálogo pero todavía sin venta. Es un aviso
 *  de que la preventa viene en camino (y lo que enciende el modo turbo).
 *
 * El estado NO se guarda aquí. Se devuelve un `commit(entregadas)` que el
 * llamador invoca cuando ya sabe qué alertas salieron de verdad: si Telegram
 * falla, la película se queda con su estado anterior y el siguiente ciclo
 * vuelve a intentarlo. Perder el aviso por un error de red sería justo el
 * único fallo que este proyecto no se puede permitir.
 */
export function detect(movies, { watches = listWatches() } = {}) {
 const state = loadState();
 const alerts = [];
 const pending = [];
 const unmatched = [];    // términos que aún no existen en ningún catálogo
 const writes = new Map();  // clave → estado a persistir
 const blocked = new Set(); // claves con alerta todavía sin entregar
 const alerted = new Set(); // una alerta por película por ciclo

 for (const watch of watches) {
  const found = findMatches(watch.term, movies);
  if (!found.length) unmatched.push(watch);
  for (const movie of found) {
   const key = keyOf(movie);
   const onSale = isOnSale(movie);
   const previous = state[key];

   if (!alerted.has(key)) {
    const kind = onSale ? 'onsale' : 'announced';
    const seenKey = `${key}:${kind}`;
    // Solo en la transición (o la primera vez que se ve). `wasSeen` cubre
    // el reinicio del servicio con el estado ya guardado.
    const isNew = onSale ? !previous?.onSale : !previous;
    if (isNew && !wasSeen(seenKey)) {
     alerts.push({ kind, term: watch.term, movie, key, seenKey });
     blocked.add(key);
     alerted.add(key);
    }
   }

   if (!onSale) pending.push({ term: watch.term, movie });

   writes.set(key, {
    title: movie.title,
    chain: movie.chain,
    onSale,
    categories: movie.categories,
    releaseDate: movie.releaseDate,
    lastSeen: new Date().toISOString(),
   });
  }
 }

 const commit = (delivered = new Set()) => {
  const next = loadState();
  for (const [key, entry] of writes) {
   if (blocked.has(key) && !delivered.has(key)) continue; // se reintenta
   next[key] = entry;
  }
  saveState(next);
 };

 return { alerts, pending, unmatched, commit };
}

/** Antigüedad de un término, en ms. Si la fecha no se puede leer, se trata como recién puesto. */
function ageOf(watch) {
 const parsed = Date.parse(String(watch.addedAt ?? '').replace(' ', 'T'));
 return Number.isNaN(parsed) ? 0 : Date.now() - parsed;
}

/**
 * Ritmo del siguiente sondeo.
 *
 * Ante la duda se elige ir rápido: el costo de un sondeo de más es
 * despreciable, y el de llegar tarde es perder el boleto.
 */
export function nextDelay({ pending, unmatched }) {
 if (pending.length) return TURBO_MS;
 if (!unmatched.length) return IDLE_MS;
 const alguienReciente = unmatched.some((watch) => ageOf(watch) < STALE_AFTER_MS);
 return alguienReciente ? TURBO_MS : STALE_WATCH_MS;
}

/**
 * Bucle de vigilancia. `onAlert` recibe cada alerta ya enriquecida con las
 * funciones concretas (cuando las hay) y debe lanzar si no pudo entregarla.
 */
export function startWatcher({ onAlert, onError = () => {} }) {
 let stopped = false;

 const schedule = (ms) => {
  if (stopped) return;
  setTimeout(tick, ms).unref?.();
 };

 async function tick() {
  let delay = IDLE_MS;
  try {
   const watches = listWatches();
   if (!watches.length) {
    // Sin términos registrados no hay nada que detectar: no tiene sentido
    // castigar a las APIs mientras tanto.
    schedule(IDLE_MS);
    return;
   }
   const { movies, errors } = await snapshotAll();
   errors.forEach((e) => onError(new Error(e)));

   const { alerts, pending, unmatched, commit } = detect(movies, { watches });
   const delivered = new Set();

   for (const alert of alerts) {
    // Las funciones concretas son opcionales: si fallan, la alerta sale
    // igual. Llegar tarde con el detalle sería peor que llegar sin él.
    let detail = null;
    if (alert.kind === 'onsale') {
     try {
      detail = await showtimesOf(alert.movie);
     } catch (err) {
      onError(err);
     }
    }
    try {
     await onAlert({ ...alert, detail });
     markSeen(alert.seenKey);
     delivered.add(alert.key);
    } catch (err) {
     onError(new Error(`No se entregó la alerta de ${alert.movie.title}: ${err.message}`));
    }
   }

   commit(delivered);
   delay = nextDelay({ pending, unmatched });
  } catch (err) {
   onError(err);
   delay = ERROR_BACKOFF_MS;
  }
  schedule(delay);
 }

 tick();
 return () => { stopped = true; };
}
