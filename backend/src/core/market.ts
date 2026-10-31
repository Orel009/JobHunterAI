/**
 * Posted-salary market stats from the jobs JobHunter has seen (monthly gross ILS only), per role type × required
 * years, over a time window. Each job counts once with the midpoint of its posted range. Nothing here changes a
 * setting: "suggestedFloor" is a proposal the user confirms.
 */
import { scoringRole } from './prefilter.js';
import type { Prefs } from './prefs.js';
import { salarySettings } from './salary.js';

export type YearsBucket = '0–1' | '2' | '3' | '4+' | 'not stated' | 'all';

export interface MarketJob {
  title: string;
  roleTypes: string[];
  requiredYears: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryUnit: string | null;
  firstSeenAt: string;
}

export interface MarketBucket {
  roleType: string;
  years: YearsBucket;
  count: number;
  p25: number;
  median: number;
  p75: number;
  min: number;
  max: number;
  /** the role type's floor, if set */
  floor: number | null;
  /** % of these jobs whose posted maximum is below the floor (null without a floor) */
  belowFloorPct: number | null;
  /** p25 rounded to 500 — a proposal only */
  suggestedFloor: number;
  /** fewer than 10 jobs: read with care */
  lowSample: boolean;
}

export interface MarketReport {
  days: number;
  jobsInWindow: number;
  withMonthlySalary: number;
  hourlyOnly: number;
  buckets: MarketBucket[];
}

export const yearsBucket = (y: number | null): YearsBucket => (y === null ? 'not stated' : y <= 1 ? '0–1' : y <= 2 ? '2' : y <= 3 ? '3' : '4+');

/** Linear-interpolated percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

const round100 = (n: number) => Math.round(n / 100) * 100;
const ORDER: YearsBucket[] = ['all', '0–1', '2', '3', '4+', 'not stated'];

export function marketStats(jobs: MarketJob[], prefs: Prefs, opts: { days: number; now?: Date }): MarketReport {
  const since = (opts.now ?? new Date()).getTime() - opts.days * 86_400_000;
  const inWindow = jobs.filter((j) => Date.parse(j.firstSeenAt) >= since);
  const monthly = inWindow.filter((j) => j.salaryUnit === 'month' && (j.salaryMin !== null || j.salaryMax !== null));
  const groups = new Map<string, { roleType: string; years: YearsBucket; values: number[]; maxes: number[] }>();
  for (const j of monthly) {
    const role = scoringRole(j, prefs);
    const roleType = role?.id ?? '(no role type)';
    const value = j.salaryMin !== null && j.salaryMax !== null ? (j.salaryMin + j.salaryMax) / 2 : (j.salaryMin ?? j.salaryMax)!;
    const top = j.salaryMax ?? j.salaryMin!;
    for (const years of ['all', yearsBucket(j.requiredYears)] as YearsBucket[]) {
      const key = `${roleType}|${years}`;
      const g = groups.get(key) ?? { roleType, years, values: [], maxes: [] };
      g.values.push(value);
      g.maxes.push(top);
      groups.set(key, g);
    }
  }
  const buckets = [...groups.values()].map((g): MarketBucket => {
    const v = [...g.values].sort((a, b) => a - b);
    const role = prefs.roleTypes.find((r) => r.id === g.roleType) ?? null;
    const floor = salarySettings(prefs, role).floor;
    const p25 = percentile(v, 0.25);
    return {
      roleType: g.roleType,
      years: g.years,
      count: v.length,
      p25: round100(p25),
      median: round100(percentile(v, 0.5)),
      p75: round100(percentile(v, 0.75)),
      min: v[0]!,
      max: v[v.length - 1]!,
      floor,
      belowFloorPct: floor === null ? null : Math.round((100 * g.maxes.filter((m) => m < floor).length) / g.maxes.length),
      suggestedFloor: Math.round(p25 / 500) * 500,
      lowSample: v.length < 10,
    };
  });
  buckets.sort((a, b) => a.roleType.localeCompare(b.roleType) || ORDER.indexOf(a.years) - ORDER.indexOf(b.years));
  return {
    days: opts.days,
    jobsInWindow: inWindow.length,
    withMonthlySalary: monthly.length,
    hourlyOnly: inWindow.filter((j) => j.salaryUnit === 'hour').length,
    buckets,
  };
}
