import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { detectLanguage } from '../core/text.js';
import type { Prefs } from '../core/prefs.js';
import { questionKey } from './classify.js';
import type { FieldType } from './types.js';

export type BankType = 'text' | 'yes_no' | 'choice' | 'number';

export interface BankEntry {
  id: number;
  question: string;
  normKey: string;
  answer: string | null;
  type: BankType;
  options: string[] | null;
  language: 'he' | 'en';
  status: 'active' | 'pending';
  usageCount: number;
  source: 'seed' | 'user' | 'review';
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

interface Row {
  id: number;
  question: string;
  norm_key: string;
  answer: string | null;
  type: string;
  options: string | null;
  language: string;
  status: string;
  usage_count: number;
  source: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

const fromRow = (r: Row): BankEntry => ({
  id: r.id,
  question: r.question,
  normKey: r.norm_key,
  answer: r.answer,
  type: r.type as BankType,
  options: r.options ? (JSON.parse(r.options) as string[]) : null,
  language: r.language as 'he' | 'en',
  status: r.status as 'active' | 'pending',
  usageCount: r.usage_count,
  source: r.source as BankEntry['source'],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
});

export const bankTypeFor = (t: FieldType): BankType => (t === 'textarea' ? 'text' : t === 'consent' ? 'yes_no' : t);

/** Accepts yes/no in Hebrew or English. */
export function yesNo(answer: string | null): 'yes' | 'no' | null {
  const a = (answer ?? '').trim().toLowerCase();
  if (/^(yes|y|true|כן|נכון|בטח|מסכים|מאשר)$/.test(a)) return 'yes';
  if (/^(no|n|false|לא|לא נכון)$/.test(a)) return 'no';
  return null;
}

export class AnswersBank {
  constructor(private db: DB) {}

  list(filter: { status?: 'active' | 'pending' } = {}): BankEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM answers WHERE (? IS NULL OR status = ?) ORDER BY status = 'pending' DESC, updated_at DESC`)
      .all(filter.status ?? null, filter.status ?? null) as unknown as Row[];
    return rows.map(fromRow);
  }

  get(id: number): BankEntry | null {
    const r = this.db.prepare('SELECT * FROM answers WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  byKey(normKey: string): BankEntry | null {
    const r = this.db.prepare('SELECT * FROM answers WHERE norm_key = ?').get(normKey) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  active(): BankEntry[] {
    return this.list({ status: 'active' });
  }

  /** Creates or updates by normalized question. A non-empty answer makes the entry active. */
  upsert(e: { question: string; answer?: string | null; type: BankType; options?: string[] | null; source?: BankEntry['source']; language?: 'he' | 'en' }): BankEntry {
    const key = questionKey(e.question);
    const now = nowIso();
    const answer = e.answer?.trim() ? e.answer.trim() : null;
    const existing = this.byKey(key);
    if (existing) {
      this.db
        .prepare(`UPDATE answers SET answer = COALESCE(?, answer), type = ?, options = COALESCE(?, options), status = CASE WHEN COALESCE(?, answer) IS NULL THEN 'pending' ELSE 'active' END, source = ?, updated_at = ? WHERE id = ?`)
        .run(answer, e.type, e.options ? JSON.stringify(e.options) : null, answer, e.source ?? existing.source, now, existing.id);
      return this.get(existing.id)!;
    }
    const r = this.db
      .prepare(`INSERT INTO answers (question, norm_key, answer, type, options, language, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(e.question.trim(), key, answer, e.type, e.options ? JSON.stringify(e.options) : null, e.language ?? detectLanguage(e.question), answer ? 'active' : 'pending', e.source ?? 'user', now, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** Records an unanswered question once (no-op if it already exists). */
  addPending(question: string, type: BankType, options?: string[] | null): BankEntry {
    return this.byKey(questionKey(question)) ?? this.upsert({ question, type, options, answer: null, source: 'user' });
  }

  update(id: number, patch: { question?: string; answer?: string | null; type?: BankType; options?: string[] | null }): BankEntry | null {
    const cur = this.get(id);
    if (!cur) return null;
    const question = patch.question?.trim() || cur.question;
    const answer = patch.answer === undefined ? cur.answer : patch.answer?.trim() || null;
    this.db
      // any manual edit makes the entry user-owned, so re-seeding from preferences.yaml never overwrites it
      .prepare(`UPDATE answers SET question = ?, norm_key = ?, answer = ?, type = ?, options = ?, status = ?, source = 'user', updated_at = ? WHERE id = ?`)
      .run(
        question,
        questionKey(question),
        answer,
        patch.type ?? cur.type,
        patch.options === undefined ? (cur.options ? JSON.stringify(cur.options) : null) : patch.options ? JSON.stringify(patch.options) : null,
        answer ? 'active' : 'pending',
        nowIso(),
        id,
      );
    return this.get(id);
  }

  delete(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM answers WHERE id = ?').run(id).changes) > 0;
  }

  markUsed(id: number): void {
    this.db.prepare('UPDATE answers SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?').run(nowIso(), id);
  }

  /** Seeds standard answers from preferences.yaml. Never overwrites an answer the user edited. */
  seed(prefs: Pick<Prefs, 'standardAnswers'>): number {
    let n = 0;
    for (const [key, value] of Object.entries(prefs.standardAnswers)) {
      const def = SEED_QUESTIONS[key];
      const question = def?.question ?? key;
      const type: BankType = def?.type ?? (typeof value === 'boolean' ? 'yes_no' : typeof value === 'number' ? 'number' : 'text');
      const answer = typeof value === 'boolean' ? (value ? 'כן' : 'לא') : String(value ?? '').trim();
      const existing = this.byKey(questionKey(question));
      if (existing && existing.source !== 'seed') continue;
      this.upsert({ question, answer: answer || null, type, source: 'seed', language: 'he' });
      n++;
    }
    return n;
  }
}

/** Canonical Hebrew questions for known preferences.yaml standardAnswers keys. */
export const SEED_QUESTIONS: Record<string, { question: string; type: BankType }> = {
  city: { question: 'עיר מגורים', type: 'text' },
  salaryExpectation: { question: 'מהן ציפיות השכר שלך?', type: 'text' },
  noticePeriod: { question: 'מהי תקופת ההודעה המוקדמת שלך?', type: 'text' },
  availability: { question: 'מתי תוכל להתחיל לעבוד?', type: 'text' },
  fullTime: { question: 'האם אתה מעוניין במשרה מלאה?', type: 'yes_no' },
  drivingLicense: { question: 'האם יש לך רישיון נהיגה?', type: 'yes_no' },
  shifts: { question: 'האם אתה מוכן לעבוד במשמרות?', type: 'yes_no' },
  weekends: { question: 'האם אתה מוכן לעבוד בסופי שבוע?', type: 'yes_no' },
  relocation: { question: 'האם אתה מוכן לרילוקיישן?', type: 'yes_no' },
  militaryService: { question: 'האם שירתת בצבא?', type: 'yes_no' },
  securityClearance: { question: 'האם יש לך סיווג ביטחוני?', type: 'yes_no' },
  hybridOk: { question: 'האם אתה מוכן לעבוד מהמשרד ללא אפשרות לעבודה היברידית?', type: 'yes_no' },
  applyConsent: { question: 'אני מאשר/ת את תנאי השימוש ומדיניות הפרטיות בעת הגשת מועמדות', type: 'yes_no' },
};
