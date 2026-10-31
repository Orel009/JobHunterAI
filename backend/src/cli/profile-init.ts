/**
 * npm run profile:init
 * data/profile/cv-he.pdf + cv-en.pdf → data/profile/profile.draft.json + profile.conflicts.md
 * The LLM only extracts; every fact is verified against the CV text, and contradictions are listed, never resolved.
 * Review the draft, resolve the conflicts, then rename it to profile.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { config } from '../config.js';
import { chatJson } from '../llm/ollama.js';
import { pdfToText } from '../profile/pdf.js';
import {
  AlignSchema,
  ExtractSchema,
  conflictsMarkdown,
  mergeProfiles,
  uncoveredDateLines,
  verifyExtraction,
  type Extracted,
  type Lang,
} from '../profile/merge.js';
import { ProfileSchema } from '../profile/schema.js';

const dir = config.paths.profileDir;
const files: Record<Lang, string> = { he: path.join(dir, 'cv-he.pdf'), en: path.join(dir, 'cv-en.pdf') };
for (const f of Object.values(files)) {
  if (!fs.existsSync(f)) {
    console.error(`missing ${f}`);
    process.exit(1);
  }
}
const model = config.OLLAMA_MODEL_ANALYZE;

const EXTRACT_SYSTEM = [
  'You extract facts from ONE CV into JSON. Rules:',
  '- Copy text exactly as written in the CV, in the CV\'s language. Do NOT translate, rephrase, summarize, or add anything.',
  '- Only include facts that are explicitly written in the CV. If something is not written, use null or an empty list.',
  '- Dates: convert to "YYYY-MM" or "YYYY" exactly as precise as the CV; ongoing roles end with "present".',
  '- experience: every job, army service (kind "military"), volunteering, or significant project section, in CV order.',
  '  skills = technologies explicitly named inside that role\'s text. highlights = that role\'s bullet points copied verbatim.',
  '- skills: every technology/skill named anywhere in the CV, each listed ONCE (no repeats). statedYears ONLY when the CV explicitly states a number of years for that skill; otherwise null. Never compute years.',
  '- education: degrees, diplomas, courses with institution names.',
  '- languages: spoken languages with the level as written.',
].join('\n');

/** Three focused calls: bigger combined calls silently skipped entries (e.g. a second school) and could time out. */
async function extract(lang: Lang, text: string): Promise<Extracted> {
  const t0 = Date.now();
  const user = `CV (${lang === 'he' ? 'Hebrew' : 'English'}):\n"""\n${text}\n"""`;
  const call = <T extends z.ZodType>(schema: T, focus: string) =>
    chatJson({
      model,
      schema,
      numCtx: 16384,
      messages: [
        { role: 'system', content: `${EXTRACT_SYSTEM}\n\nThis pass: ${focus}` },
        { role: 'user', content: user },
      ],
    });
  const a = await call(ExtractSchema.pick({ name: true, city: true, summary: true, experience: true }), 'name, city, summary and EVERY experience entry (jobs, army service, projects).');
  const b = await call(ExtractSchema.pick({ education: true, languages: true }), 'EVERY education entry (each degree/diploma/course line) and every spoken language.');
  const c = await call(ExtractSchema.pick({ skills: true }), 'every skill/technology named anywhere in the CV.');
  const data: Extracted = { ...a.data, ...b.data, ...c.data };
  console.log(`extracted ${lang}: ${data.experience.length} roles, ${data.education.length} education, ${data.skills.length} skills (${Date.now() - t0} ms)`);
  return data;
}

console.log(`model: ${model}`);
const he = await pdfToText(files.he);
const en = await pdfToText(files.en);
fs.writeFileSync(path.join(dir, 'cv-he.txt'), he.text);
fs.writeFileSync(path.join(dir, 'cv-en.txt'), en.text);

const vHe = verifyExtraction(await extract('he', he.text), he.text, 'he');
const vEn = verifyExtraction(await extract('en', en.text), en.text, 'en');

const list = (x: Extracted, k: 'experience' | 'education') =>
  x[k].map((e, i) => ('company' in e ? `${i}: ${e.title} | ${e.company} | ${e.start ?? '?'} – ${e.end ?? '?'}` : `${i}: ${e.degree ?? ''} ${e.field ?? ''} | ${e.institution} | ${e.start ?? '?'} – ${e.end ?? '?'}`)).join('\n');
const { data: align } = await chatJson({
  model,
  schema: AlignSchema,
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
      content: `Hebrew experience:\n${list(vHe.clean, 'experience')}\n\nEnglish experience:\n${list(vEn.clean, 'experience')}\n\nHebrew education:\n${list(vHe.clean, 'education')}\n\nEnglish education:\n${list(vEn.clean, 'education')}`,
    },
  ],
});

const links = [...new Set([...he.links, ...en.links])];
const { profile, conflicts } = mergeProfiles({ he: vHe.clean, en: vEn.clean, heText: he.text, enText: en.text, links }, align);
profile.meta = { generatedAt: new Date().toISOString(), sources: { he: 'cv-he.pdf', en: 'cv-en.pdf' }, model };

// sanity: everything except CONFLICT placeholders must already fit the schema
const check = ProfileSchema.safeParse(JSON.parse(JSON.stringify(profile).replace(/"CONFLICT [^"]*"/g, 'null')));
if (!check.success) console.warn('draft does not fit the schema yet:', check.error.issues.slice(0, 5));

fs.writeFileSync(path.join(dir, 'profile.draft.json'), JSON.stringify(profile, null, 2));
const missed = [
  ...uncoveredDateLines(he.text, vHe.clean).map((line) => ({ lang: 'he' as const, line })),
  ...uncoveredDateLines(en.text, vEn.clean).map((line) => ({ lang: 'en' as const, line })),
];
fs.writeFileSync(path.join(dir, 'profile.conflicts.md'), conflictsMarkdown(conflicts, [...vHe.dropped, ...vEn.dropped], missed));
console.log(
  `\nwrote ${path.join(dir, 'profile.draft.json')}\n      ${path.join(dir, 'profile.conflicts.md')}\n` +
    `${profile.experience.length} roles, ${profile.education.length} education, ${profile.skills.length} skills; ` +
    `${conflicts.filter((c) => c.kind === 'contradiction').length} contradictions, ${conflicts.filter((c) => c.kind !== 'contradiction').length} other notes, ` +
    `${vHe.dropped.length + vEn.dropped.length} dropped facts, ${missed.length} possibly missed lines.\nReview, resolve, then rename to profile.json.`,
);
