/**
 * Profile files: data/profile/profile.json (the real one) and profile.draft.json (unreviewed, from a CV extraction).
 * Writes keep a timestamped backup of the previous file in data/profile/backups/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { profilePath } from './facts.js';
import { ProfileSchema, type Profile } from './schema.js';

export const draftPath = () => path.join(config.paths.profileDir, 'profile.draft.json');

export interface Validation {
  ok: boolean;
  issues: string[];
  profile: Profile | null;
}

/** Schema + unresolved CONFLICT values. Never throws. */
export function validateProfile(obj: unknown): Validation {
  const issues: string[] = [];
  const conflicts = JSON.stringify(obj ?? {}).match(/"CONFLICT [^"]*"/g);
  if (conflicts) issues.push(...conflicts.map((c) => `unresolved ${c.slice(1, -1)}`));
  const parsed = ProfileSchema.safeParse(obj);
  if (!parsed.success) issues.push(...parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  return { ok: issues.length === 0, issues, profile: parsed.success && issues.length === 0 ? parsed.data : null };
}

export type ProfileSource = 'profile' | 'draft' | 'none';

export function currentProfileFile(): { source: ProfileSource; file: string | null } {
  if (fs.existsSync(profilePath())) return { source: 'profile', file: profilePath() };
  if (fs.existsSync(draftPath())) return { source: 'draft', file: draftPath() };
  return { source: 'none', file: null };
}

export function readProfileRaw(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function backup(file: string) {
  if (!fs.existsSync(file)) return;
  const dir = path.join(config.paths.profileDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, `${path.basename(file, '.json')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
}

/** Writes a profile file (validated object for profile.json; drafts may be saved while still invalid). */
export function writeProfileFile(file: string, obj: unknown): void {
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
