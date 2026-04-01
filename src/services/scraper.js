const axios = require('axios')
const cheerio = require('cheerio')

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY
const SHORT_LINK_DOMAINS = ['pin.it', 'bit.ly', 'tinyurl.com', 'shorturl.at', 'ow.ly', 'buff.ly', 't.co']

function isShortLink(url) {
  return SHORT_LINK_DOMAINS.some(domain => url.includes(domain))
}

async function resolveUrl(url) {
  if (!isShortLink(url) && !url.includes('pinterest.com')) return url

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    })

    const finalUrl = res.request?.res?.responseUrl || res.config.url || url

    // Pinterest peut être une étape intermédiaire : on tente d'extraire le lien source.
    if (finalUrl.includes('pinterest.com')) {
      const $ = cheerio.load(typeof res.data === 'string' ? res.data : '')
      const externalUrl = $('meta[property="og:see_also"]').attr('content')
        || $('a[data-test-id="pin-closeup-link"]').attr('href')
        || $('a[href*="http"]').filter((_, el) => {
          const href = $(el).attr('href') || ''
          return href.startsWith('http') && !href.includes('pinterest.com')
        }).first().attr('href')

      if (externalUrl && !externalUrl.includes('pinterest.com')) {
        return externalUrl
      }
    }

    return finalUrl
  } catch (err) {
    if (err.request?.res?.responseUrl) return err.request.res.responseUrl
    throw new Error(`Impossible de résoudre le lien : ${url}`)
  }
}

// ─── Fetch avec fallbacks ────────────────────────────────────────────────────

async function fetchPage(url) {
  // Tentative 1 : fetch direct avec headers Chrome
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      decompress: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://www.google.fr/'
      }
    })
    return { html: res.data, method: 'direct' }
  } catch (err) {
    const status = err.response?.status
    console.log(`Fetch direct échoué (${status ?? 'réseau'}), fallback ScraperAPI...`)
  }

  // Tentative 2 : ScraperAPI
  if (SCRAPER_API_KEY) {
    try {
      const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&country_code=fr&render=true`
      const res = await axios.get(scraperUrl, { timeout: 30000 })
      return { html: res.data, method: 'scraperapi' }
    } catch (err) {
      console.log('ScraperAPI échoué, fallback Jina...')
    }
  }

  // Tentative 3 : Jina AI Reader (gratuit, sans clé)
  try {
    const jinaUrl = `https://r.jina.ai/${url}`
    const res = await axios.get(jinaUrl, {
      timeout: 20000,
      headers: { 'Accept': 'text/markdown,text/plain;q=0.9,*/*;q=0.8' }
    })
    return { html: res.data, method: 'jina', isMarkdown: true }
  } catch (err) {
    throw new Error(`Impossible d'accéder à la page après 3 tentatives : ${url}`)
  }
}

// ─── Parsing JSON-LD schema.org ──────────────────────────────────────────────

function findRecipeInJsonLd(obj) {
  if (!obj) return null
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findRecipeInJsonLd(item)
      if (found) return found
    }
    return null
  }
  if (typeof obj === 'object') {
    const type = obj['@type']
    if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) {
      return obj
    }
    // Cherche dans @graph
    if (obj['@graph']) return findRecipeInJsonLd(obj['@graph'])
  }
  return null
}

function parseIso8601Duration(duration) {
  if (!duration) return null
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/)
  if (!match) return null
  const hours = parseInt(match[1] || 0)
  const minutes = parseInt(match[2] || 0)
  return hours * 60 + minutes || null
}

function extractImageUrl(image) {
  if (!image) return null
  if (typeof image === 'string') return image
  if (Array.isArray(image)) return extractImageUrl(image[0])
  if (typeof image === 'object') return image.url || image.contentUrl || null
  return null
}

function extractServings(yieldVal) {
  if (!yieldVal) return null
  const str = Array.isArray(yieldVal) ? yieldVal[0] : String(yieldVal)
  const match = str.match(/\d+/)
  return match ? parseInt(match[0]) : null
}

function extractSteps(instructions) {
  if (!instructions) return []
  if (typeof instructions === 'string') return [instructions.trim()].filter(Boolean)
  if (Array.isArray(instructions)) {
    return instructions.map((step) => {
      if (typeof step === 'string') return step.trim()
      if (step['@type'] === 'HowToStep') return (step.text || step.name || '').trim()
      if (step['@type'] === 'HowToSection') return extractSteps(step.itemListElement)
      return ''
    }).flat().filter(Boolean)
  }
  return []
}

function parseJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray()
  for (const script of scripts) {
    try {
      const json = JSON.parse($(script).html())
      const recipe = findRecipeInJsonLd(json)
      if (!recipe) continue

      const prepTime = parseIso8601Duration(recipe.prepTime)
      const cookTime = parseIso8601Duration(recipe.cookTime)
      const totalTime = parseIso8601Duration(recipe.totalTime)

      return {
        title: recipe.name || null,
        imageUrl: extractImageUrl(recipe.image),
        prepTime: totalTime || (prepTime && cookTime ? prepTime + cookTime : prepTime || cookTime),
        servings: extractServings(recipe.recipeYield),
        ingredients: (recipe.recipeIngredient || []).map((s) => s.trim()).filter(Boolean),
        steps: extractSteps(recipe.recipeInstructions)
      }
    } catch (e) {
      continue
    }
  }
  return null
}

// ─── Parsing Microdata ───────────────────────────────────────────────────────

function parseMicrodata($) {
  const ingredients = $('[itemprop="recipeIngredient"], [itemprop="ingredients"]')
    .map((_, el) => $(el).text().trim()).get().filter(Boolean)

  const stepsEl = $('[itemprop="recipeInstructions"] [itemprop="text"]')
  const steps = stepsEl.length
    ? stepsEl.map((_, el) => $(el).text().trim()).get().filter(Boolean)
    : $('[itemprop="recipeInstructions"]').map((_, el) => $(el).text().trim()).get().filter(Boolean)

  if (ingredients.length === 0 && steps.length === 0) return null

  return {
    title: $('[itemprop="name"]').first().text().trim() || null,
    imageUrl: $('[itemprop="image"]').first().attr('src') || $('[itemprop="image"]').first().attr('content') || null,
    prepTime: null,
    servings: null,
    ingredients,
    steps
  }
}

// ─── Parsing heuristique CSS ─────────────────────────────────────────────────

function parseHeuristic($) {
  const ingrKeywords = /ingr[ée]dient|composant/i
  const stepKeywords = /pr[ée]paration|instruction|[ée]tape|recette|r[ée]alisation/i

  let ingredients = []
  let steps = []

  // Cherche les ingrédients
  $('h2, h3, h4, strong, .title, [class*="title"], [class*="heading"]').each((_, el) => {
    if (ingrKeywords.test($(el).text())) {
      const list = $(el).nextAll('ul, ol').first()
      if (list.length) {
        ingredients = list.find('li').map((_, li) => $(li).text().trim()).get().filter(Boolean)
        return false // break
      }
    }
  })

  // Cherche les étapes
  $('h2, h3, h4, strong, .title, [class*="title"], [class*="heading"]').each((_, el) => {
    if (stepKeywords.test($(el).text())) {
      const list = $(el).nextAll('ol, ul').first()
      if (list.length) {
        steps = list.find('li').map((_, li) => $(li).text().trim()).get().filter(Boolean)
        return false
      }
    }
  })

  // Fallback : chercher par classes CSS communes
  if (ingredients.length === 0) {
    const sel = $('[class*="ingredient"], [class*="ingr"]')
    if (sel.length) ingredients = sel.map((_, el) => $(el).text().trim()).get().filter(Boolean)
  }
  if (steps.length === 0) {
    const sel = $('[class*="step"], [class*="instruction"], [class*="direction"]')
    if (sel.length) steps = sel.map((_, el) => $(el).text().trim()).get().filter(Boolean)
  }

  if (ingredients.length > 50) ingredients = []
  if (steps.length > 30) steps = []

  if (ingredients.length === 0 && steps.length === 0) return null

  return {
    title: $('h1').first().text().trim() || $('title').text().trim() || null,
    imageUrl: $('meta[property="og:image"]').attr('content') || null,
    prepTime: null,
    servings: null,
    ingredients,
    steps
  }
}

function parseMarkdownRecipe(markdown, url) {
  const lines = String(markdown || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const title = lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') || null

  const ingredients = []
  const steps = []
  let section = null

  for (const line of lines) {
    if (/ingr[ée]dient/i.test(line)) {
      section = 'ingredients'
      continue
    }
    if (/pr[ée]paration|instruction|[ée]tape/i.test(line)) {
      section = 'steps'
      continue
    }
    if (line.startsWith('#')) {
      section = null
      continue
    }

    const isListLine = /^\s*(?:[-*]|\d+\.)\s+/.test(line)
    if (!isListLine) continue

    const cleaned = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim()
    if (!cleaned) continue

    if (section === 'ingredients') ingredients.push(cleaned)
    if (section === 'steps') steps.push(cleaned)
  }

  return {
    title,
    imageUrl: null,
    prepTime: null,
    servings: null,
    ingredients,
    steps,
    sourceUrl: url,
    partial: ingredients.length === 0 || steps.length === 0
  }
}

// ─── Fonction principale ─────────────────────────────────────────────────────

async function scrapeRecipe(rawUrl) {
  const url = await resolveUrl(rawUrl)
  console.log(`URL résolue : ${url}`)
  const { html, isMarkdown } = await fetchPage(url)

  if (isMarkdown) {
    return parseMarkdownRecipe(html, url)
  }

  const $ = cheerio.load(html)

  // Cascade de parsers
  const result = parseJsonLd($)
    ?? parseMicrodata($)
    ?? parseHeuristic($)

  if (!result) {
    return {
      title: $('h1').first().text().trim() || null,
      imageUrl: $('meta[property="og:image"]').attr('content') || null,
      prepTime: null,
      servings: null,
      ingredients: [],
      steps: [],
      sourceUrl: url,
      partial: true
    }
  }

  const partial = result.ingredients.length === 0 || result.steps.length === 0

  return {
    ...result,
    title: result.title || $('h1').first().text().trim() || 'Recette sans titre',
    imageUrl: result.imageUrl || $('meta[property="og:image"]').attr('content') || null,
    sourceUrl: url,
    partial
  }
}

module.exports = { scrapeRecipe }
