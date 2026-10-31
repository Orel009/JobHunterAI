/**
 * Did the login survive? Compares the site's cookies Chrome SAVED in the profile (read from its cookie file after
 * the window closed) with the cookies the automated Chrome SEES after a restart, then runs the site's session probe.
 * Only cookie names, domains and expiry are read — never values.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkDrushimSession, type SessionInfo } from './site-session.js';

export interface CookieInfo {
  domain: string;
  name: string;
  /** ISO time, or null for a session-only cookie */
  expires: string | null;
}

const AUTH_COOKIE = /token|auth|session|refresh|login|user|jwt|sid/i;

/** The site's cookies as saved on disk by Chrome (the profile must not be open). */
export function savedCookies(profileDir: string, site: string): CookieInfo[] {
  const file = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (!fs.existsSync(file)) return [];
  const copy = path.join(os.tmpdir(), `jobhunter-cookies-${process.pid}.db`);
  fs.copyFileSync(file, copy);
  try {
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      // Chrome stores microseconds since 1601-01-01; converted in SQL (too large for a JS number)
      const rows = db
        .prepare(
          `SELECT host_key AS domain, name, is_persistent AS persistent,
                  CAST(expires_utc / 1000000 - 11644473600 AS INTEGER) AS unix
           FROM cookies WHERE host_key LIKE ? ORDER BY host_key, name`,
        )
        .all(`%${site}%`) as Array<{ domain: string; name: string; persistent: number; unix: number }>;
      return rows.map((r) => ({ domain: r.domain, name: r.name, expires: r.persistent && r.unix > 0 ? new Date(r.unix * 1000).toISOString() : null }));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

export interface SessionReport {
  session: SessionInfo;
  saved: CookieInfo[];
  seen: CookieInfo[];
  /** saved on disk but gone after the restart */
  lost: CookieInfo[];
}

export async function sessionReport(profileDir: string, site: string): Promise<SessionReport> {
  const saved = savedCookies(profileDir, site);
  let seen: CookieInfo[] = [];
  const session = await checkDrushimSession(async (ctx) => {
    seen = (await ctx.cookies())
      .filter((c) => c.domain.includes(site))
      .map((c) => ({ domain: c.domain, name: c.name, expires: c.expires === -1 ? null : new Date(c.expires * 1000).toISOString() }));
  });
  const key = (c: CookieInfo) => `${c.domain}|${c.name}`;
  const seenKeys = new Set(seen.map(key));
  return { session, saved, seen, lost: saved.filter((c) => !seenKeys.has(key(c))) };
}

export function formatSessionReport(r: SessionReport): string {
  const auth = (list: CookieInfo[]) => list.filter((c) => AUTH_COOKIE.test(c.name));
  const line = (c: CookieInfo) =>
    `  ${c.domain.padEnd(24)} ${c.name.padEnd(34)} ${c.expires === null ? 'SESSION ONLY (dropped when the browser restarts)' : `${c.expires}${Date.parse(c.expires) < Date.now() ? ' (expired)' : ''}`}`;
  const out: string[] = [];
  out.push(`cookies saved by Chrome for this site: ${r.saved.length} (${auth(r.saved).length} login-related)`);
  for (const c of auth(r.saved)) out.push(line(c));
  out.push(`cookies seen after restarting the browser: ${r.seen.length}`);
  if (r.lost.length) {
    out.push(`✗ ${r.lost.length} cookie(s) did NOT survive the restart:`);
    for (const c of r.lost) out.push(line(c));
  } else if (r.saved.length) out.push('✓ every saved cookie survived the restart');
  const s = r.session;
  out.push(
    `session probe: ${s.detail} → ${s.state === 'logged_in' ? 'LOGGED IN' : s.state === 'logged_out' ? 'NOT logged in' : `UNKNOWN (${s.detail})`}`,
  );
  if (s.state === 'logged_out' && !auth(r.saved).some((c) => c.expires)) {
    out.push('  no login cookie was saved to disk: the site kept the login only for that browser session.');
  }
  return out.join('\n');
}
