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
const RESEARCH_MODEL = 'groq/compound'; // agente con búsqueda web propia

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

/** Investigación con la búsqueda web propia de Groq. */
export async function groqResearch(system, query) {
 const messages = [
  { role: 'system', content: system },
  { role: 'user', content: query },
 ];
 try {
  const text = await chat({ model: RESEARCH_MODEL, messages, max_completion_tokens: 3072 });
  return { text, web: true, model: RESEARCH_MODEL };
 } catch {
  const text = await chat({ model: CHAT_MODEL, messages, max_completion_tokens: 1536 });
  return { text, web: false, model: CHAT_MODEL };
 }
}
