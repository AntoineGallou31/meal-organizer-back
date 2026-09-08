require('dotenv').config();
const express = require('express');
const cors = require('cors');
const validateUUID = require('../src/middlewares/validateUUID');

const app = express();

app.locals.validateUUID = validateUUID;

function logKeepAlive(path) {
  const now = new Date().toISOString();
  console.log(`[${now}] Keep-alive hit: ${path}`);
}

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://meal-organizer-front.vercel.app'
  ]
}));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  logKeepAlive('/health');
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/ping', (_req, res) => {
  logKeepAlive('/ping');
  res.send('pong');
});

app.use('/api', require('../src/routes/categories'));
app.use('/api', require('../src/routes/recipes'));
app.use('/api', require('../src/routes/mealPlan'));

module.exports = app;
