const supabase = require('./supabase');

const MONTH_NAMES = [
  'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre',
];

// Poids du score. Ajustables sans toucher a la logique.
const WEIGHTS = {
  freshness: 40, // jamais faite ou faite il y a longtemps -> score plus haut
  rarity: 25, // recette peu cuisinee au global -> score plus haut
  season: 20, // recette de saison ce mois-ci
  diversity: 15, // categorie differente des repas recents du planning
};

// Au-dela de ce nombre de jours, la fraicheur est consideree maximale.
const FRESHNESS_CAP_DAYS = 60;
// Nombre de derniers repas planifies (faits) a regarder pour la diversite.
const RECENT_MEALS_WINDOW = 5;
// Nombre de recettes cuisinees "beaucoup" servant a plafonner le malus de rarete.
const RARITY_CAP_COUNT = 10;
// Malus applique (en points de score) a chaque recette deja retenue dans le
// lot de la semaine pour ses categories, afin de diversifier la selection.
const INTRA_LIST_CATEGORY_PENALTY = 12;

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

// Semaine ISO courante au format YYYY-Www, coherent avec routes/mealPlan.js.
function getCurrentIsoWeek() {
  const now = new Date();
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function isValidIsoWeek(week) {
  return typeof week === 'string' && /^\d{4}-W\d{2}$/.test(week);
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

function computeRarityScore(cookCount) {
  const cappedCount = Math.min(cookCount, RARITY_CAP_COUNT);
  return 1 - cappedCount / RARITY_CAP_COUNT;
}

function computeSeasonScore(months) {
  if (!Array.isArray(months) || months.length === 0) return 0.5; // recette non renseignee = neutre
  return months.includes(getCurrentMonthName()) ? 1 : 0;
}

function computeDiversityScore(recipeCategoryIds, recentCategoryIds) {
  if (!recentCategoryIds.size) return 1;
  if (!recipeCategoryIds.length) return 0.5;
  const overlaps = recipeCategoryIds.some((id) => recentCategoryIds.has(id));
  return overlaps ? 0 : 1;
}

function scoreRecipe(recipe, { history, recentCategoryIds }) {
  const entry = history[recipe.id];
  const cookCount = entry?.count || 0;
  const lastDate = entry?.lastDate || null;
  const recipeCategoryIds = (recipe.recipe_categories || [])
    .map((rc) => rc.category_id)
    .filter(Boolean);

  const freshness = computeFreshnessScore(lastDate);
  const rarity = computeRarityScore(cookCount);
  const season = computeSeasonScore(recipe.months);
  const diversity = computeDiversityScore(recipeCategoryIds, recentCategoryIds);

  const baseScore =
    freshness * WEIGHTS.freshness +
    rarity * WEIGHTS.rarity +
    season * WEIGHTS.season +
    diversity * WEIGHTS.diversity;

  return {
    baseScore,
    recipeCategoryIds,
    cookCount,
    lastCookedAt: lastDate,
    reasons: {
      neverCooked: !lastDate,
      inSeason: season === 1,
      addsDiversity: diversity === 1 && recentCategoryIds.size > 0,
    },
  };
}

// Selection gloutonne : a chaque tour, on prend le meilleur score restant
// (score de base moins un malus pour les categories deja choisies dans le
// lot), puis on penalise ses categories pour le tour suivant. Diversifie la
// liste elle-meme, pas seulement par rapport a l'historique passe.
function pickDiversifiedTopN(candidates, limit) {
  const remaining = [...candidates];
  const categoryPenalties = new Map();
  const picked = [];

  while (remaining.length && picked.length < limit) {
    let bestIndex = 0;
    let bestAdjustedScore = -Infinity;

    remaining.forEach((candidate, index) => {
      const penalty = candidate.recipeCategoryIds.reduce(
        (sum, categoryId) => sum + (categoryPenalties.get(categoryId) || 0),
        0
      );
      const adjustedScore = candidate.baseScore - penalty;
      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    });

    const [chosen] = remaining.splice(bestIndex, 1);
    picked.push({ ...chosen, score: Math.round(bestAdjustedScore * 100) / 100 });
    chosen.recipeCategoryIds.forEach((categoryId) => {
      categoryPenalties.set(categoryId, (categoryPenalties.get(categoryId) || 0) + INTRA_LIST_CATEGORY_PENALTY);
    });
  }

  return picked;
}

async function computeRecipeSuggestions({ limit = 7, excludeRecipeIds = [] } = {}) {
  const [{ data: recipes, error }, history, recentCategoryIds] = await Promise.all([
    supabase
      .from('recipes')
      .select('id,title,image_url,prep_time,months,created_at,recipe_categories(category_id,categories(id,name,color))'),
    getCookHistoryMap(),
    getRecentCategoryIds(),
  ]);

  if (error) throw error;

  const excluded = new Set(excludeRecipeIds);
  const candidates = (recipes || [])
    .filter((recipe) => !excluded.has(recipe.id))
    .map((recipe) => ({
      recipe,
      ...scoreRecipe(recipe, { history, recentCategoryIds }),
    }));

  return pickDiversifiedTopN(candidates, limit);
}

async function getStoredWeeklySuggestions(week) {
  const { data, error } = await supabase
    .from('weekly_suggestions')
    .select('recipe_ids')
    .eq('week', week)
    .maybeSingle();

  if (error) {
    // Table absente ou non migree : on retombe sur le calcul a la volee.
    if (error.code === '42P01' || /does not exist|schema cache/i.test(error.message || '')) {
      return null;
    }
    throw error;
  }

  return data?.recipe_ids || null;
}

async function storeWeeklySuggestions(week, recipeIds) {
  const { error } = await supabase
    .from('weekly_suggestions')
    .upsert({ week, recipe_ids: recipeIds, created_at: new Date().toISOString() }, { onConflict: 'week' });

  if (error && error.code !== '42P01' && !/does not exist|schema cache/i.test(error.message || '')) {
    throw error;
  }
}

async function hydrateSuggestionsFromIds(recipeIds, { history, recentCategoryIds }) {
  if (!recipeIds.length) return [];

  const { data: recipes, error } = await supabase
    .from('recipes')
    .select('id,title,image_url,prep_time,months,created_at,recipe_categories(category_id,categories(id,name,color))')
    .in('id', recipeIds);

  if (error) throw error;

  const byId = new Map((recipes || []).map((recipe) => [recipe.id, recipe]));

  return recipeIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((recipe) => {
      const { baseScore, ...rest } = scoreRecipe(recipe, { history, recentCategoryIds });
      return { recipe, score: Math.round(baseScore * 100) / 100, ...rest };
    });
}

// Suggestions "de la semaine" : calculees une fois par semaine ISO puis
// figees (stockees en base) pour rester stables jusqu'a la semaine suivante,
// meme si l'historique du planning change entre-temps.
async function getWeeklySuggestions({ week, limit = 7, excludeRecipeIds = [] } = {}) {
  const targetWeek = isValidIsoWeek(week) ? week : getCurrentIsoWeek();

  const storedIds = await getStoredWeeklySuggestions(targetWeek);
  const [history, recentCategoryIds] = await Promise.all([getCookHistoryMap(), getRecentCategoryIds()]);

  if (storedIds && storedIds.length) {
    const hydrated = await hydrateSuggestionsFromIds(
      storedIds.filter((id) => !excludeRecipeIds.includes(id)),
      { history, recentCategoryIds }
    );
    if (hydrated.length) return { week: targetWeek, suggestions: hydrated };
  }

  const suggestions = await computeRecipeSuggestions({ limit, excludeRecipeIds });
  await storeWeeklySuggestions(targetWeek, suggestions.map((s) => s.recipe.id));

  return { week: targetWeek, suggestions };
}

module.exports = {
  getWeeklySuggestions,
  getCurrentIsoWeek,
  // Exports internes utiles pour les tests / le debug.
  computeFreshnessScore,
  computeRarityScore,
  computeSeasonScore,
  computeDiversityScore,
};
