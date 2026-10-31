/**
 * LLM settings. Provider + model per task come from the environment (.env) and can be changed from the Settings
 * screen, which writes .env and updates this process — no restart. API keys live ONLY in .env: they are never stored
 * in the DB, never logged, and only ever returned masked.
 * Prices (for the cost estimate) live in data/settings.json; nothing is hard-coded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, config } from '../config.js';
import { PROVIDER_IDS, type ProviderId, type Task } from './types.js';

export const KEY_VARS: Partial<Record<ProviderId, string>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

export interface TaskConfig {
  provider: ProviderId;
  model: string;
}

const isProvider = (v: string | undefined): v is ProviderId => !!v && (PROVIDER_IDS as string[]).includes(v);

export function taskConfig(task: Task): TaskConfig {
  const p = process.env[`LLM_${task.toUpperCase()}_PROVIDER`];
  const provider: ProviderId = isProvider(p) ? p : 'ollama';
  const model = process.env[`LLM_${task.toUpperCase()}_MODEL`] || (provider === 'ollama' ? (task === 'write' ? config.OLLAMA_MODEL_WRITE : config.OLLAMA_MODEL_ANALYZE) : '');
  return { provider, model };
}

export const apiKey = (provider: ProviderId): string | undefined => {
  const v = KEY_VARS[provider];
  return v ? process.env[v] || undefined : undefined;
};

/** "sk-ant-api03-abcd…wxyz" → "sk-a…wxyz"; never more than 4+4 characters. */
export function maskKey(key: string | undefined | null): string | null {
  if (!key) return null;
  if (key.length <= 10) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export const dailyTokenLimit = (): number => {
  const n = Number(process.env.DAILY_LLM_TOKEN_LIMIT ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// ---------- non-secret settings (data/settings.json) ----------
export interface Price {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}
interface SettingsFile {
  /** key: "provider:model" */
  prices: Record<string, Price>;
}
const settingsPath = () => path.join(config.dataDir, 'settings.json');
export function readSettingsFile(): SettingsFile {
  try {
    return { prices: {}, ...(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<SettingsFile>) };
  } catch {
    return { prices: {} };
  }
}
export function writeSettingsFile(s: SettingsFile): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

// ---------- .env writes ----------
export const envPath = () => path.join(ROOT_DIR, '.env');

/** Sets KEY=value lines in .env (adding missing keys, '' removes the value) and in process.env. */
export function writeEnv(values: Record<string, string>): void {
  const file = envPath();
  if (!fs.existsSync(file)) {
    const example = path.join(ROOT_DIR, '.env.example');
    fs.writeFileSync(file, fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '');
  }
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`bad env key ${k}`);
    if (/[\r\n]/.test(v)) throw new Error(`bad value for ${k}`);
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
  fs.writeFileSync(file, text);
}

export function setTask(task: Task, c: TaskConfig): void {
  if (!isProvider(c.provider)) throw new Error(`unknown provider ${c.provider}`);
  writeEnv({ [`LLM_${task.toUpperCase()}_PROVIDER`]: c.provider, [`LLM_${task.toUpperCase()}_MODEL`]: c.model.trim() });
}

export function setApiKey(provider: ProviderId, key: string | null): void {
  const v = KEY_VARS[provider];
  if (!v) throw new Error(`${provider} has no API key`);
  writeEnv({ [v]: (key ?? '').trim() });
}

export function publicSettings() {
  const s = readSettingsFile();
  return {
    analyze: taskConfig('analyze'),
    write: taskConfig('write'),
    keys: Object.fromEntries(Object.entries(KEY_VARS).map(([p, v]) => [p, maskKey(process.env[v!])])),
    dailyTokenLimit: dailyTokenLimit(),
    prices: s.prices,
  };
}
