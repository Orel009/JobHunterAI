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
 * The same job, wherever it was found: same normalized company + normalized title, first seen within `windowDays` of
 * each other — on another site, or on the same site under another job id (a repost). The same job id is the same
 * job (an update, not a duplicate). Anonymous companies ("חסוי") never match: there is nothing to compare.
 */
export function isDuplicateJob(job: Pick<Job, 'site' | 'companyNorm' | 'titleNorm'> & { id?: string }, seenAt: Date, other: DedupeCandidate, windowDays: number): boolean {
  if (job.id !== undefined && other.id === job.id) return false;
  if (!job.companyNorm || isAnonymousCompany(job.companyNorm)) return false;
  if (other.companyNorm !== job.companyNorm || other.titleNorm !== job.titleNorm) return false;
  const diffDays = Math.abs(seenAt.getTime() - new Date(other.firstSeenAt).getTime()) / 86_400_000;
  return diffDays <= windowDays;
}

/** The original of a job just found: the earliest matching job, or null. */
export function findDuplicate(job: Pick<Job, 'site' | 'companyNorm' | 'titleNorm'> & { id?: string }, seenAt: Date, candidates: DedupeCandidate[], windowDays: number): DedupeCandidate | null {
  const matches = candidates.filter((c) => isDuplicateJob(job, seenAt, c, windowDays)).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
  return matches[0] ?? null;
}

/** @deprecated names from when only other sites counted */
export const isCrossSiteDuplicate = isDuplicateJob;
export const findCrossSiteDuplicate = findDuplicate;
