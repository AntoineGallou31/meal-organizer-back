// Restructuration des categories : les anciennes sont fusionnees dans les 21
// categories de reference (data/categories.js).
//
// Usage : node src/scripts/migrateCategories.js [mode] [options]
//   --dry-run            simulation, n'ecrit rien en base (mode par defaut)
//   --review             simulation + liste de revue ecrite dans data/categories-review.json
//   --apply              sauvegarde dans backups/, puis applique la fusion et les decisions
//                        de data/categories-decisions.json
//   --auto               decisions = propositions du classement automatique, sans revue
//                        (projet demo, donnees fictives) ; a combiner avec --apply pour ecrire
//   --restore <fichier>  remet categories et recipe_categories dans l'etat de la sauvegarde
//
// Tout se fait par nom de categorie (sans tenir compte de la casse ni des accents),
// a partir de l'etat de la base au moment du lancement : on peut relancer le script
// sans degat. Une fois tout applique, la simulation annonce « rien a faire ».
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const supabase = require('../services/supabase');
const { buildMatchers, classifyTitle, normalizeForMatching } = require('../services/categoryMatcher');
const CATEGORIES = require('./data/categories');

const DATA_DIR = path.join(__dirname, 'data');
const REVIEW_FILE = path.join(DATA_DIR, 'categories-review.json');
const DECISIONS_FILE = path.join(DATA_DIR, 'categories-decisions.json');
const BACKUP_DIR = path.resolve(__dirname, '../../backups');
const PAGE_SIZE = 1000;
const WRITE_CHUNK = 100;
const REVIEW_EXAMPLES = 10;

// Categories actuelles fusionnees dans chaque cible. Si une categorie porte deja le
// nom de la cible, elle devient la cible ; sinon la source la plus remplie est renommee.
const MERGES = {
  'Plats de légumes': ['Légumes'],
  'Pâtes': ['Pâtes'],
  'Salades': ['Salades'],
  'Quiches & tartes salées': ['Quiches et tartes'],
  'Céréales & légumineuses': ['Quinoa', 'Semoule', 'Boulgour', 'Sarrasin', 'Lentilles'],
  'Riz & risottos': ['Riz'],
  'Soupes & veloutés': ['Soupes', 'Soupes & Veloutés'],
  'Poulet & volaille': ['Poulet'],
  'Gnocchis': ['Gnocchis'],
  'Crozets': [],
  'Poissons & fruits de mer': ['Poissons', 'Poissons & Fruits de mer'],
  'Currys & dahls': ['Dahl et curry'],
  'Cakes & clafoutis salés': ['Clafoutis salés'],
  'Œufs & omelettes': ['Oeufs', 'Omelettes'],
  'Burgers & croques': ['Burgers', 'Croques Monsieur'],
  'Viandes': ['Viandes', 'Boeuf', 'Veau', 'Agneau'],
  'Bowls & assiettes complètes': ['Assiettes complètes'],
  'Desserts': ['Desserts'],
  'Apéro & entrées': ['Apéritif', 'Snacks & Apéro'],
  'Boissons & cocktails': ['Cocktails'],
  'Petit-déjeuner & brunch': ['Brunch', 'Petit-déjeuner & Brunch'],
  'Sans catégorie': [],
};

// Categories partagees entre plusieurs cibles ou supprimees : chaque recette est
// tranchee (decisions), puis la categorie, devenue vide, est supprimee.
const SPLIT = ['Pâtes & Riz', 'Cakes', 'Végétarien', 'Sauces & Condiments'];
// Categories ou le classement repere probablement des recettes mal rangees.
const SUSPECT = ['Légumes', 'Quiches et tartes'];

const DEFAULT_NAME = CATEGORIES.find((category) => category.is_default).name;
const nameKey = (name) => normalizeForMatching(name);

// ---------- Lecture ----------

// Supabase renvoie au plus 1000 lignes par requete : on lit par tranches.
async function fetchAll(table, columns, orderColumns) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns);
    orderColumns.forEach((column) => { query = query.order(column); });
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function loadState() {
  const [categories, links, recipes] = await Promise.all([
    fetchAll('categories', '*', ['id']),
    fetchAll('recipe_categories', '*', ['recipe_id', 'category_id']),
    fetchAll('recipes', 'id,title', ['id']),
  ]);
  return { categories, links, recipes };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------- Plan ----------

function checkConfig() {
  const targetKeys = new Set(CATEGORIES.map((category) => nameKey(category.name)));
  const sourceOwner = new Map();
  CATEGORIES.forEach((category) => {
    if (!MERGES[category.name]) throw new Error(`Cible absente de MERGES : ${category.name}`);
  });
  Object.entries(MERGES).forEach(([target, sources]) => {
    if (!targetKeys.has(nameKey(target))) throw new Error(`Cible inconnue dans MERGES : ${target}`);
    sources.forEach((source) => {
      if (sourceOwner.has(nameKey(source))) throw new Error(`Source listee deux fois : ${source}`);
      sourceOwner.set(nameKey(source), target);
    });
  });
  [...SPLIT, ...SUSPECT].forEach((name) => {
    const isSplit = SPLIT.includes(name);
    if (isSplit && (sourceOwner.has(nameKey(name)) || targetKeys.has(nameKey(name)))) {
      throw new Error(`Categorie a trancher aussi listee comme source ou cible : ${name}`);
    }
    if (!isSplit && !sourceOwner.has(nameKey(name))) throw new Error(`Categorie suspecte sans cible : ${name}`);
  });
}

// Decisions : [{ recipeId, from, to }] -> Map "recipeId|from" -> nom de cible
function indexDecisions(decisionList, targetByKey) {
  const decisions = new Map();
  const invalid = [];
  (decisionList || []).forEach((decision) => {
    const target = targetByKey.get(nameKey(decision.to));
    if (!decision.recipeId || !decision.from || !target) {
      invalid.push(decision);
      return;
    }
    decisions.set(`${decision.recipeId}|${nameKey(decision.from)}`, target);
  });
  if (invalid.length) {
    const sample = invalid.slice(0, 5).map((d) => `${d.title || d.recipeId} -> ${d.to}`).join(' ; ');
    throw new Error(`${invalid.length} decision(s) invalide(s) (cible inconnue ou champ manquant) : ${sample}`);
  }
  return decisions;
}

// Ce que l'application ferait sur l'etat `state`, sans rien ecrire.
function buildPlan(state, decisionList) {
  const { categories, links, recipes } = state;
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const categoryByKey = new Map();
  categories.forEach((category) => {
    const key = nameKey(category.name);
    const other = categoryByKey.get(key);
    if (other) throw new Error(`Deux categories ont le meme nom : « ${other.name} » et « ${category.name} »`);
    categoryByKey.set(key, category);
  });

  const linkCount = new Map();
  links.forEach((link) => linkCount.set(link.category_id, (linkCount.get(link.category_id) || 0) + 1));
  const countOf = (category) => linkCount.get(category.id) || 0;

  // Cibles : categorie gardee (meme nom), renommee (source la plus remplie) ou creee
  const targets = CATEGORIES.map((definition) => {
    const existing = categoryByKey.get(nameKey(definition.name)) || null;
    const found = MERGES[definition.name].map((name) => categoryByKey.get(nameKey(name))).filter(Boolean);
    const sources = found.filter((category) => category !== existing);
    let category = existing;
    let action = existing ? 'gardee' : 'creee';
    if (!existing && sources.length) {
      category = sources.reduce((best, candidate) => (countOf(candidate) > countOf(best) ? candidate : best));
      action = 'renommee';
    }
    const shown = existing && !found.includes(existing) ? [existing, ...found] : found;
    return {
      definition,
      category,
      action,
      sourcesFound: shown.map((source) => ({ name: source.name, recipes: countOf(source) })),
      merged: sources.filter((source) => source !== category),
    };
  });
  const targetByKey = new Map(targets.map((target) => [nameKey(target.definition.name), target]));

  const roleById = new Map();
  targets.forEach((target) => {
    if (target.category) roleById.set(target.category.id, { kind: 'target', target });
    target.merged.forEach((source) => roleById.set(source.id, { kind: 'source', target }));
  });
  SPLIT.forEach((name) => {
    const category = categoryByKey.get(nameKey(name));
    if (category) roleById.set(category.id, { kind: 'split' });
  });

  // Destination de chaque lien : decision, sinon cible de fusion, sinon en attente / inchange
  const decisions = indexDecisions(decisionList, targetByKey);
  const usedDecisions = new Set();
  const staying = [];
  const moving = [];
  const pending = [];
  links.forEach((link) => {
    const category = categoryById.get(link.category_id);
    const role = roleById.get(link.category_id);
    const decisionKey = `${link.recipe_id}|${nameKey(category?.name)}`;
    let target = decisions.get(decisionKey) || null;
    if (target) usedDecisions.add(decisionKey);
    else if (role && role.kind !== 'split') target = role.target;
    else if (role?.kind === 'split') pending.push(link);

    if (target && target.category?.id !== link.category_id) moving.push({ link, target });
    else staying.push({ link, target });
  });

  // Liens finaux : ceux qui restent, puis ceux deplaces (un lien deja present = doublon fusionne)
  const destinationKey = ({ link, target }) => `${link.recipe_id}|${target ? `t:${target.definition.name}` : `c:${link.category_id}`}`;
  const finalLinks = new Set(staying.map(destinationKey));
  const moves = moving.map((entry) => {
    const key = destinationKey(entry);
    const duplicate = finalLinks.has(key);
    finalLinks.add(key);
    return { recipeId: entry.link.recipe_id, fromId: entry.link.category_id, target: entry.target, duplicate };
  });

  const stats = new Map(targets.map((target) => [target, { moved: 0, duplicates: 0, total: 0 }]));
  moves.forEach((move) => {
    const stat = stats.get(move.target);
    if (move.duplicate) stat.duplicates += 1;
    else stat.moved += 1;
  });
  finalLinks.forEach((key) => {
    const destination = key.split('|')[1];
    if (destination.startsWith('t:')) stats.get(targetByKey.get(nameKey(destination.slice(2)))).total += 1;
  });

  // Categories a supprimer : sources fusionnees et categories tranchees, une fois vides
  const movedFrom = new Map();
  moves.forEach((move) => movedFrom.set(move.fromId, (movedFrom.get(move.fromId) || 0) + 1));
  const deletions = categories
    .filter((category) => ['source', 'split'].includes(roleById.get(category.id)?.kind))
    .map((category) => ({ category, remaining: countOf(category) - (movedFrom.get(category.id) || 0) }));

  const sameKeywords = (a, b) => JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(b);
  const updates = targets
    .filter((target) => target.category)
    .map((target) => ({
      target,
      name: target.category.name !== target.definition.name ? target.definition.name : undefined,
      keywords: sameKeywords(target.category.keywords, target.definition.keywords) ? undefined : target.definition.keywords,
    }))
    .filter((update) => update.name !== undefined || update.keywords !== undefined);
  const creations = targets.filter((target) => !target.category);
  const untouched = categories.filter((category) => !roleById.has(category.id));

  const recipesBefore = new Set(links.map((link) => link.recipe_id)).size;
  const recipesAfter = new Set([...finalLinks].map((key) => key.split('|')[0])).size;

  return {
    targets,
    stats,
    moves,
    pending,
    deletions,
    updates,
    creations,
    untouched,
    categoryById,
    roleById,
    decisionsUsed: usedDecisions.size,
    decisionsUnused: decisions.size - usedDecisions.size,
    recipesTotal: recipes.length,
    recipesBefore,
    recipesAfter,
    linksTotal: links.length,
    isEmpty: !moves.length && !pending.length && !deletions.length && !updates.length && !creations.length,
  };
}

// ---------- Affichage ----------

function printCategories(state) {
  const counts = new Map();
  state.links.forEach((link) => counts.set(link.category_id, (counts.get(link.category_id) || 0) + 1));
  const order = new Map(CATEGORIES.map((category, index) => [nameKey(category.name), index]));
  const rows = [...state.categories].sort((a, b) => (order.get(nameKey(a.name)) ?? 99) - (order.get(nameKey(b.name)) ?? 99)
    || a.name.localeCompare(b.name, 'fr'));
  console.log(`${state.categories.length} categories :`);
  rows.forEach((category) => {
    const flag = category.is_default ? '  (par defaut)' : '';
    const unknown = order.has(nameKey(category.name)) ? '' : '  (hors referentiel)';
    console.log(`  ${String(counts.get(category.id) || 0).padStart(4)}  ${category.name}${flag}${unknown}`);
  });
}

function printPlan(plan, state) {
  console.log(`${state.categories.length} categories, ${plan.recipesTotal} recettes, ${plan.linksTotal} liens en base\n`);

  if (plan.isEmpty) {
    console.log('Rien a faire : les categories sont deja dans l\'etat cible.\n');
    printCategories(state);
    return;
  }

  console.log(`${'Cible'.padEnd(30)} ${'Action'.padEnd(9)} ${'Deplaces'.padStart(8)} ${'Doublons'.padStart(8)} ${'Total'.padStart(6)}  Sources trouvees (recettes)`);
  plan.targets.forEach((target) => {
    const stat = plan.stats.get(target);
    const renamed = target.category && target.category.name !== target.definition.name ? `, « ${target.category.name} » renommee` : '';
    const sources = target.sourcesFound.map((source) => `${source.name} (${source.recipes})`).join(', ') || '-';
    console.log(`${target.definition.name.padEnd(30)} ${target.action.padEnd(9)} ${String(stat.moved).padStart(8)} ${String(stat.duplicates).padStart(8)} ${String(stat.total).padStart(6)}  ${sources}${renamed}`);
  });

  const keywordUpdates = plan.updates.filter((update) => update.keywords !== undefined).length;
  console.log(`\nMots-cles mis a jour : ${keywordUpdates} categorie(s) ; creations : ${plan.creations.length}`);

  const deletable = plan.deletions.filter((deletion) => deletion.remaining === 0);
  const blocked = plan.deletions.filter((deletion) => deletion.remaining > 0);
  console.log(`Categories supprimees (${deletable.length}) : ${deletable.map((d) => d.category.name).join(', ') || '-'}`);
  if (blocked.length) {
    console.log(`Suppressions bloquees, recettes sans decision : ${blocked.map((d) => `${d.category.name} (${d.remaining})`).join(', ')}`);
  }
  if (plan.untouched.length) {
    console.log(`Categories hors referentiel, non touchees : ${plan.untouched.map((category) => category.name).join(', ')}`);
  }

  console.log(`\nDecisions appliquees : ${plan.decisionsUsed} ; sans effet (deja appliquees ou recette absente) : ${plan.decisionsUnused} ; en attente : ${plan.pending.length}`);
  const same = plan.recipesBefore === plan.recipesAfter ? 'identique' : 'DIFFERENT';
  console.log(`Recettes avec au moins une categorie : avant ${plan.recipesBefore}, apres ${plan.recipesAfter} (${same})`);
  console.log(`Recettes sans aucune categorie : avant ${plan.recipesTotal - plan.recipesBefore}, apres ${plan.recipesTotal - plan.recipesAfter}`);
}

// ---------- Revue ----------

// Propositions du classement automatique pour les recettes a verifier.
function buildReview(state, plan) {
  const matchers = buildMatchers(CATEGORIES);
  const titleById = new Map(state.recipes.map((recipe) => [recipe.id, recipe.title]));
  const toDecideKeys = new Set([...SPLIT, DEFAULT_NAME].map(nameKey));
  const suspectKeys = new Set(SUSPECT.map(nameKey));
  const toDecide = [];
  const likelyMisfiled = [];
  const others = new Map();

  state.links.forEach((link) => {
    const category = plan.categoryById.get(link.category_id);
    const key = nameKey(category.name);
    const title = titleById.get(link.recipe_id) || '';
    const { category: proposedCategory, keyword } = classifyTitle(title, CATEGORIES, matchers);
    const target = plan.roleById.get(link.category_id)?.target?.definition.name || null;
    const item = { recipeId: link.recipe_id, title, from: category.name, proposed: proposedCategory.name, keyword };

    if (toDecideKeys.has(key)) {
      toDecide.push(item);
    } else if (suspectKeys.has(key)) {
      if (item.proposed !== target) likelyMisfiled.push({ ...item, target });
    } else if (target) {
      const group = others.get(category.name) || { category: category.name, target, recipes: 0, disagreements: [] };
      group.recipes += 1;
      if (item.proposed !== target) group.disagreements.push(item);
      others.set(category.name, group);
    }
  });

  const byFromThenTitle = (a, b) => a.from.localeCompare(b.from, 'fr') || a.title.localeCompare(b.title, 'fr');
  return {
    generatedAt: new Date().toISOString(),
    toDecide: toDecide.sort(byFromThenTitle),
    likelyMisfiled: likelyMisfiled.sort(byFromThenTitle),
    otherDisagreements: [...others.values()]
      .sort((a, b) => b.disagreements.length - a.disagreements.length || a.category.localeCompare(b.category, 'fr'))
      .map((group) => ({
        category: group.category,
        target: group.target,
        recipes: group.recipes,
        disagreements: group.disagreements.length,
        examples: group.disagreements
          .sort((a, b) => a.title.localeCompare(b.title, 'fr'))
          .slice(0, REVIEW_EXAMPLES)
          .map(({ recipeId, title, proposed, keyword }) => ({ recipeId, title, proposed, keyword })),
      })),
  };
}

function printReview(review) {
  const line = (item, extra = '') => `  - [${item.from}] ${item.title} -> ${item.proposed}${item.keyword ? ` (« ${item.keyword} »)` : ''}${extra}`;
  console.log(`\na) A trancher (${review.toDecide.length}) :`);
  review.toDecide.forEach((item) => console.log(line(item)));
  console.log(`\nb) Probablement mal rangees (${review.likelyMisfiled.length}) :`);
  review.likelyMisfiled.forEach((item) => console.log(line(item, `  [fusion : ${item.target}]`)));
  console.log('\nc) Desaccords dans les autres categories (fusion appliquee telle quelle) :');
  review.otherDisagreements.filter((group) => group.disagreements > 0).forEach((group) => {
    console.log(`  ${group.category} -> ${group.target} : ${group.disagreements}/${group.recipes}`);
    group.examples.forEach((example) => console.log(`      ${example.title} -> ${example.proposed}`));
  });
}

// Decisions du mode --auto : la proposition du classement pour les recettes a trancher
// et celles probablement mal rangees (sauf « Sans categorie » pour une recette qui a
// deja une categorie de plat), plus les recettes destinees a une categorie creee
// (sans source, comme Crozets), ou qu'elles soient rangees aujourd'hui.
function buildAutoDecisions(state, plan) {
  const review = buildReview(state, plan);
  const reviewed = [
    ...review.toDecide.filter((item) => nameKey(item.from) !== nameKey(DEFAULT_NAME) || item.proposed !== DEFAULT_NAME),
    ...review.likelyMisfiled.filter((item) => item.proposed !== DEFAULT_NAME),
  ];
  const reviewedKeys = new Set(reviewed.map((item) => `${item.recipeId}|${nameKey(item.from)}`));

  const createdNames = new Set(plan.creations.map((target) => target.definition.name));
  const matchers = buildMatchers(CATEGORIES);
  const titleById = new Map(state.recipes.map((recipe) => [recipe.id, recipe.title]));
  const toCreated = state.links
    .map((link) => {
      const title = titleById.get(link.recipe_id) || '';
      const from = plan.categoryById.get(link.category_id).name;
      return { recipeId: link.recipe_id, title, from, proposed: classifyTitle(title, CATEGORIES, matchers).category.name };
    })
    .filter((item) => createdNames.has(item.proposed) && !reviewedKeys.has(`${item.recipeId}|${nameKey(item.from)}`));

  return [...reviewed, ...toCreated].map(({ recipeId, title, from, proposed }) => ({ recipeId, title, from, to: proposed }));
}

// ---------- Ecriture ----------

function chunk(items, size = WRITE_CHUNK) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function writeBackup(state) {
  const base = path.join(BACKUP_DIR, `categories-${timestamp()}`);
  let file = `${base}.json`;
  for (let n = 2; fs.existsSync(file); n += 1) file = `${base}-${n}.json`;
  writeJson(file, {
    createdAt: new Date().toISOString(),
    supabaseUrl: process.env.SUPABASE_URL,
    categories: state.categories,
    recipe_categories: state.links,
  });
  return file;
}

async function applyPlan(state, plan) {
  if (plan.pending.length) {
    throw new Error(`${plan.pending.length} recette(s) attendent une decision : rien n'a ete ecrit. Lance --review, puis complete ${path.relative(process.cwd(), DECISIONS_FILE)}.`);
  }
  if (plan.isEmpty) {
    console.log('Rien a faire.');
    return;
  }

  // 1. Sauvegarde
  const backupFile = await writeBackup(state);
  console.log(`Sauvegarde : ${path.relative(process.cwd(), backupFile)}`);

  // 2. Fusion et decisions : cibles absentes creees, nouveaux liens ajoutes, puis anciens
  //    liens retires, pour qu'une recette ne soit jamais sans categorie.
  const targetId = new Map(plan.targets.filter((t) => t.category).map((t) => [t, t.category.id]));
  for (const target of plan.creations) {
    const { name, color, keywords, is_default: isDefault } = target.definition;
    const created = await run(supabase.from('categories').insert([{ name, color, keywords, is_default: isDefault }]).select('id').single());
    targetId.set(target, created.id);
    console.log(`Categorie creee : ${name}`);
  }

  const newLinks = [...new Map(plan.moves
    .filter((move) => !move.duplicate)
    .map((move) => [`${move.recipeId}|${targetId.get(move.target)}`, { recipe_id: move.recipeId, category_id: targetId.get(move.target) }]))
    .values()];
  for (const rows of chunk(newLinks)) {
    await run(supabase.from('recipe_categories').upsert(rows, { onConflict: 'recipe_id,category_id', ignoreDuplicates: true }));
  }

  const oldLinksByCategory = new Map();
  plan.moves.forEach((move) => {
    oldLinksByCategory.set(move.fromId, [...(oldLinksByCategory.get(move.fromId) || []), move.recipeId]);
  });
  for (const [categoryId, recipeIds] of oldLinksByCategory) {
    for (const ids of chunk(recipeIds)) {
      await run(supabase.from('recipe_categories').delete().eq('category_id', categoryId).in('recipe_id', ids));
    }
  }
  console.log(`Liens deplaces : ${newLinks.length}, doublons fusionnes : ${plan.moves.length - newLinks.length}`);

  // 3. Noms et mots-cles
  for (const update of plan.updates) {
    const changes = {};
    if (update.name !== undefined) changes.name = update.name;
    if (update.keywords !== undefined) changes.keywords = update.keywords;
    await run(supabase.from('categories').update(changes).eq('id', update.target.category.id));
  }
  console.log(`Categories mises a jour (nom ou mots-cles) : ${plan.updates.length}`);

  // 4. Categories devenues vides
  let deleted = 0;
  for (const { category } of plan.deletions) {
    const { count, error } = await supabase
      .from('recipe_categories')
      .select('recipe_id', { count: 'exact', head: true })
      .eq('category_id', category.id);
    if (error) throw error;
    if (count > 0 || category.is_default) {
      console.log(`Non supprimee, encore ${count} recette(s) : ${category.name}`);
      continue;
    }
    await run(supabase.from('categories').delete().eq('id', category.id));
    deleted += 1;
  }
  console.log(`Categories supprimees : ${deleted}`);
}

async function restore(file) {
  const backup = readJson(file);
  if (!Array.isArray(backup.categories) || !Array.isArray(backup.recipe_categories)) {
    throw new Error(`Sauvegarde invalide : ${file}`);
  }
  if (backup.supabaseUrl && backup.supabaseUrl !== process.env.SUPABASE_URL) {
    throw new Error('Cette sauvegarde vient d\'une autre base (SUPABASE_URL different) : rien n\'a ete ecrit.');
  }

  const state = await loadState();
  const linkKey = (link) => `${link.recipe_id}|${link.category_id}`;
  const recipeIds = new Set(state.recipes.map((recipe) => recipe.id));
  const backupCategoryIds = new Set(backup.categories.map((category) => category.id));
  const backupLinkKeys = new Set(backup.recipe_categories.map(linkKey));
  const currentLinkKeys = new Set(state.links.map(linkKey));

  // 1. Categories de la sauvegarde, a l'identique (les supprimees sont recreees avec leur id)
  for (const rows of chunk(backup.categories)) {
    await run(supabase.from('categories').upsert(rows, { onConflict: 'id' }));
  }

  // 2. Liens de la sauvegarde manquants (sauf recettes supprimees depuis), puis liens en trop
  const skipped = backup.recipe_categories.filter((link) => !recipeIds.has(link.recipe_id));
  const missing = backup.recipe_categories.filter((link) => recipeIds.has(link.recipe_id) && !currentLinkKeys.has(linkKey(link)));
  for (const rows of chunk(missing)) {
    await run(supabase.from('recipe_categories').upsert(rows, { onConflict: 'recipe_id,category_id', ignoreDuplicates: true }));
  }
  const extra = state.links.filter((link) => !backupLinkKeys.has(linkKey(link)));
  const extraByCategory = new Map();
  extra.forEach((link) => extraByCategory.set(link.category_id, [...(extraByCategory.get(link.category_id) || []), link.recipe_id]));
  for (const [categoryId, ids] of extraByCategory) {
    for (const part of chunk(ids)) {
      await run(supabase.from('recipe_categories').delete().eq('category_id', categoryId).in('recipe_id', part));
    }
  }

  // 3. Categories absentes de la sauvegarde
  const extraCategories = state.categories.filter((category) => !backupCategoryIds.has(category.id));
  for (const category of extraCategories) {
    await run(supabase.from('categories').delete().eq('id', category.id));
  }

  console.log(`Restaure depuis ${file} : ${backup.categories.length} categories, ${missing.length} liens remis, ${extra.length} liens retires, ${extraCategories.length} categories retirees.`);
  if (skipped.length) console.log(`${skipped.length} lien(s) ignore(s) : recettes supprimees depuis la sauvegarde.`);

  // Verification
  const after = await loadState();
  const byId = (a, b) => (a.id < b.id ? -1 : Number(a.id > b.id));
  const sameCategories = JSON.stringify([...after.categories].sort(byId)) === JSON.stringify([...backup.categories].sort(byId));
  const afterKeys = new Set(after.links.map(linkKey));
  const expectedKeys = backup.recipe_categories.filter((link) => recipeIds.has(link.recipe_id)).map(linkKey);
  const sameLinks = afterKeys.size === expectedKeys.length && expectedKeys.every((key) => afterKeys.has(key));
  console.log(`Verification : categories ${sameCategories ? 'identiques' : 'DIFFERENTES'}, liens ${sameLinks ? 'identiques' : 'DIFFERENTS'}.`);
}

// ---------- Lancement ----------

function parseArgs(argv) {
  const known = new Set(['--dry-run', '--review', '--apply', '--auto', '--restore']);
  const restoreIndex = argv.indexOf('--restore');
  const restoreFile = restoreIndex >= 0 ? argv[restoreIndex + 1] : null;
  const unknown = argv.filter((arg, index) => !known.has(arg) && !(restoreIndex >= 0 && index === restoreIndex + 1));
  if (unknown.length || (restoreIndex >= 0 && !restoreFile)) {
    throw new Error('Usage : migrateCategories.js [--dry-run | --review | --apply] [--auto] | --restore <fichier>');
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('--apply et --dry-run sont incompatibles');
  return {
    apply: argv.includes('--apply'),
    review: argv.includes('--review'),
    auto: argv.includes('--auto'),
    restoreFile,
  };
}

async function loadDecisions(options, state) {
  if (options.auto) {
    const decisions = buildAutoDecisions(state, buildPlan(state, []));
    console.log(`Mode --auto : ${decisions.length} decision(s) prises par le classement automatique.\n`);
    return decisions;
  }
  if (!fs.existsSync(DECISIONS_FILE)) return [];
  return readJson(DECISIONS_FILE).decisions || [];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  checkConfig();

  if (options.restoreFile) {
    await restore(path.resolve(options.restoreFile));
    return;
  }

  const state = await loadState();
  const decisions = await loadDecisions(options, state);
  const plan = buildPlan(state, decisions);

  if (!options.apply) {
    console.log('Simulation : rien n\'est ecrit en base.\n');
    printPlan(plan, state);
    if (options.review) {
      const review = buildReview(state, plan);
      writeJson(REVIEW_FILE, review);
      printReview(review);
      console.log(`\nListe de revue : ${path.relative(process.cwd(), REVIEW_FILE)}`);
    }
    if (options.auto) console.log('\nAjoute --apply pour appliquer ces decisions.');
    return;
  }

  await applyPlan(state, plan);

  console.log('\nNouvelle simulation apres application :\n');
  const after = await loadState();
  printPlan(buildPlan(after, decisions), after);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur migrateCategories:', error.message || error);
    process.exit(1);
  });
