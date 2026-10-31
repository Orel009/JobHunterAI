/** Ollama on this machine (default, free, private). Native structured output: `format` = JSON Schema. */
import { config } from '../../config.js';
import { LlmError, type LlmProvider, type LlmReply, type LlmRequest } from '../types.js';

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export function ollamaProvider(opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): LlmProvider {
  const base = () => opts.baseUrl ?? config.OLLAMA_URL;
  const chat = async (req: LlmRequest, format?: Record<string, unknown>): Promise<LlmReply> => {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(`${base()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: false,
        model: req.model,
        messages: req.messages,
        ...(format ? { format } : {}),
        think: false,
        options: { temperature: req.temperature ?? 0, num_ctx: req.numCtx ?? 8192 },
      }),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as OllamaChatResponse;
    if (!res.ok || json.error) throw new LlmError(`ollama ${res.status}: ${json.error ?? res.statusText}`);
    return { text: json.message?.content ?? '', usage: { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 } };
  };
  return {
    id: 'ollama',
    label: 'Ollama (local, free)',
    local: true,
    generateStructured: (req, schema) => chat(req, schema),
    generateText: (req) => chat(req),
    listModels: async () => {
      const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      return (json.models ?? []).map((m) => m.name);
    },
  };
}

export async function ollamaModelsWithSize(baseUrl = config.OLLAMA_URL): Promise<Array<{ name: string; size: number }>> {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const json = (await res.json()) as { models?: Array<{ name: string; size: number }> };
  return json.models ?? [];
}
