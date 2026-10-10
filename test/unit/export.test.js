/**
 * ui/export.js: CSV (RFC 4180 quoting, formula guard), JSON (scrollcollector.export/v2) and the
 * HTML diary (escaping, safe links, decision line).
 */
import { describe, test, expect } from 'vitest';
import {
  CSV_COLUMNS, EXPORT_SCHEMA, csvField, csvRow, toCsv, buildJsonExport, toJson, toHtmlExport,
  exportFilename, splitTitle, tagNames
} from '../../ui/export.js';

const XSS = '<img src=x onerror=alert(1)>';

function item(overrides = {}) {
  return {
    id: 'id-1',
    postKey: 'li:urn:li:activity:1',
    timestamp: Date.UTC(2026, 9, 10, 12, 0, 0),
    sourcePlatform: 'linkedin.com',
    sourceUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
    authorName: 'Ada Lovelace',
    canonicalAuthorName: 'Ada Lovelace',
    authorUrl: 'https://www.linkedin.com/in/ada/',
    textSnippet: 'Great ramen in Tokyo. The broth was rich.',
    assignedTag: 'Food',
    tags: [{ name: 'Food', score: 0.9 }, { name: 'Travel', score: 0.4 }],
    isAd: false,
    isFavorite: true,
    decision: {
      v: 1, promptVersion: 3, specHash: 'abc', path: ['system1', 'jev'], provider: 'jev',
      pMatch: 0.9234, matchConfidence: 0.8468, tag: 'Food', tagConfidence: 0.61, tags: [],
      escalated: true, uncertain: false, reason: null, collect: true, latencyMs: 312, at: 1
    },
    matchInfo: { engine: 'TypeSafe Jev' },
    ...overrides
  };
}

/** Minimal RFC 4180 parser (quoted fields, "" escapes, CRLF records). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i += 1; continue; }
      field += c; i += 1; continue;
    }
    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    field += c; i += 1;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

describe('csvField', () => {
  test('quotes every field and doubles embedded quotes', () => {
    expect(csvField('plain')).toBe('"plain"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('line1\r\nline2\nline3')).toBe('"line1\r\nline2\nline3"');
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
    expect(csvField(0.5)).toBe('"0.5"');
  });

  test('neutralises spreadsheet formulas but keeps plain numbers', () => {
    expect(csvField('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvField('+1+2')).toBe('"\'+1+2"');
    expect(csvField('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvField('\tcmd')).toBe('"\'\tcmd"');
    expect(csvField('-5')).toBe('"-5"');
    expect(csvField('-5', { guardFormulas: false })).toBe('"-5"');
    expect(csvField('=1', { guardFormulas: false })).toBe('"=1"');
  });
});

describe('toCsv', () => {
  test('header row has the documented columns, records are CRLF-delimited', () => {
    const csv = toCsv([item()]);
    expect(csv.endsWith('\r\n')).toBe(true);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(CSV_COLUMNS).toEqual(['ID', 'Timestamp', 'Platform', 'Post URL', 'Author', 'Tag', 'Tags', 'P(match)',
      'Decided by', 'Confidence', 'Escalated', 'Is Ad', 'Favorite', 'Text']);
    expect(rows).toHaveLength(2);
  });

  test('a record round-trips through an RFC 4180 parser, quotes/commas/newlines included', () => {
    const text = 'He said "wow", then left.\nNew line, more "quotes"';
    const rows = parseCsv(toCsv([item({ textSnippet: text, authorName: 'Doe, "J"', canonicalAuthorName: '' })]));
    const rec = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[1][i]]));
    expect(rec).toMatchObject({
      ID: 'id-1',
      Timestamp: '2026-10-10T12:00:00.000Z',
      Platform: 'linkedin.com',
      'Post URL': 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      Author: 'Doe, "J"',
      Tag: 'Food',
      Tags: 'Food; Travel',
      'P(match)': '0.9234',
      'Decided by': 'TypeSafe Jev',
      Confidence: '0.8468',
      Escalated: 'TRUE',
      'Is Ad': 'FALSE',
      Favorite: 'TRUE',
      Text: text
    });
  });

  test('prefers the canonical author; legacy items leave decision columns blank', () => {
    const legacy = item({ decision: undefined, matchInfo: { engine: 'Rule-based Classifier' }, canonicalAuthorName: 'Ada L.' });
    const row = csvRow(legacy);
    expect(row[4]).toBe('Ada L.');
    expect(row[7]).toBe(''); // P(match)
    expect(row[8]).toBe('Rule-based Classifier');
    expect(row[10]).toBe(''); // Escalated unknown
  });

  test('gate off: confidence falls back to the tag confidence; manual overrides say Manual', () => {
    const gateOff = item({ decision: { ...item().decision, pMatch: null, matchConfidence: null, escalated: false } });
    expect(csvRow(gateOff)[9]).toBe('0.61');
    expect(csvRow(gateOff)[7]).toBe('');
    const manual = item({ matchInfo: { engine: 'Manual Override', manual: true } });
    expect(csvRow(manual)[8]).toBe('Manual');
  });

  test('tags may be strings (old data)', () => {
    expect(tagNames({ tags: ['A', { name: 'B' }, null, { score: 1 }] })).toEqual(['A', 'B']);
  });
});

describe('JSON export', () => {
  test('wraps items with schema, exportedAt, version and prompt', () => {
    const out = buildJsonExport({
      items: [item()],
      configuration: { matchPrompt: 'ramen spots', isMatchPromptEnabled: true, intelligence: { escalation: { provider: 'jev' } } },
      version: '0.9.0',
      now: Date.UTC(2026, 9, 10)
    });
    expect(out).toMatchObject({
      schema: EXPORT_SCHEMA,
      exportedAt: '2026-10-10T00:00:00.000Z',
      version: '0.9.0',
      prompt: 'ramen spots',
      promptFilterEnabled: true
    });
    expect(EXPORT_SCHEMA).toBe('scrollcollector.export/v2');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toEqual(item());
    // Only the prompt is taken from the configuration.
    expect(Object.keys(out).sort()).toEqual(['exportedAt', 'items', 'prompt', 'promptFilterEnabled', 'schema', 'version']);
  });

  test('never includes configuration secrets and parses back', () => {
    const json = toJson({
      items: [item()],
      configuration: { matchPrompt: '', secrets: { openai: 'sk-SECRET-123456789' }, apiKey: 'sk-SECRET-123456789' },
      version: '1',
      now: 0
    });
    expect(json).not.toContain('SECRET');
    const parsed = JSON.parse(json);
    expect(parsed.items[0].id).toBe('id-1');
    expect(parsed.prompt).toBe('');
  });

  test('items are copies (exports cannot mutate the panel state)', () => {
    const it = item();
    const out = buildJsonExport({ items: [it], now: 0 });
    out.items[0].assignedTag = 'X';
    expect(it.assignedTag).toBe('Food');
  });
});

describe('HTML diary', () => {
  test('escapes every collected string', () => {
    const evil = item({
      textSnippet: `${XSS} first sentence. ${XSS} body`,
      authorName: XSS,
      assignedTag: `Tag ${XSS}`,
      sourcePlatform: XSS,
      decision: { ...item().decision, reason: `<script>alert(2)</script>` }
    });
    const html = toHtmlExport({ items: [evil], configuration: { matchPrompt: XSS, isMatchPromptEnabled: true }, version: '0.9.0', now: 0, nonce: 'abc123' });
    expect(html).not.toContain(XSS);
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Exactly one script: the diary's own, with the CSP nonce.
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain("img-src 'none'");
  });

  test('only http(s) URLs become links', () => {
    const html = toHtmlExport({
      items: [item({ sourceUrl: 'javascript:alert(1)', authorUrl: 'data:text/html,<b>x</b>' })],
      now: 0,
      nonce: 'ff'
    });
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/href="data:/i);
    const ok = toHtmlExport({ items: [item()], now: 0, nonce: 'ff' });
    expect(ok).toContain('href="https://www.linkedin.com/feed/update/urn:li:activity:1/"');
    expect(ok).toContain('rel="noopener noreferrer"');
  });

  test('shows the decision line and the prompt', () => {
    const html = toHtmlExport({ items: [item()], configuration: { matchPrompt: 'ramen', isMatchPromptEnabled: false }, now: 0, nonce: 'ff' });
    expect(html).toContain('class="decision-line"');
    expect(html).toContain('Decided by System 1 → TypeSafe Jev (escalated) · p(match) 0.92 · confidence 85% · 312 ms');
    expect(html).toContain('Prompt (filter off)');
    expect(html).toContain('ramen');
  });

  test('tag colors outside the palette format are not injected into style attributes', () => {
    const html = toHtmlExport({ items: [item()], now: 0, nonce: 'ff', tagColor: () => 'red; background:url(x)' });
    expect(html).not.toContain('background:url(x)');
    expect(html).toContain('--tag-color: #71717a');
  });

  test('a bad nonce is replaced', () => {
    const html = toHtmlExport({ items: [], now: 0, nonce: '"><script>' });
    expect(html).not.toContain('"><script>');
    expect(html.match(/<script\b/g)).toHaveLength(1);
  });
});

describe('helpers', () => {
  test('splitTitle mirrors the card title/body split', () => {
    expect(splitTitle('Hello world. More text here')).toEqual({ title: 'Hello world.', body: 'More text here' });
    expect(splitTitle('')).toEqual({ title: '', body: '' });
    const long = 'x'.repeat(80);
    expect(splitTitle(long).title).toBe(`${'x'.repeat(65)}…`);
  });

  test('exportFilename', () => {
    expect(exportFilename('json', 5)).toBe('scrollcollector_export_5.json');
    expect(exportFilename('csv', 5)).toBe('scrollcollector_export_5.csv');
    expect(exportFilename('html', 5)).toBe('scrollcollector_diary_5.html');
  });
});
