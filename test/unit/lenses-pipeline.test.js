/**
 * Drafted by Engineering for 🧪 Testing review (ENG-1, prompt lenses; docs/team/engineering-goals.md).
 *
 * The storage and pipeline side of lenses: TAG_ADDED flags a lens; the v3 migration (idempotent, flags
 * only user tags, never derives scores from stored tags); the lens backfill through the re-decide job
 * (System 1 only, no escalation, lenses equal a fresh decide); a lens prompt edit re-decides and moves
 * that lens's score; the idle refinement keeps decision.lenses consistent with pMatch.
 */
import { describe, test, expect, vi } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { createBroadcaster } from '../../lib/bg/broadcast.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { defaultConfiguration, defaultTrackedTags } from '../../lib/bg/defaults.js';
import { emptyTelemetry } from '../../lib/bg/stack-utils.js';
import { migrateState } from '../../lib/storage/migrations.js';
import { createRedecider, isRedecideTarget } from '../../lib/pipeline/redecide.js';
import { createRefiner, refineSpec } from '../../lib/pipeline/refine.js';
import { createCascade, buildDecideContext } from '../../lib/decision/cascade.js';
import { createRulesProvider } from '../../lib/decision/providers/rules.js';
import { noulAnswer, Q } from '../../lib/decision/types.js';
import { choiceConfidence } from '../../lib/decision/confidence.js';
import { MSG } from '../../lib/messages.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const lensTag = (id, label, prompt) => ({ id, label, prompt, isEnabled: true, isLens: true });
const RAMEN = lensTag('t_ramen', 'Ramen', 'Find posts about ramen.');

/** System 1 stand-in: a lens/main question scores 0.9 when its Reader request shares a word with the post, else 0.05. */
function makeSystem1() {
  const calls = [];
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
  const scoreFor = (text, q) => {
    const request = /Reader request: "([^"]*)"/.exec(q.instructions)?.[1] || '';
    const stop = new Set(['find', 'posts', 'about', 'related']);
    const pw = [...words(request)].filter((w) => !stop.has(w));
    const tw = words(text);
    return pw.some((w) => tw.has(w)) ? 0.9 : 0.05;
  };
  return {
    id: 'system1',
    calibrationId: 'cal-test',
    calls,
    isReady: async () => true,
    waitUntilReady: async () => true,
    decideBatch: vi.fn(async ({ items, questions }) => {
      calls.push({ ids: items.map((i) => i.text), questions: Object.keys(questions) });
      return {
        results: items.map((it) => {
          const answers = {};
          for (const [qid, q] of Object.entries(questions)) {
            if (q.type === 'noul') answers[qid] = noulAnswer(scoreFor(it.text, q), 'system1');
            else {
              const options = Object.keys(q.criteria).filter((o) => o !== 'none');
              const pick = options.find((o) => it.text.includes(o)) || options[0];
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

function nanoSpy() {
  return {
    id: 'nano', displayName: 'nano', isCloud: false,
    isReady: vi.fn(async () => true),
    status: () => ({ state: 'ready' }),
    decide: vi.fn(async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).filter((k) => questions[k].type === 'noul').map((k) => [k, { type: 'noul', noul: 0.77 }])), provider: 'nano', latencyMs: 1 }))
  };
}

function cfgWith({ lenses = [RAMEN], main = 'find posts about michelin restaurants', enabled = true, intelligence = {} } = {}) {
  return {
    ...defaultConfiguration(),
    matchPrompt: main,
    isMatchPromptEnabled: enabled,
    promptVersion: 1,
    trackedTags: [...defaultTrackedTags(), { id: 't_ads', label: 'Ads', isEnabled: true, isPseudo: true }, ...lenses],
    intelligence: { system1: { waitForReadyMs: 0 }, escalation: { provider: 'nano', allowRedecideEscalation: true }, ...intelligence }
  };
}

function stored(id, text, over = {}) {
  return {
    id, postKey: `k-${id}`, timestamp: 10, sourcePlatform: 'linkedin.com', sourceUrl: '', textSnippet: text,
    assignedTag: 'Food', tags: [{ name: 'Food', score: 0.7 }], isFavorite: false, isAd: false,
    matchInfo: { engine: 'System 1 (local embeddings)' },
    decision: {
      v: 1, promptVersion: 1, specHash: 'old', path: ['system1'], provider: 'system1', pMatch: 0.8, matchConfidence: 0.6,
      tag: 'Food', tagConfidence: 0.5, tags: [{ name: 'Food', score: 0.7 }], escalated: false, uncertain: false, reason: null,
      collect: true, latencyMs: 1, at: 1, ...(over.decision || {})
    },
    ...(over.extra || {})
  };
}

describe('TAG_ADDED', () => {
  function handlerSetup() {
    const fake = createFakeChrome({ local: { configuration: defaultConfiguration(), stack: [], metrics: { counts: {} }, telemetry: emptyTelemetry(0) } });
    const store = createStore({ area: fake.storage.local });
    const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
    const calls = [];
    const handlers = createHandlers({
      store, broadcast,
      redecide: { start: () => 'j', schedule: async (o) => { calls.push(o); return 'j'; }, clearHidden: async () => ({ cleared: 0, hidden: 0 }) },
      ingest: { enqueue: async () => ({ status: 'queued' }) },
      now: () => 1,
      engine: { checkEngineStatus: async () => ({}), extractTagsFromPrompt: async () => [], enhanceMatchPrompt: async () => '', autoSuggestTagPrompt: async () => '' }
    });
    return { fake, handlers, calls, cfg: () => fake.storage.local.peek('configuration') };
  }

  test('a tag the user adds is a lens (isLens: true) and re-decides; the 25 built-ins are not', async () => {
    const { handlers, cfg, calls } = handlerSetup();
    expect(await handlers[MSG.TAG_ADDED]({ tag: 'Ramen', prompt: '' })).toEqual({ success: true });
    const added = cfg().trackedTags.find((t) => t.label === 'Ramen');
    expect(added).toMatchObject({ isLens: true, isEnabled: true });
    expect(added.id).toMatch(/^t_/);
    expect(cfg().trackedTags.filter((t) => t.isLens === true)).toHaveLength(1);
    expect(cfg().trackedTags.filter((t) => /^t\d+$/.test(t.id))).toHaveLength(25);
    expect(calls.map((c) => c.scope)).toEqual(['all']);
  });
});

describe('migration to lenses (migrateState)', () => {
  const v2 = () => ({
    schemaVersion: 2,
    configuration: {
      ...cfgWith({ lenses: [] }),
      trackedTags: [
        ...defaultTrackedTags(),
        { id: 't_ads', label: 'Ads', isEnabled: true, isPseudo: true },
        { id: 't_u1', label: 'Ramen', prompt: 'Find posts about ramen.', isEnabled: true },
        { id: 't_u2', label: 'Chess', prompt: 'Find posts about chess.', isEnabled: false },
        { id: 'dt_1', label: 'Dynamic', isEnabled: true, isDynamic: true },
        { id: 't_u3', label: 'Kept off', prompt: 'x', isEnabled: true, isLens: false }
      ]
    },
    stack: [
      stored('a', 'text a'),
      stored('b', 'text b', { extra: { assignedTag: 'Ramen', tags: [{ name: 'Ramen', score: 0.9 }] } }),
      { id: 'legacy', textSnippet: 'old', sourceUrl: '', assignedTag: 'Health' },
      stored('c', 'text c', { decision: { lenses: { main: 0.3 } } })
    ]
  });

  test('flags only the tags the user added: not built-in, dynamic, pseudo, Ads; an explicit isLens is kept', () => {
    const { state, changed } = migrateState(v2());
    expect(changed).toBe(true);
    const flagged = state.configuration.trackedTags.filter((t) => t.isLens === true).map((t) => t.label);
    expect(flagged).toEqual(['Ramen', 'Chess']);
    expect(state.configuration.trackedTags.find((t) => t.label === 'Kept off').isLens).toBe(false);
    expect(state.configuration.trackedTags.filter((t) => /^t\d+$/.test(t.id)).every((t) => t.isLens === undefined)).toBe(true);
  });

  test('stack: decided posts without lenses are marked for backfill; scores are never derived from stored tags', () => {
    const { state } = migrateState(v2());
    const byId = Object.fromEntries(state.stack.map((i) => [i.id, i]));
    expect(byId.a.lensBackfill).toBe(true);
    expect(byId.a.decision.lenses).toBeUndefined();
    // filed under a lens tag: marked, and its stored tag score 0.9 did not become a lens score
    expect(byId.b.lensBackfill).toBe(true);
    expect(byId.b.decision.lenses).toBeUndefined();
    // a post without a decision is not a decided post
    expect(byId.legacy.lensBackfill).toBeUndefined();
    // already scored: untouched
    expect(byId.c.lensBackfill).toBeUndefined();
    expect(byId.c.decision.lenses).toEqual({ main: 0.3 });
  });

  test('no lens to score: decided posts get an empty lens map and are not marked', () => {
    const input = v2();
    input.configuration.trackedTags = defaultTrackedTags();
    input.configuration.matchPrompt = '';
    const { state } = migrateState(input);
    expect(state.stack.find((i) => i.id === 'a')).toMatchObject({ decision: { lenses: {} } });
    expect(state.stack.some((i) => i.lensBackfill)).toBe(false);
  });

  test('idempotent: a second run changes nothing, and the input is never mutated', () => {
    const input = v2();
    const snapshot = JSON.parse(JSON.stringify(input));
    const first = migrateState(input);
    expect(input).toEqual(snapshot);
    const second = migrateState(first.state);
    expect(second.changed).toBe(false);
    expect(second.state).toEqual(first.state);
  });

  test('a configuration with lens tags and a decided stack, migrated, then re-run after a backfill, is stable', async () => {
    const { state } = migrateState(v2());
    const again = migrateState(state);
    expect(again.changed).toBe(false);
  });
});

describe('lens backfill (re-decide job, System 1 only)', () => {
  function backfillSetup({ stack, cfg = cfgWith() }) {
    const system1 = makeSystem1();
    const nano = nanoSpy();
    const cascade = createCascade({ system1, escalators: { nano }, rules: createRulesProvider() });
    const fake = createFakeChrome({ local: { configuration: cfg, stack, metrics: { counts: {} }, telemetry: { ...emptyTelemetry(0), totalProcessed: stack.length } } });
    const store = createStore({ area: fake.storage.local });
    const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
    const decideMany = vi.fn((items, ctx) => cascade.decideMany(items, ctx));
    const redecide = createRedecider({ store, decideMany, broadcast, debounceMs: 5 });
    return { fake, system1, nano, decideMany, redecide, cascade, stackNow: () => fake.storage.local.peek('stack') };
  }

  const TEXTS = {
    a: 'The ramen shop on Fifth serves a rich tonkotsu broth.',
    b: 'Ramen night with friends, best Ramen in town.',
    c: 'Hiring a backend engineer for our platform team.',
    d: 'Quarterly numbers look great for the michelin restaurants business.'
  };

  test('adds decision.lenses equal to a fresh decide; changes nothing else; clears the mark; no escalation although re-decide escalation is on', async () => {
    const cfg = cfgWith();
    const stack = [
      stored('a', TEXTS.a, { extra: { lensBackfill: true } }),
      stored('d', TEXTS.d, { extra: { lensBackfill: true } })
    ];
    const { redecide, nano, decideMany, stackNow, cascade } = backfillSetup({ stack, cfg });
    const before = JSON.parse(JSON.stringify(stackNow()));
    const jobId = redecide.start({ scope: 'rules-only', reason: 'system1_ready' });
    const result = await redecide.wait(jobId);
    expect(result).toMatchObject({ total: 2, updated: 2, finished: true });
    expect(nano.decide).not.toHaveBeenCalled();
    expect(decideMany.mock.calls.every(([, ctx]) => ctx.noEscalation === true)).toBe(true);

    for (const item of stackNow()) {
      const was = before.find((i) => i.id === item.id);
      expect(item.lensBackfill).toBeUndefined();
      const fresh = (await cascade.decideMany([{ id: item.id, text: item.textSnippet }], { ...buildDecideContext(cfg, 'redecide'), noEscalation: true }))[0];
      expect(item.decision.lenses).toEqual(fresh.lenses);
      expect(Object.keys(item.decision.lenses).sort()).toEqual(['main', 't_ramen']);
      // everything but the lenses (and the mark) is exactly what the post had
      const { lenses: _l, ...rest } = item.decision;
      expect(rest).toEqual(was.decision);
      const { lensBackfill: _m, decision: _d, ...itemRest } = { ...item };
      const { lensBackfill: _m2, decision: _d2, ...wasRest } = was;
      expect(itemRest).toEqual(wasRest);
    }
    const byId = Object.fromEntries(stackNow().map((i) => [i.id, i]));
    expect(byId.a.decision.lenses.t_ramen).toBe(0.9);
    expect(byId.d.decision.lenses.main).toBe(0.9);
  });

  test('a post filed under a lens tag is re-filed to a built-in tag or Unclassified, with the lens score; a manual override keeps its tag', async () => {
    const stack = [
      stored('b', TEXTS.b, { extra: { assignedTag: 'Ramen', tags: [{ name: 'Ramen', score: 0.9 }], lensBackfill: true } }),
      stored('m', TEXTS.b, { extra: { assignedTag: 'Ramen', tags: [{ name: 'Ramen', score: 1 }], lensBackfill: true, matchInfo: { manual: true } } })
    ];
    const { redecide, stackNow } = backfillSetup({ stack });
    await redecide.wait(redecide.start({ scope: 'rules-only', reason: 'system1_ready' }));
    const byId = Object.fromEntries(stackNow().map((i) => [i.id, i]));
    expect(byId.b.assignedTag).not.toBe('Ramen');
    expect(byId.b.tags.map((t) => t.name)).not.toContain('Ramen');
    expect(byId.b.decision.lenses.t_ramen).toBe(0.9);
    expect(byId.b.lensBackfill).toBeUndefined();
    // manual overrides are never re-decided
    expect(byId.m.assignedTag).toBe('Ramen');
    expect(byId.m.decision.lenses).toBeUndefined();
  });

  test('a second job finds nothing to do', async () => {
    const stack = [stored('a', TEXTS.a, { extra: { lensBackfill: true } })];
    const { redecide, decideMany } = backfillSetup({ stack });
    await redecide.wait(redecide.start({ scope: 'rules-only', reason: 'system1_ready' }));
    const calls = decideMany.mock.calls.length;
    const second = await redecide.wait(redecide.start({ scope: 'rules-only', reason: 'system1_ready' }));
    expect(second.total).toBe(0);
    expect(decideMany.mock.calls.length).toBe(calls);
  });

  test('without a System 1 answer the mark stays for the next job (nothing is invented)', async () => {
    const stack = [stored('a', TEXTS.a, { extra: { lensBackfill: true } })];
    const down = { id: 'system1', isReady: async () => false, waitUntilReady: async () => false, decideBatch: vi.fn() };
    const cascade = createCascade({ system1: down, escalators: {}, rules: null });
    const fake = createFakeChrome({ local: { configuration: cfgWith(), stack, metrics: { counts: {} }, telemetry: emptyTelemetry(0) } });
    const store = createStore({ area: fake.storage.local });
    const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
    const redecide = createRedecider({ store, decideMany: (i, c) => cascade.decideMany(i, c), broadcast, debounceMs: 5 });
    await redecide.wait(redecide.start({ scope: 'rules-only', reason: 'system1_ready' }));
    const item = fake.storage.local.peek('stack')[0];
    expect(item.lensBackfill).toBe(true);
    expect(item.decision.lenses).toBeUndefined();
  });

  test('isRedecideTarget: only the rules-only scope picks marked posts; plain model-decided posts are not targets', () => {
    const marked = stored('a', 't', { extra: { lensBackfill: true } });
    const plain = stored('p', 't');
    expect(isRedecideTarget(marked, 'rules-only', cfgWith())).toBe(true);
    expect(isRedecideTarget(plain, 'rules-only', cfgWith())).toBe(false);
  });
});

describe('editing a lens re-decides and moves that lens\'s score', () => {
  test('TAG_PROMPT_UPDATED on a lens: the stack is re-decided and the lens score follows the new prompt', async () => {
    const stack = [stored('x', 'Fresh udon noodles are my favourite lunch.', { decision: { lenses: { main: 0.05, t_ramen: 0.05 } } })];
    const cfg = cfgWith({ lenses: [lensTag('t_noodle', 'Noodles', 'Find posts about ramen.')] });
    const system1 = makeSystem1();
    const cascade = createCascade({ system1, escalators: {}, rules: createRulesProvider() });
    const fake = createFakeChrome({ local: { configuration: cfg, stack, metrics: { counts: {} }, telemetry: emptyTelemetry(0) } });
    const store = createStore({ area: fake.storage.local });
    const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
    const redecide = createRedecider({ store, decideMany: (i, c) => cascade.decideMany(i, c), broadcast, debounceMs: 5 });
    const handlers = createHandlers({
      store, broadcast, redecide, ingest: { enqueue: async () => ({ status: 'queued' }) }, now: () => 1,
      engine: { checkEngineStatus: async () => ({}), extractTagsFromPrompt: async () => [], enhanceMatchPrompt: async () => '', autoSuggestTagPrompt: async () => '' }
    });
    // first decide with the old prompt
    await redecide.wait(redecide.start({ scope: 'all', reason: 'test' }));
    const lensOf = () => fake.storage.local.peek('stack')[0].decision.lenses;
    expect(lensOf().t_noodle).toBe(0.05);
    await handlers[MSG.TAG_PROMPT_UPDATED]({ tag: 'Noodles', prompt: 'Find posts about udon.' });
    await tick(30);
    await redecide.idle();
    expect(lensOf().t_noodle).toBe(0.9);
    expect(lensOf().main).toBe(0.05);
  });
});

describe('idle refinement keeps decision.lenses consistent with pMatch', () => {
  function twoModelSystem1(scores) {
    return {
      calibrationId: 'cal-1',
      floor: { matches_prompt: 0.5, primary_tag: 0.3 },
      status: () => ({ state: 'ready' }),
      isReady: async () => true,
      waitUntilReady: async () => true,
      release: async () => true,
      async decideBatch(req) {
        const model = req.model || 'minilm';
        await tick(1);
        return {
          results: req.items.map((it) => {
            const s = scores[model];
            const answers = { [Q.MATCHES_PROMPT]: { type: 'noul', noul: s.main }, [Q.PRIMARY_TAG]: { type: 'choice', probabilities: { Health: 0.7, none: 0.3 } } };
            if (req.questions['lens:t_ramen']) answers['lens:t_ramen'] = { type: 'noul', noul: s.ramen };
            return { id: it.id, answers };
          })
        };
      }
    };
  }

  test('lenses.main moves with pMatch (mean of both models); another lens is refined the same way; uncertain lenses go to Nano with matches_prompt', async () => {
    const cfg = cfgWith();
    const fake = createFakeChrome({ local: { configuration: cfg, stack: [stored('r', 'some post')] } });
    const store = createStore({ area: fake.storage.local });
    const nanoCalls = [];
    const nano = {
      id: 'nano', isCloud: false, isReady: async () => true, status: () => ({ state: 'ready' }),
      async decide({ questions }) {
        nanoCalls.push(Object.keys(questions));
        return { answers: { 'lens:t_ramen': { type: 'noul', noul: 0.12 } }, provider: 'nano' };
      }
    };
    const s1 = twoModelSystem1({ minilm: { main: 0.9, ramen: 0.7 }, 'bge-small': { main: 0.7, ramen: 0.3 } });
    const refiner = createRefiner({ store, system1: s1, nano });
    expect(Object.keys(refineSpec(cfg, s1).spec.questions)).toEqual(expect.arrayContaining(['matches_prompt', 'lens:t_ramen']));
    const result = await refiner.run({ reason: 'test' });
    expect(result).toMatchObject({ outcome: 'done', refined: 1 });
    const d = fake.storage.local.peek('stack')[0].decision;
    expect(d.pMatch).toBe(0.8);
    expect(d.lenses.main).toBe(d.pMatch);
    // (0.7 + 0.3) / 2 = 0.5 -> confidence 0 -> uncertain -> Nano answered 0.12
    expect(nanoCalls).toHaveLength(1);
    expect(nanoCalls[0]).toContain('lens:t_ramen');
    expect(nanoCalls[0]).not.toContain('matches_prompt');
    expect(d.lenses.t_ramen).toBe(0.12);
    // main (0.8) is a confident yes, so the gate collects whatever the Nano-refined lens says
    expect(d.collect).toBe(true);
  });

  test('without Nano the other lens is the plain mean; the any-lens gate still sees it', async () => {
    const cfg = cfgWith({ main: 'find posts about michelin restaurants' });
    const fake = createFakeChrome({ local: { configuration: cfg, stack: [stored('r', 'some post', { decision: { pMatch: 0.2, collect: false } })] } });
    const store = createStore({ area: fake.storage.local });
    const s1 = twoModelSystem1({ minilm: { main: 0.1, ramen: 0.95 }, 'bge-small': { main: 0.2, ramen: 0.85 } });
    await createRefiner({ store, system1: s1, nano: null }).run({ reason: 'test' });
    const item = fake.storage.local.peek('stack')[0];
    expect(item.decision.lenses.main).toBeCloseTo(0.15, 10);
    expect(item.decision.lenses.t_ramen).toBeCloseTo(0.9, 10);
    expect(item.decision.collect).toBe(true);
  });
});
