/**
 * "Already applied" must end as skipped (reason already_applied), never failed — on every path: the site's applied
 * list during discovery, the pre-check before preparing / submitting, the job page, and the send-cv response.
 * Stand-ins for the Drushim pages and the browser; own data folder; test-mode model; DRY_RUN off (submissions are
 * stand-ins too: nothing reaches any site).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-applied';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return {
    applied: new Map<string, string | null>(),
    openPanel: null as null | (() => Promise<unknown>),
    submitOutcome: { kind: 'submitted' } as unknown,
    calls: { openPanel: 0, submit: 0 },
  };
});

vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/drushim/apply.js', async (orig) => {
  const real = await orig<typeof import('../src/sites/drushim/apply.js')>();
  return {
    ...real,
    fetchAppliedJobs: async () => h.applied,
    installDryRunGuard: async () => async () => undefined,
    openPanel: async () => {
      h.calls.openPanel++;
      if (h.openPanel) return h.openPanel();
      return { fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false };
    },
    fillPanel: async () => undefined,
    screenshotPanel: async () => 'shot.png',
    screenshot: async () => 'shot.png',
    submitPanel: async () => {
      h.calls.submit++;
      return { outcome: h.submitOutcome, confirmationText: null, screenshotAfter: 'after.png' };
    },
  };
});
vi.mock('../src/sites/registry.js', async (orig) => {
  const real = await orig<typeof import('../src/sites/registry.js')>();
  const card = (id: string, title: string) => ({
    site: 'drushim' as const, externalId: id, company: `Co ${id}`, title, location: 'חיפה', descriptionText: 'React', requirementsText: '',
    url: `https://www.drushim.co.il/job/${id}/x/`, postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {},
  });
  const fake = {
    id: 'drushim' as const,
    displayName: 'Drushim',
    loginUrl: 'https://www.drushim.co.il/',
    async *search() {
      yield card('100', 'Full Stack Developer');
      yield card('200', 'Backend Developer');
    },
    async getDetails() {
      return null;
    },
    async appliedJobs() {
      return h.applied;
    },
  };
  return { ...real, adapters: { drushim: fake }, getAdapter: (id: string) => (id === 'drushim' ? fake : real.getAdapter(id)) };
});

import fs from 'node:fs';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { startRun, waitIdle } from '../src/pipeline/runner.js';
import { approveApplication, prepareJobs } from '../src/apply/service.js';
import { Applications } from '../src/apply/plan.js';
import { ApplyError } from '../src/sites/drushim/apply.js';
import { decideSession, REFRESH_GRACE_MS } from '../src/sites/drushim/session-probe.js';
import { config } from '../src/config.js';
import { profilePath } from '../src/profile/facts.js';
import type { ApplyPlan } from '../src/apply/types.js';

fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
fs.writeFileSync(profilePath(), JSON.stringify({ contact: { name: { he: 'דנה', en: 'Dana Test' }, city: {} }, skills: [{ id: 'skill.react', name: 'React' }] }));

const raw = (id: string) => ({
  site: 'drushim' as const, externalId: id, company: `Co ${id}`, title: 'Full Stack Developer', location: 'חיפה', descriptionText: 'React', requirementsText: '',
  url: `https://www.drushim.co.il/job/${id}/x/`, postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {},
});
let db: DB;
let repo: Repo;
const status = (id: string) => repo.getJob(jobId('drushim', id))!;
const lastRun = () => repo.listRuns(1)[0] as unknown as { kind: string; status: string; reason: string | null };

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  h.applied = new Map();
  h.openPanel = null;
  h.submitOutcome = { kind: 'submitted' };
  h.calls = { openPanel: 0, submit: 0 };
});

describe('session probe: the first 401 is not the answer', () => {
  it('a 200 at any point → logged in; a lone 401 → logged out only after the refresh grace period', () => {
    expect(decideSession([401, 200], 500, false)).toBe('logged_in');
    expect(decideSession([401], 500, false)).toBeNull(); // keep waiting: the site is refreshing its token
    expect(decideSession([401], REFRESH_GRACE_MS, false)).toBe('logged_out');
    expect(decideSession([], null, false)).toBeNull();
    expect(decideSession([], null, true)).toBe('unknown');
  });
});

describe('the applied list', () => {
  it('marks discovered / scored / queued / failed jobs skipped already_applied; leaves our own submissions alone', () => {
    for (const id of ['1', '2', '3', '4', '5']) repo.upsertJob(toJob(raw(id)));
    repo.setStatus(jobId('drushim', '2'), 'scored');
    repo.setStatus(jobId('drushim', '3'), 'failed', 'locator.click: Timeout 30000ms exceeded.');
    repo.setStatus(jobId('drushim', '4'), 'submitted', 'submitted');
    const n = repo.markAlreadyApplied('drushim', new Map([['1', '2026-10-28T08:08:29.64'], ['2', null], ['3', '2026-10-01T00:00:00'], ['4', '2026-10-31T19:04:04']]));
    expect(n).toBe(3);
    expect(status('1')).toMatchObject({ status: 'skipped', statusReason: 'already_applied: on drushim (sent 2026-10-28)' });
    expect(status('2').statusReason).toBe('already_applied: on drushim');
    expect(status('3').status).toBe('skipped'); // was failed (the ONE BPO case)
    expect(status('4').status).toBe('submitted');
    expect(status('5').status).toBe('discovered');
  });

  it('failed jobs whose recorded error says "already applied" are re-classified without the site', () => {
    repo.upsertJob(toJob(raw('7')));
    repo.setStatus(jobId('drushim', '7'), 'failed', 'כבר הגשת מועמדות למשרה זו');
    expect(repo.reclassifyAlreadyAppliedFailures()).toBe(1);
    expect(status('7')).toMatchObject({ status: 'skipped', statusReason: 'already_applied: כבר הגשת מועמדות למשרה זו' });
  });

  it('discovery skips jobs from the applied list before they are scored or queued', async () => {
    h.applied = new Map([['100', '2026-10-28T08:08:29']]);
    startRun(db, 'drushim', 'full');
    await waitIdle();
    expect(status('100')).toMatchObject({ status: 'skipped', statusReason: 'already_applied: on drushim (sent 2026-10-28)' });
    expect(status('200').status).toBe('scored');
    expect(repo.getScore(jobId('drushim', '100'))).toBeNull();
  });
});

describe('prepare', () => {
  it('a job on the applied list is skipped before its page is opened', async () => {
    repo.upsertJob(toJob(raw('300')));
    h.applied = new Map([['300', null]]);
    prepareJobs(db, [jobId('drushim', '300')]);
    await waitIdle();
    expect(status('300').status).toBe('skipped');
    expect(h.calls.openPanel).toBe(0);
  });

  it('the job page says already applied (no button, the "הגשת" chip) → skipped, not failed', async () => {
    repo.upsertJob(toJob(raw('301')));
    h.openPanel = async () => {
      throw new ApplyError('already_applied', 'job page shows "הגשת" (no apply button)');
    };
    prepareJobs(db, [jobId('drushim', '301')]);
    await waitIdle();
    expect(status('301')).toMatchObject({ status: 'skipped', statusReason: 'already_applied: job page shows "הגשת" (no apply button)' });
  });

  it('a real problem still fails', async () => {
    repo.upsertJob(toJob(raw('302')));
    h.openPanel = async () => {
      throw new ApplyError('no_apply_button', 'apply button not found on the job page');
    };
    prepareJobs(db, [jobId('drushim', '302')]);
    await waitIdle();
    expect(status('302').status).toBe('failed');
  });
});

describe('submit (DRY_RUN off)', () => {
  const plan = (id: string): ApplyPlan => ({ jobId: jobId('drushim', id), site: 'drushim', createdAt: '', cv: { lang: 'he', cvName: 'cv.pdf', hebrewRatio: 1, threshold: 0.2 }, fields: [], readiness: 'ready', notes: [] });
  const queued = (id: string) => {
    repo.upsertJob(toJob(raw(id)));
    repo.setStatus(jobId('drushim', id), 'needs_review');
    return new Applications(db).savePlan(repo.getJob(jobId('drushim', id))!, plan(id), 'needs_review');
  };

  it('the send-cv answer "Failed + SentDate" → skipped already_applied, and the run is not a failure', async () => {
    expect(config.DRY_RUN).toBe(false);
    const app = queued('400');
    h.submitOutcome = { kind: 'already_applied', sentDate: '28/10/2026' };
    approveApplication(db, app.id);
    await waitIdle();
    expect(status('400')).toMatchObject({ status: 'skipped', statusReason: 'already_applied: the site answered "sent 28/10/2026"' });
    expect(new Applications(db).get(app.id)!.status).toBe('skipped');
    expect(lastRun()).toMatchObject({ kind: 'submit', status: 'done' });
  });

  it('applied in the meantime (on the applied list) → skipped before anything is opened or sent', async () => {
    const app = queued('401');
    h.applied = new Map([['401', '2026-10-31T10:00:00']]);
    approveApplication(db, app.id);
    await waitIdle();
    expect(status('401').statusReason).toBe('already_applied: on drushim (sent 2026-10-31)');
    expect(h.calls.openPanel + h.calls.submit).toBe(0);
  });

  it('the page says already applied while submitting → skipped, run done', async () => {
    const app = queued('402');
    h.openPanel = async () => {
      throw new ApplyError('already_applied', 'job page shows "הגשת" (the apply button went away)');
    };
    approveApplication(db, app.id);
    await waitIdle();
    expect(status('402').status).toBe('skipped');
    expect(lastRun().status).toBe('done');
  });
});
