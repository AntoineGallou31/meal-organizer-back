const { Router } = require('express');
const supabase = require('../services/supabase');
const { APIError, handleError } = require('../services/errorHandler');
const router = Router();

const SLOT_VALUES = ['lunch', 'dinner'];
const ITEM_TYPES = ['recipe', 'note'];

const getWeekDays = (weekString) => {
    const [year, weekNum] = weekString.split('-W').map(Number);
    const d = new Date(Date.UTC(year, 0, 1 + (weekNum - 1) * 7));
    const day = d.getUTCDay() || 7; // Get day of week (1-7), Sunday is 7
    if (day !== 1) {
        d.setUTCDate(d.getUTCDate() - day + 1);
    }
    const days = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date(d);
        date.setUTCDate(d.getUTCDate() + i);
        days.push(date.toISOString().split('T')[0]);
    }
    return days;
};

const getDayName = (date, locale = 'fr-FR') => {
    return new Date(date).toLocaleDateString(locale, { weekday: 'long' });
}

const isMissingColumnError = (error) => {
    const message = (error?.message ?? '').toLowerCase();
    return message.includes('column') && (
        message.includes('does not exist') ||
        message.includes('not found') ||
        message.includes('schema cache')
    );
};

const MEAL_PLAN_ITEM_SELECT_CANDIDATES = [
    'id,date,slot,position,type,recipe_id,note,created_at,recipes(id,title,image_url,prep_time,source_url,incoherent_import,restricted_detail,import_validation,recipe_categories(category_id,categories(id,name,color)))',
    'id,date,slot,position,type,recipe_id,note,created_at,recipes(id,title,image_url,prep_time,source_url,recipe_categories(category_id,categories(id,name,color)))',
    'id,date,slot,position,type,recipe_id,note,created_at,recipes(id,title,image_url,prep_time,source_url)',
];

const toMealPlanItemResponse = (row) => ({
    id: row.id,
    date: row.date,
    slot: row.slot,
    position: Number.isInteger(row.position) ? row.position : null,
    type: row.type,
    recipeId: row.recipe_id ?? null,
    note: row.note ?? null,
    recipe: row.recipes ?? null,
    createdAt: row.created_at ?? null,
});

const sortItems = (items) => {
    return [...items].sort((a, b) => {
        const positionA = Number.isInteger(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
        const positionB = Number.isInteger(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
        if (positionA !== positionB) {
            return positionA - positionB;
        }

        const createdA = a.createdAt ? Date.parse(a.createdAt) : 0;
        const createdB = b.createdAt ? Date.parse(b.createdAt) : 0;
        return createdA - createdB;
    });
};

const fetchMealPlanItemsWithSchemaFallback = async (weekDays) => {
    for (let i = 0; i < MEAL_PLAN_ITEM_SELECT_CANDIDATES.length; i += 1) {
        const selectClause = MEAL_PLAN_ITEM_SELECT_CANDIDATES[i];
        const { data, error } = await supabase
            .from('meal_plan_items')
            .select(selectClause)
            .in('date', weekDays);

        if (!error) {
            return data || [];
        }

        const canRetry = i < MEAL_PLAN_ITEM_SELECT_CANDIDATES.length - 1;
        if (!isMissingColumnError(error) || !canRetry) {
            throw error;
        }
    }

    return [];
};

// GET /api/meal-plan?week=YYYY-Www
router.get('/meal-plan', async (req, res) => {
    try {
        let week = req.query.week;
        if (!week) {
            const today = new Date();
            const year = today.getFullYear();
            const firstDayOfYear = new Date(year, 0, 1);
            const pastDaysOfYear = (today - firstDayOfYear) / 86400000;
            const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
            week = `${year}-W${String(weekNum).padStart(2, '0')}`;
        }

        const weekDays = getWeekDays(week);
        const mealPlanItems = (await fetchMealPlanItemsWithSchemaFallback(weekDays))
            .map(toMealPlanItemResponse);

        const weekSchedule = weekDays.map(date => {
            const dayItems = mealPlanItems.filter((item) => item.date === date);
            const lunchItems = sortItems(dayItems.filter((item) => item.slot === 'lunch'));
            const dinnerItems = sortItems(dayItems.filter((item) => item.slot === 'dinner'));

            return {
                date,
                dayName: getDayName(date),
                lunchItems,
                dinnerItems,
            };
        });

        res.json(weekSchedule);
    } catch (error) {
        handleError(error, res, { endpoint: 'GET /api/meal-plan', week: req.query.week });
    }
});

// POST /api/meal-plan/items
router.post('/meal-plan/items', async (req, res) => {
    try {
        const { date, slot, type, recipeId, note, position } = req.body;

        if (!date || !slot || !type) {
            return res.status(400).json({ error: 'date, slot et type sont requis' });
        }

        if (!SLOT_VALUES.includes(slot)) {
            return res.status(400).json({ error: 'slot doit être "lunch" ou "dinner"' });
        }

        if (!ITEM_TYPES.includes(type)) {
            return res.status(400).json({ error: 'type doit être "recipe" ou "note"' });
        }

        const normalizedPosition = position === undefined || position === null || String(position).trim() === ''
            ? null
            : Number(position);
        if (normalizedPosition !== null && (!Number.isInteger(normalizedPosition) || normalizedPosition < 0)) {
            return res.status(400).json({ error: 'position doit être un entier >= 0' });
        }

        let payload;

        if (type === 'recipe') {
            const hasRecipeId = recipeId !== undefined && recipeId !== null && String(recipeId).trim() !== '';
            if (!hasRecipeId) {
                return res.status(400).json({ error: 'recipeId est requis pour le type "recipe"' });
            }

            payload = {
                date,
                slot,
                type,
                position: normalizedPosition,
                recipe_id: recipeId,
                note: null,
            };
        } else {
            const normalizedNote = typeof note === 'string' ? note.trim() : '';
            if (!normalizedNote) {
                return res.status(400).json({ error: 'note est requis pour le type "note"' });
            }

            payload = {
                date,
                slot,
                type,
                position: normalizedPosition,
                recipe_id: null,
                note: normalizedNote,
            };
        }

        const { data, error } = await supabase
            .from('meal_plan_items')
            .insert(payload)
            .select('id,date,slot,position,type,recipe_id,note,created_at,recipes(id,title,image_url,prep_time,source_url,recipe_categories(category_id,categories(id,name,color)))')
            .single();

        if (error) {
            throw error;
        }

        return res.status(201).json(toMealPlanItemResponse(data));
    } catch (error) {
        handleError(error, res, {
            endpoint: 'POST /api/meal-plan/items',
            date: req.body?.date,
            slot: req.body?.slot,
            type: req.body?.type,
        });
    }
});

// DELETE /api/meal-plan/items/:id
router.delete('/meal-plan/items/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { data, error } = await supabase
            .from('meal_plan_items')
            .delete()
            .eq('id', id)
            .select('id')
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            throw new APIError('Item de planning introuvable', 404, 'MEAL_PLAN_ITEM_NOT_FOUND');
        }

        res.status(204).send();
    } catch (error) {
        handleError(error, res, {
            endpoint: 'DELETE /api/meal-plan/items/:id',
            itemId: req.params.id,
        });
    }
});

// PUT /api/meal-plan/items/:id
router.put('/meal-plan/items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { note, recipeId, position, type } = req.body;

        if (!id) {
            return res.status(400).json({ error: 'id est requis' });
        }

        const updates = {};

        if (type !== undefined) {
            if (!ITEM_TYPES.includes(type)) {
                return res.status(400).json({ error: 'type invalide' });
            }
            updates.type = type;
        }

        if (position !== undefined) {
            const normalizedPosition = position === null || position === '' ? null : Number(position);
            if (normalizedPosition !== null && (!Number.isInteger(normalizedPosition) || normalizedPosition < 0)) {
                return res.status(400).json({ error: 'position doit être un entier >= 0' });
            }
            updates.position = normalizedPosition;
        }

        if (recipeId !== undefined) {
            updates.recipe_id = recipeId === null ? null : recipeId;
        }

        if (note !== undefined) {
            updates.note = note === null ? null : String(note).trim();
        }

        const { data, error } = await supabase
            .from('meal_plan_items')
            .update(updates)
            .eq('id', id)
            .select('id,date,slot,position,type,recipe_id,note,created_at,recipes(id,title,image_url,prep_time,source_url,recipe_categories(category_id,categories(id,name,color)))')
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            throw new APIError('Item de planning introuvable', 404, 'MEAL_PLAN_ITEM_NOT_FOUND');
        }

        return res.json(toMealPlanItemResponse(data));
    } catch (error) {
        handleError(error, res, {
            endpoint: 'PUT /api/meal-plan/items/:id',
            itemId: req.params.id,
        });
    }
});

// DELETE /api/meal-plan/:date/:slot
router.delete('/meal-plan/:date/:slot', async (req, res) => {
    try {
        const { date, slot } = req.params;

        if (!SLOT_VALUES.includes(slot)) {
            return res.status(400).json({ error: 'slot doit être "lunch" ou "dinner"' });
        }

        const { error } = await supabase
            .from('meal_plan_items')
            .delete()
            .match({ date, slot });

        if (error) throw error;

        res.status(204).send();
    } catch (error) {
        handleError(error, res, { endpoint: 'DELETE /api/meal-plan/:date/:slot', date: req.params.date, slot: req.params.slot });
    }
});


module.exports = router;
