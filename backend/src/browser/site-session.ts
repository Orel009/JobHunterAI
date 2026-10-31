/**
 * Site login state, checked by the session probe the site's own frontend calls (never by logging in).
 * The server keeps the last result: when a site is known to be logged out, applying is disabled.
 */
import type { BrowserContext } from 'playwright';
import { closeContext, getContext, getPage } from './session.js';
import cfg from '../sites/drushim/selectors.json' with { type: 'json' };
import { watchSessionProbe } from '../sites/drushim/session-probe.js';

export type LoginState = 'logged_in' | 'logged_out' | 'unknown';

export interface SessionInfo {
  state: LoginState;
  checkedAt: string | null;
  detail: string;
}

const states: Record<string, SessionInfo> = {
  drushim: { state: 'unknown', checkedAt: null, detail: 'not checked yet' },
};

export const getSession = (site: string): SessionInfo => states[site] ?? { state: 'unknown', checkedAt: null, detail: 'unknown site' };
export const allSessions = () => ({ ...states });
const validListeners: Array<(site: string) => void> = [];
/** Called whenever a site's session is confirmed logged in (e.g. to put jobs that failed on "not logged in" back). */
export const onSessionValid = (fn: (site: string) => void) => void validListeners.push(fn);
export const setSession = (site: string, s: SessionInfo) => {
  states[site] = s;
  if (s.state === 'logged_in') for (const fn of validListeners) fn(site);
};


/**
 * Opens the persistent profile headless, loads the Drushim homepage and reads the seeker-details probe:
 * 200 = logged in, 401 = logged out. Closes the browser afterwards. Records the result.
 * onContext runs on the fresh context first (e.g. to read which cookies survived the restart).
 */
export async function checkDrushimSession(onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  let info: SessionInfo;
  try {
    const ctx = await getContext({ headless: true });
    await onContext?.(ctx);
    const page = await getPage({ headless: true });
    // the first probe is often 401 until the site refreshes its token; wait for the settled answer
    const probe = watchSessionProbe(page, 30_000);
    await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const state = await probe.settle();
    const now = new Date().toISOString();
    const seen = probe.statuses.join('→') || 'none';
    if (state === 'unknown') info = { state: 'unknown', checkedAt: now, detail: 'session probe not seen (site changed or slow?)' };
    else info = { state, checkedAt: now, detail: `probe ${seen}` };
  } catch (e) {
    info = { state: 'unknown', checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  } finally {
    await closeContext();
  }
  setSession('drushim', info);
  return info;
}

/**
 * AllJobs: its own session endpoint (observed 2026-10-31) answers `null` when logged out and the session object when
 * logged in. Read with the browser's cookies; nothing is sent.
 */
const ALLJOBS_SESSION = 'https://app.alljobs.co.il/api/auth/session';
export async function checkAllJobsSession(onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  let info: SessionInfo;
  try {
    const ctx = await getContext({ headless: true });
    await onContext?.(ctx);
    const r = await ctx.request.get(ALLJOBS_SESSION, { timeout: 20_000 });
    const body = (await r.json().catch(() => null)) as { user?: unknown } | null;
    const now = new Date().toISOString();
    if (!r.ok()) info = { state: 'unknown', checkedAt: now, detail: `session endpoint ${r.status()}` };
    else info = body && body.user ? { state: 'logged_in', checkedAt: now, detail: 'session endpoint: user' } : { state: 'logged_out', checkedAt: now, detail: 'session endpoint: null' };
  } catch (e) {
    info = { state: 'unknown', checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  } finally {
    await closeContext();
  }
  setSession('alljobs', info);
  return info;
}

/** The session check of a site (sites without one answer "unknown"). */
export function checkSiteSession(site: string, onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  if (site === 'drushim') return checkDrushimSession(onContext);
  if (site === 'alljobs') return checkAllJobsSession(onContext);
  return Promise.resolve({ state: 'unknown', checkedAt: null, detail: `no session check for ${site} yet` });
}
