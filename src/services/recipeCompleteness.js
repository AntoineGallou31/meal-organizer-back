const supabase = require('./supabase');

// Recette incomplete : sans ingredients ou sans etapes (null ou liste vide).
// Meme definition pour GET /api/recipes?incomplete=true, le compteur toComplete
// de GET /api/recipes/stats et l'exclusion des suggestions.
const INCOMPLETE_FILTER = 'ingredients.is.null,ingredients.eq.[],steps.is.null,steps.eq.[]';

// Restreint une requete sur `recipes` aux recettes incompletes.
function onlyIncompleteRecipes(query) {
  return query.or(INCOMPLETE_FILTER);
}

async function getIncompleteRecipeIds() {
  const { data, error } = await onlyIncompleteRecipes(supabase.from('recipes').select('id'));
  if (error) throw error;
  return new Set((data || []).map((recipe) => recipe.id));
}

async function countIncompleteRecipes() {
  const { count, error } = await onlyIncompleteRecipes(
    supabase.from('recipes').select('id', { count: 'exact', head: true })
  );
  if (error) throw error;
  return count || 0;
}

module.exports = { onlyIncompleteRecipes, getIncompleteRecipeIds, countIncompleteRecipes };
