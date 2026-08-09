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
import { groqAvailable, groqJson, groqResearch, groqSummarize } from './groq.mjs';
import { gatherSources, sourcesBlock } from '../watcher/websearch.mjs';

const API_KEY = process.env.GEMINI_API_KEY;
// Versión FIJA, no el alias `-latest`: ese alias migró solo de 2.5 a 3.x y se
// llevó por delante el grounding con Búsqueda (gratis en 2.5, "Not available"
// en 3.x) sin que cambiara una línea de código. Actualizar a mano y probando.
// El tier gratuito tiene cuota independiente POR MODELO: si flash se agota,
// flash-lite es un segundo bolsillo con la misma API key.
const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
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

/**
 * Gemini con búsqueda de verdad, o nada.
 *
 * Antes había dos escalones más aquí y los dos acababan en lo mismo. El de
 * "solo url_context" parecía prudente, pero `url_context` únicamente sabe
 * abrir URLs que le pases, y a `/investiga` llega una pregunta, no enlaces:
 * sin nada que abrir el modelo respondía de memoria bajo un aviso que decía
 * "investigué leyendo URLs". Se comprobó el 08/ago/2026: contestó que no había
 * fecha de preventa de Avatar mientras la prensa mexicana llevaba meses con la
 * fecha publicada. El tercer escalón, sin herramientas, era eso mismo sin
 * disimulo. Si aquí no hay búsqueda, el trabajo es de `research()`.
 *
 * ⚠️ 09/ago/2026: `google_search` devuelve **429 RESOURCE_EXHAUSTED en la
 * primera llamada del día**, y no es esta clave: se probó con las cinco que
 * hay en la Pi, de cuatro cuentas distintas, y todas igual. El grounding con
 * Búsqueda ya no entra en el tier gratuito. La generación normal y
 * `url_context` siguen dando 200, así que la clave está perfectamente viva.
 * Cambiarla por otra gratuita no arregla nada.
 */
const REPRUEBA_MS = 6 * 60 * 60 * 1000;
let busquedaNativaCaida = 0;

/**
 * Interruptor: tras un 429 de `google_search` no se vuelve a intentar en seis
 * horas. Sin esto, cada `/investiga` paga la latencia de una petición que
 * sabemos que va a fallar. Con esto, el día que Google lo reactive (o si un
 * día hay plan de pago) el bot lo detecta solo, sin tocar código.
 */
const busquedaNativaViva = () => Date.now() - busquedaNativaCaida > REPRUEBA_MS;

async function geminiResearch(query, stamp) {
 try {
  const { text, model } = await callAnyModel({
   systemInstruction: { parts: [{ text: researcherSystem(stamp) }] },
   contents: [{ parts: [{ text: query }] }],
   tools: [{ google_search: {} }, { url_context: {} }],
   generationConfig: { maxOutputTokens: 8192 },
  });
  return `${text}\n\n🤖 Investigó: Gemini (${model}) con Búsqueda de Google`;
 } catch (err) {
  if (/429/.test(err.message)) busquedaNativaCaida = Date.now();
  throw err;
 }
}

const groundedSystem = (stamp) => `${researcherSystem(stamp)}

Te doy abajo los resultados de una búsqueda web hecha hace unos segundos.
Responde ÚNICAMENTE con lo que digan esas fuentes. No completes con lo que
creas recordar: tu memoria es de hace meses y aquí lo que importa es lo de
esta semana. Si las fuentes no contestan la pregunta, la primera línea es
que no hay nada confirmado todavía, y luego lo más cercano que sí traigan.

Cita cada dato con la URL completa de la fuente de donde salió, escrita tal
cual y a la vista: esto se lee en Telegram, donde un marcador tipo [1] o 【1】
no lleva a ningún lado. Algunas fuentes vienen sin URL: a esas cítalas por
medio y fecha. NUNCA escribas una URL que no aparezca tal cual arriba.`;

/** Fuentes en crudo, cuando ni siquiera queda un modelo para redactarlas. */
const rawSources = (sources) =>
 [
  'No pude usar ninguna IA en este momento (cuotas agotadas), así que te dejo',
  'lo que encontré en la web hace un momento, sin resumir:',
  '',
  ...sources.slice(0, 8).map((s, i) => `${i + 1}. ${s.title}\n  ${s.source}${s.date ? ` · ${s.date}` : ''}\n  ${s.url}`),
 ].join('\n');

/**
 * El escalón de trabajo: buscamos nosotros y la IA solo ordena lo encontrado.
 *
 * Nació como último recurso y desde el 09/ago/2026 es el camino normal,
 * porque el grounding nativo de Gemini dejó de estar en el tier gratuito.
 * No es un consuelo: la información es siempre de hoy, las URL son reales
 * porque las trajo la Pi, y si falla falla de forma evidente — sin fuentes
 * no hay respuesta. Lo único que se pierde es velocidad.
 */
async function groundedResearch(query, stamp) {
 const sources = await gatherSources(query);
 if (!sources.length) {
  throw new Error('no encontré nada en la web sobre eso ahora mismo');
 }
 const prompt = `Pregunta: ${query}\n\n<resultados_de_busqueda>\n${sourcesBlock(sources)}\n</resultados_de_busqueda>`;
 const note = '\n\n(Busqué yo en Google Noticias y DuckDuckGo; la IA solo ordenó esas fuentes.)';

 try {
  const { text, model } = await callAnyModel({
   systemInstruction: { parts: [{ text: groundedSystem(stamp) }] },
   contents: [{ parts: [{ text: prompt }] }],
   generationConfig: { maxOutputTokens: 8192 },
  });
  return `${text}${note}\n\n🤖 Resumió: Gemini (${model})`;
 } catch (err) {
  if (!groqAvailable()) return rawSources(sources);
  try {
   const { text, model } = await groqSummarize(groundedSystem(stamp), prompt);
   return `${text}${note}\n\n🤖 Resumió: Groq (${model})`;
  } catch {
   return rawSources(sources);
  }
 }
}

/**
 * Investigación sobre preventas, siempre contra la web.
 *
 * Tres escalones, y los tres miran internet:
 *  1. Gemini con `google_search` — hoy caído por cuota; se reprueba cada
 *   seis horas por si vuelve.
 *  2. La Pi busca (Google Noticias + DuckDuckGo, leyendo el texto real de
 *   las notas) y **Gemini redacta** con esas fuentes delante.
 *  3. Groq con su agente `compound`, que trae su propia búsqueda.
 *
 * El orden cambió el 09/ago/2026. Antes Groq iba en el segundo puesto, así
 * que al caerse el grounding de Gemini el bot contestaba SIEMPRE con Groq y
 * parecía que Gemini estaba roto — cuando lo único roto era una herramienta.
 * Ahora Gemini vuelve a ser quien responde; lo que cambia es de dónde salen
 * los hechos, y salen de una búsqueda hecha hace tres segundos.
 *
 * Lo que sigue sin existir es un escalón que conteste de memoria. Lo hubo,
 * con un aviso al pie, y era la peor combinación posible: la respuesta se
 * leía con la misma seguridad que una buena, pero la fecha de una preventa
 * anunciada esta semana no puede salir de un modelo entrenado hace meses.
 * Preferimos quedarnos sin respuesta antes que dar una inventada.
 */
export async function research(query, { stamp }) {
 const tropiezos = [];

 if (busquedaNativaViva()) {
  try {
   return await geminiResearch(query, stamp);
  } catch (err) {
   tropiezos.push(`Gemini con Búsqueda: ${err.message.slice(0, 100)}`);
  }
 }

 try {
  return await groundedResearch(query, stamp);
 } catch (err) {
  tropiezos.push(`búsqueda propia: ${err.message.slice(0, 100)}`);
 }

 // Solo si la Pi no encontró NADA en la web. El agente de Groq busca por su
 // cuenta y a veces llega donde no llegan DuckDuckGo ni Google Noticias.
 if (groqAvailable()) {
  try {
   const { text, model } = await groqResearch(researcherSystem(stamp), query);
   return `${text}\n\n(Mi búsqueda no encontró nada: investigó Groq con su propio agente web.)\n\n🤖 Investigó: Groq (${model})`;
  } catch (err) {
   tropiezos.push(`Groq: ${err.message.slice(0, 100)}`);
  }
 }

 throw new Error(tropiezos.join(' | '));
}
