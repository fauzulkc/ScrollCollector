// Exports from the side panel: JSON (scrollcollector.export/v2) parses and round-trips the items,
// CSV quoting round-trips commas, quotes and line breaks (and defuses formulas), the HTML diary
// escapes markup, hidden-by-prompt posts are included only while shown, and no export carries an
// API key.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchWithExtension, seed, openPanel, waitForStartup, parseCsv, TEST_JEV_KEY, TEST_OPENAI_KEY } from './helpers/ext.mjs';

const XSS = '<img src=x onerror=alert(1)>';
const SCRIPT = '</script><script>alert("x")</script>';

function item(id, n, extra = {}) {
  const at = Date.now() - n * 60000;
  return {
    id,
    postKey: `li:urn:li:activity:71000000000000000${n}`,
    timestamp: at,
    sourcePlatform: 'linkedin.com',
    sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:71000000000000000${n}/`,
    authorName: `Author ${n}`,
    canonicalAuthorName: `Author ${n}`,
    authorUrl: `https://www.linkedin.com/in/author-${n}/`,
    textSnippet: `Plain post ${n} about ramen.`,
    assignedTag: 'Personal Opinion',
    tags: [{ name: 'Personal Opinion', score: 0.81 }, { name: 'Blog', score: 0.4 }],
    isAd: false,
    isFavorite: false,
    favoritedAt: null,
    decision: {
      v: 1, promptVersion: 1, specHash: 'h', path: ['system1'], provider: 'system1', pMatch: 0.9312, matchConfidence: 0.8624,
      tag: 'Personal Opinion', tagConfidence: 0.81, tags: [], escalated: false, uncertain: false, reason: null, collect: true, latencyMs: 4, at
    },
    matchInfo: { engine: 'System 1 (local embeddings)' },
    ...extra
  };
}

const ITEMS = [
  item('x1', 1, { authorName: XSS, canonicalAuthorName: XSS, textSnippet: `${XSS} Ramen night ${SCRIPT}. Broth was great.` }),
  item('x2', 2, { textSnippet: 'Commas, "double quotes", and a\nline break,\r\nplus a CRLF; also ""doubled"" quotes.' }),
  item('x3', 3, { textSnippet: '=HYPERLINK("http://evil.example","click") ramen', isFavorite: true, favoritedAt: Date.now() }),
  item('x4', 4, { textSnippet: 'Escalated ramen post', decision: { ...item('x', 4).decision, path: ['system1', 'jev'], provider: 'jev', escalated: true } }),
  // Hidden by the prompt: exported only while "Hidden by prompt" is shown.
  item('x5', 5, { textSnippet: 'A hurricane forecast, not ramen', hiddenByPrompt: true, decision: { ...item('x', 5).decision, pMatch: 0.02, collect: false } })
];

async function download(page, button) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(button).click()]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
}

function noKeys(text) {
  for (const k of [TEST_JEV_KEY, TEST_OPENAI_KEY, 'SECRET', TEST_JEV_KEY.slice(-4), TEST_OPENAI_KEY.slice(-6)]) {
    expect(text.includes(k), `export contains ${k}`).toBe(false);
  }
}

test('JSON, CSV and HTML exports parse, round-trip, escape, and never contain a key', async () => {
  test.setTimeout(180000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    await seed(sw, {
      configuration: { matchPrompt: 'ramen, and "quotes", too', isMatchPromptEnabled: true, promptVersion: 1 },
      intelligence: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true }, openai: { enabled: true } } },
      secrets: { jev: TEST_JEV_KEY, openai: TEST_OPENAI_KEY },
      stack: ITEMS
    });
    const { page } = await openPanel(ext, { tab: 'stream' });
    await expect(page.locator('#stream-list .item-row')).toHaveCount(4);
    await page.locator('.tab-btn[data-tab="export"]').click();
    await expect(page.locator('#export-note')).toContainText('1 post hidden by your prompt');

    // JSON
    const json = await download(page, '#btn-export-json');
    expect(json.name).toMatch(/\.json$/);
    const doc = JSON.parse(json.text);
    expect(doc).toMatchObject({ schema: 'scrollcollector.export/v2', prompt: 'ramen, and "quotes", too', promptFilterEnabled: true });
    expect(Number.isNaN(Date.parse(doc.exportedAt))).toBe(false);
    expect(doc.items.map((i) => i.id).sort()).toEqual(['x1', 'x2', 'x3', 'x4']);
    for (const exported of doc.items) {
      expect(exported).toEqual(JSON.parse(JSON.stringify(ITEMS.find((i) => i.id === exported.id))));
    }
    expect(json.text).not.toContain('"secrets"');
    noKeys(json.text);

    // CSV: RFC 4180, every field quoted, BOM for spreadsheets.
    const csv = await download(page, '#btn-export-csv');
    expect(csv.name).toMatch(/\.csv$/);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(csv.text.slice(1));
    const header = rows[0];
    expect(header).toEqual(['ID', 'Timestamp', 'Platform', 'Post URL', 'Author', 'Tag', 'Tags', 'P(match)', 'Decided by', 'Confidence', 'Escalated', 'Is Ad', 'Favorite', 'Text']);
    const records = rows.slice(1).filter((r) => r.length > 1);
    expect(records).toHaveLength(4);
    const col = (name) => header.indexOf(name);
    for (const r of records) {
      const src = ITEMS.find((i) => i.id === r[col('ID')]);
      expect(r).toHaveLength(header.length);
      if (src.id === 'x3') {
        // A formula is defused with a leading apostrophe; the rest is verbatim.
        expect(r[col('Text')]).toBe(`'${src.textSnippet}`);
      } else {
        expect(r[col('Text')], src.id).toBe(src.textSnippet);
      }
      expect(r[col('Author')]).toBe(src.authorName);
      expect(r[col('Post URL')]).toBe(src.sourceUrl);
      expect(r[col('Tags')]).toBe('Personal Opinion; Blog');
      expect(r[col('P(match)')]).toBe(String(src.decision.pMatch));
      expect(r[col('Favorite')]).toBe(src.isFavorite ? 'TRUE' : 'FALSE');
      expect(new Date(r[col('Timestamp')]).getTime()).toBe(src.timestamp);
    }
    expect(records.find((r) => r[0] === 'x4')[col('Escalated')]).toBe('TRUE');
    noKeys(csv.text);

    // HTML diary: markup escaped, nothing executable from the posts.
    const html = await download(page, '#btn-export-html');
    expect(html.name).toMatch(/\.html$/);
    expect(html.text).not.toContain(XSS);
    expect(html.text).not.toContain('<script>alert');
    expect(html.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html.text).toContain('Content-Security-Policy');
    noKeys(html.text);
    // Opened in the browser, the diary runs no injected script and shows the four posts.
    const diary = await ext.context.newPage();
    const dialogs = [];
    diary.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    await diary.setContent(html.text);
    await diary.waitForTimeout(500);
    expect(dialogs).toEqual([]);
    expect(await diary.locator('img').count()).toBe(0);
    await diary.close();

    // Showing the hidden posts includes them in the exports.
    await page.locator('.tab-btn[data-tab="stream"]').click();
    await page.locator('#hidden-pill').click();
    await page.locator('.tab-btn[data-tab="export"]').click();
    await expect(page.locator('#export-note')).toBeHidden();
    const all = JSON.parse((await download(page, '#btn-export-json')).text);
    expect(all.items.map((i) => i.id).sort()).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
  } finally {
    await ext.close();
  }
});
