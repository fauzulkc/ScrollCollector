/**
 * Settings › Intelligence › Diagnostics (collapsible): GET_DIAGNOSTICS per provider, decision
 * counters, the last rejected posts, and Copy diagnostics / Re-decide stack / Reset counters.
 *
 * "Copy diagnostics" never includes API keys: the reply only carries describeSecrets()
 * ({ set, last4 }), the copy keeps just `set`, and the JSON is passed through redact().
 */
import { MSG } from '../lib/messages.js';
import { redact } from '../lib/storage/secrets.js';
import { formatMs, formatPct, formatProb, formatUsd, isUnsupportedReply } from './util.js';
import { providerLabel, reasonText } from './decision-info.js';
import { statusPill } from './intelligence.js';

export const DIAGNOSTIC_PROVIDERS = Object.freeze(['system1', 'nano', 'jev', 'openai']);

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Counter tiles.
 * @param {any} diag   GET_DIAGNOSTICS reply
 * @param {any} [engineStatus]
 * @returns {{ label: string, value: string }[]}
 */
export function diagnosticsStats(diag, engineStatus) {
  const es = (diag && diag.engineStatus) || engineStatus || {};
  const c = es.counters || {};
  const cache = (diag && diag.cache) || {};
  const hits = num(cache.hits);
  const misses = num(cache.misses);
  const lookups = (hits || 0) + (misses || 0);
  const budget = (diag && diag.budget) || {};
  let cost = null;
  for (const id of DIAGNOSTIC_PROVIDERS) {
    const v = num(diag && diag.providers && diag.providers[id] && diag.providers[id].costUsd);
    if (v !== null) cost = (cost || 0) + v;
  }
  const decided = num(c.decided);
  return [
    { label: 'Decided', value: decided === null ? '—' : String(decided) },
    { label: 'Escalated', value: num(c.escalationRate) === null ? '—' : `${formatPct(c.escalationRate, 1)}${num(c.escalated) !== null ? ` (${c.escalated})` : ''}` },
    { label: 'Cache hits', value: lookups > 0 ? `${formatPct((hits || 0) / lookups)} of ${lookups}` : (num(c.cacheHits) !== null ? String(c.cacheHits) : '—') },
    { label: 'Avg / p95', value: num(c.avgMs) === null ? '—' : `${formatMs(c.avgMs)} / ${formatMs(c.p95Ms)}` },
    { label: 'Escalations today', value: num(budget.dayUsed) === null ? '—' : `${budget.dayUsed}${num(budget.perDay) !== null ? ` / ${budget.perDay}` : ''}` },
    { label: 'Est. cost', value: cost === null ? '—' : formatUsd(cost) }
  ];
}

/**
 * One row per provider: status, calls, latency, cost and last error.
 * @param {any} diag
 * @param {any} [engineStatus]
 */
export function providerRows(diag, engineStatus) {
  const es = (diag && diag.engineStatus) || engineStatus || {};
  const providers = (diag && diag.providers) || {};
  const escalation = es.escalation || {};
  return DIAGNOSTIC_PROVIDERS.map((id) => {
    const p = providers[id] || {};
    let state = typeof p.state === 'string' ? p.state : (p.status && typeof p.status.state === 'string' ? p.status.state : null);
    if (!state) {
      if (id === 'system1') state = es.system1 && es.system1.state;
      else if (id === 'nano') state = es.nano && es.nano.state;
      else if (escalation.provider === id) state = escalation.status && escalation.status.state;
      else state = 'disabled';
    }
    const pill = statusPill(state || 'checking');
    const lastError = typeof p.lastError === 'string' && p.lastError ? redact(p.lastError).slice(0, 200) : '';
    return {
      id,
      label: providerLabel(id),
      tone: pill.tone,
      status: pill.label,
      calls: num(p.calls),
      avgMs: num(p.avgMs),
      p95Ms: num(p.p95Ms),
      costUsd: num(p.costUsd),
      model: typeof p.model === 'string' ? p.model : '',
      lastError
    };
  });
}

/**
 * @param {any} diag
 * @returns {{ snippet: string, p: string, path: string, reason: string, platform: string, at: number|null }[]}
 */
export function rejectedRows(diag) {
  const list = diag && Array.isArray(diag.rejected) ? diag.rejected : [];
  return list.slice(0, 50).map((r) => ({
    snippet: String((r && r.snippet) || '').slice(0, 140),
    p: formatProb(r && r.pMatch),
    path: Array.isArray(r && r.path) ? r.path.map(providerLabel).join(' → ') : String((r && r.path) || ''),
    reason: reasonText(r && r.reason) || '',
    platform: String((r && r.platform) || ''),
    at: num(r && r.at)
  }));
}

/**
 * The JSON put on the clipboard: no key material at all (secrets reduced to { set }).
 * @param {any} diag
 * @param {{ version?: string, intelligence?: any, now?: number }} [extra]
 * @returns {string}
 */
export function diagnosticsForCopy(diag, { version = '', intelligence = null, now = Date.now() } = {}) {
  const copy = diag && typeof diag === 'object' ? JSON.parse(JSON.stringify(diag)) : {};
  delete copy.success;
  if (copy.secrets && typeof copy.secrets === 'object') {
    const safe = {};
    for (const [id, s] of Object.entries(copy.secrets)) safe[id] = { set: !!(s && /** @type {any} */ (s).set) };
    copy.secrets = safe;
  }
  const out = {
    kind: 'scrollcollector.diagnostics/v1',
    generatedAt: new Date(now).toISOString(),
    version,
    intelligence,
    ...copy
  };
  return redact(JSON.stringify(out, null, 2));
}

/**
 * @param {{ done?: number, total?: number, hidden?: number, finished?: boolean }} p
 */
export function redecideText(p) {
  const done = num(p && p.done) || 0;
  const total = num(p && p.total) || 0;
  const hidden = num(p && p.hidden) || 0;
  if (p && p.finished) return `Re-check finished: ${total} post${total === 1 ? '' : 's'}, ${hidden} hidden by the prompt.`;
  return `Re-checking ${done} of ${total}${hidden ? ` · ${hidden} hidden` : ''}…`;
}

/**
 * @param {string} text
 * @param {Document} doc
 */
async function copyText(text, doc) {
  try {
    if (globalThis.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * @typedef {object} DiagnosticsDeps
 * @property {(type: string, payload?: object) => Promise<any>} send
 * @property {{ show: (o: { level?: string, text: string, key?: string }) => unknown }} toast
 * @property {() => { version?: string, intelligence?: any, engineStatus?: any }} [getContext]
 * @property {(diag: any) => void} [onDiagnostics]   called with every successful GET_DIAGNOSTICS reply
 * @property {Document} [doc]
 * @property {number} [refreshMs]
 */

/**
 * @param {HTMLElement} root
 * @param {DiagnosticsDeps} deps
 */
export function mountDiagnostics(root, deps) {
  const { send, toast } = deps;
  const doc = deps.doc || root.ownerDocument || globalThis.document;
  const getContext = deps.getContext || (() => ({}));
  const refreshMs = deps.refreshMs ?? 5000;

  root.innerHTML = `
  <details class="intel-details" id="diag-details">
    <summary>Diagnostics</summary>
    <div class="diag-body">
      <p class="intel-hint hidden" id="diag-unavailable">Diagnostics are not available from this version of the extension’s background yet.</p>
      <div class="diag-stats" id="diag-stats"></div>
      <div class="diag-section-title">Providers</div>
      <div class="diag-providers" id="diag-providers"></div>
      <div class="diag-section-title">Recently rejected <span class="diag-count" id="diag-rejected-count"></span></div>
      <ol class="diag-rejected" id="diag-rejected"></ol>
      <div class="progress hidden" id="diag-redecide-progress" role="progressbar" aria-label="Re-decide progress" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill"></div></div>
      <p class="intel-hint hidden" id="diag-redecide-text" aria-live="polite"></p>
      <div class="intel-actions wrap">
        <button type="button" class="btn-sm" id="diag-copy">Copy diagnostics</button>
        <button type="button" class="btn-sm" id="diag-redecide">Re-decide stack</button>
        <button type="button" class="btn-sm ghost" id="diag-reset">Reset counters</button>
        <button type="button" class="btn-sm ghost" id="diag-refresh">Refresh</button>
      </div>
    </div>
  </details>`;

  /** @param {string} id @returns {any} */
  const $ = (id) => root.querySelector(`#${id}`);
  const details = $('diag-details');

  /** @type {any} */
  let last = null;
  let unsupported = false;
  /** @type {any} */
  let timer = null;
  /** @type {string|null} */
  let activeJob = null;

  function render() {
    const ctx = getContext() || {};
    $('diag-unavailable').classList.toggle('hidden', !unsupported);

    const stats = $('diag-stats');
    stats.textContent = '';
    // Without GET_DIAGNOSTICS there are no counters to show (provider states still come from ENGINE_STATUS).
    stats.classList.toggle('hidden', unsupported && !last);
    for (const s of diagnosticsStats(last, ctx.engineStatus)) {
      const tile = doc.createElement('div');
      tile.className = 'diag-stat';
      const v = doc.createElement('span');
      v.className = 'diag-stat-value';
      v.textContent = s.value;
      const l = doc.createElement('span');
      l.className = 'diag-stat-label';
      l.textContent = s.label;
      tile.append(v, l);
      stats.appendChild(tile);
    }

    const list = $('diag-providers');
    list.textContent = '';
    for (const r of providerRows(last, ctx.engineStatus)) {
      const row = doc.createElement('div');
      row.className = 'diag-provider';
      row.dataset.provider = r.id;
      const head = doc.createElement('div');
      head.className = 'diag-provider-head';
      const name = doc.createElement('span');
      name.className = 'diag-provider-name';
      name.textContent = r.model ? `${r.label} · ${r.model}` : r.label;
      const pill = doc.createElement('span');
      pill.className = 'status-pill';
      pill.dataset.tone = r.tone;
      const dot = doc.createElement('span');
      dot.className = 'status-pill-dot';
      const txt = doc.createElement('span');
      txt.className = 'status-pill-text';
      txt.textContent = r.status;
      pill.append(dot, txt);
      head.append(name, pill);
      const meta = doc.createElement('div');
      meta.className = 'diag-provider-meta';
      const parts = [`${r.calls === null ? '—' : r.calls} calls`, `avg ${formatMs(r.avgMs)}`, `p95 ${formatMs(r.p95Ms)}`];
      if (r.costUsd !== null) parts.push(formatUsd(r.costUsd));
      meta.textContent = parts.join(' · ');
      row.append(head, meta);
      if (r.lastError) {
        const err = doc.createElement('div');
        err.className = 'diag-provider-error';
        err.textContent = r.lastError;
        row.appendChild(err);
      }
      list.appendChild(row);
    }

    const rejected = rejectedRows(last);
    $('diag-rejected-count').textContent = rejected.length ? `(${rejected.length})` : '';
    const ol = $('diag-rejected');
    ol.textContent = '';
    if (!rejected.length) {
      const li = doc.createElement('li');
      li.className = 'diag-empty';
      li.textContent = unsupported ? '—' : 'No rejected posts yet.';
      ol.appendChild(li);
    }
    for (const r of rejected) {
      const li = doc.createElement('li');
      li.className = 'diag-rejected-row';
      const snippet = doc.createElement('span');
      snippet.className = 'diag-snippet';
      snippet.textContent = r.snippet || '(no text)';
      snippet.title = r.snippet;
      const meta = doc.createElement('span');
      meta.className = 'diag-rejected-meta';
      meta.textContent = [`p ${r.p}`, r.path, r.reason, r.platform].filter(Boolean).join(' · ');
      li.append(snippet, meta);
      ol.appendChild(li);
    }
  }

  /** @returns {Promise<any>} the GET_DIAGNOSTICS reply (null when unavailable) */
  async function refresh() {
    const reply = await send(MSG.GET_DIAGNOSTICS, {});
    if (isUnsupportedReply(reply)) {
      unsupported = true;
      render();
      return null;
    }
    if (reply && reply.success !== false) {
      unsupported = false;
      last = reply;
      if (deps.onDiagnostics) deps.onDiagnostics(reply);
    }
    render();
    return reply && reply.success !== false ? reply : null;
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  details.addEventListener('toggle', () => {
    if (details.open) {
      refresh();
      stopTimer();
      // Only while visible (the Settings tab may be hidden with the section left open).
      if (refreshMs > 0) timer = setInterval(() => { if (root.getClientRects().length > 0) refresh(); }, refreshMs);
    } else {
      stopTimer();
    }
  });

  $('diag-refresh').addEventListener('click', () => refresh());

  $('diag-copy').addEventListener('click', async () => {
    const ctx = getContext() || {};
    const fresh = (await refresh()) || last || { engineStatus: ctx.engineStatus || null };
    const ok = await copyText(diagnosticsForCopy(fresh, { version: ctx.version || '', intelligence: ctx.intelligence || null }), doc);
    toast.show(ok
      ? { level: 'success', text: 'Diagnostics copied (no API keys included).', key: 'diag-copy' }
      : { level: 'error', text: 'Could not copy to the clipboard.', key: 'diag-copy' });
  });

  $('diag-redecide').addEventListener('click', async () => {
    const btn = $('diag-redecide');
    btn.disabled = true;
    const reply = await send(MSG.REDECIDE_STACK, { scope: 'all' });
    if (isUnsupportedReply(reply)) {
      btn.disabled = false;
      toast.show({ level: 'info', text: 'Re-deciding the stack is not available in this version yet.', key: 'redecide' });
      return;
    }
    if (!reply || reply.success === false) {
      btn.disabled = false;
      toast.show({ level: 'error', text: `Could not start the re-check: ${redact(reply?.error || 'no answer')}`, key: 'redecide' });
      return;
    }
    activeJob = reply.jobId ?? null;
    onRedecideProgress({ jobId: activeJob, done: 0, total: 0, hidden: 0, finished: false });
  });

  $('diag-reset').addEventListener('click', async () => {
    const reply = await send(MSG.RESET_DIAGNOSTICS, {});
    if (isUnsupportedReply(reply)) {
      toast.show({ level: 'info', text: 'Resetting counters is not available in this version yet.', key: 'diag-reset' });
      return;
    }
    if (!reply || reply.success === false) {
      toast.show({ level: 'error', text: 'Could not reset the counters.', key: 'diag-reset' });
      return;
    }
    toast.show({ level: 'info', text: 'Diagnostics counters reset.', key: 'diag-reset' });
    refresh();
  });

  /**
   * REDECIDE_PROGRESS { jobId, done, total, hidden, finished }
   * @param {any} p
   */
  function onRedecideProgress(p) {
    if (!p || typeof p !== 'object') return;
    if (activeJob !== null && p.jobId !== undefined && p.jobId !== activeJob && !p.finished) activeJob = p.jobId;
    const bar = $('diag-redecide-progress');
    const text = $('diag-redecide-text');
    const total = num(p.total) || 0;
    const done = num(p.done) || 0;
    bar.classList.toggle('hidden', !!p.finished);
    const fill = bar.querySelector('.progress-fill');
    const pct = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0;
    bar.classList.toggle('indeterminate', !p.finished && total === 0);
    fill.style.width = total > 0 ? `${pct}%` : '';
    bar.setAttribute('aria-valuenow', String(pct));
    text.textContent = redecideText(p);
    text.classList.remove('hidden');
    $('diag-redecide').disabled = !p.finished;
    if (p.finished) {
      activeJob = null;
      if (details.open) refresh();
    }
  }

  render();
  return { refresh, render, onRedecideProgress, root, get open() { return details.open; } };
}
