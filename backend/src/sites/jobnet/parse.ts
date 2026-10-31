/**
 * Jobnet pages → our data. Pure functions over the server-rendered HTML (no browser). Search / category results and
 * the job page share the same schema.org JobPosting markup (verified on the live site 2026-10-31; sanitized copies in
 * test/fixtures/jobnet-*).
 *
 * Location: Jobnet gives only regions (מרכז, שרון…) with a list of sub-areas per job, never the job's own city —
 * so every Jobnet job is "location approximate".
 */
import { text } from '../jobmaster/parse.js';
import type { RawJob } from '../types.js';

export const JN_BASE = 'https://www.jobnet.co.il';
export const jobUrl = (id: string) => `${JN_BASE}/jobs?positionid=${id}`;
/** the send form the apply button loads (an iframe on desktop) */
export const sendFormUrl = (id: string) => `${JN_BASE}/Newstyle/InternalPages/SendCv.aspx?pid=${id}&l=4`;

export interface JobnetPlace {
  /** the Jobnet region (מרכז, שרון, צפון…) */
  region: string;
  /** the sub-areas listed for the job ("תל אביב", "פתח תקווה", "נתניה ועמק חפר"…) */
  subAreas: string[];
}

const hasHebrew = (s: string) => /[א-ת]/.test(s);
const dmy = (s: string | undefined) => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s ?? '');
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
};

function places(block: string): JobnetPlace[] {
  const out: JobnetPlace[] = [];
  for (const m of block.matchAll(/itemprop="addressRegion"[^>]*>([\s\S]*?)<\/span>\s*<span class="reg">([\s\S]*?)<\/span>/g)) {
    const region = text(m[1]);
    const subAreas = text(m[2])
      .replace(/^[-–\s]+/, '')
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (region && !out.some((p) => p.region === region)) out.push({ region, subAreas });
  }
  return out;
}

/** "you sent a CV for this job on dd/mm/yyyy" — visible only on jobs this account applied to */
function appliedOn(block: string): string | null {
  const m = /<span(?![^>]*display:\s*none)[^>]*>\s*שלחת קורות חיים למשרה זו בתאריך\s*([\d/]*)\s*<\/span>/.exec(block);
  return m ? (dmy(m[1]) ?? 'yes') : null;
}

function fromBlock(block: string, detailsFetched: boolean): RawJob | null {
  const id = /href="\/jobs\?positionid=(\d+)"/.exec(block)?.[1] ?? /[?&]positionid=(\d+)/.exec(block)?.[1];
  const title = text(/<h2 itemprop="title">([\s\S]*?)<\/h2>/.exec(block)?.[1]);
  if (!id || !title) return null;
  const company = text(/itemprop="hiringOrganization"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1]);
  const description = text(/<div itemprop="description">([\s\S]*?)<\/div>\s*<div itemprop="skills"/.exec(block)?.[1] ?? /<div itemprop="description">([\s\S]*?)<\/div>\s*<\/div>/.exec(block)?.[1]).replace(/^תיאור תפקיד:\s*/, '');
  const requirements = text(/<div itemprop="skills"[^>]*>([\s\S]*?)<\/div>\s*<div style="margin-top/.exec(block)?.[1]).replace(/^דרישות:\s*/, '');
  const employmentType = text(/itemprop="employmentType"[^>]*>([\s\S]*?)<\/span>/.exec(block)?.[1]);
  const where = places(block);
  // the apply button: clickPosition(id, l, externalUrl) — an empty URL means Jobnet's own send form
  const click = new RegExp(`clickPosition\\('${id}','\\d+','([^']*)'\\)`).exec(block);
  const external = click?.[1] ? click[1] : null;
  const subAreas = where.flatMap((p) => p.subAreas);
  return {
    site: 'jobnet',
    externalId: id,
    company,
    title,
    // the sub-areas are what the location filter matches; the regions are kept for the Jobnet region mapping
    location: subAreas.join(', ') || where.map((p) => p.region).join(', '),
    descriptionText: description,
    requirementsText: requirements,
    url: jobUrl(id),
    postedAt: dmy(/itemprop="datePosted"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1]),
    applyType: external ? 'external' : 'site_one_click',
    applyTarget: external ?? '',
    language: hasHebrew(`${title} ${description}`) ? 'he' : 'en',
    detailsFetched,
    raw: { shape: detailsFetched ? 'job-page' : 'search-card', employmentType, jobnetPlaces: where, regions: where.map((p) => p.region), locationApproximate: true, appliedOn: appliedOn(block), canApply: !!click },
  };
}

const blocks = (html: string) => html.split(/<div itemscope="" itemtype="https:\/\/schema\.org\/JobPosting"/).slice(1);

export interface JobnetResults {
  jobs: RawJob[];
  /** "נמצאו 21 משרות" */
  total: number | null;
  /** the page numbers the site links to (postback page buttons) */
  pages: number;
}
export function parseResults(html: string): JobnetResults {
  const jobs: RawJob[] = [];
  for (const b of blocks(html)) {
    const j = fromBlock(b, true); // the result cards carry the full description and requirements
    if (j && !jobs.some((x) => x.externalId === j.externalId)) jobs.push(j);
  }
  const total = /נמצאו\s*([\d,]+)\s*משרות/.exec(text(html))?.[1];
  const pages = new Set([...html.matchAll(/rptPaging_btnPage_(\d+)/g)].map((m) => m[1])).size;
  return { jobs, total: total ? Number(total.replace(/,/g, '')) : null, pages: Math.max(1, pages) };
}

/** The job page (same markup as a card); null when the job is gone. */
export function parseJobPage(html: string, id: string): RawJob | null {
  for (const b of blocks(html)) {
    const j = fromBlock(b, true);
    if (j?.externalId === id) return j;
  }
  return null;
}

/** Logged in: the personal-area menu shows a logout ("התנתק") that is not hidden; logged out: the login form. */
export function loginState(html: string): 'logged_in' | 'logged_out' | 'unknown' {
  if (/logout_user_block\(\)/.test(html) && /id="loginmyprofile"/.test(html)) {
    // both are always in the page; the login box is only rendered for a visitor
    if (/id="emailBlock"/.test(html) && /id="passwordBlock"/.test(html) && !/UserProfile\.aspx\?act=pos/.test(html)) return 'logged_out';
  }
  if (/class="[^"]*userName[^"]*"[^>]*>[^<]{2,}</.test(html) || /UserProfile\.aspx\?act=pos/.test(html)) return 'logged_in';
  if (/id="emailBlock"/.test(html)) return 'logged_out';
  return 'unknown';
}

/**
 * Jobnet regions → your locations: a job counts as in your area when one of its regions is in jobnet.regions
 * (Preferences); otherwise its sub-areas are matched against your locations as usual. Always approximate.
 */
export function regionAccepted(jobRegions: string[], accepted: string[]): string | null {
  const norm = (s: string) => s.replace(/^ה(?=שרון|שפלה|נגב|גליל)/, '').trim();
  const ok = new Set(accepted.map(norm));
  return jobRegions.find((r) => ok.has(norm(r))) ?? null;
}
