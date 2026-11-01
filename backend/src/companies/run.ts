/**
 * Company jobs in the pipeline: each enabled company's list read once (a pause between companies), only jobs in your
 * locations kept, then the normal prefilter, experience cap, scoring and cross-site dedupe. A job that is also on an
 * automated site (e.g. Drushim) keeps that copy for applying; the company copy is marked a duplicate of it. No browser
 * at any step; applying is done by you in the assisted panel.
 */
import type { DB } from '../db/index.js';
import { config } from '../config.js';
import { pace } from '../browser/session.js';
import { toJob } from '../core/job.js';
import { loadPrefs } from '../core/prefs.js';
import { isPaused, pauseSite } from '../core/site-pause.js';
import { COMPANY_SOURCES } from '../alerts/assisted.js';
import { applyPrefilter, score, startTask, waitIdle } from '../pipeline/runner.js';
import { fetchCompanyJobs, keepCompanyJob, type CompanyFetch } from './fetch.js';
import { isSupported, loadCompanies, updateCompany, type Company } from './store.js';

export const COMPANIES_RUN_SITE = 'companies';

export const enabledCompanies = () => loadCompanies().filter((c) => c.enabled && isSupported(c));

/** Records a fetch on the company (counts, error, a Comeet token read or rejected). */
export function recordCheck(c: Company, f: CompanyFetch, kept: number | null): void {
  updateCompany(c.id, {
    // no name given: the company name the ATS reports (the same name the job sites use, for the cross-site dedupe)
    ...(!c.name && f.jobs[0]?.company ? { name: f.jobs[0].company } : {}),
    lastCheck: { at: new Date().toISOString(), total: f.total, israel: f.israel, kept, error: f.blocked ?? f.error },
    ...(f.token !== undefined ? { comeetToken: f.token } : {}),
  });
}

/** fetch: read the lists, then score; score: only score what is waiting. */
export function startCompaniesRun(db: DB, opts: { fetch?: boolean; fetchImpl?: typeof fetch } = {}): number {
  return startTask(db, COMPANIES_RUN_SITE, opts.fetch === false ? 'score' : 'full', async (run, repo, L) => {
    const prefs = loadPrefs();
    if (opts.fetch !== false) {
      const list = enabledCompanies();
      run.stats.companies = 0;
      let first = true;
      for (const c of list) {
        if (run.controller.signal.aborted) return;
        if (isPaused(c.ats)) {
          L.warn({ company: c.name, ats: c.ats }, `${c.ats} is paused — skipped`);
          continue;
        }
        if (!first) await pace(2000, 5000);
        first = false;
        run.stage = `reading ${c.name || c.board} (${c.ats})`;
        const f = await fetchCompanyJobs(c, opts.fetchImpl);
        if (f.blocked) {
          pauseSite(c.ats, f.blocked); // the rest of that ATS waits 48 hours
          recordCheck(c, f, null);
          L.error({ company: c.name, ats: c.ats, reason: f.blocked }, 'ATS refused — paused for 48 hours');
          continue;
        }
        const kept = f.jobs.filter((j) => keepCompanyJob(j, prefs));
        recordCheck(c, f, f.error ? null : kept.length);
        if (f.error) {
          L.warn({ company: c.name, err: f.error }, 'company list not read');
          continue;
        }
        run.stats.companies++;
        run.stats.seen += f.jobs.length;
        for (const raw of kept) {
          const { outcome, job } = repo.upsertJob(toJob(raw));
          if (outcome === 'inserted') {
            run.stats.inserted++;
            // the same job on an automated site keeps that copy for applying (either way round)
            if (repo.dedupeNewJob(job, config.DEDUPE_WINDOW_DAYS).duplicateOf) run.stats.duplicates++;
          } else if (outcome === 'updated') run.stats.updated++;
        }
        run.stats.outsideLocations = (run.stats.outsideLocations ?? 0) + (f.jobs.length - kept.length);
        L.info({ company: c.name, ats: c.ats, total: f.total, israel: f.israel, kept: kept.length, requests: f.requests }, 'company list read');
      }
    }
    for (const site of COMPANY_SOURCES) {
      run.site = site; // prefilter and score() work on one site's jobs
      applyPrefilter(repo, run, prefs);
      await score(repo, run, L);
    }
    run.site = COMPANIES_RUN_SITE;
  });
}

export async function runCompaniesToCompletion(db: DB, opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  startCompaniesRun(db, opts);
  await waitIdle();
}
