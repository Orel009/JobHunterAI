import { z } from 'zod';

/** "2021", "2021-03" or "present". Anything else (e.g. an unresolved "CONFLICT …") fails validation. */
export const DateStr = z
  .string()
  .regex(/^(\d{4}(-(0[1-9]|1[0-2]))?|present)$/, 'expected YYYY, YYYY-MM or "present" — resolve CONFLICT values from profile.conflicts.md');

const Bi = z.object({ he: z.string().nullable().default(null), en: z.string().nullable().default(null) });
export type Bilingual = z.infer<typeof Bi>;
const Src = z.array(z.enum(['he', 'en']));

export const ProfileSchema = z.object({
  meta: z.object({ generatedAt: z.string(), sources: z.record(z.string(), z.string()), model: z.string() }).partial().default({}),
  contact: z.object({
    name: Bi,
    email: z.string().nullable().default(null),
    phone: z.string().nullable().default(null),
    city: Bi,
  }),
  links: z.array(z.object({ id: z.string(), label: z.string(), url: z.string() })).default([]),
  summary: Bi.default({ he: null, en: null }),
  experience: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['work', 'military', 'volunteer', 'project', 'other']).default('work'),
        company: Bi,
        title: Bi,
        start: DateStr.nullable(),
        end: DateStr.nullable(),
        /** skill ids used in this role (years are derived from these dates) */
        skills: z.array(z.string()).default([]),
        highlights: z.object({ he: z.array(z.string()).default([]), en: z.array(z.string()).default([]) }).default({ he: [], en: [] }),
        sources: Src.default([]),
      }),
    )
    .default([]),
  education: z
    .array(
      z.object({
        id: z.string(),
        institution: Bi,
        degree: Bi,
        field: Bi,
        start: DateStr.nullable(),
        end: DateStr.nullable(),
        sources: Src.default([]),
      }),
    )
    .default([]),
  skills: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        aliases: z.array(z.string()).default([]),
        /** years only when the CV states them explicitly */
        statedYears: z.number().nonnegative().nullable().default(null),
        /**
         * strong (default): may auto-answer screening/years questions.
         * basic: counts for scoring and matching, but NEVER auto-answers a yes/no or years statement (always pending).
         */
        level: z.enum(['strong', 'basic']).default('strong'),
        sources: Src.default([]),
      }),
    )
    .default([]),
  languages: z.array(z.object({ id: z.string(), name: Bi, level: Bi })).default([]),
  /**
   * Your own statement of total professional development experience. Answers GENERAL years statements only
   * ("N years of software development"); technology-specific statements never use it.
   */
  declaredExperience: z.object({ totalDevYears: z.number().nonnegative(), basis: z.string().min(1) }).nullable().default(null),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Experience = Profile['experience'][number];
export type Skill = Profile['skills'][number];
