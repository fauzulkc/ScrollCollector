/**
 * inference-engine.js
 *
 * Two-tier AI inference router for text classification.
 *
 * Tier 1 — Chrome Gemini Nano (on-device LLM via the Prompt API)
 * Tier 2 — Keyword-based fallback scoring (enhanced with custom tag support)
 *
 * The router always attempts Tier 1 first and gracefully degrades to
 * Tier 2 when Gemini Nano is unavailable or returns an unusable result.
 */

import { buildSystemPrompt, buildUserPrompt } from './prompt-builder.js';

// ---------------------------------------------------------------------------
// Keyword map for Tier 2 fallback (massively expanded for accuracy)
// ---------------------------------------------------------------------------

const KEYWORD_MAP = {
  'Health': ['health', 'medical', 'doctor', 'hospital', 'fitness', 'mental health', 'nutrition', 'exercise', 'therapy', 'disease', 'wellness', 'workout', 'diet', 'healthcare', 'symptom'],
  'Jobs': ['job', 'career', 'hiring', 'resume', 'interview', 'recruiting', 'salary', 'workplace', 'employment', 'vacancies', 'profession', 'software engineer', 'manager', 'developer', 'full-time', 'part-time', 'remote', 'hybrid', 'actively reviewing applicants', 'apply', 'director', 'recruiter', 'contract', 'freelance'],
  'Politics': ['government', 'election', 'policy', 'law', 'regulation', 'vote', 'political', 'legislation', 'democracy', 'geopolitics'],
  'Tech/AI': ['software', 'programming', 'developer', 'code', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'neural network', 'digital', 'algorithm', 'app', 'computer', 'startup', 'web', 'cybersecurity'],
  'Weather': ['weather', 'forecast', 'rain', 'storm', 'temperature', 'climate', 'sunny', 'cloudy', 'hurricane', 'snow', 'meteorology'],
  'Ad': ['sponsored', 'ad', 'advertisement', 'promo code', 'discount', 'buy now', 'limited time', 'sale'],
  'News': ['breaking news', 'update', 'report', 'journalism', 'press', 'coverage', 'headline', 'announcement'],
  'Entertainment': ['movie', 'film', 'music', 'concert', 'celebrity', 'streaming', 'gaming', 'tv show', 'comedy', 'drama'],
  'Promotion': ['promotion', 'giveaway', 'special offer', 'deal', 'marketing', 'campaign', 'brand'],
  'Personal Opinion': ['in my opinion', 'i think', 'personally', 'my thoughts', 'perspective', 'viewpoint'],
  'Portfolio': ['portfolio', 'my work', 'showcase', 'projects', 'case study', 'design', 'art'],
  'Product Showcase': ['product launch', 'new feature', 'demo', 'introducing', 'check out our', 'showcase'],
  'Immigration': ['immigration', 'visa', 'passport', 'citizenship', 'green card', 'asylum', 'border'],
  'Migration': ['migration', 'relocation', 'moving abroad', 'expat', 'emigration', 'settle'],
  'Study': ['study', 'student', 'university', 'learning', 'education', 'college', 'course', 'degree', 'scholarship', 'exam'],
  'International News': ['world news', 'global', 'international', 'foreign affairs', 'united nations', 'overseas'],
  'Sports': ['game', 'team', 'player', 'championship', 'league', 'score', 'coach', 'tournament', 'athlete', 'match'],
  'Events': ['event', 'conference', 'webinar', 'meetup', 'festival', 'summit', 'workshop'],
  'Blog': ['blog', 'article', 'post', 'read my', 'new post', 'blogger'],
  'Vlog': ['vlog', 'video log', 'youtube', 'watch my', 'channel'],
  'Culture': ['culture', 'tradition', 'heritage', 'society', 'customs', 'art', 'history'],
  'NGO': ['ngo', 'non-profit', 'charity', 'volunteer', 'donation', 'foundation', 'humanitarian'],
  'Policy': ['policy', 'guidelines', 'rules', 'regulation', 'compliance', 'framework'],
  'Release': ['release', 'v1.0', 'changelog', 'patch notes', 'update', 'version'],
  'History': ['history', 'historical', 'ancient', 'century', 'past', 'timeline', 'archives']
};

// ---------------------------------------------------------------------------
// Tier 1 — Chrome Gemini Nano (Prompt API)
// ---------------------------------------------------------------------------

/**
 * Attempts classification via Chrome's built-in Gemini Nano model.
 *
 * @param {string} systemPrompt - The system-level instruction prompt.
 * @param {string} userPrompt   - The user-level text-to-classify prompt.
 * @returns {Promise<{category: string} | null>} Parsed result or null if unavailable.
 */
async function tryNativeInference(systemPrompt, userPrompt) {
  try {
    // Guard: the Prompt API surface must exist on the global scope
    if (!self.ai?.languageModel) {
      return null;
    }

    const capabilities = await self.ai.languageModel.capabilities();

    if (capabilities.available === 'readily') {
      // Model is downloaded and ready — run inference
      const session = await self.ai.languageModel.create({ systemPrompt });
      try {
        const result = await session.prompt(userPrompt);
        return JSON.parse(result);
      } finally {
        session.destroy();
      }
    }

    if (capabilities.available === 'after-download') {
      // Trigger the model download for future calls, but can't classify now
      console.info('[inference-engine] Gemini Nano model download triggered.');
      const session = await self.ai.languageModel.create({ systemPrompt });
      session.destroy();
      return null;
    }

    // Model is explicitly unavailable on this device/browser
    return null;
  } catch (err) {
    console.warn('[inference-engine] Tier 1 (Gemini Nano) failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Keyword Fallback (enhanced with custom tag support)
// ---------------------------------------------------------------------------

/** @type {Record<string, string[]>} */
const CUSTOM_TAG_EXPANSIONS = {
  'restaurant': ['food', 'dining', 'cafe', 'bistro', 'eats', 'menu', 'chef', 'cook', 'cooking', 'delicious', 'meal', 'lunch', 'dinner', 'breakfast', 'restaurant', 'restaurants', 'eatout', 'diningout'],
  'food': ['cooking', 'recipe', 'meal', 'delicious', 'dish', 'dining', 'eat', 'eats', 'hungry', 'restaurant', 'cafe', 'kitchen', 'chef', 'snack', 'beverage', 'cuisine'],
  'cooking': ['recipe', 'kitchen', 'chef', 'bake', 'grill', 'cook', 'meals', 'ingredient', 'food', 'culinary', 'cookery'],
  'travel': ['trip', 'vacation', 'flight', 'hotel', 'destination', 'explore', 'tourism', 'journey', 'adventure', 'wanderlust', 'booking', 'cruise', 'luggage', 'passport'],
  'crypto': ['bitcoin', 'ethereum', 'blockchain', 'token', 'solana', 'nft', 'defi', 'wallet', 'crypto', 'cryptocurrency', 'mining', 'btc', 'eth', 'web3', 'ledger'],
  'gaming': ['game', 'games', 'gamer', 'playstation', 'xbox', 'nintendo', 'steam', 'esports', 'pc gaming', 'console', 'gameplay', 'retro', 'multiplayer'],
  'marketing': ['seo', 'advertising', 'brand', 'social media', 'campaign', 'sales', 'funnel', 'growth hacking', 'lead generation', 'copywriting', 'publicity'],
  'real estate': ['housing', 'apartment', 'property', 'mortgage', 'rent', 'landlord', 'tenant', 'buying home', 'realtor', 'condo', 'residential', 'listing'],
  'career': ['job', 'hiring', 'resume', 'interview', 'recruiting', 'cv', 'salary', 'promotion', 'workplace', 'employment', 'vacancies', 'profession'],
  'fashion': ['clothing', 'style', 'apparel', 'outfit', 'designer', 'beauty', 'wardrobe', 'trends', 'model', 'accessory', 'jewelry', 'shoes'],
  'book': ['reading', 'novel', 'literature', 'author', 'writer', 'novel', 'library', 'ebook', 'chapters', 'fiction', 'non-fiction'],
  'history': ['historical', 'ancient', 'century', 'timeline', 'war', 'civilization', 'archaeology', 'archives', 'heritage', 'epoch'],
  'music': ['song', 'album', 'concert', 'band', 'singer', 'musician', 'spotify', 'track', 'melody', 'lyrics', 'audio', 'sound', 'tune'],
  'art': ['painting', 'drawing', 'sculpture', 'gallery', 'museum', 'artist', 'design', 'illustration', 'creative', 'exhibition', 'masterpiece']
};

/**
 * Generate keywords for a custom tag that doesn't exist in KEYWORD_MAP.
 * Uses the tag label words themselves + common morphological variants + synonym expansions.
 *
 * @param {string} tagLabel - e.g. "restaurant" or "Web Development"
 * @returns {string[]} Auto-generated keyword list
 */
function generateCustomKeywords(tagLabel) {
  const words = tagLabel.toLowerCase()
    .split(/[\s&,\-/]+/)
    .filter(w => w.length >= 2);

  const keywords = new Set(words);
  // Add the full label as a phrase match
  keywords.add(tagLabel.toLowerCase());

  // Add common morphological variants and expansions
  for (const word of words) {
    if (word.endsWith('s')) keywords.add(word.slice(0, -1));
    else keywords.add(word + 's');

    if (word.endsWith('ing')) {
      keywords.add(word.slice(0, -3));    // cooking → cook
      keywords.add(word.slice(0, -3) + 'er'); // cooking → cooker
    }
    if (word.endsWith('er')) {
      keywords.add(word.slice(0, -2));    // developer → develop
      keywords.add(word.slice(0, -2) + 'ing'); // developer → developing
    }
    if (!word.endsWith('ing')) keywords.add(word + 'ing');
    if (!word.endsWith('ed'))  keywords.add(word + 'ed');

    // Add matching common synonym list if any
    const expansion = CUSTOM_TAG_EXPANSIONS[word];
    if (expansion) {
      expansion.forEach(k => keywords.add(k));
    }
  }

  return Array.from(keywords).filter(k => k.length >= 3);
}

/**
 * Scores each enabled tag by counting case-insensitive keyword hits in
 * the input text. Supports both built-in categories (KEYWORD_MAP) and
 * user-created custom tags (auto-generated keywords from label).
 *
 * Returns the highest-scoring category or 'Unclassified'.
 *
 * @param {string}   text        - The raw text to classify.
 * @param {string[]} enabledTags - Labels the user has enabled.
 * @returns {{category: string}} Classification result.
 */
export function keywordFallback(text, enabledTags) {
  const lowerText = text.toLowerCase();

  const tagScores = [];

  for (const tag of enabledTags) {
    // Use built-in keywords or auto-generate from tag label
    const keywords = KEYWORD_MAP[tag] || generateCustomKeywords(tag);

    // Tally the number of distinct keyword matches
    let score = 0;
    for (const kw of keywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        // Multi-word phrases get bonus weight (more specific = more signal)
        score += kw.includes(' ') ? 2 : 1;
      }
    }

    if (score > 0) {
      tagScores.push({ name: tag, rawScore: score });
    }
  }

  if (tagScores.length === 0) {
    return { tags: [] };
  }

  tagScores.sort((a, b) => b.rawScore - a.rawScore);
  const topTags = tagScores.slice(0, 3);
  
  // Normalize scores between 0.0 and 1.0 based on the highest score
  const maxScore = topTags[0].rawScore;
  const normalizedTags = topTags.map(t => ({
    name: t.name,
    score: Number((t.rawScore / maxScore).toFixed(2))
  }));

  return { tags: normalizedTags };
}

// ---------------------------------------------------------------------------
// Helpers for Dynamic Tag Extraction
// ---------------------------------------------------------------------------

/** Common English stop words and social media noise */
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'arent', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'cant', 'cannot', 'could',
  'couldnt', 'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he', 'hed', 'hell', 'hes', 'her', 'here',
  'heres', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'hows', 'i', 'id', 'ill', 'im', 'ive', 'if', 'in',
  'into', 'is', 'isnt', 'it', 'its', 'itself', 'lets', 'me', 'more', 'most', 'mustnt', 'my', 'myself', 'no', 'nor',
  'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'shant', 'she', 'shed', 'shell', 'shes', 'should', 'shouldnt', 'so', 'some', 'such', 'than', 'that',
  'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'theres', 'these', 'they', 'theyd',
  'theyll', 'theyre', 'theyve', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'wasnt', 'we', 'wed', 'well', 'were', 'weve', 'werent', 'what', 'whats', 'when', 'whens', 'where', 'wheres',
  'which', 'while', 'who', 'whos', 'whom', 'why', 'whys', 'with', 'wont', 'would', 'wouldnt', 'you', 'youd',
  'youll', 'youre', 'youve', 'your', 'yours', 'yourself', 'yourselves',
  // Conversational/social media noise
  'just', 'like', 'really', 'would', 'could', 'should', 'think', 'get', 'one', 'new', 'post', 'feed', 'click', 'link',
  'video', 'watch', 'share', 'comment', 'today', 'people', 'time', 'years', 'using', 'make', 'good', 'great', 'awesome'
]);

/**
 * Extract a dynamic topic tag (noun/entity) from text.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractNounTopic(text) {
  if (!text) return null;

  // Split into sentences to distinguish sentence-starting capitalization
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const wordCounts = {};

  for (const sentence of sentences) {
    const words = sentence
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 3);

    words.forEach((word, idx) => {
      const lower = word.toLowerCase();
      if (STOP_WORDS.has(lower)) return;

      const isCapitalized = /^[A-Z]/.test(word);
      const isFirstWord = idx === 0;

      let score = 1;
      if (isCapitalized) {
        score += isFirstWord ? 1 : 3; // Bonus for mid-sentence capitalization (proper noun)
      }

      if (!wordCounts[lower]) {
        wordCounts[lower] = {
          text: word,
          score: 0
        };
      }
      wordCounts[lower].score += score;
    });
  }

  const candidates = Object.values(wordCounts).sort((a, b) => b.score - a.score);
  return candidates.length > 0 ? candidates[0].text : null;
}

/**
 * Format and sanitize an extracted topic name.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function cleanTagName(name) {
  if (!name) return null;
  // Strip special chars, keep alphanumeric, spaces, and dashes
  let clean = name.replace(/[^\w\s-]/g, '').trim();
  // Title Case each word
  clean = clean.split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  // Cap at 20 characters
  if (clean.length > 20) {
    clean = clean.substring(0, 20).trim();
  }
  return clean || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies text into one of the user's enabled tag categories.
 *
 * Attempts Tier 1 (Gemini Nano) first, then falls back to Tier 2
 * (keyword matching) if the native model is unavailable or errors out.
 *
 * Custom tags always take priority.
 *
 * @param {string}   text           - The text fragment to classify.
 * @param {string}   sourcePlatform - Origin platform (e.g. 'twitter').
 * @param {string[]} customTags     - Enabled custom/default tag labels.
 * @param {string[]} dynamicTags    - Enabled dynamic tag labels.
 * @returns {Promise<{category: string, dynamicTag?: string}>} The classification result.
 */
export async function classify(text, sourcePlatform, customTags, dynamicTags) {
  const systemPrompt = buildSystemPrompt(customTags);
  const userPrompt = buildUserPrompt(text, sourcePlatform);

  // Tier 1: Chrome Gemini Nano
  const nativeResult = await tryNativeInference(systemPrompt, userPrompt);

  if (nativeResult) {
    let resultTags = [];
    
    // Process returned tags, filtering out any that aren't in customTags or dynamicTags
    if (nativeResult.tags && Array.isArray(nativeResult.tags)) {
      resultTags = nativeResult.tags.filter(t => {
        return customTags.includes(t.name) || dynamicTags.includes(t.name);
      });
    }

    // Process dynamic tag
    let finalDynamicTag = null;
    if (nativeResult.dynamicTag) {
      const cleanedDynamic = cleanTagName(nativeResult.dynamicTag);
      if (cleanedDynamic) {
        // Map dynamic tag back to custom tag if it matches case-insensitively
        const matchedCustom = customTags.find(t => t.toLowerCase() === cleanedDynamic.toLowerCase());
        if (matchedCustom) {
          if (!resultTags.some(t => t.name === matchedCustom)) {
             resultTags.push({ name: matchedCustom, score: 1.0 });
          }
        } else {
          const matchedDynamic = dynamicTags.find(t => t.toLowerCase() === cleanedDynamic.toLowerCase());
          if (matchedDynamic) {
            if (!resultTags.some(t => t.name === matchedDynamic)) {
               resultTags.push({ name: matchedDynamic, score: 1.0 });
            }
          } else {
            finalDynamicTag = cleanedDynamic;
          }
        }
      }
    }

    if (resultTags.length > 0 || finalDynamicTag) {
       resultTags.sort((a, b) => b.score - a.score);
       return { tags: resultTags.slice(0, 3), dynamicTag: finalDynamicTag };
    }
  }

  // Tier 2: Keyword Fallback
  // Pass 1: Try custom tags
  const customMatch = keywordFallback(text, customTags);
  
  // Pass 2: Try dynamic tags if needed to fill up to 3
  const dynamicMatch = dynamicTags.length > 0 ? keywordFallback(text, dynamicTags) : { tags: [] };
  
  let combinedTags = [...(customMatch.tags || []), ...(dynamicMatch.tags || [])];
  
  if (combinedTags.length > 0) {
    // Re-sort and take top 3
    combinedTags.sort((a, b) => b.score - a.score);
    
    // Deduplicate just in case
    const uniqueTags = [];
    const seen = new Set();
    for (const t of combinedTags) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        uniqueTags.push(t);
        if (uniqueTags.length === 3) break;
      }
    }
    
    return { tags: uniqueTags };
  }

  // Pass 3: Extract a new dynamic tag from text
  const extracted = extractNounTopic(text);
  if (extracted) {
    const cleanedDynamic = cleanTagName(extracted);
    if (cleanedDynamic) {
      const matchedCustom = customTags.find(t => t.toLowerCase() === cleanedDynamic.toLowerCase());
      if (matchedCustom) return { tags: [{ name: matchedCustom, score: 1.0 }] };

      const matchedDynamic = dynamicTags.find(t => t.toLowerCase() === cleanedDynamic.toLowerCase());
      if (matchedDynamic) return { tags: [{ name: matchedDynamic, score: 1.0 }] };

      return { tags: [], dynamicTag: cleanedDynamic };
    }
  }

  return { tags: [] };
}

/**
 * Returns a status descriptor for the currently active inference engine.
 *
 * @returns {Promise<{tier: number, name: string, status: string}>}
 */
export async function checkEngineStatus() {
  try {
    if (self.ai?.languageModel) {
      const capabilities = await self.ai.languageModel.capabilities();

      if (capabilities.available === 'readily') {
        return { tier: 1, name: 'Gemini Nano', status: 'ready' };
      }
      if (capabilities.available === 'after-download') {
        return { tier: 1, name: 'Gemini Nano', status: 'downloading' };
      }

      // API exists but model is not usable
      return { tier: 1, name: 'Gemini Nano', status: 'unavailable' };
    }
  } catch {
    // Prompt API threw — treat as unavailable
  }

  // Prompt API not present at all — fall back to rule-based engine
  return { tier: 2, name: 'Rule-based Classifier', status: 'ready' };
}
