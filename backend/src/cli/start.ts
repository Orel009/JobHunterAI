/**
 * Checks 2–8 of `npm start` (check 1, Node + dependencies, runs in scripts/start.mjs before tsx exists).
 *   --doctor   checks 1–6 only, report, change nothing
 *   --hunt     after startup: discover → score → prepare plans for jobs ≥ threshold (never submits)
 *   --no-open  don't open the browser
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const DOCTOR = args.includes('--doctor');
const HUNT = args.includes('--hunt');
const NO_OPEN = args.includes('--no-open');
if (DOCTOR) process.env.JOBHUNTER_READONLY = '1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// ---------- output ----------
const c = { red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
const failures: string[] = [];
const warnings: string[] = [];
const ok = (en: string) => console.log(`${c.green('✓')} ${en}`);
const warn = (he: string, en: string, fixHe?: string, fixEn?: string) => {
  warnings.push(en);
  console.log(`${c.yellow('!')} ${en}\n  ${he}${fixEn ? `\n  → ${fixEn}\n  → ${fixHe}` : ''}`);
};
/** Stops startup (or, in doctor mode, records the failure and continues). */
function fail(he: string, en: string, fixHe: string, fixEn: string): void {
  failures.push(en);
  console.log(`${c.red('✗')} ${en}\n  ${he}\n  → ${fixEn}\n  → ${fixHe}`);
  if (!DOCTOR) {
    console.log(c.red('\nStartup stopped at the first failing check. / ההפעלה נעצרה בבדיקה הראשונה שנכשלה.'));
    process.exit(1);
  }
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${question} (non-interactive → no)`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} (y/N) `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes' || a === 'כ' || a === 'כן';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- check 4a: .env (before anything imports config) ----------
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  fail('קובץ ‎.env חסר', '.env is missing', 'צור אותו מהדוגמה: copy .env.example .env', 'Create it from the example: copy .env.example .env');
}
let config: typeof import('../config.js').config;
try {
  ({ config } = await import('../config.js'));
} catch (e) {
  const issues = (e as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
  fail(
    `ערך לא תקין ב-‎.env: ${issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? (e as Error).message}`,
    `.env has invalid values: ${issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? (e as Error).message}`,
    'תקן את הערכים לפי .env.example',
    'Fix the values (see .env.example for each variable)',
  );
  process.exit(1);
}
ok('.env valid');

// ---------- check 2: Ollama ----------
const ollamaUp = async () => {
  try {
    const r = await fetch(`${config.OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
};
if (await ollamaUp()) ok(`Ollama reachable at ${config.OLLAMA_URL}`);
else if (DOCTOR) fail('Ollama לא רץ', `Ollama is not reachable at ${config.OLLAMA_URL}`, 'פתח את אפליקציית Ollama (או npm start ינסה להפעיל אותה)', 'Start the Ollama app (npm start will try to start it for you)');
else {
  const app = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama app.exe');
  if (process.platform === 'win32' && fs.existsSync(app)) {
    console.log('… Ollama not running → starting the Ollama app');
    spawn(app, [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log('… Ollama not running → starting `ollama serve` (detached)');
    try {
      spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    } catch {
      /* reported below */
    }
  }
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(1000);
    up = await ollamaUp();
  }
  if (up) ok('Ollama started');
  else fail('לא הצלחתי להפעיל את Ollama תוך 30 שניות', 'Could not start Ollama within 30s', 'פתח את אפליקציית Ollama ידנית, או התקן מ-https://ollama.com/download', 'Open the Ollama app manually, or install it from https://ollama.com/download');
}

// ---------- check 3: models ----------
const required = [...new Set([config.OLLAMA_MODEL_ANALYZE, config.OLLAMA_MODEL_WRITE])];
const installedModels = async (): Promise<string[]> => {
  try {
    const r = await fetch(`${config.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return ((await r.json()) as { models?: Array<{ name: string }> }).models?.map((m) => m.name) ?? [];
  } catch {
    return [];
  }
};
const have = (list: string[], m: string) => list.includes(m) || list.includes(`${m}:latest`);
let models = await installedModels();
for (const m of required.filter((x) => !have(models, x))) {
  if (!DOCTOR && (await ask(`Model ${m} is not pulled. Pull it now? / המודל ${m} לא מותקן. להוריד עכשיו?`))) {
    try {
      execSync(`ollama pull ${m}`, { stdio: 'inherit' });
    } catch {
      /* re-checked below */
    }
    models = await installedModels();
  }
  if (!have(models, m)) fail(`המודל ${m} לא מותקן`, `Model ${m} is not installed`, `הרץ: ollama pull ${m}`, `Run: ollama pull ${m}`);
}
if (required.every((m) => have(models, m))) ok(`model(s): ${required.join(', ')}`);

// ---------- check 4b/4c: preferences.yaml, profile.json ----------
const { PrefsSchema } = await import('../core/prefs.js');
const YAML = (await import('yaml')).default;
const prefsFile = config.paths.preferences;
if (!fs.existsSync(prefsFile)) {
  fail('הקובץ preferences.yaml חסר', `${path.basename(prefsFile)} is missing`, 'צור אותו מהדוגמה: copy preferences.example.yaml preferences.yaml וערוך', 'Create it: copy preferences.example.yaml preferences.yaml, then edit it');
} else {
  const parsed = PrefsSchema.safeParse(YAML.parse(fs.readFileSync(prefsFile, 'utf8')) ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    fail(`preferences.yaml לא תקין: ${msg}`, `preferences.yaml is invalid: ${msg}`, 'תקן לפי preferences.example.yaml', 'Fix it (see preferences.example.yaml)');
  } else {
    ok('preferences.yaml valid');
    const p = parsed.data;
    if (!p.cv.he || !p.cv.en || /^</.test(p.cv.he) || /^</.test(p.cv.en)) {
      warn('שמות קורות החיים (cv.he / cv.en) לא מוגדרים — לא ניתן להגיש', 'cv.he / cv.en are not set — applying will fail', 'הגדר את השמות בדיוק כפי שהם מופיעים באתר', 'Set the CV names exactly as shown on the site');
    }
    if (p.queries.titles.length === 0) warn('אין שאילתות חיפוש (queries.titles)', 'No search queries (queries.titles)', 'הוסף כותרות משרה ב-preferences.yaml', 'Add job titles to preferences.yaml');
  }
}
const { loadProfile } = await import('../profile/facts.js');
const profileFile = path.join(config.paths.profileDir, 'profile.json');
const draftFile = path.join(config.paths.profileDir, 'profile.draft.json');
if (fs.existsSync(profileFile)) {
  try {
    loadProfile(profileFile);
    ok('data/profile/profile.json valid');
  } catch (e) {
    fail(`profile.json לא תקין: ${(e as Error).message}`, `profile.json is invalid: ${(e as Error).message}`, 'תקן את הקובץ (ראה profile.conflicts.md)', 'Fix the file (see profile.conflicts.md)');
  }
} else if (fs.existsSync(draftFile)) {
  fail(
    'יש טיוטת פרופיל (profile.draft.json) שעוד לא אושרה',
    'profile.draft.json exists but has not been reviewed yet',
    'עבור על data/profile/profile.conflicts.md, תקן את הטיוטה ושנה את שמה ל-profile.json',
    'Review data/profile/profile.conflicts.md, fix the draft, then rename it to profile.json',
  );
} else {
  fail('אין פרופיל', 'No profile (data/profile/profile.json)', 'שים cv-he.pdf ו-cv-en.pdf ב-data/profile והרץ npm run profile:init', 'Put cv-he.pdf and cv-en.pdf in data/profile and run: npm run profile:init');
}

// ---------- check 5: DB migrations ----------
const migDir = path.join(BACKEND, 'src', 'db', 'migrations');
const allMigrations = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
const { openDb } = await import('../db/index.js');
let db: import('../db/index.js').DB | null = null;
if (DOCTOR) {
  if (!fs.existsSync(config.paths.db)) warn('מסד הנתונים עוד לא נוצר (ייווצר בהפעלה הראשונה)', 'Database not created yet (created on first start)');
  else {
    const { DatabaseSync } = await import('node:sqlite');
    const ro = new DatabaseSync(config.paths.db, { readOnly: true });
    const done = new Set((ro.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map((r) => r.version));
    ro.close();
    const pending = allMigrations.filter((m) => !done.has(m));
    if (pending.length) warn(`מיגרציות ממתינות: ${pending.join(', ')} (יוחלו ב-npm start)`, `Pending migrations: ${pending.join(', ')} (applied by npm start)`);
    else ok(`database up to date (${allMigrations.length} migrations)`);
  }
} else {
  try {
    db = openDb(config.paths.db);
    ok(`database ready (${allMigrations.length} migrations)`);
  } catch (e) {
    fail(`מיגרציה נכשלה: ${(e as Error).message}`, `Database migration failed: ${(e as Error).message}`, 'גבה את data/jobhunter.sqlite ודווח על השגיאה', 'Back up data/jobhunter.sqlite and report the error');
  }
}

// ---------- check 6: Drushim session ----------
const { checkDrushimSession, getSession } = await import('../browser/site-session.js');
console.log('… checking the Drushim session (headless browser)');
let session = await checkDrushimSession();
if (session.state === 'logged_in') ok('Drushim: logged in');
else if (session.state === 'logged_out') {
  warn('לא מחובר לדרושים — ההגשה תהיה מושבתת', 'Not logged in to Drushim — applying will be disabled', 'הרץ: npm run login -- drushim', 'Run: npm run login -- drushim');
  if (!DOCTOR && (await ask('Open the Drushim login window now? / לפתוח עכשיו חלון התחברות לדרושים?'))) {
    execSync(`"${process.execPath}" "${TSX_CLI}" src/cli/login.ts drushim`, { cwd: BACKEND, stdio: 'inherit' });
    session = await checkDrushimSession();
    if (session.state === 'logged_in') ok('Drushim: logged in');
    else warn('עדיין לא מחובר — ממשיך בלי אפשרות הגשה', 'Still not logged in — continuing with applying disabled');
  }
} else warn(`מצב החיבור לדרושים לא ידוע: ${session.detail}`, `Drushim session unknown: ${session.detail}`, 'אם השרת כבר רץ, סגור אותו ונסה שוב', 'If JobHunter is already running, close it and try again');

if (DOCTOR) {
  console.log(`\n${c.bold('Doctor report')}: ${failures.length} failed, ${warnings.length} warning(s). Nothing was changed.`);
  for (const f of failures) console.log(`  ${c.red('✗')} ${f}`);
  for (const w of warnings) console.log(`  ${c.yellow('!')} ${w}`);
  process.exit(failures.length ? 1 : 0);
}

// ---------- check 7: frontend build + server ----------
const dist = path.join(FRONTEND, 'dist');
const newest = (dir: string): number =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs), 0);
const srcTime = Math.max(newest(path.join(FRONTEND, 'src')), ...['index.html', 'vite.config.ts', 'package.json'].map((f) => fs.statSync(path.join(FRONTEND, f)).mtimeMs));
const distIndex = path.join(dist, 'index.html');
if (!fs.existsSync(distIndex) || fs.statSync(distIndex).mtimeMs < srcTime) {
  console.log('… building the dashboard');
  try {
    execSync('npm run build -w frontend', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    fail('בניית ה-dashboard נכשלה', 'Dashboard build failed', 'הרץ npm run build -w frontend וראה את השגיאה', 'Run: npm run build -w frontend and check the error');
  }
}
ok('dashboard built');

const { log } = await import('../log.js');
const { Repo } = await import('../db/repo.js');
const { buildApp } = await import('../server/app.js');
const { closeContext } = await import('../browser/session.js');
const { stopRun, waitIdle, runToCompletion, getActiveRun } = await import('../pipeline/runner.js');
const { effectiveLimits, loadPrefs } = await import('../core/prefs.js');
const repo = new Repo(db!);
repo.failOrphanRuns();
const app = buildApp(db!, { staticDir: dist });
const url = `http://127.0.0.1:${config.PORT}`;
try {
  await app.listen({ host: '127.0.0.1', port: config.PORT });
} catch (e) {
  fail(`הפורט ${config.PORT} תפוס (אולי JobHunter כבר רץ?)`, `Port ${config.PORT} is busy (is JobHunter already running?)`, `סגור את המופע הקודם או שנה PORT ב-.env`, 'Close the other instance or change PORT in .env');
}

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down… / סוגר…');
  stopRun();
  await Promise.race([waitIdle(), sleep(8000)]);
  await closeContext().catch(() => undefined);
  await app.close().catch(() => undefined);
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

// ---------- check 8: summary ----------
const limits = effectiveLimits(loadPrefs());
const pendingQ = (db!.prepare("SELECT COUNT(*) AS n FROM answers WHERE status = 'pending'").get() as { n: number }).n;
const line = '═'.repeat(58);
console.log(`\n${line}`);
console.log(config.DRY_RUN ? c.bold(c.yellow('   DRY RUN — nothing is sent   /   מצב ניסוי — שום דבר לא נשלח')) : c.bold(c.red('   LIVE — approvals SUBMIT for real   /   שליחה אמיתית!')));
console.log(line);
console.log(`  model          ${config.OLLAMA_MODEL_ANALYZE}${config.OLLAMA_MODEL_WRITE !== config.OLLAMA_MODEL_ANALYZE ? ` / ${config.OLLAMA_MODEL_WRITE}` : ''}`);
console.log(`  Drushim login  ${getSession('drushim').state === 'logged_in' ? c.green('yes') : c.red(getSession('drushim').state === 'logged_out' ? 'NO (applying disabled)' : 'unknown')}`);
console.log(`  applied today  ${repo.submittedToday()} / ${limits.dailyApplyLimit}`);
console.log(`  pending answers ${pendingQ}`);
console.log(`  dashboard      ${url}`);
console.log(`${line}\nCtrl+C to stop / לעצירה Ctrl+C\n`);
log.info({ url, dryRun: config.DRY_RUN }, 'JobHunter started');

if (!NO_OPEN) {
  const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  try {
    execSync(opener, { stdio: 'ignore', shell: process.platform === 'win32' ? 'cmd.exe' : undefined });
  } catch {
    /* open it manually */
  }
}

// ---------- --hunt ----------
if (HUNT) {
  const { prepareJobs } = await import('../apply/service.js');
  const { Applications } = await import('../apply/plan.js');
  console.log(c.bold('\n--hunt: discover → score → prepare plans (nothing is submitted)'));
  const before = repo.statusCounts();
  await runToCompletion(db!, 'drushim', 'full');
  const run = repo.listRuns(1)[0] as { status?: string; reason?: string | null; stats?: Record<string, number> } | undefined;
  console.log(`  run: ${run?.status}${run?.reason ? ` (${run.reason})` : ''} · new ${run?.stats?.inserted ?? 0} · scored ${run?.stats?.scored ?? 0}`);
  const apps = new Applications(db!);
  const room = Math.max(0, limits.dailyApplyLimit - repo.submittedToday());
  const candidates = repo
    .listJobs({ status: 'scored', minScore: limits.autoSubmitMinScore, limit: 200 })
    .items.filter((j) => j.site === 'drushim' && !apps.latestForJob(j.id))
    .slice(0, room);
  if (getSession('drushim').state === 'logged_out') {
    console.log(c.yellow(`  ${candidates.length} job(s) ≥ ${limits.autoSubmitMinScore} — not preparing: not logged in to Drushim`));
  } else if (candidates.length === 0) {
    console.log(`  no new jobs with score ≥ ${limits.autoSubmitMinScore}`);
  } else if (!getActiveRun()) {
    console.log(`  preparing ${candidates.length} plan(s)…`);
    prepareJobs(db!, candidates.map((j) => j.id));
    await waitIdle();
  }
  const after = repo.statusCounts();
  const diff = Object.keys(after)
    .map((k) => `${k} ${after[k]}${before[k] !== after[k] ? ` (${(after[k] ?? 0) - (before[k] ?? 0) >= 0 ? '+' : ''}${(after[k] ?? 0) - (before[k] ?? 0)})` : ''}`)
    .join(' · ');
  const pendingNow = (db!.prepare("SELECT COUNT(*) AS n FROM answers WHERE status = 'pending'").get() as { n: number }).n;
  console.log(`\n${c.bold('hunt summary')}: ${diff}\n  pending answers: ${pendingNow} · review queue: ${apps.list(['needs_review']).length}\n  Approve in the dashboard → Review queue (${url})\n`);
}
