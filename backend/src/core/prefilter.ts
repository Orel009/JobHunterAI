import type { Job } from '../sites/types.js';
import { activeRoleTypes, type Prefs, type RoleType } from './prefs.js';
import { containsKeyword, normalizeCompany, normalizeText } from './text.js';
import { skillKey } from '../profile/facts.js';

export interface PrefilterResult {
  pass: boolean;
  reason: string;
}

type PrefilterInput = Pick<Job, 'title' | 'company' | 'location'>;
type PrefilterPrefs = Pick<Prefs, 'locations' | 'filters'> & Partial<Pick<Prefs, 'roleTypes' | 'queries'>>;

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

/** Deterministic gate before any LLM call. Order matters: the first failing rule is the reason. */
export function prefilter(job: PrefilterInput, prefs: PrefilterPrefs, opts: { aliasGroups?: string[][] } = {}): PrefilterResult {
  const title = normalizeText(job.title);
  const groups = opts.aliasGroups ?? [];
  const f = {
    ...prefs.filters,
    includeTitleKeywords: expandWithAliases(
      [...prefs.filters.includeTitleKeywords, ...activeRoleTypes({ roleTypes: prefs.roleTypes ?? [], queries: prefs.queries ?? { titles: [], keywords: [] } }).flatMap((r) => r.titleKeywords)],
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

  if (f.includeTitleKeywords.length > 0 && !f.includeTitleKeywords.some((k) => containsKeyword(title, k))) {
    return { pass: false, reason: 'no include keyword in title' };
  }

  if (prefs.locations.length > 0 && job.location.trim()) {
    const loc = normalizeText(job.location);
    const ok =
      prefs.locations.some((l) => {
        const n = normalizeText(l);
        return !!n && (containsKeyword(loc, l) || containsKeyword(n, job.location));
      }) || f.remoteKeywords.some((k) => containsKeyword(loc, k));
    if (!ok) return { pass: false, reason: `location: ${job.location}` };
  }

  return { pass: true, reason: 'ok' };
}

/** Enabled role types whose titleKeywords match the title (whole words). */
export function rolesMatchingTitle(title: string, roles: RoleType[]): RoleType[] {
  const t = normalizeText(title);
  return roles.filter((r) => r.enabled && r.titleKeywords.some((k) => containsKeyword(t, k)));
}

/**
 * The role type a job is judged and ranked as (best tier wins at each step):
 *   1. role types that found it AND whose title keywords match the title
 *   2. else role types whose title keywords match
 *   3. else role types whose queries found it
 */
export function primaryRole(job: { title: string; roleTypes: string[] }, prefs: Pick<Prefs, 'roleTypes' | 'queries'>): RoleType | null {
  const roles = activeRoleTypes(prefs);
  const byTier = (rs: RoleType[]) => [...rs].sort((a, b) => a.tier - b.tier)[0] ?? null;
  const titled = rolesMatchingTitle(job.title, roles);
  return byTier(titled.filter((r) => job.roleTypes.includes(r.id))) ?? byTier(titled) ?? byTier(roles.filter((r) => job.roleTypes.includes(r.id)));
}
