/**
 * Checks 2–8 of `npm start` (check 1, Node + dependencies, runs in scripts/start.mjs before tsx exists).
 *   --doctor   checks 1–6 only, report, change nothing
 *   --hunt     after startup: discover → score → prepare plans for jobs ≥ threshold; sends only what passes the
 *              auto-submit gate (DRY_RUN off and auto-submit on for the site)
 *   --send     with --hunt: the "Run & send" session — no dashboard tab, print the "Done. Safe to close" summary
 *              and exit when finished (if JobHunter is already running, the running app does it and this waits)
 *   --no-open  don't open the browser
 *   --no-browser  for Windows Task Scheduler: no dashboard tab, the site browser headless, exit after the hunt;
 *                 if JobHunter is already running, ask it to run the hunt instead and exit
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const DOCTOR = args.includes('--doctor');
const SEND = args.includes('--send');
const HUNT = args.includes('--hunt') || SEND;
const NO_BROWSER = args.includes('--no-browser');
const NO_OPEN = args.includes('--no-open') || NO_BROWSER || SEND;
if (NO_BROWSER) process.env.HEADLESS = 'true'; // before .env is read (it never overrides a set variable)
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
  if (NO_BROWSER) return false; // scheduled run: nobody is there to answer
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

/** Total VRAM in MB of the largest NVIDIA GPU (nvidia-smi), or null when unavailable. */
function gpuMemoryMb(): number | null {
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
    const vals = out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0);
    return vals.length ? Math.max(...vals) : null;
  } catch {
    return null;
  }
}

// ---------- check: .env (before anything imports config) ----------
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  if (DOCTOR) warn('קובץ ‎.env חסר — ייווצר אוטומטית בהפעלה הראשונה', '.env is missing — npm start creates it from .env.example');
  else {
    fs.copyFileSync(path.join(ROOT, '.env.example'), envFile);
    ok('.env created from .env.example (first run)');
  }
}
let config: typeof import('../config.js').config;
try {
  ({ config } = await import('../config.js'));
} catch (e) {
  const issues = (e as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
  fail(
    `ערך לא תקין ב-‎.env: ${issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? (e as Error).message}`,
    `.env has invalid values: ${issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? (e as Error).message}`,
    'יש לתקן את הערכים לפי .env.example',
    'Fix the values (see .env.example for each variable)',
  );
  process.exit(1);
}
ok('.env valid');

// ---------- hunt while JobHunter is already running: let the running app do it ----------
if (HUNT && (NO_BROWSER || SEND)) {
  const base = `http://127.0.0.1:${config.PORT}`;
  const up = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  if (up) {
    const r = await fetch(`${base}/api/hunt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: NO_BROWSER ? 'task' : 'manual' }) }).catch(() => null);
    console.log(r?.ok ? 'JobHunter is already running: it runs this hunt now (summary in the dashboard).' : `JobHunter is running but did not start the hunt: ${r ? await r.text() : 'no answer'}`);
    if (!SEND || !r?.ok) process.exit(r?.ok ? 0 : 1);
    // --send: wait for the running app to finish, then print its summary
    const { doneReport } = await import('../pipeline/hunt.js');
    type St = { huntRunning: boolean; huntProgress: { step: string; current: string | null } | null; lastHunt: Parameters<typeof doneReport>[0] | null; stillRunning: string[] };
    let st: St | null = null;
    let lastLine = '';
    for (;;) {
      await new Promise((res) => setTimeout(res, 3000));
      st = (await fetch(`${base}/api/status`).then((x) => x.json()).catch(() => null)) as St | null;
      if (!st) break;
      const line = `  … ${st.huntProgress?.step ?? ''}${st.huntProgress?.current ? ` — ${st.huntProgress.current}` : ''}`;
      if (line !== lastLine) console.log((lastLine = line));
      if (!st.huntRunning) break;
    }
    if (st?.lastHunt) for (const l of doneReport(st.lastHunt, st.stillRunning)) console.log(`  ${l}`);
    console.log('  (the dashboard is still open in the running JobHunter — close it there)');
    process.exit(0);
  }
}

// ---------- profile state decides onboarding mode ----------
const { loadProfile, profilePath } = await import('../profile/facts.js');
const profileFile = profilePath();
const draftFile = path.join(config.paths.profileDir, 'profile.draft.json');
const ONBOARDING = !fs.existsSync(profileFile) && !fs.existsSync(draftFile);
/** in onboarding mode the wizard configures the LLM: problems are warnings, not stops */
const llmProblem = (he: string, en: string, fixHe: string, fixEn: string) => (ONBOARDING ? warn(he, en, fixHe, fixEn) : fail(he, en, fixHe, fixEn));

// ---------- check: LLM provider(s) for each task ----------
const { taskConfig, apiKey } = await import('../llm/settings.js');
const { getProvider } = await import('../llm/llm.js');
const tasks = { analyze: taskConfig('analyze'), write: taskConfig('write') };
const providers = [...new Set([tasks.analyze.provider, tasks.write.provider])];
console.log(`… LLM: analyze = ${tasks.analyze.provider}:${tasks.analyze.model || '(no model)'} · write = ${tasks.write.provider}:${tasks.write.model || '(no model)'}`);

if (providers.includes('ollama')) {
  const { ollamaUp, startOllama } = await import('../llm/reachable.js');
  let up = await ollamaUp();
  if (up) ok(`Ollama reachable at ${config.OLLAMA_URL}`);
  else if (!DOCTOR) {
    console.log('… Ollama not running → starting it');
    up = await startOllama();
    if (up) ok('Ollama started');
  }
  if (!up) {
    llmProblem(
      'Ollama לא רץ',
      `Ollama is not reachable at ${config.OLLAMA_URL}`,
      'יש לפתוח את אפליקציית Ollama (או להתקין מ-https://ollama.com/download), או לבחור ספק API במסך Settings',
      'Open the Ollama app (or install it from https://ollama.com/download), or choose an API provider on the Settings screen',
    );
  } else {
    const { ollamaModelsWithSize } = await import('../llm/providers/ollama.js');
    const required = [...new Set((['analyze', 'write'] as const).filter((t) => tasks[t].provider === 'ollama').map((t) => tasks[t].model).filter(Boolean))];
    const have = (list: Array<{ name: string; size: number }>, m: string) => list.find((x) => x.name === m || x.name === `${m}:latest`);
    let models = await ollamaModelsWithSize().catch(() => [] as Array<{ name: string; size: number }>);
    for (const m of required.filter((x) => !have(models, x))) {
      if (!DOCTOR && (await ask(`Model ${m} is not pulled. Pull it now? / המודל ${m} לא מותקן. להוריד עכשיו?`))) {
        try {
          execSync(`ollama pull ${m}`, { stdio: 'inherit' });
        } catch {
          /* re-checked below */
        }
        models = await ollamaModelsWithSize().catch(() => [] as Array<{ name: string; size: number }>);
      }
      if (!have(models, m)) llmProblem(`המודל ${m} לא מותקן`, `Model ${m} is not installed`, `יש להריץ: ollama pull ${m}`, `Run: ollama pull ${m}`);
    }
    if (required.length && required.every((m) => have(models, m))) ok(`local model(s): ${required.join(', ')}`);
    // does the model fit the GPU?
    const vram = gpuMemoryMb();
    for (const m of required) {
      const sizeMb = (have(models, m)?.size ?? 0) / 1024 / 1024;
      if (!sizeMb) continue;
      if (vram === null) {
        warn('לא נמצא GPU של NVIDIA (nvidia-smi) — מודל מקומי ירוץ לאט על המעבד', `No NVIDIA GPU found (nvidia-smi) — ${m} will run slowly on the CPU`, 'כדאי לבחור מודל קטן יותר או ספק API במסך Settings', 'Pick a smaller model or an API provider on the Settings screen');
      } else if (sizeMb > vram * 0.9) {
        warn(
          `המודל ${m} (${(sizeMb / 1024).toFixed(1)}GB) גדול מזיכרון ה-GPU (${(vram / 1024).toFixed(1)}GB)`,
          `${m} (${(sizeMb / 1024).toFixed(1)} GB) does not fit the GPU (${(vram / 1024).toFixed(1)} GB VRAM)`,
          'יש לבחור מודל מקומי קטן יותר (למשל גרסת 4B) או ספק API במסך Settings',
          'Choose a smaller local model (e.g. a 4B variant) or an API provider on the Settings screen',
        );
      } else ok(`${m} fits the GPU (${(sizeMb / 1024).toFixed(1)} of ${(vram / 1024).toFixed(1)} GB)`);
    }
  }
}
for (const p of providers.filter((x) => x !== 'ollama')) {
  if (p === 'fake') {
    warn('מצב ניסוי: אין מודל — התשובות ריקות', 'Test mode provider: no model, answers are empty placeholders', 'יש לבחור ספק אמיתי במסך Settings', 'Choose a real provider on the Settings screen');
    continue;
  }
  if (!apiKey(p)) {
    llmProblem(`חסר מפתח API עבור ${p}`, `No API key for ${p}`, 'יש להזין מפתח במסך Settings (נשמר רק ב-.env)', 'Enter the key on the Settings screen (stored only in .env)');
    continue;
  }
  try {
    const list = await getProvider(p).listModels();
    const wanted = (['analyze', 'write'] as const).filter((t) => tasks[t].provider === p).map((t) => tasks[t].model);
    const missing = wanted.filter((m) => m && list.length && !list.includes(m));
    if (missing.length) warn(`המודל ${missing.join(', ')} לא מופיע ברשימת ${p}`, `${missing.join(', ')} is not in ${p}'s model list`, 'יש לבדוק את שם המודל במסך Settings', 'Check the model name on the Settings screen');
    else ok(`${p} API reachable (${list.length} models)`);
  } catch (e) {
    llmProblem(`לא ניתן להתחבר ל-${p}`, `Cannot reach ${p}: ${(e as Error).message}`, 'יש לבדוק את המפתח והחיבור במסך Settings (Test connection)', 'Check the key and connection on the Settings screen (Test connection)');
  }
}

// ---------- check: preferences ----------
const { PrefsSchema } = await import('../core/prefs.js');
const YAML = (await import('yaml')).default;
const prefsFile = config.paths.preferences;
if (!fs.existsSync(prefsFile)) {
  if (DOCTOR) warn('קובץ ההעדפות חסר — ייווצר מהדוגמה בהפעלה', `${path.relative(ROOT, prefsFile)} is missing — npm start creates it from preferences.example.yaml`);
  else {
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'preferences.example.yaml'), prefsFile);
    ok(`${path.relative(ROOT, prefsFile)} created from preferences.example.yaml — edit it on the Preferences screen`);
  }
}
if (fs.existsSync(prefsFile)) {
  const parsed = PrefsSchema.safeParse(YAML.parse(fs.readFileSync(prefsFile, 'utf8')) ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    fail(`קובץ ההעדפות לא תקין: ${msg}`, `preferences are invalid: ${msg}`, 'יש לתקן במסך Preferences או לפי preferences.example.yaml', 'Fix them on the Preferences screen (or see preferences.example.yaml)');
  } else {
    ok(`${path.relative(ROOT, prefsFile)} valid`);
    const p = parsed.data;
    if (!p.cv.he && !p.cv.en) warn('שמות קורות החיים בדרושים לא מוגדרים — לא ניתן להגיש', 'Drushim CV names (cv.he / cv.en) are not set — applying will fail', 'יש להגדיר אותם במסך Preferences', 'Set them on the Preferences screen');
    else if (/^</.test(p.cv.he) || /^</.test(p.cv.en)) warn('שמות קורות החיים עדיין בערכי הדוגמה', 'Drushim CV names still have the example placeholders', 'יש להגדיר אותם במסך Preferences', 'Set them on the Preferences screen');
    if (p.roleTypes.filter((r) => r.enabled).length === 0 && p.queries.titles.length === 0) warn('אין סוגי תפקידים לחיפוש', 'No enabled role types to search for', 'יש להוסיף אותם במסך Preferences', 'Add them on the Preferences screen');
  }
}

// ---------- check: profile ----------
if (fs.existsSync(profileFile)) {
  try {
    loadProfile(profileFile);
    ok(`${path.relative(ROOT, profileFile)} valid`);
  } catch (e) {
    fail(`profile.json לא תקין: ${(e as Error).message}`, `profile.json is invalid: ${(e as Error).message}`, 'יש לתקן במסך Profile (או לעיין ב-profile.conflicts.md)', 'Fix it on the Profile screen (or see profile.conflicts.md)');
  }
} else if (fs.existsSync(draftFile)) {
  warn(
    'יש טיוטת פרופיל שעוד לא אושרה',
    'profile.draft.json is waiting for your review',
    'יש לעבור עליה במסך Profile וללחוץ "Approve draft" (או לשנות את שמה ל-profile.json)',
    'Review it on the Profile screen and click "Approve draft" (or rename it to profile.json)',
  );
} else {
  warn('אין פרופיל — אשף ההגדרה ייפתח ב-dashboard', 'No profile yet — the setup wizard opens in the dashboard', 'יש להשלים את אשף ההגדרה', 'Complete the setup wizard');
}

// ---------- optional: email job alerts (LinkedIn, Indeed) — checked only when turned on ----------
const { emailAlertsEnabled, enabledSources, imapConfig, imapConfigured } = await import('../linkedin/settings.js');
if (emailAlertsEnabled()) {
  if (!imapConfigured()) {
    warn(
      'התראות המשרות במייל מופעלות, אבל פרטי המייל (IMAP) חסרים',
      'Email job alerts are on, but the email (IMAP) settings are missing',
      'יש להזין כתובת מייל וסיסמת אפליקציה במסך Settings, או לכבות את האפשרות',
      'Enter the email address and app password on the Settings screen, or turn the option off',
    );
  } else {
    const { testImap } = await import('../linkedin/imap.js');
    try {
      const t = await testImap();
      ok(`Job alerts (${enabledSources().join(', ')}): ${imapConfig().user} — ${Object.entries(t.bySource).map(([k, v]) => `${v} ${k}`).join(', ')} alert email(s) in the last ${t.windowDays} days`);
    } catch (e) {
      warn('אין חיבור לתיבת המייל של התראות המשרות', `Job alerts: ${(e as Error).message}`, 'יש לבדוק את סיסמת האפליקציה במסך Settings (Test connection)', 'Check the app password on the Settings screen (Test connection)');
    }
  }
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
    fail(`מיגרציה נכשלה: ${(e as Error).message}`, `Database migration failed: ${(e as Error).message}`, 'יש לגבות את data/jobhunter.sqlite ולדווח על השגיאה', 'Back up data/jobhunter.sqlite and report the error');
  }
}

// ---------- check: Google Chrome (site sessions and the login window use the installed Chrome) ----------
const { findChrome, profileInUse, PROFILE_IN_USE } = await import('../browser/chrome.js');
const chrome = findChrome();
if (chrome) ok(`Google Chrome ${chrome.version ?? '(version unknown)'} — ${chrome.path}`);
else {
  warn(
    'Google Chrome לא נמצא — התחברות עם Google לא תעבוד',
    'Google Chrome not found — "Sign in with Google" will not work',
    'יש להתקין את Chrome מ-https://www.google.com/chrome/ (או להגדיר CHROME_PATH ב-.env). בלי Chrome אפשר להתחבר לאתר בקוד ב-SMS / במייל או בסיסמה',
    "Install Chrome from https://www.google.com/chrome/ (or set CHROME_PATH in .env). Without it, use the site's SMS / email code or password login",
  );
  // fallback for site sessions without Chrome: Playwright's bundled Chromium, downloaded once
  const { chromium } = await import('playwright');
  const bundled = () => {
    try {
      return fs.existsSync(chromium.executablePath());
    } catch {
      return false;
    }
  };
  if (!bundled() && !DOCTOR) {
    console.log('… no Chrome → installing the bundled browser instead: npx playwright install chromium (one time, ~150 MB)');
    try {
      execSync('npx playwright install chromium', { cwd: BACKEND, stdio: 'inherit' });
    } catch {
      /* reported below */
    }
  }
  if (bundled()) ok('fallback browser (bundled Chromium) installed');
  else fail('אין דפדפן: Chrome לא נמצא ו-Chromium לא מותקן', 'No browser: Chrome not found and the bundled Chromium is not installed', 'יש להתקין את Google Chrome', 'Install Google Chrome');
}

// ---------- check 6: Drushim session ----------
const { checkDrushimSession, getSession } = await import('../browser/site-session.js');
console.log('… checking the Drushim session (headless browser)');
let session = profileInUse(config.paths.browserProfile)
  ? { state: 'unknown' as const, checkedAt: null, detail: PROFILE_IN_USE }
  : await checkDrushimSession();
if (session.state === 'logged_in') ok('Drushim: logged in');
else if (session.state === 'logged_out') {
  warn('אין חיבור לדרושים — ההגשה תהיה מושבתת', 'Not logged in to Drushim — applying will be disabled', 'יש ללחוץ "Open the login window" ב-dashboard, או להריץ: npm run login -- drushim', 'Click "Open the login window" in the dashboard, or run: npm run login -- drushim');
  // on a fresh installation the setup wizard has a login step
  if (!DOCTOR && !ONBOARDING && (await ask('Open the Drushim login window now? / לפתוח עכשיו חלון התחברות לדרושים?'))) {
    execSync(`"${process.execPath}" "${TSX_CLI}" src/cli/login.ts drushim`, { cwd: BACKEND, stdio: 'inherit' });
    session = await checkDrushimSession();
    if (session.state === 'logged_in') ok('Drushim: logged in');
    else warn('עדיין אין חיבור — ההפעלה ממשיכה בלי אפשרות הגשה', 'Still not logged in — continuing with applying disabled');
  }
} else warn(`מצב החיבור לדרושים לא ידוע: ${session.detail}`, `Drushim session unknown: ${session.detail}`, 'אם השרת כבר רץ, יש לסגור אותו ולנסות שוב', 'If JobHunter is already running, close it and try again');

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
    fail('בניית ה-dashboard נכשלה', 'Dashboard build failed', 'יש להריץ npm run build -w frontend ולבדוק את השגיאה', 'Run: npm run build -w frontend and check the error');
  }
}
ok('dashboard built');

const { log } = await import('../log.js');
const { Repo } = await import('../db/repo.js');
const { buildApp } = await import('../server/app.js');
const { closeContext } = await import('../browser/session.js');
const { stopRun, waitIdle } = await import('../pipeline/runner.js');
const { effectiveLimits, loadPrefs } = await import('../core/prefs.js');
const repo = new Repo(db!);
repo.failOrphanRuns();
const app = buildApp(db!, { staticDir: dist });
const url = `http://127.0.0.1:${config.PORT}`;
try {
  await app.listen({ host: '127.0.0.1', port: config.PORT });
} catch (e) {
  fail(`הפורט ${config.PORT} תפוס (אולי JobHunter כבר רץ?)`, `Port ${config.PORT} is busy (is JobHunter already running?)`, `יש לסגור את המופע הקודם או לשנות PORT ב-.env`, 'Close the other instance or change PORT in .env');
}

// the other sites' logins (Drushim was checked above), in the background
const { startStartupSessionChecks } = await import('../pipeline/startup-checks.js');
startStartupSessionChecks(db!);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down… / סגירה…');
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
const llmLabel = (t: { provider: string; model: string }) => `${t.provider}:${t.model || '(not set)'}`;
console.log(`  model          ${llmLabel(tasks.analyze)}${llmLabel(tasks.write) !== llmLabel(tasks.analyze) ? ` (write: ${llmLabel(tasks.write)})` : ''}`);
console.log(`  Drushim login  ${getSession('drushim').state === 'logged_in' ? c.green('yes') : c.red(getSession('drushim').state === 'logged_out' ? 'NO (applying disabled)' : 'unknown')}`);
const { dailySendLimit } = await import('../apply/pacing.js');
console.log(`  applied today  ${Object.entries(repo.submittedTodayBySite()).map(([s, n]) => `${s} ${n}/${dailySendLimit(s)}`).join(' · ') || `0 (limit per site: Drushim ${dailySendLimit('drushim')}, others up to ${limits.dailyApplyLimit})`}`);
console.log(`  pending answers ${pendingQ}`);
console.log(`  dashboard      ${url}`);
console.log(`${line}\nCtrl+C to stop / לעצירה Ctrl+C\n`);
log.info({ url, dryRun: config.DRY_RUN }, 'JobHunter started');

// in-app schedule (off unless turned on in Settings); not for a one-off scheduled run
if (!NO_BROWSER) {
  const { startScheduler } = await import('../pipeline/scheduler.js');
  startScheduler(db!);
}

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
  const { runHunt } = await import('../pipeline/hunt.js');
  const { Applications } = await import('../apply/plan.js');
  console.log(c.bold('\n--hunt: discover → score → prepare plans (sends only if auto-submit is on and its gate passes)'));
  const h = await runHunt(db!, { trigger: NO_BROWSER ? 'task' : 'cli' });
  if (h.loginNeeded) console.log(c.red('  Drushim login expired — log in again (dashboard button or npm run login -- drushim). This hunt was discovery-only.'));
  console.log(`  found ${h.found} · skipped ${Object.entries(h.skipped).map(([k, v]) => `${k} ${v}`).join(', ') || '0'} · ready for review ${h.readyForReview} · auto-submitted ${h.autoSubmitted} · failed ${h.failed}`);
  for (const r of h.runs) console.log(`  ${r.site} run: ${r.status}${r.reason ? ` (${r.reason})` : ''} · new ${r.inserted} · scored ${r.scored}`);
  if (h.note) console.log(c.yellow(`  ${h.note}`));
  else console.log(`  prepared ${h.prepared} plan(s)`);
  const { before, after } = h;
  const diff = Object.keys(after)
    .map((k) => `${k} ${after[k]}${before[k] !== after[k] ? ` (${(after[k] ?? 0) - (before[k] ?? 0) >= 0 ? '+' : ''}${(after[k] ?? 0) - (before[k] ?? 0)})` : ''}`)
    .join(' · ');
  const pendingNow = (db!.prepare("SELECT COUNT(*) AS n FROM answers WHERE status = 'pending'").get() as { n: number }).n;
  console.log(`\n${c.bold('hunt summary')}: ${diff}\n  pending answers: ${pendingNow} · review queue: ${new Applications(db!).list(['needs_review']).length}\n  Approve in the dashboard → Review queue (${url})\n`);
  if (SEND) {
    const { doneReport } = await import('../pipeline/hunt.js');
    const { stillRunning } = await import('../server/app.js');
    const lines = doneReport(h, stillRunning());
    console.log(`${'═'.repeat(58)}\n  ${c.bold(lines[0]!)}`);
    for (const l of lines.slice(1)) console.log(`  ${l}`);
    console.log('═'.repeat(58));
  }
  if (NO_BROWSER || SEND) await shutdown(0); // a scheduled run, or a Run & send session, ends here
}
