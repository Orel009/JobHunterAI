/**
 * The extension's cover letter / message to the hiring team: plain and specific (2–4 sentences, first person, the job's
 * language), no AI clichés, no em dashes, no lists; a draft that breaks the rules is sent back once with the reason, and
 * one that still does is not used. Your writing sample is the style reference. When the model is not running, the
 * reason comes back for the overlay ("no draft: …").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-cover';
  process.env.PREFERENCES_FILE = 'data/test-cover/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { drafts: [] as string[], calls: [] as Array<Array<{ role: string; content: string }>>, cached: [] as boolean[], reach: { ok: true, reason: null as string | null, canStart: true } };
});
vi.mock('../src/llm/llm.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm/llm.js')>()),
  chatJson: async (o: { task?: string; cache?: unknown; messages: Array<{ role: string; content: string }> }) => {
    if (o.task === 'analyze') return { data: { unsupportedClaims: [] } };
    h.calls.push(o.messages);
    h.cached.push(!!o.cache);
    return { data: { text: h.drafts.shift() ?? '', usedFactIds: ['exp.matrix.en.1'], unanswerable: false } };
  },
}));
vi.mock('../src/llm/reachable.js', async (orig) => ({ ...(await orig<typeof import('../src/llm/reachable.js')>()), llmReachable: async () => ({ ...h.reach }) }));

import fs from 'node:fs';
import { config } from '../src/config.js';
import { coverLetterProblem, makeDrafter, sentenceCount, yearsProblem } from '../src/apply/draft.js';
import { ProfileSchema } from '../src/profile/schema.js';
import { profilePath } from '../src/profile/facts.js';
import { openDb } from '../src/db/index.js';
import { buildApp } from '../src/server/app.js';
import { extensionToken } from '../src/extension/token.js';

const PROFILE = ProfileSchema.parse({
  contact: { name: { en: 'Test Person' }, city: {} },
  declaredExperience: { totalDevYears: 2, basis: 'test' },
  experience: [{ id: 'exp.matrix', company: { en: 'Matrix' }, title: { en: 'Developer' }, start: '2023', end: 'present', highlights: { en: ['Built an API platform for internal teams'] } }],
});
const field = { key: 'coverLetter', label: 'Message to the hiring team', type: 'textarea', required: false } as never;
const ctx = { jobTitle: 'Full Stack Engineer — Wix', jobText: 'Build APIs and developer tools.', language: 'en' as const };
const CLEAN = 'I built an API platform for internal teams at Matrix. Your ad asks for developer tools, which is the work I do every day.';

beforeEach(() => {
  h.drafts.length = 0;
  h.calls.length = 0;
  h.cached.length = 0;
  h.reach = { ok: true, reason: null, canStart: true };
});

describe('the style rules', () => {
  it('banned phrases, em dashes, lists and more than 4 sentences are problems; a plain short message is fine', () => {
    expect(coverLetterProblem(CLEAN)).toBeNull();
    expect(coverLetterProblem('I am excited to apply. I build APIs.')).toMatch(/"excited"/);
    expect(coverLetterProblem("I'm confident I would be a great fit.")).toMatch(/"I am confident".*"I believe I would be a great fit"/);
    expect(coverLetterProblem('I build APIs and leverage AI agents in a fast-paced team.')).toMatch(/"leverage".*"fast-paced"/);
    expect(coverLetterProblem('אני נלהב להצטרף. אשמח מאוד להצטרף לצוות מאתגר ודינמי.')).toMatch(/"נלהב".*"אשמח מאוד להצטרף".*"מאתגר ודינמי"/);
    expect(coverLetterProblem('I build APIs — and tools.')).toBe('an em dash');
    expect(coverLetterProblem('What I bring:\n- APIs\n- tools')).toBe('a list');
    expect(coverLetterProblem('One. Two. Three. Four. Five.')).toBe('5 sentences (at most 4)');
    expect(sentenceCount('I used Node.js 20.5 at Matrix, e.g. for APIs. Then React.')).toBe(2);
  });
});

describe('the draft', () => {
  it('a draft that breaks the rules is sent back once with the reason; the rewrite is used', async () => {
    h.drafts.push('I am thrilled to apply. I built an API platform at Matrix.', CLEAN);
    const d = await makeDrafter(PROFILE, { mode: 'coverLetter' })(field, ctx);
    expect(d.text).toBe(CLEAN);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.at(-1)!.content).toMatch(/^Rejected: it has banned phrase: "thrilled"/);
    expect(h.calls[0]![0]!.content).toMatch(/2-4 short sentences.*THIS job only.*\n.*Pick 1-2 requirements from the job ad that the listed facts really meet.*one concrete reason tied to this company or role/s);
  });

  it('still breaking the rules after the rewrite → no draft, with the reason', async () => {
    h.drafts.push('I am passionate about APIs.', 'I am passionate about tools — really.');
    const d = await makeDrafter(PROFILE, { mode: 'coverLetter' })(field, ctx);
    expect(d).toMatchObject({ text: null, rejectedReason: 'style check failed twice (banned phrase: "passionate")' });
  });

  it('your writing sample is the style reference; form answers keep their own rules (no style check)', async () => {
    h.drafts.push(CLEAN);
    await makeDrafter(PROFILE, { mode: 'coverLetter', styleSample: 'Hi, I saw the role and it fits what I do.' })(field, ctx);
    expect(h.calls[0]![1]!.content).toMatch(/Writing style sample .*never copy facts from them\):\nHi, I saw the role and it fits what I do\.$/s);
    h.calls.length = 0;
    h.drafts.push('I am excited about it. I build APIs.');
    const answer = await makeDrafter(PROFILE)(field, ctx);
    expect(answer.text).toBe('I am excited about it. I build APIs.');
    expect(h.calls).toHaveLength(1);
  });
});

describe('a fresh text for every job, and the bio', () => {
  const cache = { get: () => null, set: () => undefined } as never;
  it('cover letters and bios are never served from the cache (the same request twice = two texts); form answers are', async () => {
    h.drafts.push(CLEAN, CLEAN);
    const draft = makeDrafter(PROFILE, { mode: 'coverLetter', cache });
    await draft(field, ctx);
    await draft(field, ctx);
    expect(h.calls).toHaveLength(2);
    expect(h.cached).toEqual([false, false]);
    h.drafts.push('I build APIs.');
    await makeDrafter(PROFILE, { cache })(field, ctx);
    expect(h.cached.at(-1)).toBe(true);
  });

  it('a bio: about you (current role, stack, one project), 2-3 sentences; a fourth sentence sends it back', async () => {
    h.drafts.push('I am a developer at Matrix. I build APIs. I use Node.js. I built a platform.', 'I am a developer at Matrix, where I built an API platform for internal teams.');
    const d = await makeDrafter(PROFILE, { mode: 'bio' })(field, ctx);
    expect(d.text).toBe('I am a developer at Matrix, where I built an API platform for internal teams.');
    expect(h.calls[0]![0]!.content).toMatch(/short bio of the candidate.*2-3 short plain sentences: the current role, the key stack, and one project/s);
    expect(h.calls[1]!.at(-1)!.content).toMatch(/^Rejected: it has 4 sentences \(at most 3\)/);
  });
});

describe('years the ad asks for, never claimed', () => {
  it('a number of years above your declared total is a problem; your own total, or none, is fine', () => {
    expect(yearsProblem('I have 3+ years of experience with React.', 2)).toBe('a claim of 3+ years of experience (your profile: 2)');
    expect(yearsProblem('I bring 5 yrs of Node.js work.', 2)).toMatch(/5 yrs/);
    expect(yearsProblem('יש לי 4 שנות ניסיון בפיתוח.', 2)).toMatch(/4 שנות/);
    expect(yearsProblem('I have 2 years of professional experience building React apps.', 2)).toBeNull();
    expect(yearsProblem('I built REST APIs with Node.js at Matrix (2025).', 2)).toBeNull();
    expect(yearsProblem('I have 3 years of experience.', null, '[exp.a] 3 years at Acme')).toBeNull();
    expect(yearsProblem('I have 3 years of experience.', null, '[exp.a] Developer at Acme')).toMatch(/3 years/);
  });

  it('an ad asking for 3+ years: a draft claiming it is sent back with the reason; the rewrite focuses on the work', async () => {
    h.drafts.push('I have 3+ years of experience with React and Node.js.', 'I build React dashboards and REST APIs in Node.js at Matrix.');
    const d = await makeDrafter(PROFILE, { mode: 'bio' })(field, { ...ctx, jobText: 'Requirements: 3+ years of experience with React, JavaScript, REST and Node.js.' });
    expect(d.text).toBe('I build React dashboards and REST APIs in Node.js at Matrix.');
    expect(h.calls[1]!.at(-1)!.content).toMatch(/^Rejected: it has a claim of 3\+ years of experience \(your profile: 2\)/);
    expect(h.calls[0]![0]!.content).toMatch(/Years: never state or imply a number of years of experience the facts do not give/);
  });
});

describe('the extension asks for a draft', () => {
  it('the model not running: the reason comes back for the overlay (no error deep in the call)', async () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(profilePath(), JSON.stringify(PROFILE));
    try {
      const app = buildApp(openDb(':memory:'));
      h.reach = { ok: false, reason: 'Ollama is not running (http://127.0.0.1:11434)', canStart: true };
      const r = await app.inject({ method: 'POST', url: '/api/fill/draft', headers: { 'x-jobhunter-token': extensionToken() }, payload: { title: 'Full Stack Engineer', company: 'Wix', lang: 'en' } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ text: null, error: 'Ollama is not running (http://127.0.0.1:11434): start it (JobHunter → the LLM badge → Start Ollama), then fill again' });
      h.reach = { ok: true, reason: null, canStart: true };
      // a very long page title is cut, never a reason to refuse the draft
      h.drafts.push(CLEAN);
      expect((await app.inject({ method: 'POST', url: '/api/fill/draft', headers: { 'x-jobhunter-token': extensionToken() }, payload: { title: 'x'.repeat(2000), company: 'Wix', lang: 'en' } })).json()).toMatchObject({ text: CLEAN });
      h.drafts.push(CLEAN);
      expect((await app.inject({ method: 'POST', url: '/api/fill/draft', headers: { 'x-jobhunter-token': extensionToken() }, payload: { title: 'Full Stack Engineer', company: 'Wix', lang: 'en' } })).json()).toMatchObject({ text: CLEAN, error: null });
    } finally {
      fs.rmSync(profilePath(), { force: true });
    }
  });
});
