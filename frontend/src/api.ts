export type JobStatus =
  | 'discovered'
  | 'scored'
  | 'queued'
  | 'needs_review'
  | 'ready'
  | 'submitted'
  | 'failed'
  | 'blocked'
  | 'skipped';

export const STATUSES: JobStatus[] = ['discovered', 'scored', 'queued', 'needs_review', 'ready', 'submitted', 'failed', 'blocked', 'skipped'];

export interface Score {
  score: number;
  matchedSkills: string[];
  missingRequirements: string[];
  seniorityFit: string;
  reasoningHe: string;
  model: string;
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
};
