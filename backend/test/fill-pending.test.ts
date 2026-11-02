/**
 * JobHunter Fill and your answers bank / settings: a form's question with no answer on file goes into the bank as
 * pending (once; the next fill with an answer uses it), and the "draft optional cover / bio fields" setting.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-fill-pending';
  process.env.PREFERENCES_FILE = 'data/test-fill-pending/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
});

import { buildApp } from '../src/server/app.js';
import { openDb } from '../src/db/index.js';
import { AnswersBank } from '../src/apply/bank.js';
import { extensionToken } from '../src/extension/token.js';
import { extensionSettings, saveExtensionSettings } from '../src/extension/settings.js';

const Q = 'This remote position is based in Israel. Are you currently based in Israel, and are you either an Israeli citizen or legally authorized to work in Israel?';

describe('questions a form asked', () => {
  it('into the bank as pending, once; answered in JobHunter → given back to the extension as a bank answer', async () => {
    const db = openDb(':memory:');
    const app = buildApp(db);
    const hdr = { 'x-jobhunter-token': extensionToken() };
    const r = await app.inject({ method: 'POST', url: '/api/fill/pending', headers: hdr, payload: { questions: [{ question: Q, type: 'yes_no', options: ['YES', 'NO'] }] } });
    expect(r.json()).toEqual({ added: 1, pending: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/fill/pending', headers: hdr, payload: { questions: [{ question: Q, type: 'yes_no', options: ['YES', 'NO'] }] } })).json()).toEqual({ added: 0, pending: 1 });
    const bank = new AnswersBank(db);
    const e = bank.list({ status: 'pending' })[0]!;
    expect(e).toMatchObject({ question: Q, type: 'yes_no', options: ['YES', 'NO'], status: 'pending' });
    bank.update(e.id, { answer: 'Yes' });
    const data = (await app.inject({ method: 'GET', url: '/api/fill/data?lang=en', headers: hdr })).json();
    expect(data.bank).toEqual([{ question: Q, answer: 'Yes', type: 'yes_no', options: ['YES', 'NO'] }]);
    // never from a web page
    expect((await app.inject({ method: 'POST', url: '/api/fill/pending', payload: { questions: [] } })).statusCode).toBe(401);
  });

  it('"draft optional cover / bio fields": on by default; saved from the dashboard; given to the extension', async () => {
    expect(extensionSettings().draftOptionalFields).toBe(true);
    expect(saveExtensionSettings({ draftOptionalFields: false })).toMatchObject({ draftOptionalFields: false, fillCoverLetters: true });
    const app = buildApp(openDb(':memory:'));
    expect((await app.inject({ method: 'GET', url: '/api/fill/data?lang=en', headers: { 'x-jobhunter-token': extensionToken() } })).json()).toMatchObject({ draftOptionalFields: false, fillCoverLetters: true });
    expect((await app.inject({ method: 'PUT', url: '/api/extension/settings', payload: { draftOptionalFields: true } })).json()).toMatchObject({ draftOptionalFields: true });
  });
});
