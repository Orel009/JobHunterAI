import type { Prefs } from '../core/prefs.js';

/** The CV names (exactly as the site lists them) for a site: Drushim uses cv.he / cv.en, JobMaster and Jobnet their own. */
export function cvNamesFor(site: string, prefs: Pick<Prefs, 'cv' | 'jobmaster' | 'jobnet'>): { he: string; en: string; where: string } {
  if (site === 'jobmaster') return { ...prefs.jobmaster.cv, where: 'jobmaster.cv.he / jobmaster.cv.en (Preferences → JobMaster)' };
  if (site === 'jobnet') return { ...prefs.jobnet.cv, where: 'jobnet.cv.he / jobnet.cv.en (Preferences → Jobnet)' };
  return { he: prefs.cv.he, en: prefs.cv.en, where: 'cv.he / cv.en (Preferences)' };
}
