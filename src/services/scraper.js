const axios = require('axios');
const cheerio = require('cheerio');
const { parse, toSeconds } = require('iso8601-duration');

function parseServings(text) {
  if (!text) return null;
  const match = text.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function cleanString(s) {
  return s.trim().replace(/[\r\n\t]/g, '').replace(/\s\s+/g, ' ');
}

async function scrapeRecipe(url) {
  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Accept': 'text/html',
    },
  });
  const $ = cheerio.load(html);

  let recipe = {
    title: '',
    imageUrl: null,
    prepTime: null,
    servings: null,
    ingredients: [],
    steps: [],
    sourceUrl: url,
    partial: false,
  };

  // Method 1: JSON-LD
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const json = JSON.parse($(el).html());
      let recipeData = null;

      const findRecipe = (obj) => {
        if (obj['@type'] && (Array.isArray(obj['@type']) ? obj['@type'].includes('Recipe') : obj['@type'] === 'Recipe')) {
          return obj;
        }
        if (obj['@graph']) {
          for (const item of obj['@graph']) {
            const found = findRecipe(item);
            if (found) return found;
          }
        }
        return null;
      };
      
      recipeData = findRecipe(json);

      if (recipeData) {
        recipe.title = recipeData.name || recipe.title;
        if (recipeData.image) {
          recipe.imageUrl = recipeData.image.url || (Array.isArray(recipeData.image) ? recipeData.image[0]?.url || recipeData.image[0] : recipeData.image);
        }
        let totalDuration = 0;
        if (recipeData.prepTime) totalDuration += toSeconds(parse(recipeData.prepTime));
        if (recipeData.cookTime) totalDuration += toSeconds(parse(recipeData.cookTime));
        if (totalDuration > 0) recipe.prepTime = Math.round(totalDuration / 60);

        if (recipeData.recipeYield) {
            recipe.servings = parseServings(Array.isArray(recipeData.recipeYield) ? recipeData.recipeYield[0] : recipeData.recipeYield);
        }
        
        if (recipeData.recipeIngredient) {
          recipe.ingredients = recipeData.recipeIngredient.map(cleanString);
        }
        if (recipeData.recipeInstructions) {
          recipe.steps = recipeData.recipeInstructions
            .map(step => (typeof step === 'string' ? cleanString(step) : cleanString(step.text)))
            .filter(Boolean);
        }
        if (recipe.ingredients.length > 0 && recipe.steps.length > 0) {
          return false; // break cheerio loop
        }
      }
    } catch (e) {
      // ignore json parse errors
    }
  });

  if (recipe.ingredients.length > 0 && recipe.steps.length > 0) {
    return recipe;
  }

  // Method 2: Microdata
  if (recipe.ingredients.length === 0) {
    $('[itemprop="recipeIngredient"]').each((i, el) => {
      recipe.ingredients.push(cleanString($(el).text()));
    });
  }
  if (recipe.steps.length === 0) {
    $('[itemprop="recipeInstructions"]').find('li, p').each((i, el) => {
        const text = cleanString($(el).text());
        if(text) recipe.steps.push(text);
    });
  }
   if (!recipe.title) {
    recipe.title = $('[itemprop="name"]').first().text();
  }
  if (!recipe.imageUrl) {
    recipe.imageUrl = $('[itemprop="image"]').first().attr('src') || $('[itemprop="image"]').first().attr('content');
  }


  if (recipe.ingredients.length > 0 && recipe.steps.length > 0) {
    return recipe;
  }

  // Method 3: Heuristics
  if (recipe.ingredients.length === 0) {
    $('h2, h3, section, div').each((i, el) => {
        const title = $(el).text().toLowerCase();
        if (title.includes('ingrédient')) {
            $(el).parent().find('ul, ol').find('li').each((i, li) => {
                recipe.ingredients.push(cleanString($(li).text()));
            });
            if(recipe.ingredients.length > 0) return false;
        }
    });
  }
  if (recipe.steps.length === 0) {
     $('h2, h3, section, div').each((i, el) => {
        const title = $(el).text().toLowerCase();
        if (title.includes('préparation') || title.includes('instructions') || title.includes('étapes') || title.includes('recette')) {
            let list = $(el).parent().find('ol, ul');
            if(!list.length) list = $(el).nextAll('ol, ul').first();
            
            list.find('li').each((i, li) => {
                recipe.steps.push(cleanString($(li).text()));
            });
            if(recipe.steps.length > 0) return false;
        }
    });
  }
    if (!recipe.imageUrl) {
        $('img').each((i, el) => {
            const src = $(el).attr('src');
            const width = $(el).attr('width') || 0;
            if (src && (parseInt(width) > 300 || src.includes('large') || src.includes('800'))) {
                recipe.imageUrl = src;
                return false;
            }
        });
    }


  recipe.ingredients = recipe.ingredients.filter(i => i.length > 0);
  recipe.steps = recipe.steps.filter(s => s.length > 0);

  if (recipe.ingredients.length === 0 && recipe.steps.length === 0) {
    throw { message: "Impossible d'extraire la recette", partial: true };
  }

  if (recipe.ingredients.length === 0 || recipe.steps.length === 0) {
    recipe.partial = true;
  }

  return recipe;
}

module.exports = { scrapeRecipe };
