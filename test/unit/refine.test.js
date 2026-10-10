/**
 * lib/pipeline/refine.js: the idle multi-model refinement pass (ensemble of both bundled System 1
 * models, then Gemini Nano for what stays uncertain; never a cloud provider) and its idle trigger,
 * plus the wiring in lib/bg/decision-runtime.js.
 */
import { describe, test, expect } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { defaultConfiguration } from '../../lib/bg/defaults.js';
import { createDecisionRuntime } from '../../lib/bg/decision-runtime.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { createRouter } from '../../lib/bg/router.js';
import { MSG } from '../../lib/messages.js';
import { Q } from '../../lib/decision/types.js';
import { thresholdConfidence, choiceConfidence } from '../../lib/decision/confidence.js';
import {
  createRefiner,
  createIdleTrigger,
  ensembleAnswers,
  modelsAgree,
  refineSpec,
  refineCandidates,
  secondaryModelOf,
  isRefineEligible,
  REFINE_ALARM
} from '../../lib/pipeline/refine.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const PANEL = { id: 'fake-extension-id', url: 'chrome-extension://fake-extension-id/sidepanel.html', origin: 'chrome-extension://fake-extension-id' };

const TAGS = [
  { id: 't1', label: 'Food', prompt: 'food, restaurants, cooking', isEnabled: true },
  { id: 't2', label: 'Jobs', prompt: 'job postings, hiring', isEnabled: true }
];

function config(over = {}) {
  return {
    ...defaultConfiguration(),
    isMatchPromptEnabled: true,
    matchPrompt: 'restaurant and fine dining posts',
    promptVersion: 3,
    trackedTags: TAGS,
    ...over,
    intelligence: { escalation: { provider: 'nano' }, ...(over.intelligence || {}) }
  };
}

/** A stored item decided by System 1 at ingest. */
function item(id, text, over = {}) {
  return {
    id,
    textSnippet: text,
    sourcePlatform: 'linkedin.com',
    timestamp: over.timestamp ?? 1000,
    assignedTag: over.assignedTag ?? 'Food',
    tags: [{ name: over.assignedTag ?? 'Food', score: 0.6 }],
    matchInfo: { engine: 'System 1 (local embeddings)' },
    decision: {
      v: 1, promptVersion: 3, specHash: 'old', path: ['system1'], provider: 'system1', pMatch: 0.7, matchConfidence: 0.4,
      tag: over.assignedTag ?? 'Food', tagConfidence: 0.5, tags: [], escalated: false, uncertain: false, reason: null,
      collect: true, latencyMs: 5, at: 1, ...(over.decision || {})
    },
    ...(over.extra || {})
  };
}

/**
 * Fake System 1 with two models. `scores[model][text] = { p, tags }`: p = P(match), tags = primary_tag
 * probabilities. decideBatch({ model }) answers with that model (default = the active one).
 */
function fakeSystem1({ scores, active = 'minilm', onDecide = null } = {}) {
  const calls = [];
  const released = [];
  return {
    calls,
    released,
    calibrationId: 'cal-1',
    floor: { matches_prompt: 0.5, primary_tag: 0.3 },
    status: () => ({ state: 'ready' }),
    isReady: async () => true,
    waitUntilReady: async () => true,
    async release(model) {
      released.push(model);
      return true;
    },
    async decideBatch(req) {
      const model = req.model || active;
      calls.push({ model, texts: req.items.map((i) => i.text) });
      if (onDecide) await onDecide(req, model, calls.length);
      await tick(1);
      return {
        results: req.items.map((it) => {
          const s = scores[model][it.text];
          if (!s) return { id: it.id, error: 's1_missing' };
          return {
            id: it.id,
            answers: {
              [Q.MATCHES_PROMPT]: { type: 'noul', noul: s.p },
              [Q.PRIMARY_TAG]: { type: 'choice', probabilities: s.tags }
            }
          };
        })
      };
    }
  };
}

function fakeNano({ ready = true, answer = () => ({ [Q.MATCHES_PROMPT]: { type: 'noul', noul: 0.1 } }) } = {}) {
  const calls = [];
  return {
    id: 'nano',
    isCloud: false,
    calls,
    isReady: async () => ready,
    status: () => ({ state: ready ? 'ready' : 'unavailable' }),
    async decide({ state, questions }) {
      calls.push({ text: state.text, questions: Object.keys(questions), author: state.author });
      return { answers: answer(state, questions), provider: 'nano', latencyMs: 1 };
    }
  };
}

/** Cloud provider spy: must never be called by the refiner. */
function cloudSpy(id) {
  const calls = [];
  return {
    id, isCloud: true, calls,
    isReady: async () => true,
    status: () => ({ state: 'ready' }),
    async decide(req) { calls.push(req); return { answers: { [Q.MATCHES_PROMPT]: { type: 'noul', noul: 0.99 } } }; },
    async testConnection() { return { ok: true, latencyMs: 0, model: id }; }
  };
}

const T = { Food: 0.6, Jobs: 0.2, none: 0.2 };
const SCORES = {
  minilm: {
    'Michelin chef tasting menu': { p: 0.9, tags: T },
    'Maybe a food truck event': { p: 0.6, tags: T },
    'Hiring a backend engineer': { p: 0.2, tags: { Food: 0.1, Jobs: 0.8, none: 0.1 } }
  },
  'bge-small': {
    'Michelin chef tasting menu': { p: 0.7, tags: { Food: 0.8, Jobs: 0.1, none: 0.1 } },
    'Maybe a food truck event': { p: 0.4, tags: T },
    'Hiring a backend engineer': { p: 0.1, tags: { Food: 0.1, Jobs: 0.6, none: 0.3 } }
  }
};

function setup({ cfg = config(), stack, system1, nano = fakeNano(), refiner: refinerOpts = {} } = {}) {
  const fake = createFakeChrome({ local: { configuration: cfg, stack } });
  const store = createStore({ area: fake.storage.local });
  const s1 = system1 || fakeSystem1({ scores: SCORES });
  const progress = [];
  const refiner = createRefiner({ store, system1: s1, nano, onProgress: (p) => progress.push(p), ...refinerOpts });
  const stackNow = () => fake.storage.local.peek('stack');
  return { fake, store, s1, nano, refiner, progress, stackNow };
}

describe('ensemble math', () => {
  test('matches_prompt is the mean of the calibrated probabilities; confidence against the strictness threshold', () => {
    const out = ensembleAnswers(
      { [Q.MATCHES_PROMPT]: { type: 'noul', noul: 0.9, confidence: 0.8, source: 'system1' } },
      { [Q.MATCHES_PROMPT]: { type: 'noul', noul: 0.7, confidence: 0.4, source: 'system1' } },
      0.7
    );
    expect(out[Q.MATCHES_PROMPT].noul).toBeCloseTo(0.8, 12);
    // strict (0.7): (0.8 - 0.7) / 0.3
    expect(out[Q.MATCHES_PROMPT].confidence).toBeCloseTo(1 / 3, 12);
    expect(out[Q.MATCHES_PROMPT].source).toBe('ensemble');
  });

  test('primary_tag probabilities are averaged over the union of labels and renormalised', () => {
    const out = ensembleAnswers(
      { [Q.PRIMARY_TAG]: { type: 'choice', choice: 'Food', probabilities: { Food: 0.8, none: 0.2 }, confidence: 0.6, source: 'system1' } },
      { [Q.PRIMARY_TAG]: { type: 'choice', choice: 'Jobs', probabilities: { Jobs: 0.6, none: 0.4 }, confidence: 0.2, source: 'system1' } },
      0.5
    );
    const t = out[Q.PRIMARY_TAG];
    expect(t.probabilities.Food).toBeCloseTo(0.4, 12);
    expect(t.probabilities.Jobs).toBeCloseTo(0.3, 12);
    expect(t.probabilities.none).toBeCloseTo(0.3, 12);
    expect(t.choice).toBe('Food');
    // (0.4 - 1/3) / (1 - 1/3)
    expect(t.confidence).toBeCloseTo(0.1, 12);
    expect(t.confidence).toBeCloseTo(choiceConfidence(t.probabilities), 12);
  });

  test('a question only one model answered keeps that answer; agreement compares verdict and tag', () => {
    const a = { [Q.MATCHES_PROMPT]: { type: 'noul', noul: 0.9 }, [Q.PRIMARY_TAG]: { type: 'choice', choice: 'Food', probabilities: { Food: 1 } } };
    const b = { [Q.MATCHES_PROMPT]: { type: 'noul', noul: 0.55 } };
    expect(ensembleAnswers(a, b, 0.5)[Q.PRIMARY_TAG]).toMatchObject({ choice: 'Food', source: 'ensemble' });
    expect(modelsAgree(a, { ...b, [Q.PRIMARY_TAG]: { choice: 'Food' } }, 0.5)).toBe(true);
    expect(modelsAgree(a, { ...b, [Q.PRIMARY_TAG]: { choice: 'Food' } }, 0.7)).toBe(false); // 0.55 < 0.7
    expect(modelsAgree(a, { ...b, [Q.PRIMARY_TAG]: { choice: null } }, 0.5)).toBe(false);
  });

  test('the secondary model is the bundled model that is not active', () => {
    expect(secondaryModelOf('minilm')).toBe('bge-small');
    expect(secondaryModelOf('bge-small')).toBe('minilm');
    expect(refineSpec(config({ intelligence: { system1: { model: 'bge-small' } } })).models).toEqual(['bge-small', 'minilm']);
  });

  test('eligibility: manual overrides, prefiltered noise and posts an escalator decided at ingest are left alone', () => {
    expect(isRefineEligible(item('a', 'x'))).toBe(true);
    expect(isRefineEligible(item('a', 'x', { extra: { matchInfo: { manual: true } } }))).toBe(false);
    expect(isRefineEligible(item('a', 'x', { decision: { provider: 'manual' } }))).toBe(false);
    expect(isRefineEligible(item('a', 'x', { decision: { path: ['prefilter'] } }))).toBe(false);
    expect(isRefineEligible(item('a', 'x', { decision: { path: ['system1', 'jev'], escalated: true } }))).toBe(false);
    expect(isRefineEligible(item('a', ''))).toBe(false);
  });
});

describe('refinement pass', () => {
  const stack = () => [
    item('old', 'Hiring a backend engineer', { timestamp: 1, assignedTag: 'Jobs' }),
    item('new', 'Michelin chef tasting menu', { timestamp: 3 }),
    item('mid', 'Maybe a food truck event', { timestamp: 2 })
  ];

  test('averages both models, asks Nano only for what stays uncertain, commits by id with exact numbers', async () => {
    const { refiner, s1, nano, stackNow, progress } = setup({ stack: stack() });
    const result = await refiner.run({ reason: 'test' });
    expect(result).toMatchObject({ outcome: 'done', total: 3, refined: 3, nanoCalls: 1, models: ['minilm', 'bge-small'] });

    // newest first, both models, same texts
    expect(s1.calls.map((c) => c.model)).toEqual(['minilm', 'bge-small']);
    expect(s1.calls[0].texts).toEqual(['Michelin chef tasting menu', 'Maybe a food truck event', 'Hiring a backend engineer']);
    expect(s1.released).toEqual(['bge-small']);

    const byId = Object.fromEntries(stackNow().map((i) => [i.id, i]));
    // (0.9 + 0.7) / 2 = 0.8, balanced threshold 0.5: confidence 0.6 >= floor 0.5 -> no Nano
    const n = byId.new.decision;
    expect(n.pMatch).toBe(0.8);
    expect(n.matchConfidence).toBe(0.6);
    expect(n.collect).toBe(true);
    // tags: Food (0.6 + 0.8) / 2 = 0.7, Jobs 0.15, none 0.15; confidence (0.7 - 1/3) / (2/3) = 0.55
    expect(n.tag).toBe('Food');
    expect(n.tagConfidence).toBe(0.55);
    expect(n.tags[0]).toEqual({ name: 'Food', score: 0.7 });
    expect(n.path).toEqual(['system1', 'ensemble']);
    expect(n.provider).toBe('ensemble');
    expect(n.refined).toMatchObject({ specHash: refineSpec(config(), s1).spec.specHash, models: ['minilm', 'bge-small'], agreement: true, nano: false });
    expect(byId.new.matchInfo.engine).toBe('System 1 ensemble (two local models)');

    // (0.6 + 0.4) / 2 = 0.5 -> confidence 0 -> Nano decides (0.1 -> not a match -> hidden)
    expect(nano.calls).toHaveLength(1);
    expect(nano.calls[0].text).toBe('Maybe a food truck event');
    expect(nano.calls[0].questions).toContain(Q.MATCHES_PROMPT);
    const m = byId.mid.decision;
    expect(m.pMatch).toBe(0.1);
    expect(m.path).toEqual(['system1', 'ensemble', 'nano']);
    expect(m.provider).toBe('nano');
    expect(m.refined).toMatchObject({ nano: true, agreement: false });
    expect(m.collect).toBe(false);
    expect(byId.mid.hiddenByPrompt).toBe(true);

    // (0.2 + 0.1) / 2 = 0.15: confident non-match, both agree on Jobs
    expect(byId.old.decision.pMatch).toBe(0.15);
    expect(byId.old.decision.matchConfidence).toBe(Math.round(thresholdConfidence(0.15, 0.5) * 1e4) / 1e4);
    expect(byId.old.decision.refined.agreement).toBe(true);
    expect(byId.old.hiddenByPrompt).toBe(true);

    expect(result.changedVerdicts).toBe(2);
    expect(progress.at(-1)).toMatchObject({ finished: true, refined: 3 });
  });

  test('already refined items are skipped; a spec change re-queues them', async () => {
    const { refiner, s1, fake } = setup({ stack: stack() });
    await refiner.run();
    const calls = s1.calls.length;
    const again = await refiner.run();
    expect(again).toMatchObject({ outcome: 'done', total: 0, refined: 0 });
    expect(s1.calls.length).toBe(calls);

    const cfg = fake.storage.local.peek('configuration');
    await fake.storage.local.set({ configuration: { ...cfg, matchPrompt: 'job postings', promptVersion: 4 } });
    const third = await refiner.run();
    expect(third.total).toBe(3);
    expect(s1.calls.length).toBe(calls + 2);
  });

  test('Nano is skipped when refine.nano is off, when it is not ready or switched off; cloud providers are never called', async () => {
    for (const { cfg, nano } of [
      { cfg: config({ intelligence: { refine: { nano: false } } }), nano: fakeNano() },
      { cfg: config(), nano: fakeNano({ ready: false }) },
      { cfg: config({ intelligence: { providers: { nano: { enabled: false } } } }), nano: fakeNano() }
    ]) {
      const { refiner, stackNow } = setup({ cfg, nano, stack: stack() });
      const r = await refiner.run();
      expect(r.nanoCalls).toBe(0);
      expect(nano.calls).toHaveLength(0);
      const mid = stackNow().find((i) => i.id === 'mid');
      // still uncertain: whenUnsure 'collect' keeps it
      expect(mid.decision).toMatchObject({ pMatch: 0.5, uncertain: true, collect: true, provider: 'ensemble' });
      expect(mid.hiddenByPrompt).toBe(false);
    }
  });

  test('the runtime refiner never calls a cloud provider, even when it is the escalation provider', async () => {
    const fake = createFakeChrome({
      local: {
        configuration: config({ intelligence: { escalation: { provider: 'jev', allowRedecideEscalation: true }, providers: { jev: { enabled: true }, openai: { enabled: true } } } }),
        stack: stack()
      }
    });
    const store = createStore({ area: fake.storage.local });
    const jev = cloudSpy('jev');
    const openai = cloudSpy('openai');
    const nano = fakeNano({ ready: false });
    const runtime = createDecisionRuntime({
      store,
      broadcast: { sendRuntime: async () => {} },
      area: fake.storage.local,
      session: fake.storage.session,
      engineStatusDebounceMs: 1,
      providers: { system1: fakeSystem1({ scores: SCORES }), nano, jev, openai },
      idleApi: fake.idle,
      alarmsApi: fake.alarms
    });
    const r = await runtime.refiner.run();
    expect(r.refined).toBe(3);
    expect(jev.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(0);
  });

  test('manual overrides are never touched and favourites never hidden', async () => {
    const s = [
      item('fav', 'Maybe a food truck event', { extra: { isFavorite: true } }),
      item('man', 'Hiring a backend engineer', { extra: { matchInfo: { manual: true } }, assignedTag: 'Food' })
    ];
    const { refiner, stackNow } = setup({ stack: s });
    await refiner.run();
    const byId = Object.fromEntries(stackNow().map((i) => [i.id, i]));
    expect(byId.fav.decision.collect).toBe(false);
    expect(byId.fav.hiddenByPrompt).toBe(false);
    expect(byId.man).toEqual(s[1]);
  });

  test('an item deleted (or re-decided) during the pass is not resurrected or overwritten', async () => {
    let fakeRef;
    const s1 = fakeSystem1({
      scores: SCORES,
      onDecide: async (_req, model) => {
        if (model !== 'bge-small') return;
        await fakeRef.store.mutateStack((fresh) => fresh
          .filter((i) => i.id !== 'old')
          .map((i) => (i.id === 'mid' ? { ...i, decision: { ...i.decision, at: 99, pMatch: 0.33 } } : i)));
      }
    });
    fakeRef = setup({ stack: stack(), system1: s1 });
    const r = await fakeRef.refiner.run();
    const ids = fakeRef.stackNow().map((i) => i.id);
    expect(ids).not.toContain('old');
    expect(ids).toHaveLength(2);
    const mid = fakeRef.stackNow().find((i) => i.id === 'mid');
    expect(mid.decision.pMatch).toBe(0.33);
    expect(mid.decision.refined).toBeUndefined();
    expect(r.refined).toBe(1);
  });

  test('yields to ingest / re-decide before a batch; a re-decide or a spec change drops the batch in flight', async () => {
    const busy = setup({ stack: stack(), refiner: { isBusy: () => true } });
    expect(await busy.refiner.run()).toMatchObject({ outcome: 'busy', refined: 0 });
    expect(busy.s1.calls).toHaveLength(0);

    const superseded = setup({ stack: stack(), refiner: { isSuperseded: () => true } });
    expect(await superseded.refiner.run()).toMatchObject({ outcome: 'cancelled', refined: 0 });
    expect(superseded.stackNow().every((i) => !i.decision.refined)).toBe(true);

    let ctx;
    const s1 = fakeSystem1({
      scores: SCORES,
      onDecide: async (_req, model) => {
        if (model !== 'bge-small') return;
        const cfg = ctx.fake.storage.local.peek('configuration');
        await ctx.fake.storage.local.set({ configuration: { ...cfg, matchPrompt: 'something else' } });
      }
    });
    ctx = setup({ stack: stack(), system1: s1 });
    expect(await ctx.refiner.run()).toMatchObject({ outcome: 'cancelled', refined: 0 });
    expect(ctx.stackNow().every((i) => !i.decision.refined)).toBe(true);
  });

  test('pause() lets the batch in flight commit, then stops; the next pass resumes with the rest', async () => {
    let ctx;
    const s1 = fakeSystem1({
      scores: SCORES,
      onDecide: async (_req, model, n) => {
        if (n === 2) ctx.refiner.pause();
      }
    });
    ctx = setup({ stack: stack(), system1: s1, refiner: { batchSize: 1 } });
    expect(await ctx.refiner.run()).toMatchObject({ outcome: 'paused', refined: 1 });
    expect(ctx.stackNow().filter((i) => i.decision.refined).map((i) => i.id)).toEqual(['new']);
    const next = await ctx.refiner.run();
    expect(next).toMatchObject({ outcome: 'done', total: 2, refined: 2 });
  });

  test('does nothing while refinement or System 1 is switched off; no model load without candidates', async () => {
    const off = setup({ cfg: config({ intelligence: { refine: { enabled: false } } }), stack: stack() });
    expect(await off.refiner.run()).toMatchObject({ outcome: 'skipped', skipped: 'disabled' });
    const s1off = setup({ cfg: config({ intelligence: { system1: { enabled: false } } }), stack: stack() });
    expect(await s1off.refiner.run()).toMatchObject({ outcome: 'skipped', skipped: 's1_disabled' });
    let waited = 0;
    const s1 = { ...fakeSystem1({ scores: SCORES }), waitUntilReady: async () => { waited++; return true; } };
    const empty = setup({ stack: [], system1: s1 });
    expect(await empty.refiner.run()).toMatchObject({ outcome: 'done', total: 0 });
    expect(waited).toBe(0);
    expect(refineCandidates(stack(), 'x', ['minilm', 'bge-small']).map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('idle trigger', () => {
  function trig({ enabled = true, idleSeconds = 90, canRun = () => true } = {}) {
    const fake = createFakeChrome();
    const runs = [];
    let paused = 0;
    const refiner = {
      run: async (o) => { runs.push(o.reason); return { outcome: 'done' }; },
      pause: () => { paused++; },
      cancel: () => {}
    };
    const t = createIdleTrigger({ refiner, idle: fake.idle, alarms: fake.alarms, getSettings: async () => ({ enabled, idleSeconds, nano: true }), canRun });
    return { fake, t, runs, paused: () => paused };
  }

  test('runs only when idle or locked; active pauses; the interval follows idleSeconds', async () => {
    const { fake, t, runs, paused } = trig();
    await t.start();
    expect(fake.idle.detectionInterval).toBe(90);
    expect(fake.alarms.created.get(REFINE_ALARM)).toMatchObject({ periodInMinutes: 5 });
    // a later worker start keeps the running alarm (re-creating it would restart its period)
    fake.alarms.created.set(REFINE_ALARM, { name: REFINE_ALARM, periodInMinutes: 5, marker: 1 });
    await t.start();
    expect(fake.alarms.created.get(REFINE_ALARM)).toMatchObject({ marker: 1 });
    await t.onIdleState('active');
    expect(runs).toEqual([]);
    expect(paused()).toBe(1);
    await t.onIdleState('idle');
    await t.onIdleState('locked');
    expect(runs).toEqual(['idle', 'idle']);
  });

  test('the periodic alarm asks chrome.idle and runs only when the user is idle', async () => {
    const { fake, t, runs } = trig();
    fake.idle.state = 'active';
    await t.onAlarm();
    expect(runs).toEqual([]);
    fake.idle.state = 'idle';
    await t.onAlarm();
    expect(runs).toEqual(['alarm']);
  });

  test('nothing runs when the setting is off or System 1 cannot run', async () => {
    const off = trig({ enabled: false });
    await off.t.onIdleState('idle');
    off.fake.idle.state = 'idle';
    await off.t.onAlarm();
    expect(off.runs).toEqual([]);
    const noS1 = trig({ canRun: () => false });
    await noS1.t.onIdleState('idle');
    expect(noS1.runs).toEqual([]);
  });
});

describe('runtime wiring', () => {
  function runtimeSetup() {
    const fake = createFakeChrome({ local: { configuration: config(), stack: [item('a', 'Michelin chef tasting menu', { decision: { pMatch: 0.2, collect: false } })] } });
    const store = createStore({ area: fake.storage.local });
    const sent = [];
    const s1 = fakeSystem1({ scores: SCORES });
    const runtime = createDecisionRuntime({
      store,
      broadcast: { sendRuntime: async (m) => { sent.push(JSON.parse(JSON.stringify(m))); } },
      area: fake.storage.local,
      session: fake.storage.session,
      engineStatusDebounceMs: 1,
      providers: { system1: s1, nano: fakeNano() },
      idleApi: fake.idle,
      alarmsApi: fake.alarms,
      isIngestBusy: () => false
    });
    fake.storage.onChanged.addListener((changes, area) => runtime.onStorageChanged(changes, area));
    return { fake, store, sent, s1, runtime };
  }

  test('idle state change runs a pass; one toast per pass that changed a verdict; diagnostics carry the counters', async () => {
    const { fake, sent, runtime } = runtimeSetup();
    await runtime.start();
    await runtime.onIdleState('idle');
    await runtime.refiner.idle();
    await tick(20);
    const toasts = sent.filter((m) => m.type === MSG.TOAST && m.payload.key === 'refine');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].payload.text).toMatch(/^Refined 1 post with a second model/);
    expect(fake.storage.local.peek('stack')[0].decision.refined.models).toEqual(['minilm', 'bge-small']);

    const handlers = createHandlers({
      store: createStore({ area: fake.storage.local }),
      broadcast: { scheduleBroadcast() {}, getInflightCount: () => 0, sendRuntime: async () => {}, broadcastToAllTabs: async () => {} },
      ingest: { enqueue: async () => ({ status: 'queued' }) },
      decision: runtime,
      engine: {},
      extensionOrigin: 'chrome-extension://fake-extension-id'
    });
    const route = createRouter(handlers, { extensionOrigin: 'chrome-extension://fake-extension-id' });
    const call = (type, payload, sender = PANEL) => new Promise((resolve) => { route({ type, payload }, sender, resolve); });
    const diag = await call(MSG.GET_DIAGNOSTICS, {});
    expect(diag.refine).toMatchObject({ enabled: true, refined: 1, total: 1, state: 'done', counters: { refined: 1, changedVerdicts: 1, changedTags: 0, nanoCalls: 0 } });
    // a pass with nothing left to do: no second toast
    await runtime.onIdleState('idle');
    await runtime.refiner.idle();
    await tick(20);
    expect(sent.filter((m) => m.type === MSG.TOAST && m.payload.key === 'refine')).toHaveLength(1);
    // pushed as EngineStatus.refine
    const pushed = sent.filter((m) => m.type === MSG.ENGINE_STATUS).map((m) => m.payload.refine).filter(Boolean);
    expect(pushed.at(-1)).toMatchObject({ refined: 1, total: 1 });
    // REFINE_NOW is side-panel only
    expect(await call(MSG.REFINE_NOW, {}, { tab: { id: 3 }, url: 'https://www.linkedin.com/feed/', origin: 'https://www.linkedin.com' })).toMatchObject({ code: 'forbidden' });
    expect(await call(MSG.REFINE_NOW, {})).toMatchObject({ success: true });
  });

  test('a prompt change cancels the running pass; the refine setting applies to chrome.idle live', async () => {
    const { fake, runtime } = runtimeSetup();
    const cfg = fake.storage.local.peek('configuration');
    await fake.storage.local.set({ configuration: { ...cfg, intelligence: { ...cfg.intelligence, refine: { idleSeconds: 300 } } } });
    expect(fake.idle.detectionInterval).toBe(300);
    const pass = runtime.refiner.run();
    await fake.storage.local.set({ configuration: { ...fake.storage.local.peek('configuration'), matchPrompt: 'other things' } });
    expect((await pass).outcome).toBe('cancelled');
    expect(fake.storage.local.peek('stack')[0].decision.refined).toBeUndefined();
  });
});
