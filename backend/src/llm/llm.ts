/**
 * The single entry point for model calls (scoring, matching, classification, drafts, profile extraction).
 * Picks the provider + model for the task, uses the provider's native structured output, validates with zod,
 * retries once (feeding the error back), caches by content hash, records token usage and enforces the daily
 * token limit for API providers.
 */
import { z } from 'zod';
import { sha1 } from '../core/text.js';
import { log } from '../log.js';
import { anthropicProvider } from './providers/anthropic.js';
import { fakeProvider } from './providers/fake.js';
import { geminiProvider } from './providers/gemini.js';
import { ollamaProvider } from './providers/ollama.js';
import { openaiProvider } from './providers/openai.js';
import { apiKey, taskConfig } from './settings.js';
import { assertUnderLimit, recordUsage } from './usage.js';
import { LlmError, dropNullOptionals, strictSchema, type ChatMessage, type LlmProvider, type ProviderId, type Task } from './types.js';

export { LlmError, LlmPausedError, type ChatMessage } from './types.js';

export interface LlmCache {
  cacheGet(key: string): string | null;
  cachePut(key: string, model: string, response: string): void;
}

export function getProvider(id: ProviderId): LlmProvider {
  switch (id) {
    case 'ollama':
      return ollamaProvider();
    case 'anthropic':
      return anthropicProvider(() => apiKey('anthropic'));
    case 'openai':
      return openaiProvider(() => apiKey('openai'));
    case 'gemini':
      return geminiProvider(() => apiKey('gemini'));
    case 'fake':
      return fakeProvider();
  }
}

/**
 * Hebrew abbreviations (קו"ח, ש"ח, צה"ל) written with an ASCII `"` terminate the JSON string under
 * grammar-constrained sampling and silently truncate the text. Require the Hebrew gershayim ״ instead.
 */
export const HEBREW_QUOTE_RULE =
  'In Hebrew text inside JSON strings NEVER use the ASCII double-quote character ("). Write Hebrew abbreviations with the Hebrew gershayim ״ (e.g. קו״ח, ש״ח, צה״ל) or spell them out.';

function withHebrewQuoteRule(messages: ChatMessage[]): ChatMessage[] {
  const [first, ...rest] = messages;
  if (first?.role === 'system') return [{ role: 'system', content: `${first.content}\n${HEBREW_QUOTE_RULE}` }, ...rest];
  return [{ role: 'system', content: HEBREW_QUOTE_RULE }, ...messages];
}

interface Target {
  provider?: ProviderId;
  model?: string;
  task?: Task;
  /** test seam: use this provider object directly */
  providerImpl?: LlmProvider;
  /** test seam for the default Ollama provider */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

function resolve(t: Target): { provider: LlmProvider; model: string } {
  if (t.providerImpl) return { provider: t.providerImpl, model: t.model ?? 'test' };
  const cfg = t.task ? taskConfig(t.task) : null;
  const id = t.provider ?? cfg?.provider ?? 'ollama';
  const model = t.model ?? cfg?.model ?? '';
  if (!model) throw new LlmError(`no model chosen for ${t.task ?? id} (Settings screen)`);
  const provider = id === 'ollama' && (t.fetchImpl || t.baseUrl) ? ollamaProvider({ fetchImpl: t.fetchImpl, baseUrl: t.baseUrl }) : getProvider(id);
  return { provider, model };
}

async function track(provider: LlmProvider, model: string, usage: { inputTokens: number; outputTokens: number }) {
  await recordUsage(provider.id, model, usage).catch((e: unknown) => log.debug({ err: String(e) }, 'usage not recorded'));
}

export interface StructuredOptions<T extends z.ZodType> extends Target {
  messages: ChatMessage[];
  schema: T;
  temperature?: number;
  numCtx?: number;
  cache?: LlmCache;
}

export async function generateStructured<T extends z.ZodType>(opts: StructuredOptions<T>): Promise<{ data: z.infer<T>; cached: boolean }> {
  const { provider, model } = resolve(opts);
  // `input` side: what the model must produce (post-validation transforms are ours)
  const raw = z.toJSONSchema(opts.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  const jsonSchema = provider.id === 'ollama' ? raw : strictSchema(raw);
  const key = sha1(JSON.stringify([provider.id, model, raw, opts.messages, opts.temperature ?? 0]));
  const hit = opts.cache?.cacheGet(key);
  if (hit) {
    const parsed = opts.schema.safeParse(JSON.parse(hit));
    if (parsed.success) return { data: parsed.data, cached: true };
  }

  const base = withHebrewQuoteRule(opts.messages);
  let messages = base;
  let lastErr = '';
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!provider.local) await assertUnderLimit();
    const res = await provider.generateStructured({ model, messages, temperature: opts.temperature ?? 0, numCtx: opts.numCtx }, jsonSchema);
    await track(provider, model, res.usage);
    lastRaw = res.text;
    let obj: unknown;
    try {
      obj = JSON.parse(lastRaw);
      if (provider.id !== 'ollama') obj = dropNullOptionals(obj, raw);
    } catch {
      lastErr = 'reply was not valid JSON';
    }
    if (obj !== undefined) {
      const parsed = opts.schema.safeParse(obj);
      if (parsed.success) {
        opts.cache?.cachePut(key, `${provider.id}:${model}`, JSON.stringify(parsed.data));
        return { data: parsed.data, cached: false };
      }
      lastErr = z.prettifyError(parsed.error);
    }
    messages = [...base, { role: 'assistant', content: lastRaw }, { role: 'user', content: `The JSON did not match the schema:\n${lastErr}\nReturn corrected JSON only.` }];
  }
  throw new LlmError(`invalid structured output after retry: ${lastErr}`, lastRaw);
}

/** Back-compatible name used across the code base. */
export const chatJson = generateStructured;

export async function generateText(opts: Target & { messages: ChatMessage[]; temperature?: number; numCtx?: number }): Promise<{ text: string }> {
  const { provider, model } = resolve(opts);
  if (!provider.local) await assertUnderLimit();
  const res = await provider.generateText({ model, messages: opts.messages, temperature: opts.temperature, numCtx: opts.numCtx });
  await track(provider, model, res.usage);
  return { text: res.text };
}

/** Tiny structured call: does this provider + model answer with valid JSON? */
export async function testConnection(provider: ProviderId, model: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const { data } = await generateStructured({
      provider,
      model,
      schema: z.object({ ok: z.boolean() }),
      messages: [{ role: 'user', content: 'Reply with the JSON object {"ok": true}.' }],
    });
    return { ok: data.ok === true || provider === 'fake', ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listModels(provider: ProviderId): Promise<{ models: string[]; error?: string }> {
  try {
    return { models: await getProvider(provider).listModels() };
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export const listLocalModels = async (): Promise<string[]> => getProvider('ollama').listModels();
