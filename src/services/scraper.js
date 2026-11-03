const axios = require('axios')
const cheerio = require('cheerio')
const { APIError } = require('./errorHandler')

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY
const SHORT_LINK_DOMAINS = ['bit.ly', 'tinyurl.com', 'shorturl.at', 'ow.ly', 'buff.ly', 't.co']

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

// Les pages sont téléchargées en binaire puis décodées avec leur propre encodage :
// sinon une page en ISO-8859-1 donne « Cr�me br�l�e ».
function detectCharset(contentType, buffer) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '')
  if (fromHeader) return fromHeader[1]
  const head = buffer.subarray(0, 4096).toString('latin1')
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)
  return fromMeta ? fromMeta[1] : 'utf-8'
}

function decodeHtmlResponse(res) {
  const { data } = res
  if (typeof data === 'string') return data
  if (!data) return ''
  const buffer = Buffer.from(data)
  const charset = detectCharset(res.headers?.['content-type'], buffer)
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

const HTML_ENTITY_REGEX = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i

// Convertit les codes HTML (&eacute;, &amp;, &#039;...) et retire les balises.
// Deux passes au maximum pour les textes encodés deux fois (&amp;eacute;).
function htmlToText(value) {
  let text = String(value ?? '')
  for (let pass = 0; pass < 2 && (/[<&]/.test(text)); pass += 1) {
    if (pass > 0 && !HTML_ENTITY_REGEX.test(text)) break
    text = cheerio.load(text, null, false).text()
  }
  return text.replace(/\s+/g, ' ').trim()
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

function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

// Compare le nom de domaine exact : avec un simple `includes`, « chocolat.com » passait pour « t.co »
function isShortLink(url) {
  const hostname = getHostname(url)
  return SHORT_LINK_DOMAINS.some((domain) => hostMatches(hostname, domain))
}

// pin.it, pinterest.com, fr.pinterest.com, pinterest.fr, pinterest.co.uk...
function isPinterestUrl(url) {
  const hostname = getHostname(url)
  return hostMatches(hostname, 'pin.it') || /(^|\.)pinterest\.[a-z.]+$/.test(hostname)
}

async function resolveUrl(url) {
  if (!isShortLink(url)) return url

  try {
    const res = await withRetry('resolveUrl', async () => axios.get(url, {
      timeout: 12000,
      maxRedirects: 10,
      headers: DEFAULT_HEADERS,
    }))

    return res.request?.res?.responseUrl || res.config.url || url
  } catch (err) {
    if (err.request?.res?.responseUrl) return err.request.res.responseUrl
    throw new Error(`Impossible de résoudre le lien : ${url}`)
  }
}

// ─── Pinterest ───────────────────────────────────────────────────────────────

// Une page de pin ne contient pas la recette : elle renvoie vers le site d'origine
// via <meta property="og:see_also">. On importe ce site-là à la place.
function extractPinterestSourceUrl(html) {
  const $ = cheerio.load(html)
  const candidates = [
    $('meta[property="og:see_also"]').attr('content'),
    $('meta[name="og:see_also"]').attr('content'),
  ]
  return candidates.find((link) => /^https?:\/\//i.test(link || '') && !isPinterestUrl(link)) || null
}

async function resolvePinterestSource(pinUrl) {
  const fetchers = [
    async () => {
      const res = await axios.get(pinUrl, {
        timeout: 15000,
        maxRedirects: 10,
        responseType: 'arraybuffer',
        headers: DEFAULT_HEADERS,
      })
      return decodeHtmlResponse(res)
    },
    async () => (await fetchViaScraperApi(pinUrl))?.html || '',
  ]

  for (const fetchHtml of fetchers) {
    try {
      const sourceUrl = extractPinterestSourceUrl(await fetchHtml())
      if (sourceUrl) {
        console.log(`[scraper] Pin Pinterest -> source : ${sourceUrl}`)
        return sourceUrl
      }
    } catch (err) {
      console.log(`[scraper] Lecture du pin Pinterest échouée : ${err.message || err}`)
    }
  }

  throw new APIError(
    'Ce pin Pinterest ne renvoie vers aucun site de recette. Ouvrez le pin, puis importez directement le lien du site d\'origine.',
    422,
    'PINTEREST_NO_SOURCE',
    { url: pinUrl }
  )
}

// ─── Fetch avec fallback ─────────────────────────────────────────────────────

async function fetchDirect(url) {
  const res = await withRetry('fetch direct', async () => axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    decompress: true,
    responseType: 'arraybuffer',
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

  const html = decodeHtmlResponse(res)
  if (!html || html.length < 300) return null
  return { html, method: 'direct' }
}

async function fetchViaScraperApi(url) {
  if (!SCRAPER_API_KEY) return null
  const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&country_code=fr&render=true`
  const res = await withRetry('fetch scraperapi', async () => axios.get(scraperUrl, {
    timeout: 35000,
    responseType: 'arraybuffer',
    headers: DEFAULT_HEADERS,
  }))

  const html = decodeHtmlResponse(res)
  if (!html || html.length < 300) return null
  return { html, method: 'scraperapi' }
}

async function fetchOgImage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        ...DEFAULT_HEADERS,
        'Accept': 'text/html,application/xhtml+xml'
      },
      responseType: 'arraybuffer'
    })
    // cheerio décode les &amp; présents dans les URLs d'images
    const $ = cheerio.load(decodeHtmlResponse(res).slice(0, 20000))
    const imageUrl = $('meta[property="og:image"]').attr('content')
      || $('meta[name="twitter:image"]').attr('content')
    if (imageUrl) return toAbsoluteImageUrl(imageUrl, url)
  } catch {
    // no-op
  }
  return null
}

async function fetchPage(url) {
  console.log(`[scraper] fetchPage start for: ${url}`)
  let directResult = null
  try {
    directResult = await fetchDirect(url)
    if (directResult && hasRecipeSignals(directResult.html)) {
      return directResult
    }
    if (directResult) {
      console.log('[scraper] Direct fetch ok mais signaux faibles. tentative via ScraperAPI...')
    }
  } catch (err) {
    const status = err.response?.status
    console.log(`[scraper] Fetch direct échoué (${status ?? 'réseau'}), tentative via ScraperAPI...`)
  }

  const scraperApiResult = await fetchViaScraperApi(url).catch(() => null)
  if (scraperApiResult) {
    console.log(`[scraper] Source retenue: scraperapi (len=${scraperApiResult.html.length})`)
    return scraperApiResult
  }

  if (directResult) {
    console.log(`[scraper] Source retenue: direct malgré signaux faibles (len=${directResult.html.length})`)
    return directResult
  }

  throw new Error(`Impossible d'accéder à la page après toutes les tentatives : ${url}`)
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
  if (typeof image === 'string') return image.includes('&') ? htmlToText(image) : image
  if (Array.isArray(image)) return extractImageUrl(image[0], fallbackUrl)
  if (typeof image === 'object') return image.url || image.contentUrl || image.thumbnailUrl || image.src || fallbackUrl
  return fallbackUrl
}

function toAbsoluteImageUrl(imageUrl, pageUrl) {
  if (!imageUrl) return imageUrl
  try {
    return new URL(imageUrl, pageUrl).href
  } catch {
    return imageUrl
  }
}

function extractServings(yieldVal) {
  if (!yieldVal) return null
  // recipeYield peut être [4, "4 personnes"] : un nombre n'a pas de .match()
  const str = String(Array.isArray(yieldVal) ? yieldVal[0] : yieldVal)
  const match = str.match(/\d+/)
  return match ? parseInt(match[0]) : null
}

function extractSteps(instructions) {
  if (!instructions) return []

  function clean(text) {
    return htmlToText(String(text || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
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

// Beaucoup de sites laissent des retours à la ligne ou tabulations bruts dans
// leurs textes JSON, ce qui rend le JSON invalide. On les échappe, mais
// uniquement à l'intérieur des chaînes (ailleurs ce sont des espaces valides).
function escapeControlCharsInJsonStrings(json) {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      } else if (ch < ' ') {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ' '
        continue
      }
    } else if (ch === '"') {
      inString = true
    }
    out += ch
  }
  return out
}

function parseJsonLenient(text) {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(escapeControlCharsInJsonStrings(text))
  }
}

function toTextList(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : [])
  return list.map(htmlToText).filter(Boolean)
}

function parseJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray()
  for (const script of scripts) {
    try {
      const json = parseJsonLenient($(script).html())
      const recipe = findRecipeInJsonLd(json)
      if (!recipe) continue

      const prepTime = parseIso8601Duration(recipe.prepTime)
      const cookTime = parseIso8601Duration(recipe.cookTime)
      const totalTime = parseIso8601Duration(recipe.totalTime)

      return {
        title: htmlToText(recipe.name) || null,
        imageUrl: extractImageUrl(recipe.image, recipe.thumbnailUrl),
        prepTime: prepTime || null,
        cookTime: cookTime || null,
        totalTime: totalTime || (prepTime && cookTime ? prepTime + cookTime : prepTime || cookTime),
        servings: extractServings(recipe.recipeYield),
        ingredients: toTextList(recipe.recipeIngredient || recipe.ingredients),
        steps: extractSteps(recipe.recipeInstructions)
      }
    } catch (e) {
      continue
    }
  }
  return null
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

// ─── Fonction principale ─────────────────────────────────────────────────────

async function scrapeRecipe(rawUrl) {
  let url = await resolveUrl(rawUrl)
  if (isPinterestUrl(url)) {
    url = await resolvePinterestSource(url)
  }
  console.log(`URL résolue : ${url}`)
  const { html, method } = await fetchPage(url)
  const contentSnippet = String(html || '').slice(0, 1200).replace(/\s+/g, ' ')

  const $ = cheerio.load(html)

  const parsers = [
    { name: 'JSON-LD', fn: parseJsonLd },
    { name: 'Heuristic', fn: parseHeuristic },
  ]

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
    const fallbackImage = toAbsoluteImageUrl($('meta[property="og:image"]').attr('content') || null, url)
    console.log(`[scraper] No parser matched. method=${method} title=${String(fallbackTitle)}`)

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

  if (partial) {
    console.log(`[scraper] Partial recipe extracted. method=${method} parser=${parserUsed} ingredients=${(result.ingredients||[]).length} steps=${(result.steps||[]).length}`)
  } else {
    console.log(`[scraper] Full recipe extracted. method=${method} parser=${parserUsed} title=${result.title} ingredients=${result.ingredients.length} steps=${result.steps.length}`)
  }

  return {
    ...result,
    title: result.title || $('h1').first().text().trim() || 'Recette sans titre',
    imageUrl: toAbsoluteImageUrl(result.imageUrl, url)
      || toAbsoluteImageUrl($('meta[property="og:image"]').attr('content') || null, url)
      || await fetchOgImage(url)
      || null,
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
