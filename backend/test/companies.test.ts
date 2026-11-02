/**
 * Target companies (Greenhouse, Comeet, SmartRecruiters, Workable): ATS detection from a careers URL / job link / page, the two readers (sanitized
 * real API answers, 2026-11-01), Comeet's request discipline (one positions request per company per run; the token only
 * from the company's public page; a rejected token is not retried; never stored on a job), the run (only your locations,
 * prefilter + scoring, a Drushim copy wins for applying, a refusal pauses that ATS), the Companies routes, the Greenhouse
 * form answered ahead for the assisted panel (profile / bank only, never drafted), and no ATS page in the automated browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-companies';
  process.env.PREFERENCES_FILE = 'data/test-companies/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { pace: vi.fn(async () => undefined) };
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: h.pace,
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { waitIdle } from '../src/pipeline/runner.js';
import { detectAts, detectFromHtml, detectFromUrl, nameVariants } from '../src/companies/detect.js';
import { ghQuestionFields, ghToRawJob, type GhJob } from '../src/companies/greenhouse.js';
import { comeetToken, comeetToRawJob, type ComeetPosition } from '../src/companies/comeet.js';
import { srListToRawJob, srPostingToRawJob, type SrListItem, type SrPosting } from '../src/companies/smartrecruiters.js';
import { wkJobToRawJob, wkListToRawJob, type WkJob, type WkListJob } from '../src/companies/workable.js';
import { fetchCompanyJobs, isIsraelLocation, keepCompanyJob } from '../src/companies/fetch.js';
import { addCompany, cleanUrl, companiesFile, companyId, loadCompanies, saveCompanies, seedCompanies, updateCompany, type Company } from '../src/companies/store.js';
import { runCompaniesToCompletion } from '../src/companies/run.js';
import { formAnswers } from '../src/companies/answers.js';
import { isAssistedOnlyHost } from '../src/alerts/assisted.js';
import { isPaused, sitePauses, unpauseSite } from '../src/core/site-pause.js';
import { prepareJobs } from '../src/apply/service.js';
import { buildApp } from '../src/server/app.js';
import { ProfileSchema } from '../src/profile/schema.js';
import { profilePath } from '../src/profile/facts.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const GH = JSON.parse(fx('greenhouse-jobs.json')) as { jobs: GhJob[] };
const GHQ = JSON.parse(fx('greenhouse-questions.json'));
const POSITIONS = JSON.parse(fx('comeet-positions.json')) as ComeetPosition[];
const COMEET_PAGE = fx('comeet-page.html');
const TOKEN = '0000FIXTURE0000TOKEN0000000000000000';
const SR = JSON.parse(fx('smartrecruiters-postings.json')) as { totalFound: number; content: SrListItem[] };
const SR1 = JSON.parse(fx('smartrecruiters-posting.json')) as SrPosting;
const WKL = JSON.parse(fx('workable-widget.json')) as { name: string; jobs: WkListJob[] };
const WK1 = JSON.parse(fx('workable-job.json')) as WkJob;

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(
  config.paths.preferences,
  'locations: [תל אביב, Tel Aviv, הרצליה]\nfilters: { remoteKeywords: [remote] }\nroleTypes:\n  - { id: dev, tier: 1, queries: [x], titleKeywords: [engineer, developer, researcher, analyst, lead, executive, specialist] }\n',
);

/** a fetch stand-in: answers by URL, records every request */
function fakeFetch(routes: Array<[RegExp, (url: string) => { status?: number; body: unknown }]>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response('not found', { status: 404 });
    const { status = 200, body } = hit[1](url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

const company = (o: Partial<Company>): Company => ({ id: `${o.ats}:${o.board}`, name: '', url: 'https://x', ats: 'greenhouse', board: 'similarweb', slug: null, enabled: true, addedAt: '', lastCheck: null, comeetToken: null, ...o }) as Company;

let db: DB;
let repo: Repo;
beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  if (fs.existsSync(companiesFile())) fs.rmSync(companiesFile());
  for (const s of Object.keys(sitePauses())) unpauseSite(s);
  h.pace.mockClear();
});

describe('ATS detection', () => {
  it('from the address: Greenhouse board / job link, Comeet company page / job link; Lever and Ashby are detected only', () => {
    expect(detectFromUrl('https://job-boards.greenhouse.io/similarweb/jobs/6897277')).toMatchObject({ ats: 'greenhouse', board: 'similarweb', supported: true, how: 'url' });
    expect(detectFromUrl('https://boards.greenhouse.io/embed/job_board?for=pagaya')).toMatchObject({ ats: 'greenhouse', board: 'pagaya' });
    expect(detectFromUrl('https://job-boards.eu.greenhouse.io/acme')).toMatchObject({ ats: 'greenhouse', board: 'acme' });
    expect(detectFromUrl('https://www.comeet.com/jobs/cyera/17.008/ai-researcher/2B.D67')).toMatchObject({ ats: 'comeet', board: '17.008', slug: 'cyera', supported: true });
    expect(detectFromUrl('https://jobs.lever.co/palantir/6ed76ce8')).toMatchObject({ ats: 'lever', board: 'palantir', supported: false });
    expect(detectFromUrl('https://jobs.ashbyhq.com/linear/abc/application')).toMatchObject({ ats: 'ashby', board: 'linear', supported: false });
    expect(detectFromUrl('https://www.example.com/careers')).toBeNull();
  });

  it('from a careers page: links / embeds; a widget without its id asks for one job link', () => {
    expect(detectFromHtml('<a href="https://www.comeet.com/jobs/cyera/17.008/careers/01.06D">job</a>')).toMatchObject({ ats: 'comeet', board: '17.008', slug: 'cyera', how: 'page' });
    expect(detectFromHtml('<script src="https://boards.greenhouse.io/embed/job_board/js?for=pagaya"></script>')).toMatchObject({ ats: 'greenhouse', board: 'pagaya' });
    expect(detectFromHtml('<div class="comeet-list comeet-g-r">…</div>')).toMatchObject({ ats: 'comeet', board: null, supported: false, evidence: expect.stringMatching(/paste one job link/) });
    expect(detectFromHtml('<a href="/careers/x?gh_jid=123">x</a>')).toMatchObject({ ats: 'greenhouse', board: null, supported: false });
  });

  it('no request when the address says it all; otherwise ONE plain request to the page', async () => {
    const none = fakeFetch([]);
    await detectAts('https://job-boards.greenhouse.io/similarweb', none.f);
    expect(none.calls).toEqual([]);
    const page = fakeFetch([[/acme\.example/, () => ({ body: '<a href="https://job-boards.greenhouse.io/acme/jobs/1">Apply</a>' })]]);
    expect(await detectAts('https://www.acme.example/careers', page.f)).toMatchObject({ ats: 'greenhouse', board: 'acme', how: 'page' });
    expect(page.calls).toHaveLength(1);
    const err = fakeFetch([[/acme\.example/, () => ({ status: 403, body: 'no' })]]);
    expect(await detectAts('https://www.acme.example/careers', err.f)).toMatchObject({ ats: 'unknown', evidence: 'the page answered HTTP 403 — paste one job link from this company' });
  });

  it('name variants from the name you give and the domain', () => {
    expect(nameVariants('', 'https://www.similarweb.com/corp/careers/')).toEqual(['similarweb']);
    expect(nameVariants('', 'https://careers.wix.com/positions')).toEqual(['wix']);
    expect(nameVariants('', 'https://www.matrix.co.il/jobs/')).toEqual(['matrix']);
    expect(nameVariants('Similar Web', 'https://www.similarweb.com/x')).toEqual(['similarweb']);
    expect(nameVariants('מטריקס', 'https://www.matrix.co.il/')).toEqual(['matrix']);
  });

  it('a page built by script: the ATS APIs asked by name (Greenhouse board first); a few requests at most', async () => {
    const gh = fakeFetch([
      [/similarweb\.com\/corp\/careers/, () => ({ body: '<html><script src="/app.js"></script><div id="root"></div></html>' })],
      [/boards-api\.greenhouse\.io\/v1\/boards\/similarweb$/, () => ({ body: { name: 'Similarweb', content: '' } })],
    ]);
    expect(await detectAts('https://www.similarweb.com/corp/careers/', gh.f)).toMatchObject({ ats: 'greenhouse', board: 'similarweb', supported: true, how: 'probe' });
    expect(gh.calls).toHaveLength(2); // the page, then one board check
    const none = fakeFetch([[/careers\.wix\.com/, () => ({ body: '<html><script></script></html>' })]]);
    const d = await detectAts('https://careers.wix.com/positions', none.f, 'Wix');
    expect(d).toMatchObject({ ats: 'unknown', evidence: expect.stringMatching(/paste one job link from this company$/) });
    expect(none.calls.length).toBeLessThanOrEqual(1 + 6);
    expect(none.calls.filter((u) => /comeet/.test(u))).toEqual([]); // Comeet cannot be asked by name
  });
});

describe('readers', () => {
  it('Greenhouse: description decoded, location with the office country, the hosted form as the apply target', () => {
    const j = ghToRawJob('similarweb', '', GH.jobs.find((x) => x.id === 7972320)!);
    expect(j).toMatchObject({ site: 'greenhouse', externalId: 'similarweb:7972320', company: 'Similarweb', applyType: 'external', applyTarget: 'https://job-boards.greenhouse.io/similarweb/jobs/7972320', detailsFetched: true });
    expect(j.location).toMatch(/Israel/);
    expect(j.descriptionText).not.toMatch(/&lt;|<p>/);
    expect(j.descriptionText.length).toBeGreaterThan(100);
  });

  it('Greenhouse questions → plan fields: files are yours to attach, yes/no selects become yes/no', () => {
    const f = ghQuestionFields(GHQ.questions);
    expect(f.map((x) => x.label)).toEqual(expect.arrayContaining(['First Name', 'Last Name', 'Email', 'Phone', 'LinkedIn Profile']));
    expect(f.some((x) => /Resume|Cover Letter/i.test(x.label))).toBe(false);
    expect(ghQuestionFields([{ label: 'Are you authorized to work in Israel?', required: true, fields: [{ name: 'question_1', type: 'multi_value_single_select', values: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] }] }])[0]).toMatchObject({ type: 'yes_no', required: true });
  });

  it('Comeet: the token only from the company page (and only for that company UID)', () => {
    expect(comeetToken(COMEET_PAGE, '17.008')).toEqual({ uid: '17.008', token: TOKEN });
    expect(comeetToken(COMEET_PAGE, '99.999')).toBeNull();
    expect(comeetToken('<html>no data</html>')).toBeNull();
  });

  it('Comeet: description / requirements split, Israel from the country code, and never the token-bearing API address', () => {
    const p = { ...POSITIONS[0]!, position_url: `https://www.comeet.co/careers-api/2.0/company/17.008/positions/75.277?token=${TOKEN}` };
    const j = comeetToRawJob('17.008', '', p);
    expect(j).toMatchObject({ site: 'comeet', externalId: '17.008:75.277', company: 'Cyera', applyType: 'external' });
    expect(j.location).toMatch(/Israel/);
    expect(j.requirementsText.length).toBeGreaterThan(20);
    expect(JSON.stringify(j)).not.toContain(TOKEN);
    expect(JSON.stringify(j)).not.toMatch(/@|arrival/);
  });

  it('kept: in Israel and in your locations — English city names match Hebrew locations; remote / hybrid abroad does not', () => {
    const prefs = { locations: ['תל אביב', 'הרצליה'], filters: { remoteKeywords: ['remote', 'hybrid'] } } as never;
    const j = (location: string, country: string | null = null) => ({ ...ghToRawJob('x', 'X', GH.jobs[0]!), location, raw: { country } });
    expect(keepCompanyJob(j('Tel Aviv-Yafo'), prefs)).toBe(true);
    expect(keepCompanyJob(j('Herzliya, Israel'), prefs)).toBe(true);
    expect(keepCompanyJob(j('Haifa, Israel'), prefs)).toBe(false);
    expect(keepCompanyJob(j('Israel, Remote', 'IL'), prefs)).toBe(true);
    expect(keepCompanyJob(j('Australia, Sydney, AU, Remote', 'AU'), prefs)).toBe(false);
    expect(keepCompanyJob(j('New York, NY · Hybrid'), prefs)).toBe(false);
    expect(keepCompanyJob(j(''), prefs)).toBe(true);
  });

  it('Israel locations', () => {
    expect(isIsraelLocation('Tel Aviv-Yafo')).toBe(true);
    expect(isIsraelLocation('', 'IL')).toBe(true);
    expect(isIsraelLocation('Burlington, MA')).toBe(false);
  });
});

describe('Comeet request discipline', () => {
  const routes = (positions: { status?: number } = {}) =>
    fakeFetch([
      [/comeet\.com\/jobs\//, () => ({ body: COMEET_PAGE })],
      [/careers-api\/2\.0\/company\/17\.008\/positions/, () => ({ status: positions.status ?? 200, body: positions.status ? { error: 'x' } : POSITIONS })],
    ]);
  const cyera = (o: Partial<Company> = {}) => company({ ats: 'comeet', board: '17.008', slug: 'cyera', ...o });

  it('no token kept: the public page once, then ONE positions request; internal postings left out', async () => {
    const { f, calls } = routes();
    const r = await fetchCompanyJobs(cyera(), f);
    expect(calls.map((u) => (/careers-api/.test(u) ? 'positions' : 'page'))).toEqual(['page', 'positions']);
    expect(r.token?.value).toBe(TOKEN);
    expect(r.total).toBe(POSITIONS.length - 1);
    expect(r.israel).toBe(3);
  });

  it('a kept token: exactly one request (the positions)', async () => {
    const { f, calls } = routes();
    await fetchCompanyJobs(cyera({ comeetToken: { value: TOKEN, readAt: '' } }), f);
    expect(calls).toHaveLength(1);
  });

  it('a kept token rejected: not retried now; dropped so the page is read again next run', async () => {
    const { f, calls } = routes({ status: 401 });
    const r = await fetchCompanyJobs(cyera({ comeetToken: { value: 'OLD', readAt: '' } }), f);
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ token: null, error: expect.stringMatching(/rejected.*next run/) });
  });

  it('HTTP 429 is a refusal (the caller pauses the ATS)', async () => {
    const { f } = routes({ status: 429 });
    expect((await fetchCompanyJobs(cyera({ comeetToken: { value: TOKEN, readAt: '' } }), f)).blocked).toMatch(/HTTP 429/);
  });
});

describe('the companies run', () => {
  const ghFetch = (status = 200) => fakeFetch([[/boards-api\.greenhouse\.io\/v1\/boards\/similarweb\/jobs\?content=true/, () => ({ status, body: status === 200 ? GH : 'no' })]]);

  it('reads each enabled company once, keeps only your locations, prefilters and scores; records the totals and the ATS name', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb' }), company({ ats: 'lever', board: 'palantir', enabled: false })]);
    const { f, calls } = ghFetch();
    await runCompaniesToCompletion(db, { fetchImpl: f });
    expect(calls).toHaveLength(1);
    const jobs = repo.listJobs({ site: 'greenhouse', limit: 100 }).items;
    expect(jobs.length).toBe(3); // the 3 Tel Aviv jobs; Burlington / New York left out
    expect(jobs.every((j) => /Tel Aviv/.test(j.location))).toBe(true);
    expect(jobs.every((j) => !!j.prefilterReason)).toBe(true); // prefiltered (scoring waits for an approved profile here)
    const c = loadCompanies().find((x) => x.board === 'similarweb')!;
    expect(c).toMatchObject({ name: 'Similarweb', lastCheck: { total: 5, israel: 3, kept: 3, error: null } });
  });

  it('the same job on Drushim keeps the Drushim copy for applying (whichever came first)', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb' })]);
    const gj = GH.jobs.find((x) => x.id === 7972320)!;
    await runCompaniesToCompletion(db, { fetchImpl: ghFetch().f });
    const d = toJob({ site: 'drushim', externalId: '777', company: 'Similarweb', title: gj.title, location: 'תל אביב', descriptionText: 'x', requirementsText: '', url: 'https://www.drushim.co.il/job/777/', postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'en', detailsFetched: true, raw: {} });
    repo.upsertJob(d);
    expect(repo.dedupeNewJob(repo.getJob(d.id)!, 14)).toMatchObject({ duplicateOf: null, absorbed: expect.any(String) });
    const ghCopy = repo.listJobs({ site: 'greenhouse', limit: 100 }).items.find((j) => j.externalId === 'similarweb:7972320')!;
    expect(repo.getJob(ghCopy.id)).toMatchObject({ status: 'skipped_duplicate', duplicateOf: d.id });
  });

  it('the companies-only run reports per company: read / Israel / in your locations / skipped by reason / scored / answers / ready', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb', name: 'Similarweb' })]);
    const f = fakeFetch([
      [/jobs\?content=true/, () => ({ body: GH })],
      [/questions=true/, () => ({ body: GHQ })],
    ]);
    const p = (await runCompaniesToCompletion(db, { fetchImpl: f.f }))!;
    expect(p.finishedAt).toBeTruthy();
    const c = p.companies[0]!;
    expect(c).toMatchObject({ name: 'Similarweb', ats: 'greenhouse', read: 5, israel: 3, inLocations: 3, added: 3 });
    expect(c.skipped.reduce((n, s) => n + s.count, 0) + c.ready).toBeLessThanOrEqual(c.inLocations!);
    for (const s of c.skipped) expect(s.examples.length).toBeGreaterThan(0);
    // scoring waits for an approved profile here; no job is scored, so no answers are prepared
    expect(c.scored).toBe(0);
    expect(c.answersPrepared).toBe(0);
  });

  it('Score only (no list read): the summary shows the totals of the last read, not "—"; the Jobs list can show company jobs only', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb', name: 'Similarweb' })]);
    await runCompaniesToCompletion(db, { fetchImpl: ghFetch().f });
    const again = ghFetch();
    const p = (await runCompaniesToCompletion(db, { fetch: false, fetchImpl: again.f }))!;
    expect(again.calls).toEqual([]);
    expect(p.companies[0]).toMatchObject({ name: 'Similarweb', read: 5, israel: 3, inLocations: 3, added: 0 });
    repo.upsertJob(toJob({ site: 'drushim', externalId: '1', company: 'X', title: 'Developer', location: 'תל אביב', descriptionText: 'x', requirementsText: '', url: 'https://www.drushim.co.il/job/1/', postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'he', detailsFetched: true, raw: {} }));
    const companyJobs = repo.listJobs({ site: 'companies', limit: 100 }).items;
    expect(companyJobs).toHaveLength(3);
    expect(companyJobs.every((j) => j.site === 'greenhouse')).toBe(true);
  });

  it('a refusal pauses that ATS for 48 hours; a paused ATS is not read', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb' })]);
    await runCompaniesToCompletion(db, { fetchImpl: ghFetch(429).f });
    expect(isPaused('greenhouse')).toBe(true);
    const again = ghFetch();
    await runCompaniesToCompletion(db, { fetchImpl: again.f });
    expect(again.calls).toEqual([]);
  });

  it('company jobs are never prepared by the automated flow', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb' })]);
    await runCompaniesToCompletion(db, { fetchImpl: ghFetch().f });
    const j = repo.listJobs({ site: 'greenhouse', limit: 1 }).items[0]!;
    expect(() => prepareJobs(db, [j.id])).toThrow(/applied to by hand/);
    await waitIdle();
  });
});

describe('companies.yaml and the Companies routes', () => {
  it('addresses lose ad tracking; an id stays short (an address with a long query gave HTTP 414)', () => {
    const long = 'https://www.sqlink.com/hightechjob/?utm_source=google&utm_medium=cpc&gad_source=1&gbraid=0AAAA&gclid=CjwKCAjw&page=2#x';
    expect(cleanUrl(long)).toBe('https://www.sqlink.com/hightechjob/?page=2');
    expect(companyId('unknown', null, long)).toBe('unknown:sqlink.com/hightechjob');
    expect(companyId('greenhouse', 'similarweb', long)).toBe('greenhouse:similarweb');
    saveCompanies([{ ...company({ ats: 'unknown', board: null }), id: `unknown:${long}`, url: long }]);
    expect(loadCompanies()[0]).toMatchObject({ id: 'unknown:sqlink.com/hightechjob', url: 'https://www.sqlink.com/hightechjob/?page=2' });
  });

  it('seeded empty; a company on an unsupported ATS is listed but never turned on', () => {
    seedCompanies();
    expect(fs.readFileSync(companiesFile(), 'utf8')).toMatch(/companies: \[\]/);
    const c = addCompany({ ats: 'lever', board: 'palantir', supported: false, how: 'url', evidence: '' }, 'https://jobs.lever.co/palantir');
    expect(c.enabled).toBe(false);
    expect(updateCompany(c.id, { enabled: true })!.enabled).toBe(false);
  });

  it('a company on your excluded list is refused, with the reason (by its name, its domain, or the ATS\'s name)', async () => {
    fs.writeFileSync(config.paths.preferences, fs.readFileSync(config.paths.preferences, 'utf8').replace('filters: { remoteKeywords: [remote] }', 'filters: { remoteKeywords: [remote], excludeCompanies: [matrix, מטריקס, Similarweb] }'));
    const { f } = fakeFetch([[/boards-api\.greenhouse\.io/, () => ({ body: GH })]]);
    vi.stubGlobal('fetch', f);
    try {
      const app = buildApp(db);
      const m = await app.inject({ method: 'POST', url: '/api/companies', payload: { url: 'https://www.matrix.co.il/jobs/' } });
      expect(m.statusCode).toBe(409);
      expect(m.json().error).toBe('not added: "matrix" is on your excluded companies (matches "matrix")');
      // detected fine, but the ATS reports the company name "Similarweb" — excluded too
      const s = await app.inject({ method: 'POST', url: '/api/companies', payload: { url: 'https://job-boards.greenhouse.io/similarweb' } });
      expect(s.statusCode).toBe(409);
      expect(loadCompanies()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      fs.writeFileSync(config.paths.preferences, fs.readFileSync(config.paths.preferences, 'utf8').replace(', excludeCompanies: [matrix, מטריקס, Similarweb]', ''));
    }
  });

  it('add → detect + one read of the list for the totals; enable / disable; remove', async () => {
    const { f } = fakeFetch([[/boards-api\.greenhouse\.io/, () => ({ body: GH })]]);
    vi.stubGlobal('fetch', f);
    try {
      const app = buildApp(db);
      const r = (await app.inject({ method: 'POST', url: '/api/companies', payload: { url: 'https://job-boards.greenhouse.io/similarweb' } })).json();
      expect(r.detected).toMatchObject({ ats: 'greenhouse', board: 'similarweb', supported: true });
      expect(r.preview).toMatchObject({ total: 5, israel: 3, kept: 3, error: null });
      const id = r.companies[0].id;
      expect((await app.inject({ method: 'PATCH', url: `/api/companies/${encodeURIComponent(id)}`, payload: { enabled: false } })).json().companies[0].enabled).toBe(false);
      const lever = (await app.inject({ method: 'POST', url: '/api/companies', payload: { url: 'https://jobs.lever.co/palantir' } })).json();
      expect(lever.companies.find((c: Company) => c.ats === 'lever')).toMatchObject({ enabled: false, supported: false, status: 'Lever: not supported yet' });
      expect((await app.inject({ method: 'PATCH', url: `/api/companies/${encodeURIComponent('lever:palantir')}`, payload: { enabled: true } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: `/api/companies/${encodeURIComponent(id)}` })).json().companies).toHaveLength(1);
      // the view never shows the Comeet token
      expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/companies' })).json())).not.toContain(TOKEN);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the Greenhouse form, answered ahead for the assisted panel', () => {
  it('questions read once per job; profile and answers-bank answers ready; the rest pending; never drafted', async () => {
    fs.writeFileSync(profilePath(), JSON.stringify(ProfileSchema.parse({ contact: { name: { en: 'Test Person' }, email: 'test@example.com', phone: '050-0000000', city: {} }, links: [{ id: 'link.linkedin', label: 'LinkedIn', url: 'https://linkedin.com/in/test' }] })));
    try {
      saveCompanies([company({ ats: 'greenhouse', board: 'similarweb' })]);
      await runCompaniesToCompletion(db, { fetchImpl: fakeFetch([[/jobs\?content=true/, () => ({ body: GH })]]).f });
      const job = repo.listJobs({ site: 'greenhouse', limit: 1 }).items[0]!;
      const q = fakeFetch([[/questions=true/, () => ({ body: GHQ })]]);
      const a = (await formAnswers(db, repo.getJob(job.id)!, q.f))!;
      expect(a.error).toBeNull();
      const by = (l: string) => a.answers.find((x) => x.label === l)!;
      expect(by('First Name')).toMatchObject({ status: 'resolved', value: 'Test' });
      expect(by('Email')).toMatchObject({ status: 'resolved', value: 'test@example.com', source: expect.stringMatching(/^profile/) });
      expect(by('LinkedIn Profile')).toMatchObject({ status: 'resolved', value: 'https://linkedin.com/in/test' });
      expect(a.answers.every((x) => !/draft/.test(x.source))).toBe(true);
      await formAnswers(db, repo.getJob(job.id)!, q.f);
      expect(q.calls).toHaveLength(1); // kept on the job after the first read
    } finally {
      fs.rmSync(profilePath(), { force: true });
    }
  });
});

describe('SmartRecruiters', () => {
  const wix = (o: Partial<Company> = {}) => company({ ats: 'smartrecruiters', board: 'Wix2', name: 'Wix', ...o });
  /** the list in two pages (5 + 3) and every posting's ad (the fixture's, under each id) */
  const srFetch = (o: { status?: number; empty?: boolean; detailStatus?: number } = {}) =>
    fakeFetch([
      [/\/postings\?limit=100&offset=0/, () => ({ status: o.status ?? 200, body: o.status ? 'no' : o.empty ? { totalFound: 0, content: [] } : { ...SR, content: SR.content.slice(0, 5) } })],
      [/\/postings\?limit=100&offset=5/, () => ({ body: { ...SR, offset: 5, content: SR.content.slice(5) } })],
      [/\/postings\/(\d+)$/, (u) => ({ status: o.detailStatus ?? 200, body: o.detailStatus ? 'no' : { ...SR1, ...SR.content.find((x) => u.endsWith(`/${x.id}`)) } })],
    ]);
  const details = (calls: string[]) => calls.filter((u) => /\/postings\/\d+$/.test(u));

  it('detection: the "Easy apply" link, a job page, the careers page and the API address give the company id', () => {
    expect(detectFromUrl('https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2/publication/8563a7fa-d926-41a8-9ece-49e1501d03bf')).toMatchObject({ ats: 'smartrecruiters', board: 'Wix2' });
    expect(detectFromUrl('https://jobs.smartrecruiters.com/Wix2/744000158971809-technical-support-team-lead')).toMatchObject({ ats: 'smartrecruiters', board: 'Wix2' });
    expect(detectFromUrl('https://careers.smartrecruiters.com/Wix2')).toMatchObject({ ats: 'smartrecruiters', board: 'Wix2' });
    expect(detectFromUrl('https://api.smartrecruiters.com/v1/companies/Wix2/postings')).toMatchObject({ ats: 'smartrecruiters', board: 'Wix2' });
    expect(detectFromUrl('https://jobs.smartrecruiters.com/oneclick-ui/')?.board ?? null).toBeNull();
  });

  it('the probe by name counts only a company that has postings (SmartRecruiters answers 200 for any name)', async () => {
    const none = fakeFetch([[/api\.smartrecruiters\.com\/v1\/companies\/[^/]+\/postings\?limit=1/, () => ({ body: { totalFound: 0, content: [] } })], [/careers\.example/, () => ({ body: '<html>script</html>' })]]);
    expect((await detectAts('https://careers.example/jobs', none.f, 'Nobody')).ats).toBe('unknown');
    const some = fakeFetch([[/companies\/wix\/postings\?limit=1/, () => ({ body: { totalFound: 89, content: [] } })], [/careers\.example/, () => ({ body: '<html>script</html>' })]]);
    expect(await detectAts('https://careers.example/jobs', some.f, 'Wix')).toMatchObject({ ats: 'smartrecruiters', board: 'wix', how: 'probe' });
  });

  it('readers: the list has title and location only ("il" → Israel); the ad gives description / requirements; never the recruiter', () => {
    const l = srListToRawJob('Wix2', 'Wix', SR.content[0]!);
    expect(l).toMatchObject({ site: 'smartrecruiters', externalId: 'Wix2:744000158971809', location: 'Tel Aviv, Israel', detailsFetched: false, descriptionText: '' });
    expect(l.applyTarget).toBe('https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2/publication/8563a7fa-d926-41a8-9ece-49e1501d03bf');
    expect(srListToRawJob('Wix2', 'Wix', SR.content.find((p) => p.location?.remote)!).location).toBe('Remote, OR, United States');
    const d = srPostingToRawJob('Wix2', 'Wix', SR1);
    expect(d.detailsFetched).toBe(true);
    expect(d.descriptionText).toMatch(/Technical Support Team Lead/);
    expect(d.descriptionText).toMatch(/Work model/); // additional information
    expect(d.requirementsText).toMatch(/2\+ years leading technical support/);
    expect(d.descriptionText).not.toMatch(/<p>|&#xa0;/);
    expect(JSON.stringify(d)).not.toMatch(/FIXTURE RECRUITER|avatar/);
  });

  it('the list: paged (100 per request, a pause between pages); no postings at all → most likely the wrong id; 429 → refusal', async () => {
    const ok = srFetch();
    const r = await fetchCompanyJobs(wix(), ok.f);
    expect(ok.calls).toHaveLength(2);
    expect(h.pace).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ total: 8, israel: 5, error: null, blocked: null });
    expect(details(ok.calls)).toEqual([]); // no ad is read here
    expect((await fetchCompanyJobs(wix(), srFetch({ empty: true }).f)).error).toMatch(/no SmartRecruiters postings for "Wix2"/);
    expect((await fetchCompanyJobs(wix(), srFetch({ status: 429 }).f)).blocked).toMatch(/HTTP 429/);
  });

  it('the run reads the full ad only for jobs that pass the title and location filters, with a pause before each; not again on the next run', async () => {
    saveCompanies([wix()]);
    const a = srFetch();
    const p = (await runCompaniesToCompletion(db, { fetchImpl: a.f }))!;
    const jobs = repo.listJobs({ site: 'smartrecruiters', limit: 100 }).items;
    expect(jobs).toHaveLength(5);
    expect(jobs.every((j) => /Israel/.test(j.location))).toBe(true);
    // only titles with your keywords — never Talent Sourcer / Brand and Web Designer
    const read = details(a.calls).map((u) => u.split('/').pop()!);
    const passed = jobs.filter((j) => j.detailsFetched).map((j) => j.externalId.split(':')[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect([...read].sort()).toEqual([...passed].sort());
    for (const id of ['744000157666699', '744000158967689']) expect(read).not.toContain(id);
    expect(h.pace).toHaveBeenCalledTimes(1 + read.length); // one between the list pages, one before each ad
    expect(p.companies[0]).toMatchObject({ name: 'Wix', ats: 'smartrecruiters', read: 8, israel: 5, inLocations: 5, postingsRead: read.length });
    const b = srFetch();
    const q = (await runCompaniesToCompletion(db, { fetchImpl: b.f }))!;
    expect(details(b.calls)).toEqual([]);
    expect(q.companies[0]!.postingsRead).toBe(0);
  });

  it('a refused ad pauses SmartRecruiters for 48 hours and stops reading', async () => {
    saveCompanies([wix()]);
    const a = srFetch({ detailStatus: 403 });
    await runCompaniesToCompletion(db, { fetchImpl: a.f });
    expect(details(a.calls)).toHaveLength(1);
    expect(isPaused('smartrecruiters')).toBe(true);
  });
});

describe('Workable', () => {
  const goarc = (o: Partial<Company> = {}) => company({ ats: 'workable', board: 'goarc', name: 'GOARC', ...o });
  const wkFetch = (o: { status?: number; detailStatus?: number } = {}) =>
    fakeFetch([
      [/apply\.workable\.com\/api\/v1\/widget\/accounts\/goarc$/, () => ({ status: o.status ?? 200, body: o.status ? 'no' : WKL })],
      [/apply\.workable\.com\/api\/v2\/accounts\/goarc\/jobs\/([A-Z0-9]+)$/, (u) => ({ status: o.detailStatus ?? 200, body: o.detailStatus ? 'no' : { ...WK1, shortcode: u.split('/').pop() } })],
    ]);
  const details = (calls: string[]) => calls.filter((u) => /\/api\/v2\/accounts\/goarc\/jobs\//.test(u));

  it('detection: the apply page, a job page, the careers page and the account subdomain give the account; "j" / "api" never do', () => {
    for (const u of ['https://apply.workable.com/goarc/j/30E379F87B/apply/', 'https://apply.workable.com/goarc/j/E822F93FB5/', 'https://apply.workable.com/goarc/', 'https://goarc.workable.com/'])
      expect(detectFromUrl(u), u).toMatchObject({ ats: 'workable', board: 'goarc' });
    expect(detectFromUrl('https://apply.workable.com/j/E822F93FB5')?.board ?? null).toBeNull();
    expect(detectFromUrl('https://apply.workable.com/api/v2/accounts/goarc/jobs/E822F93FB5')).toMatchObject({ ats: 'workable', board: 'goarc' });
  });

  it('the probe by name: the widget list of a real account with jobs', async () => {
    const some = fakeFetch([[/widget\/accounts\/goarc$/, () => ({ body: WKL })], [/careers\.example/, () => ({ body: '<html>script</html>' })]]);
    expect(await detectAts('https://careers.example/jobs', some.f, 'GOARC')).toMatchObject({ ats: 'workable', board: 'goarc', how: 'probe' });
    const none = fakeFetch([[/widget\/accounts\//, () => ({ status: 404, body: 'no' })], [/careers\.example/, () => ({ body: '<html>script</html>' })]]);
    expect((await detectAts('https://careers.example/jobs', none.f, 'Nobody')).ats).toBe('unknown');
  });

  it('readers: the list has title / location / shortcode only (Israel, Remote); the job gives description and requirements as text', () => {
    const l = wkListToRawJob('goarc', 'GOARC', WKL.jobs[0]!);
    expect(l).toMatchObject({ site: 'workable', externalId: 'goarc:E822F93FB5', company: 'GOARC', title: 'Full Stack Developer', location: 'Israel, Remote', detailsFetched: false, descriptionText: '' });
    expect(l.applyTarget).toBe('https://apply.workable.com/goarc/j/E822F93FB5/apply/');
    expect(l.url).toBe('https://apply.workable.com/goarc/j/E822F93FB5/');
    const d = wkJobToRawJob('goarc', 'GOARC', WK1);
    expect(d).toMatchObject({ detailsFetched: true, location: 'Israel, Remote' });
    expect(d.requirementsText).toMatch(/^What We're Looking For/);
    expect(d.requirementsText).toMatch(/6\+ years of experience/);
    expect(d.descriptionText).toMatch(/GOARC is an AI-native B2B SaaS company/);
    expect(d.descriptionText).not.toMatch(/<p>|<h3>/);
    expect(JSON.stringify(d)).not.toMatch(/accountUid/);
  });

  it('the list: one widget request, no ad; a missing account → "check the account"; 429 → refusal', async () => {
    const ok = wkFetch();
    const r = await fetchCompanyJobs(goarc(), ok.f);
    expect(ok.calls).toHaveLength(1);
    expect(r).toMatchObject({ total: 3, israel: 1, error: null, blocked: null }); // the other two are in Tennessee
    expect(details(ok.calls)).toEqual([]);
    expect((await fetchCompanyJobs(goarc(), wkFetch({ status: 404 }).f)).error).toMatch(/no Workable account "goarc"/);
    expect((await fetchCompanyJobs(goarc(), wkFetch({ status: 429 }).f)).blocked).toMatch(/HTTP 429/);
  });

  it('the run reads the full ad only for jobs that pass the title and location filters (a pause before each); not again next time', async () => {
    saveCompanies([goarc()]);
    const a = wkFetch();
    const p = (await runCompaniesToCompletion(db, { fetchImpl: a.f }))!;
    const jobs = repo.listJobs({ site: 'workable', limit: 100 }).items;
    expect(jobs).toHaveLength(1); // Israel (remote) only
    const read = details(a.calls).map((u) => u.split('/').pop()!);
    const passed = jobs.filter((j) => j.detailsFetched).map((j) => j.externalId.split(':')[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect([...read].sort()).toEqual([...passed].sort());
    expect(h.pace).toHaveBeenCalledTimes(read.length);
    expect(p.companies[0]).toMatchObject({ name: 'GOARC', ats: 'workable', read: 3, israel: 1, inLocations: 1, postingsRead: read.length });
    const b = wkFetch();
    await runCompaniesToCompletion(db, { fetchImpl: b.f });
    expect(details(b.calls)).toEqual([]);
  });

  it('a refused ad pauses Workable for 48 hours', async () => {
    saveCompanies([goarc()]);
    await runCompaniesToCompletion(db, { fetchImpl: wkFetch({ detailStatus: 403 }).f });
    expect(isPaused('workable')).toBe(true);
  });
});

describe('never in the automated browser', () => {
  it('ATS careers pages and apply forms are blocked like LinkedIn / Indeed', () => {
    for (const u of ['https://job-boards.greenhouse.io/x/jobs/1', 'https://boards.greenhouse.io/x', 'https://www.comeet.com/jobs/x/17.008', 'https://www.comeet.co/careers-api/2.0/company/x', 'https://jobs.lever.co/x', 'https://jobs.ashbyhq.com/x', 'https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2/publication/x', 'https://api.smartrecruiters.com/v1/companies/Wix2/postings', 'https://apply.workable.com/goarc/j/E822F93FB5/apply/', 'https://goarc.workable.com/'])
      expect(isAssistedOnlyHost(u)).toBe(true);
    expect(isAssistedOnlyHost('https://www.drushim.co.il/job/1/')).toBe(false);
  });
});
