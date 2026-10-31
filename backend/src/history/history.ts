/**
 * History: every application actually sent — submitted by JobHunter, or marked "I applied" (LinkedIn) — with the
 * evidence, and your own outcome tracking (status changes with dates, notes). Stats and CSV for your records.
 */
import fs from 'node:fs';
import { config } from '../config.js';
import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { Repo } from '../db/repo.js';
import type { Prefs } from '../core/prefs.js';
import { scoringRole } from '../core/prefilter.js';
import { rankStoredJob } from '../core/rank.js';

export const OUTCOMES = ['no_response', 'screening_call', 'interview', 'home_assignment', 'offer', 'rejected', 'withdrawn'] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** the employer answered (any way) */
export const RESPONDED: Outcome[] = ['screening_call', 'interview', 'home_assignment', 'offer', 'rejected'];

export interface OutcomeEvent {
  id: number;
  outcome: Outcome;
  changedOn: string;
  note: string | null;
}

export interface HistoryEntry {
  jobId: string;
  applicationId: number | null;
  kind: 'submitted' | 'submitted_manual';
  appliedAt: string;
  site: string;
  company: string;
  title: string;
  url: string;
  roleType: string | null;
  cv: { lang: 'he' | 'en'; cvName: string } | null;
  score: number | null;
  rank: number | null;
  evidence: { before: string | null; after: string | null; plan: string | null; response: string | null; confirmation: string | null };
  /** auto-submit: which gate conditions passed (null = approved by hand) */
  autoGate: unknown;
  outcome: Outcome;
  outcomeOn: string | null;
  outcomes: OutcomeEvent[];
  notes: string;
}

export interface HistoryFilter {
  site?: string;
  outcome?: Outcome;
  /** YYYY-MM-DD, inclusive, on the application date */
  from?: string;
  to?: string;
}

function evidenceFiles(appId: number): { plan: string | null; response: string | null } {
  let files: string[] = [];
  try {
    files = fs.readdirSync(config.paths.screenshots);
  } catch {
    /* no screenshots yet */
  }
  const plan = files.filter((f) => f.startsWith(`app${appId}-plan-`) && f.endsWith('.json')).sort().pop() ?? null;
  const response = files.includes(`app${appId}-response.json`) ? `app${appId}-response.json` : null;
  return { plan, response };
}

export function historyEntries(db: DB, prefs: Prefs, f: HistoryFilter = {}): HistoryEntry[] {
  const repo = new Repo(db);
  const rows = db
    .prepare(
      `SELECT j.id AS job_id, j.status AS job_status, j.applied_manually_at, j.updated_at,
              a.id AS app_id, a.submitted_at, a.plan_json, a.screenshot_before, a.screenshot_after, a.confirmation_text, a.gate_json
       FROM jobs j
       LEFT JOIN applications a ON a.id = (SELECT id FROM applications x WHERE x.job_id = j.id AND x.status = 'submitted' AND x.dry_run = 0 ORDER BY x.submitted_at DESC LIMIT 1)
       WHERE a.id IS NOT NULL OR j.status = 'submitted_manual'`,
    )
    .all() as Array<Record<string, string | number | null>>;
  const outcomesFor = db.prepare('SELECT id, outcome, changed_on, note FROM application_outcomes WHERE job_id = ? ORDER BY changed_on, id');
  const notesFor = db.prepare('SELECT notes FROM application_notes WHERE job_id = ?');

  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const job = repo.getJob(String(r.job_id));
    if (!job) continue;
    const appId = r.app_id === null ? null : Number(r.app_id);
    const plan = r.plan_json ? (JSON.parse(String(r.plan_json)) as { cv?: { lang: 'he' | 'en'; cvName: string } | null }) : null;
    const score = repo.getScore(job.id);
    const outcomes = (outcomesFor.all(job.id) as Array<{ id: number; outcome: Outcome; changed_on: string; note: string | null }>).map((o) => ({ id: o.id, outcome: o.outcome, changedOn: o.changed_on, note: o.note }));
    const last = outcomes[outcomes.length - 1];
    const files = appId !== null ? evidenceFiles(appId) : { plan: null, response: null };
    out.push({
      jobId: job.id,
      applicationId: appId,
      kind: appId !== null ? 'submitted' : 'submitted_manual',
      appliedAt: String(r.submitted_at ?? r.applied_manually_at ?? r.updated_at),
      site: job.site,
      company: job.company,
      title: job.title,
      url: job.url,
      roleType: score?.roleType ?? scoringRole(job, prefs)?.id ?? null,
      cv: plan?.cv ? { lang: plan.cv.lang, cvName: plan.cv.cvName } : null,
      score: score?.score ?? null,
      rank: rankStoredJob(job, score, prefs).rank,
      evidence: { before: (r.screenshot_before as string | null) ?? null, after: (r.screenshot_after as string | null) ?? null, ...files, confirmation: (r.confirmation_text as string | null) ?? null },
      autoGate: r.gate_json ? (JSON.parse(String(r.gate_json)) as { auto?: boolean }).auto ? JSON.parse(String(r.gate_json)) : null : null,
      outcome: last?.outcome ?? 'no_response',
      outcomeOn: last?.changedOn ?? null,
      outcomes,
      notes: (notesFor.get(job.id) as { notes: string } | undefined)?.notes ?? '',
    });
  }
  const day = (iso: string) => iso.slice(0, 10);
  return out
    .filter((e) => (!f.site || e.site === f.site) && (!f.outcome || e.outcome === f.outcome) && (!f.from || day(e.appliedAt) >= f.from) && (!f.to || day(e.appliedAt) <= f.to))
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function addOutcome(db: DB, jobId: string, outcome: Outcome, changedOn = nowIso().slice(0, 10), note: string | null = null): OutcomeEvent {
  if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new Error(`unknown outcome ${outcome}`);
  if (!isDay(changedOn)) throw new Error('date must be YYYY-MM-DD');
  if (!new Repo(db).getJob(jobId)) throw new Error('no such job');
  const r = db.prepare('INSERT INTO application_outcomes (job_id, outcome, changed_on, note, created_at) VALUES (?, ?, ?, ?, ?)').run(jobId, outcome, changedOn, note?.trim() || null, nowIso());
  return { id: Number(r.lastInsertRowid), outcome, changedOn, note: note?.trim() || null };
}

export const deleteOutcome = (db: DB, id: number): boolean => Number(db.prepare('DELETE FROM application_outcomes WHERE id = ?').run(id).changes) > 0;

export function setNotes(db: DB, jobId: string, notes: string): void {
  db.prepare('INSERT INTO application_notes (job_id, notes, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at').run(jobId, notes, nowIso());
}

// ---------- CSV ----------
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function historyCsv(entries: HistoryEntry[]): string {
  const head = ['applied_at', 'site', 'company', 'title', 'url', 'role_type', 'cv', 'rank', 'score', 'how', 'outcome', 'outcome_on', 'outcome_history', 'notes'];
  const lines = entries.map((e) =>
    [
      e.appliedAt.slice(0, 10),
      e.site,
      e.company,
      e.title,
      e.url,
      e.roleType,
      e.cv?.cvName,
      e.rank,
      e.score,
      e.kind === 'submitted_manual' ? 'by hand' : e.autoGate ? 'auto-submitted' : 'approved',
      e.outcome,
      e.outcomeOn,
      e.outcomes.map((o) => `${o.changedOn} ${o.outcome}${o.note ? ` (${o.note})` : ''}`).join('; '),
      e.notes,
    ]
      .map(csvCell)
      .join(','),
  );
  // BOM so Excel opens the Hebrew correctly
  return `﻿${[head.join(','), ...lines].join('\r\n')}\r\n`;
}

// ---------- stats ----------
/** Sunday of the week of an ISO date (YYYY-MM-DD), the Israeli work week. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

export interface RateRow {
  key: string;
  applications: number;
  responded: number;
  /** % (rounded) */
  rate: number;
}

export function historyStats(entries: HistoryEntry[], weeks = 12, now = new Date()) {
  const thisWeek = weekStart(now.toISOString());
  const perWeek: Array<{ week: string; applications: number }> = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(`${thisWeek}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    const week = d.toISOString().slice(0, 10);
    perWeek.push({ week, applications: entries.filter((e) => weekStart(e.appliedAt) === week).length });
  }
  const responded = (e: HistoryEntry) => e.outcomes.some((o) => RESPONDED.includes(o.outcome));
  const rate = (key: (e: HistoryEntry) => string): RateRow[] => {
    const m = new Map<string, HistoryEntry[]>();
    for (const e of entries) m.set(key(e), [...(m.get(key(e)) ?? []), e]);
    return [...m.entries()]
      .map(([k, list]) => {
        const n = list.filter(responded).length;
        return { key: k, applications: list.length, responded: n, rate: Math.round((100 * n) / list.length) };
      })
      .sort((a, b) => b.applications - a.applications || a.key.localeCompare(b.key));
  };
  return {
    total: entries.length,
    responded: entries.filter(responded).length,
    perWeek,
    byRoleType: rate((e) => e.roleType ?? '(no role type)'),
    bySite: rate((e) => e.site),
  };
}
