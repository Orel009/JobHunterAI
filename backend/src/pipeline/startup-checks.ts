/**
 * Right after the app starts: each enabled site's own session check, one after another, so the header shows the real
 * login state instead of "login unknown". Skipped: paused sites (they are not loaded at all) and sites already checked
 * in this process (npm start checks Drushim before the server starts). One browser task; a check that hits a block
 * pauses that site for 48 hours, as always.
 */
import type { DB } from '../db/index.js';
import { checkSiteSession, getSession, type SessionInfo } from '../browser/site-session.js';
import { hasApplyFlow } from '../apply/drivers.js';
import { isPaused } from '../core/site-pause.js';
import { adapters, SITES } from '../sites/registry.js';
import { startTask } from './runner.js';

export const STARTUP_CHECK_SITE = 'sessions';

/** The sites the startup check covers (enabled, with an apply flow, not paused, not checked yet). */
export const sitesToCheckAtStartup = () =>
  SITES.filter((s) => s.enabled && adapters[s.id] && hasApplyFlow(s.id) && !isPaused(s.id) && getSession(s.id).checkedAt === null);

export function startStartupSessionChecks(db: DB, check: (site: string) => Promise<SessionInfo> = checkSiteSession): number | null {
  const sites = sitesToCheckAtStartup();
  if (!sites.length) return null;
  try {
    return startTask(db, STARTUP_CHECK_SITE, 'session_check', async (run, _repo, L) => {
      run.stats.checked = 0;
      for (const s of sites) {
        if (run.controller.signal.aborted) return;
        run.stage = `checking the ${s.displayName} login`;
        const info = await check(s.id).catch((e: unknown): SessionInfo => ({ state: 'unknown', checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message : String(e) }));
        run.stats.checked++;
        L.info({ site: s.id, state: info.state, detail: info.detail }, 'startup session check');
      }
    });
  } catch {
    return null; // something else is already running: the checks run with the next Run & send
  }
}
