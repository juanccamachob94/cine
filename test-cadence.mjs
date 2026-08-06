/** Comprueba la tabla de cadencias sin tocar la red ni el estado. */
import { nextDelay } from './watcher/poll.mjs';

const hoy = new Date().toISOString().slice(0, 16).replace('T', ' ');
const viejo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

const casos = [
 ['sin términos', { pending: [], unmatched: [] }, 90],
 ['término nuevo sin coincidencias (Madoka)', { pending: [], unmatched: [{ addedAt: hoy }] }, 20],
 ['término viejo que nunca apareció', { pending: [], unmatched: [{ addedAt: viejo }] }, 30],
 ['viejo + uno nuevo → manda el nuevo', { pending: [], unmatched: [{ addedAt: viejo }, { addedAt: hoy }] }, 20],
 ['película anunciada sin venta', { pending: [{}], unmatched: [] }, 20],
 ['anunciada gana sobre término viejo', { pending: [{}], unmatched: [{ addedAt: viejo }] }, 20],
 ['fecha ilegible → se trata como reciente', { pending: [], unmatched: [{ addedAt: 'xx' }] }, 20],
];

let fallos = 0;
for (const [nombre, entrada, esperado] of casos) {
 const real = nextDelay(entrada) / 1000;
 const ok = real === esperado;
 if (!ok) fallos++;
 console.log(`${ok ? '✓' : '✗'} ${nombre}: ${real}s (esperado ${esperado}s)`);
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo correcto');
process.exit(fallos ? 1 : 0);
