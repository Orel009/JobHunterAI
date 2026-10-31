/**
 * npm run login -- <site>
 * Opens the site in the persistent profile (data/browser-profile). Log in by hand, then close the window.
 * We never automate login; the session cookies are reused by later runs.
 */
import { SITES } from '../sites/registry.js';
import { getContext, getPage } from '../browser/session.js';

const site = process.argv[2];
const entry = SITES.find((s) => s.id === site);
if (!entry) {
  console.error(`usage: npm run login -- <${SITES.map((s) => s.id).join('|')}>`);
  process.exit(1);
}

const ctx = await getContext({ headless: false });
const page = await getPage({ headless: false });
await page.goto(entry.loginUrl, { waitUntil: 'domcontentloaded' });
console.log(`\n  ${entry.displayName} is open. Log in manually (click "התחברות"/"כניסה"), then CLOSE THE BROWSER WINDOW.\n  The session is saved in data/browser-profile.\n`);
await new Promise<void>((resolve) => {
  ctx.on('close', () => resolve());
  page.on('close', () => {
    if (ctx.pages().length === 0) void ctx.close().then(resolve);
  });
});
console.log('Browser closed — session saved.');
process.exit(0);
