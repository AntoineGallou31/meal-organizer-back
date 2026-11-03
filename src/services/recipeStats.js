const supabase = require('./supabase');
const { getParisToday, getSeasonalSuggestions } = require('./recipeRecommendation');

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

// Recettes de la categorie "A completer" (meme recherche que GET /api/recipes)
async function countIncompleteRecipes() {
  const { data: category, error } = await supabase
    .from('categories')
    .select('id')
    .ilike('name', 'A completer')
    .maybeSingle();
  if (error) throw error;
  if (!category) return 0;

  const { count, error: countError } = await supabase
    .from('recipe_categories')
    .select('recipe_id', { count: 'exact', head: true })
    .eq('category_id', category.id);
  if (countError) throw countError;
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
