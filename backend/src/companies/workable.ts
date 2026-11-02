/**
 * Workable's public job endpoints (no login; verified 2026-11-02 with GOARC, account "goarc"):
 *   - the widget list `GET /api/v1/widget/accounts/{account}`: every published job with title, shortcode, locations,
 *     remote flag and the apply address (no job text) — read once per run;
 *   - one job `GET /api/v2/accounts/{account}/jobs/{shortcode}`: description, requirements and benefits as HTML — read
 *     only for jobs that pass your title and location filters, with a pause between requests.
 * Applying is done by you (the "/apply" page). The careers and job pages themselves are script shells with no text.
 */
import { decodeEntities } from '../linkedin/parse.js';
import { text } from '../sites/jobmaster/parse.js';
import type { RawJob } from '../sites/types.js';

export const WK = 'https://apply.workable.com';
const enc = encodeURIComponent;
export const wkListUrl = (account: string) => `${WK}/api/v1/widget/accounts/${enc(account)}`;
export const wkJobUrl = (account: string, shortcode: string) => `${WK}/api/v2/accounts/${enc(account)}/jobs/${enc(shortcode)}`;
export const wkJobPage = (account: string, shortcode: string) => `${WK}/${enc(account)}/j/${enc(shortcode)}/`;
export const wkApplyPage = (account: string, shortcode: string) => `${WK}/${enc(account)}/j/${enc(shortcode)}/apply/`;

export interface WkLocation {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
}
export interface WkListJob {
  title: string;
  shortcode: string;
  code?: string;
  employment_type?: string;
  telecommuting?: boolean;
  department?: string | null;
  url?: string;
  application_url?: string;
  published_on?: string;
  country?: string;
  city?: string;
  state?: string;
  locations?: WkLocation[];
}
export interface WkJob {
  id?: number;
  shortcode: string;
  title: string;
  remote?: boolean;
  workplace?: 'remote' | 'hybrid' | 'on_site' | string;
  location?: WkLocation | null;
  locations?: WkLocation[];
  published?: string;
  type?: string;
  department?: string[] | string | null;
  description?: string;
  requirements?: string;
  benefits?: string;
}

/** "Tel Aviv, Israel" (+ Remote / Hybrid); the country code is kept for the Israel filter. */
export function wkLocation(j: Pick<WkListJob, 'telecommuting' | 'locations' | 'city' | 'state' | 'country'> & Pick<WkJob, 'remote' | 'workplace' | 'location'>): string {
  const l: WkLocation = j.locations?.[0] ?? j.location ?? { city: j.city, region: j.state, country: j.country };
  const out = [l.city, l.region, l.country].map((x) => (x ?? '').trim()).filter(Boolean);
  if (j.telecommuting || j.remote || j.workplace === 'remote') out.push('Remote');
  if (j.workplace === 'hybrid') out.push('Hybrid');
  return [...new Set(out)].join(', ');
}
const countryCode = (j: { locations?: WkLocation[]; location?: WkLocation | null }) => (j.locations?.[0]?.countryCode ?? j.location?.countryCode ?? '').toUpperCase() || null;

/** A job from the widget list: title and location only (the ad is read later, for jobs that pass your filters). */
export function wkListToRawJob(account: string, companyName: string, j: WkListJob): RawJob {
  return {
    site: 'workable',
    externalId: `${account}:${j.shortcode}`,
    company: companyName || account,
    title: (j.title ?? '').trim(),
    location: wkLocation(j),
    descriptionText: '',
    requirementsText: '',
    url: wkJobPage(account, j.shortcode),
    postedAt: j.published_on ?? null,
    applyType: 'external',
    applyTarget: wkApplyPage(account, j.shortcode),
    language: /[א-ת]/.test(j.title ?? '') ? 'he' : 'en',
    detailsFetched: false,
    raw: { ats: 'workable', board: account, shortcode: j.shortcode, country: countryCode(j), publishedOn: j.published_on ?? null, department: j.department ?? null, employmentType: j.employment_type ?? null },
  };
}

/** The full job: description (+ benefits) as the description, requirements as the requirements. */
export function wkJobToRawJob(account: string, companyName: string, j: WkJob, list?: WkListJob): RawJob {
  const base = wkListToRawJob(account, companyName, list ?? { title: j.title, shortcode: j.shortcode, published_on: j.published?.slice(0, 10), locations: j.locations ?? (j.location ? [j.location] : []), telecommuting: !!j.remote });
  const t = (h?: string) => text(decodeEntities(h ?? ''));
  const description = [t(j.description), t(j.benefits)].filter(Boolean).join('\n\n');
  return {
    ...base,
    location: wkLocation({ ...(list ?? {}), remote: j.remote, workplace: j.workplace, location: j.location, locations: j.locations ?? list?.locations }),
    descriptionText: description,
    requirementsText: t(j.requirements),
    language: /[א-ת]/.test(`${j.title} ${description}`) ? 'he' : 'en',
    detailsFetched: true,
    raw: { ...(base.raw as object), workplace: j.workplace ?? null, type: j.type ?? null },
  };
}
