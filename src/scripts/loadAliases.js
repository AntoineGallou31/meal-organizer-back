// Charge src/scripts/data/food-aliases.json dans la table food_aliases.
//
// Usage : node src/scripts/loadAliases.js [--dry-run | --apply]
//   --dry-run   compare le fichier à la base, n'écrit rien (mode par défaut)
//   --apply     ajoute les alias nouveaux et corrige ceux qui pointent ailleurs
//
// Format du fichier : { "<alias normalisé>": { "ciqual_code": "9436", "food": "<nom, pour relecture>" } }
// Un alias à "ciqual_code": null signifie « pas d'équivalent fiable : ne pas
// deviner » ; il n'est pas chargé en base (l'analyseur lit ces noms dans le fichier).
// Le fichier fait foi pour ses alias. Ceux créés depuis l'app (correction d'un
// ingrédient) et absents du fichier ne sont pas touchés. Relançable sans dégât.
// Prérequis : importCiqual.js --apply (les aliments doivent exister).
require('dotenv').config({ quiet: true });
const supabase = require('../services/supabase');
const { normalizeFoodName } = require('../services/foodName');
const ALIASES = require('./data/food-aliases.json');

const PAGE_SIZE = 1000;
const IN_CHUNK = 200;
const WRITE_CHUNK = 500;

async function fetchFoodsByCode(codes) {
  const byCode = new Map();
  for (let start = 0; start < codes.length; start += IN_CHUNK) {
    const { data, error } = await supabase
      .from('foods')
      .select('id,ciqual_code,name')
      .in('ciqual_code', codes.slice(start, start + IN_CHUNK));
    if (error) throw error;
    (data || []).forEach((food) => byCode.set(food.ciqual_code, food));
  }
  return byCode;
}

async function fetchExistingAliases() {
  const existing = new Map();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from('food_aliases').select('alias,food_id').order('alias').range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    (data || []).forEach((row) => existing.set(row.alias, row.food_id));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return existing;
}

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((arg) => !['--dry-run', '--apply'].includes(arg));
  if (unknown.length || (argv.includes('--apply') && argv.includes('--dry-run'))) {
    throw new Error('Usage : loadAliases.js [--dry-run | --apply]');
  }
  const apply = argv.includes('--apply');

  const noGuess = Object.entries(ALIASES).filter(([, value]) => value.ciqual_code === null);
  const entries = Object.entries(ALIASES).filter(([, value]) => value.ciqual_code !== null);
  const badKeys = entries.filter(([alias]) => normalizeFoodName(alias) !== alias).map(([alias]) => alias);
  if (badKeys.length) throw new Error(`Alias non normalisés dans le fichier : ${badKeys.join(', ')}`);

  const foods = await fetchFoodsByCode([...new Set(entries.map(([, value]) => value.ciqual_code))]);
  if (!foods.size) throw new Error('Aucun aliment en base : lancer d\'abord importCiqual.js --apply');
  const existing = await fetchExistingAliases();

  const missing = [];
  const renamed = [];
  const toWrite = [];
  let unchanged = 0;
  let added = 0;
  let changed = 0;
  for (const [alias, { ciqual_code: code, food: label }] of entries) {
    const food = foods.get(code);
    if (!food) {
      missing.push(`${alias} → ${code}`);
      continue;
    }
    if (label && label !== food.name) renamed.push(`${alias} → ${code} : « ${label} » dans le fichier, « ${food.name} » en base`);
    const current = existing.get(alias);
    if (current === food.id) {
      unchanged += 1;
      continue;
    }
    if (current) changed += 1;
    else added += 1;
    toWrite.push({ alias, food_id: food.id });
  }

  console.log(`Alias dans le fichier : ${entries.length} (+ ${noGuess.length} noms « ne pas deviner », non chargés)`);
  console.log(`  déjà à jour : ${unchanged}`);
  console.log(`  à ajouter   : ${added}`);
  console.log(`  à corriger  : ${changed} (l'alias existe mais pointe vers un autre aliment)`);
  console.log(`  code Ciqual introuvable en base : ${missing.length}`);
  missing.forEach((line) => console.log(`      ${line}`));
  if (renamed.length) {
    console.log('  nom différent entre le fichier et la base (alias chargé quand même) :');
    renamed.forEach((line) => console.log(`      ${line}`));
  }
  console.log(`Alias en base absents du fichier (créés depuis l'app, non touchés) : ${[...existing.keys()].filter((alias) => !ALIASES[alias]).length}`);

  if (!apply) {
    console.log('\nSimulation : rien n\'a été écrit. Relancer avec --apply pour charger.');
    return;
  }
  console.log(`\nÉcriture dans ${new URL(process.env.SUPABASE_URL).host}...`);
  for (let start = 0; start < toWrite.length; start += WRITE_CHUNK) {
    const { error } = await supabase.from('food_aliases').upsert(toWrite.slice(start, start + WRITE_CHUNK), { onConflict: 'alias' });
    if (error) throw error;
  }
  console.log(`${toWrite.length} alias écrits.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
