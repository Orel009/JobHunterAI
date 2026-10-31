import crypto from 'node:crypto';

export const sha1 = (s: string): string => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML fragment (as used in job posts) → plain text with line breaks preserved. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#') && e !== '#39') return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalizes Hebrew/English text for matching: lowercases, strips niqqud and gender markers
 * ("מפתח/ת", "מפתח.ת", "מפתח(ת)" → "מפתח"), punctuation, and collapses whitespace.
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '') // niqqud / cantillation
    .replace(/([א-ת])\s*[/.\\(]\s*(ת|ית|ה|ות|יות|ים)\)?(?=[\s,\-–|)]|$)/g, '$1')
    .replace(/["'`׳״]/g, '')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-based (JS \b is ASCII-only and never matches around Hebrew letters).
const dropTokens = (s: string, stop: Set<string>): string =>
  s
    .split(' ')
    .filter((t) => t && !stop.has(t))
    .join(' ');

const TITLE_STOP = new Set(['דרוש', 'דרושה', 'דרושים', 'דרושות', 'למשרה', 'משרה', 'לחברה', 'לחברת', 'מגייסת', 'hiring', 'wanted']);
const COMPANY_STOP = new Set(['בעמ', 'ltd', 'inc', 'llc', 'group', 'קבוצת', 'חברת']);

export function normalizeTitle(title: string): string {
  return dropTokens(normalizeText(title), TITLE_STOP);
}

const CONFIDENTIAL = new Set(['חסוי', 'חברה חסויה', 'חסויה', 'confidential', 'חברה', '']);

export function normalizeCompany(company: string): string {
  return dropTokens(normalizeText(company).replace(/בע מ$/, 'בעמ'), COMPANY_STOP);
}

/** Confidential/empty company names must never be used for dedupe or cooldown matching. */
export const isAnonymousCompany = (companyNorm: string): boolean => CONFIDENTIAL.has(companyNorm);

export function detectLanguage(text: string): 'he' | 'en' {
  const he = (text.match(/[א-ת]/g) ?? []).length;
  const en = (text.match(/[a-zA-Z]/g) ?? []).length;
  return he >= en * 0.3 ? 'he' : 'en';
}

/** Substring keyword match on normalized text; short latin keywords (≤3 chars) need word boundaries. */
export function containsKeyword(haystackNorm: string, keyword: string): boolean {
  const k = normalizeText(keyword);
  if (!k) return false;
  if (/^[a-z0-9+#]{1,3}$/.test(k)) return new RegExp(`(^|\\s)${k.replace(/[+#]/g, '\\$&')}(\\s|$)`).test(haystackNorm);
  return haystackNorm.includes(k);
}
