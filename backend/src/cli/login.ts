/**
 * npm run login -- <site>
 * Opens the site in the user's INSTALLED Google Chrome, started as a normal process on our profile folder
 * (data/browser-profile): no Playwright, no remote debugging, no automation flags — so Google sign-in works.
 * You log in by hand and close Chrome; then the session is checked with the same profile and a report shows which
 * login cookies survived (names and expiry only, never values). We never type or automate a login.
 * Without Chrome: a window of the bundled browser opens instead, for the site's non-Google login (code or password).
 */
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { SITES } from '../sites/registry.js';
import { CHROME_MISSING_HELP, findChrome, profileInUse, PROFILE_IN_USE } from '../browser/chrome.js';
import { formatSessionReport, sessionReport } from '../browser/session-report.js';

const site = process.argv[2];
const entry = SITES.find((s) => s.id === site);
if (!entry) {
  console.error(`usage: npm run login -- <${SITES.map((s) => s.id).join('|')}>`);
  process.exit(1);
}
const profile = config.paths.browserProfile;
if (profileInUse(profile)) {
  console.error(PROFILE_IN_USE);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chrome = findChrome();

if (chrome) {
  console.log(`\n  Opening ${entry.displayName} in Google Chrome ${chrome.version ?? ''} (a separate window with JobHunter's own profile).`);
  console.log('  Log in there by hand — "Sign in with Google" works — then CLOSE THAT CHROME WINDOW.\n');
  // a plain Chrome process; the two --no-* switches only skip the first-run welcome and the default-browser prompt
  const child = spawn(chrome.path, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', entry.loginUrl], { stdio: 'ignore' });
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  // Chrome may hand over to a relaunched process: wait until nothing holds the profile any more
  if (profileInUse(profile)) {
    console.log('  waiting for Chrome to close…');
    while (profileInUse(profile)) await sleep(1000);
  }
  if (Date.now() - started < 4000) console.log('  (Chrome closed right away — was the window opened and closed, or did Chrome fail to start?)');
} else {
  console.log(`\n${CHROME_MISSING_HELP}\n`);
  console.log(`  Opening ${entry.displayName} in the bundled browser instead. Log in with a code by SMS/email or a password, then CLOSE THE WINDOW.\n`);
  const { getContext, getPage } = await import('../browser/session.js');
  const ctx = await getContext({ headless: false });
  const page = await getPage({ headless: false });
  await page.goto(entry.loginUrl, { waitUntil: 'domcontentloaded' });
  await new Promise<void>((resolve) => {
    ctx.on('close', () => resolve());
    page.on('close', () => {
      if (ctx.pages().length === 0) void ctx.close().then(resolve);
    });
  });
}

console.log('\nChecking the session with the same profile (browser restarted, in the background)…');
const report = await sessionReport(profile, entry.id);
console.log(formatSessionReport(report));
// one machine-readable line for the dashboard, which started this command
console.log(`SESSION_RESULT ${JSON.stringify({ site: entry.id, ...report.session })}`);
process.exit(0);
