/**
 * Resuming a paused site: ONE session check, and the site resumes only if it served its real page. A check that cannot
 * tell keeps it paused. Challenged again at this check after the pause ran out → paused for 7 days (core/site-pause.ts),
 * and the result says so (`repaused`); during a pause that is still running (an early Settings → Resume) the pause keeps
 * its end. Used by Settings → Resume (any time) and by Run & send once a pause has run out.
 */
import type { DB } from '../db/index.js';
import { resumeSessionCheck, type SessionInfo } from '../browser/site-session.js';
import { REPAUSE_HOURS, isRepause, israelTime, pauseOf, pauseSite, unpauseSite } from '../core/site-pause.js';
import { startTask } from './runner.js';

export interface ResumeResult {
  site: string;
  resumed: boolean;
  detail: string;
  session: SessionInfo | null;
  /** challenged again after the pause: paused for 7 days (until) — tell the user */
  repaused?: { until: string; reason: string };
}

/** The decision after the check (pure apart from the pause store). */
export function decideResume(site: string, info: SessionInfo): ResumeResult {
  if (info.blocked) {
    const p = pauseSite(site, info.blocked); // the session check may have paused it already: the same pause, never shorter
    if (isRepause(p) && Date.parse(p.until) - Date.parse(p.since) >= REPAUSE_HOURS * 3_600_000 - 60_000) {
      return {
        site,
        resumed: false,
        detail: `challenged again after the pause (${info.blocked}) — paused for 7 days, until ${israelTime(p.until)} Israel time`,
        session: info,
        repaused: { until: p.until, reason: p.reason },
      };
    }
    return { site, resumed: false, detail: `still blocked: ${info.blocked} — paused until ${israelTime(p.until)} Israel time`, session: info };
  }
  if (!info.realPage) return { site, resumed: false, detail: `still paused: the check could not confirm a real page (${info.detail})`, session: info };
  unpauseSite(site, { byCheck: true });
  return { site, resumed: true, detail: `resumed: the site serves its page again (${info.state === 'logged_in' ? 'logged in' : info.state === 'logged_out' ? 'NOT logged in — log in again' : info.detail})`, session: info };
}

export async function resumeCheck(site: string, check: (site: string) => Promise<SessionInfo> = resumeSessionCheck): Promise<ResumeResult> {
  if (!pauseOf(site)) return { site, resumed: true, detail: 'not paused', session: null };
  const info = await check(site).catch((e: unknown): SessionInfo => ({ state: 'unknown', checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message : String(e) }));
  return decideResume(site, info);
}

/** Settings → Resume: the check as a browser task (one at a time), answered when it is done. */
export function resumeSiteNow(db: DB, site: string): Promise<ResumeResult> {
  return new Promise((resolve, reject) => {
    try {
      startTask(db, site, 'resume_check', async (run) => {
        run.stage = `checking whether ${site} serves its page again`;
        try {
          resolve(await resumeCheck(site));
        } catch (e) {
          resolve({ site, resumed: false, detail: e instanceof Error ? e.message : String(e), session: null });
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}
