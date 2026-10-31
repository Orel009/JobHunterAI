/**
 * Alert emails → jobs, per source (LinkedIn, Indeed). Each email's Message-ID is recorded once processed, so the
 * same email is never imported twice; a job already known (same LinkedIn id / Indeed job key) keeps everything the
 * user added to it (a pasted description, a company-site link, its status).
 *
 * Indeed jobs are routed by where applying happens (resolved offline, see indeed.ts):
 *   a Drushim job link     → a normal Drushim job (automated flow); the Indeed copy points to it
 *   a company / ATS link   → an external application with that link (→ the review queue once scored)
 *   Indeed Apply / unknown → assisted: open in your own browser, copy helpers, "I applied"
 * The same company + normalized title within the dedupe window is one job, whatever the source; every link is kept.
 */
import type { DB } from '../db/index.js';
import { nowIso, tx } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { toJob } from '../core/job.js';
import { config } from '../config.js';
import type { RawJob } from '../sites/types.js';
import { hebrewPlaces, parseAlertEmail } from '../linkedin/parse.js';
import { supportedSiteJob } from '../linkedin/external.js';
import type { AlertEmail } from '../linkedin/imap.js';
import { indeedRegions, parseIndeedAlert } from './indeed.js';

export class ProcessedEmails {
  constructor(private db: DB) {}
  has(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM email_processed WHERE message_id = ?').get(messageId);
  }
  mark(messageId: string, receivedAt: string | null, jobsFound: number, source = 'linkedin'): void {
    this.db
      .prepare('INSERT OR IGNORE INTO email_processed (message_id, source, received_at, processed_at, jobs_found) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, `${source}-alert`, receivedAt, nowIso(), jobsFound);
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
  /** Indeed jobs whose link leads to a Drushim job / a company or ATS page / Indeed itself */
  toDrushim: number;
  toCompany: number;
  assisted: number;
  /** Drushim jobs created from those links (their pages are read by a Drushim run) */
  drushimJobsCreated: string[];
}

const hasHebrew = (s: string) => /[א-ת]/.test(s);

export function importAlertEmails(db: DB, emails: AlertEmail[]): ImportStats {
  const repo = new Repo(db);
  const processed = new ProcessedEmails(db);
  const st: ImportStats = { emails: 0, skippedEmails: 0, jobsFound: 0, inserted: 0, known: 0, duplicates: 0, emptyEmails: 0, toDrushim: 0, toCompany: 0, assisted: 0, drushimJobsCreated: [] };
  /** inserts a new job and links it to its other copies; false when it was known already */
  const add = (raw: RawJob, duplicateOf: string | null = null): boolean => {
    const job = toJob(raw);
    if (repo.getJob(job.id)) {
      st.known++;
      return false;
    }
    repo.upsertJob(job);
    st.inserted++;
    if (duplicateOf) {
      repo.markDuplicate(job.id, duplicateOf);
      st.duplicates++;
    } else if (repo.dedupeNewJob(job, config.DEDUPE_WINDOW_DAYS).duplicateOf) st.duplicates++;
    return true;
  };

  for (const mail of emails) {
    if (processed.has(mail.messageId)) {
      st.skippedEmails++;
      continue;
    }
    const source = mail.source ?? 'linkedin';
    let found = 0;
    tx(db, () => {
      if (source === 'linkedin') {
        const jobs = parseAlertEmail(mail);
        found = jobs.length;
        for (const a of jobs) {
          add({
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
          });
        }
      } else {
        const jobs = parseIndeedAlert(mail);
        found = jobs.length;
        for (const a of jobs) {
          let drushimId: string | null = null;
          let applyTarget = '';
          if (a.link.kind === 'drushim') {
            const target = supportedSiteJob(a.link.url);
            if (target) {
              const d = toJob({
                site: target.site,
                externalId: target.externalId,
                // placeholders from the Indeed alert until the Drushim page is read
                company: a.company,
                title: a.title,
                location: a.location,
                descriptionText: '',
                requirementsText: '',
                url: target.url,
                postedAt: null,
                applyType: 'site_one_click',
                applyTarget: '',
                language: hasHebrew(a.title) ? 'he' : 'en',
                detailsFetched: false,
                raw: { from: `indeed:${a.externalId}` },
              });
              if (!repo.getJob(d.id)) {
                repo.upsertJob(d);
                st.drushimJobsCreated.push(d.id);
                // the same job may also be known from LinkedIn / an earlier Indeed email: the Drushim copy wins
                repo.dedupeNewJob(d, config.DEDUPE_WINDOW_DAYS);
              }
              drushimId = repo.getJob(d.id)!.duplicateOf ?? d.id;
              st.toDrushim++;
            }
          } else if (a.link.kind === 'company') {
            applyTarget = a.link.url;
            st.toCompany++;
          } else st.assisted++;
          add(
            {
              site: 'indeed',
              externalId: a.externalId,
              company: a.company,
              title: a.title,
              location: a.location,
              descriptionText: '',
              requirementsText: '',
              url: a.indeedUrl,
              postedAt: mail.date,
              applyType: 'external',
              applyTarget,
              language: hasHebrew(a.title) ? 'he' : 'en',
              detailsFetched: false,
              raw: { source: 'indeed-alert', messageId: mail.messageId, regions: indeedRegions(a.location), destination: a.link.kind, indeedApply: a.indeedApply, salaryText: a.salaryText },
            },
            drushimId,
          );
        }
      }
      processed.mark(mail.messageId, mail.date, found, source);
    });
    st.emails++;
    st.jobsFound += found;
    if (found === 0) st.emptyEmails++;
  }
  return st;
}
