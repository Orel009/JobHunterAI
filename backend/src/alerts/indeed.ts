/**
 * Indeed job-alert emails → jobs. Pure functions, no network and no browser.
 * A card starts at a link that leads to an Indeed job (its text is the title); the next lines up to the following
 * card hold the company and the location (Indeed also puts ratings, salary, badges and a snippet there).
 *
 * Links are resolved OFFLINE only: email click-trackers and Indeed's own tracking links are unwrapped when the
 * destination is written inside the link (a query parameter, or Indeed's encoded cts.indeed.com payload). Indeed is
 * never requested to find out where a link goes: when the destination can only be known by visiting Indeed, the
 * Indeed link is kept.
 */
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeEntities, hebrewPlaces, htmlLines } from '../linkedin/parse.js';
import { isIndeedHost } from './assisted.js';

/** Indeed alert senders (alert@indeed.com, jobalert…@indeed.com, …@jobalert.indeed.com, …@match.indeed.com). */
export function isIndeedAlertSender(address: string | null | undefined): boolean {
  const a = (address ?? '').trim().toLowerCase();
  return /^(alert|alerts|jobalert|jobalerts|jobalerts-noreply|noreply|no-reply|donotreply)@indeed\.com$/.test(a) || /@(jobalert|match|alert)\.indeed\.com$/.test(a);
}
/** IMAP search term (FROM is a substring match); every envelope is then checked with isIndeedAlertSender */
export const INDEED_SEARCH_FROM = 'indeed.com';

export type LinkKind = 'drushim' | 'company' | 'indeed';
export interface ResolvedLink {
  /** where applying happens: a company / ATS page, a Drushim job, or Indeed itself */
  kind: LinkKind;
  /** the destination (for kind indeed: the Indeed job link) */
  url: string;
  /** Indeed's job key when known */
  jk: string | null;
  /** the Indeed job link (canonical viewjob link when the job key is known) */
  indeedUrl: string | null;
}

const URL_PARAMS = ['adurl', 'url', 'u', 'q', 'dest', 'destination', 'redirect', 'redirect_url', 'target', 'rurl', 'r', 'link', 'to'];
const isHttp = (s: string) => /^https?:\/\//i.test(s);
const JK = /^[0-9a-f]{16}$/i;

function base64urlDecode(s: string): Buffer | null {
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}

/** A URL written inside an encoded payload (cts.indeed.com/v3/<gzip+base64url JSON>, or plain base64url). */
function urlInPayload(segment: string): string | null {
  const buf = base64urlDecode(segment);
  if (!buf || buf.length < 8) return null;
  let text: string;
  try {
    text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  } catch {
    return null;
  }
  const m = /https?:(?:\\?\/){2}[^\s"'<>\\]+(?:\\\/[^\s"'<>\\]*)*/.exec(text);
  return m ? m[0].replace(/\\\//g, '/') : null;
}

function jkOf(u: URL): string | null {
  const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
  return jk && JK.test(jk) ? jk.toLowerCase() : null;
}
const indeedJobUrl = (jk: string, host = 'il.indeed.com') => `https://${/indeed\./i.test(host) ? host : 'il.indeed.com'}/viewjob?jk=${jk}`;

/** Unwraps a link from an alert email to its destination, without any network access. */
export function resolveAlertLink(href: string, depth = 0): ResolvedLink {
  let u: URL;
  try {
    u = new URL(decodeEntities(href.trim()));
  } catch {
    return { kind: 'indeed', url: href, jk: null, indeedUrl: null };
  }
  if (depth < 5) {
    // a destination written as a parameter (email click-trackers, Gmail / Outlook safe links, Indeed redirects)
    for (const p of URL_PARAMS) {
      const v = u.searchParams.get(p);
      if (v && isHttp(v)) {
        const inner = resolveAlertLink(v, depth + 1);
        if (inner.kind !== 'indeed' || !isIndeedHost(u.href)) return { ...inner, jk: inner.jk ?? jkOf(u), indeedUrl: inner.indeedUrl ?? (jkOf(u) ? indeedJobUrl(jkOf(u)!, u.hostname) : null) };
      }
    }
    // Indeed's encoded tracking links: the destination is inside the payload
    if (isIndeedHost(u.href)) {
      for (const seg of u.pathname.split('/').filter((s) => s.length > 40)) {
        const inner = urlInPayload(seg);
        if (inner) return resolveAlertLink(inner, depth + 1);
      }
    }
  }
  if (isIndeedHost(u.href)) {
    const jk = jkOf(u);
    const url = jk ? indeedJobUrl(jk, u.hostname) : u.href;
    return { kind: 'indeed', url, jk, indeedUrl: url };
  }
  if (/(^|\.)drushim\.co\.il$/i.test(u.hostname) && /^\/job\/\d+/.test(u.pathname)) return { kind: 'drushim', url: u.href, jk: null, indeedUrl: null };
  return { kind: 'company', url: u.href, jk: null, indeedUrl: null };
}

export interface IndeedAlertJob {
  /** Indeed's job key, or a stable hash of the link when the email does not show one */
  externalId: string;
  title: string;
  company: string;
  location: string;
  /** the Indeed link (always kept, as a source link) */
  indeedUrl: string;
  link: ResolvedLink;
  /** "Easily apply" (Indeed Apply): applying happens on Indeed → assisted */
  indeedApply: boolean;
  salaryText: string | null;
}

// lines that are never a company or a location
const BADGE = [
  /^easily apply$/i,
  /^(apply|applying) (with|via) indeed/i,
  /^הגש(ה|ת מועמדות) (קלה|בקלות|מהירה)$/,
  /^just posted$/i,
  /^(new|חדש|חדשה)$/i,
  /^(responsive employer|urgently hiring|hiring multiple candidates|actively hiring)$/i,
  /^(מעסיק שמגיב|מגייסים בדחיפות|דרושים בדחיפות)/,
  /^\d(\.\d)?\s*(★|stars?)?$/i,
  /^(today|yesterday|\d+\+?\s+days? ago|היום|אתמול|לפני\s)/i,
  /^(view|see) (job|all|more|similar)/i,
  /^(צפייה|לכל המשרות)/,
];
// footer / account links that can point outside Indeed too (privacy, help, unsubscribe): never a job card
const NOT_JOB_TEXT = /unsubscribe|privacy|terms|cookie|help( center)?$|manage (your )?(alerts?|subscriptions?)|edit (this )?alert|הסר|הסרה|פרטיות|תנאי (ה)?שימוש|ניהול התראות|עזרה/i;
const NOT_JOB_HOST = /(^|\.)(hrtechprivacy\.com|indeed\.jobs|indeedinc\.com|google\.com|apple\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com)$/i;
const notJob = (title: string, link: ResolvedLink) => {
  if (NOT_JOB_TEXT.test(title)) return true;
  if (link.kind !== 'company') return false;
  try {
    return NOT_JOB_HOST.test(new URL(link.url).hostname);
  } catch {
    return true;
  }
};
const EASY = [/^easily apply$/i, /^(apply|applying) (with|via) indeed/i, /^הגש(ה|ת מועמדות) (קלה|בקלות|מהירה)$/];
const SALARY = /(₪|\$|€|ils\b|nis\b|a month|a year|an hour|per (month|hour|year)|לחודש|לשעה|לשנה)/i;

const isIndeedJobHref = (href: string): string | null => {
  const r = resolveAlertLink(href);
  if (r.kind === 'indeed') return r.jk;
  // a card whose link goes straight to the company / Drushim: keyed by the destination
  return isIndeedHost(href) || /indeed/i.test(href) ? `url:${r.url}` : null;
};

const stableId = (key: string) => (JK.test(key) ? key : `h${createHash('sha1').update(key).digest('hex').slice(0, 15)}`);

function companyAndLocation(details: string[]): { company: string; location: string } {
  const first = details[0] ?? '';
  // older cards: "Company - Location"
  const dash = /^(.+?)\s+[-–]\s+(.+)$/.exec(first);
  if (details.length === 1 && dash) return { company: dash[1]!.trim(), location: dash[2]!.trim() };
  return { company: first, location: details[1] ?? '' };
}

/** Jobs in an Indeed alert's HTML part. A job linked more than once (title + "apply" button) is returned once. */
export function parseIndeedHtml(html: string): IndeedAlertJob[] {
  const lines = htmlLines(html, isIndeedJobHref);
  const out = new Map<string, IndeedAlertJob>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.jobId || out.has(l.jobId) || BADGE.some((r) => r.test(l.text)) || SALARY.test(l.text)) continue;
    const details: string[] = [];
    let easy = false;
    let salary: string | null = null;
    for (let k = i + 1; k < lines.length; k++) {
      const n = lines[k]!;
      if ((n.jobId && n.jobId !== l.jobId) || NOT_JOB_TEXT.test(n.text)) break;
      if (EASY.some((r) => r.test(n.text))) easy = true;
      if (n.text === l.text || BADGE.some((r) => r.test(n.text))) continue;
      if (SALARY.test(n.text) && /\d/.test(n.text)) {
        salary ??= n.text;
        continue;
      }
      if (details.length < 2) details.push(n.text);
    }
    const link = resolveAlertLink(l.href ?? '');
    if (notJob(l.text, link)) continue;
    const indeedUrl = link.indeedUrl ?? (link.kind === 'indeed' ? link.url : (l.href ?? ''));
    out.set(l.jobId, { externalId: stableId(link.jk ?? l.jobId), title: l.text, ...companyAndLocation(details), indeedUrl, link, indeedApply: easy, salaryText: salary });
  }
  return [...out.values()];
}

/** Fallback: the text/plain part ("Title / Company - Location / … / <link>"). */
export function parseIndeedText(text: string): IndeedAlertJob[] {
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  const out = new Map<string, IndeedAlertJob>();
  for (let i = 0; i < lines.length; i++) {
    const href = /(https?:\/\/\S+)/.exec(lines[i]!)?.[1];
    if (!href) continue;
    const key = isIndeedJobHref(href);
    if (!key || out.has(key)) continue;
    const before: string[] = [];
    let easy = false;
    let salary: string | null = null;
    for (let k = i - 1; k >= 0 && before.length < 3; k--) {
      const t = lines[k]!;
      if (!t) {
        if (before.length) break;
        continue;
      }
      if (/https?:\/\//.test(t) || /^-{3,}$|^={3,}$/.test(t)) break;
      if (EASY.some((r) => r.test(t))) easy = true;
      if (BADGE.some((r) => r.test(t))) continue;
      if (SALARY.test(t) && /\d/.test(t)) {
        salary ??= t;
        continue;
      }
      before.unshift(t);
    }
    if (!before.length) continue;
    const [title, ...rest] = before;
    const link = resolveAlertLink(href);
    if (notJob(title!, link)) continue;
    out.set(key, { externalId: stableId(link.jk ?? key), title: title!, ...companyAndLocation(rest), indeedUrl: link.indeedUrl ?? href, link, indeedApply: easy, salaryText: salary });
  }
  return [...out.values()];
}

export function parseIndeedAlert(mail: { html?: string | null; text?: string | null }): IndeedAlertJob[] {
  const fromHtml = mail.html ? parseIndeedHtml(mail.html) : [];
  return fromHtml.length ? fromHtml : mail.text ? parseIndeedText(mail.text) : [];
}

/** Hebrew place names for an Indeed location ("Tel Aviv-Yafo", "Herzliya, Center District", "תל אביב יפו"). */
export const indeedRegions = (location: string): string[] => hebrewPlaces(location);
