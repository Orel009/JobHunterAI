/**
 * Interprets Drushim's POST …/api/cv/sendsinglecv response. Shape and rules come from the site's own frontend code
 * (investigation, 2026-10-31):
 *   { Successful: [...], Failed: [{ JobCode, SentDate, ... }], IsError, Errors: { <key>: ... } }
 *   - a Failed entry for this job with a SentDate  → already applied
 *   - IsError, any Failed entry, or no Successful entry → error (first Errors key, else "send_cv_failed")
 *   - otherwise success
 */
export type SendCvOutcome =
  | { kind: 'submitted' }
  | { kind: 'already_applied'; sentDate: string }
  | { kind: 'error'; key: string; message: string; fatalForDay: boolean; needsLogin: boolean };

const MESSAGES: Record<string, string> = {
  UnauthenticatedUser: 'login expired',
  AuthorizationHeaderMissing: 'login expired',
  InvalidToken: 'login expired',
  TokenExpired: 'login expired',
  ExceededDailyCvSubmissionsLimit: "Drushim's daily submission limit reached",
  CVNotFound: 'CV not found on the account',
};
const AUTH = new Set(['UnauthenticatedUser', 'AuthorizationHeaderMissing', 'InvalidToken', 'TokenExpired']);

interface SendCvResponse {
  Successful?: Array<{ JobCode?: number }> | null;
  Failed?: Array<{ JobCode?: number; SentDate?: string | null }> | null;
  IsError?: boolean;
  Errors?: Record<string, unknown> | null;
}

export function parseSendCvResponse(body: unknown, jobCode: number): SendCvOutcome {
  const r = (body ?? {}) as SendCvResponse;
  const failed = r.Failed ?? [];
  const prior = failed.find((f) => f.JobCode === jobCode && !!f.SentDate);
  if (prior) return { kind: 'already_applied', sentDate: String(prior.SentDate) };
  if (r.IsError || failed.length > 0 || (r.Successful ?? []).length === 0) {
    const key = Object.keys(r.Errors ?? {})[0] ?? 'send_cv_failed';
    return { kind: 'error', key, message: MESSAGES[key] ?? key, fatalForDay: key === 'ExceededDailyCvSubmissionsLimit', needsLogin: AUTH.has(key) };
  }
  return { kind: 'submitted' };
}

/**
 * Jobs this account already applied to, from GET …/api/webapi/api/seeker/userdata/ — the site's own appliedJobIds is
 * Object.keys(UserProfile.JobHistory) (observed in its frontend code and response, 2026-10-31). job code → sent date.
 */
export function appliedJobsFromUserdata(body: unknown): Map<string, string | null> {
  const hist = (body as { UserProfile?: { JobHistory?: Record<string, { SentDate?: string | null } | null> } } | null)?.UserProfile?.JobHistory;
  if (!hist || typeof hist !== 'object') return new Map();
  return new Map(Object.entries(hist).map(([code, v]) => [String(code), v?.SentDate ?? null]));
}
