import type { SiteAdapter, SiteId } from './types.js';
import { drushim } from './drushim/adapter.js';

export const adapters: Partial<Record<SiteId, SiteAdapter>> = { drushim };

/** Known sites in priority order; not-yet-built ones are listed so the UI can show them disabled. */
export const SITES: Array<{ id: SiteId; displayName: string; loginUrl: string; enabled: boolean }> = [
  { id: 'drushim', displayName: 'Drushim', loginUrl: 'https://www.drushim.co.il/', enabled: true },
  { id: 'alljobs', displayName: 'AllJobs', loginUrl: 'https://www.alljobs.co.il/', enabled: false },
  { id: 'jobmaster', displayName: 'JobMaster', loginUrl: 'https://www.jobmaster.co.il/', enabled: false },
];

export function getAdapter(id: string): SiteAdapter {
  const a = adapters[id as SiteId];
  if (!a) throw new Error(`No adapter for site "${id}" (yet)`);
  return a;
}
