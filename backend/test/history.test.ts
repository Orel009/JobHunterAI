import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { Applications } from '../src/apply/plan.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { addOutcome, historyCsv, historyEntries, historyStats, setNotes, weekStart } from '../src/history/history.js';
import { buildApp } from '../src/server/app.js';
import type { ApplyPlan } from '../src/apply/types.js';

const prefs = PrefsSchema.parse({ roleTypes: [{ id: 'fullstack', tier: 1, queries: ['x'], titleKeywords: ['full stack'] }, { id: 'ai-innovation', tier: 2, queries: ['x'], titleKeywords: ['חדשנות'] }] });
const raw = (site: 'drushim' | 'linkedin', id: string, title: string, company: string) => ({
  site, externalId: id, company, title, location: '', descriptionText: '', requirementsText: '', url: `https://example.test/${id}`,
  postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {},
});

function seed() {
  const db = openDb(':memory:');
  const repo = new Repo(db);
  const apps = new Applications(db);
  const submit = (id: string, title: string, company: string, at: string) => {
    repo.upsertJob(toJob(raw('drushim', id, title, company)));
    const job = repo.getJob(jobId('drushim', id))!;
    const plan: ApplyPlan = { jobId: job.id, site: 'drushim', createdAt: at, cv: { lang: 'he', cvName: 'קורות חיים - דוגמה.pdf', hebrewRatio: 1, threshold: 0.2 }, fields: [], readiness: 'ready', notes: [] };
    const app = apps.savePlan(job, plan, 'needs_review');
    apps.update(app.id, { status: 'submitted', submitted: true, screenshotBefore: `app${app.id}-before.png`, confirmationText: 'עבודה טובה!' });
    db.prepare('UPDATE applications SET submitted_at = ? WHERE id = ?').run(at, app.id);
    repo.setStatus(job.id, 'submitted', 'submitted');
    return job.id;
  };
  const a = submit('1', 'Full Stack Developer', 'Acme, Ltd "Israel"', '2026-10-20T09:00:00.000Z');
  const b = submit('2', 'מוביל/ת חדשנות ו-AI', 'Oron', '2026-10-31T17:04:06.000Z');
  // a dry run and a job only prepared never show up
  repo.upsertJob(toJob(raw('drushim', '3', 'Backend Developer', 'Globex')));
  repo.upsertJob(toJob(raw('linkedin', '9', 'Full Stack Engineer', 'Initech')));
  const c = jobId('linkedin', '9');
  db.prepare("UPDATE jobs SET status = 'submitted_manual', applied_manually_at = '2026-10-29T10:00:00.000Z' WHERE id = ?").run(c);
  return { db, a, b, c };
}

describe('History', () => {
  it('lists real submissions and "I applied" jobs (newest first) with CV, rank, evidence', () => {
    const { db } = seed();
    const h = historyEntries(db, prefs);
    expect(h.map((e) => [e.title, e.kind, e.appliedAt.slice(0, 10)])).toEqual([
      ['מוביל/ת חדשנות ו-AI', 'submitted', '2026-10-31'],
      ['Full Stack Engineer', 'submitted_manual', '2026-10-29'],
      ['Full Stack Developer', 'submitted', '2026-10-20'],
    ]);
    expect(h[0]).toMatchObject({ site: 'drushim', roleType: 'ai-innovation', cv: { cvName: 'קורות חיים - דוגמה.pdf' }, evidence: { before: expect.stringMatching(/^app\d+-before\.png$/), confirmation: 'עבודה טובה!' }, outcome: 'no_response', autoGate: null });
    expect(h[1]!.applicationId).toBeNull();
  });

  it('outcome changes with dates, notes, and filters by site / outcome / date', () => {
    const { db, a, b } = seed();
    addOutcome(db, a, 'screening_call', '2026-10-22');
    addOutcome(db, a, 'interview', '2026-10-27', 'מול ראש הצוות');
    addOutcome(db, b, 'rejected', '2026-11-02');
    setNotes(db, a, 'שאלו על React');
    const h = historyEntries(db, prefs);
    expect(h.find((e) => e.jobId === a)).toMatchObject({ outcome: 'interview', outcomeOn: '2026-10-27', notes: 'שאלו על React', outcomes: [{ outcome: 'screening_call' }, { outcome: 'interview', note: 'מול ראש הצוות' }] });
    expect(historyEntries(db, prefs, { outcome: 'interview' }).map((e) => e.jobId)).toEqual([a]);
    expect(historyEntries(db, prefs, { site: 'linkedin' })).toHaveLength(1);
    expect(historyEntries(db, prefs, { from: '2026-10-25', to: '2026-10-30' }).map((e) => e.site)).toEqual(['linkedin']);
    expect(() => addOutcome(db, a, 'hired' as never)).toThrow(/unknown outcome/);
    expect(() => addOutcome(db, a, 'offer', '31/10/2026')).toThrow(/YYYY-MM-DD/);
  });

  it('CSV: one row per application, quoted when needed, BOM for Excel', () => {
    const { db, a } = seed();
    addOutcome(db, a, 'interview', '2026-10-27');
    const csv = historyCsv(historyEntries(db, prefs));
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe('applied_at,site,company,title,url,role_type,cv,rank,score,how,outcome,outcome_on,outcome_history,notes');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('"Acme, Ltd ""Israel"""');
    expect(lines[3]).toContain('2026-10-27 interview');
    expect(lines[2]).toContain('by hand');
  });

  it('stats: applications per week (weeks start on Sunday), response rate by role type and site', () => {
    const { db, a, b } = seed();
    addOutcome(db, a, 'screening_call', '2026-10-22');
    addOutcome(db, b, 'no_response', '2026-11-10');
    expect(weekStart('2026-10-31T17:04:06.000Z')).toBe('2026-10-25'); // a Saturday → that week's Sunday
    const s = historyStats(historyEntries(db, prefs), 3, new Date('2026-11-01T12:00:00Z'));
    expect(s.perWeek).toEqual([
      { week: '2026-10-18', applications: 1 },
      { week: '2026-10-25', applications: 2 },
      { week: '2026-11-01', applications: 0 },
    ]);
    expect(s).toMatchObject({ total: 3, responded: 1 });
    expect(s.bySite).toEqual([
      { key: 'drushim', applications: 2, responded: 1, rate: 50 },
      { key: 'linkedin', applications: 1, responded: 0, rate: 0 },
    ]);
    expect(s.byRoleType.find((r) => r.key === 'fullstack')).toEqual({ key: 'fullstack', applications: 2, responded: 1, rate: 50 });
  });

  it('API: outcome, notes, CSV download', async () => {
    const { db, a } = seed();
    const app = buildApp(db);
    expect((await app.inject({ method: 'POST', url: `/api/history/${a}/outcome`, payload: { outcome: 'offer', date: '2026-11-05' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/history/${a}/outcome`, payload: { outcome: 'offer', date: 'yesterday' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/history/${a}/notes`, payload: { notes: 'x' } })).statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/history?outcome=offer' })).json();
    expect(list.map((e: { jobId: string }) => e.jobId)).toEqual([a]);
    const csv = await app.inject({ method: 'GET', url: '/api/history.csv' });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="jobhunter-history-/);
  });
});
