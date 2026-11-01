/**
 * Runs that score check the model first: not there (Ollama not running) → HTTP 409 with code "llm_unreachable", and the
 * dashboard offers "Start Ollama and run" / "Run without scoring". `withoutLlm: true` in the body runs anyway (the jobs
 * are read and filtered, and wait for scoring).
 */
import type { FastifyReply } from 'fastify';
import { llmReachable } from '../llm/reachable.js';

export async function llmGate(body: unknown, reply: FastifyReply): Promise<boolean> {
  if ((body as { withoutLlm?: unknown } | null)?.withoutLlm === true) return true;
  const r = await llmReachable();
  if (r.ok) return true;
  void reply.status(409).send({ error: `${r.reason} — scoring needs it`, code: 'llm_unreachable', canStart: r.canStart });
  return false;
}
