/**
 * Per-session page-load budget for sites that need a light touch (JobKarov: Preferences jobkarov.maxPageLoads,
 * default 10). A session is one Run & send, or one task on its own (a Discover run, a batch approval, a resume check).
 * Every page JobHunter loads on that site counts, including its own requests (the city list, the apply preview).
 * Discovery leaves room for applying (APPLY_RESERVE loads); when the budget is spent, the rest waits for the next session.
 * The same session counts CAPTCHAs answered at send, per site (the second one pauses the site: apply/service.ts).
 */
import { loadPrefs } from './prefs.js';

/** loads kept free for preparing / sending (2 per job: the job page and the apply preview) */
export const APPLY_RESERVE = 4;

const used = new Map<string, number>();
const sendCaptchas = new Map<string, number>();
let owner: 'hunt' | 'task' | null = null;

/** Starts a budget session (a hunt owns it for all its tasks; a task alone gets its own). */
export function beginBudgetSession(o: 'hunt' | 'task'): boolean {
  if (owner === 'hunt' && o === 'task') return false;
  owner = o;
  used.clear();
  sendCaptchas.clear();
  return true;
}
export function endBudgetSession(o: 'hunt' | 'task'): void {
  if (owner === o) owner = null;
}

export function maxPageLoads(site: string): number {
  if (site === 'jobkarov') return loadPrefs().jobkarov.maxPageLoads;
  return Infinity;
}
export const loadsUsed = (site: string) => used.get(site) ?? 0;
export const loadsLeft = (site: string) => maxPageLoads(site) - loadsUsed(site);

export class BudgetError extends Error {
  constructor(public site: string) {
    super(`${site}: the page-load budget for this session (${maxPageLoads(site)}) is spent — the rest waits for the next session`);
    this.name = 'BudgetError';
  }
}

/** Counts a load; throws BudgetError (nothing loaded) when it would go over the budget. */
export function useLoad(site: string, n = 1): void {
  if (loadsUsed(site) + n > maxPageLoads(site)) throw new BudgetError(site);
  used.set(site, loadsUsed(site) + n);
}

/** One more CAPTCHA answered at send on this site in this session; returns how many so far. */
export function noteSendCaptcha(site: string): number {
  const n = (sendCaptchas.get(site) ?? 0) + 1;
  sendCaptchas.set(site, n);
  return n;
}

export const budgetSummary = () => Object.fromEntries([...used].map(([site, n]) => [site, { used: n, max: maxPageLoads(site) }]));
