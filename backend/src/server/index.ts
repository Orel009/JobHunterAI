import { config } from '../config.js';
import { log } from '../log.js';
import { getDb } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { buildApp } from './app.js';
import { closeContext } from '../browser/session.js';

const db = await getDb();
new Repo(db).failOrphanRuns();
const app = buildApp(db);
await app.listen({ host: '127.0.0.1', port: config.PORT });
log.info({ url: `http://127.0.0.1:${config.PORT}`, dryRun: config.DRY_RUN }, 'JobHunter API listening');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeContext().finally(() => process.exit(0));
  });
}
