import type { Page } from 'playwright';

/** linkedin: jobs from LinkedIn job-alert emails only (never opened by the automated browser; applying is manual) */
/** greenhouse / comeet: jobs from your target companies' public ATS job lists (assisted apply only) */
export type SiteId = 'drushim' | 'alljobs' | 'jobmaster' | 'jobnet' | 'jobkarov' | 'sqlink' | 'linkedin' | 'indeed' | 'greenhouse' | 'comeet';
export type ApplyType = 'site_one_click' | 'site_questionnaire' | 'external' | 'email';

export const JOB_STATUSES = [
  'discovered',
  'scored',
  'queued',
  'needs_review',
  'ready',
  'dry_run_ok',
  'submitted',
  /** applied by hand (LinkedIn assisted apply): "I applied" */
  'submitted_manual',
  /** the site asked for something JobHunter never does (a CAPTCHA): apply by hand in the assisted panel */
  'needs_manual',
  'failed',
  'blocked',
  'skipped',
  /** required experience above preferences.maxRequiredYears */
  'skipped_experience',
  /** a required screening statement is false for the candidate */
  'skipped_screening',
  /** the post is a training program / course, not a job */
  'skipped_not_a_job',
  /** the posted monthly salary is below the role type's floor */
  'skipped_salary',
  /** the company is in filters.excludeCompanies */
  'skipped_company',
  /** the same company + title as another job within the dedupe window (any site): duplicate_of → the original */
  'skipped_duplicate',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** What an adapter yields: already mapped into our field names, but not yet hashed/normalized. */
export interface RawJob {
  site: SiteId;
  externalId: string;
  company: string;
  title: string;
  location: string;
  descriptionText: string;
  requirementsText: string;
  url: string;
  postedAt: string | null; // ISO
  applyType: ApplyType;
  applyTarget: string;
  language: 'he' | 'en';
  /** true when description/requirements/applyType came from the full job page/API, not a search card. */
  detailsFetched: boolean;
  raw: unknown;
}

export interface Job extends RawJob {
  id: string;
  companyNorm: string;
  titleNorm: string;
  contentHash: string;
}

export interface SearchQuery {
  keyword: string;
  location?: string;
}

export interface SiteContext {
  page: Page;
  maxPages: number;
  signal: AbortSignal;
}

export interface SiteAdapter {
  id: SiteId;
  displayName: string;
  loginUrl: string;
  search(query: SearchQuery, ctx: SiteContext): AsyncIterable<RawJob>;
  /** Fetch full details for a job found via search. Returns the enriched RawJob. */
  getDetails(job: Pick<Job, 'url' | 'externalId'>, ctx: SiteContext): Promise<RawJob | null>;
  /** Optional: the order to run the search terms in (e.g. least recently searched first, under a page budget). */
  orderQueries?<T extends { query: string }>(plan: T[]): T[];
  /** Job ids (externalId) this account already applied to on the site, with the sent date when known. */
  appliedJobs?(ctx: SiteContext): Promise<Map<string, string | null>>;
  /** Phase 2. */
  apply?(job: Job, plan: unknown, ctx: SiteContext): Promise<unknown>;
}
