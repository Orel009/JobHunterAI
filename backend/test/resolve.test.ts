import { describe, expect, it, vi } from 'vitest';
import { resolveField, type ResolveDeps } from '../src/apply/resolve.js';
import { draftAllowed, hardRuleCategory, parseMinYears, questionKey } from '../src/apply/classify.js';
import type { BankEntry } from '../src/apply/bank.js';
import type { FormField } from '../src/apply/types.js';
import { ProfileSchema, type Profile } from '../src/profile/schema.js';

const NOW = new Date('2026-10-31T00:00:00Z');
const profile: Profile = ProfileSchema.parse({
  contact: { name: { he: 'ישראל ישראלי', en: 'Israel Israeli' }, email: 'a@b.co', phone: '050-0000000', city: { he: 'חיפה', en: 'Haifa' } },
  links: [{ id: 'link.linkedin', label: 'linkedin', url: 'https://linkedin.com/in/x' }],
  experience: [
    { id: 'exp.acme', company: { en: 'Acme' }, title: { en: 'Developer' }, start: '2021-01', end: '2024-12', skills: ['skill.react', 'skill.node'] },
    { id: 'exp.beta', company: { en: 'Beta' }, title: { en: 'Developer' }, start: '2023', end: 'present', skills: ['skill.node'] },
  ],
  skills: [
    { id: 'skill.react', name: 'React.js', aliases: ['React 19'] },
    { id: 'skill.node', name: 'Node.js' },
    { id: 'skill.sql', name: 'SQL' },
    { id: 'skill.k8s', name: 'Kubernetes', statedYears: 2 },
  ],
});

const entry = (id: number, question: string, answer: string | null, type: BankEntry['type'] = 'yes_no'): BankEntry => ({
  id, question, normKey: questionKey(question), answer, type, options: null, language: 'he', status: answer ? 'active' : 'pending',
  usageCount: 0, source: 'user', createdAt: '', updatedAt: '', lastUsedAt: null,
});

function deps(over: Partial<ResolveDeps> = {}, bank: BankEntry[] = []) {
  const matchBank = vi.fn(async () => ({ entryId: null as number | null, confidence: 0 }));
  const draft = vi.fn(async () => ({ text: 'טקסט', usedFactIds: ['exp.acme'], unanswerable: false, flaggedClaims: [] as string[] }));
  const d: ResolveDeps = {
    profile,
    bank: { byKey: (k) => bank.find((b) => b.normKey === k) ?? null, active: () => bank.filter((b) => b.status === 'active') },
    matchBank,
    draft,
    classifyYears: async () => ({ kind: 'technology' as const }),
    minConfidence: 0.85,
    job: { title: 'Full Stack', text: 'React Node', language: 'he' },
    now: NOW,
    ...over,
  };
  return { d, matchBank: (over.matchBank ?? matchBank) as ReturnType<typeof vi.fn>, draft: (over.draft ?? draft) as ReturnType<typeof vi.fn> };
}
const f = (label: string, type: FormField['type'] = 'yes_no', required = true): FormField => ({ key: 'k', label, type, required });

describe('classification', () => {
  it('hard-rule categories (Hebrew + English, gender forms)', () => {
    expect(hardRuleCategory('מהן ציפיות השכר שלך?', 'text')).toBe('salary');
    expect(hardRuleCategory('האם הנך זמין/ה לחמש משמרות שבועיות הכוללות גם לילות /סופ"ש?', 'text')).toBe('availability');
    expect(hardRuleCategory('Are you willing to relocate?', 'text')).toBe('relocation');
    expect(hardRuleCategory('Notice period?', 'text')).toBe('notice_period');
    expect(hardRuleCategory('האם יש לך סיווג ביטחוני?', 'text')).toBe('clearance');
    expect(hardRuleCategory('האם שירתת בצה"ל?', 'text')).toBe('military');
    expect(hardRuleCategory('אני מסכים לתנאי השימוש', 'text')).toBe('legal');
    expect(hardRuleCategory('למה אתה מתעניין בתפקיד?', 'textarea')).toBeNull();
  });
  it('drafts only for open text outside every category', () => {
    expect(draftAllowed('למה אתה מתעניין בתפקיד?', 'textarea')).toBe(true);
    expect(draftAllowed('למה אתה מתעניין בתפקיד?', 'yes_no')).toBe(false);
    expect(draftAllowed('ספר על הזמינות שלך', 'textarea')).toBe(false);
    expect(draftAllowed('Which option fits you?', 'choice')).toBe(false);
  });
  it('parses minimum years in Hebrew and English', () => {
    expect(parseMinYears('האם יש לך נסיון בעבודה עם MSSQL כולל כתיבת stored procedures של שלוש שנים לפחות')).toBe(3);
    expect(parseMinYears('האם יש לך לפחות 3 שנות ניסיון ב-React?')).toBe(3);
    expect(parseMinYears('ניסיון של שנתיים לפחות ב-Node.js')).toBe(2);
    expect(parseMinYears('Do you have 5+ years of experience with Python?')).toBe(5);
    expect(parseMinYears('Do you have two years experience in Go?')).toBe(2);
    expect(parseMinYears('האם יש לך רישיון מעל שנתיים?')).toBeNull(); // not an experience question
  });
});

describe('resolution order', () => {
  it('(a) profile mapping wins for contact fields, without touching the bank or LLM', async () => {
    const { d, matchBank } = deps({}, [entry(1, 'טלפון', '999', 'text')]);
    const r = await resolveField(f('טלפון נייד', 'text'), d);
    expect(r).toMatchObject({ status: 'resolved', value: '050-0000000', provenance: { source: 'profile', ref: 'contact.phone' } });
    expect(matchBank).not.toHaveBeenCalled();
  });

  it('(b) exact bank key before the LLM matcher', async () => {
    const { d, matchBank } = deps({}, [entry(7, 'האם את/ה מוכן/ה לעבוד במשמרות?', 'כן')]);
    const r = await resolveField(f('האם אתה מוכן לעבוד במשמרות?'), d);
    expect(r).toMatchObject({ status: 'resolved', value: 'yes', provenance: { source: 'bank', ref: '7', confidence: 1 } });
    expect(matchBank).not.toHaveBeenCalled();
  });

  it('(b) LLM matcher only picks an entry; below the confidence threshold it is ignored', async () => {
    const bank = [entry(3, 'האם יש לך רישיון נהיגה?', 'כן')];
    const hi = deps({ matchBank: vi.fn(async () => ({ entryId: 3, confidence: 0.95 })) }, bank);
    expect(await resolveField(f('רישיון נהיגה בתוקף?'), hi.d)).toMatchObject({ status: 'resolved', value: 'yes', provenance: { source: 'bank', ref: '3' } });
    const lo = deps({ matchBank: vi.fn(async () => ({ entryId: 3, confidence: 0.5 })) }, bank);
    expect(await resolveField(f('רישיון נהיגה בתוקף?'), lo.d)).toMatchObject({ status: 'pending' });
  });

  it('(b) beats (c): a bank answer for a years question is used as-is', async () => {
    const { d } = deps({}, [entry(9, 'האם יש לך לפחות 3 שנות ניסיון ב-React?', 'לא')]);
    expect(await resolveField(f('האם יש לך לפחות 3 שנות ניסיון ב-React?'), d)).toMatchObject({ value: 'no', provenance: { source: 'bank' } });
  });

  it('(c) years from profile skill dates (conservative) — yes / no / count', async () => {
    const { d } = deps();
    // React: exp.acme 2021-01..2024-12 = 48 months = 4.0y
    expect(await resolveField(f('האם יש לך לפחות 3 שנות ניסיון ב-React?'), d)).toMatchObject({ status: 'resolved', value: 'yes', provenance: { source: 'skill_years', ref: 'skill.react' } });
    expect(await resolveField(f('Do you have 5+ years of experience with React?'), d)).toMatchObject({ value: 'no' });
    // Node: union of 2021-01..2024-12 and 2023(→Dec 2023)..present(Oct 2026) = 2021-01..2026-10 = 70 months
    expect(await resolveField(f('כמה שנות ניסיון יש לך ב-Node.js?', 'number'), d)).toMatchObject({ value: '5' });
    // stated years win
    expect(await resolveField(f('האם יש לך שנתיים ניסיון עם Kubernetes?'), d)).toMatchObject({ value: 'yes', provenance: { detail: expect.stringContaining('stated') } });
  });

  it('(c) skill not in profile, or no dates → pending (never guessed)', async () => {
    const { d, draft } = deps();
    expect(await resolveField(f('האם יש לך נסיון בעבודה עם MSSQL של שלוש שנים לפחות'), d)).toMatchObject({ status: 'pending' });
    expect(await resolveField(f('האם יש לך 2 שנות ניסיון ב-SQL?'), d)).toMatchObject({ status: 'pending' }); // SQL has no dated role
    expect(draft).not.toHaveBeenCalled();
  });

  it('(d) drafts only open text questions', async () => {
    const { d, draft } = deps();
    const r = await resolveField(f('למה אתה מתעניין בתפקיד הזה?', 'textarea'), d);
    expect(r).toMatchObject({ status: 'draft', provenance: { source: 'draft', usedFactIds: ['exp.acme'] } });
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it('optional free text is left empty, not drafted', async () => {
    const { d, draft } = deps();
    expect(await resolveField(f('מכתב מקדים', 'textarea', false), d)).toMatchObject({ status: 'empty_optional' });
    expect(draft).not.toHaveBeenCalled();
  });

  it('a rejected/unanswerable draft becomes pending with the reason', async () => {
    const { d } = deps({ draft: vi.fn(async () => ({ text: null, usedFactIds: [], unanswerable: false, flaggedClaims: [], rejectedReason: 'draft cites no facts' })) });
    expect(await resolveField(f('ספר על פרויקט שאתה גאה בו', 'textarea'), d)).toMatchObject({ status: 'pending', reason: 'draft cites no facts' });
  });
});

describe('HARD RULE: the LLM never answers these', () => {
  const cases: Array<[string, FormField['type']]> = [
    ['האם את/ה מוכן/ה לעבוד במשמרות כולל סופי שבוע?', 'yes_no'],
    ['מתי תוכל להתחיל לעבוד?', 'text'],
    ['מהן ציפיות השכר שלך?', 'text'],
    ['What is your notice period?', 'textarea'],
    ['Are you willing to relocate?', 'text'],
    ['האם יש לך סיווג ביטחוני?', 'text'],
    ['פרט את השירות הצבאי שלך', 'textarea'],
    ['האם יש לך אישור עבודה בישראל?', 'text'],
    ['בחר את רמת האנגלית שלך', 'choice'],
    ['כמה שנים אתה מתכנת?', 'number'],
    ['אני מאשר/ת את תנאי השימוש', 'consent'],
  ];
  it.each(cases)('%s (%s) → pending, no draft call', async (label, type) => {
    const { d, draft } = deps();
    const r = await resolveField(f(label, type), d);
    expect(r.status).toBe('pending');
    expect(draft).not.toHaveBeenCalled();
  });
});
