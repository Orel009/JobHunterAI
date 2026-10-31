import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromeVersion, findChrome, profileInUse } from '../src/browser/chrome.js';
import { formatSessionReport, savedCookies, type SessionReport } from '../src/browser/session-report.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-chrome-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('installed Chrome', () => {
  it('reads the version from the newest version folder next to chrome.exe', () => {
    const app = path.join(tmp, 'Application');
    for (const d of ['99.0.1.2', '156.0.8078.74', '156.0.8078.9', 'SetupMetrics']) fs.mkdirSync(path.join(app, d), { recursive: true });
    fs.writeFileSync(path.join(app, 'chrome.exe'), '');
    expect(chromeVersion(path.join(app, 'chrome.exe'))).toBe('156.0.8078.74');
  });

  it('CHROME_PATH wins over the standard locations', () => {
    const exe = path.join(tmp, 'Application', 'chrome.exe');
    process.env.CHROME_PATH = exe;
    try {
      expect(findChrome()).toMatchObject({ path: exe, source: 'CHROME_PATH', version: '156.0.8078.74' });
    } finally {
      delete process.env.CHROME_PATH;
    }
  });

  it.runIf(process.platform === 'win32')('a stale lockfile is cleared; a held one means the profile is open', () => {
    const profile = path.join(tmp, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    expect(profileInUse(profile)).toBe(false);
    fs.writeFileSync(path.join(profile, 'lockfile'), '');
    expect(profileInUse(profile)).toBe(false); // stale (nobody holds it) → removed
    expect(fs.existsSync(path.join(profile, 'lockfile'))).toBe(false);
  });
});

describe('cookie survival report', () => {
  const profile = path.join(tmp, 'cookie-profile');
  const chromeTime = (iso: string) => BigInt(Date.parse(iso)) * 1000n + 11644473600n * 1_000_000n;
  fs.mkdirSync(path.join(profile, 'Default', 'Network'), { recursive: true });
  const db = new DatabaseSync(path.join(profile, 'Default', 'Network', 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER, is_persistent INTEGER, has_expires INTEGER)');
  const add = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?)');
  add.run('.drushim.co.il', 'refreshToken', '', Buffer.from('secret'), chromeTime('2027-01-01T00:00:00.000Z'), 1, 1);
  add.run('www.drushim.co.il', 'accessToken', '', Buffer.from('secret'), 0, 0, 0);
  add.run('.google.com', 'SID', '', Buffer.from('secret'), chromeTime('2027-06-01T00:00:00.000Z'), 1, 1);
  db.close();

  it("reads the site's saved cookies (names and expiry, never values)", () => {
    expect(savedCookies(profile, 'drushim')).toEqual([
      { domain: '.drushim.co.il', name: 'refreshToken', expires: '2027-01-01T00:00:00.000Z' },
      { domain: 'www.drushim.co.il', name: 'accessToken', expires: null },
    ]);
    expect(JSON.stringify(savedCookies(profile, 'drushim'))).not.toMatch(/secret/);
  });

  it('names the cookies that did not survive the restart', () => {
    const saved = savedCookies(profile, 'drushim');
    const r: SessionReport = { session: { state: 'logged_out', checkedAt: null, detail: 'probe 401' }, saved, seen: [saved[0]!], lost: [saved[1]!] };
    const text = formatSessionReport(r);
    expect(text).toMatch(/1 cookie\(s\) did NOT survive the restart:\n.*accessToken.*SESSION ONLY/);
    expect(text).toMatch(/NOT logged in/);
  });
});
