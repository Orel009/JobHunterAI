import type { Prefs } from '../core/prefs.js';

/** The CV names (exactly as the site lists them) for a site: Drushim uses cv.he / cv.en, JobMaster its own. */
export function cvNamesFor(site: string, prefs: Pick<Prefs, 'cv' | 'jobmaster'>): { he: string; en: string; where: string } {
  if (site === 'jobmaster') return { ...prefs.jobmaster.cv, where: 'jobmaster.cv.he / jobmaster.cv.en (Preferences → JobMaster)' };
  return { he: prefs.cv.he, en: prefs.cv.en, where: 'cv.he / cv.en (Preferences)' };
}
