// @vitest-environment happy-dom
/**
 * content.js post identity, boundaries and "…more" handling, run against fixtures modelled
 * on real feed markup (vm + happy-dom harness, like test/integration.test.js).
 * The fake chrome has NO storage: configuration only arrives via GET_CONTENT_CONFIG.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const CONTENT_JS = fs.readFileSync(path.resolve(__dirname, '../../content.js'), 'utf8');

function fixtureBody(name) {
  const html = fs.readFileSync(path.resolve(__dirname, '../fixtures', name), 'utf8');
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return match ? match[1] : html;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

function teardownContentScript() {
  const instance = globalThis.__scrollCollectorLoaded;
  if (instance && typeof instance.teardown === 'function') instance.teardown();
  delete globalThis.__scrollCollectorLoaded;
}

/** Loads `html` at `url`, installs a storage-less fake chrome and runs content.js. */
function loadPage(url, html, config = {}) {
  delete globalThis.location;
  globalThis.location = new URL(url);
  document.body.innerHTML = html;

  const messages = [];
  const listeners = [];
  const fullConfig = { isTrackingPaused: false, sites: [], ignoredDomains: [], debugAnnotate: false, ...config };
  const fake = {
    runtime: {
      id: 'test-extension',
      sendMessage: vi.fn((message) => {
        messages.push(message);
        if (message.type === 'GET_CONTENT_CONFIG') return Promise.resolve(JSON.parse(JSON.stringify(fullConfig)));
        return Promise.resolve({ status: 'queued', postKey: message.payload && message.payload.postKey });
      }),
      onMessage: {
        addListener: vi.fn(fn => listeners.push(fn)),
        removeListener: vi.fn(fn => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        })
      }
    }
  };
  let storageTouched = false;
  Object.defineProperty(fake, 'storage', { get() { storageTouched = true; return undefined; } });
  globalThis.chrome = fake;

  vm.runInThisContext(CONTENT_JS);

  return {
    extracted: () => messages.filter(m => m.type === 'TEXT_EXTRACTED').map(m => m.payload),
    send: (message) => listeners.map(fn => fn(message, {}, () => {})),
    storageTouched: () => storageTouched
  };
}

const keyed = (postKey) => document.querySelector(`[data-sc-key="${postKey}"]`);

// ─── LinkedIn ────────────────────────────────────────────────────────────────

const LI = {
  michelin: 'urn:li:activity:7301000000000000001',
  company: 'urn:li:activity:7301000000000000002',
  reshare: 'urn:li:activity:7301000000000000003',
  promoted: 'urn:li:ugcPost:7301000000000000444',
  original: 'urn:li:activity:7299000000000000099'
};

const LI_TEXT = {
  michelin:
    'Post by: Amélie Durand (Chef & food writer)\n\n' +
    'Dinner at Maison Aubergine last night, two days after it received its second Michelin star.\n\n' +
    'The langoustine with brown butter and the 24-month comté soufflé were the highlights of the tasting menu',
  company:
    'Post by: Northwind Labs (8,412 followers)\n\n' +
    '𝗦𝗢𝗖 𝟮 𝗶𝗻 𝟯𝟬 𝗱𝗮𝘆𝘀, 𝗻𝗼𝘁 𝟲 𝗺𝗼𝗻𝘁𝗵𝘀.\n\n' +
    'Enterprise buyers keep asking for a SOC 2 report before they sign. Our compliance autopilot collects the evidence from your cloud accounts automatically.\n\n' +
    '#SOC2 #Compliance',
  reshare:
    'Post by: Priya Raman (Language teacher | EdTech)\n\n' +
    'Sharing this because my students ask me every week whether it is too late to start.\n\n' +
    'Reshared from Polyglot Research Institute:\n' +
    'Is it ever too late to pick up a new language? Our ten-year study of 4,000 learners found that adults who practise twenty minutes a day reach conversational fluency faster than teenagers.',
  promoted:
    'Post by: Contoso Cloud (52,108 followers)\n\n' +
    'Cut your cloud bill by a third. Contoso Cloud right-sizes idle instances automatically and shows the savings in one dashboard.'
};

/** One distinctive phrase per post body, plus text that must never leak into a post */
const POST_MARKERS = ['Maison Aubergine', 'compliance autopilot', 'too late to start', 'Cut your cloud bill'];
const FOREIGN_MARKERS = ['ISO 27001', 'Restaurant openings surge', 'Cloud spending slows', 'likes this', '…more', 'Learn more', 'hashtag#'];

describe('content.js identity on a LinkedIn feed', () => {
  let page;

  beforeEach(async () => {
    teardownContentScript();
    page = loadPage('https://www.linkedin.com/feed/', fixtureBody('linkedin-feed.html'));
    await waitFor(() => page.extracted().length >= 4);
  });

  afterEach(() => teardownContentScript());

  test('one dispatch per post with distinct postKeys and /feed/update/<urn>/ permalinks', async () => {
    await sleep(350);
    const items = page.extracted();
    expect(items).toHaveLength(4);

    const keys = items.map(p => p.postKey);
    expect(new Set(keys).size).toBe(4);
    expect(keys.sort()).toEqual(['li:' + LI.michelin, 'li:' + LI.company, 'li:' + LI.reshare, 'li:' + LI.promoted].sort());

    for (const item of items) {
      const urn = item.postKey.slice(3);
      expect(item.postUrl).toBe(`https://www.linkedin.com/feed/update/${urn}/`);
      expect(item.sourceUrl).toBe(item.postUrl);
      expect(item.postUrl).not.toMatch(/\/company\/|\/in\/|\/posts\/?$/);
      expect(item.pageUrl).toBe('https://www.linkedin.com/feed/');
      expect(item.sourcePlatform).toBe('www.linkedin.com');
      expect(item.isUpdate).toBe(false);
      expect(typeof item.timestamp).toBe('number');
      expect(keyed(item.postKey)).not.toBeNull();
    }
    expect(page.storageTouched()).toBe(false);
  });

  test('each text is exactly one post body (no concatenation, no comments or sidebar)', () => {
    const byKey = Object.fromEntries(page.extracted().map(p => [p.postKey, p]));
    expect(byKey['li:' + LI.michelin].text).toBe(LI_TEXT.michelin);
    expect(byKey['li:' + LI.company].text).toBe(LI_TEXT.company);
    expect(byKey['li:' + LI.reshare].text).toBe(LI_TEXT.reshare);
    expect(byKey['li:' + LI.promoted].text).toBe(LI_TEXT.promoted);

    for (const item of page.extracted()) {
      expect(POST_MARKERS.filter(m => item.text.includes(m))).toHaveLength(1);
      for (const foreign of FOREIGN_MARKERS) expect(item.text).not.toContain(foreign);
      expect(item.text.length).toBeLessThanOrEqual(2000);
    }
  });

  test('authorUrl is the actor link (never the post URL) and authorName the visible actor name', () => {
    const byKey = Object.fromEntries(page.extracted().map(p => [p.postKey, p]));
    expect(byKey['li:' + LI.michelin]).toMatchObject({
      authorName: 'Amélie Durand',
      authorUrl: 'https://www.linkedin.com/in/amelie-durand/'
    });
    expect(byKey['li:' + LI.company]).toMatchObject({
      authorName: 'Northwind Labs',
      authorUrl: 'https://www.linkedin.com/company/northwind-labs/'
    });
    expect(byKey['li:' + LI.reshare].authorName).toBe('Priya Raman');
    for (const item of page.extracted()) expect(item.authorUrl).not.toBe(item.postUrl);
  });

  test('a reshare is one post keyed by the outer update; the embedded original is not dispatched', () => {
    const keys = page.extracted().map(p => p.postKey);
    expect(keys).toContain('li:' + LI.reshare);
    expect(keys).not.toContain('li:' + LI.original);
    expect(page.extracted().filter(p => p.text.includes('Is it ever too late to pick up'))).toHaveLength(1);
    expect(document.querySelectorAll('[data-sc-key]')).toHaveLength(4);
  });

  test('promoted post is flagged as an ad and keyed by the canonical ugcPost URN', () => {
    const byKey = Object.fromEntries(page.extracted().map(p => [p.postKey, p]));
    expect(byKey['li:' + LI.promoted].isAd).toBe(true);
    expect(byKey['li:' + LI.michelin].isAd).toBe(false);
    expect(byKey['li:' + LI.company].isAd).toBe(false);
    expect(byKey['li:' + LI.reshare].isAd).toBe(false);
  });

  test('math-bold Unicode text is kept intact', () => {
    const company = page.extracted().find(p => p.postKey === 'li:' + LI.company);
    expect(company.text).toContain('𝗦𝗢𝗖 𝟮 𝗶𝗻 𝟯𝟬 𝗱𝗮𝘆𝘀');
  });

  test('"…more" expansion re-dispatches once with isUpdate, the same postKey and the full text', async () => {
    const post = keyed('li:' + LI.michelin);
    const span = post.querySelector('.update-components-text span[dir="ltr"]');
    span.innerHTML =
      'Dinner at Maison Aubergine last night, two days after it received its second Michelin star.<br><br>' +
      'The langoustine with brown butter and the 24-month comté soufflé were the highlights of the tasting menu. ' +
      'Booking tip: tables open 30 days ahead at 9am and the counter seats are walk-in only.';
    post.querySelector('.feed-shared-inline-show-more-text__see-more-less-toggle').remove();

    await waitFor(() => page.extracted().length === 5);
    await sleep(700);
    const items = page.extracted();
    expect(items).toHaveLength(5);

    const update = items[4];
    expect(update.isUpdate).toBe(true);
    expect(update.postKey).toBe('li:' + LI.michelin);
    expect(update.postUrl).toBe(`https://www.linkedin.com/feed/update/${LI.michelin}/`);
    expect(update.text).toBe(LI_TEXT.michelin + '. Booking tip: tables open 30 days ahead at 9am and the counter seats are walk-in only.');
    expect(update.text).not.toMatch(/more$/);
  });

  test('small DOM changes inside a sent post (< 20 chars) do not re-dispatch', async () => {
    const span = keyed('li:' + LI.company).querySelector('.update-components-text span[dir="ltr"]');
    span.appendChild(document.createTextNode(' ✨'));
    await sleep(700);
    expect(page.extracted()).toHaveLength(4);
  });

  test('a post re-rendered by the platform is not dispatched again and keeps its decision', async () => {
    // Debug mode writes the decision onto the element, so the re-applied copy is visible.
    page.send({ type: 'CONTENT_CONFIG_UPDATED', payload: { isTrackingPaused: false, sites: [], ignoredDomains: [], debugAnnotate: true } });
    page.send({ type: 'DECISION_RESULT', payload: { postKey: 'li:' + LI.company, status: 'rejected', reason: 'prompt_mismatch', pMatch: 0.08 } });
    const original = keyed('li:' + LI.company);
    expect(original.getAttribute('data-sc-status')).toBe('rejected');

    const clone = original.cloneNode(true);
    for (const attr of ['data-sc-key', 'data-scrollcollector-processed', 'data-sc-status', 'data-sc-reason', 'data-sc-pmatch']) {
      clone.removeAttribute(attr);
    }
    const parent = original.parentElement;
    original.remove();
    parent.appendChild(clone);

    await waitFor(() => clone.getAttribute('data-sc-key') === 'li:' + LI.company);
    await sleep(300);
    expect(page.extracted()).toHaveLength(4);
    expect(clone.getAttribute('data-sc-status')).toBe('rejected');
    expect(clone.getAttribute('data-sc-reason')).toBe('prompt_mismatch');
  });

  test('an element recycled for a different post is dispatched as a new post, not an update', async () => {
    const wrapper = keyed('li:' + LI.promoted);
    const update = wrapper.matches('[data-urn]') ? wrapper : wrapper.querySelector('[data-urn]');
    update.setAttribute('data-urn', 'urn:li:activity:7301000000000000006');
    update.querySelector('.update-components-text span[dir="ltr"]').textContent =
      'Completely different post now rendered in the recycled element, about a pastry school opening in Lyon next spring.';

    await waitFor(() => page.extracted().length === 5);
    const recycled = page.extracted()[4];
    expect(recycled.postKey).toBe('li:urn:li:activity:7301000000000000006');
    expect(recycled.isUpdate).toBe(false);
    expect(recycled.text).toContain('pastry school');
    expect(wrapper.getAttribute('data-sc-key')).toBe('li:urn:li:activity:7301000000000000006');
  });

  test('a new post appended to the feed is picked up by the observer', async () => {
    const feed = document.querySelector('.scaffold-finite-scroll__content');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="relative" data-id="urn:li:activity:7301000000000000005">
        <div class="feed-shared-update-v2" role="article" data-urn="urn:li:activity:7301000000000000005">
          <div class="update-components-actor"><a class="update-components-actor__meta-link" href="https://www.linkedin.com/company/harbor-bakery/posts/">
            <span class="update-components-actor__title"><span aria-hidden="true">Harbor Bakery</span></span></a></div>
          <div class="update-components-text"><span dir="ltr">Our croissant dough rests for 72 hours before it is laminated with Normandy butter.</span></div>
        </div>
      </div>`;
    feed.appendChild(wrapper);

    await waitFor(() => page.extracted().length === 5);
    const added = page.extracted()[4];
    expect(added.postKey).toBe('li:urn:li:activity:7301000000000000005');
    expect(added.postUrl).toBe('https://www.linkedin.com/feed/update/urn:li:activity:7301000000000000005/');
    expect(added.authorUrl).toBe('https://www.linkedin.com/company/harbor-bakery/');
    expect(added.text).toBe('Post by: Harbor Bakery\n\nOur croissant dough rests for 72 hours before it is laminated with Normandy butter.');
  });
});

// ─── X ───────────────────────────────────────────────────────────────────────

describe('content.js identity on an X timeline', () => {
  let page;

  beforeEach(async () => {
    teardownContentScript();
    page = loadPage('https://x.com/home', fixtureBody('x-feed.html'));
    await waitFor(() => page.extracted().length >= 3);
    await sleep(300);
  });

  afterEach(() => teardownContentScript());

  test('one dispatch per tweet keyed by status id with canonical /status/ URLs', () => {
    const items = page.extracted();
    expect(items).toHaveLength(3);
    expect(items.map(p => p.postKey)).toEqual([
      'x:1890000000000000001', 'x:1890000000000000002', 'x:1890000000000000003'
    ]);
    expect(items.map(p => p.postUrl)).toEqual([
      'https://x.com/nasa_jpl/status/1890000000000000001',
      'https://x.com/dwhitfield/status/1890000000000000002',
      'https://x.com/acmeanalytics/status/1890000000000000003'
    ]);
  });

  test('a quote tweet is one post with its own text and author', () => {
    const quote = page.extracted().find(p => p.postKey === 'x:1890000000000000002');
    expect(quote.text).toBe('Tweet by: Dana Whitfield @dwhitfield\n\nThis is the most practical explanation of vector databases I have read. Bookmarking it for the whole team.');
    expect(quote.authorName).toBe('Dana Whitfield');
    expect(quote.authorUrl).toBe('https://x.com/dwhitfield');
  });

  test('the lone "Ad" label marks only the promoted tweet', () => {
    expect(page.extracted().map(p => p.isAd)).toEqual([false, false, true]);
  });
});

// ─── Other platforms ─────────────────────────────────────────────────────────

describe('content.js identity on other platforms', () => {
  beforeEach(() => teardownContentScript());
  afterEach(() => teardownContentScript());

  test('Facebook: "See more" is stripped, the expansion is an update of the same post', async () => {
    const page = loadPage('https://www.facebook.com/', `
      <div role="feed">
        <div data-pagelet="FeedUnit_0">
          <div role="article" aria-labelledby="h-1">
            <h3 id="h-1"><span><strong><a href="https://www.facebook.com/bistro.lumiere" role="link">Bistro Lumière</a></strong></span></h3>
            <a href="https://www.facebook.com/bistro.lumiere/posts/pfbid02AbCdEf123?__cft__[0]=AZX&amp;__tn__=%2CO%2CP-R" role="link"><span>2h</span></a>
            <div data-ad-preview="message"><div dir="auto">Our autumn tasting menu starts Friday: wild mushroom velouté, duck with blackberries and a chestnut mont blanc… <div role="button" tabindex="0">See more</div></div></div>
          </div>
        </div>
      </div>`);

    const first = await waitFor(() => page.extracted()[0]);
    expect(first.postKey).toBe('fb:pfbid02AbCdEf123');
    expect(first.postUrl).toBe('https://www.facebook.com/bistro.lumiere/posts/pfbid02AbCdEf123');
    expect(first.text).not.toMatch(/see more/i);
    expect(first.text).toContain('chestnut mont blanc');

    document.querySelector('[dir="auto"]').innerHTML =
      'Our autumn tasting menu starts Friday: wild mushroom velouté, duck with blackberries and a chestnut mont blanc. ' +
      'Six courses, wine pairing optional, and the kitchen counter is bookable for groups of four.';
    await waitFor(() => page.extracted().length === 2);
    const update = page.extracted()[1];
    expect(update).toMatchObject({ postKey: 'fb:pfbid02AbCdEf123', isUpdate: true });
    expect(update.text).toContain('bookable for groups of four');
  });

  test('YouTube: video id key, watch URL, channel name from ytd-channel-name (not the avatar link)', async () => {
    const page = loadPage('https://www.youtube.com/', `
      <ytd-rich-item-renderer>
        <div id="dismissible">
          <a id="thumbnail" href="/watch?v=dQw4w9WgXcQ"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
          <div id="details">
            <a id="avatar-link" href="/@slowfoodlab"><yt-img-shadow><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></yt-img-shadow></a>
            <h3><a id="video-title-link" href="/watch?v=dQw4w9WgXcQ&amp;pp=ygUF">How a three-star kitchen preps 400 covers a night</a></h3>
            <ytd-channel-name><div id="container"><yt-formatted-string id="text"><a href="/@slowfoodlab">Slow Food Lab</a></yt-formatted-string></div></ytd-channel-name>
            <div id="metadata-line"><span>98K views</span><span>1 day ago</span></div>
          </div>
        </div>
      </ytd-rich-item-renderer>`);

    const item = await waitFor(() => page.extracted()[0]);
    expect(item).toMatchObject({
      postKey: 'yt:dQw4w9WgXcQ',
      postUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      authorName: 'Slow Food Lab',
      authorUrl: 'https://www.youtube.com/@slowfoodlab'
    });
  });

  test('Hacker News: tr.athing id gives the item URL', async () => {
    const page = loadPage('https://news.ycombinator.com/', `
      <table><tbody>
        <tr class="athing submission" id="41234567"><td class="title"><span class="titleline"><a href="https://example.com/llm-inference">Running LLM inference on a phone at 20 tokens per second</a></span></td></tr>
        <tr><td class="subtext"><a href="user?id=pgdev" class="hnuser">pgdev</a> <span class="age"><a href="item?id=41234567">2 hours ago</a></span></td></tr>
      </tbody></table>`);

    const item = await waitFor(() => page.extracted()[0]);
    expect(item).toMatchObject({
      postKey: 'hn:41234567',
      postUrl: 'https://news.ycombinator.com/item?id=41234567',
      authorName: 'pgdev',
      authorUrl: 'https://news.ycombinator.com/user?id=pgdev'
    });
    // The author travels only as authorName: a cloud provider sees it only when the user allows it.
    expect(item.text).toBe('Running LLM inference on a phone at 20 tokens per second');
  });

  test('Medium: title + subtitle as the text, the author only as authorName', async () => {
    const page = loadPage('https://medium.com/', `
      <article>
        <a href="/@janeqdoe?source=home">Jane Q. Doe</a>
        <a href="https://medium.com/@janeqdoe/how-i-bake-sourdough-at-home-3f9a2b7c1d4e"><h2>How I bake sourdough at home</h2></a>
        <p>A beginner guide to starters, hydration and the first loaf</p>
      </article>`);

    const item = await waitFor(() => page.extracted()[0]);
    expect(item).toMatchObject({
      postKey: 'md:3f9a2b7c1d4e',
      authorName: 'Jane Q. Doe',
      authorUrl: 'https://medium.com/@janeqdoe?source=home'
    });
    expect(item.text).toBe('How I bake sourdough at home A beginner guide to starters, hydration and the first loaf');
    expect(item.text).not.toMatch(/By:|Jane/);
  });

  test('generic site: text-hash keys, URL only from inside the post, list wrappers are not posts', async () => {
    const page = loadPage('https://blog.example.org/', `
      <div class="post-list">
        <article class="entry">
          <h2><a href="/2026/10/sourdough-starter-guide">A beginner's guide to keeping a sourdough starter alive</a></h2>
          <p>Feed it twice a day, keep it somewhere warm and discard half of it before every feeding... more</p>
        </article>
        <article class="entry">
          <h2>Notes from the farmers market</h2>
          <p>No link in this one: heirloom tomatoes, late figs and the first quinces of the season were everywhere this Saturday morning.</p>
        </article>
      </div>`, { sites: [{ domain: 'blog.example.org', isEnabled: true }] });

    await waitFor(() => page.extracted().length >= 2);
    await sleep(300);
    const items = page.extracted();
    expect(items).toHaveLength(2);

    const [linked, unlinked] = items;
    expect(linked.postKey).toMatch(/^t:[0-9a-z]+$/);
    expect(unlinked.postKey).toMatch(/^t:[0-9a-z]+$/);
    expect(linked.postKey).not.toBe(unlinked.postKey);
    expect(linked.postUrl).toBe('https://blog.example.org/2026/10/sourdough-starter-guide');
    expect(unlinked.postUrl).toBe('');
    expect(linked.text).toContain('sourdough starter');
    expect(linked.text).not.toMatch(/more$/);
    expect(unlinked.text).toContain('farmers market');
    expect(unlinked.text).not.toContain('sourdough');
    expect(document.querySelector('.post-list').hasAttribute('data-sc-key')).toBe(false);
  });

  test('generic site: class-based cards are whole posts (header + body), their feed wrapper is not', async () => {
    const card = (slug, title, body) => `
      <div class="post-container">
        <div class="post-header"><a href="/2026/10/${slug}">${title}</a></div>
        <div class="post-body"><p>${body}</p></div>
      </div>`;
    const page = loadPage('https://recipes.example.net/', `
      <div class="post-feed">
        <h1>Latest</h1>
        ${card('fig-tart', 'Fig and frangipane tart for the last warm weekend', 'Blind-bake the shell, spread the frangipane thinly and fan the figs so the juices caramelise at the edges.')}
        ${card('miso-soup', 'A ten-minute miso soup for busy weeknights', 'Dissolve the miso off the heat so it keeps its aroma, then add silken tofu and a handful of wakame.')}
      </div>`, { sites: [{ domain: '*', isEnabled: true }] });

    await waitFor(() => page.extracted().length >= 2);
    await sleep(300);
    const items = page.extracted();
    expect(items).toHaveLength(2);
    expect(items[0].text).toContain('Fig and frangipane tart');
    expect(items[0].text).toContain('fan the figs');
    expect(items[0].text).not.toContain('miso');
    expect(items[0].postUrl).toBe('https://recipes.example.net/2026/10/fig-tart');
    expect(items[1].text).toContain('ten-minute miso soup');
    expect(items[1].text).toContain('silken tofu');
    expect(items[1].postUrl).toBe('https://recipes.example.net/2026/10/miso-soup');
    expect(document.querySelectorAll('.post-container[data-sc-key]')).toHaveLength(2);
  });
});
