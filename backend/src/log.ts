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

const fileDest = READONLY ? null : pino.destination({ dest: path.join(config.paths.logs, 'jobhunter.log'), mkdir: true, sync: false });
const pretty = pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } });

export const log = pino(
  { level: config.LOG_LEVEL },
  pino.multistream([
    { stream: pretty, level: config.LOG_LEVEL },
    ...(fileDest ? [{ stream: fileDest, level: config.LOG_LEVEL }] : []),
    { stream: ringStream, level: config.LOG_LEVEL },
  ]),
);
