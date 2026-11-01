import { config } from '../config.js';
import { log } from '../log.js';
import { getDb } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { buildApp } from './app.js';
import { closeContext } from '../browser/session.js';
import { startStartupSessionChecks } from '../pipeline/startup-checks.js';
import { llmReachable, OLLAMA_HELP } from '../llm/reachable.js';

const db = await getDb();
new Repo(db).failOrphanRuns();
const app = buildApp(db);
await app.listen({ host: '127.0.0.1', port: config.PORT });
log.info({ url: `http://127.0.0.1:${config.PORT}`, dryRun: config.DRY_RUN }, 'JobHunter API listening');
// the scoring model: not there → said now, not at the first job (the dashboard offers to start it)
void llmReachable().then((r) => {
  if (!r.ok) log.warn(`${r.reason} — scoring waits. Start it from the dashboard (the LLM badge → "Start Ollama"), or ${OLLAMA_HELP}.`);
});
// each enabled site's login, checked in the background (the header shows it instead of "login unknown")
startStartupSessionChecks(db);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeContext().finally(() => process.exit(0));
  });
}
