import { z } from 'zod';

/** "2021", "2021-03" or "present". Anything else (e.g. an unresolved "CONFLICT …") fails validation. */
export const DateStr = z
  .string()
  .regex(/^(\d{4}(-(0[1-9]|1[0-2]))?|present)$/, 'expected YYYY, YYYY-MM or "present" — resolve CONFLICT values from profile.conflicts.md');

const Bi = z.object({ he: z.string().nullable().default(null), en: z.string().nullable().default(null) });
export type Bilingual = z.infer<typeof Bi>;
const Src = z.array(z.enum(['he', 'en']));

/**
 * USER-OWNED fields are never changed by a CV update (profile:init / CV upload diff):
 * gender, blockedSkills, declaredExperience, skills[].level, skills[].aliases, experience[].skills (skill links),
 * experience[]/education[].datesLocked dates (and any month-precise date you added), forms (the city for application
 * forms), education[].kind / order / city.
 */
export const USER_OWNED_FIELDS = [
  'gender',
  'blockedSkills',
  'declaredExperience',
  'skills[].level',
  'skills[].aliases',
  'experience[].skills',
  'experience[].datesLocked',
  'education[].datesLocked',
  'education[].kind',
  'education[].order',
  'education[].city',
  'forms',
] as const;

export const ProfileSchema = z.object({
  /** USER-OWNED: drives Hebrew grammatical gender in every prompt that writes Hebrew */
  gender: z.enum(['male', 'female']).nullable().default(null),
  /** USER-OWNED: skills you removed; CV updates never re-add them (matched by name/alias key) */
  blockedSkills: z.array(z.string()).default([]),
  meta: z.object({ generatedAt: z.string(), sources: z.record(z.string(), z.string()), model: z.string() }).partial().default({}),
  contact: z.object({
    name: Bi,
    email: z.string().nullable().default(null),
    phone: z.string().nullable().default(null),
    city: Bi,
  }),
  /**
   * USER-OWNED: values for application forms only (JobHunter Fill and form filling) — never a profile fact, never in a
   * CV or a draft. city: the city forms ask for (your CV may leave it out on purpose); country: a form's "Country".
   */
  forms: z.object({ city: Bi.default({ he: null, en: null }), country: Bi.default({ he: null, en: null }) }).default({ city: { he: null, en: null }, country: { he: null, en: null } }),
  links: z.array(z.object({ id: z.string(), label: z.string(), url: z.string() })).default([]),
  summary: Bi.default({ he: null, en: null }),
  experience: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['work', 'project', 'education', 'military', 'volunteer', 'other']).default('work'),
        company: Bi,
        title: Bi,
        start: DateStr.nullable(),
        end: DateStr.nullable(),
        /** skill ids used in this role (years are derived from these dates) */
        skills: z.array(z.string()).default([]),
        highlights: z.object({ he: z.array(z.string()).default([]), en: z.array(z.string()).default([]) }).default({ he: [], en: [] }),
        sources: Src.default([]),
        /** USER-OWNED: set when you edit the dates; CV updates never propose date changes for this role */
        datesLocked: z.boolean().default(false),
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
        /** USER-OWNED: see experience[].datesLocked */
        datesLocked: z.boolean().default(false),
        /** USER-OWNED: a degree or a course (null = from the degree's name: "course", "bootcamp", "קורס"… = a course) */
        kind: z.enum(['degree', 'course']).nullable().default(null),
        /** USER-OWNED: the order on application forms (1 = first); null = degrees before courses, newest first */
        order: z.number().int().min(1).max(99).nullable().default(null),
        /** USER-OWNED: the institution's city (forms' "school location"); null = left empty there */
        city: Bi.default({ he: null, en: null }),
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
