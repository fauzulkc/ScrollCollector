/**
 * Mock decision server for E2E and provider tests: speaks TypeSafe Jev's /v1/systemone and the
 * OpenAI Chat Completions / Responses shapes, with injectable faults.
 *
 *   import { startMockDecisionServer } from './mock-decision-server.mjs';
 *   const mock = await startMockDecisionServer();          // { url, close, setMode, log, clearLog }
 *   // Jev baseUrl: mock.url           OpenAI baseUrl: `${mock.url}/v1` (or mock.url)
 *
 * CLI: node e2e/mock-decision-server.mjs [--port 8787]
 *
 * Routes
 *   POST /v1/systemone                         Jev: { model, state: { platform, post, author? }, questions }
 *   POST /v1/chat/completions, /chat/completions   OpenAI chat; honors response_format.json_schema
 *   POST /v1/responses, /responses             OpenAI Responses API; honors text.format.json_schema
 *   GET  /v1/models, /models
 *   POST /__control { mode, retryAfter?, delayMs?, count? }   fault injection (see MODES)
 *   GET  /__log                                requests seen: auth recorded only as present/absent
 *   POST /__reset                              mode 'ok', empty log
 *
 * Answers are deterministic keyword rules: food words (food, restaurant, michelin, chef, …) make
 * matches_prompt-style nouls ~0.93, otherwise ~0.07; tag nouls / choices pick the option whose
 * label words appear in the post (food posts prefer a food-like option), else 'none'.
 *
 * The log keeps the post text (fixtures only) and whether an Authorization header was present —
 * never its value. CORS is permissive (extension service workers and pages can call it).
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Fault modes for POST /__control. */
export const MODES = Object.freeze(['ok', '401', '422', '429', '529', 'slow', 'malformed', 'schema400', 'echo401']);

const FOOD_RE = /\b(?:food|foods|restaurants?|michelin|chefs?|cook(?:s|ed|ing)?|cuisine|culinary|dish(?:es)?|menu|tasting|dining|dinner|lunch|breakfast|meal|ramen|sushi|bistro|kitchen|recipe|bakery|croissants?|sourdough|pastry|wine|eat(?:s|ing)?)\b/i;
const FOOD_OPTION_RE = /food|restaurant|cook|culinary|cuisine|dining|michelin|recipe/i;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LOG = 500;

/** @param {string} text */
function isFood(text) {
  return FOOD_RE.test(text || '');
}

/**
 * @param {string} label
 * @param {string} text
 */
function labelMatches(label, text) {
  const words = String(label || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const t = String(text || '').toLowerCase();
  return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t));
}

/**
 * P(yes) for a noul. Tag nouls ('tag:Food', 'tag_Food') check the label; everything else is the
 * "matches the food prompt" rule.
 * @param {string} key
 * @param {string} post
 */
function noulP(key, post) {
  const m = /^tag[:_](.+)$/i.exec(key);
  if (m) return labelMatches(m[1], post) || (isFood(post) && FOOD_OPTION_RE.test(m[1])) ? 0.9 : 0.1;
  return isFood(post) ? 0.93 : 0.07;
}

/**
 * @param {string[]} options   including 'none'
 * @param {string} post
 */
function pickOption(options, post) {
  const real = options.filter((o) => o !== 'none');
  let pick = null;
  if (isFood(post)) pick = real.find((o) => FOOD_OPTION_RE.test(o)) || null;
  if (!pick) pick = real.find((o) => labelMatches(o, post)) || null;
  return pick || (options.includes('none') ? 'none' : options[0]);
}

/**
 * Answers keyed like the request for a set of question specs.
 * @param {{ key: string, kind: 'noul'|'choice', options?: string[] }[]} specs
 * @param {string} post
 */
function answerSpecs(specs, post) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const s of specs) {
    if (s.kind === 'noul') {
      out[s.key] = { probability: noulP(s.key, post) };
    } else {
      const choice = pickOption(s.options || ['none'], post);
      out[s.key] = { choice, confidence: choice === 'none' ? 0.6 : 0.9 };
    }
  }
  return out;
}

/** Question specs from a JSON schema with one property per question. @param {any} schema */
function specsFromSchema(schema) {
  const specs = [];
  for (const [key, prop] of Object.entries(schema?.properties || {})) {
    const p = /** @type {any} */ (prop)?.properties || {};
    if (p.probability) specs.push({ key, kind: 'noul' });
    else if (p.choice) specs.push({ key, kind: 'choice', options: Array.isArray(p.choice.enum) ? p.choice.enum : ['none'] });
  }
  return specs;
}

/**
 * Question specs parsed from the rendered prompt (json_object fallback, no schema):
 *   1. "matches_prompt" (yes/no): …
 *   2. "primary_tag" (pick one option): …   followed by   - "Label": …
 * @param {string} prompt
 */
function specsFromPrompt(prompt) {
  const specs = [];
  let current = null;
  for (const line of String(prompt || '').split('\n')) {
    const q = /^\d+\.\s+"([^"]+)"\s+\((yes\/no|pick one option)\)/.exec(line);
    if (q) {
      current = { key: q[1], kind: q[2] === 'yes/no' ? 'noul' : 'choice', options: [] };
      specs.push(current);
      continue;
    }
    const o = /^\s+-\s+"([^"]+)"/.exec(line);
    if (o && current && current.kind === 'choice') current.options.push(o[1]);
  }
  return specs;
}

/** @param {string} content */
function postFromPrompt(content) {
  const m = /<post>\n?([\s\S]*?)\n?<\/post>/i.exec(String(content || ''));
  return m ? m[1] : String(content || '');
}

/** Text of the last user message (string or content parts). @param {any} messages */
function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : typeof messages === 'string' ? [{ role: 'user', content: messages }] : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    }
  }
  return '';
}

/** @param {string} s */
function tokens(s) {
  return Math.max(1, Math.ceil(String(s || '').length / 4));
}

/**
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   close: () => Promise<void>,
 *   setMode: (mode: string, opts?: { retryAfter?: number, delayMs?: number, count?: number }) => void,
 *   log: () => object[],
 *   clearLog: () => void
 * }>}
 */
export async function startMockDecisionServer({ port = 0, host = '127.0.0.1' } = {}) {
  /** @type {{ mode: string, retryAfter: number|null, delayMs: number, count: number|null }} */
  let control = { mode: 'ok', retryAfter: 1, delayMs: 3000, count: null };
  /** @type {object[]} */
  let entries = [];

  /** @param {string} mode @param {{ retryAfter?: number, delayMs?: number, count?: number }} [o] */
  function setMode(mode, o = {}) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
    control = {
      mode,
      retryAfter: Number.isFinite(o.retryAfter) ? Number(o.retryAfter) : 1,
      delayMs: Number.isFinite(o.delayMs) ? Number(o.delayMs) : 3000,
      count: Number.isFinite(o.count) && Number(o.count) > 0 ? Math.floor(Number(o.count)) : null
    };
  }

  /** The fault for this request (consumes one of `count`). */
  function takeFault() {
    const c = control;
    if (c.mode === 'ok') return c;
    if (c.count !== null) {
      c.count -= 1;
      if (c.count <= 0) control = { ...c, mode: 'ok', count: null };
    }
    return c;
  }

  /** @param {http.ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
  function send(res, status, body, headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...cors(), ...headers });
    res.end(text);
  }

  function cors() {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, accept',
      'access-control-allow-private-network': 'true',
      'access-control-expose-headers': 'retry-after, retry-after-ms',
      // The extension runs cross-origin isolated (COEP require-corp).
      'cross-origin-resource-policy': 'cross-origin'
    };
  }

  /** @param {http.IncomingMessage} req */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** @param {object} entry */
  function record(entry) {
    entries.push({ at: Date.now(), ...entry });
    if (entries.length > MAX_LOG) entries = entries.slice(-MAX_LOG);
  }

  /**
   * Applies a fault mode; returns true when the response was sent.
   * @param {http.ServerResponse} res
   * @param {ReturnType<typeof takeFault>} fault
   * @param {{ token: string, usesSchema: boolean }} ctx
   */
  async function applyFault(res, fault, ctx) {
    switch (fault.mode) {
      case '401':
        send(res, 401, { error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 'invalid_api_key' } });
        return true;
      case 'echo401':
        // Echoes the bearer token back, so tests can prove the client redacts it.
        send(res, 401, { error: { message: `Incorrect API key provided: ${ctx.token}`, type: 'invalid_request_error' } });
        return true;
      case '422':
        send(res, 422, { error: { message: 'Unprocessable request: the questions are invalid.', type: 'invalid_request_error' } });
        return true;
      case '429':
        send(res, 429, { error: { message: 'Rate limit exceeded.', type: 'rate_limit_error' } }, { 'retry-after': String(fault.retryAfter ?? 1) });
        return true;
      case '529':
        send(res, 529, { error: { message: 'Overloaded.', type: 'overloaded_error' } });
        return true;
      case 'malformed':
        send(res, 200, '{"answers": {not json');
        return true;
      case 'schema400':
        if (!ctx.usesSchema) return false;
        send(res, 400, {
          error: {
            message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
            type: 'invalid_request_error',
            param: 'response_format'
          }
        });
        return true;
      case 'slow':
        await new Promise((r) => setTimeout(r, fault.delayMs));
        return false;
      default:
        return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://mock');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors());
      res.end();
      return;
    }
    const auth = req.headers.authorization;
    const authState = auth ? 'present' : 'absent';
    const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';

    try {
      if (path === '/__control' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        setMode(String(body.mode || 'ok'), { retryAfter: body.retryAfter, delayMs: body.delayMs, count: body.count });
        send(res, 200, { ok: true, mode: control.mode });
        return;
      }
      if (path === '/__log' && req.method === 'GET') {
        send(res, 200, entries);
        return;
      }
      if (path === '/__reset' && req.method === 'POST') {
        setMode('ok');
        entries = [];
        send(res, 200, { ok: true });
        return;
      }
      if ((path === '/v1/models' || path === '/models') && req.method === 'GET') {
        record({ method: 'GET', path, kind: 'models', auth: authState });
        send(res, 200, { object: 'list', data: [{ id: 'gpt-6-luna', object: 'model' }, { id: 'jev-latest', object: 'model' }] });
        return;
      }

      const isJev = path === '/v1/systemone';
      const isChat = path === '/v1/chat/completions' || path === '/chat/completions';
      const isResponses = path === '/v1/responses' || path === '/responses';
      if (req.method !== 'POST' || !(isJev || isChat || isResponses)) {
        send(res, 404, { error: { message: `No route for ${req.method} ${path}` } });
        return;
      }

      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        send(res, 400, { error: { message: 'Request body is not JSON.' } });
        return;
      }
      const kind = isJev ? 'jev' : isChat ? 'chat' : 'responses';
      const schema = isChat
        ? body?.response_format?.type === 'json_schema' ? body.response_format.json_schema?.schema : null
        : isResponses && body?.text?.format?.type === 'json_schema' ? body.text.format.schema : null;
      const prompt = isJev ? '' : isChat ? lastUserText(body?.messages) : lastUserText(body?.input);
      const post = isJev ? String(body?.state?.post ?? '') : postFromPrompt(prompt);
      const fault = takeFault();
      record({
        method: 'POST',
        path,
        kind,
        auth: authState,
        model: typeof body?.model === 'string' ? body.model : null,
        post,
        questionIds: isJev ? Object.keys(body?.questions || {}) : schema ? Object.keys(schema.properties || {}) : specsFromPrompt(prompt).map((s) => s.key),
        responseFormat: isChat ? body?.response_format?.type ?? null : isResponses ? body?.text?.format?.type ?? null : null,
        mode: fault.mode
      });
      if (await applyFault(res, fault, { token, usesSchema: !!schema })) return;

      if (isJev) {
        /** @type {Record<string, any>} */
        const answers = {};
        for (const [id, q] of Object.entries(body?.questions || {})) {
          const qq = /** @type {any} */ (q);
          if (qq?.type === 'noul') {
            answers[id] = { noul: noulP(id, post) };
          } else if (qq?.type === 'choice') {
            const options = Object.keys(qq.criteria || {});
            if (!options.includes('none')) options.push('none');
            const choice = pickOption(options, post);
            const top = choice === 'none' ? 0.6 : 0.88;
            /** @type {Record<string, number>} */
            const probabilities = {};
            for (const o of options) probabilities[o] = o === choice ? top : (1 - top) / (options.length - 1);
            const n = options.length;
            answers[id] = { choice, probabilities, confidence: (top - 1 / n) / (1 - 1 / n) };
          } else if (qq?.type === 'score') {
            answers[id] = { score: 0, probabilities: {}, confidence: 0 };
          }
        }
        send(res, 200, {
          model: body?.model || 'jev-latest',
          answers,
          usage: { input_tokens: tokens(JSON.stringify(body)), output_tokens: tokens(JSON.stringify(answers)) }
        });
        return;
      }

      const specs = schema ? specsFromSchema(schema) : specsFromPrompt(prompt);
      const content = JSON.stringify(answerSpecs(specs, post));
      const inputTokens = tokens(raw);
      const outputTokens = tokens(content);
      if (isChat) {
        send(res, 200, {
          id: `chatcmpl-mock-${entries.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body?.model || 'gpt-6-luna',
          choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
        });
      } else {
        send(res, 200, {
          id: `resp-mock-${entries.length}`,
          object: 'response',
          status: 'completed',
          model: body?.model || 'gpt-6-luna',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] }],
          output_text: content,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
        });
      }
    } catch (err) {
      send(res, 500, { error: { message: `Mock server error: ${String(/** @type {any} */ (err)?.message || err).slice(0, 200)}` } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://${host}:${address.port}`;

  return {
    url,
    port: address.port,
    setMode,
    log: () => entries.map((e) => ({ ...e })),
    clearLog: () => {
      entries = [];
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      })
  };
}

// CLI: node e2e/mock-decision-server.mjs [--port N]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8787;
  const mock = await startMockDecisionServer({ port });
  console.log(`[mock-decision-server] listening on ${mock.url}`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
