// Import de la table de composition Ciqual (Anses) dans la table foods.
//
// Usage : node src/scripts/importCiqual.js [--dry-run | --apply] [--dir <dossier>]
//   --dry-run   lit les fichiers et affiche le rapport, n'écrit rien (mode par défaut)
//   --apply     upsert dans foods par ciqual_code (relançable sans dégât)
//   --dir       dossier des fichiers XML Ciqual (défaut : data/ciqual, sinon data)
//
// Fichiers attendus (export XML Ciqual) : alim_*.xml, alim_grp_*.xml, compo_*.xml,
// const_*.xml. Si plusieurs versions sont présentes, la plus récente est prise.
//
// Indicateurs de régime : src/scripts/data/food-flags.js
// Poids unitaires et densités : src/scripts/data/unit-weights.json
// Un relancement réécrit ces champs pour les aliments Ciqual ; les aliments
// ajoutés à la main (ciqual_code null) ne sont jamais touchés.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { normalizeFoodName } = require('../services/foodName');
const FLAG_RULES = require('./data/food-flags');
const UNIT_WEIGHTS = require('./data/unit-weights.json');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_DIRS = [path.join(ROOT, 'data', 'ciqual'), path.join(ROOT, 'data')];
const WRITE_CHUNK = 500;
const EXAMPLES_PER_FLAG = 20;

// Constituants Ciqual retenus (valeurs pour 100 g)
const NUTRIENTS = {
  energy_kcal: '328', // Energie, Règlement UE N° 1169/2011 (kcal/100 g)
  proteins_g: '25000', // Protéines, N x facteur de Jones (g/100 g)
  carbs_g: '31000', // Glucides (g/100 g)
  sugars_g: '32000', // Sucres (g/100 g)
  fat_g: '40000', // Lipides (g/100 g)
  fibers_g: '34100', // Fibres alimentaires (g/100 g)
  salt_g: '10004', // Sel chlorure de sodium (g/100 g)
};
// Lus seulement pour estimer l'énergie quand Ciqual ne la donne pas
const AUX_NUTRIENTS = {
  energy_jones_kcal: '333', // Energie, N x facteur Jones, avec fibres (kcal/100 g)
  alcohol_g: '60000', // Alcool (éthanol) (g/100 g)
};

// Énergie inconnue : autre valeur Ciqual (333), sinon calcul depuis les
// macronutriments avec les coefficients du règlement UE 1169/2011.
// Pas de calcul pour une boisson alcoolisée dont l'alcool est inconnu.
function estimateEnergy(values, subgroupCode) {
  if (values.energy_jones_kcal != null) return { value: values.energy_jones_kcal, source: 'ciqual-333' };
  const { proteins_g: p, carbs_g: c, fat_g: f } = values;
  if (p == null || c == null || f == null) return null;
  if (subgroupCode === '0603' && values.alcohol_g == null) return null;
  const kcal = 4 * p + 4 * c + 9 * f + 2 * (values.fibers_g ?? 0) + 7 * (values.alcohol_g ?? 0);
  return { value: Math.round(kcal * 10) / 10, source: 'macros' };
}

const FLAGS = Object.keys(FLAG_RULES);

// ---------- Lecture des fichiers ----------

function findCiqualDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);
  const found = DEFAULT_DIRS.find((dir) => fs.existsSync(dir) && findFile(dir, 'alim', false));
  if (!found) throw new Error(`Fichiers Ciqual introuvables dans ${DEFAULT_DIRS.join(' ou ')}`);
  return found;
}

function findFile(dir, prefix, required = true) {
  const pattern = new RegExp(`^${prefix}_\\d.*\\.xml$`, 'i');
  const files = fs.readdirSync(dir).filter((file) => pattern.test(file)).sort();
  if (!files.length) {
    if (required) throw new Error(`Fichier ${prefix}_*.xml introuvable dans ${dir}`);
    return null;
  }
  return path.join(dir, files[files.length - 1]);
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// Les fichiers Ciqual sont plats : <TABLE><TAG><champ> valeur </champ>...</TAG>...</TABLE>.
// Un champ vide est écrit <champ missing=" " /> et reste absent de l'objet.
function* readRows(file, tag) {
  const xml = fs.readFileSync(file, 'utf8');
  const rowPattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  for (const row of xml.matchAll(rowPattern)) {
    const fields = {};
    for (const field of row[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) {
      fields[field[1]] = decodeXml(field[2]);
    }
    yield fields;
  }
}

// « 1,5 » → 1.5 ; « traces » → 0 ; « < 0,5 » → 0.25 ; « - » ou vide → null
function parseCiqualValue(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value || value === '-') return null;
  if (value === 'traces') return 0;
  const lessThan = value.match(/^<\s*(.+)$/);
  const number = Number((lessThan ? lessThan[1] : value).replace(',', '.'));
  if (!Number.isFinite(number)) return null;
  return lessThan ? number / 2 : number;
}

function loadCiqual(dir) {
  const files = {
    alim: findFile(dir, 'alim'),
    grp: findFile(dir, 'alim_grp'),
    compo: findFile(dir, 'compo'),
    const: findFile(dir, 'const'),
  };

  const constNames = new Map();
  for (const row of readRows(files.const, 'CONST')) constNames.set(row.const_code, row.const_nom_fr);
  for (const [column, code] of Object.entries(NUTRIENTS)) {
    if (!constNames.has(code)) throw new Error(`Constituant ${code} (${column}) absent de ${path.basename(files.const)}`);
  }

  const groupNames = new Map();
  const subgroupNames = new Map();
  for (const row of readRows(files.grp, 'ALIM_GRP')) {
    groupNames.set(row.alim_grp_code, row.alim_grp_nom_fr);
    if (row.alim_ssgrp_nom_fr && row.alim_ssgrp_nom_fr !== '-') {
      subgroupNames.set(row.alim_ssgrp_code, row.alim_ssgrp_nom_fr);
    }
  }

  const codeToColumn = new Map(
    Object.entries({ ...NUTRIENTS, ...AUX_NUTRIENTS }).map(([column, code]) => [code, column])
  );
  const values = new Map();
  for (const row of readRows(files.compo, 'COMPO')) {
    const column = codeToColumn.get(row.const_code);
    if (!column) continue;
    if (!values.has(row.alim_code)) values.set(row.alim_code, {});
    values.get(row.alim_code)[column] = parseCiqualValue(row.teneur);
  }

  const foods = [];
  for (const row of readRows(files.alim, 'ALIM')) {
    const nutrients = values.get(row.alim_code) || {};
    let energySource = nutrients.energy_kcal != null ? 'ciqual' : null;
    if (nutrients.energy_kcal == null) {
      const estimate = estimateEnergy(nutrients, row.alim_ssgrp_code);
      if (estimate) {
        nutrients.energy_kcal = estimate.value;
        energySource = estimate.source;
      }
    }
    foods.push({
      ciqual_code: row.alim_code,
      name: row.alim_nom_fr,
      group_code: row.alim_grp_code,
      subgroup_code: row.alim_ssgrp_code,
      subsubgroup_code: row.alim_ssssgrp_code,
      group_name: groupNames.get(row.alim_grp_code) ?? null,
      subgroup_name: subgroupNames.get(row.alim_ssgrp_code) ?? null,
      energySource,
      ...Object.fromEntries(Object.keys(NUTRIENTS).map((column) => [column, nutrients[column] ?? null])),
    });
  }

  return { files, foods, constNames };
}

// ---------- Indicateurs, poids unitaires, densités ----------

function compileRule(rule) {
  const words = (list) => (list.length ? new RegExp(`\\b(?:${list.join('|')})`) : null);
  return { groups: rule.groups || [], keywords: words(rule.keywords || []), exclude: words(rule.exclude || []) };
}

const COMPILED_FLAGS = Object.fromEntries(FLAGS.map((flag) => [flag, compileRule(FLAG_RULES[flag])]));

function computeFlags(food, normalizedName) {
  const codes = [food.group_code, food.subgroup_code, food.subsubgroup_code].filter(Boolean);
  const flags = {};
  for (const flag of FLAGS) {
    const rule = COMPILED_FLAGS[flag];
    const byGroup = rule.groups.some((prefix) => codes.some((code) => code.startsWith(prefix)));
    const byKeyword = rule.keywords ? rule.keywords.test(normalizedName) : false;
    const excluded = rule.exclude ? rule.exclude.test(normalizedName) : false;
    flags[flag] = (byGroup || byKeyword) && !excluded;
  }
  return flags;
}

const UNIT_RULES = UNIT_WEIGHTS.units.map((entry) => ({ ...entry, regex: new RegExp(entry.match) }));
const DENSITY_RULES = UNIT_WEIGHTS.densities.map((entry) => ({ ...entry, regex: new RegExp(entry.match) }));

function computeUnits(normalizedName) {
  const unitWeights = {};
  const unitLabels = [];
  for (const rule of UNIT_RULES) {
    if (!rule.regex.test(normalizedName)) continue;
    Object.assign(unitWeights, rule.unit_weights);
    unitLabels.push(rule.label);
  }
  const densityRule = DENSITY_RULES.find((rule) => rule.regex.test(normalizedName));
  return {
    unit_weights: unitWeights,
    density: densityRule ? densityRule.density : null,
    unitLabels,
    densityLabel: densityRule?.label ?? null,
  };
}

function buildRows(foods) {
  return foods.map((food) => {
    const normalizedName = normalizeFoodName(food.name);
    const units = computeUnits(normalizedName);
    return {
      food,
      units,
      row: {
        ciqual_code: food.ciqual_code,
        name: food.name,
        group_name: food.group_name,
        subgroup_name: food.subgroup_name,
        ...Object.fromEntries(Object.keys(NUTRIENTS).map((column) => [column, food[column]])),
        ...computeFlags(food, normalizedName),
        unit_weights: units.unit_weights,
        density: units.density,
      },
    };
  });
}

// ---------- Rapport ----------

// Exemples répartis sur toute la liste (triée par groupe puis nom), pour voir
// des aliments de groupes différents plutôt que les 20 premiers.
function spreadSample(list, count) {
  if (list.length <= count) return list;
  const step = list.length / count;
  return Array.from({ length: count }, (_, index) => list[Math.floor(index * step)]);
}

function printReport({ files, constNames }, built) {
  console.log('Fichiers :');
  Object.values(files).forEach((file) => console.log(`  ${path.relative(ROOT, file)}`));
  console.log('Constituants :');
  Object.entries(NUTRIENTS).forEach(([column, code]) => console.log(`  ${column.padEnd(12)} ← ${code} ${constNames.get(code)}`));

  console.log(`\nAliments : ${built.length}`);
  for (const column of Object.keys(NUTRIENTS)) {
    const missing = built.filter(({ row }) => row[column] === null).length;
    console.log(`  ${column.padEnd(12)} inconnu pour ${missing}`);
  }
  const estimated = built.filter(({ food }) => food.energySource && food.energySource !== 'ciqual');
  console.log(`  énergie estimée pour ${estimated.length} (valeur Ciqual 333 ou calcul 4/4/9) :`);
  estimated.slice(0, 10).forEach(({ row, food }) => console.log(`      ${row.name} → ${row.energy_kcal} kcal (${food.energySource})`));
  if (estimated.length > 10) console.log(`      ... et ${estimated.length - 10} autres`);

  const sorted = [...built].sort((a, b) =>
    (a.food.subgroup_code || '').localeCompare(b.food.subgroup_code || '') || a.row.name.localeCompare(b.row.name, 'fr'));

  console.log('\nIndicateurs :');
  for (const flag of FLAGS) {
    console.log(`  ${flag.padEnd(17)} ${built.filter(({ row }) => row[flag]).length}`);
  }

  for (const flag of FLAGS) {
    const flagged = sorted.filter(({ row }) => row[flag]);
    console.log(`\n── ${flag} (${flagged.length}) : ${Math.min(EXAMPLES_PER_FLAG, flagged.length)} exemples`);
    spreadSample(flagged, EXAMPLES_PER_FLAG).forEach(({ row }) => {
      console.log(`  ${row.ciqual_code.padStart(5)}  ${row.name}  [${row.subgroup_name ?? row.group_name ?? '?'}]`);
    });
  }

  console.log('\n── Poids unitaires');
  for (const rule of UNIT_RULES) {
    const matched = built.filter(({ units }) => units.unitLabels.includes(rule.label));
    console.log(`  ${rule.label} ${JSON.stringify(rule.unit_weights)} → ${matched.length} aliment(s)`);
    matched.forEach(({ row }) => console.log(`      ${row.name}`));
  }

  console.log('\n── Densités');
  for (const rule of DENSITY_RULES) {
    const matched = built.filter(({ units }) => units.densityLabel === rule.label);
    console.log(`  ${rule.label} ${rule.density} g/ml → ${matched.length} aliment(s)`);
    matched.forEach(({ row }) => console.log(`      ${row.name}`));
  }
}

// ---------- Écriture ----------

async function upsertFoods(rows) {
  const supabase = require('../services/supabase');
  console.log(`\nUpsert de ${rows.length} aliments dans ${new URL(process.env.SUPABASE_URL).host}...`);
  for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
    const chunk = rows.slice(start, start + WRITE_CHUNK);
    const { error } = await supabase.from('foods').upsert(chunk, { onConflict: 'ciqual_code' });
    if (error) throw error;
    console.log(`  ${Math.min(start + WRITE_CHUNK, rows.length)} / ${rows.length}`);
  }
  console.log('Import terminé.');
}

// ---------- Main ----------

function parseArgs(argv) {
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : null;
  const known = new Set(['--dry-run', '--apply', '--dir']);
  const unknown = argv.filter((arg, index) => !known.has(arg) && !(dirIndex >= 0 && index === dirIndex + 1));
  if (unknown.length || (dirIndex >= 0 && !dir)) {
    throw new Error('Usage : importCiqual.js [--dry-run | --apply] [--dir <dossier>]');
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('--apply et --dry-run sont incompatibles');
  return { apply: argv.includes('--apply'), dir };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ciqual = loadCiqual(findCiqualDir(options.dir));
  const built = buildRows(ciqual.foods);
  printReport(ciqual, built);

  if (!options.apply) {
    console.log('\nSimulation : rien n\'a été écrit. Relancer avec --apply pour importer.');
    return;
  }
  await upsertFoods(built.map(({ row }) => row));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { parseCiqualValue, decodeXml, loadCiqual, buildRows, findCiqualDir };
