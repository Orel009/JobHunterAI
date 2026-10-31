import { z } from 'zod';
import { config } from '../config.js';
import { sha1 } from '../core/text.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCache {
  cacheGet(key: string): string | null;
  cachePut(key: string, model: string, response: string): void;
}

export interface ChatJsonOptions<T extends z.ZodType> {
  /** explicit model, or a task whose configured model is used */
  model?: string;
  task?: 'analyze' | 'write';
  messages: ChatMessage[];
  schema: T;
  temperature?: number;
  numCtx?: number;
  cache?: LlmCache;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class LlmError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = 'LlmError';
  }
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
  total_duration?: number;
}

export async function ollamaChat(
  body: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<OllamaChatResponse> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl ?? config.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, ...body }),
    signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as OllamaChatResponse;
  if (!res.ok || json.error) throw new LlmError(`ollama ${res.status}: ${json.error ?? res.statusText}`);
  return json;
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

/**
 * Structured output: passes the zod schema as JSON Schema in `format`, validates the reply with zod,
 * retries once (feeding the validation error back), and caches valid results by content hash.
 */
export async function chatJson<T extends z.ZodType>(optsIn: ChatJsonOptions<T>): Promise<{ data: z.infer<T>; cached: boolean }> {
  const opts = { ...optsIn, model: optsIn.model ?? (optsIn.task === 'write' ? config.OLLAMA_MODEL_WRITE : config.OLLAMA_MODEL_ANALYZE) };
  // `input` side: what the model must produce (post-validation transforms are ours).
  const jsonSchema = z.toJSONSchema(opts.schema, { target: 'draft-7', io: 'input' });
  const key = sha1(JSON.stringify([opts.model, jsonSchema, opts.messages, opts.temperature ?? 0]));
  const hit = opts.cache?.cacheGet(key);
  if (hit) {
    const parsed = opts.schema.safeParse(JSON.parse(hit));
    if (parsed.success) return { data: parsed.data, cached: true };
  }

  let messages = withHebrewQuoteRule(opts.messages);
  const baseMessages = messages;
  let lastErr = '';
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ollamaChat(
      {
        model: opts.model,
        messages,
        format: jsonSchema,
        think: false,
        options: { temperature: opts.temperature ?? 0, num_ctx: opts.numCtx ?? 8192 },
      },
      { fetchImpl: opts.fetchImpl, baseUrl: opts.baseUrl },
    );
    lastRaw = res.message?.content ?? '';
    let obj: unknown;
    try {
      obj = JSON.parse(lastRaw);
    } catch {
      lastErr = 'reply was not valid JSON';
    }
    if (obj !== undefined) {
      const parsed = opts.schema.safeParse(obj);
      if (parsed.success) {
        opts.cache?.cachePut(key, opts.model, JSON.stringify(parsed.data));
        return { data: parsed.data, cached: false };
      }
      lastErr = z.prettifyError(parsed.error);
    }
    messages = [
      ...baseMessages,
      { role: 'assistant', content: lastRaw },
      { role: 'user', content: `The JSON did not match the schema:\n${lastErr}\nReturn corrected JSON only.` },
    ];
  }
  throw new LlmError(`invalid structured output after retry: ${lastErr}`, lastRaw);
}

export async function listLocalModels(baseUrl = config.OLLAMA_URL): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const json = (await res.json()) as { models?: Array<{ name: string }> };
  return (json.models ?? []).map((m) => m.name);
}
