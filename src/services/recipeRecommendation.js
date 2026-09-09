const supabase = require('./supabase');

const MONTH_NAMES = [
  'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre',
];

// Au-dela de ce nombre de jours, la fraicheur est consideree maximale.
const FRESHNESS_CAP_DAYS = 60;
// Nombre de derniers repas planifies (faits) a regarder pour la diversite.
const RECENT_MEALS_WINDOW = 5;
// Malus applique (en points de score) a chaque recette deja retenue dans le
// lot pour ses categories, afin de diversifier la selection.
const INTRA_LIST_CATEGORY_PENALTY = 3;
// Nombre d'ids memorises par semaine pour pouvoir les exclure la semaine suivante.
const REMEMBERED_SUGGESTIONS_COUNT = 30;

// Categories jamais proposees dans les suggestions : ce ne sont pas des
// plats de tous les jours (boissons, sucre, apero, condiments).
const EXCLUDED_CATEGORY_NAMES = [
  'cocktails',
  'desserts',
  'brunch',
  'petit-dejeuner & brunch',
  'aperitif',
  'snacks & apero',
  'sauces & condiments',
];

function normalizeCategoryName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

const EXCLUDED_CATEGORY_NAME_SET = new Set(EXCLUDED_CATEGORY_NAMES.map(normalizeCategoryName));

function hasExcludedCategory(recipe) {
  return (recipe.recipe_categories || []).some((rc) => {
    const name = rc.categories?.name;
    return name && EXCLUDED_CATEGORY_NAME_SET.has(normalizeCategoryName(name));
  });
}

function todayDateString() {
  return new Date().toISOString().split('T')[0];
}

function getCurrentMonthName() {
  return MONTH_NAMES[new Date().getMonth()];
}

function daysBetween(dateStringA, dateStringB) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = new Date(`${dateStringA}T00:00:00Z`).getTime();
  const b = new Date(`${dateStringB}T00:00:00Z`).getTime();
  return Math.round((a - b) / msPerDay);
}

// Semaine ISO au format YYYY-Www, coherent avec routes/mealPlan.js.
function toIsoWeek(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getCurrentIsoWeek() {
  return toIsoWeek(new Date());
}

function getPreviousIsoWeek() {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return toIsoWeek(oneWeekAgo);
}

// Historique des recettes deja planifiees a une date passee : pour chacune,
// nombre de fois faite et date de la derniere fois.
async function getCookHistoryMap() {
  const { data, error } = await supabase
    .from('meal_plan_items')
    .select('recipe_id,date')
    .eq('type', 'recipe')
    .lt('date', todayDateString())
    .not('recipe_id', 'is', null)
    .order('date', { ascending: false });

  if (error) throw error;

  const history = {};
  for (const row of data || []) {
    if (!row.recipe_id) continue;
    if (!history[row.recipe_id]) {
      history[row.recipe_id] = { count: 0, lastDate: row.date };
    }
    history[row.recipe_id].count += 1;
  }

  return history;
}

// Categories des N derniers repas planifies (passes), pour penaliser la
// repetition d'une meme categorie d'un coup a l'autre.
async function getRecentCategoryIds(limit = RECENT_MEALS_WINDOW) {
  const { data, error } = await supabase
    .from('meal_plan_items')
    .select('date,recipes(recipe_categories(category_id))')
    .eq('type', 'recipe')
    .lt('date', todayDateString())
    .not('recipe_id', 'is', null)
    .order('date', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const categoryIds = new Set();
  for (const row of data || []) {
    const links = row.recipes?.recipe_categories || [];
    links.forEach((link) => {
      if (link?.category_id) categoryIds.add(link.category_id);
    });
  }

  return categoryIds;
}

// Ids suggeres la semaine ISO precedente, pour ne pas reproposer les memes
// recettes deux semaines de suite. Retombe sur une liste vide si la table
// n'existe pas encore (avant migration) ou si rien n'a ete enregistre.
async function getPreviouslySuggestedRecipeIds() {
  const { data, error } = await supabase
    .from('weekly_suggestions')
    .select('recipe_ids')
    .eq('week', getPreviousIsoWeek())
    .maybeSingle();

  if (error) {
    if (error.code === '42P01' || /does not exist|schema cache/i.test(error.message || '')) {
      return [];
    }
    throw error;
  }

  return data?.recipe_ids || [];
}

async function rememberThisWeekSuggestions(recipeIds) {
  const { error } = await supabase
    .from('weekly_suggestions')
    .upsert(
      {
        week: getCurrentIsoWeek(),
        recipe_ids: recipeIds.slice(0, REMEMBERED_SUGGESTIONS_COUNT),
        created_at: new Date().toISOString(),
      },
      { onConflict: 'week' }
    );

  if (error && error.code !== '42P01' && !/does not exist|schema cache/i.test(error.message || '')) {
    throw error;
  }
}

function computeFreshnessScore(lastDate) {
  if (!lastDate) return 1; // jamais cuisinee = fraicheur maximale
  const daysSince = daysBetween(todayDateString(), lastDate);
  if (daysSince <= 0) return 0;
  return Math.min(daysSince, FRESHNESS_CAP_DAYS) / FRESHNESS_CAP_DAYS;
}

function computeDiversityScore(recipeCategoryIds, recentCategoryIds) {
  if (!recentCategoryIds.size) return 1;
  if (!recipeCategoryIds.length) return 0.5;
  const overlaps = recipeCategoryIds.some((id) => recentCategoryIds.has(id));
  return overlaps ? 0 : 1;
}

function isInSeason(months) {
  return Array.isArray(months) && months.includes(getCurrentMonthName());
}

function evaluateRecipe(recipe, { history, recentCategoryIds }) {
  const entry = history[recipe.id];
  const cookCount = entry?.count || 0;
  const lastDate = entry?.lastDate || null;
  const recipeCategoryIds = (recipe.recipe_categories || [])
    .map((rc) => rc.category_id)
    .filter(Boolean);

  return {
    recipe,
    recipeCategoryIds,
    cookCount,
    lastCookedAt: lastDate,
    freshness: computeFreshnessScore(lastDate),
    diversity: computeDiversityScore(recipeCategoryIds, recentCategoryIds),
    reasons: {
      neverCooked: !lastDate,
      inSeason: true,
      addsDiversity: computeDiversityScore(recipeCategoryIds, recentCategoryIds) === 1 && recentCategoryIds.size > 0,
    },
  };
}

// Selection gloutonne : trie par popularite (cookCount desc), fraicheur en
// departage, puis penalise a chaque tour les categories deja choisies pour
// eviter une liste dominee par 2-3 categories.
function orderByPopularityWithDiversity(candidates) {
  const remaining = [...candidates];
  const categoryPenalties = new Map();
  const ordered = [];

  while (remaining.length) {
    let bestIndex = 0;
    let bestRank = -Infinity;

    remaining.forEach((candidate, index) => {
      const penalty = candidate.recipeCategoryIds.reduce(
        (sum, categoryId) => sum + (categoryPenalties.get(categoryId) || 0),
        0
      );
      // cookCount domine le tri ; freshness ne sert qu'a departager a egalite.
      const rank = candidate.cookCount * 1000 + candidate.freshness * 10 - penalty;
      if (rank > bestRank) {
        bestRank = rank;
        bestIndex = index;
      }
    });

    const [chosen] = remaining.splice(bestIndex, 1);
    ordered.push(chosen);
    chosen.recipeCategoryIds.forEach((categoryId) => {
      categoryPenalties.set(categoryId, (categoryPenalties.get(categoryId) || 0) + INTRA_LIST_CATEGORY_PENALTY);
    });
  }

  return ordered;
}

// Liste (paginee, "infinie") des recettes de saison, triee de la plus a la
// moins populaire, en excluant les recettes deja suggerees la semaine
// precedente pour varier d'une semaine a l'autre.
async function getSeasonalSuggestions({ page = 1, limit = 10 } = {}) {
  const [{ data: recipes, error }, history, recentCategoryIds, previouslySuggestedIds] = await Promise.all([
    supabase
      .from('recipes')
      .select('id,title,image_url,prep_time,months,created_at,recipe_categories(category_id,categories(id,name,color))'),
    getCookHistoryMap(),
    getRecentCategoryIds(),
    getPreviouslySuggestedRecipeIds(),
  ]);

  if (error) throw error;

  const previouslySuggested = new Set(previouslySuggestedIds);

  const candidates = (recipes || [])
    .filter((recipe) => isInSeason(recipe.months))
    .filter((recipe) => !hasExcludedCategory(recipe))
    .filter((recipe) => !previouslySuggested.has(recipe.id))
    .map((recipe) => evaluateRecipe(recipe, { history, recentCategoryIds }));

  const ordered = orderByPopularityWithDiversity(candidates);

  if (page === 1) {
    await rememberThisWeekSuggestions(ordered.map((item) => item.recipe.id));
  }

  const offset = (page - 1) * limit;
  const pageItems = ordered.slice(offset, offset + limit);

  return {
    items: pageItems,
    hasMore: offset + limit < ordered.length,
    total: ordered.length,
  };
}

module.exports = {
  getSeasonalSuggestions,
  getCurrentIsoWeek,
};
