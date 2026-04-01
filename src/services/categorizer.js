const supabase = require('./supabase');

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return [...new Set(
    keywords
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean)
  )];
}

async function detectCategory(title, ingredients) {
  const { data: categories, error } = await supabase
    .from('categories')
    .select('id, name, keywords, is_default');

  if (error) throw error;
  if (!categories || categories.length === 0) {
    throw new Error('Aucune categorie disponible');
  }

  const defaultCategory = categories.find((c) => c.is_default) || categories[0];
  const normalizedTitle = normalizeText(title);
  const ingredientText = Array.isArray(ingredients)
    ? ingredients.map((item) => String(item)).join(' ')
    : '';
  const fullText = `${normalizedTitle} ${normalizedTitle} ${normalizeText(ingredientText)}`;

  let bestCategory = null;
  let bestScore = 0;

  for (const category of categories) {
    if (category.is_default) continue;

    const keywords = normalizeKeywords(category.keywords);
    if (!keywords.length) continue;

    let score = 0;
    for (const keyword of keywords) {
      if (fullText.includes(keyword)) {
        score += normalizedTitle.includes(keyword) ? 2 : 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  if (!bestCategory || bestScore <= 0) {
    return {
      id: defaultCategory.id,
      name: defaultCategory.name,
      confident: false,
    };
  }

  return {
    id: bestCategory.id,
    name: bestCategory.name,
    confident: true,
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
