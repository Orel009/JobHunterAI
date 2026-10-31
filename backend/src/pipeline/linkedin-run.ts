/**
 * Email job-alert run (LinkedIn, Indeed): read new alert emails → import jobs → prefilter → score, per source.
 * No browser at any step: jobs come from the emails, and the description is whatever the user pastes in.
 * Afterwards, Indeed jobs whose link leads to a company / ATS page and that scored well go to the review queue with
 * that link, and Drushim jobs found through Indeed links are read by a normal Drushim run.
 */
import type { DB } from '../db/index.js';
import { emailAlertsEnabled, enabledSources } from '../linkedin/settings.js';
import { fetchAlertEmails, LinkedInDisabledError } from '../linkedin/imap.js';
import { importAlertEmails, ProcessedEmails } from '../alerts/importer.js';
import { queueExternalForReview } from '../apply/service.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { score, startRun, startTask, startWhenIdle, waitIdle } from './runner.js';

export const ALERTS_RUN_SITE = 'email-alerts';

/**
 * fetch: read the mailbox, import, score; score: score what is waiting.
 * followUp (default true): read the pages of Drushim jobs found through Indeed links in a Drushim run right after;
 * a hunt passes false because its own Drushim run reads them.
 */
export function startEmailAlertsRun(db: DB, kind: 'fetch' | 'score', opts: { followUp?: boolean } = {}): number {
  if (!emailAlertsEnabled()) throw new LinkedInDisabledError();
  return startTask(db, ALERTS_RUN_SITE, kind === 'fetch' ? 'full' : 'score', async (run, repo, L) => {
    let drushimJobs = 0;
    if (kind === 'fetch') {
      run.stage = 'reading alert emails';
      const processed = new ProcessedEmails(db);
      const emails = await fetchAlertEmails({ isProcessed: (id) => processed.has(id), signal: run.controller.signal });
      const st = importAlertEmails(db, emails);
      run.stats.seen += st.jobsFound;
      run.stats.inserted += st.inserted;
      run.stats.duplicates += st.duplicates;
      run.stats.emails = st.emails;
      run.stats.toDrushim = st.toDrushim;
      run.stats.toCompany = st.toCompany;
      run.stats.assisted = st.assisted;
      drushimJobs = st.drushimJobsCreated.length;
      L.info({ ...st, drushimJobsCreated: drushimJobs }, 'job-alert emails imported');
      if (st.emptyEmails) L.warn({ emails: st.emptyEmails }, 'alert email(s) with no jobs found — the email format may have changed');
    }
    const sites = enabledSources();
    for (const site of sites) {
      run.site = site; // score() works on one site's jobs
      await score(repo, run, L);
    }
    run.site = ALERTS_RUN_SITE;
    if (sites.includes('indeed')) {
      const queued = queueExternalForReview(db, 'indeed', effectiveLimits(loadPrefs()).autoSubmitMinScore);
      run.stats.toReview = queued;
      if (queued) L.info({ jobs: queued }, 'Indeed jobs with a company / ATS link → review queue');
    }
    if (drushimJobs && opts.followUp !== false) startWhenIdle(() => void startRun(db, 'drushim', 'enrich'));
  });
}

/** @deprecated name kept for the LinkedIn routes and older callers */
export const startLinkedInRun = (db: DB, kind: 'fetch' | 'score') => startEmailAlertsRun(db, kind);

export async function runEmailAlertsToCompletion(db: DB, opts: { followUp?: boolean } = {}): Promise<void> {
  startEmailAlertsRun(db, 'fetch', opts);
  await waitIdle();
}
export const runLinkedInToCompletion = (db: DB) => runEmailAlertsToCompletion(db);
