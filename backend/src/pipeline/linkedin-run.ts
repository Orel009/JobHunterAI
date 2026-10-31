/**
 * LinkedIn job-alert run: read new alert emails → import jobs → prefilter → score. No browser at any step:
 * jobs come from the emails, and the description is whatever the user pastes in.
 */
import type { DB } from '../db/index.js';
import { linkedInEnabled } from '../linkedin/settings.js';
import { fetchAlertEmails, LinkedInDisabledError } from '../linkedin/imap.js';
import { importAlertEmails, ProcessedEmails } from '../linkedin/importer.js';
import { score, startTask, waitIdle } from './runner.js';

export function startLinkedInRun(db: DB, kind: 'fetch' | 'score'): number {
  if (!linkedInEnabled()) throw new LinkedInDisabledError();
  return startTask(db, 'linkedin', kind === 'fetch' ? 'full' : 'score', async (run, repo, L) => {
    if (kind === 'fetch') {
      run.stage = 'reading alert emails';
      const processed = new ProcessedEmails(db);
      const emails = await fetchAlertEmails({ isProcessed: (id) => processed.has(id), signal: run.controller.signal });
      const st = importAlertEmails(db, emails);
      run.stats.seen += st.jobsFound;
      run.stats.inserted += st.inserted;
      run.stats.duplicates += st.duplicates;
      run.stats.emails = st.emails;
      L.info(st, 'LinkedIn job alerts imported');
      if (st.emptyEmails) L.warn({ emails: st.emptyEmails }, 'alert email(s) with no jobs found — the email format may have changed');
    }
    await score(repo, run, L);
  });
}

export async function runLinkedInToCompletion(db: DB): Promise<void> {
  startLinkedInRun(db, 'fetch');
  await waitIdle();
}
