const { Router } = require('express');
const supabase = require('../services/supabase');
const { APIError, handleError } = require('../services/errorHandler');
const router = Router();

const MANUAL_TEXT_COLUMNS = ['manual_text', 'manual_note', 'custom_text', 'text'];

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

const extractManualText = (mealPlanRow) => {
    if (!mealPlanRow) {
        return null;
    }

    const value = MANUAL_TEXT_COLUMNS
        .map((column) => mealPlanRow[column])
        .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);

    return value ?? null;
};

const isMissingColumnError = (error) => {
    const message = (error?.message ?? '').toLowerCase();
    return message.includes('column') && (
        message.includes('does not exist') ||
        message.includes('not found') ||
        message.includes('schema cache')
    );
};

const MEAL_PLAN_RECIPE_SELECT_CANDIDATES = [
    '*, recipes(id,title,image_url,prep_time,source_url,incoherent_import,restricted_detail,import_validation,recipe_categories(category_id,categories(id,name,color)))',
    '*, recipes(id,title,image_url,prep_time,source_url,recipe_categories(category_id,categories(id,name,color)))',
    '*, recipes(id,title,image_url,prep_time,source_url)',
];

const fetchMealPlansWithSchemaFallback = async (weekDays) => {
    for (let i = 0; i < MEAL_PLAN_RECIPE_SELECT_CANDIDATES.length; i += 1) {
        const selectClause = MEAL_PLAN_RECIPE_SELECT_CANDIDATES[i];
        const { data, error } = await supabase
            .from('meal_plan')
            .select(selectClause)
            .in('date', weekDays);

        if (!error) {
            return data || [];
        }

        const canRetry = i < MEAL_PLAN_RECIPE_SELECT_CANDIDATES.length - 1;
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
        const mealPlans = await fetchMealPlansWithSchemaFallback(weekDays);

        const weekSchedule = weekDays.map(date => {
            const lunch = mealPlans.find(p => p.date === date && p.slot === 'lunch');
            const dinner = mealPlans.find(p => p.date === date && p.slot === 'dinner');
            return {
                date,
                dayName: getDayName(date),
                lunch: lunch ? lunch.recipes : null,
                lunchManualText: extractManualText(lunch),
                dinner: dinner ? dinner.recipes : null,
                dinnerManualText: extractManualText(dinner),
            };
        });

        res.json(weekSchedule);
    } catch (error) {
        handleError(error, res, { endpoint: 'GET /api/meal-plan', week: req.query.week });
    }
});

// POST /api/meal-plan
router.post('/meal-plan', async (req, res) => {
    try {
        const { date, slot, recipeId, manualText } = req.body;
        const hasRecipeId = recipeId !== undefined && recipeId !== null && String(recipeId).trim() !== '';
        const normalizedManualText = typeof manualText === 'string' ? manualText.trim() : '';
        const hasManualText = normalizedManualText.length > 0;

        if (!date || !slot) {
            return res.status(400).json({ error: 'date et slot sont requis' });
        }
        if ((hasRecipeId && hasManualText) || (!hasRecipeId && !hasManualText)) {
            return res.status(400).json({ error: 'Fournir soit recipeId, soit manualText' });
        }
        if (slot !== 'lunch' && slot !== 'dinner') {
            return res.status(400).json({ error: 'slot doit être "lunch" ou "dinner"' });
        }

        const basePayload = { date, slot };

        if (hasRecipeId) {
            const recipePayload = { ...basePayload, recipe_id: recipeId };
            const candidateColumns = [...MANUAL_TEXT_COLUMNS, null];

            for (const column of candidateColumns) {
                const payload = column
                    ? { ...recipePayload, [column]: null }
                    : recipePayload;
                const { data, error } = await supabase
                    .from('meal_plan')
                    .upsert(payload, { onConflict: 'date, slot' })
                    .select('*, recipes(*)')
                    .single();

                if (!error) {
                    return res.status(201).json(data);
                }

                if (!isMissingColumnError(error) || !column) {
                    throw error;
                }
            }
        }

        for (const column of MANUAL_TEXT_COLUMNS) {
            const payload = { ...basePayload, recipe_id: null, [column]: normalizedManualText };
            const { data, error } = await supabase
                .from('meal_plan')
                .upsert(payload, { onConflict: 'date, slot' })
                .select('*, recipes(*)')
                .single();

            if (!error) {
                return res.status(201).json(data);
            }

            if (!isMissingColumnError(error)) {
                throw error;
            }
        }

        return res.status(500).json({
            error: 'Aucune colonne texte compatible trouvée dans meal_plan (manual_text/manual_note/custom_text/text)',
        });
    } catch (error) {
        handleError(error, res, { endpoint: 'POST /api/meal-plan', date: req.body?.date, slot: req.body?.slot });
    }
});

// DELETE /api/meal-plan/:date/:slot
router.delete('/meal-plan/:date/:slot', async (req, res) => {
    try {
        const { date, slot } = req.params;
        const { data, error } = await supabase
            .from('meal_plan')
            .delete()
            .match({ date, slot });

        if (error) throw error;
        
        // Supabase delete returns an empty data array if nothing was deleted.
        // There is no simple way to check for 404 without another query.
        // So we'll just return 204.

        res.status(204).send();
    } catch (error) {
        handleError(error, res, { endpoint: 'DELETE /api/meal-plan/:date/:slot', date: req.params.date, slot: req.params.slot });
    }
});


module.exports = router;
