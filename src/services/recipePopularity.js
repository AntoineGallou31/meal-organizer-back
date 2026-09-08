const supabase = require('./supabase');

function todayDateString() {
  return new Date().toISOString().split('T')[0];
}

// Compte, pour chaque recette, le nombre de fois où elle a ete planifiee
// a une date deja passee (= consideree comme "faite").
async function getCookCountMap() {
  const { data, error } = await supabase
    .from('meal_plan_items')
    .select('recipe_id')
    .eq('type', 'recipe')
    .lt('date', todayDateString())
    .not('recipe_id', 'is', null);

  if (error) throw error;

  return (data || []).reduce((acc, row) => {
    if (!row.recipe_id) return acc;
    acc[row.recipe_id] = (acc[row.recipe_id] || 0) + 1;
    return acc;
  }, {});
}

async function getCookCountForRecipe(recipeId) {
  const { count, error } = await supabase
    .from('meal_plan_items')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'recipe')
    .eq('recipe_id', recipeId)
    .lt('date', todayDateString());

  if (error) throw error;
  return count || 0;
}

module.exports = { getCookCountMap, getCookCountForRecipe };
