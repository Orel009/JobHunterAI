/**
 * npm run discover -- <site> [discover|score|full]
 * Same pipeline as the dashboard button, from the terminal (don't run while the server is running a job).
 */
import { getDb } from '../db/index.js';
import { runToCompletion, type RunKind } from '../pipeline/runner.js';

const [site = 'drushim', kind = 'full'] = process.argv.slice(2);
if (!['discover', 'score', 'full'].includes(kind)) {
  console.error('usage: npm run discover -- <site> [discover|score|full]');
  process.exit(1);
}
const db = await getDb();
process.on('SIGINT', async () => {
  const { stopRun } = await import('../pipeline/runner.js');
  stopRun();
});
await runToCompletion(db, site, kind as RunKind);
process.exit(0);
