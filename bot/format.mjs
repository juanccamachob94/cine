/**
 * Redacción de los mensajes de Telegram.
 *
 * Criterio: la alerta de venta abierta se lee de pie, con el celular en la
 * mano y con prisa. Lo primero tiene que ser qué película y dónde comprar;
 * el detalle va después, para quien quiera leerlo.
 */
import { nowCdmx } from './store.mjs';

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

/** 🚨 La alerta que justifica todo el proyecto: ya se puede comprar. */
export function onSaleAlert({ term, movie, detail }) {
 const lines = [
  '🚨🎟️ ¡BOLETOS A LA VENTA!',
  '',
  `🎬 ${movie.title}`,
  `🏢 ${movie.chain} · CDMX`,
 ];
 if (movie.releaseDate) lines.push(`📅 Estreno: ${dia(movie.releaseDate)}`);
 if (movie.presale) lines.push('⏳ En PREVENTA');

 if (detail?.count) {
  lines.push(
   '',
   `${detail.count} funciones en ${detail.cinemas} cines`,
   `Fechas: ${detail.dates.slice(0, 6).map(dia).join(', ')}${detail.dates.length > 6 ? '…' : ''}`
  );
  const first = detail.sessions.slice(0, 5);
  if (first.length) {
   lines.push('', 'Primeras funciones:');
   for (const s of first) {
    lines.push(`• ${dia(s.date)} ${hora(s.datetime)} — ${s.cinema}${s.format ? ` (${s.format})` : ''}`);
   }
  }
 }

 lines.push('', `👉 COMPRAR: ${detail?.url ?? movie.url}`);
 lines.push('', `🔎 Coincide con tu término: "${term}"`, `🕐 ${nowCdmx().stamp} CDMX`);
 return lines.join('\n');
}

/** Aviso temprano: ya está anunciada, pero todavía no se puede comprar. */
export function announcedAlert({ term, movie }) {
 return [
  '👀 Película anunciada (aún SIN venta)',
  '',
  `🎬 ${movie.title}`,
  `🏢 ${movie.chain}`,
  movie.releaseDate ? `📅 Estreno: ${dia(movie.releaseDate)}` : '',
  '',
  'Ya la tengo en la mira y a partir de ahora reviso cada 20 segundos.',
  'En cuanto abran la venta te aviso aquí mismo.',
  '',
  `🔎 Término: "${term}"`,
 ]
  .filter(Boolean)
  .join('\n');
}

/** Respuesta a una consulta puntual sobre un término. */
export function statusReport(term, matches) {
 if (!matches.length) {
  return `🔎 "${term}"\n\nTodavía no aparece en Cinépolis ni en Cinemex. Sigo vigilando.`;
 }
 const lines = [`🔎 "${term}"`, ''];
 for (const { movie, onSale, detail } of matches) {
  lines.push(`🎬 ${movie.title} — ${movie.chain}`);
  lines.push(onSale ? '  ✅ A LA VENTA' : '  ⏳ Anunciada, sin venta abierta');
  if (movie.releaseDate) lines.push(`  📅 Estreno: ${dia(movie.releaseDate)}`);
  if (detail?.count) {
   lines.push(`  🎟️ ${detail.count} funciones en ${detail.cinemas} cines`);
   lines.push(`  👉 ${detail.url}`);
  } else if (onSale) {
   lines.push(`  👉 ${movie.url}`);
  }
  lines.push('');
 }
 return lines.join('\n').trim();
}

/** Listado de términos vigilados. */
export function watchList(watches) {
 if (!watches.length) {
  return 'No hay términos registrados todavía.\n\nAgrega uno con:\n/agregar Avatar Fuego y Ceniza';
 }
 const lines = ['🎯 Términos vigilados:', ''];
 watches.forEach((w, i) => {
  lines.push(`${i + 1}. ${w.term}  — ${w.addedBy}, ${w.addedAt}`);
 });
 lines.push('', 'Para eliminar: /eliminar <número>');
 return lines.join('\n');
}

/** Hallazgos de prensa y redes. */
export function newsReport(term, items) {
 if (!items.length) return `📰 "${term}"\n\nSin menciones recientes en prensa ni en Reddit.`;
 const lines = [`📰 Menciones recientes de "${term}":`, ''];
 for (const item of items.slice(0, 8)) {
  lines.push(`• [${item.source}] ${item.title}`);
  lines.push(` ${item.link}`);
 }
 return lines.join('\n');
}
