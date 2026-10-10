/**
 * fake-chrome.js
 *
 * In-memory stand-in for the chrome.* APIs the service worker uses, for node/vitest tests.
 * Storage values are structured-cloned on the way in and out (like the real API), every call is
 * asynchronous, and calls are recorded so tests can assert on sent messages.
 *
 *   const chrome = createFakeChrome({ local: { configuration: {...} } });
 *   installFakeChrome(chrome);   // sets globalThis.chrome (returns an uninstall function)
 */

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

/** @param {any} v */
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Resolves on a later macrotask so concurrent callers really interleave. */
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Minimal chrome.events.Event.
 */
export function createEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => { listeners.add(fn); },
    removeListener: (fn) => { listeners.delete(fn); },
    hasListener: (fn) => listeners.has(fn),
    hasListeners: () => listeners.size > 0,
    /** Test helper: invoke every listener; returns their return values. */
    dispatch: (...args) => [...listeners].map(fn => fn(...args)),
    get listeners() { return [...listeners]; }
  };
}

/**
 * @param {string} areaName
 * @param {object} initial
 * @param {ReturnType<typeof createEvent>} onChanged   chrome.storage.onChanged
 * @param {{ latencyMs?: number }} options
 */
export function createStorageArea(areaName, initial, onChanged, { latencyMs = 0 } = {}) {
  /** @type {Map<string, any>} */
  const data = new Map(Object.entries(clone(initial || {})));
  const areaOnChanged = createEvent();
  const calls = { get: 0, set: 0, remove: 0 };

  function emit(changes) {
    if (Object.keys(changes).length === 0) return;
    onChanged.dispatch(clone(changes), areaName);
    areaOnChanged.dispatch(clone(changes));
  }

  /** @param {any} keys */
  function read(keys) {
    const out = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of data) out[k] = clone(v);
    } else if (typeof keys === 'string') {
      if (data.has(keys)) out[keys] = clone(data.get(keys));
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
    } else if (typeof keys === 'object') {
      for (const [k, dflt] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : clone(dflt);
    }
    return out;
  }

  /** Supports both promise and callback styles. */
  function withCallback(promise, cb) {
    if (typeof cb === 'function') {
      promise.then(v => cb(v), () => cb(undefined));
      return undefined;
    }
    return promise;
  }

  const area = {
    calls,
    onChanged: areaOnChanged,
    accessLevel: 'TRUSTED_CONTEXTS',

    get(keys, cb) {
      if (typeof keys === 'function') { cb = keys; keys = null; }
      calls.get++;
      return withCallback(tick(latencyMs).then(() => read(keys)), cb);
    },

    set(items, cb) {
      calls.set++;
      const snapshot = clone(items || {});
      return withCallback(tick(latencyMs).then(() => {
        const changes = {};
        for (const [k, v] of Object.entries(snapshot)) {
          changes[k] = { oldValue: clone(data.get(k)), newValue: clone(v) };
          data.set(k, v);
        }
        emit(changes);
      }), cb);
    },

    remove(keys, cb) {
      calls.remove++;
      const list = Array.isArray(keys) ? keys : [keys];
      return withCallback(tick(latencyMs).then(() => {
        const changes = {};
        for (const k of list) {
          if (!data.has(k)) continue;
          changes[k] = { oldValue: clone(data.get(k)) };
          data.delete(k);
        }
        emit(changes);
      }), cb);
    },

    clear(cb) {
      return withCallback(tick(latencyMs).then(() => {
        const changes = {};
        for (const [k, v] of data) changes[k] = { oldValue: clone(v) };
        data.clear();
        emit(changes);
      }), cb);
    },

    setAccessLevel({ accessLevel } = {}, cb) {
      area.accessLevel = accessLevel;
      return withCallback(Promise.resolve(), cb);
    },

    /** Test helpers (synchronous, no events). */
    dump: () => read(null),
    peek: (key) => clone(data.get(key)),
    seed: (items) => { for (const [k, v] of Object.entries(clone(items))) data.set(k, v); }
  };
  return area;
}

/**
 * @param {object} [options]
 * @param {object} [options.local]     initial storage.local contents
 * @param {object} [options.session]   initial storage.session contents
 * @param {{ id: number, url: string }[]} [options.tabs]
 * @param {(tabId: number, message: any) => any} [options.onTabMessage]   return a reply; throw for "no receiver"
 * @param {(message: any) => any} [options.onRuntimeMessage]            same, for runtime.sendMessage
 * @param {number} [options.latencyMs]  storage latency per call
 */
export function createFakeChrome({
  local = {},
  session = {},
  tabs = [],
  onTabMessage,
  onRuntimeMessage,
  latencyMs = 0
} = {}) {
  const onChanged = createEvent();

  /** @type {{ message: any }[]} */
  const runtimeSent = [];
  /** @type {{ tabId: number, message: any }[]} */
  const tabSent = [];
  const alarms = new Map();
  const executed = [];
  /** @type {object[]} */
  const offscreenDocuments = [];

  const runtime = {
    async getContexts({ contextTypes } = {}) {
      await tick();
      if (contextTypes && !contextTypes.includes('OFFSCREEN_DOCUMENT')) return [];
      return offscreenDocuments.map(d => ({ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: runtime.getURL(d.url) }));
    },
    id: 'fake-extension-id',
    lastError: undefined,
    onMessage: createEvent(),
    onInstalled: createEvent(),
    getURL: (p) => `chrome-extension://fake-extension-id/${String(p).replace(/^\//, '')}`,
    sent: runtimeSent,
    sendMessage(message, cb) {
      runtimeSent.push({ message: clone(message) });
      const p = (async () => {
        await tick();
        if (!onRuntimeMessage) throw new Error(NO_RECEIVER);
        return onRuntimeMessage(clone(message));
      })();
      if (typeof cb === 'function') {
        p.then(r => cb(r), (err) => {
          runtime.lastError = { message: err.message };
          try { cb(undefined); } finally { runtime.lastError = undefined; }
        });
        return undefined;
      }
      return p;
    }
  };

  const tabsApi = {
    list: tabs,
    sent: tabSent,
    onActivated: createEvent(),
    onUpdated: createEvent(),
    async query() {
      await tick();
      return clone(tabs);
    },
    get(tabId, cb) {
      const tab = tabs.find(t => t.id === tabId);
      const p = tick().then(() => clone(tab));
      if (typeof cb === 'function') { p.then(cb); return undefined; }
      return p;
    },
    sendMessage(tabId, message, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      tabSent.push({ tabId, message: clone(message) });
      const p = (async () => {
        await tick();
        if (!onTabMessage) throw new Error(NO_RECEIVER);
        return onTabMessage(tabId, clone(message));
      })();
      if (typeof cb === 'function') {
        p.then(r => cb(r), (err) => {
          runtime.lastError = { message: err.message };
          try { cb(undefined); } finally { runtime.lastError = undefined; }
        });
        return undefined;
      }
      return p;
    }
  };

  return {
    storage: {
      local: createStorageArea('local', local, onChanged, { latencyMs }),
      session: createStorageArea('session', session, onChanged, { latencyMs }),
      onChanged
    },
    runtime,
    tabs: tabsApi,
    alarms: {
      created: alarms,
      onAlarm: createEvent(),
      create(name, info) { alarms.set(name, { name, ...(info || {}) }); return Promise.resolve(); },
      async get(name) { return alarms.get(name); },
      async clear(name) { return alarms.delete(name); }
    },
    sidePanel: {
      behavior: null,
      async setPanelBehavior(behavior) { this.behavior = behavior; }
    },
    offscreen: {
      documents: offscreenDocuments,
      Reason: { WORKERS: 'WORKERS', DOM_PARSER: 'DOM_PARSER' },
      async createDocument(params) { offscreenDocuments.push(clone(params)); },
      async closeDocument() { offscreenDocuments.length = 0; },
      async hasDocument() { return offscreenDocuments.length > 0; }
    },
    scripting: {
      executed,
      async executeScript(injection) { executed.push(clone(injection)); return []; }
    }
  };
}

/**
 * Installs `fake` as globalThis.chrome.
 *
 * @param {ReturnType<typeof createFakeChrome>} fake
 * @returns {() => void} restores the previous global
 */
export function installFakeChrome(fake) {
  const previous = globalThis.chrome;
  globalThis.chrome = fake;
  return () => {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  };
}

/** Messages of `type` sent to tabs (unwrapped). */
export function tabMessagesOfType(fake, type) {
  return fake.tabs.sent.filter(s => s.message && s.message.type === type);
}

/** Messages of `type` sent through runtime.sendMessage (unwrapped). */
export function runtimeMessagesOfType(fake, type) {
  return fake.runtime.sent.map(s => s.message).filter(m => m && m.type === type);
}
