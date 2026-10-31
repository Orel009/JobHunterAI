import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listModels, getProvider, testConnection } from '../llm/llm.js';
import { publicSettings, readSettingsFile, setApiKey, setTask, writeEnv, writeSettingsFile, KEY_VARS } from '../llm/settings.js';
import { usageReport } from '../llm/usage.js';
import { PROVIDER_IDS, type ProviderId } from '../llm/types.js';

const Provider = z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]);
const TaskCfg = z.object({ provider: Provider, model: z.string().min(1) });

export function registerLlmRoutes(app: FastifyInstance) {
  const providers = () => PROVIDER_IDS.map((id) => ({ id, label: getProvider(id).label, local: getProvider(id).local, needsKey: !!KEY_VARS[id] }));

  /** Keys are only ever returned masked. */
  app.get('/api/llm/settings', async () => ({ ...publicSettings(), providers: providers() }));

  app.put('/api/llm/settings', async (req) => {
    const b = z
      .object({
        analyze: TaskCfg.optional(),
        write: TaskCfg.optional(),
        /** write-only: a new key, or null/'' to remove it */
        keys: z.record(z.string(), z.string().nullable()).optional(),
        dailyTokenLimit: z.number().int().min(0).optional(),
        prices: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })).optional(),
      })
      .parse(req.body);
    if (b.analyze) setTask('analyze', b.analyze);
    if (b.write) setTask('write', b.write);
    for (const [p, key] of Object.entries(b.keys ?? {})) setApiKey(Provider.parse(p), key);
    if (b.dailyTokenLimit !== undefined) writeEnv({ DAILY_LLM_TOKEN_LIMIT: b.dailyTokenLimit ? String(b.dailyTokenLimit) : '' });
    if (b.prices) writeSettingsFile({ ...readSettingsFile(), prices: b.prices });
    return { ...publicSettings(), providers: providers() };
  });

  app.get('/api/llm/models', async (req) => listModels(Provider.parse((req.query as { provider?: string }).provider)));

  app.post('/api/llm/test', async (req) => {
    const b = z.object({ provider: Provider, model: z.string().min(1) }).parse(req.body);
    return testConnection(b.provider, b.model);
  });

  app.get('/api/llm/usage', async () => usageReport());
}
