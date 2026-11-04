/**
 * npm start's "Open the login window now?": runs `login.ts <site>` as a child and reports how it ended. A refusal
 * (exit 2: the site is paused, or its login page does not answer) or a window closed without logging in is an
 * outcome to report — never a reason to stop the startup.
 */
import { execSync } from 'node:child_process';

export type LoginWindowResult = { ok: true } | { ok: false; code: number | null; why: string };

export function runLoginWindow(cmd: string, cwd: string, exec: (cmd: string, opts: { cwd: string; stdio: 'inherit' }) => unknown = execSync): LoginWindowResult {
  try {
    exec(cmd, { cwd, stdio: 'inherit' });
    return { ok: true };
  } catch (e) {
    const code = (e as { status?: number | null }).status ?? null;
    return { ok: false, code, why: code === 2 ? 'refused: the site is paused or its login page is not answering' : `the login window ended with exit ${code ?? '?'}` };
  }
}
