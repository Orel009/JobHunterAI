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
import { educationEntries, fillData, isCourse, jobIdsInUrl, normalizeJobUrl, orderEducation } from '../src/extension/fill.js';
import { ProfileSchema } from '../src/profile/schema.js';
import { profilePath } from '../src/profile/facts.js';

await import(pathToFileURL(path.join(process.cwd(), '..', 'extension', 'fill-core.js')).href);
type Fill = {
  fieldType(f: Record<string, unknown>, d?: Record<string, unknown>): string | null;
  localPhone(p: string): string;
  exactPlace(o: string, v: string): boolean;
  bucketOption(o: string[], n: number): number;
  nameQueries(v: string, alt?: string): string[];
  closeMatch(o: string, v: string): boolean;
  dateFor(el: Record<string, unknown>, d: string | null): string | null;
  entryKey(section: string, label: string): string | null;
  FORBIDDEN: RegExp;
  manualOnlyHost(u: string): boolean;
  MANUAL_ONLY_MESSAGE: string;
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
    // cover letters: the AI draft when there is one; yellow without; left alone when the setting is off
    expect(F.answerFor({ label: 'Cover Letter', type: 'textarea' }, { ...DATA, draft: { text: 'Hello.' } })).toEqual({ draft: 'Hello.', flaggedClaims: [] });
    expect(F.answerFor({ label: 'Cover Letter', type: 'textarea' }, DATA)).toMatchObject({ pending: 'cover letter: no draft was written — write it yourself' });
    expect(F.answerFor({ label: 'Cover Letter', type: 'textarea' }, { ...DATA, fillCoverLetters: false })).toMatchObject({ skip: expect.stringMatching(/off/) });
    expect(F.answerFor({ label: 'GitHub URL', type: 'url' }, DATA)).toMatchObject({ pending: 'no github in your profile' });
    expect(F.answerFor({ label: 'Why us?', type: 'textarea', required: true }, DATA)).toMatchObject({ pending: 'cover letter: no draft was written — write it yourself' });
    expect(F.answerFor({ label: 'Describe a challenge you solved', type: 'textarea', required: true }, DATA)).toMatchObject({ pending: 'no answer on file' });
    expect(F.answerFor({ label: 'Favourite colour', type: 'text', required: false }, DATA)).toMatchObject({ skip: expect.any(String) });
  });
});

describe('semantic field types (dictionary, autocomplete, form-control names)', () => {
  it('Hebrew and English synonyms', () => {
    expect(['Confirm your email', 'Re-enter email', 'אימות דוא"ל'].map(F.classify)).toEqual(['confirmEmail', 'confirmEmail', 'confirmEmail']);
    expect(['Message to the Hiring Team', 'Let the company know about your interest working there', 'Why do you want to work here?', 'Please send us a note on why you want to join', 'מכתב מקדים'].map(F.classify)).toEqual(Array(5).fill('coverLetter'));
    // about you: a bio, not a cover letter
    expect(['Bio', 'Bio *', 'Tell us about yourself', 'About you', 'ספר/י על עצמך', 'קצת על עצמי'].map(F.classify)).toEqual(Array(6).fill('bio'));
    expect(['Country', 'Country of residence', 'מדינה'].map(F.classify)).toEqual(['country', 'country', 'country']);
    expect(['Current job title', 'Current company', 'Notice period', 'When can you start?'].map(F.classify)).toEqual(['currentTitle', 'currentCompany', 'noticePeriod', 'noticePeriod']);
    expect(['Facebook', 'X (fka Twitter)'].map(F.classify)).toEqual(['social', 'social']);
  });
  it('years of experience: general wording only — a question naming a technology is not "total years"', () => {
    expect(['Years of experience', 'Total years of experience', 'How many years of professional experience do you have', 'שנות ניסיון'].map(F.classify)).toEqual(Array(4).fill('yearsExperience'));
    expect(F.classify('How many years of work experience do you have with Node.js?')).toBeNull();
  });
  it('the page\'s autocomplete hint and the form-control name count; a confirmation is told apart', () => {
    expect(F.fieldType({ label: '', autocomplete: 'given-name' })).toBe('firstName');
    expect(F.fieldType({ label: 'Confirm your email', id: 'confirm-email-input', autocomplete: 'email' })).toBe('confirmEmail');
    expect(F.fieldType({ label: 'x', controlName: 'firstName' })).toBe('firstName');
    expect(F.fieldType({ label: 'Mystery field' }, { labelTypes: { 'mystery field': 'currentTitle' } })).toBe('currentTitle');
    expect(F.fieldType({ label: 'Mystery field' }, { labelTypes: { 'mystery field': 'unknown' } })).toBeNull();
  });
  it('local phone next to a country selector; the exact city suggestion; date formats; entry fields; never Save / Submit / Next', () => {
    expect(['+972-50-123-4567', '972501234567', '050-1234567'].map(F.localPhone)).toEqual(['0501234567', '0501234567', '0501234567']);
    expect(F.answerFor({ label: 'Phone number', type: 'tel', hasCountry: true }, { ...DATA, contact: { phone: '+972 50 000 0000' } })).toMatchObject({ value: '0500000000' });
    expect(F.exactPlace('Tel Aviv, Israel', 'Tel Aviv')).toBe(true);
    expect(F.exactPlace('Tel Aviv-Yafo, Israel', 'Tel Aviv')).toBe(false);
    const el = (type: string, placeholder = '') => ({ type, placeholder, getAttribute: () => '' });
    expect([F.dateFor(el('month'), '2023-02'), F.dateFor(el('date'), '2023-02'), F.dateFor(el('text', 'MM/YYYY'), '2023-02'), F.dateFor(el('text', 'MM/YY'), '2023-02'), F.dateFor(el('text', 'YYYY'), '2023-02'), F.dateFor(el('text'), null)]).toEqual(['2023-02', '2023-02-01', '02/2023', '02/23', '2023', null]);
    expect(['Company', 'Job title', 'From', 'To', 'I currently work here', 'Description'].map((l) => F.entryKey('experience', l))).toEqual(['company', 'title', 'start', 'end', 'current', 'description']);
    expect(['School', 'Degree', 'Field of study'].map((l) => F.entryKey('education', l))).toEqual(['institution', 'degree', 'field']);
    // SmartRecruiters' education entry: "School location" is a place (never the institution); Major = the field of study
    expect(['Institution', 'Major', 'Degree', 'School location', 'From', 'To'].map((l) => F.entryKey('education', l))).toEqual(['institution', 'field', 'degree', 'location', 'start', 'end']);
    expect(['Company location', 'Location', 'עיר'].map((l) => F.entryKey('experience', l))).toEqual(['location', 'location', 'location']);
    expect(['Submit', 'Next', 'Apply', 'Save', 'שלח', 'שמור', 'המשך'].every((t) => F.FORBIDDEN.test(t))).toBe(true);
    expect(F.FORBIDDEN.test('+ Add')).toBe(false);
  });
  it('a list suggestion: exactly or closely the name ("ORT" / "John Bryce"), never another institution', () => {
    expect(F.closeMatch('ORT', 'ORT Hermelin College')).toBe(true);
    expect(F.closeMatch('ORT Hermelin Academic College', 'ORT Hermelin College')).toBe(true);
    expect(F.closeMatch('John Bryce', 'John Bryce College')).toBe(true);
    expect(F.closeMatch('מכללת אורט הרמלין', 'אורט הרמלין')).toBe(true);
    expect(F.closeMatch('ORT Braude College', 'ORT Hermelin College')).toBe(false);
    expect(F.closeMatch('Tel Aviv University', 'Open University')).toBe(false);
    expect(F.closeMatch('College', 'ORT Hermelin College')).toBe(false); // generic words only
  });

  it('a years bucket in a select; the queries tried in a list of names', () => {
    const b = ['Select', 'Less than 1 year', '1-3 years', '3–5 years', '5+ years'];
    expect([0.5, 2, 4, 7].map((n) => F.bucketOption(b, n))).toEqual([1, 2, 3, 4]);
    expect(F.bucketOption(['פחות משנה', '1 עד 3 שנים', '3 שנים ומעלה'], 2)).toBe(1);
    expect(F.nameQueries('ORT Hermelin College', 'מכללת אורט הרמלין')).toEqual(['ORT Hermelin College', 'מכללת אורט הרמלין', 'ORT Hermelin', 'ORT', 'Hermelin', 'ORT Hermelin Academic College']);
    expect(F.nameQueries('John Bryce College', '')).toEqual(['John Bryce College', 'John Bryce', 'John', 'Bryce', 'John Bryce Academic College']);
  });

  it('the very question in your answers bank wins over a profile value', () => {
    expect(F.answerFor({ label: 'Years of experience', type: 'text' }, { ...DATA, profile: { yearsExperience: 2 }, bank: [{ question: 'Years of experience', answer: '3' }] })).toMatchObject({ value: '3', from: 'answers bank' });
    expect(F.answerFor({ label: 'Years of experience', type: 'text' }, { ...DATA, profile: { yearsExperience: 2 }, bank: [] })).toMatchObject({ value: '2', from: 'profile' });
  });
});

describe('LinkedIn and Indeed: manual only', () => {
  it('the shared host check', () => {
    expect(['https://www.linkedin.com/jobs/view/1', 'https://linkedin.com/jobs', 'https://il.linkedin.com/x', 'https://lnkd.in/abc', 'https://il.indeed.com/viewjob?jk=1', 'https://www.indeed.com/x', 'https://uk.indeed.co.uk/x', 'https://apply.indeed.com/x', 'https://smartapply.indeedapply.com/x'].map(F.manualOnlyHost)).toEqual(Array(9).fill(true));
    expect(['https://job-boards.greenhouse.io/x/jobs/1', 'https://www.comeet.com/jobs/x', 'https://jobs.lever.co/x', 'https://notlinkedin.com/x', 'https://www.indeedish.io/', 'not a url'].map(F.manualOnlyHost)).toEqual(Array(6).fill(false));
    expect(F.MANUAL_ONLY_MESSAGE).toBe('LinkedIn/Indeed: manual only, use the copy panel');
  });

  it('the background worker refuses them: no request to JobHunter, nothing injected, "I applied" from there refused', async () => {
    const vm = await import('node:vm');
    const ext = path.join(process.cwd(), '..', 'extension');
    const calls = { fetch: 0, inject: 0 };
    let listener: (m: unknown, s: unknown, r: (x: unknown) => void) => boolean = () => false;
    let tabUrl = 'https://www.linkedin.com/jobs/view/4012345678/';
    const ctx: Record<string, unknown> = {
      fetch: async () => (calls.fetch++, new Response('{"job":null}')),
      chrome: {
        storage: { local: { get: async () => ({ token: 'x'.repeat(48) }) } },
        tabs: { get: async (id: number) => ({ id, url: tabUrl }) },
        scripting: { executeScript: async () => (calls.inject++, [{ result: { filled: 0, needYou: 0, cv: null } }]) },
        runtime: { onMessage: { addListener: (fn: typeof listener) => (listener = fn) } },
      },
      URL,
      Response,
      console,
    };
    ctx.globalThis = ctx;
    ctx.importScripts = (f: string) => vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx as never);
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), ctx as never);
    const ask = (msg: unknown, sender: unknown) => new Promise<{ ok: boolean; error?: string }>((res) => void listener(msg, sender, res as never));
    for (const u of ['https://www.linkedin.com/jobs/view/4012345678/', 'https://il.indeed.com/viewjob?jk=a1b2c3d4e5f60718']) {
      tabUrl = u;
      expect(await ask({ type: 'fill', tabId: 1 }, {})).toEqual({ ok: false, error: 'LinkedIn/Indeed: manual only, use the copy panel' });
      expect(await ask({ type: 'applied', jobId: 'j1' }, { tab: { id: 1, url: u } })).toEqual({ ok: false, error: 'LinkedIn/Indeed: manual only, use the copy panel' });
    }
    expect(calls).toEqual({ fetch: 0, inject: 0 });
    // elsewhere it does ask JobHunter (and injects)
    tabUrl = 'https://job-boards.greenhouse.io/similarweb/jobs/7972320';
    await ask({ type: 'fill', tabId: 1 }, {});
    expect(calls.fetch).toBeGreaterThan(0);
    expect(calls.inject).toBeGreaterThan(0);
  });
});

describe('job addresses', () => {
  it('normalized; the ids an ATS / job site puts in them', () => {
    expect(normalizeJobUrl('https://job-boards.greenhouse.io/similarweb/jobs/7972320/apply?utm=x#top')).toBe('job-boards.greenhouse.io/similarweb/jobs/7972320');
    expect(jobIdsInUrl('https://www.similarweb.com/corp/careers/job/?gh_jid=7972320')).toEqual(['7972320']);
    expect(jobIdsInUrl('https://www.comeet.com/jobs/cyera/17.008/ai-researcher/2B.D67')).toEqual(['2B.D67']);
    expect(jobIdsInUrl('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678')).toEqual(['4012345678']);
    expect(jobIdsInUrl('https://il.indeed.com/viewjob?jk=a1b2c3d4e5f60718')).toEqual(['a1b2c3d4e5f60718']);
    // SmartRecruiters: a job page (its posting id) and the "Easy apply" form (its uuid, which the stored apply target holds)
    expect(jobIdsInUrl('https://jobs.smartrecruiters.com/Wix2/744000158971809-technical-support-team-lead-customer-care')).toEqual(['744000158971809']);
    expect(jobIdsInUrl('https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2/publication/8563a7fa-d926-41a8-9ece-49e1501d03bf?dcr_ci=Wix2')).toEqual(['8563a7fa-d926-41a8-9ece-49e1501d03bf']);
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

  it('matches the page to the job: the form address, the company page (gh_jid); LinkedIn / Indeed pages refused (manual only)', async () => {
    const app = buildApp(db);
    const gh = add('greenhouse', 'similarweb:7972320', 'https://www.similarweb.com/corp/careers/job/?gh_jid=7972320', 'https://job-boards.greenhouse.io/similarweb/jobs/7972320');
    const li = add('linkedin', '4012345678', 'https://www.linkedin.com/jobs/view/4012345678/');
    const match = async (u: string) => (await app.inject({ method: 'GET', url: `/api/fill/match?url=${encodeURIComponent(u)}`, headers: hdr() })).json().job?.id ?? null;
    expect(await match('https://job-boards.greenhouse.io/similarweb/jobs/7972320?gh_src=abc')).toBe(gh);
    expect(await match('https://www.similarweb.com/corp/careers/job/?gh_jid=7972320#app')).toBe(gh);
    for (const u of ['https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=x', 'https://il.indeed.com/viewjob?jk=a1b2c3d4e5f60718']) {
      const r = await app.inject({ method: 'GET', url: `/api/fill/match?url=${encodeURIComponent(u)}`, headers: hdr() });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('LinkedIn/Indeed: manual only, use the copy panel');
    }
    expect(li).toBeTruthy(); // the LinkedIn job exists; only its LinkedIn page is refused
    expect(await match('https://www.example.com/careers/123')).toBeNull();
    // a SmartRecruiters company job: its job page, and its "Easy apply" form (matched by the uuid in the apply target)
    const sr = toJob({ site: 'smartrecruiters', externalId: 'Wix2:744000158971809', company: 'Wix', title: 'Business Analyst', location: 'Tel Aviv, Israel', descriptionText: 'x', requirementsText: '', url: 'https://jobs.smartrecruiters.com/Wix2/744000158971809', postedAt: null, applyType: 'external', applyTarget: 'https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2/publication/8563a7fa-d926-41a8-9ece-49e1501d03bf', language: 'en', detailsFetched: true, raw: {} });
    repo.upsertJob(sr);
    expect(await match('https://jobs.smartrecruiters.com/Wix2/744000158971809-business-analyst')).toBe(sr.id);
    expect(await match('https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2/publication/8563a7fa-d926-41a8-9ece-49e1501d03bf?dcr_ci=Wix2')).toBe(sr.id);
  });

  it('unknown labels → a field type (the model picks a type, never a value), cached', async () => {
    const { classifyLabels } = await import('../src/extension/labels.js');
    fs.rmSync(path.join(config.dataDir, 'fill-label-types.json'), { force: true });
    let calls = 0;
    const llm = (async () => (calls++, { data: { types: [{ label: 'Mystery field', type: 'currentTitle' }, { label: 'Shoe size', type: 'unknown' }] } })) as never;
    expect(await classifyLabels(['Mystery field', 'Shoe size'], llm)).toEqual({ 'mystery field': 'currentTitle', 'shoe size': 'unknown' });
    expect(await classifyLabels(['Mystery field'], llm)).toEqual({ 'mystery field': 'currentTitle' });
    expect(calls).toBe(1); // the second time from the cache
  });

  it('the cover-letter draft: refused when the setting is off; a draft that cites no facts is not returned', async () => {
    const app = buildApp(db);
    const { saveExtensionSettings } = await import('../src/extension/settings.js');
    saveExtensionSettings({ fillCoverLetters: false });
    expect((await app.inject({ method: 'POST', url: '/api/fill/draft', headers: hdr(), payload: { title: 'Developer', company: 'Acme' } })).statusCode).toBe(409);
    saveExtensionSettings({ fillCoverLetters: true });
    const { coverLetterDraft } = await import('../src/extension/fill.js');
    const asked: string[] = [];
    const drafter = (async (f: { label: string }, ctx: { language: string; jobText: string }) => (asked.push(`${ctx.language}|${f.label}|${ctx.jobText}`), { text: 'I build APIs.', usedFactIds: ['exp.acme'], unanswerable: false, flaggedClaims: [] })) as never;
    expect(await coverLetterDraft(db, { job: null, title: 'Support Lead', company: 'Base44', label: 'Message to the hiring team', lang: 'en' }, drafter)).toMatchObject({ text: 'I build APIs.', error: null });
    expect(asked[0]).toBe('en|Message to the hiring team: a short note to the hiring team on why I fit the Support Lead role at Base44|Support Lead at Base44');
    // a page JobHunter does not know: the job ad from the page itself is the job text (context "page"); a bio is asked as a bio
    const ad = 'Requirements: 2+ years with Node.js and TypeScript, React, SQL. We build a delivery management platform. '.repeat(3);
    asked.length = 0;
    expect(await coverLetterDraft(db, { job: null, title: 'Full Stack Developer', company: 'Example Logistics', label: 'Bio *', lang: 'en', kind: 'bio', pageText: ad }, drafter)).toMatchObject({ text: 'I build APIs.', context: 'page' });
    expect(asked[0]).toBe(`en|Bio *: a few sentences about me, for the Full Stack Developer role at Example Logistics|${ad.trim()}`);
    expect((await coverLetterDraft(db, { job: null, title: 'x', company: 'y', label: '', lang: 'en', pageText: 'short' }, drafter)).context).toBe('title');
    const none = (async () => ({ text: null, usedFactIds: [], unanswerable: false, flaggedClaims: [], rejectedReason: 'draft cites no facts' })) as never;
    expect(await coverLetterDraft(db, { job: null, title: 'x', company: 'y', label: '', lang: 'he' }, none)).toMatchObject({ text: null, error: 'draft cites no facts' });
  });

  it('education on forms: your order where set, else degrees before courses and newest first; the institution\'s city; the city for forms', async () => {
    const edu = (id: string, degree: string, start: string, end: string, o: Record<string, unknown> = {}) => ({ id, institution: { en: `${id} College` }, degree: { en: degree }, field: { en: null }, start, end, ...o });
    const course = edu('course', 'Full Stack Development Course', '2024', '2025');
    const degree = edu('degree', 'Practical Software Engineer', '2021', '2024', { field: { en: 'Software Engineering' }, city: { en: 'Netanya' } });
    const older = edu('older', 'B.A. Economics', '2010', '2013');
    const p = ProfileSchema.parse({ contact: { name: { en: 'Test Person' }, city: { en: 'Tel Aviv' } }, forms: { city: { en: 'Netanya' }, country: { he: 'ישראל', en: 'Israel' } }, education: [course, older, degree] });
    expect(p.education.map(isCourse)).toEqual([true, false, false]);
    expect(isCourse({ kind: null, degree: { he: 'קורס פיתוח', en: null } })).toBe(true);
    expect(isCourse({ kind: 'degree', degree: { he: null, en: 'Full Stack Development Course' } })).toBe(false); // your choice wins
    expect(orderEducation(p.education).map((e) => e.id)).toEqual(['degree', 'older', 'course']);
    expect(educationEntries(p, 'en')[0]).toMatchObject({ institution: 'degree College', degree: 'Practical Software Engineer', field: 'Software Engineering', city: 'Netanya', start: '2021', end: '2024' });
    expect(educationEntries(p, 'en')[2]!.city).toBe('');
    // your order wins (1 = first)
    p.education.find((e) => e.id === 'course')!.order = 1;
    expect(orderEducation(p.education).map((e) => e.id)).toEqual(['course', 'degree', 'older']);
    // the city for application forms, not the CV's
    fs.writeFileSync(profilePath(), JSON.stringify(p));
    try {
      expect((await fillData(db, null, 'en')).contact).toMatchObject({ city: 'Netanya', country: 'Israel', countryAlts: ['ישראל', 'Israel'], cityAlts: ['Netanya', 'Tel Aviv'] });
      fs.writeFileSync(profilePath(), JSON.stringify({ ...p, forms: { city: { he: null, en: null } } }));
      expect((await fillData(db, null, 'en')).contact.city).toBe('Tel Aviv');
    } finally {
      fs.rmSync(profilePath(), { force: true });
    }
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
      expect(d).toMatchObject({ lang: 'en', fillCoverLetters: true, experience: [], education: [], profile: { currentTitle: null, currentCompany: null, yearsExperience: null } });
      const a = (await app.inject({ method: 'POST', url: `/api/fill/jobs/${id}/applied`, headers: hdr(), payload: {} })).json();
      expect(a).toMatchObject({ ok: true, already: false });
      expect(repo.getJob(id)).toMatchObject({ status: 'submitted_manual', statusReason: expect.stringMatching(/^applied by hand on LinkedIn .*JobHunter Fill/) });
      expect((await app.inject({ method: 'POST', url: `/api/fill/jobs/${id}/applied`, headers: hdr(), payload: {} })).json()).toMatchObject({ already: true });
    } finally {
      fs.rmSync(profilePath(), { force: true });
    }
  });
});
