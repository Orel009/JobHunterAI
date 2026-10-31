/**
 * Google Gemini via the official @google/genai SDK. Structured output: config.responseMimeType "application/json"
 * + config.responseJsonSchema (raw JSON Schema; unsupported keywords are ignored, zod validates afterwards).
 */
import { GoogleGenAI } from '@google/genai';
import { LlmError, splitSystem, type LlmProvider, type LlmReply, type LlmRequest } from '../types.js';

export function geminiProvider(apiKey: () => string | undefined): LlmProvider {
  const client = () => {
    const key = apiKey();
    if (!key) throw new LlmError('GEMINI_API_KEY is not set (Settings screen)');
    return new GoogleGenAI({ apiKey: key });
  };
  const call = async (req: LlmRequest, schema?: Record<string, unknown>): Promise<LlmReply> => {
    const { system, rest } = splitSystem(req.messages);
    try {
      const res = await client().models.generateContent({
        model: req.model,
        contents: rest.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        config: {
          ...(system ? { systemInstruction: system } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
        },
      });
      const u = res.usageMetadata;
      return {
        text: res.text ?? '',
        usage: { inputTokens: u?.promptTokenCount ?? 0, outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) },
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(`Gemini API error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    id: 'gemini',
    label: 'Google Gemini API',
    local: false,
    generateStructured: (req, schema) => call(req, schema),
    generateText: (req) => call(req),
    listModels: async () => {
      const names: string[] = [];
      const pager = await client().models.list();
      for await (const m of pager) if (m.name) names.push(m.name.replace(/^models\//, ''));
      return names;
    },
  };
}
