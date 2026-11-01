/**
 * Company jobs in the pipeline — a complete companies-only run (the Companies screen's "Read lists now", the header's
 * "Discover Companies", npm run discover -- --companies, and the first step of Run & send):
 *   read each enabled company's list once (a pause between companies) → keep jobs in Israel and your locations →
 *   prefilter → experience cap and scoring → the Greenhouse answers prepared for every job that is ready.
 * A job that is also on an automated site (e.g. Drushim) keeps that copy for applying; the company copy is marked a
 * duplicate of it. No browser at any step; applying is done by you in the assisted panel. Live progress and a summary
 * per company (read / in Israel / in your locations / skipped by reason / scored / ready) are kept for the screen.
 */
import type { DB } from '../db/index.js';
import { config } from '../config.js';
import { pace } from '../browser/session.js';
import { toJob } from '../core/job.js';
import { loadPrefs } from '../core/prefs.js';
import { isPaused, pauseSite } from '../core/site-pause.js';
import { COMPANY_SOURCES } from '../alerts/assisted.js';
import { Repo } from '../db/repo.js';
import { applyPrefilter, score, startTask, waitIdle } from '../pipeline/runner.js';
import { fetchCompanyJobs, fetchSrPosting, keepCompanyJob, type CompanyFetch } from './fetch.js';
import { prefilter } from '../core/prefilter.js';
import { formAnswers } from './answers.js';
import { isSupported, loadCompanies, updateCompany, type Company } from './store.js';

export const COMPANIES_RUN_SITE = 'companies';

export const enabledCompanies = () => loadCompanies().filter((c) => c.enabled && isSupported(c));

export interface CompanySummary {
  id: string;
  name: string;
  ats: string;
  read: number | null;
  israel: number | null;
  inLocations: number | null;
  /** new in this run */
  added: number;
  /** of the jobs in your locations: skipped, by reason, with up to two example titles */
  skipped: Array<{ reason: string; count: number; examples: string[] }>;
  scored: number;
  /** Greenhouse: jobs whose form answers were prepared */
  answersPrepared: number;
  /** SmartRecruiters: full postings read (only for jobs that passed the title and location filters) */
  postingsRead?: number;
  /** waiting for you in Assisted apply (scored, not skipped, not applied) */
  ready: number;
  error: string | null;
  ms: number;
}
export interface CompaniesRunProgress {
  runId: number | null;
  startedAt: string;
  finishedAt: string | null;
  stage: string;
  current: string | null;
  done: number;
  total: number;
  companies: CompanySummary[];
}
let progress: CompaniesRunProgress | null = null;
export const companiesProgress = () => progress;

/** Records a fetch on the company (counts, error, a Comeet token read or rejected, the ATS's company name). */
export function recordCheck(c: Company, f: CompanyFetch, kept: number | null): void {
  updateCompany(c.id, {
    // no name given: the company name the ATS reports (the same name the job sites use, for the cross-site dedupe)
    ...(!c.name && f.jobs[0]?.company ? { name: f.jobs[0].company } : {}),
    lastCheck: { at: new Date().toISOString(), total: f.total, israel: f.israel, kept, error: f.blocked ?? f.error },
    ...(f.token !== undefined ? { comeetToken: f.token } : {}),
  });
}

/** "prefilter: seniority: \"Senior\"" → "seniority"; statuses by name. */
export function skipReason(status: string, reason: string | null): string {
  if (status === 'skipped_duplicate') return 'duplicate (another site has it)';
  if (status === 'skipped_experience') return 'too much experience required';
  if (status === 'skipped_company') return 'excluded company';
  if (status === 'skipped_salary') return 'salary below your floor';
  if (status === 'skipped_screening') return 'screening';
  if (status === 'skipped_not_a_job') return 'not a job (course)';
  const r = (reason ?? '').replace(/^prefilter: /, '');
  if (r === 'front-line support') return r;
  return r.replace(/:.*$/, '').replace(/"[^"]*"/g, '').trim() || status;
}

/** The summary of one company's jobs as they stand now (after prefilter and scoring). */
export function summarize(db: DB, c: Company, f: CompanyFetch | null, keptIds: Set<string>, added: number, answersPrepared: number, ms: number): CompanySummary {
  const repo = new Repo(db);
  const prefix = `${c.board}:`;
  const jobs = repo
    .listJobs({ site: c.ats, limit: 100_000 })
    .items.filter((j) => j.externalId.startsWith(prefix) && (keptIds.size === 0 || keptIds.has(j.externalId)));
  const skipped = new Map<string, { count: number; examples: string[] }>();
  for (const j of jobs.filter((x) => x.status.startsWith('skipped'))) {
    const k = skipReason(j.status, j.statusReason);
    const e = skipped.get(k) ?? { count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 2) e.examples.push(j.title);
    skipped.set(k, e);
  }
  return {
    id: c.id,
    name: c.name || f?.jobs[0]?.company || c.board || c.id,
    ats: c.ats,
    read: f?.total ?? null,
    israel: f?.israel ?? null,
    inLocations: f && !f.error && !f.blocked ? keptIds.size : null,
    added,
    skipped: [...skipped].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count),
    scored: jobs.filter((j) => j.score).length,
    answersPrepared,
    ready: jobs.filter((j) => j.score && !j.status.startsWith('skipped') && !/^submitted/.test(j.status) && j.status !== 'failed').length,
    error: f?.blocked ?? f?.error ?? null,
    ms,
  };
}

/** fetch: read the lists, then everything after; score: score what is waiting (and prepare the answers). */
export function startCompaniesRun(db: DB, opts: { fetch?: boolean; fetchImpl?: typeof fetch } = {}): number {
  const list = enabledCompanies();
  // created before the task starts (it runs synchronously up to its first await); shown once the task is accepted
  const p: CompaniesRunProgress = { runId: null, startedAt: new Date().toISOString(), finishedAt: null, stage: 'starting', current: null, done: 0, total: opts.fetch === false ? 0 : list.length, companies: [] };
  const runId = startTask(db, COMPANIES_RUN_SITE, opts.fetch === false ? 'score' : 'full', async (run, repo, L) => {
    p.runId = run.id;
    const prefs = loadPrefs();
    const fetched = new Map<string, { f: CompanyFetch | null; kept: Set<string>; added: number; ms: number; postingsRead?: number }>();
    if (opts.fetch !== false) {
      run.stats.companies = 0;
      let first = true;
      for (const c of list) {
        if (run.controller.signal.aborted) return;
        const t0 = Date.now();
        p.current = c.name || c.board;
        if (isPaused(c.ats)) {
          L.warn({ company: c.name, ats: c.ats }, `${c.ats} is paused — skipped`);
          fetched.set(c.id, { f: { jobs: [], total: null, israel: null, error: `${c.ats} is paused`, blocked: null, requests: [] }, kept: new Set(), added: 0, ms: 0 });
          p.done++;
          continue;
        }
        if (!first) await pace(2000, 5000);
        first = false;
        p.stage = run.stage = `reading ${c.name || c.board} (${c.ats})`;
        const f = await fetchCompanyJobs(c, opts.fetchImpl);
        if (f.blocked) {
          pauseSite(c.ats, f.blocked); // the rest of that ATS waits 48 hours
          recordCheck(c, f, null);
          L.error({ company: c.name, ats: c.ats, reason: f.blocked }, 'ATS refused — paused for 48 hours');
          fetched.set(c.id, { f, kept: new Set(), added: 0, ms: Date.now() - t0 });
          p.done++;
          continue;
        }
        const kept = f.jobs.filter((j) => keepCompanyJob(j, prefs));
        recordCheck(c, f, f.error ? null : kept.length);
        let added = 0;
        if (!f.error) {
          run.stats.companies++;
          run.stats.seen += f.jobs.length;
          for (const raw of kept) {
            const { outcome, job } = repo.upsertJob(toJob(raw));
            if (outcome === 'inserted') {
              run.stats.inserted++;
              added++;
              // the same job on an automated site keeps that copy for applying (either way round)
              if (repo.dedupeNewJob(job, config.DEDUPE_WINDOW_DAYS).duplicateOf) run.stats.duplicates++;
            } else if (outcome === 'updated') run.stats.updated++;
          }
          run.stats.outsideLocations = (run.stats.outsideLocations ?? 0) + (f.jobs.length - kept.length);
          L.info({ company: c.name, ats: c.ats, total: f.total, israel: f.israel, kept: kept.length, requests: f.requests }, 'company list read');
        } else L.warn({ company: c.name, err: f.error }, 'company list not read');
        // SmartRecruiters: the list has no job text — read the full posting only for jobs that pass your title (and
        // location) filters and are not read yet, with a pause between requests
        let postingsRead = 0;
        if (c.ats === 'smartrecruiters' && !f.error) {
          const toRead = kept.filter((j) => prefilter({ ...j, roleTypes: [] }, prefs).pass && !repo.getJob(toJob(j).id)?.detailsFetched);
          for (const [i, j] of toRead.entries()) {
            if (run.controller.signal.aborted) return;
            await pace(1000, 2500);
            p.stage = run.stage = `reading ${c.name || c.board}: posting ${i + 1}/${toRead.length}`;
            const d = await fetchSrPosting(c, String((j.raw as { postingId: string }).postingId), opts.fetchImpl);
            if (d.blocked) {
              pauseSite(c.ats, d.blocked);
              L.error({ company: c.name, reason: d.blocked }, 'SmartRecruiters refused — paused for 48 hours');
              break;
            }
            if (d.job) {
              repo.upsertJob(toJob(d.job));
              postingsRead++;
            } else L.warn({ company: c.name, job: j.title, err: d.error }, 'posting not read');
          }
          run.stats.postingsRead = (run.stats.postingsRead ?? 0) + postingsRead;
        }
        fetched.set(c.id, { f, kept: new Set(kept.map((j) => j.externalId)), added, ms: Date.now() - t0, postingsRead });
        p.done++;
      }
    }
    for (const site of COMPANY_SOURCES) {
      p.stage = run.stage = `prefilter and scoring (${site})`;
      run.site = site; // prefilter and score() work on one site's jobs
      applyPrefilter(repo, run, prefs);
      await score(repo, run, L);
    }
    run.site = COMPANIES_RUN_SITE;
    // Greenhouse: the form's questions read once per ready job and answered ahead (profile / bank), for the panel
    const prepared = new Map<string, number>();
    const ready = repo.listJobs({ site: 'greenhouse', status: 'scored', limit: 100_000 }).items.filter((j) => !j.duplicateOf);
    let i = 0;
    for (const j of ready) {
      if (run.controller.signal.aborted) return;
      const job = repo.getJob(j.id)!;
      const cached = !!(job.raw as { questionsReadAt?: string } | null)?.questionsReadAt;
      p.stage = run.stage = `preparing the Greenhouse answers ${++i}/${ready.length}`;
      if (!cached && i > 1) await pace(500, 1500);
      const a = await formAnswers(db, job, opts.fetchImpl).catch(() => null);
      if (a && !a.error) {
        const board = String((job.raw as { board?: string } | null)?.board ?? '');
        prepared.set(board, (prepared.get(board) ?? 0) + 1);
      }
    }
    run.stats.answersPrepared = [...prepared.values()].reduce((a, b) => a + b, 0);
    p.companies = (opts.fetch === false ? loadCompanies().filter((c) => isSupported(c)) : list).map((c) => {
      const x = fetched.get(c.id);
      return { ...summarize(db, c, x?.f ?? null, x?.kept ?? new Set(), x?.added ?? 0, c.ats === 'greenhouse' ? (prepared.get(c.board ?? '') ?? 0) : 0, x?.ms ?? 0), ...(c.ats === 'smartrecruiters' ? { postingsRead: x?.postingsRead ?? 0 } : {}) };
    });
    p.stage = 'done';
    p.current = null;
    p.finishedAt = new Date().toISOString();
  });
  p.runId = runId;
  progress = p;
  return runId;
}

export async function runCompaniesToCompletion(db: DB, opts: { fetchImpl?: typeof fetch; fetch?: boolean } = {}): Promise<CompaniesRunProgress | null> {
  startCompaniesRun(db, opts);
  await waitIdle();
  return companiesProgress();
}
