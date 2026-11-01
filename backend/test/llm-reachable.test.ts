/**
 * The scoring model checked before a run needs it: a run started from the dashboard while Ollama is not running is
 * refused with "llm_unreachable" (the dashboard offers to start it, or to run without scoring); score() never fails at
 * the first job because of it (the jobs wait, with the reason on the run). The companies run always builds its
 * per-company summary, also when scoring fails, with the reason. A SmartRecruiters job is never scored on its title
 * alone: "Score only" reads its ad first. "xEngineer" (Wix's software engineer) is a whole-word title keyword.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-llm-reach';
  process.env.PREFERENCES_FILE = 'data/test-llm-reach/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return {
    reach: { ok: true, reason: null as string | null, canStart: true },
    scoreErr: null as Error | null,
    scored: [] as Array<{ title: string; descriptionText: string }>,
    started: 0,
  };
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/llm/reachable.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm/reachable.js')>()),
  llmReachable: async () => ({ ...h.reach }),
  startOllama: async () => (h.started++, (h.reach = { ok: true, reason: null, canStart: true }), true),
}));
vi.mock('../src/llm/score.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm/score.js')>()),
  candidateContext: () => 'candidate',
  scoreJob: async (j: { title: string; descriptionText: string }) => {
    if (h.scoreErr) throw h.scoreErr;
    h.scored.push({ title: j.title, descriptionText: j.descriptionText });
    return {
      score: 70, matchedSkills: [], missingRequirements: [], seniorityFit: 'fit', reasoningHe: 'מתאים.', requiredYearsMin: null, requiredYearsQuote: null,
      seniority: 'junior', devContentScore: 50, isTrainingProgram: false, isFrontLineSupport: false, model: 'm', cached: false,
    };
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { prefilter } from '../src/core/prefilter.js';
import { loadPrefs } from '../src/core/prefs.js';
import { runCompaniesToCompletion } from '../src/companies/run.js';
import { companiesFile, saveCompanies, type Company } from '../src/companies/store.js';
import { srListToRawJob, type SrListItem, type SrPosting } from '../src/companies/smartrecruiters.js';
import { pauseSite, sitePauses, unpauseSite } from '../src/core/site-pause.js';
import { buildApp } from '../src/server/app.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const SR = JSON.parse(fx('smartrecruiters-postings.json')) as { content: SrListItem[] };
const SR1 = JSON.parse(fx('smartrecruiters-posting.json')) as SrPosting;
const GH = JSON.parse(fx('greenhouse-jobs.json'));

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(
  config.paths.preferences,
  'locations: [תל אביב, Tel Aviv]\nroleTypes:\n  - { id: software, tier: 1, queries: [x], titleKeywords: [software engineer, developer, xEngineer] }\n  - { id: data, tier: 1, queries: [x], titleKeywords: [analyst, engineer, lead] }\n',
);

const company = (o: Partial<Company>): Company => ({ id: `${o.ats}:${o.board}`, name: '', url: 'https://x', ats: 'greenhouse', board: 'similarweb', slug: null, enabled: true, addedAt: '', lastCheck: null, comeetToken: null, ...o }) as Company;
const calls: string[] = [];
const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url);
  if (/boards-api\.greenhouse\.io\/v1\/boards\/similarweb\/jobs\?content=true/.test(url)) return Response.json(GH);
  const m = /\/postings\/(\d+)$/.exec(url);
  if (m) return Response.json({ ...SR1, ...SR.content.find((x) => x.id === m[1]) });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

let db: DB;
let repo: Repo;
beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  if (fs.existsSync(companiesFile())) fs.rmSync(companiesFile());
  for (const s of Object.keys(sitePauses())) unpauseSite(s);
  h.reach = { ok: true, reason: null, canStart: true };
  h.scoreErr = null;
  h.scored.length = 0;
  h.started = 0;
  calls.length = 0;
});
const lastRun = () => repo.listRuns(1)[0] as unknown as { status: string; reason: string | null; stats: Record<string, number> };
const down = () => (h.reach = { ok: false, reason: 'Ollama is not running (http://127.0.0.1:11434)', canStart: true });

describe('scoring without the model', () => {
  it('the companies run: the lists are read, scoring waits (never fails at the first job); the summary has the reason and the waiting count', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb', name: 'Similarweb' })]);
    down();
    const p = (await runCompaniesToCompletion(db, { fetchImpl }))!;
    expect(h.scored).toEqual([]);
    expect(p.error).toBe('scoring waits: Ollama is not running (http://127.0.0.1:11434)');
    const c = p.companies[0]!;
    expect(c).toMatchObject({ name: 'Similarweb', read: 5, inLocations: 3, scored: 0 });
    expect(c.waiting).toBeGreaterThan(0);
    expect(lastRun()).toMatchObject({ status: 'done', reason: 'scoring waits: Ollama is not running (http://127.0.0.1:11434)' });
  });

  it('scoring that fails mid-way: the run fails with its reason, and the per-company summary is still there', async () => {
    saveCompanies([company({ ats: 'greenhouse', board: 'similarweb', name: 'Similarweb' })]);
    h.scoreErr = new Error('fetch failed');
    const p = (await runCompaniesToCompletion(db, { fetchImpl }))!;
    expect(p.finishedAt).toBeTruthy();
    expect(p.error).toMatch(/^failed: LLM provider not reachable/);
    expect(p.companies[0]).toMatchObject({ name: 'Similarweb', read: 5, inLocations: 3 });
    expect(lastRun().status).toBe('failed');
  });
});

describe('a SmartRecruiters job is never scored on its title alone', () => {
  const wix = company({ ats: 'smartrecruiters', board: 'Wix2', name: 'Wix' });
  const stored = (id: string) => {
    const raw = srListToRawJob('Wix2', 'Wix', SR.content.find((x) => x.id === id)!);
    repo.upsertJob(toJob(raw));
    return toJob(raw).id;
  };

  it('"Score only" reads the ad of a job that passes now (e.g. after a new keyword) before scoring it', async () => {
    saveCompanies([wix]);
    const id = stored('744000158476089'); // Business Analyst, Tel Aviv — no ad yet
    await runCompaniesToCompletion(db, { fetch: false, fetchImpl });
    expect(calls.filter((u) => /\/postings\/744000158476089$/.test(u))).toHaveLength(1);
    expect(repo.getJob(id)!.detailsFetched).toBe(true);
    expect(h.scored.find((s) => /Business Analyst/.test(s.title))?.descriptionText).toBeTruthy();
  });

  it('when the ad cannot be read (SmartRecruiters paused) the job waits instead of being scored', async () => {
    saveCompanies([wix]);
    stored('744000158476089');
    pauseSite('smartrecruiters', 'test');
    await runCompaniesToCompletion(db, { fetch: false, fetchImpl });
    expect(calls).toEqual([]);
    expect(h.scored).toEqual([]);
    expect(lastRun().stats.waitingForAd).toBe(1);
  });
});

describe('runs from the dashboard check the model first', () => {
  it('refused with "llm_unreachable" (the offer); "run without scoring" goes ahead; discovering only is never asked', async () => {
    const app = buildApp(db);
    down();
    for (const [url, body] of [
      ['/api/runs', { site: 'drushim', kind: 'score' }],
      ['/api/companies/score', {}],
      ['/api/jobs/rescore', {}],
      ['/api/hunt', {}],
    ] as const) {
      const r = await app.inject({ method: 'POST', url, payload: body });
      expect(r.statusCode, url).toBe(409);
      expect(r.json(), url).toMatchObject({ code: 'llm_unreachable', canStart: true, error: expect.stringMatching(/Ollama is not running/) });
    }
    const without = await app.inject({ method: 'POST', url: '/api/companies/score', payload: { withoutLlm: true } });
    expect(without.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const { waitIdle } = await import('../src/pipeline/runner.js');
    await waitIdle();
    const discover = await app.inject({ method: 'POST', url: '/api/runs', payload: { site: 'nosuchsite', kind: 'discover' } });
    expect(discover.json().code).toBeUndefined();
  });

  it('"Start Ollama" starts it (as npm start does); not offered for an API provider', async () => {
    const app = buildApp(db);
    down();
    const r = await app.inject({ method: 'POST', url: '/api/llm/start-ollama' });
    expect(r.json()).toEqual({ ok: true });
    expect(h.started).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/llm/start-ollama' })).json()).toEqual({ ok: true, already: true });
    h.reach = { ok: true, reason: null, canStart: false };
    expect((await app.inject({ method: 'POST', url: '/api/llm/start-ollama' })).statusCode).toBe(409);
  });
});

describe('"xEngineer" (Wix\'s software engineer)', () => {
  it('a whole-word title keyword: "xEngineer for Wix Headless" passes; "Senior xEngineer" is still a seniority skip', () => {
    const prefs = loadPrefs();
    const t = (title: string) => prefilter({ title, company: 'Wix', location: 'Tel Aviv', descriptionText: '', roleTypes: [] }, prefs);
    expect(t('xEngineer for Wix Headless').pass).toBe(true);
    expect(t('xEngineer (Backend oriented), Premium Billing Platform').pass).toBe(true);
    expect(t('Senior xEngineer (Backend Oriented) - User Voice')).toMatchObject({ pass: false, reason: expect.stringMatching(/seniority/) });
  });
});
