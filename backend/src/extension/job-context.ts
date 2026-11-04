/**
 * The job ad for an application page that does not show it (JobHunter Fill, a page not linked to a stored job):
 *   - Workable: the public job endpoint (the overview page itself is a script shell);
 *   - Greenhouse / SmartRecruiters: their public job endpoints;
 *   - Comeet: the company's public page (its token) and the positions endpoint — two requests;
 *   - any other site: the same address without "/apply" (same origin only), its main text.
 * Plain GET requests from JobHunter, no cookies, one address at a time; LinkedIn and Indeed are never fetched. The
 * answer is kept for an hour (a "Fill again" does not fetch twice).
 */
import { GH_API } from '../companies/greenhouse.js';
import { srPostingUrl, type SrPosting } from '../companies/smartrecruiters.js';
import { comeetPageUrl, comeetPositionsUrl, comeetToken, type ComeetPosition } from '../companies/comeet.js';
import { wkJobUrl, type WkJob } from '../companies/workable.js';
import { decodeEntities, isLinkedInHost } from '../linkedin/parse.js';
import { isIndeedHost } from '../alerts/assisted.js';
import { pausedText } from '../core/site-pause.js';
import { SITES } from '../sites/registry.js';

/** A job board that is paused / disabled, by host ("www.drushim.co.il" → the pause text), or null. */
function pausedSiteOf(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, '');
  for (const s of SITES) {
    const base = new URL(s.loginUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (h === base || h.endsWith(`.${base}`)) return pausedText(s.id, s.displayName);
  }
  return null;
}
import { text } from '../sites/jobmaster/parse.js';

export interface JobContext {
  title: string;
  company: string;
  text: string;
  /** where it came from, for the overlay ("fetched from Workable's job API") */
  source: string;
}
export type JobContextResult = { ok: true; context: JobContext } | { ok: false; error: string };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIN_TEXT = 200;
const cache = new Map<string, { at: number; result: JobContextResult }>();
const HOUR = 3_600_000;

async function get(fetchImpl: typeof fetch, url: string, accept: string): Promise<Response> {
  return fetchImpl(url, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
}
const html2text = (h: string) => text(decodeEntities(h));

/** the main text of a page: no scripts, styles, navigation, header, footer or forms */
export function pageMainText(html: string): string {
  let h = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(h)?.[0];
  const body = /<body\b[\s\S]*?<\/body>/i.exec(h)?.[0] ?? h;
  const pick = main && html2text(main).length >= MIN_TEXT ? main : body;
  return html2text(pick).slice(0, 6000);
}

async function workable(u: URL, f: typeof fetch): Promise<JobContextResult | null> {
  const m = /^\/([a-z0-9-]+)\/j\/([A-Za-z0-9]+)/i.exec(u.pathname);
  if (u.hostname !== 'apply.workable.com' || !m || m[1] === 'j' || m[1] === 'api') return null;
  const r = await get(f, wkJobUrl(m[1]!, m[2]!), 'application/json');
  if (!r.ok) return { ok: false, error: `Workable's job endpoint answered HTTP ${r.status}` };
  const j = (await r.json()) as WkJob;
  const body = [html2text(j.description ?? ''), html2text(j.requirements ?? ''), html2text(j.benefits ?? '')].filter(Boolean).join('\n\n');
  return { ok: true, context: { title: j.title ?? '', company: '', text: body.slice(0, 8000), source: "Workable's job API" } };
}

async function greenhouse(u: URL, f: typeof fetch): Promise<JobContextResult | null> {
  if (!/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
  const m = /^\/([^/]+)\/jobs\/(\d+)/.exec(u.pathname);
  const board = m?.[1] ?? (/^\/embed\/job_app/.test(u.pathname) ? u.searchParams.get('for') : null);
  const id = m?.[2] ?? u.searchParams.get('token') ?? u.searchParams.get('gh_jid');
  if (!board || !id) return null;
  const r = await get(f, `${GH_API}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`, 'application/json');
  if (!r.ok) return { ok: false, error: `Greenhouse's job endpoint answered HTTP ${r.status}` };
  const j = (await r.json()) as { title?: string; content?: string; company_name?: string };
  return { ok: true, context: { title: j.title ?? '', company: j.company_name ?? '', text: html2text(j.content ?? '').slice(0, 8000), source: "Greenhouse's job API" } };
}

async function smartrecruiters(u: URL, f: typeof fetch): Promise<JobContextResult | null> {
  if (!/(^|\.)smartrecruiters\.com$/.test(u.hostname)) return null;
  const m = /^\/([^/]+)\/(\d{6,})/.exec(u.pathname);
  if (!m) return null; // the "Easy apply" page carries only a uuid: no public endpoint by it
  const r = await get(f, srPostingUrl(m[1]!, m[2]!), 'application/json');
  if (!r.ok) return { ok: false, error: `SmartRecruiters' posting endpoint answered HTTP ${r.status}` };
  const p = (await r.json()) as SrPosting;
  const s = p.jobAd?.sections ?? {};
  const body = ['jobDescription', 'qualifications', 'additionalInformation'].map((k) => html2text(s[k]?.text ?? '')).filter(Boolean).join('\n\n');
  return { ok: true, context: { title: p.name ?? '', company: p.company?.name ?? '', text: body.slice(0, 8000), source: "SmartRecruiters' posting API" } };
}

async function comeet(u: URL, f: typeof fetch): Promise<JobContextResult | null> {
  if (!/(^|\.)comeet\.(com|co)$/.test(u.hostname)) return null;
  // the job page: /jobs/{slug}/{company uid}/{position slug}/{position uid}; the apply frame: ?company-uid=…&position-uid=…
  const m = /^\/jobs\/([^/]+)\/([0-9A-F]{2}\.[0-9A-F]{3})\/[^/]+\/([0-9A-F]{2}\.[0-9A-F]{3})/i.exec(u.pathname);
  const slug = m?.[1] ?? u.searchParams.get('company-name');
  const uid = (m?.[2] ?? u.searchParams.get('company-uid') ?? '').toUpperCase();
  const pos = (m?.[3] ?? u.searchParams.get('position-uid') ?? '').toUpperCase();
  if (!uid || !pos) return null;
  const page = await get(f, comeetPageUrl(slug, uid), 'text/html');
  if (!page.ok) return { ok: false, error: `Comeet's company page answered HTTP ${page.status}` };
  const tok = comeetToken(await page.text(), uid);
  if (!tok) return { ok: false, error: "Comeet's company page gave no token" };
  const r = await get(f, comeetPositionsUrl(uid, tok.token), 'application/json');
  if (!r.ok) return { ok: false, error: `Comeet's positions endpoint answered HTTP ${r.status}` };
  const p = ((await r.json()) as ComeetPosition[]).find((x) => String(x.uid).toUpperCase() === pos);
  if (!p) return { ok: false, error: `position ${pos} is not in Comeet's list for this company` };
  const details = (p.details ?? []).map((d) => `${d.name ? `${html2text(d.name)}\n` : ''}${html2text(d.value ?? '')}`).filter(Boolean).join('\n\n');
  return { ok: true, context: { title: p.name ?? '', company: p.company_name ?? '', text: details.slice(0, 8000), source: "Comeet's positions API" } };
}

async function generic(u: URL, f: typeof fetch): Promise<JobContextResult> {
  const path = u.pathname.replace(/\/(apply|application|applynow)\/?$/i, '/');
  if (path === u.pathname) return { ok: false, error: 'the page shows no job ad, and its address has no "/apply" to go back from' };
  const target = `${u.origin}${path}`;
  const r = await get(f, target, 'text/html');
  if (!r.ok) return { ok: false, error: `${target} answered HTTP ${r.status}` };
  const body = pageMainText(await r.text());
  if (body.length < MIN_TEXT) return { ok: false, error: `no job ad found at ${target} either (a page built by script)` };
  return { ok: true, context: { title: '', company: '', text: body, source: `the page ${path}` } };
}

/** The job ad behind an application page. Never LinkedIn or Indeed; same site only for the generic case. */
export async function fetchJobContext(url: string, fetchImpl: typeof fetch = fetch): Promise<JobContextResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < HOUR) return hit.result;
  let result: JobContextResult;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'not a web address' };
    if (isLinkedInHost(url) || isIndeedHost(url)) return { ok: false, error: 'LinkedIn / Indeed pages are never fetched (manual only)' };
    const paused = pausedSiteOf(u.hostname);
    if (paused) return { ok: false, error: `${paused} — its pages are not fetched while paused (the page you have open is used)` };
    result = (await workable(u, fetchImpl)) ?? (await greenhouse(u, fetchImpl)) ?? (await smartrecruiters(u, fetchImpl)) ?? (await comeet(u, fetchImpl)) ?? (await generic(u, fetchImpl));
    if (result.ok && result.context.text.length < MIN_TEXT) result = { ok: false, error: `${result.context.source} gave no job text` };
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: Date.now(), result });
  return result;
}
