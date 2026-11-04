const { Router } = require('express');
const supabase = require('../services/supabase');
const { normalizeFoodName } = require('../services/foodName');
const { handleError } = require('../services/errorHandler');
const { isMissingTableError } = require('../services/schemaFallback');
const router = Router();

const MAX_RESULTS = 20;
// On lit plus large puis on classe : nom qui commence par la recherche, puis nom court
const CANDIDATES = 200;

// GET /api/foods?search=… : aliments pour l'écran de correction des ingrédients
router.get('/foods', async (req, res) => {
  try {
    const search = normalizeFoodName(typeof req.query.search === 'string' ? req.query.search : '');
    if (search.length < 2) return res.json([]);

    let query = supabase
      .from('foods')
      .select('id,ciqual_code,name,name_search,group_name,subgroup_name,energy_kcal,proteins_g,carbs_g,fat_g');
    for (const word of search.split(' ').slice(0, 6)) {
      query = query.ilike('name_search', `%${word}%`);
    }
    const { data, error } = await query.order('name', { ascending: true }).limit(CANDIDATES);
    // Table pas encore créée (nutrition.sql non exécuté) : aucun aliment
    if (error && isMissingTableError(error)) return res.json([]);
    if (error) throw error;

    const ranked = (data || [])
      .map((food) => ({ food, rank: food.name_search.startsWith(search) ? 0 : (food.name_search.includes(` ${search}`) ? 1 : 2) }))
      .sort((a, b) => a.rank - b.rank || a.food.name.length - b.food.name.length)
      .slice(0, MAX_RESULTS);

    res.json(ranked.map(({ food }) => ({
      id: food.id,
      ciqualCode: food.ciqual_code ?? null,
      name: food.name,
      groupName: food.group_name ?? null,
      subgroupName: food.subgroup_name ?? null,
      per100g: {
        kcal: food.energy_kcal ?? null,
        proteins_g: food.proteins_g ?? null,
        carbs_g: food.carbs_g ?? null,
        fat_g: food.fat_g ?? null,
      },
    })));
  } catch (error) {
    handleError(error, res, { endpoint: 'GET /api/foods', search: req.query.search });
  }
});

module.exports = router;
