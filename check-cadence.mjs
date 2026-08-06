/**
 * Diagnóstico: reproduce lo que el vigilante calcula en un ciclo y dice a qué
 * ritmo va a sondear y por qué. No escribe nada: solo lee.
 */
import { listWatches, loadState } from './bot/store.mjs';
import { findMatches } from './watcher/match.mjs';
import { nextDelay, snapshotAll } from './watcher/poll.mjs';

const isOnSale = (m) =>
 m.chain === 'Cinépolis' ? Boolean(m.availableForSale && m.inCdmx) : Boolean(m.availableForSale);

const watches = listWatches();
const { movies, errors } = await snapshotAll();
errors.forEach((e) => console.log('⚠️', e));
console.log(`catálogo: ${movies.length} títulos\n`);

const pending = [];
const unmatched = [];
for (const w of watches) {
 const found = findMatches(w.term, movies);
 if (!found.length) unmatched.push(w);
 console.log(`término "${w.term}" (alta: ${w.addedAt}) → ${found.length} coincidencia(s)`);
 for (const m of found) {
  const sale = isOnSale(m);
  if (!sale) pending.push(m);
  console.log(`  ${sale ? '✅ a la venta' : '⏳ anunciada sin venta'} — ${m.chain}: ${m.title}`);
 }
 if (!found.length) console.log('  🕓 todavía no existe en ningún catálogo: esperando a que aparezca');
}

const delay = nextDelay({ pending, unmatched });
const razon = pending.length
 ? 'hay una película anunciada sin venta abierta'
 : unmatched.length
  ? 'hay términos esperando a aparecer en el catálogo'
  : 'no hay nada inminente';

console.log(`\npendientes: ${pending.length} | esperando a aparecer: ${unmatched.length}`);
console.log(`→ PRÓXIMO SONDEO EN ${delay / 1000} s (${razon})`);
console.log(`\nestado guardado: ${Object.keys(loadState()).length} película(s)`);
