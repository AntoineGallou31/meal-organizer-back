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
  const rawConfidence = recipeData.confidence;
  const parsedConfidence = rawConfidence == null || rawConfidence === ''
    ? null
    : Number(rawConfidence);

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
    confidence: Number.isFinite(parsedConfidence) ? parsedConfidence : null,
  };
}

function pickPrimaryCategory(categories = []) {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  return categories.find((category) => category && !category.is_default) || categories[0] || null;
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

function evaluateRecipeCoherence({ title, ingredients, steps }) {
  const cleanIngredients = (Array.isArray(ingredients) ? ingredients : [])
    .map(cleanLine)
    .filter(Boolean);
  const cleanSteps = (Array.isArray(steps) ? steps : [])
    .map(cleanLine)
    .filter(Boolean);

  const ingredientChars = cleanIngredients.reduce((sum, item) => sum + item.length, 0);
  const stepChars = cleanSteps.reduce((sum, item) => sum + item.length, 0);
  const averageStepLength = cleanSteps.length ? stepChars / cleanSteps.length : 0;
  const quantitySignals = cleanIngredients.filter((line) => UNIT_OR_QUANTITY_REGEX.test(line)).length;
  const quantityRatio = cleanIngredients.length ? quantitySignals / cleanIngredients.length : 0;
  const normalizedStepsText = normalizeForComparison(cleanSteps.join(' '));
  const actionSignals = STEP_ACTION_KEYWORDS.some((keyword) => normalizedStepsText.includes(keyword));

  const normalizedLines = [...cleanIngredients, ...cleanSteps].map(normalizeForComparison).filter(Boolean);
  const uniqueLines = new Set(normalizedLines);
  const duplicateRatio = normalizedLines.length
    ? 1 - (uniqueLines.size / normalizedLines.length)
    : 0;

  const noiseHits = CONTENT_NOISE_KEYWORDS.filter((keyword) => {
    const normalizedKeyword = normalizeForComparison(keyword);
    return normalizedStepsText.includes(normalizedKeyword);
  }).length;

  const urlLikeLines = [...cleanIngredients, ...cleanSteps].filter((line) => /https?:\/\//i.test(line)).length;
  const urlRatio = normalizedLines.length ? urlLikeLines / normalizedLines.length : 0;

  let score = 0;
  const reasons = [];
  const criticalIssues = [];

  if (cleanIngredients.length >= 4) score += 20;
  else if (cleanIngredients.length >= 2) score += 10;
  else {
    reasons.push('Nombre d\'ingrédients insuffisant');
    criticalIssues.push('ingredients_count');
  }

  if (cleanSteps.length >= 3) score += 20;
  else if (cleanSteps.length >= 2) score += 10;
  else {
    reasons.push('Nombre d\'étapes insuffisant');
    criticalIssues.push('steps_count');
  }

  if (stepChars >= 120 && averageStepLength >= 18) score += 20;
  else if (stepChars >= 70 && averageStepLength >= 14) score += 10;
  else {
    reasons.push('Préparation trop courte ou peu exploitable');
    criticalIssues.push('steps_too_short');
  }

  if (ingredientChars >= 40) score += 10;
  else reasons.push('Bloc ingrédients trop court');

  if (quantityRatio >= 0.4) score += 10;
  else reasons.push('Peu d\'indices de quantités dans les ingrédients');

  if (actionSignals) score += 10;
  else {
    reasons.push('Aucun verbe d\'action culinaire détecté dans la préparation');
    criticalIssues.push('no_cooking_actions');
  }

  const titleCheck = titleLooksLikeRecipe(title);
  if (titleCheck.valid) score += 10;
  else reasons.push('Titre peu représentatif d\'une recette');

  if (noiseHits >= 2) {
    score -= 25;
    reasons.push('Contenu parasite détecté (cookies, réseaux sociaux, mentions légales, etc.)');
    criticalIssues.push('noise_content');
  }

  if (duplicateRatio > 0.45) {
    score -= 10;
    reasons.push('Contenu très répétitif');
  }

  if (urlRatio > 0.25) {
    score -= 15;
    reasons.push('Trop de lignes ressemblent à des URLs');
    criticalIssues.push('url_content');
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const isCoherent = boundedScore >= 55 && criticalIssues.length === 0;

  return {
    isCoherent,
    score: boundedScore,
    reasons,
    criticalIssues,
    metrics: {
      ingredientCount: cleanIngredients.length,
      stepCount: cleanSteps.length,
      ingredientChars,
      stepChars,
      averageStepLength,
      quantityRatio,
      noiseHits,
      duplicateRatio,
      urlRatio,
      titleLooksLikeRecipe: titleCheck.valid,
    },
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

function sanitizeScrapedLines(lines = [], { maxItems = 30, maxLength = 280 } = {}) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) => cleanLine(line))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((line) => (line.length > maxLength ? `${line.slice(0, maxLength)}...` : line));
}

function buildImportValidationReport({ url, recipeData, titleCheck, coherenceCheck, missingFields }) {
  const fieldErrors = [];
  const imageUrl = recipeData.imageUrl ? String(recipeData.imageUrl).trim() : '';

  if (missingFields.includes('title')) {
    fieldErrors.push({
      field: 'title',
      code: 'MISSING_TITLE',
      message: 'Titre manquant dans le contenu scrappé.',
    });
  } else if (!titleCheck.valid) {
    fieldErrors.push({
      field: 'title',
      code: 'WEAK_TITLE',
      message: 'Le titre extrait ne ressemble pas à un titre de recette.',
      matchedKeywords: titleCheck.matchedKeywords,
    });
  }

  if (missingFields.includes('image')) {
    fieldErrors.push({
      field: 'image',
      code: 'MISSING_IMAGE',
      message: 'Image introuvable dans la page source.',
    });
  } else if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    fieldErrors.push({
      field: 'image',
      code: 'INVALID_IMAGE_URL',
      message: 'L\'image extraite n\'est pas une URL HTTP/HTTPS valide.',
    });
  }

  if (missingFields.includes('ingredients')) {
    fieldErrors.push({
      field: 'ingredients',
      code: 'MISSING_INGREDIENTS',
      message: 'Aucun ingrédient exploitable trouvé.',
    });
  }

  if (missingFields.includes('steps')) {
    fieldErrors.push({
      field: 'steps',
      code: 'MISSING_STEPS',
      message: 'Aucune étape de préparation exploitable trouvée.',
    });
  }

  if (!coherenceCheck.isCoherent) {
    fieldErrors.push({
      field: 'content',
      code: 'INCOHERENT_CONTENT',
      message: 'Le contenu scrappé ne semble pas cohérent avec une recette de cuisine.',
      reasons: coherenceCheck.reasons,
      criticalIssues: coherenceCheck.criticalIssues,
      score: coherenceCheck.score,
    });
  }

  const hardBlockFields = new Set(['title', 'image']);
  const hardErrors = fieldErrors.filter((entry) => hardBlockFields.has(entry.field));
  const softErrors = fieldErrors.filter((entry) => !hardBlockFields.has(entry.field));
  const hasContentIssues = softErrors.some((entry) => entry.field === 'ingredients' || entry.field === 'steps' || entry.field === 'content');

  return {
    hasIssues: fieldErrors.length > 0,
    validationType: hardErrors.length > 0 ? 'hard' : (softErrors.length > 0 ? 'content' : null),
    hardErrors,
    softErrors,
    canImportNormally: fieldErrors.length === 0,
    canForceIncomplete: hardErrors.length > 0,
    canImportWithoutContent: hasContentIssues && hardErrors.length === 0,
    fieldErrors,
    scrapedContent: {
      sourceUrl: recipeData.sourceUrl || url,
      title: recipeData.title ? String(recipeData.title).trim() : null,
      imageUrl: recipeData.imageUrl ? String(recipeData.imageUrl).trim() : null,
      prepTime: recipeData.prepTime || null,
      servings: recipeData.servings || null,
      ingredientsCount: Array.isArray(recipeData.ingredients) ? recipeData.ingredients.length : 0,
      stepsCount: Array.isArray(recipeData.steps) ? recipeData.steps.length : 0,
      ingredients: sanitizeScrapedLines(recipeData.ingredients),
      steps: sanitizeScrapedLines(recipeData.steps),
      partial: Boolean(recipeData.partial),
      scrapingMeta: recipeData.scrapingMeta || null,
    },
    importValidation: coherenceCheck,
  };
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

async function persistImportedRecipe({
  url,
  recipeData,
  forceImportMode = null,
}) {
  const normalizedRecipeData = normalizeImportedRecipeData(recipeData);
  const missingFields = getMissingImportFields(normalizedRecipeData);
  const titleRaw = normalizedRecipeData.title ? String(normalizedRecipeData.title).trim() : '';
  const titleCheck = titleLooksLikeRecipe(titleRaw);
  const coherenceCheck = evaluateRecipeCoherence({
    title: titleRaw,
    ingredients: normalizedRecipeData.ingredients,
    steps: normalizedRecipeData.steps,
  });
  const validationReport = buildImportValidationReport({
    url,
    recipeData: normalizedRecipeData,
    titleCheck,
    coherenceCheck,
    missingFields,
  });
  const incoherentImport = !coherenceCheck.isCoherent;
  const hasValidationIssues = validationReport.fieldErrors.length > 0;
  const forceMode = forceImportMode === 'incomplete' || forceImportMode === 'contentless' || forceImportMode === 'normal' ? forceImportMode : null;
  const canProceedNormally = validationReport.hardErrors.length === 0;

  const preparedRecipeData = forceMode === 'contentless'
    ? {
      ...normalizedRecipeData,
      ingredients: [],
      steps: [],
    }
    : forceMode === 'normal' && hasValidationIssues
    ? {
      ...normalizedRecipeData,
      ingredients: sanitizeImportedIngredients(normalizedRecipeData.ingredients),
      steps: sanitizeImportedSteps(normalizedRecipeData.steps),
    }
    : normalizedRecipeData;

  if (hasValidationIssues && !forceMode) {
    return {
      needsImportReview: true,
      validationType: validationReport.validationType,
      canImportNormally: validationReport.canImportNormally,
      canForceIncomplete: validationReport.canForceIncomplete,
      canImportWithoutContent: validationReport.canImportWithoutContent,
      recipePreview: {
        title: titleRaw,
        imageUrl: normalizedRecipeData.imageUrl || null,
        sourceUrl: normalizedRecipeData.sourceUrl || url,
      },
      missingFields,
      titleCheck,
      fieldErrors: validationReport.fieldErrors,
      scrapedContent: validationReport.scrapedContent,
      importValidation: validationReport.importValidation,
    };
  }

  if (forceMode === 'normal' && !canProceedNormally) {
    return {
      needsImportReview: true,
      validationType: validationReport.validationType,
      canImportNormally: false,
      canForceIncomplete: validationReport.canForceIncomplete,
      canImportWithoutContent: validationReport.canImportWithoutContent,
      recipePreview: {
        title: titleRaw,
        imageUrl: normalizedRecipeData.imageUrl || null,
        sourceUrl: normalizedRecipeData.sourceUrl || url,
      },
      missingFields,
      titleCheck,
      fieldErrors: validationReport.fieldErrors,
      scrapedContent: validationReport.scrapedContent,
      importValidation: validationReport.importValidation,
    };
  }

  const insertPayload = {
    title: titleRaw || 'Recette importee',
    image_url: preparedRecipeData.imageUrl || null,
    prep_time: preparedRecipeData.prepTime || null,
    servings: preparedRecipeData.servings || null,
    ingredients: Array.isArray(preparedRecipeData.ingredients) ? preparedRecipeData.ingredients : [],
    steps: Array.isArray(preparedRecipeData.steps) ? preparedRecipeData.steps : [],
    source_url: preparedRecipeData.sourceUrl || url,
    months: Array.isArray(preparedRecipeData.months) ? preparedRecipeData.months : [],
    confidence: Number.isFinite(preparedRecipeData.confidence) ? preparedRecipeData.confidence : null,
  };

  const { data: existingRecipe, error: duplicateCheckError } = await supabase
    .from('recipes')
    .select('id,title,source_url')
    .eq('title', insertPayload.title)
    .eq('source_url', insertPayload.source_url)
    .maybeSingle();

  if (duplicateCheckError) throw duplicateCheckError;

  if (existingRecipe) {
    throw new APIError(
      'Une recette avec le meme nom et la meme URL existe deja',
      409,
      'DUPLICATE_IMPORTED_RECIPE',
      {
        existingRecipeId: existingRecipe.id,
        title: existingRecipe.title,
        sourceUrl: existingRecipe.source_url,
      }
    );
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

  if (forceMode === 'incomplete') {
    const toCompleteCategoryId = await getOrCreateCategory(ALERT_CATEGORY_COMPLETE.name, ALERT_CATEGORY_COMPLETE.color);
    assignedCategoryIds.add(toCompleteCategoryId);
    confident = false;
  } else if (Array.isArray(preparedRecipeData.categories) && preparedRecipeData.categories.length > 0) {
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
  const mappedRecipe = mapRecipeWithCategories(recipeWithCategories);
  const categories = (recipeWithCategories.recipe_categories || []).map((rc) => rc.categories).filter(Boolean);

  return {
    needsImportReview: false,
    recipe: {
      ...mappedRecipe,
      categories,
      missingFields,
      incomplete: forceMode === 'incomplete',
      importMode: forceMode === 'incomplete'
        ? 'incomplete'
        : forceMode === 'contentless'
          ? 'contentless'
          : 'normal',
      autoDetected,
      confident,
      incoherentImport: mappedRecipe.incoherent_import,
      restrictedDetail: mappedRecipe.restricted_detail,
      importValidation: mappedRecipe.import_validation,
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
  const instructions = Array.isArray(recipe.steps) ? recipe.steps : [];
  const months = Array.isArray(recipe.months)
    ? recipe.months
    : (Array.isArray(recipe.seasons) ? recipe.seasons : []);
  const confidence = Number.isFinite(Number(recipe.confidence)) ? Number(recipe.confidence) : null;
  const categories = (recipe.recipe_categories || [])
    .map((rc) => rc.categories)
    .filter(Boolean);
  const primaryCategory = pickPrimaryCategory(categories);

  const hasToCompleteCategory = categories.some((category) => {
    const name = normalizeTextForMatch(category?.name);
    return name === 'a completer';
  });

  const importValidation = evaluateRecipeCoherence({
    title: recipe.title,
    ingredients,
    steps: instructions,
  });
  const incoherentImport = !importValidation.isCoherent;
  const restrictedDetail = Boolean(recipe.source_url) && hasToCompleteCategory;

  return {
    id: recipe.id,
    title: recipe.title,
    image: recipe.image_url ?? null,
    imageUrl: recipe.image_url ?? null,
    category: primaryCategory?.name ?? null,
    categories,
    months,
    ingredients,
    instructions,
    steps: instructions,
    duration: recipe.prep_time ?? null,
    prepTime: recipe.prep_time ?? null,
    servings: recipe.servings,
    sourceUrl: recipe.source_url,
    source_url: recipe.source_url,
    createdAt: recipe.created_at,
    created_at: recipe.created_at,
    confidence,
    externalOnly: Boolean(recipe.source_url) && ingredients.length === 0 && instructions.length === 0,
    external_only: Boolean(recipe.source_url) && ingredients.length === 0 && instructions.length === 0,
    incoherentImport,
    incoherent_import: incoherentImport,
    restrictedDetail,
    restricted_detail: restrictedDetail,
    importValidation,
    import_validation: importValidation,
  };
}

function buildRecipeSelectString({ summary = false, categoryId = '' } = {}) {
  if (summary) {
    return `id,title,image_url,prep_time,created_at,recipe_categories${categoryId ? '!inner' : ''}(category_id)`;
  }

  return `id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,confidence,created_at,recipe_categories${categoryId ? '!inner' : ''}(category_id,categories(id,name,color))`;
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
    .select('id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,confidence,created_at,recipe_categories(categories(id,name,color))')
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
  const rawSteps = Array.isArray(body.steps)
    ? body.steps
    : (Array.isArray(body.instructions) ? body.instructions : undefined);
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  const monthsInput = Array.isArray(body.months)
    ? body.months
    : (Array.isArray(body.seasons) ? body.seasons : undefined);
  const months = Array.isArray(monthsInput)
    ? [...new Set(monthsInput.map((m) => String(m).trim()).filter(Boolean))]
    : undefined;
  const prepTimeInput = body.prepTime ?? body.prep_time ?? body.duration;
  const prepTimeParsed = prepTimeInput === undefined ? undefined : Number(prepTimeInput);
  const prepTimeValue = prepTimeParsed === undefined
    ? undefined
    : (prepTimeInput === null ? null : (Number.isFinite(prepTimeParsed) ? prepTimeParsed : undefined));
  const confidenceInput = body.confidence;
  const confidenceParsed = confidenceInput === undefined ? undefined : Number(confidenceInput);
  const confidence = confidenceInput === undefined
    ? undefined
    : (confidenceInput === null ? null : (Number.isFinite(confidenceParsed) ? confidenceParsed : undefined));
  const imageValue = body.image ?? body.imageUrl ?? body.image_url ?? undefined;

  const payload = {
    title,
    image_url: imageValue,
    prep_time: prepTimeValue,
    servings: body.servings ?? undefined,
    ingredients,
    steps,
    source_url: body.sourceUrl ?? body.source_url ?? undefined,
    months,
    confidence,
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

    if (sort === 'oldest') {
      query = query.order('created_at', { ascending: true });
    } else if (sort === 'prepTime') {
      query = query.order('prep_time', { ascending: true });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    if (paged) {
      const offset = (page - 1) * limit;
      query = query.range(offset, offset + limit);
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
    const visibleRecipes = hiddenIncompleteRecipeIds.length
      ? (data || []).filter((recipe) => !hiddenIncompleteRecipeIds.includes(recipe.id))
      : (data || []);

    if (paged) {
      return res.json({
        items: visibleRecipes.slice(0, limit),
        page,
        limit,
        hasMore: visibleRecipes.length > limit,
      });
    }

    res.json(visibleRecipes.map(mapRecipeWithCategories));
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
        .select('id,title,image_url,prep_time,servings,ingredients,steps,source_url,months,confidence,created_at,recipe_categories!inner(category_id,categories(id,name,color))')
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
  const { url, forceImportMode } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required', field: 'url' });
    }

    try {
        const recipeData = await scrapeRecipeWithRetries(url);
        const persisted = await persistImportedRecipe({
          url,
          recipeData,
          forceImportMode: typeof forceImportMode === 'string' ? forceImportMode : null,
        });

        if (persisted.needsImportReview) {
          const hasHardBlockingError = persisted.fieldErrors.some((entry) => entry.field === 'title' || entry.field === 'image');
          return res.status(422).json({
            error: hasHardBlockingError
              ? 'Import annulé automatiquement: titre ou image invalide.'
              : 'Le contenu importé est incomplet ou incohérent.',
            code: 'IMPORT_VALIDATION_FAILED',
            validationType: persisted.validationType,
            canImportNormally: Boolean(persisted.canImportNormally),
            canForceIncomplete: Boolean(persisted.canForceIncomplete),
            canImportWithoutContent: Boolean(persisted.canImportWithoutContent),
            missingFields: persisted.missingFields,
            titleKeywordsMatched: persisted.titleCheck.matchedKeywords,
            recipePreview: persisted.recipePreview,
            fieldErrors: persisted.fieldErrors,
            scrapedContent: persisted.scrapedContent,
            importValidation: persisted.importValidation,
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

        if (err.partial) {
            return res.status(422).json({ error: err.message, url });
        }
        console.error(err);
        res.status(500).json({
          error: 'Failed to import recipe',
          code: err.code || 'IMPORT_FAILED',
          url,
          details: {
            message: err.message || 'Erreur inconnue pendant l\'import',
            ...(err.details ? { importDetails: err.details } : {}),
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
