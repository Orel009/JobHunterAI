/**
 * npm run login -- <site>
 * Opens the site in the persistent profile (data/browser-profile). Log in by hand, then close the window.
 * We never automate login; the session cookies are reused by later runs.
 * Reports whether a login was detected and whether the auth cookies will survive a browser restart
 * (cookie names and expiry only, never values).
 */
import type { Cookie } from 'playwright';
import { SITES } from '../sites/registry.js';
import { getContext, getPage } from '../browser/session.js';

const AUTH_COOKIE = /token|auth|session|refresh|login|user/i;
const PROBES: Record<string, RegExp> = { drushim: /gw\.drushim\.co\.il\/auth\/seeker-details/ };

const site = process.argv[2];
const entry = SITES.find((s) => s.id === site);
if (!entry) {
  console.error(`usage: npm run login -- <${SITES.map((s) => s.id).join('|')}>`);
  process.exit(1);
}

const ctx = await getContext({ headless: false });
const page = await getPage({ headless: false });
let loggedIn = false;
const probe = PROBES[entry.id];
if (probe) {
  ctx.on('response', (r) => {
    if (!probe.test(r.url())) return;
    const ok = r.status() === 200;
    if (ok && !loggedIn) console.log('  ✓ login detected (session probe returned 200) — you can close the window now.');
    loggedIn = ok;
  });
}

let snapshot: Cookie[] = [];
const timer = setInterval(() => {
  void ctx
    .cookies()
    .then((c) => (snapshot = c.filter((x) => x.domain.includes(entry.id) && AUTH_COOKIE.test(x.name))))
    .catch(() => undefined);
}, 2000);

await page.goto(entry.loginUrl, { waitUntil: 'domcontentloaded' });
console.log(`\n  ${entry.displayName} is open. Log in manually (click "התחברות"/"כניסה"), then CLOSE THE BROWSER WINDOW.\n`);
await new Promise<void>((resolve) => {
  ctx.on('close', () => resolve());
  page.on('close', () => {
    if (ctx.pages().length === 0) void ctx.close().then(resolve);
  });
});
clearInterval(timer);

console.log(`\nlogin detected: ${probe ? (loggedIn ? 'YES' : 'NO') : 'n/a (no probe for this site)'}`);
if (snapshot.length) {
  console.log('auth-like cookies (name → expiry):');
  for (const c of snapshot) console.log(`  ${c.domain} ${c.name} → ${c.expires === -1 ? 'SESSION ONLY (lost on browser restart)' : new Date(c.expires * 1000).toISOString()}`);
}
console.log('\nVerify with: npm run session:check -- ' + entry.id);
process.exit(0);
