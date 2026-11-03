// Regles qui decident si une recette est un plat, donc suggerable.
// Les listes ci-dessous sont a modifier librement. Elles sont comparees apres
// normalisation : minuscules, sans accents.

// Categories hors plat, par nom exact (classement valide a la main + recettes incompletes).
const NON_MEAL_CATEGORY_NAMES = [
  'a completer',
  'aperitif',
  'brunch',
  'cocktails',
  'desserts',
  'petit-dejeuner & brunch',
  'sauces & condiments',
  'snacks & apero',
];

// Toute categorie dont le nom contient l'un de ces mots est hors plat,
// y compris celles creees plus tard.
const NON_MEAL_CATEGORY_KEYWORDS = [
  'dessert', 'gateau', 'patisserie', 'biscuit', 'cookie', 'gouter',
  'boisson', 'cocktail', 'smoothie',
  'apero', 'aperitif',
  'sauce', 'condiment',
  'petit-dej', 'petit dej', 'brunch', 'snack',
];

// Filet de securite pour les recettes mal rangees : titres de desserts ou de boissons.
// Mots ou expressions qui suffisent a ecarter la recette.
const SWEET_TITLE_WORDS = [
  'gateau', 'cookie', 'brownie', 'muffin', 'tiramisu', 'cheesecake', 'crumble', 'compote',
  'mousse au chocolat', 'creme brulee', 'panna cotta', 'flan', 'glace', 'sorbet',
  'smoothie', 'cocktail', 'sangria', 'madeleine', 'financier', 'macaron', 'meringue',
];

// Mots qui n'ecartent la recette que s'ils sont suivis d'un fruit ou de chocolat.
const SWEET_IF_FOLLOWED_WORDS = ['tarte', 'tartelette', 'cake', 'clafoutis'];
const SWEET_INGREDIENTS = [
  'pomme', 'poire', 'citron', 'fraise', 'framboise', 'abricot', 'cerise',
  'prune', 'rhubarbe', 'banane', 'chocolat',
];
// Expressions retirees avant de chercher un fruit : ce ne sont pas des fruits.
const NOT_SWEET_EXPRESSIONS = ['pomme de terre', 'tomate cerise'];

// Un titre qui contient l'un de ces mots n'est jamais ecarte par le filet de securite.
const SAVORY_MARKERS = ['sale', 'salee'];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Mots d'un texte, au singulier ("gateaux" -> "gateau", "abricots" -> "abricot"),
// pour comparer mot a mot sans se soucier du pluriel.
function toWords(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => (word.length > 3 && /[sx]$/.test(word) ? word.slice(0, -1) : word));
}

function toPhrase(value) {
  return ` ${toWords(value).join(' ')} `;
}

const NON_MEAL_NAME_SET = new Set(NON_MEAL_CATEGORY_NAMES.map(normalizeText));
const SWEET_TITLE_PHRASES = SWEET_TITLE_WORDS.map(toPhrase);
const SWEET_IF_FOLLOWED_SET = new Set(SWEET_IF_FOLLOWED_WORDS.flatMap(toWords));
const SWEET_INGREDIENT_SET = new Set(SWEET_INGREDIENTS.flatMap(toWords));
const NOT_SWEET_PHRASES = NOT_SWEET_EXPRESSIONS.map(toPhrase);
const SAVORY_MARKER_SET = new Set(SAVORY_MARKERS.flatMap(toWords));

function isNonMealCategory(category) {
  const name = normalizeText(category?.name);
  return NON_MEAL_NAME_SET.has(name) || NON_MEAL_CATEGORY_KEYWORDS.some((keyword) => name.includes(keyword));
}

// Plat : une categorie qui n'est ni hors plat, ni la categorie par defaut ("Sans categorie").
function isMealCategory(category) {
  return Boolean(category) && !category.is_default && !isNonMealCategory(category);
}

function isSweetOrDrinkTitle(title) {
  // "glacé" (carottes glacées, poulet glacé) n'est pas une glace : l'accent disparait a la normalisation
  let phrase = toPhrase(String(title || '').replace(/glacé/gi, 'glacee'));
  const words = phrase.trim().split(' ');
  if (words.some((word) => SAVORY_MARKER_SET.has(word))) return false;
  if (SWEET_TITLE_PHRASES.some((sweet) => phrase.includes(sweet))) return true;

  // "Tarte aux pommes", "Cake au chocolat"... mais pas "Tarte aux pommes de terre"
  NOT_SWEET_PHRASES.forEach((expression) => {
    phrase = phrase.split(expression).join(' ');
  });
  const remaining = phrase.trim().split(' ');
  const triggerIndex = remaining.findIndex((word) => SWEET_IF_FOLLOWED_SET.has(word));
  return triggerIndex !== -1 && remaining.slice(triggerIndex + 1).some((word) => SWEET_INGREDIENT_SET.has(word));
}

// Motif pour lequel une recette n'est pas un plat suggerable, ou null si elle l'est.
// `categories` : ses categories, avec { name, is_default }.
function getNonMealReason(title, categories) {
  if (categories.some(isNonMealCategory)) return 'nonMealCategory';
  if (!categories.some(isMealCategory)) return 'noMealCategory';
  if (isSweetOrDrinkTitle(title)) return 'sweetTitle';
  return null;
}

module.exports = {
  NON_MEAL_CATEGORY_NAMES,
  NON_MEAL_CATEGORY_KEYWORDS,
  SWEET_TITLE_WORDS,
  SWEET_IF_FOLLOWED_WORDS,
  SWEET_INGREDIENTS,
  NOT_SWEET_EXPRESSIONS,
  SAVORY_MARKERS,
  normalizeText,
  isNonMealCategory,
  isMealCategory,
  isSweetOrDrinkTitle,
  getNonMealReason,
};
