import type { Job } from '../sites/types.js';
import { activeRoleTypes, type Prefs, type RoleType } from './prefs.js';
import { containsKeyword, normalizeCompany, normalizeText } from './text.js';
import { skillKey } from '../profile/facts.js';
import { belowFloor, describeSalary, fmtIls, salarySettings } from './salary.js';

export interface PrefilterResult {
  pass: boolean;
  reason: string;
  /** a more specific skip status than 'skipped' */
  status?: 'skipped_salary' | 'skipped_company';
}

type PrefilterInput = Pick<Job, 'title' | 'company' | 'location'> & {
  /** read for role type excludes (title OR description) */
  descriptionText?: string;
  requirementsText?: string;
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
  return roles.filter((r) => !r.enabled && !r.searchOnly && r.excludeTitlesWhenDisabled !== false).flatMap((r) => r.titleKeywords.filter((k) => !keep.has(normalizeText(k))).map((k): [string, string] => [k, r.id]));
}

/**
 * excludeCompanies entries match the company name as whole words, case-insensitive, after normalizing
 * ("matrix" matches "Matrix R&D Services", "matrix (בנקאות)", "צפון matrix"). List Hebrew and English names separately.
 */
export function excludedCompanyMatch(company: string, excludes: string[]): string | null {
  const c = normalizeCompany(company);
  if (!c) return null;
  return excludes.find((e) => {
    const n = normalizeCompany(e);
    return !!n && (c === n || containsKeyword(c, n));
  }) ?? null;
}

// "מוביל/ה", "מוביל/ת", "מוביל.ת", "מובילה", "מוביל" — as a word of its own
const LEAD = /(?<![א-ת])(מוביל\s*[/.\\(]\s*[הת]\)?|מובילה|מוביל)(?![א-ת])/g;
/** words that make "מוביל/ת X" a role: team / innovation / technology / development / domain / product lead */
const LEAD_DOMAIN = /^\s*[בהלו]?(חדשנות|צוות|טכנולוג|פיתוח|תחום|פרויקט|מוצר|מערך|תהליכ|הנדס|מחלק|תשתיות|אבטחת)/;
const TITLE_START = /^[\s\-–|:!*"'(]*(?:דרוש[^\s]*\s+|דרושים[^\s]*\s+)?$/;
const AFTER_SEPARATOR = /[-–|,:(]\s*$/;

/**
 * "מוביל/ת" as the role noun (a lead position) — never "מוביל" as an adjective ("לארגון מוביל", "חברה מובילה").
 * A role when it opens the title ("מוביל/ת צוות תוכנה", "מובילה טכנולוגית"), or when a domain word follows it and it
 * is the gendered slash form (companies never get one: "מהנדס/ת FAE מוביל/ה בתחום") or comes right after a separator.
 */
export function leadRoleNoun(title: string): string | null {
  for (const m of title.matchAll(LEAD)) {
    const before = title.slice(0, m.index);
    const after = title.slice(m.index! + m[0].length);
    if (TITLE_START.test(before)) return m[0];
    const slashed = /[/.\\(]/.test(m[0]);
    if (LEAD_DOMAIN.test(after) && (slashed || AFTER_SEPARATOR.test(before))) return m[0];
  }
  return null;
}

const removeWords = (normTitle: string, phrase: string) => {
  const p = normalizeText(phrase);
  if (!p) return normTitle;
  return ` ${normTitle} `.split(` ${p} `).join(' ').replace(/\s+/g, ' ').trim();
};

/** "מוביל/ת צוות", "מובילה לצוות" — a team lead, which no role type's exception covers (like "ראש צוות"). */
export const isTeamLead = (title: string) => /(?<![א-ת])מוביל(?:\s*[/.\\(]\s*[הת]\)?|ה)?\s+[ול]?צוות/.test(title);

/**
 * Seniority words allowed for this title: the allowSeniorityWords of every enabled role type whose titleKeywords
 * match it. lead = the role-noun "מוביל/ת" is allowed (listed as "מוביל" / "מובילה").
 */
export function allowedSeniority(title: string, roles: RoleType[]): { phrases: string[]; lead: boolean } {
  const words = rolesMatchingTitle(title, roles.filter((r) => !r.searchOnly)).flatMap((r) => r.allowSeniorityWords ?? []);
  return { phrases: words, lead: words.some((w) => /^מוביל(ה|\s*[/.]\s*[הת])?$/.test(w.trim())) };
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

  const excludedCompany = excludedCompanyMatch(job.company, f.excludeCompanies);
  if (excludedCompany) return { pass: false, status: 'skipped_company', reason: `excluded company: ${job.company} (matches "${excludedCompany}")` };

  // a role type can allow some seniority words when the title is that kind of role (allowSeniorityWords)
  const allow = allowedSeniority(job.title, prefs.roleTypes ?? []);
  const seniorityTitle = allow.phrases.reduce(removeWords, title);
  const seniority = f.excludeSeniorityKeywords.find((k) => containsKeyword(seniorityTitle, k));
  if (seniority) return { pass: false, reason: `seniority: "${seniority}"` };
  const lead = leadRoleNoun(job.title);
  if (lead && !(allow.lead && !isTeamLead(job.title))) return { pass: false, reason: `seniority: "${lead}" (team / domain lead)` };

  const excluded = f.excludeTitleKeywords.find((k) => containsKeyword(title, k));
  if (excluded) return { pass: false, reason: `excluded title keyword: "${excluded}"` };

  const disabled = disabledRoleKeywords(prefs.roleTypes ?? [], prefs.filters.includeTitleKeywords).find(([k]) => containsKeyword(title, k));
  if (disabled) return { pass: false, reason: `role type disabled: ${disabled[1]}` };

  if (f.includeTitleKeywords.length > 0 && !f.includeTitleKeywords.some((k) => containsKeyword(title, k))) {
    return { pass: false, reason: 'no include keyword in title' };
  }

  // the role type the job counts as may exclude words in its title or description (e.g. phone support for app-support)
  const role = primaryRole({ title: job.title, roleTypes: job.roleTypes ?? [] }, { roleTypes: prefs.roleTypes ?? [], queries: prefs.queries ?? { titles: [], keywords: [] } });
  const roleExcluded = role ? roleExclude(role, job) : null;
  if (roleExcluded) return { pass: false, reason: `${role!.id}: excluded "${roleExcluded.word}" in the ${roleExcluded.where}` };

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

/** A role type's own exclude word in the title or description (none when an "unless" phrase is also there). */
export function roleExclude(role: RoleType, job: { title: string; descriptionText?: string; requirementsText?: string }): { word: string; where: 'title' | 'description' } | null {
  if (!role.excludeKeywords?.length) return null;
  const title = normalizeText(job.title);
  const body = normalizeText(`${job.descriptionText ?? ''}\n${job.requirementsText ?? ''}`);
  const all = `${title} ${body}`;
  for (const word of role.excludeKeywords) {
    const where = containsKeyword(title, word) ? 'title' : containsKeyword(body, word) ? 'description' : null;
    if (!where) continue;
    const unless = role.excludeUnless?.[word] ?? [];
    if (unless.some((u) => containsKeyword(all, u))) continue;
    return { word, where };
  }
  return null;
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
  // best tier; within a tier the role type with more matching keywords ("מוביל/ת חדשנות ו-AI" is AI innovation, not
  // AI development), then the order in preferences
  const t = normalizeText(job.title);
  const hits = (r: RoleType) => r.titleKeywords.filter((k) => containsKeyword(t, k)).length;
  return [...rolesMatchingTitle(job.title, roles)].sort((a, b) => a.tier - b.tier || hits(b) - hits(a))[0] ?? null;
}

/** Tier used for ranking: the primary role's tier, or 3 when no role type matches the title. */
export const rankTier = (role: RoleType | null): 1 | 2 | 3 => role?.tier ?? 3;

/** Role context for the scorer: the primary role, else the best non-search-only role type whose query found it. */
export function scoringRole(job: { title: string; roleTypes: string[] }, prefs: Pick<Prefs, 'roleTypes' | 'queries'>): RoleType | null {
  const p = primaryRole(job, prefs);
  if (p) return p;
  return [...activeRoleTypes(prefs).filter((r) => !r.searchOnly && job.roleTypes.includes(r.id))].sort((a, b) => a.tier - b.tier)[0] ?? null;
}
