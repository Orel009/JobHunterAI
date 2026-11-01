/**
 * The application form of a Greenhouse job, answered ahead for the assisted panel: the questions are read once
 * (?questions=true, when you open the job) and kept on the job; each is answered from your profile, the answers bank,
 * your years per skill / declared experience and your salary settings — never drafted by the model. Unanswered ones are
 * shown as pending (and added to the answers bank, so you answer them once). Files (CV, cover letter) you attach.
 */
import type { DB } from '../db/index.js';
import { Repo, type StoredJob } from '../db/repo.js';
import { loadPrefs } from '../core/prefs.js';
import { buildPlan } from '../apply/plan.js';
import type { FormField } from '../apply/types.js';
import { ghQuestionFields, ghQuestionsUrl, type GhQuestion } from './greenhouse.js';

export interface FormAnswer {
  label: string;
  required: boolean;
  type: FormField['type'];
  options?: string[];
  /** resolved = ready to copy; pending = answer it in the answers bank (or on the form yourself) */
  status: 'resolved' | 'pending' | 'empty_optional';
  value: string | null;
  source: string;
}
export interface FormAnswers {
  ats: 'greenhouse';
  readAt: string | null;
  answers: FormAnswer[];
  error: string | null;
}

type GhRaw = { ats?: string; board?: string; jobId?: number | string; questions?: GhQuestion[]; questionsReadAt?: string };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Reads the questions once per job (kept on the job afterwards). */
export async function greenhouseQuestions(repo: Repo, job: StoredJob, fetchImpl: typeof fetch = fetch): Promise<{ questions: GhQuestion[]; readAt: string } | { error: string }> {
  const raw = (job.raw ?? {}) as GhRaw;
  if (raw.questions && raw.questionsReadAt) return { questions: raw.questions, readAt: raw.questionsReadAt };
  if (!raw.board || raw.jobId === undefined) return { error: 'no Greenhouse board / job id on this job' };
  const r = await fetchImpl(ghQuestionsUrl(raw.board, raw.jobId), { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (r.status === 404) return { error: 'the job is no longer on Greenhouse (HTTP 404)' };
  if (!r.ok) return { error: `Greenhouse answered HTTP ${r.status}` };
  const questions = (((await r.json()) as { questions?: GhQuestion[] }).questions ?? []).map((q) => ({
    label: q.label,
    required: !!q.required,
    description: q.description ?? null,
    fields: (q.fields ?? []).map((f) => ({ name: f.name, type: f.type, values: (f.values ?? []).map((v) => ({ label: v.label, value: v.value })) })),
  }));
  const readAt = new Date().toISOString();
  repo.setRaw(job.id, { ...raw, questions, questionsReadAt: readAt });
  return { questions, readAt };
}

const SOURCE: Record<string, string> = {
  profile: 'profile',
  bank: 'answers bank',
  skill_years: 'years per skill (work roles)',
  declared_experience: 'declared experience',
  salary: 'salary settings',
};

/** The form's answers, ready to copy (null for jobs without a known form). */
export async function formAnswers(db: DB, job: StoredJob, fetchImpl: typeof fetch = fetch): Promise<FormAnswers | null> {
  if (job.site !== 'greenhouse') return null;
  const repo = new Repo(db);
  const q = await greenhouseQuestions(repo, job, fetchImpl).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  if ('error' in q) return { ats: 'greenhouse', readAt: null, answers: [], error: q.error };
  const fields = ghQuestionFields(q.questions);
  // profile / bank / years / salary only: the drafter is switched off (never invented, never written by the model)
  const plan = await buildPlan(job, fields, {
    db,
    repo,
    prefs: loadPrefs(),
    deps: { draft: async () => ({ text: null, usedFactIds: [], unanswerable: true, flaggedClaims: [], rejectedReason: 'not drafted for the assisted panel' }) },
  });
  return {
    ats: 'greenhouse',
    readAt: q.readAt,
    error: null,
    answers: plan.fields.map((f) => ({
      label: f.field.label,
      required: f.field.required,
      type: f.field.type,
      options: f.field.options,
      status: f.status === 'resolved' ? 'resolved' : f.status === 'empty_optional' ? 'empty_optional' : 'pending',
      value: f.status === 'resolved' ? f.value : null,
      source: f.status === 'resolved' ? `${SOURCE[f.provenance.source] ?? f.provenance.source}${f.provenance.detail ? ` — ${f.provenance.detail}` : ''}` : (f.reason ?? 'needs your answer'),
    })),
  };
}
