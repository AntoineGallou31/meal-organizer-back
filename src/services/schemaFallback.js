// Repli quand une base n'a pas encore reçu un fichier de src/scripts/sql/ :
// les requêtes retentent sans les colonnes ajoutées, et l'API répond comme avant.

const isMissingColumnError = (error) => {
  const message = (error?.message ?? '').toLowerCase();
  return message.includes('column') && (
    message.includes('does not exist') ||
    message.includes('not found') ||
    message.includes('schema cache')
  );
};

// Table absente : PostgREST répond PGRST205 (« Could not find the table »)
const isMissingTableError = (error) => error?.code === 'PGRST205'
  || /could not find the table|relation .* does not exist/i.test(error?.message ?? '');

// Colonnes ajoutées par src/scripts/sql/nutrition.sql
const NUTRITION_COLUMNS = 'nutrition,diet_tags,main_protein';
// Après un échec, on ne retente les colonnes qu'au bout de ce délai
const RETRY_AFTER_MS = 5 * 60 * 1000;
let nutritionMissingAt = 0;

// buildQuery(extraColumns) construit la requête complète ; extraColumns vaut
// « nutrition,diet_tags,main_protein, » ou « » (à placer en tête du select).
// requireColumns : la requête filtre sur ces colonnes ; sans elles, aucune
// recette ne peut correspondre et on renvoie une liste vide.
async function selectWithNutrition(buildQuery, { requireColumns = false } = {}) {
  if (Date.now() - nutritionMissingAt > RETRY_AFTER_MS) {
    const result = await buildQuery(`${NUTRITION_COLUMNS},`);
    if (!result.error || !isMissingColumnError(result.error)) return result;
    nutritionMissingAt = Date.now();
  }
  if (requireColumns) return { data: [], error: null };
  return buildQuery('');
}

module.exports = { isMissingColumnError, isMissingTableError, selectWithNutrition, NUTRITION_COLUMNS };
