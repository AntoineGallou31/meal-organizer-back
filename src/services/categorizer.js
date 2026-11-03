const supabase = require('./supabase');
const { classifyTitle } = require('./categoryMatcher');

// Categorie d'une recette d'apres les mots-cles trouves dans son titre
// (regles dans categoryMatcher.js). Sans mot-cle reconnu : la categorie par
// defaut, avec confident a false. Les ingredients ne sont plus pris en compte ;
// le parametre reste pour ne pas changer la signature.
async function detectCategory(title, _ingredients) {
  const { data: categories, error } = await supabase
    .from('categories')
    .select('id, name, keywords, is_default');

  if (error) throw error;
  if (!categories || categories.length === 0) {
    throw new Error('Aucune categorie disponible');
  }

  const { category, confident } = classifyTitle(title, categories);
  return {
    id: category.id,
    name: category.name,
    confident,
  };
}

async function assignCategoryToRecipe(recipeId, categoryId) {
  const { error } = await supabase
    .from('recipe_categories')
    .upsert([{ recipe_id: recipeId, category_id: categoryId }], {
      onConflict: 'recipe_id,category_id',
    });

  if (error) throw error;
}

async function replaceCategoriesForRecipe(recipeId, categoryIds) {
  const { error: deleteError } = await supabase
    .from('recipe_categories')
    .delete()
    .eq('recipe_id', recipeId);

  if (deleteError) throw deleteError;

  const uniqueCategoryIds = [...new Set((categoryIds || []).filter(Boolean))];
  if (!uniqueCategoryIds.length) return;

  const rows = uniqueCategoryIds.map((categoryId) => ({
    recipe_id: recipeId,
    category_id: categoryId,
  }));

  const { error: insertError } = await supabase
    .from('recipe_categories')
    .insert(rows);

  if (insertError) throw insertError;
}

async function getOrCreateCategory(name, color) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) {
    throw new Error('Le nom de categorie est requis');
  }

  const { data: existing, error: findError } = await supabase
    .from('categories')
    .select('id')
    .ilike('name', normalizedName)
    .maybeSingle();

  if (findError) throw findError;
  if (existing) return existing.id;

  const { data: created, error: createError } = await supabase
    .from('categories')
    .insert([{ name: normalizedName, color: color || '#888888' }])
    .select('id')
    .single();

  if (createError) throw createError;
  return created.id;
}

module.exports = {
  detectCategory,
  assignCategoryToRecipe,
  replaceCategoriesForRecipe,
  getOrCreateCategory,
};
