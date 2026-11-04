const supabase = require('./supabase');
const { getNonMealReason } = require('./mealCategories');
const { getIncompleteRecipeIds } = require('./recipeCompleteness');

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

// Date du jour a Paris (YYYY-MM-DD), et non en UTC : juste apres minuit,
// Paris est deja le lendemain.
function getParisToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Lundi de la semaine precedente, lundi et dimanche de la semaine de `dateString`.
function getWeekBounds(dateString) {
  const weekday = new Date(`${dateString}T00:00:00Z`).getUTCDay(); // 0 = dimanche
  const monday = addDays(dateString, -((weekday + 6) % 7));
  return { previousMonday: addDays(monday, -7), monday, sunday: addDays(monday, 6) };
}

// Recettes au menu entre le lundi de la semaine precedente et le dimanche de la
// semaine de reference, bornes incluses : faites la semaine derniere, ou deja
// prevues cette semaine. Renvoie id -> motif (la semaine derniere l'emporte).
async function getRecentlyPlannedRecipes(referenceDate) {
  const { previousMonday, monday, sunday } = getWeekBounds(referenceDate);
  const { data, error } = await supabase
    .from('meal_plan_items')
    .select('recipe_id,date')
    .eq('type', 'recipe')
    .not('recipe_id', 'is', null)
    .gte('date', previousMonday)
    .lte('date', sunday);

  if (error) throw error;

  const reasons = new Map();
  for (const row of data || []) {
    if (reasons.get(row.recipe_id) === 'cookedLastWeek') continue;
    reasons.set(row.recipe_id, row.date < monday ? 'cookedLastWeek' : 'plannedThisWeek');
  }

  return reasons;
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

// Toutes les categories, avec is_default, lues a part pour ne pas changer la
// forme des recettes renvoyees par l'API.
async function getCategoryMap() {
  const { data, error } = await supabase.from('categories').select('id,name,is_default');
  if (error) throw error;
  return new Map((data || []).map((category) => [category.id, category]));
}

function getRecipeCategories(recipe, categoryMap) {
  return (recipe.recipe_categories || [])
    .map((link) => categoryMap.get(link.category_id))
    .filter(Boolean);
}

// Motif pour lequel une recette n'est pas suggeree, ou null si elle l'est :
// incomplete (sans ingredients ou sans etapes), pas un plat (voir
// mealCategories.js), au menu la semaine derniere ou cette semaine, puis hors saison.
function getExclusionReason(recipe, { categoryMap, recentlyPlanned, incompleteRecipeIds }) {
  return (
    (incompleteRecipeIds.has(recipe.id) ? 'incomplete' : null) ||
    getNonMealReason(recipe.title, getRecipeCategories(recipe, categoryMap)) ||
    recentlyPlanned.get(recipe.id) ||
    (isInSeason(recipe.months) ? null : 'outOfSeason')
  );
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

// Tout ce qu'il faut pour decider et classer les suggestions d'une semaine de
// reference (`date`, YYYY-MM-DD ; par defaut aujourd'hui a Paris).
async function loadSuggestionContext({ date } = {}) {
  const referenceDate = date || getParisToday();
  const [
    { data: recipes, error },
    history,
    recentCategoryIds,
    categoryMap,
    recentlyPlanned,
    incompleteRecipeIds,
  ] = await Promise.all([
    supabase
      .from('recipes')
      .select('id,title,image_url,prep_time,months,created_at,recipe_categories(category_id,categories(id,name,color))'),
    getCookHistoryMap(),
    getRecentCategoryIds(),
    getCategoryMap(),
    getRecentlyPlannedRecipes(referenceDate),
    getIncompleteRecipeIds(),
  ]);

  if (error) throw error;

  return {
    referenceDate,
    recipes: recipes || [],
    history,
    recentCategoryIds,
    categoryMap,
    recentlyPlanned,
    incompleteRecipeIds,
  };
}

// Liste (paginee, "infinie") des plats de saison, triee de la plus a la moins
// populaire, sans ceux au menu la semaine precedente ou la semaine de reference.
// Les exclusions sont faites avant la pagination.
async function getSeasonalSuggestions({ page = 1, limit = 10, date } = {}) {
  const context = await loadSuggestionContext({ date });

  const candidates = context.recipes
    .filter((recipe) => !getExclusionReason(recipe, context))
    .map((recipe) => evaluateRecipe(recipe, context));

  const ordered = orderByPopularityWithDiversity(candidates);

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
  loadSuggestionContext,
  getExclusionReason,
  getWeekBounds,
  getParisToday,
  isValidDateString,
  toIsoWeek,
};
