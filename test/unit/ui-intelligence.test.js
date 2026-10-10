// @vitest-environment happy-dom
/**
 * ui/intelligence.js: form value -> UPDATE_INTELLIGENCE_SETTINGS patches (checked against the
 * storage whitelist), status mapping, the Gemini Nano download (create() inside the click) and the
 * mounted form's messages (API keys never re-displayed).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  providerPatch, modelPatch, cloudEnabledPatch, cloudFieldPatch, gatePatch, budgetPatch, floorPatch,
  secretPayload, secretStatusText, statusPill, cloudCardState, nanoState, escalationHint, testResultText,
  system1State, startNanoDownload, mountIntelligence, ESCALATION_OPTIONS, NANO_SESSION_OPTIONS
} from '../../ui/intelligence.js';
import { validateIntelligencePatch } from '../../lib/storage/schema.js';
import { MSG } from '../../lib/messages.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('patch builders', () => {
  test('every builder produces a patch the storage whitelist accepts', () => {
    const patches = [
      providerPatch('none'), providerPatch('nano'), providerPatch('jev'), providerPatch('openai'),
      modelPatch('minilm'), modelPatch('bge-small'),
      cloudEnabledPatch('jev', true), cloudEnabledPatch('openai', false),
      cloudFieldPatch('openai', 'model', ' gpt-6-luna ').patch,
      cloudFieldPatch('jev', 'baseUrl', 'https://api.typesafe.ai').patch,
      cloudFieldPatch('openai', 'baseUrl', 'http://localhost:8787/v1').patch,
      gatePatch('strictness', 'strict'), gatePatch('whenUnsure', 'skip'),
      budgetPatch('perMinute', '30').patch, budgetPatch('perDay', '1000').patch,
      floorPatch('matches_prompt', '0.7').patch, floorPatch('primary_tag', '0').patch
    ];
    for (const patch of patches) {
      const res = validateIntelligencePatch(patch);
      expect(res.errors, JSON.stringify(patch)).toEqual([]);
    }
  });

  test('exact shapes', () => {
    expect(providerPatch('jev')).toEqual({ escalation: { provider: 'jev' } });
    expect(modelPatch('minilm')).toEqual({ system1: { model: 'minilm' } });
    expect(cloudEnabledPatch('openai', 1)).toEqual({ providers: { openai: { enabled: true } } });
    expect(cloudFieldPatch('openai', 'model', '  gpt-x ')).toEqual({ ok: true, patch: { providers: { openai: { model: 'gpt-x' } } } });
    expect(gatePatch('whenUnsure', 'collect')).toEqual({ gate: { whenUnsure: 'collect' } });
    expect(budgetPatch('perDay', ' 250 ')).toEqual({ ok: true, patch: { escalation: { perDay: 250 } } });
    expect(floorPatch('primary_tag', '0.35')).toEqual({ ok: true, patch: { escalation: { floor: { primary_tag: 0.35 } } } });
  });

  test('a blank floor means the calibrated default (sent as null)', () => {
    expect(floorPatch('matches_prompt', '')).toEqual({ ok: true, patch: { escalation: { floor: { matches_prompt: null } } } });
    expect(floorPatch('matches_prompt', '   ')).toEqual({ ok: true, patch: { escalation: { floor: { matches_prompt: null } } } });
  });

  test('invalid values are refused before anything is sent', () => {
    expect(budgetPatch('perMinute', '').ok).toBe(false);
    expect(budgetPatch('perMinute', '1.5').ok).toBe(false);
    expect(budgetPatch('perMinute', '601').ok).toBe(false);
    expect(budgetPatch('perDay', '-1').ok).toBe(false);
    expect(budgetPatch('perDay', 'abc').ok).toBe(false);
    expect(floorPatch('matches_prompt', '1.2').ok).toBe(false);
    expect(floorPatch('matches_prompt', 'x').ok).toBe(false);
    expect(cloudFieldPatch('jev', 'model', '').ok).toBe(false);
    expect(cloudFieldPatch('jev', 'baseUrl', 'http://api.example.com').ok).toBe(false);
    expect(cloudFieldPatch('jev', 'baseUrl', 'https://user:pw@api.example.com').ok).toBe(false);
    expect(cloudFieldPatch('jev', 'baseUrl', 'not a url').ok).toBe(false);
  });

  test('secretPayload trims and validates without echoing the key', () => {
    expect(secretPayload('jev', '  jev-key-123  ')).toEqual({ ok: true, payload: { provider: 'jev', value: 'jev-key-123' } });
    const bad = secretPayload('openai', 'sk with spaces');
    expect(bad.ok).toBe(false);
    expect(bad.error).not.toContain('sk with spaces');
    expect(secretPayload('openai', '').ok).toBe(false);
  });

  test('the provider select offers None | Gemini Nano | TypeSafe Jev | OpenAI', () => {
    expect(ESCALATION_OPTIONS.map((o) => o.value)).toEqual(['none', 'nano', 'jev', 'openai']);
    expect(ESCALATION_OPTIONS[1].label).toContain('Gemini Nano');
  });
});

describe('status mapping', () => {
  test('statusPill tones and progress', () => {
    expect(statusPill('ready')).toMatchObject({ tone: 'ok', label: 'Ready' });
    expect(statusPill('loading', { progress: 0.256 })).toMatchObject({ tone: 'loading', label: 'Loading 26%' });
    expect(statusPill('auth_error')).toMatchObject({ tone: 'error', label: 'Key rejected' });
    expect(statusPill('rate_limited').tone).toBe('warn');
    expect(statusPill(undefined)).toMatchObject({ state: 'checking', label: 'Checking…' });
  });

  test('system1State is checking until the service worker knows', () => {
    expect(system1State(null).state).toBe('checking');
    expect(system1State({ badge: { level: 'checking' }, system1: { state: 'loading' } }).state).toBe('checking');
    expect(system1State({ badge: { level: 'ok' }, system1: { state: 'ready', model: 'minilm' } })).toMatchObject({ state: 'ready', model: 'minilm' });
    expect(system1State({ tier: 3, status: 'ready' }).state).toBe('unavailable');
  });

  test('cloudCardState', () => {
    const base = { id: 'jev', enabled: true, secret: { set: true, last4: 'abcd' }, primary: 'jev' };
    expect(cloudCardState({ ...base, enabled: false }).label).toBe('Off');
    expect(cloudCardState({ ...base, secret: { set: false } }).state).toBe('no_key');
    expect(cloudCardState({ ...base, primary: 'nano' }).state).toBe('standby');
    expect(cloudCardState({ ...base, escalation: { provider: 'jev', status: { state: 'auth_error' } } }).state).toBe('auth_error');
    expect(cloudCardState({ ...base, escalation: { provider: 'jev', status: { state: 'ready' } } }).tone).toBe('ok');
    expect(cloudCardState({ ...base, secret: null }).label).toBe('Allowed');
  });

  test('nanoState merges the service worker view with the panel probe', () => {
    const local = { api: true, availability: null, downloading: false, progress: null, error: null };
    expect(nanoState(null, local)).toMatchObject({ state: 'checking', canDownload: false });
    expect(nanoState(null, { ...local, availability: 'downloadable' })).toMatchObject({ state: 'downloadable', canDownload: true });
    expect(nanoState(null, { ...local, availability: 'available' })).toMatchObject({ state: 'ready', canDownload: false });
    expect(nanoState({ state: 'downloading', progress: 0.3 }, local)).toMatchObject({ state: 'downloading', progress: 0.3, canDownload: true });
    expect(nanoState(null, { ...local, downloading: true, progress: 0.7 })).toMatchObject({ state: 'downloading', progress: 0.7, canDownload: false });
    expect(nanoState(null, { ...local, api: false })).toMatchObject({ state: 'unavailable', noApi: true, canDownload: false });
    expect(nanoState({ state: 'unavailable', lastError: 'no GPU' }, { ...local, availability: 'unknown' })).toMatchObject({ state: 'unavailable', error: 'no GPU' });
    // The service worker's view wins when it can see the API.
    expect(nanoState({ state: 'downloadable', present: 'sw' }, { ...local, availability: 'unavailable' })).toMatchObject({ state: 'downloadable', canDownload: true });
    expect(nanoState({ state: 'unavailable', present: 'none' }, { ...local, availability: 'downloadable' }).state).toBe('downloadable');
    // ...except an 'unavailable' from the worker's start that the panel's fresher probe contradicts:
    // the Download button must show when the browser says the model can be downloaded.
    expect(nanoState({ state: 'unavailable', present: 'sw' }, { ...local, availability: 'downloadable' })).toMatchObject({ state: 'downloadable', canDownload: true });
    expect(nanoState({ state: 'unavailable', present: 'sw' }, { ...local, availability: 'available' })).toMatchObject({ state: 'ready', canDownload: false });
    expect(nanoState({ state: 'unavailable', present: 'sw' }, { ...local, availability: 'unavailable' })).toMatchObject({ state: 'unavailable', canDownload: false });
    expect(nanoState({ state: 'unavailable', present: 'sw' }, local)).toMatchObject({ state: 'unavailable', canDownload: false });
    // A switched-off provider stays off whatever the probe says.
    expect(nanoState({ state: 'disabled', present: 'sw' }, { ...local, availability: 'downloadable' }).state).toBe('disabled');
  });

  test('escalationHint warns when a cloud provider is selected but not allowed or has no key', () => {
    const intel = { providers: { jev: { enabled: false }, openai: { enabled: true } } };
    expect(escalationHint({ provider: 'jev', intelligence: intel, secrets: null, nano: { state: 'ready' } }).tone).toBe('warn');
    expect(escalationHint({ provider: 'openai', intelligence: intel, secrets: { openai: { set: false } }, nano: {} }).tone).toBe('warn');
    expect(escalationHint({ provider: 'openai', intelligence: intel, secrets: { openai: { set: true } }, nano: {} })).toMatchObject({ tone: 'muted' });
    expect(escalationHint({ provider: 'nano', intelligence: intel, secrets: null, nano: { state: 'downloadable' } }).tone).toBe('warn');
    expect(escalationHint({ provider: 'none', intelligence: intel, secrets: null, nano: {} }).tone).toBe('muted');
  });

  test('secretStatusText shows only the last 4', () => {
    expect(secretStatusText({ set: true, last4: 'wxyz' })).toBe('Key saved ••wxyz');
    expect(secretStatusText({ set: true, last4: null })).toBe('Key saved');
    expect(secretStatusText({ set: false })).toBe('No key saved');
    expect(secretStatusText(null)).toBe('');
  });

  test('testResultText: latency, redacted errors, unsupported', () => {
    expect(testResultText({ success: true, ok: true, latencyMs: 312, model: 'gpt-6-luna' })).toEqual({ tone: 'ok', text: 'Connected · 312 ms · gpt-6-luna' });
    const err = testResultText({ success: true, ok: false, error: 'Bearer sk-abcdefghijklmnop rejected', code: 'auth_error' });
    expect(err.tone).toBe('error');
    expect(err.text).not.toContain('sk-abcdefghijklmnop');
    expect(err.text).toContain('(auth_error)');
    expect(testResultText({ success: false, error: 'Unknown message type' }).tone).toBe('muted');
    expect(testResultText(null).tone).toBe('error');
  });
});

describe('startNanoDownload', () => {
  function fakeLanguageModel({ fail = false } = {}) {
    const calls = [];
    const session = { destroy: vi.fn() };
    let monitorTarget = null;
    let resolve;
    let reject;
    const LM = {
      create: vi.fn((opts) => {
        calls.push('create');
        const listeners = {};
        monitorTarget = { addEventListener: (type, fn) => { listeners[type] = fn; }, emit: (type, e) => listeners[type] && listeners[type](e) };
        opts.monitor(monitorTarget);
        return new Promise((res, rej) => { resolve = () => res(session); reject = () => rej(Object.assign(new Error('Not enough disk'), { name: 'NotSupportedError' })); });
      })
    };
    return { LM, calls, session, progress: (e) => monitorTarget.emit('downloadprogress', e), finish: () => (fail ? reject() : resolve()) };
  }

  test('calls create() synchronously with the expected inputs/outputs and relays progress', async () => {
    const fake = fakeLanguageModel();
    const sent = [];
    const updates = [];
    const p = startNanoDownload({ LanguageModel: fake.LM, send: (type, payload) => { sent.push({ type, payload }); return Promise.resolve({ success: true }); }, onUpdate: (u) => updates.push(u) });
    // Synchronous: create already ran before any await (user activation is preserved).
    expect(fake.LM.create).toHaveBeenCalledTimes(1);
    const opts = fake.LM.create.mock.calls[0][0];
    expect(opts.expectedInputs).toEqual(NANO_SESSION_OPTIONS.expectedInputs);
    expect(opts.expectedOutputs).toEqual(NANO_SESSION_OPTIONS.expectedOutputs);
    expect(typeof opts.monitor).toBe('function');
    expect(sent[0]).toEqual({ type: MSG.NANO_DOWNLOAD_STATE, payload: { phase: 'start' } });

    fake.progress({ loaded: 0.25 });
    fake.progress({ loaded: 0.251 }); // same percent: not relayed again
    fake.progress({ loaded: 512, total: 1024 }); // bytes form
    fake.finish();
    await expect(p).resolves.toEqual({ ok: true });

    expect(sent.map((s) => s.payload)).toEqual([
      { phase: 'start' },
      { phase: 'progress', loaded: 0.25 },
      { phase: 'progress', loaded: 0.5 },
      { phase: 'done' }
    ]);
    expect(fake.session.destroy).toHaveBeenCalledTimes(1);
    expect(updates.map((u) => u.phase)).toEqual(['start', 'progress', 'progress', 'progress', 'done']);
  });

  test('relays errors (create rejects)', async () => {
    const fake = fakeLanguageModel({ fail: true });
    const sent = [];
    const p = startNanoDownload({ LanguageModel: fake.LM, send: (type, payload) => { sent.push(payload); } });
    fake.finish();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Not enough disk');
    expect(sent.at(-1)).toMatchObject({ phase: 'error' });
  });

  test('create() throwing synchronously and a missing API', async () => {
    const throwing = { create: () => { throw new Error('NotAllowedError: needs a user gesture'); } };
    const sent = [];
    await expect(startNanoDownload({ LanguageModel: throwing, send: (t, p) => sent.push(p) })).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([{ phase: 'error', error: 'NotAllowedError: needs a user gesture' }]);
    await expect(startNanoDownload({ LanguageModel: undefined, send: () => {} })).resolves.toMatchObject({ ok: false });
  });
});

describe('mountIntelligence', () => {
  let root;
  let sent;
  let toasts;
  let replies;

  function mount(extra = {}) {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root');
    sent = [];
    toasts = [];
    const send = vi.fn(async (type, payload) => {
      sent.push({ type, payload });
      const r = replies[type];
      return typeof r === 'function' ? r(payload) : r;
    });
    return mountIntelligence(root, { send, toast: { show: (o) => toasts.push(o) }, getLanguageModel: () => undefined, ...extra });
  }

  beforeEach(() => {
    replies = {
      [MSG.UPDATE_INTELLIGENCE_SETTINGS]: { success: true },
      [MSG.SET_SECRET]: (p) => ({ success: true, secrets: { jev: { set: true, last4: p.value.slice(-4) }, openai: { set: false, last4: null } } }),
      [MSG.CLEAR_SECRET]: { success: true, secrets: { jev: { set: false, last4: null }, openai: { set: false, last4: null } } },
      [MSG.TEST_PROVIDER]: { success: true, ok: true, latencyMs: 210, model: 'jev-latest' }
    };
  });

  test('renders System 1, the provider select, Nano and both cloud cards (cloud off by default)', () => {
    const ui = mount();
    ui.update({ configuration: {} });
    const select = root.querySelector('#esc-provider');
    expect([...select.options].map((o) => o.value)).toEqual(['none', 'nano', 'jev', 'openai']);
    expect(root.querySelector('#s1-model').options.length).toBeGreaterThanOrEqual(2);
    expect(root.querySelector('#jev-enabled').checked).toBe(false);
    expect(root.querySelector('#openai-enabled').checked).toBe(false);
    expect(root.querySelector('#jev-key').type).toBe('password');
    expect(root.querySelector('#intel-jev').textContent).toContain('Allow sending uncertain posts to TypeSafe Jev');
    expect(root.querySelector('#intel-openai').textContent).toContain('Only posts System 1 is unsure about leave your device');
    expect(root.querySelector('#s1-pill').textContent).toBe('Checking…');
  });

  test('changing the provider sends UPDATE_INTELLIGENCE_SETTINGS { patch: { escalation: { provider } } }', async () => {
    mount();
    const select = root.querySelector('#esc-provider');
    select.value = 'openai';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(sent).toContainEqual({ type: MSG.UPDATE_INTELLIGENCE_SETTINGS, payload: { patch: { escalation: { provider: 'openai' } } } });
  });

  test('allow switch, model, budget and strictness controls send their patches', async () => {
    mount();
    const allow = root.querySelector('#jev-enabled');
    allow.checked = true;
    allow.dispatchEvent(new Event('change'));
    const model = root.querySelector('#openai-model');
    model.value = 'gpt-6-luna-mini';
    model.dispatchEvent(new Event('change'));
    const perDay = root.querySelector('#budget-day');
    perDay.value = '200';
    perDay.dispatchEvent(new Event('change'));
    const strict = root.querySelector('input[name="intel-strictness"][value="strict"]');
    strict.checked = true;
    strict.dispatchEvent(new Event('change', { bubbles: true }));
    const floor = root.querySelector('#floor-match');
    floor.value = '';
    floor.dispatchEvent(new Event('change'));
    await flush();
    const patches = sent.filter((s) => s.type === MSG.UPDATE_INTELLIGENCE_SETTINGS).map((s) => s.payload.patch);
    expect(patches).toEqual([
      { providers: { jev: { enabled: true } } },
      { providers: { openai: { model: 'gpt-6-luna-mini' } } },
      { escalation: { perDay: 200 } },
      { gate: { strictness: 'strict' } },
      { escalation: { floor: { matches_prompt: null } } }
    ]);
  });

  test('an invalid budget is not sent and is reported', async () => {
    mount();
    const perMinute = root.querySelector('#budget-minute');
    perMinute.value = '9999';
    perMinute.dispatchEvent(new Event('change'));
    await flush();
    expect(sent.filter((s) => s.type === MSG.UPDATE_INTELLIGENCE_SETTINGS)).toEqual([]);
    expect(toasts.at(-1)).toMatchObject({ level: 'warn' });
  });

  test('a refused patch shows an error toast and reverts the control', async () => {
    replies[MSG.UPDATE_INTELLIGENCE_SETTINGS] = { success: false, error: 'Invalid settings: escalation.provider: expected one of none, nano, jev, openai' };
    const ui = mount();
    ui.update({ configuration: { intelligence: { escalation: { provider: 'nano' } } } });
    const select = root.querySelector('#esc-provider');
    select.value = 'jev';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(toasts.at(-1)).toMatchObject({ level: 'error' });
    expect(select.value).toBe('nano');
  });

  test('API key: SET_SECRET with the value, field cleared, only ••last4 shown, never in the DOM', async () => {
    const ui = mount();
    ui.update({ diagnostics: { secrets: { jev: { set: false, last4: null }, openai: { set: false, last4: null } } } });
    expect(root.querySelector('#jev-key-status').textContent).toBe('No key saved');
    const key = 'jev-live-SECRET-1234567890wxyz';
    const input = root.querySelector('#jev-key');
    input.value = key;
    root.querySelector('#jev-key-save').click();
    expect(input.value).toBe(''); // cleared before the reply
    await flush();
    expect(sent).toContainEqual({ type: MSG.SET_SECRET, payload: { provider: 'jev', value: key } });
    expect(root.querySelector('#jev-key-status').textContent).toBe('Key saved ••wxyz');
    expect(document.documentElement.outerHTML).not.toContain('SECRET');
    expect(input.value).toBe('');
    expect(toasts.at(-1)).toMatchObject({ level: 'success' });
    expect(JSON.stringify(toasts)).not.toContain('SECRET');

    root.querySelector('#jev-key-clear').click();
    await flush();
    expect(sent).toContainEqual({ type: MSG.CLEAR_SECRET, payload: { provider: 'jev' } });
    expect(root.querySelector('#jev-key-status').textContent).toBe('No key saved');
  });

  test('a failed key save never echoes the key', async () => {
    replies[MSG.SET_SECRET] = (p) => ({ success: false, error: `bad key ${p.value}`, code: 'bad_request' });
    mount();
    const key = 'sk-live-SECRET-abcdefghijkl';
    root.querySelector('#openai-key').value = key;
    root.querySelector('#openai-key-save').click();
    await flush();
    expect(JSON.stringify(toasts)).not.toContain('SECRET');
    expect(document.documentElement.outerHTML).not.toContain('SECRET');
  });

  test('Test connection shows latency or the redacted error', async () => {
    mount();
    root.querySelector('#jev-test').click();
    await flush();
    expect(sent).toContainEqual({ type: MSG.TEST_PROVIDER, payload: { provider: 'jev' } });
    expect(root.querySelector('#jev-test-result').textContent).toBe('Connected · 210 ms · jev-latest');
    replies[MSG.TEST_PROVIDER] = { success: true, ok: false, error: 'HTTP 401 for Bearer abcdefghijklmnop', code: 'auth_error' };
    root.querySelector('#openai-test').click();
    await flush();
    const text = root.querySelector('#openai-test-result').textContent;
    expect(text).toContain('Failed');
    expect(text).not.toContain('abcdefghijklmnop');
  });

  test('engine status drives the System 1 pill, progress and the primary card', () => {
    const ui = mount();
    ui.update({ configuration: { intelligence: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true } } } } });
    ui.update({ engineStatus: { badge: { level: 'loading' }, system1: { state: 'loading', progress: 0.4 }, escalation: { provider: 'jev', status: { state: 'auth_error' } } } });
    expect(root.querySelector('#s1-pill').textContent).toBe('Loading 40%');
    expect(root.querySelector('#s1-progress').classList.contains('hidden')).toBe(false);
    expect(root.querySelector('#s1-progress .progress-fill').style.width).toBe('40%');
    expect(root.querySelector('#intel-jev').classList.contains('is-primary')).toBe(true);
    expect(root.querySelector('#jev-pill').dataset.tone).toBe('error');
    ui.update({ engineStatus: { badge: { level: 'ok' }, system1: { state: 'ready', model: 'minilm', device: 'wasm', lastLatencyMs: 7 } } });
    expect(root.querySelector('#s1-pill').textContent).toBe('Ready');
    expect(root.querySelector('#s1-load').classList.contains('hidden')).toBe(true);
    expect(root.querySelector('#s1-meta').textContent).toContain('avg 7 ms');
  });

  test('Nano download button calls LanguageModel.create inside the click', async () => {
    const create = vi.fn(() => Promise.resolve({ destroy() {} }));
    const LM = { create, availability: vi.fn(async () => 'downloadable') };
    mount({ getLanguageModel: () => LM });
    await flush();
    await flush();
    const btn = root.querySelector('#nano-download');
    expect(btn.classList.contains('hidden')).toBe(false);
    btn.click();
    expect(create).toHaveBeenCalledTimes(1); // synchronously within the click
    await flush();
    const relayed = sent.filter((s) => s.type === MSG.NANO_DOWNLOAD_STATE).map((s) => s.payload.phase);
    expect(relayed).toEqual(['start', 'done']);
  });

  test('S1_ENSURE_LOADED from Load model; unsupported background → info toast', async () => {
    replies[MSG.S1_ENSURE_LOADED] = { success: false, error: 'Unknown message type' };
    mount();
    root.querySelector('#s1-load').click();
    await flush();
    expect(sent).toContainEqual({ type: MSG.S1_ENSURE_LOADED, payload: {} });
    expect(toasts.at(-1)).toMatchObject({ level: 'info' });
  });

  test('calibrated floors become placeholders', async () => {
    const loadCalibration = vi.fn(async () => ({ floor: { matches_prompt: 0.7, primary_tag: 0.3 } }));
    const ui = mount({ loadCalibration });
    ui.update({ configuration: { intelligence: { system1: { model: 'minilm' } } } });
    await flush();
    expect(loadCalibration).toHaveBeenCalledWith('minilm');
    expect(root.querySelector('#floor-match').placeholder).toBe('default 0.7');
    expect(root.querySelector('#floor-tag').placeholder).toBe('default 0.3');
  });
});

describe('idle refinement (Settings › Intelligence)', () => {
  test('status line and patch', async () => {
    const { refineStatusText, refinePatch, agoText } = await import('../../ui/intelligence.js');
    const { refineStats } = await import('../../ui/diagnostics.js');
    expect(validateIntelligencePatch(refinePatch(false))).toMatchObject({ ok: true, patch: { refine: { enabled: false } } });
    expect(validateIntelligencePatch({ refine: { idleSeconds: 5 } }).ok).toBe(false);
    expect(validateIntelligencePatch({ refine: { idleSeconds: 120, nano: false } }).ok).toBe(true);
    const now = 10 * 60_000;
    expect(refineStatusText(null)).toBe('Waiting for idle');
    expect(refineStatusText({ state: 'waiting' }, { enabled: false })).toBe('Off');
    expect(refineStatusText({ state: 'running', done: 8, pending: 20 })).toBe('Running… 8 of 20');
    expect(refineStatusText({ state: 'done', refined: 0, total: 0 })).toBe('Nothing to refine yet');
    expect(refineStatusText({ state: 'waiting', refined: 12, total: 40, lastRunAt: now - 3 * 60_000 }, { now })).toBe('Refined 12 of 40 · last run 3 min ago · Waiting for idle');
    expect(refineStatusText({ state: 'done', refined: 40, total: 40, lastRunAt: now - 10_000 }, { now })).toBe('Refined 40 of 40 · last run just now');
    expect(agoText(null, now)).toBe('');
    expect(refineStats({ refine: { counters: { refined: 5, changedVerdicts: 2, changedTags: 1, nanoCalls: 3 } } }).map((s) => s.value)).toEqual(['5', '2', '1', '3']);
  });

  test('toggle, status from ENGINE_STATUS and "Refine now"', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root');
    const sent = [];
    const send = vi.fn(async (type, payload) => {
      sent.push({ type, payload });
      if (type === MSG.REFINE_NOW) return { success: true, running: true, refine: { state: 'running', done: 0, pending: 3 } };
      return { success: true };
    });
    const ui = mountIntelligence(root, { send, toast: { show: () => {} }, getLanguageModel: () => undefined });
    ui.update({ configuration: {} });
    const toggle = root.querySelector('#refine-enabled');
    expect(toggle.checked).toBe(true);
    expect(root.querySelector('#intel-refine').textContent).toContain('Refine collected posts when idle (second model + on-device AI)');
    ui.update({ engineStatus: { refine: { enabled: true, state: 'waiting', refined: 2, total: 5, lastRunAt: null } } });
    expect(root.querySelector('#refine-status').textContent).toBe('Refined 2 of 5 · Waiting for idle');

    root.querySelector('#refine-now').click();
    await flush();
    expect(sent.map((s) => s.type)).toContain(MSG.REFINE_NOW);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await flush();
    expect(sent).toContainEqual({ type: MSG.UPDATE_INTELLIGENCE_SETTINGS, payload: { patch: { refine: { enabled: false } } } });
    ui.update({ configuration: { intelligence: { refine: { enabled: false } } } });
    expect(root.querySelector('#refine-status').textContent).toBe('Off');
    expect(root.querySelector('#refine-now').disabled).toBe(true);
  });
});
