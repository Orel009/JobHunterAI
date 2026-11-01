import type { Prefs } from '../core/prefs.js';

/** The CV names (exactly as the site lists them) for a site: Drushim uses cv.he / cv.en, JobMaster, Jobnet and JobKarov their own. */
export function cvNamesFor(site: string, prefs: Pick<Prefs, 'cv' | 'jobmaster' | 'jobnet' | 'jobkarov'>): { he: string; en: string; where: string } {
  if (site === 'jobmaster') return { ...prefs.jobmaster.cv, where: 'jobmaster.cv.he / jobmaster.cv.en (Preferences → JobMaster)' };
  if (site === 'jobnet') return { ...prefs.jobnet.cv, where: 'jobnet.cv.he / jobnet.cv.en (Preferences → Jobnet)' };
  if (site === 'jobkarov') return { ...prefs.jobkarov.cv, where: 'jobkarov.cv.he / jobkarov.cv.en (Preferences → JobKarov)' };
  return { he: prefs.cv.he, en: prefs.cv.en, where: 'cv.he / cv.en (Preferences)' };
}
