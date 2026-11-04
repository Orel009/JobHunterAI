/**
 * No "sonic boom is not ready yet": a CLI that logs and exits at once ends with its own exit code (the log file is
 * opened synchronously, CLIs flush before exiting), `npm run login -- drushim` on a paused site is a refusal with
 * exit 2, and npm start's login window treats that refusal as an outcome, never a startup failure.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLoginWindow } from '../src/browser/login-window.js';

const BACKEND = path.resolve(__dirname, '..');
const DATA = path.resolve(BACKEND, '..', 'data', 'test-cli-exit');
fs.mkdirSync(DATA, { recursive: true });

const run = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', ...args], {
    cwd: BACKEND,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DATA_DIR: 'data/test-cli-exit', PREFERENCES_FILE: 'data/test-cli-exit/preferences.yaml', LOG_LEVEL: 'info' },
  });

describe('exiting right after a log line', () => {
  it('a process that logs, then exits at once, ends cleanly with its exit code', () => {
    const script = path.join(DATA, 'log-then-exit.mts');
    const logTs = path.join(BACKEND, 'src', 'log.ts').replace(/\\/g, '/');
    fs.writeFileSync(script, `import { log } from 'file:///${logTs}';\nlog.warn('about to exit');\nprocess.exit(3);\n`);
    const r = run([script]);
    expect(r.stderr + r.stdout).not.toMatch(/sonic boom|not ready yet/i);
    expect(r.status).toBe(3);
  });
  it('npm run login -- drushim while Drushim is paused: refused, exit 2, no crash', () => {
    const until = new Date(Date.now() + 24 * 3_600_000).toISOString();
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ prices: {}, sitePauses: { drushim: { reason: 'CAPTCHA / bot check', detail: 'captcha', since: new Date().toISOString(), until, source: 'block', strikes: 1 } } }));
    const r = run(['src/cli/login.ts', 'drushim']);
    expect(r.stderr).toMatch(/Drushim is paused: CAPTCHA \/ bot check .*Not opening it/);
    expect(r.stderr + r.stdout).not.toMatch(/sonic boom|not ready yet|Error:/i);
    expect(r.status).toBe(2);
  });
});

describe("npm start's login window", () => {
  it('a refusal (exit 2) is an outcome: reported, never thrown', () => {
    const exec = () => {
      throw Object.assign(new Error('Command failed'), { status: 2 });
    };
    expect(runLoginWindow('login drushim', BACKEND, exec)).toEqual({ ok: false, code: 2, why: 'refused: the site is paused or its login page is not answering' });
  });
  it('another exit code is reported with it; a finished login is ok', () => {
    expect(runLoginWindow('x', BACKEND, () => {
      throw Object.assign(new Error('x'), { status: 1 });
    })).toMatchObject({ ok: false, code: 1, why: 'the login window ended with exit 1' });
    expect(runLoginWindow('x', BACKEND, () => Buffer.from(''))).toEqual({ ok: true });
  });
});
