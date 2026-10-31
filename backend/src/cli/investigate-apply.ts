/**
 * Apply-flow investigation with a hard write guard (nothing can be submitted):
 *   - every non-GET request to drushim/yad2 hosts (except the bot-manager beacon) is ABORTED and logged with its payload;
 *   - every request whose URL looks like apply/sendcv/submit is ABORTED and logged.
 *
 *   npm run investigate:apply -- find <term...>        find jobs with filter questions (search pages only)
 *   npm run investigate:apply -- apply <jobUrl...>     open job page, click the apply button, dump modal/network
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Request } from 'playwright';
import { config } from '../config.js';
import { closeContext, detectBlock, getPage, pace } from '../browser/session.js';
import { extractNextData, ssrSearchJobs } from '../sites/drushim/normalize.js';
import cfg from '../sites/drushim/selectors.json' with { type: 'json' };

const [mode, ...rest] = process.argv.slice(2);
const outDir = path.join(config.paths.investigations, `drushim-apply-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });

const GUARDED_HOST = /(^|\.)(drushim\.co\.il|yad2\.co\.il)$/i;
const BEACON = /\/c99a4269-161c-4242-a3f0-28d44fa6ce24/;
const APPLY_LIKE = /sendcv|send-cv|apply|submit|candidac|application/i;

interface Rec {
  t: string;
  method: string;
  url: string;
  status?: number;
  postData?: string | null;
  blocked?: boolean;
  body?: string;
}
const recs: Rec[] = [];
let n = 0;

function shouldBlock(req: Request): boolean {
  const u = new URL(req.url());
  if (!GUARDED_HOST.test(u.hostname)) return false;
  if (BEACON.test(u.pathname)) return false;
  if (req.method() !== 'GET') return true;
  return APPLY_LIKE.test(u.pathname + u.search) && req.resourceType() !== 'script' && req.resourceType() !== 'stylesheet';
}

async function setup(page: Page) {
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (shouldBlock(req)) {
      recs.push({ t: new Date().toISOString(), method: req.method(), url: req.url(), postData: req.postData(), blocked: true });
      console.log(`  ⛔ BLOCKED ${req.method()} ${req.url()}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  page.on('response', async (res) => {
    const req = res.request();
    const u = new URL(res.url());
    if (!GUARDED_HOST.test(u.hostname) || BEACON.test(u.pathname)) return;
    const type = req.resourceType();
    if (type === 'script' && /_next\/static/.test(u.pathname)) {
      const body = await res.text().catch(() => '');
      if (/sendcv|apply|filterQuestion|cv/i.test(body)) fs.writeFileSync(path.join(outDir, 'js', path.basename(u.pathname)), body);
      return;
    }
    if (!['xhr', 'fetch', 'document'].includes(type)) return;
    const rec: Rec = { t: new Date().toISOString(), method: req.method(), url: res.url(), status: res.status(), postData: req.postData() };
    if (type !== 'document' && /json|text/.test(res.headers()['content-type'] ?? '')) {
      const file = `${String(++n).padStart(3, '0')}.json`;
      fs.writeFileSync(path.join(outDir, file), await res.text().catch(() => ''));
      rec.body = file;
    }
    recs.push(rec);
  });
}

async function dumpApplyUi(page: Page, tag: string) {
  const info = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a,button,[role=button]')).filter((e) =>
      /שלח|הגש|קורות חיים|קו״ח|קו"ח|הגשת מועמדות|apply|נשלח|הגשת/i.test(e.textContent ?? ''),
    );
    const dialogs = Array.from(document.querySelectorAll('[role=dialog],[aria-modal=true],.modal,[class*=Modal],[class*=modal]'));
    return {
      buttons: els.slice(0, 15).map((e) => ({ text: (e.textContent ?? '').trim().slice(0, 80), html: e.outerHTML.slice(0, 600) })),
      dialogs: dialogs.map((d) => d.outerHTML),
    };
  });
  fs.writeFileSync(path.join(outDir, `${tag}-ui.json`), JSON.stringify(info, null, 2));
  fs.writeFileSync(path.join(outDir, `${tag}.html`), await page.content());
  await page.screenshot({ path: path.join(outDir, `${tag}.png`), fullPage: true });
  return info;
}

const page = await getPage();
await setup(page);

try {
  if (mode === 'find') {
    const found: unknown[] = [];
    for (const term of rest) {
      await pace();
      const res = await page.goto(`https://www.drushim.co.il/jobs/search/${encodeURIComponent(term)}/`, { waitUntil: 'domcontentloaded' });
      const blocked = await detectBlock(page, res?.status());
      if (blocked) throw new Error(`blocked: ${blocked}`);
      const { jobs } = ssrSearchJobs(extractNextData(await page.content()));
      const withQ = jobs.filter((j) => (j.filterQuestions?.length ?? 0) > 0 || j.hasSmartFilter);
      console.log(`${term}: ${jobs.length} jobs, ${withQ.length} with filter questions`);
      for (const j of withQ) found.push({ term, id: j.id, title: j.title, url: j.jobUrl, hasSmartFilter: j.hasSmartFilter, filterQuestions: j.filterQuestions });
    }
    fs.writeFileSync(path.join(outDir, 'filter-jobs.json'), JSON.stringify(found, null, 2));
    console.log(`${found.length} jobs with questions → ${outDir}`);
  } else if (mode === 'apply') {
    for (const [i, url] of rest.entries()) {
      const tag = `job${i}`;
      console.log(`\n== ${url}`);
      await pace();
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      const blocked = await detectBlock(page, res?.status());
      if (blocked) throw new Error(`blocked: ${blocked}`);
      const before = await dumpApplyUi(page, `${tag}-before`);
      console.log('  apply-like buttons:', before.buttons.map((b) => b.text));
      const btn = page.locator(cfg.apply.applyButton).first();
      if (!(await btn.isVisible().catch(() => false))) {
        console.log('  no apply button visible');
        continue;
      }
      await pace(1500, 3000);
      await btn.click();
      await page.waitForTimeout(4000);
      const after = await dumpApplyUi(page, `${tag}-after-click`);
      console.log(`  dialogs after click: ${after.dialogs.length}; url now ${page.url()}`);
      if (await detectBlock(page)) throw new Error('blocked after click');
    }
  } else {
    console.error('usage: investigate-apply find <term...> | apply <jobUrl...>');
  }
} finally {
  fs.writeFileSync(path.join(outDir, 'network.json'), JSON.stringify(recs, null, 2));
  console.log(`\nblocked writes: ${recs.filter((r) => r.blocked).length}; saved ${outDir}`);
  await closeContext();
}
