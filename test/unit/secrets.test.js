import { describe, test, expect } from 'vitest';
import {
  setSecret,
  getSecret,
  clearSecret,
  describeSecrets,
  listSecretValues,
  redact,
  SECRET_PROVIDERS
} from '../../lib/storage/secrets.js';
import { SECRETS_KEY } from '../../lib/messages.js';

/** In-memory chrome.storage area (get(key) -> { key: value }). */
function memoryArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    }
  };
}

const JEV_KEY = 'jev_live_0123456789abcdefWXYZ';
const OPENAI_KEY = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234';

describe('secret storage', () => {
  test('set, get, describe and clear', async () => {
    const area = memoryArea({ configuration: { a: 1 } });
    expect(SECRET_PROVIDERS).toEqual(['jev', 'openai']);
    expect(await describeSecrets(area)).toEqual({ jev: { set: false, last4: null }, openai: { set: false, last4: null } });

    const afterSet = await setSecret(area, 'jev', `  ${JEV_KEY}  `);
    expect(afterSet).toEqual({ jev: { set: true, last4: 'WXYZ' }, openai: { set: false, last4: null } });
    await setSecret(area, 'openai', OPENAI_KEY);
    expect(await getSecret(area, 'jev')).toBe(JEV_KEY);
    expect(await getSecret(area, 'openai')).toBe(OPENAI_KEY);
    expect(area.data[SECRETS_KEY]).toEqual({ jev: JEV_KEY, openai: OPENAI_KEY });
    expect(area.data.configuration).toEqual({ a: 1 }); // nothing leaks into configuration
    expect(await listSecretValues(area)).toEqual([JEV_KEY, OPENAI_KEY]);

    const afterClear = await clearSecret(area, 'jev');
    expect(afterClear).toEqual({ jev: { set: false, last4: null }, openai: { set: true, last4: '1234' } });
    expect(await getSecret(area, 'jev')).toBeNull();
  });

  test('short keys show no suffix', async () => {
    const area = memoryArea();
    await setSecret(area, 'openai', 'abc12345');
    expect((await describeSecrets(area)).openai).toEqual({ set: true, last4: null });
  });

  test('rejects unknown providers and malformed keys without echoing them', async () => {
    const area = memoryArea();
    await expect(setSecret(area, 'anthropic', 'whatever-key-123')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(getSecret(area, 'nano')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(setSecret(area, 'jev', '   ')).rejects.toMatchObject({ code: 'bad_request' });
    const err = await setSecret(area, 'jev', 'two words-secret-value').catch((e) => e);
    expect(err.code).toBe('bad_request');
    expect(err.message).not.toContain('secret-value');
    await expect(setSecret(area, 'jev', 'x'.repeat(600))).rejects.toMatchObject({ code: 'bad_request' });
  });

  test('ignores malformed stored values', async () => {
    const area = memoryArea({ [SECRETS_KEY]: { jev: 42, openai: '', other: 'x' } });
    expect(await describeSecrets(area)).toEqual({ jev: { set: false, last4: null }, openai: { set: false, last4: null } });
  });
});

describe('redact', () => {
  test('replaces known secret values', () => {
    const msg = `request failed for key ${JEV_KEY} (retry with ${JEV_KEY})`;
    expect(redact(msg, [JEV_KEY])).toBe('request failed for key [REDACTED] (retry with [REDACTED])');
    expect(redact(msg, JEV_KEY)).not.toContain(JEV_KEY);
  });

  test('replaces sk- keys, Bearer tokens and api_key assignments', () => {
    expect(redact(`Incorrect API key provided: ${OPENAI_KEY}.`)).toBe('Incorrect API key provided: [REDACTED].');
    expect(redact('Authorization: Bearer abc.def-ghi_jkl')).toBe('Authorization: Bearer [REDACTED]');
    expect(redact('{"api_key": "abcdef123456789"}')).toBe('{"api_key": "[REDACTED]"}');
    expect(redact('x-api-key=0123456789abcdef&b=1')).toBe('x-api-key=[REDACTED]&b=1');
  });

  test('leaves ordinary text alone and handles non-strings', () => {
    expect(redact('task-scheduler-12345678 ran fine', ['abc'])).toBe('task-scheduler-12345678 ran fine');
    expect(redact(undefined)).toBe('');
    expect(redact(404)).toBe('404');
    expect(redact(new Error(`bad key ${OPENAI_KEY}`).message)).toBe('bad key [REDACTED]');
  });
});
