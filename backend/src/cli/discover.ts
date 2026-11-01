/**
 * npm run discover -- <site> [discover|score|full|enrich] [--roles id,id]   (enrich = details + score, no searching;
 *   --roles: search only those role types' queries)
 * npm run discover -- --companies [score]   the companies-only run (read the lists → prefilter → score → Greenhouse
 *   answers; "score": no list is read)
 * Same pipeline as the dashboard button, from the terminal (don't run while the server is running a job).
 */
import { getDb } from '../db/index.js';
import { runToCompletion, type RunKind } from '../pipeline/runner.js';

const args = process.argv.slice(2);
const rolesAt = args.indexOf('--roles');
const onlyRoles = rolesAt >= 0 ? (args[rolesAt + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const [site = 'drushim', kind = 'full'] = args.filter((a, i) => !a.startsWith('--') && (rolesAt < 0 || i !== rolesAt + 1));
if (!['discover', 'score', 'full', 'enrich'].includes(kind)) {
  console.error('usage: npm run discover -- <site> [discover|score|full|enrich]');
  process.exit(1);
}
const db = await getDb();
if (args.includes('--companies')) {
  const { runCompaniesToCompletion } = await import('../companies/run.js');
  const r = await runCompaniesToCompletion(db, { fetch: !args.includes('score') });
  for (const c of r?.companies ?? []) {
    console.log(`${c.name} (${c.ats}): read ${c.read ?? '-'} · in Israel ${c.israel ?? '-'} · in your locations ${c.inLocations ?? '-'} · new ${c.added} · scored ${c.scored} · answers ${c.answersPrepared} · ready ${c.ready}${c.error ? ` · ${c.error}` : ''}`);
    for (const s of c.skipped) console.log(`   skipped ${s.count} × ${s.reason} — e.g. ${s.examples.join(' | ')}`);
  }
  process.exit(0);
}
process.on('SIGINT', async () => {
  const { stopRun } = await import('../pipeline/runner.js');
  stopRun();
});
await runToCompletion(db, site, kind as RunKind, { onlyRoles });
process.exit(0);
