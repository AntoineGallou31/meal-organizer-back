// Verifie le classement automatique sur des titres connus, avec les 21 categories
// de reference (data/categories.js). En memoire, sans la base.
// Usage : node src/scripts/checkCategorizer.js
const { buildMatchers, classifyTitle } = require('../services/categoryMatcher');
const CATEGORIES = require('./data/categories');

// [titre, categorie attendue]
const CASES = [
  ['Risotto au chorizo', 'Riz & risottos'],
  ['Riz au lait', 'Desserts'],
  ['Tarte au citron meringuée', 'Desserts'],
  ['Tarte poireaux chèvre', 'Quiches & tartes salées'],
  ['Cake salé olives jambon', 'Cakes & clafoutis salés'],
  ['Cake au citron', 'Desserts'],
  ['Clafoutis aux cerises', 'Desserts'],
  ['Gratin de pâtes', 'Pâtes'],
  ['Gratin dauphinois', 'Plats de légumes'],
  ['Soupe de lentilles corail', 'Soupes & veloutés'],
  ['Salade de pâtes', 'Salades'],
  ['Curry de poulet', 'Currys & dahls'],
  ['Poulet au curry', 'Poulet & volaille'],
  ['Œufs cocotte aux épinards', 'Œufs & omelettes'],
  ['Croque-monsieur', 'Burgers & croques'],
  ['Pancakes moelleux', 'Petit-déjeuner & brunch'],
  ['Buddha bowl au quinoa', 'Bowls & assiettes complètes'],
  ['Thé glacé à la pêche', 'Boissons & cocktails'],
  ['Moussaka', 'Sans catégorie'],
];

const defaultName = CATEGORIES.find((category) => category.is_default).name;
const matchers = buildMatchers(CATEGORIES);
let failures = 0;

CASES.forEach(([title, expected]) => {
  const { category, keyword, confident } = classifyTitle(title, CATEGORIES, matchers);
  // Sans mot-cle reconnu, la categorie par defaut doit venir avec confident: false
  const ok = category.name === expected && confident === (expected !== defaultName);
  if (!ok) failures += 1;

  const found = keyword ? `${category.name} (« ${keyword} »)` : `${category.name} (aucun mot-cle, confident: ${confident})`;
  console.log(`${ok ? 'ok   ' : 'ECHEC'}  ${title} -> ${found}${ok ? '' : `, attendu : ${expected}`}`);
});

console.log(`\n${CASES.length - failures}/${CASES.length} cas passent`);
process.exit(failures ? 1 : 0);
