import { z } from 'zod';
import { config } from '../config.js';
import type { Prefs } from '../core/prefs.js';
import { loadProfile, profileForScoring } from '../profile/facts.js';
import type { Job } from '../sites/types.js';
import { chatJson, type LlmCache } from './ollama.js';

// No length caps in the schema: Ollama compiles them into the sampling grammar, which truncates Hebrew text mid-word.
// Lists/text are clamped after validation instead.
export const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  matchedSkills: z.array(z.string()).transform((a) => a.slice(0, 20)),
  missingRequirements: z.array(z.string()).transform((a) => a.slice(0, 20)),
  seniorityFit: z.enum(['too_junior', 'fit', 'too_senior', 'unclear']),
  reasoningHe: z.string().min(10),
});
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
  throw new Error('No candidate profile: add `candidateSummary` to preferences.yaml (or create data/profile/profile.json).');
}

export function buildScoreMessages(job: Pick<Job, 'title' | 'company' | 'location' | 'descriptionText' | 'requirementsText'>, candidate: string) {
  const post = [
    `כותרת: ${job.title}`,
    `חברה: ${job.company || 'לא צוין'}`,
    `מיקום: ${job.location || 'לא צוין'}`,
    `תיאור:\n${job.descriptionText}`,
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
      ].join('\n'),
    },
    { role: 'user' as const, content: `## Candidate profile\n${candidate}\n\n## Job post\n${post}\n\nReturn the JSON evaluation.` },
  ];
}

export async function scoreJob(
  job: Pick<Job, 'title' | 'company' | 'location' | 'descriptionText' | 'requirementsText'>,
  candidate: string,
  opts: { model?: string; cache?: LlmCache; fetchImpl?: typeof fetch } = {},
): Promise<ScoreResult & { model: string; cached: boolean }> {
  const model = opts.model ?? config.OLLAMA_MODEL_ANALYZE;
  const { data, cached } = await chatJson({
    model,
    messages: buildScoreMessages(job, candidate),
    schema: ScoreSchema,
    cache: opts.cache,
    fetchImpl: opts.fetchImpl,
  });
  return { ...data, model, cached };
}
