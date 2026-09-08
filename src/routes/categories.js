const { Router } = require('express');
const supabase = require('../services/supabase');
const { replaceCategoriesForRecipe } = require('../services/categorizer');
const { mapRecipeWithCategories } = require('../services/recipeMapper');
const validateUUID = require('../middlewares/validateUUID');
const { APIError, handleError } = require('../services/errorHandler');

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return [...new Set(
    keywords
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean)
  )];
}

// GET /api/categories
router.get('/categories', async (req, res) => {
  try {
    const withCount = req.query.withCount !== 'false';

    const { data: categories, error } = await supabase
      .from('categories')
      .select('id, name, color, keywords, is_default, created_at')
      .order('name', { ascending: true });

    if (error) throw error;

    if (!withCount) {
      return res.json(categories);
    }

    const { data: links, error: linksError } = await supabase
      .from('recipe_categories')
      .select('category_id');

    if (linksError) throw linksError;

    const countByCategoryId = (links || []).reduce((acc, row) => {
      acc[row.category_id] = (acc[row.category_id] || 0) + 1;
      return acc;
    }, {});

    return res.json(
      (categories || []).map((category) => ({
        ...category,
        recipe_count: countByCategoryId[category.id] || 0,
      }))
    );
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/categories' });
  }
});

// POST /api/categories
router.post('/categories', async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const color = req.body.color || '#888888';
    const keywords = req.body.keywords;

    if (!name) {
      return res.status(400).json({ error: 'Le nom est requis' });
    }
    if (name.length > 50) {
      return res.status(400).json({ error: 'Le nom ne peut pas depasser 50 caracteres' });
    }
    if (keywords !== undefined && !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'keywords doit etre un tableau de chaines' });
    }
    if (Array.isArray(keywords) && !keywords.every((k) => typeof k === 'string')) {
      return res.status(400).json({ error: 'keywords doit etre un tableau de chaines' });
    }

    const { data: existing, error: findError } = await supabase
      .from('categories')
      .select('id')
      .ilike('name', name)
      .maybeSingle();

    if (findError) throw findError;
    if (existing) {
      return res.status(409).json({ error: 'Une categorie avec ce nom existe deja' });
    }

    const { data, error } = await supabase
      .from('categories')
      .insert([{
        name,
        color,
        keywords: normalizeKeywords(keywords),
      }])
      .select('id, name, color, keywords, is_default, created_at')
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (error) {
    handleError(error, res, { endpoint: 'POST /api/categories' });
  }
});

// PUT /api/categories/:id
router.put('/categories/:id', validateUUID('id'), async (req, res) => {
  try {
    const categoryId = req.params.id;

    const updates = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
        return res.status(400).json({ error: 'Le nom est invalide' });
      }
      if (req.body.name.trim().length > 50) {
        return res.status(400).json({ error: 'Le nom ne peut pas depasser 50 caracteres' });
      }
      updates.name = req.body.name.trim();

      const { data: duplicate, error: duplicateError } = await supabase
        .from('categories')
        .select('id')
        .ilike('name', updates.name)
        .neq('id', categoryId)
        .maybeSingle();

      if (duplicateError) throw duplicateError;
      if (duplicate) {
        return res.status(409).json({ error: 'Une categorie avec ce nom existe deja' });
      }
    }

    if (req.body.color !== undefined) {
      updates.color = req.body.color;
    }

    if (req.body.keywords !== undefined) {
      if (!Array.isArray(req.body.keywords) || !req.body.keywords.every((k) => typeof k === 'string')) {
        return res.status(400).json({ error: 'keywords doit etre un tableau de chaines' });
      }
      updates.keywords = normalizeKeywords(req.body.keywords);
    }

    if (req.body.is_default !== undefined) {
      updates.is_default = Boolean(req.body.is_default);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Aucun champ a mettre a jour' });
    }

    if (updates.is_default === true) {
      const { error: unsetError } = await supabase
        .from('categories')
        .update({ is_default: false })
        .neq('id', categoryId);
      if (unsetError) throw unsetError;
    }

    const { data, error } = await supabase
      .from('categories')
      .update(updates)
      .eq('id', categoryId)
      .select('id, name, color, keywords, is_default, created_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Categorie non trouvee' });
    }

    return res.json(data);
  } catch (error) {
    handleError(error, res, { endpoint: 'PUT /api/categories/:id', categoryId: req.params.id });
  }
});

// DELETE /api/categories/:id
router.delete('/categories/:id', validateUUID('id'), async (req, res) => {
  try {
    const categoryId = req.params.id;

    const { data: existing, error: existingError } = await supabase
      .from('categories')
      .select('id, is_default')
      .eq('id', categoryId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (!existing) {
      return res.status(404).json({ error: 'Categorie non trouvee' });
    }
    if (existing.is_default) {
      return res.status(400).json({ error: 'La categorie par defaut ne peut pas etre supprimee' });
    }

    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', categoryId);

    if (error) throw error;
    return res.status(204).send();
  } catch (error) {
    handleError(error, res, { endpoint: 'DELETE /api/categories/:id', categoryId: req.params.id });
  }
});

// POST /api/recipes/:id/categories
router.post('/recipes/:id/categories', validateUUID('id'), async (req, res) => {
  try {
    const recipeId = req.params.id;
    const { categoryIds } = req.body || {};

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return res.status(400).json({ error: 'categoryIds doit etre un tableau non vide' });
    }
    if (!categoryIds.every((id) => typeof id === 'string' && UUID_REGEX.test(id))) {
      return res.status(400).json({ error: 'Tous les categoryIds doivent etre des UUID valides' });
    }

    const { data: recipeExists, error: recipeError } = await supabase
      .from('recipes')
      .select('id')
      .eq('id', recipeId)
      .maybeSingle();

    if (recipeError) throw recipeError;
    if (!recipeExists) {
      return res.status(404).json({ error: 'Recette non trouvee' });
    }

    await replaceCategoriesForRecipe(recipeId, categoryIds);

    const { data: assigned, error: assignedError } = await supabase
      .from('categories')
      .select('id, name, color')
      .in('id', [...new Set(categoryIds)])
      .order('name', { ascending: true });

    if (assignedError) throw assignedError;
    return res.json(assigned || []);
  } catch (error) {
    handleError(error, res, { endpoint: 'POST /api/recipes/:id/categories', recipeId: req.params.id });
  }
});

// GET /api/categories/:id/recipes
router.get('/categories/:id/recipes', validateUUID('id'), async (req, res) => {
  try {
    const categoryId = req.params.id;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    let query = supabase
      .from('recipes')
      .select(`
        id,
        title,
        image_url,
        prep_time,
        servings,
        ingredients,
        steps,
        source_url,
        months,
        created_at,
        recipe_categories!inner (
          categories ( id, name, color )
        )
      `)
      .eq('recipe_categories.category_id', categoryId);

    if (search) {
      query = query.ilike('title', `%${search}%`);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    return res.json((data || []).map(mapRecipeWithCategories));
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/categories/:id/recipes', categoryId: req.params.id });
  }
});

module.exports = router;
