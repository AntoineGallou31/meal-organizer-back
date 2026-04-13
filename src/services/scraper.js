const axios = require('axios')
const cheerio = require('cheerio')

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY
const SHORT_LINK_DOMAINS = ['pin.it', 'bit.ly', 'tinyurl.com', 'shorturl.at', 'ow.ly', 'buff.ly', 't.co']

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
}

const RETRY_ATTEMPTS = Number(process.env.SCRAPER_RETRY_ATTEMPTS || 3)
const BACKOFF_BASE_MS = Number(process.env.SCRAPER_BACKOFF_BASE_MS || 500)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractHtmlFromResponseData(data) {
  return typeof data === 'string' ? data : ''
}

function hasRecipeSignals(content) {
  if (!content) return false
  return /application\/ld\+json|recipeIngredient|recipeInstructions|Ingr[ée]dients?|Pr[ée]paration|instructions?|\bétape\b/i.test(content)
}

async function withRetry(taskName, fn, attempts = RETRY_ATTEMPTS) {
  let lastError = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i)
    } catch (error) {
      lastError = error
      const isLast = i === attempts - 1
      if (isLast) break
      const jitter = Math.floor(Math.random() * 150)
      const backoff = BACKOFF_BASE_MS * Math.pow(2, i) + jitter
      console.log(`[scraper] ${taskName} attempt ${i + 1}/${attempts} failed: ${error.message || error}. retrying in ${backoff}ms`)
      await sleep(backoff)
    }
  }
  throw lastError
}

function isShortLink(url) {
  return SHORT_LINK_DOMAINS.some(domain => url.includes(domain))
}

async function resolveUrl(url) {
  if (!isShortLink(url) && !url.includes('pinterest.com')) return url

  try {
    const res = await withRetry('resolveUrl', async () => axios.get(url, {
      timeout: 12000,
      maxRedirects: 10,
      headers: DEFAULT_HEADERS,
    }))

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
  console.log(`[scraper] fetchPage start for: ${url}`)
  // Tentative 1 : fetch direct avec retries
  try {
    const res = await withRetry('fetch direct', async () => axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      decompress: true,
      headers: {
        ...DEFAULT_HEADERS,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://www.google.fr/'
      }
    }))

    const html = extractHtmlFromResponseData(res.data)
    if (hasRecipeSignals(html)) {
      return { html, method: 'direct' }
    }

    console.log('[scraper] Direct fetch succeeded but weak recipe signals. trying richer fallbacks...')
  } catch (err) {
    const status = err.response?.status
    console.log(`[scraper] Fetch direct échoué (${status ?? 'réseau'}), tenter ScraperAPI si clé présente...`)
  }

  // Tentative 2 : ScraperAPI
  if (SCRAPER_API_KEY) {
    try {
      const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&country_code=fr&render=true`
      console.log(`[scraper] ScraperAPI key present — calling ScraperAPI: ${scraperUrl}`)
      const res = await withRetry('fetch scraperapi', async () => axios.get(scraperUrl, {
        timeout: 35000,
        headers: DEFAULT_HEADERS,
      }))
      console.log(`[scraper] ScraperAPI response status: ${res.status} bodyLength=${String(res.data || '').length}`)
      const html = extractHtmlFromResponseData(res.data)
      if (hasRecipeSignals(html)) {
        return { html, method: 'scraperapi' }
      }
      console.log('[scraper] ScraperAPI returned weak recipe signals, trying Jina fallback...')
    } catch (err) {
      console.log('[scraper] ScraperAPI échoué:', err.message || err)
      console.log('[scraper] Fallback vers Jina.ai reader...')
    }
  }

  // Tentative 3 : Jina AI Reader (gratuit, sans clé)
  try {
    const jinaUrl = `https://r.jina.ai/${url}`
    const res = await withRetry('fetch jina', async () => axios.get(jinaUrl, {
      timeout: 22000,
      headers: {
        ...DEFAULT_HEADERS,
        'Accept': 'text/markdown,text/plain;q=0.9,*/*;q=0.8'
      }
    }))
    console.log(`[scraper] Jina.ai reader used — fetched markdown length=${String(res.data || '').length}`)
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
  // Support formats like P1DT2H30M15S, PT2H, PT30M15S
  const iso = String(duration)
  const match = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i)
  if (!match) return null
  const days = parseInt(match[1] || 0)
  const hours = parseInt(match[2] || 0)
  const minutes = parseInt(match[3] || 0)
  const seconds = parseInt(match[4] || 0)
  const totalMinutes = days * 1440 + hours * 60 + minutes + Math.round(seconds / 60)
  return totalMinutes || null
}

function extractImageUrl(image, fallbackUrl = null) {
  if (!image) return fallbackUrl
  if (typeof image === 'string') return image
  if (Array.isArray(image)) return extractImageUrl(image[0], fallbackUrl)
  if (typeof image === 'object') return image.url || image.contentUrl || image.thumbnailUrl || image.src || fallbackUrl
  return fallbackUrl
}

function extractServings(yieldVal) {
  if (!yieldVal) return null
  const str = Array.isArray(yieldVal) ? yieldVal[0] : String(yieldVal)
  const match = str.match(/\d+/)
  return match ? parseInt(match[0]) : null
}

function extractSteps(instructions) {
  if (!instructions) return []

  function clean(text) {
    return String(text || '')
      .replace(/(<([^>]+)>)/gi, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim()
  }

  if (typeof instructions === 'string') {
    return instructions.split(/<br\s*\/?>|\n/gi).map(clean).filter(Boolean)
  }

  if (Array.isArray(instructions)) {
    const out = instructions.map((step) => {
      if (!step) return ''
      if (typeof step === 'string') return clean(step)
      if (step['@type'] === 'HowToStep') return clean(step.text || step.name || '')
      if (step['@type'] === 'HowToSection') return extractSteps(step.itemListElement || step.instructions)
      // Some recipes nest itemListElement directly
      if (step.itemListElement) return extractSteps(step.itemListElement)
      return ''
    }).flat(Infinity).filter(Boolean)
    return out
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
        imageUrl: extractImageUrl(recipe.image, recipe.thumbnailUrl),
        prepTime: prepTime || null,
        cookTime: cookTime || null,
        totalTime: totalTime || (prepTime && cookTime ? prepTime + cookTime : prepTime || cookTime),
        servings: extractServings(recipe.recipeYield),
        ingredients: (recipe.recipeIngredient || recipe.ingredients || []).map((s) => String(s || '').replace(/(<([^>]+)>)/gi, "").trim()).filter(Boolean),
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

// ─── Parser Overblog spécifique ──────────────────────────────────────────────

function parseOverblog($) {
  let ingredients = []
  let steps = []
  let title = null

  // Overblog structure: titre avec "Ingrédients:" ou "Ingredients:"
  // suivi de bullets • ou listes, puis "Préparation:" suivi de liste numérotée

  // Cherche le titre principal
  title = $('h1, h2').first().text().trim() || null

  // Cherche ingrédients avec le pattern Overblog
  const allText = $.html()
  const ingredMatch = allText.match(/Ingr[ée]dient[s]?:?\s*\(([^)]+)\)([\s\S]*?)(?:Pr[ée]paration|Instruction|P r[ée]paration)/i)
  if (ingredMatch && ingredMatch[2]) {
    const ingredText = ingredMatch[2]
    // Extrait les lignes qui commencent par • ou qui sont en listes
    const lines = ingredText
      .split(/[•\n]/g)
      .map(line => line.replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, ' '))
      .filter(line => line.length > 3 && !line.match(/^\d+\s*\./))
    ingredients = lines.slice(0, 30) // Limite à 30 ingrédients
  }

  // Cherche étapes avec le pattern Overblog
  const stepMatch = allText.match(/Pr[ée]paration:?([\s\S]*?)(?:<\/article|<footer|COMMENTER|Photographies)/i)
  if (stepMatch && stepMatch[1]) {
    const stepText = stepMatch[1]
    // Cherche les listes numérotées
    const stepLines = stepText.split(/\n/g)
    for (const line of stepLines) {
      const clean = line.replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, ' ')
      // Pattern: "1. texte" ou "1 texte"
      if (/^\d+\.?\s+.{20,}/.test(clean)) {
        const stepText = clean.replace(/^\d+\.?\s+/, '').trim()
        if (stepText.length > 10) {
          steps.push(stepText)
        }
      }
    }
  }

  if (ingredients.length === 0 && steps.length === 0) return null

  return {
    title,
    imageUrl: $('meta[property="og:image"]').attr('content') || null,
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
      // Cherche d'abord le frère direct, sinon cherche descendant dans le container
      let list = $(el).nextAll('ul, ol').first()
      if (!list.length) {
        list = $(el).parent().find('ul, ol').first()
      }
      if (!list.length) {
        list = $(el).closest('section,article,div').find('ul, ol').first()
      }
      if (list.length) {
        ingredients = list.find('li').map((_, li) => $(li).text().trim()).get().filter(Boolean)
        return false // break
      }
    }
  })

  // Cherche les étapes
  $('h2, h3, h4, strong, .title, [class*="title"], [class*="heading"]').each((_, el) => {
    if (stepKeywords.test($(el).text())) {
      let list = $(el).nextAll('ol, ul').first()
      if (!list.length) list = $(el).parent().find('ol, ul').first()
      if (!list.length) list = $(el).closest('section,article,div').find('ol, ul').first()
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

  let title = lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') || null

  const ingredients = []
  const steps = []
  let section = null

  // More permissive, supports FR/EN headings and varied bullets
  const regexIngredients = /^(?:#+|\*\*)\s*(ingr[ée]dients?|composants?|what you need|ingredients?)\b/i
  const regexSteps = /^(?:#+|\*\*)\s*(pr[ée]paration|instructions?|étapes?|recette|réalisation|directions?|method|steps?)\b/i

  for (const line of lines) {
    if (regexIngredients.test(line)) { section = 'ingredients'; continue }
    if (regexSteps.test(line)) { section = 'steps'; continue }
    if (/^#+/.test(line)) { section = null; continue }

    const isListLine = /^\s*(?:[-*•]|\d+\.)\s+/.test(line)
    if (!isListLine) continue

    let cleanedText = line.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim()
    cleanedText = cleanedText.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    cleanedText = cleanedText.replace(/(<([^>]+)>)/gi, '').trim()

    if (cleanedText.length > 2) {
      if (section === 'ingredients') ingredients.push(cleanedText)
      if (section === 'steps') steps.push(cleanedText)
    }
  }

  // Si aucun titre trouvé avec #, cherche le premier titre
  let finalTitle = title
  if (!finalTitle) {
    const boldTitle = lines.find((line) => /^\*\*[^*]+\*\*/.test(line))
    if (boldTitle) finalTitle = boldTitle.replace(/\*\*/g, '')
  }

  return {
    title: finalTitle || null,
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
  const { html, isMarkdown, method } = await fetchPage(url)
  const contentSnippet = String(html || '').slice(0, 1200).replace(/\s+/g, ' ')

  if (isMarkdown) {
    const markdownResult = parseMarkdownRecipe(html, url)
    return {
      ...markdownResult,
      scrapingMeta: {
        method,
        parser: 'Markdown',
        resolvedUrl: url,
        contentSnippet,
      },
    }
  }

  const $ = cheerio.load(html)

  // Détecte Overblog
  const isOverblog = html.includes('over-blog') || html.includes('overblog') || url.includes('.over-blog.')
  // Cascade de parsers : try each parser in order and stop on a result with ingredients+steps
  const parsers = isOverblog
    ? [{ name: 'Overblog', fn: parseOverblog }, { name: 'JSON-LD', fn: parseJsonLd }, { name: 'Microdata', fn: parseMicrodata }, { name: 'Heuristic', fn: parseHeuristic }]
    : [{ name: 'JSON-LD', fn: parseJsonLd }, { name: 'Microdata', fn: parseMicrodata }, { name: 'Heuristic', fn: parseHeuristic }]

  let result = null
  let parserUsed = null
  for (const p of parsers) {
    try {
      const res = p.fn($)
      if (res && Array.isArray(res.ingredients) && Array.isArray(res.steps) && (res.ingredients.length > 0 && res.steps.length > 0)) {
        result = res
        parserUsed = p.name
        break
      }
      // keep a partial result as fallback
      if (!result && res) { result = res; parserUsed = p.name }
    } catch (e) {
      continue
    }
  }

  if (!result) {
    const fallbackTitle = $('h1').first().text().trim() || null
    const fallbackImage = $('meta[property="og:image"]').attr('content') || null
    const htmlSnippet = String(html || '').slice(0, 800).replace(/\s+/g, ' ')
    const hasKeywords = Boolean((html || '').match(/Ingrédients|Préparation|ingredients|Préparation:/i))
    console.log(`[scraper] No parser matched. method=${method} title=${String(fallbackTitle)} hasKeywords=${hasKeywords} htmlSnippet=${htmlSnippet}`)
    return {
      title: fallbackTitle,
      imageUrl: fallbackImage,
      prepTime: null,
      servings: null,
      ingredients: [],
      steps: [],
      sourceUrl: url,
      partial: true,
      scrapingMeta: {
        method,
        parser: 'none',
        resolvedUrl: url,
        contentSnippet,
      },
    }
  }

  const partial = (result.ingredients || []).length === 0 || (result.steps || []).length === 0

  // Log details when recipe is partial so we can debug what was retrieved
  if (partial) {
    const titleFound = result.title || $('h1').first().text().trim() || null
    const imgFound = result.imageUrl || $('meta[property="og:image"]').attr('content') || null
    const htmlSnippet = String(html || '').slice(0, 800).replace(/\s+/g, ' ')
    const hasKeywords = Boolean((html || '').match(/Ingrédients|Préparation|ingredients|Préparation:/i))
    console.log(`[scraper] Partial recipe extracted. method=${method} parser=${parserUsed} title=${String(titleFound)} ingredients=${(result.ingredients||[]).length} steps=${(result.steps||[]).length} img=${Boolean(imgFound)} hasKeywords=${hasKeywords} htmlSnippet=${htmlSnippet}`)
    if (isMarkdown) {
      const mdSnippet = String(html || '').slice(0, 800).replace(/\s+/g, ' ')
      console.log(`[scraper] Markdown snippet: ${mdSnippet}`)
    }
  } else {
    console.log(`[scraper] Full recipe extracted. method=${method} parser=${parserUsed} title=${result.title} ingredients=${result.ingredients.length} steps=${result.steps.length}`)
  }

  return {
    ...result,
    title: result.title || $('h1').first().text().trim() || 'Recette sans titre',
    imageUrl: result.imageUrl || $('meta[property="og:image"]').attr('content') || null,
    sourceUrl: url,
    partial,
    scrapingMeta: {
      method,
      parser: parserUsed || 'unknown',
      resolvedUrl: url,
      contentSnippet,
    },
  }
}

module.exports = { scrapeRecipe }
