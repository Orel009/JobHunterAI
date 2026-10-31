/** History screen: applications sent, evidence, your outcome tracking, CSV export and stats. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { loadPrefs } from '../core/prefs.js';
import { ServiceError } from '../apply/service.js';
import { addOutcome, deleteOutcome, historyCsv, historyEntries, historyStats, OUTCOMES, setNotes } from '../history/history.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const Filter = z.object({ site: z.string().optional(), outcome: z.enum(OUTCOMES).optional(), from: day.optional(), to: day.optional() });

export function registerHistoryRoutes(app: FastifyInstance, db: DB): void {
  const list = (q: unknown) => historyEntries(db, loadPrefs(), Filter.parse(q ?? {}));

  app.get('/api/history', async (req) => list(req.query));

  app.get('/api/history/stats', async (req) => historyStats(list(req.query)));

  app.get('/api/history.csv', async (req, reply) => {
    const name = `jobhunter-history-${new Date().toISOString().slice(0, 10)}.csv`;
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(historyCsv(list(req.query)));
  });

  app.post<{ Params: { jobId: string } }>('/api/history/:jobId/outcome', async (req) => {
    const b = z.object({ outcome: z.enum(OUTCOMES), date: day.optional(), note: z.string().max(2000).nullable().optional() }).parse(req.body ?? {});
    try {
      return addOutcome(db, req.params.jobId, b.outcome, b.date, b.note ?? null);
    } catch (e) {
      throw new ServiceError(400, (e as Error).message);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/history/outcome/:id', async (req) => ({ ok: deleteOutcome(db, Number(req.params.id)) }));

  app.put<{ Params: { jobId: string } }>('/api/history/:jobId/notes', async (req) => {
    const { notes } = z.object({ notes: z.string().max(20_000) }).parse(req.body ?? {});
    setNotes(db, req.params.jobId, notes);
    return { ok: true };
  });
}
