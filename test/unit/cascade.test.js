import { describe, test, expect, vi } from 'vitest';
import {
  createCascade,
  buildDecideContext,
  resolvePolicy,
  buildDecisionSpec,
  sanitizeAnswers,
  STRICTNESS_THRESHOLDS,
  PREFILTER_NOISE_P
} from '../../lib/decision/cascade.js';
import { createRulesProvider, rulesMatchAnswer, rulesChoiceAnswer } from '../../lib/decision/providers/rules.js';
import { scoreRuleBasedEvalMatch } from '../../lib/inference-engine.js';
import { createBudget } from '../../lib/decision/budget.js';
import { createDecisionCache } from '../../lib/decision/cache.js';
import { noulAnswer } from '../../lib/decision/types.js';
import { choiceConfidence, argmax } from '../../lib/decision/confidence.js';
import { buildPrimaryTagQuestion } from '../../lib/decision/questions.js';
import { textHash, normalizeForDecision } from '../../lib/decision/state.js';
import { deepMerge, DEFAULT_INTELLIGENCE } from '../../lib/storage/schema.js';

const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const TAG_LABELS = ['Food', 'Tech/AI', 'Jobs'];

/** configuration shaped like the extension's, with an intelligence patch */
function config({ intelligence = {}, ...overrides } = {}) {
  return {
    matchPrompt: PROMPT,
    isMatchPromptEnabled: true,
    matchPromptTags: ['Restaurants', 'Michelin Star', { name: 'Fine Dining', weight: 1 }],
    promptVersion: 3,
    trackedTags: [
      { id: 't1', label: 'Food', isEnabled: true, prompt: 'Identify posts related to food, restaurants, cooking, chefs, or dining.' },
      { id: 't2', label: 'Tech/AI', isEnabled: true, prompt: 'Identify posts related to software, technology, programming, or artificial intelligence.' },
      { id: 't3', label: 'Jobs', isEnabled: true, prompt: 'Identify posts related to hiring, careers, or job postings.' },
      { id: 't_ads', label: 'Ads', isEnabled: true, isPseudo: true }
    ],
    intelligence: deepMerge(DEFAULT_INTELLIGENCE, deepMerge({ system1: { waitForReadyMs: 0 } }, intelligence)),
    ...overrides
  };
}

const CONFIDENT_TAG = { Food: 0.8, 'Tech/AI': 0.1, Jobs: 0.05, none: 0.05 };
const UNSURE_TAG = { Food: 0.3, 'Tech/AI': 0.28, Jobs: 0.22, none: 0.2 };

/** System 1 answers keyed off markers in the text. */
function s1Answers(text) {
  const p = /MATCH_HIGH/.test(text) ? 0.95 : /MATCH_MID/.test(text) ? 0.55 : /MATCH_SIXTY/.test(text) ? 0.6 : 0.05;
  const probabilities = /TAG_UNSURE/.test(text) ? UNSURE_TAG : CONFIDENT_TAG;
  const best = argmax(probabilities);
  return {
    matches_prompt: noulAnswer(p, 'system1'),
    primary_tag: { type: 'choice', choice: best === 'none' ? null : best, probabilities, confidence: choiceConfidence(probabilities), source: 'system1' }
  };
}

function makeSystem1({ ready = true, waitResult, answers = s1Answers, reverse = false, error = null } = {}) {
  return {
    id: 'system1',
    calibrationId: 'cal-test',
    isReady: vi.fn(async () => ready),
    waitUntilReady: vi.fn(async () => waitResult ?? ready),
    decideBatch: vi.fn(async ({ items }) => {
      if (error) throw error;
      const results = items.map((it) => ({ id: it.id, answers: answers(it.text), ms: 4 }));
      return { results: reverse ? results.reverse() : results };
    })
  };
}

const ESCALATED_TAG = { Jobs: 0.9, Food: 0.05, 'Tech/AI': 0.03, none: 0.02 };

function makeEscalator(id, { isCloud = false, ready = true, state, error = null, match = 0.1, tag = 'Jobs' } = {}) {
  return {
    id,
    displayName: id,
    isCloud,
    isReady: vi.fn(async () => ready),
    status: vi.fn(() => ({ state: state ?? (ready ? 'ready' : 'unavailable') })),
    decide: vi.fn(async ({ questions }) => {
      if (error) throw error;
      const answers = {};
      for (const [qid, q] of Object.entries(questions)) {
        if (qid === 'matches_prompt') answers[qid] = { type: 'noul', noul: match };
        else if (q.type === 'noul') answers[qid] = { type: 'noul', noul: 0.8 };
        else answers[qid] = { type: 'choice', choice: tag, probabilities: ESCALATED_TAG, confidence: 0.87 };
      }
      return { answers, provider: id, latencyMs: 3 };
    })
  };
}

function makeStatus() {
  return { count: vi.fn(), error: vi.fn(), update: vi.fn() };
}

const FOOD_POST = 'MATCH_HIGH Our tasting menu at the new Michelin star restaurant opens Friday TAG_FOOD';
const MID_POST = 'MATCH_MID Thinking about where to have dinner with the team this week TAG_FOOD';
const LOW_POST = 'MATCH_LOW Quarterly roadmap update for our developer platform and SDKs';

function setup({ system1 = makeSystem1(), escalators, status = makeStatus(), budget = null, cache = null, rules = createRulesProvider(), now } = {}) {
  const esc = escalators ?? { nano: makeEscalator('nano') };
  const cascade = createCascade({ system1, escalators: esc, rules, status, budget, cache, ...(now ? { now } : {}) });
  return { cascade, system1, escalators: esc, status, budget, cache };
}

describe('cascade: confident System 1', () => {
  test('confident answer => no escalation, collected with the System 1 tag', async () => {
    const { cascade, escalators, system1, status } = setup();
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST, platform: 'linkedin.com' }], buildDecideContext(config()));
    expect(escalators.nano.decide).not.toHaveBeenCalled();
    expect(system1.decideBatch).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({
      v: 1,
      promptVersion: 3,
      path: ['system1'],
      provider: 'system1',
      pMatch: 0.95,
      matchConfidence: 0.9,
      tag: 'Food',
      escalated: false,
      uncertain: false,
      reason: null,
      collect: true
    });
    expect(d.tagConfidence).toBeCloseTo(choiceConfidence(CONFIDENT_TAG), 4);
    expect(d.tags).toEqual([{ name: 'Food', score: 0.8 }]);
    expect(d.specHash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof d.at).toBe('number');
    expect(status.count).toHaveBeenCalledWith(d);
  });

  test('one batched System 1 call for many posts; output keeps input order', async () => {
    const system1 = makeSystem1({ reverse: true });
    const { cascade } = setup({ system1 });
    const items = [
      { id: 'dup', text: FOOD_POST },
      { id: 'dup', text: LOW_POST },
      { id: 'c', text: 'MATCH_HIGH TAG_UNSURE A long read about ramen shops in Tokyo and their broths' }
    ];
    const out = await cascade.decideMany(items, buildDecideContext(config({ intelligence: { escalation: { provider: 'none' } } })));
    expect(system1.decideBatch).toHaveBeenCalledTimes(1);
    expect(system1.decideBatch.mock.calls[0][0].items).toHaveLength(3);
    expect(out.map((d) => d.pMatch)).toEqual([0.95, 0.05, 0.95]);
    expect(out.map((d) => d.collect)).toEqual([true, false, true]);
  });

  test('System 1 receives normalized text, the questions, the spec hash and the prompt pieces', async () => {
    const { cascade, system1 } = setup();
    await cascade.decideMany([{ id: 'a', text: `Post by: Ann\n\n${FOOD_POST} https://lnkd.in/x 🚀` }], buildDecideContext(config()));
    const req = system1.decideBatch.mock.calls[0][0];
    expect(req.items[0]).toEqual({ id: '0', text: normalizeForDecision(FOOD_POST) });
    expect(Object.keys(req.questions)).toEqual(['matches_prompt', 'primary_tag']);
    expect(Object.keys(req.questions.primary_tag.criteria)).toEqual([...TAG_LABELS, 'none']);
    expect(req.context.prompt).toEqual({ raw: PROMPT, cleaned: 'restaurant and 5 star quality food; michelin star cooking', expansion: '' });
    expect(req.specHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('cascade: escalation', () => {
  test('uncertain match => escalates to the primary provider; its answer overrides', async () => {
    const { cascade, escalators } = setup();
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(escalators.nano.decide).toHaveBeenCalledTimes(1);
    const req = escalators.nano.decide.mock.calls[0][0];
    // only the uncertain question goes out (the tag was confident)
    expect(Object.keys(req.questions)).toEqual(['matches_prompt']);
    expect(req.state.text).toBe(normalizeForDecision(MID_POST));
    expect(d).toMatchObject({
      path: ['system1', 'nano'],
      provider: 'nano',
      pMatch: 0.1,
      escalated: true,
      uncertain: false,
      collect: false,
      reason: null,
      tag: 'Food'
    });
  });

  test('uncertain tag => rotated primary_tag plus top-3 tag nouls go to the escalator', async () => {
    const { cascade, escalators } = setup();
    const text = 'MATCH_HIGH TAG_UNSURE Our chef shares the recipe behind the new spring menu';
    const [d] = await cascade.decideMany([{ id: 'a', text }], buildDecideContext(config()));
    const { questions } = escalators.nano.decide.mock.calls[0][0];
    expect(Object.keys(questions)).toEqual(['primary_tag', 'tag:Food', 'tag:Tech/AI', 'tag:Jobs']);
    const seed = parseInt(textHash(normalizeForDecision(text)).slice(-8), 16) >>> 0;
    expect(questions.primary_tag).toEqual(buildPrimaryTagQuestion(config().trackedTags, seed));
    expect(Object.keys(questions.primary_tag.criteria).at(-1)).toBe('none');
    expect(d).toMatchObject({ tag: 'Jobs', escalated: true, provider: 'nano', pMatch: 0.95, collect: true });
    expect(d.tags[0].name).toBe('Jobs');
    expect(d.tags).toHaveLength(3);
  });

  test('confidently rejected post => the uncertain tag is not escalated', async () => {
    const { cascade, escalators } = setup();
    const [d] = await cascade.decideMany([{ id: 'a', text: 'MATCH_LOW TAG_UNSURE Quarterly planning notes for the platform team' }], buildDecideContext(config()));
    expect(escalators.nano.decide).not.toHaveBeenCalled();
    expect(d).toMatchObject({ collect: false, escalated: false, reason: null, tag: 'Unclassified', uncertain: false });
  });

  test('cloud provider not enabled => no call, reason cloud_not_allowed', async () => {
    const jev = makeEscalator('jev', { isCloud: true });
    const { cascade } = setup({ escalators: { jev } });
    const cfg = config({ intelligence: { escalation: { provider: 'jev' } } }); // providers.jev.enabled defaults to false
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(cfg));
    expect(jev.decide).not.toHaveBeenCalled();
    expect(jev.isReady).not.toHaveBeenCalled();
    expect(d).toMatchObject({ reason: 'cloud_not_allowed', escalated: false, uncertain: true, collect: true, pMatch: 0.55, path: ['system1'] });
  });

  test('cloud provider enabled => uncertain posts escalate; author only with sendAuthor', async () => {
    const jev = makeEscalator('jev', { isCloud: true, match: 0.9 });
    const { cascade } = setup({ escalators: { jev } });
    const cfg = config({ intelligence: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true } } } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST, author: 'Ann Lee', platform: 'linkedin.com' }], buildDecideContext(cfg));
    expect(d).toMatchObject({ escalated: true, provider: 'jev', collect: true, path: ['system1', 'jev'] });
    expect(jev.decide.mock.calls[0][0].state).not.toHaveProperty('author');
    expect(jev.decide.mock.calls[0][0].state.platform).toBe('linkedin.com');

    const withAuthor = config({ intelligence: { escalation: { provider: 'jev', sendAuthor: true }, providers: { jev: { enabled: true } } } });
    await cascade.decideMany([{ id: 'b', text: `${MID_POST} again`, author: 'Ann Lee' }], buildDecideContext(withAuthor));
    expect(jev.decide.mock.calls[1][0].state.author).toBe('Ann Lee');
  });

  test("provider 'none' => no call, reason provider_none", async () => {
    const { cascade, escalators } = setup();
    const cfg = config({ intelligence: { escalation: { provider: 'none' } } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(cfg));
    expect(escalators.nano.decide).not.toHaveBeenCalled();
    expect(d).toMatchObject({ reason: 'provider_none', escalated: false, uncertain: true, collect: true });
  });

  test('missing or not-ready escalator => provider_unavailable / its status state', async () => {
    const { cascade } = setup({ escalators: {} });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(d.reason).toBe('provider_unavailable');

    const nano = makeEscalator('nano', { ready: false, state: 'downloadable' });
    const second = setup({ escalators: { nano } });
    const [d2] = await second.cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(nano.decide).not.toHaveBeenCalled();
    expect(d2.reason).toBe('downloadable');

    const disabled = setup();
    const [d3] = await disabled.cascade.decideMany(
      [{ id: 'a', text: MID_POST }],
      buildDecideContext(config({ intelligence: { providers: { nano: { enabled: false } } } }))
    );
    expect(d3.reason).toBe('provider_disabled');
  });

  test('budget exceeded => the remaining uncertain posts keep System 1 answers', async () => {
    const budget = createBudget({ now: () => 1_000_000 });
    const { cascade, escalators } = setup({ budget });
    const cfg = config({ intelligence: { escalation: { perMinute: 1, perDay: 100 } } });
    const out = await cascade.decideMany(
      [{ id: 'a', text: MID_POST }, { id: 'b', text: `${MID_POST} second` }],
      buildDecideContext(cfg)
    );
    expect(escalators.nano.decide).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ escalated: true, reason: null });
    expect(out[1]).toMatchObject({ escalated: false, reason: 'budget_exceeded', pMatch: 0.55, uncertain: true });
    expect(budget.snapshot()).toMatchObject({ perMinute: 1, minuteUsed: 1, dayUsed: 1 });
  });

  test('escalator throws => System 1 answer kept, status.error called, reason = error code', async () => {
    const err = Object.assign(new Error('429 Too Many Requests'), { code: 'rate_limited' });
    const nano = makeEscalator('nano', { error: err });
    const { cascade, status } = setup({ escalators: { nano } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(status.error).toHaveBeenCalledWith('nano', err);
    expect(d).toMatchObject({ pMatch: 0.55, escalated: false, uncertain: true, reason: 'rate_limited', path: ['system1'], provider: 'system1' });

    const plain = setup({ escalators: { nano: makeEscalator('nano', { error: new Error('boom') }) } });
    const [d2] = await plain.cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(d2.reason).toBe('escalation_error');
  });

  test("an escalator that never answers: deadline, System 1's answer stands (reason 'timeout'), the rest of the call skips it", async () => {
    const nano = makeEscalator('nano');
    /** @type {AbortSignal[]} */
    const signals = [];
    nano.decide.mockImplementation(({ signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const status = makeStatus();
    const cascade = createCascade({ system1: makeSystem1(), escalators: { nano }, rules: createRulesProvider(), status, escalationTimeoutMs: 40 });
    const t0 = Date.now();
    const out = await cascade.decideMany(
      [{ id: 'a', text: MID_POST }, { id: 'b', text: `${MID_POST} second` }, { id: 'c', text: FOOD_POST }],
      buildDecideContext(config())
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    // One stalled call, not one per uncertain post; the confident post never needed it.
    expect(nano.decide).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(true);
    expect(out[0]).toMatchObject({ pMatch: 0.55, escalated: false, uncertain: true, reason: 'timeout', path: ['system1'], provider: 'system1', collect: true });
    expect(out[1]).toMatchObject({ pMatch: 0.55, escalated: false, reason: 'timeout' });
    expect(out[2]).toMatchObject({ pMatch: 0.95, collect: true, escalated: false, reason: null });
    expect(status.error).toHaveBeenCalledTimes(1);
    expect(status.error.mock.calls[0][1]).toMatchObject({ code: 'timeout' });
  });

  test("the deadline comes from the escalator's own timeoutMs (plus grace) when the cascade sets none", async () => {
    vi.useFakeTimers();
    try {
      const nano = Object.assign(makeEscalator('nano'), { timeoutMs: 15000 });
      nano.decide.mockImplementation(() => new Promise(() => {}));
      const cascade = createCascade({ system1: makeSystem1(), escalators: { nano }, rules: createRulesProvider(), status: makeStatus() });
      let done = null;
      const pending = cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config())).then((v) => { done = v; });
      await vi.advanceTimersByTimeAsync(15000);
      expect(done).toBeNull();
      await vi.advanceTimersByTimeAsync(1500);
      await pending;
      expect(done[0]).toMatchObject({ reason: 'timeout', escalated: false });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a readiness check that hangs counts as not ready; a paused provider reports why", async () => {
    vi.useFakeTimers();
    try {
      const nano = makeEscalator('nano');
      nano.isReady.mockImplementation(() => new Promise(() => {}));
      const { cascade } = setup({ escalators: { nano } });
      const pending = cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
      await vi.advanceTimersByTimeAsync(5001);
      const [d] = await pending;
      expect(nano.decide).not.toHaveBeenCalled();
      expect(d).toMatchObject({ reason: 'provider_unavailable', escalated: false, pMatch: 0.55 });
    } finally {
      vi.useRealTimers();
    }

    const paused = makeEscalator('nano', { ready: false });
    paused.status.mockReturnValue({ state: 'ready', paused: 'timeout' });
    const { cascade } = setup({ escalators: { nano: paused } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(paused.decide).not.toHaveBeenCalled();
    expect(d.reason).toBe('timeout');
  });

  test('answers are stamped with the provider that produced them', async () => {
    const nano = makeEscalator('nano');
    nano.decide.mockResolvedValueOnce({ answers: { matches_prompt: { type: 'noul', noul: 0.9, source: 'gemini-nano-v3' } } });
    const { cascade } = setup({ escalators: { nano } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(d).toMatchObject({ escalated: true, provider: 'nano', uncertain: false, collect: true });
  });

  test('escalator returning nothing usable counts as an error', async () => {
    const nano = makeEscalator('nano');
    nano.decide.mockResolvedValueOnce({ answers: { matches_prompt: { type: 'noul', noul: 'yes' } } });
    const { cascade, status } = setup({ escalators: { nano } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(d).toMatchObject({ escalated: false, reason: 'empty_answer', pMatch: 0.55 });
    expect(status.error).toHaveBeenCalledTimes(1);
  });

  test('redecide purpose => no escalation unless allowRedecideEscalation', async () => {
    const jev = makeEscalator('jev', { isCloud: true });
    const { cascade } = setup({ escalators: { jev } });
    const cfg = config({ intelligence: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true } } } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(cfg, 'redecide'));
    expect(jev.decide).not.toHaveBeenCalled();
    expect(d).toMatchObject({ reason: 'redecide_no_escalation', escalated: false });

    const allowed = config({ intelligence: { escalation: { provider: 'jev', allowRedecideEscalation: true }, providers: { jev: { enabled: true } } } });
    const [d2] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(allowed, 'redecide'));
    expect(jev.decide).toHaveBeenCalledTimes(1);
    expect(d2.escalated).toBe(true);

    // ingest escalates normally
    await cascade.decideMany([{ id: 'b', text: `${MID_POST} b` }], buildDecideContext(cfg, 'ingest'));
    expect(jev.decide).toHaveBeenCalledTimes(2);
  });

  test('idle retry never re-sends stored posts to a cloud provider unless re-checks may escalate', async () => {
    const jev = makeEscalator('jev', { isCloud: true });
    const nano = makeEscalator('nano');
    const cache = createDecisionCache();
    const { cascade } = setup({ escalators: { jev, nano }, cache });
    const cfg = config({ intelligence: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true } } } });
    const text = 'MATCH_HIGH TAG_UNSURE Our chef shares the recipe behind the new spring menu';

    const [ingest] = await cascade.decideMany([{ id: 'a', text }], buildDecideContext(cfg, 'ingest'));
    expect(ingest.escalated).toBe(true);
    expect(jev.decide).toHaveBeenCalledTimes(1);

    // The retry asks with the gate off (another spec hash, so the cached answer does not apply).
    for (let i = 0; i < 3; i++) {
      const [retry] = await cascade.decideMany([{ id: 'a', text }], { ...buildDecideContext(cfg, 'retry'), gateOn: false });
      expect(retry).toMatchObject({ escalated: false, reason: 'retry_no_cloud', provider: 'system1' });
    }
    expect(jev.decide).toHaveBeenCalledTimes(1);

    const allowed = config({ intelligence: { escalation: { provider: 'jev', allowRedecideEscalation: true }, providers: { jev: { enabled: true } } } });
    const [opted] = await cascade.decideMany([{ id: 'a', text }], { ...buildDecideContext(allowed, 'retry'), gateOn: false });
    expect(opted.escalated).toBe(true);
    expect(jev.decide).toHaveBeenCalledTimes(2);

    // The on-device provider still gives retries a second opinion.
    const onDevice = config({ intelligence: { escalation: { provider: 'nano' } } });
    const [local] = await cascade.decideMany([{ id: 'b', text: `${text} b` }], { ...buildDecideContext(onDevice, 'retry'), gateOn: false });
    expect(local).toMatchObject({ escalated: true, provider: 'nano' });
  });

  test('System 1 down => nothing goes to a cloud provider; the rules decide', async () => {
    for (const system1 of [makeSystem1({ ready: false }), makeSystem1({ error: Object.assign(new Error('offscreen crashed'), { code: 's1_error' }) })]) {
      const jev = makeEscalator('jev', { isCloud: true });
      const { cascade } = setup({ system1, escalators: { jev } });
      const cfg = config({ intelligence: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true } } } });
      const out = await cascade.decideMany(
        [
          { id: 'a', text: 'Quarterly roadmap update for our developer platform and SDKs, see the changelog' },
          { id: 'b', text: 'Dinner at a Michelin star restaurant in Paris last night was unforgettable' }
        ],
        buildDecideContext(cfg)
      );
      expect(jev.isReady).toHaveBeenCalled();
      expect(jev.decide).not.toHaveBeenCalled();
      for (const d of out) expect(d).toMatchObject({ path: ['rules'], provider: 'rules', escalated: false, uncertain: true });
      expect(out[0].collect).toBe(false);
      expect(out[1].collect).toBe(true);
      expect(['s1_unavailable', 's1_error']).toContain(out[0].reason);
    }
  });

  test('cloud providers get the text without the attribution lines content.js adds', async () => {
    const jev = makeEscalator('jev', { isCloud: true, match: 0.9 });
    const { cascade } = setup({ escalators: { jev } });
    const cfg = config({ intelligence: { escalation: { provider: 'jev', sendAuthor: false }, providers: { jev: { enabled: true } } } });
    await cascade.decideMany(
      [
        { id: 'li', text: `Post by: Alice Martin (Head of Growth at Acme)\n\nWorth a read.\n\nReshared from Robert Kowalski:\n${MID_POST}`, author: 'Alice Martin' },
        { id: 'fb', text: `${MID_POST} pasta night\n\nAuthor: Carol Nguyen`, author: 'Carol Nguyen' },
        // Hacker News / Medium items stored while content.js still put a byline into the text
        { id: 'hn', platform: 'news.ycombinator.com', text: `${MID_POST} Show HN\n\nBy: jdoe42`, author: 'jdoe42' },
        { id: 'md', platform: 'medium.com', text: `${MID_POST} A beginner guide to starters By: Jane Q. Doe` }
      ],
      buildDecideContext(cfg)
    );
    expect(jev.decide).toHaveBeenCalledTimes(4);
    for (const [req] of jev.decide.mock.calls) {
      expect(req.state).not.toHaveProperty('author');
      expect(req.state.text).not.toMatch(/Alice|Martin|Robert|Kowalski|Carol|Nguyen|Reshared|Author|jdoe42|Jane|Doe|By:/);
    }
    expect(jev.decide.mock.calls[0][0].state.text).toBe(normalizeForDecision(`Worth a read. ${MID_POST}`));
  });
});

describe('cascade: gate and verdicts', () => {
  test('gate off => collect true and pMatch null; no matches_prompt question', async () => {
    const { cascade, system1, escalators } = setup();
    const cfg = config({ isMatchPromptEnabled: false });
    const [d] = await cascade.decideMany([{ id: 'a', text: LOW_POST }], buildDecideContext(cfg));
    expect(Object.keys(system1.decideBatch.mock.calls[0][0].questions)).toEqual(['primary_tag']);
    expect(d).toMatchObject({ pMatch: null, matchConfidence: null, collect: true, uncertain: false, tag: 'Food', provider: 'system1' });
    expect(escalators.nano.decide).not.toHaveBeenCalled();

    // gate on with an empty prompt behaves as off
    const empty = await cascade.decideMany([{ id: 'a', text: LOW_POST }], { ...buildDecideContext(config({ matchPrompt: '  ' })), gateOn: true });
    expect(empty[0]).toMatchObject({ pMatch: null, collect: true });
  });

  test("whenUnsure 'skip' rejects uncertain model answers", async () => {
    const { cascade } = setup();
    const cfg = config({ intelligence: { escalation: { provider: 'none' }, gate: { whenUnsure: 'skip' } } });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(cfg));
    expect(d).toMatchObject({ uncertain: true, collect: false });
  });

  test('strictness thresholds apply to certain answers', async () => {
    const { cascade } = setup();
    const text = 'MATCH_SIXTY A bistro opened near the office and the menu looks good';
    const decide = async (strictness) => {
      const cfg = config({ intelligence: { escalation: { provider: 'none', floor: { matches_prompt: 0.1 } }, gate: { strictness } } });
      return (await cascade.decideMany([{ id: 'a', text }], buildDecideContext(cfg)))[0];
    };
    expect(STRICTNESS_THRESHOLDS).toEqual({ strict: 0.7, balanced: 0.5, lenient: 0.3 });
    expect((await decide('strict')).collect).toBe(false);
    expect((await decide('balanced')).collect).toBe(true);
    expect((await decide('lenient')).collect).toBe(true);
  });

  test('strictness changes System 1 verdicts at the default floor: the uncertain band follows the threshold', async () => {
    const answers = (text) => ({
      matches_prompt: noulAnswer(Number(/P=([\d.]+)/.exec(text)[1]), 'system1'),
      primary_tag: { type: 'choice', choice: 'Food', probabilities: CONFIDENT_TAG, confidence: choiceConfidence(CONFIDENT_TAG), source: 'system1' }
    });
    const items = Array.from({ length: 99 }, (_, i) => ({ id: String(i), text: `P=${((i + 1) / 100).toFixed(2)} Dinner at a new bistro downtown with the team tonight` }));
    for (const whenUnsure of ['collect', 'skip']) {
      const collected = {};
      for (const strictness of ['strict', 'balanced', 'lenient']) {
        const cascade = createCascade({ system1: makeSystem1({ answers }), rules: createRulesProvider() });
        const cfg = config({ intelligence: { escalation: { provider: 'none' }, gate: { strictness, whenUnsure } } });
        const out = await cascade.decideMany(items, buildDecideContext(cfg));
        collected[strictness] = new Set(out.flatMap((d, i) => (d.collect ? [i] : [])));
      }
      // stricter never collects more, and each step changes some verdicts
      for (const [a, b] of [['strict', 'balanced'], ['balanced', 'lenient']]) {
        expect([...collected[a]].every((i) => collected[b].has(i))).toBe(true);
        expect(collected[b].size).toBeGreaterThan(collected[a].size);
      }
    }

    // floor 0.5: p = 0.3 is a confident 'no' when strict, unsure (collected) when balanced
    const one = async (p, strictness, whenUnsure = 'collect') => {
      const cascade = createCascade({ system1: makeSystem1({ answers }), rules: createRulesProvider() });
      const cfg = config({ intelligence: { escalation: { provider: 'none' }, gate: { strictness, whenUnsure } } });
      return (await cascade.decideMany([{ id: 'x', text: `P=${p} Dinner at a new bistro downtown with the team tonight` }], buildDecideContext(cfg)))[0];
    };
    expect(await one(0.3, 'strict')).toMatchObject({ uncertain: false, collect: false });
    expect(await one(0.3, 'balanced')).toMatchObject({ uncertain: true, collect: true });
    expect(await one(0.8, 'strict', 'skip')).toMatchObject({ uncertain: true, collect: false });
    expect(await one(0.8, 'balanced', 'skip')).toMatchObject({ uncertain: false, collect: true });
    expect(await one(0.7, 'lenient', 'skip')).toMatchObject({ uncertain: false, collect: true });
  });

  test('prefilter: social noise gets pMatch 0.02 and skips System 1', async () => {
    const { cascade, system1 } = setup();
    const [d] = await cascade.decideMany([{ id: 'a', text: 'Jane Doe viewed your profile and 3 others reacted' }], buildDecideContext(config()));
    expect(system1.decideBatch).not.toHaveBeenCalled();
    expect(d).toMatchObject({ path: ['prefilter'], provider: 'prefilter', pMatch: PREFILTER_NOISE_P, collect: false, reason: 'social_noise', tags: [] });
  });

  test('empty text: rejected by the gate, collected as Unclassified without it', async () => {
    const { cascade, system1 } = setup();
    const [on] = await cascade.decideMany([{ id: 'a', text: '🚀 https://lnkd.in/x' }], buildDecideContext(config()));
    expect(on).toMatchObject({ collect: false, reason: 'empty_text', path: ['prefilter'] });
    const [off] = await cascade.decideMany([{ id: 'a', text: '🚀 https://lnkd.in/x' }], buildDecideContext(config({ isMatchPromptEnabled: false })));
    expect(off).toMatchObject({ collect: true, tag: 'Unclassified', reason: 'empty_text', path: [] });
    expect(system1.decideBatch).not.toHaveBeenCalled();
  });

  test('no questions at all (gate off, no tags) => collected as Unclassified', async () => {
    const { cascade, system1 } = setup();
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(config({ isMatchPromptEnabled: false, trackedTags: [] })));
    expect(d).toMatchObject({ collect: true, tag: 'Unclassified', pMatch: null, path: [], provider: 'none' });
    expect(system1.decideBatch).not.toHaveBeenCalled();
  });
});

describe('cascade: System 1 unavailable', () => {
  test('waits up to waitForReadyMs, then rules decide (their verdict stands)', async () => {
    const system1 = makeSystem1({ ready: false });
    const cache = createDecisionCache();
    const { cascade } = setup({ system1, cache });
    const cfg = config({ intelligence: { system1: { waitForReadyMs: 5000 }, escalation: { provider: 'none' } } });
    const out = await cascade.decideMany(
      [
        { id: 'a', text: 'Dinner at a Michelin star restaurant in Paris last night was unforgettable' },
        { id: 'b', text: 'Our quarterly roadmap for the developer platform is now public' }
      ],
      buildDecideContext(cfg)
    );
    expect(system1.waitUntilReady).toHaveBeenCalledWith(5000);
    expect(system1.decideBatch).not.toHaveBeenCalled();
    const rulesP = (text) => scoreRuleBasedEvalMatch(text, PROMPT, cfg.matchPromptTags).pMatch;
    expect(out[0]).toMatchObject({ path: ['rules'], provider: 'rules', pMatch: rulesP('Dinner at a Michelin star restaurant in Paris last night was unforgettable'), uncertain: true, collect: true, reason: 's1_unavailable', tag: 'Food' });
    expect(out[0].pMatch).toBeGreaterThanOrEqual(0.5);
    expect(out[1]).toMatchObject({ path: ['rules'], pMatch: rulesP('Our quarterly roadmap for the developer platform is now public'), uncertain: true, collect: false });
    expect(out[1].pMatch).toBeLessThan(0.5);
    expect(cache.size()).toBe(0); // degraded answers are never cached
  });

  test('System 1 becomes ready while waiting => normal path', async () => {
    const system1 = makeSystem1({ ready: false, waitResult: true });
    const { cascade } = setup({ system1 });
    const cfg = config({ intelligence: { system1: { waitForReadyMs: 1000 } } });
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(cfg));
    expect(d.path).toEqual(['system1']);
  });

  test('System 1 down + Nano ready => Nano answers every question and the result is cached', async () => {
    const system1 = makeSystem1({ ready: false });
    const cache = createDecisionCache();
    const { cascade, escalators } = setup({ system1, cache });
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(config()));
    expect(Object.keys(escalators.nano.decide.mock.calls[0][0].questions)).toEqual(['matches_prompt', 'primary_tag']);
    expect(d).toMatchObject({ path: ['nano'], provider: 'nano', escalated: true, tag: 'Jobs', pMatch: 0.1 });
    expect(cache.size()).toBe(1);
  });

  test('System 1 batch error => status.error(system1), rules fill, reason = error code', async () => {
    const err = Object.assign(new Error('offscreen timed out'), { code: 's1_timeout' });
    const system1 = makeSystem1({ error: err });
    const { cascade, status } = setup({ system1 });
    const cfg = config({ intelligence: { escalation: { provider: 'none' } } });
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(cfg));
    expect(status.error).toHaveBeenCalledWith('system1', err);
    expect(d).toMatchObject({ path: ['rules'], reason: 's1_timeout' });
  });

  test('System 1 disabled in settings => not called', async () => {
    const { cascade, system1 } = setup();
    const cfg = config({ intelligence: { system1: { enabled: false }, escalation: { provider: 'none' } } });
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(cfg));
    expect(system1.isReady).not.toHaveBeenCalled();
    expect(d).toMatchObject({ path: ['rules'], reason: 's1_disabled' });
  });
});

describe('cascade: cache', () => {
  test('cache hit skips System 1 and appends cache to the path', async () => {
    const cache = createDecisionCache();
    const { cascade, system1, status } = setup({ cache });
    const ctx = buildDecideContext(config());
    const [first] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], ctx);
    const [second] = await cascade.decideMany([{ id: 'b', text: `${FOOD_POST} 🚀` }], ctx); // same normalized text
    expect(system1.decideBatch).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ path: ['system1', 'cache'], provider: 'system1', pMatch: first.pMatch, tag: first.tag, collect: true });
    expect(status.count).toHaveBeenCalledTimes(2);

    // a different prompt is a different spec => miss
    await cascade.decideMany([{ id: 'c', text: FOOD_POST }], buildDecideContext(config({ matchPrompt: 'AI tools that help with coding' })));
    expect(system1.decideBatch).toHaveBeenCalledTimes(2);
  });

  test('cached uncertain answers escalate once the policy allows it', async () => {
    const cache = createDecisionCache();
    const { cascade, system1, escalators } = setup({ cache });
    const [first] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config({ intelligence: { escalation: { provider: 'none' } } })));
    expect(first).toMatchObject({ escalated: false, reason: 'provider_none' });
    const [second] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(system1.decideBatch).toHaveBeenCalledTimes(1);
    expect(escalators.nano.decide).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ path: ['system1', 'cache', 'nano'], escalated: true, provider: 'nano', pMatch: 0.1 });
    // the escalated answer replaced the cached one
    const [third] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(escalators.nano.decide).toHaveBeenCalledTimes(1);
    expect(third).toMatchObject({ path: ['system1', 'nano', 'cache'], escalated: true, provider: 'nano', pMatch: 0.1 });
  });

  test('changing the strictness re-finalizes cached answers without a model call', async () => {
    const cache = createDecisionCache();
    const { cascade, system1 } = setup({ cache });
    const text = 'MATCH_SIXTY A bistro opened near the office and the menu looks good';
    const mk = (strictness) => config({ intelligence: { escalation: { provider: 'none', floor: { matches_prompt: 0.1 } }, gate: { strictness } } });
    const [a] = await cascade.decideMany([{ id: 'a', text }], buildDecideContext(mk('balanced')));
    const [b] = await cascade.decideMany([{ id: 'a', text }], buildDecideContext(mk('strict')));
    expect(system1.decideBatch).toHaveBeenCalledTimes(1);
    expect([a.collect, b.collect]).toEqual([true, false]);
  });
});

describe('cascade: status and policy plumbing', () => {
  test('status.update receives the provider and the budget snapshot', async () => {
    const budget = createBudget();
    const { cascade, status } = setup({ budget });
    await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(config()));
    expect(status.update).toHaveBeenCalledWith({ escalation: { provider: 'nano', budget: budget.snapshot() } });
  });

  test('latency excludes the wait for System 1 readiness', async () => {
    let t = 0;
    const now = () => t;
    const system1 = makeSystem1({ ready: false, waitResult: true });
    system1.waitUntilReady.mockImplementation(async () => {
      t += 10_000;
      return true;
    });
    system1.decideBatch.mockImplementation(async ({ items }) => {
      t += 40;
      return { results: items.map((it) => ({ id: it.id, answers: s1Answers(it.text) })) };
    });
    const { cascade } = setup({ system1, now });
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(config({ intelligence: { system1: { waitForReadyMs: 60000 } } })));
    expect(d.latencyMs).toBe(40);
  });

  test('resolvePolicy reads configuration.intelligence with defaults', () => {
    const p = resolvePolicy({});
    expect(p).toMatchObject({
      provider: 'nano',
      floor: { matches_prompt: 0.5, primary_tag: 0.35 },
      perMinute: 30,
      perDay: 1000,
      sendAuthor: false,
      allowRedecideEscalation: false,
      system1Enabled: true,
      waitForReadyMs: 180000,
      model: 'minilm',
      strictness: 'balanced',
      threshold: 0.5,
      whenUnsure: 'collect'
    });
    expect(p.providers.jev.enabled).toBe(false);
    const q = resolvePolicy({ intelligence: { escalation: { provider: 'bogus' }, gate: { strictness: 'weird', whenUnsure: 'skip' } } });
    expect(q).toMatchObject({ provider: 'none', strictness: 'balanced', whenUnsure: 'skip' });
  });

  test('floors: the user setting, else the System 1 calibration, else the built-in defaults', async () => {
    const calibratedFloor = { matches_prompt: 0.66, primary_tag: 0.3 };
    expect(resolvePolicy({}, { calibratedFloor }).floor).toEqual(calibratedFloor);
    expect(resolvePolicy({ intelligence: { escalation: { floor: { matches_prompt: 0.4 } } } }, { calibratedFloor }).floor).toEqual({ matches_prompt: 0.4, primary_tag: 0.3 });
    expect(resolvePolicy({}).floor).toEqual({ matches_prompt: 0.5, primary_tag: 0.35 });

    // The cascade reads the floor from the System 1 provider's calibration.
    const system1 = Object.assign(makeSystem1(), { floor: { matches_prompt: 0.95 } });
    const { cascade, escalators } = setup({ system1 });
    const [d] = await cascade.decideMany([{ id: 'a', text: FOOD_POST }], buildDecideContext(config())); // p 0.95, confidence 0.9
    expect(escalators.nano.decide).toHaveBeenCalledTimes(1);
    expect(d.escalated).toBe(true);
    const userFloor = config({ intelligence: { escalation: { floor: { matches_prompt: 0.5 } } } });
    const [e] = await cascade.decideMany([{ id: 'b', text: `${FOOD_POST} again` }], buildDecideContext(userFloor));
    expect(escalators.nano.decide).toHaveBeenCalledTimes(1);
    expect(e).toMatchObject({ escalated: false, uncertain: false, collect: true });
  });

  test('buildDecideContext derives gateOn, promptVersion and purpose', () => {
    expect(buildDecideContext({ isMatchPromptEnabled: true, matchPrompt: ' food ', promptVersion: 4 }, 'redecide')).toMatchObject({ gateOn: true, promptVersion: 4, purpose: 'redecide' });
    expect(buildDecideContext({ isMatchPromptEnabled: true, matchPrompt: '' })).toMatchObject({ gateOn: false, promptVersion: 0, purpose: 'ingest' });
    expect(buildDecideContext(null, 'nonsense').purpose).toBe('ingest');
  });

  test('spec hash changes with prompt, tags and model but not with strictness', () => {
    const policy = resolvePolicy(config());
    const base = buildDecisionSpec(buildDecideContext(config()), policy).specHash;
    expect(buildDecisionSpec(buildDecideContext(config()), resolvePolicy(config({ intelligence: { gate: { strictness: 'strict' } } }))).specHash).toBe(base);
    expect(buildDecisionSpec(buildDecideContext(config({ matchPrompt: 'other' })), policy).specHash).not.toBe(base);
    expect(buildDecisionSpec(buildDecideContext(config()), resolvePolicy(config({ intelligence: { system1: { model: 'bge-small' } } }))).specHash).not.toBe(base);
    expect(buildDecisionSpec(buildDecideContext(config()), policy, { calibrationId: 'v2' }).specHash).not.toBe(base);
  });

  test('getPolicy can override parts of the policy', async () => {
    const system1 = makeSystem1();
    const nano = makeEscalator('nano');
    const cascade = createCascade({ system1, escalators: { nano }, rules: createRulesProvider(), getPolicy: () => ({ floor: { matches_prompt: 0.05 } }) });
    const [d] = await cascade.decideMany([{ id: 'a', text: MID_POST }], buildDecideContext(config()));
    expect(nano.decide).not.toHaveBeenCalled();
    expect(d).toMatchObject({ uncertain: false, collect: true });
  });

  test('sanitizeAnswers validates shapes against the questions', () => {
    const questions = { matches_prompt: { type: 'noul', instructions: '' }, primary_tag: buildPrimaryTagQuestion(config().trackedTags) };
    const out = sanitizeAnswers(
      {
        matches_prompt: { type: 'noul', probability: 0.8 },
        primary_tag: { type: 'choice', choice: 'Nope', probabilities: { Food: 2, Jobs: 1, Bogus: 5 } },
        'tag:Food': { type: 'noul', noul: 0.7 },
        'tag:Unknown': { type: 'noul', noul: 0.7 },
        stray: { type: 'noul', noul: 1 }
      },
      questions,
      'jev',
      new Set(TAG_LABELS)
    );
    expect(Object.keys(out)).toEqual(['matches_prompt', 'primary_tag', 'tag:Food']);
    expect(out.matches_prompt).toEqual(noulAnswer(0.8, 'jev'));
    expect(out.primary_tag.choice).toBe('Food');
    expect(out.primary_tag.probabilities).toEqual({ Food: 2 / 3, 'Tech/AI': 0, Jobs: 1 / 3, none: 0 });
    // a bare choice without probabilities keeps the provider's confidence
    const bare = sanitizeAnswers({ primary_tag: { choice: null, confidence: 0.6 } }, questions, 'openai');
    expect(bare.primary_tag).toMatchObject({ choice: null, confidence: 0.6, probabilities: { none: 1 } });
  });
});

describe('rules provider', () => {
  const rules = createRulesProvider();

  test("matches_prompt: the rules engine's pMatch (0.2-0.85, low confidence)", () => {
    const tags = ['Restaurants', 'Michelin Star', { name: 'Fine Dining', weight: 1 }];
    const yes = rulesMatchAnswer('Dinner at a Michelin star restaurant in Paris', PROMPT, tags);
    const no = rulesMatchAnswer('Michelin tyres on sale for the winter season', PROMPT, tags);
    const expected = scoreRuleBasedEvalMatch('Dinner at a Michelin star restaurant in Paris', PROMPT, tags).pMatch;
    expect(yes).toEqual({ type: 'noul', noul: expected, confidence: expect.closeTo(Math.abs(2 * expected - 1), 10), source: 'rules' });
    expect(yes.noul).toBeGreaterThanOrEqual(0.65);
    expect(yes.noul).toBeLessThanOrEqual(0.85);
    expect(no.noul).toBeLessThan(0.5);
    expect(no.confidence).toBeLessThan(0.7);
  });

  test('matches_prompt: one concept passes only a lenient gate, none passes nothing', async () => {
    const decide = (strictness, text) => createCascade({ rules: createRulesProvider() }).decideMany(
      [{ id: 'x', text }],
      buildDecideContext(config({ intelligence: { escalation: { provider: 'none' }, gate: { strictness } } }))
    );
    const oneConcept = 'Our trip to Lyon ended at a lovely restaurant by the river';
    const noConcept = 'Our quarterly roadmap for the developer platform is now public';
    expect(rulesMatchAnswer(oneConcept, PROMPT, config().matchPromptTags).noul).toBe(0.4);
    expect((await decide('lenient', oneConcept))[0].collect).toBe(true);
    expect((await decide('balanced', oneConcept))[0].collect).toBe(false);
    // The old fixed 0.3 equalled the lenient threshold, so lenient collected every post.
    expect((await decide('lenient', noConcept))[0].collect).toBe(false);
  });

  test('primary_tag: keyword hits become probabilities including none', () => {
    const criteria = buildPrimaryTagQuestion(config().trackedTags).criteria;
    const food = rulesChoiceAnswer('The chef cooked a great meal at the restaurant', criteria);
    expect(food.choice).toBe('Food');
    expect(Object.keys(food.probabilities).sort()).toEqual([...TAG_LABELS, 'none'].sort());
    expect(Object.values(food.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(food.confidence).toBeCloseTo(choiceConfidence(food.probabilities), 10);
    expect(food.confidence).toBeGreaterThan(0.35);
    const none = rulesChoiceAnswer('A quiet afternoon by the lake', criteria);
    expect(none.choice).toBeNull();
    expect(argmax(none.probabilities)).toBe('none');
  });

  test('decide() answers the asked questions; prompt can come from the question text', async () => {
    const spec = buildDecisionSpec(buildDecideContext(config()), resolvePolicy(config()));
    const res = await rules.decide({ state: { text: 'Dinner at a Michelin star restaurant in Paris', textHash: 'x', platform: '' }, questions: spec.questions });
    expect(res.provider).toBe('rules');
    expect(Object.keys(res.answers)).toEqual(['matches_prompt', 'primary_tag']);
    expect(res.answers.matches_prompt.source).toBe('rules');
    expect(await rules.isReady()).toBe(true);
    expect(rules.status()).toEqual({ state: 'ready' });
  });

  test('isNoise flags notifications and very short snippets', () => {
    expect(rules.isNoise('Jane Doe viewed your profile')).toBe(true);
    expect(rules.isNoise('too short')).toBe(true);
    expect(rules.isNoise('A detailed review of the new tasting menu at our favourite bistro')).toBe(false);
  });
});
