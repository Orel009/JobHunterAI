/**
 * Pure mappers from Drushim's own data shapes → RawJob. Shapes found during the network investigation:
 *  1. Search page SSR:  __NEXT_DATA__.props.pageProps.dehydratedState.queries[queryKey[0]='search-results'].state.data.pages[].jobs[]
 *  2. "Load more" XHR:  GET webapi.drushim.co.il/api/jobs/search?SearchTerm=..&page=N  → ResultList[]
 *  3. Job page SSR:     __NEXT_DATA__.props.pageProps.job   (/job/<code>/<hash>/)
 */
import type { ApplyType, RawJob } from '../types.js';
import { detectLanguage, htmlToText } from '../../core/text.js';
import cfg from './selectors.json' with { type: 'json' };

const abs = (u: string): string => (u.startsWith('http') ? u : new URL(u, cfg.baseUrl).toString());
const sendCvUrl = (code: string | number): string => `${cfg.baseUrl}/sendcv.aspx?jobcode=${code}`;
const toIso = (d: string | null | undefined): string | null => {
  if (!d) return null;
  // Drushim dates are Israel local time without offset.
  const t = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(d) ? d : `${d}+02:00`);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

function applyTypeOf(externalUrl: string, hasQuestions: boolean): { applyType: ApplyType; external: boolean } {
  if (externalUrl.trim()) return { applyType: 'external', external: true };
  return { applyType: hasQuestions ? 'site_questionnaire' : 'site_one_click', external: false };
}

// ---------- 1. search page SSR ----------
export interface DrushimSsrJob {
  id: string;
  title: string;
  companyName?: string;
  city?: string;
  cities?: string[];
  description?: string;
  isEnglish?: boolean;
  publishedAtIso?: string;
  jobUrl: string;
  allowNoCv?: boolean;
  hasSmartFilter?: boolean;
  filterQuestions?: unknown[];
}

export function extractNextData(html: string): unknown {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function ssrSearchJobs(nextData: unknown): { jobs: DrushimSsrJob[]; totalPages: number | null } {
  const queries = (nextData as { props?: { pageProps?: { dehydratedState?: { queries?: unknown[] } } } })?.props?.pageProps
    ?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return { jobs: [], totalPages: null };
  const q = queries.find((x) => (x as { queryKey?: unknown[] }).queryKey?.[0] === 'search-results') as
    | { state?: { data?: { pages?: Array<{ jobs?: DrushimSsrJob[]; totalPages?: number }> } } }
    | undefined;
  const pages = q?.state?.data?.pages ?? [];
  return { jobs: pages.flatMap((p) => p.jobs ?? []), totalPages: pages[0]?.totalPages ?? null };
}

export function fromSsrSearchJob(j: DrushimSsrJob): RawJob {
  const hasQuestions = (j.filterQuestions?.length ?? 0) > 0 || !!j.hasSmartFilter;
  const { applyType } = applyTypeOf('', hasQuestions);
  const descriptionText = htmlToText(j.description ?? '');
  return {
    site: 'drushim',
    externalId: String(j.id),
    company: j.companyName ?? '',
    title: j.title,
    location: (j.cities?.length ? j.cities : [j.city ?? '']).filter(Boolean).join(', '),
    descriptionText,
    requirementsText: '',
    url: abs(j.jobUrl),
    postedAt: toIso(j.publishedAtIso),
    applyType,
    applyTarget: sendCvUrl(j.id),
    language: j.isEnglish ? 'en' : detectLanguage(`${j.title} ${descriptionText}`),
    detailsFetched: false,
    raw: { shape: 'ssr-search', ...j },
  };
}

// ---------- 2. webapi search (load more) ----------
export interface DrushimApiJob {
  Code: number;
  Company?: { CompanyDisplayName?: string; NameInHebrew?: string };
  SendCVButtonModel?: { ExternalLink?: string; ButtonLink?: string };
  JobContent: {
    Name?: string;
    FullName?: string;
    Description?: string;
    Requirements?: string;
    Addresses?: Array<{ City?: string }>;
    Regions?: Array<{ NameInHebrew?: string }>;
    Zones?: Array<{ NameInHebrew?: string }>;
    Experience?: { NameInHebrew?: string } | null;
  };
  JobInfo: { Link: string; JobCode?: number; Hash?: string; Date?: string; HasFilter?: boolean; AllowNoCV?: boolean; IsExpired?: boolean; Lang?: number };
}

export function fromApiJob(j: DrushimApiJob): RawJob {
  const external = j.SendCVButtonModel?.ExternalLink ?? '';
  const { applyType } = applyTypeOf(external, !!j.JobInfo.HasFilter);
  const title = j.JobContent.FullName || j.JobContent.Name || '';
  const descriptionText = htmlToText(j.JobContent.Description);
  const cities = [...new Set((j.JobContent.Addresses ?? []).map((a) => a.City?.trim() ?? '').filter(Boolean))];
  return {
    site: 'drushim',
    externalId: String(j.Code ?? j.JobInfo.JobCode),
    company: j.Company?.CompanyDisplayName || j.Company?.NameInHebrew || '',
    title,
    location: cities.join(', '),
    descriptionText,
    requirementsText: htmlToText(j.JobContent.Requirements),
    url: abs(j.JobInfo.Link),
    postedAt: toIso(j.JobInfo.Date),
    applyType,
    applyTarget: external || j.SendCVButtonModel?.ButtonLink || sendCvUrl(j.Code),
    language: j.JobInfo.Lang === 2 ? 'en' : detectLanguage(`${title} ${descriptionText}`),
    detailsFetched: true, // the API returns full description + requirements + HasFilter
    raw: { shape: 'api-search', code: j.Code, hash: j.JobInfo.Hash, hasFilter: j.JobInfo.HasFilter, allowNoCv: j.JobInfo.AllowNoCV, externalLink: external, experience: j.JobContent.Experience?.NameInHebrew ?? null,
      // the site's region/zone names (e.g. "נתניה / אבן יהודה", "שרון"), matched by the location filter as well as the city
      regions: [...new Set([...(j.JobContent.Regions ?? []), ...(j.JobContent.Zones ?? [])].map((r) => r.NameInHebrew?.trim() ?? '').filter(Boolean))] },
  };
}

// ---------- 3. job page SSR ----------
export interface DrushimJobPage {
  id: string;
  title: string;
  companyName?: string;
  cities?: string[];
  requirements?: string[];
  description?: string[];
  isEnglish?: boolean;
  publishedDate?: string;
  externalApplyUrl?: string;
  allowNoCv?: boolean;
  hasSmartFilter?: boolean;
  filterQuestions?: unknown[];
  salaryRange?: string;
  experience?: string;
  scope?: string;
}

export function jobPageFromNextData(nextData: unknown): { job: DrushimJobPage | null; isGone: boolean } {
  const pp = (nextData as { props?: { pageProps?: { job?: DrushimJobPage; isGone?: boolean } } })?.props?.pageProps;
  return { job: pp?.job ?? null, isGone: !!pp?.isGone };
}

export function fromJobPage(j: DrushimJobPage, url: string): RawJob {
  const hasQuestions = (j.filterQuestions?.length ?? 0) > 0 || !!j.hasSmartFilter;
  const external = j.externalApplyUrl ?? '';
  const { applyType } = applyTypeOf(external, hasQuestions);
  const descriptionText = htmlToText((j.description ?? []).join('<br/>'));
  const meta = [j.scope && `היקף: ${j.scope}`, j.experience && `ניסיון: ${j.experience}`, j.salaryRange && `שכר: ${j.salaryRange}`]
    .filter(Boolean)
    .join(' | ');
  return {
    site: 'drushim',
    externalId: String(j.id),
    company: j.companyName ?? '',
    title: j.title,
    location: (j.cities ?? []).join(', '),
    descriptionText: meta ? `${descriptionText}\n\n${meta}` : descriptionText,
    requirementsText: htmlToText((j.requirements ?? []).join('<br/>')),
    url: abs(url),
    postedAt: toIso(j.publishedDate),
    applyType,
    applyTarget: external || sendCvUrl(j.id),
    language: j.isEnglish ? 'en' : detectLanguage(`${j.title} ${descriptionText}`),
    detailsFetched: true,
    raw: { shape: 'job-page', filterQuestions: j.filterQuestions ?? [], hasSmartFilter: !!j.hasSmartFilter, allowNoCv: !!j.allowNoCv, externalApplyUrl: external },
  };
}
