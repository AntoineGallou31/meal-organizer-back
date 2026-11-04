// Analyse des ingrédients d'une recette : quantité, unité, aliment Ciqual,
// grammes, puis valeurs nutritionnelles et régimes.
//
// recipes.ingredients (texte d'origine) n'est jamais modifié. Le résultat va
// dans recipe_ingredients (une ligne par ingrédient) et dans recipes.nutrition,
// recipes.diet_tags et recipes.main_protein. Tout est recalculable.
const { normalizeFoodName } = require('./foodName');
const { createDbMatcher } = require('./foodMatchers');

// Score minimal d'un candidat de match_food() pour être retenu
const MATCH_THRESHOLD = 0.45;
// Entre candidats à moins de cet écart du meilleur, on préfère l'aliment cru
const RAW_PREFERENCE_MARGIN = 0.05;
const SMALL_SPICE_GRAMS = 5;
const MIN_PROTEIN_PER_SERVING = 10;

// ---------- 1. parseIngredientLine ----------

const UNICODE_FRACTIONS = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 1 / 5, '⅖': 2 / 5,
  '⅗': 3 / 5, '⅘': 4 / 5, '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};
const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

const NUMBER_WORDS = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  dix: 10, douze: 12, quinze: 15, vingt: 20,
};

const NUM = String.raw`\d+(?:[.,]\d+)?`;

// Unités reconnues juste après la quantité, testées dans l'ordre.
// Le texte est déjà en minuscules et sans accents.
const UNIT_PATTERNS = [
  ['cas', /^cuil+(?:eree|ere|er)?s?\.?\s*(?:a\s*)?(?:soupe|s\.?)(?![a-z])/],
  ['cac', /^cuil+(?:eree|ere|er)?s?\.?\s*(?:a\s*)?(?:cafe|the|c\.?)(?![a-z])/],
  ['cas', /^c\.?\s*(?:a\s*\.?\s*)?s(?:oupe)?\.?(?![a-z])/],
  ['cac', /^c\.?\s*(?:a\s*\.?\s*)?(?:c(?:afe)?|the)\.?(?![a-z])/],
  ['cas', /^(?:tbsp|tablespoons?)(?![a-z])/],
  ['cac', /^(?:tsp|teaspoons?)(?![a-z])/],
  ['kg', /^(?:kg|kilos?|kilogrammes?)(?![a-z'])/],
  ['mg', /^mg(?![a-z'])/],
  ['g', /^(?:grammes?|grs?|g)\.?(?![a-z'])/],
  ['ml', /^(?:ml|millilitres?)(?![a-z'])/],
  ['cl', /^(?:cl|centilitres?)(?![a-z'])/],
  ['dl', /^(?:dl|decilitres?)(?![a-z'])/],
  ['l', /^(?:litres?|l)(?![a-z'])/],
  ['pincee', /^(?:pincees?|pointes?)(?![a-z])/],
  ['sachet', /^sachets?(?![a-z])/],
  ['gousse', /^gousses?(?![a-z])/],
  ['tranche', /^tranches?(?![a-z])/],
  ['rouleau', /^rouleaux?(?![a-z])/],
  ['boite', /^(?:boites?|conserves?)(?![a-z])/],
  ['botte', /^(?:bottes?|bouquets?)(?![a-z])/],
  ['brin', /^(?:brins?|branches?)(?![a-z])/],
  ['feuille', /^feuilles?(?![a-z])/],
  ['verre', /^(?:verres?|tasses?|cups?)(?![a-z])/],
  ['poignee', /^poignees?(?![a-z])/],
  ['unite', /^(?:unites?|pieces?)(?![a-z])/],
];
const WEIGHT_IN_PARENTHESES = new RegExp(`(${NUM})\\s*(kg|kilos?|mg|grammes?|grs?|g|ml|cl|dl|litres?|l)\\.?(?![a-z])`);

// Adjectifs de taille avant l'unité ou le nom : « 2 grosses cuillères », « 1 petit oignon »
const SIZE_WORDS = /^(?:(?:petite?s?|grosse?s?|gros|grande?s?|bonne?s?|belle?s?|beaux?|bel|moyenne?s?|bien)\s+(?!(?:pois|suisses?|epeautre)\b))+/;
// Après une cuillère : « rase », « bombée »...
const SPOON_WORDS = /^(?:(?:rases?|bombees?|pleines?|bien|genereuses?|bonnes?)\s+)+/;
// Contenants sans poids connu : la quantité reste un nombre d'unités
const CONTAINERS = /^(?:morceaux?|cubes?|carres?|pots?|briques?|barquettes?|paquets?|bocal|bocaux)\s+(?:de\s+|d'|du\s+|des\s+)?/;
// « un filet d'huile » : pas de quantité utilisable
const DRIZZLE = /^filets?\s+(?:de\s+|d')?(?=(?:huile|vinaigre|citron|jus|creme|lait|miel|sauce|sirop))/;
const LEADING_DE = /^(?:de la |de l'|d'|de |du |des )/;
const LEADING_ARTICLE = /^(?:le |la |les |l')/;

// Fin de nom à couper : « huile pour la cuisson », « roquefort selon goût »...
const TAIL = /\b(?:pour|selon|suivant|au choix|a votre convenance|a convenance|facultatif|facultative|optionnel|optionnelle|si possible|si besoin|de preference|environ|quantite|type|facon|a temperature ambiante|a defaut)\b.*$/;
// Expressions à garder entières même si elles contiennent un qualificatif
const PROTECTED = [
  'petits? pois', 'petits? suisses?', 'petit epeautre', 'cremes? fraiches?', 'fromages? frais',
  'levures? fraiches?', 'chevres? frais', 'pates fraiches', 'fromages? rapes?', 'emmental rape',
  'gruyere rape', 'lait entier', 'cremes? entieres?', 'jambons? crus?', 'patates? douces?',
  'tomates? concassees?', 'tomates? pelees?', 'boeuf hache', 'viande hachee', 'steaks? haches?',
  'fines herbes', 'piment doux', 'gros sel',
].map((pattern) => new RegExp(`\\b${pattern}\\b`, 'g'));
const QUALIFIER_PHRASES = /\b(?:en (?:petits |gros |fines |fins )?(?:des|cubes|morceaux|rondelles|lamelles|tranches|julienne|quartiers|batonnets|copeaux|petits morceaux|deux|2|quatre|4|huit|8)|au naturel|de taille moyenne|de bonne qualite|bien mures?|a temperature ambiante)\b/g;
const QUALIFIER_WORDS = new Set(`
  frais fraiche fraiches hache hachee haches hachees emince emincee eminces emincees
  cisele ciselee ciseles ciselees concasse concassee concasses concassees rape rapee rapes rapees
  coupe coupee coupes coupees epluche epluchee epluches epluchees pele pelee peles pelees
  egoutte egouttee egouttes egouttees decortique decortiquee decortiques decortiquees
  fondu fondue fondus fondues mou molle molles pommade ramolli ramollie ramollis ramollies
  tiede tiedes froid froide froids froides chaud chaude chauds chaudes bouillant bouillante
  gros grosse grosses petit petite petits petites grand grande grands grandes moyen moyenne
  moyens moyennes beau belle belles bel bio entier entiere entiers entieres extra
  fin fine fins fines finement grossierement rase rases bombee bombees lave lavee laves lavees
  mixe mixee mixes mixees cru crue crus crues doux douce douces maison nature naturel
  rond ronde ronds rondes rectangulaire rectangulaires mur mure murs mures bien tres
  denoyaute denoyautee denoyautes denoyautees tranche tranchee tranches tranchees
`.trim().split(/\s+/));

function formatNumber(value) {
  return String(Math.round(value * 1000) / 1000);
}

function parseNumber(text) {
  const value = Number(String(text).replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

// Texte de travail : minuscules, sans accents, apostrophes droites, fractions en décimales
function prepare(raw) {
  return String(raw ?? '')
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/œ/g, 'oe').replace(/Œ/g, 'Oe').replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(new RegExp(`(\\d+)?\\s*([${FRACTION_CHARS}])`, 'g'),
      (_, whole, fraction) => ` ${formatNumber((whole ? Number(whole) : 0) + UNICODE_FRACTIONS[fraction])} `)
    .replace(/(\d+)\s+(\d+)\s*\/\s*(\d+)/g,
      (match, whole, num, den) => (Number(den) ? ` ${formatNumber(Number(whole) + Number(num) / Number(den))} ` : match))
    .replace(/(\d+)\s*\/\s*(\d+)/g, (match, num, den) => (Number(den) ? ` ${formatNumber(Number(num) / Number(den))} ` : match))
    .replace(/\s+/g, ' ')
    .trim();
}

// Retire toutes les parenthèses (même imbriquées) ; garde le premier poids ou volume trouvé
function extractParentheses(text) {
  let weight = null;
  let current = text;
  let previous;
  do {
    previous = current;
    current = current.replace(/\(([^()]*)\)/g, (_, inner) => {
      const found = !weight && inner.match(WEIGHT_IN_PARENTHESES);
      if (found) weight = { quantity: parseNumber(found[1]), unit: unitCode(found[2]) };
      return ' ';
    });
  } while (current !== previous);
  return { text: current.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim(), weight };
}

function unitCode(text) {
  const match = UNIT_PATTERNS.find(([, pattern]) => pattern.test(text));
  return match ? match[0] : null;
}

function readUnit(text) {
  for (const [code, pattern] of UNIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { code, rest: text.slice(match[0].length).trim() };
  }
  return null;
}

function removeQualifiers(name) {
  let text = name.replace(QUALIFIER_PHRASES, ' ');
  PROTECTED.forEach((pattern) => { text = text.replace(pattern, (match) => match.replace(/ /g, '_')); });
  const kept = text.split(/\s+/).filter((word) => word && !QUALIFIER_WORDS.has(word));
  return kept.join(' ').replace(/_/g, ' ')
    .replace(/^(?:(?:de|d|du|des|la|le|les|l)\s+)+/, '')
    .replace(/(?:\s+(?:de|d|du|des|et|a|au|aux|en))+$/, '')
    .trim();
}

const SALT_PEPPER_WORDS = new Set(`
  sel poivre poivres fin fine gros fleur de du d noir blanc gris moulin et guerande mignonnette
  concasse baies 5 cinq au gout gouts marin camargue ou un peu a l selon les vos votre
`.trim().split(/\s+/));

function isSaltOrPepper(text) {
  const words = text.split(' ').filter(Boolean);
  return words.some((word) => word === 'sel' || word === 'poivre' || word === 'poivres')
    && words.every((word) => SALT_PEPPER_WORDS.has(word));
}

function isAlwaysIgnoredName(name, wholeText) {
  if (isSaltOrPepper(name) || isSaltOrPepper(wholeText)) return true;
  if (/^eau(?: (?:gazeuse|petillante|minerale|du robinet|plate|filtree|glacee|bouillante))?$/.test(name)) return true;
  if (/^(?:glacons?|glace pilee|glace)$/.test(name)) return true;
  if (/\b(?:arome|aromes|extrait|extraits|essence|colorant|colorants)\b/.test(name)) return true;
  if (/\b(?:fleur d oranger|eau de rose)\b/.test(name)) return true;
  return false;
}

// → { quantity, unit, name, fullName, ignored }
//   name : nom normalisé, sans qualificatifs ; fullName : avant retrait des qualificatifs
//   ignored : sel, poivre, eau, glaçons, arômes et extraits, ou ligne sans nom
function parseIngredientLine(text) {
  const { text: prepared, weight } = extractParentheses(prepare(text));
  let rest = prepared;
  let quantity = null;
  let unit = null;

  const leading = rest.match(new RegExp(`^(${NUM})(?:\\s*(?:-|–|a|ou)\\s*(${NUM}))?(?![\\d.,])\\s*`));
  if (leading) {
    const low = parseNumber(leading[1]);
    const high = leading[2] ? parseNumber(leading[2]) : null;
    quantity = high !== null ? (low + high) / 2 : low;
    rest = rest.slice(leading[0].length);
  } else {
    const word = rest.match(/^([a-z]+)\s+/);
    if (word && NUMBER_WORDS[word[1]] !== undefined) {
      quantity = NUMBER_WORDS[word[1]];
      rest = rest.slice(word[0].length);
    }
  }
  if (quantity !== null) {
    const half = rest.match(/^demie?\s*-?\s*/);
    if (half) {
      quantity *= 0.5;
      rest = rest.slice(half[0].length);
    }
    const dozen = rest.match(/^(dizaines?|douzaines?)\s+(?:de\s+|d')?/);
    if (dozen) {
      quantity *= dozen[1].startsWith('diz') ? 10 : 12;
      rest = rest.slice(dozen[0].length);
    }
    rest = rest.replace(SIZE_WORDS, '');
  }

  // Unités anglo-saxonnes, converties en grammes
  const imperial = quantity !== null && rest.match(/^(lbs?|livres?|pounds?|oz|onces?|ounces?)\.?\s+(?:de\s+|d'|of\s+)?/);
  const readU = imperial ? null : readUnit(rest);
  if (imperial) {
    quantity *= /^(?:lb|livre|pound)/.test(imperial[1]) ? 453.6 : 28.35;
    unit = 'g';
    rest = rest.slice(imperial[0].length);
  } else if (readU && (quantity !== null || readU.code !== 'unite')) {
    unit = readU.code;
    rest = readU.rest.replace(SPOON_WORDS, '');
    if (quantity === null) quantity = 1; // « cuillère à soupe de sucre »
  } else if (quantity !== null && CONTAINERS.test(rest)) {
    unit = 'unite';
    rest = rest.replace(CONTAINERS, '');
  } else if (DRIZZLE.test(rest)) {
    quantity = null;
    rest = rest.replace(DRIZZLE, '');
  } else if (quantity !== null) {
    unit = 'unite';
  }

  // Quantité en fin de ligne : « Farine : 200 g », « beurre 50g »
  if (quantity === null) {
    const trailing = rest.match(new RegExp(`[\\s:]+(${NUM})\\s*(kg|g|grs?|grammes?|mg|ml|cl|dl|l|litres?)\\.?\\s*$`));
    if (trailing) {
      quantity = parseNumber(trailing[1]);
      unit = unitCode(trailing[2]);
      rest = rest.slice(0, trailing.index);
    }
  }

  rest = rest.replace(LEADING_DE, '');
  if (quantity === null) rest = rest.replace(LEADING_ARTICLE, '').replace(LEADING_DE, '');
  // Mesure américaine restée dans le nom : « 1 conserve de 14 oz de tomates »
  rest = rest.replace(new RegExp(`^${NUM}\\s*(?:oz|onces?|lbs?|livres?)\\s+(?:de\\s+|d')?`), '');

  const whole = normalizeFoodName(rest).replace(TAIL, '').trim();
  const firstPart = rest.split(/[,;:]| ou | \/ /)[0];
  const fullName = normalizeFoodName(firstPart).replace(TAIL, '').trim() || whole;
  const name = removeQualifiers(fullName) || fullName;

  if (weight && weight.quantity !== null && weight.unit) {
    quantity = weight.quantity;
    unit = weight.unit;
  }

  return {
    quantity,
    unit: quantity === null ? null : unit,
    name,
    fullName,
    ignored: !name || isAlwaysIgnoredName(name, whole),
  };
}

// ---------- 2. matchFood ----------

// Mots qui gardent leur « s » ou leur « x » au singulier
const INVARIABLE = new Set(`
  pois riz noix jus mais paris radis anis ananas cassis brebis gras frais epais bas dos os ris
  cervelas chasselas lys pastis couscous colis tapas gros doux roux faux houx prix croix jacques
  anchois tous plus sans sous
`.trim().split(/\s+/));

function singularize(name) {
  return String(name ?? '').split(' ').map((word) => {
    if (word.length <= 3 || INVARIABLE.has(word)) return word;
    if (/(?:eau|ou|au)x$/.test(word)) return word.slice(0, -1);
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  }).join(' ');
}

// « Cru » au sens large : pour les herbes, l'état brut est « frais »
const RAW_WORD = /\b(?:cru|crue|crus|crues|frais|fraiche|fraiches)\b/;

let defaultMatcher = null;
function getDefaultMatcher() {
  if (!defaultMatcher) defaultMatcher = createDbMatcher(require('./supabase'));
  return defaultMatcher;
}

// → { foodId, foodName, score, method: 'alias' | 'similarity' | null, best }
//   best : meilleur candidat, même sous le seuil (pour les rapports)
async function matchFood(name, { matcher = getDefaultMatcher(), fullName = null } = {}) {
  const normalized = normalizeFoodName(name);
  if (!normalized) return { foodId: null, foodName: null, score: null, method: null, best: null };

  // Alias exact : le nom complet d'abord (« levure fraiche »), puis sans qualificatifs
  const forms = [...new Set([fullName, fullName && singularize(fullName), normalized, singularize(normalized)]
    .filter(Boolean))];
  for (const form of forms) {
    const foodId = await matcher.findAlias(form);
    if (foodId) return { foodId, foodName: null, score: 1, method: 'alias', best: null };
  }

  const searches = [...new Set([normalized, singularize(normalized)])];
  const merged = new Map();
  for (const form of searches) {
    for (const candidate of await matcher.searchCandidates(form)) {
      const previous = merged.get(candidate.food_id);
      if (!previous || candidate.score > previous.score) merged.set(candidate.food_id, candidate);
    }
  }
  const candidates = [...merged.values()].sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  const best = candidates[0] || null;
  if (!best || best.score < MATCH_THRESHOLD) {
    return { foodId: null, foodName: null, score: best ? best.score : null, method: null, best };
  }

  const raw = candidates.find((candidate) => candidate.score >= best.score - RAW_PREFERENCE_MARGIN
    && RAW_WORD.test(normalizeFoodName(candidate.name)));
  const chosen = raw || best;
  return { foodId: chosen.food_id, foodName: chosen.name, score: chosen.score, method: 'similarity', best };
}

// ---------- 3. toGrams ----------

const MASS_IN_GRAMS = { g: 1, kg: 1000, mg: 0.001, pincee: 0.5 };
const VOLUME_IN_ML = { ml: 1, cl: 10, dl: 100, l: 1000, cas: 15, cac: 5, verre: 200 };

function toGrams(quantity, unit, food) {
  if (quantity === null || quantity === undefined || !unit) return null;
  const amount = Number(quantity);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (MASS_IN_GRAMS[unit] !== undefined) return amount * MASS_IN_GRAMS[unit];
  if (VOLUME_IN_ML[unit] !== undefined) {
    const density = Number(food?.density);
    return amount * VOLUME_IN_ML[unit] * (Number.isFinite(density) && density > 0 ? density : 1);
  }
  const perUnit = Number(food?.unit_weights?.[unit]);
  return Number.isFinite(perUnit) && perUnit > 0 ? amount * perUnit : null;
}

// ---------- 4. Lignes ignorées ----------

const HERB_SPICE = new RegExp(`\\b(?:${[
  'vanille', 'cannelle', 'cumin', 'curry', 'curcuma', 'paprika', 'piment', 'muscade', 'cardamome',
  'girofle', 'badiane', 'anis', 'safran', 'ras el hanout', 'quatre epices', '4 epices', 'cinq epices',
  '5 epices', 'garam masala', 'herbes?', 'thym', 'romarin', 'laurier', 'persil', 'ciboulette',
  'basilic', 'coriandre', 'menthe', 'aneth', 'estragon', 'sauge', 'origan', 'marjolaine', 'sarriette',
  'cerfeuil', 'carvi', 'fenugrec', 'sumac', 'zaatar', 'gingembre', 'epices?', 'nigelle', 'genievre',
  'cayenne', 'espelette', 'tandoori', 'colombo', 'graines? de (?:fenouil|cumin|coriandre|moutarde|pavot)',
  'baies? roses?',
].join('|')})\\b`);
const HERB_SPICE_SUBGROUPS = new Set(['épices', 'herbes']);

function isHerbOrSpice(name, food) {
  return HERB_SPICE.test(name || '') || HERB_SPICE_SUBGROUPS.has(food?.subgroup_name);
}

// ---------- 5. analyzeRecipe ----------

const NUTRIENTS = {
  kcal: 'energy_kcal',
  proteins_g: 'proteins_g',
  carbs_g: 'carbs_g',
  sugars_g: 'sugars_g',
  fat_g: 'fat_g',
  fibers_g: 'fibers_g',
  salt_g: 'salt_g',
};

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

function roundNutrients(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value, key === 'kcal' ? 0 : 1)]));
}

function parseServings(servings) {
  const value = Number.parseInt(String(servings ?? ''), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Ligne décidée à la main (PUT .../ingredients/:position) : à garder telle quelle
function isManualRow(row) {
  return row.status === 'checked' || (row.status === 'ignored' && row.match_method === 'manual');
}

const ROW_FIELDS = ['position', 'raw_text', 'quantity', 'unit', 'name', 'food_id', 'match_method', 'match_score', 'grams', 'status'];
const pickRow = (row) => Object.fromEntries(ROW_FIELDS.map((field) => [field, row[field] ?? null]));

function summarize(rows, foods, servings) {
  const active = rows.filter((row) => row.status !== 'ignored');
  if (!active.length) return { nutrition: null, dietTags: [], mainProtein: null };

  const foodOf = (row) => (row.food_id ? foods.get(row.food_id) : null);
  const totals = Object.fromEntries(Object.keys(NUTRIENTS).map((key) => [key, 0]));
  for (const row of active) {
    const food = foodOf(row);
    if (!food || row.grams === null) continue;
    for (const [key, column] of Object.entries(NUTRIENTS)) {
      const per100 = Number(food[column]);
      if (food[column] !== null && Number.isFinite(per100)) totals[key] += (row.grams * per100) / 100;
    }
  }

  const servingsCount = parseServings(servings);
  const withGrams = active.filter((row) => row.grams !== null).length;
  const recognized = active.filter((row) => foodOf(row)).length;
  const nutrition = {
    total: roundNutrients(totals),
    per_serving: servingsCount
      ? roundNutrients(Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / servingsCount])))
      : null,
    coverage: round(withGrams / active.length, 2),
    recognized: round(recognized / active.length, 2),
    computed_at: new Date().toISOString(),
  };

  // Régimes
  const has = (flag) => active.some((row) => foodOf(row)?.[flag]);
  const dietTags = [];
  if (has('is_meat')) dietTags.push('viande');
  if (has('is_fish')) dietTags.push('poisson');
  // Étiquettes d'absence : seulement si chaque ligne est sûre (alias exact ou corrigée à la main)
  const certain = active.every((row) => foodOf(row) && (row.status === 'checked' || row.match_method === 'alias'));
  if (certain) {
    const vegetarian = !has('is_meat') && !has('is_fish');
    if (vegetarian) dietTags.push('vegetarien');
    if (vegetarian && !has('is_egg') && !has('is_dairy') && !has('is_other_animal')) dietTags.push('vegan');
    if (!has('has_gluten')) dietTags.push('sans-gluten');
    if (!has('is_dairy')) dietTags.push('sans-lactose');
  }

  // Protéine principale : il faut l'aliment et les grammes de chaque ligne
  let mainProtein = null;
  if (servingsCount && active.every((row) => foodOf(row) && row.grams !== null)) {
    const bySource = { animale: 0, 'oeufs-laitiers': 0, vegetale: 0 };
    let protein = 0;
    for (const row of active) {
      const food = foodOf(row);
      const grams = (row.grams * (Number(food.proteins_g) || 0)) / 100;
      protein += grams;
      const source = food.is_meat || food.is_fish ? 'animale'
        : (food.is_egg || food.is_dairy ? 'oeufs-laitiers' : (food.is_plant_protein ? 'vegetale' : null));
      if (source) bySource[source] += grams;
    }
    const [source, amount] = Object.entries(bySource).sort((a, b) => b[1] - a[1])[0];
    if (protein / servingsCount >= MIN_PROTEIN_PER_SERVING && amount > 0) mainProtein = source;
  }

  return { nutrition, dietTags, mainProtein };
}

// Cœur de l'analyse, sans lecture ni écriture de recette : utilisé par
// analyzeRecipe et par les simulations (analyzeRecipes.js).
// previousRows : lignes recipe_ingredients existantes (les lignes décidées à la
// main sont gardées si leur raw_text n'a pas changé).
async function analyzeIngredientLines(lines, { servings = null, previousRows = [], matcher = getDefaultMatcher() } = {}) {
  const manualByText = new Map();
  for (const row of previousRows.filter(isManualRow).sort((a, b) => a.position - b.position)) {
    if (!manualByText.has(row.raw_text)) manualByText.set(row.raw_text, []);
    manualByText.get(row.raw_text).push(row);
  }

  const rows = [];
  const matches = [];
  for (let position = 0; position < (lines || []).length; position += 1) {
    const rawText = String(lines[position] ?? '').trim();
    const kept = manualByText.get(rawText)?.shift();
    if (kept) {
      rows.push({ ...pickRow(kept), position, kept: true });
      matches.push(null);
      continue;
    }

    const parsed = parseIngredientLine(rawText);
    const row = {
      position,
      raw_text: rawText,
      quantity: parsed.quantity,
      unit: parsed.unit,
      name: parsed.name || null,
      food_id: null,
      match_method: null,
      match_score: null,
      grams: null,
      status: parsed.ignored ? 'ignored' : 'auto',
    };
    let match = null;
    if (!parsed.ignored) {
      match = await matchFood(parsed.name, { matcher, fullName: parsed.fullName });
      row.food_id = match.foodId;
      row.match_method = match.method;
      row.match_score = match.score;
    }
    rows.push(row);
    matches.push(match);
  }

  const foods = await matcher.getFoods([...new Set(rows.map((row) => row.food_id).filter(Boolean))]);
  for (const row of rows) {
    if (row.kept) continue;
    const food = row.food_id ? foods.get(row.food_id) : null;
    const grams = toGrams(row.quantity, row.unit, food);
    row.grams = grams === null ? null : round(grams, 1);
    if (row.status === 'auto' && isHerbOrSpice(row.name, food) && (row.grams === null || row.grams < SMALL_SPICE_GRAMS)) {
      row.status = 'ignored';
    }
  }

  return {
    rows: rows.map(pickRow),
    matches,
    foods,
    ...summarize(rows, foods, servings),
  };
}

async function saveAnalysis(supabase, recipeId, result) {
  const rows = result.rows.map((row) => ({ recipe_id: recipeId, ...row }));
  if (rows.length) {
    const { error } = await supabase.from('recipe_ingredients').upsert(rows, { onConflict: 'recipe_id,position' });
    if (error) throw error;
  }
  const { error: deleteError } = await supabase
    .from('recipe_ingredients')
    .delete()
    .eq('recipe_id', recipeId)
    .gte('position', rows.length);
  if (deleteError) throw deleteError;

  const { error: updateError } = await supabase
    .from('recipes')
    .update({ nutrition: result.nutrition, diet_tags: result.dietTags, main_protein: result.mainProtein })
    .eq('id', recipeId);
  if (updateError) throw updateError;
}

// (Ré)écrit recipe_ingredients et les colonnes calculées de la recette.
// dryRun : calcule sans rien écrire.
async function analyzeRecipe(recipeId, { dryRun = false, matcher = getDefaultMatcher(), supabase = require('./supabase') } = {}) {
  const { data: recipe, error } = await supabase
    .from('recipes')
    .select('id,ingredients,servings')
    .eq('id', recipeId)
    .maybeSingle();
  if (error) throw error;
  if (!recipe) throw new Error(`Recette introuvable : ${recipeId}`);

  const { data: previousRows, error: rowsError } = await supabase
    .from('recipe_ingredients')
    .select(ROW_FIELDS.join(','))
    .eq('recipe_id', recipeId);
  if (rowsError) throw rowsError;

  const result = await analyzeIngredientLines(recipe.ingredients || [], {
    servings: recipe.servings,
    previousRows: previousRows || [],
    matcher,
  });
  if (!dryRun) await saveAnalysis(supabase, recipeId, result);
  return result;
}

module.exports = {
  parseIngredientLine,
  singularize,
  matchFood,
  toGrams,
  isHerbOrSpice,
  analyzeIngredientLines,
  analyzeRecipe,
  getDefaultMatcher,
  MATCH_THRESHOLD,
};
