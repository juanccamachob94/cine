import dotenv from 'dotenv';
dotenv.config();

/**
 * Cinemex: API REST del sitio (api.cinemex.com). A diferencia de Cinépolis,
 * aquí basta el fetch nativo de Node — no hay Cloudflare de por medio.
 *
 * La consumer key sale del bundle público del sitio; es la misma para todos
 * los visitantes.
 *
 * Nota de rendimiento, que aquí manda el diseño: la cartelera por estado
 * (`cinemas/state/8/movies/?date=…`) devuelve ~7.6 MB y tarda ~27 s por
 * fecha, así que es inservible para sondear. En cambio `cinemas/{cine}/movies/
 * {peli}` responde en ~200 ms con 19 KB. Por eso el detalle de funciones se
 * arma preguntando cine por cine en paralelo, y no por fechas.
 */
const BASE = 'https://api.cinemex.com/rest/v2.37.2/';
const HEADERS = {
 'X-API-Consumer-Key': process.env.CINEMEX_API_KEY,
 origin: 'https://cinemex.com',
 referer: 'https://cinemex.com/',
};
if (!process.env.CINEMEX_API_KEY) {
  throw new Error('CINEMEX_API_KEY no está definida en .env');
}
