/**
 * El vigilante: sondea Cinépolis y Cinemex y decide cuándo hay algo que avisar.
 *
 * La idea de fondo es que el objetivo no es "leer la cartelera" sino detectar
 * un *cambio de estado*: el instante en que una película pasa de anunciada a
 * comprable en CDMX. Por eso todo gira alrededor de comparar el sondeo actual
 * contra el anterior (data/state.json), no de mirar la foto de hoy.
 *
 * Cadencia adaptativa: en reposo se sondea tranquilo, pero en cuanto una
 * película vigilada aparece anunciada sin venta abierta, el intervalo baja a
 * segundos — es exactamente la ventana en la que se gana o se pierde la
 * carrera por el boleto. Un sondeo son 3 peticiones en total, así que incluso
 * en modo turbo la carga es mínima.
 */
import * as cinemex from './cinemex.mjs';
import * as cinepolis from './cinepolis.mjs';
import { findMatches } from './match.mjs';
import { listWatches, loadState, markSeen, saveState, wasSeen } from '../bot/store.mjs';

const IDLE_MS = 90_000;  // nada inminente: ritmo de crucero
const TURBO_MS = 20_000; // hay una peli vigilada anunciada y aún sin venta
const ERROR_BACKOFF_MS = 120_000;

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
 const writes = new Map();  // clave → estado a persistir
 const blocked = new Set(); // claves con alerta todavía sin entregar
 const alerted = new Set(); // una alerta por película por ciclo

 for (const watch of watches) {
  for (const movie of findMatches(watch.term, movies)) {
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

 return { alerts, pending, commit };
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

   const { alerts, pending, commit } = detect(movies, { watches });
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
   delay = pending.length ? TURBO_MS : IDLE_MS;
  } catch (err) {
   onError(err);
   delay = ERROR_BACKOFF_MS;
  }
  schedule(delay);
 }

 tick();
 return () => { stopped = true; };
}
