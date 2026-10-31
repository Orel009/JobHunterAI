/**
 * Test mode: no model at all. Returns the smallest JSON that satisfies the requested schema (empty lists, nulls,
 * first enum value, zeros, short placeholder strings) and a fixed text. Lets you try the whole UI without a GPU or
 * an API key; results are obviously empty. Never use it for real applications.
 */
import type { LlmProvider, LlmReply, LlmRequest } from '../types.js';

type Schema = Record<string, unknown>;

export function sampleFromSchema(s: unknown): unknown {
  const sc = (s ?? {}) as Schema;
  if (Array.isArray(sc.enum)) return sc.enum[0];
  if ('const' in sc) return sc.const;
  for (const k of ['anyOf', 'oneOf']) {
    if (Array.isArray(sc[k])) {
      const opts = sc[k] as Schema[];
      const nul = opts.find((o) => o.type === 'null');
      return nul ? null : sampleFromSchema(opts[0]);
    }
  }
  const type = Array.isArray(sc.type) ? (sc.type.includes('null') ? 'null' : sc.type[0]) : sc.type;
  switch (type) {
    case 'null':
      return null;
    case 'object': {
      const props = (sc.properties ?? {}) as Record<string, unknown>;
      const req = new Set((sc.required as string[] | undefined) ?? Object.keys(props));
      return Object.fromEntries(Object.entries(props).filter(([k]) => req.has(k)).map(([k, v]) => [k, sampleFromSchema(v)]));
    }
    case 'array':
      return Array.from({ length: Number(sc.minItems ?? 0) }, () => sampleFromSchema(sc.items));
    case 'integer':
    case 'number':
      return typeof sc.minimum === 'number' ? sc.minimum : 0;
    case 'boolean':
      return false;
    case 'string': {
      const min = Number(sc.minLength ?? 0);
      return 'test mode'.padEnd(Math.max(min, 9), '.');
    }
    default:
      return null;
  }
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

export function fakeProvider(): LlmProvider {
  const usageOf = (req: LlmRequest, out: string) => ({ inputTokens: approxTokens(req.messages.map((m) => m.content).join('\n')), outputTokens: approxTokens(out) });
  return {
    id: 'fake',
    label: 'Test mode (no model — fake empty answers)',
    local: false,
    generateStructured: async (req, schema): Promise<LlmReply> => {
      const text = JSON.stringify(sampleFromSchema(schema));
      return { text, usage: usageOf(req, text) };
    },
    generateText: async (req): Promise<LlmReply> => {
      const text = '[test mode] This text was not written by a model.';
      return { text, usage: usageOf(req, text) };
    },
    listModels: async () => ['test-model'],
  };
}
