/**
 * Drafted by Engineering for 🧪 Testing review (ENG-1, prompt lenses; docs/team/engineering-goals.md).
 *
 * lib/decision/lenses.js: the pure module the cascade, the idle refinement and the side panel share.
 * "Matched" is one function (docs/DESIGN.md P-2); the score label is one function (D-3).
 */
import { describe, test, expect } from 'vitest';
import {
  userLenses,
  scoredLenses,
  lensThreshold,
  isLensMatch,
  matchedLenses,
  lensScoreLabel,
  isLensGateOn,
  isUserAddedTag,
  lensGateVerdict,
  STRICTNESS_THRESHOLDS,
  LENS_MAIN_ID
} from '../../lib/decision/lenses.js';
import { resolvePolicy } from '../../lib/decision/cascade.js';
import { defaultTrackedTags, DEFAULT_TAG_LABELS } from '../../lib/bg/defaults.js';

const tag = (id, label, extra = {}) => ({ id, label, prompt: `Find posts about ${label}.`, isEnabled: true, isLens: true, ...extra });

describe('userLenses', () => {
  test('one ordered array: main first, then enabled isLens tags in configured order, each { id, label, text }', () => {
    const cfg = {
      matchPrompt: '  michelin star restaurants ',
      isMatchPromptEnabled: true,
      trackedTags: [...defaultTrackedTags(), tag('t_b', 'Bravo'), tag('t_a', 'Alpha')]
    };
    expect(userLenses(cfg)).toEqual([
      { id: 'main', label: null, text: 'michelin star restaurants' },
      { id: 't_b', label: 'Bravo', text: 'Find posts about Bravo.' },
      { id: 't_a', label: 'Alpha', text: 'Find posts about Alpha.' }
    ]);
  });

  test('no colour field, no extra fields', () => {
    const [main, t] = userLenses({ matchPrompt: 'p', trackedTags: [tag('t1x', 'X')] });
    expect(Object.keys(main).sort()).toEqual(['id', 'label', 'text']);
    expect(Object.keys(t).sort()).toEqual(['id', 'label', 'text']);
  });

  test('main is listed whenever the match prompt is non-empty (the switch does not remove it)', () => {
    expect(userLenses({ matchPrompt: 'p', isMatchPromptEnabled: false }).map((l) => l.id)).toEqual(['main']);
    expect(userLenses({ matchPrompt: '   ' }).map((l) => l.id)).toEqual([]);
  });

  test('a tag with a blank prompt uses the stored default text', () => {
    expect(userLenses({ trackedTags: [tag('t_z', 'Zen', { prompt: '  ' })] })).toEqual([{ id: 't_z', label: 'Zen', text: 'Find posts related to Zen.' }]);
    expect(userLenses({ trackedTags: [tag('t_z', 'Zen', { prompt: undefined })] })[0].text).toBe('Find posts related to Zen.');
  });

  test('never a lens: built-in tags, dynamic, pseudo, Ads, disabled, unflagged, duplicate ids, the id "main"', () => {
    const cfg = {
      trackedTags: [
        ...defaultTrackedTags(),
        { id: 't_x', label: 'Dyn', isEnabled: true, isDynamic: true, isLens: true },
        { id: 't_y', label: 'Pseudo', isEnabled: true, isPseudo: true, isLens: true },
        { id: 't_ads', label: 'Ads', isEnabled: true, isLens: true },
        tag('t_off', 'Off', { isEnabled: false }),
        { id: 't_plain', label: 'Plain', prompt: 'p', isEnabled: true },
        tag('t_dup', 'Dup1'),
        tag('t_dup', 'Dup2'),
        tag('main', 'Impostor')
      ]
    };
    expect(userLenses(cfg).map((l) => l.id)).toEqual(['t_dup']);
  });

  test('built-in tags (the 25 defaults) are never lenses even if flagged by mistake only when the migration flags them; userLenses itself trusts isLens', () => {
    expect(userLenses({ trackedTags: defaultTrackedTags() })).toEqual([]);
    expect(defaultTrackedTags()).toHaveLength(25);
    expect(DEFAULT_TAG_LABELS).toHaveLength(25);
  });

  test('scoredLenses drops main while the match-prompt switch is off', () => {
    const cfg = { matchPrompt: 'p', isMatchPromptEnabled: false, trackedTags: [tag('t_a', 'A')] };
    expect(scoredLenses(cfg).map((l) => l.id)).toEqual(['t_a']);
    expect(scoredLenses({ ...cfg, isMatchPromptEnabled: true }).map((l) => l.id)).toEqual(['main', 't_a']);
  });
});

describe('isUserAddedTag', () => {
  const builtIns = new Set(DEFAULT_TAG_LABELS);
  test.each([
    [{ id: 't_1', label: 'Ramen', prompt: 'p' }, true],
    [{ id: 't_1', label: 'Ramen' }, true],
    [{ id: 't1', label: 'Health', prompt: 'p' }, false],
    [{ id: 't_2', label: 'health', prompt: 'p' }, false],
    [{ id: 't_3', label: 'Ramen', isDynamic: true }, false],
    [{ id: 't_4', label: 'Ramen', isPseudo: true }, false],
    [{ id: 't_ads', label: 'Ads' }, false],
    [{ id: 't_5', label: '  ' }, false],
    [null, false]
  ])('%j -> %s', (t, want) => {
    expect(isUserAddedTag(t, builtIns)).toBe(want);
  });
});

describe('the one "matched" test', () => {
  const cfgFor = (strictness) => ({ intelligence: { gate: { strictness } } });

  test.each([
    ['strict', 0.7],
    ['balanced', 0.5],
    ['lenient', 0.3]
  ])('lensThreshold(%s) = %s and the cascade policy uses the same value', (strictness, want) => {
    expect(lensThreshold(cfgFor(strictness))).toBe(want);
    expect(STRICTNESS_THRESHOLDS[strictness]).toBe(want);
    expect(resolvePolicy(cfgFor(strictness)).threshold).toBe(lensThreshold(cfgFor(strictness)));
  });

  test('balanced when unset or unknown', () => {
    expect(lensThreshold({})).toBe(0.5);
    expect(lensThreshold(null)).toBe(0.5);
    expect(lensThreshold(cfgFor('nope'))).toBe(0.5);
    expect(resolvePolicy(cfgFor('nope')).threshold).toBe(0.5);
  });

  test('isLensMatch is score >= threshold, and only for a finite number', () => {
    expect(isLensMatch(0.5, {})).toBe(true);
    expect(isLensMatch(0.4999, {})).toBe(false);
    expect(isLensMatch(0.69, cfgFor('strict'))).toBe(false);
    expect(isLensMatch(0.7, cfgFor('strict'))).toBe(true);
    expect(isLensMatch(0.3, cfgFor('lenient'))).toBe(true);
    expect(isLensMatch(undefined, {})).toBe(false);
    expect(isLensMatch(NaN, {})).toBe(false);
    expect(isLensMatch('0.9', {})).toBe(false);
  });

  test('matchedLenses: the lenses a decision matched, best first; unknown, removed and unscored lenses are not matched', () => {
    const cfg = { matchPrompt: 'p', isMatchPromptEnabled: true, trackedTags: [tag('t_a', 'A'), tag('t_b', 'B'), tag('t_c', 'C')] };
    const decision = { lenses: { main: 0.55, t_a: 0.9, t_b: 0.49, t_gone: 0.99 } };
    expect(matchedLenses(decision, cfg)).toEqual([
      { id: 't_a', label: 'A', score: 0.9 },
      { id: 'main', label: null, score: 0.55 }
    ]);
    expect(matchedLenses({}, cfg)).toEqual([]);
    expect(matchedLenses(null, cfg)).toEqual([]);
    expect(matchedLenses(decision, { ...cfg, intelligence: { gate: { strictness: 'strict' } } }).map((m) => m.id)).toEqual(['t_a']);
  });

  test('matchedLenses and the cascade verdict agree on every score (P-2: one test)', () => {
    const cfg = { matchPrompt: 'p', isMatchPromptEnabled: true, trackedTags: [tag('t_a', 'A')], intelligence: { gate: { strictness: 'strict' } } };
    for (const score of [0, 0.29, 0.3, 0.49, 0.5, 0.69, 0.7, 0.71, 1]) {
      const matched = matchedLenses({ lenses: { main: score } }, cfg).length === 1;
      const verdict = lensGateVerdict([{ noul: score, decisive: true, settled: true }], { threshold: resolvePolicy(cfg).threshold, whenUnsure: 'collect' }).collect;
      expect(matched).toBe(verdict);
      expect(matched).toBe(isLensMatch(score, cfg));
    }
  });

  test('lensScoreLabel is Math.round(score * 100)', () => {
    expect(lensScoreLabel(0.8123)).toBe(81);
    expect(lensScoreLabel(0.495)).toBe(50);
    expect(lensScoreLabel(0.004)).toBe(0);
    expect(lensScoreLabel(1)).toBe(100);
    expect(lensScoreLabel(0.5)).toBe(Math.round(0.5 * 100));
    expect(lensScoreLabel(undefined)).toBeNull();
    expect(lensScoreLabel(NaN)).toBeNull();
  });
});

describe('isLensGateOn', () => {
  test.each([
    ['switch on + prompt', { isMatchPromptEnabled: true, matchPrompt: 'p' }, true],
    ['switch on + lens tag, no prompt', { isMatchPromptEnabled: true, matchPrompt: '', trackedTags: [tag('t_a', 'A')] }, true],
    ['switch on, nothing to match', { isMatchPromptEnabled: true, matchPrompt: '', trackedTags: defaultTrackedTags() }, false],
    ['switch off + prompt + lens', { isMatchPromptEnabled: false, matchPrompt: 'p', trackedTags: [tag('t_a', 'A')] }, false],
    ['null', null, false]
  ])('%s -> %s', (_n, cfg, want) => {
    expect(isLensGateOn(cfg)).toBe(want);
  });
});

describe('lensGateVerdict: with one lens it is the old single-prompt gate', () => {
  const policy = { threshold: 0.5, whenUnsure: 'collect' };
  const one = (noul, decisive, settled) => lensGateVerdict([{ noul, decisive, settled }], policy);

  test('confident yes / confident no / unsure / none / rules', () => {
    expect(one(0.9, true, true)).toEqual({ collect: true, uncertain: false });
    expect(one(0.1, true, true)).toEqual({ collect: false, uncertain: false });
    expect(one(0.55, false, false)).toEqual({ collect: true, uncertain: true });
    expect(lensGateVerdict([{ noul: 0.55, decisive: false, settled: false }], { ...policy, whenUnsure: 'skip' })).toEqual({ collect: false, uncertain: true });
    expect(one(null, false, false)).toEqual({ collect: true, uncertain: true });
    // a rules answer: its verdict stands, but it is never certain
    expect(one(0.2, true, false)).toEqual({ collect: false, uncertain: true });
    expect(one(0.85, true, false)).toEqual({ collect: true, uncertain: true });
  });

  test('several lenses: any decisive yes collects; an unsure one waits for whenUnsure; all confident no rejects', () => {
    const e = (noul, decisive = true, settled = decisive) => ({ noul, decisive, settled });
    expect(lensGateVerdict([e(0.1), e(0.9), e(0.2)], policy)).toEqual({ collect: true, uncertain: false });
    expect(lensGateVerdict([e(0.1), e(0.2)], policy)).toEqual({ collect: false, uncertain: false });
    expect(lensGateVerdict([e(0.1), e(0.55, false)], policy)).toEqual({ collect: true, uncertain: true });
    expect(lensGateVerdict([e(0.1), e(0.55, false)], { ...policy, whenUnsure: 'skip' })).toEqual({ collect: false, uncertain: true });
    expect(lensGateVerdict([e(0.55, false), e(0.9)], { ...policy, whenUnsure: 'skip' }).collect).toBe(true);
  });

  test('the main id', () => {
    expect(LENS_MAIN_ID).toBe('main');
  });
});
