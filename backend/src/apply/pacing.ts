/**
 * Sending pace per site, so a run of sends does not look like a burst (Drushim showed bot protection after three
 * sends ~25 seconds apart, 2026-11-04):
 *   - a random wait between two sends on the same site (Drushim 60–150 s), counted from the last send on that site —
 *     also one sent by an earlier batch or Run & send;
 *   - that wait is spent on a normal page of the site (a job list for one of your search terms), not by going straight
 *     from one send to the next; a block on that page stops the sends like any other block;
 *   - at most N sends per session (one Run & send, or one batch / task on its own) and per day, per site.
 * Defaults below; Preferences → pacing.<site> overrides any of them. Sites without defaults keep the general pace and the
 * general daily limit. Dry runs (nothing is sent) are not paced this way.
 */
import type { Page } from 'playwright';
import type { DB } from '../db/index.js';
import { BlockedError, assertNotBlocked, pace, randomDelay } from '../browser/session.js';
import { effectiveLimits, loadPrefs, searchTerms, type Prefs } from '../core/prefs.js';
import { noteSessionSend, sendsThisSession } from '../core/site-budget.js';
import { log } from '../log.js';
import { driverFor } from './drivers.js';

export interface SitePacing {
  minDelaySec: number;
  maxDelaySec: number;
  maxSendsPerSession: number;
  maxSendsPerDay: number;
  idleOnList: boolean;
}

/** Drushim: slow (it challenged a burst); JobMaster / Jobnet: moderate. */
export const PACING_DEFAULTS: Record<string, SitePacing> = {
  drushim: { minDelaySec: 60, maxDelaySec: 150, maxSendsPerSession: 8, maxSendsPerDay: 12, idleOnList: true },
  jobmaster: { minDelaySec: 30, maxDelaySec: 90, maxSendsPerSession: 10, maxSendsPerDay: 15, idleOnList: true },
  jobnet: { minDelaySec: 30, maxDelaySec: 90, maxSendsPerSession: 10, maxSendsPerDay: 15, idleOnList: true },
};

export function pacingFor(site: string, prefs: Prefs = loadPrefs()): SitePacing {
  const base: SitePacing = PACING_DEFAULTS[site] ?? { minDelaySec: 0, maxDelaySec: 0, maxSendsPerSession: Infinity, maxSendsPerDay: Infinity, idleOnList: false };
  const own = Object.fromEntries(Object.entries(prefs.pacing[site] ?? {}).filter(([, v]) => v !== undefined)) as Partial<SitePacing>;
  const p = { ...base, ...own };
  if (p.maxDelaySec < p.minDelaySec) p.maxDelaySec = p.minDelaySec;
  return p;
}

/** The most real sends today on this site: its own pacing number, never above limits.dailyApplyLimit. */
export const dailySendLimit = (site: string, prefs: Prefs = loadPrefs()): number => Math.min(effectiveLimits(prefs).dailyApplyLimit, pacingFor(site, prefs).maxSendsPerDay);
export const sessionSendLimit = (site: string, prefs: Prefs = loadPrefs()): number => pacingFor(site, prefs).maxSendsPerSession;

/** Why no more sends on this site in this session, or null. */
export function sessionCapReached(site: string, label: string, prefs: Prefs = loadPrefs()): string | null {
  const max = sessionSendLimit(site, prefs);
  return sendsThisSession(site) >= max ? `${label}: ${max} sends this session (the most per session) — the rest wait for the next session` : null;
}

const lastAttempt = new Map<string, number>();

/** The final click was reached on this site (sent, CAPTCHA, or failed after it): counts for the wait and the session cap. */
export function noteSendAttempt(site: string, at = Date.now()): void {
  lastAttempt.set(site, Math.max(at, lastAttempt.get(site) ?? 0));
  noteSessionSend(site);
}

/** test seam: forget this process's send times */
export const resetSendTimes = () => lastAttempt.clear();

/** The last send on this site: this process's last attempt, or the last real send in the database. */
export function lastSendAt(db: DB, site: string): number | null {
  const row = db.prepare(`SELECT MAX(submitted_at) AS at FROM applications WHERE site = ? AND status = 'submitted' AND dry_run = 0`).get(site) as { at: string | null } | undefined;
  const fromDb = row?.at ? Date.parse(row.at) : null;
  const mine = lastAttempt.get(site) ?? null;
  return fromDb === null ? mine : mine === null ? fromDb : Math.max(fromDb, mine);
}

/** Loads a normal job-list page of the site. A block there throws BlockedError; anything else is only logged. */
async function visitList(site: string, page: Page, prefs: Prefs): Promise<string | null> {
  const d = driverFor(site);
  if (!d?.listUrl) return null;
  const terms = searchTerms(prefs);
  const term = terms.length ? terms[Math.floor(Math.random() * terms.length)]! : 'developer';
  const url = d.listUrl(term);
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await assertNotBlocked(page, res?.status());
    return url;
  } catch (e) {
    if (e instanceof BlockedError) throw e;
    log.warn({ site, url, err: e instanceof Error ? e.message.split('\n')[0] : String(e) }, 'could not open the job list to wait on — waiting anyway');
    return null;
  }
}

const CHUNK_MS = 5_000;

/**
 * Before a real send on this site: waits until a random 60–150 s (the site's pacing) after its last send, on a job-list
 * page. Returns the milliseconds waited (0 = no wait needed). Stops waiting early when `signal` aborts. A block on the
 * job-list page throws BlockedError (the caller pauses the site, as for any block).
 */
export async function waitBeforeSend(
  db: DB,
  site: string,
  page: Page,
  opts: { signal?: AbortSignal; onWait?: (text: string) => void; prefs?: Prefs; now?: () => number } = {},
): Promise<number> {
  const prefs = opts.prefs ?? loadPrefs();
  const p = pacingFor(site, prefs);
  const last = lastSendAt(db, site);
  if (last === null || p.maxDelaySec <= 0) return 0;
  const now = opts.now ?? Date.now;
  const target = last + randomDelay(p.minDelaySec * 1000, p.maxDelaySec * 1000);
  const total = target - now();
  if (total <= 0) return 0;
  opts.onWait?.(`waiting ${Math.round(total / 1000)} s before the next ${site} send (pacing)`);
  log.info({ site, waitSec: Math.round(total / 1000) }, 'pacing: waiting before the next send');
  if (p.idleOnList && (await visitList(site, page, prefs))) opts.onWait?.(`waiting ${Math.round(total / 1000)} s on a ${site} job list before the next send (pacing)`);
  const rest = Math.max(0, target - now());
  // in chunks, so Stop ends the wait (and a test's instant pace() still ends the loop)
  for (let left = rest; left > 0; left -= CHUNK_MS) {
    if (opts.signal?.aborted) break;
    const ms = Math.min(CHUNK_MS, left);
    await pace(ms, ms);
  }
  return total;
}
