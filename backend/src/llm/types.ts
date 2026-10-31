export type Task = 'analyze' | 'write';
export type ProviderId = 'ollama' | 'anthropic' | 'openai' | 'gemini' | 'fake';
export const PROVIDER_IDS: ProviderId[] = ['ollama', 'anthropic', 'openai', 'gemini', 'fake'];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  numCtx?: number;
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmReply {
  text: string;
  usage: LlmUsage;
}

/**
 * One interface for every model backend. Providers return raw text; the caller (llm.ts) validates JSON with zod,
 * retries once, caches, tracks usage and enforces the daily token limit.
 */
export interface LlmProvider {
  id: ProviderId;
  label: string;
  /** runs on this machine (nothing leaves it; no token limit/cost) */
  local: boolean;
  /** JSON constrained to `jsonSchema` using the provider's native structured-output mode */
  generateStructured(req: LlmRequest, jsonSchema: Record<string, unknown>): Promise<LlmReply>;
  generateText(req: LlmRequest): Promise<LlmReply>;
  /** model ids for suggestions (empty when the provider has no list endpoint or is unreachable) */
  listModels(): Promise<string[]>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly raw?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** The daily token limit for API providers was reached: LLM steps pause until tomorrow (or a higher limit). */
export class LlmPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmPausedError';
  }
}

/**
 * Strict JSON Schema for cloud structured-output modes: every object gets additionalProperties:false and lists all
 * its properties as required (optional ones become nullable); "$schema" is dropped.
 */
export function strictSchema(schema: unknown): Record<string, unknown> {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== 'object') return s;
    const o = { ...(s as Record<string, unknown>) };
    delete o.$schema;
    for (const k of ['items', 'additionalItems', 'not']) if (o[k] && typeof o[k] === 'object') o[k] = walk(o[k]);
    for (const k of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map(walk);
    if (o.definitions && typeof o.definitions === 'object') o.definitions = Object.fromEntries(Object.entries(o.definitions).map(([k, v]) => [k, walk(v)]));
    if (o.type === 'object' && o.properties && typeof o.properties === 'object') {
      const props = o.properties as Record<string, unknown>;
      const req = new Set((o.required as string[] | undefined) ?? []);
      o.properties = Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, req.has(k) ? walk(v) : { anyOf: [walk(v), { type: 'null' }] }]),
      );
      o.required = Object.keys(props);
      o.additionalProperties = false;
    }
    return o;
  };
  return walk(schema) as Record<string, unknown>;
}

/**
 * Inverse of strictSchema for the reply: fields that were OPTIONAL in the original schema come back as null under
 * strict mode — drop them so zod's .optional() accepts the object.
 */
export function dropNullOptionals(value: unknown, original: unknown): unknown {
  const sc = (original ?? {}) as Record<string, unknown>;
  if (Array.isArray(value)) return value.map((v) => dropNullOptionals(v, sc.items));
  if (!value || typeof value !== 'object' || sc.type !== 'object' || !sc.properties) return value;
  const props = sc.properties as Record<string, unknown>;
  const req = new Set((sc.required as string[] | undefined) ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null && !req.has(k)) continue;
    out[k] = dropNullOptionals(v, props[k]);
  }
  return out;
}

/** Splits leading system messages from the conversation (most cloud APIs take the system prompt separately). */
export function splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  return { system, rest: messages.filter((m) => m.role !== 'system') };
}
