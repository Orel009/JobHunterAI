/**
 * CV(s) → profile. The LLM only extracts; every fact is verified against the CV text (merge.ts) and
 * contradictions between a Hebrew and an English CV are listed, never resolved. Works with one or both CVs.
 */
import fs from 'node:fs';
import type { z } from 'zod';
import { chatJson, type LlmCache } from '../llm/ollama.js';
import { pdfToText } from './pdf.js';
import {
  AlignSchema,
  ExtractSchema,
  mergeProfiles,
  uncoveredDateLines,
  verifyExtraction,
  type Alignment,
  type Conflict,
  type Dropped,
  type Extracted,
  type Lang,
} from './merge.js';
import type { Profile } from './schema.js';

const EXTRACT_SYSTEM = [
  'You extract facts from ONE CV into JSON. Rules:',
  "- Copy text exactly as written in the CV, in the CV's language. Do NOT translate, rephrase, summarize, or add anything.",
  '- Only include facts that are explicitly written in the CV. If something is not written, use null or an empty list.',
  '- Dates: convert to "YYYY-MM" or "YYYY" exactly as precise as the CV; ongoing roles end with "present".',
  '- experience: every job, army service (kind "military"), volunteering, or significant project section, in CV order.',
  "  skills = technologies explicitly named inside that role's text. highlights = that role's bullet points copied verbatim.",
  '- skills: every technology/skill named anywhere in the CV, each listed ONCE (no repeats). statedYears ONLY when the CV explicitly states a number of years for that skill; otherwise null. Never compute years.',
  '- education: degrees, diplomas, courses with institution names.',
  '- languages: spoken languages with the level as written.',
].join('\n');

const EMPTY: Extracted = { name: null, city: null, summary: null, experience: [], education: [], skills: [], languages: [] };

export interface ExtractResult {
  profile: Profile;
  conflicts: Conflict[];
  dropped: Dropped[];
  missed: Array<{ lang: Lang; line: string }>;
  texts: Partial<Record<Lang, string>>;
}

export type Progress = (stage: string, pct: number) => void;

export interface ExtractOptions {
  cache?: LlmCache;
  onProgress?: Progress;
  /** test seam */
  chat?: typeof chatJson;
}

/** Three focused calls per CV: bigger combined calls silently skipped entries and could time out. */
async function extractOne(lang: Lang, text: string, opts: ExtractOptions, base: number, span: number): Promise<Extracted> {
  const chat = opts.chat ?? chatJson;
  const user = `CV (${lang === 'he' ? 'Hebrew' : 'English'}):\n"""\n${text}\n"""`;
  const call = <T extends z.ZodType>(schema: T, focus: string) =>
    chat({ task: 'analyze', schema, numCtx: 16384, cache: opts.cache, messages: [{ role: 'system', content: `${EXTRACT_SYSTEM}\n\nThis pass: ${focus}` }, { role: 'user', content: user }] });
  opts.onProgress?.(`${lang} CV: roles`, base);
  const a = await call(ExtractSchema.pick({ name: true, city: true, summary: true, experience: true }), 'name, city, summary and EVERY experience entry (jobs, army service, projects).');
  opts.onProgress?.(`${lang} CV: education & languages`, base + span / 3);
  const b = await call(ExtractSchema.pick({ education: true, languages: true }), 'EVERY education entry (each degree/diploma/course line) and every spoken language.');
  opts.onProgress?.(`${lang} CV: skills`, base + (2 * span) / 3);
  const c = await call(ExtractSchema.pick({ skills: true }), 'every skill/technology named anywhere in the CV, each ONCE.');
  return { ...a.data, ...b.data, ...c.data };
}

export async function extractProfile(files: Partial<Record<Lang, string>>, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const langs = (['he', 'en'] as const).filter((l) => files[l] && fs.existsSync(files[l]!));
  if (langs.length === 0) throw new Error('no CV file to read');
  opts.onProgress?.('reading PDF text', 2);
  const texts: Partial<Record<Lang, { text: string; links: string[] }>> = {};
  for (const l of langs) texts[l] = await pdfToText(files[l]!);

  const verified: Record<Lang, ReturnType<typeof verifyExtraction>> = { he: { clean: EMPTY, dropped: [] }, en: { clean: EMPTY, dropped: [] } };
  const span = 80 / langs.length;
  for (const [i, l] of langs.entries()) verified[l] = verifyExtraction(await extractOne(l, texts[l]!.text, opts, 5 + i * span, span), texts[l]!.text, l);

  opts.onProgress?.('matching the two CVs', 88);
  let align: Alignment = { experience: [], education: [] };
  if (langs.length === 2) {
    const list = (x: Extracted, k: 'experience' | 'education') =>
      x[k].map((e, i) => ('company' in e ? `${i}: ${e.title} | ${e.company} | ${e.start ?? '?'} – ${e.end ?? '?'}` : `${i}: ${e.degree ?? ''} ${e.field ?? ''} | ${e.institution} | ${e.start ?? '?'} – ${e.end ?? '?'}`)).join('\n');
    const { data } = await (opts.chat ?? chatJson)({
      task: 'analyze',
      schema: AlignSchema,
      cache: opts.cache,
      messages: [
        {
          role: 'system',
          content:
            'Two CVs of the same person (Hebrew and English) list the same roles in different languages. Pair entries that describe the SAME role/school ' +
            '(same organization and period, possibly translated). Each index at most once; unmatched entries get null on the other side. ' +
            'Do not judge dates. titleMismatch=true only if the two job titles describe different positions/seniority (not mere translation); explain in note, else note "".',
        },
        {
          role: 'user',
          content: `Hebrew experience:\n${list(verified.he.clean, 'experience')}\n\nEnglish experience:\n${list(verified.en.clean, 'experience')}\n\nHebrew education:\n${list(verified.he.clean, 'education')}\n\nEnglish education:\n${list(verified.en.clean, 'education')}`,
        },
      ],
    });
    align = data;
  }

  const links = [...new Set(langs.flatMap((l) => texts[l]!.links))];
  const merged = mergeProfiles({ he: verified.he.clean, en: verified.en.clean, heText: texts.he?.text ?? '', enText: texts.en?.text ?? '', links }, align);
  // with a single CV, "only in one CV" notes are meaningless
  const conflicts = langs.length === 2 ? merged.conflicts : merged.conflicts.filter((c) => c.kind !== 'only_in_one');
  merged.profile.meta = { generatedAt: new Date().toISOString(), sources: Object.fromEntries(langs.map((l) => [l, `cv-${l}.pdf`])) };
  const missed = langs.flatMap((l) => uncoveredDateLines(texts[l]!.text, verified[l].clean).map((line) => ({ lang: l, line })));
  opts.onProgress?.('done', 100);
  return {
    profile: merged.profile,
    conflicts,
    dropped: [...verified.he.dropped, ...verified.en.dropped],
    missed,
    texts: Object.fromEntries(langs.map((l) => [l, texts[l]!.text])),
  };
}
