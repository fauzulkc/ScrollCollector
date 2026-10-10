// @vitest-environment happy-dom
/**
 * ui/toast.js: live region, levels/roles, de-duplication by key, auto-dismiss, close button,
 * text-only rendering.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createToaster } from '../../ui/toast.js';

let root;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toaster', () => {
  test('creates one polite live region and reuses it', () => {
    const a = createToaster({ root });
    const b = createToaster({ root });
    expect(root.querySelectorAll('.toast-region')).toHaveLength(1);
    expect(a.region).toBe(b.region);
    expect(a.region.getAttribute('aria-live')).toBe('polite');
  });

  test('levels map to classes and roles; errors are alerts', () => {
    const t = createToaster({ root });
    const info = t.show({ text: 'Saved' });
    const err = t.show({ level: 'error', text: 'Failed' });
    const weird = t.show({ level: 'nope', text: 'x' });
    expect(info.className).toBe('toast toast-info');
    expect(info.getAttribute('role')).toBe('status');
    expect(err.className).toBe('toast toast-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(weird.className).toBe('toast toast-info');
  });

  test('renders text with textContent (no HTML)', () => {
    const t = createToaster({ root });
    const el = t.show({ text: '<img src=x onerror=alert(1)>' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.toast-text').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  test('a string argument is the text; empty text shows nothing', () => {
    const t = createToaster({ root });
    expect(t.show('Hello').querySelector('.toast-text').textContent).toBe('Hello');
    expect(t.show({ text: '   ' })).toBeNull();
    expect(t.region.children).toHaveLength(1);
  });

  test('same key replaces the visible toast instead of stacking', () => {
    const t = createToaster({ root });
    const first = t.show({ level: 'warn', text: 'Rate limited', key: 'jev' });
    const second = t.show({ level: 'error', text: 'Key rejected', key: 'jev' });
    expect(second).toBe(first);
    expect(t.region.children).toHaveLength(1);
    expect(second.className).toBe('toast toast-error');
    expect(second.querySelector('.toast-text').textContent).toBe('Key rejected');
  });

  test('auto-dismisses (errors stay longer); timeoutMs 0 keeps it', () => {
    const t = createToaster({ root, defaultMs: 1000, errorMs: 5000 });
    t.show({ text: 'info' });
    t.show({ level: 'error', text: 'err' });
    t.show({ text: 'sticky', timeoutMs: 0 });
    expect(t.region.children).toHaveLength(3);
    vi.advanceTimersByTime(1001);
    expect([...t.region.children].map((c) => c.textContent.replace('×', ''))).toEqual(['err', 'sticky']);
    vi.advanceTimersByTime(5000);
    expect([...t.region.children].map((c) => c.textContent.replace('×', ''))).toEqual(['sticky']);
  });

  test('re-showing a keyed toast restarts its timer', () => {
    const t = createToaster({ root, defaultMs: 1000 });
    t.show({ text: 'a', key: 'k' });
    vi.advanceTimersByTime(800);
    t.show({ text: 'b', key: 'k' });
    vi.advanceTimersByTime(800);
    expect(t.region.children).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(t.region.children).toHaveLength(0);
  });

  test('close button and dismiss(key) remove the toast', () => {
    const t = createToaster({ root });
    const el = t.show({ text: 'x', key: 'one' });
    t.show({ text: 'y', key: 'two' });
    const close = el.querySelector('.toast-close');
    expect(close.getAttribute('aria-label')).toBe('Dismiss notification');
    close.click();
    expect(t.region.children).toHaveLength(1);
    t.dismiss('two');
    expect(t.region.children).toHaveLength(0);
  });

  test('keeps at most `max` toasts (oldest dropped)', () => {
    const t = createToaster({ root, max: 2 });
    t.show('1');
    t.show('2');
    t.show('3');
    expect([...t.region.children].map((c) => c.querySelector('.toast-text').textContent)).toEqual(['2', '3']);
    t.clear();
    expect(t.region.children).toHaveLength(0);
  });
});
