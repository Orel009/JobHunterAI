/**
 * Site login state, checked by the session probe the site's own frontend calls (never by logging in).
 * The server keeps the last result: when a site is known to be logged out, applying is disabled.
 */
import type { BrowserContext } from 'playwright';
import { closeContext, detectBlock, getContext, getPage } from './session.js';
import cfg from '../sites/drushim/selectors.json' with { type: 'json' };
import { watchSessionProbe } from '../sites/drushim/session-probe.js';
import { JM_BASE, loginState as jmLoginState } from '../sites/jobmaster/parse.js';

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
 * AllJobs: the classic site (www.alljobs.co.il, where jobs are applied to) shows a logout link when logged in and a
 * login link when not. (app.alljobs.co.il/api/auth/session belongs to a separate app: it answered null while the
 * classic site was logged in — observed 2026-10-31.) One page load with the browser's cookies; nothing is sent.
 * A bot-protection page answers "unknown" — never bypassed.
 */
export const ALLJOBS_HOME = 'https://www.alljobs.co.il/';
export function allJobsLoginState(page: { logout: boolean; login: boolean }): 'logged_in' | 'logged_out' | 'unknown' {
  if (page.logout) return 'logged_in';
  if (page.login) return 'logged_out';
  return 'unknown';
}
export async function checkAllJobsSession(onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  let info: SessionInfo;
  try {
    const ctx = await getContext({ headless: true });
    await onContext?.(ctx);
    const page = await getPage();
    const res = await page.goto(ALLJOBS_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
    const now = new Date().toISOString();
    const blocked = await detectBlock(page, res?.status());
    if (blocked) info = { state: 'unknown', checkedAt: now, detail: `alljobs: ${blocked} — not bypassed; try again later` };
    else {
      const links = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('a, button'));
        return {
          logout: items.some((a) => /התנתק|logout|signout/i.test((a.textContent ?? '') + (a.getAttribute('href') ?? ''))),
          login: items.some((a) => /^\s*(כניסה|התחברות)\s*$/.test(a.textContent ?? '')),
        };
      });
      const state = allJobsLoginState(links);
      info = { state, checkedAt: now, detail: state === 'logged_in' ? 'alljobs: logout link shown' : state === 'logged_out' ? 'alljobs: login link shown' : 'alljobs: neither login nor logout link found' };
    }
  } catch (e) {
    info = { state: 'unknown', checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  } finally {
    await closeContext();
  }
  setSession('alljobs', info);
  return info;
}

/**
 * JobMaster: a logged-in page links to logoff.asp, a logged-out one shows the "התחבר" link (sites/jobmaster/parse.ts).
 * One page load with the browser's cookies; nothing is sent. A bot-protection page answers "unknown".
 */
export async function checkJobMasterSession(onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  let info: SessionInfo;
  try {
    const ctx = await getContext({ headless: true });
    await onContext?.(ctx);
    const page = await getPage();
    const res = await page.goto(`${JM_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
    const now = new Date().toISOString();
    const blocked = await detectBlock(page, res?.status());
    if (blocked) info = { state: 'unknown', checkedAt: now, detail: `jobmaster: ${blocked} — not bypassed; try again later` };
    else {
      const state = jmLoginState(await page.content());
      info = { state, checkedAt: now, detail: state === 'logged_in' ? 'jobmaster: logoff link shown' : state === 'logged_out' ? 'jobmaster: login link shown' : 'jobmaster: neither login nor logoff link found' };
    }
  } catch (e) {
    info = { state: 'unknown', checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  } finally {
    await closeContext();
  }
  setSession('jobmaster', info);
  return info;
}

/** The session check of a site (sites without one answer "unknown"). */
export function checkSiteSession(site: string, onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  if (site === 'drushim') return checkDrushimSession(onContext);
  if (site === 'alljobs') return checkAllJobsSession(onContext);
  if (site === 'jobmaster') return checkJobMasterSession(onContext);
  return Promise.resolve({ state: 'unknown', checkedAt: null, detail: `no session check for ${site} yet` });
}
