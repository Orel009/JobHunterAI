/**
 * Free-text drafts (only for open text questions; see classify.draftAllowed):
 *  1. WRITE model gets only relevant profile facts with ids + the job text → {text, usedFactIds, unanswerable}
 *  2. post-check: unanswerable / no citations / unknown ids → rejected (field becomes pending)
 *  3. ANALYZE model verification pass lists claims not supported by the cited facts → flaggedClaims (kept as draft)
 */
import { z } from 'zod';
import { config } from '../config.js';
import { normalizeText } from '../core/text.js';
import { chatJson, type LlmCache } from '../llm/ollama.js';
import { listFacts, type Fact } from '../profile/facts.js';
import type { Profile } from '../profile/schema.js';
import type { BankEntry } from './bank.js';
import type { DraftResult } from './resolve.js';
import type { FormField } from './types.js';

export const DraftSchema = z.object({ text: z.string(), usedFactIds: z.array(z.string()), unanswerable: z.boolean() });
export const VerifySchema = z.object({ unsupportedClaims: z.array(z.string()) });
export const MatchSchema = z.object({ entryId: z.number().int().nullable(), confidence: z.number().min(0).max(1) });

const MAX_FACTS = 25;

/** Facts most relevant to the question/job (token overlap), always including the summary and role headers. */
export function relevantFacts(facts: Fact[], question: string, jobText: string): Fact[] {
  const q = new Set(normalizeText(`${question} ${jobText}`).split(' ').filter((t) => t.length > 2));
  const always = facts.filter((f) => /^summary\./.test(f.id) || /^exp\.[^.]+$/.test(f.id));
  const rest = facts
    .filter((f) => !always.includes(f) && !f.id.startsWith('contact.') && !f.id.startsWith('link.'))
    .map((f) => ({ f, s: normalizeText(f.text).split(' ').filter((t) => q.has(t)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.f);
  return [...always, ...rest].slice(0, MAX_FACTS);
}

/** Pure post-check of a draft's citations. */
export function checkDraftCitations(d: z.infer<typeof DraftSchema>, known: Set<string>): string | null {
  if (d.unanswerable) return 'model marked the question unanswerable from the facts';
  if (!d.text.trim()) return 'empty draft';
  if (d.usedFactIds.length === 0) return 'draft cites no facts';
  const unknown = d.usedFactIds.filter((id) => !known.has(id));
  if (unknown.length) return `draft cites unknown fact ids: ${unknown.join(', ')}`;
  return null;
}

const WRITE_SYSTEM: Record<'he' | 'en', string> = {
  he: [
    'אתה כותב תשובה לשאלה פתוחה בטופס מועמדות, בשם המועמד, בגוף ראשון.',
    'המועמד גבר: לשון זכר תקנית ("עבדתי", "אני מתעניין").',
    'מותר להשתמש אך ורק בעובדות שברשימה (כל עובדה עם מזהה בסוגריים מרובעים). אסור להוסיף שום פרט שלא מופיע בהן: לא שנים, לא זמינות, לא נכונות, לא תכונות אופי, לא טכנולוגיות.',
    'אם אי אפשר לענות מתוך העובדות — unanswerable=true ו-text ריק.',
    'usedFactIds: מזהי כל העובדות שהתשובה נשענת עליהן. 2-4 משפטים, עברית טבעית ותקנית.',
  ].join('\n'),
  en: [
    'You write an answer to an open question in a job application form, as the candidate, in first person.',
    'Use ONLY the facts listed (each has an id in square brackets). Do not add any detail that is not in them: no years, availability, willingness, personality traits or technologies that are not listed.',
    'If the question cannot be answered from the facts: unanswerable=true and empty text.',
    'usedFactIds: ids of every fact the answer relies on. 2-4 sentences, natural English.',
  ].join('\n'),
};

export function makeDrafter(profile: Profile | null, opts: { cache?: LlmCache; now?: Date } = {}) {
  return async (field: FormField, ctx: { jobTitle: string; jobText: string; language: 'he' | 'en' }): Promise<DraftResult> => {
    if (!profile) return { text: null, usedFactIds: [], unanswerable: true, flaggedClaims: [], rejectedReason: 'no profile.json yet' };
    const all = listFacts(profile, opts.now);
    const facts = relevantFacts(all, field.label, ctx.jobText);
    const factBlock = facts.map((f) => `[${f.id}] ${f.text}`).join('\n');
    const { data } = await chatJson({
      model: config.OLLAMA_MODEL_WRITE,
      schema: DraftSchema,
      temperature: 0.2,
      cache: opts.cache,
      messages: [
        { role: 'system', content: WRITE_SYSTEM[ctx.language] },
        { role: 'user', content: `Facts:\n${factBlock}\n\nJob: ${ctx.jobTitle}\n${ctx.jobText.slice(0, 2500)}\n\nQuestion: ${field.label}` },
      ],
    });
    const rejected = checkDraftCitations(data, new Set(all.map((f) => f.id)));
    if (rejected) return { text: null, usedFactIds: data.usedFactIds, unanswerable: data.unanswerable, flaggedClaims: [], rejectedReason: rejected };
    const cited = all.filter((f) => data.usedFactIds.includes(f.id));
    const flaggedClaims = await judgeClaims(data.text, cited, { cache: opts.cache });
    return { text: data.text.trim(), usedFactIds: data.usedFactIds, unanswerable: false, flaggedClaims };
  };
}

/** Verification pass: claims in `text` not supported by `facts` (ANALYZE model). */
export async function judgeClaims(text: string, facts: Fact[], opts: { cache?: LlmCache; model?: string } = {}): Promise<string[]> {
  const { data } = await chatJson({
    model: opts.model ?? config.OLLAMA_MODEL_ANALYZE,
    schema: VerifySchema,
    cache: opts.cache,
    messages: [
      {
        role: 'system',
        content:
          'You are a strict fact checker. List every factual claim in TEXT that is not directly supported by FACTS ' +
          '(years, availability, willingness, skills, employers, achievements, traits). Ignore generic politeness. ' +
          'Quote each unsupported claim briefly in the language of TEXT. Empty list if everything is supported.',
      },
      { role: 'user', content: `FACTS:\n${facts.map((f) => `[${f.id}] ${f.text}`).join('\n')}\n\nTEXT:\n${text}` },
    ],
  });
  return data.unsupportedClaims;
}

export function makeBankMatcher(opts: { cache?: LlmCache } = {}) {
  return async (question: string, candidates: BankEntry[]) => {
    const { data } = await chatJson({
      model: config.OLLAMA_MODEL_ANALYZE,
      schema: MatchSchema,
      cache: opts.cache,
      messages: [
        {
          role: 'system',
          content:
            'Match a job-application form question to an existing answers-bank entry that asks for the SAME information. ' +
            'Return its entryId, or null if none asks for the same information. confidence 0-1. Do NOT write or guess answers.',
        },
        { role: 'user', content: `Bank entries:\n${candidates.map((c) => `${c.id}: ${c.question}`).join('\n')}\n\nForm question: ${question}` },
      ],
    });
    return data;
  };
}

export const YearsClassSchema = z.object({ kind: z.enum(['general', 'technology', 'unsure']) });

/**
 * Classifies a years-of-experience statement. Classification only: the answer always comes from
 * declaredExperience (general) or profile work roles (technology), never from the model.
 */
export function makeYearsClassifier(opts: { cache?: LlmCache } = {}) {
  return async (question: string) => {
    const { data } = await chatJson({
      model: config.OLLAMA_MODEL_ANALYZE,
      schema: YearsClassSchema,
      cache: opts.cache,
      messages: [
        {
          role: 'system',
          content: [
            'Classify a job-application statement about years of experience.',
            'general: total professional experience in software development / programming / as a developer or engineer, with NO specific technology, language, framework, tool, platform, product or business domain named.',
            'technology: names any specific technology, language, framework, database, tool, platform, product or domain (e.g. React, .NET, SQL, stored procedures, AWS, QA automation, Priority, fintech).',
            'unsure: anything else or ambiguous. Do NOT answer the statement.',
          ].join('\n'),
        },
        { role: 'user', content: question },
      ],
    });
    return data;
  };
}
