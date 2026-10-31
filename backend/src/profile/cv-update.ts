/**
 * CV uploads from the dashboard:
 *   upload → data/profile/cv-history/cv-<lang>-<timestamp>.pdf (history kept) + data/profile/cv-<lang>.pdf (current)
 *   → background extraction (progress) → no profile yet: a draft · otherwise: a pending update (structured diff)
 *   → you accept/reject each change → validated → saved. profile.json is never overwritten automatically.
 * A changed CV raises a reminder to replace it on Drushim too (the site sends the CV stored on your account).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { LlmCache } from '../llm/llm.js';
import { conflictsMarkdown, type Lang } from './merge.js';
import { extractProfile } from './extract.js';
import { applyDiff, diffProfiles, type DiffEntry } from './diff.js';
import { currentProfileFile, draftPath, readProfileRaw, validateProfile, writeProfileFile } from './store.js';
import { ProfileSchema } from './schema.js';

const dir = () => config.paths.profileDir;
const statePath = () => path.join(dir(), 'cv-state.json');
const pendingPath = () => path.join(dir(), 'pending-update.json');

export interface CvSlot {
  file: string;
  hash: string;
  uploadedAt: string;
  history: number;
  /** the file changed since you last confirmed it is replaced on Drushim too */
  needsDrushimUpdate: boolean;
}
export type CvState = Partial<Record<Lang, CvSlot>>;

export const readCvState = (): CvState => (fs.existsSync(statePath()) ? (JSON.parse(fs.readFileSync(statePath(), 'utf8')) as CvState) : {});
const writeCvState = (s: CvState) => fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));

export function saveCvUpload(lang: Lang, pdf: Buffer): { changed: boolean; slot: CvSlot } {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF file');
  const hist = path.join(dir(), 'cv-history');
  fs.mkdirSync(hist, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(hist, `cv-${lang}-${ts}.pdf`), pdf);
  fs.writeFileSync(path.join(dir(), `cv-${lang}.pdf`), pdf);
  const hash = crypto.createHash('sha1').update(pdf).digest('hex');
  const state = readCvState();
  const prev = state[lang];
  const changed = !prev || prev.hash !== hash;
  const slot: CvSlot = {
    file: `cv-${lang}.pdf`,
    hash,
    uploadedAt: new Date().toISOString(),
    history: fs.readdirSync(hist).filter((f) => f.startsWith(`cv-${lang}-`)).length,
    needsDrushimUpdate: changed ? true : (prev?.needsDrushimUpdate ?? false),
  };
  state[lang] = slot;
  writeCvState(state);
  return { changed, slot };
}

export function ackDrushimUpdate(lang: Lang): void {
  const s = readCvState();
  if (s[lang]) s[lang]!.needsDrushimUpdate = false;
  writeCvState(s);
}

// ---------- background extraction ----------
export interface ExtractionJob {
  status: 'idle' | 'running' | 'done' | 'failed';
  stage: string;
  pct: number;
  startedAt: string | null;
  error: string | null;
  result: 'draft' | 'pending_update' | null;
}
let job: ExtractionJob = { status: 'idle', stage: '', pct: 0, startedAt: null, error: null, result: null };
export const extractionJob = () => job;

export interface PendingUpdate {
  createdAt: string;
  target: 'profile' | 'draft';
  entries: DiffEntry[];
}
export const readPending = (): PendingUpdate | null => (fs.existsSync(pendingPath()) ? (JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) as PendingUpdate) : null);
export const discardPending = () => fs.existsSync(pendingPath()) && fs.rmSync(pendingPath());

export function startExtraction(opts: { cache?: LlmCache } = {}): ExtractionJob {
  if (job.status === 'running') throw new Error('an extraction is already running');
  const files = Object.fromEntries((['he', 'en'] as const).map((l) => [l, path.join(dir(), `cv-${l}.pdf`)]).filter(([, f]) => fs.existsSync(f!)));
  if (Object.keys(files).length === 0) throw new Error('upload a CV first');
  job = { status: 'running', stage: 'starting', pct: 0, startedAt: new Date().toISOString(), error: null, result: null };
  void (async () => {
    try {
      const r = await extractProfile(files, { cache: opts.cache, onProgress: (stage, pct) => void Object.assign(job, { stage, pct }) });
      for (const [l, t] of Object.entries(r.texts)) fs.writeFileSync(path.join(dir(), `cv-${l}.txt`), t);
      fs.writeFileSync(path.join(dir(), 'profile.conflicts.md'), conflictsMarkdown(r.conflicts, r.dropped, r.missed));
      const { source, file } = currentProfileFile();
      if (source === 'none' || !file) {
        writeProfileFile(draftPath(), r.profile);
        job = { ...job, status: 'done', stage: 'draft ready for review', pct: 100, result: 'draft' };
        return;
      }
      // compare against the current profile (CONFLICT placeholders → null so the diff still works)
      const cur = ProfileSchema.parse(JSON.parse(JSON.stringify(readProfileRaw(file)).replace(/"CONFLICT [^"]*"/g, 'null')));
      const incoming = ProfileSchema.parse(JSON.parse(JSON.stringify(r.profile).replace(/"CONFLICT [^"]*"/g, 'null')));
      const pending: PendingUpdate = { createdAt: new Date().toISOString(), target: source, entries: diffProfiles(cur, incoming) };
      fs.writeFileSync(pendingPath(), JSON.stringify(pending, null, 2));
      job = { ...job, status: 'done', stage: `${pending.entries.length} change(s) to review`, pct: 100, result: 'pending_update' };
    } catch (e) {
      job = { ...job, status: 'failed', error: e instanceof Error ? e.message : String(e) };
      log.error({ err: job.error }, 'CV extraction failed');
    }
  })();
  return job;
}

/** Applies accepted changes to the current profile (or draft); profile.json must still validate afterwards. */
export function applyPending(acceptedIds: string[]): { ok: boolean; issues: string[]; applied: number; target: 'profile' | 'draft' } {
  const pending = readPending();
  if (!pending) throw new Error('no pending update');
  const { source, file } = currentProfileFile();
  if (!file || source === 'none') throw new Error('no profile to update');
  const cur = ProfileSchema.parse(JSON.parse(JSON.stringify(readProfileRaw(file)).replace(/"CONFLICT [^"]*"/g, 'null')));
  const next = applyDiff(cur, pending.entries, acceptedIds);
  const v = validateProfile(next);
  if (source === 'profile' && !v.ok) return { ok: false, issues: v.issues, applied: 0, target: source };
  writeProfileFile(file, source === 'profile' ? v.profile : next);
  discardPending();
  return { ok: true, issues: v.issues, applied: acceptedIds.length, target: source };
}
