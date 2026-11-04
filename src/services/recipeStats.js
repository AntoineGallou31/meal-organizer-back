const supabase = require('./supabase');
const { getParisToday, getSeasonalSuggestions } = require('./recipeRecommendation');
// toComplete : recettes sans ingredients ou sans etapes (meme filtre que GET /api/recipes?incomplete=true)
const { countIncompleteRecipes } = require('./recipeCompleteness');

const MONTH_NAMES = [
  'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre',
];

// "Août", "aout", "Aout" -> "aout"
function normalizeMonth(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function isMissingColumnError(error) {
  return error?.code === '42703' || /column .* does not exist|schema cache/i.test(error?.message || '');
}

async function countRecipes() {
  const { count, error } = await supabase.from('recipes').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

// Recettes dont les mois contiennent le mois courant (a Paris), accents ou non
async function countSeasonalRecipes() {
  const currentMonth = normalizeMonth(MONTH_NAMES[Number(getParisToday().slice(5, 7)) - 1]);
  const { data, error } = await supabase.from('recipes').select('months');
  if (error) throw error;
  return (data || []).filter((recipe) => (recipe.months || []).some((month) => normalizeMonth(month) === currentMonth)).length;
}

// 0 tant que la colonne is_favorite n'existe pas (script favorites.sql pas encore execute)
async function countFavoriteRecipes() {
  // Requete GET (et non HEAD) pour que l'erreur "colonne absente" soit lisible
  const { count, error } = await supabase
    .from('recipes')
    .select('id', { count: 'exact' })
    .eq('is_favorite', true)
    .limit(1);
  if (error) {
    if (isMissingColumnError(error)) return 0;
    throw error;
  }
  return count || 0;
}

// Meme liste que GET /api/recipes/suggestions pour la semaine en cours
async function countSuggestions() {
  const { total } = await getSeasonalSuggestions({ page: 1, limit: 1 });
  return total;
}

// Compteurs de l'onglet Recettes (sous-titre et raccourcis)
async function getRecipeStats() {
  const [total, seasonal, favorites, toComplete, suggestions] = await Promise.all([
    countRecipes(),
    countSeasonalRecipes(),
    countFavoriteRecipes(),
    countIncompleteRecipes(),
    countSuggestions(),
  ]);
  return { total, seasonal, favorites, toComplete, suggestions };
}

module.exports = { getRecipeStats };
