/**
 * npm run session:check -- drushim : is the browser profile logged in, and which login cookies survive a browser
 * restart? (cookie names and expiry only, never values)
 */
import { config } from '../config.js';
import { profileInUse, PROFILE_IN_USE } from '../browser/chrome.js';
import { siteBrowser } from '../browser/session.js';
import { formatSessionReport, sessionReport } from '../browser/session-report.js';

const site = process.argv[2] ?? 'drushim';
if (site !== 'drushim') {
  console.error('only drushim has a session probe so far');
  process.exit(1);
}
if (profileInUse(config.paths.browserProfile)) {
  console.error(PROFILE_IN_USE);
  process.exit(1);
}
console.log(`browser: ${siteBrowser().label} · profile: ${config.paths.browserProfile}`);
const r = await sessionReport(config.paths.browserProfile, site);
console.log(formatSessionReport(r));
if (r.session.state === 'logged_out') console.log('\nLog in with: npm run login -- drushim (or the dashboard button)');
process.exit(0);
