/**
 * Header engine badge, driven by the EngineStatus the service worker pushes (ENGINE_STATUS) and
 * returns from GET_ENGINE_STATUS (lib/decision/types.js).
 *
 * Levels: checking (grey) / loading (amber, with %) / ok (green) / warn (amber) / error (red).
 * The badge starts as 'checking' and only turns green when the service worker says so — it never
 * assumes a ready model.
 */

export const BADGE_LEVELS = Object.freeze(['checking', 'loading', 'ok', 'warn', 'error']);

const DEFAULT_LABELS = Object.freeze({
  checking: 'Checking…',
  loading: 'Loading…',
  ok: 'Ready',
  warn: 'Degraded',
  error: 'Error'
});

/** @returns {{ level: 'checking', label: string, title: string }} */
export function checkingView() {
  return { level: 'checking', label: DEFAULT_LABELS.checking, title: 'Checking the local decision model…' };
}

/**
 * Badge for a background that still answers GET_ENGINE_STATUS with the legacy
 * { tier, name, status } shape (no `badge`).
 * @param {{ tier?: number, name?: string, status?: string }} legacy
 */
function legacyView(legacy) {
  const name = typeof legacy.name === 'string' && legacy.name ? legacy.name : '';
  switch (legacy.status) {
    case 'downloading':
      return { level: 'loading', label: DEFAULT_LABELS.loading, title: `${name || 'The on-device model'} is downloading…` };
    case 'ready':
      if (legacy.tier === 1 || legacy.tier === 2) {
        return { level: 'ok', label: name || DEFAULT_LABELS.ok, title: `Deciding with ${name || 'the on-device model'}.` };
      }
      return { level: 'warn', label: 'Rules only', title: 'No on-device model is available; posts are decided by keyword rules.' };
    case 'unavailable':
      return { level: 'warn', label: 'Rules only', title: `${name || 'The on-device model'} is unavailable; posts are decided by keyword rules.` };
    default:
      return checkingView();
  }
}

/**
 * @param {any} status  EngineStatus, a legacy engine reply, or null
 * @returns {{ level: 'checking'|'loading'|'ok'|'warn'|'error', label: string, title: string }}
 */
export function badgeView(status) {
  if (!status || typeof status !== 'object' || status.success === false) return checkingView();
  const badge = status.badge;
  if (badge && typeof badge === 'object' && BADGE_LEVELS.includes(badge.level)) {
    const level = badge.level;
    let label = typeof badge.label === 'string' && badge.label.trim() ? badge.label.trim() : DEFAULT_LABELS[level];
    if (level === 'loading' && !label.includes('%')) {
      const p = Number(status.system1 && status.system1.progress);
      if (Number.isFinite(p) && p >= 0 && p <= 1) label = `${label.replace(/…$/, '')} ${Math.round(p * 100)}%`;
    }
    const title = typeof badge.title === 'string' && badge.title.trim() ? badge.title.trim() : label;
    return { level, label, title };
  }
  if ('tier' in status || 'status' in status) return legacyView(status);
  return checkingView();
}

/**
 * GET_ENGINE_STATUS is polled only while the status is unknown or still loading; pushes
 * (ENGINE_STATUS) cover everything else.
 * @param {{ level: string }} view
 */
export function shouldPollEngine(view) {
  return !view || view.level === 'checking' || view.level === 'loading';
}

/**
 * @param {{ root: HTMLElement, dot: HTMLElement, label: HTMLElement }} els
 * @param {{ level: string, label: string, title: string }} view
 */
export function renderBadge(els, view) {
  const v = view || checkingView();
  if (els.root) {
    els.root.dataset.level = v.level;
    els.root.title = v.title;
    els.root.setAttribute('aria-label', `Decision engine: ${v.label}. ${v.title}`);
  }
  if (els.dot) els.dot.className = `engine-dot level-${v.level}`;
  if (els.label) els.label.textContent = v.label;
}

/**
 * Short engine name for the telemetry card.
 * @param {any} status
 */
export function engineDisplayName(status) {
  if (!status || typeof status !== 'object') return '—';
  if (!status.badge && typeof status.name === 'string' && status.name) return status.name;
  const s1 = status.system1 || {};
  if (s1.state === 'ready') return s1.model ? `System 1 (${s1.model})` : 'System 1';
  return badgeView(status).label;
}

/**
 * Polls while shouldPollEngine(view); call sync(view) after every badge change.
 * @param {{ poll: () => unknown, intervalMs?: number, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval }} opts
 */
export function createEnginePoller({ poll, intervalMs = 5000, setTimer = setInterval, clearTimer = clearInterval }) {
  /** @type {any} */
  let timer = null;
  return {
    /** @param {{ level: string }} view */
    sync(view) {
      const want = shouldPollEngine(view);
      if (want && timer === null) timer = setTimer(() => poll(), intervalMs);
      else if (!want && timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get active() {
      return timer !== null;
    }
  };
}
