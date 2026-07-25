/**
 * inference-engine.js
 *
 * Public facade for ScrollCollector inference.
 *
 * Semantic tiers (via lib/inference/router.js):
 *   Tier 1 — Browser Prompt API (Chrome Gemini Nano / Edge Phi-4-mini)
 *   Tier 2 — WebGPU Transformers.js (Brave and others without Prompt API)
 *   Tier 4 — Cloud API (deferred stub)
 *
 * Tier 3 — Rule-based keyword fallback (always available)
 */
import { buildSystemPrompt, buildUserPrompt, buildMatchSystemPrompt, buildMatchPromptEnhancementSystemPrompt, buildPromptTagExtractionSystemPrompt, buildTagEvalGenerationSystemPrompt, buildAuthorMatchSystemPrompt } from './prompt-builder.js';
import { inferJson, checkEngineStatus as routerCheckEngineStatus } from './inference/router.js';
export { parseModelJson } from './inference/types.js';

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
// Semantic inference (Tier 1 / 2 / 4 via router)
// ---------------------------------------------------------------------------

/**
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [responseConstraint]
 * @returns {Promise<{ data: object, engine: string, tier: number } | null>}
 */
async function trySemanticInference(systemPrompt, userPrompt, responseConstraint = null) {
  return inferJson({ systemPrompt, userPrompt, responseConstraint });
}

// ---------------------------------------------------------------------------
// Tier 3 — Keyword Fallback (enhanced with custom tag support)
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

  for (const tagObj of enabledTags) {
    const label = typeof tagObj === 'string' ? tagObj : tagObj.label;
    const prompt = typeof tagObj === 'object' ? (tagObj.prompt || '') : '';

    // Use built-in keywords or auto-generate from tag label
    let keywords = new Set(KEYWORD_MAP[label] || generateCustomKeywords(label));

    // If there is an evaluation prompt, extract significant keywords from it to improve matching!
    if (prompt && prompt.trim()) {
      const promptKeywords = extractSignificantKeywords(prompt);
      promptKeywords.forEach(kw => keywords.add(kw));
    }

    // Tally matches
    let score = 0;
    const hitKeywords = [];
    for (const kw of keywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        score += kw.includes(' ') ? 2 : 1;
        hitKeywords.push(kw);
      }
    }

    if (score > 0) {
      tagScores.push({ name: label, rawScore: score, hitKeywords });
    }
  }

  if (tagScores.length === 0) {
    return { tags: [] };
  }

  tagScores.sort((a, b) => b.rawScore - a.rawScore);
  const topTags = tagScores.slice(0, 3);
  
  const maxScore = topTags[0].rawScore;
  const normalizedTags = topTags.map(t => ({
    name: t.name,
    score: Number((t.rawScore / maxScore).toFixed(2)),
    hitKeywords: t.hitKeywords
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
  'video', 'watch', 'share', 'comment', 'today', 'people', 'time', 'years', 'using', 'make', 'good', 'great', 'awesome',
  // Prompt instructions & metadata noise
  'identify', 'related', 'relates', 'find', 'posts', 'category', 'categories', 'tag', 'tags', 'match', 'matches',
  'information', 'content', 'belong', 'belongs', 'belongs to', 'related to'
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
 * @param {Array<{label: string, prompt: string}>} customTags - Enabled custom/default tags.
 * @param {string[]} dynamicTags    - Enabled dynamic tag labels.
 * @returns {Promise<{category: string, dynamicTag?: string}>} The classification result.
 */
export async function classify(text, sourcePlatform, customTags, dynamicTags) {
  const customTagLabels = customTags.map(t => t.label);
  const systemPrompt = buildSystemPrompt(customTags);
  const userPrompt = buildUserPrompt(text, sourcePlatform);

  const semantic = await trySemanticInference(systemPrompt, userPrompt);

  if (semantic?.data) {
    const nativeResult = semantic.data;
    let resultTags = [];
    
    if (nativeResult.tags && Array.isArray(nativeResult.tags)) {
      resultTags = nativeResult.tags.filter(t => {
        return customTagLabels.includes(t.name) || dynamicTags.includes(t.name);
      });
    }

    // Process dynamic tag
    let finalDynamicTag = null;
    if (nativeResult.dynamicTag) {
      const cleanedDynamic = cleanTagName(nativeResult.dynamicTag);
      if (cleanedDynamic) {
        // Map dynamic tag back to custom tag if it matches case-insensitively
        const matchedCustom = customTagLabels.find(t => t.toLowerCase() === cleanedDynamic.toLowerCase());
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
       return { tags: resultTags.slice(0, 3), dynamicTag: finalDynamicTag, engine: semantic.engine };
    }
  }

  // Tier 3: Keyword Fallback
  // Pass 1: Try custom tags (pass full custom tags so we can read prompts)
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
    
    return { tags: uniqueTags, engine: 'Rule-based Classifier' };
  }

  // Pass 3: Extract a new dynamic tag from text
  const extracted = extractNounTopic(text);
  if (extracted) {
    const cleanedDynamic = cleanTagName(extracted);
    if (cleanedDynamic) {
      const matchedCustom = customTags.find(t => t.label.toLowerCase() === cleanedDynamic.toLowerCase());
      if (matchedCustom) return { tags: [{ name: matchedCustom.label, score: 1.0 }], engine: 'Rule-based Classifier' };

      const matchedDynamic = dynamicTags.find(t => t.toLowerCase() === cleanedDynamic.toLowerCase());
      if (matchedDynamic) return { tags: [{ name: matchedDynamic, score: 1.0 }], engine: 'Rule-based Classifier' };

      return { tags: [], dynamicTag: cleanedDynamic, engine: 'Rule-based Classifier' };
    }
  }

  return { tags: [], dynamicTag: null, engine: 'Rule-based Classifier' };
}

/**
 * Extracts auto-detected tags from a given match prompt string.
 *
 * @param {string} matchPrompt - The user's query prompt.
 * @returns {Promise<string[]>} List of inferred tag names.
 */
export async function extractTagsFromPrompt(matchPrompt) {
  if (!matchPrompt || matchPrompt.trim() === '') {
    return [];
  }
  
  const sysPrompt = buildPromptTagExtractionSystemPrompt();
  
  // Wrap user prompt
  const userPrompt = `"${matchPrompt}"`;

  try {
    const result = await trySemanticInference(sysPrompt, userPrompt);
    if (result?.data?.tags && Array.isArray(result.data.tags)) {
      return result.data.tags.slice(0, 3);
    }
  } catch (err) {
    console.warn('[inference-engine] Error extracting tags from prompt:', err);
  }

  // Fallback if semantic inference is unavailable or fails
  const dynamicTag = extractNounTopic(matchPrompt);
  if (dynamicTag) {
    const cleaned = cleanTagName(dynamicTag);
    if (cleaned) return [cleaned];
  }

  return [];
}

/**
 * Automatically suggests a prompt evaluation for a new tag using AI.
 * 
 * @param {string} tagName - The name of the tag.
 * @param {string} currentPrompt - Existing prompt if any.
 * @returns {Promise<string>} The generated prompt.
 */
export async function autoSuggestTagPrompt(tagName, currentPrompt = '') {
  if (!tagName || !tagName.trim()) return '';

  const sysPrompt = buildTagEvalGenerationSystemPrompt(currentPrompt);
  const userPrompt = `Tag Name: "${tagName}"`;

  try {
    const result = await trySemanticInference(sysPrompt, userPrompt);
    if (result?.data?.prompt) {
      return result.data.prompt.trim();
    }
  } catch (err) {
    console.warn('[inference-engine] Error generating tag prompt:', err);
  }

  return `Find posts related to ${tagName}.`;
}

/**
 * Extract significant words (non-stop-words) from a text.
 * 
 * @param {string} text - The input query or prompt.
 * @returns {string[]} Filtered unique keywords.
 */
export function extractSignificantKeywords(text) {
  if (!text) return [];
  const words = text
    .replace(/[^\w\s-]/g, '')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  return Array.from(new Set(words));
}

/**
 * Extract multi-word phrases (quoted sequences or non-stopword bigrams/trigrams).
 * 
 * @param {string} text - The input query or prompt.
 * @returns {string[]} Filtered unique phrases.
 */
export function extractSignificantPhrases(text) {
  if (!text) return [];
  
  const phrases = [];
  
  // Extract quoted strings
  const quoteRegex = /"([^"]+)"/g;
  let match;
  while ((match = quoteRegex.exec(text)) !== null) {
    if (match[1] && match[1].trim().length > 2) {
      phrases.push(match[1].toLowerCase().trim());
    }
  }
  
  // Extract contiguous non-stopword word sequences (bigrams/trigrams)
  const cleanText = text.replace(/[^\w\s-]/g, ' ');
  const words = cleanText.split(/\s+/).filter(Boolean);
  
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i].toLowerCase();
    const w2 = words[i+1].toLowerCase();
    if (w1.length >= 2 && w2.length >= 2 && !STOP_WORDS.has(w1) && !STOP_WORDS.has(w2)) {
      phrases.push(`${w1} ${w2}`);
      if (i < words.length - 2) {
        const w3 = words[i+2].toLowerCase();
        if (w3.length >= 2 && !STOP_WORDS.has(w3)) {
          phrases.push(`${w1} ${w2} ${w3}`);
        }
      }
    }
  }
  
  return Array.from(new Set(phrases));
}

/** Patterns for low-value social feed noise that should never pass eval match. */
const SOCIAL_NOISE_PATTERNS = [
  /\breacted to your (?:post|comment|update|photo|video|story)\b/i,
  /\bliked your (?:post|comment|update|photo|video|story)\b/i,
  /\bcommented on your (?:post|update|photo|video)\b/i,
  /\bshared your (?:post|update|photo|video)\b/i,
  /\bviewed your profile\b/i,
  /\b(?:and )?\d+ others reacted\b/i,
  /\b(?:sent|accepted) (?:you )?an? invitation to connect\b/i,
  /\bwould like to connect\b/i,
  /\bis celebrating\b/i,
  /\bstarted a new position\b/i,
  /\b(?:great|good|nice|happy|pleased|glad|amazing|excited) to (?:be )?connect(?:ed|ing)?\b/i,
  /\b(?:let'?s|lets) (?:connect|chat|catch up)\b/i,
  /\b(?:hi|hello|hey),?\s+\w+[,!.]?\s*(?:great|good|nice|happy|pleased|glad|amazing|excited) to connect\b/i,
];

/**
 * Returns true when text looks like a notification, connection boilerplate, or profile snippet.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSocialNoise(text) {
  if (!text || text.trim().length < 20) return true;
  return SOCIAL_NOISE_PATTERNS.some(pattern => pattern.test(text));
}

/** Keywords too ambiguous for eval gate on their own (substring-prone or generic). */
const WEAK_EVAL_KEYWORDS = new Set([
  'star', 'stars', 'eat', 'food', 'cook', 'cooking', 'recipe', 'chef', 'meal',
  'menu', 'quality', 'arts'
]);

/**
 * Match a whole word or phrase (phrases may use substring; single tokens use word boundaries).
 *
 * @param {string} text
 * @param {string} term
 * @returns {boolean}
 */
export function containsEvalTerm(text, term) {
  if (!text || !term) return false;
  const trimmed = term.trim();
  if (!trimmed) return false;
  if (trimmed.includes(' ')) {
    return text.toLowerCase().includes(trimmed.toLowerCase());
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Build weighted eval keywords from prompt tags only (no synonym expansions).
 *
 * @param {string} matchPrompt
 * @param {string[]} matchPromptTags
 * @returns {{ tagKeywords: string[], promptKeywords: string[], tagKeywordSources: Map<string, string> }}
 */
export function buildEvalKeywords(matchPrompt, matchPromptTags = []) {
  /** @type {Map<string, string>} keyword -> source tag label */
  const tagKeywordSources = new Map();
  const tagKeywords = new Set();

  for (const tag of matchPromptTags || []) {
    const label = (tag || '').trim();
    if (!label) continue;
    const labelLower = label.toLowerCase();
    tagKeywords.add(labelLower);
    tagKeywordSources.set(labelLower, label);

    labelLower.split(/[\s&,\-/]+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
      .forEach(w => {
        tagKeywords.add(w);
        if (!tagKeywordSources.has(w)) tagKeywordSources.set(w, label);
      });
  }

  const promptKeywords = new Set(
    extractSignificantKeywords(matchPrompt).filter(w => w.length >= 4 && !WEAK_EVAL_KEYWORDS.has(w))
  );
  for (const kw of tagKeywords) promptKeywords.delete(kw);

  return {
    tagKeywords: Array.from(tagKeywords),
    promptKeywords: Array.from(promptKeywords),
    tagKeywordSources
  };
}

/**
 * Build high-signal phrases from prompt tags (not instructional prompt bigrams).
 *
 * @param {string[]} matchPromptTags
 * @returns {string[]}
 */
export function buildEvalPhrases(matchPromptTags = []) {
  const phrases = new Set();
  for (const tag of matchPromptTags || []) {
    const label = (tag || '').toLowerCase().trim();
    if (label.length >= 5) phrases.add(label);
    const words = label.split(/[\s&,\-/]+/).filter(w => w.length >= 2 && !STOP_WORDS.has(w));
    for (let i = 0; i < words.length - 1; i++) {
      phrases.add(`${words[i]} ${words[i + 1]}`);
      if (i < words.length - 2) phrases.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  }
  return Array.from(phrases).filter(p => p.length >= 5);
}

/**
 * Rule-based eval scoring. Requires a strong signal — generic prompt bigrams are ignored.
 *
 * @param {string} text
 * @param {string} matchPrompt
 * @param {string[]} matchPromptTags
 * @returns {{ doesMatch: boolean, score: number, matchedPhrases: string[], matchedKeywords: string[] }}
 */
export function scoreRuleBasedEvalMatch(text, matchPrompt, matchPromptTags = []) {
  const matchedPhrases = [];
  const matchedKeywords = [];

  for (const phrase of buildEvalPhrases(matchPromptTags)) {
    if (containsEvalTerm(text, phrase)) matchedPhrases.push(phrase);
  }

  const { tagKeywords, promptKeywords, tagKeywordSources } = buildEvalKeywords(matchPrompt, matchPromptTags);

  let strongHits = 0;
  let weakHits = 0;

  for (const kw of tagKeywords) {
    if (!containsEvalTerm(text, kw)) continue;
    const source = tagKeywordSources.get(kw) || kw;
    const label = `${source}:${kw}`;
    matchedKeywords.push(label);
    if (WEAK_EVAL_KEYWORDS.has(kw)) {
      weakHits += 1;
    } else {
      strongHits += 1;
    }
  }

  for (const kw of promptKeywords) {
    if (containsEvalTerm(text, kw)) {
      matchedKeywords.push(`prompt:${kw}`);
      strongHits += 1;
    }
  }

  // Phrase from tags (e.g. "michelin star", "5 star cooking") is a strong signal
  const hasTagPhrase = matchedPhrases.length > 0;

  // Pass only with clear food-domain signal — never on weak substring accidents alone
  const doesMatch =
    hasTagPhrase && (strongHits >= 1 || matchedPhrases.some(p => p.length >= 10)) ||
    strongHits >= 2 ||
    (strongHits >= 1 && matchedPhrases.length >= 1);

  const score = matchedPhrases.length * 5 + strongHits * 3 + weakHits;

  return { doesMatch, score, matchedPhrases, matchedKeywords, strongHits, weakHits };
}

/**
 * Heuristic enhanced prompt when Gemini is unavailable.
 *
 * @param {string} matchPrompt
 * @param {string[]} matchPromptTags
 * @returns {string}
 */
export function heuristicEnhanceMatchPrompt(matchPrompt, matchPromptTags = []) {
  const tagHint = (matchPromptTags || []).filter(Boolean).slice(0, 4).join(', ');
  if (tagHint) {
    return `Collect substantive posts about ${tagHint}. Reject social notifications, connection messages, profile headlines, and engagement alerts.`;
  }
  return `Collect posts that substantively match: "${matchPrompt}". Reject social notifications, connection messages, and profile snippets.`;
}

/**
 * Expands a user match prompt into a stricter one-sentence eval criteria string.
 *
 * @param {string} matchPrompt
 * @param {string[]} matchPromptTags
 * @returns {Promise<string>}
 */
export async function enhanceMatchPrompt(matchPrompt, matchPromptTags = []) {
  if (!matchPrompt?.trim()) return '';

  const sysPrompt = buildMatchPromptEnhancementSystemPrompt();
  const tagLine = (matchPromptTags || []).length > 0
    ? `\nSuggested tags: ${matchPromptTags.join(', ')}`
    : '';
  const userPrompt = `Intent: "${matchPrompt}"${tagLine}`;

  try {
    const result = await trySemanticInference(sysPrompt, userPrompt);
    if (result?.data?.enhanced?.trim()) return result.data.enhanced.trim();
  } catch (err) {
    console.warn('[inference-engine] Error enhancing match prompt:', err);
  }

  return heuristicEnhanceMatchPrompt(matchPrompt, matchPromptTags);
}

export async function evaluateMatch(text, sourcePlatform, matchPrompt, options = {}) {
  const res = await evaluateMatchWithReason(text, sourcePlatform, matchPrompt, options);
  return res.doesMatch;
}

export async function evaluateMatchWithReason(text, sourcePlatform, matchPrompt, options = {}) {
  const { matchPromptTags = [], enhancedPrompt = '' } = options;

  if (!matchPrompt || !matchPrompt.trim()) {
    return { doesMatch: false, engine: 'Rule-based Classifier', reason: 'empty_prompt' };
  }

  if (isSocialNoise(text)) {
    return { doesMatch: false, engine: 'Rule-based Classifier', reason: 'social_noise' };
  }

  const effectivePrompt = enhancedPrompt?.trim() || matchPrompt;
  const systemPrompt = buildMatchSystemPrompt(effectivePrompt);
  const userPrompt = buildUserPrompt(text, sourcePlatform);

  const matchSchema = {
    type: 'object',
    properties: { matches: { type: 'boolean' } },
    required: ['matches']
  };
  const semantic = await trySemanticInference(systemPrompt, userPrompt, matchSchema);

  if (semantic?.data && typeof semantic.data.matches === 'boolean') {
    return { doesMatch: semantic.data.matches, engine: semantic.engine };
  }

  // Tier 3: Strict tag-aware keyword scoring (fail closed when uncertain)
  const ruleResult = scoreRuleBasedEvalMatch(text, matchPrompt, matchPromptTags);
  return {
    doesMatch: ruleResult.doesMatch,
    engine: 'Rule-based Classifier',
    matchedPhrases: ruleResult.matchedPhrases,
    matchedKeywords: ruleResult.matchedKeywords,
    score: ruleResult.score
  };
}

/**
 * Returns a status descriptor for the currently active inference engine.
 *
 * @returns {Promise<{tier: number, name: string, status: string}>}
 */
export async function checkEngineStatus() {
  return routerCheckEngineStatus();
}

/**
 * Heuristically determines if two author profiles likely refer to the same person.
 *
 * @param {{name: string, platform: string, url: string}} authorA
 * @param {{name: string, platform: string, url: string}} authorB
 * @returns {boolean} True if matched, false otherwise.
 */
export function heuristicAuthorMatch(authorA, authorB) {
  const nameA = (authorA.name || '').trim().toLowerCase();
  const nameB = (authorB.name || '').trim().toLowerCase();

  if (!nameA || !nameB) return false;

  // Exact clean match
  if (nameA === nameB) return true;

  // Helper to normalize name (remove @, spaces, punctuation, numbers)
  const normalize = (s) => s.replace(/[@_\-\s\d]/g, '');
  const normA = normalize(nameA);
  const normB = normalize(nameB);

  if (normA === normB && normA.length > 2) return true;

  // Check if one is a substring of the other (with a minimum length)
  if (normA.length > 3 && normB.length > 3) {
    if (normA.includes(normB) || normB.includes(normA)) {
      return true;
    }
  }

  // Check handles from URLs if available
  const getHandle = (url) => {
    if (!url) return '';
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      return last.replace('@', '').toLowerCase();
    } catch {
      return '';
    }
  };

  const handleA = getHandle(authorA.url);
  const handleB = getHandle(authorB.url);

  if (handleA && handleB && handleA === handleB) {
    return true;
  }

  // Simple edit distance (Levenshtein) fallback
  const dist = levenshteinDistance(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  const similarity = 1 - dist / maxLen;
  
  if (similarity > 0.8 && maxLen > 4) {
    return true;
  }

  return false;
}

function levenshteinDistance(s1, s2) {
  const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
  for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;
  for (let j = 1; j <= s2.length; j += 1) {
    for (let i = 1; i <= s1.length; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  return track[s2.length][s1.length];
}

/**
 * Determines if two author profiles refer to the same person.
 * First checks fast heuristics, then falls back to Gemini Nano if available.
 *
 * @param {{name: string, platform: string, url: string}} authorA
 * @param {{name: string, platform: string, url: string}} authorB
 * @returns {Promise<boolean>} True if matched, false otherwise.
 */
export async function evaluateAuthorMatch(authorA, authorB) {
  // 1. Fast heuristic check first
  if (heuristicAuthorMatch(authorA, authorB)) {
    return true;
  }

  const sysPrompt = buildAuthorMatchSystemPrompt();
  const userPrompt = `Profile A:\nName: "${authorA.name}"\nPlatform: "${authorA.platform}"\nURL: "${authorA.url}"\n\nProfile B:\nName: "${authorB.name}"\nPlatform: "${authorB.platform}"\nURL: "${authorB.url}"`;

  try {
    const semantic = await trySemanticInference(sysPrompt, userPrompt);
    if (semantic?.data && typeof semantic.data.isSame === 'boolean') {
      return semantic.data.isSame;
    }
  } catch (err) {
    console.warn('[inference-engine] evaluateAuthorMatch native inference error:', err);
  }

  return false;
}

