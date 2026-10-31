import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb } from '../src/db/index.js';
import { generateStructured, generateText } from '../src/llm/llm.js';
import { maskKey, publicSettings } from '../src/llm/settings.js';
import { setUsageDb, usageReport } from '../src/llm/usage.js';
import { sampleFromSchema } from '../src/llm/providers/fake.js';
import { LlmPausedError, strictSchema, type LlmProvider, type LlmReply } from '../src/llm/types.js';
import { buildScoreMessages, ScoreSchema } from '../src/llm/score.js';
import { writeSystem } from '../src/apply/draft.js';

/** Scripted provider: returns the queued replies in order and records what it was asked. */
function scripted(replies: string[], local = false) {
  const calls: Array<{ schema?: Record<string, unknown>; messages: unknown }> = [];
  const reply = (text: string): LlmReply => ({ text, usage: { inputTokens: 100, outputTokens: 50 } });
  const p: LlmProvider = {
    id: 'fake',
    label: 'scripted',
    local,
    generateStructured: async (req, schema) => (calls.push({ schema, messages: req.messages }), reply(replies.shift() ?? '{}')),
    generateText: async (req) => (calls.push({ messages: req.messages }), reply(replies.shift() ?? '')),
    listModels: async () => [],
  };
  return { p, calls };
}
const Answer = z.object({ answer: z.string().min(2), confidence: z.number().min(0).max(1), note: z.string().optional() });
const msgs = [{ role: 'user' as const, content: 'q' }];

beforeEach(() => setUsageDb(openDb(':memory:')));
afterEach(() => {
  setUsageDb(null);
  delete process.env.DAILY_LLM_TOKEN_LIMIT;
});

describe('provider contract', () => {
  it('passes a strict JSON schema to API providers and validates the reply', async () => {
    const { p, calls } = scripted(['{"answer":"כן","confidence":0.9,"note":null}']);
    const { data } = await generateStructured({ providerImpl: p, model: 'm', schema: Answer, messages: msgs });
    expect(data).toMatchObject({ answer: 'כן', confidence: 0.9 });
    const schema = calls[0]!.schema!;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['answer', 'confidence', 'note']); // optional → required + nullable
    expect(JSON.stringify(schema)).not.toContain('$schema');
    // the Hebrew quote rule is always in the system prompt
    expect(JSON.stringify(calls[0]!.messages)).toContain('gershayim');
  });

  it('retries once with the validation error, then succeeds', async () => {
    const { p, calls } = scripted(['{"answer":"x","confidence":2}', '{"answer":"ok!","confidence":1,"note":null}']);
    const { data } = await generateStructured({ providerImpl: p, model: 'm', schema: Answer, messages: msgs });
    expect(data.answer).toBe('ok!');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.messages)).toMatch(/did not match the schema/);
  });

  it('fails after the retry instead of returning invalid data', async () => {
    const { p } = scripted(['nope', 'still nope']);
    await expect(generateStructured({ providerImpl: p, model: 'm', schema: Answer, messages: msgs })).rejects.toThrow(/after retry/);
  });

  it('records token usage per provider/model', async () => {
    const { p } = scripted(['{"answer":"ok","confidence":1,"note":null}', 'free text']);
    await generateStructured({ providerImpl: p, model: 'm1', schema: Answer, messages: msgs });
    await generateText({ providerImpl: p, model: 'm1', messages: msgs });
    const r = await usageReport();
    expect(r.rows[0]).toMatchObject({ provider: 'fake', model: 'm1', input_tokens: 200, output_tokens: 100, calls: 2 });
    expect(r.today.apiTokens).toBe(300);
  });
});

describe('daily token limit', () => {
  it('pauses API calls once the limit is reached; local providers are not limited', async () => {
    process.env.DAILY_LLM_TOKEN_LIMIT = '250';
    const api = scripted(['{"answer":"ok","confidence":1,"note":null}', '{"answer":"ok","confidence":1,"note":null}']);
    await generateStructured({ providerImpl: api.p, model: 'm', schema: Answer, messages: msgs }); // 150 tokens
    await generateStructured({ providerImpl: api.p, model: 'm', schema: Answer, messages: [{ role: 'user', content: 'other' }] }); // 300
    await expect(generateStructured({ providerImpl: api.p, model: 'm', schema: Answer, messages: [{ role: 'user', content: 'third' }] })).rejects.toBeInstanceOf(LlmPausedError);
    await expect(generateText({ providerImpl: api.p, model: 'm', messages: msgs })).rejects.toThrow(/token limit/);
    const local = scripted(['{"answer":"ok","confidence":1,"note":null}'], true);
    await expect(generateStructured({ providerImpl: local.p, model: 'm', schema: Answer, messages: msgs })).resolves.toBeTruthy();
  });

  it('no limit set → never pauses', async () => {
    const api = scripted(Array(5).fill('{"answer":"ok","confidence":1,"note":null}'));
    for (let i = 0; i < 5; i++) await generateStructured({ providerImpl: api.p, model: 'm', schema: Answer, messages: [{ role: 'user', content: `q${i}` }] });
  });
});

describe('API keys', () => {
  it('are masked to 4+4 characters', () => {
    expect(maskKey('sk-ant-api03-abcdefghijklmnop-WXYZ')).toBe('sk-a…WXYZ');
    expect(maskKey('short')).toBe('••••');
    expect(maskKey(undefined)).toBeNull();
  });
  it('never appear unmasked in the settings response', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-SECRETSECRETSECRET-9876';
    const s = JSON.stringify(publicSettings());
    expect(s).not.toContain('SECRETSECRET');
    expect(s).toContain('sk-a…9876');
    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe('schemas', () => {
  it('strictSchema handles nested objects, arrays and nullables', () => {
    const raw = z.toJSONSchema(z.object({ a: z.array(z.object({ b: z.string(), c: z.number().optional() })), d: z.string().nullable() }), { target: 'draft-7', io: 'input' });
    const s = strictSchema(raw) as { properties: { a: { items: Record<string, unknown> } } };
    expect(s.properties.a.items).toMatchObject({ additionalProperties: false, required: ['b', 'c'] });
  });
  it('test-mode provider produces schema-valid answers (empty but valid)', () => {
    const raw = z.toJSONSchema(ScoreSchema, { target: 'draft-7', io: 'input' });
    expect(ScoreSchema.safeParse(sampleFromSchema(strictSchema(raw))).success).toBe(true);
  });
});

describe('Hebrew grammatical gender comes from the profile', () => {
  it('drafts: first person masculine / feminine / neutral', () => {
    expect(writeSystem('he', 'male')).toMatch(/לשון זכר/);
    expect(writeSystem('he', 'male')).toContain('אני מתעניין');
    expect(writeSystem('he', 'female')).toMatch(/לשון נקבה/);
    expect(writeSystem('he', 'female')).toContain('אני מתעניינת');
    expect(writeSystem('he', null)).toMatch(/נייטרליות/);
    expect(writeSystem('he', 'female')).not.toMatch(/לשון זכר/);
  });
  it('score reasoning: third person', () => {
    const job = { title: 't', company: 'c', location: '', descriptionText: 'd', requirementsText: '' };
    const sys = (g: 'male' | 'female' | null) => buildScoreMessages(job, 'cand', null, g)[0]!.content;
    expect(sys('female')).toContain('המועמדת');
    expect(sys('male')).toMatch(/masculine forms \(המועמד/);
    expect(sys(null)).toContain('המועמד/ת');
  });
});
