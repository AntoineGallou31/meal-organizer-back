require('dotenv').config();
const express = require('express');
const cors = require('cors');
const validateUUID = require('./middlewares/validateUUID');

const app = express();

app.locals.validateUUID = validateUUID;

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://meal-organizer-front.vercel.app'
  ]
}));
app.use(express.json());

app.use('/api', require('./routes/categories'));
app.use('/api', require('./routes/recipes'));
app.use('/api', require('./routes/mealPlan'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
