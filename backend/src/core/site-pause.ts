/**
 * Paused sites. A paused site is not loaded at all: no discovery, no session checks, nothing prepared or sent, and it
 * is left out of Run & send. Any block (bot protection, CAPTCHA page, a refusal such as JobKarov's HTTP 402, rate
 * limiting) pauses that site for 48 hours by itself. When the pause runs out, the site is NOT simply resumed: ONE
 * session check runs first (at the next Run & send, or with "Resume" in Settings), and the site resumes only if it
 * serves a real page.
 * Challenged again — at that check after the pause ran out, or within 24 hours of resuming — the site pauses for 7
 * days (REPAUSE_HOURS), not 48 hours, and says so (strikes ≥ 2; the hunt summary and a notification tell you).
 * A new block never shortens a pause that is still running. Kept in data/settings.json (sitePauses, siteResumes).
 */
import { readSettingsFile, writeSettingsFile } from '../llm/settings.js';
import { log } from '../log.js';

export const PAUSE_HOURS = 48;
/** the pause after a site challenges again once its pause has run out (or soon after it resumed) */
export const REPAUSE_HOURS = 7 * 24;
/** a block this soon after a resume counts as "challenged again" */
export const RESUME_GRACE_HOURS = 24;

export interface SitePause {
  /** short, shown as "paused: <reason>" (e.g. "site refusing (402)") */
  reason: string;
  /** the full reason as detected */
  detail: string;
  since: string;
  /** the earliest time the resume check runs by itself */
  until: string;
  source: 'block' | 'manual';
  /** blocks in a row: 1 = the first (48 hours); 2+ = challenged again after a pause (7 days) */
  strikes?: number;
}

interface SiteResume {
  at: string;
  /** the strikes of the pause it resumed from */
  strikes: number;
}

type WithPauses = { sitePauses?: Record<string, SitePause>; siteResumes?: Record<string, SiteResume> };
const file = () => readSettingsFile() as ReturnType<typeof readSettingsFile> & WithPauses;
const read = (): Record<string, SitePause> => ({ ...(file().sitePauses ?? {}) });
const save = (p: Partial<WithPauses>) => {
  const f = file();
  writeSettingsFile({ ...f, ...p } as typeof f);
};
const write = (p: Record<string, SitePause>) => save({ sitePauses: p });
const resumes = (): Record<string, SiteResume> => ({ ...(file().siteResumes ?? {}) });

export const sitePauses = (): Record<string, SitePause> => read();
export const pauseOf = (site: string): SitePause | null => read()[site] ?? null;
export const isPaused = (site: string): boolean => !!pauseOf(site);
/** The pause ran out: the next resume check may run (the site stays paused until it passes). */
export const pauseExpired = (p: SitePause, now = new Date()) => Date.parse(p.until) <= now.getTime();
/** A pause after the site challenged again (7 days). */
export const isRepause = (p: SitePause | null | undefined): boolean => (p?.strikes ?? 1) >= 2;

/** "refused by the site (HTTP 402, reference …) — …" → "site refusing (402)". */
export function shortBlockReason(reason: string): string {
  const http = /HTTP (\d{3})/.exec(reason)?.[1];
  if (/refused by the site|forbidden/i.test(reason)) return `site refusing${http ? ` (${http})` : ''}`;
  if (/rate limit|too many|429/i.test(reason)) return `rate limited${http ? ` (${http})` : ''}`;
  if (/captcha/i.test(reason)) return 'CAPTCHA / bot check';
  if (/bot protection|cloudflare|radware|imperva|perimeterx/i.test(reason)) return 'bot protection';
  if (/in a row/i.test(reason)) return 'pages failing in a row (possible rate limiting)';
  return reason.length > 60 ? `${reason.slice(0, 57)}…` : reason;
}

const fmtHours = (h: number) => (h % 24 === 0 ? `${h / 24} days` : `${h}h`);

/**
 * Pauses a site after a block. 48 hours the first time; 7 days when the site challenges again — the pause it had has
 * run out (this block came from the resume check) or it resumed less than 24 hours ago. A pause still running is never
 * shortened (a second block during it keeps the later end).
 */
export function pauseSite(site: string, detail: string, opts: { hours?: number; source?: SitePause['source']; reason?: string; now?: Date } = {}): SitePause {
  const now = opts.now ?? new Date();
  const prior = read()[site];
  const resumed = resumes()[site];
  const resumedRecently = !!resumed && now.getTime() - Date.parse(resumed.at) < RESUME_GRACE_HOURS * 3_600_000;
  let strikes = 1;
  let hours = opts.hours ?? PAUSE_HOURS;
  if (prior && pauseExpired(prior, now)) strikes = (prior.strikes ?? 1) + 1; // blocked at the check after the pause
  else if (prior) strikes = prior.strikes ?? 1; // blocked again during the pause (e.g. an early Resume)
  else if (resumedRecently) strikes = resumed.strikes + 1; // blocked again soon after resuming
  if (opts.hours === undefined && strikes >= 2 && (!prior || pauseExpired(prior, now))) hours = REPAUSE_HOURS;
  let until = new Date(now.getTime() + hours * 3_600_000).toISOString();
  if (prior && !pauseExpired(prior, now) && prior.until > until) until = prior.until; // never shortened
  const p: SitePause = {
    reason: opts.reason ?? shortBlockReason(detail),
    detail,
    since: prior && !pauseExpired(prior, now) ? prior.since : now.toISOString(),
    until,
    source: opts.source ?? 'block',
    strikes,
  };
  write({ ...read(), [site]: p });
  const span = fmtHours(Math.round((Date.parse(until) - now.getTime()) / 3_600_000));
  if (strikes >= 2 && hours === REPAUSE_HOURS) log.error({ site, reason: p.reason, until: p.until, strikes }, `${site} challenged again after its pause — paused for 7 days (until ${israelTime(p.until)}, Israel time)`);
  else log.warn({ site, reason: p.reason, until: p.until }, `site paused for ${span} — nothing loads it until a resume check passes`);
  return p;
}

/**
 * The site is not paused any more. After a resume check that passed (`byCheck`), the resume is remembered for 24 hours,
 * so a block right after it counts as "challenged again".
 */
export function unpauseSite(site: string, opts: { byCheck?: boolean; now?: Date } = {}): void {
  const all = read();
  const p = all[site];
  if (!p) return;
  delete all[site];
  const r = resumes();
  if (opts.byCheck) r[site] = { at: (opts.now ?? new Date()).toISOString(), strikes: p.strikes ?? 1 };
  save({ sitePauses: all, siteResumes: r });
  log.info({ site }, 'site resumed');
}

/** test seam / Settings: forget a site's resume record */
export function clearResume(site: string): void {
  const r = resumes();
  if (!r[site]) return;
  delete r[site];
  save({ siteResumes: r });
}

// ---------- Israel time ----------
/** "Fri 06.11 12:40" — Israel time, as in the header badge */
export function israelTime(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p.weekday} ${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

/** "Drushim: paused until Fri 06.11 12:40" (or "pause over — checked at the next Run & send"); 7-day pauses say so. */
export function pauseBadgeText(label: string, p: SitePause, now = new Date()): string {
  if (pauseExpired(p, now)) return `${label}: pause over — one check at the next Run & send`;
  return `${label}: paused until ${israelTime(p.until)}${isRepause(p) ? ' (7 days — challenged again)' : ''}`;
}

/** The refusal shown when something would load a paused site. */
export const pausedText = (site: string, label = site): string | null => {
  const p = pauseOf(site);
  return p ? `${label} is paused: ${p.reason} (until ${israelTime(p.until)} Israel time${isRepause(p) ? ' — 7 days, challenged again after a pause' : ''}; then one check at the next Run & send, or Settings → Resume)` : null;
};
