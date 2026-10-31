/**
 * Draft hallucination comparison (section 4 of model:bench; also runnable alone: npm run bench:drafts).
 * before = Phase 1 free-text prompt; after = Phase 2 pipeline (hard rule → pending, else fact-cited draft + post-check).
 * Both outputs are judged by the same verification pass against ALL profile facts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { ollamaChat } from '../llm/ollama.js';
import { listFacts, loadProfile } from '../profile/facts.js';
import { ProfileSchema, type Profile } from '../profile/schema.js';
import { judgeClaims, makeDrafter } from '../apply/draft.js';
import { resolveField } from '../apply/resolve.js';
import type { FormField } from '../apply/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface BenchQ {
  q: string;
  type: string;
}

const OLD_WRITE_SYSTEM = [
  'אתה כותב תשובות לשאלוני מועמדות למשרות בשם המועמד, בגוף ראשון.',
  'המועמד הוא גבר: השתמש בלשון זכר תקנית (למשל "אני מגיע", "עבדתי", "אני מתעניין").',
  'השתמש אך ורק בעובדות שמופיעות בפרופיל. אם חסר מידע — אל תמציא; כתוב תשובה כללית יותר או ציין שאפרט בראיון.',
  'עברית טבעית, תקנית וזורמת. 2-4 משפטים לשאלות פתוחות, תשובה קצרה לשאלות סגורות. החזר רק את נוסח התשובה.',
].join('\n');

/** profile.json → profile.draft.json (CONFLICT values nulled) → fictional sample. */
export function benchProfile(sample: Record<string, unknown>): { profile: Profile; source: string } {
  const real = loadProfile();
  if (real) return { profile: real, source: 'data/profile/profile.json' };
  const draftFile = path.join(config.paths.profileDir, 'profile.draft.json');
  if (fs.existsSync(draftFile)) {
    const raw = fs.readFileSync(draftFile, 'utf8').replace(/"CONFLICT [^"]*"/g, 'null');
    return { profile: ProfileSchema.parse(JSON.parse(raw)), source: 'data/profile/profile.draft.json (not yet reviewed)' };
  }
  const s = sample as { fullName: string; city: string; skills: string[]; experience: Array<{ company: string; role: string; years: string; highlights: string[] }> };
  const skills = s.skills.map((n) => ({ id: `skill.${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: n }));
  const [from, to] = (s.experience[0]?.years ?? '').split('-');
  return {
    profile: ProfileSchema.parse({
      contact: { name: { he: s.fullName }, city: { he: s.city } },
      experience: s.experience.map((e, i) => ({
        id: `exp.sample${i}`, company: { he: e.company }, title: { en: e.role }, start: from ?? null, end: to ?? null,
        skills: skills.map((k) => k.id), highlights: { he: e.highlights },
      })),
      skills,
    }),
    source: 'fictional sample profile (bench/questions.json)',
  };
}

const benchType = (t: string): FormField['type'] => (t === 'yes_no' || t === 'textarea' || t === 'number' || t === 'choice' ? t : 'text');

export async function runDraftComparison(): Promise<{ markdown: string; before: number; after: number }> {
  const data = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'bench', 'questions.json'), 'utf8')) as { sampleProfile: Record<string, unknown>; questions: BenchQ[] };
  const job = (JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'bench', 'jobs.json'), 'utf8')) as Array<{ title: string; descriptionText: string; requirementsText: string }>)[0]!;
  const { profile, source } = benchProfile(data.sampleProfile);
  const facts = listFacts(profile);
  const profileText = facts.map((f) => `- ${f.text}`).join('\n');
  const drafter = makeDrafter(profile);
  const rows: string[] = [];
  let before = 0;
  let after = 0;

  for (const q of data.questions) {
    const field: FormField = { key: 'q', label: q.q, type: benchType(q.type), required: true };
    // before
    const old = await ollamaChat({
      model: config.OLLAMA_MODEL_WRITE,
      think: false,
      options: { temperature: 0.3, num_ctx: 8192 },
      messages: [
        { role: 'system', content: OLD_WRITE_SYSTEM },
        { role: 'user', content: `פרופיל המועמד:\n${profileText}\n\nמשרה: ${job.title}\n\nשאלה (${q.type}): ${q.q}` },
      ],
    });
    const oldText = old.message?.content?.trim() ?? '';
    const oldClaims = oldText ? await judgeClaims(oldText, facts) : [];
    before += oldClaims.length;

    // after
    const r = await resolveField(field, {
      profile,
      bank: { byKey: () => null, active: () => [] },
      matchBank: async () => ({ entryId: null, confidence: 0 }),
      draft: drafter,
      minConfidence: 0.85,
      job: { title: job.title, text: `${job.title}\n${job.descriptionText}\n${job.requirementsText}`, language: 'he' },
    });
    const newText = r.status === 'draft' || r.status === 'resolved' ? (r.value ?? '') : '';
    const newClaims = r.status === 'draft' && newText ? await judgeClaims(newText, facts) : [];
    after += newClaims.length;
    const afterCell =
      r.status === 'draft'
        ? `draft: ${newText}${r.provenance.usedFactIds?.length ? ` _[cites ${r.provenance.usedFactIds.join(', ')}]_` : ''}`
        : r.status === 'resolved'
          ? `resolved (${r.provenance.source}): ${newText} _${r.provenance.detail ?? ''}_`
          : `**${r.status}** — ${r.reason ?? ''}`;
    rows.push(
      `### ${q.q} (${q.type})`,
      '',
      '<div dir="rtl">',
      '',
      `**before** (${oldClaims.length} unsupported): ${oldText.replace(/\n+/g, ' ')}`,
      oldClaims.length ? `\n> ❌ ${oldClaims.join(' · ')}` : '',
      '',
      `**after** (${newClaims.length} unsupported): ${afterCell.replace(/\n+/g, ' ')}`,
      newClaims.length ? `\n> ⚠️ flagged: ${newClaims.join(' · ')}` : '',
      '',
      '</div>',
      '',
    );
    process.stdout.write('d');
  }
  process.stdout.write('\n');
  const markdown = [
    `## 4. Draft hallucinations — Phase 1 prompt vs Phase 2 pipeline (${config.OLLAMA_MODEL_WRITE})`,
    '',
    `Profile: ${source}. Judge: ${config.OLLAMA_MODEL_ANALYZE} verification pass against all ${facts.length} profile facts.`,
    '',
    `| | unsupported claims (10 questions) |`,
    `|---|---|`,
    `| before (free-text prompt) | **${before}** |`,
    `| after (hard rule + cited drafts) | **${after}** |`,
    '',
    ...rows,
  ].join('\n');
  return { markdown, before, after };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { markdown, before, after } = await runDraftComparison();
  const out = path.join(config.paths.reports, `draft-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(out, markdown);
  console.log(`unsupported claims: before=${before} after=${after}\nreport: ${out}`);
}
