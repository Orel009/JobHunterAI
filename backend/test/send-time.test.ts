/**
 * A send time is set once and never changes: an application's submitted_at and a job's "I applied" time
 * (applied_manually_at). Later updates (a second "submitted" update, outcome changes, notes, status changes, the dedupe
 * passes, a direct UPDATE such as a migration's) keep it; the rest of such an UPDATE still applies. History shows it in
 * Israel time, filters by the day in Israel, and sorts by the time itself.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { Applications } from '../src/apply/plan.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { addOutcome, historyCsv, historyEntries, israelDateTime, israelDay, setNotes } from '../src/history/history.js';
import { markAppliedByHand } from '../src/extension/fill.js';
import type { ApplyPlan } from '../src/apply/types.js';

const prefs = PrefsSchema.parse({ roleTypes: [{ id: 'fullstack', tier: 1, queries: ['x'], titleKeywords: ['full stack'] }] });
const raw = (site: 'drushim' | 'linkedin', id: string, title: string) => ({
  site, externalId: id, company: `Co ${id}`, title, location: '', descriptionText: '', requirementsText: '', url: `https://example.test/${id}`,
  postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {},
});

function setup() {
  const db = openDb(':memory:');
  const repo = new Repo(db);
  const apps = new Applications(db);
  const sent = (id: string, title: string, at: string) => {
    repo.upsertJob(toJob(raw('drushim', id, title)));
    const job = repo.getJob(jobId('drushim', id))!;
    const plan: ApplyPlan = { jobId: job.id, site: 'drushim', createdAt: at, cv: null, fields: [], readiness: 'ready', notes: [] };
    const app = apps.savePlan(job, plan, 'needs_review');
    apps.update(app.id, { status: 'submitted' });
    db.prepare('UPDATE applications SET submitted_at = ? WHERE id = ?').run(at, app.id); // set once (from empty)
    repo.setStatus(job.id, 'submitted', 'submitted');
    return { job, app: apps.get(app.id)! };
  };
  const submittedAt = (id: number) => (db.prepare('SELECT submitted_at FROM applications WHERE id = ?').get(id) as { submitted_at: string }).submitted_at;
  return { db, repo, apps, sent, submittedAt };
}

describe('a send time never changes once set', () => {
  it('the triggers are there (a table rebuild must create them again)', () => {
    const { db } = setup();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['applications_submitted_at_immutable', 'jobs_applied_manually_at_immutable']));
  });

  it('submitted_at: a second "submitted" update, outcomes, notes, status changes, dedupe, a direct UPDATE: all keep it', () => {
    const { db, repo, apps, sent, submittedAt } = setup();
    const { job, app } = sent('1', 'Full Stack Developer', '2026-11-01T07:21:16.415Z');
    apps.update(app.id, { status: 'submitted', submitted: true, confirmationText: 'again' });
    addOutcome(db, job.id, 'interview', '2026-11-03', 'call');
    setNotes(db, job.id, 'notes');
    repo.setStatus(job.id, 'skipped', 'skipped manually');
    repo.dedupeExisting(14);
    // a migration / backfill that sets every row: the send time stays; the rest of the UPDATE applies
    db.prepare("UPDATE applications SET submitted_at = '2026-11-04T00:00:00.000Z', error = 'touched'").run();
    expect(submittedAt(app.id)).toBe('2026-11-01T07:21:16.415Z');
    expect(apps.get(app.id)).toMatchObject({ error: 'touched', confirmationText: 'again' });
    db.prepare('UPDATE applications SET submitted_at = NULL WHERE id = ?').run(app.id);
    expect(submittedAt(app.id)).toBe('2026-11-01T07:21:16.415Z');
  });

  it('a send time not set yet is set by the first "submitted" update only', () => {
    const { db, repo, apps } = setup();
    repo.upsertJob(toJob(raw('drushim', '5', 'Backend')));
    const job = repo.getJob(jobId('drushim', '5'))!;
    const app = apps.savePlan(job, { jobId: job.id, site: 'drushim', createdAt: '', cv: null, fields: [], readiness: 'ready', notes: [] }, 'approved');
    expect(apps.get(app.id)!.submittedAt).toBeNull();
    apps.update(app.id, { status: 'submitted', submitted: true });
    const first = apps.get(app.id)!.submittedAt!;
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    apps.update(app.id, { status: 'submitted', submitted: true });
    expect(apps.get(app.id)!.submittedAt).toBe(first);
    void db;
  });

  it('"I applied" (applied_manually_at): a second "I applied" and a direct UPDATE keep the first time', () => {
    const { db, repo } = setup();
    repo.upsertJob(toJob(raw('linkedin', '9', 'Full Stack Engineer')));
    const id = jobId('linkedin', '9');
    const first = markAppliedByHand(db, repo.getJob(id)!);
    expect(markAppliedByHand(db, repo.getJob(id)!)).toMatchObject({ already: true });
    db.prepare("UPDATE jobs SET applied_manually_at = '2026-12-01T00:00:00.000Z', status = 'submitted_manual' WHERE id = ?").run(id);
    expect((db.prepare('SELECT applied_manually_at FROM jobs WHERE id = ?').get(id) as { applied_manually_at: string }).applied_manually_at).toBe(first.appliedAt);
  });
});

describe('History in Israel time', () => {
  it('the day and time in Israel (winter UTC+2, summer UTC+3)', () => {
    expect(israelDateTime('2026-11-01T07:21:16.415Z')).toBe('2026-11-01 09:21');
    expect(israelDateTime('2026-07-01T07:21:00.000Z')).toBe('2026-07-01 10:21');
    expect(israelDay('2026-10-31T22:30:00.000Z')).toBe('2026-11-01'); // after midnight in Israel
  });

  it('newest first by the time itself; the date filters use the day in Israel; the CSV has the Israel time and UTC', () => {
    const { db, sent } = setup();
    sent('1', 'Full Stack A', '2026-11-01T07:21:16.415Z');
    sent('2', 'Full Stack B', '2026-11-01T13:54:15.235Z');
    sent('3', 'Full Stack C', '2026-10-31T22:30:00.000Z'); // 00:30 on Nov 1 in Israel
    sent('4', 'Full Stack D', '2026-10-31T17:04:06.482Z');
    const h = historyEntries(db, prefs);
    expect(h.map((e) => e.title)).toEqual(['Full Stack B', 'Full Stack A', 'Full Stack C', 'Full Stack D']);
    expect(historyEntries(db, prefs, { from: '2026-11-01', to: '2026-11-01' }).map((e) => e.title)).toEqual(['Full Stack B', 'Full Stack A', 'Full Stack C']);
    const csv = historyCsv(h).replace(/^﻿/, '').split('\r\n');
    expect(csv[0]!.startsWith('applied_at_israel,applied_at_utc,site')).toBe(true);
    expect(csv[1]!.startsWith('2026-11-01 15:54,2026-11-01T13:54:15.235Z,drushim')).toBe(true);
  });
});
