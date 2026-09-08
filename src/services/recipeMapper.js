function pickPrimaryCategory(categories = []) {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  return categories.find((category) => category && !category.is_default) || categories[0] || null;
}

function mapRecipeWithCategories(recipe) {
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  const months = Array.isArray(recipe.months) ? recipe.months : [];
  const categories = (recipe.recipe_categories || [])
    .map((rc) => rc.categories)
    .filter(Boolean);
  const primaryCategory = pickPrimaryCategory(categories);
  const restrictedDetail = ingredients.length === 0 || steps.length === 0;

  return {
    id: recipe.id,
    title: recipe.title,
    imageUrl: recipe.image_url ?? null,
    category: primaryCategory?.name ?? null,
    categories,
    months,
    ingredients,
    steps,
    prepTime: recipe.prep_time ?? null,
    servings: recipe.servings,
    sourceUrl: recipe.source_url,
    createdAt: recipe.created_at,
    restrictedDetail,
  };
}

module.exports = { mapRecipeWithCategories, pickPrimaryCategory };
