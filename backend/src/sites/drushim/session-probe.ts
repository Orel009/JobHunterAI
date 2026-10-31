/**
 * Is the page logged in? Observed on the live site (2026-10-31): the access token lives ~10 minutes, so a page load
 * often starts with gw …/auth/seeker-details → 401, then the site POSTs …/api/session/refresh/ and the next probe
 * returns 200. The FIRST probe therefore says nothing; any 200 means logged in, and only a 401 that is not followed
 * by a 200 within a few seconds means logged out.
 */
import type { Page, Response } from 'playwright';
import cfg from './selectors.json' with { type: 'json' };

export type ProbeState = 'logged_in' | 'logged_out' | 'unknown';

const PROBE = new RegExp(cfg.sessionProbePattern);
/** after the first 401, how long the site gets to refresh the token and probe again */
export const REFRESH_GRACE_MS = 6000;

/** Pure decision over the probe statuses seen so far. null = keep waiting. */
export function decideSession(statuses: number[], msSinceFirst401: number | null, timedOut: boolean): ProbeState | null {
  if (statuses.includes(200)) return 'logged_in';
  if (statuses.some((s) => s === 401 || s === 403)) return msSinceFirst401 !== null && msSinceFirst401 >= REFRESH_GRACE_MS ? 'logged_out' : timedOut ? 'logged_out' : null;
  return timedOut ? 'unknown' : null;
}

/** Start watching BEFORE navigating; settle() resolves once the probes give an answer (or after timeoutMs). */
export function watchSessionProbe(page: Page, timeoutMs = 20_000) {
  const statuses: number[] = [];
  let first401: number | null = null;
  const onResponse = (r: Response) => {
    if (!PROBE.test(r.url())) return;
    statuses.push(r.status());
    if ((r.status() === 401 || r.status() === 403) && first401 === null) first401 = Date.now();
  };
  page.on('response', onResponse);
  const started = Date.now();
  return {
    statuses,
    async settle(): Promise<ProbeState> {
      try {
        for (;;) {
          const d = decideSession(statuses, first401 === null ? null : Date.now() - first401, Date.now() - started >= timeoutMs);
          if (d) return d;
          await page.waitForTimeout(250);
        }
      } finally {
        page.off('response', onResponse);
      }
    },
  };
}
