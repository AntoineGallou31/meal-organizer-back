// Vérifie parseIngredientLine (quantité / unité / nom) sur des lignes de référence.
// Usage : node src/scripts/checkIngredientParser.js   (code de sortie 1 si un cas échoue)
const { parseIngredientLine } = require('../services/ingredientAnalyzer');

// [ligne, quantité, unité, nom] ; 'ignored' : la ligne doit être ignorée
const CASES = [
  ['1 unité pâte feuilletée', 1, 'unite', 'pate feuilletee'],
  ['1 l lait demi écrémé', 1, 'l', 'lait demi ecreme'],
  ['3 unité oeuf', 3, 'unite', 'oeuf'],
  ['2 sachet sucre vanillé', 2, 'sachet', 'sucre vanille'],
  ['½ c à c vanille en poudre', 0.5, 'cac', 'vanille en poudre'],
  ["2 gousses d'ail", 2, 'gousse', 'ail'],
  ['200g de farine', 200, 'g', 'farine'],
  ['1 boîte de pois chiches (400 g)', 400, 'g', 'pois chiches'],
  ['1,5 kg de pommes de terre', 1.5, 'kg', 'pommes de terre'],
  ['2-3 tomates', 2.5, 'unite', 'tomates'],
  ['20 cl de crème liquide', 20, 'cl', 'creme liquide'],
  ["1 c. à soupe d'huile d'olive", 1, 'cas', 'huile d olive'],
  ['½ botte de persil', 0.5, 'botte', 'persil'],
  ['Huile pour la cuisson', null, null, 'huile'],
  ['Sel, poivre', 'ignored'],

  // Lignes réelles de la base
  ['1 oignon jaune, finement haché', 1, 'unite', 'oignon jaune'],
  ["de l'huile d'olive", null, null, 'huile d olive'],
  ['4 œufs', 4, 'unite', 'oeufs'],
  ['3 c à s de vinaigre à la framboise', 3, 'cas', 'vinaigre a la framboise'],
  ['1 grosse courgette', 1, 'unite', 'courgette'],
  ['2 cuillères à soupe d\'huile d\'olive', 2, 'cas', 'huile d olive'],
  ['1 cuillère à café de piment', 1, 'cac', 'piment'],
  ['60 cl de lait froid', 60, 'cl', 'lait'],
  ['Roquefort (selon goût)', null, null, 'roquefort'],
  ['1 cube de bouillon de légumes bio', 1, 'unite', 'bouillon de legumes'],
  ['20cl de crème fraîche', 20, 'cl', 'creme fraiche'],
  ['1/2 cuillère à thé de flocons de piment de cayenne', 0.5, 'cac', 'flocons de piment de cayenne'],
  ['65g de noix, hâchées grossièrement', 65, 'g', 'noix'],
  ['2 à 3 gousses d\'ail hachées', 2.5, 'gousse', 'ail'],
  ['1/2 càc de cannelle en poudre', 0.5, 'cac', 'cannelle en poudre'],
  ['1 conserve de 14 oz (414 ml) de tomates en dés', 414, 'ml', 'tomates'],
  ['fromage râpé au choix (mozzarella râpée ou parmesan)', null, null, 'fromage rape'],
  ['1 pointe de muscade', 1, 'pincee', 'muscade'],
  ['1 c. à c. de paprika doux', 1, 'cac', 'paprika'],
  ['Une cuillère à soupe de rhum', 1, 'cas', 'rhum'],
  ['un filet d\'huile d\'olive', null, null, 'huile d olive'],
  ['1 filet huile d\'olive', null, null, 'huile d olive'],
  ['1 dizaine de tomates cerises', 10, 'unite', 'tomates cerises'],
  ['1 petit morceau de gingembre', 1, 'unite', 'gingembre'],
  ['160 g sucre', 160, 'g', 'sucre'],
  ['Poivre du moulin (pour la sauce)', 'ignored'],
  ['10 cl d\'eau', 'ignored'],
  ['4 cL d\'eau', 'ignored'],
  ['sel', 'ignored'],
  ['1 kg de carottes ((j’ai pris des carottes des sables des Landes, un délice))', 1, 'kg', 'carottes'],
  ['500 g de patates douces (3 patates de taille moyenne)', 500, 'g', 'patates douces'],
  ['Farine : 200 g', 200, 'g', 'farine'],
  ['1 c. à s. bombée de farine', 1, 'cas', 'farine'],
  ['2 jaunes d\'œufs', 2, 'unite', 'jaunes d oeufs'],
  ['1 cuil. à soupe de pignons de pin', 1, 'cas', 'pignons de pin'],
  ['1/2 c. à thé (2,5 ml) de sel ou plus au goût', 'ignored'],
  ['3 tasses de tomates cerise coupées en deux', 3, 'verre', 'tomates cerise'],
  ['10 olives noires dénoyautées', 10, 'unite', 'olives noires'],
  ['1/2 lb de saumon fumé', 226.8, 'g', 'saumon fume'],
  ['2 cuillères à café de sel', 'ignored'],
  ['3 cuillères à table de persil frais', 3, 'cas', 'persil'],
  ['1 cuillère à table d\'origan frais', 1, 'cas', 'origan'],
  ['1 l. d\'eau', 'ignored'],
  ['15 g + 20 g de beurre', 35, 'g', 'beurre'],
  ['30 + 20g de parmesan râpé', 50, 'g', 'parmesan'],
  ['2 tranches d\'agneau 200 g', 200, 'g', 'agneau'],
  ['1 cuillère(s) à soupe huile d&#x27;olive', 1, 'cas', 'huile d olive'],
  ['huile d&#039;olive vierge extra', null, null, 'huile d olive vierge'],
  ['2 gousses d\'ail + 1 gousse', 3, 'gousse', 'ail'],
  ['1 cuillère à thé et demie de paprika', 1.5, 'cac', 'paprika'],
  ['​900 g de pommes', 900, 'g', 'pommes'],
  ['1 sachet de 25g de préparation pour pâtes à pains', 25, 'g', 'preparation'],
  ['1 boîte de 540 ml de pois chiches', 540, 'ml', 'pois chiches'],
  ['3 cuillères à table d\'huile d\'olive + 1 cuillère pour la cuisson', 4, 'cas', 'huile d olive'],
  ['80 g de parmesan fraîchement râpé', 80, 'g', 'parmesan'],
  ['quelques noix', null, null, 'noix'],
  ['2 noix de beurre', 20, 'g', 'beurre'],
  ['le jus d\'un citron', 1, 'unite', 'jus de citron'],
  ['Jus de 2 citrons verts', 2, 'unite', 'jus de citron vert'],
  ['la moitié d\'un oignon', 0.5, 'unite', 'oignon'],
  ['une quinzaine de tomates cerises', 15, 'unite', 'tomates cerises'],
  ['200 g de thon en conserve', 200, 'g', 'thon'],
  ['4 blancs de poireaux', 4, 'unite', 'poireaux'],
  ['2 boules de mozzarella', 2, 'unite', 'mozzarella'],
  ['20 cl de crème fraîche à 4%', 20, 'cl', 'creme fraiche'],
  ['pois chiches soit 200 gr', 200, 'g', 'pois chiches'],
  ['Huile de cuisson', null, null, 'huile'],
];

let failures = 0;
for (const [line, ...expected] of CASES) {
  const parsed = parseIngredientLine(line);
  let ok;
  let wanted;
  if (expected[0] === 'ignored') {
    ok = parsed.ignored === true;
    wanted = 'ligne ignorée';
  } else {
    const [quantity, unit, name] = expected;
    const sameQuantity = quantity === null ? parsed.quantity === null : Math.abs(parsed.quantity - quantity) < 1e-9;
    ok = sameQuantity && parsed.unit === unit && (name === null || parsed.name === name) && !parsed.ignored;
    wanted = `${quantity} / ${unit} / ${name ?? '*'}`;
  }
  const got = parsed.ignored ? `ligne ignorée (${parsed.name})` : `${parsed.quantity} / ${parsed.unit} / ${parsed.name}`;
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} « ${line} » → ${got}${ok ? '' : `   attendu : ${wanted}`}`);
}

console.log(`\n${CASES.length - failures}/${CASES.length} cas corrects`);
process.exit(failures ? 1 : 0);
