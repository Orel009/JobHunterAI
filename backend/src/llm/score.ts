import { z } from 'zod';
import { taskConfig } from './settings.js';
import { hebrewThirdPersonRule, type Gender } from '../core/gender.js';
import type { Prefs } from '../core/prefs.js';
import { loadProfile, profileForScoring } from '../profile/facts.js';
import type { Job } from '../sites/types.js';
import { chatJson, type LlmCache } from './llm.js';

// No length caps in the schema: Ollama compiles them into the sampling grammar, which truncates Hebrew text mid-word.
// Lists/text are clamped after validation instead.
export const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  matchedSkills: z.array(z.string()).transform((a) => a.slice(0, 20)),
  missingRequirements: z.array(z.string()).transform((a) => a.slice(0, 20)),
  seniorityFit: z.enum(['too_junior', 'fit', 'too_senior', 'unclear']),
  reasoningHe: z.string().min(10),
  /** fallback for the deterministic extractor: minimum years the post REQUIRES (not "advantage"), or null */
  requiredYearsMin: z.number().min(0).max(30).nullable(),
  /** short quote from the post supporting requiredYearsMin (provenance), or null */
  requiredYearsQuote: z.string().nullable(),
  seniority: z.enum(['junior', 'mid', 'senior', 'unknown']),
  /** 0-100: how much of the job is real software development (code, APIs, databases, debugging) */
  devContentScore: z.number().int().min(0).max(100),
  /** true when the post is a course / bootcamp / training program ("הכשרה והשמה"), not a job */
  isTrainingProgram: z.boolean(),
  /** true when the job is front-line support: phone / chat / first-line customer handling (skipped for role types that ask) */
  isFrontLineSupport: z.boolean(),
});

export interface ScoreRole {
  id: string;
  label?: string;
  tier: number;
  notes?: string;
}
export type ScoreResult = z.infer<typeof ScoreSchema>;

const MAX_POST_CHARS = 6000;

/**
 * Candidate facts for the scorer: data/profile/profile.json whenever it exists (an invalid or unresolved profile
 * throws rather than silently falling back); `candidateSummary` from preferences.yaml only before profile.json exists.
 */
export function candidateContext(prefs: Prefs): string {
  const profile = loadProfile();
  if (profile) return profileForScoring(profile);
  const summary = prefs.candidateSummary.trim();
  if (summary && !summary.startsWith('(fill in)')) return summary;
  throw new Error('No candidate profile yet: finish the setup wizard or upload your CV on the Profile screen (or set `candidateSummary` in your preferences).');
}

export function buildScoreMessages(
  job: Pick<Job, 'title' | 'company' | 'location' | 'descriptionText' | 'requirementsText'>,
  candidate: string,
  role?: ScoreRole | null,
  gender?: Gender,
) {
  const roleName = role ? `${role.label ?? role.id} (tier ${role.tier})` : '';
  const post = [
    `כותרת: ${job.title}`,
    `חברה: ${job.company || 'לא צוין'}`,
    `מיקום: ${job.location || 'לא צוין'}`,
    job.descriptionText ? `תיאור:\n${job.descriptionText}` : '(Only the title, company and location are known — the description is not available.)',
    job.requirementsText ? `דרישות:\n${job.requirementsText}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_POST_CHARS);

  return [
    {
      role: 'system' as const,
      content: [
        'You are a strict technical recruiter evaluating fit between ONE candidate and ONE job post (Israeli job market, posts mostly in Hebrew).',
        'Use only facts stated in the candidate profile. Never assume skills or experience that are not written there.',
        'score: 0-100. 85+ = meets essentially all mandatory requirements (חובה). 60-84 = good fit with gaps in nice-to-haves (יתרון). 30-59 = partial. <30 = poor fit or different profession.',
        'matchedSkills: requirements from the post the candidate clearly has. missingRequirements: mandatory requirements the candidate lacks or that the profile does not show.',
        'seniorityFit: compare required years/seniority to the candidate.',
        'reasoningHe: exactly 2 short sentences in natural, grammatical Hebrew explaining the score.',
        hebrewThirdPersonRule(gender),
        'requiredYearsMin: minimum years of experience the post REQUIRES (ignore anything marked יתרון / advantage / nice to have); a range counts as its minimum; several requirements → the highest minimum; null if none is stated. requiredYearsQuote: the exact short phrase from the post, or null.',
        'seniority: how the POST describes the role — junior (entry level, students, graduates, 0-1 years), mid, senior, or unknown.',
        'devContentScore: 0-100, how much of the daily work is real software development (writing code, APIs, databases, debugging). Call-center / customer service / IT helpdesk / hardware support ≈ 0-20.',
        'isTrainingProgram: true if the post is a course, bootcamp, "הכשרה והשמה" or any training program the candidate would join as a student, not a job.',
        'isFrontLineSupport: true if the daily work is front-line support — answering phone calls or chats, first-line / Tier 1 customer or end-user handling, a call center or helpdesk, IT / computer support, technician work, or customer service shifts. false for technical application / production support (Tier 2/3: investigating incidents with logs, SQL and APIs, on-call for production) and for any non-support job.',
        job.descriptionText
          ? ''
          : 'The description is NOT available: judge from the title, company and location alone, score conservatively (never above 75), say in reasoningHe that the description was missing, and use null / unknown for anything the title does not state.',
        role
          ? `Judge fit for the role type "${roleName}"${role.notes ? ` — ${role.notes}` : ''}: evaluate the candidate for THIS kind of role, not only as a full stack developer.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user' as const,
      content: `## Candidate profile\n${candidate}\n\n${role ? `## Role type\n${roleName}\n\n` : ''}## Job post\n${post}\n\nReturn the JSON evaluation.`,
    },
  ];
}

export async function scoreJob(
  job: Pick<Job, 'title' | 'company' | 'location' | 'descriptionText' | 'requirementsText'>,
  candidate: string,
  opts: { model?: string; cache?: LlmCache; fetchImpl?: typeof fetch; role?: ScoreRole | null; gender?: Gender } = {},
): Promise<ScoreResult & { model: string; cached: boolean }> {
  const cfg = taskConfig('analyze');
  const model = opts.model ?? cfg.model;
  const { data, cached } = await chatJson({
    task: 'analyze',
    ...(opts.model ? { model: opts.model } : {}),
    messages: buildScoreMessages(job, candidate, opts.role, opts.gender),
    schema: ScoreSchema,
    cache: opts.cache,
    fetchImpl: opts.fetchImpl,
  });
  return { ...data, model: opts.model ? model : `${cfg.provider}:${model}`, cached };
}
