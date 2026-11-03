// Liste les categories en base avec leur nombre de recettes. Lecture seule.
// Usage : node src/scripts/listCategories.js [--exemples]
//   --exemples : affiche aussi quelques titres de recettes par categorie
require('dotenv').config();
const supabase = require('../services/supabase');

const PAGE_SIZE = 1000;
const EXAMPLE_COUNT = 4;
const withExamples = process.argv.includes('--exemples');

// Supabase renvoie au plus 1000 lignes par requete : on lit par tranches.
async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function main() {
  const [categories, links, recipes] = await Promise.all([
    fetchAll(() => supabase.from('categories').select('id, name, is_default').order('name')),
    fetchAll(() => supabase.from('recipe_categories').select('category_id, recipe_id, recipes(title)').order('recipe_id')),
    fetchAll(() => supabase.from('recipes').select('id').order('id')),
  ]);

  const byCategory = new Map(categories.map((category) => [category.id, []]));
  links.forEach((link) => byCategory.get(link.category_id)?.push(link.recipes?.title || '(sans titre)'));

  const linkedRecipeIds = new Set(links.map((link) => link.recipe_id));
  const uncategorized = recipes.filter((recipe) => !linkedRecipeIds.has(recipe.id)).length;

  const rows = categories
    .map((category) => ({ ...category, titles: byCategory.get(category.id) || [] }))
    .sort((a, b) => b.titles.length - a.titles.length || a.name.localeCompare(b.name, 'fr'));

  console.log(`${categories.length} categories, ${recipes.length} recettes en base, ${uncategorized} sans aucune categorie\n`);
  console.log('Recettes  Categorie');

  rows.forEach((row) => {
    const flag = row.is_default ? '  (par defaut)' : '';
    console.log(`${String(row.titles.length).padStart(8)}  ${row.name}${flag}`);
    if (withExamples && row.titles.length) {
      row.titles.slice(0, EXAMPLE_COUNT).forEach((title) => console.log(`            - ${title}`));
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur listCategories:', error.message || error);
    process.exit(1);
  });
