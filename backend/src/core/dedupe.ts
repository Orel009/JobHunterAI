import type { Job } from '../sites/types.js';
import { isAnonymousCompany } from './text.js';

export interface DedupeCandidate {
  id: string;
  site: string;
  companyNorm: string;
  titleNorm: string;
  firstSeenAt: string; // ISO
}

/**
 * Same job posted on different sites: same normalized company + normalized title,
 * first seen within `windowDays` of each other. Anonymous companies ("חסוי") never match.
 */
export function isCrossSiteDuplicate(
  job: Pick<Job, 'site' | 'companyNorm' | 'titleNorm'>,
  seenAt: Date,
  other: DedupeCandidate,
  windowDays: number,
): boolean {
  if (other.site === job.site) return false;
  if (!job.companyNorm || isAnonymousCompany(job.companyNorm)) return false;
  if (other.companyNorm !== job.companyNorm || other.titleNorm !== job.titleNorm) return false;
  const diffDays = Math.abs(seenAt.getTime() - new Date(other.firstSeenAt).getTime()) / 86_400_000;
  return diffDays <= windowDays;
}

export function findCrossSiteDuplicate(
  job: Pick<Job, 'site' | 'companyNorm' | 'titleNorm'>,
  seenAt: Date,
  candidates: DedupeCandidate[],
  windowDays: number,
): DedupeCandidate | null {
  const matches = candidates
    .filter((c) => isCrossSiteDuplicate(job, seenAt, c, windowDays))
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
  return matches[0] ?? null;
}
