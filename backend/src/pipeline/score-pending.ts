/**
 * Scores what is waiting, per site — used right after the profile is approved, so jobs discovered without a profile
 * get scored without another click. Starts now, or right after the current run.
 */
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { log } from '../log.js';
import { adapters } from '../sites/registry.js';
import { isAssistedSite } from '../alerts/assisted.js';
import { sourceEnabled } from '../linkedin/settings.js';
import { ALERTS_RUN_SITE, startEmailAlertsRun } from './linkedin-run.js';
import { startRun, startWhenIdle } from './runner.js';

export function scorePending(db: DB): { jobs: number; sites: string[]; queued: boolean } {
  const todo = new Repo(db).jobsNeedingScore();
  const sites = [...new Set(todo.map((j) => j.site))].filter((s) => (isAssistedSite(s) ? sourceEnabled(s) : s in adapters));
  // one email-alerts run scores every alert source
  const runs = [...new Set(sites.map((s) => (isAssistedSite(s) ? ALERTS_RUN_SITE : s)))];
  let queued = false;
  for (const site of runs) {
    const how = startWhenIdle(() => void (site === ALERTS_RUN_SITE ? startEmailAlertsRun(db, 'score') : startRun(db, site, 'score')));
    queued ||= how === 'queued';
  }
  if (sites.length) log.info({ jobs: todo.length, sites, queued }, 'profile approved — scoring the waiting jobs');
  return { jobs: todo.length, sites, queued };
}
