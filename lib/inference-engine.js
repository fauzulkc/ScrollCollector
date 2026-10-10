/**
 * inference-engine.js
 *
 * Public facade for ScrollCollector inference.
 *
 * Semantic tier: an injectable JSON generator (setSemanticGenerator), by default the browser's
 * built-in LanguageModel (lib/decision/providers/nano.js) when it is ready. It backs the
 * configuration helpers (extractTagsFromPrompt, enhanceMatchPrompt, autoSuggestTagPrompt,
 * evaluateAuthorMatch) and the legacy classify / evaluateMatchWithReason path; every helper falls
 * back to its heuristic when no generator can answer.
 *
 * Rules tier: deterministic keyword rules, the last resort when no model can answer. They are
 * deliberately conservative: weak evidence produces a low score (or no tag at all) so the decision
 * cascade can mark the post uncertain instead of guessing.
 *
 * Every rules-tier comparison goes through normalizeForMatch(), so LinkedIn "math bold" text
 * (𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻), zero-width characters and letter case never change the outcome.
 */
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildMatchSystemPrompt,
  buildMatchPromptEnhancementSystemPrompt,
  buildPromptTagExtractionSystemPrompt,
  buildTagEvalGenerationSystemPrompt,
  buildAuthorMatchSystemPrompt,
  buildClassifySchema,
  PROMPT_TAGS_SCHEMA,
  ENHANCED_PROMPT_SCHEMA,
  TAG_EVAL_PROMPT_SCHEMA,
  AUTHOR_MATCH_SCHEMA,
  MATCH_SCHEMA
} from './prompt-builder.js';
import { createNanoProvider } from './decision/providers/nano.js';
import { noulConfidence } from './decision/confidence.js';
export { parseModelJson } from './decision/providers/schema-builder.js';

/** Engine name reported whenever the rules tier made the call. */
export const RULES_ENGINE = 'Rule-based Classifier';

// ---------------------------------------------------------------------------
// Keyword map for the rules tier (built-in default tags)
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
  // 'game', 'team', 'score' and 'match' are deliberately absent: "game-changing for your team" is not sport.
  'Sports': ['sports', 'athlete', 'championship', 'league', 'tournament', 'football', 'soccer', 'basketball', 'baseball', 'cricket', 'tennis', 'rugby', 'hockey', 'olympics', 'world cup', 'premier league', 'stadium', 'playoffs', 'coach'],
  'Events': ['event', 'conference', 'webinar', 'meetup', 'festival', 'summit', 'workshop'],
  'Blog': ['blog', 'article', 'post', 'read my', 'new post', 'blogger'],
  'Vlog': ['vlog', 'video log', 'youtube', 'watch my', 'channel'],
  'Culture': ['culture', 'tradition', 'heritage', 'society', 'customs', 'art', 'history'],
  'NGO': ['ngo', 'non-profit', 'charity', 'volunteer', 'donation', 'foundation', 'humanitarian'],
  'Policy': ['policy', 'guidelines', 'rules', 'regulation', 'compliance', 'framework'],
  'Release': ['release', 'v1.0', 'changelog', 'patch notes', 'update', 'version'],
  'History': ['history', 'historical', 'ancient', 'century', 'past', 'timeline', 'archives']
};

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

// ---------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------

/** Plain English stop words. */
const BASE_STOP_WORDS = [
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
  'youll', 'youre', 'youve', 'your', 'yours', 'yourself', 'yourselves'
];

/** Stop words plus social noise and junk fragments; used to reject dynamic topic candidates. */
const STOP_WORDS = new Set([
  ...BASE_STOP_WORDS,
  // Conversational/social media noise
  'just', 'like', 'really', 'would', 'could', 'should', 'think', 'get', 'one', 'new', 'post', 'feed', 'click', 'link',
  'video', 'watch', 'share', 'comment', 'today', 'people', 'time', 'years', 'using', 'make', 'good', 'great', 'awesome',
  // Prompt instructions & metadata noise
  'identify', 'related', 'relates', 'find', 'posts', 'category', 'categories', 'tag', 'tags', 'match', 'matches',
  'information', 'content', 'belong', 'belongs', 'belongs to', 'related to',
  // Additional junk fragments
  'soc', 'right', 'preparation', 'starts', 'start', 'gear', 'partner', 'update', 'thing', 'things', 'way', 'ways', 'story', 'week', 'day'
]);

const ENGLISH_STOP_WORDS = new Set(BASE_STOP_WORDS);

/**
 * Prompt filler: words that describe how the user asks ("find me really good posts about…"),
 * not what they want. Never used as evidence for a match or a tag.
 */
const WEAK_EVAL_KEYWORDS = new Set([
  // Asking and instruction verbs
  'find', 'finding', 'show', 'showing', 'shows', 'give', 'get', 'gets', 'see', 'look', 'looking', 'search', 'searching',
  'collect', 'collecting', 'want', 'wants', 'wanted', 'need', 'needs', 'help', 'please', 'identify', 'include',
  'including', 'keep', 'discover', 'recommend', 'let', 'mention', 'mentions', 'mentioning', 'reference', 'references',
  'discussing', 'describing', 'featuring', 'covering', 'involving',
  // The feed itself
  'post', 'posts', 'content', 'contents', 'feed', 'feeds', 'item', 'items', 'stuff', 'thing', 'things', 'topic',
  'topics', 'subject', 'subjects', 'kind', 'kinds', 'sort', 'sorts', 'category', 'categories', 'tag', 'tags',
  'information', 'info', 'example', 'examples', 'something', 'anything', 'everything',
  // Glue words missing from the stop list
  'me', 'myself', 'also', 'etc', 'whatever', 'lot', 'lots', 'bit', 'much', 'many', 'every', 'ever', 'just', 'only',
  'even', 'still', 'maybe', 'perhaps', 'about', 'related', 'relating', 'relates', 'relevant', 'regarding', 'around',
  'concerning', 'belong', 'belongs', 'match', 'matches', 'matching',
  // Taste and intensity words
  'quality', 'high', 'top', 'good', 'best', 'better', 'great', 'nice', 'cool', 'awesome', 'amazing', 'excellent',
  'fantastic', 'interesting', 'favourite', 'favorite', 'fun', 'exciting', 'really', 'very', 'truly', 'especially',
  'particularly', 'specifically', 'mostly', 'mainly', 'actually', 'basically', 'generally', 'usually', 'currently',
  // Feelings
  'interested', 'interest', 'interests', 'fascinated', 'fascinating', 'fascination', 'passionate', 'obsessed',
  'curious', 'love', 'loves', 'loved', 'loving', 'like', 'likes', 'liked', 'enjoy', 'enjoys', 'prefer',
  // Recency and social noise
  'new', 'latest', 'recent', 'recently', 'today', 'people', 'someone', 'anyone', 'share', 'shared', 'sharing',
  'click', 'link', 'comment', 'comments', 'make', 'using', 'think', 'one', 'time', 'years'
]);

/**
 * Keywords too common in ordinary posts to justify a tag on a single hit. They still count as
 * supporting evidence next to another hit (and for half weight in the score).
 */
const GENERIC_KEYWORDS = new Set([
  'team', 'teams', 'game', 'games', 'app', 'apps', 'web', 'digital', 'apply', 'manager', 'managers', 'update', 'updates',
  'tool', 'tools', 'learning', 'personal', 'remote', 'hybrid', 'contract', 'developer', 'developers', 'director',
  'career', 'careers', 'interview', 'interviews', 'workplace', 'profession', 'professional', 'player', 'players',
  'design', 'designs', 'project', 'projects', 'showcase', 'report', 'reports', 'coverage', 'headline', 'headlines',
  'announcement', 'global', 'international', 'overseas', 'history', 'culture', 'society', 'customs', 'tradition',
  'traditions', 'heritage', 'foundation', 'framework', 'frameworks', 'guidelines', 'policy', 'policies', 'compliance',
  'version', 'versions', 'release', 'releases', 'timeline', 'settle', 'course', 'courses', 'degree', 'studies',
  'migration', 'border', 'perspective', 'personally', 'introducing', 'promotion', 'promotions', 'streaming',
  'campaign', 'campaigns', 'marketing', 'article', 'articles', 'youtube', 'channel', 'forecast', 'forecasts',
  'health', 'exercise', 'product', 'products', 'platform', 'business', 'company', 'companies', 'customer',
  'customers', 'growth', 'launch', 'feature', 'features', 'support', 'service', 'services', 'system', 'systems',
  'solution', 'solutions', 'network', 'community', 'partner', 'partners', 'research', 'training', 'success',
  'journey', 'strategy', 'leader', 'leaders', 'leadership', 'innovation', 'opportunity', 'opportunities',
  'process', 'processes', 'experience', 'industry', 'future', 'market', 'markets', 'world', 'public', 'parties',
  'breaking', 'special', 'offers', 'displays', 'upcoming', 'written', 'sites', 'moving', 'region', 'country',
  'changes', 'events', 'event', 'media', 'press', 'startup', 'startups'
]);

/** Short keywords that are unambiguous enough to count as specific on their own. */
const SHORT_SPECIFIC_KEYWORDS = new Set(['llm', 'llms', 'gpt', 'ngo', 'ngos', 'nft', 'nfts', 'vlog', 'vlogs', 'defi', 'web3', 'v1.0']);

/** Words that negate the rest of a prompt clause ("…but not crypto"): what follows is not a match term. */
const NEGATION_WORDS = new Set(['not', 'no', 'never', 'without', 'except', 'excluding', 'exclude', 'avoid', 'dont', 'doesnt', 'nor']);

/** Feed pseudo-tags that are views, not classification targets. */
const PSEUDO_TAGS = new Set(['ads', 'all', 'favorites', 'favourites', 'unclassified']);

/** Normalized label -> built-in keywords, so 'tech/ai' finds 'Tech/AI'. */
const KEYWORD_MAP_BY_KEY = new Map(Object.entries(KEYWORD_MAP).map(([label, keywords]) => [label.toLowerCase(), keywords]));

// ---------------------------------------------------------------------------
// Text and tag normalization
// ---------------------------------------------------------------------------

/** Invisible format characters: soft hyphen, ZWSP/ZWNJ/ZWJ, LRM/RLM, bidi controls, word joiners, BOM. */
const INVISIBLE_CHARS_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Typographic apostrophes, folded to ' so "let’s connect" matches "let's connect". */
const APOSTROPHE_RE = /[\u2018\u2019\u201B\u2032\u02BC]/g;

const MAX_TAG_LENGTH = 60;

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * NFKC plus invisible-character stripping, case preserved.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cleanUnicode(value) {
  return toText(value).normalize('NFKC').replace(INVISIBLE_CHARS_RE, '');
}

/**
 * Canonical form for every rules-tier comparison: NFKC (LinkedIn math-bold 𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻 becomes
 * Michelin, full-width letters and ligatures fold too), zero-width characters stripped,
 * typographic apostrophes folded, lowercased, whitespace collapsed. Non-string input yields ''.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  return cleanUnicode(text).replace(APOSTROPHE_RE, "'").toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Cleans a tag list from any source (stored config, model output, legacy v0.9 `{name, weight}`
 * objects) into unique, trimmed strings. Entries without a usable name (null, objects without
 * name/label, nested arrays, '[object Object]') are dropped and duplicates are removed
 * case-insensitively, keeping the first spelling.
 *
 * @param {unknown} tags  array of strings or {name|label} objects, a single object, or a comma-separated string
 * @returns {string[]}
 */
export function normalizeTagList(tags) {
  let list;
  if (Array.isArray(tags)) list = tags;
  else if (typeof tags === 'string') list = tags.split(',');
  else if (tags && typeof tags === 'object') list = [tags];
  else return [];

  const out = [];
  const seen = new Set();
  for (const raw of list) {
    let name = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      name = [raw.name, raw.label, raw.tag].find(v => toText(v) !== '');
    }
    const clean = cleanUnicode(name)
      .replace(/\s+/g, ' ')
      .replace(/^[\s#"'`\u201C\u201D\u2018\u2019]+|[\s"'`\u201C\u201D\u2018\u2019,;]+$/g, '');
    if (!clean || clean.length > MAX_TAG_LENGTH) continue;
    if (!/[\p{L}\p{N}]/u.test(clean) || /^\[object \w+\]$/i.test(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * @param {unknown} label
 * @returns {boolean} true for feed views (Ads, All, Favorites, Unclassified) that are never classification targets
 */
function isPseudoTag(label) {
  return PSEUDO_TAGS.has(normalizeForMatch(label));
}

/**
 * True when a candidate tag name carries no topic (stop word, filler, pseudo-tag, too short).
 *
 * @param {string} name
 * @param {number} [minLength]
 * @returns {boolean}
 */
function isJunkTopic(name, minLength = 2) {
  const key = normalizeForMatch(name);
  if (key.length < minLength || !/\p{L}/u.test(key)) return true;
  return PSEUDO_TAGS.has(key) || STOP_WORDS.has(key) || WEAK_EVAL_KEYWORDS.has(key);
}

/**
 * Reads a tag given as a label string or a {label|name, prompt} object.
 *
 * @param {unknown} spec
 * @returns {{ label: string, prompt: string }}
 */
function readTagSpec(spec) {
  if (typeof spec === 'string') return { label: spec, prompt: '' };
  if (!spec || typeof spec !== 'object') return { label: '', prompt: '' };
  const label = typeof spec.label === 'string' ? spec.label : (typeof spec.name === 'string' ? spec.name : '');
  return { label, prompt: typeof spec.prompt === 'string' ? spec.prompt : '' };
}

// ---------------------------------------------------------------------------
// Term matching
// ---------------------------------------------------------------------------

const termRegexCache = new Map();
const TERM_REGEX_CACHE_LIMIT = 5000;

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plural-insensitive key for one matched word ("stars" and "star" share "star").
 *
 * @param {string} word
 * @returns {string}
 */
function singularize(word) {
  if (word.length >= 4 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** @param {string} word */
function isPluralizable(word) {
  return /^\p{L}{3,}$/u.test(word);
}

/**
 * Stem that a plural-tolerant matcher anchors on: "yields" -> "yield", "kids" stays "kids".
 *
 * @param {string} word
 */
function pluralBase(word) {
  return word.length >= 5 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * Literal text every match of the term must contain; a cheap includes() on it skips most regexes.
 *
 * @param {string} term
 */
function termNeedle(term) {
  const parts = term.split(/[\s-]+/).filter(Boolean);
  if (parts.length > 1) return parts[0];
  const word = parts[0] || term;
  return isPluralizable(word) ? pluralBase(word) : word;
}

/**
 * Compiled matcher for a normalized term. Single words need a letter/digit boundary on both sides
 * ("star" never matches "startups"); phrases need one at the start only ("michelin star" also
 * finds "michelin-starred") and accept a space or hyphen between words.
 *
 * @param {string} term
 * @param {boolean} plural  single words also match their plural/singular form
 * @returns {RegExp}
 */
function termRegex(term, plural) {
  const cacheKey = `${plural ? 1 : 0}\u0000${term}`;
  let re = termRegexCache.get(cacheKey);
  if (re) return re;

  const parts = term.split(/[\s-]+/).filter(Boolean);
  if (parts.length > 1) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(escapeRegExp).join('[\\s-]+')}`, 'u');
  } else {
    const word = parts[0] || term;
    const body = plural && isPluralizable(word) ? `${escapeRegExp(pluralBase(word))}(?:s|es)?` : escapeRegExp(word);
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u');
  }

  if (termRegexCache.size >= TERM_REGEX_CACHE_LIMIT) termRegexCache.clear();
  termRegexCache.set(cacheKey, re);
  return re;
}

/**
 * @param {string} normText  normalizeForMatch() output
 * @param {string} term      normalizeForMatch() output
 * @param {boolean} [plural]
 * @returns {string|null} the first matched text, or null
 */
function findTerm(normText, term, plural = false) {
  if (!normText || !term) return null;
  const match = termRegex(term, plural).exec(normText);
  return match ? match[0] : null;
}

/**
 * Match a whole word or a phrase after normalizing both sides (NFKC, zero-width stripped, case
 * folded). Single words need word boundaries; phrases need a leading boundary and tolerate a
 * hyphen between words.
 *
 * @param {string} text
 * @param {string} term
 * @returns {boolean}
 */
export function containsEvalTerm(text, term) {
  const normTerm = normalizeForMatch(term);
  if (!normTerm) return false;
  return findTerm(normalizeForMatch(text), normTerm) !== null;
}

/** @param {string} term */
function isGenericKeyword(term) {
  return GENERIC_KEYWORDS.has(term) || GENERIC_KEYWORDS.has(singularize(term)) || WEAK_EVAL_KEYWORDS.has(term);
}

/**
 * A keyword is specific enough to justify a tag on its own when it is long (>= 6 chars) and not
 * generic, or a curated unambiguous acronym.
 *
 * @param {string} term
 */
function isSpecificKeyword(term) {
  if (isGenericKeyword(term)) return false;
  // Judge the singular form, so a plural variant ("rights") is no more specific than its word ("right").
  return singularize(term).length >= 6 || SHORT_SPECIFIC_KEYWORDS.has(term);
}

/**
 * @typedef {object} RuleTerm
 * @property {string} term       normalized keyword or phrase
 * @property {string} needle     literal text any match must contain (see termNeedle)
 * @property {boolean} phrase    more than one word
 * @property {boolean} specific  enough evidence on its own (any phrase, or isSpecificKeyword)
 * @property {string} source     where it came from (tag label, 'prompt', 'phrase')
 */

/**
 * @param {string} term
 * @param {string} [source]
 * @returns {RuleTerm}
 */
function makeTerm(term, source = '') {
  const phrase = term.split(/[\s-]+/).filter(Boolean).length > 1;
  return { term, needle: termNeedle(term), phrase, specific: phrase || isSpecificKeyword(term), source };
}

/**
 * Matches terms against normalized text and folds overlapping evidence into concepts: plural
 * variants of a word count once, and a matched phrase absorbs its own words ("michelin star",
 * "michelin" and "star" in one sentence are one concept, not three).
 *
 * @param {string} normText
 * @param {RuleTerm[]} terms
 * @returns {{ term: RuleTerm, matched: string }[]} one entry per concept
 */
function collectConcepts(normText, terms) {
  const phraseHits = [];
  const wordHits = new Map();
  for (const t of terms) {
    if (!normText.includes(t.needle)) continue;
    const matched = findTerm(normText, t.term, true);
    if (matched === null) continue;
    if (t.phrase) {
      phraseHits.push({ term: t, matched, keys: matched.split(/[\s-]+/).filter(Boolean).map(singularize) });
      continue;
    }
    const key = singularize(matched);
    const previous = wordHits.get(key);
    if (!previous || (t.specific && !previous.term.specific)) wordHits.set(key, { term: t, matched });
  }

  phraseHits.sort((a, b) => b.keys.length - a.keys.length || b.matched.length - a.matched.length);
  const covered = new Set();
  const concepts = [];
  for (const hit of phraseHits) {
    if (hit.keys.every(k => covered.has(k))) continue;
    hit.keys.forEach(k => covered.add(k));
    concepts.push({ term: hit.term, matched: hit.matched });
  }
  for (const [key, hit] of wordHits) {
    if (!covered.has(key)) concepts.push(hit);
  }
  return concepts;
}

// ---------------------------------------------------------------------------
// Distinctive terms of prompts and labels
// ---------------------------------------------------------------------------

/** Clause separators: punctuation, '&', '+', '/', bullets and spaced dashes. */
const SEGMENT_SPLIT_RE = /[,.;:!?()[\]{}"|/\\&+…•·]+|\s[-–—]+\s/u;
/** Upper-case acronyms (AI, NGO, SOC) are kept even when shorter than 3 letters. */
const ACRONYM_RE = /(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{1,4}(?![\p{L}\p{N}])/gu;

const distinctiveTermsCache = new Map();
const DISTINCTIVE_TERMS_CACHE_LIMIT = 500;

/** @param {string} token */
function isNumberToken(token) {
  return /^\p{N}+$/u.test(token);
}

/**
 * @param {string} token
 * @param {Set<string>} acronyms
 */
function isDistinctiveWord(token, acronyms) {
  if (ENGLISH_STOP_WORDS.has(token) || WEAK_EVAL_KEYWORDS.has(token)) return false;
  if (!/\p{L}/u.test(token)) return false;
  return token.length >= 3 || acronyms.has(token);
}

/**
 * Distinctive terms of a natural-language prompt or tag label: content words (no stop words,
 * filler, bare numbers or words after a negation) plus the 2-3 word phrases they form within a
 * clause ("michelin star cooking" -> "michelin star", "star cooking", "michelin star cooking").
 * Numbers only appear inside phrases ("5 star"). `standalone` lists the words that are not part
 * of a compound ("hiring" in "job postings, hiring, resumes"); a compound's own words
 * ("organizations" in "non-governmental organizations") are too ambiguous for tag matching.
 *
 * @param {unknown} text
 * @returns {{ words: string[], phrases: string[], standalone: string[] }}
 */
function extractDistinctiveTerms(text) {
  const source = cleanUnicode(text);
  if (!source.trim()) return { words: [], phrases: [], standalone: [] };
  const cached = distinctiveTermsCache.get(source);
  if (cached) return cached;

  const acronyms = new Set((source.match(ACRONYM_RE) || []).map(a => a.toLowerCase()));
  const words = new Set();
  const phrases = new Set();
  const standalone = new Set();

  for (const segment of normalizeForMatch(source).split(SEGMENT_SPLIT_RE)) {
    let run = [];
    let negated = false;
    const flush = () => {
      const runWords = run.filter(t => !isNumberToken(t));
      if (runWords.length === 1 && run.length === 1) standalone.add(runWords[0]);
      for (let i = 0; i < run.length - 1; i++) {
        for (let len = 2; len <= 3 && i + len <= run.length; len++) {
          const slice = run.slice(i, i + len);
          if (!slice.every(isNumberToken)) phrases.add(slice.join(' '));
        }
      }
      run = [];
    };

    for (const raw of segment.split(/[^\p{L}\p{N}'-]+/u)) {
      const token = raw.replace(/^['-]+|['-]+$/g, '').replace(/'s$/, '').replace(/'/g, '');
      if (!token) continue;
      if (NEGATION_WORDS.has(token)) negated = true;
      if (negated) { flush(); continue; }
      if (isNumberToken(token)) { run.push(token); continue; }
      if (!isDistinctiveWord(token, acronyms)) { flush(); continue; }
      words.add(token);
      run.push(token);
    }
    flush();
  }

  const result = { words: [...words], phrases: [...phrases], standalone: [...standalone] };
  if (distinctiveTermsCache.size >= DISTINCTIVE_TERMS_CACHE_LIMIT) distinctiveTermsCache.clear();
  distinctiveTermsCache.set(source, result);
  return result;
}

// ---------------------------------------------------------------------------
// Rules-tier tag classification
// ---------------------------------------------------------------------------

/**
 * Generate keywords for a custom tag that doesn't exist in KEYWORD_MAP.
 * Uses the tag label words themselves + common morphological variants + synonym expansions.
 *
 * @param {string} tagLabel - e.g. "restaurant" or "Web Development"
 * @returns {string[]} Auto-generated keyword list
 */
export function generateCustomKeywords(tagLabel) {
  if (!tagLabel || typeof tagLabel !== 'string') return [];
  const rawLabel = normalizeForMatch(tagLabel);
  const words = rawLabel
    .split(/[\s&,\-/]+/)
    .filter(w => w.length >= 2);

  const isMultiWord = words.length > 1;
  const keywords = new Set();

  // Full phrase
  if (rawLabel) keywords.add(rawLabel);

  if (!isMultiWord) {
    for (const word of words) {
      keywords.add(word);
      if (word.endsWith('s')) {
        keywords.add(word.slice(0, -1));
      } else {
        keywords.add(word + 's');
      }

      const expansion = CUSTOM_TAG_EXPANSIONS[word];
      if (expansion) {
        expansion.forEach(k => keywords.add(k));
      }
    }
  } else {
    for (const word of words) {
      const expansion = CUSTOM_TAG_EXPANSIONS[word];
      if (expansion) {
        expansion.forEach(k => keywords.add(k));
      }
    }
    // Never emit bare individual words of a multi-word label
    words.forEach(w => keywords.delete(w));
  }

  return Array.from(keywords).filter(k => k.length >= 3);
}

const tagTermsCache = new Map();
const TAG_TERMS_CACHE_LIMIT = 500;

/**
 * Keywords for one tag: built-in or label-derived keywords, plus the distinctive nouns of its
 * evaluation prompt: standalone words and compound phrases, never instruction boilerplate or
 * the loose words inside a compound ("machine learning" adds the phrase, not "learning").
 *
 * @param {string} label
 * @param {string} prompt
 * @returns {RuleTerm[]}
 */
function getTagTerms(label, prompt) {
  const cacheKey = `${label}\u0000${prompt}`;
  const cached = tagTermsCache.get(cacheKey);
  if (cached) return cached;

  const terms = new Map();
  const add = (keyword) => {
    const term = normalizeForMatch(keyword);
    if (term.length >= 2 && !WEAK_EVAL_KEYWORDS.has(term) && !terms.has(term)) terms.set(term, makeTerm(term, label));
  };
  (KEYWORD_MAP_BY_KEY.get(normalizeForMatch(label)) || generateCustomKeywords(label)).forEach(add);
  if (prompt.trim()) {
    const { standalone, phrases } = extractDistinctiveTerms(prompt);
    standalone.forEach(add);
    phrases.forEach(add);
  }

  const result = [...terms.values()];
  if (tagTermsCache.size >= TAG_TERMS_CACHE_LIMIT) tagTermsCache.clear();
  tagTermsCache.set(cacheKey, result);
  return result;
}

/**
 * Rules-tier tagging. A tag needs either one specific hit (a phrase, or a word of 6+ characters
 * that is not generic) or two distinct hits; a single short or generic hit ("team", "apply",
 * "code") is not enough. Scores are absolute, min(1, weightedHits / 3) with phrases weighted 2,
 * specific words 1 and generic words 0.5, so one specific hit scores 0.33 and the cascade can
 * treat it as uncertain. The best tag is never stretched to 1.0.
 *
 * Pseudo-tags (Ads, All, Favorites, Unclassified) are never returned.
 *
 * @param {string} text
 * @param {Array<string|{label: string, prompt?: string}>} enabledTags
 * @returns {{ tags: { name: string, score: number, hitKeywords: string[] }[] }} up to 3 tags, best first
 */
export function keywordFallback(text, enabledTags) {
  const normText = normalizeForMatch(text);
  if (!normText || !Array.isArray(enabledTags)) return { tags: [] };

  const tagScores = [];
  const seen = new Set();
  for (const spec of enabledTags) {
    const { label, prompt } = readTagSpec(spec);
    const key = normalizeForMatch(label);
    if (!key || PSEUDO_TAGS.has(key) || seen.has(key)) continue;
    seen.add(key);

    const concepts = collectConcepts(normText, getTagTerms(label, prompt));
    if (concepts.length === 0) continue;
    const specificHits = concepts.filter(c => c.term.specific).length;
    if (specificHits === 0 && concepts.length < 2) continue;

    const weighted = concepts.reduce((sum, c) => sum + (c.term.phrase ? 2 : c.term.specific ? 1 : 0.5), 0);
    tagScores.push({
      name: label,
      score: Math.min(1, weighted / 3),
      weighted,
      hitKeywords: concepts.map(c => c.term.term)
    });
  }

  tagScores.sort((a, b) => b.score - a.score || b.weighted - a.weighted);
  return {
    tags: tagScores.slice(0, 3).map(t => ({
      name: t.name,
      score: Number(t.score.toFixed(2)),
      hitKeywords: t.hitKeywords
    }))
  };
}

// ---------------------------------------------------------------------------
// Helpers for Dynamic Tag Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a dynamic topic tag (noun/entity) from text.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractNounTopic(text) {
  const source = cleanUnicode(text);
  if (!source.trim()) return null;

  // Split into sentences to distinguish sentence-starting capitalization
  const sentences = source.split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
  const candidates = {};

  for (const sentence of sentences) {
    const words = sentence
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 2);

    for (let i = 0; i < words.length; i++) {
      for (let len = 1; len <= 3 && i + len <= words.length; len++) {
        const slice = words.slice(i, i + len);

        const allCapitalized = slice.every(w => /^[A-Z]/.test(w));
        const hasStopWord = slice.some(w => STOP_WORDS.has(w.toLowerCase()));

        if (!allCapitalized || hasStopWord) {
          continue;
        }

        let runScore = 0;
        slice.forEach((w, idx) => {
          const isFirstWordInSentence = (i + idx) === 0;
          runScore += isFirstWordInSentence ? 1 : 3;
        });

        if (len === 2) runScore += 4;
        if (len === 3) runScore += 7;

        const phraseText = slice.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const key = phraseText.toLowerCase();

        if (!candidates[key]) {
          candidates[key] = {
            text: phraseText,
            score: 0
          };
        }
        candidates[key].score += runScore;
      }
    }
  }

  const sortedCandidates = Object.values(candidates).sort((a, b) => b.score - a.score);
  return sortedCandidates.length > 0 ? sortedCandidates[0].text : null;
}

/**
 * Format and sanitize an extracted topic name.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function cleanTagName(name) {
  if (!name || typeof name !== 'string') return null;
  // Strip special chars, keep alphanumeric, spaces, and dashes
  let clean = cleanUnicode(name).replace(/[^\w\s-]/g, '').trim();
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
// Semantic inference
// ---------------------------------------------------------------------------

/**
 * Optional per-call semantic-inference override, mainly for tests.
 * @callback InferFn
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object|null} responseConstraint
 * @returns {Promise<{ data: object, engine?: string } | null>}
 */

/**
 * @typedef {object} InferenceOptions
 * @property {boolean} [rulesOnly]  skip semantic inference entirely (rules tier only)
 * @property {InferFn} [infer]      use this instead of the semantic generator(s)
 */

/**
 * A text/JSON generator for the semantic tier: lib/decision/providers/nano.js (the default), or
 * any object with the same generateJson() (e.g. the OpenAI provider when the user enabled it).
 * @typedef {object} SemanticGenerator
 * @property {(system: string, user: string, opts?: { schema?: object|null, signal?: AbortSignal }) => Promise<any>} generateJson
 * @property {() => Promise<boolean>|boolean} [isReady]   skipped (quietly) when false
 * @property {() => { state?: string, availability?: string }} [status]
 * @property {string} [displayName]                        reported as the engine name
 */

/** @type {SemanticGenerator|null} lazily created default (the built-in LanguageModel) */
let defaultGenerator = null;
/** @type {SemanticGenerator[]|false|null} null = default, false = rules only */
let customGenerators = null;

/**
 * Replaces the semantic tier: one generator or a list tried in order (the first ready one that
 * returns JSON wins), `false` for rules only, or null/undefined to restore the default built-in
 * LanguageModel. The service worker passes its configured Nano provider so the helpers honor
 * providers.nano.enabled and share its sessions.
 *
 * @param {SemanticGenerator|SemanticGenerator[]|false|null|undefined} generator
 */
export function setSemanticGenerator(generator) {
  if (generator === false) customGenerators = false;
  else if (generator === null || generator === undefined) customGenerators = null;
  else customGenerators = (Array.isArray(generator) ? generator : [generator]).filter(g => g && typeof g.generateJson === 'function');
}

/** @returns {SemanticGenerator[]} */
export function getSemanticGenerators() {
  if (customGenerators === false) return [];
  if (Array.isArray(customGenerators)) return customGenerators;
  if (!defaultGenerator) defaultGenerator = createNanoProvider();
  return [defaultGenerator];
}

/**
 * The semantic tier: asks each ready generator in turn. A generator that is not ready is skipped
 * quietly; one that fails is logged and skipped.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object|null} [responseConstraint]
 * @returns {Promise<{ data: object, engine: string } | null>}
 */
async function trySemanticInference(systemPrompt, userPrompt, responseConstraint = null) {
  for (const gen of getSemanticGenerators()) {
    try {
      if (typeof gen.isReady === 'function' && !(await gen.isReady())) continue;
      const data = await gen.generateJson(systemPrompt, userPrompt, { schema: responseConstraint || null });
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return { data, engine: typeof gen.displayName === 'string' && gen.displayName ? gen.displayName : 'Semantic model' };
      }
    } catch (err) {
      console.warn('[inference-engine] Semantic generator failed:', err && err.code ? err.code : err);
    }
  }
  return null;
}

/**
 * Runs semantic inference unless disabled. Never throws; anything but a JSON object is null.
 *
 * @param {InferenceOptions|undefined} options
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object|null} [responseConstraint]
 * @returns {Promise<{ data: object, engine?: string } | null>}
 */
async function runInference(options, systemPrompt, userPrompt, responseConstraint = null) {
  if (options?.rulesOnly === true) return null;
  const infer = typeof options?.infer === 'function' ? options.infer : trySemanticInference;
  try {
    const result = await infer(systemPrompt, userPrompt, responseConstraint);
    const data = result?.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? result : null;
  } catch (err) {
    console.warn('[inference-engine] Semantic inference failed:', err);
    return null;
  }
}

/** @param {{ engine?: unknown }} result */
function engineName(result) {
  return typeof result?.engine === 'string' && result.engine ? result.engine : 'Semantic model';
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function toScore(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {InferenceOptions & {
 *   dynamicTags?: boolean,
 *   sourcePlatform?: string,
 *   customTags?: Array<string|{label: string, prompt?: string}>,
 *   dynamicTagLabels?: string[]
 * }} ClassifyOptions
 * dynamicTags: allow inventing a NEW dynamic tag (model suggestion or noun-topic heuristic) when
 * nothing matches. Default false: the heuristic produced junk tags (Right, Soc, Partner, Mvp).
 */

/**
 * Classifies text into the user's enabled tags: the semantic tier first, then the rules tier.
 *
 * Call forms (both supported):
 *   classify(text, sourcePlatform, customTags, dynamicTagLabels, options?)
 *   classify(text, { sourcePlatform, customTags, dynamicTagLabels, dynamicTags, rulesOnly, infer })
 *
 * Model tag names are matched case-insensitively and mapped back to the stored label. The 'Ads',
 * 'All', 'Favorites' and 'Unclassified' pseudo-tags are never returned.
 *
 * @param {string} text
 * @param {string|ClassifyOptions} sourcePlatform
 * @param {Array<string|{label: string, prompt?: string}>} [customTags]  enabled non-dynamic tags
 * @param {string[]} [dynamicTagLabels]  labels of already-registered, enabled dynamic tags
 * @param {ClassifyOptions} [options]
 * @returns {Promise<{ tags: { name: string, score: number, hitKeywords?: string[] }[], dynamicTag: string|null, engine: string }>}
 */
export async function classify(text, sourcePlatform, customTags = [], dynamicTagLabels = [], options = {}) {
  let opts = options && typeof options === 'object' ? options : {};
  let platform = sourcePlatform;
  if (sourcePlatform && typeof sourcePlatform === 'object' && !Array.isArray(sourcePlatform)) {
    opts = sourcePlatform;
    platform = opts.sourcePlatform;
    customTags = opts.customTags;
    dynamicTagLabels = opts.dynamicTagLabels ?? (Array.isArray(opts.dynamicTags) ? opts.dynamicTags : []);
  }
  const allowDynamicTags = opts.dynamicTags === true;
  const body = toText(text);
  const empty = { tags: [], dynamicTag: null, engine: RULES_ENGINE };
  if (!normalizeForMatch(body)) return empty;

  // Enabled tags, keyed by normalized label so model output can be mapped back case-insensitively.
  const labelIndex = new Map();
  const tagSpecs = [];
  for (const spec of Array.isArray(customTags) ? customTags : []) {
    const { label, prompt } = readTagSpec(spec);
    const key = normalizeForMatch(label);
    if (!key || PSEUDO_TAGS.has(key) || labelIndex.has(key)) continue;
    labelIndex.set(key, label);
    tagSpecs.push({ label, prompt });
  }
  const dynamicLabels = [];
  for (const label of Array.isArray(dynamicTagLabels) ? dynamicTagLabels : []) {
    const key = normalizeForMatch(label);
    if (typeof label !== 'string' || !key || PSEUDO_TAGS.has(key) || labelIndex.has(key)) continue;
    labelIndex.set(key, label);
    dynamicLabels.push(label);
  }

  // The model only sees the enabled tags; without them it can only help by inventing a topic.
  if (tagSpecs.length > 0 || allowDynamicTags) {
    const systemPrompt = buildSystemPrompt(tagSpecs, { allowDynamicTag: allowDynamicTags });
    const userPrompt = buildUserPrompt(body, toText(platform));
    const schema = buildClassifySchema(tagSpecs, { allowDynamicTag: allowDynamicTags });
    const semantic = await runInference(opts, systemPrompt, userPrompt, schema);

    if (semantic) {
      const data = semantic.data;
      const resultTags = [];
      const added = new Set();
      const addTag = (name, score) => {
        const canonical = labelIndex.get(normalizeForMatch(name));
        if (!canonical || added.has(canonical)) return;
        added.add(canonical);
        resultTags.push({ name: canonical, score });
      };

      for (const raw of Array.isArray(data.tags) ? data.tags : []) {
        if (typeof raw === 'string') addTag(raw, 0.5);
        else if (raw && typeof raw === 'object') addTag(raw.name ?? raw.label, toScore(raw.score, 0.5));
      }

      let finalDynamicTag = null;
      const cleanedDynamic = typeof data.dynamicTag === 'string' ? cleanTagName(data.dynamicTag) : null;
      if (cleanedDynamic && !isJunkTopic(cleanedDynamic)) {
        if (labelIndex.has(normalizeForMatch(cleanedDynamic))) {
          addTag(cleanedDynamic, 0.6);
        } else if (allowDynamicTags) {
          finalDynamicTag = cleanedDynamic;
        }
      }

      if (resultTags.length > 0 || finalDynamicTag) {
        resultTags.sort((a, b) => b.score - a.score);
        return { tags: resultTags.slice(0, 3), dynamicTag: finalDynamicTag, engine: engineName(semantic) };
      }
    }
  }

  // Rules tier. Pass 1: enabled tags (with their prompts). Pass 2: registered dynamic tags.
  const combinedTags = [
    ...keywordFallback(body, tagSpecs).tags,
    ...(dynamicLabels.length > 0 ? keywordFallback(body, dynamicLabels).tags : [])
  ];
  if (combinedTags.length > 0) {
    combinedTags.sort((a, b) => b.score - a.score);
    const uniqueTags = [];
    const seen = new Set();
    for (const t of combinedTags) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      uniqueTags.push(t);
      if (uniqueTags.length === 3) break;
    }
    return { tags: uniqueTags, dynamicTag: null, engine: RULES_ENGINE };
  }

  // Pass 3 (opt-in only): invent a dynamic tag from the most prominent capitalized noun phrase.
  if (allowDynamicTags) {
    const cleanedDynamic = cleanTagName(extractNounTopic(body));
    if (cleanedDynamic && !isJunkTopic(cleanedDynamic, 3)) {
      const canonical = labelIndex.get(normalizeForMatch(cleanedDynamic));
      if (canonical) return { tags: [{ name: canonical, score: 0.34 }], dynamicTag: null, engine: RULES_ENGINE };
      return { tags: [], dynamicTag: cleanedDynamic, engine: RULES_ENGINE };
    }
  }

  return empty;
}

/**
 * Extracts up to 3 expected category tags from the user's match prompt. Model output is
 * type-checked: only clean, unique tag strings are returned whatever shape the model used.
 *
 * @param {string} matchPrompt
 * @param {InferenceOptions} [options]
 * @returns {Promise<string[]>}
 */
export async function extractTagsFromPrompt(matchPrompt, options = {}) {
  const prompt = typeof matchPrompt === 'string' ? matchPrompt.trim() : '';
  if (!prompt) return [];

  const result = await runInference(options, buildPromptTagExtractionSystemPrompt(), `"${prompt}"`, PROMPT_TAGS_SCHEMA);
  const rawTags = result?.data?.tags;
  if (Array.isArray(rawTags)) {
    const tags = normalizeTagList(rawTags).filter(t => t.length <= 40 && !isJunkTopic(t)).slice(0, 3);
    if (tags.length > 0) return tags;
  }

  // Fallback if semantic inference is unavailable, fails or returns nothing usable
  const cleaned = cleanTagName(extractNounTopic(prompt));
  return cleaned && !isJunkTopic(cleaned, 3) ? [cleaned] : [];
}

/**
 * Automatically suggests a prompt evaluation for a new tag using AI.
 *
 * @param {string} tagName - The name of the tag.
 * @param {string} [currentPrompt] - Existing prompt if any.
 * @param {InferenceOptions} [options]
 * @returns {Promise<string>} The generated prompt.
 */
export async function autoSuggestTagPrompt(tagName, currentPrompt = '', options = {}) {
  const name = typeof tagName === 'string' ? tagName.trim() : '';
  if (!name) return '';

  const sysPrompt = buildTagEvalGenerationSystemPrompt(typeof currentPrompt === 'string' ? currentPrompt : '');
  const result = await runInference(options, sysPrompt, `Tag Name: "${name}"`, TAG_EVAL_PROMPT_SCHEMA);
  const prompt = result?.data?.prompt;
  if (typeof prompt === 'string' && prompt.trim()) return prompt.trim();

  return `Find posts related to ${name}.`;
}

/**
 * Extract significant words (non-stop-words) from a text.
 *
 * @param {string} text - The input query or prompt.
 * @returns {string[]} Filtered unique keywords.
 */
export function extractSignificantKeywords(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return [];
  const words = normalized
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .split(/\s+/)
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
  const source = cleanUnicode(text);
  if (!source) return [];

  const phrases = [];

  // Extract quoted strings
  const quoteRegex = /"([^"]+)"/g;
  let match;
  while ((match = quoteRegex.exec(source)) !== null) {
    if (match[1] && match[1].trim().length > 2) {
      phrases.push(normalizeForMatch(match[1]));
    }
  }

  // Extract contiguous non-stopword word sequences (bigrams/trigrams)
  const words = normalizeForMatch(source).replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);

  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i];
    const w2 = words[i + 1];
    if (w1.length >= 2 && w2.length >= 2 && !STOP_WORDS.has(w1) && !STOP_WORDS.has(w2)) {
      phrases.push(`${w1} ${w2}`);
      if (i < words.length - 2) {
        const w3 = words[i + 2];
        if (w3.length >= 2 && !STOP_WORDS.has(w3)) {
          phrases.push(`${w1} ${w2} ${w3}`);
        }
      }
    }
  }

  return Array.from(new Set(phrases));
}

/** Patterns for low-value social feed noise that should never pass eval match (run on normalized text). */
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
  /\bcommented on a post you follow\b/i,
  /\byour post has [\d,.]+k? (?:impressions|views)\b/i,
  /\bwho'?s viewed your (?:post|profile)\b/i,
];

/** Platform prompts that are noise when they make up a short snippet (a long post may quote them). */
const SHORT_SOCIAL_NOISE_PATTERNS = [
  /\bhappy work anniversary\b/i,
  /\bsay congrats\b/i,
  /\bcongratulate\b.{1,80}\b(?:for|on) (?:starting a new|(?:their|his|her) (?:new (?:position|role|job)|work anniversary))\b/i,
  /\bstarting a new (?:position|role|job)\b/i,
  /\bpeople you may know\b/i,
  /\bsuggested for you\b/i,
  /\bliked by\b.{1,80}\band [\d,.]+k? others\b/i,
];
const SHORT_NOISE_MAX_CHARS = 280;

/**
 * A profile headline ("AI Partner | Content Creator | Leader @ Acme") or a strip of feed UI chrome
 * ("Promoted · Suggested for you · Follow") rather than a post: short, several "|" or "·"
 * separated fields and no sentences.
 *
 * @param {string} normalized
 */
function looksLikeProfileHeadline(normalized) {
  if (normalized.length > 240) return false;
  const fields = Math.max(normalized.split(/\s\|\s/).length, normalized.split(/\s[·•]\s/).length);
  return fields >= 3 && !/[.!?](?:\s|$)/.test(normalized);
}

/**
 * Returns true when text looks like a notification, connection boilerplate, profile snippet or
 * feed UI chrome.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSocialNoise(text) {
  const normalized = normalizeForMatch(text);
  if (normalized.length < 20) return true;
  if (SOCIAL_NOISE_PATTERNS.some(pattern => pattern.test(normalized))) return true;
  if (normalized.length <= SHORT_NOISE_MAX_CHARS && SHORT_SOCIAL_NOISE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return true;
  }
  return looksLikeProfileHeadline(normalized);
}

/**
 * Build weighted eval keywords from prompt tags and the prompt's distinctive words.
 * Filler ("find", "quality", "fascinated", ...) never becomes a keyword.
 *
 * @param {string} matchPrompt
 * @param {Array<string|{name: string}>} matchPromptTags  strings or legacy {name, weight} objects
 * @returns {{ tagKeywords: string[], promptKeywords: string[], tagKeywordSources: Map<string, string> }}
 */
export function buildEvalKeywords(matchPrompt, matchPromptTags = []) {
  /** @type {Map<string, string>} keyword -> source tag label */
  const tagKeywordSources = new Map();
  const tagKeywords = new Set();
  const addTagKeyword = (keyword, label) => {
    if (!keyword || WEAK_EVAL_KEYWORDS.has(keyword) || ENGLISH_STOP_WORDS.has(keyword)) return;
    tagKeywords.add(keyword);
    if (!tagKeywordSources.has(keyword)) tagKeywordSources.set(keyword, label);
  };

  for (const label of normalizeTagList(matchPromptTags)) {
    const labelKey = normalizeForMatch(label);
    if (/\p{L}/u.test(labelKey)) addTagKeyword(labelKey, label);
    extractDistinctiveTerms(label).words.forEach(w => addTagKeyword(w, label));
  }

  const promptKeywords = new Set(extractDistinctiveTerms(matchPrompt).words);
  for (const kw of tagKeywords) promptKeywords.delete(kw);

  return {
    tagKeywords: Array.from(tagKeywords),
    promptKeywords: Array.from(promptKeywords),
    tagKeywordSources
  };
}

/**
 * Build multi-word phrases from prompt tags ("5 star cooking", "star cooking") and, when given,
 * from the prompt's distinctive words ("michelin star"). Instruction words never form phrases.
 *
 * @param {Array<string|{name: string}>} matchPromptTags
 * @param {string} [matchPrompt]
 * @returns {string[]}
 */
export function buildEvalPhrases(matchPromptTags = [], matchPrompt = '') {
  const phrases = new Set();
  for (const label of normalizeTagList(matchPromptTags)) {
    const labelKey = normalizeForMatch(label);
    if (labelKey.split(/[\s-]+/).filter(Boolean).length > 1 && /\p{L}/u.test(labelKey)) phrases.add(labelKey);
    extractDistinctiveTerms(label).phrases.forEach(p => phrases.add(p));
  }
  extractDistinctiveTerms(matchPrompt).phrases.forEach(p => phrases.add(p));
  return Array.from(phrases).filter(p => p.length >= 5);
}

/** P(match) reported by the rules tier for 0, 1, 2, 3 and 4+ distinct concepts found. */
const EVAL_P_BY_CONCEPTS = [0.2, 0.4, 0.65, 0.75, 0.85];

/**
 * Rule-based eval scoring. A post matches only when it hits at least two distinct concepts of the
 * prompt/tags (a phrase and its own words are one concept), so a lone "star", "michelin" or
 * "cooking" never passes. pMatch stays modest (never above 0.85) and one concept gives 0.4, so the
 * cascade sees rules decisions as low-confidence. With no usable terms at all pMatch is 0.5.
 *
 * @param {string} text
 * @param {string} matchPrompt
 * @param {Array<string|{name: string}>} matchPromptTags  strings or legacy {name, weight} objects
 * @returns {{ doesMatch: boolean, score: number, pMatch: number, confidence: number, matchedPhrases: string[], matchedKeywords: string[], strongHits: number, hasTerms: boolean }}
 */
export function scoreRuleBasedEvalMatch(text, matchPrompt, matchPromptTags = []) {
  const tags = normalizeTagList(matchPromptTags);
  const { tagKeywords, promptKeywords, tagKeywordSources } = buildEvalKeywords(matchPrompt, tags);

  const terms = new Map();
  for (const kw of tagKeywords) terms.set(kw, makeTerm(kw, tagKeywordSources.get(kw) || kw));
  for (const kw of promptKeywords) if (!terms.has(kw)) terms.set(kw, makeTerm(kw, 'prompt'));
  for (const phrase of buildEvalPhrases(tags, matchPrompt)) if (!terms.has(phrase)) terms.set(phrase, makeTerm(phrase, 'phrase'));

  const normText = normalizeForMatch(text);
  const concepts = terms.size > 0 && normText ? collectConcepts(normText, [...terms.values()]) : [];
  const matchedPhrases = concepts.filter(c => c.term.phrase).map(c => c.term.term);
  const matchedKeywords = concepts.filter(c => !c.term.phrase).map(c => `${c.term.source}:${c.term.term}`);

  const hasTerms = terms.size > 0;
  const pMatch = hasTerms ? EVAL_P_BY_CONCEPTS[Math.min(concepts.length, EVAL_P_BY_CONCEPTS.length - 1)] : 0.5;
  const doesMatch = concepts.length >= 2;

  return {
    doesMatch,
    score: pMatch,
    pMatch,
    confidence: Number(noulConfidence(pMatch).toFixed(2)),
    matchedPhrases,
    matchedKeywords,
    strongHits: concepts.length,
    hasTerms
  };
}

/**
 * Heuristic enhanced prompt when no model is available.
 *
 * @param {string} matchPrompt
 * @param {Array<string|{name: string}>} matchPromptTags
 * @returns {string}
 */
export function heuristicEnhanceMatchPrompt(matchPrompt, matchPromptTags = []) {
  // Keep the user's own words: title-cased tag hints lose meaning ("Hiring AI Tech role" -> "Hiring Ai Tech").
  const prompt = toText(matchPrompt).trim().replace(/\s+/g, ' ');
  const tagHint = normalizeTagList(matchPromptTags).slice(0, 4).join(', ');
  const related = tagHint && tagHint.toLowerCase() !== prompt.toLowerCase() ? ` (related: ${tagHint})` : '';
  return `Collect posts that are substantively about "${prompt}"${related}. Reject social notifications, connection messages, profile headlines, and engagement alerts.`;
}

/**
 * Expands a user match prompt into a stricter one-sentence eval criteria string.
 *
 * @param {string} matchPrompt
 * @param {Array<string|{name: string}>} matchPromptTags  strings or legacy {name, weight} objects
 * @param {InferenceOptions} [options]
 * @returns {Promise<string>}
 */
export async function enhanceMatchPrompt(matchPrompt, matchPromptTags = [], options = {}) {
  const prompt = typeof matchPrompt === 'string' ? matchPrompt.trim() : '';
  if (!prompt) return '';

  const tags = normalizeTagList(matchPromptTags);
  const tagLine = tags.length > 0 ? `\nSuggested tags: ${tags.join(', ')}` : '';
  const result = await runInference(options, buildMatchPromptEnhancementSystemPrompt(), `Intent: "${prompt}"${tagLine}`, ENHANCED_PROMPT_SCHEMA);
  const enhanced = result?.data?.enhanced;
  if (typeof enhanced === 'string' && enhanced.trim()) return enhanced.trim();

  return heuristicEnhanceMatchPrompt(prompt, tags);
}

export async function evaluateMatch(text, sourcePlatform, matchPrompt, options = {}) {
  const res = await evaluateMatchWithReason(text, sourcePlatform, matchPrompt, options);
  return res.doesMatch;
}

/**
 * Decides whether a post matches the user's global prompt.
 *
 * - Empty prompt: the gate cannot judge, so the post passes with warning 'empty_prompt'.
 * - Social noise (notifications, connection openers, profile headlines): rejected.
 * - Semantic tier: the model sees the user's raw prompt (an enhanced sentence is only a clarification).
 * - Rules tier: scoreRuleBasedEvalMatch over the raw prompt; fails closed and reports pMatch/confidence.
 *
 * @param {string} text
 * @param {string} sourcePlatform
 * @param {string} matchPrompt
 * @param {InferenceOptions & { matchPromptTags?: Array<string|{name: string}>, enhancedPrompt?: string }} [options]
 * @returns {Promise<{ doesMatch: boolean, engine: string, reason?: string, warning?: string, pMatch?: number, confidence?: number, matchedPhrases?: string[], matchedKeywords?: string[], score?: number }>}
 */
export async function evaluateMatchWithReason(text, sourcePlatform, matchPrompt, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const matchPromptTags = normalizeTagList(opts.matchPromptTags);
  const enhancedPrompt = typeof opts.enhancedPrompt === 'string' ? opts.enhancedPrompt.trim() : '';
  const prompt = typeof matchPrompt === 'string' ? matchPrompt.trim() : '';
  const body = toText(text);

  if (!prompt) {
    return { doesMatch: true, engine: RULES_ENGINE, reason: 'empty_prompt', warning: 'empty_prompt' };
  }

  if (isSocialNoise(body)) {
    return { doesMatch: false, engine: RULES_ENGINE, reason: 'social_noise', pMatch: 0.05, confidence: 0.9 };
  }

  const systemPrompt = buildMatchSystemPrompt(prompt, enhancedPrompt);
  const userPrompt = buildUserPrompt(body, toText(sourcePlatform));
  const semantic = await runInference(opts, systemPrompt, userPrompt, MATCH_SCHEMA);

  if (semantic && typeof semantic.data.matches === 'boolean') {
    return { doesMatch: semantic.data.matches, engine: engineName(semantic), reason: 'model' };
  }

  // Rules tier: strict tag-aware keyword scoring (fail closed when uncertain)
  const ruleResult = scoreRuleBasedEvalMatch(body, prompt, matchPromptTags);
  let reason = ruleResult.doesMatch ? 'rules_match' : 'rules_no_match';
  if (!ruleResult.hasTerms) reason = 'rules_no_terms';
  return {
    doesMatch: ruleResult.doesMatch,
    engine: RULES_ENGINE,
    reason,
    pMatch: ruleResult.pMatch,
    confidence: ruleResult.confidence,
    matchedPhrases: ruleResult.matchedPhrases,
    matchedKeywords: ruleResult.matchedKeywords,
    score: ruleResult.score
  };
}

/**
 * Legacy engine descriptor { tier, name, status } of the semantic tier: tier 1 when the first
 * generator (the built-in LanguageModel by default) is ready or downloading, else tier 3 (rules).
 *
 * @deprecated GET_ENGINE_STATUS replies with the EngineStatus of lib/decision/engine-status.js
 *   (plus these legacy fields derived from its badge); kept until the side panel stops reading them.
 * @returns {Promise<{tier: number, name: string, status: string, availability?: string}>}
 */
export async function checkEngineStatus() {
  const rules = { tier: 3, name: RULES_ENGINE, status: 'ready' };
  const gen = getSemanticGenerators()[0];
  if (!gen) return rules;
  try {
    const ready = typeof gen.isReady === 'function' ? await gen.isReady() : true;
    const s = typeof gen.status === 'function' ? gen.status() || {} : {};
    const name = typeof gen.displayName === 'string' && gen.displayName ? gen.displayName : 'Semantic model';
    const availability = typeof s.availability === 'string' ? { availability: s.availability } : {};
    if (ready) return { tier: 1, name, status: 'ready', ...availability };
    if (s.state === 'downloading') return { tier: 1, name: `${name} (downloading…)`, status: 'downloading', ...availability };
    return rules;
  } catch (err) {
    console.warn('[inference-engine] Engine status check failed:', err);
    return rules;
  }
}

/**
 * Heuristically determines if two author profiles likely refer to the same person.
 *
 * @param {{name: string, platform: string, url: string}} authorA
 * @param {{name: string, platform: string, url: string}} authorB
 * @returns {boolean} True if matched, false otherwise.
 */
export function heuristicAuthorMatch(authorA, authorB) {
  const nameA = normalizeForMatch(authorA?.name);
  const nameB = normalizeForMatch(authorB?.name);

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
    if (!url || typeof url !== 'string') return '';
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
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return false;
  const dist = levenshteinDistance(normA, normB);
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
 * First checks fast heuristics, then falls back to the semantic tier if available.
 *
 * @param {{name: string, platform: string, url: string}} authorA
 * @param {{name: string, platform: string, url: string}} authorB
 * @param {InferenceOptions} [options]
 * @returns {Promise<boolean>} True if matched, false otherwise.
 */
export async function evaluateAuthorMatch(authorA, authorB, options = {}) {
  if (!authorA || !authorB) return false;

  // 1. Fast heuristic check first
  if (heuristicAuthorMatch(authorA, authorB)) {
    return true;
  }

  const sysPrompt = buildAuthorMatchSystemPrompt();
  const field = (value) => toText(value);
  const userPrompt = `Profile A:\nName: "${field(authorA.name)}"\nPlatform: "${field(authorA.platform)}"\nURL: "${field(authorA.url)}"\n\nProfile B:\nName: "${field(authorB.name)}"\nPlatform: "${field(authorB.platform)}"\nURL: "${field(authorB.url)}"`;

  const semantic = await runInference(options, sysPrompt, userPrompt, AUTHOR_MATCH_SCHEMA);
  if (semantic && typeof semantic.data.isSame === 'boolean') {
    return semantic.data.isSame;
  }

  return false;
}
