export type JobStatus =
  | 'discovered'
  | 'scored'
  | 'queued'
  | 'needs_review'
  | 'ready'
  | 'dry_run_ok'
  | 'submitted'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'skipped_experience'
  | 'skipped_screening';

export const STATUSES: JobStatus[] = ['discovered', 'scored', 'queued', 'needs_review', 'dry_run_ok', 'submitted', 'failed', 'blocked', 'skipped', 'skipped_experience', 'skipped_screening'];

export interface Rank {
  rank: number | null;
  score: number | null;
  experience: number;
  tier: number;
  category: 'junior' | 'years2' | 'years3' | 'above3' | 'unknown';
  roleType: string | null;
  roleTier: number | null;
}

export interface Score {
  score: number;
  matchedSkills: string[];
  missingRequirements: string[];
  seniorityFit: string;
  reasoningHe: string;
  model: string;
  requiredYearsMin?: number | null;
  requiredYearsQuote?: string | null;
  seniority?: string | null;
  roleType?: string | null;
}

export interface JobItem {
  id: string;
  site: string;
  externalId: string;
  company: string;
  title: string;
  location: string;
  descriptionText: string;
  requirementsText: string;
  url: string;
  postedAt: string | null;
  applyType: string;
  applyTarget: string;
  language: 'he' | 'en';
  detailsFetched: boolean;
  status: JobStatus;
  statusReason: string | null;
  prefilterPass: boolean | null;
  prefilterReason: string | null;
  duplicateOf: string | null;
  firstSeenAt: string;
  score: Score | null;
  roleTypes: string[];
  requiredYears: number | null;
  requiredYearsSource: 'regex' | 'llm' | null;
  requiredYearsText: string | null;
  juniorText: string | null;
  rank: Rank;
}

export interface RunInfo {
  id: number;
  site: string;
  kind: string;
  startedAt: string;
  stage: string;
  stats: Record<string, number>;
}

export interface Status {
  dryRun: boolean;
  activeRun: RunInfo | null;
  today: { submitted: number };
  limits: { dailyApplyLimit: number; autoSubmitMinScore: number; maxPagesPerRun: number };
  counts: Record<string, number>;
  models: { analyze: string; write: string };
  ollama: { ok: boolean; models: string[]; analyzeAvailable: boolean };
  sites: Array<{ id: string; displayName: string; enabled: boolean }>;
  sessions: Record<string, { state: 'logged_in' | 'logged_out' | 'unknown'; checkedAt: string | null; detail: string }>;
  pendingQuestions: number;
  roleTypes: Array<{ id: string; label: string; tier: number; enabled: boolean }>;
  maxRequiredYears: number;
}

export interface RunRow {
  id: number;
  site: string;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  reason: string | null;
  stats: Record<string, number>;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

export const api = {
  status: () => req<Status>('GET', '/api/status'),
  jobs: (q: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return req<{ total: number; items: JobItem[] }>('GET', `/api/jobs?${p}`);
  },
  skip: (id: string) => req('POST', `/api/jobs/${id}/skip`),
  unskip: (id: string) => req('POST', `/api/jobs/${id}/unskip`),
  apply: (id: string) => req<{ note: string }>('POST', `/api/jobs/${id}/apply`),
  startRun: (site: string, kind: 'discover' | 'score' | 'full') => req<{ id: number }>('POST', '/api/runs', { site, kind }),
  stopRun: () => req('POST', '/api/runs/stop'),
  runs: () => req<RunRow[]>('GET', '/api/runs'),
  checkSession: () => req<{ runId: number }>('POST', '/api/session/check'),
};

// ---------- Phase 2 ----------
export type FieldType = 'text' | 'textarea' | 'yes_no' | 'choice' | 'number' | 'consent';
export interface ResolvedField {
  field: { key: string; label: string; type: FieldType; required: boolean; options?: string[] };
  normKey: string;
  status: 'resolved' | 'draft' | 'pending' | 'empty_optional';
  value: string | null;
  provenance: { source: 'profile' | 'bank' | 'skill_years' | 'declared_experience' | 'draft' | 'user' | 'none'; ref?: string; confidence?: number; detail?: string; usedFactIds?: string[]; flaggedClaims?: string[] };
  reason?: string;
  category?: string | null;
}
export interface Plan {
  jobId: string;
  cv: { lang: 'he' | 'en'; cvName: string; hebrewRatio: number; threshold: number; overridden?: boolean } | null;
  fields: ResolvedField[];
  readiness: 'ready' | 'needs_answers' | 'has_drafts' | 'blocked_no';
  notes: string[];
}
export interface Application {
  id: number;
  jobId: string;
  status: string;
  dryRun: boolean;
  plan: Plan;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  confirmationText: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  job: JobItem | null;
  score: Score | null;
  rank: Rank;
}
export interface BankEntry {
  id: number;
  question: string;
  answer: string | null;
  type: 'text' | 'yes_no' | 'choice' | 'number';
  options: string[] | null;
  language: 'he' | 'en';
  status: 'active' | 'pending';
  usageCount: number;
  source: string;
  blocks: number;
}

export const apply = {
  list: (status?: string) => req<Application[]>('GET', `/api/applications${status ? `?status=${status}` : ''}`),
  editField: (id: number, key: string, value: string, saveToBank: boolean) =>
    req<Application>('PATCH', `/api/applications/${id}/fields/${encodeURIComponent(key)}`, { value, saveToBank }),
  setCv: (id: number, lang: 'he' | 'en') => req<Application>('PUT', `/api/applications/${id}/cv`, { lang }),
  approve: (id: number) => req<{ runId: number; dryRun: boolean }>('POST', `/api/applications/${id}/approve`),
  reject: (id: number, reason?: string) => req('POST', `/api/applications/${id}/reject`, { reason }),
  prepareQueued: () => req<{ note?: string; count?: number }>('POST', '/api/applications/prepare', {}),
  screenshotUrl: (file: string) => `/api/screenshots/${encodeURIComponent(file)}`,
};

export const answers = {
  list: () => req<BankEntry[]>('GET', '/api/answers'),
  create: (e: { question: string; answer: string | null; type: BankEntry['type'] }) => req<BankEntry>('POST', '/api/answers', e),
  update: (id: number, e: Partial<{ question: string; answer: string | null; type: BankEntry['type'] }>) => req<BankEntry>('PATCH', `/api/answers/${id}`, e),
  remove: (id: number) => req('DELETE', `/api/answers/${id}`),
  seed: () => req<{ seeded: number }>('POST', '/api/answers/seed', {}),
};

export const profileStatus = () =>
  req<{ exists: boolean; valid: boolean; draftExists: boolean; facts?: number; error?: string }>('GET', '/api/profile/status');
