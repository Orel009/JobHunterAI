import { describe, expect, it } from 'vitest';
import { experienceInput, extractRequiredYears } from '../src/core/experience.js';

/** Realistic (sanitized) requirement lines → expected required years (null = none required). */
const CASES: Array<[string, number | null]> = [
  // English
  ['3+ years of experience in backend development', 3],
  ['At least 2 years of experience with React', 2],
  ['2-4 years of experience as a software engineer', 2],
  ['Minimum of five years of experience in C#', 5],
  ['Over 4 years of experience in software development', 4],
  ['2+ yrs exp in Python', 2],
  ['5 years of experience in Java - an advantage', null],
  ['Experience with AWS - a plus (2 years)', null],
  ['Nice to have: 3 years of Kubernetes', null],
  ["Bachelor's degree in Computer Science", null],
  ['Junior developer, 0-1 years of experience', 0],
  // Hebrew
  ['ניסיון של 3 שנים לפחות בפיתוח Full Stack - חובה', 3],
  ['לפחות שנתיים ניסיון בפיתוח צד שרת', 2],
  ['ניסיון של שנה-שנתיים בפיתוח Web', 1],
  ['3-5 שנות ניסיון בפיתוח .NET', 3],
  ['+3 שנים ניסיון ב-Node.js', 3],
  ['ניסיון של שלוש שנים לפחות בעבודה עם SQL', 3],
  ['ניסיון של ארבע שנים ב-Angular - יתרון משמעותי', null],
  ['ניסיון של שנה לפחות בפיתוח', 1],
  ['ניסיון: 3-4 שנים', 3],
  ['שנתיים-שלוש ניסיון בפיתוח React', 2],
  ['ניסיון של חמש שנים לפחות ב-Python וניסיון של שנתיים ב-Django', 5],
  ['ניסיון בפיתוח Node.js - חובה', null],
  ['החברה פועלת כבר 30 שנה ומונה 200 עובדים', null],
  ['ניסיון של 2 שנים ב-React; ניסיון של 6 שנים ב-Java - יתרון', 2],
  ['ללא ניסיון / בוגרי קורס מוזמנים', null],
  // several requirements → the highest minimum
  ['2 years of experience in software development\n4+ years of experience with React', 4],
  ['ניסיון של שנתיים לפחות בפיתוח תוכנה\nניסיון של 4 שנים ב-React - חובה', 4],
];

describe('extractRequiredYears', () => {
  it.each(CASES)('%s → %s', (line, expected) => {
    expect(extractRequiredYears(line).requiredYears).toBe(expected);
  });

  it('keeps the matched clause as provenance', () => {
    const r = extractRequiredYears('ידע ב-Docker\nניסיון של 3 שנים לפחות בפיתוח Full Stack - חובה');
    expect(r.text).toBe('ניסיון של 3 שנים לפחות בפיתוח Full Stack - חובה');
    expect(r.matches.map((m) => m.min)).toEqual([3]);
  });

  it('detects junior / entry-level signals', () => {
    expect(extractRequiredYears('ללא ניסיון / בוגרי קורס מוזמנים').juniorText).toMatch(/ללא ניסיון/);
    expect(extractRequiredYears('Junior developer, 0-1 years of experience').juniorText).toMatch(/Junior/);
    expect(extractRequiredYears('מתאים לסטודנטים').juniorText).toMatch(/סטודנטים/);
    expect(extractRequiredYears('ניסיון של 3 שנים').juniorText).toBeNull();
  });

  it('reads the site experience field from raw', () => {
    expect(extractRequiredYears(experienceInput({ requirementsText: '', descriptionText: 'תיאור', raw: { experience: '3-4 שנים' } })).requiredYears).toBe(3);
  });
});
