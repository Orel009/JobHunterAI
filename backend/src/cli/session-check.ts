/**
 * npm run session:check -- drushim : is the browser profile logged in, and which login cookies survive a browser
 * restart? (cookie names and expiry only, never values)
 */
import { config } from '../config.js';
import { profileInUse, PROFILE_IN_USE } from '../browser/chrome.js';
import { siteBrowser } from '../browser/session.js';
import { formatSessionReport, sessionReport } from '../browser/session-report.js';

const site = process.argv[2] ?? 'drushim';
if (site !== 'drushim' && site !== 'alljobs' && site !== 'jobmaster') {
  console.error('session checks exist for drushim, alljobs and jobmaster');
  process.exit(1);
}
if (profileInUse(config.paths.browserProfile)) {
  console.error(PROFILE_IN_USE);
  process.exit(1);
}
console.log(`browser: ${siteBrowser().label} · profile: ${config.paths.browserProfile}`);
const r = await sessionReport(config.paths.browserProfile, site);
console.log(formatSessionReport(r));
if (r.session.state === 'logged_out') console.log(`\nLog in with: npm run login -- ${site}${site === 'drushim' ? ' (or the dashboard button)' : ''}`);
if (r.session.state === 'logged_in') {
  const { getDb } = await import('../db/index.js');
  const { Repo } = await import('../db/repo.js');
  const n = new Repo(await getDb()).requeueLoginFailures(site);
  if (n) console.log(`${n} job(s) that failed on "not logged in" are back in the queue.`);
}
process.exit(0);
