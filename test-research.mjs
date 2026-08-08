/**
 * Prueba manual de `/investiga` (toca la red a propósito).
 *
 *  node --env-file=.env test-research.mjs "cuándo abre la preventa de Avatar en México"
 *  node --env-file=.env test-research.mjs --fuentes "..."  solo la búsqueda propia
 *
 * Sirve para comprobar lo que importa de este comando: que la respuesta salga
 * de la web de hoy y no de la memoria del modelo. Si alguna vez vuelve a
 * aparecer un texto sin fuentes ni URLs, algo se rompió.
 */
import { gatherSources, sourcesBlock } from './watcher/websearch.mjs';
import { research } from './bot/ai.mjs';
import { nowCdmx } from './bot/store.mjs';

const args = process.argv.slice(2);
const soloFuentes = args.includes('--fuentes');
const query = args.filter((a) => a !== '--fuentes').join(' ') ||
 'cuándo abre la preventa de boletos de Avatar Fuego y Ceniza en México';

console.log(`Consulta: ${query}\n`);

const t0 = Date.now();
if (soloFuentes) {
 const sources = await gatherSources(query);
 console.log(`${sources.length} fuentes en ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
 console.log(sourcesBlock(sources));
} else {
 console.log(await research(query, nowCdmx()));
 console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
