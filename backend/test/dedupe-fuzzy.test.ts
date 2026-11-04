/**
 * The same company and the same title, loosely: case, spaces, punctuation and legal forms ("voicespin" = "Voice Spin"),
 * a Hebrew spelling vs an English one ("וויס ספין"), job codes and ids in the title ("JB-96", "- 1124314", direction
 * marks) — without merging different requisitions or another seniority.
 */
import { describe, expect, it } from 'vitest';
import { companyKey, companySkeletons, groupSameJobs, sameCompany, sameTitle, titleCode, titleKey } from '../src/core/dedupe.js';
import { normalizeCompany, normalizeTitle } from '../src/core/text.js';

const C = normalizeCompany;
const T = normalizeTitle;

describe('the same company', () => {
  it.each([
    ['voicespin', 'Voice Spin'],
    ['VoiceSpin Ltd.', 'Voice-Spin'],
    ['U.C.L Group', 'Ucl Group'],
    ['Red C. H.R', 'Red C HR'],
    ['קבוצת HOT', 'HOT'],
    ['אלביט מערכות בע"מ', 'אלביט מערכות'],
    ['Intel Israel', 'Intel'],
  ])('%s = %s', (a, b) => {
    expect(sameCompany(C(a), C(b))).toBe(true);
  });
  it.each([
    ['Voice Spin', 'וויס ספין'],
    ['R.Y.B. PLACEMENT AGENCY', 'אר.ויי.בי. פלסמנט אגנסי בע"מ'],
    ['Check Point', "צ'ק פוינט"],
    ['Elbit', 'אלביט'],
    ['Amdocs', 'אמדוקס'],
    ['Matrix', 'מטריקס'],
    ['Priority', 'פריוריטי'],
  ])('Hebrew / English spelling: %s = %s', (a, b) => {
    expect(sameCompany(C(a), C(b))).toBe(true);
  });
  it.each([
    ['Voice Spin', 'Voice Spark'],
    ['Elbit', 'Elad'],
    ['Ness', 'נס'], // too short to compare across scripts
    ['- חסוי -', '- חסוי -'],
    ['', ''],
  ])('%s ≠ %s', (a, b) => {
    expect(sameCompany(C(a), C(b))).toBe(false);
  });
  it('the key and the skeletons', () => {
    expect(companyKey('Voice Spin Ltd')).toBe('voicespin');
    expect(companySkeletons('Voice Spin')).toEqual({ script: 'en', skeletons: ['PSPN'] });
    expect(companySkeletons('וויס ספין')).toEqual({ script: 'he', skeletons: ['PSPN'] });
  });
});

describe('the same title', () => {
  it('job codes, trailing ids and direction marks are ignored', () => {
    expect(titleKey('Forward Deployed Engineer (AI) - JB-96')).toBe('forward deployed engineer ai');
    expect(titleCode('Forward Deployed Engineer (AI) - JB-96')).toBe('96 jb');
    expect(titleKey('מפתח/ת Full Stack לפיתוח מוצר מקצה לקצה -היברידי - 1124314')).toBe('מפתח full stack לפיתוח מוצר מקצה לקצה היברידי');
    expect(sameTitle(T('איש /אשת תמיכה טכנית למוצרים בסביבת Linux‏'), T('איש /אשת תמיכה טכנית למוצרים בסביבת Linux'))).toBe(true);
    expect(sameTitle(T('Forward Deployed Engineer (AI) - JB-96'), T('Forward Deployed Engineer (AI)'))).toBe(true);
    expect(sameTitle(T('AI Software Engineer - 155666 01/11'), T('AI Software Engineer'))).toBe(true);
    expect(sameTitle(T('Salesforce Developer - 533377'), T('Salesforce Developer'))).toBe(true);
  });
  it('spacing, word order, one extra word with 4+ in common', () => {
    expect(sameTitle(T('Full Stack Developer'), T('FullStack Developer'))).toBe(true);
    expect(sameTitle(T('Developer Full Stack'), T('Full Stack Developer'))).toBe(true);
    expect(sameTitle(T('לחברת בלורן דרוש/ה נציג/ת שירות לקוחות - משרה היברידית'), T('לחברת בלורן דרוש/ה נציג/ת שירות לקוחות ראשלצ - משרה היברידית'))).toBe(true);
  });
  it('two different codes are two requisitions; another seniority is another job; a different word is another job', () => {
    expect(sameTitle(T('Angular Developer - 533313'), T('Angular Developer - 533761'))).toBe(false);
    expect(sameTitle(T('Forward Deployed Engineer - JB-96'), T('Forward Deployed Engineer - JB-97'))).toBe(false);
    expect(sameTitle(T('Backend Developer Python Data Team'), T('Senior Backend Developer Python Data Team'))).toBe(false);
    expect(sameTitle(T('Backend Developer'), T('Frontend Developer'))).toBe(false);
    expect(sameTitle(T('QA Automation Engineer Mobile'), T('QA Automation Engineer'))).toBe(false); // only 3 words in common
  });
});

describe('groups', () => {
  it('Voice Spin on two sites is one group; the anonymous company never groups', () => {
    const rows = [
      { id: '14', companyNorm: C('voicespin'), titleNorm: T('איש /אשת תמיכה טכנית למוצרים בסביבת Linux‏') },
      { id: '31', companyNorm: C('Voice Spin'), titleNorm: T('איש /אשת תמיכה טכנית למוצרים בסביבת Linux') },
      { id: 'a', companyNorm: C('- חסוי -'), titleNorm: T('Full Stack') },
      { id: 'b', companyNorm: C('- חסוי -'), titleNorm: T('Full Stack') },
    ];
    expect(groupSameJobs(rows).map((g) => g.map((r) => r.id).sort())).toEqual([['14', '31']]);
  });
});
