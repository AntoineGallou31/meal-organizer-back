// Verifie les regles des suggestions (GET /api/recipes/suggestions). Lecture seule.
// Usage : node src/scripts/checkSuggestions.js [YYYY-MM-DD]
//   La date optionnelle remplace "une date de la semaine prochaine" (par defaut : dans 7 jours).
// Affiche :
//   - le nombre de recettes exclues par motif et le nombre de recettes restantes ;
//   - les recettes ecartees par le filet de securite sur le titre (faux positifs a reperer) ;
//   - les 10 premieres suggestions pour aujourd'hui et pour la date de la semaine prochaine.
require('dotenv').config({ quiet: true });
const {
  getExclusionReason,
  getParisToday,
  getSeasonalSuggestions,
  getWeekBounds,
  isValidDateString,
  loadSuggestionContext,
} = require('../services/recipeRecommendation');

// Ordre des motifs : une recette est comptee sous le premier qui s'applique.
const REASONS = [
  ['nonMealCategory', 'categorie hors plat'],
  ['noMealCategory', 'sans categorie de plat'],
  ['sweetTitle', 'titre sucre ou boisson'],
  ['cookedLastWeek', 'faite la semaine derniere'],
  ['plannedThisWeek', 'deja prevue cette semaine'],
  ['outOfSeason', 'hors saison'],
];

const TOP_COUNT = 10;

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function categoryNames(recipe) {
  return (recipe.recipe_categories || []).map((link) => link.categories?.name).filter(Boolean).join(', ');
}

function describeWeek(date) {
  const { previousMonday, monday, sunday } = getWeekBounds(date);
  return `semaine du ${monday} au ${sunday} (semaine derniere : depuis le ${previousMonday})`;
}

async function printTop(date, label) {
  const { items, total } = await getSeasonalSuggestions({ page: 1, limit: TOP_COUNT, date });
  console.log(`\n${TOP_COUNT} premieres suggestions ${label} (${date}, ${total} au total)`);
  items.forEach((item, index) => {
    const cooked = item.cookCount ? `faite ${item.cookCount} fois, derniere le ${item.lastCookedAt}` : 'jamais faite';
    console.log(`  ${String(index + 1).padStart(2)}. ${item.recipe.title}  [${categoryNames(item.recipe)}] - ${cooked}`);
  });
}

async function main() {
  const today = getParisToday();
  const nextWeekDate = process.argv[2] || addDays(today, 7);
  if (!isValidDateString(nextWeekDate)) throw new Error(`Date invalide : ${nextWeekDate}`);

  const context = await loadSuggestionContext({ date: today });
  const counts = new Map(REASONS.map(([key]) => [key, 0]));
  const sweetTitles = [];
  let remaining = 0;

  context.recipes.forEach((recipe) => {
    const reason = getExclusionReason(recipe, context);
    if (!reason) {
      remaining += 1;
      return;
    }
    counts.set(reason, counts.get(reason) + 1);
    if (reason === 'sweetTitle') sweetTitles.push(recipe);
  });

  console.log(`Aujourd'hui a Paris : ${today}, ${describeWeek(today)}`);
  console.log(`${context.recipes.length} recettes en base\n`);
  console.log('Exclues par motif (chaque recette comptee une fois, au premier motif) :');
  REASONS.forEach(([key, label]) => console.log(`  ${String(counts.get(key)).padStart(4)}  ${label}`));
  console.log(`  ${String(remaining).padStart(4)}  restantes (suggerables)`);

  console.log(`\nEcartees par le filet de securite sur le titre (${sweetTitles.length}) :`);
  sweetTitles
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'))
    .forEach((recipe) => console.log(`  - ${recipe.title}  [${categoryNames(recipe)}]`));

  await printTop(today, "pour aujourd'hui");
  await printTop(nextWeekDate, `pour la semaine prochaine, ${describeWeek(nextWeekDate)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur checkSuggestions:', error.message || error);
    process.exit(1);
  });
