const { Router } = require('express');
const supabase = require('../services/supabase');
const { scrapeRecipe } = require('../services/scraper');
const router = Router();

// GET /api/recipes
router.get('/', async (req, res) => {
  try {
    let query = supabase.from('recipes').select('id, title, image_url, prep_time, servings, source_url, created_at');
    if (req.query.search) {
      query = query.ilike('title', `%${req.query.search}%`);
    }
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

// GET /api/recipes/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('recipes').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Recette non trouvée' });
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

// POST /api/recipes
router.post('/', async (req, res) => {
  try {
    const { title, imageUrl, prepTime, servings, ingredients, steps, sourceUrl } = req.body;
    if (!title) return res.status(400).json({ error: 'Le titre est requis', field: 'title' });
    if (!ingredients || ingredients.length === 0) return res.status(400).json({ error: 'Les ingrédients sont requis', field: 'ingredients' });
    if (!steps || steps.length === 0) return res.status(400).json({ error: 'Les étapes sont requises', field: 'steps' });

    const { data, error } = await supabase.from('recipes').insert([{
      title,
      image_url: imageUrl,
      prep_time: prepTime,
      servings,
      ingredients,
      steps,
      source_url: sourceUrl,
    }]).select().single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

// POST /api/recipes/import
router.post('/import', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required', field: 'url' });
    }

    try {
        const recipeData = await scrapeRecipe(url);
        const { data, error } = await supabase.from('recipes').insert([{
            title: recipeData.title,
            image_url: recipeData.imageUrl,
            prep_time: recipeData.prepTime,
            servings: recipeData.servings,
            ingredients: recipeData.ingredients,
            steps: recipeData.steps,
            source_url: recipeData.sourceUrl,
        }]).select().single();

        if (error) throw error;

        if (recipeData.partial) {
            res.set('X-Partial', 'true');
            return res.status(201).json({ ...data, partial: true });
        }

        res.status(201).json(data);
    } catch (err) {
        if (err.partial) {
            return res.status(422).json({ error: err.message, url });
        }
        console.error(err);
        res.status(500).json({ error: "Failed to import recipe", url });
    }
});


// PUT /api/recipes/:id
router.put('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('recipes').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Recette non trouvée' });
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

// DELETE /api/recipes/:id
router.delete('/:id', async (req, res) => {
  try {
    // In a real app, you might want to set ON DELETE SET NULL or CASCADE in the DB
    await supabase.from('meal_plan').delete().eq('recipe_id', req.params.id);
    
    const { data, error } = await supabase.from('recipes').delete().eq('id', req.params.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Recette non trouvée' });
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

module.exports = router;
