import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import {
  normalizeForMatch,
  normalizeTagList,
  containsEvalTerm,
  isSocialNoise,
  keywordFallback,
  scoreRuleBasedEvalMatch,
  buildEvalKeywords,
  buildEvalPhrases,
  heuristicEnhanceMatchPrompt,
  enhanceMatchPrompt,
  evaluateMatchWithReason,
  extractTagsFromPrompt,
  classify,
  RULES_ENGINE
} from '../../lib/inference-engine.js';
import { buildSystemPrompt, buildMatchSystemPrompt } from '../../lib/prompt-builder.js';

/** The user's prompt, verbatim. */
const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const STRING_TAGS = ['Michelin', '5 Star Cooking', 'Cooking', 'Restaurant', 'Food'];
/** v0.9 stored prompt tags as {name, weight} objects. */
const LEGACY_TAGS = STRING_TAGS.map((name, i) => ({ name, weight: 1 - i / 10 }));
const TAG_VARIANTS = [['no tags', []], ['string tags', STRING_TAGS], ['legacy {name, weight} tags', LEGACY_TAGS]];

/** The user's export (private, outside the repo). Its tests skip when the file is absent. */
const EXPORT_PATH = process.env.SC_EXPORT_PATH || '/mnt/d/Projects/scrollcollector/scrollcollector_export_1783212781902.json';
const hasExport = fs.existsSync(EXPORT_PATH);

/** Default tags and prompts as seeded by background.js, plus the 'Ads' pseudo-tag it appends. */
const DEFAULT_PROMPTS = {
  'Health': 'Identify posts related to health, medicine, doctors, hospitals, fitness, wellness, or nutrition.',
  'Jobs': 'Identify posts related to job postings, career opportunities, hiring, recruitment, resumes, or interviews.',
  'Politics': 'Identify posts related to government, elections, political parties, public policy, or legislation.',
  'Tech/AI': 'Identify posts related to software, technology, programming, developer tools, artificial intelligence, or machine learning.',
  'Weather': 'Identify posts related to weather forecasts, storms, climate, temperatures, sunny, rain, or snow.',
  'Ad': 'Identify advertisements, sponsored content, products for sale, or promotional codes.',
  'News': 'Identify breaking news updates, media reports, journalism, headlines, or press coverage.',
  'Entertainment': 'Identify posts related to movies, television, music, concerts, gaming, or celebrity culture.',
  'Promotion': 'Identify giveaways, special offers, discounts, brand campaigns, or sales promotions.',
  'Personal Opinion': 'Identify personal viewpoints, personal updates, opinions, thoughts, or editorial reflections.',
  'Portfolio': 'Identify project showcases, personal portfolios, designs, case studies, or displays of professional work.',
  'Product Showcase': 'Identify product launches, demonstrations, features, release highlights, or new tools.',
  'Immigration': 'Identify posts related to immigration processes, visas, passports, citizenship, or green cards.',
  'Migration': 'Identify posts related to relocation, moving to another region or country, expats, or emigration.',
  'Study': 'Identify posts related to academic studies, university, learning resources, college courses, or scholarships.',
  'International News': 'Identify news about international events, global affairs, foreign relations, or world news.',
  'Sports': 'Identify posts related to athletic sports, games, leagues, matches, players, championships, or coaches.',
  'Events': 'Identify posts related to upcoming events, conferences, webinars, meetups, festivals, or workshops.',
  'Blog': 'Identify references to blog articles, long-form posts, reading materials, or updates for written sites.',
  'Vlog': 'Identify video logs, YouTube clips, vlog updates, or video content updates.',
  'Culture': 'Identify posts related to cultural heritage, traditions, societal customs, art, or historical celebrations.',
  'NGO': 'Identify posts related to non-governmental organizations, charities, volunteering, non-profits, or donations.',
  'Policy': 'Identify posts related to policy changes, company guidelines, compliance rules, or regulatory frameworks.',
  'Release': 'Identify software releases, product versions, changelogs, updates, or patch notes.',
  'History': 'Identify posts related to historical events, ancient civilizations, timelines, archives, or heritage.'
};
const DEFAULT_TAGS = [
  ...Object.entries(DEFAULT_PROMPTS).map(([label, prompt]) => ({ label, prompt })),
  { label: 'Ads' }
];

/** Fails the test if the semantic tier is consulted when it must not be. */
const forbiddenInfer = async () => { throw new Error('semantic inference must not run'); };

describe('normalizeForMatch', () => {
  test('folds LinkedIn math-bold to plain lowercase text', () => {
    expect(normalizeForMatch('𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻')).toBe('michelin');
    expect(normalizeForMatch('𝘁𝗵𝗿𝗲𝗲 𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻 𝘀𝘁𝗮𝗿𝘀')).toBe('three michelin stars');
  });

  test('strips zero-width characters and collapses whitespace', () => {
    expect(normalizeForMatch('Mi​che‍lin﻿   star\n\n\tcooking ')).toBe('michelin star cooking');
    expect(normalizeForMatch('Let’s connect')).toBe("let's connect");
  });

  test('never throws on non-string input', () => {
    expect(normalizeForMatch(undefined)).toBe('');
    expect(normalizeForMatch(null)).toBe('');
    expect(normalizeForMatch({ name: 'Food' })).toBe('');
    expect(normalizeForMatch(42)).toBe('42');
  });
});

describe('containsEvalTerm', () => {
  test("math-bold 'Michelin' matches 'michelin'", () => {
    expect(containsEvalTerm('Dinner at a 𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻 restaurant', 'michelin')).toBe(true);
    expect(containsEvalTerm('𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻', 'MICHELIN')).toBe(true);
  });

  test('zero-width characters inside a word do not hide it', () => {
    expect(containsEvalTerm('A Mi​chelin guide pick', 'michelin')).toBe(true);
  });

  test('keeps word boundaries and tolerates hyphenated phrases', () => {
    expect(containsEvalTerm('so many SaaS startups', 'star')).toBe(false);
    expect(containsEvalTerm('three Michelin stars', 'stars')).toBe(true);
    expect(containsEvalTerm('a Michelin-starred kitchen', 'michelin star')).toBe(true);
    expect(containsEvalTerm('rated 25 star by users', '5 star')).toBe(false);
  });
});

describe('normalizeTagList', () => {
  test('turns legacy {name, weight} objects and junk into clean unique strings', () => {
    const tags = normalizeTagList([
      { name: 'Michelin', weight: 0.9 },
      'Food',
      { label: 'Cooking' },
      '  food ',
      null,
      undefined,
      {},
      ['nested'],
      { name: { deep: true } },
      '[object Object]',
      '#Restaurant',
      ''
    ]);
    expect(tags).toEqual(['Michelin', 'Food', 'Cooking', 'Restaurant']);
    for (const t of tags) expect(typeof t).toBe('string');
  });

  test('accepts a single object or a comma-separated string', () => {
    expect(normalizeTagList({ name: 'Michelin', weight: 1 })).toEqual(['Michelin']);
    expect(normalizeTagList('Food, Cooking,')).toEqual(['Food', 'Cooking']);
    expect(normalizeTagList(undefined)).toEqual([]);
    expect(normalizeTagList(7)).toEqual([]);
  });
});

describe('legacy {name, weight} prompt tags never throw or render [object Object]', () => {
  test('buildEvalKeywords / buildEvalPhrases produce strings', () => {
    const keywords = buildEvalKeywords(PROMPT, LEGACY_TAGS);
    const all = [...keywords.tagKeywords, ...keywords.promptKeywords, ...keywords.tagKeywordSources.values()];
    for (const k of all) {
      expect(typeof k).toBe('string');
      expect(k).not.toContain('[object');
    }
    expect(keywords.tagKeywords).toContain('michelin');
    expect(keywords.tagKeywordSources.get('michelin')).toBe('Michelin');

    const phrases = buildEvalPhrases(LEGACY_TAGS, PROMPT);
    for (const p of phrases) expect(typeof p).toBe('string');
    expect(phrases).toContain('5 star cooking');
    expect(phrases).toContain('michelin star');
  });

  test('scoreRuleBasedEvalMatch and the enhanced prompt accept object tags', async () => {
    expect(() => scoreRuleBasedEvalMatch('Michelin star restaurant review', PROMPT, LEGACY_TAGS)).not.toThrow();
    expect(() => scoreRuleBasedEvalMatch('text', PROMPT, [null, 3, { weight: 1 }, 'Food'])).not.toThrow();

    const heuristic = heuristicEnhanceMatchPrompt(PROMPT, LEGACY_TAGS);
    expect(heuristic).toContain('Michelin, 5 Star Cooking, Cooking, Restaurant');
    expect(heuristic).not.toContain('[object');

    const enhanced = await enhanceMatchPrompt(PROMPT, LEGACY_TAGS, { infer: async () => null });
    expect(enhanced).toBe(heuristic);

    let seenUserPrompt = '';
    await enhanceMatchPrompt(PROMPT, LEGACY_TAGS, {
      infer: async (_sys, user) => { seenUserPrompt = user; return { data: { enhanced: 42 } }; }
    });
    expect(seenUserPrompt).toContain('Suggested tags: Michelin, 5 Star Cooking');
    expect(seenUserPrompt).not.toContain('[object');
  });

  test('prompt builders skip unusable tags', () => {
    const prompt = buildSystemPrompt([{ label: 'Tech', prompt: 'Identify tech.' }, 'Food', { name: 'Cooking', weight: 1 }, null, {}]);
    expect(prompt).toContain('- Tech: Identify tech.');
    expect(prompt).toContain('- Food: Identify posts related to Food.');
    expect(prompt).toContain('- Cooking: Identify posts related to Cooking.');
    expect(prompt).not.toContain('[object');
    expect(prompt).not.toContain('dynamicTag');
    expect(buildSystemPrompt(['Food'], { allowDynamicTag: true })).toContain('dynamicTag');
  });
});

describe('evaluateMatchWithReason on the rules path (no model in Node)', () => {
  const exportPosts = hasExport
    ? JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8')).map(item => item.textSnippet)
    : [];

  test.skipIf(!hasExport)('the export holds the 7 collected posts', () => {
    expect(exportPosts).toHaveLength(7);
    for (const text of exportPosts) expect(typeof text).toBe('string');
  });

  for (const [name, tags] of TAG_VARIANTS) {
    test.skipIf(!hasExport)(`rejects all 7 export posts (${name}, default semantic tier)`, async () => {
      for (const text of exportPosts) {
        const result = await evaluateMatchWithReason(text, 'linkedin.com', PROMPT, { matchPromptTags: tags });
        expect(result.engine).toBe(RULES_ENGINE);
        expect(result.doesMatch, text.slice(0, 80)).toBe(false);
      }
    });

    test.skipIf(!hasExport)(`rejects all 7 export posts (${name}, rulesOnly)`, async () => {
      for (const text of exportPosts) {
        const result = await evaluateMatchWithReason(text, 'linkedin.com', PROMPT, {
          matchPromptTags: tags,
          rulesOnly: true,
          infer: forbiddenInfer
        });
        expect(result.doesMatch, text.slice(0, 80)).toBe(false);
        expect(result.pMatch).toBeLessThan(0.5);
      }
    });
  }

  // Synthetic look-alikes of the export posts (same traps, invented wording), so the guarantee holds
  // without the private file. Keep export text itself out of the repo.
  const FALSE_FRIENDS = [
    'Enterprise buyers stall without a SOC 2 report, and many SaaS startups lose quarters to it. Our free compliance guide walks you through it.',
    'Our open-source CLI reached the top of trending this week and is closing in on 40,000 stars, Apache licensed. Repo link below.',
    'We convert everyday business processes into high-quality training data for frontier AI labs.',
    'Choose a concrete goal (a recipe to read, a song to sing, a 5-minute chat) and build fluency step by step.',
    'Our onboarding got a 5 star review on G2! Quality support is our recipe for success.',
    'Michelin tyres are now available for the whole fleet with free fitting this month.',
    '𝗚𝗿𝗲𝗮𝘁 𝗧𝗿𝗶𝗽𝘀 𝗕𝗲𝗴𝗶𝗻 𝘄𝗶𝘁𝗵 𝗚𝗼𝗼𝗱 𝗣𝗹𝗮𝗻𝗻𝗶𝗻𝗴. A sturdy carry-on keeps your essentials close at hand.',
    'Growth Strategist | Award-Winning Content Creator | AI Trainer | Founder @ Example Labs'
  ];

  for (const [name, tags] of TAG_VARIANTS) {
    test(`rejects false friends (${name})`, async () => {
      for (const text of FALSE_FRIENDS) {
        const result = await evaluateMatchWithReason(text, 'linkedin.com', PROMPT, { matchPromptTags: tags, rulesOnly: true });
        expect(result.doesMatch, text).toBe(false);
      }
    });
  }

  const MICHELIN_POST = 'We finally visited a three Michelin star restaurant in Kyoto. The chef served a twelve course kaiseki tasting menu and every dish was perfect.';
  const MATH_BOLD_POST = '𝗢𝘂𝗿 𝗿𝗲𝘀𝘁𝗮𝘂𝗿𝗮𝗻𝘁 𝗷𝘂𝘀𝘁 𝗲𝗮𝗿𝗻𝗲𝗱 𝗶𝘁𝘀 𝗳𝗶𝗿𝘀𝘁 𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻 𝘀𝘁𝗮𝗿. Thank you to the whole kitchen team.';

  for (const [name, tags] of TAG_VARIANTS) {
    test(`a clear Michelin restaurant post passes (${name})`, async () => {
      for (const text of [MICHELIN_POST, MATH_BOLD_POST]) {
        const result = await evaluateMatchWithReason(text, 'linkedin.com', PROMPT, { matchPromptTags: tags });
        expect(result.engine).toBe(RULES_ENGINE);
        expect(result.doesMatch, text).toBe(true);
        expect(result.pMatch).toBeGreaterThan(0.5);
        expect(result.pMatch).toBeLessThan(1);
      }
    });
  }

  test('a single concept stays uncertain and is rejected', () => {
    const result = scoreRuleBasedEvalMatch('Our new Michelin guide app is live.', PROMPT, STRING_TAGS);
    expect(result.doesMatch).toBe(false);
    expect(result.pMatch).toBeGreaterThan(0.3);
    expect(result.pMatch).toBeLessThan(0.5);
    expect(result.confidence).toBeLessThan(0.3);
  });

  test('an empty prompt lets posts through with a warning', async () => {
    const result = await evaluateMatchWithReason('Any substantive post about anything at all.', 'linkedin.com', '   ', { infer: forbiddenInfer });
    expect(result.doesMatch).toBe(true);
    expect(result.warning).toBe('empty_prompt');
  });

  test('the model sees the raw prompt; an enhanced sentence is only a clarification', async () => {
    let systemPrompt = '';
    const result = await evaluateMatchWithReason('Dinner at a Michelin star restaurant.', 'linkedin.com', PROMPT, {
      enhancedPrompt: 'Collect posts about technology.',
      infer: async (sys) => { systemPrompt = sys; return { data: { matches: false }, engine: 'Fake Nano' }; }
    });
    expect(result).toMatchObject({ doesMatch: false, engine: 'Fake Nano' });
    expect(systemPrompt).toContain(`"${PROMPT}"`);
    expect(systemPrompt).toContain('Clarification of the same intent');
    expect(buildMatchSystemPrompt(PROMPT)).not.toContain('Clarification');
  });
});

describe('isSocialNoise', () => {
  test('flags profile headlines and normalized connection boilerplate', () => {
    expect(isSocialNoise('Growth Strategist | Award-Winning Content Creator 🏆 | AI Trainer (coached 5,000+ teams & founders) | Founder @ Example Labs & Summit 25 EU')).toBe(true);
    expect(isSocialNoise('Hi Sam, let’s​ connect and chat about growth soon')).toBe(true);
    expect(isSocialNoise('A stunning Michelin-star tasting menu featured locally sourced ingredients and modern French technique.')).toBe(false);
  });

  test('flags feed UI chrome and platform prompts (eval golden noise patterns)', () => {
    const noise = [
      'Happy work anniversary, Maria! 🎉 Celebrating 5 years at Northwind Traders. Say congrats →',
      'People you may know · Software engineers at companies you follow · Connect',
      "Your post has 1,284 impressions. See who's viewed your post this week.",
      'Congratulate Daniel Kim for starting a new position as Engineering Manager at Brightwave!',
      'Promoted · Suggested for you · Follow',
      "Ana Pereira commented on a post you follow: 'Totally agree, thanks for sharing!'",
      'Liked by Chris Wong and 312 others · 48 comments · 12 reposts'
    ];
    for (const text of noise) expect(isSocialNoise(text), text).toBe(true);
  });

  test('short-snippet patterns do not reject real posts', () => {
    // Congratulations on an achievement is a post, not a "new position" prompt.
    expect(isSocialNoise('Congratulate the whole kitchen team on their third Michelin star, earned with a 14-seat counter!')).toBe(false);
    // A long post may mention an anniversary and still be about food.
    const long = 'Happy work anniversary to our head chef! Ten years ago she joined as a line cook. '
      + 'Since then the restaurant earned two Michelin stars, rebuilt its tasting menu around Baltic seafood '
      + 'and trained a generation of cooks who now run kitchens of their own across Scandinavia and the rest of Europe.';
    expect(long.length).toBeGreaterThan(280);
    expect(isSocialNoise(long)).toBe(false);
  });

  test('the eval golden set: every noise post is flagged and no other post is', () => {
    const lines = fs.readFileSync(new URL('../../eval/golden/posts.synthetic.jsonl', import.meta.url), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    const noise = lines.filter(p => p.kind === 'noise');
    expect(noise.length).toBeGreaterThanOrEqual(12);
    expect(noise.filter(p => !isSocialNoise(p.text)).map(p => p.id)).toEqual([]);
    expect(lines.filter(p => p.kind !== 'noise' && isSocialNoise(p.text)).map(p => p.id)).toEqual([]);
  });
});

describe('keywordFallback', () => {
  const SAAS_POSTS = [
    'Our team shipped a big update this week: faster dashboards, better permissions and a cleaner onboarding flow for every manager.',
    'Apply these three tips to help your team close more deals this quarter.',
    'Game-changing analytics for your team. Try our platform free for 14 days.',
    'Deals slipping away at the 11th hour? Without a SOC 2 report, many SaaS startups grow more slowly.'
  ];

  test('does not tag a generic SaaS post as Sports/Jobs from a single weak hit', () => {
    for (const text of SAAS_POSTS) {
      const names = keywordFallback(text, DEFAULT_TAGS).tags.map(t => t.name);
      expect(names, text).not.toContain('Sports');
      expect(names, text).not.toContain('Jobs');
    }
  });

  test('one specific keyword is enough, with a low absolute score', () => {
    const { tags } = keywordFallback('The tournament final is on Saturday.', DEFAULT_TAGS);
    expect(tags[0]).toMatchObject({ name: 'Sports' });
    expect(tags[0].score).toBeCloseTo(0.33, 2);
  });

  test('scores are absolute, not normalized to the best tag', () => {
    const { tags } = keywordFallback('What a final! The championship went to extra time and the stadium was electric.', DEFAULT_TAGS);
    expect(tags[0].name).toBe('Sports');
    expect(tags[0].score).toBeGreaterThan(0.5);
    expect(tags[0].score).toBeLessThan(1);

    const jobs = keywordFallback('We are hiring a senior backend engineer. Remote friendly, apply now via our careers page.', DEFAULT_TAGS);
    expect(jobs.tags[0].name).toBe('Jobs');
  });

  test('does not turn every word of a tag prompt into a keyword', () => {
    const tags = [{ label: 'NGO', prompt: DEFAULT_PROMPTS.NGO }, { label: 'Study', prompt: DEFAULT_PROMPTS.Study }];
    // "organizations" and "resources" only appear inside compounds of those prompts.
    expect(keywordFallback('Good organization and the right resources make every trip smoother.', tags).tags).toEqual([]);
    expect(keywordFallback('Proud to volunteer with local charities and collect donations.', tags).tags[0]?.name).toBe('NGO');
  });

  test('never returns the Ads pseudo-tag', () => {
    const text = 'Ads ads ads: our ads platform helps you run better ads.';
    expect(keywordFallback(text, [{ label: 'Ads' }, 'ads', 'Unclassified']).tags).toEqual([]);
  });

  test('accepts legacy tag shapes without throwing', () => {
    expect(() => keywordFallback('python programming tutorial', [null, 7, {}, { name: 'Tech', prompt: 'Identify programming posts.' }])).not.toThrow();
    expect(keywordFallback(undefined, DEFAULT_TAGS)).toEqual({ tags: [] });
  });
});

describe('classify', () => {
  const JUNK_SOURCE = 'Great Trips Begin with Good Planning. The Proper Kit Changes Everything. Missing SOC 2 holds Teams back.';

  test('does not invent dynamic tags unless asked', async () => {
    const result = await classify(JUNK_SOURCE, 'linkedin.com', [], []);
    expect(result).toEqual({ tags: [], dynamicTag: null, engine: RULES_ENGINE });
  });

  test('the noun-topic pass runs only with dynamicTags: true', async () => {
    const text = 'Microsoft launched a new platform. The Microsoft platform is very fast. Developers like Microsoft.';
    const off = await classify(text, 'x.com', [{ label: 'Health', prompt: '' }], []);
    expect(off.dynamicTag).toBeNull();
    const on = await classify(text, 'x.com', [{ label: 'Health', prompt: '' }], [], { dynamicTags: true, rulesOnly: true });
    expect(on.dynamicTag).toBe('Microsoft');
    const objectForm = await classify(text, { sourcePlatform: 'x.com', customTags: [], dynamicTags: true, rulesOnly: true });
    expect(objectForm.dynamicTag).toBe('Microsoft');
  });

  test('never classifies into the Ads pseudo-tag', async () => {
    const result = await classify('Ads ads ads. Sponsored ads everywhere.', 'linkedin.com', [{ label: 'Ads' }], ['Ads'], { rulesOnly: true });
    expect(result.tags.map(t => t.name)).not.toContain('Ads');
  });

  test('maps model tag names case-insensitively and drops unknown, Ads and junk entries', async () => {
    const infer = async () => ({
      engine: 'Fake Nano',
      data: { tags: [{ name: 'tech/ai', score: 0.9 }, { name: 'ADS', score: 1 }, { name: 'Space', score: 0.8 }, 'HEALTH', null, { score: 2 }] }
    });
    const result = await classify('Some post text that is long enough.', 'linkedin.com', DEFAULT_TAGS, [], { infer });
    expect(result.engine).toBe('Fake Nano');
    expect(result.tags).toEqual([{ name: 'Tech/AI', score: 0.9 }, { name: 'Health', score: 0.5 }]);
    expect(result.dynamicTag).toBeNull();
  });

  test('ignores a model dynamicTag unless dynamic tags are enabled', async () => {
    const infer = async () => ({ engine: 'Fake Nano', data: { tags: [], dynamicTag: 'Gardening' } });
    const off = await classify('Tomatoes love the sun.', 'x.com', [{ label: 'Health' }], [], { infer });
    expect(off.dynamicTag).toBeNull();
    expect(off.engine).toBe(RULES_ENGINE);
    const on = await classify('Tomatoes love the sun.', 'x.com', [{ label: 'Health' }], [], { infer, dynamicTags: true });
    expect(on).toMatchObject({ dynamicTag: 'Gardening', engine: 'Fake Nano' });
  });
});

describe('extractTagsFromPrompt', () => {
  test('type-checks model output and returns clean strings', async () => {
    const infer = async () => ({ data: { tags: [{ name: 'Food', weight: 1 }, 42, null, 'Michelin', '', {}, 'food', 'Restaurants'] } });
    const tags = await extractTagsFromPrompt(PROMPT, { infer });
    // 42 has no letters and 'food' is a duplicate; at most 3 tags are kept.
    expect(tags).toEqual(['Food', 'Michelin', 'Restaurants']);
  });

  test('falls back to the heuristic when the model returns junk', async () => {
    const tags = await extractTagsFromPrompt('Posts about SpaceX Starship launches', { infer: async () => ({ data: { tags: 'Food' } }) });
    for (const t of tags) expect(typeof t).toBe('string');
    expect(await extractTagsFromPrompt('   ', { infer: forbiddenInfer })).toEqual([]);
    expect(await extractTagsFromPrompt(PROMPT, { rulesOnly: true })).toEqual([]);
  });
});
