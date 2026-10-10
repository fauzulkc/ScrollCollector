/**
 * ui/decision-info.js: card tooltip / decision line from item.decision, falling back to the
 * legacy matchInfo of items collected before the decision cascade.
 */
import { describe, test, expect } from 'vitest';
import { decisionFacts, decisionTooltip, decisionLine, decidedBy, providerLabel, reasonText } from '../../ui/decision-info.js';

const decision = {
  v: 1, promptVersion: 2, specHash: 'h', path: ['system1', 'nano'], provider: 'nano',
  pMatch: 0.81, matchConfidence: 0.62, tag: 'Food', tagConfidence: 0.47, tags: [],
  escalated: true, uncertain: false, reason: null, collect: true, latencyMs: 145, at: 1
};

describe('decision facts', () => {
  test('cascade decision', () => {
    const f = decisionFacts({ decision });
    expect(f).toMatchObject({ kind: 'decision', provider: 'nano', providerLabel: 'Gemini Nano', pathLabel: 'System 1 → Gemini Nano', pMatch: 0.81, escalated: true, latencyMs: 145 });
  });

  test('legacy and manual items', () => {
    expect(decisionFacts({ matchInfo: { engine: 'Rule-based Classifier' } })).toMatchObject({ kind: 'legacy', engine: 'Rule-based Classifier' });
    expect(decisionFacts({ decision, matchInfo: { engine: 'Manual Override', manual: true } }).kind).toBe('manual');
    expect(decisionFacts({}).kind).toBe('none');
    expect(decisionFacts(null).kind).toBe('none');
  });

  test('labels and reasons', () => {
    expect(providerLabel('jev')).toBe('TypeSafe Jev');
    expect(providerLabel('mystery')).toBe('mystery');
    expect(reasonText('budget_exceeded')).toBe('escalation budget used up');
    expect(reasonText('some_new_code')).toBe('some new code');
    expect(reasonText(null)).toBe('');
  });
});

describe('tooltip', () => {
  test('shows path, provider, p(match), confidences, latency, escalation', () => {
    const text = decisionTooltip({ decision });
    expect(text.split('\n')).toEqual([
      'Decided by: Gemini Nano (escalated)',
      'Path: System 1 → Gemini Nano',
      'P(match): 0.81 · confidence 62%',
      'Tag confidence: 47%',
      'Latency: 145 ms',
      'Escalated: yes'
    ]);
  });

  test('gate off, reason, uncertain, hidden', () => {
    const text = decisionTooltip({
      hiddenByPrompt: true,
      decision: { ...decision, path: ['system1'], provider: 'system1', pMatch: null, matchConfidence: null, escalated: false, uncertain: true, reason: 'cloud_not_allowed' }
    });
    expect(text).toContain('Prompt filter: off');
    expect(text).toContain('Escalated: no');
    expect(text).toContain('Note: cloud provider not allowed');
    expect(text).toContain('Still uncertain after all checks.');
    expect(text).toContain('Hidden: no longer matches the prompt.');
  });

  test('legacy matchInfo fallback', () => {
    const text = decisionTooltip({ matchInfo: { engine: 'Gemini Nano', globalMatchPrompt: 'ramen', globalMatchedKeywords: ['ramen'], matchedKeywords: ['food'] } });
    expect(text).toContain('Classified using: Gemini Nano');
    expect(text).toContain('Prompt: "ramen"');
    expect(text).toContain("Matched keyword(s): 'ramen'");
    expect(text).toContain("Tag keyword(s): 'food'");
    expect(decisionTooltip({ decision, matchInfo: { manual: true } })).toBe('Tag set manually.');
    expect(decisionTooltip({})).toBe('');
  });
});

describe('decision line / decided by', () => {
  test('one line for exports', () => {
    expect(decisionLine({ decision })).toBe('Decided by System 1 → Gemini Nano (escalated) · p(match) 0.81 · confidence 62% · 145 ms');
    expect(decisionLine({ decision: { ...decision, path: ['rules'], provider: 'rules', pMatch: null, escalated: false, latencyMs: 0, reason: 's1_unavailable' } }))
      .toBe('Decided by Rules · confidence 47% · System 1 unavailable');
    expect(decisionLine({ matchInfo: { engine: 'Rule-based Classifier' } })).toBe('Classified by Rule-based Classifier');
    expect(decisionLine({ matchInfo: { manual: true } })).toBe('Tag set manually');
  });

  test('decidedBy', () => {
    expect(decidedBy({ decision })).toBe('Gemini Nano');
    expect(decidedBy({ matchInfo: { engine: 'Rule-based Classifier' } })).toBe('Rule-based Classifier');
    expect(decidedBy({ decision, matchInfo: { manual: true } })).toBe('Manual');
  });
});
