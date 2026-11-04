// Cree les categories de reference (data/categories.js) absentes de la base, avec
// leurs couleurs et leurs mots-cles, puis fait de « Sans catégorie » la seule
// categorie par defaut. Une categorie deja presente (meme nom, sans tenir compte
// de la casse ni des accents) n'est pas modifiee.
// Usage : npm run seed
require('dotenv').config();
const supabase = require('../services/supabase');
const { normalizeForMatching } = require('../services/categoryMatcher');
const SEED_CATEGORIES = require('./data/categories');

const nameKey = (name) => normalizeForMatching(name);
const DEFAULT_NAME = SEED_CATEGORIES.find((category) => category.is_default).name;

async function seed() {
  const { data: existing, error: existingError } = await supabase
    .from('categories')
    .select('id, name, is_default');

  if (existingError) {
    throw existingError;
  }

  const existingNames = new Set((existing || []).map((row) => nameKey(row.name)));
  const toInsert = SEED_CATEGORIES
    .filter((category) => !existingNames.has(nameKey(category.name)))
    .map(({ name, color, keywords, is_default: isDefault }) => ({ name, color, keywords, is_default: isDefault }));

  if (toInsert.length) {
    const { error: insertError } = await supabase
      .from('categories')
      .insert(toInsert);

    if (insertError) {
      throw insertError;
    }

    console.log(`${toInsert.length} categories inserees : ${toInsert.map((category) => category.name).join(', ')}.`);
  } else {
    console.log('Aucune nouvelle categorie a inserer.');
  }

  const { data: refreshed, error: refreshedError } = await supabase
    .from('categories')
    .select('id, name, is_default');

  if (refreshedError) {
    throw refreshedError;
  }

  const defaultCategory = (refreshed || []).find((category) => nameKey(category.name) === nameKey(DEFAULT_NAME));

  if (!defaultCategory) {
    throw new Error(`La categorie par defaut "${DEFAULT_NAME}" est introuvable apres le seed.`);
  }

  const { error: unsetDefaultError } = await supabase
    .from('categories')
    .update({ is_default: false })
    .neq('id', defaultCategory.id)
    .eq('is_default', true);

  if (unsetDefaultError) {
    throw unsetDefaultError;
  }

  if (!defaultCategory.is_default) {
    const { error: setDefaultError } = await supabase
      .from('categories')
      .update({ is_default: true })
      .eq('id', defaultCategory.id);

    if (setDefaultError) {
      throw setDefaultError;
    }
  }

  console.log(`Categorie par defaut definie : ${defaultCategory.name}.`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur seed categories:', error.message || error);
    process.exit(1);
  });
