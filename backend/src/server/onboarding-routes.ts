/**
 * First-run setup wizard (one user per installation). It opens when there is neither profile.json nor
 * profile.draft.json and it was never completed; an existing installation never sees it.
 * State lives in data/onboarding.json. Also: the manual Drushim login window, opened from the UI.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROOT_DIR, config } from '../config.js';
import type { DB } from '../db/index.js';
import { loadPrefs } from '../core/prefs.js';
import { AnswersBank, SEED_QUESTIONS } from '../apply/bank.js';
import { closeContext } from '../browser/session.js';
import { checkDrushimSession } from '../browser/site-session.js';
import { getActiveRun, startTask } from '../pipeline/runner.js';
import { candidateGender, profilePath } from '../profile/facts.js';
import { draftPath, readProfileRaw, validateProfile, writeProfileFile } from '../profile/store.js';
import { log } from '../log.js';

const Gender = z.enum(['male', 'female']).nullable();
export const WIZARD_STEPS = ['about', 'llm', 'cv', 'review', 'skills', 'experience', 'search', 'drushim', 'answers'] as const;

const StateSchema = z.object({
  active: z.boolean().default(false),
  step: z.number().int().min(0).default(0),
  name: z.string().default(''),
  gender: Gender.default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  skipped: z.boolean().default(false),
});
export type OnboardingState = z.infer<typeof StateSchema>;

const stateFile = () => path.join(config.dataDir, 'onboarding.json');

export function readOnboarding(): OnboardingState {
  try {
    return StateSchema.parse(JSON.parse(fs.readFileSync(stateFile(), 'utf8')));
  } catch {
    return StateSchema.parse({});
  }
}

function writeOnboarding(s: OnboardingState) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
}

/** The wizard shows while it is in progress, or on a fresh installation (no profile, no draft, never completed). */
export function onboardingNeeded(s = readOnboarding()): boolean {
  if (s.completedAt) return false;
  if (s.active) return true;
  return !fs.existsSync(profilePath()) && !fs.existsSync(draftPath());
}

/** Copies the wizard's name + gender into the draft (user-entered: they win over the CV extraction). */
export function applyIdentityToDraft(s: OnboardingState): boolean {
  if (!fs.existsSync(draftPath()) || fs.existsSync(profilePath())) return false;
  const d = readProfileRaw(draftPath()) as { gender?: unknown; contact?: { name?: { he: string | null; en: string | null } } };
  const name = s.name.trim();
  if (name) {
    d.contact ??= {};
    d.contact.name ??= { he: null, en: null };
    d.contact.name[/[א-ת]/.test(name) ? 'he' : 'en'] = name;
  }
  d.gender = s.gender;
  writeProfileFile(draftPath(), d);
  return true;
}

let loginChild: ChildProcess | null = null;

export function registerOnboardingRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/onboarding', async () => {
    const s = readOnboarding();
    return { needed: onboardingNeeded(s), state: s, steps: WIZARD_STEPS, profileExists: fs.existsSync(profilePath()), draftExists: fs.existsSync(draftPath()) };
  });

  app.put('/api/onboarding', async (req) => {
    const b = z.object({ step: z.number().int().min(0).max(WIZARD_STEPS.length).optional(), name: z.string().max(120).optional(), gender: Gender.optional() }).parse(req.body ?? {});
    const s = readOnboarding();
    const next: OnboardingState = { ...s, ...b, active: true, startedAt: s.startedAt ?? new Date().toISOString() };
    writeOnboarding(next);
    if (b.name !== undefined || b.gender !== undefined) applyIdentityToDraft(next);
    return { needed: true, state: next };
  });

  /** Approves the draft (it must be valid) and ends the wizard. */
  app.post('/api/onboarding/finish', async (_req, reply) => {
    const s = readOnboarding();
    applyIdentityToDraft(s);
    if (!fs.existsSync(profilePath())) {
      if (!fs.existsSync(draftPath())) return reply.status(400).send({ error: 'no profile yet — upload a CV first' });
      const v = validateProfile(readProfileRaw(draftPath()));
      if (!v.ok) return reply.status(400).send({ error: 'the profile is not valid yet', issues: v.issues });
      writeProfileFile(profilePath(), v.profile);
      fs.renameSync(draftPath(), path.join(config.paths.profileDir, `profile.draft.promoted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    }
    new AnswersBank(db).seed(loadPrefs(), candidateGender());
    writeOnboarding({ ...s, active: false, completedAt: new Date().toISOString() });
    return { ok: true };
  });

  /** "Set up later": hide the wizard; everything stays editable on the normal screens. */
  app.post('/api/onboarding/skip', async () => {
    const s = readOnboarding();
    writeOnboarding({ ...s, active: false, skipped: true, completedAt: new Date().toISOString() });
    return { ok: true };
  });

  /** The standard questions the wizard asks, in the candidate's grammatical gender. */
  app.get('/api/onboarding/standard-questions', async () => {
    const g = candidateGender() ?? 'neutral';
    const answers = loadPrefs().standardAnswers;
    return Object.entries(SEED_QUESTIONS).map(([key, d]) => ({ key, question: d.question[g], type: d.type, value: answers[key] ?? '' }));
  });


  // ---------- manual login window ----------
  app.get('/api/session/login', async () => ({ running: !!loginChild }));

  /**
   * Opens the site in the app's browser profile so YOU can log in by hand (we never type credentials or automate
   * login). When you close the window, the session is re-checked.
   */
  app.post('/api/session/login', async (req, reply) => {
    const site = z.object({ site: z.string().default('drushim') }).parse(req.body ?? {}).site;
    if (loginChild) return reply.status(409).send({ error: 'the login window is already open' });
    if (getActiveRun()) return reply.status(409).send({ error: 'a run is active — wait for it or stop it first' });
    await closeContext(); // the browser profile can only be open once
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'cli', 'login.ts'), site], {
      cwd: path.join(ROOT_DIR, 'backend'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    loginChild = child;
    child.stdout?.on('data', (d: Buffer) => log.info({ login: d.toString().trim() }, 'login window'));
    child.stderr?.on('data', (d: Buffer) => log.warn({ login: d.toString().trim() }, 'login window'));
    child.on('exit', () => {
      loginChild = null;
      try {
        startTask(db, site, 'session_check', async () => void (await checkDrushimSession()));
      } catch (e) {
        log.warn({ err: String(e) }, 'session check after login not started');
      }
    });
    return { started: true };
  });
}
