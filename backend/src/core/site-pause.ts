/**
 * Paused sites. A paused site is not loaded at all: no discovery, no session checks, nothing prepared or sent, and it
 * is left out of Run & send. Any block (bot protection, CAPTCHA page, a refusal such as JobKarov's HTTP 402, rate
 * limiting) pauses that site for 48 hours by itself. When the pause runs out, the site is NOT simply resumed: one
 * session check runs first (at the next Run & send, or with "Resume" in Settings), and the site resumes only if it
 * serves a real page; another block pauses it for 48 hours again. Kept in data/settings.json (sitePauses).
 */
import { readSettingsFile, writeSettingsFile } from '../llm/settings.js';
import { log } from '../log.js';

export const PAUSE_HOURS = 48;

export interface SitePause {
  /** short, shown as "paused: <reason>" (e.g. "site refusing (402)") */
  reason: string;
  /** the full reason as detected */
  detail: string;
  since: string;
  /** the earliest time the resume check runs by itself */
  until: string;
  source: 'block' | 'manual';
}

type WithPauses = { sitePauses?: Record<string, SitePause> };
const read = (): Record<string, SitePause> => ({ ...((readSettingsFile() as WithPauses).sitePauses ?? {}) });
const write = (p: Record<string, SitePause>) => {
  const file = readSettingsFile();
  writeSettingsFile({ ...file, sitePauses: p } as typeof file);
};

export const sitePauses = (): Record<string, SitePause> => read();
export const pauseOf = (site: string): SitePause | null => read()[site] ?? null;
export const isPaused = (site: string): boolean => !!pauseOf(site);
/** The pause ran out: the next resume check may run (the site stays paused until it passes). */
export const pauseExpired = (p: SitePause, now = new Date()) => Date.parse(p.until) <= now.getTime();

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

export function pauseSite(site: string, detail: string, opts: { hours?: number; source?: SitePause['source']; reason?: string; now?: Date } = {}): SitePause {
  const now = opts.now ?? new Date();
  const p: SitePause = {
    reason: opts.reason ?? shortBlockReason(detail),
    detail,
    since: now.toISOString(),
    until: new Date(now.getTime() + (opts.hours ?? PAUSE_HOURS) * 3_600_000).toISOString(),
    source: opts.source ?? 'block',
  };
  write({ ...read(), [site]: p });
  log.warn({ site, reason: p.reason, until: p.until }, `site paused for ${opts.hours ?? PAUSE_HOURS}h — nothing loads it until a resume check passes`);
  return p;
}

export function unpauseSite(site: string): void {
  const all = read();
  if (!all[site]) return;
  delete all[site];
  write(all);
  log.info({ site }, 'site resumed');
}

/** The refusal shown when something would load a paused site. */
export const pausedText = (site: string, label = site): string | null => {
  const p = pauseOf(site);
  return p ? `${label} is paused: ${p.reason} (since ${p.since.slice(0, 16).replace('T', ' ')}; resume check from ${p.until.slice(0, 16).replace('T', ' ')} UTC, or Settings → Resume)` : null;
};
