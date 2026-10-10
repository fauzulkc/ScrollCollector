import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  createNanoProvider,
  nanoOptions,
  normalizeAvailability,
  NANO_TEST_STATE
} from '../../lib/decision/providers/nano.js';
import { DECISION_SYSTEM_PROMPT } from '../../lib/decision/providers/schema-builder.js';
import { buildMatchQuestion, buildPrimaryTagQuestion } from '../../lib/decision/questions.js';

const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const TAGS = ['Food', 'Tech/AI', 'Jobs'].map((label) => ({ label, prompt: `Identify posts related to ${label}.` }));
const ANSWER = JSON.stringify({ matches_prompt: { probability: 0.8 }, primary_tag: { choice: 'Food', confidence: 1 } });

function questions() {
  return { matches_prompt: buildMatchQuestion(PROMPT, ''), primary_tag: buildPrimaryTagQuestion(TAGS, 0) };
}

const STATE = { text: 'We visited a Michelin star restaurant; the chef served a tasting menu.', platform: 'linkedin.com' };

/**
 * Fake LanguageModel: availability()/params()/create(), sessions with clone()/prompt()/destroy().
 * `reply(text, options, n)` answers prompt() (n = 1-based prompt count); it may throw.
 */
function fakeLM({ availability = 'available', params = null, reply = () => ANSWER, rejectSampling = false } = {}) {
  const log = { availability: [], create: [], prompts: [], destroyed: [], clones: 0 };
  let avail = availability;
  let n = 0;
  class Session {
    constructor(opts, kind) {
      this.id = ++n;
      this.opts = opts;
      this.kind = kind;
    }
    async clone() {
      log.clones++;
      return new Session(this.opts, 'clone');
    }
    async prompt(text, options) {
      log.prompts.push({ text, options, session: this.id, kind: this.kind, system: this.opts.initialPrompts?.[0]?.content });
      return reply(text, options, log.prompts.length);
    }
    destroy() {
      log.destroyed.push({ id: this.id, kind: this.kind, system: this.opts.initialPrompts?.[0]?.content });
    }
  }
  const LM = {
    availability: vi.fn(async (opts) => {
      log.availability.push(opts);
      if (avail instanceof Error) throw avail;
      return avail;
    }),
    create: vi.fn(async (opts) => {
      log.create.push(opts);
      if (rejectSampling && ('temperature' in opts || 'topK' in opts)) throw new TypeError('Unsupported option: temperature');
      return new Session(opts, 'base');
    })
  };
  if (params) LM.params = vi.fn(async () => params);
  return { LM, log, setAvailability: (a) => { avail = a; } };
}

const quota = () => new DOMException('The input is too large.', 'QuotaExceededError');

afterEach(() => {
  vi.useRealTimers();
});

describe('availability and status', () => {
  test('the same OPTIONS go to availability() and create()', async () => {
    const { LM, log } = fakeLM();
    const nano = createNanoProvider({ languageModel: LM });
    expect(await nano.isReady()).toBe(true);
    await nano.decide({ state: STATE, questions: questions() });
    expect(log.availability[0]).toEqual(nanoOptions());
    expect(log.availability[0]).toEqual({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    });
    const { expectedInputs, expectedOutputs } = log.create[0];
    expect({ expectedInputs, expectedOutputs }).toEqual(log.availability[0]);
    expect(nano.status()).toMatchObject({ state: 'ready', availability: 'available', present: 'sw' });
  });

  test.each([
    ['available', 'ready', true],
    ['readily', 'ready', true],
    ['downloadable', 'downloadable', false],
    ['after-download', 'downloadable', false],
    ['downloading', 'downloading', false],
    ['unavailable', 'unavailable', false],
    ['no', 'unavailable', false]
  ])('availability %s -> %s', async (raw, state, ready) => {
    const { LM } = fakeLM({ availability: raw });
    const nano = createNanoProvider({ languageModel: LM });
    expect(await nano.isReady()).toBe(ready);
    expect(nano.status().state).toBe(state);
    expect(normalizeAvailability(raw)).toBe(state === 'ready' ? 'available' : state);
    if (state === 'downloadable') expect(nano.status().detail).toMatch(/needs a click/);
    if (state === 'unavailable') expect(nano.status().detail).toContain('chrome://on-device-internals');
    if (!ready) await expect(nano.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: state });
  });

  test('no LanguageModel, a throwing availability() and the user switch', async () => {
    const absent = createNanoProvider({ languageModel: null });
    expect(await absent.isReady()).toBe(false);
    expect(absent.status()).toMatchObject({ state: 'unavailable', present: 'none' });
    expect(await absent.testConnection()).toMatchObject({ ok: false, code: 'unavailable' });

    const { LM } = fakeLM({ availability: new Error('internal failure') });
    const broken = createNanoProvider({ languageModel: LM });
    expect(await broken.isReady()).toBe(false);
    expect(broken.status()).toMatchObject({ state: 'unavailable', lastError: 'internal failure' });

    const ok = fakeLM();
    const off = createNanoProvider({ languageModel: ok.LM, getConfig: () => ({ intelligence: { providers: { nano: { enabled: false } } } }) });
    expect(await off.isReady()).toBe(false);
    expect(off.status().state).toBe('disabled');
    await expect(off.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: 'disabled' });
    await expect(off.generateJson('s', 'u')).rejects.toMatchObject({ code: 'disabled' });
    expect(ok.LM.create).not.toHaveBeenCalled();
  });

  test('availability is cached 10 s, 5 s while downloading', async () => {
    let t = 0;
    const { LM, setAvailability } = fakeLM({ availability: 'downloadable' });
    const nano = createNanoProvider({ languageModel: LM, now: () => t });
    await nano.isReady();
    t = 9_999;
    await nano.isReady();
    expect(LM.availability).toHaveBeenCalledTimes(1);
    t = 10_000;
    setAvailability('downloading');
    await nano.isReady();
    expect(LM.availability).toHaveBeenCalledTimes(2);
    t = 14_999;
    await nano.isReady();
    expect(LM.availability).toHaveBeenCalledTimes(2);
    t = 15_000;
    setAvailability('available');
    expect(await nano.isReady()).toBe(true);
    expect(LM.availability).toHaveBeenCalledTimes(3);
    await nano.refresh(); // forced
    expect(LM.availability).toHaveBeenCalledTimes(4);
  });

  test('with an onStatus listener it polls every 5 s while downloading and stops when ready', async () => {
    vi.useFakeTimers();
    const seen = [];
    const { LM, setAvailability } = fakeLM({ availability: 'downloading' });
    const nano = createNanoProvider({ languageModel: LM, onStatus: (s) => seen.push(s.state) });
    await nano.checkAvailability();
    expect(seen).toEqual(['downloading']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(LM.availability).toHaveBeenCalledTimes(2);
    setAvailability('available');
    await vi.advanceTimersByTimeAsync(5000);
    expect(LM.availability).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(['downloading', 'ready']);
    await vi.advanceTimersByTimeAsync(20000);
    expect(LM.availability).toHaveBeenCalledTimes(3);
    nano.dispose();
  });

  test('download progress relayed from the side panel', async () => {
    const { LM, setAvailability } = fakeLM({ availability: 'downloadable' });
    const nano = createNanoProvider({ languageModel: LM });
    await nano.isReady();
    expect(nano.noteDownload({ phase: 'start' })).toMatchObject({ state: 'downloading', progress: 0 });
    expect(nano.noteDownload({ phase: 'progress', loaded: 0.42 })).toMatchObject({ state: 'downloading', progress: 0.42 });
    setAvailability('available');
    nano.noteDownload({ phase: 'done' });
    await vi.waitFor(() => expect(nano.status().state).toBe('ready'));
    expect(nano.status()).not.toHaveProperty('progress');
    setAvailability('downloadable');
    nano.noteDownload({ phase: 'error', error: 'NotAllowedError: needs a user gesture' });
    await vi.waitFor(() => expect(nano.status().state).toBe('downloadable'));
    expect(nano.status().lastError).toContain('user gesture');
  });
});

describe('sessions', () => {
  test('one base session (system prompt, temperature 0.2 + topK 3), a clone per call, clones destroyed', async () => {
    const { LM, log } = fakeLM();
    const nano = createNanoProvider({ languageModel: LM });
    await nano.decide({ state: STATE, questions: questions() });
    await nano.decide({ state: STATE, questions: questions() });
    expect(LM.create).toHaveBeenCalledTimes(1);
    expect(log.create[0]).toMatchObject({ initialPrompts: [{ role: 'system', content: DECISION_SYSTEM_PROMPT }], temperature: 0.2, topK: 3 });
    expect(log.clones).toBe(2);
    expect(log.prompts.map((p) => p.kind)).toEqual(['clone', 'clone']);
    expect(log.destroyed.map((d) => d.kind)).toEqual(['clone', 'clone']);
    expect(log.prompts[0].options.responseConstraint.required).toEqual(['matches_prompt', 'primary_tag']);
    expect(log.prompts[0].text).toContain(`<post>\n${STATE.text}\n</post>`);
  });

  test('temperature/topK clamped to params() maxima; created again without them when rejected', async () => {
    const a = fakeLM({ params: { defaultTopK: 3, maxTopK: 2, defaultTemperature: 1, maxTemperature: 0.1 } });
    await createNanoProvider({ languageModel: a.LM }).generateText('sys', 'hello');
    expect(a.log.create[0]).toMatchObject({ temperature: 0.1, topK: 2 });

    const b = fakeLM({ rejectSampling: true });
    const nano = createNanoProvider({ languageModel: b.LM });
    expect(await nano.generateText('sys', 'hello')).toBe(ANSWER);
    expect(b.log.create).toHaveLength(2);
    expect(b.log.create[1]).not.toHaveProperty('temperature');
    expect(b.log.create[1]).not.toHaveProperty('topK');
    await nano.generateText('other system', 'hello');
    expect(b.log.create).toHaveLength(3); // the rejection is remembered: no failing attempt first
    expect(b.log.create[2]).not.toHaveProperty('temperature');
  });

  test('LRU of 2 base sessions: the evicted one is destroyed', async () => {
    const { LM, log } = fakeLM();
    const nano = createNanoProvider({ languageModel: LM });
    await nano.generateText('A', 'x');
    await nano.generateText('B', 'x');
    await nano.generateText('A', 'x'); // A becomes most recent
    await nano.generateText('C', 'x'); // evicts B
    expect(log.create.map((c) => c.initialPrompts[0].content)).toEqual(['A', 'B', 'C']);
    await vi.waitFor(() => expect(log.destroyed.filter((d) => d.kind === 'base').map((d) => d.system)).toEqual(['B']));
    await nano.generateText('B', 'x'); // evicts A
    expect(log.create.map((c) => c.initialPrompts[0].content)).toEqual(['A', 'B', 'C', 'B']);
    nano.dispose();
    await vi.waitFor(() => expect(log.destroyed.filter((d) => d.kind === 'base').map((d) => d.system).sort()).toEqual(['A', 'B', 'B', 'C']));
  });
});

describe('decide', () => {
  test('maps answers like openai.js (noul probability, shrunk choice)', async () => {
    const { LM } = fakeLM();
    const nano = createNanoProvider({ languageModel: LM });
    const res = await nano.decide({ state: STATE, questions: questions() });
    expect(res.provider).toBe('nano');
    expect(res.answers.matches_prompt).toMatchObject({ type: 'noul', noul: 0.8, source: 'nano' });
    expect(res.answers.primary_tag.choice).toBe('Food');
    expect(res.answers.primary_tag.probabilities.Food).toBeCloseTo(0.9, 10);
    expect(nano.stats()).toMatchObject({ calls: 1, errors: 0 });
    expect(nano.maxConcurrency).toBe(1);
    expect(nano.isCloud).toBe(false);
  });

  test('QuotaExceededError: retried once with the post text halved', async () => {
    const long = `${'Michelin dinner tasting menu with seasonal produce. '.repeat(20)}`.trim();
    const { LM, log } = fakeLM({ reply: (text, options, n) => { if (n === 1) throw quota(); return ANSWER; } });
    const nano = createNanoProvider({ languageModel: LM });
    const res = await nano.decide({ state: { ...STATE, text: long }, questions: questions() });
    expect(res.answers.matches_prompt.noul).toBe(0.8);
    const post = (p) => /<post>\n([\s\S]*)\n<\/post>/.exec(p.text)[1];
    expect(post(log.prompts[0])).toBe(long);
    expect(post(log.prompts[1]).length).toBeLessThanOrEqual(Math.ceil(long.length / 2));
    expect(post(log.prompts[1]).length).toBeGreaterThan(long.length / 2 - 60);
    expect(long.startsWith(post(log.prompts[1]))).toBe(true);
  });

  test("a second QuotaExceededError is code 'nano_quota'", async () => {
    const { LM } = fakeLM({ reply: () => { throw quota(); } });
    const nano = createNanoProvider({ languageModel: LM });
    await expect(nano.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: 'nano_quota' });
    expect(nano.stats()).toMatchObject({ errors: 1, lastCode: 'nano_quota' });
    expect(nano.status().lastError).toMatch(/too long/);
  });

  test('unusable replies and model errors are typed', async () => {
    const junk = createNanoProvider({ languageModel: fakeLM({ reply: () => 'I like food' }).LM });
    await expect(junk.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: 'bad_response' });
    const aborted = createNanoProvider({ languageModel: fakeLM({ reply: () => { throw new DOMException('stop', 'AbortError'); } }).LM });
    await expect(aborted.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('text helpers and connection test', () => {
  test('generateText / generateJson pass the schema and parse JSON objects only', async () => {
    const replies = ['{"tags": ["Food"]}', 'no json', '[1,2]'];
    const { LM, log } = fakeLM({ reply: (t, o, n) => replies[n - 1] });
    const nano = createNanoProvider({ languageModel: LM });
    const schema = { type: 'object', properties: { tags: { type: 'array' } }, required: ['tags'], additionalProperties: false };
    expect(await nano.generateJson('sys', 'user', { schema })).toEqual({ tags: ['Food'] });
    expect(log.prompts[0].options.responseConstraint).toBe(schema);
    expect(await nano.generateJson('sys', 'user')).toBeNull();
    expect(log.prompts[1].options).not.toHaveProperty('responseConstraint');
    expect(await nano.generateJson('sys', 'user')).toBeNull();
  });

  test('testConnection: fixed synthetic post when available; the availability state otherwise', async () => {
    const { LM, log } = fakeLM({ reply: () => '{"connection_test": {"probability": 0.95}}' });
    const nano = createNanoProvider({ languageModel: LM, getConfig: () => ({ intelligence: { providers: { nano: { enabled: false } } } }) });
    expect(await nano.testConnection()).toMatchObject({ ok: true });
    expect(log.prompts[0].text).toContain(NANO_TEST_STATE.text);
    const d = fakeLM({ availability: 'downloadable' });
    expect(await createNanoProvider({ languageModel: d.LM }).testConnection()).toMatchObject({ ok: false, code: 'downloadable' });
  });
});

describe('deadlines (a stalled or very slow on-device model)', () => {
  const never = () => new Promise(() => {});

  test("a prompt that never settles: decide() rejects with 'timeout', aborts the prompt and pauses the model", async () => {
    let clock = 1000;
    const { LM, log } = fakeLM({ reply: never });
    const nano = createNanoProvider({ languageModel: LM, now: () => clock, decideTimeoutMs: 30, timeoutCooldownMs: 60000 });

    const t0 = Date.now();
    await expect(nano.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log.prompts).toHaveLength(1);
    expect(log.prompts[0].options.signal.aborted).toBe(true);
    expect(nano.stats()).toMatchObject({ errors: 1, lastCode: 'timeout' });

    // Paused: the cascade skips it and System 1's answers stand.
    expect(await nano.isReady()).toBe(false);
    expect(nano.status()).toMatchObject({ state: 'ready', paused: 'timeout' });
    expect(nano.status().lastError).toMatch(/did not finish the decision within 1 s/);

    clock += 60001;
    expect(await nano.isReady()).toBe(true);
    expect(nano.status().paused).toBeUndefined();
  });

  test('a base session whose create() never finishes is dropped, so the next call can recover', async () => {
    const { LM, log } = fakeLM();
    const create = LM.create;
    let hang = true;
    LM.create = vi.fn((opts) => (hang ? never() : create(opts)));
    const nano = createNanoProvider({ languageModel: LM, decideTimeoutMs: 30, timeoutCooldownMs: 0 });

    await expect(nano.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: 'timeout' });
    hang = false;
    const res = await nano.decide({ state: STATE, questions: questions() });
    expect(res.answers.matches_prompt.noul).toBeCloseTo(0.8, 5);
    expect(LM.create).toHaveBeenCalledTimes(2);
    expect(log.prompts).toHaveLength(1);
  });

  test('generateText / generateJson time out too (prompt tags, expansion, tag wand)', async () => {
    const { LM } = fakeLM({ reply: never });
    const nano = createNanoProvider({ languageModel: LM, textTimeoutMs: 30 });
    await expect(nano.generateJson('sys', 'user')).rejects.toMatchObject({ code: 'timeout' });
    expect(await nano.isReady()).toBe(false);
  });

  test('a hung availability() counts as unavailable instead of blocking isReady()', async () => {
    const { LM } = fakeLM();
    LM.availability = vi.fn(never);
    const nano = createNanoProvider({ languageModel: LM, availabilityTimeoutMs: 30 });
    expect(await nano.isReady()).toBe(false);
    expect(nano.status()).toMatchObject({ state: 'unavailable' });
    expect(nano.status().lastError).toMatch(/availability check/);
  });

  test('testConnection reports a timeout instead of hanging; a later success lifts the pause', async () => {
    let stall = true;
    const { LM } = fakeLM({ reply: () => (stall ? never() : '{"connection_test": {"probability": 0.95}}') });
    const nano = createNanoProvider({ languageModel: LM, decideTimeoutMs: 30 });
    await expect(nano.decide({ state: STATE, questions: questions() })).rejects.toMatchObject({ code: 'timeout' });
    expect(await nano.testConnection()).toMatchObject({ ok: false, code: 'timeout' });
    stall = false;
    expect(await nano.testConnection()).toMatchObject({ ok: true });
    expect(await nano.isReady()).toBe(true);
  });

  test("the caller's signal still cancels a call ('aborted', no pause)", async () => {
    const { LM } = fakeLM({ reply: never });
    const nano = createNanoProvider({ languageModel: LM, decideTimeoutMs: 60000 });
    const controller = new AbortController();
    const pending = nano.decide({ state: STATE, questions: questions(), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(await nano.isReady()).toBe(true);
  });
});
