// Les 21 categories de reference : nom, couleur et mots-cles du classement automatique.
// Mots-cles sans accents et au singulier : le classement ajoute lui-meme un pluriel
// optionnel en s ou x a chaque mot (voir services/categoryMatcher.js).
// Utilise par seedCategories.js, migrateCategories.js et checkCategorizer.js.

const list = (text) => text.split(',').map((keyword) => keyword.trim()).filter(Boolean);

const CATEGORIES = [
  // Plats
  {
    name: 'Plats de légumes',
    color: '#22C55E',
    keywords: list(`legume, gratin, gratine, gratinee, poelee, ratatouille, tian, farci, farcie, puree,
      pomme de terre, patate douce, crumble de legume, crumble sale, crumble de tomate, crumble tomate,
      crumble de courgette, tomate, courgette, aubergine, poivron, champignon, chou, carotte, poireau,
      endive, haricot vert, epinard, brocoli, butternut, potimarron, courge, fenouil`),
  },
  {
    name: 'Pâtes',
    color: '#D4A574',
    keywords: list(`pates, pasta, spaghetti, tagliatelle, fusilli, penne, linguine, lasagne, macaroni,
      coquillette, orzo, ravioli, tortellini, farfalle, rigatoni, cannelloni, canneloni, nouille, udon, soba,
      crozet, conchiglie, conchiglioni, lumaconi, trofie, pappardelle, orecchiette, carbonara,
      gratin de pates, gratin de crozet, gratin de macaroni, gratin de coquillette`),
  },
  {
    name: 'Salades',
    color: '#86EFAC',
    keywords: list('salade, salad, taboule, coleslaw, crudite'),
  },
  {
    name: 'Quiches & tartes salées',
    color: '#D4A574',
    keywords: list(`quiche, tarte, tartelette, tourte, feuillete, pissaladiere, flamiche, pizza,
      tarte aux pomme de terre`),
  },
  {
    name: 'Céréales & légumineuses',
    color: '#10B981',
    keywords: list(`quinoa, quinotto, semoule, couscous, boulgour, bulgur, sarrasin, orge, epeautre,
      lentille, pois chiche, haricot rouge, haricot blanc, falafel, gratin de quinoa`),
  },
  {
    name: 'Riz & risottos',
    color: '#D4A574',
    keywords: list('riz, risotto, paella, biryani, jambalaya'),
  },
  {
    name: 'Soupes & veloutés',
    color: '#6EE7B7',
    keywords: list('soupe, veloute, potage, bouillon, minestrone, gaspacho, gazpacho, pho, ramen'),
  },
  {
    name: 'Poulet & volaille',
    color: '#F59E0B',
    keywords: list('poulet, volaille, dinde, canard, pintade, chicken, nugget'),
  },
  {
    name: 'Gnocchis',
    color: '#F59E0B',
    keywords: list('gnocchi, gratin de gnocchi'),
  },
  {
    name: 'Poissons & fruits de mer',
    color: '#BAE6FD',
    keywords: list(`poisson, saumon, cabillaud, thon, truite, colin, merlu, dorade, sardine, maquereau,
      crevette, gambas, moule, saint jacques, calamar, encornet, fruits de mer, fish`),
  },
  {
    name: 'Currys & dahls',
    color: '#F97316',
    keywords: list('curry, dahl, dal, masala, tikka, korma'),
  },
  {
    name: 'Cakes & clafoutis salés',
    color: '#8B5CF6',
    keywords: list('clafoutis, cake sale, muffin sale'),
  },
  {
    name: 'Œufs & omelettes',
    color: '#FCD34D',
    keywords: list('oeuf, omelette, frittata, shakshuka'),
  },
  {
    name: 'Burgers & croques',
    color: '#EA580C',
    keywords: list('burger, hamburger, croque, sandwich, panini, wrap, bagel, hot dog, tacos'),
  },
  {
    name: 'Viandes',
    color: '#FCA5A5',
    keywords: list(`viande, boeuf, veau, agneau, porc, steak, roti, jambon, saucisse, boulette, kefta,
      bourguignon, blanquette, parmentier, chili con carne`),
  },
  {
    name: 'Bowls & assiettes complètes',
    color: '#10B981',
    keywords: list('bowl, poke, bibimbap, assiette'),
  },

  // Hors plat (exclues des suggestions, voir services/mealCategories.js)
  {
    name: 'Desserts',
    color: '#F9A8D4',
    keywords: list(`dessert, gateau, cake, cookie, brownie, muffin, crumble, compote, mousse au chocolat,
      tiramisu, cheesecake, panna cotta, creme brulee, flan patissier, fondant, moelleux, financier,
      madeleine, macaron, meringue, pavlova, sable, biscuit, gaufre, glace, sorbet, riz au lait,
      clafoutis aux cerises, clafoutis aux abricot, clafoutis aux figue, clafoutis aux poire, clafoutis poire,
      tarte aux pommes, tarte aux poires, tarte aux fraises, tarte aux framboises, tarte aux abricots,
      tarte au citron, tarte au chocolat, tarte tatin, tarte aux peche, tarte a la peche, tarte banane,
      tarte a la banane, tarte a l abricot, tarte aux figue, tarte aux fruit, tarte a la rhubarbe,
      tarte aux prune, tarte aux mirabelle, tarte aux myrtille, salade de fruit, gratin de poire,
      pate a crepe, pate a choux, choux a la creme, banana bread, charlotte, quatre quart, pudding`),
  },
  {
    name: 'Apéro & entrées',
    color: '#F59E0B',
    keywords: list(`apero, aperitif, tapas, entree, verrine, toast, tartinade, houmous, hummus, guacamole,
      tzatziki, rillette, gougere, blini, bruschetta, accras, feuillete apero, bouchee, palmier,
      amuse bouche, mini pizza, cookie sale, financier sale`),
  },
  {
    name: 'Boissons & cocktails',
    color: '#06B6D4',
    keywords: list(`boisson, cocktail, mocktail, smoothie, limonade, citronnade, mojito, sangria, spritz,
      punch, milkshake, the glace`),
  },
  {
    name: 'Petit-déjeuner & brunch',
    color: '#FCD34D',
    keywords: list(`petit dejeuner, brunch, granola, porridge, pancake, muesli, overnight oat, pain perdu,
      bowlcake`),
  },

  // Categorie par defaut : aucun mot-cle, recoit les recettes que rien ne reconnait
  {
    name: 'Sans catégorie',
    color: '#9CA3AF',
    is_default: true,
    keywords: [],
  },
].map((category) => ({ is_default: false, ...category }));

module.exports = CATEGORIES;
