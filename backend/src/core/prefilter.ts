import type { Job } from '../sites/types.js';
import type { Prefs } from './prefs.js';
import { containsKeyword, normalizeCompany, normalizeText } from './text.js';

export interface PrefilterResult {
  pass: boolean;
  reason: string;
}

type PrefilterInput = Pick<Job, 'title' | 'company' | 'location'>;
type PrefilterPrefs = Pick<Prefs, 'locations' | 'filters'>;

/** Deterministic gate before any LLM call. Order matters: the first failing rule is the reason. */
export function prefilter(job: PrefilterInput, prefs: PrefilterPrefs): PrefilterResult {
  const title = normalizeText(job.title);
  const f = prefs.filters;

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
        return n && (loc.includes(n) || n.includes(loc));
      }) || f.remoteKeywords.some((k) => containsKeyword(loc, k));
    if (!ok) return { pass: false, reason: `location: ${job.location}` };
  }

  return { pass: true, reason: 'ok' };
}
