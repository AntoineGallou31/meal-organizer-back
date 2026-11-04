// Analyse nutritionnelle de toutes les recettes (rattrapage).
//
// Usage : node src/scripts/analyzeRecipes.js [--dry-run | --apply] [--only <id>] [--db]
//   --dry-run   simulation, n'écrit rien (mode par défaut) : affiche le rapport
//   --apply     réécrit recipe_ingredients et recipes.nutrition / diet_tags / main_protein
//   --only <id> une seule recette (en simulation : détail ligne par ligne)
//   --db        simulation avec les aliments et alias de la base au lieu des fichiers
//
// La simulation lit les recettes en base (lecture seule) et, par défaut, les
// aliments dans les fichiers Ciqual (data/) et les alias dans
// src/scripts/data/food-aliases.json : elle fonctionne avant tout import, et
// chaque modification du fichier d'alias se voit en relançant la simulation.
// --apply utilise la base : lancer d'abord importCiqual.js et loadAliases.js.
// Relançable sans dégât : les lignes corrigées à la main sont gardées.
require('dotenv').config({ quiet: true });
const supabase = require('../services/supabase');
const { createDbMatcher, createLocalMatcher } = require('../services/foodMatchers');
const { analyzeIngredientLines, analyzeRecipe, MATCH_THRESHOLD } = require('../services/ingredientAnalyzer');
const { loadCiqual, buildRows, findCiqualDir } = require('./importCiqual');
const ALIASES = require('./data/food-aliases.json');

const PAGE_SIZE = 1000;
const APPLY_CONCURRENCY = 4;
const DOUBTFUL_MAX_SCORE = 0.6;
const TOP_UNMATCHED = 150;
const TOP_SIMILARITY = 150;
const MANUAL_FIELDS = 'position,raw_text,quantity,unit,name,food_id,match_method,match_score,grams,status';

// ---------- Lecture ----------

async function fetchRecipes(onlyId) {
  const recipes = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from('recipes').select('id,title,servings,ingredients').order('created_at');
    if (onlyId) query = query.eq('id', onlyId);
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    recipes.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return recipes;
}

// Lignes corrigées à la main (si la table existe), pour que la simulation en tienne compte.
// En simulation locale, les aliments sont repérés par code Ciqual.
async function fetchManualRows({ localIds }) {
  const byRecipe = new Map();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('recipe_ingredients')
      .select(`recipe_id,${MANUAL_FIELDS},foods(ciqual_code)`)
      .or('status.eq.checked,match_method.eq.manual')
      .order('recipe_id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) return byRecipe; // table pas encore créée
    for (const row of data || []) {
      const { recipe_id: recipeId, foods, ...rest } = row;
      if (localIds && rest.food_id) rest.food_id = foods?.ciqual_code ?? rest.food_id;
      if (!byRecipe.has(recipeId)) byRecipe.set(recipeId, []);
      byRecipe.get(recipeId).push(rest);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return byRecipe;
}

function createFileMatcher() {
  const foods = buildRows(loadCiqual(findCiqualDir()).foods).map(({ row }) => ({ ...row, id: row.ciqual_code }));
  const aliases = new Map(Object.entries(ALIASES)
    .filter(([, { ciqual_code: code }]) => code !== null)
    .map(([alias, { ciqual_code: code }]) => [alias, code]));
  return createLocalMatcher({ foods, aliases });
}

// ---------- Rapport ----------

const percent = (part, total) => (total ? `${Math.round((part / total) * 1000) / 10} %` : '-');

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const k = key(item);
    if (!counts.has(k)) counts.set(k, { count: 0, item });
    counts.get(k).count += 1;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function printReport(results) {
  const lines = results.flatMap(({ recipe, result }) => result.rows.map((row, index) => ({
    recipe, row, match: result.matches[index], food: row.food_id ? result.foods.get(row.food_id) : null,
  })));
  const active = lines.filter(({ row }) => row.status !== 'ignored');
  const recognized = active.filter(({ food }) => food);
  const withGrams = active.filter(({ row }) => row.grams !== null);
  const analyzed = results.filter(({ result }) => result.nutrition);
  const fullyRecognized = analyzed.filter(({ result }) => result.nutrition.recognized === 1);
  const fullyWeighed = analyzed.filter(({ result }) => result.nutrition.coverage === 1);
  const withoutServings = results.filter(({ recipe }) => !(Number.parseInt(String(recipe.servings ?? ''), 10) > 0));
  const byAlias = active.filter(({ row }) => row.match_method === 'alias' || row.status === 'checked');

  console.log(`Recettes : ${results.length} (${analyzed.length} avec des ingrédients)`);
  console.log(`Lignes : ${lines.length}, dont ${lines.length - active.length} ignorées (sel, poivre, eau, épices...)`);
  console.log(`Lignes non ignorées : ${active.length}`);
  console.log(`  reconnues            ${percent(recognized.length, active.length)} (${recognized.length})`);
  console.log(`    par alias exact    ${percent(byAlias.length, active.length)} (${byAlias.length})`);
  console.log(`    par similarité     ${percent(recognized.length - byAlias.length, active.length)} (${recognized.length - byAlias.length})`);
  console.log(`  avec grammes         ${percent(withGrams.length, active.length)} (${withGrams.length})`);
  console.log(`Recettes entièrement reconnues : ${percent(fullyRecognized.length, analyzed.length)} (${fullyRecognized.length})`);
  console.log(`Recettes entièrement pesées    : ${percent(fullyWeighed.length, analyzed.length)} (${fullyWeighed.length})`);
  console.log(`Recettes sans servings         : ${withoutServings.length}`);

  const tagCounts = countBy(analyzed.flatMap(({ result }) => result.dietTags), (tag) => tag);
  console.log(`Étiquettes : ${tagCounts.map(({ item, count }) => `${item} ${count}`).join(', ') || 'aucune'}`);
  const proteinCounts = countBy(analyzed, ({ result }) => result.mainProtein ?? 'null');
  console.log(`Protéine principale : ${proteinCounts.map(({ item, count }) => `${item.result.mainProtein ?? 'inconnue'} ${count}`).join(', ')}`);

  const unmatched = countBy(active.filter(({ food, row }) => !food && row.name), ({ row }) => row.name);
  console.log(`\n── ${Math.min(TOP_UNMATCHED, unmatched.length)} noms non reconnus les plus fréquents (sur ${unmatched.length}) : nom ×occurrences  [meilleur candidat sous le seuil]`);
  unmatched.slice(0, TOP_UNMATCHED).forEach(({ item, count }) => {
    const best = item.match?.best;
    console.log(`  ${item.row.name} ×${count}${best ? `  [${best.name} ${best.score}]` : ''}`);
  });

  const similar = countBy(active.filter(({ row }) => row.match_method === 'similarity'), ({ row }) => row.name);
  console.log(`\n── ${Math.min(TOP_SIMILARITY, similar.length)} noms reconnus par similarité les plus fréquents (sur ${similar.length}) : nom ×occurrences → aliment (score)`);
  similar.slice(0, TOP_SIMILARITY).forEach(({ item, count }) => {
    console.log(`  ${item.row.name} ×${count} → ${item.food.name} (${item.row.match_score})`);
  });

  // Lignes reconnues sans grammes : quantité absente, ou unité sans poids connu pour cet aliment
  const noGrams = countBy(active.filter(({ food, row }) => food && row.grams === null),
    ({ row, food }) => `${food.name} | ${row.quantity === null ? 'sans quantité' : row.unit}`);
  console.log(`\n── ${Math.min(TOP_SIMILARITY, noGrams.length)} cas les plus fréquents de lignes reconnues sans grammes : aliment | unité ×occurrences`);
  noGrams.slice(0, 60).forEach(({ item, count }) => {
    console.log(`  ${item.food.name} | ${item.row.quantity === null ? 'sans quantité' : item.row.unit} ×${count}  (ex. « ${item.row.raw_text} »)`);
  });

  const doubtful = similar.filter(({ item }) => item.row.match_score < DOUBTFUL_MAX_SCORE);
  console.log(`\n── Correspondances douteuses (score entre ${MATCH_THRESHOLD} et ${DOUBTFUL_MAX_SCORE}) : ${doubtful.length} noms`);
  doubtful.forEach(({ item, count }) => {
    console.log(`  ${item.row.name} ×${count} → ${item.food.name} (${item.row.match_score})`);
  });
}

function printRecipeDetail({ recipe, result }) {
  console.log(`\n${recipe.title} (${recipe.id}, ${recipe.servings ?? '?'} parts)`);
  result.rows.forEach((row) => {
    const food = row.food_id ? result.foods.get(row.food_id) : null;
    const how = row.status === 'checked' ? 'à la main' : (row.match_method ? `${row.match_method} ${row.match_score}` : '');
    console.log(`  [${row.status}] ${row.raw_text}`);
    console.log(`      ${row.quantity ?? '-'} ${row.unit ?? '-'} « ${row.name ?? ''} » → ${food ? food.name : 'non reconnu'}${how ? ` (${how})` : ''} → ${row.grams ?? '?'} g`);
  });
  console.log(`  Par part : ${JSON.stringify(result.nutrition?.per_serving ?? null)}`);
  console.log(`  Couverture ${result.nutrition?.coverage ?? '-'}, reconnues ${result.nutrition?.recognized ?? '-'}`);
  console.log(`  Étiquettes : ${result.dietTags.join(', ') || 'aucune'} | protéine principale : ${result.mainProtein ?? 'inconnue'}`);
}

// ---------- Main ----------

function parseArgs(argv) {
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : null;
  const known = new Set(['--dry-run', '--apply', '--only', '--db']);
  const unknown = argv.filter((arg, index) => !known.has(arg) && !(onlyIndex >= 0 && index === onlyIndex + 1));
  if (unknown.length || (onlyIndex >= 0 && !only)) {
    throw new Error('Usage : analyzeRecipes.js [--dry-run | --apply] [--only <id>] [--db]');
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('--apply et --dry-run sont incompatibles');
  return { apply: argv.includes('--apply'), only, db: argv.includes('--db') || argv.includes('--apply') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const recipes = await fetchRecipes(options.only);
  if (!recipes.length) throw new Error(options.only ? `Recette introuvable : ${options.only}` : 'Aucune recette');

  if (options.apply) {
    console.log(`Analyse de ${recipes.length} recette(s) dans ${new URL(process.env.SUPABASE_URL).host}...`);
    const matcher = createDbMatcher(supabase);
    const results = [];
    let failed = 0;
    for (let start = 0; start < recipes.length; start += APPLY_CONCURRENCY) {
      await Promise.all(recipes.slice(start, start + APPLY_CONCURRENCY).map(async (recipe) => {
        try {
          results.push({ recipe, result: await analyzeRecipe(recipe.id, { matcher }) });
        } catch (error) {
          failed += 1;
          console.error(`  échec ${recipe.id} (${recipe.title}) : ${error.message || error}`);
        }
      }));
      if ((start / APPLY_CONCURRENCY) % 25 === 0) console.log(`  ${Math.min(start + APPLY_CONCURRENCY, recipes.length)} / ${recipes.length}`);
    }
    console.log(`Terminé : ${results.length} analysée(s), ${failed} échec(s).\n`);
    printReport(results);
    return;
  }

  const matcher = options.db ? createDbMatcher(supabase) : createFileMatcher();
  const manualRows = await fetchManualRows({ localIds: !options.db });
  const results = [];
  for (const recipe of recipes) {
    const result = await analyzeIngredientLines(recipe.ingredients || [], {
      servings: recipe.servings,
      previousRows: manualRows.get(recipe.id) || [],
      matcher,
    });
    results.push({ recipe, result });
  }

  if (options.only) results.forEach(printRecipeDetail);
  else printReport(results);
  console.log(`\nSimulation (${options.db ? 'aliments et alias de la base' : 'fichiers Ciqual et food-aliases.json'}) : rien n'a été écrit.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
