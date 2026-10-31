/** npm run session:check -- drushim : prints cookie names/expiry (never values) for the site and whether the session probe says logged in. */
import { getContext, getPage, closeContext } from '../browser/session.js';

const site = process.argv[2] ?? 'drushim';
const ctx = await getContext({ headless: true });
const cookies = (await ctx.cookies()).filter((c) => c.domain.includes(site));
for (const c of cookies) {
  const exp = c.expires === -1 ? 'SESSION (not persisted)' : new Date(c.expires * 1000).toISOString();
  console.log(`${c.domain.padEnd(24)} ${c.name.padEnd(40)} ${exp}`);
}
if (site === 'drushim') {
  const page = await getPage();
  const probe = page.waitForResponse((r) => /gw\.drushim\.co\.il\/auth\/seeker-details/.test(r.url()), { timeout: 30_000 }).catch(() => null);
  await page.goto('https://www.drushim.co.il/', { waitUntil: 'domcontentloaded' });
  const r = await probe;
  console.log(`\nsession probe: ${r ? r.status() : 'not seen'} → ${r?.status() === 200 ? 'LOGGED IN' : 'NOT logged in'}`);
}
await closeContext();
