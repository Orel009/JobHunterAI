export type JobStatus =
  | 'discovered'
  | 'scored'
  | 'queued'
  | 'needs_review'
  | 'ready'
  | 'dry_run_ok'
  | 'submitted'
  | 'submitted_manual'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'skipped_experience'
  | 'skipped_screening'
  | 'skipped_not_a_job'
  | 'skipped_salary'
  | 'skipped_company';

export const STATUSES: JobStatus[] = ['discovered', 'scored', 'queued', 'needs_review', 'dry_run_ok', 'submitted', 'submitted_manual', 'failed', 'blocked', 'skipped', 'skipped_experience', 'skipped_screening', 'skipped_not_a_job', 'skipped_salary', 'skipped_company'];

export interface Rank {
  rank: number | null;
  score: number | null;
  rawScore: number | null;
  experience: number;
  tier: number;
  salary: number;
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
  /** posted salary: monthly gross ₪ unless salaryUnit = 'hour' */
  salaryMin: number | null;
  salaryMax: number | null;
  salaryUnit: 'month' | 'hour' | null;
  salarySource: 'drushim_field' | 'description' | 'drushim_bucket' | null;
  salaryText: string | null;
  rank: Rank;
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
/** "10K–13K ₪", "~10K–13K ₪" (search bucket), "45 ₪/hour", or "not posted" */
export function salaryLabel(j: Pick<JobItem, 'salaryMin' | 'salaryMax' | 'salaryUnit' | 'salarySource'>): string {
  if (!j.salaryUnit || (j.salaryMin === null && j.salaryMax === null)) return 'not posted';
  const r =
    j.salaryMin !== null && j.salaryMax !== null && j.salaryMin !== j.salaryMax
      ? `${k(j.salaryMin)}–${k(j.salaryMax)}`
      : j.salaryMin !== null && j.salaryMax === null
        ? `${k(j.salaryMin)}+`
        : j.salaryMin === null
          ? `up to ${k(j.salaryMax!)}`
          : k(j.salaryMin);
  return `${j.salarySource === 'drushim_bucket' ? '~' : ''}${r} ₪${j.salaryUnit === 'hour' ? '/hour' : ''}`;
}
export const SALARY_SOURCE: Record<string, string> = { drushim_field: "site's salary field", description: 'from the post text', drushim_bucket: 'search salary bucket (approximate)' };

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
  llm: {
    analyze: { provider: string; model: string };
    write: { provider: string; model: string };
    ollama: { ok: boolean; missing: string[] } | null;
    cloud: boolean;
    tokensToday: number;
    tokenLimit: number;
  };
  sites: Array<{ id: string; displayName: string; enabled: boolean }>;
  /** optional LinkedIn job alerts (email): the LinkedIn screen and filter exist only while enabled */
  linkedin: { enabled: boolean };
  sessions: Record<string, { state: 'logged_in' | 'logged_out' | 'unknown'; checkedAt: string | null; detail: string }>;
  pendingQuestions: number;
  /** passed the prefilter, no current score (e.g. discovered before the profile was approved) */
  waitingForScore: number;
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

// ---------- LLM settings ----------
export interface TaskCfg {
  provider: string;
  model: string;
}
export interface LlmSettings {
  analyze: TaskCfg;
  write: TaskCfg;
  /** masked ("sk-a…wxyz") or null; the full key is never sent to the browser */
  keys: Record<string, string | null>;
  dailyTokenLimit: number;
  prices: Record<string, { input: number; output: number }>;
  providers: Array<{ id: string; label: string; local: boolean; needsKey: boolean }>;
}
export interface UsageRow {
  day: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  cost: number | null;
}
export interface UsageReport {
  rows: UsageRow[];
  today: { tokens: number; apiTokens: number; cost: number | null };
  limit: number;
}
export const llm = {
  settings: () => req<LlmSettings>('GET', '/api/llm/settings'),
  save: (b: Partial<{ analyze: TaskCfg; write: TaskCfg; keys: Record<string, string | null>; dailyTokenLimit: number; prices: LlmSettings['prices'] }>) =>
    req<LlmSettings>('PUT', '/api/llm/settings', b),
  models: (provider: string) => req<{ models: string[]; error?: string }>('GET', `/api/llm/models?provider=${encodeURIComponent(provider)}`),
  test: (provider: string, model: string) => req<{ ok: boolean; ms: number; error?: string }>('POST', '/api/llm/test', { provider, model }),
  usage: () => req<UsageReport>('GET', '/api/llm/usage'),
};

// ---------- LinkedIn job alerts (optional) + assisted apply ----------
export interface LinkedInSettings {
  enabled: boolean;
  windowDays: number;
  mailbox: string;
  imap: { host: string; port: number; user: string; password: string | null };
  configured: boolean;
}
export interface HelperItem {
  label: string;
  value: string;
  source: string;
}
export interface ApplyHelper {
  cv: { lang: 'he' | 'en'; reason: string; file: string | null; exists: boolean };
  contact: HelperItem[];
  answers: HelperItem[];
  declared: { totalDevYears: number; basis: string } | null;
  skillYears: HelperItem[];
  salary: HelperItem[];
  incompleteInfo: boolean;
}
export const linkedin = {
  settings: () => req<LinkedInSettings>('GET', '/api/linkedin/settings'),
  save: (b: Partial<{ enabled: boolean; windowDays: number; mailbox: string; host: string; port: number; user: string; password: string | null }>) =>
    req<LinkedInSettings>('PUT', '/api/linkedin/settings', b),
  test: () => req<{ ok: boolean; mailbox: string; alerts: number; windowDays: number }>('POST', '/api/linkedin/test', {}),
  fetch: () => req<{ runId: number }>('POST', '/api/linkedin/fetch', {}),
  helper: (id: string) => req<ApplyHelper>('GET', `/api/linkedin/jobs/${id}/helper`),
  open: (id: string) => req('POST', `/api/linkedin/jobs/${id}/open`, {}),
  showCv: (id: string) => req('POST', `/api/linkedin/jobs/${id}/show-cv`, {}),
  applied: (id: string) => req<{ appliedAt: string }>('POST', `/api/linkedin/jobs/${id}/applied`, {}),
  skip: (id: string) => req('POST', `/api/linkedin/jobs/${id}/skip`, {}),
  description: (id: string, text: string) => req<{ note: string }>('POST', `/api/linkedin/jobs/${id}/description`, { text }),
  external: (id: string, url: string) => req<{ kind: 'site' | 'manual'; note: string }>('POST', `/api/linkedin/jobs/${id}/external`, { url }),
};

// ---------- salary market ----------
export interface MarketBucket {
  roleType: string;
  years: 'all' | '0–1' | '2' | '3' | '4+' | 'not stated';
  count: number;
  p25: number;
  median: number;
  p75: number;
  min: number;
  max: number;
  floor: number | null;
  belowFloorPct: number | null;
  suggestedFloor: number;
  lowSample: boolean;
}
export interface MarketReport {
  days: number;
  jobsInWindow: number;
  withMonthlySalary: number;
  hourlyOnly: number;
  buckets: MarketBucket[];
}
export const market = (days: 30 | 60 | 90) => req<MarketReport>('GET', `/api/market?days=${days}`);
