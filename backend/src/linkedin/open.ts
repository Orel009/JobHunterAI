/**
 * Opens links in the user's own default browser (Windows `start`) and shows files in Explorer.
 * This is the only way LinkedIn is ever opened: never in the Playwright-controlled browser.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** A plain http(s) URL, re-serialized; anything else (or anything cmd could misread) is rejected. */
export function safeHttpUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error('not a valid link');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) links can be opened');
  const href = u.href;
  // printable ASCII only, no quotes: the href goes inside "…" on a cmd line, where & | < > are literal
  if (!/^[\x21-\x7e]+$/.test(href) || href.includes('"')) throw new Error('link contains characters that cannot be opened safely');
  return href;
}

export function openInDefaultBrowser(url: string): void {
  const href = safeHttpUrl(url);
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${href}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [href], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** Opens Explorer with the file selected (so it can be dragged into an upload box). */
export function revealFile(file: string): void {
  if (!fs.existsSync(file)) throw new Error('file not found');
  if (process.platform === 'win32') spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [process.platform === 'darwin' ? '-R' : '', file].filter(Boolean), { detached: true, stdio: 'ignore' }).unref();
}
