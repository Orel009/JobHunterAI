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
export const setSession = (site: string, s: SessionInfo) => {
  states[site] = s;
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
