const { Router } = require('express');
const supabase = require('../services/supabase');
const { scrapeRecipe } = require('../services/scraper');
const {
  detectCategory,
  assignCategoryToRecipe,
  replaceCategoriesForRecipe,
  getOrCreateCategory,
} = require('../services/categorizer');
const validateUUID = require('../middlewares/validateUUID');
const { APIError, handleError } = require('../services/errorHandler');
const router = Router();

// Simple UUID v4 generator for compatibility
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEASON_INGREDIENTS = {
  spring: ['asperge', 'petit pois', 'radis', 'epinard', 'fraise', 'artichaut', 'feve'],
  summer: ['tomate', 'courgette', 'aubergine', 'poivron', 'mais', 'peche', 'abricot', 'melon', 'pasteque', 'basilic'],
  autumn: ['potiron', 'potimarron', 'courge', 'champignon', 'chataigne', 'pomme', 'poire', 'raisin', 'chou', 'betterave'],
  winter: ['poireau', 'panais', 'navet', 'endive', 'chou-fleur', 'brocoli', 'orange', 'clementine', 'truffe', 'celeri'],
};

const TITLE_RECIPE_KEYWORDS = [
  'recette', 'soupe', 'veloute', 'salade', 'curry', 'gratin', 'quiche', 'pizza', 'burger', 'tacos',
  'omelette', 'crepe', 'gateau', 'tarte', 'brownie', 'cookie', 'muffin', 'pancake', 'riz', 'risotto',
  'pates', 'lasagne', 'ravioli', 'gnocchi', 'sauce', 'plat', 'dessert', 'poisson', 'poulet', 'boeuf',
  'porc', 'agneau', 'tofu', 'lentilles', 'pois chiches', 'dhal', 'tajine', 'cassoulet', 'sandwich',
];

const ALERT_CATEGORY_COMPLETE = {
  name: 'A completer',
  color: '#F59E0B',
};

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function titleLooksLikeRecipe(title) {
  const normalizedTitle = normalizeTextForMatch(title);
  if (!normalizedTitle) {
    return { valid: true, matchedKeywords: [] };
  }

  const matchedKeywords = TITLE_RECIPE_KEYWORDS.filter((keyword) => normalizedTitle.includes(keyword));
  return {
    valid: matchedKeywords.length > 0,
    matchedKeywords,
  };
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

async function scrapeRecipeWithRetries(url) {
  const maxAttempts = Number(process.env.IMPORT_URL_RETRY_ATTEMPTS || 3);
  let recipeData = null;
  let lastScrapeError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      recipeData = await scrapeRecipe(url);
      lastScrapeError = null;
      break;
    } catch (error) {
      lastScrapeError = error;
      if (attempt < maxAttempts) {
        const delay = Math.min(2500, 400 * Math.pow(2, attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  if (!recipeData) {
    throw lastScrapeError || new Error('Extraction impossible');
  }

  return recipeData;
}

async function persistImportedRecipe({ url, recipeData, forceImportUnverifiedTitle = false }) {
  const missingFields = getMissingImportFields(recipeData);
  const titleRaw = recipeData.title ? String(recipeData.title).trim() : '';
  const titleCheck = titleLooksLikeRecipe(titleRaw);
  const requiresTitleVerification = Boolean(titleRaw) && !titleCheck.valid;

  if (requiresTitleVerification && !forceImportUnverifiedTitle) {
    return {
      needsTitleVerification: true,
      recipePreview: {
        title: titleRaw,
        imageUrl: recipeData.imageUrl || null,
        sourceUrl: recipeData.sourceUrl || url,
      },
      missingFields,
      titleCheck,
    };
  }

  const insertPayload = {
    title: titleRaw || 'Recette importee',
    image_url: recipeData.imageUrl || null,
    prep_time: recipeData.prepTime || null,
    servings: recipeData.servings || null,
    ingredients: Array.isArray(recipeData.ingredients) ? recipeData.ingredients : [],
    steps: Array.isArray(recipeData.steps) ? recipeData.steps : [],
    source_url: recipeData.sourceUrl || url,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('recipes')
    .insert([insertPayload])
    .select('id')
    .single();

  if (insertError) throw insertError;

  const assignedCategoryIds = new Set();
  let autoDetected = false;
  let confident = true;

  if (missingFields.length > 0) {
    const toCompleteCategoryId = await getOrCreateCategory(ALERT_CATEGORY_COMPLETE.name, ALERT_CATEGORY_COMPLETE.color);
    assignedCategoryIds.add(toCompleteCategoryId);
  }

  if (requiresTitleVerification || forceImportUnverifiedTitle) {
    const toCompleteCategoryId = await getOrCreateCategory(ALERT_CATEGORY_COMPLETE.name, ALERT_CATEGORY_COMPLETE.color);
    assignedCategoryIds.add(toCompleteCategoryId);
    confident = false;
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
  const categories = (recipeWithCategories.recipe_categories || []).map((rc) => rc.categories).filter(Boolean);

  return {
    needsTitleVerification: false,
    recipe: {
      ...recipeWithCategories,
      categories,
      missingFields,
      incomplete: missingFields.length > 0,
      requiresTitleVerification,
      autoDetected,
      confident,
      externalOnly: false,
    },
  };
}

function normalizeCategoryIds(categoryIds) {
  if (!Array.isArray(categoryIds)) return null;
  const cleaned = categoryIds.filter((id) => typeof id === 'string' && UUID_REGEX.test(id));
  if (cleaned.length !== categoryIds.length) return null;
  return [...new Set(cleaned)];
}

function mapRecipeWithCategories(recipe) {
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  const seasons = Array.isArray(recipe.seasons) ? recipe.seasons : [];

  return {
    id: recipe.id,
    title: recipe.title,
    image_url: recipe.image_url,
    prep_time: recipe.prep_time,
    servings: recipe.servings,
    source_url: recipe.source_url,
    created_at: recipe.created_at,
    ingredients,
    steps,
    seasons,
    external_only: Boolean(recipe.source_url) && ingredients.length === 0 && steps.length === 0,
    categories: (recipe.recipe_categories || [])
      .map((rc) => rc.categories)
      .filter(Boolean),
  };
}

async function fetchRecipeWithCategoriesById(recipeId) {
  const { data, error } = await supabase
    .from('recipes')
    .select('id,title,image_url,prep_time,servings,ingredients,steps,source_url,created_at,recipe_categories(categories(id,name,color))')
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

async function processImport(jobId, urls = []) {
  const results = {
    success: 0,
    failed: 0,
    errors: [],
    created: [],
    needsReview: [],
  };

  console.log(`[Import Job ${jobId}] Starting with ${urls.length} URLs`);

  try {
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      // Check job status to support cancellation
      try {
        const { data: jobRow } = await supabase.from('job_status').select('status').eq('id', jobId).maybeSingle();
        if (jobRow && jobRow.status === 'cancelled') {
          console.log(`[Import Job ${jobId}] Cancelled by user. Stopping processing.`);
          await supabase
            .from('job_status')
            .update({
              status: 'cancelled',
              processed: results.success + results.failed,
              results,
              updated_at: new Date().toISOString(),
            })
            .eq('id', jobId);
          break;
        }
      } catch (err) {
        console.error(`[Import Job ${jobId}] Erreur lors de la vérification du status:`, err.message || err);
      }
      try {
        console.log(`[Import Job ${jobId}] Processing URL ${i + 1}/${urls.length}: ${url}`);
        const recipeData = await scrapeRecipeWithRetries(url);
        const persisted = await persistImportedRecipe({ url, recipeData, forceImportUnverifiedTitle: false });

        if (persisted.needsTitleVerification) {
          throw new Error('Titre douteux: import annule pour validation manuelle');
        }

        const recipe = persisted.recipe;
        results.success += 1;
        results.created.push({
          id: recipe.id,
          title: recipe.title,
          source_url: recipe.source_url,
          incomplete: recipe.incomplete,
          requiresTitleVerification: recipe.requiresTitleVerification,
        });

        if (!recipe.confident) {
          results.needsReview.push({
            recipeId: recipe.id,
            recipeTitle: recipe.title,
            assignedCategory: (recipe.categories || []).map((c) => c?.name).filter(Boolean).join(', '),
          });
        }

        console.log(`[Import Job ${jobId}] ✓ Success: ${recipe.title}`);
      } catch (error) {
        results.failed += 1;
        const errorMsg = error.message || 'Import impossible';
        results.errors.push({ url, message: errorMsg });
        console.error(`[Import Job ${jobId}] ✗ Failed: ${url} - ${errorMsg}`);
      }

      if ((i + 1) % 10 === 0) {
        await supabase
          .from('job_status')
          .update({
            processed: results.success + results.failed,
            results,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
        console.log(`[Import Job ${jobId}] Progress: ${results.success + results.failed}/${urls.length}`);
      }
    }

    await supabase
      .from('job_status')
      .update({
        status: 'completed',
        processed: results.success + results.failed,
        results,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
    
    console.log(`[Import Job ${jobId}] Completed - Success: ${results.success}, Failed: ${results.failed}`);
  } catch (error) {
    console.error(`[Import Job ${jobId}] Fatal error:`, error);
    await supabase
      .from('job_status')
      .update({
        status: 'failed',
        processed: results.success + results.failed,
        results: {
          ...results,
          fatalError: error.message || 'Erreur inattendue',
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}

// POST /api/recipes/import-cancel
router.post('/recipes/import-cancel', async (req, res) => {
  try {
    const jobId = (req.body && req.body.jobId) || null;
    if (!jobId || !UUID_REGEX.test(jobId)) {
      return res.status(400).json({ error: 'jobId manquant ou invalide', field: 'jobId' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('job_status')
      .select('id,status,processed,total,results')
      .eq('id', jobId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'Job non trouve' });

    if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
      return res.status(200).json({ id: jobId, status: existing.status });
    }

    const { error: updateError } = await supabase
      .from('job_status')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', jobId);
    if (updateError) throw updateError;

    return res.json({ id: jobId, status: 'cancelled' });
  } catch (error) {
    handleError(error, res, { endpoint: 'POST /api/recipes/import-cancel' });
  }
});

function extractUrlsFromBody(body = {}) {
  let rawUrls = [];

  if (Array.isArray(body)) {
    rawUrls = body;
  } else if (Array.isArray(body.urls)) {
    rawUrls = body.urls;
  } else if (Array.isArray(body.links)) {
    rawUrls = body.links;
  } else if (typeof body.content === 'string') {
    const matches = body.content.match(/https?:\/\/[^\s"'<>]+/g) || [];
    rawUrls = matches;
  }

  return [...new Set(
    rawUrls
      .map((url) => String(url || '').trim())
      .filter((url) => /^https?:\/\//i.test(url)),
  )];
}

function normalizeRecipePayload(body = {}, { partial = false } = {}) {
  const title = typeof body.title === 'string' ? body.title.trim() : undefined;
  const ingredients = Array.isArray(body.ingredients)
    ? body.ingredients.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  const steps = Array.isArray(body.steps)
    ? body.steps.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  const seasons = Array.isArray(body.seasons)
    ? [...new Set(body.seasons.map((s) => String(s).trim().toLowerCase()).filter(Boolean))]
    : undefined;

  const payload = {
    title,
    image_url: body.imageUrl ?? body.image_url ?? undefined,
    prep_time: body.prepTime ?? body.prep_time ?? undefined,
    servings: body.servings ?? undefined,
    ingredients,
    steps,
    source_url: body.sourceUrl ?? body.source_url ?? undefined,
    seasons,
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
    const season = typeof req.query.season === 'string' ? req.query.season.trim().toLowerCase() : '';
    const prepMax = Number.parseInt(req.query.prepMax, 10);
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';

    // Validation
    if (categoryId && !UUID_REGEX.test(categoryId)) {
      throw new APIError('L\'ID de catégorie fourni n\'est pas au format UUID valide', 400, 'INVALID_UUID');
    }
    if (season && !Object.keys(SEASON_INGREDIENTS).includes(season)) {
      throw new APIError(`La saison "${season}" n\'existe pas. Saisons disponibles: ${Object.keys(SEASON_INGREDIENTS).join(', ')}`, 400, 'INVALID_SEASON');
    }
    if (req.query.prepMax !== undefined && Number.isNaN(prepMax)) {
      throw new APIError('Le paramètre prepMax doit être un nombre entier', 400, 'INVALID_PREP_MAX');
    }

    const ingredientTerms = [];
    if (ingredient) ingredientTerms.push(ingredient);
    if (season) ingredientTerms.push(...SEASON_INGREDIENTS[season]);

    let ingredientFilteredIds = null;
    if (ingredientTerms.length) {
      ingredientFilteredIds = await collectRecipeIdsByIngredientTerms(ingredientTerms);
      if (!ingredientFilteredIds.length) {
        return res.json([]);
      }
    }

    const selectString = `id,title,image_url,prep_time,servings,ingredients,steps,source_url,created_at,recipe_categories${categoryId ? '!inner' : ''}(category_id,categories(id,name,color))`;
    let query = supabase.from('recipes').select(selectString);

    if (search) {
      query = query.ilike('title', `%${search}%`);
    }
    if (categoryId) {
      query = query.eq('recipe_categories.category_id', categoryId);
    }
    if (!Number.isNaN(prepMax)) {
      query = query.lte('prep_time', prepMax);
    }
    if (ingredientFilteredIds) {
      query = query.in('id', ingredientFilteredIds);
    }

    if (sort === 'oldest') {
      query = query.order('created_at', { ascending: true });
    } else if (sort === 'prepTime') {
      query = query.order('prep_time', { ascending: true });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;
    if (error) {
      throw new APIError(
        'Impossible de récupérer les recettes',
        500,
        'FETCH_RECIPES_ERROR',
        { supabaseError: error.message }
      );
    }
    res.json((data || []).map(mapRecipeWithCategories));
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/recipes' });
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
        .select('id,title,image_url,prep_time,servings,ingredients,steps,source_url,created_at,recipe_categories!inner(category_id,categories(id,name,color))')
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

    res.json({
      ...mapRecipeWithCategories(data),
      categories: (data.recipe_categories || []).map((rc) => rc.categories).filter(Boolean),
      similar_recipes: similarRecipes,
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

    const categoryIds = req.body?.categoryIds;
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
    } else {
      const detection = await detectCategory(payload.title, payload.ingredients);
      await assignCategoryToRecipe(data.id, detection.id);
      autoDetected = true;
      confident = detection.confident;
    }

    const withCategories = await fetchRecipeWithCategoriesById(data.id);

    res.status(201).json({
      ...withCategories,
      categories: (withCategories.recipe_categories || []).map((rc) => rc.categories).filter(Boolean),
      autoDetected,
      confident,
    });
  } catch (error) {
    handleError(error, res, { endpoint: 'POST /api/recipes' });
  }
});

// POST /api/recipes/import
router.post('/recipes/import', async (req, res) => {
    const { url, forceImportUnverifiedTitle } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required', field: 'url' });
    }

    try {
        const recipeData = await scrapeRecipeWithRetries(url);
        const persisted = await persistImportedRecipe({
          url,
          recipeData,
          forceImportUnverifiedTitle: Boolean(forceImportUnverifiedTitle),
        });

        if (persisted.needsTitleVerification) {
          return res.status(422).json({
            error: 'Le titre extrait ne ressemble pas a un titre de recette.',
            code: 'TITLE_NEEDS_VERIFICATION',
            canForceImport: true,
            missingFields: persisted.missingFields,
            titleKeywordsMatched: persisted.titleCheck.matchedKeywords,
            recipePreview: persisted.recipePreview,
          });
        }

        res.status(201).json(persisted.recipe);
    } catch (err) {
        if (err.partial) {
            return res.status(422).json({ error: err.message, url });
        }
        console.error(err);
        res.status(500).json({ error: "Failed to import recipe", url });
    }
});

async function createBulkImportJob(req, res, endpointLabel) {
  try {
    const urls = extractUrlsFromBody(req.body || {});
    if (!urls.length) {
      throw new APIError('Aucune URL détectée dans le fichier', 400, 'NO_URLS_FOUND');
    }

    const jobId = generateUUID();

    const { data: job, error } = await supabase
      .from('job_status')
      .insert([{
        id: jobId,
        status: 'running',
        total: urls.length,
        processed: 0,
        results: {
          success: 0,
          failed: 0,
          errors: [],
          created: [],
          needsReview: [],
        },
      }])
      .select('id, status, total, processed, results')
      .single();

    if (error) {
      throw new APIError(
        'Impossible de créer le job d\'import',
        500,
        'CREATE_JOB_ERROR',
        { supabaseError: error.message }
      );
    }

    processImport(job.id, urls).catch((importError) => {
      console.error('Import error:', importError);
    });

    return res.status(202).json(job);
  } catch (error) {
    handleError(error, res, { endpoint: endpointLabel });
  }
}

// POST /api/recipes/import-urls
router.post('/recipes/import-urls', async (req, res) => {
  return createBulkImportJob(req, res, 'POST /api/recipes/import-urls');
});

// POST /api/recipes/import-pinterest-export (legacy alias)
router.post('/recipes/import-pinterest-export', async (req, res) => {
  return createBulkImportJob(req, res, 'POST /api/recipes/import-pinterest-export');
});

// GET /api/recipes/import-status/:jobId
router.get('/recipes/import-status/:jobId', validateUUID('jobId'), async (req, res) => {
  try {
    const { jobId } = req.params;

    const { data, error } = await supabase
      .from('job_status')
      .select('status, total, processed, results')
      .eq('id', jobId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Job non trouve' });
    }

    const total = Number(data.total || 0);
    const processed = Number(data.processed || 0);
    const progressPercent = total > 0 ? Math.round((processed / total) * 100) : 0;

    return res.json({
      status: data.status,
      total,
      processed,
      progressPercent,
      results: data.results || {},
    });
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/recipes/import-status/:jobId', jobId: req.params.jobId });
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
      .select()
      .single();
    if (error) throw error;
    if (!data) {
      throw new APIError('Recette non trouvée avec cet ID', 404, 'RECIPE_NOT_FOUND');
    }
    res.json(data);
  } catch (error) {
    handleError(error, res, { endpoint: 'PUT /api/recipes/:id', recipeId: req.params.id });
  }
});

// DELETE /api/recipes/:id
router.delete('/recipes/:id', validateUUID('id'), async (req, res) => {
  try {
    // In a real app, you might want to set ON DELETE SET NULL or CASCADE in the DB
    await supabase.from('meal_plan').delete().eq('recipe_id', req.params.id);
    
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
