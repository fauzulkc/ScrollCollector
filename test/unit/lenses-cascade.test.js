/**
 * Drafted by Engineering for 🧪 Testing review (ENG-1, prompt lenses; docs/team/engineering-goals.md).
 *
 * The cascade side of lenses: decision.lenses holds the score of every enabled lens on every decided
 * post; the gate collects a post when ANY COLLECTING lens matches (a lens tag with `collects: false` is
 * scored and labels but never collects); the built-in tags never gate; a lens tag is still a tag (it
 * labels exactly as before ENG-1); collecting lens questions escalate in the post's one call (gate on
 * only, at most 10); the backfill context never escalates; providers accept several noul questions.
 *
 * Every test here imports only modules that exist on the parent commit (562d77a), so each guard is
 * seen failing on the parent by behaviour, not by a missing import.
 */
import { describe, test, expect, vi } from 'vitest';
import {
  createCascade,
  buildDecideContext,
  buildDecisionSpec,
  resolvePolicy,
  STRICTNESS_THRESHOLDS
} from '../../lib/decision/cascade.js';
import { createRulesProvider } from '../../lib/decision/providers/rules.js';
import { buildQuestionPlan, mapLlmAnswers } from '../../lib/decision/providers/schema-builder.js';
import { buildJevRequest, mapJevAnswers } from '../../lib/decision/providers/jev.js';
import { noulAnswer } from '../../lib/decision/types.js';
import { choiceConfidence } from '../../lib/decision/confidence.js';
import { deepMerge, DEFAULT_INTELLIGENCE } from '../../lib/storage/schema.js';
import { isGateOn, decisionFingerprint, classifiableTags, resolveDynamicTag } from '../../lib/pipeline/apply-decision.js';
import { shouldHideByPrompt } from '../../lib/bg/stack-utils.js';

const MAIN_PROMPT = 'find me posts about michelin star restaurants';

const BUILT_INS = [
  { id: 't1', label: 'Food', isEnabled: true, prompt: 'Identify posts related to food, restaurants, cooking, or dining.' },
  { id: 't2', label: 'Jobs', isEnabled: true, prompt: 'Identify posts related to hiring, careers, or job postings.' },
  { id: 't_ads', label: 'Ads', isEnabled: true, isPseudo: true }
];
const lensTag = (id, label, prompt, extra = {}) => ({ id, label, prompt, isEnabled: true, isLens: true, ...extra });
/** The same lens with its collect switch off: scored, sorts, never collects. */
const sortOnly = (tag) => ({ ...tag, collects: false });
const RAMEN = lensTag('t_ramen', 'Ramen', 'Find posts about ramen shops and noodle broth.');
const CLIMBING = lensTag('t_climb', 'Climbing', 'Find posts about rock climbing and bouldering.');
const CHESS = lensTag('t_chess', 'Chess', 'Find posts about chess openings and tournaments.');

/** Escalation is off unless a test turns it on: every score below is System 1's own. */
const ESCALATE = { escalation: { provider: 'nano' } };

function config({ main = MAIN_PROMPT, enabled = true, lenses = [], builtIns = BUILT_INS, strictness, whenUnsure, intelligence = { escalation: { provider: 'none' } }, ...rest } = {}) {
  return {
    matchPrompt: main,
    isMatchPromptEnabled: enabled,
    promptVersion: 1,
    trackedTags: [...builtIns, ...lenses],
    intelligence: deepMerge(
      DEFAULT_INTELLIGENCE,
      deepMerge({ system1: { waitForReadyMs: 0 }, gate: { ...(strictness ? { strictness } : {}), ...(whenUnsure ? { whenUnsure } : {}) } }, intelligence)
    ),
    ...rest
  };
}

/**
 * System 1 stand-in. A post's text carries its scores as `[<question id>=<p>]` tokens, e.g.
 * `[main=0.9] [lens:t_ramen=0.7]` (`main` stands for matches_prompt); the default is 0.05. primary_tag
 * picks the label named by `[tag=<Label>]` when that label is on offer, else the first one offered.
 * It answers only the questions it is asked, so on the parent commit (which asks no lens question)
 * no lens is ever answered.
 */
function makeSystem1({ ready = true } = {}) {
  const calls = [];
  const score = (text, qid) => {
    const key = qid === 'matches_prompt' ? 'main' : qid;
    const m = new RegExp(`\\[${key.replace(/[:]/g, '\\:')}=([0-9.]+)\\]`).exec(text);
    return m ? Number(m[1]) : 0.05;
  };
  return {
    id: 'system1',
    calibrationId: 'cal-test',
    calls,
    isReady: vi.fn(async () => ready),
    waitUntilReady: vi.fn(async () => ready),
    decideBatch: vi.fn(async ({ items, questions, context }) => {
      calls.push({ questions, context });
      return {
        results: items.map((it) => {
          const answers = {};
          for (const [qid, q] of Object.entries(questions)) {
            if (q.type === 'noul') answers[qid] = noulAnswer(score(it.text, qid), 'system1');
            else if (q.type === 'choice') {
              const options = Object.keys(q.criteria).filter((o) => o !== 'none');
              const wanted = /\[tag=([^\]]+)\]/.exec(it.text)?.[1];
              const pick = options.includes(wanted) ? wanted : options[0];
              const probabilities = Object.fromEntries(Object.keys(q.criteria).map((o) => [o, o === pick ? 0.8 : 0.2 / (Object.keys(q.criteria).length - 1)]));
              answers[qid] = { type: 'choice', choice: pick, probabilities, confidence: choiceConfidence(probabilities), source: 'system1' };
            }
          }
          return { id: it.id, answers, ms: 1 };
        })
      };
    })
  };
}

/** An escalator that answers every noul question it is given with `p` and records the question ids. */
function makeNano({ p = 0.9 } = {}) {
  return {
    id: 'nano',
    displayName: 'nano',
    isCloud: false,
    isReady: vi.fn(async () => true),
    status: vi.fn(() => ({ state: 'ready' })),
    decide: vi.fn(async ({ questions }) => {
      const answers = {};
      for (const [qid, q] of Object.entries(questions)) {
        if (q.type === 'noul') answers[qid] = { type: 'noul', noul: p };
      }
      return { answers, provider: 'nano', latencyMs: 1 };
    })
  };
}

function setup({ system1 = makeSystem1(), nano = makeNano(), rules = createRulesProvider() } = {}) {
  const cascade = createCascade({ system1, escalators: { nano }, rules });
  return { cascade, system1, nano };
}

async function decide(cascade, cfg, text, ctxOver = {}) {
  const ctx = { ...buildDecideContext(cfg), ...ctxOver };
  const [d] = await cascade.decideMany([{ id: 'p1', text, platform: 'linkedin.com' }], ctx);
  return d;
}

describe('decision.lenses: every enabled lens on every decided post', () => {
  test('main + 3 user-tag lenses, built-in tags present: all four scored, below 0.5 too', async () => {
    const { cascade } = setup();
    const cfg = config({ lenses: [RAMEN, CLIMBING, CHESS] });
    const d = await decide(cascade, cfg, 'A post. [main=0.9] [lens:t_ramen=0.3] [lens:t_climb=0.05] [lens:t_chess=0.61]');
    expect(d.lenses).toEqual({ main: 0.9, t_ramen: 0.3, t_climb: 0.05, t_chess: 0.61 });
  });

  test('the built-in tags and the Ads tag are never lenses', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN] }), 'A post. [main=0.2] [lens:t_ramen=0.4]');
    expect(Object.keys(d.lenses).sort()).toEqual(['main', 't_ramen']);
  });

  test('a disabled lens tag is not scored; a tag without isLens is not a lens', async () => {
    const { cascade } = setup();
    const off = { ...CLIMBING, isEnabled: false };
    const plain = { id: 't_plain', label: 'Plain', prompt: 'plain tag', isEnabled: true };
    const d = await decide(cascade, config({ lenses: [RAMEN, off, plain] }), 'A post. [main=0.2] [lens:t_ramen=0.4]');
    expect(Object.keys(d.lenses).sort()).toEqual(['main', 't_ramen']);
  });

  test('pMatch is the main lens score', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN] }), 'A post. [main=0.8123] [lens:t_ramen=0.4]');
    expect(d.pMatch).toBe(0.8123);
    expect(d.lenses.main).toBe(d.pMatch);
  });

  test('scores are rounded to 4 places', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN] }), 'A post. [main=0.123456] [lens:t_ramen=0.654321]');
    expect(d.lenses).toEqual({ main: 0.1235, t_ramen: 0.6543 });
  });

  test('switch off, lens tag with collects:false: scored, main is not a lens, nothing escalates, everything collected', async () => {
    const { cascade, nano } = setup();
    const d = await decide(cascade, config({ enabled: false, lenses: [sortOnly(RAMEN)], intelligence: ESCALATE }), 'A post. [lens:t_ramen=0.55]');
    expect(d.lenses).toEqual({ t_ramen: 0.55 });
    expect(d.pMatch).toBeNull();
    expect(d.collect).toBe(true);
    expect(nano.decide).not.toHaveBeenCalled();
  });

  test('a noise post (prefilter) gets the prefilter score on every lens', async () => {
    const { cascade, system1 } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN] }), 'liked this');
    expect(system1.decideBatch).not.toHaveBeenCalled();
    expect(d.lenses).toEqual({ main: 0.02, t_ramen: 0.02 });
    expect(d.collect).toBe(false);
  });

  test('with System 1 down the rules tier still scores every lens', async () => {
    const system1 = makeSystem1({ ready: false });
    const { cascade } = setup({ system1 });
    const cfg = config({ lenses: [RAMEN], intelligence: { escalation: { provider: 'none' } } });
    const d = await decide(cascade, cfg, 'The best ramen shops serve rich noodle broth and the ramen noodles are fresh in this ramen shop.');
    expect(Object.keys(d.lenses).sort()).toEqual(['main', 't_ramen']);
    expect(d.lenses.t_ramen).toBeGreaterThan(d.lenses.main);
  });
});

describe('the any-lens gate', () => {
  test('gate on: a post that matches only a user-tag lens is collected', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN] }), 'A post. [main=0.05] [lens:t_ramen=0.95]');
    expect(d.collect).toBe(true);
    expect(d.pMatch).toBe(0.05);
  });

  test('gate on: a post that matches only the main prompt is collected', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN] }), 'A post. [main=0.95] [lens:t_ramen=0.05]');
    expect(d.collect).toBe(true);
  });

  test('gate on: a post that matches no lens is not collected', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN, CHESS] }), 'A post. [main=0.05] [lens:t_ramen=0.05] [lens:t_chess=0.05]');
    expect(d.collect).toBe(false);
  });

  test('gate on, empty match prompt, one lens tag: the gate is on and the lens decides', async () => {
    const { cascade } = setup();
    const cfg = config({ main: '', lenses: [RAMEN] });
    expect(isGateOn(cfg)).toBe(true);
    expect((await decide(cascade, cfg, 'A post. [lens:t_ramen=0.95]')).collect).toBe(true);
    expect((await decide(cascade, cfg, 'Another post. [lens:t_ramen=0.05]')).collect).toBe(false);
  });

  test('built-in tags never gate: a post that matches only a built-in tag is not collected', async () => {
    const { cascade } = setup();
    const cfg = config({ lenses: [RAMEN] });
    // The post is confidently a "Food" post (the built-in tag) but matches no prompt.
    const d = await decide(cascade, cfg, 'Great restaurant review. [tag=Food] [main=0.05] [lens:t_ramen=0.05]');
    expect(d.tag).toBe('Food');
    expect(d.collect).toBe(false);
  });

  test('gate on with no prompt and no lens (built-in tags only) is a gate off: everything collected, as before', async () => {
    const { cascade } = setup();
    const cfg = config({ main: '' });
    expect(isGateOn(cfg)).toBe(false);
    const d = await decide(cascade, cfg, 'Great restaurant review. [tag=Food]');
    expect(d.collect).toBe(true);
    expect(d.lenses).toEqual({});
  });

  test('switch off and no collecting lens: everything is collected whatever the lens scores', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ enabled: false, lenses: [sortOnly(RAMEN)] }), 'A post. [lens:t_ramen=0.01]');
    expect(d.collect).toBe(true);
  });

  test('switch off but a lens tag collects: the gate is on and only that lens collects', async () => {
    const { cascade } = setup();
    const cfg = config({ enabled: false, lenses: [RAMEN] });
    expect(isGateOn(cfg)).toBe(true);
    expect((await decide(cascade, cfg, 'A post. [lens:t_ramen=0.95]')).collect).toBe(true);
    expect((await decide(cascade, cfg, 'Another post. [main=0.95] [lens:t_ramen=0.05]')).collect).toBe(false);
  });

  test.each(['strict', 'balanced', 'lenient'])('the threshold is the strictness threshold (%s), and it is the one function', async (strictness) => {
    const { cascade } = setup();
    const t = STRICTNESS_THRESHOLDS[strictness];
    const cfg = config({ strictness, lenses: [RAMEN], intelligence: { escalation: { provider: 'none' } }, whenUnsure: 'skip' });
    expect(resolvePolicy(cfg).threshold).toBe(t);
    // Confident scores either side of the threshold (confidence = distance from t >= the floor), so whenUnsure is out of play.
    const above = Math.min(0.99, t + 0.45);
    const below = Math.max(0.01, t - 0.45);
    expect((await decide(cascade, cfg, `A post. [main=${below}] [lens:t_ramen=${above}]`)).collect).toBe(true);
    expect((await decide(cascade, cfg, `A post. [main=${below}] [lens:t_ramen=${below}]`)).collect).toBe(false);
  });

  test('a lens the user removed no longer gates (the stored score is ignored by the next decide)', async () => {
    const { cascade } = setup();
    const d = await decide(cascade, config({ lenses: [] }), 'A post. [main=0.05] [lens:t_ramen=0.95]');
    expect(d.collect).toBe(false);
    expect(d.lenses).toEqual({ main: 0.05 });
  });

  test('hiding follows the same gate: a lens-only gate hides a post whose decision says no', () => {
    const cfg = config({ main: '', lenses: [RAMEN] });
    const item = { id: 'x', decision: { collect: false, promptVersion: 1, path: ['system1'] } };
    expect(shouldHideByPrompt(item, cfg)).toBe(true);
    expect(shouldHideByPrompt(item, config({ main: '' }))).toBe(false);
  });
});

describe('a lens tag is still a tag (DEC-6, owner 02:27: label and lens)', () => {
  test('a post that matches a user tag as its category keeps the user tag, and the lens carries the score', async () => {
    const { cascade, system1 } = setup();
    const cfg = config({ lenses: [RAMEN] });
    const d = await decide(cascade, cfg, 'Best bowl of the year. [tag=Ramen] [main=0.05] [lens:t_ramen=0.93]');
    expect(d.tag).toBe('Ramen');
    expect(d.tags.map((t) => t.name)).toContain('Ramen');
    expect(d.lenses.t_ramen).toBe(0.93);
    expect(Object.keys(system1.calls[0].questions.primary_tag.criteria)).toEqual(expect.arrayContaining(['Food', 'Jobs', 'Ramen', 'none']));
  });

  test.each([['collects', {}], ['sort-only', { collects: false }]])('the label does not depend on collects (%s)', async (_n, extra) => {
    const { cascade } = setup();
    const cfg = config({ lenses: [{ ...RAMEN, ...extra }] });
    const d = await decide(cascade, cfg, 'Best bowl of the year. [tag=Ramen] [main=0.95] [lens:t_ramen=0.93]');
    expect(d.tag).toBe('Ramen');
    expect(d.tags.map((t) => t.name)).toContain('Ramen');
  });

  test('classifiableTags and the dynamic-tag matcher treat a lens tag like any tag', () => {
    expect(classifiableTags([...BUILT_INS, RAMEN]).map((t) => t.label)).toEqual(['Food', 'Jobs', 'Ramen']);
    const out = resolveDynamicTag([...BUILT_INS, RAMEN], { tag: 'Unclassified', meta: { dynamicTag: 'ramen' } },
      { intelligence: { dynamicTags: true } }, false, () => 'dt_1');
    expect(out).toEqual({ tag: 'Ramen', newTag: null });
  });

  test('built-in tags classify exactly as before', async () => {
    const { cascade } = setup();
    const withLens = await decide(cascade, config({ lenses: [RAMEN] }), 'Dinner. [tag=Jobs] [main=0.9]');
    const without = await decide(cascade, config(), 'Dinner. [tag=Jobs] [main=0.9]');
    expect(withLens.tag).toBe('Jobs');
    expect(withLens.tag).toBe(without.tag);
  });
});

describe('collects: the per-prompt collect switch (DEC-6, owner 02:27)', () => {
  test('absent collects means true', async () => {
    const { cascade } = setup();
    const { collects: _c, ...bare } = RAMEN;
    expect((await decide(cascade, config({ lenses: [bare] }), 'A post. [main=0.05] [lens:t_ramen=0.95]')).collect).toBe(true);
  });

  test('a lens with collects:false is scored but a match on it alone does not collect (gate on through main)', async () => {
    const { cascade } = setup();
    const cfg = config({ lenses: [sortOnly(RAMEN)] });
    const d = await decide(cascade, cfg, 'A post. [main=0.05] [lens:t_ramen=0.95]');
    expect(d.lenses).toEqual({ main: 0.05, t_ramen: 0.95 });
    expect(d.collect).toBe(false);
  });

  test('main and a collecting lens still collect while another lens is sort-only', async () => {
    const { cascade } = setup();
    const cfg = config({ lenses: [sortOnly(RAMEN), CHESS] });
    expect((await decide(cascade, cfg, 'A post. [main=0.05] [lens:t_ramen=0.05] [lens:t_chess=0.95]')).collect).toBe(true);
    expect((await decide(cascade, cfg, 'A post. [main=0.95] [lens:t_ramen=0.05] [lens:t_chess=0.05]')).collect).toBe(true);
    expect((await decide(cascade, cfg, 'A post. [main=0.05] [lens:t_ramen=0.95] [lens:t_chess=0.05]')).collect).toBe(false);
  });

  test('no collecting lens (empty match prompt, only a sort-only tag): nothing is filtered', async () => {
    const { cascade } = setup();
    const cfg = config({ main: '', lenses: [sortOnly(RAMEN)] });
    expect(isGateOn(cfg)).toBe(false);
    const d = await decide(cascade, cfg, 'A post. [lens:t_ramen=0.01]');
    expect(d.collect).toBe(true);
    expect(d.lenses).toEqual({ t_ramen: 0.01 });
  });

  test('a sort-only lens question is never escalated', async () => {
    const { cascade, nano } = setup();
    await decide(cascade, config({ lenses: [sortOnly(RAMEN), CHESS], intelligence: ESCALATE }), 'A post. [main=0.97] [lens:t_ramen=0.55] [lens:t_chess=0.55]');
    const asked = Object.keys(nano.decide.mock.calls[0][0].questions);
    expect(asked).toContain('lens:t_chess');
    expect(asked).not.toContain('lens:t_ramen');
  });

  test('flipping collects changes the fingerprint (and so re-decides); the spec hash keeps its cache keys', () => {
    const on = config({ lenses: [RAMEN] });
    const off = config({ lenses: [sortOnly(RAMEN)] });
    expect(decisionFingerprint(on)).not.toBe(decisionFingerprint(off));
    const spec = (c) => buildDecisionSpec(buildDecideContext(c), resolvePolicy(c), { calibrationId: 'c' });
    expect(spec(on).specHash).toBe(spec(off).specHash);
  });

  test('hiding follows the gate: a post only a sort-only lens matched is hidden once a collecting lens exists', () => {
    const item = { id: 'x', decision: { collect: false, promptVersion: 1, path: ['system1'] } };
    expect(shouldHideByPrompt(item, config({ lenses: [sortOnly(RAMEN)] }))).toBe(true);
    expect(shouldHideByPrompt(item, config({ main: '', lenses: [sortOnly(RAMEN)] }))).toBe(false);
  });
});

describe('the spec: the lens question is the matches_prompt question', () => {
  const spec = (cfg) => buildDecisionSpec(buildDecideContext(cfg), resolvePolicy(cfg), { calibrationId: 'c' });

  test('lens:<id> is built exactly like matches_prompt for the same prompt text', () => {
    const lensSpec = spec(config({ lenses: [RAMEN] }));
    const asMain = spec(config({ main: RAMEN.prompt }));
    expect(lensSpec.questions['lens:t_ramen']).toEqual(asMain.questions.matches_prompt);
    expect(lensSpec.questions['lens:t_ramen'].type).toBe('noul');
  });

  test('no tag noul and no choice question is asked for a lens', () => {
    const q = spec(config({ lenses: [RAMEN, CHESS] })).questions;
    expect(Object.keys(q).filter((k) => k.startsWith('tag:'))).toEqual([]);
    expect(Object.keys(q).sort()).toEqual(['lens:t_chess', 'lens:t_ramen', 'matches_prompt', 'primary_tag']);
  });

  test('a configuration without lenses keeps its spec hash (cache keys survive)', () => {
    const a = spec(config());
    const b = spec(config({ builtIns: BUILT_INS }));
    expect(a.specHash).toBe(b.specHash);
    expect(a.lenses.map((l) => l.id)).toEqual(['main']);
  });

  test('a lens prompt edit changes the spec hash', () => {
    expect(spec(config({ lenses: [RAMEN] })).specHash).not.toBe(spec(config({ lenses: [{ ...RAMEN, prompt: 'Find posts about udon.' }] })).specHash);
  });
});

describe('escalation: the post\'s one call to the one primary provider', () => {
  const MANY = Array.from({ length: 12 }, (_, i) => lensTag(`t_l${i}`, `Lens ${i}`, `Find posts about topic number ${i}.`));
  const uncertain = (ids) => ids.map((id) => `[${id}=0.55]`).join(' ');

  test('uncertain lens questions go in ONE call with matches_prompt, at most 10 lenses', async () => {
    const { cascade, nano } = setup();
    const cfg = config({ lenses: MANY, intelligence: ESCALATE });
    const d = await decide(cascade, cfg, `A post. [main=0.55] ${uncertain(MANY.map((l) => `lens:${l.id}`))}`);
    expect(nano.decide).toHaveBeenCalledTimes(1);
    const asked = Object.keys(nano.decide.mock.calls[0][0].questions);
    const lensAsked = asked.filter((id) => id === 'matches_prompt' || id.startsWith('lens:'));
    expect(lensAsked).toHaveLength(10);
    expect(lensAsked[0]).toBe('matches_prompt');
    expect(d.escalated).toBe(true);
    // The escalated lenses carry the provider's score (0.9); the rest keep System 1's.
    expect(d.lenses.main).toBe(0.9);
    expect(Object.values(d.lenses).filter((v) => v === 0.9)).toHaveLength(10);
    expect(Object.keys(d.lenses)).toHaveLength(13);
  });

  test('confident lens questions are not sent', async () => {
    const { cascade, nano } = setup();
    const d = await decide(cascade, config({ lenses: [RAMEN, CHESS], intelligence: ESCALATE }), 'A post. [main=0.97] [lens:t_ramen=0.02] [lens:t_chess=0.55]');
    const asked = Object.keys(nano.decide.mock.calls[0][0].questions);
    expect(asked).toContain('lens:t_chess');
    expect(asked).not.toContain('lens:t_ramen');
    expect(asked).not.toContain('matches_prompt');
    expect(d.lenses.t_ramen).toBe(0.02);
  });

  test('gate off (no collecting lens): lens questions never escalate', async () => {
    const { cascade, nano } = setup();
    await decide(cascade, config({ enabled: false, lenses: [sortOnly(RAMEN)], intelligence: ESCALATE }), 'A post. [lens:t_ramen=0.55]');
    expect(nano.decide).not.toHaveBeenCalled();
  });

  test('ctx.noEscalation (the backfill) asks System 1 alone, whatever the policy allows', async () => {
    const { cascade, nano } = setup();
    const cfg = config({ lenses: [RAMEN], intelligence: { escalation: { provider: 'nano', allowRedecideEscalation: true } } });
    const d = await decide(cascade, cfg, 'A post. [main=0.55] [lens:t_ramen=0.55]', { purpose: 'redecide', noEscalation: true });
    expect(nano.decide).not.toHaveBeenCalled();
    expect(d.escalated).toBe(false);
    expect(d.lenses).toEqual({ main: 0.55, t_ramen: 0.55 });
    // The same call without the flag does escalate (allowRedecideEscalation), so the flag is what stops it.
    const d2 = await decide(cascade, cfg, 'A post. [main=0.55] [lens:t_ramen=0.55]', { purpose: 'redecide' });
    expect(nano.decide).toHaveBeenCalledTimes(1);
    expect(d2.escalated).toBe(true);
  });

  test('cloud providers: a lens question reaches the cloud only through the one primary provider with its own opt-in', async () => {
    const jev = { ...makeNano(), id: 'jev', displayName: 'jev', isCloud: true };
    const system1 = makeSystem1();
    const cascade = createCascade({ system1, escalators: { nano: makeNano(), jev }, rules: createRulesProvider() });
    // provider 'jev' selected but not enabled: nothing leaves the device.
    const d = await decide(cascade, config({ lenses: [RAMEN], intelligence: { escalation: { provider: 'jev' } } }), 'A post. [main=0.55] [lens:t_ramen=0.55]');
    expect(jev.decide).not.toHaveBeenCalled();
    expect(d.escalated).toBe(false);
  });
});

describe('providers accept several noul questions (no adaptation needed)', () => {
  const q = (text) => ({ type: 'noul', instructions: `Is it? Reader request: "${text}"`, criteria: { true: 'yes', false: 'no' } });
  const questions = {
    matches_prompt: q('main prompt'),
    'lens:t_6f1c2b9e-1111-4222-8333-444455556666': q('first lens'),
    'lens:t_6f1c2b9e-1111-4222-8333-444455557777': q('second lens')
  };

  test('schema-builder: unique JSON keys per lens id, answers map back to the question ids', () => {
    const plan = buildQuestionPlan(questions);
    const keys = plan.entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => k.length <= 48 && /^[A-Za-z0-9_]+$/.test(k))).toBe(true);
    const reply = Object.fromEntries(plan.entries.map((e, i) => [e.key, { probability: 0.1 * (i + 1) }]));
    const out = mapLlmAnswers(reply, plan, 'nano');
    expect(Object.keys(out)).toEqual(Object.keys(questions));
    expect(out['lens:t_6f1c2b9e-1111-4222-8333-444455557777'].noul).toBeCloseTo(0.3, 5);
  });

  test('jev: the request carries one noul per lens and the answers map back by id', () => {
    const body = buildJevRequest({ text: 'post', platform: 'x.com' }, questions, 'jev-latest');
    expect(Object.keys(body.questions)).toHaveLength(3);
    const answers = Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, { type: 'noul', noul: 0.2 * (i + 1) }]));
    const out = mapJevAnswers({ answers }, questions);
    expect(Object.keys(out)).toEqual(Object.keys(questions));
  });
});

describe('decisionFingerprint: adding, removing, enabling, renaming a lens or editing its prompt', () => {
  const base = () => config({ lenses: [RAMEN] });
  const fp = decisionFingerprint;

  test.each([
    ['add a lens', (c) => ({ ...c, trackedTags: [...c.trackedTags, CHESS] })],
    ['remove a lens', (c) => ({ ...c, trackedTags: c.trackedTags.filter((t) => t.id !== 't_ramen') })],
    ['flip a lens\'s collect switch', (c) => ({ ...c, trackedTags: c.trackedTags.map((t) => (t.id === 't_ramen' ? { ...t, collects: false } : t)) })],
    ['disable a lens', (c) => ({ ...c, trackedTags: c.trackedTags.map((t) => (t.id === 't_ramen' ? { ...t, isEnabled: false } : t)) })],
    ['rename a lens', (c) => ({ ...c, trackedTags: c.trackedTags.map((t) => (t.id === 't_ramen' ? { ...t, label: 'Noodles' } : t)) })],
    ['edit a lens prompt', (c) => ({ ...c, trackedTags: c.trackedTags.map((t) => (t.id === 't_ramen' ? { ...t, prompt: 'Find posts about udon.' } : t)) })]
  ])('%s changes the fingerprint', (_name, change) => {
    expect(fp(change(base()))).not.toBe(fp(base()));
  });

  test('an unrelated edit does not', () => {
    expect(fp({ ...base(), ignoredKeywords: ['x'] })).toBe(fp(base()));
  });
});
