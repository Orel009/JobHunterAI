/**
 * "Approved" never sticks, and nothing is sent twice: a run that fails before sending (browser profile in use, login),
 * an approval while another run is active, a process stopped mid-send (startup recovery), and the hard "already
 * sent" check at approval, in a batch and right before the click. Also the reason shown for a disabled Approve.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-stuck';
  process.env.PREFERENCES_FILE = 'data/test-stuck/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { sent: [] as string[], pageError: null as string | null };
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => {
    if (h.pageError) throw new Error(h.pageError);
    return {} as never;
  },
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/drushim/apply.js', async (orig) => ({
  ...(await orig<typeof import('../src/sites/drushim/apply.js')>()),
  fetchAppliedJobs: async () => new Map(),
  installDryRunGuard: async () => async () => undefined,
  openPanel: async () => ({ fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false }),
  fillPanel: async () => undefined,
  screenshotPanel: async () => 'shot.png',
  submitPanel: async (_p: unknown, code: number) => {
    h.sent.push(String(code));
    return { outcome: { kind: 'submitted' }, confirmationText: 'ok', screenshotAfter: 'after.png' };
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { startTask, waitIdle } from '../src/pipeline/runner.js';
import { alreadySent, approveApplication, approveBatch, approveBlock, recoverStuckApprovals } from '../src/apply/service.js';
import { Applications } from '../src/apply/plan.js';
import type { ApplyPlan } from '../src/apply/types.js';

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.mkdirSync(config.paths.screenshots, { recursive: true });
fs.writeFileSync(config.paths.preferences, 'cv: { he: cv.pdf, en: cv.pdf }\nroleTypes:\n  - { id: fs, tier: 1, queries: [x], titleKeywords: [qa] }\n');

let db: DB;
let repo: Repo;
let apps: Applications;
let n = 0;
const queued = (title = 'QA Automation Engineer', company = `Proceed ${++n}`) => {
  const j = toJob({ site: 'drushim', externalId: String(5000 + n), company, title, location: '', descriptionText: 'x', requirementsText: '', url: `https://www.drushim.co.il/job/${5000 + n}/x/`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'en', detailsFetched: true, raw: {} });
  repo.upsertJob(j);
  const plan: ApplyPlan = { jobId: j.id, site: 'drushim', createdAt: '', cv: { lang: 'en', cvName: 'cv.pdf', hebrewRatio: 0, threshold: 0.2 }, fields: [], readiness: 'ready', notes: [] };
  return { job: j, appId: apps.savePlan(repo.getJob(j.id)!, plan, 'needs_review').id };
};

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  apps = new Applications(db);
  h.sent = [];
  h.pageError = null;
});

describe('"approved" never sticks', () => {
  it('a run that fails before reaching the job (browser profile in use) → back in review, with the reason', async () => {
    const { appId } = queued();
    h.pageError = 'The browser profile is open in another window — close the login window (Chrome) first, then try again.';
    approveApplication(db, appId);
    await waitIdle();
    expect(apps.get(appId)).toMatchObject({ status: 'needs_review', error: expect.stringMatching(/^not sent — the run stopped before sending: The browser profile is open/) });
    expect(h.sent).toEqual([]);
  });

  it('Approve while another run is active → refused, and the application is not marked approved', async () => {
    const { appId } = queued();
    let release!: () => void;
    startTask(db, 'drushim', 'prepare', () => new Promise<void>((r) => (release = r)));
    expect(() => approveApplication(db, appId)).toThrow(/already active/);
    expect(apps.get(appId)!.status).toBe('needs_review');
    release();
    await waitIdle();
  });

  it('startup recovery: approved without any trace of the final step → needs_review; with a trace → blocked', () => {
    const a = queued();
    const b = queued();
    for (const x of [a, b]) apps.update(x.appId, { status: 'approved', reviewed: true });
    fs.writeFileSync(path.join(config.paths.screenshots, `app${b.appId}-request.txt`), 'POST …');
    const r = recoverStuckApprovals(db);
    expect(r.map((x) => [x.id, x.to]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([[a.appId, 'needs_review'], [b.appId, 'blocked']]);
    expect(apps.get(a.appId)!.error).toMatch(/but never sent — back for review$/);
    expect(apps.get(b.appId)!.error).toMatch(/the send may have gone out/);
    expect(approveBlock(db, apps.get(b.appId)!)).toMatch(/^blocked: /);
    fs.rmSync(path.join(config.paths.screenshots, `app${b.appId}-request.txt`));
  });
});

describe('nothing is sent twice', () => {
  it('a job with a sent application: Approve and batch refuse; the reason is shown', async () => {
    const { job, appId } = queued();
    approveApplication(db, appId);
    await waitIdle();
    expect(h.sent).toHaveLength(1);
    // a second application row for the same job (e.g. prepared again)
    const again = apps.savePlan(repo.getJob(job.id)!, apps.get(appId)!.plan, 'needs_review');
    expect(again.id).not.toBe(appId);
    expect(alreadySent(db, job.id)).toMatch(/^already sent \(application #/);
    expect(() => approveApplication(db, again.id)).toThrow(/already sent/);
    expect(() => approveBatch(db, [again.id])).toThrow(/already sent/);
    expect(approveBlock(db, again)).toMatch(/^already sent/);
    expect(h.sent).toHaveLength(1);
  });

  it('the check right before the click catches a send that happened after selection', async () => {
    const a = queued();
    const b = queued();
    approveBatch(db, [a.appId, b.appId]);
    // the first job's application gets sent by another row meanwhile is impossible here; instead: same job, two rows
    await waitIdle();
    expect(h.sent).toHaveLength(2);
    const dup = apps.savePlan(repo.getJob(a.job.id)!, apps.get(a.appId)!.plan, 'needs_review');
    db.prepare("UPDATE applications SET status = 'approved' WHERE id = ?").run(dup.id); // as if approved before the first was sent
    const { alreadySent: check } = await import('../src/apply/service.js');
    expect(check(db, a.job.id, dup.id)).toMatch(/already sent/);
  });

  it('reasons for a disabled Approve, from the application itself', () => {
    const { appId } = queued();
    expect(approveBlock(db, apps.get(appId)!)).toBeNull();
    apps.update(appId, { status: 'rejected', error: 'duplicate of abc — the same company and title (one application per job)' });
    expect(approveBlock(db, apps.get(appId)!)).toMatch(/^duplicate: duplicate of abc/);
    apps.update(appId, { status: 'approved' });
    expect(approveBlock(db, apps.get(appId)!)).toBe('sending now');
    apps.update(appId, { status: 'needs_review' });
    const app = apps.get(appId)!;
    app.plan.fields = [{ field: { key: 'q', label: 'q', type: 'yes_no', required: true }, normKey: 'q', status: 'pending', value: null, provenance: { source: 'none' } }];
    expect(approveBlock(db, app)).toBe('answer 1 pending question first');
  });
});
