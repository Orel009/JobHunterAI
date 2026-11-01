/**
 * One company's job list, read from its ATS's public API with plain requests (never the automated browser).
 *   Greenhouse: one request (every job with its description).
 *   Comeet: one positions request with the token the company publishes on its public Comeet page. The token is read
 *     from that page only when none is kept yet (or the kept one was rejected on the previous run); a rejected token is
 *     never retried in the same run.
 * A refusal (HTTP 403 / 429) is a block: the caller pauses that ATS for 48 hours.
 */
import type { RawJob } from '../sites/types.js';
import type { Prefs } from '../core/prefs.js';
import { locationAccepted } from '../core/prefilter.js';
import type { Company } from './store.js';
import { ghListUrl, ghToRawJob, type GhJob } from './greenhouse.js';
import { comeetPageUrl, comeetPositionsUrl, comeetToken, comeetToRawJob, type ComeetPosition } from './comeet.js';
import { srListToRawJob, srListUrl, srPostingToRawJob, srPostingUrl, type SrListItem, type SrPosting } from './smartrecruiters.js';
import { pace } from '../browser/session.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const get = (fetchImpl: typeof fetch, url: string, accept = 'application/json') =>
  fetchImpl(url, { headers: { 'user-agent': UA, accept }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });

export interface CompanyFetch {
  jobs: RawJob[];
  total: number | null;
  israel: number | null;
  error: string | null;
  /** HTTP 403 / 429 from the ATS: pause it */
  blocked: string | null;
  /** Comeet: a token read now (keep it), or null = the kept one was rejected (read it again next run) */
  token?: { value: string; readAt: string } | null;
  /** requests made, by kind (tests and the log) */
  requests: string[];
}

const ISRAEL = /israel|ישראל|tel[ -]?aviv|תל[ -]?אביב|herzliya|הרצליה|petah[ -]?tikva|פתח[ -]?תקו|ramat[ -]?gan|רמת[ -]?גן|haifa|חיפה|jerusalem|ירושלים|netanya|נתניה|ra'?anana|רעננה|kfar[ -]?saba|כפר[ -]?סבא|hod[ -]?hasharon|הוד[ -]?השרון|yokneam|יקנעם|be'?er[ -]?sheva|באר[ -]?שבע|rehovot|רחובות|rosh[ -]?ha'?ayin|ראש[ -]?העין|bnei[ -]?brak|בני[ -]?ברק|givatayim|גבעתיים|modi'?in|מודיעין|caesarea|קיסריה/i;
export const isIsraelLocation = (location: string, country?: string | null) => country === 'IL' || ISRAEL.test(location);

const refused = (status: number) => status === 403 || status === 429;

/**
 * A company job is kept when it is in Israel (or gives no location) AND passes your location filter — so "Tel Aviv"
 * passes for "תל אביב", and a remote / hybrid job abroad does not pass on its "remote" word.
 */
export function keepCompanyJob(j: RawJob, prefs: Pick<Prefs, 'locations' | 'filters'>): boolean {
  const country = (j.raw as { country?: string | null } | null)?.country ?? null;
  if (j.location.trim() && !isIsraelLocation(j.location, country)) return false;
  return locationAccepted(j.location, prefs);
}

/** One SmartRecruiters posting's full ad (one request). */
export async function fetchSrPosting(c: Company, postingId: string, fetchImpl: typeof fetch = fetch): Promise<{ job: RawJob | null; blocked: string | null; error: string | null }> {
  try {
    const r = await get(fetchImpl, srPostingUrl(c.board!, postingId));
    if (refused(r.status)) return { job: null, blocked: `SmartRecruiters refused the request (HTTP ${r.status})`, error: null };
    if (!r.ok) return { job: null, blocked: null, error: `HTTP ${r.status}` };
    return { job: srPostingToRawJob(c.board!, c.name, (await r.json()) as SrPosting), blocked: null, error: null };
  } catch (e) {
    return { job: null, blocked: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchCompanyJobs(c: Company, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<CompanyFetch> {
  const out: CompanyFetch = { jobs: [], total: null, israel: null, error: null, blocked: null, requests: [] };
  if (!c.board) return { ...out, error: 'no board / company UID detected' };
  try {
    if (c.ats === 'greenhouse') {
      out.requests.push('greenhouse jobs');
      const r = await get(fetchImpl, ghListUrl(c.board));
      if (refused(r.status)) return { ...out, blocked: `Greenhouse refused the request (HTTP ${r.status})` };
      if (r.status === 404) return { ...out, error: `no Greenhouse board "${c.board}" (HTTP 404)` };
      if (!r.ok) return { ...out, error: `Greenhouse answered HTTP ${r.status}` };
      const jobs = ((await r.json()) as { jobs?: GhJob[] }).jobs ?? [];
      out.jobs = jobs.map((j) => ghToRawJob(c.board!, c.name, j));
    } else if (c.ats === 'comeet') {
      let token = c.comeetToken?.value ?? null;
      let fresh = false;
      if (!token) {
        // the token the company publishes on its own public Comeet careers page
        out.requests.push('comeet public page');
        const p = await get(fetchImpl, comeetPageUrl(c.slug, c.board), 'text/html');
        if (refused(p.status)) return { ...out, blocked: `Comeet refused the request (HTTP ${p.status})` };
        if (!p.ok) return { ...out, error: `the company's Comeet page answered HTTP ${p.status}` };
        const t = comeetToken(await p.text(), c.board);
        if (!t) return { ...out, error: "no token on the company's public Comeet page" };
        token = t.token;
        fresh = true;
        out.token = { value: token, readAt: now.toISOString() };
      }
      out.requests.push('comeet positions');
      const r = await get(fetchImpl, comeetPositionsUrl(c.board, token));
      if (r.status === 429 || (r.status === 403 && fresh)) return { ...out, blocked: `Comeet refused the request (HTTP ${r.status})` };
      if (r.status === 401 || r.status === 403 || r.status === 400) {
        // a kept token that no longer works: read the page again next run (never retried now)
        return { ...out, token: null, error: `the Comeet token was rejected (HTTP ${r.status}) — it is read again from the company's page next run` };
      }
      if (!r.ok) return { ...out, error: `Comeet answered HTTP ${r.status}` };
      const positions = ((await r.json()) as ComeetPosition[] | null) ?? [];
      out.jobs = (Array.isArray(positions) ? positions : []).filter((p) => !p.is_internal).map((p) => comeetToRawJob(c.board!, c.name, p));
    } else if (c.ats === 'smartrecruiters') {
      // the list: title, location and ids (no job text), 100 per request; the ads are read later, for jobs that pass
      const items: SrListItem[] = [];
      let total = 0;
      for (let offset = 0, n = 0; n < 10; n++) {
        if (n) await pace(1000, 2500);
        out.requests.push('smartrecruiters postings');
        const r = await get(fetchImpl, srListUrl(c.board, offset));
        if (refused(r.status)) return { ...out, blocked: `SmartRecruiters refused the request (HTTP ${r.status})` };
        if (!r.ok) return { ...out, error: `SmartRecruiters answered HTTP ${r.status}` };
        const j = (await r.json()) as { totalFound?: number; content?: SrListItem[] };
        total = j.totalFound ?? 0;
        items.push(...(j.content ?? []));
        offset += (j.content ?? []).length;
        if (!(j.content ?? []).length || offset >= total) break;
      }
      // SmartRecruiters answers for any name: a company with no postings at all is most likely the wrong id
      if (!total) return { ...out, error: `no SmartRecruiters postings for "${c.board}" (check the company id in one of its job links)` };
      out.jobs = items.map((p) => srListToRawJob(c.board!, c.name, p));
    } else {
      return { ...out, error: `${c.ats}: not supported yet` };
    }
  } catch (e) {
    return { ...out, error: e instanceof Error ? e.message : String(e) };
  }
  out.total = out.jobs.length;
  out.israel = out.jobs.filter((j) => isIsraelLocation(j.location, (j.raw as { country?: string | null }).country)).length;
  return out;
}
