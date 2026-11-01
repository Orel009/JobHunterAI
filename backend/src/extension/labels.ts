/**
 * JobHunter Fill: form labels the extension's synonym dictionary does not know are classified into a known field type
 * by the analyze model (structured output; it picks a TYPE, never writes a value). Results are cached locally in
 * data/fill-label-types.json, so a label seen once is instant afterwards. "unknown" stays yellow on the form.
 */
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
  'to start), salary (salary expectation), coverLetter (cover letter, message to the hiring team, why us, about yourself),',
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
