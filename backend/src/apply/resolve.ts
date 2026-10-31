/**
 * Field resolution. For every form field, in this order:
 *   (a) deterministic profile mapping (text fields only: name, email, phone, city, links)
 *   (b) answers bank: exact normalized key, else the LLM matcher returns {entryId, confidence} (never an answer)
 *   (c) "N years of X": deterministic from profile skill years, only if X maps to a profile skill
 *   (d) free-text draft — only for open text questions outside every hard-rule category
 * Anything else becomes `pending` and is saved to the bank for the user to answer once.
 */
import { normalizeText } from '../core/text.js';
import type { Profile } from '../profile/schema.js';
import { canonicalizeSkillMentions, listFacts, skillKey, skillYears } from '../profile/facts.js';
import { yesNo, type BankEntry, bankTypeFor } from './bank.js';
import { asksYearsCount, draftAllowed, hardRuleCategory, parseMinYears, questionKey } from './classify.js';
import type { FormField, ResolvedField } from './types.js';

export interface DraftResult {
  text: string | null;
  usedFactIds: string[];
  unanswerable: boolean;
  flaggedClaims: string[];
  rejectedReason?: string;
}

export interface ResolveDeps {
  profile: Profile | null;
  bank: { byKey(normKey: string): BankEntry | null; active(): BankEntry[] };
  /** LLM: picks a bank entry with the same meaning. Must not produce answers. */
  matchBank(question: string, candidates: BankEntry[]): Promise<{ entryId: number | null; confidence: number }>;
  /** LLM: free-text draft with fact citations + verification (see draft.ts). */
  draft(field: FormField, context: { jobTitle: string; jobText: string; language: 'he' | 'en' }): Promise<DraftResult>;
  minConfidence: number;
  job: { title: string; text: string; language: 'he' | 'en' };
  now?: Date;
}

// ---------- (a) profile mapping ----------
const PROFILE_MAP: Array<[RegExp, (p: Profile) => { value: string | null; ref: string }]> = [
  [/^(שם מלא|שם|full name|name)$/, (p) => ({ value: p.contact.name.he ?? p.contact.name.en, ref: 'contact.name' })],
  [/^(שם פרטי|first name)$/, (p) => ({ value: (p.contact.name.he ?? p.contact.name.en)?.split(' ')[0] ?? null, ref: 'contact.name' })],
  [/^(שם משפחה|last name|surname)$/, (p) => ({ value: (p.contact.name.he ?? p.contact.name.en)?.split(' ').slice(1).join(' ') || null, ref: 'contact.name' })],
  [/(דואל|דוא ל|אימייל|מייל|e ?mail)/, (p) => ({ value: p.contact.email, ref: 'contact.email' })],
  [/(טלפון|נייד|phone|mobile)/, (p) => ({ value: p.contact.phone, ref: 'contact.phone' })],
  [/^(עיר|עיר מגורים|מקום מגורים|city|city of residence|location)$/, (p) => ({ value: p.contact.city.he ?? p.contact.city.en, ref: 'contact.city' })],
  [/linkedin/, (p) => ({ value: p.links.find((l) => l.id.startsWith('link.linkedin'))?.url ?? null, ref: 'link.linkedin' })],
  [/github/, (p) => ({ value: p.links.find((l) => l.id.startsWith('link.github'))?.url ?? null, ref: 'link.github' })],
];

function fromProfile(field: FormField, profile: Profile | null): { value: string; ref: string } | null {
  if (!profile || (field.type !== 'text' && field.type !== 'textarea')) return null;
  const q = normalizeText(field.label);
  for (const [re, get] of PROFILE_MAP) {
    if (!re.test(q)) continue;
    const r = get(profile);
    return r.value ? { value: r.value, ref: r.ref } : null;
  }
  return null;
}

// ---------- (c) years ----------
/** Profile skills whose name/alias appears as whole words in the question. */
export function skillsMentioned(profile: Profile, question: string): Profile['skills'] {
  const q = ` ${normalizeText(question)} `;
  return profile.skills.filter((s) =>
    [s.name, ...s.aliases].some((n) => {
      const k = skillKey(n);
      return k.length > 0 && q.includes(` ${k} `);
    }),
  );
}

type YearsResult = { value: string; ref: string; detail: string } | { pending: string } | null;

function fromSkillYears(field: FormField, profile: Profile | null, now: Date): YearsResult {
  const minYears = parseMinYears(field.label);
  const countQ = asksYearsCount(field.label);
  if (minYears === null && !countQ) return null;
  if (!profile) return { pending: 'years question: no profile yet' };
  const skills = skillsMentioned(profile, field.label);
  // keep the most specific matches ("react native" over "react")
  const specific = skills.filter((s) => !skills.some((o) => o !== s && skillKey(o.name).includes(skillKey(s.name)) && skillKey(o.name) !== skillKey(s.name)));
  if (specific.length === 0) return { pending: 'years question: skill not in your profile' };
  // RULE: a basic-level skill counts for scoring/matching but never auto-answers a screening/years statement
  const basic = specific.filter((s) => s.level === 'basic');
  if (basic.length) return { pending: `basic-level skill (${basic.map((s) => s.name).join(', ')}): answer this yourself` };
  const ys = specific.map((s) => ({ s, y: skillYears(profile, s.id, now) }));
  if (ys.some((x) => x.y.years === null)) return { pending: 'years question: no dated role lists this skill' };
  const min = Math.min(...ys.map((x) => x.y.years!));
  const ref = ys.map((x) => x.s.id).join(',');
  const detail = ys.map((x) => `${x.s.name}: ${x.y.years}y ${x.y.source}${x.y.from.length ? ` from ${x.y.from.join('+')}` : ''}`).join('; ');
  if (minYears !== null && (field.type === 'yes_no' || field.type === 'consent' || !countQ)) {
    return { value: min >= minYears ? 'yes' : 'no', ref, detail: `${detail} vs required ${minYears}` };
  }
  return { value: String(Math.floor(min)), ref, detail };
}

// ---------- bank candidates ----------
function shortlist(question: string, entries: BankEntry[], type: FormField['type'], max = 30): BankEntry[] {
  const qt = new Set(normalizeText(question).split(' ').filter((t) => t.length > 1));
  const bt = bankTypeFor(type);
  return entries
    .filter((e) => e.answer && (e.type === bt || (bt === 'text' && e.type !== 'yes_no')))
    .map((e) => ({ e, s: e.normKey.split(' ').filter((t) => qt.has(t)).length }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.e);
}

function normalizeChoice(value: string, field: FormField): string | null {
  if (field.type === 'yes_no' || field.type === 'consent') return yesNo(value);
  if (field.type === 'choice') {
    const v = normalizeText(value);
    return field.options?.find((o) => normalizeText(o) === v) ?? null;
  }
  if (field.type === 'number') return /^\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : null;
  return value;
}

export async function resolveField(field: FormField, deps: ResolveDeps): Promise<ResolvedField> {
  const normKey = questionKey(field.label);
  const category = hardRuleCategory(field.label, field.type);
  const base = { field, normKey, category };
  const now = deps.now ?? new Date();

  // (a)
  const p = fromProfile(field, deps.profile);
  if (p) return { ...base, status: 'resolved', value: p.value, provenance: { source: 'profile', ref: p.ref } };

  // (b) exact key, then LLM matcher over a shortlist
  const exact = deps.bank.byKey(normKey);
  if (exact?.answer) {
    const v = normalizeChoice(exact.answer, field);
    if (v !== null) return { ...base, status: 'resolved', value: v, provenance: { source: 'bank', ref: String(exact.id), confidence: 1, detail: 'exact question' } };
  }
  // same question once skill aliases are unified ("ES6" ≡ "JavaScript", "OOP" ≡ "Object-Oriented Programming")
  if (deps.profile) {
    const canon = canonicalizeSkillMentions(normKey, deps.profile);
    const hit = deps.bank.active().find((e) => e.answer && canonicalizeSkillMentions(e.normKey, deps.profile) === canon);
    const v = hit ? normalizeChoice(hit.answer!, field) : null;
    if (hit && v !== null) return { ...base, status: 'resolved', value: v, provenance: { source: 'bank', ref: String(hit.id), confidence: 1, detail: `same question via skill synonyms: ${hit.question}` } };
  }
  const candidates = shortlist(field.label, deps.bank.active(), field.type);
  if (candidates.length > 0) {
    const m = await deps.matchBank(withSynonymHint(field.label, deps.profile), candidates);
    const entry = m.entryId !== null ? candidates.find((c) => c.id === m.entryId) : undefined;
    if (entry?.answer && m.confidence >= deps.minConfidence) {
      const v = normalizeChoice(entry.answer, field);
      if (v !== null) return { ...base, status: 'resolved', value: v, provenance: { source: 'bank', ref: String(entry.id), confidence: m.confidence, detail: entry.question } };
    }
  }

  // (c)
  const y = fromSkillYears(field, deps.profile, now);
  if (y && 'value' in y) {
    const v = normalizeChoice(y.value, field) ?? y.value;
    return { ...base, status: 'resolved', value: v, provenance: { source: 'skill_years', ref: y.ref, detail: y.detail } };
  }

  // (d)
  if (!(y && 'pending' in y) && draftAllowed(field.label, field.type)) {
    if (!field.required) return { ...base, status: 'empty_optional', value: null, provenance: { source: 'none' }, reason: 'optional free text left empty' };
    const d = await deps.draft(field, { jobTitle: deps.job.title, jobText: deps.job.text, language: deps.job.language });
    if (d.text && !d.rejectedReason && !d.unanswerable) {
      return {
        ...base,
        status: 'draft',
        value: d.text,
        provenance: { source: 'draft', usedFactIds: d.usedFactIds, flaggedClaims: d.flaggedClaims },
      };
    }
    return { ...base, status: 'pending', value: null, provenance: { source: 'none' }, reason: d.rejectedReason ?? 'not answerable from profile facts' };
  }

  if (!field.required) return { ...base, status: 'empty_optional', value: null, provenance: { source: 'none' }, reason: 'optional, no answer on file' };
  return {
    ...base,
    status: 'pending',
    value: null,
    provenance: { source: 'none' },
    reason: y && 'pending' in y ? y.pending : category ? `needs your answer (${category})` : 'needs your answer',
  };
}

/** Tells the bank matcher which skill names are synonyms (it still only returns an entry id). */
export function withSynonymHint(question: string, profile: Profile | null): string {
  if (!profile) return question;
  const hints = skillsMentioned(profile, question)
    .filter((s) => s.aliases.length)
    .map((s) => `${[s.name, ...s.aliases].join(' = ')}`);
  return hints.length ? `${question}
(synonyms: ${hints.join('; ')})` : question;
}

/** Known fact ids (for validating draft citations). */
export const factIds = (profile: Profile | null, now = new Date()): Set<string> => new Set(profile ? listFacts(profile, now).map((f) => f.id) : []);
