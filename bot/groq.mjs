/**
 * Motor de respaldo con Groq (console.groq.com — tier gratuito, API
 * compatible con OpenAI). Entra solo cuando Gemini agota su cuota (429) y
 * existe GROQ_API_KEY; sin la key el bot se comporta igual que antes.
 *
 * Es otro proveedor con su propia cuenta y su propia cuota, así que no hay
 * nada que estirar ni ToS que rozar. `groq/compound` trae búsqueda web
 * integrada, lo que lo hace útil para investigar preventas.
 */
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const CHAT_MODEL = 'openai/gpt-oss-120b';
// Los dos modelos de Groq que traen búsqueda web propia. `compound` busca
// mejor; `compound-mini` gasta menos del límite por minuto y entra cuando el
// grande no cabe. Ninguno de los dos es intercambiable con CHAT_MODEL, que
// NO tiene web: ver el comentario de groqResearch.
const RESEARCH_MODELS = ['groq/compound', 'groq/compound-mini'];

export const groqAvailable = () => Boolean(process.env.GROQ_API_KEY);

async function chat(body) {
 const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
   'Content-Type': 'application/json',
   Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
  },
  body: JSON.stringify(body),
 });
 if (!res.ok) {
  const msg = await res.text().catch(() => '');
  throw new Error(`Groq (${body.model}) respondió ${res.status}: ${msg.slice(0, 300)}`);
 }
 const data = await res.json();
 const text = data.choices?.[0]?.message?.content;
 if (!text) throw new Error(`Groq (${body.model}) no devolvió texto.`);
 return text;
}

// Mismo contrato que el esquema de Gemini, en JSON Schema estándar.
const JSON_SCHEMA = {
 type: 'object',
 additionalProperties: false,
 properties: {
  intent: {
   type: 'string',
   enum: ['agregar', 'eliminar', 'listar', 'consultar', 'investigar', 'charla'],
  },
  terms: { type: 'array', items: { type: 'string' } },
  query: { type: 'string' },
  answer: { type: 'string' },
 },
 required: ['intent', 'terms', 'query', 'answer'],
};

/** Mensaje libre → el mismo JSON estructurado que devuelve Gemini. */
export async function groqJson(system, userText) {
 const messages = [
  { role: 'system', content: system },
  { role: 'user', content: userText },
 ];
 try {
  const text = await chat({
   model: CHAT_MODEL,
   messages,
   response_format: {
    type: 'json_schema',
    json_schema: { name: 'respuesta', schema: JSON_SCHEMA },
   },
   // El tier gratuito cuenta entrada + max_completion_tokens contra el
   // límite por minuto: pedir de más devuelve 413.
   max_completion_tokens: 2048,
  });
  return { ...JSON.parse(text), via: `Groq (${CHAT_MODEL})` };
 } catch (err) {
  if (!/respondió 400/.test(err.message)) throw err;
  // Algunos modelos no soportan json_schema nativo; el esquema va en el prompt.
  const text = await chat({
   model: CHAT_MODEL,
   messages: [
    {
     role: 'system',
     content: `${system}\n\nDevuelve EXACTAMENTE un objeto JSON con este esquema:\n${JSON.stringify(JSON_SCHEMA)}`,
    },
    { role: 'user', content: userText },
   ],
   response_format: { type: 'json_object' },
   max_completion_tokens: 2048,
  });
  return { ...JSON.parse(text), via: `Groq (${CHAT_MODEL})` };
 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** El límite por minuto es de tokens, y la respuesta dice cuánto falta. */
const isRateLimit = (err) => /respondió (429|413)/.test(err.message);
const retryAfterMs = (err) => {
 const seconds = Number(err.message.match(/try again in ([\d.]+)s/i)?.[1]);
 return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) + 500 : 6000;
};

/**
 * Investigación con la búsqueda web propia de Groq.
 *
 * Aquí NO hay respaldo con CHAT_MODEL, y es a propósito. La búsqueda de
 * `compound` gasta del mismo límite por minuto (8000 tokens en el tier
 * gratuito) que el resto, así que choca contra 429/413 con facilidad; el
 * código original trataba ese tropiezo pasajero como "no se puede buscar" y
 * caía a un modelo sin web, que contestaba de memoria con un aviso al pie.
 * Ese aviso es fácil de pasar por alto y la respuesta suena idéntica a una
 * investigada de verdad. Para un bot cuyo trabajo es avisar de preventas,
 * inventar una fecha plausible es peor que no responder.
 *
 * Así que ante un límite se espera lo que la propia API indica y se reintenta;
 * si aun así no se puede buscar, se lanza el error y `research()` pasa al
 * escalón siguiente, que trae fuentes reales.
 */
export async function groqResearch(system, query) {
 const messages = [
  { role: 'system', content: system },
  { role: 'user', content: query },
 ];
 let lastErr;
 for (const model of RESEARCH_MODELS) {
  for (let attempt = 0; attempt < 2; attempt++) {
   try {
    // 2048 es lo que cabe junto con la entrada y los resultados de
    // búsqueda dentro del límite por minuto; con 3072 devolvía 413 siempre.
    const text = await chat({ model, messages, max_completion_tokens: 2048 });
    return { text, model };
   } catch (err) {
    lastErr = err;
    if (!isRateLimit(err)) break; // fallo real de ese modelo: probar el otro
    if (attempt === 0) await sleep(retryAfterMs(err));
   }
  }
 }
 throw lastErr;
}

/**
 * Redacción a partir de fuentes que ya vienen en el prompt.
 *
 * Este sí usa el modelo sin web, y no hay contradicción: no se le pide que
 * sepa nada, se le pide que ordene lo que tiene delante.
 */
export async function groqSummarize(system, prompt) {
 const messages = [
  { role: 'system', content: system },
  { role: 'user', content: prompt },
 ];
 // Reintenta igual que groqResearch: aquí las fuentes ya están en la mano y
 // sería absurdo renunciar a redactarlas por unos segundos de límite.
 for (let attempt = 0; ; attempt++) {
  try {
   return { text: await chat({ model: CHAT_MODEL, messages, max_completion_tokens: 1536 }), model: CHAT_MODEL };
  } catch (err) {
   if (!isRateLimit(err) || attempt >= 1) throw err;
   await sleep(retryAfterMs(err));
  }
 }
}
