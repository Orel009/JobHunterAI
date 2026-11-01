/**
 * The JobHunter Fill extension's per-install token (data/extension-token, local only). Every /api/fill request must
 * carry it; web pages cannot read it (it lives in the extension's storage, and requests are made by the extension's
 * background worker, never by the page).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const file = () => path.join(config.dataDir, 'extension-token');

export function extensionToken(): string {
  try {
    const t = fs.readFileSync(file(), 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(t)) return t;
  } catch {
    /* first use */
  }
  return regenerateExtensionToken();
}

/** A new token (the old one stops working; paste the new one into the extension's options). */
export function regenerateExtensionToken(): string {
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), t, { mode: 0o600 });
  return t;
}

/** Constant-time check of a presented token. */
export function tokenOk(presented: string | undefined | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(extensionToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
