/**
 * The daily apply limit is per site: the status shows today's count per site with an apply flow. At startup each
 * enabled site's session is checked once, in the background (paused sites and sites already checked are skipped).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-startup';
  process.env.PREFERENCES_FILE = 'data/test-startup/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));

import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { buildApp } from '../src/server/app.js';
import { setSession, type SessionInfo } from '../src/browser/site-session.js';
import { sitesToCheckAtStartup, startStartupSessionChecks } from '../src/pipeline/startup-checks.js';
import { startTask, waitIdle } from '../src/pipeline/runner.js';
import { pauseSite, sitePauses, unpauseSite } from '../src/core/site-pause.js';
import { SITES } from '../src/sites/registry.js';

let db: DB;
beforeEach(async () => {
  await waitIdle();
  db = openDb(':memory:');
  for (const s of Object.keys(sitePauses())) unpauseSite(s);
  for (const s of SITES) setSession(s.id, { state: 'unknown', checkedAt: null, detail: 'not checked yet' });
});

describe('daily limit per site', () => {
  it('the status shows each site with an apply flow, against the per-site limit', async () => {
    const insert = db.prepare("INSERT INTO applications (job_id, site, status, plan_json, dry_run, submitted_at, created_at, updated_at) VALUES (?, ?, 'submitted', '{}', 0, ?, ?, ?)");
    const now = new Date().toISOString();
    for (const [i, site] of ['drushim', 'drushim', 'jobmaster'].entries()) {
      db.prepare("INSERT INTO jobs (id, site, external_id, company, company_norm, title, title_norm, location, description_text, requirements_text, url, apply_type, apply_target, language, details_fetched, raw_json, content_hash, status, first_seen_at, last_seen_at, updated_at) VALUES (?, ?, ?, 'c', 'c', 't', 't', '', '', '', 'u', 'site_one_click', '', 'en', 1, '{}', 'h', 'submitted', ?, ?, ?)").run(`j${i}`, site, `${i}`, now, now, now);
      insert.run(`j${i}`, site, now, now, now);
    }
    expect(new Repo(db).submittedTodayBySite()).toEqual({ drushim: 2, jobmaster: 1 });
    const st = (await buildApp(db).inject({ method: 'GET', url: '/api/status' })).json();
    expect(st.today.submitted).toBe(3);
    expect(st.today.bySite).toEqual(expect.arrayContaining([{ site: 'drushim', label: 'Drushim', submitted: 2 }, { site: 'jobmaster', label: 'JobMaster', submitted: 1 }, { site: 'jobnet', label: 'Jobnet', submitted: 0 }]));
  });
});

describe('session checks at startup', () => {
  const ok = (site: string): Promise<SessionInfo> => {
    const info: SessionInfo = { state: 'logged_in', checkedAt: new Date().toISOString(), detail: `${site} ok` };
    setSession(site, info);
    return Promise.resolve(info);
  };

  it('every enabled site with an apply flow, once each, in one background task; paused and already-checked sites skipped', async () => {
    pauseSite('jobkarov', 'refused by the site (HTTP 402)');
    setSession('drushim', { state: 'logged_in', checkedAt: new Date().toISOString(), detail: 'checked by npm start' });
    const checked: string[] = [];
    const id = startStartupSessionChecks(db, (s) => (checked.push(s), ok(s)));
    expect(id).not.toBeNull();
    await waitIdle();
    expect(checked).toEqual(['jobmaster', 'jobnet']);
    expect(sitesToCheckAtStartup()).toEqual([]);
  });

  it('nothing to check → no task; another run active → skipped (no error)', async () => {
    for (const s of SITES) setSession(s.id, { state: 'logged_in', checkedAt: new Date().toISOString(), detail: 'x' });
    expect(startStartupSessionChecks(db, ok)).toBeNull();
    for (const s of SITES) setSession(s.id, { state: 'unknown', checkedAt: null, detail: 'x' });
    let release!: () => void;
    startTask(db, 'drushim', 'full', () => new Promise<void>((r) => (release = r)));
    expect(startStartupSessionChecks(db, ok)).toBeNull();
    release();
    await waitIdle();
  });
});
