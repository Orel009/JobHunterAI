/**
 * In-app scheduler (while JobHunter runs; OFF by default — Settings → Schedule): starts a hunt at the configured
 * times on the configured days, never inside quiet hours, never while another run is active (it keeps trying for a
 * few minutes after the slot, then skips it).
 */
import type { DB } from '../db/index.js';
import { log } from '../log.js';
import { runHunt, huntRunning } from './hunt.js';
import { getActiveRun } from './runner.js';
import { dueSlot, scheduleSettings } from './schedule.js';

export function startScheduler(db: DB, everyMs = 30_000): () => void {
  const ran = new Set<string>();
  const tick = () => {
    const s = scheduleSettings();
    if (!s.enabled) return;
    const slot = dueSlot(new Date(), s, ran);
    if (!slot || getActiveRun() || huntRunning()) return;
    ran.add(slot);
    log.info({ slot }, 'scheduled hunt starting');
    void runHunt(db, { trigger: 'schedule' }).catch((e: unknown) => log.error({ slot, err: e instanceof Error ? e.message : String(e) }, 'scheduled hunt failed'));
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
