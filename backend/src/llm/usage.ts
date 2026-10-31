/** Token usage per day / provider / model, the cost estimate, and the daily token limit for API providers. */
import type { DB } from '../db/index.js';
import { getDb } from '../db/index.js';
import { dailyTokenLimit, readSettingsFile } from './settings.js';
import { LlmPausedError, type LlmUsage, type ProviderId } from './types.js';

let override: DB | null = null;
/** test seam */
export const setUsageDb = (db: DB | null) => {
  override = db;
};
const db = async () => override ?? (await getDb());
const today = () => new Date().toISOString().slice(0, 10);

export async function recordUsage(provider: ProviderId, model: string, u: LlmUsage): Promise<void> {
  (await db())
    .prepare(
      `INSERT INTO llm_usage (day, provider, model, input_tokens, output_tokens, calls) VALUES (?,?,?,?,?,1)
       ON CONFLICT(day, provider, model) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens, calls = calls + 1`,
    )
    .run(today(), provider, model, u.inputTokens, u.outputTokens);
}

/** Today's tokens across API (non-local) providers. */
export async function apiTokensToday(localProviders: ProviderId[] = ['ollama']): Promise<number> {
  const rows = (await db()).prepare('SELECT provider, input_tokens + output_tokens AS t FROM llm_usage WHERE day = ?').all(today()) as Array<{ provider: string; t: number }>;
  return rows.filter((r) => !localProviders.includes(r.provider as ProviderId)).reduce((a, r) => a + r.t, 0);
}

/** Throws LlmPausedError when DAILY_LLM_TOKEN_LIMIT is set and today's API tokens reached it. */
export async function assertUnderLimit(): Promise<void> {
  const limit = dailyTokenLimit();
  if (!limit) return;
  const used = await apiTokensToday();
  if (used >= limit) throw new LlmPausedError(`daily LLM token limit reached (${used.toLocaleString()} / ${limit.toLocaleString()} tokens) — LLM steps paused until tomorrow`);
}

export async function usageReport(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = (await db())
    .prepare('SELECT * FROM llm_usage WHERE day >= ? ORDER BY day DESC, provider, model')
    .all(since) as Array<{ day: string; provider: string; model: string; input_tokens: number; output_tokens: number; calls: number }>;
  const prices = readSettingsFile().prices;
  const withCost = rows.map((r) => {
    const p = prices[`${r.provider}:${r.model}`];
    return { ...r, cost: p ? (r.input_tokens * p.input + r.output_tokens * p.output) / 1_000_000 : null };
  });
  const t = today();
  const todayRows = withCost.filter((r) => r.day === t);
  return {
    rows: withCost,
    today: {
      tokens: todayRows.reduce((a, r) => a + r.input_tokens + r.output_tokens, 0),
      apiTokens: await apiTokensToday(),
      cost: todayRows.some((r) => r.cost !== null) ? todayRows.reduce((a, r) => a + (r.cost ?? 0), 0) : null,
    },
    limit: dailyTokenLimit(),
  };
}
