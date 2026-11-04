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
// En dessous (g pour 100 g), une quantité inconnue ne change pas la protéine principale
const LOW_PROTEIN_PER_100G = 2;

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
// « 1 dizaine de tomates cerises », « une quinzaine de crevettes »
const MULTIPLIERS = { dizaine: 10, douzaine: 12, quinzaine: 15, vingtaine: 20, trentaine: 30, cinquantaine: 50, centaine: 100 };
const MULTIPLIER = new RegExp(`^(${Object.keys(MULTIPLIERS).join('|')})s?\\s+(?:de\\s+|d')?`);

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const MASS_VOLUME = String.raw`kg|kilos?|mg|grammes?|grs?|g|ml|cl|dl|litres?|l`;

// Unités reconnues juste après la quantité, testées dans l'ordre.
// Le texte est déjà en minuscules et sans accents. « cuillère à table » : Québec.
const UNIT_PATTERNS = [
  ['cas', /^cuil+(?:eree|ere|er)?s?\.?\s*(?:a\s*(?:soupe|table|s\.?)|soupe|table)(?![a-z])/],
  ['cac', /^cuil+(?:eree|ere|er)?s?\.?\s*(?:a\s*(?:cafe|the|c\.?)|cafe|the)(?![a-z])/],
  ['cas', /^c\.?\s*(?:a\s*\.?\s*|\/\s*)?(?:s(?:oupe)?|table)\.?(?![a-z])/],
  ['cac', /^c\.?\s*(?:a\s*\.?\s*|\/\s*)?(?:c(?:afe)?|the)\.?(?![a-z])/],
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
const WEIGHT_IN_PARENTHESES = new RegExp(`(${NUM})\\s*(${MASS_VOLUME})\\.?(?![a-z])`);
const MASS_VOLUME_CODES = new Set(['g', 'kg', 'mg', 'ml', 'cl', 'dl', 'l']);
// Quantité sans valeur utilisable : « quelques noix », « un peu de beurre »
const VAGUE = /^(?:quelques gouttes d(?:e |')|quelques|un (?:petit )?peu d(?:e |')|peu d(?:e |')|un trait d(?:e |')|trait d(?:e |')|une goutte d(?:e |')|gouttes? d(?:e |')|un soupcon d(?:e |'))\s*/;
// « le jus d'un citron », « jus de 2 citrons verts »
const JUICE = /^(?:le\s+)?jus\s+d(?:e\s+|'\s*|\s+)?(?:(\d+(?:[.,]\d+)?)|(un|une|deux|trois|quatre))\s+(citrons?(?: verts?| jaunes?)?|limes?|oranges?|pamplemousses?)\b/;

// Adjectifs de taille avant l'unité ou le nom : « 2 grosses cuillères », « 1 petit oignon »
const SIZE_WORDS = /^(?:(?:petite?s?|grosse?s?|gros|grande?s?|bonne?s?|belle?s?|beaux?|bel|moyenne?s?|bien)\s+(?!(?:pois|suisses?|epeautre)\b))+/;
// Après l'unité : « cuillère rase », « tranches épaisses »...
const SPOON_WORDS = /^(?:(?:rases?|bombees?|pleines?|bien|genereuses?|bonnes?|epaisses?|fines?)\s+)+/;
// Contenants sans poids connu : la quantité reste un nombre d'unités
const CONTAINERS = /^(?:morceaux?|cubes?|carres?|pots?|briques?|barquettes?|paquets?|bocal|bocaux|capsules?|dosettes?|blocs?)\s+(?:de\s+|d'|du\s+|des\s+)?/;
// « un filet d'huile » : pas de quantité utilisable
const DRIZZLE = /^filets?\s+(?:de\s+|d')?(?=(?:huile|vinaigre|citron|jus|creme|lait|miel|sauce|sirop))/;
const LEADING_DE = /^(?:de la |de l'|d'|de |du |des )/;
const LEADING_ARTICLE = /^(?:le |la |les |l')/;

// Fin de nom à couper : « huile pour la cuisson », « roquefort selon goût »...
const TAIL = /\b(?:pour|selon|suivant|au choix|a votre convenance|a convenance|facultatif|facultative|optionnel|optionnelle|si possible|si besoin|si vous aimez|si vous voulez|de preference|dans l ideal|environ|quantite|type|facon|a temperature ambiante|a defaut|de cuisson|a volonte|au gout|a votre gout)\b.*$/;
// Expressions à garder entières même si elles contiennent un qualificatif
const PROTECTED = [
  'petits? pois', 'petits? suisses?', 'petit epeautre', 'cremes? fraiches?', 'fromages? frais',
  'levures? fraiches?', 'chevres? frais', 'pates fraiches', 'fromages? rapes?', 'emmental rape',
  'gruyere rape', 'lait entier', 'cremes? entieres?', 'jambons? crus?', 'patates? douces?',
  'tomates? concassees?', 'tomates? pelees?', 'boeuf hache', 'viande hachee', 'steaks? haches?',
  'fines herbes', 'piment doux', 'gros sel', 'cremes? fluides?', 'bouquet garni',
].map((pattern) => new RegExp(`\\b${pattern}\\b`, 'g'));
const QUALIFIER_PHRASES = /\b(?:en (?:petits |gros |fines |fins )?(?:des|cubes|morceaux|rondelles|lamelles|tranches|julienne|quartiers|batonnets|copeaux|petits morceaux|deux|2|quatre|4|huit|8|conserves?|boites?|bocal|branches?)|au naturel|de taille moyenne|de bonne qualite|bien mures?|a temperature ambiante|non traitee?s?|non salee?s?|de saison|a point|a chair ferme|du commerce|du potager|sans croute|sans pre ?cuisson)\b/g;
// Morceau ou portion en tête de nom : « rondelles de chorizo », « blancs de poireaux »
const PIECE = /^(?:gousses?|rondelles?|lamelles?|copeaux|des|cubes?|morceaux?|boules?|billes?|cerneaux|tiges?|fleurons?|bulbes?|quartiers?|petales|allumettes|batonnets|blancs?|dos|paves?|filets?|feuilles?|brins?|branches?|bouquets?|poignees?|bols?|portions?|doses?|traits?|gouttes?|tranches?|sections?|troncons?|plaques?)\s+(?:de|d)\s+/;
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
  fraichement moulu moulue moulus moulues degerme degermee degermes degermees
  ecrase ecrasee ecrases ecrasees presse pressee presses pressees battu battue battus battues
  rince rincee rinces rincees nettoye nettoyee nettoyes nettoyees equeute equeutee equeutes equeutees
  ecosse ecossee ecosses ecossees torrefie torrefiee torrefies torrefiees toaste toastee toastes toastees
  effile effilee effiles effilees monde mondee mondes mondees revenu revenue revenus revenues
  dilue diluee dilues diluees ferme fermes joli jolie jolis jolies multicolore multicolores
  melange melangee melanges melangees varie variee varies variees legerement dore doree dores dorees
  desosse desossee desosses desossees tamise tamisee tamises tamisees fluide fluides
  surgele surgelee surgeles surgelees quelques allumette allumettes
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
    .replace(/[​-‍⁠﻿]/g, '') // caractères invisibles laissés par certains sites
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/œ/g, 'oe').replace(/Œ/g, 'Oe').replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(new RegExp(`(\\d+)?\\s*([${FRACTION_CHARS}])`, 'g'),
      (_, whole, fraction) => ` ${formatNumber((whole ? Number(whole) : 0) + UNICODE_FRACTIONS[fraction])} `)
    .replace(/(\d+)\s+(\d+)\s*\/\s*(\d+)/g,
      (match, whole, num, den) => (Number(den) ? ` ${formatNumber(Number(whole) + Number(num) / Number(den))} ` : match))
    .replace(/(\d+)\s*\/\s*(\d+)/g, (match, num, den) => (Number(den) ? ` ${formatNumber(Number(num) / Number(den))} ` : match))
    // Pourcentages (« crème à 4 % », « 30% MG ») : jamais une quantité
    .replace(new RegExp(`(?:\\ba\\s+)?${NUM}\\s*%(?:\\s*(?:de\\s+)?mg\\b)?`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readMassOrVolume(text) {
  const match = text.match(new RegExp(`^(${NUM})\\s*(${MASS_VOLUME})\\.?(?![a-z'])\\s*`));
  return match ? { quantity: parseNumber(match[1]), unit: unitCode(match[2]), length: match[0].length } : null;
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
  let text = name.replace(PIECE, '').replace(QUALIFIER_PHRASES, ' ');
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
  // Pas un aliment : « papier aluminium », « cure-dents »
  if (/^(?:papier |feuille d )?(?:aluminium|papier sulfurise|film alimentaire|cure dents?|pique brochettes?|ficelle)$/.test(name)) return true;
  return false;
}

// → { quantity, unit, name, fullName, ignored }
//   name : nom normalisé, sans qualificatifs ; fullName : avant retrait des qualificatifs
//   ignored : sel, poivre, eau, glaçons, arômes et extraits, ou ligne sans nom
function parseIngredientLine(text) {
  const { text: prepared, weight: parenthesesWeight } = extractParentheses(prepare(text));
  let weight = parenthesesWeight;
  let rest = prepared;
  let quantity = null;
  let unit = null;

  // « 200 g de pois chiches, soit 1 boîte » / « pois chiches soit 200 gr » : le poids l'emporte
  const soit = rest.match(new RegExp(`\\bsoit\\s+(${NUM})\\s*(${MASS_VOLUME})\\.?(?![a-z'])`));
  if (soit) {
    if (!weight) weight = { quantity: parseNumber(soit[1]), unit: unitCode(soit[2]) };
    rest = `${rest.slice(0, soit.index)} ${rest.slice(soit.index + soit[0].length)}`.replace(/\s+/g, ' ').trim();
  }

  const vague = rest.match(VAGUE);
  if (vague) rest = rest.slice(vague[0].length);

  const half = rest.match(/^(?:la\s+)?moitie\s+d(?:'|\s)\s*(?:un|une)\s+/);
  const leading = rest.match(new RegExp(`^(${NUM})(?:\\s*(?:-|–|a|ou)\\s*(${NUM}))?(?![\\d.,])\\s*`));
  if (vague) {
    // pas de quantité utilisable
  } else if (half) {
    quantity = 0.5;
    rest = rest.slice(half[0].length);
  } else if (leading) {
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
  // « 30 + 20 g de parmesan »
  for (let plus = rest.match(new RegExp(`^\\+\\s*(${NUM})\\s*`)); quantity !== null && plus; plus = rest.match(new RegExp(`^\\+\\s*(${NUM})\\s*`))) {
    quantity += parseNumber(plus[1]);
    rest = rest.slice(plus[0].length);
  }
  if (quantity !== null) {
    const halfWord = rest.match(/^demie?\s*-?\s*/);
    if (halfWord) {
      quantity *= 0.5;
      rest = rest.slice(halfWord[0].length);
    }
    rest = rest.replace(SIZE_WORDS, '');
  }
  const multiplier = rest.match(MULTIPLIER);
  if (multiplier && !vague) {
    quantity = (quantity ?? 1) * MULTIPLIERS[multiplier[1]];
    rest = rest.slice(multiplier[0].length);
  }

  const juice = !vague && rest.match(JUICE);
  if (juice) {
    // « le jus d'un citron » → 1 unité de « jus de citron »
    quantity = (quantity ?? 1) * (juice[1] ? parseNumber(juice[1]) : NUMBER_WORDS[juice[2]]);
    unit = 'unite';
    rest = `jus de ${singularize(juice[3])}${rest.slice(juice[0].length)}`;
  }

  // « 1 noix de beurre » ≈ 10 g
  const knob = !juice && rest.match(/^noix\s+de\s+(?=beurre\b)/);
  // Unités anglo-saxonnes, converties en grammes
  const imperial = !juice && !knob && quantity !== null && rest.match(/^(lbs?|livres?|pounds?|oz|onces?|ounces?)\.?\s+(?:de\s+|d'|of\s+)?/);
  const readU = juice || knob || imperial ? null : readUnit(rest);
  if (juice) {
    // déjà traité
  } else if (knob) {
    quantity = (quantity ?? 1) * 10;
    unit = 'g';
    rest = rest.slice(knob[0].length);
  } else if (imperial) {
    quantity *= /^(?:lb|livre|pound)/.test(imperial[1]) ? 453.6 : 28.35;
    unit = 'g';
    rest = rest.slice(imperial[0].length);
  } else if (readU && (quantity !== null || readU.code !== 'unite') && !vague) {
    unit = readU.code;
    rest = readU.rest.replace(/^\.\s*/, '').replace(SPOON_WORDS, '');
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

  if (quantity !== null) {
    // « 1 cuillère à thé et demie de paprika »
    const andHalf = rest.match(/^et\s+demie?\s+/);
    if (andHalf) {
      quantity += 0.5;
      rest = rest.slice(andHalf[0].length);
    }
    // « 15 g + 20 g de beurre »
    for (let plus = rest.match(new RegExp(`^\\+\\s*(${NUM})\\s*`)); plus; plus = rest.match(new RegExp(`^\\+\\s*(${NUM})\\s*`))) {
      const after = rest.slice(plus[0].length);
      const extraUnit = readUnit(after);
      if (extraUnit && extraUnit.code !== unit) break;
      quantity += parseNumber(plus[1]);
      rest = extraUnit ? extraUnit.rest : after;
    }
    // Taille du contenant : « 1 boîte de 400 g de tomates », « 1 sachet de 25 g de levure »
    if (!MASS_VOLUME_CODES.has(unit)) {
      const size = readMassOrVolume(rest.replace(/^(?:de\s+|d')/, ''));
      if (size && /^(?:de\s+|d')?\S/.test(rest)) {
        const afterSize = rest.replace(/^(?:de\s+|d')/, '').slice(size.length);
        if (/^(?:de\s+|d')/.test(afterSize)) {
          quantity *= size.quantity;
          unit = size.unit;
          rest = afterSize;
        }
      }
    }
  }

  // Quantité en fin de ligne : « Farine : 200 g », « beurre 50g », « 2 tranches d'agneau 200 g »
  const trailing = rest.match(new RegExp(`[\\s:]+(${NUM})\\s*(${MASS_VOLUME})\\.?\\s*$`));
  if (trailing && (quantity === null || !MASS_VOLUME_CODES.has(unit))) {
    quantity = parseNumber(trailing[1]);
    unit = unitCode(trailing[2]);
    rest = rest.slice(0, trailing.index);
  }

  // « 2 gousses d'ail + 1 gousse » : la suite après « + » s'ajoute si l'unité est la même
  // (seulement avant une alternative « ou ... » ou une virgule)
  const cut = rest.search(/[,;:]| ou | \/ /);
  const head = cut >= 0 ? rest.slice(0, cut) : rest;
  const [main, ...extras] = head.split(/\s+\+\s+/);
  rest = main + (cut >= 0 ? rest.slice(cut) : '');
  for (const extra of extras) {
    const extraQty = extra.match(new RegExp(`^(${NUM})\\s*`));
    if (!extraQty || quantity === null) continue;
    const extraUnit = readUnit(extra.slice(extraQty[0].length));
    if (!extraUnit || extraUnit.code === unit) quantity += parseNumber(extraQty[1]);
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
// Ingrédient déjà cuit : « quinoa cuit », « lentilles cuites »
const COOKED_WORD = /\b(?:cuit|cuite|cuits|cuites|bouilli|bouillie|bouillis|bouillies)\b/;
// Variante d'un alias : « cumin en poudre » → « cumin »
const ALIAS_SUFFIX = /\s+(?:en poudre|moulue?s?)$/;

// Noms sans équivalent Ciqual fiable : alias à ciqual_code null dans
// food-aliases.json. Ils restent « non reconnus » (pas de rapprochement par
// similarité), pour ne pas poser une étiquette sur une supposition.
const NO_GUESS = new Set(Object.entries(require('../scripts/data/food-aliases.json'))
  .filter(([, value]) => value.ciqual_code === null)
  .map(([alias]) => alias));

let defaultMatcher = null;
function getDefaultMatcher() {
  if (!defaultMatcher) defaultMatcher = createDbMatcher(require('./supabase'));
  return defaultMatcher;
}

function sortCandidates(list) {
  return [...list].sort((a, b) => b.score - a.score || a.name.length - b.name.length);
}

// → { foodId, foodName, score, method: 'alias' | 'similarity' | null, best }
//   best : meilleur candidat, même sous le seuil (pour les rapports)
async function matchFood(name, { matcher = getDefaultMatcher(), fullName = null } = {}) {
  const normalized = normalizeFoodName(name);
  const none = { foodId: null, foodName: null, score: null, method: null, best: null };
  if (!normalized) return none;

  // Alias exact : le nom complet d'abord (« levure fraiche »), puis sans qualificatifs
  const bases = [fullName, normalized].filter(Boolean);
  const forms = [...new Set(bases.flatMap((base) => {
    const stripped = base.replace(ALIAS_SUFFIX, '');
    return [base, singularize(base), stripped, singularize(stripped)];
  }))];
  for (const form of forms) {
    if (NO_GUESS.has(form)) return none;
    const foodId = await matcher.findAlias(form);
    if (foodId) return { foodId, foodName: null, score: 1, method: 'alias', best: null };
  }

  // Similarité : au singulier d'abord (les aliments bruts sont au singulier dans
  // Ciqual, les plats au pluriel : « abricots » ne doit pas donner « Tarte aux abricots »)
  const singular = singularize(normalized);
  let candidates = sortCandidates(await matcher.searchCandidates(singular));
  if ((!candidates[0] || candidates[0].score < MATCH_THRESHOLD) && singular !== normalized) {
    candidates = sortCandidates(await matcher.searchCandidates(normalized));
  }
  const best = candidates[0] || null;
  if (!best || best.score < MATCH_THRESHOLD) {
    return { ...none, score: best ? best.score : null, best };
  }

  // Entre candidats proches, l'aliment cru (ou cuit si le nom le précise)
  const preferred = COOKED_WORD.test(normalized) ? COOKED_WORD : RAW_WORD;
  const state = candidates.find((candidate) => candidate.score >= best.score - RAW_PREFERENCE_MARGIN
    && preferred.test(normalizeFoodName(candidate.name)));
  const chosen = state || best;
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
  'baies? roses?', 'garni', 'cajun', 'tabasco', 'sriracha', 'worcestershire', 'wasabi',
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

  // Protéine principale : il faut l'aliment de chaque ligne, et ses grammes sauf
  // s'il n'apporte presque pas de protéines (« huile d'olive » sans quantité)
  const proteinUnknown = (row) => {
    const food = foodOf(row);
    if (!food) return true;
    if (row.grams !== null) return false;
    const per100 = Number(food.proteins_g);
    return !(food.proteins_g !== null && Number.isFinite(per100) && per100 < LOW_PROTEIN_PER_100G);
  };
  let mainProtein = null;
  if (servingsCount && !active.some(proteinUnknown)) {
    const bySource = { animale: 0, 'oeufs-laitiers': 0, vegetale: 0 };
    let protein = 0;
    for (const row of active.filter((line) => line.grams !== null)) {
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
