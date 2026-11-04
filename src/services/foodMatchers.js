// Accès aux aliments pour l'analyse des ingrédients. Deux implémentations avec
// la même interface :
//   - createDbMatcher(supabase) : tables foods / food_aliases et fonction SQL
//     match_food() ; utilisé par l'API et par analyzeRecipes.js --apply ;
//   - createLocalMatcher({ foods, aliases }) : tout en mémoire (fichiers Ciqual
//     et food-aliases.json) ; utilisé par les simulations, sans rien lire ni
//     écrire en base.
//
// Interface :
//   findAlias(alias)        → id d'aliment ou null (alias exact, nom normalisé)
//   searchCandidates(name)  → [{ food_id, name, score }] comme match_food()
//   getFoods(ids)           → Map id → aliment (valeurs, indicateurs, poids)
//   invalidate()            → oublie les caches (après création d'un alias)
const { normalizeFoodName } = require('./foodName');

const FOOD_COLUMNS = [
  'id', 'name', 'subgroup_name',
  'energy_kcal', 'proteins_g', 'carbs_g', 'sugars_g', 'fat_g', 'fibers_g', 'salt_g',
  'is_meat', 'is_fish', 'is_egg', 'is_dairy', 'is_other_animal', 'is_plant_protein', 'has_gluten',
  'unit_weights', 'density',
];
const CACHE_TTL_MS = 60 * 1000;
const PAGE_SIZE = 1000;
const IN_CHUNK = 100;

// ---------- Base de données ----------

function createDbMatcher(supabase) {
  let aliases = null;
  let aliasesLoadedAt = 0;
  const candidates = new Map(); // nom → { at, rows }
  const foods = new Map();

  async function loadAliases() {
    const map = new Map();
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('food_aliases')
        .select('alias,food_id')
        .order('alias')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      (data || []).forEach((row) => map.set(row.alias, row.food_id));
      if (!data || data.length < PAGE_SIZE) break;
    }
    aliases = map;
    aliasesLoadedAt = Date.now();
  }

  return {
    async findAlias(alias) {
      if (!alias) return null;
      if (!aliases || Date.now() - aliasesLoadedAt > CACHE_TTL_MS) await loadAliases();
      return aliases.get(alias) ?? null;
    },

    async searchCandidates(name) {
      if (!name) return [];
      const cached = candidates.get(name);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;
      const { data, error } = await supabase.rpc('match_food', { p_name: name });
      if (error) throw error;
      const rows = (data || []).map((row) => ({ food_id: row.food_id, name: row.name, score: Number(row.score) }));
      candidates.set(name, { at: Date.now(), rows });
      return rows;
    },

    async getFoods(ids) {
      const missing = [...new Set(ids)].filter((id) => id && !foods.has(id));
      for (let start = 0; start < missing.length; start += IN_CHUNK) {
        const { data, error } = await supabase
          .from('foods')
          .select(FOOD_COLUMNS.join(','))
          .in('id', missing.slice(start, start + IN_CHUNK));
        if (error) throw error;
        (data || []).forEach((food) => foods.set(food.id, food));
      }
      return new Map(ids.filter((id) => foods.has(id)).map((id) => [id, foods.get(id)]));
    },

    invalidate() {
      aliases = null;
      candidates.clear();
    },
  };
}

// ---------- Similarité trigram (même calcul que pg_trgm) ----------
// Chaque mot est entouré de deux espaces devant et d'un derrière, puis découpé
// en groupes de 3 caractères. pg_trgm calcule en float4 et match_food arrondit
// à 3 décimales : on reproduit les deux pour obtenir les mêmes scores.

const f32 = Math.fround;

function wordTrigrams(word) {
  const padded = `  ${word} `;
  const out = [];
  for (let i = 0; i < padded.length - 2; i += 1) out.push(padded.slice(i, i + 3));
  return out;
}

function words(text) {
  return String(text).split(/[^a-z0-9]+/).filter(Boolean);
}

function prepareTrigrams(text) {
  const positional = [];
  const bounds = []; // 1 = début de mot, 2 = fin de mot
  for (const word of words(text)) {
    const trigrams = wordTrigrams(word);
    trigrams.forEach((trigram, index) => {
      positional.push(trigram);
      bounds.push((index === 0 ? 1 : 0) | (index === trigrams.length - 1 ? 2 : 0));
    });
  }
  return { set: new Set(positional), positional, bounds };
}

// similarity() de pg_trgm
function similarity(a, b) {
  if (!a.set.size || !b.set.size) return 0;
  let shared = 0;
  for (const trigram of a.set) if (b.set.has(trigram)) shared += 1;
  return f32(shared / (a.set.size + b.set.size - shared));
}

// strict_word_similarity() de pg_trgm (iterate_word_similarity, mode strict)
function strictWordSimilarity(needle, haystack) {
  const ulen1 = needle.set.size;
  const len2 = haystack.positional.length;
  if (!ulen1 || !len2) return 0;

  const ids = new Map();
  const index = haystack.positional.map((trigram) => {
    if (!ids.has(trigram)) ids.set(trigram, ids.size);
    return ids.get(trigram);
  });
  const found = [];
  for (const [trigram, id] of ids) found[id] = needle.set.has(trigram);

  const lastpos = new Array(ids.size).fill(-1);
  const calc = (count, ulen2) => f32(count / (ulen1 + ulen2 - count));
  let ulen2 = 0;
  let count = 0;
  let lower = 0; // en mode strict, pg_trgm part du premier trigramme
  let max = 0;

  for (let i = 0; i < len2; i += 1) {
    const id = index[i];
    if (lastpos[id] < 0) {
      ulen2 += 1;
      if (found[id]) count += 1;
    }
    lastpos[id] = i;

    if (!(haystack.bounds[i] & 2)) continue;

    const upper = i;
    let current = calc(count, ulen2);
    let tmpCount = count;
    let tmpUlen2 = ulen2;
    const prevLower = lower;
    for (let tmpLower = lower; tmpLower <= upper; tmpLower += 1) {
      if (haystack.bounds[tmpLower] & 1) {
        const candidate = calc(tmpCount, tmpUlen2);
        if (candidate > current) {
          current = candidate;
          ulen2 = tmpUlen2;
          lower = tmpLower;
          count = tmpCount;
        }
      }
      const tmpId = index[tmpLower];
      if (lastpos[tmpId] === tmpLower) {
        tmpUlen2 -= 1;
        if (found[tmpId]) tmpCount -= 1;
      }
    }
    max = Math.max(max, current);
    for (let tmpLower = prevLower; tmpLower < lower; tmpLower += 1) {
      const tmpId = index[tmpLower];
      if (lastpos[tmpId] === tmpLower) lastpos[tmpId] = -1;
    }
  }
  return max;
}

// float4 → numeric (6 chiffres significatifs) puis round(..., 3)
function toMatchScore(value) {
  const numeric = Number(f32(value).toPrecision(6));
  return Math.round(numeric * 1000 + 1e-9) / 1000;
}

function matchScore(needle, haystack) {
  return f32(f32(strictWordSimilarity(needle, haystack) + similarity(needle, haystack)) / 2);
}

// ---------- En mémoire ----------

// foods : lignes au format de la table foods (avec id) ; aliases : Map alias → id
function createLocalMatcher({ foods, aliases }) {
  const byId = new Map(foods.map((food) => [food.id, food]));
  const foodTargets = foods.map((food) => ({ id: food.id, trigrams: prepareTrigrams(normalizeFoodName(food.name)) }));
  const aliasTargets = [...aliases].map(([alias, id]) => ({ id, trigrams: prepareTrigrams(alias) }));
  const cache = new Map();

  return {
    async findAlias(alias) {
      return aliases.get(alias) ?? null;
    },

    async searchCandidates(name) {
      const needleText = String(name ?? '').toLowerCase().trim();
      if (!needleText) return [];
      if (cache.has(needleText)) return cache.get(needleText);
      const needle = prepareTrigrams(needleText);
      const best = new Map();
      for (const target of [...foodTargets, ...aliasTargets]) {
        const score = matchScore(needle, target.trigrams);
        if (score > (best.get(target.id) ?? -1)) best.set(target.id, score);
      }
      const rows = [...best]
        .filter(([, score]) => score > 0)
        .sort((a, b) => b[1] - a[1] || byId.get(a[0]).name.length - byId.get(b[0]).name.length)
        .slice(0, 5)
        .map(([id, score]) => ({ food_id: id, name: byId.get(id).name, score: toMatchScore(score) }));
      cache.set(needleText, rows);
      return rows;
    },

    async getFoods(ids) {
      return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)]));
    },

    invalidate() {
      cache.clear();
    },
  };
}

module.exports = {
  createDbMatcher,
  createLocalMatcher,
  FOOD_COLUMNS,
  // exportés pour la vérification croisée avec pg_trgm
  prepareTrigrams,
  similarity,
  strictWordSimilarity,
  toMatchScore,
};
