import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import pino from 'pino';
import { config, READONLY } from './config.js';

export interface LogLine {
  time: number;
  level: string;
  msg: string;
  [k: string]: unknown;
}

const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const RING_SIZE = 500;

/** In-memory tail of recent log lines, fed to the dashboard over SSE. */
export const logBus = new EventEmitter();
export const recentLogs: LogLine[] = [];

const ringStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    for (const raw of chunk.toString('utf8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const { pid: _pid, hostname: _host, ...rest } = obj;
        const line = { ...rest, level: LEVELS[Number(obj.level)] ?? String(obj.level) } as LogLine;
        recentLogs.push(line);
        if (recentLogs.length > RING_SIZE) recentLogs.shift();
        logBus.emit('line', line);
      } catch {
        /* ignore non-JSON */
      }
    }
    cb();
  },
});

/**
 * The log file, opened HERE synchronously and handed to pino as a file descriptor: the stream is ready at once, so
 * pino's exit hook (flushSync on process.exit) can never meet a file that is still opening ("sonic boom is not ready
 * yet" — a CLI that exited right after its first log line crashed with it). Writes stay asynchronous.
 */
function openLogFile(): number | null {
  if (READONLY) return null;
  try {
    fs.mkdirSync(config.paths.logs, { recursive: true });
    return fs.openSync(path.join(config.paths.logs, 'jobhunter.log'), 'a');
  } catch {
    return null; // no log file (read-only folder, locked file): the console and the dashboard still get every line
  }
}
const logFd = openLogFile();
const fileDest = logFd === null ? null : pino.destination({ dest: logFd, sync: false });
const pretty = pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } });

export const log = pino(
  { level: config.LOG_LEVEL, base: { pid: process.pid } }, // no hostname in the log
  pino.multistream([
    { stream: pretty, level: config.LOG_LEVEL },
    ...(fileDest ? [{ stream: fileDest, level: config.LOG_LEVEL }] : []),
    { stream: ringStream, level: config.LOG_LEVEL },
  ]),
);

const within = (ms: number, p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

/** Writes out what is still buffered (the log file, then the console transport). Never throws. */
export async function flushLog(timeoutMs = 2000): Promise<void> {
  try {
    if (fileDest) await within(timeoutMs, new Promise<void>((r) => fileDest.flush(() => r())));
    await within(timeoutMs, new Promise<void>((r) => log.flush(() => r())));
  } catch {
    /* best effort */
  }
}

/** The same, synchronously (a synchronous exit path): the file is always open, so this never meets "not ready". */
export function flushLogSync(): void {
  try {
    fileDest?.flushSync();
  } catch {
    /* best effort */
  }
  try {
    (pretty as unknown as { flushSync?: () => void }).flushSync?.();
  } catch {
    /* best effort */
  }
}

/** The way out of a CLI: flush the log, then exit with this code (never process.exit right after a log line). */
export async function exitCleanly(code: number): Promise<never> {
  process.exitCode = code;
  await flushLog();
  process.exit(code);
}
