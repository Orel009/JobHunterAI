/**
 * rank = score + experienceBoost + tierBoost + salaryBoost (all weights in preferences.yaml → ranking).
 * Prefers junior roles: the experience category comes from the extracted required years first,
 * then a junior/entry-level signal in the text, then the scorer's seniority label.
 */
import type { Prefs } from './prefs.js';
import { primaryRole, rankTier } from './prefilter.js';
import { salarySettings } from './salary.js';

export type ExperienceCategory = 'junior' | 'years2' | 'years3' | 'above3' | 'unknown';

export interface RankInput {
  score: number | null;
  /** tier 3 ranks on min(score, devContentScore) */
  devContentScore?: number | null;
  /** the role type's devContentCap (empty = tier 3 only) */
  devContentCap?: boolean;
  requiredYears: number | null;
  juniorText: string | null;
  seniority?: string | null;
  tier: number | null;
  /** posted salary reaches the role type's floor → ranking.salaryBoost */
  salaryOk?: boolean;
}

export interface RankBreakdown {
  rank: number | null;
  /** the score used in the rank (for tier 3: min(score, devContentScore)) */
  score: number | null;
  rawScore: number | null;
  experience: number;
  tier: number;
  /** ranking.salaryBoost when the posted salary reaches the floor, else 0 */
  salary: number;
  category: ExperienceCategory;
}

export function experienceCategory(i: Pick<RankInput, 'requiredYears' | 'juniorText' | 'seniority'>): ExperienceCategory {
  if (i.requiredYears !== null) {
    if (i.requiredYears <= 1) return 'junior';
    if (i.requiredYears <= 2) return 'years2';
    if (i.requiredYears <= 3) return 'years3';
    return 'above3';
  }
  if (i.juniorText) return 'junior';
  if (i.seniority === 'junior') return 'junior';
  if (i.seniority === 'senior') return 'above3';
  return 'unknown';
}

export function rankJob(i: RankInput, ranking: Prefs['ranking']): RankBreakdown {
  const category = experienceCategory(i);
  const experience = ranking.experienceBoost[category];
  const tier = i.tier === 1 ? ranking.tierBoost.tier1 : i.tier === 2 ? ranking.tierBoost.tier2 : i.tier === 3 ? ranking.tierBoost.tier3 : 0;
  const cap = i.devContentCap ?? i.tier === 3;
  const base = i.score !== null && cap && i.devContentScore !== null && i.devContentScore !== undefined ? Math.min(i.score, i.devContentScore) : i.score;
  const salary = i.salaryOk ? ranking.salaryBoost : 0;
  return { rank: base === null ? null : base + experience + tier + salary, score: base, rawScore: i.score, experience, tier, salary, category };
}

/** Highest rank first; unscored jobs last (then newest first). */
export const byRank = <T extends { rank: RankBreakdown; firstSeenAt?: string }>(a: T, b: T): number => {
  if (a.rank.rank === null && b.rank.rank === null) return (b.firstSeenAt ?? '').localeCompare(a.firstSeenAt ?? '');
  if (a.rank.rank === null) return 1;
  if (b.rank.rank === null) return -1;
  return b.rank.rank - a.rank.rank;
};

/** Rank for a stored job + its score, with the role type it is ranked as. */
export function rankStoredJob(
  job: { title: string; roleTypes: string[]; requiredYears: number | null; juniorText: string | null; salaryMax?: number | null; salaryUnit?: string | null },
  score: { score: number; seniority?: string | null; devContentScore?: number | null } | null,
  prefs: Prefs,
): RankBreakdown & { roleType: string | null; roleTier: number | null } {
  const role = primaryRole(job, prefs);
  const tier = rankTier(role);
  const floor = salarySettings(prefs, role).floor;
  const salaryOk = floor !== null && job.salaryUnit === 'month' && job.salaryMax !== null && job.salaryMax !== undefined && job.salaryMax >= floor;
  const r = rankJob(
    { score: score?.score ?? null, devContentScore: score?.devContentScore ?? null, devContentCap: role?.devContentCap, requiredYears: job.requiredYears, juniorText: job.juniorText, seniority: score?.seniority ?? null, tier, salaryOk },
    prefs.ranking,
  );
  return { ...r, roleType: role?.id ?? null, roleTier: tier };
}
