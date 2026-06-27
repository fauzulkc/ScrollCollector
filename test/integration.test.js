// @vitest-environment happy-dom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// Load content.js source code once
const contentJsCode = fs.readFileSync(path.resolve(__dirname, '../content.js'), 'utf8');

describe('ScrollCollector content.js Integration Tests', () => {
  let sendMessageMock;

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    
    sendMessageMock = vi.fn();
    
    // Mock the Chrome extension runtime and local storage APIs
    globalThis.chrome = {
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: {
          addListener: vi.fn()
        }
      },
      storage: {
        local: {
          get: vi.fn((key, cb) => {
            const data = {
              configuration: {
                sites: [
                  { id: 's1', domain: 'facebook.com', isEnabled: true },
                  { id: 's2', domain: 'youtube.com', isEnabled: true },
                  { id: 's3', domain: 'linkedin.com', isEnabled: true },
                  { id: 's4', domain: 'x.com', isEnabled: true },
                  { id: 's5', domain: 'medium.com', isEnabled: true },
                  { id: 's6', domain: 'instagram.com', isEnabled: true },
                  { id: 's7', domain: 'gsmarena.com', isEnabled: true }
                ],
                isTrackingPaused: false
              }
            };
            if (cb) cb(data);
            return Promise.resolve(data);
          }),
          set: vi.fn()
        },
        onChanged: {
          addListener: vi.fn()
        }
      }
    };
  });

  test('YouTube integration parses video cards correctly', () => {
    // Mock location URL
    delete globalThis.location;
    globalThis.location = new URL('https://www.youtube.com/feed/subscriptions');

    document.body.innerHTML = `
      <ytd-rich-item-renderer>
        <div id="dismissible">
          <div id="details">
            <h3>
              <a id="video-title-link" href="/watch?v=123">Building an On-Device Neural Network with WebGPU and JavaScript</a>
            </h3>
            <ytd-channel-name>
              <a href="/@webgpudecoded">WebGPU Decoded</a>
            </ytd-channel-name>
            <div id="metadata-line">
              <span>12K views</span>
              <span>3 days ago</span>
            </div>
          </div>
        </div>
      </ytd-rich-item-renderer>
    `;

    // Execute the content script under simulated sandbox environment
    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('On-Device Neural Network');
    expect(postCall[0].payload.text).toContain('WebGPU Decoded');
    expect(postCall[0].payload.sourcePlatform).toContain('youtube.com');
  });

  test('Facebook integration parses standard homepage posts', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://www.facebook.com/');

    document.body.innerHTML = `
      <div role="article" class="fb-post-card">
        <div class="fb-post-header">
          <span class="fb-author">Science News</span>
        </div>
        <div class="fb-post-body">
          <p>Researchers have achieved a breakthrough in room-temperature superconductivity using novel carbon-sulfur-hydrogen compounds at lower pressures than previously thought possible.</p>
        </div>
      </div>
    `;

    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('superconductivity');
    expect(postCall[0].payload.sourcePlatform).toContain('facebook.com');
  });

  test('LinkedIn integration parses posts', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://www.linkedin.com/feed/');

    document.body.innerHTML = `
      <div role="article" class="linkedin-post">
        <div class="li-author">Satya Nadella</div>
        <div class="li-title">CEO at Microsoft</div>
        <div class="li-text">We are entering a new era where coding is collaborative with AI. GitHub Copilot has become the default partner.</div>
      </div>
    `;

    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('Satya Nadella');
    expect(postCall[0].payload.text).toContain('GitHub Copilot');
    expect(postCall[0].payload.sourcePlatform).toContain('linkedin.com');
  });

  test('Twitter/X integration parses tweets', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://x.com/home');

    document.body.innerHTML = `
      <article role="article">
        <div class="tw-author">Elon Musk <span class="tw-handle">@elonmusk</span></div>
        <div class="tw-text">Next SpaceX Falcon Heavy launch is scheduled for Thursday. Super Heavy booster landing will be visible from the beach.</div>
      </article>
    `;

    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('Elon Musk');
    expect(postCall[0].payload.text).toContain('Falcon Heavy');
    expect(postCall[0].payload.sourcePlatform).toContain('x.com');
  });

  test('Medium integration parses article cards correctly', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://medium.com/');

    document.body.innerHTML = `
      <article data-testid="post-preview" aria-label="The Obvious Ways To Spot Someone Secretly Writing With AI">
        <div>
          <a href="/@mattthenomad">Matt Lillywhite</a>
        </div>
        <a href="/the-daily-draft/the-obvious-ways-to-spot-someone-secretly-writing-with-ai-f36ce8d4d715">
          <h2>The Obvious Ways To Spot Someone Secretly Writing With AI</h2>
        </a>
        <p>The biggest giveaways usually have nothing to do with the writing itself.</p>
      </article>
    `;

    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('The Obvious Ways To Spot Someone Secretly Writing With AI');
    expect(postCall[0].payload.text).toContain('The biggest giveaways');
    expect(postCall[0].payload.text).toContain('Matt Lillywhite');
    expect(postCall[0].payload.sourcePlatform).toContain('medium.com');
  });

  test('Instagram integration parses posts correctly', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://www.instagram.com/');

    document.body.innerHTML = `
      <article class="instagram-post">
        <div class="post-header">
          <a href="/orientwatches/" class="username-link">orientwatches</a>
          <span class="suggested-label">• Suggested for you</span>
          <button class="follow-btn">Follow</button>
        </div>
        <div class="post-metrics">
          <span>2.1K likes</span>
          <span>20 comments</span>
        </div>
        <div class="caption-container">
          <a href="/orientwatches/" class="username-link">orientwatches</a>
          <span>Our classic Bambino dress watch arrives with an Arabic numeral index for the very first time. Say hello to the Orient... more</span>
        </div>
      </article>
    `;

    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('Our classic Bambino dress watch');
    expect(postCall[0].payload.text).not.toContain('Suggested for you');
    expect(postCall[0].payload.text).not.toContain('Follow');
    expect(postCall[0].payload.text).not.toContain('2.1K likes');
    expect(postCall[0].payload.sourcePlatform).toContain('instagram.com');
  });

  test('Custom site (GSMArena) heuristic parses feed cards correctly', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://www.gsmarena.com/');

    document.body.innerHTML = `
      <div class="news-item">
        <h3>
          <a href="/deals-prime-day-deals-123.php">Deals: Prime Day shopping is over, here are the best Galaxy S26 and Pixel 10 series deals</a>
        </h3>
        <p class="news-text">The four-day shopping bonanza ended on Friday - now we're back to the regular, no-subscription-required deals.</p>
        <span class="meta-time">2 hours ago</span>
      </div>
    `;

    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('Deals: Prime Day shopping is over');
    expect(postCall[0].payload.text).toContain('The four-day shopping bonanza ended');
    expect(postCall[0].payload.sourcePlatform).toContain('gsmarena.com');
  });
});
