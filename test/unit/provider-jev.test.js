import { describe, test, expect, vi, afterAll, beforeAll } from 'vitest';
import {
  createJevProvider,
  buildJevRequest,
  rotatedOptions,
  jevEndpoint,
  mapJevAnswers,
  JEV_TEST_STATE
} from '../../lib/decision/providers/jev.js';
import { buildMatchQuestion, buildPrimaryTagQuestion, buildTagNouls, NONE_OPTION } from '../../lib/decision/questions.js';
import { buildDecisionState } from '../../lib/decision/state.js';
import { createCascade } from '../../lib/decision/cascade.js';
import { startMockDecisionServer } from '../../e2e/mock-decision-server.mjs';

const KEY = 'jev_live_SECRET_0123456789abcdefWXYZ';
const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const TAGS = ['Food', 'Tech/AI', 'Jobs', 'Health', 'Sports'].map((label) => ({ label, prompt: `Identify posts related to ${label}.` }));
const ENABLED = { intelligence: { providers: { jev: { enabled: true } } } };

const sleepless = { sleep: async () => {}, random: () => 0 };

function state(text = 'We visited a Michelin star restaurant; the chef served a tasting menu.') {
  return buildDecisionState({ text, platform: 'linkedin.com' });
}

function questions() {
  return {
    matches_prompt: buildMatchQuestion(PROMPT, ''),
    primary_tag: buildPrimaryTagQuestion(TAGS, 0),
    ...buildTagNouls([{ label: 'Food', description: 'food and cooking' }])
  };
}

/** fetch stub: replies is a list of [status, body, headers?] (last one repeats) or functions. */
function fakeFetch(...replies) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    const [status, body, headers = {}] = next;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  });
  fn.calls = calls;
  return fn;
}

const OK_BODY = {
  model: 'jev-2026-09',
  answers: {
    matches_prompt: { noul: 0.91, confidence: 0.82 },
    primary_tag: { choice: 'Food', probabilities: { Food: 0.8, 'Tech/AI': 0.05, Jobs: 0.05, Health: 0.05, Sports: 0.03, none: 0.02 }, confidence: 0.76 },
    tag_Food: { noul: 0.97 }
  },
  usage: { input_tokens: 1000, output_tokens: 12 }
};

function provider({ fetchImpl, key = KEY, config = ENABLED, now } = {}) {
  let k = key;
  let cfg = config;
  const p = createJevProvider({ getSecret: async () => k, getConfig: async () => cfg, fetchImpl, now, http: sleepless });
  return { p, setKey: (v) => { k = v; }, setConfig: (v) => { cfg = v; } };
}

describe('request shape', () => {
  test('POST <baseUrl>/v1/systemone with a Bearer key, Jev questions and no key in the body', async () => {
    const f = fakeFetch([200, OK_BODY]);
    const { p } = provider({ fetchImpl: f });
    const s = state();
    await p.decide({ state: s, questions: questions() });
    expect(f).toHaveBeenCalledTimes(1);
    const { url, init, body } = f.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(init.body).not.toContain(KEY);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ platform: 'linkedin.com', post: s.text });
    // ids go out as safe keys ('tag:Food' -> 'tag_Food') and come back as ids
    expect(Object.keys(body.questions)).toEqual(['matches_prompt', 'primary_tag', 'tag_Food']);
    expect(body.questions.matches_prompt).toEqual({
      type: 'noul',
      instructions: questions().matches_prompt.instructions,
      criteria: questions().matches_prompt.criteria
    });
    expect(body.questions.tag_Food).toEqual({ type: 'noul', instructions: questions()['tag:Food'].instructions, criteria: questions()['tag:Food'].criteria });
    const choice = body.questions.primary_tag;
    expect(choice.type).toBe('choice');
    expect(Object.keys(choice.criteria)).toEqual(rotatedOptions(questions().primary_tag, s.textHash));
    expect(choice.criteria['Tech/AI']).toBe('Tech/AI');
    expect(Object.keys(choice.criteria).at(-1)).toBe(NONE_OPTION);
  });

  test('author only when the cascade passes one; base URL ending in /v1 is not doubled', () => {
    const withAuthor = buildJevRequest({ ...state(), author: 'Chef Ana' }, questions(), 'jev-latest');
    expect(withAuthor.state.author).toBe('Chef Ana');
    expect(buildJevRequest(state(), questions(), 'm').state).not.toHaveProperty('author');
    expect(jevEndpoint('http://127.0.0.1:9/v1')).toBe('http://127.0.0.1:9/v1/systemone');
    expect(jevEndpoint('https://api.typesafe.ai/')).toBe('https://api.typesafe.ai/v1/systemone');
  });

  test('option rotation is deterministic per post and spreads the first position', () => {
    const q = buildPrimaryTagQuestion(TAGS, 0);
    const a = state('Post number one about cooking pasta at home.');
    expect(rotatedOptions(q, a.textHash)).toEqual(rotatedOptions(q, a.textHash));
    const firsts = new Set();
    for (let i = 0; i < 40; i++) {
      const order = rotatedOptions(q, state(`Post ${i} about something else entirely.`).textHash);
      expect(order.at(-1)).toBe(NONE_OPTION);
      expect([...order].sort()).toEqual([...TAGS.map((t) => t.label), NONE_OPTION].sort());
      firsts.add(order[0]);
    }
    expect(firsts.size).toBeGreaterThan(2);
  });
});

describe('answer mapping and usage', () => {
  test('noul, choice (probabilities and confidence kept) and cost from input tokens', async () => {
    const { p } = provider({ fetchImpl: fakeFetch([200, OK_BODY]) });
    const res = await p.decide({ state: state(), questions: questions() });
    expect(res.provider).toBe('jev');
    expect(res.model).toBe('jev-2026-09');
    expect(res.answers.matches_prompt).toEqual({ type: 'noul', noul: 0.91, confidence: expect.closeTo(0.82, 10), source: 'jev' });
    expect(res.answers['tag:Food'].noul).toBe(0.97);
    expect(res.answers.primary_tag).toMatchObject({ type: 'choice', choice: 'Food', confidence: 0.76, source: 'jev' });
    expect(res.answers.primary_tag.probabilities.Food).toBeCloseTo(0.8, 10);
    expect(res.usage).toEqual({ input_tokens: 1000, output_tokens: 12, costUsd: expect.closeTo(0.000042, 12) });
    expect(p.stats()).toMatchObject({ calls: 1, errors: 0, costUsd: expect.closeTo(0.000042, 12), model: 'jev-latest' });
  });

  test("choice 'none' -> null; missing probabilities rebuilt from Jev confidence; unknown ids dropped", () => {
    const qs = questions();
    const a = mapJevAnswers({ answers: { primary_tag: { choice: 'none', confidence: 0.5 }, bogus: { noul: 1 } } }, qs);
    expect(a.primary_tag.choice).toBeNull();
    const n = 6;
    expect(a.primary_tag.probabilities.none).toBeCloseTo(0.5 * (1 - 1 / n) + 1 / n, 10);
    expect(a.primary_tag.confidence).toBe(0.5);
    expect(a).not.toHaveProperty('bogus');
    expect(mapJevAnswers({ answers: { matches_prompt: { noul: 'x' } } }, qs)).toEqual({});
    // answers under the safe key or the original id
    expect(mapJevAnswers({ answers: { tag_Food: { noul: 0.7 } } }, qs)['tag:Food'].noul).toBe(0.7);
    expect(mapJevAnswers({ answers: { 'tag:Food': { noul: 0.6 } } }, qs)['tag:Food'].noul).toBe(0.6);
  });

  test('a reply without usable answers is bad_response', async () => {
    const { p } = provider({ fetchImpl: fakeFetch([200, { answers: {} }]) });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'bad_response' });
  });

  test('malformed JSON is bad_response', async () => {
    const { p } = provider({ fetchImpl: fakeFetch([200, '{"answers": {nope']) });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'bad_response' });
    expect(p.status().state).toBe('ready');
  });
});

describe('status and circuit breaker', () => {
  test('no_key and disabled refuse without a request', async () => {
    const f = fakeFetch([200, OK_BODY]);
    const { p, setKey, setConfig } = provider({ fetchImpl: f, key: null, config: {} });
    expect(await p.isReady()).toBe(false);
    expect(p.status()).toMatchObject({ state: 'no_key' });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'no_key' });
    setKey(KEY);
    expect(await p.isReady()).toBe(false);
    expect(p.status().state).toBe('disabled');
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'disabled' });
    setConfig(ENABLED);
    expect(await p.isReady()).toBe(true);
    expect(f).not.toHaveBeenCalled();
    expect(p.stats().calls).toBe(0);
  });

  test('401 opens the circuit until the key changes', async () => {
    const f = fakeFetch([401, { error: { message: 'invalid key' } }], [200, OK_BODY]);
    const { p, setKey } = provider({ fetchImpl: f });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'auth_error' });
    expect(await p.isReady()).toBe(false);
    expect(p.status()).toMatchObject({ state: 'auth_error' });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'auth_error' });
    expect(f).toHaveBeenCalledTimes(1);
    setKey('jev_live_NEWKEY_9876543210zyxw');
    expect(await p.isReady()).toBe(true);
    await p.decide({ state: state(), questions: questions() });
    expect(f).toHaveBeenCalledTimes(2);
  });

  test('429 honors retry-after, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch([429, { error: 'slow down' }, { 'retry-after': '2' }], [200, OK_BODY]);
      const p = createJevProvider({ getSecret: async () => KEY, getConfig: async () => ENABLED, fetchImpl: f });
      const pending = p.decide({ state: state(), questions: questions() });
      await vi.advanceTimersByTimeAsync(1999);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(f).toHaveBeenCalledTimes(2);
      expect(res.answers.matches_prompt.noul).toBe(0.91);
      expect(p.status().state).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  test('529 after the retries cools down for 60 s', async () => {
    let t = 10_000;
    const f = fakeFetch([529, { error: { type: 'overloaded_error' } }], [529, {}], [529, {}], [200, OK_BODY]);
    const { p } = provider({ fetchImpl: f, now: () => t });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'overloaded' });
    expect(f).toHaveBeenCalledTimes(3);
    expect(await p.isReady()).toBe(false);
    expect(p.status()).toMatchObject({ state: 'rate_limited', retryAt: 70_000 });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(f).toHaveBeenCalledTimes(3);
    t = 70_000;
    expect(await p.isReady()).toBe(true);
    await p.decide({ state: state(), questions: questions() });
    expect(f).toHaveBeenCalledTimes(4);
  });

  test('timeout and offline are typed; offline shows in status but calls stay allowed', async () => {
    vi.useFakeTimers();
    try {
      const hang = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      const cfg = { intelligence: { providers: { jev: { enabled: true, timeoutMs: 1500 } } } };
      const slow = createJevProvider({ getSecret: async () => KEY, getConfig: async () => cfg, fetchImpl: fakeFetch(hang) });
      const pending = slow.decide({ state: state(), questions: questions() }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await pending).toMatchObject({ code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
    const { p } = provider({ fetchImpl: fakeFetch(new TypeError('Failed to fetch')) });
    await expect(p.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'offline' });
    expect(p.status().state).toBe('offline');
    expect(await p.isReady()).toBe(true);
  });
});

describe('redaction', () => {
  test('the key never appears in thrown errors, status.lastError, stats or test results', async () => {
    const echo = { error: { message: `Incorrect API key provided: ${KEY} (Authorization: Bearer ${KEY})` } };
    for (const status of [401, 422, 500]) {
      const { p } = provider({ fetchImpl: fakeFetch([status, echo]) });
      const err = await p.decide({ state: state(), questions: questions() }).catch((e) => e);
      for (const s of [err.message, err.body, String(err.stack), JSON.stringify(p.status()), JSON.stringify(p.stats())]) {
        expect(String(s)).not.toContain(KEY);
      }
      expect(p.status().lastError).toContain('[REDACTED]');
      const tested = await p.testConnection();
      expect(tested.ok).toBe(false);
      expect(JSON.stringify(tested)).not.toContain(KEY);
    }
  });
});

describe('testConnection', () => {
  test('one fixed synthetic post, allowed while switched off; no key -> no_key', async () => {
    const f = fakeFetch([200, { model: 'jev-latest', answers: { connection_test: { noul: 0.9 } } }]);
    const { p } = provider({ fetchImpl: f, config: {} });
    const res = await p.testConnection();
    expect(res).toMatchObject({ ok: true, model: 'jev-latest' });
    expect(f.calls[0].body.state).toEqual({ ...JEV_TEST_STATE });
    expect(Object.keys(f.calls[0].body.questions)).toEqual(['connection_test']);
    const none = provider({ fetchImpl: f, key: '' }).p;
    expect(await none.testConnection()).toMatchObject({ ok: false, code: 'no_key' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  test('a successful test closes an open circuit', async () => {
    const f = fakeFetch([401, {}], [200, { answers: { connection_test: { noul: 0.9 } } }]);
    const { p } = provider({ fetchImpl: f });
    expect(await p.testConnection()).toMatchObject({ ok: false, code: 'auth_error' });
    expect(p.status().state).toBe('auth_error');
    expect(await p.testConnection()).toMatchObject({ ok: true });
    expect(p.status().state).toBe('ready');
  });
});

describe('against the mock decision server (real fetch)', () => {
  /** @type {Awaited<ReturnType<typeof startMockDecisionServer>>} */
  let mock;
  beforeAll(async () => {
    mock = await startMockDecisionServer();
  });
  afterAll(async () => {
    await mock?.close();
  });

  const cfg = () => ({ intelligence: { providers: { jev: { enabled: true, baseUrl: mock.url, timeoutMs: 5000 } } } });

  test('food posts match, others do not; the log records auth presence and the post only', async () => {
    mock.setMode('ok');
    mock.clearLog();
    const p = createJevProvider({ getSecret: async () => KEY, getConfig: async () => cfg(), http: sleepless });
    const food = await p.decide({ state: state(), questions: questions() });
    expect(food.answers.matches_prompt.noul).toBeGreaterThan(0.9);
    expect(food.answers.primary_tag.choice).toBe('Food');
    const saas = await p.decide({ state: state('Our SOC 2 compliance autopilot ships today for SaaS teams.'), questions: questions() });
    expect(saas.answers.matches_prompt.noul).toBeLessThan(0.1);
    const log = mock.log();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ kind: 'jev', auth: 'present', post: state().text, model: 'jev-latest' });
    expect(JSON.stringify(log)).not.toContain(KEY);
  });

  test('faults: 401 (key echoed back) is redacted, 429 cools down, malformed is bad_response', async () => {
    const p = createJevProvider({ getSecret: async () => KEY, getConfig: async () => cfg(), http: sleepless });
    mock.setMode('echo401');
    const err = await p.decide({ state: state(), questions: questions() }).catch((e) => e);
    expect(err.code).toBe('auth_error');
    expect(err.message).not.toContain(KEY);

    const q = createJevProvider({ getSecret: async () => KEY, getConfig: async () => cfg(), http: sleepless });
    mock.setMode('429', { retryAfter: 0 });
    await expect(q.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(q.status().state).toBe('rate_limited');

    const r = createJevProvider({ getSecret: async () => KEY, getConfig: async () => cfg(), http: sleepless });
    mock.setMode('malformed');
    await expect(r.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'bad_response' });
    mock.setMode('422');
    await expect(r.decide({ state: state(), questions: questions() })).rejects.toMatchObject({ code: 'bad_request' });
    mock.setMode('ok');
  });

  test('as the cascade escalator: only the uncertain post reaches Jev', async () => {
    mock.setMode('ok');
    mock.clearLog();
    const jev = createJevProvider({ getSecret: async () => KEY, getConfig: async () => cfg(), http: sleepless });
    const system1 = {
      isReady: () => true,
      decideBatch: async ({ items }) => ({
        results: items.map((it) => ({
          id: it.id,
          answers: { matches_prompt: { noul: /tasting/.test(it.text) ? 0.55 : 0.02 } }
        }))
      })
    };
    const configuration = {
      matchPrompt: PROMPT,
      isMatchPromptEnabled: true,
      trackedTags: [],
      intelligence: { escalation: { provider: 'jev', floor: { matches_prompt: 0.5 } }, providers: { jev: { enabled: true, baseUrl: mock.url } } }
    };
    const { decideMany } = createCascade({ system1, escalators: { jev } });
    const decisions = await decideMany(
      [
        { id: 'a', text: 'A tasting menu at a Michelin star restaurant by a young chef.', platform: 'linkedin.com' },
        { id: 'b', text: 'Quarterly earnings beat expectations for the logistics company.', platform: 'linkedin.com' }
      ],
      { configuration }
    );
    expect(decisions[0]).toMatchObject({ escalated: true, provider: 'jev', collect: true });
    expect(decisions[1]).toMatchObject({ escalated: false, provider: 'system1', collect: false });
    expect(mock.log().map((e) => e.post)).toEqual(['A tasting menu at a Michelin star restaurant by a young chef.']);
  });
});
