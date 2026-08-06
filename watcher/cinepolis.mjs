/**
 * Cinépolis: envoltura del fetcher de Python (ver scraper/cinepolis_fetch.py
 * para el porqué del subproceso — Cloudflare bloquea el fingerprint TLS de
 * Node, así que este es el único camino que funciona desde la Pi).
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scraper/cinepolis_fetch.py');
const TIMEOUT_MS = 90_000;

async function run(...args) {
 let stdout;
 try {
  ({ stdout } = await execFileAsync('python3', [SCRIPT, ...args], {
   timeout: TIMEOUT_MS,
   maxBuffer: 32 * 1024 * 1024,
  }));
 } catch (err) {
  // El script escribe {"error": ...} en stdout y sale con código 1: ese
  // mensaje es mucho más útil que el "Command failed" de execFile.
  const reported = err.stdout && safeParse(err.stdout)?.error;
  throw new Error(`Cinépolis: ${reported ?? err.message}`);
 }
 const data = safeParse(stdout);
 if (!data) throw new Error('Cinépolis: el fetcher no devolvió JSON válido.');
 if (data.error) throw new Error(`Cinépolis: ${data.error}`);
 return data;
}

function safeParse(text) {
 try {
  return JSON.parse(text);
 } catch {
  return null;
 }
}

/** Catálogo nacional + qué está disponible en cines de CDMX. */
export const snapshot = () => run('snapshot');

/** Funciones reales (con sessionId) de una película en cines de CDMX. */
export const showtimes = (movieId) => run('showtimes', movieId);
