// Classement d'une recette d'apres son titre seul, sans acces a la base.
// - Un mot-cle correspond a des mots entiers du titre, avec un pluriel optionnel
//   en s ou x sur chaque mot : « riz » trouve « riz » mais pas « chorizo ».
// - Le mot-cle qui apparait le plus tot dans le titre gagne ; a position egale,
//   le plus long (« tarte aux pommes » bat « tarte »).

// Minuscules, sans accents, œ -> oe ; tirets, apostrophes et toute autre
// ponctuation deviennent des espaces.
function normalizeForMatching(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Meme principe que buildIngredientRegex (ingredientMonths.js), avec s ou x.
function buildKeywordRegex(keyword) {
  const pattern = keyword
    .split(' ')
    .map((word) => `${escapeRegExp(word)}[sx]?`)
    .join(' ');
  return new RegExp(`\\b${pattern}\\b`);
}

// Mots-cles normalises et compiles de chaque categorie. La categorie par defaut
// n'en a pas : elle ne sert que quand rien n'est trouve.
function buildMatchers(categories) {
  const matchers = [];
  for (const category of categories || []) {
    if (category.is_default || !Array.isArray(category.keywords)) continue;
    const keywords = new Set(category.keywords.map(normalizeForMatching).filter(Boolean));
    keywords.forEach((keyword) => matchers.push({ category, keyword, regex: buildKeywordRegex(keyword) }));
  }
  return matchers;
}

function isBetterMatch(candidate, best) {
  if (!best) return true;
  if (candidate.index !== best.index) return candidate.index < best.index;
  if (candidate.keyword.length !== best.keyword.length) return candidate.keyword.length > best.keyword.length;
  // Meme mot-cle dans deux categories : ordre alphabetique, pour un resultat stable
  return candidate.category.name.localeCompare(best.category.name, 'fr') < 0;
}

// { category, keyword } du mot-cle retenu, ou null si aucun n'apparait dans le titre.
function findCategoryForTitle(title, matchers) {
  const text = normalizeForMatching(title);
  let best = null;
  for (const { category, keyword, regex } of matchers) {
    const match = regex.exec(text);
    if (!match) continue;
    const candidate = { category, keyword, index: match.index };
    if (isBetterMatch(candidate, best)) best = candidate;
  }
  return best && { category: best.category, keyword: best.keyword };
}

// Categorie retenue pour un titre : { category, keyword, confident }.
// Sans mot-cle reconnu : la categorie par defaut, avec confident a false.
// `matchers` (optionnel) evite de recompiler les mots-cles a chaque titre.
function classifyTitle(title, categories, matchers = buildMatchers(categories)) {
  const found = findCategoryForTitle(title, matchers);
  if (found) return { ...found, confident: true };

  const fallback = (categories || []).find((category) => category.is_default) || (categories || [])[0] || null;
  return { category: fallback, keyword: null, confident: false };
}

module.exports = {
  normalizeForMatching,
  buildKeywordRegex,
  buildMatchers,
  findCategoryForTitle,
  classifyTitle,
};
