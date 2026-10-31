/** npm run session:check -- drushim : is the persistent browser profile logged in? (prints cookie names/expiry, never values) */
import { getContext, closeContext } from '../browser/session.js';
import { checkDrushimSession } from '../browser/site-session.js';

const site = process.argv[2] ?? 'drushim';
if (site !== 'drushim') {
  console.error('only drushim has a session probe so far');
  process.exit(1);
}
const ctx = await getContext({ headless: true });
const cookies = (await ctx.cookies()).filter((c) => c.domain.includes(site) && /token|auth|session|refresh|login/i.test(c.name));
for (const c of cookies) console.log(`${c.domain.padEnd(24)} ${c.name.padEnd(36)} ${c.expires === -1 ? 'SESSION ONLY (lost on restart)' : new Date(c.expires * 1000).toISOString()}`);
await closeContext();
const s = await checkDrushimSession();
console.log(`\nsession probe: ${s.detail} → ${s.state === 'logged_in' ? 'LOGGED IN' : s.state === 'logged_out' ? 'NOT logged in (run: npm run login -- drushim)' : `UNKNOWN (${s.detail})`}`);
process.exit(0);
