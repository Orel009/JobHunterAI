import { describe, expect, it } from 'vitest';
import { containsKeyword, detectLanguage, htmlToText, isAnonymousCompany, normalizeCompany, normalizeText, normalizeTitle } from '../src/core/text.js';

describe('htmlToText', () => {
  it('keeps line breaks and decodes entities', () => {
    expect(htmlToText('שורה&nbsp;1<br/>-ניסיון &amp; ידע<br/><br/><br/>סוף')).toBe('שורה 1\n-ניסיון & ידע\n\nסוף');
  });
  it('handles empty input', () => {
    expect(htmlToText(null)).toBe('');
  });
});

describe('normalizeText / normalizeTitle', () => {
  it('strips Hebrew gender markers', () => {
    expect(normalizeText('מפתח/ת Full-Stack')).toBe('מפתח full stack');
    expect(normalizeText('מפתח.ת Siebel')).toBe('מפתח siebel');
    expect(normalizeText('מנהל/ת מוצר')).toBe('מנהל מוצר');
  });
  it('normalizes titles across sites to the same key', () => {
    expect(normalizeTitle('דרוש/ה מפתח/ת Full Stack')).toBe(normalizeTitle('מפתח Full-Stack'));
  });
  it('keeps C# / C++', () => {
    expect(normalizeText('מפתח C# ו-C++')).toContain('c#');
  });
});

describe('company', () => {
  it('drops legal suffixes and flags anonymous companies', () => {
    expect(normalizeCompany('אלביט מערכות בע"מ')).toBe('אלביט מערכות');
    expect(isAnonymousCompany(normalizeCompany('חסוי'))).toBe(true);
  });
});

describe('containsKeyword', () => {
  it('uses word boundaries for short latin words', () => {
    expect(containsKeyword(normalizeText('QA Engineer'), 'qa')).toBe(true);
    expect(containsKeyword(normalizeText('Aqua systems'), 'qa')).toBe(false);
  });
  it('whole words only (inflections must be listed), Hebrew prefix letters tolerated', () => {
    expect(containsKeyword(normalizeText('מפתחת בכירה'), 'בכיר')).toBe(false);
    expect(containsKeyword(normalizeText('מפתחת בכירה'), 'בכירה')).toBe(true);
    expect(containsKeyword(normalizeText('דרוש/ה לראש צוות'), 'ראש צוות')).toBe(true);
  });
});

it('detectLanguage', () => {
  expect(detectLanguage('דרוש מפתח React')).toBe('he');
  expect(detectLanguage('Senior Backend Engineer, Python')).toBe('en');
});
