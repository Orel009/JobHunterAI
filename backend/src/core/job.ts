import type { Job, RawJob } from '../sites/types.js';
import { normalizeCompany, normalizeTitle, sha1 } from './text.js';

export const jobId = (site: string, externalId: string): string => sha1(`${site}:${externalId}`);

export function contentHash(j: Pick<RawJob, 'title' | 'company' | 'location' | 'descriptionText' | 'requirementsText'>): string {
  return sha1([j.title, j.company, j.location, j.descriptionText, j.requirementsText].join('␟'));
}

export function toJob(raw: RawJob): Job {
  return {
    ...raw,
    title: raw.title.trim(),
    company: raw.company.trim(),
    location: raw.location.trim(),
    id: jobId(raw.site, raw.externalId),
    companyNorm: normalizeCompany(raw.company),
    titleNorm: normalizeTitle(raw.title),
    contentHash: contentHash(raw),
  };
}

/**
 * Merge an incoming record into an existing one without losing data:
 * a search card (detailsFetched=false) must not overwrite text/apply info that came from the job page.
 */
export function mergeJob(existing: Job, incoming: Job): Job {
  if (existing.detailsFetched && !incoming.detailsFetched) {
    const merged: Job = {
      ...incoming,
      descriptionText: existing.descriptionText,
      requirementsText: existing.requirementsText,
      applyType: existing.applyType,
      applyTarget: existing.applyTarget,
      detailsFetched: true,
      raw: existing.raw,
    };
    return { ...merged, contentHash: contentHash(merged) };
  }
  return incoming;
}
