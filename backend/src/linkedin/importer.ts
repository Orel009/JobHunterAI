/**
 * Alert emails → jobs with site=linkedin. Each email's Message-ID is recorded once processed, so the same email is
 * never imported twice; a job already known (same LinkedIn id) keeps everything the user added to it (a pasted
 * description, a company-site link, its status).
 */
import type { DB } from '../db/index.js';
import { nowIso, tx } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { toJob } from '../core/job.js';
import { findCrossSiteDuplicate } from '../core/dedupe.js';
import { config } from '../config.js';
import type { RawJob } from '../sites/types.js';
import { hebrewPlaces, parseAlertEmail } from './parse.js';
import type { AlertEmail } from './imap.js';

export class ProcessedEmails {
  constructor(private db: DB) {}
  has(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM email_processed WHERE message_id = ?').get(messageId);
  }
  mark(messageId: string, receivedAt: string | null, jobsFound: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO email_processed (message_id, source, received_at, processed_at, jobs_found) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, 'linkedin-alert', receivedAt, nowIso(), jobsFound);
  }
}

export interface ImportStats {
  emails: number;
  skippedEmails: number;
  jobsFound: number;
  inserted: number;
  known: number;
  duplicates: number;
  emptyEmails: number;
}

const hasHebrew = (s: string) => /[א-ת]/.test(s);

export function importAlertEmails(db: DB, emails: AlertEmail[]): ImportStats {
  const repo = new Repo(db);
  const processed = new ProcessedEmails(db);
  const st: ImportStats = { emails: 0, skippedEmails: 0, jobsFound: 0, inserted: 0, known: 0, duplicates: 0, emptyEmails: 0 };
  for (const mail of emails) {
    if (processed.has(mail.messageId)) {
      st.skippedEmails++;
      continue;
    }
    const jobs = parseAlertEmail(mail);
    tx(db, () => {
      for (const a of jobs) {
        const raw: RawJob = {
          site: 'linkedin',
          externalId: a.externalId,
          company: a.company,
          title: a.title,
          location: a.location,
          descriptionText: '',
          requirementsText: '',
          url: a.url,
          postedAt: mail.date,
          applyType: 'external',
          applyTarget: '',
          language: hasHebrew(a.title) ? 'he' : 'en',
          detailsFetched: false,
          raw: { source: 'linkedin-alert', messageId: mail.messageId, regions: hebrewPlaces(a.location) },
        };
        const job = toJob(raw);
        if (repo.getJob(job.id)) {
          st.known++;
          continue;
        }
        repo.upsertJob(job);
        st.inserted++;
        const dup = findCrossSiteDuplicate(job, new Date(), repo.dedupeCandidates(job.companyNorm, job.titleNorm, job.site), config.DEDUPE_WINDOW_DAYS);
        if (dup) {
          repo.markDuplicate(job.id, dup.id);
          st.duplicates++;
        }
      }
      processed.mark(mail.messageId, mail.date, jobs.length);
    });
    st.emails++;
    st.jobsFound += jobs.length;
    if (jobs.length === 0) st.emptyEmails++;
  }
  return st;
}
