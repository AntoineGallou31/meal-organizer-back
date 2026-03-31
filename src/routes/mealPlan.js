const { Router } = require('express');
const supabase = require('../services/supabase');
const router = Router();

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

// GET /api/meal-plan?week=YYYY-Www
router.get('/', async (req, res) => {
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
        const { data: mealPlans, error } = await supabase
            .from('meal_plan')
            .select('*, recipes(id, title, image_url, prep_time)')
            .in('date', weekDays);

        if (error) throw error;

        const weekSchedule = weekDays.map(date => {
            const lunch = mealPlans.find(p => p.date === date && p.slot === 'lunch');
            const dinner = mealPlans.find(p => p.date === date && p.slot === 'dinner');
            return {
                date,
                dayName: getDayName(date),
                lunch: lunch ? lunch.recipes : null,
                dinner: dinner ? dinner.recipes : null,
            };
        });

        res.json(weekSchedule);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erreur base de données' });
    }
});

// POST /api/meal-plan
router.post('/', async (req, res) => {
    try {
        const { date, slot, recipeId } = req.body;
        if (!date || !slot || !recipeId) {
            return res.status(400).json({ error: 'date, slot et recipeId sont requis' });
        }
        if (slot !== 'lunch' && slot !== 'dinner') {
            return res.status(400).json({ error: 'slot doit être "lunch" ou "dinner"' });
        }

        const { data, error } = await supabase
            .from('meal_plan')
            .upsert({ date, slot, recipe_id: recipeId }, { onConflict: 'date, slot' })
            .select('*, recipes(*)')
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erreur base de données' });
    }
});

// DELETE /api/meal-plan/:date/:slot
router.delete('/:date/:slot', async (req, res) => {
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
        console.error(error);
        res.status(500).json({ error: 'Erreur base de données' });
    }
});


module.exports = router;
