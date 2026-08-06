/**
 * Emparejamiento entre los términos que registran los usuarios y los títulos
 * que publican las cadenas.
 *
 * El problema real: las cadenas escriben los títulos de formas impredecibles
 * ("SPIDER-MAN: Un nuevo día", "Spider-Man: Un Nuevo Día", "ATEEZ : LIGHT THE
 * WAY IN CINEMAS"), mezclan mayúsculas, acentos y espacios raros, y a veces
 * solo coincide el título original en inglés. Por eso se normaliza todo y se
 * exige que estén TODAS las palabras del término, no una coincidencia exacta:
 * "avatar fuego" encuentra "Avatar: Fuego y Ceniza".
 */

/** Minúsculas, sin acentos y sin puntuación: la forma comparable de un título. */
export function normalize(text) {
 return (text ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
}

// Palabras que no aportan nada al emparejamiento y que la gente escribe sin
// pensar ("la peli de avatar", "boletos para wicked").
const STOPWORDS = new Set([
 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'y', 'e',
 'o', 'a', 'al', 'en', 'para', 'por', 'the', 'of', 'and', 'peli', 'pelicula',
 'boletos', 'boleto',
]);

const tokens = (text) =>
 normalize(text).split(' ').filter((t) => t && !STOPWORDS.has(t));

/**
 * ¿El término describe a esta película? Compara contra el título local y el
 * original: una misma película puede anunciarse en cualquiera de los dos.
 */
export function matches(term, movie) {
 const needles = tokens(term);
 if (!needles.length) return false;
 const haystack = `${normalize(movie.title)} ${normalize(movie.originalTitle)}`;
 return needles.every((needle) => haystack.includes(needle));
}

/** Todas las películas de un snapshot que responden a un término. */
export const findMatches = (term, movies) => movies.filter((m) => matches(term, m));
