import { normalizeText } from '../core/text.js';
import type { FieldType } from './types.js';

/** Question normalization used as the answers-bank key (gender markers, punctuation and case removed). */
export const questionKey = (q: string): string =>
  normalizeText(q)
    .split(' ')
    .map((w) => (w === 'אתה' || w === 'הנך' || w === 'הינך' ? 'את' : w)) // "את/ה" → "את"; unify second-person forms
    .join(' ');

/**
 * Categories the LLM must NEVER answer (HARD RULE). Matched on the normalized question text.
 * Order matters only for the reported category name.
 */
const HARD_CATEGORIES: Array<[string, RegExp]> = [
  ['salary', /שכר|משכורת|תגמול|salary|compensation|\bpay\b|wage/],
  ['notice_period', /הודעה מוקדמת|notice/],
  ['availability', /זמין|זמינ|להתחיל לעבוד|תחילת עבודה|מתי תוכל|מתי את|available|availability|start date|start working|when can you start/],
  ['shifts', /משמרות|משמרת|shifts?\b|לילות|night/],
  ['weekends', /סופש|סופ ש|סוף שבוע|סופי שבוע|סופשים|שבת|weekend/],
  ['relocation', /רילוקיישן|relocat|מעבר דירה|העתקת מגורים|ניידות|רכב|הגעה עצמית|commut|own transport/],
  ['military', /צבא|צהל|צה ל|שירות צבאי|מילואים|שירות לאומי|military|army|idf|reserve duty/],
  ['clearance', /סיווג|clearance|ביטחוני/],
  ['legal', /אישור עבודה|אזרחות|תעודת זהות|רישום פלילי|הסכמ|מסכים|תנאי שימוש|מדיניות פרטיות|תקנון|consent|agree|citizenship|work permit|visa|criminal|legal|privacy|terms/],
  ['license', /רישיון|רשיון|license|licence/],
  ['years', /שנות ניסיון|שנים|שנתיים|years?\b|yrs/],
];

export function hardRuleCategory(question: string, type: FieldType): string | null {
  const q = normalizeText(question);
  for (const [name, re] of HARD_CATEGORIES) if (re.test(q)) return name;
  if (type === 'yes_no' || type === 'choice' || type === 'number' || type === 'consent') return `type:${type}`;
  return null;
}

/** Only open free-text questions outside every hard-rule category may get an LLM draft. */
export const draftAllowed = (question: string, type: FieldType): boolean =>
  (type === 'text' || type === 'textarea') && hardRuleCategory(question, type) === null;

// ---------- "N years of X" ----------
const HE_NUM: Record<string, number> = {
  שנה: 1, אחת: 1, אחד: 1, שנתיים: 2, שתיים: 2, שתי: 2, שניים: 2, שני: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4,
  חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10,
};
const EN_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Minimum years asked by a "do you have N years (of X)" question; null if it isn't one. */
export function parseMinYears(question: string): number | null {
  const q = normalizeText(question);
  if (!/ניסיון|נסיון|experience|exp\b/.test(q)) return null;
  if (/(^| )שנתיים( |$)/.test(q)) return 2;
  const digit = q.match(/(\d+)\s*\+?\s*(שנות|שנים|שנה|years?|yrs?)/);
  if (digit) return Number(digit[1]);
  const heWord = q.match(/(^| )([א-ת]+) (שנות|שנים)( |$)/);
  if (heWord && HE_NUM[heWord[2]!] !== undefined) return HE_NUM[heWord[2]!]!;
  const enWord = q.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*(years?|yrs?)/);
  if (enWord) return EN_NUM[enWord[1]!]!;
  const heAfter = q.match(/(שנות|שנים) ([א-ת]+)/); // "של שנים שלוש" is rare; keep the common order only
  if (heAfter && HE_NUM[heAfter[2]!] !== undefined && heAfter[2] !== 'ניסיון') return HE_NUM[heAfter[2]!]!;
  return null;
}

/** "How many years of X do you have?" (asks for a number rather than yes/no). */
export const asksYearsCount = (question: string): boolean =>
  /כמה שנ|how many years|years of experience do you have/.test(normalizeText(question));
