require('dotenv').config();
const supabase = require('../services/supabase');

const SEED_CATEGORIES = [
  {
    name: 'Desserts',
    color: '#F9A8D4',
    is_default: false,
    keywords: ['gâteau', 'gateau', 'cake', 'tarte', 'tartelette', 'muffin', 'brownie', 'cookie', 'biscuit', 'crêpe', 'crepe', 'pancake', 'waffle', 'gaufre', 'mousse', 'tiramisu', 'cheesecake', 'fondant', 'moelleux', 'clafoutis', 'flan', 'crème brûlée', 'panna cotta', 'sorbet', 'glace', 'macaron', 'madeleine', 'quatre-quarts', 'pudding', 'compote', 'confiture'],
  },
  {
    name: 'Petit-déjeuner & Brunch',
    color: '#FCD34D',
    is_default: false,
    keywords: ['granola', 'muesli', 'porridge', 'overnight oats', 'smoothie', 'pain perdu', 'french toast', 'eggs benedict', 'avocado toast', 'tartine', 'breakfast', 'brunch', 'acai bowl'],
  },
  {
    name: 'Soupes & Veloutés',
    color: '#6EE7B7',
    is_default: false,
    keywords: ['soupe', 'velouté', 'velout', 'bouillon', 'potage', 'minestrone', 'gaspacho', 'consommé', 'bisque', 'ramen', 'pho', 'miso', 'chorba', 'harira'],
  },
  {
    name: 'Salades',
    color: '#86EFAC',
    is_default: false,
    keywords: ['salade', 'taboulé', 'taboule', 'coleslaw', 'caesar', 'niçoise', 'fattoush', 'waldorf', 'vinaigrette', 'crudités'],
  },
  {
    name: 'Pâtes & Riz',
    color: '#FDE68A',
    is_default: false,
    keywords: ['pâtes', 'pasta', 'spaghetti', 'linguine', 'penne', 'tagliatelle', 'lasagne', 'ravioli', 'gnocchi', 'riz', 'risotto', 'quinotto', 'nouilles', 'coquillettes', 'macaroni', 'fusilli'],
  },
  {
    name: 'Poissons & Fruits de mer',
    color: '#BAE6FD',
    is_default: false,
    keywords: ['saumon', 'thon', 'cabillaud', 'dorade', 'bar', 'merlu', 'truite', 'crevette', 'gambas', 'homard', 'crabe', 'moule', 'coquille saint-jacques', 'seiche', 'poulpe', 'calamar', 'fruits de mer', 'bouillabaisse'],
  },
  {
    name: 'Viandes',
    color: '#FCA5A5',
    is_default: false,
    keywords: ['poulet', 'chicken', 'dinde', 'canard', 'bœuf', 'boeuf', 'veau', 'porc', 'agneau', 'côte', 'steak', 'burger', 'boulette', 'saucisse', 'merguez', 'chorizo', 'lardons', 'bacon', 'jambon', 'rôti', 'brochette', 'kebab', 'tajine', 'blanquette', 'coq au vin', 'cassoulet'],
  },
  {
    name: 'Végétarien',
    color: '#A7F3D0',
    is_default: false,
    keywords: ['tofu', 'tempeh', 'seitan', 'lentille', 'pois chiche', 'falafel', 'houmous', 'hummus', 'dahl', 'dal', 'veggie', 'végétarien', 'vegan', 'végétalien', 'buddha bowl'],
  },
  {
    name: 'Snacks & Apéro',
    color: '#C4B5FD',
    is_default: false,
    keywords: ['apéro', 'apero', 'tapas', 'bruschetta', 'dip', 'chips', 'wraps', 'nems', 'samossa', 'mini', 'bouchée', 'verrine', 'guacamole', 'tzatziki', 'rillettes', 'amuse-bouche'],
  },
  {
    name: 'Sauces & Condiments',
    color: '#FED7AA',
    is_default: false,
    keywords: ['sauce', 'marinade', 'pesto', 'aïoli', 'mayonnaise', 'ketchup', 'tapenade', 'salsa', 'chutney', 'coulis', 'béchamel', 'hollandaise', 'vinaigrette', 'condiment'],
  },
  {
    name: 'Plats principaux',
    color: '#93C5FD',
    is_default: true,
    keywords: [],
  },
];

async function seed() {
  const { data: existing, error: existingError } = await supabase
    .from('categories')
    .select('name');

  if (existingError) {
    throw existingError;
  }

  const existingNames = new Set((existing || []).map((row) => String(row.name || '').toLowerCase()));
  const toInsert = SEED_CATEGORIES.filter((category) => !existingNames.has(category.name.toLowerCase()));

  if (!toInsert.length) {
    console.log('Aucune nouvelle categorie a inserer.');
    return;
  }

  const { error: insertError } = await supabase
    .from('categories')
    .insert(toInsert);

  if (insertError) {
    throw insertError;
  }

  console.log(`${toInsert.length} categories inserees.`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur seed categories:', error.message || error);
    process.exit(1);
  });
