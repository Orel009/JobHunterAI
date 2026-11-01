/**
 * Is the scoring LLM there before a run needs it? Only a local Ollama can be "not running" (an API provider is asked on
 * its first call). Starting Ollama is what `npm start` does: the Ollama app on Windows, else `ollama serve` (detached),
 * then up to 30 seconds for it to answer. Runs started from the dashboard or the CLI check first and offer to start it;
 * scheduled hunts start it by themselves; score() never fails at the first job because of it (the jobs wait).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { taskConfig } from './settings.js';

export async function ollamaUp(timeoutMs = 2000): Promise<boolean> {
  try {
    return (await fetch(`${config.OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

export interface LlmReach {
  ok: boolean;
  /** why not, in one line (null when ok) */
  reason: string | null;
  /** the app can start it (a local Ollama) */
  canStart: boolean;
}

/** The scoring model (the analyze task): a local Ollama must answer; any other provider counts as reachable. */
export async function llmReachable(): Promise<LlmReach> {
  if (taskConfig('analyze').provider !== 'ollama') return { ok: true, reason: null, canStart: false };
  if (await ollamaUp()) return { ok: true, reason: null, canStart: true };
  return { ok: false, reason: `Ollama is not running (${config.OLLAMA_URL})`, canStart: true };
}

let starting: Promise<boolean> | null = null;

/** Start Ollama as `npm start` does and wait for it (up to `waitSeconds`). True when it answers. One start at a time. */
export function startOllama(waitSeconds = 30): Promise<boolean> {
  starting ??= (async () => {
    if (await ollamaUp()) return true;
    const app = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama app.exe');
    try {
      const child =
        process.platform === 'win32' && fs.existsSync(app)
          ? spawn(app, [], { detached: true, stdio: 'ignore' })
          : spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
      child.on('error', () => undefined); // not installed: reported as "not reachable" below
      child.unref();
    } catch {
      return false;
    }
    for (let i = 0; i < waitSeconds; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await ollamaUp()) return true;
    }
    return false;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** what to tell when it cannot be started */
export const OLLAMA_HELP = 'open the Ollama app (or install it from https://ollama.com/download), or choose an API provider on the Settings screen';
