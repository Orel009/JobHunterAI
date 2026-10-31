/**
 * Anthropic (Claude) via the official SDK. Structured output: output_config.format = {type: "json_schema", schema}.
 * No temperature (rejected on current models). Refusals (stop_reason "refusal") are errors.
 * On models that support it, server-side refusal fallbacks are enabled (beta server-side-fallback-2026-07-01).
 */
import Anthropic from '@anthropic-ai/sdk';
import { LlmError, splitSystem, type LlmProvider, type LlmReply, type LlmRequest } from '../types.js';

const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export function anthropicProvider(apiKey: () => string | undefined): LlmProvider {
  const client = () => {
    const key = apiKey();
    if (!key) throw new LlmError('ANTHROPIC_API_KEY is not set (Settings screen)');
    return new Anthropic({ apiKey: key });
  };
  const call = async (req: LlmRequest, schema?: Record<string, unknown>): Promise<LlmReply> => {
    const { system, rest } = splitSystem(req.messages);
    const base = {
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      ...(system ? { system } : {}),
      messages: rest.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ...(schema ? { output_config: { format: { type: 'json_schema' as const, schema } } } : {}),
    };
    try {
      const c = client();
      const res = FALLBACK_MODELS.has(req.model)
        ? await c.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as unknown as Parameters<typeof c.beta.messages.create>[0])
        : await c.messages.create(base as Parameters<typeof c.messages.create>[0]);
      const msg = res as unknown as { stop_reason: string | null; stop_details?: { category?: string | null } | null; content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number } };
      if (msg.stop_reason === 'refusal') throw new LlmError(`Claude declined (${msg.stop_details?.category ?? 'refusal'})`);
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      return { text, usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens } };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError('Anthropic: invalid API key');
      if (e instanceof Anthropic.RateLimitError) throw new LlmError('Anthropic: rate limited — try again later');
      if (e instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error ${e.status}: ${e.message}`);
      throw e;
    }
  };
  return {
    id: 'anthropic',
    label: 'Anthropic (Claude API)',
    local: false,
    generateStructured: (req, schema) => call(req, schema),
    generateText: (req) => call(req),
    listModels: async () => {
      const ids: string[] = [];
      for await (const m of client().models.list()) ids.push(m.id);
      return ids;
    },
  };
}
