/**
 * JobHunter Fill: what each form field is.
 *  - classifyLabels: labels the extension's dictionary does not know → a field type (cached in data/fill-label-types.json).
 *  - planForm (the form planner): the whole form (label / placeholder / name, type, options, required, nearby text and the
 *    form's heading) plus the job → a KIND per field: a profile key, "draft:cover", "draft:bio", "country" or "unknown".
 *    The model never writes a value and never picks a select option: values come from your profile (options are matched
 *    to them by the extension), drafts from the draft pipeline. Cached per site + form signature in
 *    data/fill-form-plans.json, so a form seen once is planned instantly.
 * Both use the analyze model with structured output.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { chatJson } from '../llm/llm.js';
import { normalizeText } from '../core/text.js';

/** The field types the extension can fill (kept in step with extension/fill-core.js). */
export const FIELD_TYPES = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'confirmEmail',
  'phone',
  'city',
  'address',
  'linkedin',
  'github',
  'website',
  'currentTitle',
  'currentCompany',
  'yearsExperience',
  'noticePeriod',
  'salary',
  'coverLetter',
  'bio',
  'country',
  'unknown',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const file = () => path.join(config.dataDir, 'fill-label-types.json');
const readCache = (): Record<string, FieldType> => {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, FieldType>;
  } catch {
    return {};
  }
};
const writeCache = (c: Record<string, FieldType>) => {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(c, null, 1));
};

const Schema = z.object({ types: z.array(z.object({ label: z.string(), type: z.enum(FIELD_TYPES) })) });

const SYSTEM = [
  'You classify the LABELS of fields in a job application form into field types. You never write values.',
  'Types: firstName, lastName, fullName, email, confirmEmail (re-enter / confirm email), phone, city (city / town of residence),',
  'address (street address), linkedin, github, website (portfolio / personal site), currentTitle (current job title),',
  'currentCompany (current employer), yearsExperience (total years of experience), noticePeriod (notice period / availability',
  'to start), salary (salary expectation), coverLetter (cover letter, message to the hiring team, a note on why you want to join),',
  'bio (bio, about you, tell us about yourself, introduce yourself), country (country of residence),',
  'unknown (anything else: questions, consents, other social profiles, demographics).',
  'Labels may be in Hebrew or English. Return one entry per label, with the label exactly as given.',
].join('\n');

/** Types for labels (normalized-label keys); the model is asked only about labels not in the cache. */
export async function classifyLabels(labels: string[], llm: typeof chatJson = chatJson): Promise<Record<string, FieldType>> {
  const cache = readCache();
  const want = [...new Set(labels.map((l) => l.trim()).filter((l) => l.length >= 2 && l.length <= 200))].slice(0, 40);
  const missing = want.filter((l) => !(normalizeText(l) in cache));
  if (missing.length) {
    const { data } = await llm({ task: 'analyze', schema: Schema, temperature: 0, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(missing) }] });
    for (const l of missing) {
      const hit = data.types.find((t) => normalizeText(t.label) === normalizeText(l));
      cache[normalizeText(l)] = hit?.type ?? 'unknown';
    }
    writeCache(cache);
  }
  return Object.fromEntries(want.map((l) => [normalizeText(l), cache[normalizeText(l)] ?? 'unknown']));
}

// ---------- the form planner ----------

/** the kinds a field can be planned as (no values: a profile key, a draft, or unknown) */
export const PLAN_KINDS = [...FIELD_TYPES.filter((t) => t !== 'coverLetter' && t !== 'bio' && t !== 'unknown'), 'draft:cover', 'draft:bio', 'unknown'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export interface PlanField {
  /** the extension's key for the field (stable between its scan and its fill) */
  key: string;
  label: string;
  placeholder: string;
  name: string;
  /** input type, "textarea" or "select-one" */
  type: string;
  options: string[];
  required: boolean;
  /** the text just before the field and the form's heading */
  near: string;
}

const PlanSchema = z.object({ fields: z.array(z.object({ key: z.string(), kind: z.enum(PLAN_KINDS) })) });

const PLAN_SYSTEM = [
  'You map the fields of a job application form to what fills them. You NEVER write values and never choose options: you pick one KIND per field.',
  'Kinds: firstName, lastName, fullName, email, confirmEmail, phone, city (city / town of residence), address (street address), country (country of residence),',
  'linkedin, github, website (portfolio / personal site), currentTitle, currentCompany, yearsExperience (TOTAL years of experience, no specific technology),',
  'noticePeriod (notice period / when you can start), salary (salary expectation),',
  'draft:cover — a free-text field for a cover letter, a message or note to the company / hiring team, why you want this job or to join them, motivation;',
  'draft:bio — a free-text field about the candidate: bio, about you / yourself, tell us about yourself, introduce yourself, professional summary;',
  'unknown — anything else: eligibility or yes/no questions, consents and declarations, demographics, uploads, other social profiles, technology-specific years.',
  'Use every clue: the label, placeholder, name, the text near the field and the form heading. A textarea under a heading such as',
  '"Please send us a note on why you want to be part of our team" is draft:cover even when its only label is "Message". A select is never a draft;',
  'its options show what it asks (a list of countries = country). Labels may be Hebrew or English.',
  'Return one entry per field, with its key exactly as given.',
].join('\n');

const plansFile = () => path.join(config.dataDir, 'fill-form-plans.json');
type PlanCache = Record<string, { at: string; plan: Record<string, PlanKind> }>;
const readPlans = (): PlanCache => {
  try {
    return JSON.parse(fs.readFileSync(plansFile(), 'utf8')) as PlanCache;
  } catch {
    return {};
  }
};

/** the form's signature: its fields as the page describes them (no values), so the same form on the same site plans once */
export const formSignature = (fields: PlanField[]): string =>
  createHash('sha1')
    .update(JSON.stringify(fields.map((f) => [f.key, normalizeText(f.label), normalizeText(f.placeholder), f.type, f.options.slice(0, 20).map(normalizeText), f.required])))
    .digest('hex')
    .slice(0, 16);

const TEXT_TYPES = new Set(['text', 'textarea', '']);

/** Plans a form: a kind per field key. A draft only for a free-text field; a cached plan for a form seen before. */
export async function planForm(
  host: string,
  fields: PlanField[],
  job: { title: string; company: string; text: string },
  llm: typeof chatJson = chatJson,
): Promise<{ plan: Record<string, PlanKind>; cached: boolean; signature: string }> {
  const signature = formSignature(fields);
  const id = `${host}|${signature}`;
  const cache = readPlans();
  if (cache[id]) return { plan: cache[id].plan, cached: true, signature };
  const ask = fields.slice(0, 80).map((f) => ({
    key: f.key,
    label: f.label.slice(0, 200),
    placeholder: f.placeholder.slice(0, 120),
    name: f.name.slice(0, 80),
    type: f.type,
    ...(f.options.length ? { options: f.options.slice(0, 25).map((o) => o.slice(0, 60)) } : {}),
    required: f.required,
    ...(f.near ? { near: f.near.slice(0, 250) } : {}),
  }));
  const { data } = await llm({
    task: 'analyze',
    schema: PlanSchema,
    temperature: 0,
    messages: [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: JSON.stringify({ job: { title: job.title.slice(0, 200), company: job.company.slice(0, 100), excerpt: job.text.slice(0, 1200) }, fields: ask }) },
    ],
  });
  const plan: Record<string, PlanKind> = {};
  for (const f of fields) {
    let kind = data.fields.find((x) => x.key === f.key)?.kind ?? 'unknown';
    // a draft goes only into a free-text field
    if (kind.startsWith('draft:') && !TEXT_TYPES.has(f.type)) kind = 'unknown';
    plan[f.key] = kind;
  }
  cache[id] = { at: new Date().toISOString(), plan };
  // the newest 300 forms
  const kept = Object.fromEntries(Object.entries(cache).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 300));
  fs.mkdirSync(path.dirname(plansFile()), { recursive: true });
  fs.writeFileSync(plansFile(), JSON.stringify(kept, null, 1));
  return { plan, cached: false, signature };
}
