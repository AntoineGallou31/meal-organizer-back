require('dotenv').config();
const supabase = require('../services/supabase');

const SEED_CATEGORIES = [
  {
    name: 'Agneau',
    color: '#EF4444',
    is_default: false,
    keywords: ['agneau', 'lamb'],
  },
  {
    name: 'Apéritif',
    color: '#F59E0B',
    is_default: false,
    keywords: ['apéritif', 'apero', 'tapas', 'snack', 'entrée'],
  },
  {
    name: 'Assiettes complètes',
    color: '#10B981',
    is_default: false,
    keywords: [],
  },
  {
    name: 'Sans catégorie',
    color: '#9CA3AF',
    is_default: true,
    keywords: [],
  },
  {
    name: 'Boeuf',
    color: '#DC2626',
    is_default: false,
    keywords: ['boeuf', 'bœuf', 'beef', 'steak'],
  },
  {
    name: 'Boulgour',
    color: '#D97706',
    is_default: false,
    keywords: ['boulgour', 'bulgur'],
  },
  {
    name: 'Brunch',
    color: '#F59E0B',
    is_default: false,
    keywords: ['brunch', 'petit déjeuner', 'eggs', 'bacon'],
  },
  {
    name: 'Burgers',
    color: '#DC2626',
    is_default: false,
    keywords: ['burger', 'hamburger'],
  },
  {
    name: 'Cakes',
    color: '#EC4899',
    is_default: false,
    keywords: ['cake', 'gâteau', 'gateau'],
  },
  {
    name: 'Clafoutis salés',
    color: '#8B5CF6',
    is_default: false,
    keywords: ['clafoutis', 'salé'],
  },
  {
    name: 'Cocktails',
    color: '#06B6D4',
    is_default: false,
    keywords: ['cocktail', 'drink', 'alcool', 'aperitif'],
  },
  {
    name: 'Croques Monsieur',
    color: '#EA580C',
    is_default: false,
    keywords: ['croque', 'sandwich'],
  },
  {
    name: 'Dahl et curry',
    color: '#F97316',
    is_default: false,
    keywords: ['dahl', 'dal', 'curry', 'spice'],
  },
  {
    name: 'Desserts',
    color: '#EC4899',
    is_default: false,
    keywords: ['gâteau', 'gateau', 'tarte', 'dessert', 'sucré'],
  },
  {
    name: 'Gnocchis',
    color: '#F59E0B',
    is_default: false,
    keywords: ['gnocchi', 'gnocchis'],
  },
  {
    name: 'Lentilles',
    color: '#DC2626',
    is_default: false,
    keywords: ['lentille', 'lentil', 'legume'],
  },
  {
    name: 'Légumes',
    color: '#22C55E',
    is_default: false,
    keywords: ['légume', 'legume', 'vegetable', 'veggie'],
  },
  {
    name: 'Oeufs',
    color: '#FCD34D',
    is_default: false,
    keywords: ['oeuf', 'œuf', 'egg', 'eggs'],
  },
  {
    name: 'Omelettes',
    color: '#FCD34D',
    is_default: false,
    keywords: ['omelette', 'scrambled'],
  },
  {
    name: 'Poissons',
    color: '#06B6D4',
    is_default: false,
    keywords: ['poisson', 'fish', 'saumon', 'trout', 'tuna'],
  },
  {
    name: 'Poulet',
    color: '#F59E0B',
    is_default: false,
    keywords: ['poulet', 'chicken', 'poultry'],
  },
  {
    name: 'Pâtes',
    color: '#D4A574',
    is_default: false,
    keywords: ['pâtes', 'pasta', 'spaghetti', 'tagliatelle', 'fusilli'],
  },
  {
    name: 'Quiches et tartes',
    color: '#D4A574',
    is_default: false,
    keywords: ['quiche', 'tarte', 'tartelette', 'pie'],
  },
  {
    name: 'Quinoa',
    color: '#10B981',
    is_default: false,
    keywords: ['quinoa', 'quinotto'],
  },
  {
    name: 'Riz',
    color: '#D4A574',
    is_default: false,
    keywords: ['riz', 'rice', 'risotto'],
  },
  {
    name: 'Salades',
    color: '#22C55E',
    is_default: false,
    keywords: ['salade', 'salad', 'crudités'],
  },
  {
    name: 'Sarrasin',
    color: '#D4A574',
    is_default: false,
    keywords: ['sarrasin', 'buckwheat'],
  },
  {
    name: 'Semoule',
    color: '#D4A574',
    is_default: false,
    keywords: ['semoule', 'couscous', 'semolina'],
  },
  {
    name: 'Soupes',
    color: '#06B6D4',
    is_default: false,
    keywords: ['soupe', 'soup', 'velouté', 'potage'],
  },
  {
    name: 'Veau',
    color: '#DC2626',
    is_default: false,
    keywords: ['veau', 'veal'],
  },
];

async function seed() {
  const { data: existing, error: existingError } = await supabase
    .from('categories')
    .select('id, name, is_default');

  if (existingError) {
    throw existingError;
  }

  const existingNames = new Set((existing || []).map((row) => String(row.name || '').toLowerCase()));
  const toInsert = SEED_CATEGORIES.filter((category) => !existingNames.has(category.name.toLowerCase()));

  if (toInsert.length) {
    const { error: insertError } = await supabase
      .from('categories')
      .insert(toInsert);

    if (insertError) {
      throw insertError;
    }

    console.log(`${toInsert.length} categories inserees.`);
  } else {
    console.log('Aucune nouvelle categorie a inserer.');
  }

  const { data: refreshed, error: refreshedError } = await supabase
    .from('categories')
    .select('id, name, is_default');

  if (refreshedError) {
    throw refreshedError;
  }

  const defaultCategory = (refreshed || []).find(
    (category) => String(category.name || '').toLowerCase() === 'sans catégorie',
  );

  if (!defaultCategory) {
    throw new Error('La categorie par defaut "Sans catégorie" est introuvable apres le seed.');
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

  console.log('Categorie par defaut definie: Sans catégorie.');
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur seed categories:', error.message || error);
    process.exit(1);
  });
