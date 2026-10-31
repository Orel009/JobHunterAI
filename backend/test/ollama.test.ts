import { describe, expect, it, vi } from 'vitest';
import { chatJson } from '../src/llm/llm.js';
import { ScoreSchema } from '../src/llm/score.js';

const reply = (content: string) => new Response(JSON.stringify({ message: { content } }), { status: 200 });
const valid = {
  score: 82,
  matchedSkills: ['React'],
  missingRequirements: [],
  seniorityFit: 'fit',
  reasoningHe: 'המועמד מתאים מאוד. חסר לו מעט ניסיון בענן.',
  requiredYearsMin: 2,
  requiredYearsQuote: 'ניסיון של שנתיים',
  seniority: 'mid',
  devContentScore: 80,
  isTrainingProgram: false,
};
const msgs = [{ role: 'user' as const, content: 'x' }];

function memCache() {
  const m = new Map<string, string>();
  return { cacheGet: (k: string) => m.get(k) ?? null, cachePut: (k: string, _m: string, v: string) => void m.set(k, v) };
}

describe('chatJson', () => {
  it('sends a JSON schema in `format`, disables thinking, and validates', async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => reply(JSON.stringify(valid)));
    const { data } = await chatJson({ model: 'm', schema: ScoreSchema, messages: msgs, fetchImpl: f as unknown as typeof fetch });
    expect(data.score).toBe(82);
    const body = JSON.parse(f.mock.calls[0]![1].body as string) as { format: { type: string; required: string[] }; think: boolean };
    expect(body.format.type).toBe('object');
    expect(body.format.required).toContain('reasoningHe');
    expect(body.think).toBe(false);
  });

  it('retries once on invalid output, then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(reply('{"score": 150}')).mockResolvedValueOnce(reply(JSON.stringify(valid)));
    const { data } = await chatJson({ model: 'm', schema: ScoreSchema, messages: msgs, fetchImpl: f as unknown as typeof fetch });
    expect(data.score).toBe(82);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('throws after the retry fails', async () => {
    const f = vi.fn(async () => reply('not json'));
    await expect(chatJson({ model: 'm', schema: ScoreSchema, messages: msgs, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/after retry/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('caches valid results by content hash', async () => {
    const cache = memCache();
    const f = vi.fn(async () => reply(JSON.stringify(valid)));
    const opts = { model: 'm', schema: ScoreSchema, messages: msgs, fetchImpl: f as unknown as typeof fetch, cache };
    await chatJson(opts);
    const second = await chatJson(opts);
    expect(second.cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
