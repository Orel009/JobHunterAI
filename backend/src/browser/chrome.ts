/**
 * The user's installed Google Chrome. Site sessions use it (Google sign-in refuses the bundled "Chrome for Testing"):
 *   - login: chrome.exe is started as a normal process (no Playwright, no CDP, no automation flags) on our profile
 *     folder; the user logs in by hand and closes it;
 *   - automation: Playwright launches the same installed Chrome (channel 'chrome') on the same profile folder.
 * Both can never run at once: Chrome locks its profile folder.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ChromeInstall {
  path: string;
  version: string | null;
  /** how it was found */
  source: string;
}

function appPath(hive: 'HKLM' | 'HKCU'): string | null {
  try {
    const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /REG_(?:EXPAND_)?SZ\s+(.+\.exe)/i.exec(out)?.[1]?.trim().replace(/^"|"$/g, '') ?? null;
  } catch {
    return null;
  }
}

/** Chrome keeps one folder per installed version next to chrome.exe ("156.0.8078.74"); the highest is the current one. */
export function chromeVersion(exe: string): string | null {
  try {
    const versions = fs.readdirSync(path.dirname(exe)).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
    const cmp = (a: string, b: string) => {
      const x = a.split('.').map(Number);
      const y = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
      return 0;
    };
    return versions.sort(cmp).pop() ?? null;
  } catch {
    return null;
  }
}

/** CHROME_PATH, then the registry App Paths (machine, user), then the standard install folders. */
export function findChrome(): ChromeInstall | null {
  const candidates: Array<[string | null | undefined, string]> = [[process.env.CHROME_PATH, 'CHROME_PATH']];
  if (process.platform === 'win32') {
    candidates.push(
      [appPath('HKLM'), 'registry (App Paths)'],
      [appPath('HKCU'), 'registry (App Paths, user)'],
      [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Program Files'],
      [process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Program Files (x86)'],
      [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'LocalAppData'],
    );
  } else if (process.platform === 'darwin') {
    candidates.push(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Applications']);
  } else {
    candidates.push(['/usr/bin/google-chrome', '/usr/bin'], ['/usr/bin/google-chrome-stable', '/usr/bin']);
  }
  for (const [p, source] of candidates) {
    if (p && fs.existsSync(p)) return { path: p, version: chromeVersion(p), source };
  }
  return null;
}

export const CHROME_MISSING_HELP = [
  'Google Chrome is not installed (or not found). Install it from https://www.google.com/chrome/ — signing in with Google only works in the real Chrome.',
  "Without Chrome, log in with the site's non-Google option instead (a code by SMS or email, or a password).",
  'If Chrome is installed somewhere unusual, set CHROME_PATH in .env to the full path of chrome.exe.',
].join('\n');

/**
 * Is a Chrome/Chromium process using this profile folder right now? On Windows Chrome holds <profile>/lockfile open
 * while it runs (a stale one from a crash can be deleted); elsewhere it keeps a SingletonLock symlink.
 */
export function profileInUse(profileDir: string): boolean {
  const lock = path.join(profileDir, 'lockfile');
  if (process.platform === 'win32') {
    if (!fs.existsSync(lock)) return false;
    try {
      fs.rmSync(lock);
      return false;
    } catch (e) {
      return ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
    }
  }
  try {
    fs.lstatSync(path.join(profileDir, 'SingletonLock'));
    return true;
  } catch {
    return false;
  }
}

export const PROFILE_IN_USE = 'The browser profile is open in another window — close the login window (Chrome) first, then try again.';
