/**
 * Capa de IA: Gemini como motor principal y Groq como respaldo cuando se
 * agota la cuota (mismo patrón que el proyecto credito, que ya lleva meses
 * corriendo así en la Pi).
 *
 * Dos usos distintos:
 * - processMessage: entender lo que escriben en el grupo en lenguaje natural
 *  ("ya quiero saber de avatar" → agregar término) y devolverlo estructurado.
 * - research: investigar con búsqueda web cuándo abre una preventa.
 */
import { groqAvailable, groqJson, groqResearch } from './groq.mjs';

const API_KEY = process.env.GEMINI_API_KEY;
// El tier gratuito tiene cuota independiente POR MODELO: si flash se agota,
// flash-lite es un segundo bolsillo con la misma API key.
const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const endpointOf = (model) =>
 `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const SYSTEM = `Eres el asistente de un grupo de Telegram de dos amigos —Juan
Camilo — cuyo único objetivo es ser los PRIMEROS en enterarse de que
se pueden comprar boletos de cine en Ciudad de México para las películas que
están esperando (Cinépolis y Cinemex).

Tienes un vigilante automático que sondea las APIs de ambas cadenas cada pocos
segundos y avisa solo cuando una película vigilada ya se puede comprar. Tu
trabajo es entender lo que escriben en lenguaje natural y convertirlo en
acciones sobre la lista de términos vigilados, o responder dudas.

Cada mensaje llega prefijado con [Nombre]: dirígete a esa persona.

Respondes SIEMPRE el JSON del esquema indicado:
- "intent":
 · "agregar"  → quieren vigilar una o más películas.
 · "eliminar"  → quieren dejar de vigilar algo.
 · "listar"   → preguntan qué se está vigilando.
 · "consultar" → preguntan por el estado actual de una película concreta
          (¿ya salió?, ¿hay funciones?, ¿dónde la dan?).
 · "investigar" → piden buscar en internet/redes cuándo abre la preventa,
          noticias, rumores o fechas anunciadas.
 · "charla"   → cualquier otra cosa.
- "terms": array con los títulos limpios involucrados. Para "agregar" usa el
 título de la película tal como lo publicarían las cadenas, sin palabras de
 relleno: de "oye agrega la nueva de avatar porfa" saca ["Avatar"]. Para
 "eliminar" y "consultar", el término o número que mencionan. Vacío si no aplica.
- "query": para "investigar", la búsqueda en español ya optimizada (incluye
 "preventa", "boletos", "México" y el año si ayuda). Vacío en los demás casos.
- "answer": tu respuesta para Telegram, en texto plano, sin markdown. Breve y
 concreta, en español de México. No prometas cosas que el vigilante no hace:
 avisa de venta de boletos en CDMX, no compra boletos ni aparta lugares.`;

const RESPONSE_SCHEMA = {
 type: 'OBJECT',
 properties: {
  intent: {
   type: 'STRING',
   enum: ['agregar', 'eliminar', 'listar', 'consultar', 'investigar', 'charla'],
  },
  terms: { type: 'ARRAY', items: { type: 'STRING' } },
  query: { type: 'STRING' },
  answer: { type: 'STRING' },
 },
 required: ['intent', 'terms', 'query', 'answer'],
 propertyOrdering: ['intent', 'terms', 'query', 'answer'],
};

async function call(body, model) {
 const res = await fetch(`${endpointOf(model)}?key=${API_KEY}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
 });
 if (!res.ok) {
  const msg = await res.text().catch(() => '');
  throw new Error(`Gemini (${model}) respondió ${res.status}: ${msg.slice(0, 300)}`);
 }
 const data = await res.json();
 const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('');
 if (!text) {
  const reason =
   data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? 'sin contenido';
  throw new Error(`La IA no devolvió texto (${reason}).`);
 }
 return { text, model };
}

/** Igual que call(), pero degrada de modelo en modelo ante cuota agotada (429). */
async function callAnyModel(body) {
 let lastErr;
 for (const model of MODELS) {
  try {
   return await call(body, model);
  } catch (err) {
   lastErr = err;
   if (!/429/.test(err.message)) throw err;
  }
 }
 throw lastErr;
}

const contextBlock = ({ stamp, watches, chat, log }) => `Fecha y hora actuales (CDMX): ${stamp}

<terminos_vigilados>
${watches.length ? watches.map((w, i) => `${i + 1}. ${w.term}`).join('\n') : '(ninguno todavía)'}
</terminos_vigilados>

<conversacion_reciente>
${chat || '(sin conversación previa)'}
</conversacion_reciente>

<bitacora_reciente>
${log || '(sin registros)'}
</bitacora_reciente>`;

/** Mensaje libre → intención estructurada. */
export async function processMessage(userText, context) {
 const prompt = `${contextBlock(context)}

<mensaje_del_usuario>
${userText}
</mensaje_del_usuario>`;
 try {
  const { text, model } = await callAnyModel({
   systemInstruction: { parts: [{ text: SYSTEM }] },
   contents: [{ parts: [{ text: prompt }] }],
   generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 8192,
   },
  });
  return { ...JSON.parse(text), via: `Gemini (${model})` };
 } catch (err) {
  if (!/429/.test(err.message) || !groqAvailable()) throw err;
  return groqJson(SYSTEM, prompt);
 }
}

const researcherSystem = (stamp) => `Eres un investigador especializado en
estrenos de cine en México. Fecha y hora actuales (CDMX): ${stamp}.

Buscas información CONCRETA y VERIFICABLE sobre cuándo abre la venta de
boletos: fechas de preventa anunciadas por Cinépolis o Cinemex, comunicados
de la distribuidora, publicaciones de las cuentas oficiales, notas de prensa
mexicana. Prioriza fuentes mexicanas y recientes.

Responde en español, en texto plano sin markdown, con lo esencial primero:
¿hay fecha de preventa anunciada? ¿cuál? ¿quién lo dijo y cuándo? Si no hay
nada confirmado, dilo claramente en la primera línea en lugar de rellenar.
Distingue siempre lo confirmado de lo rumorado, y cita las fuentes con su URL.`;

async function geminiResearch(query, stamp) {
 // Degradación por cuota: el free tier limita google_search por día.
 const modes = [
  { tools: [{ google_search: {} }, { url_context: {} }], note: '' },
  {
   tools: [{ url_context: {} }],
   note: '\n\n(⚠️ Cuota diaria de búsqueda agotada: investigué solo leyendo URLs.)',
  },
  {
   tools: undefined,
   note: '\n\n(⚠️ Sin acceso web ahora mismo: respuesta basada solo en conocimiento del modelo.)',
  },
 ];
 let lastErr;
 for (const mode of modes) {
  try {
   const { text, model } = await callAnyModel({
    systemInstruction: { parts: [{ text: researcherSystem(stamp) }] },
    contents: [{ parts: [{ text: query }] }],
    ...(mode.tools ? { tools: mode.tools } : {}),
    generationConfig: { maxOutputTokens: 8192 },
   });
   return `${text}${mode.note}\n\n🤖 Investigó: Gemini (${model})`;
  } catch (err) {
   lastErr = err;
   if (!/429/.test(err.message)) throw err;
  }
 }
 throw lastErr;
}

/** Investigación web sobre preventas. Cae a Groq si Gemini no puede. */
export async function research(query, { stamp }) {
 try {
  return await geminiResearch(query, stamp);
 } catch (err) {
  if (!groqAvailable()) throw err;
  const { text, web, model } = await groqResearch(researcherSystem(stamp), query);
  const note = web
   ? '\n\n(Cuota de Gemini agotada: investigué con Groq y su propia búsqueda web.)'
   : '\n\n(⚠️ Groq quedó SIN acceso web: respuesta basada solo en conocimiento del modelo.)';
  return `${text}${note}\n\n🤖 Investigó: Groq (${model})`;
 }
}
