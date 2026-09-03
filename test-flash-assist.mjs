/**
 * Prueba en vivo (sin comprar nada, sin mandar Telegram) de la construcción
 * del deep link del flash-assist. No hay otra oportunidad de ensayar esto
 * contra el evento real, así que se corre contra datos de HOY:
 * - alguna película en cartelera que ya tenga función confirmada en Plaza
 *   Carso (nivel 3, el caso bueno).
 * - "La Rebelión" (Madoka), que a la fecha de este script está a la venta
 *   pero sin función en Plaza Carso todavía (nivel 2, el fallback real, no
 *   teórico — ya ocurrió con datos de producción).
 * - que isFlashTarget no dispare para HOPE, Primer impacto, ni las otras
 *   películas de Madoka ya en cartelera (regresión).
 */
import { snapshot, showtimesAt } from './watcher/cinepolis.mjs';
import { findMatches } from './watcher/match.mjs';
import {
 buildDeepLink, CINEMA_IDS, flashMessage, isFlashTarget, pickPlazaCarsoSession,
} from './watcher/madoka-flash.mjs';

let fallos = 0;
const check = (nombre, ok, detalle = '') => {
 console.log(`${ok ? '✓' : '✗'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
 if (!ok) fallos++;
};

console.log('Consultando catálogo de Cinépolis…\n');
const { movies } = await snapshot();
const enCdmx = movies.filter((m) => m.availableForSale && m.inCdmx);
check('hay al menos una película a la venta en CDMX hoy', enCdmx.length > 0, `${enCdmx.length} título(s)`);

// --- Caso 1: nivel 3, una función real cualquiera en Plaza Carso ---
let ejemploNivel3 = null;
for (const m of enCdmx.slice(0, 8)) {
 const detail = await showtimesAt(m.id, CINEMA_IDS).catch(() => null);
 const session = detail && pickPlazaCarsoSession(detail.sessions);
 if (session) { ejemploNivel3 = { movie: m, session }; break; }
}
if (ejemploNivel3) {
 const { level, url } = buildDeepLink(ejemploNivel3.movie, ejemploNivel3.session);
 check('nivel 3: arma link de asiento con sesión real', level === 3 && url.includes('/asientos?'), url);
 console.log(`  (ejemplo real: "${ejemploNivel3.movie.title}" en Plaza Carso)`);
} else {
 console.log('⚠️  Ninguna de las primeras 8 películas en cartelera tiene función en Plaza Carso todavía — no se pudo probar el nivel 3. Puede que el bot esté vigilando pocas coincidencias hoy; no es necesariamente un fallo.');
}

// --- Caso 2: nivel 2, Madoka "La Rebelión" (a la venta, sin Plaza Carso aún) ---
const rebelion = findMatches('la rebelion madoka', movies)[0];
if (rebelion) {
 const msg = await flashMessage(rebelion);
 check('flashMessage no lanza para "La Rebelión"', msg.level === 2 || msg.level === 3, `nivel ${msg.level}, ${msg.url}`);
} else {
 console.log('⚠️  No se encontró "La Rebelión" en el catálogo de hoy — puede que ya haya salido de cartelera; no es necesariamente un fallo.');
}

// --- Caso 3: isFlashTarget no dispara donde no debe (regresión) ---
const noDeberian = [
 { chain: 'Cinépolis', title: 'HOPE', originalTitle: '' },
 { chain: 'Cinépolis', title: 'Primer impacto', originalTitle: '' },
 { chain: 'Cinépolis', title: 'Puella Magi Madoka Magica: La Rebelión', originalTitle: '' },
 { chain: 'Cinépolis', title: 'Puella Magi Madoka Magica: La Película - Parte 2', originalTitle: '' },
 { chain: 'Cinemex', title: 'Madoka Walpurgisnacht: Risen', originalTitle: '' }, // otra cadena: tampoco
];
for (const m of noDeberian) check(`isFlashTarget(false) — "${m.title}" (${m.chain})`, isFlashTarget(m) === false);

check(
 'isFlashTarget(true) — el término real',
 isFlashTarget({ chain: 'Cinépolis', title: 'Madoka Walpurgisnacht: Risen', originalTitle: '' }) === true
);

console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo correcto');
process.exit(fallos ? 1 : 0);
