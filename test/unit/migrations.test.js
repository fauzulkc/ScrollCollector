import { describe, test, expect } from 'vitest';
import { defaultTrackedTags } from '../../lib/bg/defaults.js';
import { migrateState, postKeyFromUrl, parsePermalink, toTagStringList } from '../../lib/storage/migrations.js';
import {
  SCHEMA_VERSION,
  DEFAULT_INTELLIGENCE,
  deepMerge,
  defaultIntelligence,
  resolveIntelligence,
  validateIntelligencePatch,
  isPlainObject
} from '../../lib/storage/schema.js';

const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';

/** Synthetic legacy item shaped like the v0.9 export (scrollcollector_export_*.json). */
function legacyItem(id, { url = 'https://www.linkedin.com/company/acme/posts/', text = 'A short company update about our new product line.', tag = 'Right' } = {}) {
  return {
    assignedTag: tag,
    authorName: '',
    authorUrl: '',
    canonicalAuthorName: '',
    favoritedAt: null,
    id,
    isAd: false,
    isFavorite: false,
    matchInfo: {
      engine: 'Rule-based Classifier',
      globalEngine: 'Rule-based Classifier',
      globalMatchPrompt: PROMPT,
      globalMatchedKeywords: ['5 Star Cooking:star', 'Food:eat'],
      globalMatchedPhrases: []
    },
    sourcePlatform: 'www.linkedin.com',
    sourceUrl: url,
    tags: [{ hitKeywords: [tag.toLowerCase()], name: tag, score: 1 }],
    textSnippet: text,
    timestamp: Number(id.replace(/\D/g, '')) || 1783212775198
  };
}

/** v1 chrome.storage.local snapshot: no schemaVersion, no intelligence, v0.9 prompt tags. */
function v1State() {
  return {
    configuration: {
      trackedTags: [
        { id: 't1', label: 'Health', isEnabled: true, prompt: 'Identify posts related to health.' },
        { id: 't4', label: 'Tech/AI', isEnabled: true, prompt: 'Identify posts related to software.' },
        { id: 't_ads', label: 'Ads', isEnabled: true }
      ],
      sites: [{ id: 's2', domain: 'linkedin.com', isEnabled: true, isCustom: false }],
      ignoredKeywords: [],
      ignoredTags: [],
      ignoredLinks: [],
      ignoredDomains: [],
      isTrackingPaused: false,
      matchPrompt: PROMPT,
      matchPromptEnhanced: 'Collect substantive posts about 5 Star Cooking, Food.',
      isMatchPromptEnabled: true,
      matchPromptTags: [{ name: '5 Star Cooking', weight: 0.9 }, { name: 'Food', weight: 0.7 }, 'Michelin', { name: ' food ' }, { weight: 1 }]
    },
    metrics: { counts: { Right: 1, Soc: 1 } },
    telemetry: { totalProcessed: 7, classifiedCount: 7, unclassifiedCount: 0, sessionStart: 1783212700000, lastProcessed: 1783212775208 },
    inFlightCount: 0,
    stack: [
      legacyItem('item_1783212775198', { url: 'https://www.linkedin.com/company/instruqt/posts/', text: 'Lorem ipsum dolor sit amet. '.repeat(105) }),
      legacyItem('item_1783212775208', { url: 'https://www.linkedin.com/company/scytale-ai/posts/', tag: 'Soc' }),
      legacyItem('item_1783212775208', { url: 'https://www.linkedin.com/company/n8n/posts/?feedView=all', tag: 'Partner' }),
      legacyItem('item_1783212773996', { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234567/', tag: 'Saldor' }),
      legacyItem('item_1783212773982', { url: 'https://x.com/someone/status/1798765432101234567?s=20', tag: 'Micro1' }),
      { ...legacyItem('item_1783212749760', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', tag: 'Mvp' }), decision: { v: 1, path: ['system1'] } },
      legacyItem('item_1783212748126', { url: 'https://news.ycombinator.com/item?id=41234567', tag: 'Kids' })
    ]
  };
}

describe('migrateState v1 -> v2', () => {
  test('migrates an export-shaped v1 snapshot', () => {
    const input = v1State();
    const before = JSON.stringify(input);
    const { state, changed } = migrateState(input);
    expect(changed).toBe(true);
    expect(JSON.stringify(input)).toBe(before); // pure

    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    const cfg = state.configuration;
    // no defaults copied in: they are filled in on read
    expect(cfg).not.toHaveProperty('intelligence');
    expect(resolveIntelligence(cfg)).toEqual(DEFAULT_INTELLIGENCE);
    expect(cfg.promptVersion).toBe(0);
    expect(cfg.matchPromptTags).toEqual(['5 Star Cooking', 'Food', 'Michelin']);
    expect(cfg.trackedTags.find((t) => t.label === 'Ads').isPseudo).toBe(true);
    expect(cfg.trackedTags.find((t) => t.label === 'Health')).not.toHaveProperty('isPseudo');
    // untouched user data
    expect(cfg.matchPrompt).toBe(PROMPT);
    expect(state.metrics).toEqual(input.metrics);
    expect(state.telemetry).toEqual(input.telemetry);

    const ids = state.stack.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[1]).toBe('item_1783212775208');
    expect(ids[2]).toBe('item_1783212775208_2');

    const byTag = Object.fromEntries(state.stack.map((i) => [i.assignedTag, i]));
    expect(byTag.Right).toMatchObject({ suspectMerged: true, legacy: true });
    expect(byTag.Right).not.toHaveProperty('postKey');
    expect(byTag.Soc.suspectMerged).toBe(true);
    expect(byTag.Partner.suspectMerged).toBe(true); // company page with a query string
    expect(byTag.Saldor.postKey).toBe('url:https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234567');
    expect(byTag.Saldor).not.toHaveProperty('suspectMerged');
    expect(byTag.Micro1.postKey).toBe('url:https://x.com/someone/status/1798765432101234567?s=20');
    expect(byTag.Mvp.postKey).toBe('url:https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10');
    expect(byTag.Mvp).not.toHaveProperty('legacy'); // already has a decision
    expect(byTag.Kids.postKey).toBe('url:https://news.ycombinator.com/item?id=41234567');
    expect(state.stack.filter((i) => i.legacy).length).toBe(6);
  });

  test('running twice is a no-op', () => {
    const once = migrateState(v1State());
    const twice = migrateState(once.state);
    expect(twice.changed).toBe(false);
    expect(twice.state).toEqual(once.state);
    expect(twice.state).not.toBe(once.state);
  });

  test('keeps user intelligence values exactly as stored (no defaults merged in); keeps unknown keys', () => {
    const input = v1State();
    const explicit = {
      escalation: { provider: 'jev', floor: { matches_prompt: 0.42 } },
      providers: { jev: { enabled: true } },
      futureFlag: 'x'
    };
    input.configuration.intelligence = explicit;
    input.configuration.promptVersion = 5;
    const { state } = migrateState(input);
    expect(state.configuration.intelligence).toEqual(explicit);
    expect(state.configuration.promptVersion).toBe(5);
    const resolved = resolveIntelligence(state.configuration);
    expect(resolved.escalation).toMatchObject({ provider: 'jev', floor: { matches_prompt: 0.42 }, perMinute: 30 });
    expect(resolved.providers.jev).toEqual({ ...DEFAULT_INTELLIGENCE.providers.jev, enabled: true });
    expect(resolved.providers.openai.enabled).toBe(false);
  });

  test('a later change of a default reaches migrated users (defaults are never frozen into storage)', () => {
    // The first build of this migration stored a full copy of the defaults, placeholder floors
    // included; that untouched copy is dropped.
    const seeded = {
      system1: { enabled: true, model: 'bge-small', device: 'wasm', dtype: 'q8', waitForReadyMs: 180000 },
      escalation: { provider: 'nano', floor: { matches_prompt: 0.5, primary_tag: 0.35 }, perMinute: 30, perDay: 1000, sendAuthor: false, allowRedecideEscalation: false },
      providers: {
        nano: { enabled: true },
        jev: { enabled: false, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 8000 },
        openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', api: 'chat', reasoningEffort: 'none', timeoutMs: 15000 }
      },
      gate: { strictness: 'balanced', whenUnsure: 'collect' },
      dynamicTags: false,
      debugAnnotate: false
    };
    const { state, changed } = migrateState({ schemaVersion: 2, configuration: { intelligence: seeded, promptVersion: 0 } });
    expect(changed).toBe(true);
    expect(state.configuration).not.toHaveProperty('intelligence');
    expect(migrateState(state).changed).toBe(false);
    // ...so the floors come from the calibration again, and every other default follows the code
    expect(resolveIntelligence(state.configuration).escalation.floor).toBeUndefined();

    // an edited copy is the user's: kept as is
    const edited = deepMerge(seeded, { gate: { strictness: 'strict' } });
    expect(migrateState({ schemaVersion: 2, configuration: { intelligence: edited, promptVersion: 0 } }).state.configuration.intelligence).toEqual(edited);

    // garbage is dropped
    expect(migrateState({ schemaVersion: 2, configuration: { intelligence: 'x', promptVersion: 0 } }).state.configuration).not.toHaveProperty('intelligence');
  });

  test('items without ids get deterministic unique ids; suffixes avoid existing ids', () => {
    const { state } = migrateState({
      stack: [
        { id: 'a', textSnippet: 'x' },
        { id: 'a', textSnippet: 'y' },
        { id: 'a_2', textSnippet: 'z' },
        { textSnippet: 'no id' },
        null
      ]
    });
    expect(state.stack.slice(0, 4).map((i) => i.id)).toEqual(['a', 'a_3', 'a_2', 'item_legacy_3']);
    expect(state.stack[4]).toBeNull();
    expect(migrateState(state).changed).toBe(false);
  });

  test('empty or foreign input', () => {
    expect(migrateState(undefined)).toEqual({ state: { schemaVersion: SCHEMA_VERSION }, changed: true });
    expect(migrateState({ schemaVersion: SCHEMA_VERSION })).toEqual({ state: { schemaVersion: SCHEMA_VERSION }, changed: false });
    // a newer schema is left alone
    const newer = { schemaVersion: SCHEMA_VERSION + 1, configuration: { trackedTags: [{ label: 'Ads' }] } };
    expect(migrateState(newer)).toEqual({ state: newer, changed: false });
  });

  test('a state written by the current defaults at the current schema is already migrated', () => {
    const { state } = migrateState({
      schemaVersion: SCHEMA_VERSION,
      configuration: { intelligence: defaultIntelligence(), promptVersion: 1, matchPromptTags: ['a'], trackedTags: [{ label: 'Ads', isPseudo: true }] },
      stack: [{ id: 'x', decision: { v: 1 }, sourceUrl: 'https://example.com/a', textSnippet: 'short' }]
    });
    expect(migrateState(state).changed).toBe(false);
  });
});

describe('permalinks', () => {
  test.each([
    ['https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234567/', true],
    ['https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7212345678901234567', true],
    ['https://www.linkedin.com/company/instruqt/posts/', false],
    ['https://www.linkedin.com/in/someone/', false],
    ['https://www.linkedin.com/feed/', false],
    ['https://x.com/dev/status/1798765432101234567', true],
    ['https://twitter.com/dev/status/1798765432101234567', true],
    ['https://x.com/dev', false],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['https://youtu.be/dQw4w9WgXcQ', true],
    ['https://www.youtube.com/shorts/abcDEF12345', true],
    ['https://www.youtube.com/@channel', false],
    ['https://news.ycombinator.com/item?id=41234567', true],
    ['https://news.ycombinator.com/news', false],
    ['https://example.com/post/1', false],
    ['not a url', false],
    [undefined, false]
  ])('%s -> %s', (url, ok) => {
    expect(!!parsePermalink(url)).toBe(ok);
    expect(postKeyFromUrl(url) !== null).toBe(ok);
  });

  test('postKey uses the canonical url (no trailing slash)', () => {
    expect(postKeyFromUrl('https://www.linkedin.com/feed/update/urn:li:activity:1234567/')).toBe('url:https://www.linkedin.com/feed/update/urn:li:activity:1234567');
  });

  test('toTagStringList normalizes v0.9 prompt tags', () => {
    expect(toTagStringList([{ name: 'A', weight: 1 }, 'b', { label: 'C' }, ' a ', null, 5])).toEqual(['A', 'b', 'C']);
    expect(toTagStringList(undefined)).toEqual([]);
  });
});

describe('schema helpers', () => {
  test('DEFAULT_INTELLIGENCE matches the approved defaults and is frozen', () => {
    expect(DEFAULT_INTELLIGENCE).toEqual({
      system1: { enabled: true, model: 'minilm', device: 'wasm', dtype: 'q8', waitForReadyMs: 180000 },
      escalation: {
        provider: 'nano',
        // no floor: unset floors come from the System 1 calibration
        perMinute: 30,
        perDay: 1000,
        sendAuthor: false,
        allowRedecideEscalation: false
      },
      providers: {
        nano: { enabled: true },
        jev: { enabled: false, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 8000 },
        openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', api: 'chat', reasoningEffort: 'none', timeoutMs: 15000 }
      },
      gate: { strictness: 'balanced', whenUnsure: 'collect' },
      refine: { enabled: true, idleSeconds: 60, nano: true },
      dynamicTags: false,
      debugAnnotate: false
    });
    expect(Object.isFrozen(DEFAULT_INTELLIGENCE.providers.jev)).toBe(true);
    // cloud providers are opt-in
    expect(DEFAULT_INTELLIGENCE.providers.jev.enabled).toBe(false);
    expect(DEFAULT_INTELLIGENCE.providers.openai.enabled).toBe(false);
  });

  test('deepMerge clones, merges objects, replaces arrays and skips undefined', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 1 };
    const out = deepMerge(base, { a: { c: [3], e: undefined }, d: undefined, f: { g: 1 } });
    expect(out).toEqual({ a: { b: 1, c: [3] }, d: 1, f: { g: 1 } });
    out.a.b = 2;
    expect(base.a.b).toBe(1);
    // merging over the frozen defaults yields a mutable copy
    const intel = deepMerge(DEFAULT_INTELLIGENCE, {});
    intel.providers.jev.enabled = true;
    expect(DEFAULT_INTELLIGENCE.providers.jev.enabled).toBe(false);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
  });

  test('resolveIntelligence fills defaults under user values', () => {
    expect(resolveIntelligence(undefined)).toEqual(DEFAULT_INTELLIGENCE);
    expect(resolveIntelligence({ intelligence: { gate: { whenUnsure: 'skip' } } }).gate).toEqual({ strictness: 'balanced', whenUnsure: 'skip' });
  });

  test('validateIntelligencePatch whitelists keys and types', () => {
    const ok = validateIntelligencePatch({
      escalation: { provider: 'openai', floor: { primary_tag: 0.4 }, perMinute: 10 },
      providers: { openai: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1/', model: ' gpt-6-luna ', reasoningEffort: 'low' } },
      gate: { strictness: 'strict' },
      dynamicTags: true
    });
    expect(ok.ok).toBe(true);
    expect(ok.errors).toEqual([]);
    expect(ok.patch).toEqual({
      escalation: { provider: 'openai', floor: { primary_tag: 0.4 }, perMinute: 10 },
      providers: { openai: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-6-luna', reasoningEffort: 'low' } },
      gate: { strictness: 'strict' },
      dynamicTags: true
    });

    const bad = validateIntelligencePatch({
      providers: { jev: { apiKey: 'sk-should-never-be-here', enabled: 'yes', baseUrl: 'http://evil.example.com' } },
      escalation: { provider: 'gpt', perDay: -1, floor: { matches_prompt: 2 } },
      system1: { model: 'qwen-0.5b', device: 'webgpu', waitForReadyMs: 1.5 },
      gate: 'strict',
      secrets: { jev: 'x' }
    });
    expect(bad.ok).toBe(false);
    expect(bad.patch).toEqual({ system1: { device: 'webgpu' } });
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        'providers.jev.apiKey: unknown key',
        expect.stringMatching(/^providers\.jev\.enabled:/),
        expect.stringMatching(/^providers\.jev\.baseUrl:/),
        expect.stringMatching(/^escalation\.provider:/),
        expect.stringMatching(/^escalation\.perDay:/),
        expect.stringMatching(/^escalation\.floor\.matches_prompt:/),
        expect.stringMatching(/^system1\.model:/),
        expect.stringMatching(/^system1\.waitForReadyMs:/),
        'gate: expected an object',
        'secrets: unknown key'
      ])
    );
    // error messages never echo values
    expect(bad.errors.join(' ')).not.toContain('sk-should-never-be-here');
    expect(validateIntelligencePatch(null)).toEqual({ ok: false, patch: {}, errors: ['patch: expected an object'] });
  });

  test('baseUrl allows http only for local servers', () => {
    expect(validateIntelligencePatch({ providers: { openai: { baseUrl: 'http://localhost:11434/v1' } } }).patch).toEqual({
      providers: { openai: { baseUrl: 'http://localhost:11434/v1' } }
    });
    expect(validateIntelligencePatch({ providers: { jev: { baseUrl: 'http://127.0.0.1:8787' } } }).ok).toBe(true);
    expect(validateIntelligencePatch({ providers: { jev: { baseUrl: 'https://user:pw@api.typesafe.ai' } } }).ok).toBe(false);
    expect(validateIntelligencePatch({ providers: { jev: { baseUrl: 'ftp://api.typesafe.ai' } } }).ok).toBe(false);
  });
});

describe('schema v3: prompt lenses (DEC-6) and the per-prompt collect switch', () => {
  /** A v2 snapshot as an upgrading user has it: 25 built-ins, Ads, two tags the user wrote, one built-in label retyped in other case. */
  const v2 = (gateOn) => ({
    schemaVersion: 2,
    configuration: {
      matchPrompt: gateOn ? 'find me posts about ramen' : '',
      isMatchPromptEnabled: gateOn,
      promptVersion: 1,
      trackedTags: [
        ...defaultTrackedTags(),
        { id: 't_ads', label: 'Ads', isEnabled: true, isPseudo: true },
        { id: 'u1', label: 'Ramen', prompt: 'Find posts about ramen.', isEnabled: true },
        { id: 'u2', label: 'Climbing', prompt: 'Find posts about climbing.', isEnabled: false }
      ]
    },
    stack: []
  });
  const userTags = (state) => state.configuration.trackedTags.filter((t) => t.id === 'u1' || t.id === 'u2');

  test('a v2 state is stamped with the current schema, and that schema is v3 (the lens release)', () => {
    expect(migrateState(v2(true)).state.schemaVersion).toBe(SCHEMA_VERSION);
    // The pin Engineering bumps: lens fields in storage are v3 data, so a v2 reader must not mistake them for its own.
    expect(SCHEMA_VERSION).toBe(3);
  });

  // Re-pinned by Engineering (DEC-6 cdd1490, Bar Raiser F3): before lenses a tag never collected, so every
  // migrated user tag is labels-only whatever the master switch was; the old pin was collects = master state.
  test.each([[true, false], [false, false]])('master switch %s: every user tag gets isLens and collects = %s (an upgrade changes no feed)', (gateOn, collects) => {
    const { state } = migrateState(v2(gateOn));
    expect(userTags(state).map((t) => [t.isLens, t.collects])).toEqual([[true, collects], [true, collects]]);
  });

  test('built-in tags, Ads and dynamic tags are never lenses: no isLens, no collects, nothing else changed', () => {
    const before = v2(true);
    const { state } = migrateState(before);
    const builtIns = state.configuration.trackedTags.filter((t) => !userTags(state).includes(t));
    expect(builtIns).toHaveLength(defaultTrackedTags().length + 1);
    for (const tag of builtIns) {
      expect(tag, tag.label).not.toHaveProperty('isLens');
      expect(tag, tag.label).not.toHaveProperty('collects');
    }
    // the built-ins are otherwise exactly what they were (the Ads tag was already a pseudo-tag)
    expect(builtIns).toEqual(before.configuration.trackedTags.filter((t) => t.id !== 'u1' && t.id !== 'u2'));
  });

  test('a user tag typed with a built-in label (any case) is that built-in, not a lens', () => {
    const input = v2(true);
    const [first] = defaultTrackedTags();
    input.configuration.trackedTags.push({ id: 'u3', label: first.label.toUpperCase(), prompt: 'x', isEnabled: true });
    const { state } = migrateState(input);
    expect(state.configuration.trackedTags.find((t) => t.id === 'u3')).not.toHaveProperty('isLens');
  });

  test('re-running the migration is a no-op, and a collects the user already set is kept', () => {
    const input = v2(true);
    // true, not false (re-pinned by Engineering): with the labels-only default a stored false would pass even if ignored
    input.configuration.trackedTags.find((t) => t.id === 'u1').collects = true;
    const once = migrateState(input);
    expect(once.state.configuration.trackedTags.find((t) => t.id === 'u1').collects).toBe(true);
    expect(migrateState(once.state).changed).toBe(false);
  });
});
