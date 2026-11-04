// Forme normalisée d'un nom d'aliment ou d'ingrédient, identique à la colonne
// générée foods.name_search (src/scripts/sql/nutrition.sql) : minuscules, sans
// accents, œ → oe, æ → ae, tout ce qui n'est ni lettre ni chiffre devient un espace.
// Les alias de food_aliases sont stockés sous cette forme.
function normalizeFoodName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = { normalizeFoodName };
