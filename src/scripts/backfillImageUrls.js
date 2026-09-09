require('dotenv').config();
const axios = require('axios');
const supabase = require('../services/supabase');

const APPLY = process.argv.includes('--apply');

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function isImageReachable(imageUrl) {
  try {
    const res = await axios.head(imageUrl, {
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: REQUEST_HEADERS,
    });
    if (res.status < 400) return true;

    // Some servers reject HEAD but accept GET (403/405/415 on HEAD).
    const res2 = await axios.get(imageUrl, {
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'stream',
      headers: REQUEST_HEADERS,
    });
    res2.data.destroy();
    return res2.status < 400;
  } catch {
    return false;
  }
}

async function backfill() {
  const { data: recipes, error } = await supabase
    .from('recipes')
    .select('id, title, image_url')
    .not('image_url', 'is', null);

  if (error) {
    throw error;
  }

  console.log(`Verification de ${recipes.length} image_url...`);

  const broken = [];
  for (const recipe of recipes) {
    const reachable = await isImageReachable(recipe.image_url);
    if (!reachable) {
      broken.push(recipe);
      console.log(`- CASSEE [${recipe.id}] ${recipe.title}\n    ${recipe.image_url}`);
    }
  }

  if (!broken.length) {
    console.log('\nAucune image cassee trouvee. Rien a faire.');
    return;
  }

  if (!APPLY) {
    console.log(`\nDry-run (aucune ecriture). ${broken.length} image(s) cassee(s) trouvee(s). Relancer avec --apply pour les vider (image_url = null).`);
    return;
  }

  for (const recipe of broken) {
    const { error: updateError } = await supabase
      .from('recipes')
      .update({ image_url: null })
      .eq('id', recipe.id);

    if (updateError) {
      console.error(`Echec mise a jour recette ${recipe.id}:`, updateError.message || updateError);
    }
  }

  console.log(`\n${broken.length} recette(s) mise(s) a jour (image_url videe).`);
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur backfill image_url:', error.message || error);
    process.exit(1);
  });
