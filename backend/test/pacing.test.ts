/**
 * Sending pace per site (apply/pacing.ts): the defaults (Drushim 60–150 s, 8 per session, 12 per day; JobMaster /
 * Jobnet moderate), Preferences overrides, the wait counted from the last send and spent on a job list, a block on that
 * page, and Stop ending the wait.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-pacing';
  process.env.PREFERENCES_FILE = 'data/test-pacing/preferences.yaml';
  return { paces: [] as number[] };
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  pace: async (a?: number) => void h.paces.push(a ?? 0),
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { BlockedError } from '../src/browser/session.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { dailySendLimit, lastSendAt, noteSendAttempt, pacingFor, resetSendTimes, sessionSendLimit, waitBeforeSend } from '../src/apply/pacing.js';

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(config.paths.preferences, 'roleTypes:\n  - { id: fs, tier: 1, queries: [מפתח], titleKeywords: [developer] }\n');

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  resetSendTimes();
  h.paces = [];
});

const page = (o: { status?: number; title?: string; body?: string } = {}) => {
  const visited: string[] = [];
  return {
    visited,
    page: {
      goto: async (url: string) => (visited.push(url), { status: () => o.status ?? 200 }),
      title: async () => o.title ?? 'דרושים',
      evaluate: async (fn: unknown) => (String(fn).includes('iframe') ? false : (o.body ?? 'משרות')),
      content: async () => '',
    } as never,
  };
};

describe('defaults and Preferences', () => {
  it('Drushim 60–150 s, 8 per session, 12 per day; JobMaster / Jobnet moderate; other sites unchanged', () => {
    const prefs = PrefsSchema.parse({});
    expect(pacingFor('drushim', prefs)).toEqual({ minDelaySec: 60, maxDelaySec: 150, maxSendsPerSession: 8, maxSendsPerDay: 12, idleOnList: true });
    expect(pacingFor('jobmaster', prefs)).toMatchObject({ minDelaySec: 30, maxDelaySec: 90, maxSendsPerSession: 10, maxSendsPerDay: 15 });
    expect(pacingFor('jobnet', prefs)).toMatchObject({ minDelaySec: 30, maxDelaySec: 90, maxSendsPerSession: 10, maxSendsPerDay: 15 });
    expect(pacingFor('jobkarov', prefs)).toMatchObject({ maxDelaySec: 0, maxSendsPerSession: Infinity });
    expect(dailySendLimit('drushim', prefs)).toBe(12);
    expect(dailySendLimit('jobkarov', prefs)).toBe(15); // the general daily limit
  });
  it('Preferences override per site; the daily number never goes above limits.dailyApplyLimit', () => {
    const prefs = PrefsSchema.parse({ limits: { dailyApplyLimit: 10 }, pacing: { drushim: { minDelaySec: 90, maxSendsPerSession: 4, maxSendsPerDay: 20 } } });
    expect(pacingFor('drushim', prefs)).toMatchObject({ minDelaySec: 90, maxDelaySec: 150, maxSendsPerSession: 4 });
    expect(sessionSendLimit('drushim', prefs)).toBe(4);
    expect(dailySendLimit('drushim', prefs)).toBe(10);
  });
});

describe('the wait before a send', () => {
  it('no earlier send on the site → no wait, nothing loaded', async () => {
    const p = page();
    expect(await waitBeforeSend(db, 'drushim', p.page)).toBe(0);
    expect(p.visited).toEqual([]);
  });
  it('right after a send: 60–150 s, spent on a Drushim job list for one of your terms', async () => {
    noteSendAttempt('drushim');
    const p = page();
    const ms = await waitBeforeSend(db, 'drushim', p.page);
    expect(ms).toBeGreaterThan(59_000);
    expect(ms).toBeLessThanOrEqual(150_000);
    expect(p.visited).toEqual([`https://www.drushim.co.il/jobs/search/${encodeURIComponent('מפתח')}/`]);
    expect(h.paces.reduce((a, b) => a + b, 0)).toBeGreaterThan(58_000);
    expect(Math.max(...h.paces)).toBeLessThanOrEqual(5_000);
  });
  it('counted from the last send in the database too (an earlier batch)', async () => {
    db.prepare(`INSERT INTO jobs (id, site, external_id, company, company_norm, title, title_norm, url, apply_type, language, raw_json, content_hash, status, first_seen_at, last_seen_at, updated_at)
                VALUES ('j','drushim','1','c','c','t','t','u','site_one_click','he','{}','h','submitted',?,?,?)`).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const at = new Date(Date.now() - 30_000).toISOString();
    db.prepare(`INSERT INTO applications (job_id, site, company_norm, status, dry_run, plan_json, created_at, updated_at, submitted_at) VALUES ('j','drushim','c','submitted',0,'{}',?,?,?)`).run(at, at, at);
    expect(lastSendAt(db, 'drushim')).toBe(Date.parse(at));
    const ms = await waitBeforeSend(db, 'drushim', page().page);
    expect(ms).toBeGreaterThan(29_000);
    expect(ms).toBeLessThanOrEqual(120_000);
  });
  it('a long time after the last send → no wait', async () => {
    noteSendAttempt('drushim', Date.now() - 10 * 60_000);
    expect(await waitBeforeSend(db, 'drushim', page().page)).toBe(0);
  });
  it('bot protection on the job list → BlockedError (the caller pauses the site); nothing more is waited', async () => {
    noteSendAttempt('drushim');
    const p = page({ title: 'Radware Page', body: 'Verifying your browser' });
    await expect(waitBeforeSend(db, 'drushim', p.page)).rejects.toBeInstanceOf(BlockedError);
    expect(h.paces).toEqual([]);
  });
  it('the job list does not load → waits anyway (on the page it is on)', async () => {
    noteSendAttempt('jobmaster');
    const p = { goto: async () => Promise.reject(new Error('net::ERR_TIMED_OUT')) } as never;
    expect(await waitBeforeSend(db, 'jobmaster', p)).toBeGreaterThan(29_000);
    expect(h.paces.length).toBeGreaterThan(5);
  });
  it('Stop ends the wait', async () => {
    noteSendAttempt('drushim');
    const ac = new AbortController();
    ac.abort();
    await waitBeforeSend(db, 'drushim', page().page, { signal: ac.signal });
    expect(h.paces).toEqual([]);
  });
});
