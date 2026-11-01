/**
 * Paused sites and the per-session page budget: any block pauses the site for 48 hours (a run, a prepare, a send, a
 * session check); a paused site is not loaded at all (discovery, session checks, prepare / approve / batch, Run & send);
 * resuming takes one session check and happens only on a real page (a block re-pauses for 48 hours); JobKarov's page
 * budget (10 per session), its reserve for applying, and the search-term rotation under it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-pause';
  process.env.PREFERENCES_FILE = 'data/test-pause/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { searches: 0, openError: null as Error | null, opened: 0 };
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/jobkarov/apply.js', async (orig) => ({
  ...(await orig<typeof import('../src/sites/jobkarov/apply.js')>()),
  fetchAppliedJobs: async () => new Map(),
  installDryRunGuard: async () => async () => undefined,
  openPanel: async () => {
    h.opened++;
    if (h.openError) throw h.openError;
    return { fields: [], cvs: [{ code: '1', name: 'Test - Resume', checked: true }], hasCoverLetter: false, extra: { preview: {} } };
  },
  fillPanel: async () => undefined,
  screenshotPanel: async () => 'shot.png',
}));
vi.mock('../src/sites/registry.js', async (orig) => {
  const real = await orig<typeof import('../src/sites/registry.js')>();
  const fake = (id: 'drushim' | 'jobkarov') => ({
    id,
    displayName: id === 'drushim' ? 'Drushim' : 'JobKarov',
    loginUrl: '',
    async *search() {
      h.searches++;
    },
    async getDetails() {
      return null;
    },
  });
  const adapters = { drushim: fake('drushim'), jobkarov: fake('jobkarov') };
  return { ...real, adapters, getAdapter: (id: string) => adapters[id as 'drushim'] ?? real.getAdapter(id) };
});

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { BlockedError } from '../src/browser/session.js';
import { getActiveRun, startRun, startTask, waitIdle } from '../src/pipeline/runner.js';
import { approveBlock, prepareJobs } from '../src/apply/service.js';
import { Applications } from '../src/apply/plan.js';
import { isPaused, pauseExpired, pauseOf, pauseSite, pausedText, shortBlockReason, sitePauses, unpauseSite } from '../src/core/site-pause.js';
import { BudgetError, beginBudgetSession, endBudgetSession, loadsLeft, useLoad } from '../src/core/site-budget.js';
import { decideResume, resumeCheck } from '../src/pipeline/site-resume.js';
import { doneReport, runHunt } from '../src/pipeline/hunt.js';
import { jobkarov } from '../src/sites/jobkarov/adapter.js';
import type { SessionInfo } from '../src/browser/site-session.js';

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.mkdirSync(config.paths.screenshots, { recursive: true });
fs.writeFileSync(config.paths.preferences, 'cv: { he: a.pdf, en: b.pdf }\njobkarov:\n  cv: { he: "Test - Resume", en: "Test - Resume" }\nroleTypes:\n  - { id: fs, tier: 1, queries: [alpha, beta, gamma], titleKeywords: [developer] }\n');
const REFUSED = 'refused by the site (HTTP 402, reference 6578810) — the site is not serving this browser / network right now';

let db: DB;
let repo: Repo;
let n = 0;
const addJob = (site: 'jobkarov' | 'drushim' = 'jobkarov') => {
  const j = toJob({ site, externalId: String(9000 + ++n), company: `Co ${n}`, title: 'Developer', location: '', descriptionText: 'x', requirementsText: '', url: `https://example.com/${n}`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'en', detailsFetched: true, raw: {} });
  repo.upsertJob(j);
  repo.setStatus(j.id, 'scored');
  return repo.getJob(j.id)!;
};

beforeEach(async () => {
  await waitIdle();
  for (const s of Object.keys(sitePauses())) unpauseSite(s);
  db = openDb(':memory:');
  repo = new Repo(db);
  h.searches = 0;
  h.opened = 0;
  h.openError = null;
});

describe('the pause store', () => {
  it('48 hours, a short reason, the refusal text; expired after the 48 hours', () => {
    const now = new Date('2026-11-01T10:00:00Z');
    const p = pauseSite('jobkarov', REFUSED, { now });
    expect(p).toMatchObject({ reason: 'site refusing (402)', since: '2026-11-01T10:00:00.000Z', until: '2026-11-03T10:00:00.000Z', source: 'block' });
    expect(isPaused('jobkarov')).toBe(true);
    expect(pausedText('jobkarov', 'JobKarov')).toMatch(/^JobKarov is paused: site refusing \(402\)/);
    expect(pauseExpired(p, new Date('2026-11-03T09:59:00Z'))).toBe(false);
    expect(pauseExpired(p, new Date('2026-11-03T10:00:00Z'))).toBe(true);
    unpauseSite('jobkarov');
    expect(pauseOf('jobkarov')).toBeNull();
  });
  it('short reasons', () => {
    expect(shortBlockReason('rate limited (HTTP 429)')).toBe('rate limited (429)');
    expect(shortBlockReason('radware bot protection')).toBe('bot protection');
    expect(shortBlockReason('captcha challenge visible')).toBe('CAPTCHA / bot check');
    expect(shortBlockReason('3 job pages failed in a row — possible rate limiting; stopping')).toMatch(/rate limit/);
  });
});

describe('any block pauses the site; a paused site is not loaded', () => {
  it('a run that hits a block → that site paused for 48 hours', async () => {
    startTask(db, 'drushim', 'full', async () => {
      throw new BlockedError('radware bot protection');
    });
    await waitIdle();
    expect(pauseOf('drushim')).toMatchObject({ reason: 'bot protection', source: 'block' });
  });

  it('Discover on a paused site is refused (scoring alone still runs)', async () => {
    pauseSite('jobkarov', REFUSED);
    expect(() => startRun(db, 'jobkarov', 'full')).toThrow(/JobKarov is paused: site refusing \(402\)/);
    expect(h.searches).toBe(0);
    startRun(db, 'jobkarov', 'score');
    await waitIdle();
  });

  it('prepare: a paused site is refused; approve shows why', async () => {
    const job = addJob();
    pauseSite('jobkarov', REFUSED);
    expect(() => prepareJobs(db, [job.id])).toThrow(/JobKarov is paused/);
    expect(h.opened).toBe(0);
    const apps = new Applications(db);
    const app = apps.savePlan(job, { jobId: job.id, site: 'jobkarov', createdAt: '', cv: { lang: 'en', cvName: 'Test - Resume', hebrewRatio: 0, threshold: 0.2 }, fields: [], readiness: 'ready', notes: [] }, 'needs_review');
    expect(approveBlock(db, app)).toMatch(/^JobKarov is paused: site refusing \(402\)/);
  });

  it('a block while preparing → the site pauses; that job and the rest of the site wait in the queue (never failed)', async () => {
    const a = addJob();
    const b = addJob();
    h.openError = new BlockedError(REFUSED);
    prepareJobs(db, [a.id, b.id]);
    await waitIdle();
    expect(h.opened).toBe(1); // the second job is not loaded
    expect(pauseOf('jobkarov')!.reason).toBe('site refusing (402)');
    for (const j of [a, b]) expect(repo.getJob(j.id)).toMatchObject({ status: 'queued', statusReason: expect.stringMatching(/paused/) });
  });
});

describe('resuming takes one check and a real page', () => {
  const info = (o: Partial<SessionInfo>): SessionInfo => ({ state: 'unknown', checkedAt: '', detail: 'x', ...o });
  it('a real page → resumed; a block → another 48 hours; cannot tell → still paused', async () => {
    pauseSite('jobkarov', REFUSED, { now: new Date('2026-10-01T00:00:00Z') });
    expect(decideResume('jobkarov', info({ realPage: false, detail: 'timeout' }))).toMatchObject({ resumed: false, detail: expect.stringMatching(/could not confirm a real page/) });
    expect(isPaused('jobkarov')).toBe(true);
    expect(decideResume('jobkarov', info({ blocked: REFUSED }))).toMatchObject({ resumed: false, detail: expect.stringMatching(/another 48 hours/) });
    expect(Date.parse(pauseOf('jobkarov')!.until)).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    const check = vi.fn(async () => info({ state: 'logged_in', realPage: true }));
    expect(await resumeCheck('jobkarov', check)).toMatchObject({ resumed: true, detail: expect.stringMatching(/logged in/) });
    expect(check).toHaveBeenCalledTimes(1);
    expect(isPaused('jobkarov')).toBe(false);
  });
});

describe('Run & send with a paused site', () => {
  const ok = async (): Promise<SessionInfo> => ({ state: 'logged_in', checkedAt: '', detail: 'ok', realPage: true });
  it('a paused site is left out: no session check, no discovery; the summary says so', async () => {
    pauseSite('jobkarov', REFUSED);
    const checked: string[] = [];
    const r = await runHunt(db, { checkSession: ok, checkSiteSession: async (s) => (checked.push(s), ok()), notify: () => undefined });
    expect(checked).not.toContain('jobkarov');
    expect(r.paused).toMatchObject({ jobkarov: { reason: 'site refusing (402)' } });
    expect(r.runs.map((x) => x.site)).not.toContain('jobkarov');
    expect(doneReport(r, []).join('\n')).toMatch(/JobKarov paused: site refusing \(402\) — left out/);
  });

  it('a pause that ran out: one check first; a real page resumes the site for this run', async () => {
    pauseSite('jobkarov', REFUSED, { now: new Date(Date.now() - 49 * 3_600_000) });
    const checked: string[] = [];
    const r = await runHunt(db, { checkSession: ok, checkSiteSession: async (s) => (checked.push(s), ok()), notify: () => undefined });
    expect(checked.filter((s) => s === 'jobkarov')).toHaveLength(2); // the resume check, then the normal login check
    expect(r.resumed).toEqual([{ site: 'jobkarov', resumed: true, detail: expect.stringMatching(/^resumed/) }]);
    expect(r.runs.map((x) => x.site)).toContain('jobkarov');
    expect(isPaused('jobkarov')).toBe(false);
  });

  it('a pause that ran out, still blocked → paused for another 48 hours and left out', async () => {
    pauseSite('jobkarov', REFUSED, { now: new Date(Date.now() - 49 * 3_600_000) });
    const r = await runHunt(db, { checkSession: ok, checkSiteSession: async (s) => (s === 'jobkarov' ? { state: 'unknown', checkedAt: '', detail: 'refused', blocked: REFUSED } : ok()), notify: () => undefined });
    expect(r.resumed![0]).toMatchObject({ resumed: false });
    expect(r.runs.map((x) => x.site)).not.toContain('jobkarov');
    expect(pauseExpired(pauseOf('jobkarov')!)).toBe(false);
    expect(getActiveRun()).toBeNull();
  });
});

describe('Run & send: companies first', () => {
  it('the companies step runs first (before the login checks and the sites) and reports its time', async () => {
    const { saveCompanies } = await import('../src/companies/store.js');
    saveCompanies([{ id: 'greenhouse:acme', name: 'Acme', url: 'https://job-boards.greenhouse.io/acme', ats: 'greenhouse', board: 'acme', slug: null, enabled: true, addedAt: '', lastCheck: null, comeetToken: null }]);
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })) as typeof fetch);
    try {
      const ok = async (): Promise<SessionInfo> => ({ state: 'logged_in', checkedAt: '', detail: 'ok', realPage: true });
      const r = await runHunt(db, { checkSession: ok, checkSiteSession: ok, notify: () => undefined });
      const { huntProgress } = await import('../src/pipeline/hunt.js');
      expect(huntProgress()!.steps[0]!.name).toMatch(/^companies: reading 1 job list/);
      expect(r.companiesMs).toBeGreaterThanOrEqual(0);
      expect(doneReport(r, []).join('\n')).toMatch(/companies first: \d+s/);
    } finally {
      vi.unstubAllGlobals();
      saveCompanies([]);
    }
  });
});

describe('JobKarov page budget', () => {
  it('10 loads per session; going over throws before loading; a new session starts again', () => {
    beginBudgetSession('task');
    for (let i = 0; i < 10; i++) useLoad('jobkarov');
    expect(() => useLoad('jobkarov')).toThrow(BudgetError);
    expect(loadsLeft('jobkarov')).toBe(0);
    expect(loadsLeft('drushim')).toBe(Infinity);
    endBudgetSession('task');
    beginBudgetSession('task');
    expect(loadsLeft('jobkarov')).toBe(10);
    endBudgetSession('task');
  });
  it('a Run & send holds one budget for all its tasks', () => {
    beginBudgetSession('hunt');
    useLoad('jobkarov', 6);
    expect(beginBudgetSession('task')).toBe(false); // a task inside the hunt keeps the hunt's count
    expect(loadsLeft('jobkarov')).toBe(4);
    endBudgetSession('hunt');
  });
  it('discovery keeps room for applying: no search once only the reserve is left', async () => {
    beginBudgetSession('task');
    useLoad('jobkarov', 6); // 4 left = the reserve
    const got = [];
    for await (const j of jobkarov.search({ keyword: 'alpha' }, { page: { url: () => 'https://www.jobkarov.com/' } as never, maxPages: 1, signal: new AbortController().signal })) got.push(j);
    expect(got).toEqual([]);
    expect(loadsLeft('jobkarov')).toBe(4);
    endBudgetSession('task');
  });
  it('search terms rotate: never searched first, then the least recently searched', () => {
    const file = path.join(config.dataDir, 'settings.json');
    const s = JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}');
    fs.writeFileSync(file, JSON.stringify({ ...s, searchRotation: { jobkarov: { alpha: '2026-11-01T10:00:00Z', beta: '2026-10-30T10:00:00Z' } } }));
    const plan = ['alpha', 'beta', 'gamma'].map((q) => ({ query: q, roleIds: ['fs'] }));
    expect(jobkarov.orderQueries!(plan).map((p) => p.query)).toEqual(['gamma', 'beta', 'alpha']);
  });
});
