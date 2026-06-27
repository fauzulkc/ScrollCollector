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
                  { id: 's5', domain: 'medium.com', isEnabled: true }
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
            <a id="video-title-link" href="https://www.youtube.com/watch?v=techYt1">
              <yt-formatted-string id="video-title" class="yt-title">Building an On-Device Neural Network with WebGPU and JavaScript</yt-formatted-string>
            </a>
            <ytd-channel-name>
              <div id="container"><a href="/@techExplained" class="yt-channel">Tech Explained Channel</a></div>
            </ytd-channel-name>
            <div id="metadata-line"><span>120K views • 3 days ago</span></div>
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
    expect(postCall[0].payload.text).toContain('Building an On-Device Neural Network');
    expect(postCall[0].payload.text).toContain('Tech Explained Channel');
    expect(postCall[0].payload.sourcePlatform).toContain('youtube.com');
  });

  test('Facebook integration parses standard homepage posts', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://www.facebook.com/');

    document.body.innerHTML = `
      <div class="facebook-post" role="article" data-pagelet="FeedUnit_1">
        <h2><a role="link" href="#" class="fb-author"><strong>Science & Tech Journal</strong></a></h2>
        <div data-ad-preview="message" class="fb-caption">Researchers have achieved a breakthrough in room-temperature superconductivity using a carbonaceous sulfur hydride material under high pressure. This could revolutionize power grids.</div>
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

  test('Medium integration parses text density blocks', () => {
    delete globalThis.location;
    globalThis.location = new URL('https://medium.com/');

    document.body.innerHTML = `
      <div class="article-card">
        <div class="author-line">Alex Jenkins in Towards Data Science</div>
        <h2 class="article-title">How we optimized our local transformer performance by 300% using quantization</h2>
        <p class="article-snippet">Optimizing large language models for client-side web applications has always been a bottleneck. In this guide, we dive into INT8 and INT4 quantization techniques on-device.</p>
        <span class="read-time">5 min read</span>
      </div>
    `;

    vm.runInThisContext(contentJsCode);

    expect(sendMessageMock).toHaveBeenCalled();
    const calls = sendMessageMock.mock.calls;
    const postCall = calls.find(c => c[0].type === 'TEXT_EXTRACTED');
    expect(postCall).toBeDefined();
    expect(postCall[0].payload.text).toContain('Alex Jenkins');
    expect(postCall[0].payload.text).toContain('quantization');
    expect(postCall[0].payload.sourcePlatform).toContain('medium.com');
  });
});
