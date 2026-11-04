// Indicateurs de régime pré-remplis par importCiqual.js.
//
// Un aliment reçoit l'indicateur si :
//   - son groupe, sous-groupe ou sous-sous-groupe Ciqual est dans `groups`
//     (comparaison par préfixe de code : '04' couvre tout le groupe 04),
//   - ou son nom contient un des `keywords`,
//   - et son nom ne contient aucun des `exclude`.
//
// Les mots-clés sont des morceaux de regex testés sur le nom normalisé
// (minuscules, sans accents, ponctuation → espaces) et ancrés en début de mot :
// 'oeuf' reconnaît « oeufs », 'lait\\b' ne reconnaît pas « laitue ».
//
// En cas de doute, on penche vers l'indicateur : une étiquette « sans-gluten »
// ou « vegan » fausse est plus gênante qu'une étiquette manquante.

const VEGETAL = [
  'vegetal', 'vegetaux', 'vegetari', 'vegan', 'tofu', 'seitan', 'tempeh',
  'a base de soja', 'de soja\\b', 'au soja\\b',
];

module.exports = {
  is_meat: {
    groups: [
      '0401', // viandes cuites
      '0402', // viandes crues
      '0403', // charcuteries (les alternatives végétales sont exclues par nom)
      '0404', // autres produits à base de viande
    ],
    keywords: [
      'viande', 'boeuf', 'veau', 'porc', 'agneau', 'mouton', 'poulet', 'dinde', 'canard',
      'oie\\b', 'lapin', 'cheval', 'gibier', 'chevreuil', 'sanglier', 'pintade', 'volaille',
      'caille\\b', 'jambon', 'lardon', 'lard\\b', 'bacon', 'saucisse', 'saucisson', 'chorizo',
      'salami', 'merguez', 'chipolata', 'knack', 'rillette', 'pate de (campagne|foie|tete)',
      'pate en croute', 'terrine', 'foie\\b', 'andouill', 'boudin', 'cervelas', 'mortadelle',
      'coppa', 'pancetta', 'bresaola', 'grison', 'kebab', 'nugget', 'cordon bleu', 'steak',
      'hamburger', 'cheeseburger', 'bolognaise', 'carbonara', 'gelatine', 'saindoux', 'suif',
      'graisse de (canard|oie|porc|boeuf)', 'abats', 'rognon', 'tripe', 'cervelle', 'jarret',
      'escalope', 'cassoulet', 'choucroute garnie', 'hachis parmentier', 'pot au feu',
      'blanquette', 'bourguignon', 'couscous (royal|au poulet|a la viande|au mouton)', 'paella',
      'fond de (veau|volaille)', 'hot dog', 'moussaka', 'chili con carne',
    ],
    exclude: [
      ...VEGETAL,
      'oeuf de (caille|cane|dinde)', 'oeuf d oie', 'foie de morue', 'sans viande',
      'paella (aux fruits de mer|de la mer)',
    ],
  },

  is_fish: {
    groups: [
      '0405', '0406', // poissons cuits, crus
      '0407', '0408', // mollusques et crustacés cuits, crus
      '0409',         // produits à base de poissons et produits de la mer
      '0904',         // huiles de poissons
    ],
    keywords: [
      'poisson', 'saumon', 'thon', 'cabillaud', 'morue', 'colin', 'lieu\\b', 'merlu', 'merlan',
      'sole\\b', 'bar\\b', 'dorade', 'daurade', 'truite', 'sardine', 'maquereau', 'hareng',
      'anchois', 'eglefin', 'haddock', 'fletan', 'limande', 'raie\\b', 'rouget', 'lotte',
      'julienne', 'espadon', 'tilapia', 'panga', 'perche', 'brochet', 'carpe\\b', 'sandre',
      'anguille', 'crevette', 'gambas', 'langoustine', 'homard', 'langouste', 'crabe',
      'tourteau', 'ecrevisse', 'moule\\b', 'moules\\b', 'huitre', 'saint jacques', 'st jacques',
      'palourde', 'coques?\\b', 'bulot', 'bigorneau', 'calmar', 'calamar', 'encornet', 'seiche',
      'poulpe', 'pieuvre', 'oursin', 'surimi', 'tarama', 'bouillabaisse', 'paella',
      'nuoc mam', 'sauce (de )?poisson', 'fruits? de mer', 'oeufs? de (lompe|lump|cabillaud|truite|saumon|poisson)',
      'caviar',
    ],
    exclude: [
      ...VEGETAL,
      'a (la )?coque', // oeuf à la coque, fruits à coque
      'caviar d (aubergine|courgette)', 'caviar de (tomate|courgette|legume)',
      'paella (au poulet|a la viande)',
    ],
  },

  is_egg: {
    groups: [
      '0410', // oeufs
      // Pâtisserie : la plupart contiennent des oeufs
      '0705', // viennoiseries
      '0706', // biscuits sucrés
      '0709', // gâteaux et pâtisseries
    ],
    keywords: [
      'oeuf', 'mayonnaise', 'meringue', 'omelette', 'quiche', 'flan\\b', 'clafoutis',
      'creme (brulee|caramel|anglaise|aux oeufs)', 'brioche', 'crepe', 'gaufre', 'madeleine',
      'genoise', 'far breton', 'pain perdu', 'tiramisu', 'mousse au chocolat', 'carbonara',
      'pates fraiches', 'nouilles .*oeufs', 'tagliatelle', 'gnocchi', 'aioli', 'bearnaise',
      'hollandaise', 'tartare',
    ],
    exclude: [...VEGETAL, 'oeufs? de (lompe|lump|cabillaud|truite|saumon|poisson)', 'sans oeuf'],
  },

  is_dairy: {
    groups: [
      '05',   // produits laitiers (les alternatives végétales sont exclues par nom)
      '0901', // beurres
      '0801', // glaces
      '0803', // desserts glacés
      // Pâtisserie : beurre ou lait presque toujours
      '0705', '0706', '0709',
    ],
    keywords: [
      'lait\\b', 'laits\\b', 'laitier', 'lactose', 'lactoserum', 'beurre', 'creme\\b',
      'fromage', 'fromager', 'yaourt', 'yogourt', 'kefir', 'babeurre', 'petit suisse',
      'faisselle', 'emmental', 'emmenthal', 'gruyere', 'comte\\b', 'parmesan', 'mozzarella',
      'feta\\b', 'ricotta', 'mascarpone', 'camembert', 'brie\\b', 'roquefort', 'reblochon',
      'raclette', 'tartiflette', 'cheddar', 'gouda', 'edam\\b', 'mimolette', 'cantal',
      'beaufort', 'chevre', 'bechamel', 'chantilly', 'gratin', 'quiche', 'croque', 'cheese',
      'tiramisu', 'panna cotta', 'flan\\b', 'chocolat (au lait|blanc)', 'ghee', 'glace\\b',
      'carbonara', 'lasagne', 'moussaka', 'hachis parmentier', 'puree de pomme de terre',
    ],
    exclude: [
      ...VEGETAL,
      'lait de (coco|riz|amande|avoine|noisette|noix)', 'lait d (amande|avoine)',
      'boisson (a base )?(de |d )?(riz|avoine|amande|coco|noisette)',
      'beurre de (cacahuete|cacao|karite|arachide)', 'beurre d arachide',
      'creme de (marron|cassis|coco|pruneaux|balsamique|riz|chataigne|framboise|menthe)',
      'fromage de tete', 'glace a l eau', 'sorbet',
    ],
  },

  is_other_animal: {
    groups: [],
    keywords: ['miel', 'gelee royale', 'propolis', 'pollen'],
    exclude: ['sans miel', 'melon miel'],
  },

  is_plant_protein: {
    groups: [
      '0203', // légumineuses
      '0411', // alternatives végétales aux produits carnés
      '1009', // ingrédients pour végétariens
    ],
    keywords: [
      'lentille', 'pois chiche', 'pois casse', 'haricots? (blanc|rouge|noir|sec|coco|mungo|azuki|borlotti|pinto|de lima)',
      'flageolet', 'feves?\\b', 'feverole', 'lupin', 'soja\\b', 'edamame', 'tofu', 'tempeh',
      'seitan', 'houmous', 'hoummos', 'falafel', 'proteines? (de |vegetale|texturee)', 'dahl', 'dal\\b',
    ],
    exclude: [
      'sauce soja', 'huile', 'lecithine', 'germee', 'germe', 'boisson', 'dessert', 'yaourt', 'creme',
      'sans soja', 'contenant du soja', 'type fromage', 'vermicelle',
    ],
  },

  has_gluten: {
    groups: [
      '0104', // pizzas, tartes et crêpes salées
      '0105', // sandwichs
      '0106', // feuilletées et autres entrées
      '0302', // pains et assimilés
      '0303', // biscuits apéritifs
      '0305', // pâtes à tarte
      '0705', // viennoiseries
      '0706', // biscuits sucrés
      '0707', // céréales de petit-déjeuner (malt d'orge fréquent)
      '0708', // barres céréalières
      '0709', // gâteaux et pâtisseries
    ],
    keywords: [
      'ble\\b', 'froment', 'farine', 'pains?\\b', 'pates\\b',
      'pate (feuilletee|brisee|sablee|a pizza|a tarte|a crepe|a choux|a pain|filo|phyllo|bric)',
      'feuilles? de bric', 'semoule', 'boulgour', 'couscous', 'orge\\b', 'seigle', 'epeautre',
      'avoine', 'kamut', 'triticale', 'malt\\b', 'chapelure', 'biscuit', 'biscotte', 'gateau',
      'cake\\b', 'brioche', 'croissant', 'crepe', 'galette', 'gaufre', 'beignet', 'pizza',
      'quiche', 'tarte', 'tourte', 'feuillete', 'croute', 'crouton', 'panes?\\b', 'panees?\\b',
      'nouille', 'vermicelle', 'ravioli', 'raviole', 'tortellini', 'lasagne', 'cannelloni',
      'gnocchi', 'spaghetti', 'macaroni', 'tagliatelle', 'sauce soja', 'seitan', 'biere',
      'levure de biere', 'bechamel', 'cereale', 'muesli', 'granola', 'wrap',
      // La levure chimique du commerce contient souvent de l'amidon de blé
      'levure chimique', 'poudre a lever',
      'tortilla', 'pita', 'naan', 'bagel', 'burger', 'sandwich', 'hot dog', 'croque',
      'empanada', 'samoussa', 'nems?\\b', 'blini', 'pancake', 'muffin', 'cookie', 'madeleine',
      'financier', 'eclair', 'profiterole', 'tiramisu', 'bouillon .*deshydrate',
      'fond de (veau|volaille)', 'moussaka', 'hachis parmentier', 'cordon bleu', 'nugget',
    ],
    exclude: [
      'sans gluten',
      'farine de (riz|mais|sarrasin|ble noir|chataigne|pois chiche|lentille|coco|amande|soja|manioc|pomme de terre|quinoa|teff|millet|lupin|banane|noisette|tapioca|souchet)',
      'fecule', 'amidon de (mais|riz|pomme de terre)', 'semoule de (mais|riz)', 'polenta',
      'nouilles? de riz', 'vermicelles? de (riz|soja)', 'galette de riz', 'ble noir', 'sarrasin',
      'pate d (amande|arachide)', 'pate de (fruit|coing|noisette|sesame|curry)', 'pate a tartiner',
      'chips', 'macaron', 'pop corn', 'mais eclate', 'manioc', 'gateau de riz',
    ],
  },
};
