/**
 * Drafted by Engineering for 🧪 Testing review (Testing away; minimal guard asked for by 🧭 CEO, DEC-6 cdd1490).
 *
 * The v2 -> v3 migration must not change anyone's collected set. Before lenses (0.10.0) only the master
 * prompt gated collection, and a user's tags never collected. So after migrating a v2 configuration, the
 * posts the cascade collects must be exactly the ones the master prompt alone collected: master on, off,
 * or on with an empty prompt. Bar Raiser finding F3 (docs/briefs/2026-10-11-prompt-lenses-review.md):
 * the old rule (collects = master state) widened the feed of every master-on user with tags.
 */
import { describe, test, expect, vi } from 'vitest';
import { createCascade, buildDecideContext, STRICTNESS_THRESHOLDS } from '../../lib/decision/cascade.js';
import { createRulesProvider } from '../../lib/decision/providers/rules.js';
import { noulAnswer } from '../../lib/decision/types.js';
import { choiceConfidence } from '../../lib/decision/confidence.js';
import { deepMerge, DEFAULT_INTELLIGENCE } from '../../lib/storage/schema.js';
import { migrateState } from '../../lib/storage/migrations.js';

const MAIN_PROMPT = 'find me posts about michelin star restaurants';

/** System 1 stand-in: `[main=p]` scores matches_prompt, `[lens:<id>=p]` a lens; default 0.05. */
function makeSystem1() {
  const score = (text, qid) => {
    const key = qid === 'matches_prompt' ? 'main' : qid;
    const m = new RegExp(`\\[${key.replace(/[:]/g, '\\:')}=([0-9.]+)\\]`).exec(text);
    return m ? Number(m[1]) : 0.05;
  };
  return {
    id: 'system1',
    calibrationId: 'cal-test',
    isReady: vi.fn(async () => true),
    waitUntilReady: vi.fn(async () => true),
    decideBatch: vi.fn(async ({ items, questions }) => ({
      results: items.map((it) => {
        const answers = {};
        for (const [qid, q] of Object.entries(questions)) {
          if (q.type === 'noul') answers[qid] = noulAnswer(score(it.text, qid), 'system1');
          else if (q.type === 'choice') {
            const opts = Object.keys(q.criteria);
            const probabilities = Object.fromEntries(opts.map((o, i) => [o, i === 0 ? 0.8 : 0.2 / (opts.length - 1)]));
            answers[qid] = { type: 'choice', choice: opts[0], probabilities, confidence: choiceConfidence(probabilities), source: 'system1' };
          }
        }
        return { id: it.id, answers, ms: 1 };
      })
    }))
  };
}

/** A v2 configuration (pre-lens): two tags the user wrote, no isLens, no collects. */
function v2Config({ master, prompt = MAIN_PROMPT }) {
  return {
    matchPrompt: prompt,
    isMatchPromptEnabled: master,
    promptVersion: 1,
    trackedTags: [
      // a real built-in label (DEFAULT_TAG_LABELS): never a lens
      { id: 't1', label: 'Health', isEnabled: true, prompt: 'Identify posts related to health and medicine.' },
      { id: 't_ads', label: 'Ads', isEnabled: true, isPseudo: true },
      { id: 't_ramen', label: 'Ramen', isEnabled: true, prompt: 'Find posts about ramen shops and noodle broth.' },
      { id: 't_chess', label: 'Chess', isEnabled: true, prompt: 'Find posts about chess openings and tournaments.' }
    ],
    intelligence: deepMerge(DEFAULT_INTELLIGENCE, { system1: { waitForReadyMs: 0 }, escalation: { provider: 'none' } })
  };
}

/** Posts: one per case, scores in the text. */
const POSTS = {
  mainOnly: 'Tasting menu. [main=0.9] [lens:t_ramen=0.05] [lens:t_chess=0.05]',
  ramenOnly: 'Tonkotsu broth. [main=0.05] [lens:t_ramen=0.9] [lens:t_chess=0.05]',
  chessOnly: 'Sicilian defence. [main=0.05] [lens:t_ramen=0.05] [lens:t_chess=0.9]',
  none: 'Weather today. [main=0.05] [lens:t_ramen=0.05] [lens:t_chess=0.05]'
};

/** What 0.10.0 collected: only the master prompt gated (on, with a non-empty prompt), at the shared threshold. */
function preLensCollected(cfg) {
  const gate = cfg.isMatchPromptEnabled && cfg.matchPrompt.trim();
  const threshold = STRICTNESS_THRESHOLDS.balanced;
  return Object.keys(POSTS).filter((k) => {
    if (!gate) return true;
    const p = Number(/\[main=([0-9.]+)\]/.exec(POSTS[k])[1]);
    return p >= threshold;
  }).sort();
}

async function postMigrationCollected(v2) {
  const { state } = migrateState({ schemaVersion: 2, configuration: structuredClone(v2), stack: [] });
  const cfg = state.configuration;
  const cascade = createCascade({ system1: makeSystem1(), escalators: {}, rules: createRulesProvider() });
  const items = Object.entries(POSTS).map(([id, text]) => ({ id, text, platform: 'linkedin.com' }));
  const decisions = await cascade.decideMany(items, buildDecideContext(cfg));
  return { cfg, collected: items.filter((_, i) => decisions[i].collect).map((it) => it.id).sort() };
}

describe('v2 -> v3 migration keeps every collected set (DEC-6 cdd1490, Bar Raiser F3)', () => {
  test.each([
    ['master on, prompt set', { master: true }],
    ['master off, prompt set', { master: false }],
    ['master on, empty prompt', { master: true, prompt: '' }]
  ])('%s: the post-migration collected set equals the pre-migration one', async (_name, opts) => {
    const v2 = v2Config(opts);
    const { cfg, collected } = await postMigrationCollected(v2);
    expect(collected).toEqual(preLensCollected(v2));
    // the user's tags became labels-only prompts; the built-ins were not touched
    const flagged = cfg.trackedTags.filter((t) => t.isLens === true).map((t) => [t.id, t.collects]);
    expect(flagged).toEqual([['t_ramen', false], ['t_chess', false]]);
  });

  test('a manual override is never marked for the lens backfill (Bar Raiser F4: the mark would never clear)', () => {
    const decided = (id, provider) => ({ id, textSnippet: id, sourceUrl: '', decision: { v: 1, provider, path: [provider] } });
    const { state } = migrateState({
      schemaVersion: 2,
      configuration: v2Config({ master: true }),
      stack: [decided('auto', 'system1'), { ...decided('man', 'manual'), assignedTag: 'Health' }, { ...decided('man2', 'system1'), matchInfo: { manual: true } }]
    });
    const byId = Object.fromEntries(state.stack.map((i) => [i.id, i]));
    expect(byId.auto.lensBackfill).toBe(true);
    expect(byId.man.lensBackfill).toBeUndefined();
    expect(byId.man2.lensBackfill).toBeUndefined();
  });

  test('a tag-only match is labelled, not collected, after the upgrade with the master on', async () => {
    const { collected } = await postMigrationCollected(v2Config({ master: true }));
    expect(collected).not.toContain('ramenOnly');
    expect(collected).not.toContain('chessOnly');
  });
});
