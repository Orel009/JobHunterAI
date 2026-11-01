/**
 * JobKarov pages → our data. Pure functions (no browser): the job data the search page embeds
 * (window.__BASE_SITES__, one object per job, the full text: no job page needed), the city list, the apply preview
 * (/User/Page/?SiteID=…&json=1: the company's own site, "already sent", or the form's data), the send request and
 * the send response. Verified against live pages on 2026-11-01 (sanitized copies in test/fixtures/jobkarov-*).
 */
import { ApplyError, clean } from '../apply-error.js';
import type { FormField } from '../../apply/types.js';
import type { RawJob } from '../types.js';

export const JK_BASE = 'https://www.jobkarov.com';
export const jobUrl = (id: string | number, addressId?: string | number | null) => `${JK_BASE}/Search/Site/${id}${addressId ? `/${addressId}` : ''}`;
/** The site's search, filtered to your cities, newest first (order=4; the default order is by distance). */
export const searchUrl = (term: string, cityIds: number[]) =>
  `${JK_BASE}/Search/?query=${encodeURIComponent(term)}${cityIds.map((c) => `&cities[]=${c}`).join('')}&order=4`;
export const CITIES_URL = `${JK_BASE}/Home/CitiesMain`;
/** the send itself, its CAPTCHA variant, and "add to the jobs I sent" (for company-site jobs): never sent in a dry run */
export const SEND_PATTERN = /^https:\/\/(www\.)?jobkarov\.com\/User\/SendCV(?:$|\?)/i;
export const ANY_SEND_PATTERN = /^https:\/\/(www\.)?jobkarov\.com\/User\/(SendCV|SendCvCaptcha|SendCVFake)(?:$|[?/])/i;
export const PREVIEW_PATTERN = /^https:\/\/(www\.)?jobkarov\.com\/User\/Page\/?\?(?:.*&)?SiteID=\d+/i;

const hasHebrew = (s: string) => /[א-ת]/.test(s);

// ---------- the job data on a search page ----------
/** One job as JobKarov embeds it (the fields we use). */
export interface JkSite {
  id: number;
  address_id?: number | null;
  name: string;
  company?: string | null;
  city?: number | null;
  city_name?: string | null;
  address?: string | null;
  description?: string | null;
  require?: string | null;
  submit_url?: string | null;
  email?: number | null;
  ts?: string | null;
  sizes?: Array<{ id: number; name: string }> | null;
  manpower?: number | null;
  home?: number | null;
  sent?: number | boolean | null;
  jSent?: { send_date?: string | null } | null;
}

/** window.__BASE_SITES__ = [...] → the jobs (empty when the page has none). */
export function baseSites(html: string): JkSite[] {
  const m = /window\.__BASE_SITES__\s*=\s*(\[[\s\S]*?\]);?\s*<\/script>/.exec(html);
  if (!m) return [];
  try {
    const v = JSON.parse(m[1]!) as unknown;
    return Array.isArray(v) ? (v as JkSite[]).filter((s) => s && Number.isFinite(Number(s.id)) && s.name) : [];
  } catch {
    return [];
  }
}

/** "עודכן היום" / "פורסם השבוע" → an approximate time (the site gives no date). */
export function postedAt(ts: string | null | undefined, now = new Date()): string | null {
  const t = ts ?? '';
  const days = /היום/.test(t) ? 0 : /אתמול/.test(t) ? 1 : /השבוע/.test(t) ? 7 : /החודש/.test(t) ? 30 : null;
  return days === null ? null : new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** The job's "sent" mark: sent=1 with jSent.send_date (ISO day), or null when never sent from this account. */
export function sentOn(s: JkSite): string | null | undefined {
  if (!s.sent && !s.jSent) return undefined;
  const d = s.jSent?.send_date;
  return d ? String(d).slice(0, 10) : null;
}

export function toRawJob(s: JkSite, now = new Date()): RawJob {
  const title = clean(s.name);
  const description = (s.description ?? '').trim();
  // the requirements end with the site's own experience line ("ניסיון: 1-2 שנים"), read by the experience extractor
  const requirements = (s.require ?? '').trim();
  const submitUrl = (s.submit_url ?? '').trim();
  const location = clean(s.city_name || s.address || '');
  return {
    site: 'jobkarov',
    externalId: String(s.id),
    company: clean(s.company),
    title,
    location,
    descriptionText: description,
    requirementsText: requirements,
    url: jobUrl(s.id, s.address_id),
    postedAt: postedAt(s.ts, now),
    // a company-site link: applying is done there (review queue with the link, no automation)
    applyType: submitUrl ? 'external' : 'site_one_click',
    applyTarget: submitUrl,
    language: hasHebrew(`${title} ${description} ${requirements}`) ? 'he' : 'en',
    detailsFetched: true,
    raw: {
      shape: 'search-card',
      addressId: s.address_id ?? null,
      cityId: s.city ?? null,
      address: clean(s.address),
      sizes: (s.sizes ?? []).map((x) => x.name),
      email: s.email ?? null,
      agency: s.manpower === 1,
      sent: sentOn(s) !== undefined,
      sentOn: sentOn(s) ?? null,
      ts: s.ts ?? null,
    },
  };
}

export interface SearchPage {
  jobs: RawJob[];
  /** jobs this account already sent a CV to (job id → day sent, null when the site gives no date) */
  applied: Map<string, string | null>;
  /** "נמצאו N משרות" */
  found: number | null;
}
export function parseSearchPage(html: string, now = new Date()): SearchPage {
  const jobs: RawJob[] = [];
  const applied = new Map<string, string | null>();
  const seen = new Set<string>();
  for (const s of baseSites(html)) {
    const id = String(s.id);
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push(toRawJob(s, now));
    const on = sentOn(s);
    if (on !== undefined) applied.set(id, on);
  }
  // the result count the page's script shows ("נמצאו N משרות")
  const found = /\/Search\/IndexPage\?"\s*\+\s*query,\s*(\d+)/.exec(html)?.[1] ?? /"count":(\d+)\}/.exec(html)?.[1];
  return { jobs, applied, found: found ? Number(found) : null };
}

// ---------- cities ----------
export interface JkCity {
  id: number;
  name: string;
}
/** /Home/CitiesMain → [{id, name}] ("נתניה ‏(1234)" → "נתניה"). */
export function parseCities(body: string): JkCity[] {
  try {
    const rows = (JSON.parse(body) as { rows?: Record<string, unknown> }).rows ?? {};
    return Object.entries(rows)
      .map(([id, v]) => ({ id: Number(id), name: clean(String(Array.isArray(v) ? v[0] : v).replace(/\(\d+\)\s*$/, '')) }))
      .filter((c) => Number.isFinite(c.id) && c.id > 0 && c.name);
  } catch {
    return [];
  }
}

const norm = (s: string) => clean(s).replace(/[-–־]/g, ' ').replace(/\s+/g, ' ').trim();
const containsWords = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `);

/**
 * Your locations (Preferences) → JobKarov city ids. A city matches when its name and the location are the same, or
 * one contains the other as whole words — the same both-way rule as the location filter, so "השרון" brings
 * "הוד השרון" and "רמת השרון", and "תל אביב" brings "תל אביב - יפו".
 */
export function cityIdsFor(locations: string[], cities: JkCity[]): { ids: number[]; unmatched: string[] } {
  const ids = new Set<number>();
  const unmatched: string[] = [];
  for (const loc of locations.map(norm).filter(Boolean)) {
    const hits = cities.filter((c) => {
      const n = norm(c.name);
      return n === loc || containsWords(n, loc) || containsWords(loc, n);
    });
    if (!hits.length) unmatched.push(loc);
    for (const c of hits) ids.add(c.id);
  }
  return { ids: [...ids].sort((a, b) => a - b), unmatched };
}

// ---------- the apply preview ----------
export interface JkCvFile {
  id: number | string;
  /** the file name stored in your JobKarov account (what the form lists) */
  filename: string;
  path?: string;
  visible?: boolean;
}
export interface JkQuestion {
  sfq_text: string;
  /** the answer set: 1 = experience buckets, 2 = level, 3 = yes/no */
  sfq_sfqc_id: number | string;
  /** the option ids the employer accepts (the site refuses to send anything else) */
  sfq_option_valid_answer?: string | Array<string | number> | null;
}
/** The preview answer: {status:0, result} (company site / already sent / an error), or the form's data. */
export interface JkPreview {
  status?: number;
  result?: string;
  cvList?: JkCvFile[];
  FileFormats?: string[];
  Site?: { id: number; name?: string; submit_url?: string; require_cv?: number; require_range?: number };
  questions?: JkQuestion[];
  /** option id → [text, text, answer-set id] */
  optionQuestions?: Record<string, [string, string, string] | string[]>;
  /** salary range id → text ("8000-10000") */
  Ranges?: Record<string, string>;
  User?: Record<string, unknown> | null;
  sent?: string | null;
  Sent?: string | null;
}

export type PreviewKind = { kind: 'external'; url: string } | { kind: 'already_sent'; date: string } | { kind: 'error'; message: string } | { kind: 'form' };
export function previewKind(p: JkPreview | null | undefined): PreviewKind {
  if (!p || typeof p !== 'object') return { kind: 'error', message: 'no answer from JobKarov' };
  if (p.status === 0) {
    const r = String(p.result ?? '');
    if (/^https?:\/\//i.test(r)) return { kind: 'external', url: r };
    if (/כבר שלחת/.test(r)) return { kind: 'already_sent', date: /(\d{1,2}[./]\d{1,2}[./]\d{2,4})/.exec(r)?.[1] ?? 'earlier' };
    return { kind: 'error', message: r || 'JobKarov refused to open the form' };
  }
  const sent = p.sent ?? p.Sent;
  if (sent) return { kind: 'already_sent', date: String(sent) };
  if (!Array.isArray(p.cvList) || !p.Site) return { kind: 'error', message: 'the form data is missing' };
  return { kind: 'form' };
}

export const ANSWER_SET = { experience: '1', level: '2', yesNo: '3' } as const;
/** The site's experience buckets, in order. */
export const EXPERIENCE_BUCKETS = ['ללא נסיון', 'עד שנתיים', '3-5 שנים', 'מעל 5 שנים'] as const;
export const LEVELS = ['ללא', 'חלש', 'בינוני', 'טוב', 'טוב מאוד', 'מצויין'] as const;
export const SALARY_LABEL = 'ציפיות שכר (חודשי, ברוטו)';

/** Option ids and texts of one answer set (the preview's optionQuestions, grouped like the site does). */
export function optionsOf(p: JkPreview, set: string): Array<{ id: string; text: string }> {
  return Object.entries(p.optionQuestions ?? {})
    .filter(([, v]) => String(v[2]) === String(set))
    .map(([id, v]) => ({ id, text: clean(String(v[0])) }));
}

/**
 * The form's questions → plan fields (key q.{index}, in the site's order; answers are sent as one list in that order):
 *   experience buckets → a "how many years" number: the deterministic years rules answer it (a general question from
 *     declaredExperience, a technology one from the years per skill in your work roles, unsure → pending);
 *   level → a choice: the answers bank only (never the LLM), else pending;
 *   yes/no → yes/no from the bank / profile (a question, so "no" is an honest answer);
 *   the salary range (when the job asks for one) → a monthly number from the salary rules, sent as the closest range.
 * The keys start with "suitability." so the apply flow treats them as questions, not statements to confirm.
 */
export function previewFields(p: JkPreview): FormField[] {
  const out: FormField[] = (p.questions ?? []).map((q, i) => {
    const label = clean(String(q.sfq_text ?? '')).replace(/\?+$/, '');
    const key = `suitability.q${i}`;
    const set = String(q.sfq_sfqc_id);
    if (set === ANSWER_SET.experience) return { key, label: /כמה שנ/.test(label) ? label : `כמה שנות ניסיון: ${label}`, type: 'number' as const, required: true };
    if (set === ANSWER_SET.yesNo) return { key, label, type: 'yes_no' as const, required: true };
    const opts = optionsOf(p, set).map((o) => o.text);
    return { key, label, type: 'choice' as const, required: true, options: opts.length ? opts : set === ANSWER_SET.level ? [...LEVELS] : undefined };
  });
  if (p.Site?.require_range) out.push({ key: 'salaryRange', label: SALARY_LABEL, type: 'number', required: true });
  return out;
}

/** Years → the site's bucket: 0 → none, up to 2 → "עד שנתיים", 3–5 → "3-5 שנים", over 5 → "מעל 5 שנים". */
export function experienceBucket(years: number): (typeof EXPERIENCE_BUCKETS)[number] {
  const y = Math.floor(years);
  if (y <= 0) return EXPERIENCE_BUCKETS[0];
  if (y <= 2) return EXPERIENCE_BUCKETS[1];
  if (y <= 5) return EXPERIENCE_BUCKETS[2];
  return EXPERIENCE_BUCKETS[3];
}

/** The option id for question i and its planned answer (years / yes|no / an option text); null = no match. */
export function optionIdFor(p: JkPreview, i: number, planned: string): string | null {
  const q = p.questions?.[i];
  if (!q) return null;
  const set = String(q.sfq_sfqc_id);
  const opts = optionsOf(p, set);
  const v = planned.trim();
  let text: string | null = v;
  if (set === ANSWER_SET.experience && /^\d+(\.\d+)?$/.test(v)) text = experienceBucket(Number(v));
  if (set === ANSWER_SET.yesNo) text = v === 'yes' ? 'כן' : v === 'no' ? 'לא' : v;
  return opts.find((o) => o.text === clean(text ?? ''))?.id ?? null;
}

/** Whether the employer accepts this option (the site refuses to send otherwise: "הנתונים אינם תואמים את דרישות המעסיק"). */
export function optionAccepted(q: JkQuestion, optionId: string): boolean {
  const valid = q.sfq_option_valid_answer;
  if (valid === null || valid === undefined || valid === '') return true;
  const list = Array.isArray(valid) ? valid.map(String) : String(valid).split(/[,;\s]+/).filter(Boolean);
  return list.length === 0 || list.includes(optionId);
}

/** "8000-10000" → [8000, 10000]; "עד 3000" → [0, 3000]; "מעל ל-35000" → [35000, ∞]. */
export function rangeBounds(text: string): [number, number] | null {
  const n = [...text.replace(/,/g, '').matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (/עד/.test(text) && n.length === 1) return [0, n[0]!];
  if (/מעל/.test(text) && n.length === 1) return [n[0]!, Infinity];
  if (n.length >= 2) return [Math.min(n[0]!, n[1]!), Math.max(n[0]!, n[1]!)];
  return null;
}

/** A monthly amount → the id of the range that holds it (the closest one when it falls between ranges); null = none. */
export function rangeIdFor(amount: number, ranges: Record<string, string> | undefined): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  let best: { id: string; d: number } | null = null;
  for (const [id, t] of Object.entries(ranges ?? {})) {
    const b = rangeBounds(t);
    if (!b) continue;
    const d = amount < b[0] ? b[0] - amount : amount > b[1] ? amount - b[1] : 0;
    // on a boundary (10000 is in "8000-10000" and "10000-12000"), the higher range: the amount is its lower end
    if (!best || d < best.d || (d === 0 && best.d === 0 && b[0] === amount)) best = { id, d };
  }
  return best?.id ?? null;
}

// ---------- the send request ----------
/** The fields of a send request: multipart form data (what the site posts), url-encoded or JSON. */
export function payloadFields(body: string | null | undefined): Record<string, string> {
  const b = body ?? '';
  const out: Record<string, string> = {};
  if (/Content-Disposition:\s*form-data/i.test(b)) {
    for (const m of b.matchAll(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;[^\r\n]*)?\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n--/gi)) out[m[1]!] = m[2]!;
    return out;
  }
  const t = b.trim();
  if (t.startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(t) as Record<string, unknown>)) out[k] = v === null || v === undefined ? '' : String(v);
      return out;
    } catch {
      /* not JSON */
    }
  }
  for (const part of t.split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    try {
      out[decodeURIComponent(k!.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k!] = v;
    }
  }
  return out;
}

/**
 * What must hold in the send request; any problem aborts it before it leaves the browser:
 *   multi = "2" ("send my CV to similar jobs?" → no), my_description empty ("קצת על עצמי"), and the planned CV.
 */
export function payloadProblems(body: string | null | undefined, expect: { cvId?: string | null }): string[] {
  const f = payloadFields(body);
  const problems: string[] = [];
  if (f.multi !== '2') problems.push(`"send my CV to similar jobs" is not "no" (multi=${JSON.stringify(f.multi ?? null)})`);
  if ((f.my_description ?? '').trim()) problems.push('"קצת על עצמי" is not empty');
  if (expect.cvId && f.cv !== String(expect.cvId)) problems.push(`the CV in the request (${JSON.stringify(f.cv ?? null)}) is not the planned one (${expect.cvId})`);
  if ((f.fu1 ?? '').trim()) problems.push('a file upload is in the request');
  return problems;
}
export function assertSafePayload(body: string | null | undefined, expect: { cvId?: string | null }): void {
  const p = payloadProblems(body, expect);
  if (p.length) throw new ApplyError('unsafe_form', `${p.join('; ')} — aborted, nothing sent`);
}

// ---------- the send response ----------
export type JkSendOutcome =
  | { kind: 'submitted' }
  | { kind: 'already_applied'; sentDate: string }
  | { kind: 'expired'; message: string }
  | { kind: 'needs_manual'; reason: 'captcha'; message: string }
  | { kind: 'failed'; message: string; needsLogin?: boolean; fatalForDay?: boolean };

/** /User/SendCV answer: status 1 (no message) = sent; "send captcha" = the site wants a CAPTCHA (never attempted). */
export function parseSendResponse(body: unknown): JkSendOutcome {
  const r = (body ?? {}) as { status?: number | string; showmsg?: unknown; result?: string; error?: string };
  if (Number(r.status) === 1 && !r.showmsg) return { kind: 'submitted' };
  const msg = clean(String(r.result || r.error || (r.status !== undefined ? `status ${r.status}` : 'no answer')));
  if (/send captcha/i.test(`${r.error ?? ''} ${r.result ?? ''}`)) return { kind: 'needs_manual', reason: 'captcha', message: 'JobKarov asked for a CAPTCHA — not attempted; apply by hand' };
  if (/notActuel/i.test(msg) || /אקטואלי/.test(msg)) return { kind: 'expired', message: 'JobKarov: the employer marked the job as no longer current' };
  if (/כבר שלחת/.test(msg)) return { kind: 'already_applied', sentDate: 'earlier' };
  if (/התחבר|login|not ?logged/i.test(msg)) return { kind: 'failed', message: `JobKarov: ${msg}`, needsLogin: true };
  if (/מכסה|limit/i.test(msg)) return { kind: 'failed', message: `JobKarov: ${msg}`, fatalForDay: true };
  return { kind: 'failed', message: `JobKarov: ${msg}` };
}
