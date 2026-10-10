// Local System 1 end to end: the real offscreen document (offscreen/system1-host.js with the bundled
// q8 MiniLM weights) driven through lib/offscreen-client.js and the service-worker provider
// (lib/decision/providers/local-system1.js), from an extension page. The same posts are scored in
// Node with the eval's embedder (onnxruntime-web wasm, as in the browser) and the shared scorer
// (lib/decision/system1-scorer.js): the browser must decide them the same way.
//
// eval/lib/embed-node.mjs is imported first: it chooses the ONNX runtime Transformers.js uses.
import { createEmbedder } from '../eval/lib/embed-node.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchWithExtension, collectConsole, ROOT } from './helpers/launch.mjs';
import { seed } from './helpers/ext.mjs';
import { createSystem1Scorer } from '../lib/decision/system1-scorer.js';
import { normalizeForDecision } from '../lib/decision/state.js';
import { cleanPrompt, selectQuestionTags } from '../lib/decision/questions.js';
import { Q } from '../lib/decision/types.js';

const MODEL = 'minilm';
const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const POSTS = [
  { food: true, text: 'Chef Ingrid Solberg and her team have been awarded a third Michelin star for their tasting menu.' },
  { food: true, text: 'We just opened our new restaurant downtown: a seven-course tasting menu built around local seafood and seasonal vegetables.' },
  { food: true, text: 'Dinner last night at a two Michelin star restaurant in Lyon was unforgettable. The lobster bisque and the souffle were perfect.' },
  { food: true, text: 'Our head chef spent ten years in fine dining kitchens before opening this bistro, and the duck confit is worth the trip.' },
  { food: false, text: 'We are hiring a remote backend engineer to build payment services in Go and Postgres.' },
  { food: false, text: 'Hurricane warning issued for the Gulf Coast as the storm strengthens to Category 4.' },
  { food: false, text: 'Our open-source code review bot just passed 10,000 stars on GitHub.' },
  { food: false, text: 'Thrilled to share that our team just wrapped up a two-day planning offsite.' },
  { food: false, text: 'Great Trips Begin with Good Planning and the Proper Kit Changes Everything.' },
  { food: false, text: 'Is it ever too late to pick up a second language? Most adults think so, and they are wrong.' }
];
// The 25 default tags as the cascade sends them (trackedTags -> selectQuestionTags).
const TAGS = selectQuestionTags(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/golden/tags.json'), 'utf8')).tags.map((t) => ({ label: t.label, prompt: t.description }))
);
const ITEMS = POSTS.map((p, i) => ({ id: String(i), text: normalizeForDecision(p.text) }));
const PROMPT_PARTS = { raw: PROMPT, cleaned: cleanPrompt(PROMPT), expansion: '' };

/** Node answers through the eval embedder (same q8 weights and wasm runtime) and the shared scorer. */
async function nodeAnswers() {
  const em = await createEmbedder(MODEL, { cache: false });
  try {
    const calibration = JSON.parse(fs.readFileSync(path.join(ROOT, `lib/decision/calibration/${MODEL}.q8.json`), 'utf8'));
    const scorer = createSystem1Scorer({ embed: (texts) => em.embed(texts), calibration, modelSpec: em.spec });
    return await scorer.decideItems(ITEMS, { prompt: PROMPT_PARTS, tags: TAGS, questions: [Q.MATCHES_PROMPT, Q.PRIMARY_TAG] });
  } finally {
    await em.dispose();
  }
}

test('System 1 loads in the offscreen document and decides posts like the Node eval', async () => {
  test.setTimeout(420000);
  const expected = await nodeAnswers();
  const ext = await launchWithExtension();
  try {
    // This test drives the offscreen host with its own provider and client. The service worker's
    // System 1 stays off: an open panel would otherwise make the worker create the same (single)
    // offscreen document and load the model at the same moment.
    await seed(ext.serviceWorker, { intelligence: { system1: { enabled: false } } });
    const page = await ext.context.newPage();
    const logs = collectConsole(page);
    await page.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);

    const out = await page.evaluate(
      async ({ model, items, prompt, tags }) => {
        const { createOffscreenClient } = await import('/lib/offscreen-client.js');
        const { createLocalSystem1 } = await import('/lib/decision/providers/local-system1.js');
        const client = createOffscreenClient();
        const statuses = [];
        const provider = createLocalSystem1({
          client,
          getConfig: () => ({ intelligence: { system1: { model } } }),
          onStatus: (s) => statuses.push({ state: s.state, progress: s.progress, detail: s.detail })
        });
        // In the extension the background routes S1_STATUS pushes to the provider.
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg && msg.type === 'S1_STATUS') provider.handleStatusPush(msg);
        });
        const req = (list, specHash) => ({
          items: list,
          questions: { matches_prompt: {}, primary_tag: {} },
          specHash,
          context: { prompt, tags }
        });

        const t0 = performance.now();
        const loading = provider.waitUntilReady(240000);
        // OFFSCREEN_PING must answer while the model loads.
        const pingStart = performance.now();
        const ping = await client.sendToOffscreen('OFFSCREEN_PING', {}, { timeoutMs: 10000 });
        const pingMs = performance.now() - pingStart;
        const ready = await loading;
        const loadMs = performance.now() - t0;

        let t = performance.now();
        const cold = await provider.decideBatch(req(items, 'e2e-spec'));
        const coldMs = performance.now() - t;

        // Same spec, ten texts never embedded before: the steady-state cost of ten posts.
        const before = (await client.sendToOffscreen('OFFSCREEN_PING', {})).stats;
        t = performance.now();
        const warm = await provider.decideBatch(req(items.map((it) => ({ id: it.id, text: `Update: ${it.text}` })), 'e2e-spec'));
        const warmMs = performance.now() - t;
        const after = (await client.sendToOffscreen('OFFSCREEN_PING', {})).stats;
        const warmModel = { calls: after.modelCalls - before.modelCalls, ms: after.modelMs - before.modelMs };

        // Everything cached (IndexedDB / memory).
        t = performance.now();
        const cached = await provider.decideBatch(req(items, 'e2e-spec'));
        const cachedMs = performance.now() - t;

        const clear = await client.sendToOffscreen('S1_CLEAR_CACHE', {});
        const ping2 = await client.sendToOffscreen('OFFSCREEN_PING', {});
        return {
          ready,
          loadMs,
          ping,
          pingMs,
          ping2,
          cold: cold.results,
          warm: warm.results,
          cached: cached.results,
          coldMs,
          warmMs,
          warmModel,
          cachedMs,
          clear,
          status: provider.status(),
          diagnostics: provider.diagnostics(),
          statuses
        };
      },
      { model: MODEL, items: ITEMS, prompt: PROMPT_PARTS, tags: TAGS }
    );

    const summary = out.cold.map((r, i) => ({
      food: POSTS[i].food,
      p: +r.answers?.[Q.MATCHES_PROMPT]?.noul.toFixed(4),
      node: +expected[i].answers[Q.MATCHES_PROMPT].noul.toFixed(4),
      tag: r.answers?.[Q.PRIMARY_TAG]?.choice ?? null,
      nodeTag: expected[i].answers[Q.PRIMARY_TAG].choice
    }));
    console.log('[s1] load', Math.round(out.loadMs), 'ms; ping during load', Math.round(out.pingMs), 'ms; caps', JSON.stringify(out.ping.caps));
    console.log(
      '[s1] decide 10 posts: cold spec', Math.round(out.coldMs), 'ms; warm spec', Math.round(out.warmMs), 'ms',
      `(${out.warmModel.calls} model calls, ${Math.round(out.warmModel.ms)} ms in the model); cached`, Math.round(out.cachedMs), 'ms'
    );
    console.log('[s1] status', JSON.stringify(out.status), 'diagnostics', JSON.stringify(out.diagnostics));
    console.log('[s1] status pushes', JSON.stringify(out.statuses.slice(0, 12)), out.statuses.length);
    console.log('[s1] answers', JSON.stringify(summary));

    expect(out.ready).toBe(true);
    expect(out.ping.ok).toBe(true);
    expect(out.ping.caps.crossOriginIsolated).toBe(true);
    expect(out.pingMs).toBeLessThan(5000);
    expect(out.status).toMatchObject({ state: 'ready', model: MODEL, device: 'wasm' });
    expect(out.statuses.some((s) => s.state === 'loading')).toBe(true);
    expect(out.statuses.at(-1).state).toBe('ready');

    for (const [i, r] of out.cold.entries()) {
      expect(r.error, `post ${i}`).toBeUndefined();
      const p = r.answers[Q.MATCHES_PROMPT].noul;
      if (POSTS[i].food) expect(p, `food post ${i}`).toBeGreaterThanOrEqual(0.5);
      else expect(p, `unrelated post ${i}`).toBeLessThan(0.5);
      // Browser and Node agree: same weights, same onnxruntime-web wasm, same scorer and calibration.
      expect(Math.abs(p - expected[i].answers[Q.MATCHES_PROMPT].noul), `p parity post ${i}`).toBeLessThan(1e-5);
      expect(r.answers[Q.PRIMARY_TAG].choice, `tag parity post ${i}`).toBe(expected[i].answers[Q.PRIMARY_TAG].choice);
      for (const [label, prob] of Object.entries(expected[i].answers[Q.PRIMARY_TAG].probabilities)) {
        expect(Math.abs(r.answers[Q.PRIMARY_TAG].probabilities[label] - prob), `tag ${label} post ${i}`).toBeLessThan(1e-5);
      }
    }
    expect(out.warm.every((r) => r.answers)).toBe(true);
    expect(out.cached.map((r) => r.answers[Q.MATCHES_PROMPT].noul)).toEqual(out.cold.map((r) => r.answers[Q.MATCHES_PROMPT].noul));
    // One single-text model call per new post; the spec's query/label/corpus vectors are reused.
    expect(out.warmModel.calls).toBe(10);
    // Phase 4 gate: ten posts decided in under 3 s once the model and the spec are ready. The model
    // calls themselves are CPU-bound (slower on a loaded machine); everything around them (batching,
    // messaging, cache) must stay well under a second and a half.
    expect(out.warmMs - out.warmModel.ms).toBeLessThan(1500);
    expect(out.warmMs).toBeLessThan(Math.max(3000, out.warmModel.ms + 1500));
    expect(out.clear.ok).toBe(true);
    expect(out.diagnostics.calls).toBeGreaterThanOrEqual(3);

    expect(out.ping2.cspViolations).toEqual([]);
    const cspErrors = logs.filter((l) => /Content Security Policy|Refused to/i.test(l.text));
    expect(cspErrors).toEqual([]);
  } finally {
    await ext.close();
  }
});
