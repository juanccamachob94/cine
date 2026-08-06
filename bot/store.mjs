/**
 * Persistencia del proyecto: términos vigilados, última señal conocida de cada
 * película, alertas ya enviadas y bitácora.
 *
 * Todo son archivos JSON planos en data/. No hace falta más: el volumen es de
 * decenas de registros y así el estado es inspeccionable con `cat` desde la Pi
 * cuando algo se comporte raro.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const LOG_DIR = join(ROOT, 'log');
const WATCHES = join(DATA_DIR, 'watches.json');
const STATE = join(DATA_DIR, 'state.json');
const SEEN = join(DATA_DIR, 'seen.json');
const CHAT = join(DATA_DIR, 'chat-buffer.json');

const TZ = 'America/Mexico_City';

/** Fecha y hora actuales en CDMX (la zona que importa para las funciones). */
export function nowCdmx() {
 const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', {
   timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
   hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
   .formatToParts(new Date())
   .map((p) => [p.type, p.value])
 );
 const date = `${parts.year}-${parts.month}-${parts.day}`;
 const time = `${parts.hour}:${parts.minute}`;
 return { date, time, stamp: `${date} ${time}`, fileStamp: `${date}-${parts.hour}${parts.minute}${parts.second}` };
}

function read(path, fallback) {
 try {
  return JSON.parse(readFileSync(path, 'utf8'));
 } catch {
  return fallback;
 }
}

function write(path, value) {
 mkdirSync(dirname(path), { recursive: true });
 writeFileSync(path, JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------- términos

/** Términos vigilados: [{ term, addedBy, addedAt }]. */
export const listWatches = () => read(WATCHES, []);

/** Alta idempotente: devuelve false si el término ya estaba (comparación laxa). */
export function addWatch(term, addedBy) {
 const clean = term.trim();
 if (!clean) return false;
 const watches = listWatches();
 const already = watches.some(
  (w) => w.term.trim().toLowerCase() === clean.toLowerCase()
 );
 if (already) return false;
 watches.push({ term: clean, addedBy, addedAt: nowCdmx().stamp });
 write(WATCHES, watches);
 return true;
}

/**
 * Baja por número (el que muestra /terminos) o por texto. Devuelve el término
 * eliminado, o null si no había nada que eliminar.
 */
export function removeWatch(reference) {
 const watches = listWatches();
 const asIndex = Number.parseInt(reference, 10);
 const index = Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= watches.length
  ? asIndex - 1
  : watches.findIndex((w) => w.term.toLowerCase() === String(reference).trim().toLowerCase());
 if (index < 0) return null;
 const [removed] = watches.splice(index, 1);
 write(WATCHES, watches);
 return removed;
}

// ------------------------------------------------------------------ estado

/**
 * Última señal conocida por película: `{ "Cinépolis:id": { onSale, dates... } }`.
 * Es lo que permite distinguir "sigue igual" de "acaba de cambiar" — el
 * corazón de la detección.
 */
export const loadState = () => read(STATE, {});
export const saveState = (state) => write(STATE, state);

/**
 * Alertas ya enviadas, para no repetirlas tras un reinicio del servicio.
 * Clave: `${cadena}:${idPelícula}:${señal}`.
 */
export const loadSeen = () => read(SEEN, {});

export function markSeen(key) {
 const seen = loadSeen();
 seen[key] = nowCdmx().stamp;
 write(SEEN, seen);
}

export const wasSeen = (key) => key in loadSeen();

// ------------------------------------------------- memoria de conversación

const CHAT_MAX_TURNS = 10;
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_MSG_CAP = 1500;

const readChat = () =>
 read(CHAT, []).filter((turn) => Date.now() - turn.at < CHAT_TTL_MS);

/** Conversación reciente formateada para el prompt ('' si no hay). */
export const chatHistory = () =>
 readChat().map((t) => `Usuario: ${t.user}\nBot: ${t.bot}`).join('\n---\n');

export function appendChat(user, bot) {
 const turns = [
  ...readChat(),
  { at: Date.now(), user: user.slice(0, CHAT_MSG_CAP), bot: bot.slice(0, CHAT_MSG_CAP) },
 ].slice(-CHAT_MAX_TURNS);
 write(CHAT, turns);
}

// ---------------------------------------------------------------- bitácora

const slugify = (text) =>
 text
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 50);

/** Registro con fecha y hora CDMX; devuelve la ruta relativa. */
export function saveLogEntry(title, markdown) {
 mkdirSync(LOG_DIR, { recursive: true });
 const { fileStamp, stamp } = nowCdmx();
 const name = `${fileStamp}-${slugify(title)}.md`;
 writeFileSync(join(LOG_DIR, name), `# ${stamp} — ${title}\n\n${markdown}\n`);
 return `log/${name}`;
}

/** Últimos `n` registros, como contexto para la IA. */
export function recentLog(n = 10) {
 if (!existsSync(LOG_DIR)) return '';
 return readdirSync(LOG_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .slice(-n)
  .map((f) => `--- ${f} ---\n${readFileSync(join(LOG_DIR, f), 'utf8')}`)
  .join('\n\n');
}
