/**
 * Scores what is waiting, per site — used right after the profile is approved, so jobs discovered without a profile
 * get scored without another click. Starts now, or right after the current run.
 */
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { log } from '../log.js';
import { adapters } from '../sites/registry.js';
import { linkedInEnabled } from '../linkedin/settings.js';
import { startLinkedInRun } from './linkedin-run.js';
import { startRun, startWhenIdle } from './runner.js';

export function scorePending(db: DB): { jobs: number; sites: string[]; queued: boolean } {
  const todo = new Repo(db).jobsNeedingScore();
  const sites = [...new Set(todo.map((j) => j.site))].filter((s) => (s === 'linkedin' ? linkedInEnabled() : s in adapters));
  let queued = false;
  for (const site of sites) {
    const how = startWhenIdle(() => void (site === 'linkedin' ? startLinkedInRun(db, 'score') : startRun(db, site, 'score')));
    queued ||= how === 'queued';
  }
  if (sites.length) log.info({ jobs: todo.length, sites, queued }, 'profile approved — scoring the waiting jobs');
  return { jobs: todo.length, sites, queued };
}
