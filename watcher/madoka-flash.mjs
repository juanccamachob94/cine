/**
 * Flash-assist específico de "Madoka Walpurgisnacht: Risen" en Cinépolis
 * Plaza Carso.
 *
 * No es una feature genérica: HOPE, Primer impacto y cualquier término
 * futuro nunca pasan por aquí. bot/index.mjs solo la invoca cuando
 * isFlashTarget(alert.movie) es cierto.
 *
 * Por qué existe: la alerta normal (onSaleAlert) manda un link genérico a la
 * página de la película. Para este estreno en particular, el usuario quiere
 * llegar de un tap al mapa de asientos de Plaza Carso, la función más
 * temprana del día — sin buscar el cine entre los ~87 de CDMX.
 *
 * Ningún dato de pago ni de sesión de usuario pasa por aquí: el botón es un
 * link `url` puro hacia el sitio público de Cinépolis. El pago lo hace el
 * usuario, con su propio dedo, en su propia cuenta.
 */
import { showtimesAt } from './cinepolis.mjs';
import { normalize } from './match.mjs';

// Plaza Carso normal primero; VIP como alterna si es la única con función.
export const CINEMA_IDS = ['cinepolis-plaza-carso-cdmx', 'cinepolis-vip-plaza-carso-cdmx'];
const TITLE_HINTS = ['walpurgisnacht', 'walpurgis', 'risen'];

const WATCH_INTERVAL_MS = 25_000;
const WATCH_MAX_TRIES = 40; // ~17 min de reintentos tras la alerta inicial

const HORA = { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false };
const DIA = { timeZone: 'America/Mexico_City', day: '2-digit', month: 'short' };
const hora = (iso) => {
 const d = new Date(iso);
 return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('es-MX', HORA);
};
const dia = (fecha) => {
 const d = new Date(`${fecha}T12:00:00`);
 return Number.isNaN(d.getTime()) ? fecha : d.toLocaleDateString('es-MX', DIA);
};

/** ¿Esta película es la que nos importa para el flash-assist? */
export function isFlashTarget(movie) {
 if (movie?.chain !== 'Cinépolis') return false;
 const title = normalize(`${movie.title ?? ''} ${movie.originalTitle ?? ''}`);
 return TITLE_HINTS.some((hint) => title.includes(hint));
}

/** La función más temprana en Plaza Carso (normal o VIP) dentro de sessions. */
export function pickPlazaCarsoSession(sessions = []) {
 const candidates = sessions.filter((s) => CINEMA_IDS.includes(s.cinemaId));
 if (!candidates.length) return null;
 return candidates.reduce((earliest, s) => (s.datetime < earliest.datetime ? s : earliest));
}

/**
 * Deep link en el mejor nivel posible con lo que se sabe ahora mismo:
 * 3 = asiento exacto, 2 = horarios de Plaza Carso, 1 = link genérico de la
 * película (mismo que ya usa onSaleAlert). Nunca lanza: si algo falta, cae
 * al nivel de abajo.
 */
export function buildDeepLink(movie, session) {
 if (session) {
  const params = new URLSearchParams({
   country: 'mx', movie: movie.id, cinema: session.cinemaId,
   selected: session.cinemaId, session: session.sessionId,
  });
  return { level: 3, url: `https://cinepolis.com/mx/asientos?${params}` };
 }
 if (movie?.id) {
  const params = new URLSearchParams({ movie: movie.id, cinema: CINEMA_IDS[0] });
  return { level: 2, url: `https://cinepolis.com/mx/horarios?${params}` };
 }
 return { level: 1, url: movie?.url };
}

/**
 * Mensaje + botón para la alerta inicial. Consulta Plaza Carso en directo
 * (no confía en alert.detail: showtimes() trunca a las 40 funciones más
 * tempranas de toda CDMX y Plaza Carso podría quedar fuera del corte aunque
 * ya tenga función). Nunca lanza — con nivel 1 basta con movie.url.
 */
export async function flashMessage(movie) {
 let session = null;
 try {
  const detail = await showtimesAt(movie.id, CINEMA_IDS);
  session = pickPlazaCarsoSession(detail.sessions);
 } catch (err) {
  console.error('[flash-assist]', err.message);
 }
 const { level, url } = buildDeepLink(movie, session);
 const label = '🎟️ Comprar — Plaza Carso';

 if (level === 3) {
  return {
   level, url, label,
   text: [
    '🎯 Plaza Carso ya tiene función',
    `${dia(session.date)} ${hora(session.datetime)}${session.format ? ` — ${session.format}` : ''}`,
    '',
    'Un tap y eliges asiento.',
   ].join('\n'),
  };
 }
 if (level === 2) {
  return {
   level, url, label,
   text: [
    '⚠️ Plaza Carso todavía no publica horario para esta función.',
    'Este botón te lleva directo a los horarios de Plaza Carso — en cuanto',
    'aparezca la función ahí la ves. Sigo revisando y aviso en cuanto se abra.',
   ].join('\n'),
  };
 }
 return {
  level, url, label,
  text: '⚠️ No pude aislar Plaza Carso automáticamente. Usa el link de la alerta de arriba y busca Plaza Carso a mano.',
 };
}

/**
 * Tras un nivel 2, reintenta hasta encontrar función en Plaza Carso (o hasta
 * agotar el tope). Se detiene solo en cualquiera de los dos casos — no se
 * queda corriendo para siempre.
 */
export function watchForPlazaCarso(movie, { onFound, onGiveUp = () => {} } = {}) {
 let tries = 0;
 const tick = async () => {
  tries += 1;
  try {
   const detail = await showtimesAt(movie.id, CINEMA_IDS);
   const session = pickPlazaCarsoSession(detail.sessions);
   if (session) {
    onFound({ session, url: buildDeepLink(movie, session).url });
    return;
   }
  } catch (err) {
   console.error('[flash-assist]', err.message);
  }
  if (tries < WATCH_MAX_TRIES) setTimeout(tick, WATCH_INTERVAL_MS).unref?.();
  else onGiveUp();
 };
 setTimeout(tick, WATCH_INTERVAL_MS).unref?.();
}
