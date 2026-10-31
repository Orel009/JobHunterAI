import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import YAML from 'yaml';
import { z } from 'zod';
import { config } from '../config.js';
import { loadPrefs, PrefsSchema } from '../core/prefs.js';
import { listFacts, profilePath, skillYears } from '../profile/facts.js';
import { ProfileSchema } from '../profile/schema.js';
import { currentProfileFile, draftPath, readProfileRaw, validateProfile, writeProfileFile } from '../profile/store.js';
import { ackDrushimUpdate, applyPending, discardPending, extractionJob, readCvState, readPending, saveCvUpload, startExtraction } from '../profile/cv-update.js';

export function registerEditorRoutes(app: FastifyInstance) {
  // ---------- profile ----------
  app.get('/api/profile', async () => {
    const { source, file } = currentProfileFile();
    if (!file) return { source, profile: null, validation: { ok: false, issues: ['no profile yet'] }, derived: null };
    const raw = readProfileRaw(file);
    const v = validateProfile(raw);
    // lenient parse for display even when invalid (CONFLICT values etc.)
    const loose = ProfileSchema.safeParse(JSON.parse(JSON.stringify(raw).replace(/"CONFLICT [^"]*"/g, 'null')));
    const p = v.profile ?? (loose.success ? loose.data : null);
    const derived = p ? { skillYears: Object.fromEntries(p.skills.map((s) => [s.id, skillYears(p, s.id)])), facts: listFacts(p).length } : null;
    return { source, path: path.relative(process.cwd(), file), profile: raw, validation: { ok: v.ok, issues: v.issues }, derived };
  });

  /** Save. profile.json must validate; a draft may be saved with issues (shown back to you). */
  app.put('/api/profile', async (req, reply) => {
    const body = z.object({ profile: z.unknown(), target: z.enum(['profile', 'draft']).optional() }).parse(req.body);
    const { source } = currentProfileFile();
    const target = body.target ?? (source === 'draft' ? 'draft' : 'profile');
    const v = validateProfile(body.profile);
    if (target === 'profile' && !v.ok) return reply.status(400).send({ error: 'profile is not valid — not saved', issues: v.issues });
    writeProfileFile(target === 'profile' ? profilePath() : draftPath(), target === 'profile' ? v.profile : body.profile);
    return { ok: true, target, validation: { ok: v.ok, issues: v.issues } };
  });

  /** Reviewed draft → profile.json (the draft is kept as a backup). */
  app.post('/api/profile/promote', async (_req, reply) => {
    if (!fs.existsSync(draftPath())) return reply.status(404).send({ error: 'no draft' });
    const v = validateProfile(readProfileRaw(draftPath()));
    if (!v.ok) return reply.status(400).send({ error: 'draft is not valid yet', issues: v.issues });
    writeProfileFile(profilePath(), v.profile);
    fs.renameSync(draftPath(), path.join(config.paths.profileDir, `profile.draft.promoted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    return { ok: true };
  });

  // ---------- preferences ----------
  app.get('/api/preferences', async () => {
    const file = config.paths.preferences;
    const exists = fs.existsSync(file);
    return { path: path.relative(process.cwd(), file), exists, preferences: loadPrefs(), englishRatioEnv: config.ENGLISH_CV_MAX_HEBREW_RATIO };
  });

  app.put('/api/preferences', async (req, reply) => {
    const parsed = PrefsSchema.safeParse((req.body as { preferences?: unknown })?.preferences);
    if (!parsed.success) return reply.status(400).send({ error: 'preferences are not valid — not saved', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const file = config.paths.preferences;
    if (fs.existsSync(file)) {
      const dir = path.join(config.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(file, path.join(dir, `preferences-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# JobHunter preferences — edited in the dashboard (Preferences screen). Previous versions: data/backups/\n${YAML.stringify(parsed.data, { lineWidth: 0 })}`);
    return { ok: true, preferences: loadPrefs() };
  });
}

// ---------- CV uploads + profile update (registered separately: needs the DB for re-scoring) ----------
export function registerCvRoutes(app: FastifyInstance, deps: { cache: import('../llm/ollama.js').LlmCache; rescore: () => { runId: number } }) {
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get('/api/profile/cv', async () => {
    const prefs = loadPrefs();
    const pending = readPending();
    return {
      state: readCvState(),
      job: extractionJob(),
      pending: pending ? { createdAt: pending.createdAt, target: pending.target, count: pending.entries.length } : null,
      drushimCvNames: { he: prefs.cv.he, en: prefs.cv.en },
    };
  });

  app.post<{ Params: { lang: string } }>('/api/profile/cv/:lang', async (req, reply) => {
    const lang = z.enum(['he', 'en']).parse(req.params.lang);
    if (!Buffer.isBuffer(req.body)) return reply.status(415).send({ error: 'send the PDF as application/pdf' });
    const r = saveCvUpload(lang, req.body);
    // a second upload while the first is being read: saved; click “read CVs again” when the first finishes
    const job = extractionJob().status === 'running' ? extractionJob() : startExtraction({ cache: deps.cache });
    return { ...r, job, note: job.startedAt && extractionJob().stage !== 'starting' ? 'another extraction is running — read the CVs again when it finishes' : undefined };
  });

  app.post('/api/profile/cv/extract', async () => startExtraction({ cache: deps.cache }));
  app.post<{ Params: { lang: string } }>('/api/profile/cv/:lang/ack', async (req) => {
    ackDrushimUpdate(z.enum(['he', 'en']).parse(req.params.lang));
    return { ok: true };
  });

  app.get('/api/profile/update', async () => readPending());
  app.post('/api/profile/update/apply', async (req, reply) => {
    const body = z.object({ accepted: z.array(z.string()) }).parse(req.body);
    const r = applyPending(body.accepted);
    if (!r.ok) return reply.status(400).send({ error: 'the updated profile would not be valid — nothing saved', issues: r.issues });
    return r;
  });
  app.delete('/api/profile/update', async () => ({ ok: discardPending() !== false }));

  /** After a profile change: re-score active (scored) jobs. */
  app.post('/api/jobs/rescore', async () => deps.rescore());
}
