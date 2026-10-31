/**
 * JobMaster pages → our data. Pure functions over the server-rendered HTML (no browser): search result cards,
 * the job page, the "jobs I applied to" list (משרות שפניתי), the apply popup's preview answer, the send payload and
 * the send response. Verified against live pages on 2026-10-31 (sanitized copies in test/fixtures/jobmaster-*).
 */
import { decodeEntities } from '../../linkedin/parse.js';
import { ApplyError } from '../apply-error.js';
import type { FormField } from '../../apply/types.js';
import type { RawJob } from '../types.js';

export const JM_BASE = 'https://www.jobmaster.co.il';
export const jobUrl = (key: string) => `${JM_BASE}/jobs/checknum.asp?key=${key}`;
export const searchUrl = (term: string) => `${JM_BASE}/jobs/?q=${encodeURIComponent(term).replace(/%20/g, '+')}`;
export const SENT_LIST_URL = `${JM_BASE}/code/korot/myJobmaster/sent-list.asp`;
/** the send itself (the popup's preview is sendkorot-prev.api.asp, which never sends) */
export const SEND_PATTERN = /\/api\/korot\/send-korot\/(?:global\/global\.)?sendkorot\.api\.asp(?:$|\?)/i;
export const PREVIEW_PATTERN = /\/api\/korot\/send-korot\/(?:global\/global\.)?sendkorot-prev\.api\.asp(?:$|\?)/i;

/** HTML fragment → text (<br> and block ends become line breaks). */
export function text(html: string | undefined | null): string {
  return decodeEntities(
    (html ?? '')
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|ul|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[​-‏‪-‮⁦-⁩­﻿]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const one = (html: string, re: RegExp) => text(re.exec(html)?.[1]);
const hasHebrew = (s: string) => /[א-ת]/.test(s);

/** "פורסם לפני 7 שעות" / "לפני 3 ימים" / "לפני שעה" → ISO time (approximate). */
export function postedAt(s: string, now = new Date()): string | null {
  const m = /לפני\s+(\d+)?\s*(דקות|דקה|שעות|שעה|שעתיים|ימים|יום|יומיים|שבועות|שבוע|חודשים|חודש)/.exec(s);
  if (!m) return null;
  const unit = m[2]!;
  const n = m[1] ? Number(m[1]) : unit === 'שעתיים' || unit === 'יומיים' ? 2 : 1;
  const ms = /דק/.test(unit) ? 60_000 : /שע/.test(unit) ? 3_600_000 : /יו|ימים/.test(unit) ? 86_400_000 : /שבוע/.test(unit) ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(now.getTime() - n * ms).toISOString();
}

// ---------- search results ----------
export interface SearchPage {
  jobs: RawJob[];
  /** the highest page number linked from this page (currPage=N), 1 when there is no paging */
  lastPage: number;
}

export function parseSearchPage(html: string, now = new Date()): SearchPage {
  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<article id="(?:misra|Mekudam)(\d+)"[^>]*class="[^"]*\bJobItem\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g)) {
    const [, key, card] = m as unknown as [string, string, string];
    if (seen.has(key)) continue;
    seen.add(key);
    const title = one(card, /class="CardHeader[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!title) continue;
    const company = one(card, /class="[^"]*CompanyNameLink[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/);
    const location = one(card, /<li[^>]*class="jobLocation"[^>]*>([\s\S]*?)<\/li>/);
    const desc = one(card, /class="jobShortDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const jobType = one(card, /<li[^>]*class="jobType"[^>]*>([\s\S]*?)<\/li>/);
    jobs.push({
      site: 'jobmaster',
      externalId: key,
      company,
      title,
      location,
      descriptionText: desc,
      requirementsText: '',
      url: jobUrl(key),
      postedAt: postedAt(text(card), now),
      applyType: 'site_one_click',
      applyTarget: '',
      language: hasHebrew(`${title} ${desc}`) ? 'he' : 'en',
      detailsFetched: false,
      raw: { shape: 'search-card', jobType, exclusive: /בלעדי/.test(card) },
    });
  }
  const pages = [...html.matchAll(/[?&]currPage=(\d+)/g)].map((x) => Number(x[1]));
  return { jobs, lastPage: pages.length ? Math.max(...pages) : 1 };
}

// ---------- job page ----------
/** The full job; null when the page has no such job (removed / expired). */
export function parseJobPage(html: string, key: string, now = new Date()): RawJob | null {
  const art = new RegExp(`<article id="misra${key}"[^>]*class="[^"]*\\barticleJob\\b[^"]*"[^>]*>([\\s\\S]*?)</article>`).exec(html)?.[1];
  if (!art) return null;
  const title = one(art, /<div class="CardHeader"[^>]*>([\s\S]*?)<\/div>/);
  if (!title) return null;
  const company =
    text(/<img alt="([^"]*)" src="\/jobs\/imageurl\.asp/.exec(art)?.[1]) || one(art, /class="[^"]*CompanyNameLink[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/).replace(/^מעבר למשרות נוספות\s*/, '');
  const location = one(art, /id="jobLocationData"[^>]*>([\s\S]*?)<\/li>/);
  const salary = one(art, /<li class="jobSalary"[^>]*>([\s\S]*?)<\/li>/);
  const description = one(art, /id="jobDescriptionContent"[^>]*>([\s\S]*?)<\/div>/);
  const requirements = one(art, /id="jobRequirementsContent"[^>]*>([\s\S]*?)<\/div>/);
  const jobType = one(art, /<li[^>]*class="jobType"[^>]*>([\s\S]*?)<\/li>/);
  const canApply = new RegExp(`id="applyJob${key}"`).test(art) || new RegExp(`applyJob\\(${key}\\b`).test(art);
  // a posted salary goes into the text, where the salary reader finds it
  const salaryLine = salary && !/לא צוין/.test(salary) ? `\nשכר: ${salary}` : '';
  return {
    site: 'jobmaster',
    externalId: key,
    company,
    title,
    location,
    descriptionText: `${description}${salaryLine}`.trim(),
    requirementsText: requirements,
    url: jobUrl(key),
    postedAt: postedAt(one(art, /class="jobHead__text__addedBefore"[^>]*>([\s\S]*?)<\/div>/), now),
    applyType: canApply ? 'site_one_click' : 'external',
    applyTarget: '',
    language: hasHebrew(`${title} ${description} ${requirements}`) ? 'he' : 'en',
    detailsFetched: true,
    raw: { shape: 'job-page', jobType, salaryText: salary || null, canApply },
  };
}

/** Logged in: the page links to logoff.asp (logged out pages show the "התחבר" login link instead). */
export function loginState(html: string): 'logged_in' | 'logged_out' | 'unknown' {
  if (/href="[^"]*\/code\/korot\/shonot\/logoff\.asp"/i.test(html)) return 'logged_in';
  if (/aria-label="התחבר"/.test(html)) return 'logged_out';
  return 'unknown';
}

// ---------- the "jobs I applied to" list ----------
export interface SentListPage {
  /** job key → date sent (ISO day) */
  applied: Map<string, string | null>;
  total: number | null;
  lastPage: number;
}
export function parseSentList(html: string): SentListPage {
  const applied = new Map<string, string | null>();
  for (const m of html.matchAll(/<article id="misra(\d+)"[^>]*>([\s\S]*?)<\/article>/g)) {
    const d = /נשלח אל[\s\S]*?בתאריך\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text(m[2]));
    applied.set(m[1]!, d ? `${d[3]}-${d[2]!.padStart(2, '0')}-${d[1]!.padStart(2, '0')}` : null);
  }
  const total = /משרות שפניתי\s*\((\d+)\)/.exec(text(html))?.[1];
  const pages = [...html.matchAll(/sent-list\.asp\?currPage=(\d+)/g)].map((x) => Number(x[1]));
  return { applied, total: total ? Number(total) : null, lastPage: pages.length ? Math.max(...pages) : 1 };
}

// ---------- the apply popup ----------
/** One CV file in your JobMaster account (the popup's radio buttons; value = file id; "1" = the digital profile). */
export interface JmCv {
  code: string;
  name: string;
  checked: boolean;
}
/** The popup's preview answer (sendkorot-prev.api.asp): questions, CV files, multi-send categories. */
export interface JmPreview {
  status: string;
  skills: Array<{ skillID: number | string; qtype: string; questiontext: string }>;
  korothaimFiles: Array<{ fileID: number | string; fileName: string }>;
  multiSend: Array<{ subcatnum: number | string; subcatname?: string }>;
  contactDetailsStatus?: string | number | null;
  errText?: string;
}

/** Each suitability question type and the answers the site offers (option value → text). */
export const QTYPE_OPTIONS: Record<string, Array<[string, string]>> = {
  Q: [['1', 'לא'], ['2', 'כן']],
  Y: [['1', 'עד שנה'], ['2', 'שנתיים'], ['3', '3 שנים'], ['4', '4 שנים'], ['5', '5 שנים ומעלה']],
  L: [['1', 'רמה בסיסית'], ['2', 'רמה בינונית'], ['3', 'רמה גבוהה'], ['4', 'רמה גבוהה מאוד']],
};

/**
 * Suitability questions → plan fields. Q (yes/no) and L (level) keep the question text; Y (years) gets a
 * "how many years" label so the deterministic skill-years rule can answer it. Unknown types: the user answers.
 * The LLM never answers any of them (resolve.ts: only the profile and the answers bank).
 */
export function previewFields(p: JmPreview): FormField[] {
  return (p.skills ?? []).map((s) => {
    const q = text(String(s.questiontext ?? ''));
    const key = `suitability.${s.skillID}`;
    if (s.qtype === 'Q') return { key, label: q, type: 'yes_no' as const, required: true };
    if (s.qtype === 'Y') return { key, label: /כמה שנ/.test(q) ? q : `כמה שנות ניסיון: ${q}`, type: 'number' as const, required: true };
    const opts = QTYPE_OPTIONS[s.qtype];
    return { key, label: q, type: 'choice' as const, required: true, options: opts ? opts.map(([, t]) => t) : undefined };
  });
}

/** The site's option value for a planned answer (yes/no, a number of years, or an option text); null = no match. */
export function optionValue(qtype: string, planned: string): string | null {
  const v = planned.trim();
  if (qtype === 'Q') return v === 'yes' ? '2' : v === 'no' ? '1' : null;
  if (qtype === 'Y') {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return QTYPE_OPTIONS.Y!.find(([, t]) => t === v)?.[0] ?? null;
    return String(Math.min(5, Math.max(1, Math.floor(n) || 1)));
  }
  return QTYPE_OPTIONS[qtype]?.find(([, t]) => t === v)?.[0] ?? null;
}

// ---------- the send ----------
/**
 * The send request must never carry "send my CV to similar categories": the site adds multiSubcat (one per ticked
 * category) and the isCheckedMultiSend / multiSendSes flags when any is ticked.
 */
export function payloadHasMultiSend(body: string | null | undefined): boolean {
  const raw = (body ?? '').replace(/\+/g, ' ');
  let b = raw;
  try {
    b = decodeURIComponent(raw);
  } catch {
    /* multipart or binary: checked as is */
  }
  return /(^|[&\s"'{,])(multiSubcat|isCheckedMultiSend|multiSendSes)\b/.test(b) || /name="(multiSubcat|isCheckedMultiSend|multiSendSes)"/.test(b);
}
export function assertNoMultiSend(body: string | null | undefined): void {
  if (payloadHasMultiSend(body)) throw new ApplyError('unsafe_form', '"send my CV to similar categories" is in the send request — aborted, nothing sent');
}

export type JmSendOutcome = { kind: 'submitted' } | { kind: 'already_applied'; sentDate: string } | { kind: 'failed'; message: string; needsLogin?: boolean; fatalForDay?: boolean };
export function parseSendResponse(body: unknown): JmSendOutcome {
  const r = (body ?? {}) as { status?: string; errText?: string; message?: string };
  if (r.status === 'OK') return { kind: 'submitted' };
  const msg = String(r.errText || r.message || r.status || 'no answer');
  if (/כבר שלחת|already (sent|applied)|sent before/i.test(msg)) return { kind: 'already_applied', sentDate: 'earlier' };
  if (/errorlogin|not ?login|התחבר/i.test(msg)) return { kind: 'failed', message: `JobMaster: ${msg}`, needsLogin: true };
  if (/limit|מכסה/i.test(msg)) return { kind: 'failed', message: `JobMaster: ${msg}`, fatalForDay: true };
  return { kind: 'failed', message: `JobMaster: ${msg}` };
}
