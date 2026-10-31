import type { DB } from './index.js';
import { nowIso, tx } from './index.js';
import type { Job, JobStatus } from '../sites/types.js';
import { mergeJob } from '../core/job.js';
import type { DedupeCandidate } from '../core/dedupe.js';

interface JobRow {
  id: string;
  site: string;
  external_id: string;
  company: string;
  company_norm: string;
  title: string;
  title_norm: string;
  location: string;
  description_text: string;
  requirements_text: string;
  url: string;
  posted_at: string | null;
  apply_type: Job['applyType'];
  apply_target: string;
  language: 'he' | 'en';
  details_fetched: number;
  raw_json: string;
  content_hash: string;
  status: JobStatus;
  status_reason: string | null;
  prefilter_pass: number | null;
  prefilter_reason: string | null;
  duplicate_of: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  role_types: string;
  required_years: number | null;
  required_years_source: string | null;
  required_years_text: string | null;
  junior_text: string | null;
}

export interface StoredJob extends Job {
  status: JobStatus;
  statusReason: string | null;
  prefilterPass: boolean | null;
  prefilterReason: string | null;
  duplicateOf: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  /** role type ids whose queries found this job */
  roleTypes: string[];
  requiredYears: number | null;
  requiredYearsSource: 'regex' | 'llm' | null;
  requiredYearsText: string | null;
  juniorText: string | null;
}

export interface ScoreRecord {
  devContentScore?: number | null;
  isTrainingProgram?: boolean | null;
  requiredYearsMin?: number | null;
  requiredYearsQuote?: string | null;
  seniority?: string | null;
  roleType?: string | null;
  score: number;
  matchedSkills: string[];
  missingRequirements: string[];
  seniorityFit: string;
  reasoningHe: string;
  model: string;
  contentHash: string;
  createdAt: string;
}

const fromRow = (r: JobRow): StoredJob => ({
  id: r.id,
  site: r.site as Job['site'],
  externalId: r.external_id,
  company: r.company,
  companyNorm: r.company_norm,
  title: r.title,
  titleNorm: r.title_norm,
  location: r.location,
  descriptionText: r.description_text,
  requirementsText: r.requirements_text,
  url: r.url,
  postedAt: r.posted_at,
  applyType: r.apply_type,
  applyTarget: r.apply_target,
  language: r.language,
  detailsFetched: !!r.details_fetched,
  raw: JSON.parse(r.raw_json) as unknown,
  contentHash: r.content_hash,
  status: r.status,
  statusReason: r.status_reason,
  prefilterPass: r.prefilter_pass === null ? null : !!r.prefilter_pass,
  prefilterReason: r.prefilter_reason,
  duplicateOf: r.duplicate_of,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  updatedAt: r.updated_at,
  roleTypes: JSON.parse(r.role_types ?? '[]') as string[],
  requiredYears: r.required_years ?? null,
  requiredYearsSource: (r.required_years_source as 'regex' | 'llm' | null) ?? null,
  requiredYearsText: r.required_years_text ?? null,
  juniorText: r.junior_text ?? null,
});

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

export class Repo {
  constructor(private db: DB) {}

  getJob(id: string): StoredJob | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return r ? fromRow(r) : null;
  }

  /** Insert or update by (site, external_id). Never duplicates; keeps richer details from earlier fetches. */
  upsertJob(incoming: Job, now = nowIso()): { outcome: UpsertOutcome; job: StoredJob } {
    return tx(this.db, () => {
      const existing = this.getJob(incoming.id);
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO jobs (id, site, external_id, company, company_norm, title, title_norm, location, description_text,
               requirements_text, url, posted_at, apply_type, apply_target, language, details_fetched, raw_json, content_hash,
               status, first_seen_at, last_seen_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'discovered',?,?,?)`,
          )
          .run(
            incoming.id, incoming.site, incoming.externalId, incoming.company, incoming.companyNorm, incoming.title,
            incoming.titleNorm, incoming.location, incoming.descriptionText, incoming.requirementsText, incoming.url,
            incoming.postedAt, incoming.applyType, incoming.applyTarget, incoming.language, incoming.detailsFetched ? 1 : 0,
            JSON.stringify(incoming.raw ?? {}), incoming.contentHash, now, now, now,
          );
        return { outcome: 'inserted' as const, job: this.getJob(incoming.id)! };
      }
      const m = mergeJob(existing, incoming);
      const changed = m.contentHash !== existing.contentHash || m.applyType !== existing.applyType || m.detailsFetched !== existing.detailsFetched;
      this.db
        .prepare(
          `UPDATE jobs SET company=?, company_norm=?, title=?, title_norm=?, location=?, description_text=?, requirements_text=?,
             url=?, posted_at=COALESCE(?, posted_at), apply_type=?, apply_target=?, language=?, details_fetched=?, raw_json=?,
             content_hash=?, last_seen_at=?, updated_at=CASE WHEN ? THEN ? ELSE updated_at END,
             prefilter_pass=CASE WHEN ? THEN NULL ELSE prefilter_pass END
           WHERE id=?`,
        )
        .run(
          m.company, m.companyNorm, m.title, m.titleNorm, m.location, m.descriptionText, m.requirementsText, m.url, m.postedAt,
          m.applyType, m.applyTarget, m.language, m.detailsFetched ? 1 : 0, JSON.stringify(m.raw ?? {}), m.contentHash, now,
          changed ? 1 : 0, now, m.title !== existing.title || m.location !== existing.location ? 1 : 0, existing.id,
        );
      return { outcome: changed ? ('updated' as const) : ('unchanged' as const), job: this.getJob(existing.id)! };
    });
  }

  dedupeCandidates(companyNorm: string, titleNorm: string, excludeSite: string): DedupeCandidate[] {
    return (
      this.db
        .prepare(
          `SELECT id, site, company_norm AS companyNorm, title_norm AS titleNorm, first_seen_at AS firstSeenAt
           FROM jobs WHERE company_norm = ? AND title_norm = ? AND site != ? AND duplicate_of IS NULL`,
        )
        .all(companyNorm, titleNorm, excludeSite) as unknown as DedupeCandidate[]
    );
  }

  markDuplicate(id: string, of: string): void {
    this.db
      .prepare(`UPDATE jobs SET duplicate_of=?, status='skipped', status_reason=?, updated_at=? WHERE id=?`)
      .run(of, `duplicate of ${of}`, nowIso(), id);
  }

  setStatus(id: string, status: JobStatus, reason: string | null = null): void {
    this.db.prepare('UPDATE jobs SET status=?, status_reason=?, updated_at=? WHERE id=?').run(status, reason, nowIso(), id);
  }

  setPrefilter(id: string, pass: boolean, reason: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET prefilter_pass=?, prefilter_reason=?,
           status=CASE WHEN ? = 0 AND status='discovered' THEN 'skipped' ELSE status END,
           status_reason=CASE WHEN ? = 0 AND status='discovered' THEN ? ELSE status_reason END,
           updated_at=? WHERE id=?`,
      )
      .run(pass ? 1 : 0, reason, pass ? 1 : 0, pass ? 1 : 0, `prefilter: ${reason}`, nowIso(), id);
  }

  /** Jobs of a site that have not been through the prefilter yet. */
  jobsNeedingPrefilter(site?: string): StoredJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE prefilter_pass IS NULL AND status = 'discovered' AND (? IS NULL OR site = ?)`)
      .all(site ?? null, site ?? null) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  jobsNeedingDetails(site: string): StoredJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE site = ? AND prefilter_pass = 1 AND details_fetched = 0 AND status = 'discovered' ORDER BY first_seen_at`)
      .all(site) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  /** Passing jobs without a score for their current content. */
  jobsNeedingScore(site?: string): StoredJob[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j LEFT JOIN scores s ON s.job_id = j.id
         WHERE j.prefilter_pass = 1 AND j.status IN ('discovered','scored')
           AND (s.job_id IS NULL OR s.content_hash != j.content_hash)
           AND (? IS NULL OR j.site = ?)
         ORDER BY j.first_seen_at`,
      )
      .all(site ?? null, site ?? null) as unknown as JobRow[];
    return rows.map(fromRow);
  }

  saveScore(jobId: string, s: Omit<ScoreRecord, 'createdAt'>): void {
    const now = nowIso();
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO scores (job_id, content_hash, model, score, matched_skills, missing_requirements, seniority_fit, reasoning_he, created_at,
             required_years_min, required_years_quote, seniority, role_type, dev_content_score, is_training_program)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(job_id) DO UPDATE SET content_hash=excluded.content_hash, model=excluded.model, score=excluded.score,
             matched_skills=excluded.matched_skills, missing_requirements=excluded.missing_requirements,
             seniority_fit=excluded.seniority_fit, reasoning_he=excluded.reasoning_he, created_at=excluded.created_at,
             required_years_min=excluded.required_years_min, required_years_quote=excluded.required_years_quote,
             seniority=excluded.seniority, role_type=excluded.role_type, dev_content_score=excluded.dev_content_score,
             is_training_program=excluded.is_training_program`,
        )
        .run(jobId, s.contentHash, s.model, s.score, JSON.stringify(s.matchedSkills), JSON.stringify(s.missingRequirements), s.seniorityFit, s.reasoningHe, now,
          s.requiredYearsMin ?? null, s.requiredYearsQuote ?? null, s.seniority ?? null, s.roleType ?? null, s.devContentScore ?? null,
          s.isTrainingProgram === undefined || s.isTrainingProgram === null ? null : s.isTrainingProgram ? 1 : 0);
      this.db.prepare(`UPDATE jobs SET status='scored', status_reason=NULL, updated_at=? WHERE id=? AND status='discovered'`).run(now, jobId);
    });
  }

  listJobs(f: { site?: string; status?: string; minScore?: number; q?: string; roleType?: string; limit?: number; offset?: number }) {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.site) (where.push('j.site = ?'), args.push(f.site));
    if (f.status) (where.push('j.status = ?'), args.push(f.status));
    if (f.minScore !== undefined) (where.push('s.score >= ?'), args.push(f.minScore));
    if (f.q) (where.push('(j.title LIKE ? OR j.company LIKE ?)'), args.push(`%${f.q}%`, `%${f.q}%`));
    if (f.roleType) (where.push('j.role_types LIKE ?'), args.push(`%"${f.roleType}"%`));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT j.*, s.score, s.matched_skills, s.missing_requirements, s.seniority_fit, s.reasoning_he, s.model AS score_model,
                s.required_years_min, s.required_years_quote, s.seniority, s.role_type, s.dev_content_score, s.is_training_program
         FROM jobs j LEFT JOIN scores s ON s.job_id = j.id ${w}
         ORDER BY (s.score IS NULL), s.score DESC, j.first_seen_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, f.limit ?? 200, f.offset ?? 0) as unknown as Array<JobRow & Record<string, unknown>>;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs j LEFT JOIN scores s ON s.job_id = j.id ${w}`).get(...args) as { n: number }).n;
    return {
      total,
      items: rows.map((r) => ({
        ...fromRow(r),
        raw: undefined,
        score:
          r.score === null || r.score === undefined
            ? null
            : {
                score: r.score as number,
                matchedSkills: JSON.parse(r.matched_skills as string) as string[],
                missingRequirements: JSON.parse(r.missing_requirements as string) as string[],
                seniorityFit: r.seniority_fit as string,
                reasoningHe: r.reasoning_he as string,
                model: r.score_model as string,
                requiredYearsMin: (r.required_years_min as number | null) ?? null,
                requiredYearsQuote: (r.required_years_quote as string | null) ?? null,
                seniority: (r.seniority as string | null) ?? null,
                roleType: (r.role_type as string | null) ?? null,
                devContentScore: (r.dev_content_score as number | null) ?? null,
                isTrainingProgram: r.is_training_program === null || r.is_training_program === undefined ? null : !!r.is_training_program,
              },
      })),
    };
  }

  getScore(jobId: string): Omit<ScoreRecord, 'contentHash' | 'createdAt'> | null {
    const r = this.db.prepare('SELECT * FROM scores WHERE job_id = ?').get(jobId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      score: r.score as number,
      matchedSkills: JSON.parse(r.matched_skills as string) as string[],
      missingRequirements: JSON.parse(r.missing_requirements as string) as string[],
      seniorityFit: r.seniority_fit as string,
      reasoningHe: r.reasoning_he as string,
      model: r.model as string,
      requiredYearsMin: (r.required_years_min as number | null) ?? null,
      requiredYearsQuote: (r.required_years_quote as string | null) ?? null,
      seniority: (r.seniority as string | null) ?? null,
      roleType: (r.role_type as string | null) ?? null,
      devContentScore: (r.dev_content_score as number | null) ?? null,
      isTrainingProgram: r.is_training_program === null || r.is_training_program === undefined ? null : !!r.is_training_program,
    };
  }

  /** Drops scores of active (scored) jobs so the next score run re-evaluates them; returns how many. */
  invalidateScores(): number {
    return tx(this.db, () => {
      this.db.prepare("DELETE FROM scores WHERE job_id IN (SELECT id FROM jobs WHERE status = 'scored')").run();
      return Number(this.db.prepare("UPDATE jobs SET status = 'discovered', status_reason = 'profile changed — re-scoring' WHERE status = 'scored'").run().changes);
    });
  }

  /** Records which role types found a job (union with existing tags). */
  addRoleTypes(id: string, roleIds: string[]): void {
    const cur = this.getJob(id);
    if (!cur) return;
    const next = [...new Set([...cur.roleTypes, ...roleIds])];
    if (next.length !== cur.roleTypes.length) this.db.prepare('UPDATE jobs SET role_types = ? WHERE id = ?').run(JSON.stringify(next), id);
  }

  setExperience(id: string, e: { years: number | null; source: 'regex' | 'llm' | null; text: string | null; juniorText: string | null }): void {
    this.db
      .prepare('UPDATE jobs SET required_years = ?, required_years_source = ?, required_years_text = ?, junior_text = ? WHERE id = ?')
      .run(e.years, e.source, e.text, e.juniorText, id);
  }

  statusCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  submittedToday(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM applications WHERE status='submitted' AND dry_run=0 AND submitted_at >= ?`)
        .get(start.toISOString()) as { n: number }
    ).n;
  }

  // ---- runs ----
  startRun(site: string, kind: string): number {
    const r = this.db.prepare(`INSERT INTO runs (site, kind, status, started_at) VALUES (?, ?, 'running', ?)`).run(site, kind, nowIso());
    return Number(r.lastInsertRowid);
  }

  finishRun(id: number, status: 'done' | 'failed' | 'blocked' | 'stopped', stats: object, reason?: string): void {
    this.db
      .prepare('UPDATE runs SET status=?, finished_at=?, stats_json=?, reason=? WHERE id=?')
      .run(status, nowIso(), JSON.stringify(stats), reason ?? null, id);
  }

  listRuns(limit = 20) {
    return (this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      stats: JSON.parse(r.stats_json as string) as unknown,
      stats_json: undefined,
    }));
  }

  /** Runs left 'running' by a crashed process. */
  failOrphanRuns(): void {
    this.db.prepare(`UPDATE runs SET status='failed', finished_at=?, reason='process exited' WHERE status='running'`).run(nowIso());
  }

  // ---- LLM cache ----
  cacheGet(key: string): string | null {
    const r = this.db.prepare('SELECT response FROM llm_cache WHERE key = ?').get(key) as { response: string } | undefined;
    return r?.response ?? null;
  }

  cachePut(key: string, model: string, response: string): void {
    this.db.prepare('INSERT OR REPLACE INTO llm_cache (key, model, response, created_at) VALUES (?,?,?,?)').run(key, model, response, nowIso());
  }
}
