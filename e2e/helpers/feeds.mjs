/**
 * Synthetic feed fixtures for the E2E specs: a LinkedIn-shaped feed builder (the DOM structure of
 * test/fixtures/linkedin-feed.html) and the golden synthetic posts (eval/golden/posts.synthetic.jsonl).
 * Every text is invented; the private export is never used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './launch.mjs';

/** @typedef {{ id: string, text: string, kind: string, primaryTag: string, tags: string[], labels: Record<string, string> }} GoldenPost */

let golden = null;

/** @returns {Map<string, GoldenPost>} golden synthetic posts by id */
export function goldenPosts() {
  if (!golden) {
    golden = new Map();
    const lines = fs.readFileSync(path.join(ROOT, 'eval/golden/posts.synthetic.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const p = JSON.parse(line);
      golden.set(p.id, p);
    }
  }
  return golden;
}

/** @param {string} id */
export function goldenText(id) {
  const p = goldenPosts().get(id);
  if (!p) throw new Error(`unknown golden post ${id}`);
  return p.text;
}

/** @param {string} s */
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Post text as LinkedIn renders it: escaped, line breaks as <br>. @param {string} text */
function textHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/** A LinkedIn activity URN for fixture post `n` of a feed (19 digits, distinct per `series`). */
export function urnFor(series, n) {
  return `urn:li:activity:7${String(series).padStart(3, '0')}${String(n).padStart(15, '0')}`;
}

/** The ingest postKey of a LinkedIn URN. @param {string} urn */
export function keyFor(urn) {
  return `li:${urn}`;
}

/**
 * @typedef {object} FeedPost
 * @property {string} urn          'urn:li:activity:…'
 * @property {string} text         the commentary (full text)
 * @property {string} [author]     actor name (default 'Person <n>')
 * @property {string} [authorSlug] /in/<slug>/ (default person-<n>)
 * @property {number} [truncateAt] render only this many characters plus a "…more" button that reveals the rest
 * @property {{ urn: string, text: string, author?: string }} [reshare]  embedded original (nested mini update)
 * @property {boolean} [promoted]  sponsored (the sub-description says "Promoted")
 */

/**
 * One LinkedIn post (outer data-id wrapper + feed-shared-update-v2[data-urn]).
 * @param {FeedPost} p
 * @param {number} i
 */
export function linkedinPostHtml(p, i) {
  const author = p.author || `Person ${i}`;
  const slug = p.authorSlug || `person-${i}`;
  const truncated = Number.isFinite(p.truncateAt) && p.truncateAt < p.text.length;
  const shown = truncated ? p.text.slice(0, p.truncateAt) : p.text;
  const more = truncated
    ? `<button class="feed-shared-inline-show-more-text__see-more-less-toggle see-more t-14 artdeco-button" type="button" data-full="${escapeHtml(p.text)}"><span class="artdeco-button__text">…more</span></button>`
    : '';
  const reshare = p.reshare
    ? `
        <div class="feed-shared-update-v2__content">
          <div class="update-components-mini-update-v2" data-urn="${p.reshare.urn}">
            <div class="update-components-actor display-flex"><div class="update-components-actor__container display-flex">
              <div class="update-components-actor__meta relative">
                <a class="update-components-actor__meta-link" href="https://www.linkedin.com/company/${escapeHtml((p.reshare.author || 'original').toLowerCase().replace(/[^a-z0-9]+/g, '-'))}/posts/">
                  <span class="update-components-actor__title"><span class="hoverable-link-text"><span dir="ltr"><span aria-hidden="true">${escapeHtml(p.reshare.author || 'Original Author')}</span></span></span></span>
                </a>
              </div>
            </div></div>
            <div class="feed-shared-inline-show-more-text">
              <div class="update-components-text relative" dir="ltr">
                <span class="break-words tvm-parent-container"><span dir="ltr">${textHtml(p.reshare.text)}</span></span>
              </div>
            </div>
            <a class="update-components-mini-update-v2__link-to-details-page" href="https://www.linkedin.com/feed/update/${p.reshare.urn}/"><span class="visually-hidden">View the original post</span></a>
          </div>
        </div>`
    : '';
  return `
    <div><div class="relative" data-id="${p.urn}" data-finite-scroll-hotkey-item="${i}"><div class="full-height">
      <div class="feed-shared-update-v2 full-height relative artdeco-card" role="article" data-urn="${p.urn}">
        <div class="update-components-actor display-flex"><div class="update-components-actor__container display-flex">
          <div class="update-components-actor__meta relative">
            <a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/${escapeHtml(slug)}/">
              <span class="update-components-actor__title"><span dir="ltr"><span aria-hidden="true">${escapeHtml(author)}</span><span class="visually-hidden">${escapeHtml(author)}</span></span></span>
              ${p.promoted ? '<span class="update-components-actor__sub-description"><span aria-hidden="true">Promoted</span></span>' : ''}
            </a>
          </div>
        </div></div>
        <div class="feed-shared-update-v2__description-wrapper">
          <div class="feed-shared-inline-show-more-text feed-shared-update-v2__description" tabindex="-1">
            <div class="update-components-text relative update-components-update-v2__commentary" dir="ltr">
              <span class="break-words tvm-parent-container"><span dir="ltr" class="sc-fixture-text">${textHtml(shown)}</span></span>
            </div>
            ${more}
          </div>
        </div>${reshare}
        <div class="update-v2-social-activity">
          <div class="feed-shared-social-action-bar">
            <button type="button"><span class="artdeco-button__text">Like</span></button>
            <button type="button"><span class="artdeco-button__text">Comment</span></button>
          </div>
        </div>
      </div>
    </div></div></div>`;
}

/**
 * A LinkedIn feed page. The posts container is #sc-feed (posts can be appended later, like infinite
 * scroll). "…more" buttons reveal their data-full text when clicked (a page script, like LinkedIn's).
 * @param {FeedPost[]} posts
 * @param {{ startIndex?: number }} [opts]
 */
export function linkedinFeedHtml(posts, { startIndex = 0 } = {}) {
  const body = posts.map((p, i) => linkedinPostHtml(p, startIndex + i)).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Feed | LinkedIn</title></head>
<body>
<header class="global-nav"><nav aria-label="Primary Navigation"><a href="https://www.linkedin.com/feed/">Home</a></nav></header>
<main class="scaffold-layout__main" id="main">
  <div class="scaffold-finite-scroll__content" id="sc-feed" data-finite-scroll-hotkey-context="FEED">${body}</div>
</main>
<script>
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.see-more');
    if (!btn) return;
    const holder = btn.closest('.feed-shared-inline-show-more-text');
    const span = holder && holder.querySelector('.sc-fixture-text');
    if (span) {
      span.textContent = '';
      btn.dataset.full.split('\\n').forEach((line, i) => {
        if (i > 0) span.appendChild(document.createElement('br'));
        span.appendChild(document.createTextNode(line));
      });
    }
    btn.remove();
  });
</script>
</body></html>`;
}

/**
 * Appends posts to a served feed (infinite scroll): one DOM mutation for the whole batch.
 * @param {import('@playwright/test').Page} page
 * @param {FeedPost[]} posts
 * @param {number} startIndex
 */
export async function appendPosts(page, posts, startIndex) {
  const html = posts.map((p, i) => linkedinPostHtml(p, startIndex + i)).join('\n');
  await page.evaluate((h) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = h;
    document.getElementById('sc-feed').appendChild(tpl.content);
  }, html);
}

/**
 * The 10 short posts of e2e/s1.spec.mjs with their System 1 behaviour for the restaurant prompt
 * (MiniLM): 0-2 are matches (p ~0.98), 3 is uncertain (p ~0.6, below the calibrated floor) and
 * 4-9 are confidently rejected (p < 0.07).
 */
export const SHORT_POSTS = Object.freeze([
  { food: true, text: 'Chef Ingrid Solberg and her team have been awarded a third Michelin star for their tasting menu.' },
  { food: true, text: 'We just opened our new restaurant downtown: a seven-course tasting menu built around local seafood and seasonal vegetables.' },
  { food: true, text: 'Dinner last night at a two Michelin star restaurant in Lyon was unforgettable. The lobster bisque and the souffle were perfect.' },
  { food: true, text: 'Our head chef spent ten years in fine dining kitchens before opening this bistro, and the duck confit is worth the trip.' },
  { food: false, text: 'We are hiring a remote backend engineer to build payment services in Go and Postgres.' },
  { food: false, text: 'Hurricane warning issued for the Gulf Coast as the storm strengthens to Category 4.' },
  { food: false, text: 'Our open-source code review bot just passed 10,000 stars on GitHub.' },
  { food: false, text: 'Thrilled to share that our team just wrapped up a two-day planning offsite.' },
  { food: false, text: 'Great Trips Begin with Good Planning and the Proper Kit Changes Everything.' },
  { food: false, text: 'Is it ever too late to pick up a second language? Most adults think so, and they are wrong.' }
]);
/** Index of the post System 1 is unsure about for the restaurant prompt. */
export const UNCERTAIN_SHORT_POST = 3;
