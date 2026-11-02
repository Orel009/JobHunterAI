/**
 * The form planner: the page's fields (label / placeholder / name, type, options, required, nearby text) and the job →
 * a KIND per field (a profile key, draft:cover, draft:bio, country, unknown). The model never writes a value (its
 * output can only be one of the kinds); a draft only for a free-text field; one plan per site + form (cached); a
 * failure comes back as the reason for the overlay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-form-plan';
  process.env.PREFERENCES_FILE = 'data/test-form-plan/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { calls: 0, fail: false, reach: { ok: true, reason: null as string | null, canStart: true } };
});
vi.mock('../src/llm/llm.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm/llm.js')>()),
  chatJson: async (o: { messages: Array<{ content: string }> }) => {
    h.calls++;
    if (h.fail) throw new Error('fetch failed');
    const fields = (JSON.parse(o.messages[1]!.content) as { fields: Array<{ key: string; label: string; placeholder: string; type: string }> }).fields;
    const kind = (f: { label: string; placeholder: string; type: string }) =>
      /message|note/i.test(`${f.label} ${f.placeholder}`) ? 'draft:cover' : /bio/i.test(f.label) ? 'draft:bio' : /country/i.test(`${f.label} ${f.placeholder}`) ? (f.type === 'select-one' ? 'draft:cover' : 'country') : /mail/i.test(f.placeholder) ? 'email' : 'unknown';
    return { data: { fields: fields.map((f) => ({ key: f.key, kind: kind(f) })) } };
  },
}));
vi.mock('../src/llm/reachable.js', async (orig) => ({ ...(await orig<typeof import('../src/llm/reachable.js')>()), llmReachable: async () => ({ ...h.reach }) }));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { formSignature, planForm, PLAN_KINDS, type PlanField } from '../src/extension/labels.js';
import { openDb } from '../src/db/index.js';
import { buildApp } from '../src/server/app.js';
import { extensionToken } from '../src/extension/token.js';

const F = (o: Partial<PlanField>): PlanField => ({ key: o.key ?? 'k', label: '', placeholder: '', name: '', type: 'text', options: [], required: false, near: '', ...o });
const FORM = [
  F({ key: 'input:text:full_name', placeholder: 'Full name' }),
  F({ key: 'input:email:your_email', type: 'email', placeholder: 'Email' }),
  F({ key: 'select:select-one:country', type: 'select-one', options: ['Country', 'Israel', 'Germany'], label: 'Country' }),
  F({ key: 'textarea:textarea:msg', type: 'textarea', placeholder: 'Message', near: 'Please send us a note on why you want to be part of our team' }),
];
const JOB = { title: 'Backend Engineer', company: 'Example Payments', text: 'Build payment APIs in Node.js.' };

beforeEach(() => {
  fs.rmSync(path.join(config.dataDir, 'fill-form-plans.json'), { force: true });
  h.calls = 0;
  h.fail = false;
  h.reach = { ok: true, reason: null, canStart: true };
});

describe('the form planner', () => {
  it('a kind per field, never a value; a draft only in a free-text field (a select planned as a draft → unknown)', async () => {
    const r = await planForm('careers.example.test', FORM, JOB);
    expect(r).toMatchObject({ cached: false, plan: { 'input:text:full_name': 'unknown', 'input:email:your_email': 'email', 'select:select-one:country': 'unknown', 'textarea:textarea:msg': 'draft:cover' } });
    expect(Object.values(r.plan).every((k) => (PLAN_KINDS as readonly string[]).includes(k))).toBe(true);
  });

  it('one plan per site + form: the same form again is not asked; another site or a changed form is', async () => {
    await planForm('careers.example.test', FORM, JOB);
    expect((await planForm('careers.example.test', FORM, { ...JOB, title: 'Another job' })).cached).toBe(true);
    expect(h.calls).toBe(1);
    await planForm('other.example.test', FORM, JOB);
    await planForm('careers.example.test', [...FORM, F({ key: 'textarea:textarea:bio', type: 'textarea', label: 'Bio *', required: true })], JOB);
    expect(h.calls).toBe(3);
    expect(formSignature(FORM)).not.toBe(formSignature(FORM.slice(1)));
  });

  it('the route: the plan; a failure comes back as the reason (Ollama not running → start it)', async () => {
    const app = buildApp(openDb(':memory:'));
    const hdr = { 'x-jobhunter-token': extensionToken() };
    const ok = (await app.inject({ method: 'POST', url: '/api/fill/plan', headers: hdr, payload: { url: 'https://careers.example.test/jobs/1', fields: FORM, job: JOB } })).json();
    expect(ok).toMatchObject({ error: null, plan: { 'textarea:textarea:msg': 'draft:cover' } });
    h.fail = true;
    h.reach = { ok: false, reason: 'Ollama is not running (http://127.0.0.1:11434)', canStart: true };
    const bad = await app.inject({ method: 'POST', url: '/api/fill/plan', headers: hdr, payload: { url: 'https://new.example.test/', fields: FORM, job: JOB } });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toMatchObject({ plan: {}, error: 'Ollama is not running (http://127.0.0.1:11434): start it (JobHunter → the LLM badge → Start Ollama), then fill again' });
    // never from a web page
    expect((await app.inject({ method: 'POST', url: '/api/fill/plan', payload: { url: 'x', fields: [] } })).statusCode).toBe(401);
  });

  it('each fill is reported to the log: fields (labels, rule, plan), drafts with their outcome, and what was left to you', async () => {
    const app = buildApp(openDb(':memory:'));
    const hdr = { 'x-jobhunter-token': extensionToken() };
    const { log } = await import('../src/log.js');
    const spy = vi.spyOn(log, 'info');
    const r = await app.inject({
      method: 'POST',
      url: '/api/fill/report',
      headers: hdr,
      payload: {
        url: 'https://www.example.test/careers/1',
        linked: false,
        jobContext: 'from page',
        fields: [{ label: 'Bio *', type: 'textarea', required: true, rule: 'bio', planned: null }],
        drafts: [{ label: 'Bio *', kind: 'bio', ok: false, error: 'timed out after 180 s', ms: 180000 }],
        problems: [],
        result: { filled: 3, drafts: 0, needYou: 1, pending: ['Bio *: no draft: timed out after 180 s'], notes: [] },
      },
    });
    expect(r.json()).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ host: 'www.example.test', drafts: [expect.objectContaining({ kind: 'bio', ok: false, error: 'timed out after 180 s' })] }), 'extension: fill report');
    spy.mockRestore();
  });
});
