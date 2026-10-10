// @vitest-environment happy-dom
/**
 * ui/engine-badge.js: badge levels from EngineStatus (and the legacy reply), never a false green,
 * polling only while checking/loading.
 */
import { describe, test, expect, vi } from 'vitest';
import { badgeView, shouldPollEngine, renderBadge, engineDisplayName, createEnginePoller, BADGE_LEVELS } from '../../ui/engine-badge.js';
import { createEngineStatus } from '../../lib/decision/engine-status.js';

describe('badgeView', () => {
  test('no status yet → grey checking (never green)', () => {
    for (const s of [null, undefined, {}, 'x', { success: false, error: 'Unknown message type' }]) {
      expect(badgeView(s).level).toBe('checking');
    }
    expect(badgeView(null).label).toBe('Checking…');
  });

  test('uses EngineStatus.badge level, label and title', () => {
    for (const level of BADGE_LEVELS) {
      const v = badgeView({ badge: { level, label: `L-${level}`, title: `T-${level}` } });
      expect(v).toEqual({ level, label: `L-${level}`, title: `T-${level}` });
    }
  });

  test('unknown badge level falls back to checking; blank label gets a default', () => {
    expect(badgeView({ badge: { level: 'green', label: 'Ready' } }).level).toBe('checking');
    expect(badgeView({ badge: { level: 'ok', label: '  ' } }).label).toBe('Ready');
    expect(badgeView({ badge: { level: 'error' } }).title).toBe('Error');
  });

  test('loading shows the System 1 progress when the label has no %', () => {
    expect(badgeView({ badge: { level: 'loading', label: 'Loading…' }, system1: { progress: 0.42 } }).label).toBe('Loading 42%');
    expect(badgeView({ badge: { level: 'loading', label: 'Loading 10%' }, system1: { progress: 0.9 } }).label).toBe('Loading 10%');
    expect(badgeView({ badge: { level: 'loading', label: 'Loading' } }).label).toBe('Loading');
  });

  test('matches the real engine-status holder', () => {
    const es = createEngineStatus();
    expect(badgeView(es.snapshot()).level).toBe('checking');
    expect(badgeView(es.update({ system1: { state: 'loading', progress: 0.5 } })).label).toBe('Loading 50%');
    expect(badgeView(es.update({ system1: { state: 'ready', model: 'minilm' } })).level).toBe('ok');
    expect(badgeView(es.update({ system1: { state: 'error', lastError: 'boom' } })).level).toBe('error');
  });

  test('legacy { tier, name, status } replies', () => {
    expect(badgeView({ tier: 3, name: 'Rule-based Classifier', status: 'ready' })).toMatchObject({ level: 'warn', label: 'Rules only' });
    expect(badgeView({ tier: 1, name: 'Gemini Nano', status: 'ready' })).toMatchObject({ level: 'ok', label: 'Gemini Nano' });
    expect(badgeView({ tier: 1, name: 'Gemini Nano', status: 'downloading' }).level).toBe('loading');
    expect(badgeView({ tier: 1, status: 'unavailable' }).level).toBe('warn');
    expect(badgeView({ tier: 1, status: 'weird' }).level).toBe('checking');
  });
});

describe('polling', () => {
  test('shouldPollEngine only for checking/loading', () => {
    expect(shouldPollEngine({ level: 'checking' })).toBe(true);
    expect(shouldPollEngine({ level: 'loading' })).toBe(true);
    for (const level of ['ok', 'warn', 'error']) expect(shouldPollEngine({ level })).toBe(false);
  });

  test('createEnginePoller starts and stops with the level', () => {
    vi.useFakeTimers();
    try {
      const poll = vi.fn();
      const poller = createEnginePoller({ poll, intervalMs: 5000 });
      poller.sync({ level: 'checking' });
      poller.sync({ level: 'loading' }); // no second timer
      expect(poller.active).toBe(true);
      vi.advanceTimersByTime(10000);
      expect(poll).toHaveBeenCalledTimes(2);
      poller.sync({ level: 'ok' });
      expect(poller.active).toBe(false);
      vi.advanceTimersByTime(20000);
      expect(poll).toHaveBeenCalledTimes(2);
      poller.sync({ level: 'loading' });
      vi.advanceTimersByTime(5000);
      expect(poll).toHaveBeenCalledTimes(3);
      poller.stop();
      expect(poller.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renderBadge', () => {
  test('sets the dot class, label, title and data-level', () => {
    document.body.innerHTML = '<button id="b"><span id="d" class="engine-dot active"></span><span id="l"></span></button>';
    const els = { root: document.getElementById('b'), dot: document.getElementById('d'), label: document.getElementById('l') };
    renderBadge(els, badgeView(null));
    expect(els.dot.className).toBe('engine-dot level-checking');
    expect(els.root.dataset.level).toBe('checking');
    renderBadge(els, { level: 'error', label: 'Model error', title: 'The local model failed' });
    expect(els.dot.className).toBe('engine-dot level-error');
    expect(els.label.textContent).toBe('Model error');
    expect(els.root.title).toBe('The local model failed');
    expect(els.root.getAttribute('aria-label')).toContain('Model error');
  });
});

describe('engineDisplayName', () => {
  test('legacy name, System 1 model, or the badge label', () => {
    expect(engineDisplayName(null)).toBe('—');
    expect(engineDisplayName({ tier: 3, name: 'Rule-based Classifier', status: 'ready' })).toBe('Rule-based Classifier');
    expect(engineDisplayName({ badge: { level: 'ok', label: 'Ready' }, system1: { state: 'ready', model: 'minilm' } })).toBe('System 1 (minilm)');
    expect(engineDisplayName({ badge: { level: 'warn', label: 'Rules only' }, system1: { state: 'error' } })).toBe('Rules only');
  });
});
