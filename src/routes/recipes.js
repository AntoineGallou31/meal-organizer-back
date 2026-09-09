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
const { getWeeklySuggestions } = require('../services/recipeRecommendation');
const validateUUID = require('../middlewares/validateUUID');
const { APIError, handleError } = require('../services/errorHandler');
const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STEP_ACTION_KEYWORDS = [
  'melanger', 'mixer', 'fouetter', 'cuire', 'prechauffer', 'chauffer', 'faire revenir', 'rissoler',
  'emincer', 'hacher', 'couper', 'ajouter', 'incorporer', 'laisser mijoter', 'mijoter', 'assaisonner',
  'enfourner', 'battre', 'faire bouillir', 'egoutter', 'servir', 'verse', 'mix', 'bake', 'cook', 'stir',
  'whisk', 'chop', 'add', 'boil', 'simmer',
];

const CONTENT_NOISE_KEYWORDS = [
  'mentions legales', 'politique de confidentialite', 'conditions generales', 'cookie', 'newsletter',
  's inscrire', 'inscrivez vous', 'publicite', 'sponsorise', 'instagram', 'facebook', 'tiktok', 'linkedin',
  'partager', 'commentaires', 'laisser un commentaire', 'accepter', 'refuser', 'consent', 'subscribe',
];

const UNIT_OR_QUANTITY_REGEX = /(\b\d+(?:[.,]\d+)?\b|\b\d+\s*\/\s*\d+\b|\b(?:g|kg|mg|ml|cl|l|cs|c\.s\.|cas|c\.a\.s\.|cac|c\.a\.c\.|cuillere|cuilleres|teaspoon|tbsp|tsp|cup|cups|oz|lb)s?\b)/i;

function cleanLine(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]+\]\([^\)]+\)/g, ' ')
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

function matchesAnyKeyword(value, keywords) {
  const normalizedValue = normalizeForComparison(value);
  return keywords.some((keyword) => normalizedValue.includes(normalizeForComparison(keyword)));
}

function sanitizeImportedIngredients(ingredients = []) {
  const cleaned = [];
  const seen = new Set();

  for (const rawIngredient of Array.isArray(ingredients) ? ingredients : []) {
    const ingredient = cleanLine(rawIngredient);
    if (!ingredient) continue;
    if (/https?:\/\//i.test(ingredient)) continue;
    if (matchesAnyKeyword(ingredient, CONTENT_NOISE_KEYWORDS)) continue;
    if (matchesAnyKeyword(ingredient, STEP_ACTION_KEYWORDS)) continue;

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
    const hasAction = matchesAnyKeyword(step, STEP_ACTION_KEYWORDS);
    const hasQuantity = UNIT_OR_QUANTITY_REGEX.test(step);

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

  const preparedRecipeData = {
    ...normalizedRecipeData,
    ingredients: sanitizeImportedIngredients(normalizedRecipeData.ingredients),
    steps: sanitizeImportedSteps(normalizedRecipeData.steps),
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
  const { data, error } = await supabase
    .from('recipes')
    .select('id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,created_at,recipe_categories(categories(id,name,color))')
    .eq('id', recipeId)
    .maybeSingle();

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
    image_url: body.imageUrl ?? undefined,
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

  if (!partial || payload.ingredients !== undefined) {
    if (!Array.isArray(payload.ingredients) || payload.ingredients.length === 0) {
      return { error: 'Les ingrédients sont requis', field: 'ingredients' };
    }
  }

  if (!partial || payload.steps !== undefined) {
    if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
      return { error: 'Les étapes sont requises', field: 'steps' };
    }
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

    // Validation
    if (categoryId && !UUID_REGEX.test(categoryId)) {
      throw new APIError('L\'ID de catégorie fourni n\'est pas au format UUID valide', 400, 'INVALID_UUID');
    }
    if (req.query.prepMax !== undefined && Number.isNaN(prepMax)) {
      throw new APIError('Le paramètre prepMax doit être un nombre entier', 400, 'INVALID_PREP_MAX');
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

    let hiddenIncompleteRecipeIds = [];
    if (!search) {
      const { data: incompleteCategory, error: incompleteCategoryError } = await supabase
        .from('categories')
        .select('id')
        .ilike('name', 'A completer')
        .maybeSingle();

      if (incompleteCategoryError) throw incompleteCategoryError;

      if (incompleteCategory?.id && categoryId !== incompleteCategory.id) {
        const { data: incompleteLinks, error: incompleteLinksError } = await supabase
          .from('recipe_categories')
          .select('recipe_id')
          .eq('category_id', incompleteCategory.id);

        if (incompleteLinksError) throw incompleteLinksError;
        hiddenIncompleteRecipeIds = [...new Set((incompleteLinks || []).map((row) => row.recipe_id).filter(Boolean))];
      }
    }

    const selectString = buildRecipeSelectString({ summary: paged, categoryId });
    let query = supabase.from('recipes').select(selectString);

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

    const sortByPopularity = sort === 'popular';

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

    const [{ data, error }, cookCountMap] = await Promise.all([
      query,
      sortByPopularity ? getCookCountMap() : Promise.resolve(null),
    ]);
    if (error) {
      throw new APIError(
        'Impossible de récupérer les recettes',
        500,
        'FETCH_RECIPES_ERROR',
        { supabaseError: error.message }
      );
    }
    let visibleRecipes = hiddenIncompleteRecipeIds.length
      ? (data || []).filter((recipe) => !hiddenIncompleteRecipeIds.includes(recipe.id))
      : (data || []);

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

// GET /api/recipes/suggestions
router.get('/recipes/suggestions', async (req, res) => {
  try {
    const limit = parsePositiveInteger(req.query.limit, 7);
    const week = typeof req.query.week === 'string' ? req.query.week.trim() : '';
    const excludeRecipeIds = typeof req.query.exclude === 'string'
      ? req.query.exclude.split(',').map((id) => id.trim()).filter(Boolean)
      : [];

    const { week: resolvedWeek, suggestions } = await getWeeklySuggestions({ week, limit, excludeRecipeIds });

    res.json({
      week: resolvedWeek,
      items: suggestions.map(({ recipe, score, cookCount, lastCookedAt, reasons }) => ({
        ...mapRecipeWithCategories(recipe, { cookCount }),
        suggestionScore: score,
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
      const { data: similar, error: similarError } = await supabase
        .from('recipes')
        .select('id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,created_at,recipe_categories!inner(category_id,categories(id,name,color))')
        .neq('id', req.params.id)
        .in('recipe_categories.category_id', recipeCategoryIds)
        .order('created_at', { ascending: false })
        .limit(20);

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

    res.json({
      ...mapRecipeWithCategories(data, { cookCount }),
      similarRecipes,
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

    const withCategories = await fetchRecipeWithCategoriesById(data.id);
    res.json(mapRecipeWithCategories(withCategories));
  } catch (error) {
    handleError(error, res, { endpoint: 'PUT /api/recipes/:id', recipeId: req.params.id });
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
