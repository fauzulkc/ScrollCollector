/**
 * LinkedIn post-URN bridge — runs in the PAGE's main world (manifest content_scripts world: "MAIN").
 *
 * The 2026 LinkedIn feed renders post cards without any data-urn or permalink: the post's
 * urn:li:activity:<id> only exists in React props, as state keys such as
 * "reactionsCount-urn:li:activity:<id>" on the social bar or
 * "identitySwitcherActorContext-urn:li:activity:<id>" on the actor. The isolated content script
 * cannot read React props, so it fires a synchronous 'sc:urn-request' event on a card; this
 * listener answers by setting data-sc-urn on that card, which content.js reads and removes.
 *
 * Reads only; never calls page functions, never sends anything anywhere.
 */
(() => {
  if (window.__scLinkedInUrnBridge) return;
  window.__scLinkedInUrnBridge = true;

  const URN_RE = /urn:li:(?:activity|share|ugcPost):\d+/;
  /** State-key contexts that belong to the card's OWN post (social bar, reactions, actor). */
  const OWN_CONTEXT_RE = /(?:^|[^a-z])(reactionsCount|reaction|socialActivity|socialDetail|identitySwitcherActorContext|feedUpdate|updateActions)[A-Za-z]*-urn:li:/i;
  /** Prop names that name the post a control belongs to. */
  const OWN_KEYS = new Set(['selectedReactionStateKey', 'updateUrn']);
  const MAX_ELEMENTS = 400;
  const MAX_DEPTH = 8;
  const MAX_NODES = 4000;

  function propsOf(el) {
    const out = [];
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactProps')) out.push(el[k]);
    }
    return out;
  }

  /**
   * Scans a props tree (children included) and tallies post URNs; own-post contexts are
   * returned as soon as one is found.
   * @returns {{ own: string|null, counts: Map<string, number> }}
   */
  function scanProps(props, counts, budget) {
    const seen = new Set();
    const stack = [[props, 0]];
    while (stack.length && budget.nodes < MAX_NODES) {
      const [obj, depth] = stack.pop();
      if (!obj || typeof obj !== 'object' || seen.has(obj) || obj instanceof Node) continue;
      seen.add(obj);
      budget.nodes += 1;
      let keys;
      try { keys = Object.keys(obj).slice(0, 80); } catch { continue; }
      for (const k of keys) {
        if (k === '_owner' || k === 'return' || k === 'stateNode') continue;
        let v;
        try { v = obj[k]; } catch { continue; }
        if (typeof v === 'string') {
          const m = URN_RE.exec(v);
          if (!m) continue;
          if (OWN_KEYS.has(k) || OWN_CONTEXT_RE.test(v)) return m[0];
          counts.set(m[0], (counts.get(m[0]) || 0) + 1);
        } else if (v && typeof v === 'object' && depth < MAX_DEPTH) {
          stack.push([v, depth + 1]);
        }
      }
    }
    return null;
  }

  function findCardUrn(card) {
    const els = [card, ...card.querySelectorAll('*')];
    const counts = new Map();
    const budget = { nodes: 0 };
    for (let i = 0; i < els.length && i < MAX_ELEMENTS; i++) {
      for (const props of propsOf(els[i])) {
        const own = scanProps(props, counts, budget);
        if (own) return own;
      }
      if (budget.nodes >= MAX_NODES) break;
    }
    // No own-post context: the URN mentioned most often in the card.
    let best = null;
    let bestCount = 0;
    for (const [urn, n] of counts) {
      if (n > bestCount) { best = urn; bestCount = n; }
    }
    return best;
  }

  document.addEventListener('sc:urn-request', (event) => {
    const card = event.target;
    if (!(card instanceof Element)) return;
    try {
      const urn = findCardUrn(card);
      if (urn) card.setAttribute('data-sc-urn', urn);
    } catch {
      // never break the page
    }
  }, true);
})();
