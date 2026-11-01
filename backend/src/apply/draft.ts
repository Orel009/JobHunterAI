/**
 * Free-text drafts (only for open text questions; see classify.draftAllowed):
 *  1. WRITE model gets only relevant profile facts with ids + the job text → {text, usedFactIds, unanswerable}
 *  2. post-check: unanswerable / no citations / unknown ids → rejected (field becomes pending)
 *  3. ANALYZE model verification pass lists claims not supported by the cited facts → flaggedClaims (kept as draft)
 * A cover letter / message to the hiring team has its own rules (plain, specific, 2–4 sentences, no AI clichés, no em
 * dashes, no lists, no flattery), an optional sample of your own writing as the style reference, and a style post-check
 * that sends it back once; a draft that still fails is not used.
 */
import { z } from 'zod';
import { hebrewFirstPersonRule, type Gender } from '../core/gender.js';
import { normalizeText } from '../core/text.js';
import { chatJson, type LlmCache } from '../llm/llm.js';
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

/** Draft-writing instructions; Hebrew grammatical gender comes from the profile. */
export const writeSystem = (language: 'he' | 'en', gender: Gender, sentences = '2-4'): string =>
  WRITE_SYSTEM[language].replace('{GENDER_RULE}', hebrewFirstPersonRule(gender)).replace('2-4', sentences);

const WRITE_SYSTEM: Record<'he' | 'en', string> = {
  he: [
    'אתה כותב תשובה לשאלה פתוחה בטופס מועמדות, בשם המועמד, בגוף ראשון.',
    '{GENDER_RULE}',
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

// ---------- cover letters / messages to the hiring team ----------

/** Phrases that make a message sound machine-written (case-insensitive; a draft with any of them is sent back). */
export const COVER_BANNED: Array<[RegExp, string]> = [
  [/\bexcit(ed|ing|ement)\b/i, 'excited'],
  [/\bpassion(ate)?\b/i, 'passionate'],
  [/\bthrilled\b/i, 'thrilled'],
  [/\bI(?: am|'m) confident\b/i, 'I am confident'],
  [/\bleverag(e|es|ed|ing)\b/i, 'leverage'],
  [/\bdynamic\b/i, 'dynamic'],
  [/\bfast[- ]paced\b/i, 'fast-paced'],
  [/\b(would be|am|I'm) a (great|perfect|strong|good) fit\b|\bI believe I would be\b/i, 'I believe I would be a great fit'],
  [/נלהב/, 'נלהב'],
  [/אשמח מאוד להצטרף/, 'אשמח מאוד להצטרף'],
  [/מאתגר ודינמי|דינמי ומאתגר|דינמית ומאתגרת|מאתגרת ודינמית/, 'מאתגר ודינמי'],
];

/** "Netanya. Built x! Done?" → 3; decimals and "e.g." are not sentence ends. */
export const sentenceCount = (t: string): number =>
  t
    .replace(/\b(e\.g|i\.e|etc|vs|Ltd|Inc)\./gi, '$1')
    .replace(/(\d)\.(\d)/g, '$1$2')
    .split(/[.!?]+(?:\s|$)/)
    .filter((x) => x.trim().length > 1).length;

/** Why a cover-letter draft breaks the style rules (null = fine): a banned phrase, an em dash, a list, over 4 sentences. */
export function coverLetterProblem(text: string): string | null {
  const banned = COVER_BANNED.filter(([re]) => re.test(text)).map(([, name]) => `"${name}"`);
  if (banned.length) return `banned phrase${banned.length > 1 ? 's' : ''}: ${banned.join(', ')}`;
  if (/[—–]/.test(text)) return 'an em dash';
  if (/^\s*([-*•●▪]|\d+[.)])\s/m.test(text)) return 'a list';
  const n = sentenceCount(text);
  if (n > 4) return `${n} sentences (at most 4)`;
  return null;
}

const COVER_SYSTEM: Record<'he' | 'en', string> = {
  he: [
    'אתה כותב הודעה קצרה לצוות הגיוס (מכתב מקדים) בשם המועמד, בגוף ראשון, בעברית.',
    '{GENDER_RULE}',
    '2-4 משפטים קצרים, פשוטים וספציפיים, כמו שאדם כותב בעצמו. בלי פתיח ובלי חתימה.',
    'הזכר 1-2 עובדות קונקרטיות מהרשימה שמתאימות למשרה, וסיבה קונקרטית אחת שקשורה למודעה עצמה (משהו שכתוב בה).',
    'אסור: קלישאות ("נלהב", "אשמח מאוד להצטרף", "מאתגר ודינמי", "תשוקה"), מחמאות לחברה, קו מפריד ארוך (—), רשימות או תבליטים.',
    'מותר להשתמש אך ורק בעובדות שברשימה (כל עובדה עם מזהה בסוגריים מרובעים). אסור להוסיף שום פרט שלא מופיע בהן.',
    'אם אי אפשר לכתוב מתוך העובדות: unanswerable=true ו-text ריק. usedFactIds: מזהי העובדות שההודעה נשענת עליהן.',
  ].join('\n'),
  en: [
    'You write a short message to the hiring team (a cover letter) as the candidate, in first person, in English.',
    '2-4 short sentences: plain and specific, the way a person writes it themselves. No greeting, no sign-off.',
    'Mention 1-2 concrete facts from the list that match the job, and one concrete reason tied to the job ad itself (something it actually says).',
    'Never: clichés ("excited", "passionate", "thrilled", "I am confident", "leverage", "dynamic", "fast-paced", "I believe I would be a great fit"), flattery of the company, em dashes (—), lists or bullet points.',
    'Use ONLY the facts listed (each has an id in square brackets). Do not add any detail that is not in them.',
    'If it cannot be written from the facts: unanswerable=true and empty text. usedFactIds: ids of every fact the message relies on.',
  ].join('\n'),
};
export const coverSystem = (language: 'he' | 'en', gender: Gender): string => COVER_SYSTEM[language].replace('{GENDER_RULE}', hebrewFirstPersonRule(gender));

/**
 * sentences: the length asked for form answers ("2-4"). mode "coverLetter": the cover-letter rules, your writing sample
 * (styleSample) as the style reference, and the style post-check (sent back once).
 */
export function makeDrafter(profile: Profile | null, opts: { cache?: LlmCache; now?: Date; sentences?: string; mode?: 'answer' | 'coverLetter'; styleSample?: string } = {}) {
  return async (field: FormField, ctx: { jobTitle: string; jobText: string; language: 'he' | 'en' }): Promise<DraftResult> => {
    if (!profile) return { text: null, usedFactIds: [], unanswerable: true, flaggedClaims: [], rejectedReason: 'no profile.json yet' };
    const all = listFacts(profile, opts.now);
    const facts = relevantFacts(all, field.label, ctx.jobText);
    const factBlock = facts.map((f) => `[${f.id}] ${f.text}`).join('\n');
    const cover = opts.mode === 'coverLetter';
    const sample = cover && opts.styleSample?.trim() ? `\n\nWriting style sample (messages I wrote myself; match their tone, length and wording, never copy facts from them):\n${opts.styleSample.trim().slice(0, 3000)}` : '';
    const messages = [
      { role: 'system' as const, content: cover ? coverSystem(ctx.language, profile.gender) : writeSystem(ctx.language, profile.gender, opts.sentences) },
      { role: 'user' as const, content: `Facts:\n${factBlock}\n\nJob: ${ctx.jobTitle}\n${ctx.jobText.slice(0, 2500)}\n\nQuestion: ${field.label}${sample}` },
    ];
    let { data } = await chatJson({ task: 'write', schema: DraftSchema, temperature: 0.2, cache: opts.cache, messages });
    // a cover letter that breaks the style rules is sent back once, with the reason
    if (cover && !data.unanswerable && data.text.trim()) {
      const problem = coverLetterProblem(data.text);
      if (problem) {
        ({ data } = await chatJson({
          task: 'write',
          schema: DraftSchema,
          temperature: 0.4,
          cache: opts.cache,
          messages: [...messages, { role: 'assistant' as const, content: JSON.stringify(data) }, { role: 'user' as const, content: `Rejected: it has ${problem}. Rewrite it following every rule: 2-4 short plain sentences, none of the banned phrases, no em dashes, no lists.` }],
        }));
        const again = data.text.trim() ? coverLetterProblem(data.text) : null;
        if (again) return { text: null, usedFactIds: data.usedFactIds, unanswerable: false, flaggedClaims: [], rejectedReason: `style check failed twice (${again})` };
      }
    }
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
    ...(opts.model ? { model: opts.model } : { task: 'analyze' as const }),
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
      task: 'analyze',
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
      task: 'analyze',
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
