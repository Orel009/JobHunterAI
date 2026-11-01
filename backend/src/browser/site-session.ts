/**
 * Site login state, checked by the session probe the site's own frontend calls (never by logging in).
 * The server keeps the last result: when a site is known to be logged out, applying is disabled.
 */
import type { BrowserContext } from 'playwright';
import { closeContext, detectBlock, getContext, getPage } from './session.js';
import cfg from '../sites/drushim/selectors.json' with { type: 'json' };
import { watchSessionProbe } from '../sites/drushim/session-probe.js';
import { JM_BASE, loginState as jmLoginState } from '../sites/jobmaster/parse.js';
import { JN_BASE, sendFormUrl as jnSendFormUrl } from '../sites/jobnet/parse.js';
import { sendFormLoginState as jnLoginState } from '../sites/jobnet/apply.js';
import { JK_BASE } from '../sites/jobkarov/parse.js';
import { jkSessionVerdict, readLogin as jkReadLogin, type JkSessionEvidence } from '../sites/jobkarov/apply.js';

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

/**
 * Jobnet: its pages fill in the user part with scripts, so the check uses the send form of a current job (the free
 * search's first result): logged in = the "already registered? log in" prompt is hidden and your saved CVs are listed.
 * Two page loads; nothing is sent. A bot-protection page answers "unknown".
 */
export async function checkJobnetSession(onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  let info: SessionInfo;
  try {
    const ctx = await getContext({ headless: true });
    await onContext?.(ctx);
    const page = await getPage();
    let res = await page.goto(`${JN_BASE}/jobs?searchtype=freesearch&freetxt=${encodeURIComponent('מפתח')}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    let blocked = await detectBlock(page, res?.status());
    const id = blocked ? null : (/href="\/jobs\?positionid=(\d+)"/.exec(await page.content())?.[1] ?? null);
    if (!blocked && id) {
      res = await page.goto(jnSendFormUrl(id), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      blocked = await detectBlock(page, res?.status());
    }
    const now = new Date().toISOString();
    if (blocked) info = { state: 'unknown', checkedAt: now, detail: `jobnet: ${blocked} — not bypassed; try again later` };
    else if (!id) info = { state: 'unknown', checkedAt: now, detail: 'jobnet: no job found to check the session with' };
    else {
      const state = jnLoginState(await page.content());
      info = { state, checkedAt: now, detail: state === 'logged_in' ? 'jobnet: your saved CVs are listed' : state === 'logged_out' ? 'jobnet: the send form asks to log in' : 'jobnet: could not tell from the send form' };
    }
  } catch (e) {
    info = { state: 'unknown', checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  } finally {
    await closeContext();
  }
  setSession('jobnet', info);
  return info;
}

/**
 * JobKarov: its pages load your account with a script (window.User, from /User/UserInfo — a read). One page load;
 * nothing is sent. The verdict carries the exact reason: the site refused the page (HTTP 402 "site unavailable", bot
 * protection), a redirect away from the homepage, the login cookie missing, the account lookup not run / failed /
 * empty — or logged in.
 */
export async function checkJobKarovSession(onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  let info: SessionInfo;
  try {
    const ctx = await getContext({ headless: true });
    await onContext?.(ctx);
    const loginCookie = (await ctx.cookies(`${JK_BASE}/`)).some((c) => c.name === 'UserInfo' && !!c.value);
    const page = await getPage();
    let userInfo: JkSessionEvidence['userInfo'] = { requested: false };
    page.on('response', (r) => {
      if (!/\/User\/UserInfo(?:$|\?)/i.test(r.url())) return;
      userInfo = { requested: true, status: r.status(), account: false };
      void r
        .json()
        .then((j: unknown) => {
          const u = j as { ID?: unknown; id?: unknown } | null;
          if (u && Number(u.ID ?? u.id ?? 0) > 0) userInfo = { requested: true, status: r.status(), account: true };
        })
        .catch(() => undefined);
    });
    const res = await page.goto(`${JK_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
    const blocked = await detectBlock(page, res?.status());
    const login = blocked ? 'unknown' : await jkReadLogin(page);
    const bootstrap = await page.evaluate(() => 'UserFromJS' in window).catch(() => false);
    const v = jkSessionVerdict({ status: res?.status() ?? null, blocked, finalUrl: page.url(), loginCookie, bootstrap, userInfo, userId: login === 'logged_in' });
    info = { ...v, checkedAt: new Date().toISOString() };
  } catch (e) {
    info = { state: 'unknown', checkedAt: new Date().toISOString(), detail: `jobkarov: ${e instanceof Error ? e.message.split('\n')[0]! : String(e)}` };
  } finally {
    await closeContext();
  }
  setSession('jobkarov', info);
  return info;
}

/** The session check of a site (sites without one answer "unknown"). */
export function checkSiteSession(site: string, onContext?: (ctx: BrowserContext) => Promise<void>): Promise<SessionInfo> {
  if (site === 'drushim') return checkDrushimSession(onContext);
  if (site === 'alljobs') return checkAllJobsSession(onContext);
  if (site === 'jobmaster') return checkJobMasterSession(onContext);
  if (site === 'jobnet') return checkJobnetSession(onContext);
  if (site === 'jobkarov') return checkJobKarovSession(onContext);
  return Promise.resolve({ state: 'unknown', checkedAt: null, detail: `no session check for ${site} yet` });
}
