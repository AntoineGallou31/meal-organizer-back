// Calendrier de saisonnalité (France) : ingrédient -> mois où il est de saison.
const INGREDIENT_MONTHS = {
  // Légumes
  'asperge': ['Avril', 'Mai', 'Juin'],
  'artichaut': ['Mai', 'Juin', 'Juillet', 'Aout'],
  'aubergine': ['Juin', 'Juillet', 'Aout', 'Septembre'],
  'betterave': ['Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre'],
  'brocoli': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'carotte': ['Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier'],
  'celeri': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier'],
  'champignon': ['Septembre', 'Octobre', 'Novembre'],
  'chou-fleur': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'chou': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'concombre': ['Mai', 'Juin', 'Juillet', 'Aout', 'Septembre'],
  'courge': ['Septembre', 'Octobre', 'Novembre', 'Decembre'],
  'courgette': ['Juin', 'Juillet', 'Aout', 'Septembre'],
  'endive': ['Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'epinard': ['Mars', 'Avril', 'Mai', 'Septembre', 'Octobre', 'Novembre'],
  'fenouil': ['Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre'],
  'haricot': ['Juin', 'Juillet', 'Aout', 'Septembre'],
  'laitue': ['Avril', 'Mai', 'Juin', 'Juillet', 'Aout', 'Septembre'],
  'mais': ['Juillet', 'Aout', 'Septembre'],
  'navet': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier'],
  'oignon': ['Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier'],
  'panais': ['Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'petit pois': ['Mai', 'Juin', 'Juillet'],
  'poireau': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'poivron': ['Juillet', 'Aout', 'Septembre', 'Octobre'],
  'pomme de terre': ['Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre'],
  'potimarron': ['Septembre', 'Octobre', 'Novembre', 'Decembre'],
  'potiron': ['Septembre', 'Octobre', 'Novembre', 'Decembre'],
  'radis': ['Avril', 'Mai', 'Juin', 'Juillet', 'Aout'],
  'salsifis': ['Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier'],
  'tomate': ['Juin', 'Juillet', 'Aout', 'Septembre'],
  'topinambour': ['Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier'],

  // Fruits
  'abricot': ['Juin', 'Juillet', 'Aout'],
  'ananas': ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai'],
  'banane': ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'],
  'cassis': ['Juillet', 'Aout'],
  'cerise': ['Mai', 'Juin', 'Juillet'],
  'chataigne': ['Octobre', 'Novembre', 'Decembre'],
  'citron': ['Janvier', 'Fevrier', 'Mars', 'Novembre', 'Decembre'],
  'clementine': ['Novembre', 'Decembre', 'Janvier'],
  'figue': ['Aout', 'Septembre', 'Octobre'],
  'fraise': ['Avril', 'Mai', 'Juin', 'Juillet'],
  'framboise': ['Juin', 'Juillet', 'Aout', 'Septembre'],
  'grenade': ['Octobre', 'Novembre', 'Decembre'],
  'groseille': ['Juin', 'Juillet', 'Aout'],
  'kiwi': ['Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars', 'Avril'],
  'mandarine': ['Novembre', 'Decembre', 'Janvier'],
  'melon': ['Juin', 'Juillet', 'Aout', 'Septembre'],
  'mirabelle': ['Aout', 'Septembre'],
  'mure': ['Aout', 'Septembre'],
  'myrtille': ['Juin', 'Juillet', 'Aout'],
  'nectarine': ['Juin', 'Juillet', 'Aout'],
  'orange': ['Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'pamplemousse': ['Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'pasteque': ['Juin', 'Juillet', 'Aout'],
  'peche': ['Juin', 'Juillet', 'Aout', 'Septembre'],
  'poire': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier'],
  'pomme': ['Septembre', 'Octobre', 'Novembre', 'Decembre', 'Janvier', 'Fevrier', 'Mars'],
  'prune': ['Juillet', 'Aout', 'Septembre'],
  'quetsche': ['Aout', 'Septembre'],
  'raisin': ['Aout', 'Septembre', 'Octobre'],
  'rhubarbe': ['Avril', 'Mai', 'Juin'],
};

function normalizeIngredientText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Autorise un "s" de pluriel optionnel après chaque mot de la clé, pour
// matcher "tomates", "pommes de terre", etc. à partir des formes au singulier.
function buildIngredientRegex(key) {
  const pattern = key
    .split(' ')
    .map((word) => `${escapeRegExp(word)}s?`)
    .join(' ');
  return new RegExp(`\\b${pattern}\\b`);
}

const NORMALIZED_ENTRIES = Object.entries(INGREDIENT_MONTHS)
  .map(([key, months]) => ({
    key: normalizeIngredientText(key),
    months,
    regex: buildIngredientRegex(normalizeIngredientText(key)),
  }))
  .sort((a, b) => b.key.length - a.key.length);

function detectMonthsFromIngredients(ingredients = []) {
  if (!Array.isArray(ingredients) || ingredients.length === 0) return [];

  const monthsSet = new Set();

  for (const rawIngredient of ingredients) {
    const normalized = normalizeIngredientText(rawIngredient);
    if (!normalized) continue;

    // Le premier match gagne : les clés sont triées de la plus longue à la
    // plus courte, pour que "pomme de terre" prime sur "pomme".
    const match = NORMALIZED_ENTRIES.find(({ regex }) => regex.test(normalized));
    if (match) {
      match.months.forEach((month) => monthsSet.add(month));
    }
  }

  return [...monthsSet];
}

module.exports = { detectMonthsFromIngredients };
