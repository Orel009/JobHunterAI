import fs from 'node:fs';
import { getDocumentProxy } from 'unpdf';

export interface PdfItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  eol: boolean;
  dir?: string;
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
/**
 * Brackets inside RTL runs arrive as standalone, direction-neutral items carrying the visual (mirrored) glyph.
 * Flip a standalone bracket when a neighbouring item on the same line is RTL.
 */
const BRACKET = /[()[\]{}<>]/g;
const isLoneBracket = (s: string) => /^\s*[()[\]{}<>]\s*$/.test(s);

const SAME_LINE_TOLERANCE = 2; // pt
const MIN_WORD_GAP = 1.5; // pt

/**
 * Rebuilds text from positioned items. Word-processor PDFs (esp. Hebrew/RTL) often emit every word as its own
 * item without space characters; a space is inserted when two neighbouring boxes on the same line don't touch.
 * Works for RTL and LTR runs because only the box gap matters, not the direction.
 */
export function itemsToText(items: PdfItem[]): string {
  const sameLine = (a: PdfItem | undefined, b: PdfItem) => !!a && a.str !== '' && Math.abs(a.y - b.y) <= SAME_LINE_TOLERANCE;
  const text = (i: number): string => {
    const it = items[i]!;
    if (!isLoneBracket(it.str)) return it.str;
    const near = [items[i - 1], items[i + 1]].some((n) => sameLine(n, it) && n!.dir === 'rtl');
    return near ? it.str.replace(BRACKET, (c) => MIRROR[c] ?? c) : it.str;
  };
  let out = '';
  let prev: PdfItem | null = null;
  for (const [i, it] of items.entries()) {
    if (it.str === '') {
      if (it.eol && prev) out += '\n';
      prev = it.eol ? null : prev;
      continue;
    }
    if (prev) {
      if (Math.abs(it.y - prev.y) > SAME_LINE_TOLERANCE) out += '\n';
      else {
        const gap = Math.max(it.x - (prev.x + prev.w), prev.x - (it.x + it.w));
        if (gap > MIN_WORD_GAP && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
      }
    }
    out += text(i);
    prev = it;
    if (it.eol) {
      out += '\n';
      prev = null;
    }
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function pdfToText(file: string): Promise<{ text: string; links: string[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  const pages: string[] = [];
  const links = new Set<string>();
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const items = (tc.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean; dir?: string }>)
      .filter((it) => typeof it.str === 'string' && it.transform)
      .map((it) => ({ str: it.str!, x: it.transform![4]!, y: it.transform![5]!, w: it.width ?? 0, h: it.height ?? 0, eol: !!it.hasEOL, dir: it.dir }));
    pages.push(itemsToText(items));
    for (const a of (await page.getAnnotations()) as Array<{ url?: string }>) if (a.url) links.add(a.url);
  }
  return { text: pages.join('\n\n'), links: [...links] };
}
