/**
 * Exports of the collected stack: CSV (RFC 4180), JSON (scrollcollector.export/v2) and a
 * self-contained HTML diary.
 *
 * Only stack items and the prompt text are exported. Configuration secrets (API keys) never reach
 * the side panel, and nothing here reads them.
 *
 * Safety:
 *  - CSV: every field is quoted ("" doubles quotes); cells that a spreadsheet would run as a
 *    formula (=, +, -, @, tab, CR at the start) get a leading apostrophe.
 *  - HTML: all collected text is escaped, only http(s) URLs become links, and the diary carries a
 *    CSP that lets only its own (nonce'd) script run and loads no images.
 */
import { escapeHTML, safeHttpUrl } from './util.js';
import { decidedBy, decisionFacts, decisionLine, primaryConfidence } from './decision-info.js';

export const EXPORT_SCHEMA = 'scrollcollector.export/v2';

export const CSV_COLUMNS = Object.freeze([
  'ID', 'Timestamp', 'Platform', 'Post URL', 'Author', 'Tag', 'Tags', 'P(match)', 'Decided by',
  'Confidence', 'Escalated', 'Is Ad', 'Favorite', 'Text'
]);

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/;

/**
 * One RFC 4180 field, always quoted.
 * @param {unknown} value
 * @param {{ guardFormulas?: boolean }} [opts]
 */
export function csvField(value, { guardFormulas = true } = {}) {
  let s = value === null || value === undefined ? '' : String(value);
  if (guardFormulas && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** @param {any} item */
export function authorOf(item) {
  return (item && (item.canonicalAuthorName || item.authorName)) || '';
}

/**
 * Tag names of an item; item.tags holds { name, score } objects (or strings in old data).
 * @param {any} item
 * @returns {string[]}
 */
export function tagNames(item) {
  const tags = item && Array.isArray(item.tags) ? item.tags : [];
  return tags
    .map((t) => (typeof t === 'string' ? t : t && typeof t.name === 'string' ? t.name : ''))
    .filter(Boolean);
}

/** @param {unknown} ts */
function isoTime(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
}

/** @param {unknown} v */
const bool = (v) => (v ? 'TRUE' : 'FALSE');

/**
 * Values of one CSV record, in CSV_COLUMNS order.
 * @param {any} item
 * @returns {string[]}
 */
export function csvRow(item) {
  const f = decisionFacts(item);
  const conf = primaryConfidence(f);
  return [
    item.id ?? '',
    isoTime(item.timestamp),
    item.sourcePlatform || '',
    item.sourceUrl || '',
    authorOf(item),
    item.assignedTag || 'Unclassified',
    tagNames(item).join('; '),
    f.pMatch === null ? '' : String(Math.round(f.pMatch * 10000) / 10000),
    decidedBy(item),
    conf === null ? '' : String(Math.round(conf * 10000) / 10000),
    f.kind === 'decision' ? bool(f.escalated) : '',
    bool(item.isAd),
    bool(item.isFavorite),
    item.textSnippet || ''
  ].map((v) => String(v));
}

/**
 * @param {any[]} items
 * @param {{ guardFormulas?: boolean }} [opts]
 * @returns {string} CRLF-delimited records with a header row
 */
export function toCsv(items, opts) {
  const lines = [CSV_COLUMNS.map((c) => csvField(c, opts)).join(',')];
  for (const item of items || []) {
    if (item && typeof item === 'object') lines.push(csvRow(item).map((v) => csvField(v, opts)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * @param {{ items: any[], configuration?: any, version?: string, now?: number }} input
 */
export function buildJsonExport({ items, configuration, version, now = Date.now() }) {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  return {
    schema: EXPORT_SCHEMA,
    exportedAt: new Date(now).toISOString(),
    version: typeof version === 'string' ? version : '',
    prompt: typeof cfg.matchPrompt === 'string' ? cfg.matchPrompt : '',
    promptFilterEnabled: !!cfg.isMatchPromptEnabled,
    items: (items || []).filter((i) => i && typeof i === 'object').map((i) => JSON.parse(JSON.stringify(i)))
  };
}

/**
 * @param {{ items: any[], configuration?: any, version?: string, now?: number }} input
 * @returns {string}
 */
export function toJson(input) {
  return JSON.stringify(buildJsonExport(input), null, 2);
}

/** @param {unknown} c */
function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#71717a';
}

/** @returns {string} */
function randomNonce() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Title (first sentence) and body of a post, like the side panel cards.
 * @param {unknown} text
 */
export function splitTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { title: '', body: '' };
  const m = clean.match(/^.*?[.!?](?:\s|$)/);
  if (m) {
    const title = m[0].trim();
    return { title, body: clean.slice(title.length).trim() };
  }
  if (clean.length > 70) return { title: `${clean.slice(0, 65)}…`, body: clean };
  return { title: clean, body: '' };
}

/**
 * @param {any} item
 * @param {(tag: string) => string} tagColor
 */
function htmlCard(item, tagColor) {
  const { title, body } = splitTitle(item.textSnippet);
  const tag = item.assignedTag || 'Unclassified';
  const color = safeColor(tagColor(tag));
  const platform = item.sourcePlatform || 'unknown';
  const ts = Number(item.timestamp);
  const when = Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleString() : '';
  const url = safeHttpUrl(item.sourceUrl);
  let host = '';
  try {
    host = url ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    host = '';
  }
  const link = url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" class="card-link">${escapeHTML(host)} ↗</a>` : '';
  const author = item.authorName || '';
  const authorUrl = safeHttpUrl(item.authorUrl);
  let authorHtml = '';
  if (author) {
    authorHtml = authorUrl
      ? `<a href="${escapeHTML(authorUrl)}" target="_blank" rel="noopener noreferrer" class="card-author-pill">@${escapeHTML(author)}</a>`
      : `<span class="card-author-pill">@${escapeHTML(author)}</span>`;
  }
  const line = decisionLine(item);
  return `
      <div class="card" data-category="${escapeHTML(tag)}" data-favorite="${item.isFavorite ? 'true' : 'false'}" data-ad="${item.isAd ? 'true' : 'false'}">
        <div class="card-header">
          <span class="platform">${escapeHTML(platform)}</span>
          ${link}
          ${authorHtml}
          <span class="time">${escapeHTML(when)}</span>
          ${item.isAd ? '<span class="ad-badge">Ad</span>' : ''}
          ${item.isFavorite ? '<span class="fav-indicator">Favorite</span>' : ''}
        </div>
        <div class="card-title">${escapeHTML(title)}</div>
        ${body ? `<div class="card-body">${escapeHTML(body)}</div>` : ''}
        <div class="card-footer">
          <span class="card-category" style="--tag-color: ${color}"><span class="cat-dot"></span>${escapeHTML(tag)}</span>
          ${line ? `<span class="decision-line">${escapeHTML(line)}</span>` : ''}
        </div>
      </div>`;
}

/**
 * Self-contained HTML diary (search + filters, light/dark), every collected string escaped.
 * @param {{ items: any[], configuration?: any, version?: string, now?: number, tagColor?: (tag: string) => string, nonce?: string }} input
 * @returns {string}
 */
export function toHtmlExport({ items, configuration, version = '', now = Date.now(), tagColor = () => '#71717a', nonce = randomNonce() }) {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  const list = (items || []).filter((i) => i && typeof i === 'object');
  const cards = list.map((item) => htmlCard(item, tagColor)).join('\n');
  const prompt = typeof cfg.matchPrompt === 'string' ? cfg.matchPrompt.trim() : '';
  const safeNonce = /^[0-9a-f]+$/i.test(nonce) ? nonce : randomNonce();
  const promptHtml = prompt
    ? `<p class="meta">Prompt${cfg.isMatchPromptEnabled ? '' : ' (filter off)'}: <span class="prompt">${escapeHTML(prompt)}</span></p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${safeNonce}'; img-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="generator" content="ScrollCollector ${escapeHTML(version)}">
  <title>ScrollCollector — Personal Feed Diary</title>
  <style>
    :root { --bg:#09090b; --bg-elevated:#131316; --bg-hover:#1e1e22; --text-primary:#f4f4f5; --text-secondary:#a1a1aa; --text-muted:#52525b; --border:#202024; --accent:#6366f1; }
    body.light-theme { --bg:#fafafa; --bg-elevated:#ffffff; --bg-hover:#f4f4f5; --text-primary:#09090b; --text-secondary:#71717a; --text-muted:#a1a1aa; --border:#e4e4e7; --accent:#4f46e5; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text-primary); padding: 40px 24px; line-height: 1.5; }
    .container { max-width: 800px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 20px; }
    h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
    .meta { font-size: 12px; color: var(--text-secondary); margin-bottom: 20px; }
    .prompt { color: var(--text-primary); font-style: italic; }
    .theme-toggle { background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .theme-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }
    .controls { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
    .search-input { width: 100%; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-primary); padding: 10px 16px; border-radius: 8px; font-size: 14px; outline: none; }
    .search-input:focus { border-color: var(--accent); }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; }
    .filter-btn { background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border); padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; cursor: pointer; }
    .filter-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .filter-btn.active { background: var(--accent); color: #ffffff; border-color: var(--accent); }
    .cards-list { display: flex; flex-direction: column; gap: 16px; }
    .card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px; padding: 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); }
    .card-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 11px; color: var(--text-secondary); margin-bottom: 12px; }
    .platform { font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .card-link { color: var(--accent); text-decoration: none; }
    .card-link:hover { text-decoration: underline; }
    .time { color: var(--text-muted); margin-left: auto; }
    .fav-indicator { background: rgba(236,72,153,0.12); color: #ec4899; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
    .ad-badge { background: rgba(239,68,68,0.15); color: #ef4444; padding: 2px 6px; border-radius: 4px; font-weight: 700; }
    .card-author-pill { font-size: 11px; color: var(--text-primary); background: var(--bg-hover); border: 1px solid var(--border); padding: 2px 8px; border-radius: 12px; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; display: inline-block; }
    .card-title { font-size: 16px; font-weight: 700; line-height: 1.4; margin-bottom: 8px; overflow-wrap: anywhere; }
    .card-body { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .card-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; border-top: 1px solid var(--border); padding-top: 12px; }
    .card-category { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; }
    .cat-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tag-color, var(--text-muted)); }
    .decision-line { font-size: 11px; color: var(--text-muted); }
    .no-results { text-align: center; padding: 40px; color: var(--text-muted); font-style: italic; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>ScrollCollector Diary</h1>
      <button class="theme-toggle" id="theme-btn" type="button">Light Theme</button>
    </header>
    <p class="meta">${list.length} post${list.length === 1 ? '' : 's'} · exported ${escapeHTML(new Date(now).toLocaleString())}</p>
    ${promptHtml}
    <div class="controls">
      <input type="text" id="search" class="search-input" placeholder="Search posts, authors, sites…">
      <div class="filters" id="filters-container">
        <button class="filter-btn active" data-filter="all" type="button">All</button>
        <button class="filter-btn" data-filter="favorites" type="button">Favorites</button>
        <button class="filter-btn" data-filter="ads" type="button">Ads</button>
      </div>
    </div>
    <div class="cards-list" id="cards-wrapper">
${cards}
      <div class="no-results" id="no-results-msg">No matching posts found.</div>
    </div>
  </div>
  <script nonce="${safeNonce}">
    (function () {
      var searchInput = document.getElementById('search');
      var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
      var filtersContainer = document.getElementById('filters-container');
      var noResults = document.getElementById('no-results-msg');
      var themeBtn = document.getElementById('theme-btn');
      themeBtn.addEventListener('click', function () {
        var isLight = document.body.classList.toggle('light-theme');
        themeBtn.textContent = isLight ? 'Dark Theme' : 'Light Theme';
      });
      var categories = [];
      cards.forEach(function (card) {
        var cat = card.dataset.category;
        if (cat && cat !== 'Ads' && cat !== 'Unclassified' && categories.indexOf(cat) === -1) categories.push(cat);
      });
      categories.forEach(function (cat) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'filter-btn';
        btn.dataset.filter = 'tag:' + cat;
        btn.textContent = cat;
        filtersContainer.appendChild(btn);
      });
      var activeFilter = 'all';
      var allFilters = Array.prototype.slice.call(document.querySelectorAll('.filter-btn'));
      allFilters.forEach(function (btn) {
        btn.addEventListener('click', function () {
          allFilters.forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          activeFilter = btn.dataset.filter;
          apply();
        });
      });
      searchInput.addEventListener('input', apply);
      function apply() {
        var q = searchInput.value.toLowerCase().trim();
        var shown = 0;
        cards.forEach(function (card) {
          var ok = activeFilter === 'all'
            || (activeFilter === 'favorites' && card.dataset.favorite === 'true')
            || (activeFilter === 'ads' && card.dataset.ad === 'true')
            || activeFilter === 'tag:' + card.dataset.category;
          if (ok && q) ok = card.textContent.toLowerCase().indexOf(q) !== -1;
          card.style.display = ok ? 'block' : 'none';
          if (ok) shown++;
        });
        noResults.style.display = shown === 0 ? 'block' : 'none';
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * @param {'json'|'csv'|'html'} kind
 * @param {number} [now]
 */
export function exportFilename(kind, now = Date.now()) {
  return kind === 'html' ? `scrollcollector_diary_${now}.html` : `scrollcollector_export_${now}.${kind}`;
}

export const EXPORT_MIME = Object.freeze({
  json: 'application/json',
  csv: 'text/csv;charset=utf-8',
  html: 'text/html;charset=utf-8'
});

/**
 * Starts a download of `content` (a Blob URL clicked through a temporary anchor).
 * @param {string} content
 * @param {string} filename
 * @param {string} mime
 * @param {{ doc?: Document }} [opts]
 */
export function downloadText(content, filename, mime, { doc = globalThis.document } = {}) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
