/**
 * OpenAI via the official SDK (Responses API). Structured output: text.format = {type: "json_schema", name, schema,
 * strict: true}. Temperature is not sent (reasoning models reject it).
 */
import OpenAI from 'openai';
import { LlmError, splitSystem, type LlmProvider, type LlmReply, type LlmRequest } from '../types.js';

export function openaiProvider(apiKey: () => string | undefined): LlmProvider {
  const client = () => {
    const key = apiKey();
    if (!key) throw new LlmError('OPENAI_API_KEY is not set (Settings screen)');
    return new OpenAI({ apiKey: key });
  };
  const call = async (req: LlmRequest, schema?: Record<string, unknown>): Promise<LlmReply> => {
    const { system, rest } = splitSystem(req.messages);
    try {
      const res = await client().responses.create({
        model: req.model,
        ...(system ? { instructions: system } : {}),
        input: rest.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        ...(schema ? { text: { format: { type: 'json_schema' as const, name: 'result', schema, strict: true } } } : {}),
      });
      return { text: res.output_text ?? '', usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 } };
    } catch (e) {
      if (e instanceof OpenAI.APIError) throw new LlmError(`OpenAI API error ${e.status ?? ''}: ${e.message}`);
      throw e;
    }
  };
  return {
    id: 'openai',
    label: 'OpenAI API',
    local: false,
    generateStructured: (req, schema) => call(req, schema),
    generateText: (req) => call(req),
    listModels: async () => {
      const ids: string[] = [];
      for await (const m of client().models.list()) ids.push(m.id);
      return ids.sort();
    },
  };
}
