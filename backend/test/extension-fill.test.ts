/**
 * JobHunter Fill: the field mapping (pure, from extension/fill-core.js), and the local backend it talks to — only with
 * the per-install token, never from a web page; which job a page belongs to; the fill data; "I applied".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-extension';
  process.env.PREFERENCES_FILE = 'data/test-extension/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
});

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { buildApp } from '../src/server/app.js';
import { extensionToken } from '../src/extension/token.js';
import { jobIdsInUrl, normalizeJobUrl } from '../src/extension/fill.js';
import { ProfileSchema } from '../src/profile/schema.js';
import { profilePath } from '../src/profile/facts.js';

await import(pathToFileURL(path.join(process.cwd(), '..', 'extension', 'fill-core.js')).href);
type Fill = {
  classify(t: string): string | null;
  chooseOption(o: string[], a: string): number;
  bankAnswer(l: string, b: Array<{ question: string; answer: string }>): { answer: string } | null;
  answerFor(f: Record<string, unknown>, d: Record<string, unknown>): { value?: string; pending?: string; cv?: boolean; skip?: string; from?: string };
};
const F = (globalThis as unknown as { JobHunterFill: Fill }).JobHunterFill;

const DATA = {
  contact: { fullName: 'Test Person', firstName: 'Test', lastName: 'Person', email: 'test@example.com', phone: '050-0000000', city: 'Tel Aviv', linkedin: 'https://linkedin.com/in/test', github: null, website: null },
  cv: { lang: 'en', file: 'Test Person - Resume.pdf' },
  salary: { number: '14000', text: '14,000–16,000 ₪ ברוטו' },
  form: [
    { name: 'question_1', label: 'Are you authorized to work in Israel?', status: 'resolved', value: 'yes', source: 'answers bank' },
    { name: 'question_2', label: 'How did you hear about this job?', status: 'pending', value: null, source: 'needs your answer' },
  ],
  bank: [{ question: 'How many years of work experience do you have with Node.js?', answer: '2', type: 'number', options: null }],
};

describe('field mapping (extension/fill-core.js)', () => {
  it('your details by label, name or id, in Hebrew and English', () => {
    expect(['First Name', 'שם פרטי', 'fname'].map(F.classify)).toEqual(['firstName', 'firstName', 'firstName']);
    expect(['Last name', 'שם משפחה'].map(F.classify)).toEqual(['lastName', 'lastName']);
    expect(['Email', 'דוא"ל', 'כתובת מייל'].map(F.classify)).toEqual(['email', 'email', 'email']);
    expect(['Mobile phone number', 'טלפון נייד'].map(F.classify)).toEqual(['phone', 'phone']);
    expect(['LinkedIn Profile', 'GitHub URL', 'Portfolio URL'].map(F.classify)).toEqual(['linkedin', 'github', 'website']);
    expect(['Resume/CV', 'קורות חיים'].map(F.classify)).toEqual(['cv', 'cv']);
    expect(['Full name', 'שם מלא', 'Location (City)', 'Current location', 'עיר מגורים'].map(F.classify)).toEqual(['fullName', 'fullName', 'city', 'city', 'city']);
    expect(['Expected salary', 'מה ציפיות השכר שלך?'].map(F.classify)).toEqual(['salary', 'salary']);
    expect(['Cover Letter', 'מכתב מקדים'].map(F.classify)).toEqual(['coverLetter', 'coverLetter']);
  });

  it('never: CAPTCHA, consents and declarations, passwords', () => {
    expect(['I agree to the privacy policy', 'אני מאשר/ת את תנאי השימוש', 'g-recaptcha-response', 'Password'].map(F.classify)).toEqual(['never', 'never', 'never', 'never']);
    expect(F.answerFor({ label: '', name: 'g-recaptcha-response', type: 'textarea' }, DATA)).toEqual({ skip: 'never filled' });
  });

  it('options: same text, yes / no in either language, or clearly containing the answer', () => {
    expect(F.chooseOption(['Select…', 'Yes', 'No'], 'yes')).toBe(1);
    expect(F.chooseOption(['כן', 'לא'], 'no')).toBe(1);
    expect(F.chooseOption(['Israel', 'United States'], 'israel')).toBe(0);
    expect(F.chooseOption(['0-1 years', '2-3 years'], '4 years')).toBe(-1);
  });

  it('answers: the prepared Greenhouse answer by field name; pending stays empty; the bank by its question; salary by your rules', () => {
    expect(F.answerFor({ label: 'x', id: 'question_1', type: 'text' }, DATA)).toMatchObject({ value: 'yes', from: 'prepared answer' });
    expect(F.answerFor({ label: 'x', id: 'question_2', type: 'text' }, DATA)).toMatchObject({ pending: 'needs your answer' });
    expect(F.answerFor({ label: 'How many years of work experience do you have with Node.js?', type: 'text' }, DATA)).toMatchObject({ value: '2', from: 'answers bank' });
    expect(F.answerFor({ label: 'Expected salary', type: 'number' }, DATA)).toMatchObject({ value: '14000' });
    expect(F.answerFor({ label: 'ציפיות שכר', type: 'text' }, DATA)).toMatchObject({ value: '14,000–16,000 ₪ ברוטו' });
    expect(F.answerFor({ label: 'Resume/CV', type: 'file' }, DATA)).toEqual({ cv: true });
    expect(F.answerFor({ label: 'Cover Letter', type: 'textarea' }, DATA)).toMatchObject({ skip: expect.stringMatching(/cover letter/) });
    expect(F.answerFor({ label: 'GitHub URL', type: 'url' }, DATA)).toMatchObject({ pending: 'no github in your profile' });
    expect(F.answerFor({ label: 'Why us?', type: 'textarea', required: true }, DATA)).toMatchObject({ pending: 'no answer on file' });
    expect(F.answerFor({ label: 'Favourite colour', type: 'text', required: false }, DATA)).toMatchObject({ skip: expect.any(String) });
  });
});

describe('job addresses', () => {
  it('normalized; the ids an ATS / job site puts in them', () => {
    expect(normalizeJobUrl('https://job-boards.greenhouse.io/similarweb/jobs/7972320/apply?utm=x#top')).toBe('job-boards.greenhouse.io/similarweb/jobs/7972320');
    expect(jobIdsInUrl('https://www.similarweb.com/corp/careers/job/?gh_jid=7972320')).toEqual(['7972320']);
    expect(jobIdsInUrl('https://www.comeet.com/jobs/cyera/17.008/ai-researcher/2B.D67')).toEqual(['2B.D67']);
    expect(jobIdsInUrl('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678')).toEqual(['4012345678']);
    expect(jobIdsInUrl('https://il.indeed.com/viewjob?jk=a1b2c3d4e5f60718')).toEqual(['a1b2c3d4e5f60718']);
  });
});

describe('the local backend (token, never from a web page)', () => {
  let db: DB;
  let repo: Repo;
  beforeEach(() => {
    db = openDb(':memory:');
    repo = new Repo(db);
    fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
    fs.writeFileSync(config.paths.preferences, 'cv: { he: cv-he.pdf, en: cv-en.pdf }\nroleTypes:\n  - { id: dev, tier: 1, queries: [x], titleKeywords: [engineer] }\n');
  });
  const add = (site: 'greenhouse' | 'linkedin', externalId: string, url: string, applyTarget = '') => {
    const j = toJob({ site, externalId, company: 'Similarweb', title: 'Big Data Engineer', location: 'Tel Aviv', descriptionText: 'Build data pipelines', requirementsText: '', url, postedAt: null, applyType: 'external', applyTarget, language: 'en', detailsFetched: true, raw: site === 'greenhouse' ? { ats: 'greenhouse', board: 'similarweb', jobId: Number(externalId.split(':')[1]) } : {} });
    repo.upsertJob(j);
    return j.id;
  };
  const hdr = (t = extensionToken()) => ({ 'x-jobhunter-token': t });

  it('no token / a wrong token → 401; a web page origin → 403 even with the token', async () => {
    const app = buildApp(db);
    expect((await app.inject({ method: 'GET', url: '/api/fill/ping' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/fill/ping', headers: hdr('0'.repeat(48)) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/fill/ping', headers: { ...hdr(), origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/fill/ping', headers: { ...hdr(), origin: 'chrome-extension://abcdef' } })).statusCode).toBe(200);
  });

  it('a new token: the old one stops working', async () => {
    const app = buildApp(db);
    const old = extensionToken();
    const fresh = (await app.inject({ method: 'POST', url: '/api/extension/token' })).json().token;
    expect(fresh).not.toBe(old);
    expect((await app.inject({ method: 'GET', url: '/api/fill/ping', headers: hdr(old) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/fill/ping', headers: hdr(fresh) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/extension', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  it('matches the page to the job: the form address, the company page (gh_jid), a LinkedIn job id', async () => {
    const app = buildApp(db);
    const gh = add('greenhouse', 'similarweb:7972320', 'https://www.similarweb.com/corp/careers/job/?gh_jid=7972320', 'https://job-boards.greenhouse.io/similarweb/jobs/7972320');
    const li = add('linkedin', '4012345678', 'https://www.linkedin.com/jobs/view/4012345678/');
    const match = async (u: string) => (await app.inject({ method: 'GET', url: `/api/fill/match?url=${encodeURIComponent(u)}`, headers: hdr() })).json().job?.id ?? null;
    expect(await match('https://job-boards.greenhouse.io/similarweb/jobs/7972320?gh_src=abc')).toBe(gh);
    expect(await match('https://www.similarweb.com/corp/careers/job/?gh_jid=7972320#app')).toBe(gh);
    expect(await match('https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=x')).toBe(li);
    expect(await match('https://www.example.com/careers/123')).toBeNull();
  });

  it('fill data: your details, the CV to choose, the bank; then "I applied" marks it applied by hand (once)', async () => {
    fs.writeFileSync(profilePath(), JSON.stringify(ProfileSchema.parse({ contact: { name: { en: 'Test Person' }, email: 'test@example.com', phone: '050-0000000', city: { en: 'Tel Aviv' } }, links: [{ id: 'link.linkedin', label: 'LinkedIn', url: 'https://linkedin.com/in/test' }] })));
    try {
      const app = buildApp(db);
      const id = add('linkedin', '4012345678', 'https://www.linkedin.com/jobs/view/4012345678/');
      const d = (await app.inject({ method: 'GET', url: `/api/fill/data?jobId=${id}`, headers: hdr() })).json();
      expect(d.job).toMatchObject({ id, siteLabel: 'LinkedIn' });
      expect(d.contact).toMatchObject({ firstName: 'Test', lastName: 'Person', email: 'test@example.com', city: 'Tel Aviv', linkedin: 'https://linkedin.com/in/test' });
      expect(d.cv.file).toMatch(/\.pdf$|cv/);
      const a = (await app.inject({ method: 'POST', url: `/api/fill/jobs/${id}/applied`, headers: hdr(), payload: {} })).json();
      expect(a).toMatchObject({ ok: true, already: false });
      expect(repo.getJob(id)).toMatchObject({ status: 'submitted_manual', statusReason: expect.stringMatching(/^applied by hand on LinkedIn .*JobHunter Fill/) });
      expect((await app.inject({ method: 'POST', url: `/api/fill/jobs/${id}/applied`, headers: hdr(), payload: {} })).json()).toMatchObject({ already: true });
    } finally {
      fs.rmSync(profilePath(), { force: true });
    }
  });
});
