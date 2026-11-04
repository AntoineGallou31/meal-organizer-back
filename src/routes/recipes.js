const { Router } = require('express');
const supabase = require('../services/supabase');
const { scrapeRecipe } = require('../services/scraper');
const {
  detectCategory,
  assignCategoryToRecipe,
  replaceCategoriesForRecipe,
  getOrCreateCategory,
} = require('../services/categorizer');
const { detectMonthsFromIngredients } = require('../services/ingredientMonths');
const { mapRecipeWithCategories } = require('../services/recipeMapper');
const { getCookCountMap, getCookCountForRecipe } = require('../services/recipePopularity');
const { getSeasonalSuggestions, isValidDateString } = require('../services/recipeRecommendation');
const { getRecipeStats } = require('../services/recipeStats');
const { onlyIncompleteRecipes } = require('../services/recipeCompleteness');
const { analyzeRecipe, getDefaultMatcher, toGrams } = require('../services/ingredientAnalyzer');
const { FOOD_COLUMNS } = require('../services/foodMatchers');
const { selectWithNutrition } = require('../services/schemaFallback');
const validateUUID = require('../middlewares/validateUUID');
const { APIError, handleError } = require('../services/errorHandler');
const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DIET_TAGS = ['viande', 'poisson', 'vegetarien', 'vegan', 'sans-gluten', 'sans-lactose'];
const MAIN_PROTEINS = ['animale', 'oeufs-laitiers', 'vegetale'];
// Après une correction d'ingrédient, nombre maximal d'autres recettes réanalysées
// dans la même requête (les suivantes le seront par analyzeRecipes.js)
const MAX_REANALYZED_RECIPES = 40;
const REANALYZE_CONCURRENCY = 4;

// L'analyse nutritionnelle ne doit jamais faire échouer un enregistrement
async function analyzeSafely(recipeId, endpoint) {
  try {
    await analyzeRecipe(recipeId);
  } catch (error) {
    console.error(`[nutrition] Analyse impossible pour la recette ${recipeId} (${endpoint}) :`, error.message || error);
  }
}

// [{ position, rawText, foodId, foodName, grams, status, matchScore, matchMethod }]
// Liste vide si la recette n'a pas encore été analysée (ou si la table n'existe pas encore).
async function fetchIngredientsAnalysis(recipeId) {
  const { data, error } = await supabase
    .from('recipe_ingredients')
    .select('position,raw_text,food_id,grams,status,match_score,match_method,foods(name)')
    .eq('recipe_id', recipeId)
    .order('position', { ascending: true });
  if (error) {
    console.error(`[nutrition] Lecture de l'analyse impossible pour la recette ${recipeId} :`, error.message);
    return [];
  }
  return (data || []).map((row) => ({
    position: row.position,
    rawText: row.raw_text,
    foodId: row.food_id ?? null,
    foodName: row.foods?.name ?? null,
    grams: row.grams ?? null,
    status: row.status,
    matchScore: row.match_score ?? null,
    matchMethod: row.match_method ?? null,
  }));
}

// Radicaux de verbes de cuisine, comparés en début de mot sur un texte sans accents :
// « melang » reconnaît mélanger, mélangez, mélangeant...
const STEP_ACTION_STEMS = [
  'melang', 'mix', 'fouett', 'cuire', 'cuis', 'prechauff', 'chauff', 'revenir', 'rissol', 'eminc',
  'hach', 'coup', 'ajout', 'incorpor', 'mijot', 'assaisonn', 'enfourn', 'batt', 'bouill', 'egoutt',
  'serv', 'vers', 'laiss', 'mett', 'eplu', 'dispos', 'retir', 'remu', 'degust', 'reserv', 'etal',
  'fai', 'fond', 'sal', 'poivr', 'decoup', 'tranch', 'rap', 'lav', 'pel', 'saupoudr', 'arros', 'plac',
  'repart', 'bake', 'cook', 'stir', 'whisk', 'chop', 'add', 'boil', 'simmer',
];
const STEP_ACTION_REGEX = new RegExp(`\\b(?:${STEP_ACTION_STEMS.join('|')})`);
// Pour les ingrédients, seul un verbe conjugué (« émincez ») signale une étape égarée :
// « 1 oignon à émincer » ou « 200 g de haddock » sont de vrais ingrédients.
const INSTRUCTION_VERB_REGEX = new RegExp(
  `\\b(?:${STEP_ACTION_STEMS.join('|')})[a-z]*ez\\b|^(?:add|mix|stir|whisk|chop|boil|simmer|bake|cook)\\b`
);

const CONTENT_NOISE_KEYWORDS = [
  'mentions legales', 'politique de confidentialite', 'conditions generales', 'cookie', 'newsletter',
  's inscrire', 'inscrivez vous', 'publicite', 'sponsorise', 'instagram', 'facebook', 'tiktok', 'linkedin',
  'partager', 'commentaires', 'laisser un commentaire', 'accepter', 'refuser', 'consent', 'consentement',
  'subscribe',
];

// Ligne qui ressemble à un ingrédient, testée sur un texte sans accents :
// - un nombre suivi d'une unité (« 200 g », « 20 cl », « 2 c. a s. ») ;
// - ou une ligne qui commence par une quantité (« 2 oignons »), mais pas « 1. Préchauffez ».
// Une unité seule ne compte pas : sinon le « l » de « l'ail » passait pour des litres.
const INGREDIENT_QUANTITY_REGEX = /\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?\s*(?:kg|mg|g|gr|grammes?|ml|cl|dl|l|litres?|cs|cas|cac|c\.?\s*a\.?\s*[sc]\.?|cuilleres?|tbsp|tsp|cups?|oz|lbs?)(?![a-z])|^\d+(?:[.,/]\d+)?\s*[^\d\s.)-]/;

function cleanLine(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeImportedText(value) {
  if (typeof value !== 'string') return value;

  return value
    .replace(/&#39;/g, "'")
    .replace(/\(\(/g, '(')
    .replace(/\)\)/g, ')');
}

function normalizeImportedRecipeData(recipeData = {}) {
  const rawPrepTime = recipeData.prepTime ?? recipeData.prep_time ?? recipeData.duration;
  const parsedPrepTime = rawPrepTime == null || rawPrepTime === ''
    ? null
    : Number.parseInt(String(rawPrepTime).replace(/[^\d]/g, ''), 10);

  return {
    ...recipeData,
    title: normalizeImportedText(recipeData.title),
    imageUrl: normalizeImportedText(recipeData.imageUrl ?? recipeData.image),
    ingredients: Array.isArray(recipeData.ingredients)
      ? recipeData.ingredients.map((line) => normalizeImportedText(String(line || '')))
      : recipeData.ingredients,
    steps: Array.isArray(recipeData.steps)
      ? recipeData.steps.map((line) => normalizeImportedText(String(line || '')))
      : (Array.isArray(recipeData.instructions)
        ? recipeData.instructions.map((line) => normalizeImportedText(String(line || '')))
        : recipeData.steps),
    prepTime: Number.isFinite(parsedPrepTime) ? parsedPrepTime : null,
    months: Array.isArray(recipeData.months)
      ? [...new Set(recipeData.months.map((month) => String(month || '').trim()).filter(Boolean))]
      : [],
  };
}

function normalizeForComparison(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Compare des mots entiers : « cookie » ne doit pas exclure « cookies émiettés »
function matchesAnyKeyword(value, keywords) {
  const normalizedValue = ` ${normalizeForComparison(value).replace(/[^a-z0-9]+/g, ' ')} `;
  return keywords.some((keyword) => normalizedValue.includes(` ${normalizeForComparison(keyword)} `));
}

// Recettes lues dans les données structurées du site (JSON-LD) : déjà propres,
// on ne fait que nettoyer les lignes, sans filtre par mots-clés.
function cleanImportedLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map(cleanLine).filter(Boolean);
}

function sanitizeImportedIngredients(ingredients = []) {
  const cleaned = [];
  const seen = new Set();

  for (const rawIngredient of Array.isArray(ingredients) ? ingredients : []) {
    const ingredient = cleanLine(rawIngredient);
    if (!ingredient) continue;
    if (/https?:\/\//i.test(ingredient)) continue;
    if (matchesAnyKeyword(ingredient, CONTENT_NOISE_KEYWORDS)) continue;
    if (INSTRUCTION_VERB_REGEX.test(normalizeForComparison(ingredient))) continue;

    const normalized = normalizeForComparison(ingredient);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(ingredient);
  }

  return cleaned;
}

function sanitizeImportedSteps(steps = []) {
  const cleaned = [];
  const seen = new Set();

  for (const rawStep of Array.isArray(steps) ? steps : []) {
    const step = cleanLine(rawStep);
    if (!step) continue;
    if (/https?:\/\//i.test(step)) continue;
    if (matchesAnyKeyword(step, CONTENT_NOISE_KEYWORDS)) continue;

    const normalized = normalizeForComparison(step);
    const hasAction = STEP_ACTION_REGEX.test(normalized);
    const hasQuantity = INGREDIENT_QUANTITY_REGEX.test(normalized);

    if (!hasAction && hasQuantity && normalized.split(/\s+/).length <= 8) continue;
    if (!hasAction && normalized.length < 12) continue;

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(step);
  }

  return cleaned;
}

function getMissingImportFields(recipeData = {}) {
  const missing = [];
  const title = recipeData.title ? String(recipeData.title).trim() : '';
  const imageUrl = recipeData.imageUrl ? String(recipeData.imageUrl).trim() : '';
  const hasIngredients = Array.isArray(recipeData.ingredients) && recipeData.ingredients.length > 0;
  const hasSteps = Array.isArray(recipeData.steps) && recipeData.steps.length > 0;

  if (!title) missing.push('title');
  if (!imageUrl) missing.push('image');
  if (!hasIngredients) missing.push('ingredients');
  if (!hasSteps) missing.push('steps');

  return missing;
}

async function findRecipeByExactSourceUrl(sourceUrl) {
  if (!sourceUrl) return null;

  const { data, error } = await supabase
    .from('recipes')
    .select('id,title,source_url')
    .eq('source_url', sourceUrl)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function throwDuplicateImportError(existingRecipe) {
  throw new APIError(
    'Cette recette a deja ete importee',
    409,
    'DUPLICATE_IMPORTED_RECIPE',
    {
      existingRecipeId: existingRecipe.id,
      title: existingRecipe.title,
      sourceUrl: existingRecipe.source_url,
    }
  );
}

async function persistImportedRecipe({
  url,
  recipeData,
  forceImport = false,
}) {
  const normalizedRecipeData = normalizeImportedRecipeData(recipeData);
  const titleRaw = normalizedRecipeData.title ? String(normalizedRecipeData.title).trim() : '';
  const missingFields = getMissingImportFields(normalizedRecipeData);

  const recipePreview = {
    title: titleRaw,
    imageUrl: normalizedRecipeData.imageUrl || null,
    sourceUrl: normalizedRecipeData.sourceUrl || url,
  };

  const isBlocked = missingFields.includes('title') || missingFields.includes('image');
  if (isBlocked) {
    return {
      importBlocked: true,
      recipePreview,
      missingFields,
    };
  }

  const needsReview = missingFields.includes('ingredients') || missingFields.includes('steps');
  if (needsReview && !forceImport) {
    return {
      needsImportReview: true,
      recipePreview,
      missingFields,
    };
  }

  const fromStructuredData = normalizedRecipeData.scrapingMeta?.parser === 'JSON-LD';
  const preparedRecipeData = {
    ...normalizedRecipeData,
    ingredients: fromStructuredData
      ? cleanImportedLines(normalizedRecipeData.ingredients)
      : sanitizeImportedIngredients(normalizedRecipeData.ingredients),
    steps: fromStructuredData
      ? cleanImportedLines(normalizedRecipeData.steps)
      : sanitizeImportedSteps(normalizedRecipeData.steps),
  };

  const importedIngredients = Array.isArray(preparedRecipeData.ingredients) ? preparedRecipeData.ingredients : [];
  const importedMonths = Array.isArray(preparedRecipeData.months) ? preparedRecipeData.months : [];
  const months = importedMonths.length > 0
    ? importedMonths
    : detectMonthsFromIngredients(importedIngredients);

  const insertPayload = {
    title: titleRaw || 'Recette importee',
    image_url: preparedRecipeData.imageUrl || null,
    prep_time: preparedRecipeData.prepTime || null,
    servings: preparedRecipeData.servings || null,
    ingredients: importedIngredients,
    steps: Array.isArray(preparedRecipeData.steps) ? preparedRecipeData.steps : [],
    source_url: preparedRecipeData.sourceUrl || url,
    months,
  };

  const existingRecipe = await findRecipeByExactSourceUrl(insertPayload.source_url);
  if (existingRecipe) {
    throwDuplicateImportError(existingRecipe);
  }

  const { data: inserted, error: insertError } = await supabase
    .from('recipes')
    .insert([insertPayload])
    .select('id')
    .single();

  if (insertError) throw insertError;

  const assignedCategoryIds = new Set();
  let autoDetected = false;
  let confident = true;

  if (Array.isArray(preparedRecipeData.categories) && preparedRecipeData.categories.length > 0) {
    for (const categoryName of preparedRecipeData.categories) {
      const categoryId = await getOrCreateCategory(categoryName);
      if (categoryId) assignedCategoryIds.add(categoryId);
    }
  } else if (typeof preparedRecipeData.category === 'string' && preparedRecipeData.category.trim()) {
    const categoryId = await getOrCreateCategory(preparedRecipeData.category.trim());
    if (categoryId) assignedCategoryIds.add(categoryId);
  }

  if (!assignedCategoryIds.size) {
    const detection = await detectCategory(insertPayload.title, insertPayload.ingredients);
    assignedCategoryIds.add(detection.id);
    autoDetected = true;
    confident = detection.confident;
  }

  for (const categoryId of assignedCategoryIds) {
    await assignCategoryToRecipe(inserted.id, categoryId);
  }

  await analyzeSafely(inserted.id, 'POST /api/recipes/import');

  const recipeWithCategories = await fetchRecipeWithCategoriesById(inserted.id);

  return {
    needsImportReview: false,
    recipe: {
      ...mapRecipeWithCategories(recipeWithCategories),
      missingFields,
      autoDetected,
      confident,
    },
  };
}

function normalizeCategoryIds(categoryIds) {
  if (!Array.isArray(categoryIds)) return null;
  const cleaned = categoryIds.filter((id) => typeof id === 'string' && UUID_REGEX.test(id));
  if (cleaned.length !== categoryIds.length) return null;
  return [...new Set(cleaned)];
}

function buildRecipeSelectString({ summary = false, categoryId = '' } = {}) {
  if (summary) {
    return `id,title,image_url,prep_time,created_at,recipe_categories${categoryId ? '!inner' : ''}(category_id)`;
  }

  return `id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,created_at,recipe_categories${categoryId ? '!inner' : ''}(category_id,categories(id,name,color))`;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchRecipeWithCategoriesById(recipeId) {
  const { data, error } = await selectWithNutrition((extraColumns) => supabase
    .from('recipes')
    .select(`${extraColumns}id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,created_at,recipe_categories(categories(id,name,color))`)
    .eq('id', recipeId)
    .maybeSingle());

  if (error) throw error;
  return data;
}

async function collectRecipeIdsByIngredientTerms(terms = []) {
  const uniqueTerms = [...new Set((terms || []).map((term) => String(term || '').trim()).filter(Boolean))];
  if (!uniqueTerms.length) return null;

  const foundIds = new Set();
  for (const term of uniqueTerms) {
    const { data, error } = await supabase.rpc('search_by_ingredient', { term });
    if (error) throw error;
    (data || []).forEach((row) => {
      if (row?.id) foundIds.add(row.id);
    });
  }

  return [...foundIds];
}

function normalizeRecipePayload(body = {}, { partial = false } = {}) {
  const title = typeof body.title === 'string' ? body.title.trim() : undefined;
  const ingredients = Array.isArray(body.ingredients)
    ? body.ingredients.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  const steps = Array.isArray(body.steps)
    ? body.steps.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  const months = Array.isArray(body.months)
    ? [...new Set(body.months.map((m) => String(m).trim()).filter(Boolean))]
    : undefined;
  const prepTimeInput = body.prepTime;
  const prepTimeParsed = prepTimeInput === undefined ? undefined : Number(prepTimeInput);
  const prepTimeValue = prepTimeParsed === undefined
    ? undefined
    : (prepTimeInput === null ? null : (Number.isFinite(prepTimeParsed) ? prepTimeParsed : undefined));

  const payload = {
    title,
    image_url: body.imageUrl === undefined ? undefined : (body.imageUrl || null),
    prep_time: prepTimeValue,
    servings: body.servings ?? undefined,
    ingredients,
    steps,
    source_url: body.sourceUrl ?? undefined,
    months,
  };

  if (partial) {
    const cleaned = {};
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined) {
        cleaned[key] = value;
      }
    });
    return cleaned;
  }

  return payload;
}

function validateRecipePayload(payload, { partial = false } = {}) {
  if (!partial || payload.title !== undefined) {
    if (!payload.title) {
      return { error: 'Le titre est requis', field: 'title' };
    }
  }

  if (payload.ingredients !== undefined && !Array.isArray(payload.ingredients)) {
    return { error: 'Les ingrédients doivent être une liste', field: 'ingredients' };
  }

  if (payload.steps !== undefined && !Array.isArray(payload.steps)) {
    return { error: 'Les étapes doivent être une liste', field: 'steps' };
  }

  return null;
}

// GET /api/recipes
router.get('/recipes', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId.trim() : '';
    const ingredient = typeof req.query.ingredient === 'string' ? req.query.ingredient.trim() : '';
    const month = typeof req.query.month === 'string'
      ? req.query.month.trim()
      : (typeof req.query.season === 'string' ? req.query.season.trim() : '');
    const prepMax = Number.parseInt(req.query.prepMax, 10);
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
    const page = parsePositiveInteger(req.query.page, 1);
    const limit = parsePositiveInteger(req.query.limit, 24);
    const summary = req.query.summary === 'true' || req.query.summary === true || req.query.summary === '1';
    const paged = req.query.page !== undefined || req.query.limit !== undefined || summary;
    // incomplete=true : seulement les recettes sans ingredients ou sans etapes
    const incomplete = req.query.incomplete === 'true';
    // diet=vegetarien,sans-gluten : la recette doit porter toutes ces etiquettes
    const diet = typeof req.query.diet === 'string'
      ? [...new Set(req.query.diet.split(',').map((tag) => tag.trim()).filter(Boolean))]
      : [];
    // protein=vegetale|animale|oeufs-laitiers
    const protein = typeof req.query.protein === 'string' ? req.query.protein.trim() : '';

    // Validation
    if (categoryId && !UUID_REGEX.test(categoryId)) {
      throw new APIError('L\'ID de catégorie fourni n\'est pas au format UUID valide', 400, 'INVALID_UUID');
    }
    if (req.query.prepMax !== undefined && Number.isNaN(prepMax)) {
      throw new APIError('Le paramètre prepMax doit être un nombre entier', 400, 'INVALID_PREP_MAX');
    }
    const unknownTags = diet.filter((tag) => !DIET_TAGS.includes(tag));
    if (unknownTags.length) {
      throw new APIError(`Régime inconnu : ${unknownTags.join(', ')}`, 400, 'INVALID_DIET', { allowed: DIET_TAGS });
    }
    if (protein && !MAIN_PROTEINS.includes(protein)) {
      throw new APIError(`Protéine inconnue : ${protein}`, 400, 'INVALID_PROTEIN', { allowed: MAIN_PROTEINS });
    }

    const ingredientTerms = [];
    if (ingredient) ingredientTerms.push(ingredient);

    let ingredientFilteredIds = null;
    if (ingredientTerms.length) {
      ingredientFilteredIds = await collectRecipeIdsByIngredientTerms(ingredientTerms);
      if (!ingredientFilteredIds.length) {
        return res.json([]);
      }
    }

    const selectString = buildRecipeSelectString({ summary: paged, categoryId });

    const sortByPopularity = sort === 'popular';
    // includeCookCount=true : chaque recette porte cookCount, quel que soit le tri
    const includeCookCount = req.query.includeCookCount === 'true';
    // cooked=never : seulement les recettes jamais planifiees a une date passee
    const neverCooked = req.query.cooked === 'never';
    const cookCountMap = sortByPopularity || includeCookCount || neverCooked ? await getCookCountMap() : null;

    // extraColumns : colonnes nutrition, absentes tant que nutrition.sql n'a pas ete execute
    const buildQuery = (extraColumns) => {
      let query = supabase.from('recipes').select(`${extraColumns}${selectString}`);

      if (search) {
        query = query.ilike('title', `%${search}%`);
      }
      if (categoryId) {
        query = query.eq('recipe_categories.category_id', categoryId);
      }
      if (month) {
        query = query.contains('months', [month]);
      }
      if (!Number.isNaN(prepMax)) {
        query = query.lte('prep_time', prepMax);
      }
      if (ingredientFilteredIds) {
        query = query.in('id', ingredientFilteredIds);
      }
      if (incomplete) {
        query = onlyIncompleteRecipes(query);
      }
      if (diet.length) {
        query = query.contains('diet_tags', diet);
      }
      if (protein) {
        query = query.eq('main_protein', protein);
      }

      // Exclusion faite dans la requete, avant la pagination, pour que les pages restent justes
      if (neverCooked) {
        const cookedIds = Object.keys(cookCountMap);
        if (cookedIds.length) {
          query = query.not('id', 'in', `(${cookedIds.join(',')})`);
        }
      }

      if (sort === 'oldest') {
        query = query.order('created_at', { ascending: true });
      } else if (sort === 'prepTime') {
        query = query.order('prep_time', { ascending: true });
      } else if (!sortByPopularity) {
        query = query.order('created_at', { ascending: false });
      }

      // Le tri par popularite depend d'un compte calcule en dehors de la DB,
      // donc on ne peut pas paginer via `range` avant d'avoir trie en memoire.
      if (paged && !sortByPopularity) {
        const offset = (page - 1) * limit;
        query = query.range(offset, offset + limit);
      }
      return query;
    };

    const { data, error } = await selectWithNutrition(buildQuery, {
      requireColumns: diet.length > 0 || Boolean(protein),
    });
    if (error) {
      throw new APIError(
        'Impossible de récupérer les recettes',
        500,
        'FETCH_RECIPES_ERROR',
        { supabaseError: error.message }
      );
    }
    let visibleRecipes = data || [];

    if (sortByPopularity) {
      visibleRecipes = [...visibleRecipes].sort(
        (a, b) => (cookCountMap[b.id] || 0) - (cookCountMap[a.id] || 0)
      );
      if (paged) {
        const offset = (page - 1) * limit;
        visibleRecipes = visibleRecipes.slice(offset, offset + limit + 1);
      }
    }

    const toResponse = (recipe) => mapRecipeWithCategories(recipe, {
      cookCount: cookCountMap ? (cookCountMap[recipe.id] || 0) : undefined,
    });

    if (paged) {
      return res.json({
        items: visibleRecipes.slice(0, limit).map(toResponse),
        page,
        limit,
        hasMore: visibleRecipes.length > limit,
      });
    }

    res.json(visibleRecipes.map(toResponse));
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/recipes' });
  }
});

// GET /api/recipes/stats : { total, seasonal, favorites, toComplete, suggestions }
// Declaree avant /recipes/:id, sinon "stats" serait pris pour un id.
router.get('/recipes/stats', async (req, res) => {
  try {
    res.json(await getRecipeStats());
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/recipes/stats' });
  }
});

// GET /api/recipes/suggestions
router.get('/recipes/suggestions', async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, 1);
    const limit = parsePositiveInteger(req.query.limit, 10);
    // Semaine de reference (optionnelle) : sans elle, celle d'aujourd'hui a Paris
    const { date } = req.query;
    if (date !== undefined && !isValidDateString(date)) {
      throw new APIError('Le paramètre date doit être une date valide au format YYYY-MM-DD', 400, 'INVALID_DATE');
    }

    const { items, hasMore } = await getSeasonalSuggestions({ page, limit, date });

    res.json({
      page,
      limit,
      hasMore,
      items: items.map(({ recipe, cookCount, lastCookedAt, reasons }) => ({
        ...mapRecipeWithCategories(recipe, { cookCount }),
        lastCookedAt,
        suggestionReasons: reasons,
      })),
    });
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/recipes/suggestions' });
  }
});

// GET /api/recipes/:id
router.get('/recipes/:id', validateUUID('id'), async (req, res) => {
  try {
    const data = await fetchRecipeWithCategoriesById(req.params.id);
    if (!data) {
      throw new APIError(
        `Aucune recette trouvée avec l\'ID: ${req.params.id}`,
        404,
        'RECIPE_NOT_FOUND'
      );
    }

    const recipeCategoryIds = (data.recipe_categories || []).map((rc) => rc.category_id).filter(Boolean);
    let similarRecipes = [];

    if (recipeCategoryIds.length) {
      const { data: similar, error: similarError } = await selectWithNutrition((extraColumns) => supabase
        .from('recipes')
        .select(`${extraColumns}id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,created_at,recipe_categories!inner(category_id,categories(id,name,color))`)
        .neq('id', req.params.id)
        .in('recipe_categories.category_id', recipeCategoryIds)
        .order('created_at', { ascending: false })
        .limit(20));

      if (similarError) {
        throw new APIError(
          'Impossible de récupérer les recettes similaires',
          500,
          'FETCH_SIMILAR_RECIPES_ERROR',
          { supabaseError: similarError.message }
        );
      }

      const unique = new Map();
      (similar || []).forEach((recipe) => {
        if (!unique.has(recipe.id) && unique.size < 3) {
          unique.set(recipe.id, mapRecipeWithCategories(recipe));
        }
      });
      similarRecipes = [...unique.values()];
    }

    const cookCount = await getCookCountForRecipe(req.params.id);
    const ingredientsAnalysis = await fetchIngredientsAnalysis(req.params.id);

    res.json({
      ...mapRecipeWithCategories(data, { cookCount }),
      similarRecipes,
      ingredientsAnalysis,
    });
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/recipes/:id', recipeId: req.params.id });
  }
});

// POST /api/recipes
router.post('/recipes', async (req, res) => {
  try {
    const payload = normalizeRecipePayload(req.body);
    const validationError = validateRecipePayload(payload);
    if (validationError) return res.status(400).json(validationError);

    if (!payload.months || payload.months.length === 0) {
      payload.months = detectMonthsFromIngredients(payload.ingredients);
    }

    const categoryIds = req.body?.categoryIds;
    const categoryName = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
    const categoryNames = Array.isArray(req.body?.categories)
      ? req.body.categories.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (categoryIds !== undefined && !Array.isArray(categoryIds)) {
      return res.status(400).json({ error: 'categoryIds doit etre un tableau de UUID' });
    }

    const normalizedCategoryIds = categoryIds !== undefined ? normalizeCategoryIds(categoryIds) : null;
    if (categoryIds !== undefined && normalizedCategoryIds === null) {
      return res.status(400).json({ error: 'categoryIds doit etre un tableau de UUID valides' });
    }

    const { data, error } = await supabase
      .from('recipes')
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    let autoDetected = false;
    let confident = true;

    if (categoryIds !== undefined) {
      await replaceCategoriesForRecipe(data.id, normalizedCategoryIds);
    } else if (categoryNames.length > 0) {
      const ids = [];
      for (const name of categoryNames) {
        const categoryId = await getOrCreateCategory(name);
        if (categoryId) ids.push(categoryId);
      }
      await replaceCategoriesForRecipe(data.id, ids);
    } else if (categoryName) {
      const categoryId = await getOrCreateCategory(categoryName);
      await replaceCategoriesForRecipe(data.id, categoryId ? [categoryId] : []);
    } else {
      const detection = await detectCategory(payload.title, payload.ingredients);
      await assignCategoryToRecipe(data.id, detection.id);
      autoDetected = true;
      confident = detection.confident;
    }

    await analyzeSafely(data.id, 'POST /api/recipes');

    const withCategories = await fetchRecipeWithCategoriesById(data.id);

    res.status(201).json({
      ...mapRecipeWithCategories(withCategories),
      autoDetected,
      confident,
    });
  } catch (error) {
    handleError(error, res, { endpoint: 'POST /api/recipes' });
  }
});

// POST /api/recipes/import
router.post('/recipes/import', async (req, res) => {
  const { url, forceImport } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required', field: 'url' });
  }

  try {
    const existingRecipe = await findRecipeByExactSourceUrl(String(url).trim());
    if (existingRecipe) {
      throwDuplicateImportError(existingRecipe);
    }

    const recipeData = await scrapeRecipe(url);
    const persisted = await persistImportedRecipe({
      url,
      recipeData,
      forceImport: forceImport === true,
    });

    if (persisted.importBlocked) {
      return res.status(422).json({
        error: 'Le titre et la photo sont indispensables pour importer une recette.',
        code: 'IMPORT_BLOCKED',
        missingFields: persisted.missingFields,
        recipePreview: persisted.recipePreview,
      });
    }

    if (persisted.needsImportReview) {
      return res.status(422).json({
        error: 'Certaines informations de la recette n\'ont pas pu être récupérées.',
        code: 'IMPORT_VALIDATION_FAILED',
        missingFields: persisted.missingFields,
        recipePreview: persisted.recipePreview,
      });
    }

    res.status(201).json(persisted.recipe);
  } catch (err) {
    if (err instanceof APIError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        url,
        details: err.details || null,
      });
    }

    console.error(err);
    res.status(500).json({
      error: 'Failed to import recipe',
      code: err.code || 'IMPORT_FAILED',
      url,
      details: {
        message: err.message || 'Erreur inconnue pendant l\'import',
      },
    });
  }
});

// PUT /api/recipes/:id
router.put('/recipes/:id', validateUUID('id'), async (req, res) => {
  try {
    const payload = normalizeRecipePayload(req.body, { partial: true });
    const validationError = validateRecipePayload(payload, { partial: true });
    if (validationError) return res.status(400).json(validationError);
    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    }

    const { data, error } = await supabase
      .from('recipes')
      .update(payload)
      .eq('id', req.params.id)
      .select('id')
      .single();
    if (error) throw error;
    if (!data) {
      throw new APIError('Recette non trouvée avec cet ID', 404, 'RECIPE_NOT_FOUND');
    }

    if (payload.ingredients !== undefined || payload.servings !== undefined) {
      await analyzeSafely(data.id, 'PUT /api/recipes/:id');
    }

    const withCategories = await fetchRecipeWithCategoriesById(data.id);
    res.json(mapRecipeWithCategories(withCategories));
  } catch (error) {
    handleError(error, res, { endpoint: 'PUT /api/recipes/:id', recipeId: req.params.id });
  }
});

// Lignes de recipe_ingredients à réanalyser après un nouvel alias : même nom,
// pas encore corrigées à la main, et non reconnues ou reconnues par similarité
async function findRecipesToReanalyze(name, excludedRecipeId) {
  const ids = new Set();
  for (const narrow of [
    (query) => query.is('food_id', null),
    (query) => query.eq('match_method', 'similarity'),
  ]) {
    const { data, error } = await narrow(supabase
      .from('recipe_ingredients')
      .select('recipe_id')
      .eq('name', name)
      .eq('status', 'auto'));
    if (error) throw error;
    (data || []).forEach((row) => { if (row.recipe_id !== excludedRecipeId) ids.add(row.recipe_id); });
  }
  return [...ids];
}

// PUT /api/recipes/:id/ingredients/:position
// Corps : { foodId, grams? } pour choisir l'aliment, ou { status: 'ignored', grams? }.
// La ligne est marquée comme décidée à la main et gardée lors des prochaines analyses
// tant que son texte ne change pas.
router.put('/recipes/:id/ingredients/:position', validateUUID('id'), async (req, res) => {
  try {
    const recipeId = req.params.id;
    const position = Number(req.params.position);
    const { foodId, status, grams } = req.body || {};
    const ignoring = status === 'ignored';
    const gramsProvided = grams !== undefined && grams !== null;

    if (!Number.isInteger(position) || position < 0) {
      throw new APIError('position doit être un entier >= 0', 400, 'INVALID_POSITION');
    }
    if (status !== undefined && !ignoring) {
      throw new APIError('status ne peut valoir que "ignored"', 400, 'INVALID_STATUS');
    }
    if (ignoring === Boolean(foodId)) {
      throw new APIError('Envoyer soit foodId, soit status: "ignored"', 400, 'INVALID_INGREDIENT_CORRECTION');
    }
    if (foodId && (typeof foodId !== 'string' || !UUID_REGEX.test(foodId))) {
      throw new APIError('foodId doit être un UUID', 400, 'INVALID_UUID');
    }
    if (gramsProvided && !(typeof grams === 'number' && Number.isFinite(grams) && grams >= 0)) {
      throw new APIError('grams doit être un nombre >= 0', 400, 'INVALID_GRAMS');
    }

    const { data: line, error: lineError } = await supabase
      .from('recipe_ingredients')
      .select('position,name,quantity,unit')
      .eq('recipe_id', recipeId)
      .eq('position', position)
      .maybeSingle();
    if (lineError) throw lineError;
    if (!line) {
      throw new APIError('Ligne d\'ingrédient introuvable', 404, 'INGREDIENT_LINE_NOT_FOUND');
    }

    let update;
    if (ignoring) {
      update = { status: 'ignored', match_method: 'manual', food_id: null, match_score: null, grams: gramsProvided ? grams : null };
    } else {
      const { data: food, error: foodError } = await supabase
        .from('foods')
        .select(FOOD_COLUMNS.join(','))
        .eq('id', foodId)
        .maybeSingle();
      if (foodError) throw foodError;
      if (!food) throw new APIError('Aliment introuvable', 400, 'FOOD_NOT_FOUND');
      const computed = gramsProvided ? grams : toGrams(line.quantity, line.unit, food);
      update = {
        status: 'checked',
        match_method: 'manual',
        food_id: foodId,
        match_score: null,
        grams: computed === null ? null : Math.round(computed * 10) / 10,
      };
    }

    const { error: updateError } = await supabase
      .from('recipe_ingredients')
      .update(update)
      .eq('recipe_id', recipeId)
      .eq('position', position);
    if (updateError) throw updateError;

    // Le nom de la ligne devient un alias de l'aliment choisi (s'il n'en existe pas déjà un)
    const matcher = getDefaultMatcher();
    let aliasCreated = false;
    if (!ignoring && line.name) {
      const { data: inserted, error: aliasError } = await supabase
        .from('food_aliases')
        .upsert({ alias: line.name, food_id: foodId }, { onConflict: 'alias', ignoreDuplicates: true })
        .select('alias');
      if (aliasError) throw aliasError;
      aliasCreated = (inserted || []).length > 0;
      matcher.invalidate();
    }

    const result = await analyzeRecipe(recipeId, { matcher });

    // Les autres recettes où ce nom n'était pas reconnu (ou seulement par similarité)
    let reanalyzed = 0;
    let remaining = 0;
    if (!ignoring && line.name) {
      const others = await findRecipesToReanalyze(line.name, recipeId);
      const batch = others.slice(0, MAX_REANALYZED_RECIPES);
      remaining = others.length - batch.length;
      for (let start = 0; start < batch.length; start += REANALYZE_CONCURRENCY) {
        await Promise.all(batch.slice(start, start + REANALYZE_CONCURRENCY).map((otherId) =>
          analyzeRecipe(otherId, { matcher }).then(
            () => { reanalyzed += 1; },
            (error) => console.error(`[nutrition] Réanalyse impossible pour la recette ${otherId} :`, error.message || error)
          )));
      }
    }

    res.json({
      nutrition: result.nutrition,
      dietTags: result.dietTags,
      mainProtein: result.mainProtein,
      ingredientsAnalysis: await fetchIngredientsAnalysis(recipeId),
      aliasCreated,
      reanalyzedRecipes: reanalyzed,
      remainingRecipes: remaining,
    });
  } catch (error) {
    handleError(error, res, {
      endpoint: 'PUT /api/recipes/:id/ingredients/:position',
      recipeId: req.params.id,
      position: req.params.position,
    });
  }
});

// DELETE /api/recipes/:id
router.delete('/recipes/:id', validateUUID('id'), async (req, res) => {
  try {
    // In a real app, you might want to set ON DELETE SET NULL or CASCADE in the DB
    await supabase.from('meal_plan_items').delete().eq('recipe_id', req.params.id);
    
    const { data, error } = await supabase
      .from('recipes')
      .delete()
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new APIError('Recette non trouvée avec cet ID', 404, 'RECIPE_NOT_FOUND');
    }
    res.status(204).send();
  } catch (error) {
    handleError(error, res, { endpoint: 'DELETE /api/recipes/:id', recipeId: req.params.id });
  }
});

module.exports = router;
