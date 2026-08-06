/**
 * Bot de Telegram + vigilante de boletos, en un solo proceso.
 *
 * Van juntos a propósito: el vigilante necesita empujar mensajes al grupo en
 * cuanto detecta algo, y el bot necesita leer y escribir la misma lista de
 * términos. Separarlos obligaría a inventar un canal entre ambos sin ganar
 * nada — el trabajo total son un puñado de peticiones HTTP por minuto.
 *
 * Long polling: funciona detrás del NAT de casa, sin abrir puertos.
 */
import { Bot } from 'grammy';
import { processMessage, research } from './ai.mjs';
import {
 announcedAlert, newsReport, onSaleAlert, statusReport, watchList,
} from './format.mjs';
import {
 addWatch, appendChat, chatHistory, listWatches, nowCdmx, recentLog,
 removeWatch, saveLogEntry,
} from './store.mjs';
import { findMatches } from '../watcher/match.mjs';
import { research as socialResearch } from '../watcher/news.mjs';
import { snapshotAll, showtimesOf, startWatcher } from '../watcher/poll.mjs';

for (const name of ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'TELEGRAM_GROUP_CHAT_ID']) {
 if (!process.env[name]) {
  console.error(`Falta la variable de entorno ${name} (ver .env.example)`);
  process.exit(1);
 }
}

const ALLOWED_USERS = new Set(
 (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
);
if (!ALLOWED_USERS.size) {
 console.error('Falta TELEGRAM_ALLOWED_USER_IDS en .env');
 process.exit(1);
}

const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID;
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Telegram corta en 4096 caracteres por mensaje.
async function send(chatId, text) {
 for (let i = 0; i < text.length; i += 4000) {
  await bot.api.sendMessage(chatId, text.slice(i, i + 4000), {
   link_preview_options: { is_disabled: true },
  });
 }
}

const reply = (ctx, text) => send(ctx.chat.id, text);

const senderOf = (ctx) => ctx.from?.first_name || 'Usuario';

// Solo los dos usuarios autorizados, tanto en el grupo como en privado.
bot.use((ctx, next) => {
 if (!ALLOWED_USERS.has(String(ctx.from?.id))) return;
 return next();
});

// ------------------------------------------------------------- comandos

bot.command('start', (ctx) =>
 reply(
  ctx,
  [
   '🎟️ Boletos Cine CDMX',
   '',
   'Vigilo Cinépolis y Cinemex sin parar y les aviso aquí en cuanto se',
   'pueda comprar boletos en CDMX de las películas que registren.',
   '',
   'Comandos:',
   '/agregar <película> — empezar a vigilarla',
   '/eliminar <número> — dejar de vigilarla',
   '/terminos      — ver la lista',
   '/estado       — cómo va cada término ahora mismo',
   '/buscar <texto>   — consultar una película sin registrarla',
   '/noticias <texto>  — qué se dice en prensa y Reddit',
   '/investiga <texto> — que la IA busque en internet cuándo abre la preventa',
   '',
   'También me pueden escribir normal, sin comandos:',
   '"avísame de la nueva de Avatar", "¿ya salió Wicked?", etc.',
  ].join('\n')
 )
);

bot.command('agregar', async (ctx) => {
 const term = ctx.match?.trim();
 if (!term) return reply(ctx, 'Dime qué película vigilar. Ejemplo:\n/agregar Avatar Fuego y Ceniza');
 await doAdd(ctx, [term]);
});

bot.command('eliminar', async (ctx) => {
 const reference = ctx.match?.trim();
 if (!reference) return reply(ctx, 'Dime cuál eliminar (número o título).\nMira la lista con /terminos');
 const removed = removeWatch(reference);
 await reply(
  ctx,
  removed
   ? `🗑️ Ya no vigilo "${removed.term}".`
   : `No encontré "${reference}" en la lista. Revisa /terminos`
 );
});

bot.command(['terminos', 'lista'], (ctx) => reply(ctx, watchList(listWatches())));

bot.command('estado', async (ctx) => {
 const watches = listWatches();
 if (!watches.length) return reply(ctx, watchList(watches));
 await reply(ctx, '⏳ Consultando Cinépolis y Cinemex…');
 try {
  const { movies, errors } = await snapshotAll();
  const blocks = [];
  for (const watch of watches) {
   blocks.push(await describeTerm(watch.term, movies));
  }
  const notes = errors.length ? `\n\n⚠️ ${errors.join('\n⚠️ ')}` : '';
  await reply(ctx, `${blocks.join('\n\n──────────\n\n')}\n\n🕐 ${nowCdmx().stamp} CDMX${notes}`);
 } catch (err) {
  await reply(ctx, `⚠️ No pude consultar las cadenas: ${err.message}`);
 }
});

bot.command('buscar', async (ctx) => {
 const term = ctx.match?.trim();
 if (!term) return reply(ctx, 'Dime qué buscar. Ejemplo:\n/buscar Avatar');
 await reply(ctx, `⏳ Buscando "${term}"…`);
 try {
  const { movies } = await snapshotAll();
  await reply(ctx, await describeTerm(term, movies));
 } catch (err) {
  await reply(ctx, `⚠️ No pude consultar las cadenas: ${err.message}`);
 }
});

bot.command('noticias', async (ctx) => {
 const term = ctx.match?.trim();
 if (!term) return reply(ctx, 'Dime de qué película. Ejemplo:\n/noticias Avatar');
 await reply(ctx, `📰 Rastreando prensa y Reddit sobre "${term}"…`);
 try {
  await reply(ctx, newsReport(term, await socialResearch(term)));
 } catch (err) {
  await reply(ctx, `⚠️ Falló el rastreo: ${err.message}`);
 }
});

bot.command(['investiga', 'ia'], async (ctx) => {
 const query = ctx.match?.trim();
 if (!query) return reply(ctx, 'Dime qué investigar. Ejemplo:\n/investiga cuándo abre la preventa de Avatar en México');
 await reply(ctx, `🔎 Investigando: ${query}`);
 try {
  await reply(ctx, await research(query, nowCdmx()));
 } catch (err) {
  await reply(ctx, `⚠️ La investigación falló: ${err.message}`);
 }
});

// --------------------------------------------------------------- texto libre

bot.on('message:text', async (ctx) => {
 if (ctx.message.text.startsWith('/')) return; // comando no reconocido
 const labeled = `[${senderOf(ctx)}] ${ctx.message.text}`;
 try {
  const result = await processMessage(labeled, {
   ...nowCdmx(),
   watches: listWatches(),
   chat: chatHistory(),
   log: recentLog(),
  });
  const answer = await handleIntent(ctx, result);
  appendChat(labeled, answer);
 } catch (err) {
  console.error(err);
  await reply(ctx, `⚠️ Error: ${err.message}`);
 }
});

/** Ejecuta lo que la IA entendió y devuelve el texto que se envió. */
async function handleIntent(ctx, result) {
 const { intent, terms = [], query, answer, via } = result;
 const signature = via ? `\n\n🤖 ${via}` : '';

 if (intent === 'agregar' && terms.length) {
  return doAdd(ctx, terms, answer);
 }

 if (intent === 'eliminar' && terms.length) {
  const removed = terms.map((t) => removeWatch(t)).filter(Boolean);
  const text = removed.length
   ? `🗑️ Ya no vigilo: ${removed.map((r) => `"${r.term}"`).join(', ')}.`
   : `No encontré eso en la lista. Revisa /terminos`;
  await reply(ctx, text);
  return text;
 }

 if (intent === 'listar') {
  const text = watchList(listWatches());
  await reply(ctx, text);
  return text;
 }

 if (intent === 'consultar' && terms.length) {
  await reply(ctx, `⏳ Consultando "${terms[0]}"…`);
  try {
   const { movies } = await snapshotAll();
   const text = await describeTerm(terms[0], movies);
   await reply(ctx, text);
   return text;
  } catch (err) {
   const text = `⚠️ No pude consultar las cadenas: ${err.message}`;
   await reply(ctx, text);
   return text;
  }
 }

 if (intent === 'investigar') {
  const q = query || terms[0] || ctx.message.text;
  await reply(ctx, `🔎 Investigando: ${q}`);
  try {
   const text = await research(q, nowCdmx());
   await reply(ctx, text);
   return text;
  } catch (err) {
   const text = `⚠️ La investigación falló: ${err.message}`;
   await reply(ctx, text);
   return text;
  }
 }

 const text = `${answer}${signature}`;
 await reply(ctx, text);
 return text;
}

/** Alta de términos, con confirmación de si ya se puede comprar. */
async function doAdd(ctx, terms, aiAnswer) {
 const added = [];
 const repeated = [];
 for (const term of terms) {
  (addWatch(term, senderOf(ctx)) ? added : repeated).push(term);
 }

 const lines = [];
 if (added.length) lines.push(`✅ Vigilando: ${added.map((t) => `"${t}"`).join(', ')}`);
 if (repeated.length) lines.push(`ℹ️ Ya estaba(n) en la lista: ${repeated.map((t) => `"${t}"`).join(', ')}`);
 if (aiAnswer) lines.push('', aiAnswer);
 const text = lines.join('\n');
 await reply(ctx, text);

 saveLogEntry(`Alta de términos: ${terms.join(', ')}`, `Registrados por ${senderOf(ctx)}.`);

 // Puede que la venta ya esté abierta: sería absurdo esperar al siguiente
 // sondeo para decirlo.
 if (added.length) {
  try {
   const { movies } = await snapshotAll();
   for (const term of added) {
    const text = await describeTerm(term, movies);
    await reply(ctx, text);
   }
  } catch {
   // El vigilante lo resolverá en su próximo ciclo.
  }
 }
 return text;
}

/** Estado actual de un término, con funciones si ya está a la venta. */
async function describeTerm(term, movies) {
 const found = findMatches(term, movies);
 const enriched = [];
 for (const movie of found) {
  const onSale =
   movie.chain === 'Cinépolis'
    ? Boolean(movie.availableForSale && movie.inCdmx)
    : Boolean(movie.availableForSale);
  let detail = null;
  if (onSale) {
   try {
    detail = await showtimesOf(movie);
   } catch {
    // Sin detalle igual sirve saber que ya está a la venta.
   }
  }
  enriched.push({ movie, onSale, detail });
 }
 return statusReport(term, enriched);
}

// ---------------------------------------------------------------- vigilante

startWatcher({
 async onAlert(alert) {
  const text = alert.kind === 'onsale' ? onSaleAlert(alert) : announcedAlert(alert);
  // Si el envío falla se propaga a propósito: el vigilante no dará la alerta
  // por entregada y la reintentará en el siguiente ciclo.
  await send(GROUP_CHAT_ID, text);
  saveLogEntry(`${alert.kind}: ${alert.movie.title} (${alert.movie.chain})`, text);
 },
 onError(err) {
  // Los fallos de sondeo son ruido operativo (una API que parpadea, la red
  // de casa): van al journal, no al grupo.
  console.error('[vigilante]', err.message);
 },
});

bot.catch((err) => console.error('Error del bot:', err));

console.log(`Bot de cine iniciado (long polling). Grupo: ${GROUP_CHAT_ID}`);
bot.start();
