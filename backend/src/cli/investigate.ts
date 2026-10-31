/**
 * Network investigation helper: opens URLs headed in the shared profile, records every XHR/fetch
 * (method, url, status, content-type, request body, JSON response sample) and the final HTML.
 *
 *   npm run investigate -- drushim https://www.drushim.co.il/jobs/search/developer/ [--wait 60]
 *
 * With --wait N the window stays open N seconds so you can click around manually; that traffic is recorded too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getPage, closeContext, detectBlock } from '../browser/session.js';

const args = process.argv.slice(2);
const waitIdx = args.indexOf('--wait');
const clickIdx = args.indexOf('--click');
const clickText = clickIdx >= 0 ? args[clickIdx + 1] : undefined;
const waitSec = waitIdx >= 0 ? Number(args[waitIdx + 1] ?? 30) : 8;
const positional = args.filter((a, i) => !a.startsWith('--') && (waitIdx < 0 || i !== waitIdx + 1) && (clickIdx < 0 || i !== clickIdx + 1));
const [site, ...urls] = positional;
if (!site || urls.length === 0) {
  console.error('usage: investigate <site> <url...> [--wait N]');
  process.exit(1);
}

const outDir = path.join(config.paths.investigations, `${site}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(outDir, { recursive: true });

interface Entry {
  method: string;
  url: string;
  status: number;
  type: string;
  contentType: string;
  postData?: string | null;
  bodyFile?: string;
  jsonKeys?: string[];
}
const entries: Entry[] = [];
let n = 0;

const page = await getPage();
page.on('response', async (res) => {
  const req = res.request();
  const type = req.resourceType();
  if (!['xhr', 'fetch', 'document'].includes(type)) return;
  const contentType = res.headers()['content-type'] ?? '';
  const entry: Entry = { method: req.method(), url: res.url(), status: res.status(), type, contentType, postData: req.postData() };
  entries.push(entry);
  if (/json/.test(contentType) || (type !== 'document' && /text\/plain/.test(contentType))) {
    try {
      const text = await res.text();
      const file = `${String(++n).padStart(3, '0')}.json`;
      fs.writeFileSync(path.join(outDir, file), text);
      entry.bodyFile = file;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object') entry.jsonKeys = Object.keys(parsed).slice(0, 30);
      } catch {
        /* not json */
      }
    } catch {
      /* body unavailable (redirect etc.) */
    }
  }
});

for (const [i, url] of urls.entries()) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  const blocked = await detectBlock(page, res?.status());
  console.log(`[${res?.status()}] ${url}${blocked ? `  BLOCKED: ${blocked}` : ''}`);
  for (let s = 0; s < 4; s++) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(1200);
  }
  if (clickText) {
    const btn = page.getByText(clickText, { exact: false }).first();
    if (await btn.isVisible().catch(() => false)) {
      console.log(`clicking "${clickText}"`);
      await btn.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    }
  }
  fs.writeFileSync(path.join(outDir, `page-${i}.html`), await page.content());
  await page.screenshot({ path: path.join(outDir, `page-${i}.png`), fullPage: false });
}

console.log(`waiting ${waitSec}s (interact with the window if you like)…`);
await page.waitForTimeout(waitSec * 1000);

fs.writeFileSync(path.join(outDir, 'network.json'), JSON.stringify(entries, null, 2));
const interesting = entries.filter((e) => e.type !== 'document' && !/google|facebook|doubleclick|hotjar|clarity|analytics|tiktok|taboola|outbrain/i.test(e.url));
console.log(`\n${entries.length} requests, ${interesting.length} first-party-ish XHR/fetch:`);
for (const e of interesting) console.log(`${e.method} ${e.status} ${e.url.slice(0, 160)} ${e.bodyFile ?? ''} ${e.jsonKeys?.join(',') ?? ''}`);
console.log(`\nsaved to ${outDir}`);
await closeContext();
