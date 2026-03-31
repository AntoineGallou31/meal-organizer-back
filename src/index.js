require('dotenv').config();
const express = require('express');
const cors = require('cors');
const recipesRouter = require('./routes/recipes');
const mealPlanRouter = require('./routes/mealPlan');

const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://meal-organizer-front.vercel.app'
  ]
}));
app.use(express.json());

app.use('/api/recipes', recipesRouter);
app.use('/api/meal-plan', mealPlanRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
