/**
 * "Apply on company website" links pasted into a LinkedIn job:
 *   a job on a supported site (Drushim now) → a normal job of that site, which goes through the automated flow
 *     (details → score → prepare → your approval); the LinkedIn job is marked as its duplicate
 *   any other link → the LinkedIn job becomes an external application with that link, for the review queue
 */
import type { DB } from '../db/index.js';
import { Repo, type StoredJob } from '../db/repo.js';
import { toJob } from '../core/job.js';
import type { SiteId } from '../sites/types.js';
import { isAssistedOnlyHost } from '../alerts/assisted.js';
import { safeHttpUrl } from './open.js';

/** Job URL patterns of the sites with an automated apply flow. */
const SUPPORTED: Array<{ site: SiteId; match: (u: URL) => string | null; canonical: (id: string, u: URL) => string }> = [
  {
    site: 'drushim',
    match: (u) => (/(^|\.)drushim\.co\.il$/i.test(u.hostname) ? (/^\/job\/(\d+)(?:\/|$)/.exec(u.pathname)?.[1] ?? null) : null),
    canonical: (_id, u) => `https://www.drushim.co.il${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`,
  },
];

export function supportedSiteJob(url: string): { site: SiteId; externalId: string; url: string } | null {
  const u = new URL(safeHttpUrl(url));
  for (const s of SUPPORTED) {
    const id = s.match(u);
    if (id) return { site: s.site, externalId: id, url: s.canonical(id, u) };
  }
  return null;
}

export type ExternalRoute = { kind: 'site'; site: SiteId; jobId: string; created: boolean } | { kind: 'manual'; url: string };

export function routeExternalApply(db: DB, job: StoredJob, url: string): ExternalRoute {
  const href = safeHttpUrl(url);
  if (isAssistedOnlyHost(href)) throw new Error('that is a LinkedIn / Indeed link — paste the company website link from the job page');
  const repo = new Repo(db);
  const target = supportedSiteJob(href);
  if (target) {
    const j = toJob({
      site: target.site,
      externalId: target.externalId,
      // placeholders from the LinkedIn alert until the site's own page is read
      company: job.company,
      title: job.title,
      location: job.location,
      descriptionText: '',
      requirementsText: '',
      url: target.url,
      postedAt: null,
      applyType: 'site_one_click',
      applyTarget: '',
      language: job.language,
      detailsFetched: false,
      raw: { from: `${job.site}:${job.externalId}` },
    });
    const existing = repo.getJob(j.id);
    if (!existing) {
      repo.upsertJob(j);
      repo.setPrefilter(j.id, true, `linked from LinkedIn job ${job.externalId}`);
      repo.addRoleTypes(j.id, job.roleTypes);
    }
    repo.markDuplicate(job.id, j.id);
    return { kind: 'site', site: target.site, jobId: j.id, created: !existing };
  }
  db.prepare("UPDATE jobs SET apply_type = 'external', apply_target = ?, updated_at = ? WHERE id = ?").run(href, new Date().toISOString(), job.id);
  return { kind: 'manual', url: href };
}
