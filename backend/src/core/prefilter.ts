import type { Job } from '../sites/types.js';
import { activeRoleTypes, type Prefs, type RoleType } from './prefs.js';
import { containsKeyword, normalizeCompany, normalizeText } from './text.js';
import { skillKey } from '../profile/facts.js';
import { belowFloor, describeSalary, fmtIls, salarySettings } from './salary.js';

export interface PrefilterResult {
  pass: boolean;
  reason: string;
  /** a more specific skip status than 'skipped' (e.g. skipped_salary) */
  status?: 'skipped_salary';
}

type PrefilterInput = Pick<Job, 'title' | 'company' | 'location'> & {
  regions?: string[];
  roleTypes?: string[];
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryUnit?: string | null;
};
type PrefilterPrefs = Pick<Prefs, 'locations' | 'filters'> & Partial<Pick<Prefs, 'roleTypes' | 'queries' | 'salary'>>;

/**
 * Expands keywords with every spelling of the same skill (profile aliases): "JavaScript" also matches
 * "ES6" / "JS", "OOP" also matches "Object-Oriented Programming". Non-skill keywords pass through unchanged.
 */
export function expandWithAliases(keywords: string[], aliasGroups: string[][]): string[] {
  if (aliasGroups.length === 0) return keywords;
  const out = new Set(keywords);
  for (const k of keywords) {
    const key = skillKey(k);
    const group = aliasGroups.find((g) => g.some((n) => skillKey(n) === key));
    if (group) for (const n of group) out.add(n);
  }
  return [...out];
}

/**
 * A disabled role type's titleKeywords act as title excludes ([keyword, role id] pairs), so e.g. support titles
 * are skipped even when another role type's query found them. Not used as excludes: keywords of search-only role
 * types (Junior never decides what a job is), and keywords an enabled role type or the include list also uses
 * (disabling "software" must not exclude every "developer").
 */
export function disabledRoleKeywords(roles: RoleType[], extraInclude: string[] = []): Array<[string, string]> {
  const keep = new Set([...roles.filter((r) => r.enabled).flatMap((r) => r.titleKeywords), ...extraInclude].map((k) => normalizeText(k)));
  return roles.filter((r) => !r.enabled && !r.searchOnly).flatMap((r) => r.titleKeywords.filter((k) => !keep.has(normalizeText(k))).map((k): [string, string] => [k, r.id]));
}

/** Deterministic gate before any LLM call. Order matters: the first failing rule is the reason. */
export function prefilter(job: PrefilterInput, prefs: PrefilterPrefs, opts: { aliasGroups?: string[][] } = {}): PrefilterResult {
  const title = normalizeText(job.title);
  const groups = opts.aliasGroups ?? [];
  const f = {
    ...prefs.filters,
    includeTitleKeywords: expandWithAliases(
      [...prefs.filters.includeTitleKeywords, ...activeRoleTypes({ roleTypes: prefs.roleTypes ?? [], queries: prefs.queries ?? { titles: [], keywords: [] } }).filter((r) => !r.searchOnly).flatMap((r) => r.titleKeywords)],
      groups,
    ),
    excludeTitleKeywords: expandWithAliases(prefs.filters.excludeTitleKeywords, groups),
  };

  const excludedCompany = f.excludeCompanies.find((c) => normalizeCompany(c) === normalizeCompany(job.company));
  if (excludedCompany) return { pass: false, reason: `excluded company: ${excludedCompany}` };

  const seniority = f.excludeSeniorityKeywords.find((k) => containsKeyword(title, k));
  if (seniority) return { pass: false, reason: `seniority: "${seniority}"` };

  const excluded = f.excludeTitleKeywords.find((k) => containsKeyword(title, k));
  if (excluded) return { pass: false, reason: `excluded title keyword: "${excluded}"` };

  const disabled = disabledRoleKeywords(prefs.roleTypes ?? [], prefs.filters.includeTitleKeywords).find(([k]) => containsKeyword(title, k));
  if (disabled) return { pass: false, reason: `role type disabled: ${disabled[1]}` };

  if (f.includeTitleKeywords.length > 0 && !f.includeTitleKeywords.some((k) => containsKeyword(title, k))) {
    return { pass: false, reason: 'no include keyword in title' };
  }

  const places = [job.location, ...(job.regions ?? [])].map((p) => p.trim()).filter(Boolean);
  if (prefs.locations.length > 0 && places.length > 0) {
    // city OR the site's region field; both directions so "השרון" matches "שרון" and "תל אביב" matches "תל אביב יפו"
    const matches = (place: string) => {
      const n = normalizeText(place);
      return prefs.locations.some((l) => containsKeyword(n, l) || containsKeyword(normalizeText(l), place)) || f.remoteKeywords.some((k) => containsKeyword(n, k));
    };
    if (!places.some(matches)) return { pass: false, reason: `location: ${job.location}${job.regions?.length ? ` (regions: ${job.regions.join(', ')})` : ''}` };
  }

  // posted monthly salary below the role type's floor (known range only; an empty floor = no salary filtering)
  if (prefs.salary && job.salaryUnit === 'month' && job.salaryMax !== null && job.salaryMax !== undefined) {
    const role = scoringRole({ title: job.title, roleTypes: job.roleTypes ?? [] }, { roleTypes: prefs.roleTypes ?? [], queries: prefs.queries ?? { titles: [], keywords: [] } });
    const st = salarySettings({ salary: prefs.salary }, role);
    const posted = { min: job.salaryMin ?? null, max: job.salaryMax, unit: 'month' as const };
    if (belowFloor(posted, st.floor)) {
      return { pass: false, status: 'skipped_salary', reason: `salary: posted ${describeSalary(posted)} < floor ${fmtIls(st.floor!)} ₪ (${role ? `role ${role.id}, ` : ''}${st.from.floor})` };
    }
  }

  return { pass: true, reason: 'ok' };
}

/** Enabled role types whose titleKeywords match the title (whole words). */
export function rolesMatchingTitle(title: string, roles: RoleType[]): RoleType[] {
  const t = normalizeText(title);
  return roles.filter((r) => r.enabled && r.titleKeywords.some((k) => containsKeyword(t, k)));
}

/**
 * The role type a job is judged and ranked as: the best tier among non-search-only role types whose title
 * keywords match the title. Search-only role types (e.g. "junior") never decide the role or tier.
 * No match → no role type, and the job is ranked as tier 3.
 */
export function primaryRole(job: { title: string; roleTypes: string[] }, prefs: Pick<Prefs, 'roleTypes' | 'queries'>): RoleType | null {
  const roles = activeRoleTypes(prefs).filter((r) => !r.searchOnly);
  return [...rolesMatchingTitle(job.title, roles)].sort((a, b) => a.tier - b.tier)[0] ?? null;
}

/** Tier used for ranking: the primary role's tier, or 3 when no role type matches the title. */
export const rankTier = (role: RoleType | null): 1 | 2 | 3 => role?.tier ?? 3;

/** Role context for the scorer: the primary role, else the best non-search-only role type whose query found it. */
export function scoringRole(job: { title: string; roleTypes: string[] }, prefs: Pick<Prefs, 'roleTypes' | 'queries'>): RoleType | null {
  const p = primaryRole(job, prefs);
  if (p) return p;
  return [...activeRoleTypes(prefs).filter((r) => !r.searchOnly && job.roleTypes.includes(r.id))].sort((a, b) => a.tier - b.tier)[0] ?? null;
}
