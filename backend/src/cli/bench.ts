/**
 * npm run model:bench
 * Runs the same Hebrew tasks through every model in BENCH_MODELS and writes a side-by-side markdown report
 * to data/reports/model-bench-<timestamp>.md:
 *   1. answers-bank matching (analyze): {entryId, confidence} vs expected
 *   2. free-text drafts (write): Hebrew, male first person, profile facts only
 *   3. job scoring (analyze): structured JSON validity + latency
 *   4. draft hallucinations: Phase 1 free-text prompt vs Phase 2 pipeline (WRITE model)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from '../config.js';
import { chatJson, listLocalModels, ollamaChat } from '../llm/ollama.js';
import { buildScoreMessages, ScoreSchema } from '../llm/score.js';
import { runDraftComparison } from './bench-drafts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const benchDir = path.join(here, '..', '..', 'bench');
const data = JSON.parse(fs.readFileSync(path.join(benchDir, 'questions.json'), 'utf8')) as {
  sampleProfile: unknown;
  sampleBank: Array<{ id: number; question: string; answer: string }>;
  questions: Array<{ q: string; type: string; expectedEntryId: number | null }>;
};
const jobs = JSON.parse(fs.readFileSync(path.join(benchDir, 'jobs.json'), 'utf8')) as Array<{
  id: string;
  title: string;
  company: string;
  location: string;
  descriptionText: string;
  requirementsText: string;
}>;

const realProfile = path.join(config.paths.profileDir, 'profile.json');
const profile = fs.existsSync(realProfile) ? fs.readFileSync(realProfile, 'utf8') : JSON.stringify(data.sampleProfile, null, 1);
const profileSource = fs.existsSync(realProfile) ? 'data/profile/profile.json' : 'fictional sample profile (bench/questions.json)';

const MatchSchema = z.object({ entryId: z.number().int().nullable(), confidence: z.number().min(0).max(1) });

const models = config.BENCH_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
const installed = await listLocalModels().catch(() => [] as string[]);
const has = (m: string) => installed.includes(m) || installed.includes(`${m}:latest`);

interface Cell {
  out: string;
  ms: number;
  ok?: boolean;
}
const results: Record<string, { match: Cell[]; write: Cell[]; score: Cell[]; skipped?: string }> = {};
const t = async <T>(fn: () => Promise<T>): Promise<[T | null, number, string?]> => {
  const t0 = Date.now();
  try {
    return [await fn(), Date.now() - t0];
  } catch (e) {
    return [null, Date.now() - t0, e instanceof Error ? e.message : String(e)];
  }
};

const bankList = data.sampleBank.map((b) => `${b.id}: ${b.question}`).join('\n');
const writeSystem = [
  'אתה כותב תשובות לשאלוני מועמדות למשרות בשם המועמד, בגוף ראשון.',
  'המועמד הוא גבר: השתמש בלשון זכר תקנית (למשל "אני מגיע", "עבדתי", "אני מתעניין").',
  'השתמש אך ורק בעובדות שמופיעות בפרופיל. אם חסר מידע — אל תמציא; כתוב תשובה כללית יותר או ציין שאפרט בראיון.',
  'עברית טבעית, תקנית וזורמת. 2-4 משפטים לשאלות פתוחות, תשובה קצרה לשאלות סגורות. החזר רק את נוסח התשובה.',
].join('\n');

for (const model of models) {
  if (!has(model)) {
    results[model] = { match: [], write: [], score: [], skipped: `not pulled (run: ollama pull ${model})` };
    console.log(`skip ${model}: not installed`);
    continue;
  }
  console.log(`== ${model}`);
  const r = (results[model] = { match: [] as Cell[], write: [] as Cell[], score: [] as Cell[] });

  for (const q of data.questions) {
    const [m, ms, err] = await t(() =>
      chatJson({
        model,
        schema: MatchSchema,
        messages: [
          {
            role: 'system',
            content:
              'Match a job-application form question to an existing answers-bank entry with the SAME meaning (same information requested). ' +
              'Return entryId of the matching entry, or null if none asks for the same information. confidence 0-1. Do not write answers.',
          },
          { role: 'user', content: `Bank entries:\n${bankList}\n\nForm question: ${q.q}` },
        ],
      }),
    );
    const ok = m ? m.data.entryId === q.expectedEntryId : false;
    r.match.push({ out: m ? `${m.data.entryId ?? 'null'} (${m.data.confidence.toFixed(2)})` : `ERR ${err}`, ms, ok });
    process.stdout.write(ok ? '.' : 'x');
  }
  process.stdout.write('\n');

  for (const q of data.questions) {
    const [res, ms, err] = await t(() =>
      ollamaChat({
        model,
        think: false,
        options: { temperature: 0.3, num_ctx: 8192 },
        messages: [
          { role: 'system', content: writeSystem },
          { role: 'user', content: `פרופיל המועמד:\n${profile}\n\nמשרה: ${jobs[0]!.title}\n\nשאלה (${q.type}): ${q.q}` },
        ],
      }),
    );
    r.write.push({ out: res?.message?.content?.trim() ?? `ERR ${err}`, ms });
    process.stdout.write('w');
  }
  process.stdout.write('\n');

  for (const job of jobs) {
    const [s, ms, err] = await t(() => chatJson({ model, schema: ScoreSchema, messages: buildScoreMessages(job, profile) }));
    r.score.push({
      out: s ? `**${s.data.score}** · ${s.data.seniorityFit} · ${s.data.reasoningHe}` : `ERR ${err}`,
      ms,
      ok: !!s,
    });
    process.stdout.write('s');
  }
  process.stdout.write('\n');
}

// ---------- report ----------
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
const live = models.filter((m) => !results[m]?.skipped);
const lines: string[] = [];
lines.push(`# Model bench — ${new Date().toLocaleString('he-IL')}`, '');
lines.push(`Profile used: ${profileSource}`, '');
for (const m of models) if (results[m]?.skipped) lines.push(`- **${m}**: skipped — ${results[m]!.skipped}`);
lines.push('', '## Summary', '', '| model | bank-match accuracy | avg match ms | avg draft ms | score JSON valid | avg score ms |', '|---|---|---|---|---|---|');
const avg = (c: Cell[]) => (c.length ? Math.round(c.reduce((a, b) => a + b.ms, 0) / c.length) : 0);
for (const m of live) {
  const r = results[m]!;
  lines.push(`| ${m} | ${r.match.filter((c) => c.ok).length}/${r.match.length} | ${avg(r.match)} | ${avg(r.write)} | ${r.score.filter((c) => c.ok).length}/${r.score.length} | ${avg(r.score)} |`);
}
lines.push('', '## 1. Answers-bank matching (expected → got)', '', `| question | expected | ${live.join(' | ')} |`, `|---|---|${live.map(() => '---').join('|')}|`);
data.questions.forEach((q, i) => {
  lines.push(`| ${esc(q.q)} | ${q.expectedEntryId ?? 'null'} | ${live.map((m) => `${results[m]!.match[i]!.ok ? '✅' : '❌'} ${results[m]!.match[i]!.out}`).join(' | ')} |`);
});
lines.push('', '## 2. Hebrew drafts (check grammar + male gender + no invented facts)', '');
data.questions.forEach((q, i) => {
  lines.push(`### ${q.q}`, '', '<div dir="rtl">', '');
  for (const m of live) lines.push(`**${m}** (${results[m]!.write[i]!.ms} ms):`, '', `> ${esc(results[m]!.write[i]!.out)}`, '');
  lines.push('</div>', '');
});
lines.push('## 3. Job scoring', '');
jobs.forEach((j, i) => {
  lines.push(`### ${j.title} — ${j.company}`, '', '<div dir="rtl">', '');
  for (const m of live) lines.push(`**${m}** (${results[m]!.score[i]!.ms} ms): ${esc(results[m]!.score[i]!.out)}`, '');
  lines.push('</div>', '');
});

console.log('draft comparison…');
const drafts = await runDraftComparison();
lines.push('', drafts.markdown);
console.log(`unsupported claims: before=${drafts.before} after=${drafts.after}`);

const out = path.join(config.paths.reports, `model-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
fs.writeFileSync(out, lines.join('\n'));
console.log(`\nreport: ${out}`);
