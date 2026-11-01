/**
 * npm run discover -- <site> [discover|score|full|enrich] [--roles id,id]   (enrich = details + score, no searching;
 *   --roles: search only those role types' queries)
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
process.on('SIGINT', async () => {
  const { stopRun } = await import('../pipeline/runner.js');
  stopRun();
});
await runToCompletion(db, site, kind as RunKind, { onlyRoles });
process.exit(0);
