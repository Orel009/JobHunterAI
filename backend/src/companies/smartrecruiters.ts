/**
 * SmartRecruiters public Posting API (no login; verified 2026-11-01 with Wix, company id "Wix2"): the list of a company's
 * postings (title, location, ids — no job text), 100 per request, and one posting's full ad (company / job description,
 * qualifications, additional information). The list is read once per run; a posting's ad is read only for jobs that pass
 * your title and location filters, with a pause between requests. Applying is done by you (the "Easy apply" page).
 */
import { decodeEntities } from '../linkedin/parse.js';
import { text } from '../sites/jobmaster/parse.js';
import type { RawJob } from '../sites/types.js';

export const SR_API = 'https://api.smartrecruiters.com/v1/companies';
export const srListUrl = (company: string, offset = 0) => `${SR_API}/${encodeURIComponent(company)}/postings?limit=100&offset=${offset}`;
export const srPostingUrl = (company: string, id: string) => `${SR_API}/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`;
export const srJobPage = (company: string, id: string) => `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(id)}`;
/** the "Easy apply" form of a posting (its uuid) */
export const srApplyPage = (company: string, uuid: string) => `https://jobs.smartrecruiters.com/oneclick-ui/company/${encodeURIComponent(company)}/publication/${encodeURIComponent(uuid)}`;

export interface SrListItem {
  id: string;
  uuid?: string;
  name: string;
  company?: { name?: string; identifier?: string };
  location?: { city?: string; region?: string; country?: string; fullLocation?: string; remote?: boolean; hybrid?: boolean };
  releasedDate?: string;
  department?: { label?: string };
  experienceLevel?: { label?: string };
  typeOfEmployment?: { label?: string };
  language?: { code?: string };
}
export interface SrPosting extends SrListItem {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

/** "Tel Aviv, , Israel" → "Tel Aviv, Israel"; the country code "il" → Israel, so the location rules read it. */
export function srLocation(l: SrListItem['location']): string {
  const full = (l?.fullLocation ?? [l?.city, l?.region, l?.country].filter(Boolean).join(', ')).split(',').map((x) => x.trim()).filter(Boolean);
  const out = full.map((x) => (/^il$/i.test(x) ? 'Israel' : x));
  if (l?.remote) out.push('Remote');
  if (l?.hybrid) out.push('Hybrid');
  return [...new Set(out)].join(', ');
}

/** A posting from the list: title and location only (the ad is read later, for jobs that pass your filters). */
export function srListToRawJob(company: string, companyName: string, p: SrListItem): RawJob {
  return {
    site: 'smartrecruiters',
    externalId: `${company}:${p.id}`,
    company: companyName || p.company?.name || company,
    title: (p.name ?? '').trim(),
    location: srLocation(p.location),
    descriptionText: '',
    requirementsText: '',
    url: srJobPage(company, p.id),
    postedAt: p.releasedDate ?? null,
    applyType: 'external',
    applyTarget: p.uuid ? srApplyPage(company, p.uuid) : srJobPage(company, p.id),
    language: /[א-ת]/.test(p.name ?? '') ? 'he' : 'en',
    detailsFetched: false,
    raw: { ats: 'smartrecruiters', board: company, postingId: p.id, uuid: p.uuid ?? null, country: (p.location?.country ?? '').toUpperCase() || null, releasedDate: p.releasedDate ?? null, department: p.department?.label ?? null },
  };
}

/** The full posting: the job description and additional information as the description, qualifications as the requirements. */
export function srPostingToRawJob(company: string, companyName: string, p: SrPosting): RawJob {
  const base = srListToRawJob(company, companyName, p);
  const sec = p.jobAd?.sections ?? {};
  const t = (k: string) => text(decodeEntities(sec[k]?.text ?? ''));
  const description = [t('jobDescription'), t('additionalInformation')].filter(Boolean).join('\n\n');
  const requirements = t('qualifications');
  return {
    ...base,
    descriptionText: description,
    requirementsText: requirements,
    url: p.postingUrl || base.url,
    // the "Easy apply" form when the uuid is known, else the posting's own apply address
    applyTarget: p.uuid ? srApplyPage(company, p.uuid) : p.applyUrl || base.applyTarget,
    language: /[א-ת]/.test(`${p.name} ${description}`) ? 'he' : 'en',
    detailsFetched: true,
    // never the recruiter's name (creator) or anything personal
    raw: { ...(base.raw as object), applyUrl: p.applyUrl ?? null, companyDescription: t('companyDescription').slice(0, 1500) },
  };
}
