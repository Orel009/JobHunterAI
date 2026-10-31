import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { log } from '../log.js';
import { isLinkedInHost } from '../linkedin/parse.js';

let ctxPromise: Promise<BrowserContext> | null = null;

/**
 * One persistent Chromium context for the whole process (data/browser-profile).
 * Sessions/cookies from `npm run login` are reused. Only one process may hold the profile at a time.
 */
export function getContext(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  if (!ctxPromise) {
    ctxPromise = chromium
      .launchPersistentContext(config.paths.browserProfile, {
        headless: opts.headless ?? config.HEADLESS,
        locale: 'he-IL',
        timezoneId: 'Asia/Jerusalem',
        viewport: { width: 1366, height: 860 },
      })
      .then(async (ctx) => {
        // LinkedIn is never automated: any request to it from this browser is aborted, whatever code path asks
        await ctx.route((u) => isLinkedInHost(u.href), (route) => route.abort('blockedbyclient'));
        ctx.on('close', () => {
          ctxPromise = null;
        });
        return ctx;
      })
      .catch((err: unknown) => {
        ctxPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        if (/ProcessSingleton|already in use|lock/i.test(msg)) {
          throw new Error('Browser profile is in use by another JobHunter process (close the login window / other run first).');
        }
        throw err;
      });
  }
  return ctxPromise;
}

/** Single-tab policy: reuse the first page of the context. */
export async function getPage(opts: { headless?: boolean } = {}): Promise<Page> {
  const ctx = await getContext(opts);
  const [first, ...rest] = ctx.pages();
  for (const p of rest) await p.close().catch(() => undefined);
  return first ?? (await ctx.newPage());
}

export async function closeContext(): Promise<void> {
  if (!ctxPromise) return;
  const ctx = await ctxPromise.catch(() => null);
  ctxPromise = null;
  await ctx?.close().catch(() => undefined);
}

export function randomDelay(min = config.PACE_MIN_MS, max = config.PACE_MAX_MS): number {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

/** Human pacing between navigations/actions. */
export async function pace(min?: number, max?: number): Promise<void> {
  const ms = randomDelay(min, max);
  log.debug({ ms }, 'pace');
  await new Promise((r) => setTimeout(r, ms));
}

export class BlockedError extends Error {
  constructor(public reason: string) {
    super(`blocked: ${reason}`);
    this.name = 'BlockedError';
  }
}

const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/recaptcha|hcaptcha|turnstile|captcha/i, 'captcha'],
  [/just a moment|cf-chl|checking your browser|attention required/i, 'cloudflare challenge'],
  [/request unsuccessful\. incapsula|_incapsula_resource|imperva/i, 'imperva/incapsula bot protection'],
  [/px-captcha|perimeterx|press & hold/i, 'perimeterx bot protection'],
  [/too many requests|rate limit/i, 'rate limited'],
];

/**
 * Detects CAPTCHA / bot-protection / rate-limit pages. We never try to get past them:
 * the caller marks the run `blocked` and moves on.
 */
export async function detectBlock(page: Page, status?: number): Promise<string | null> {
  if (status === 429) return 'rate limited (HTTP 429)';
  if (status === 403) return 'forbidden (HTTP 403) — possible bot protection';
  // Invisible reCAPTCHA v3 (0x0 "aframe"/"anchor" iframes) is on many normal pages; only a *visible* challenge counts.
  const visibleChallenge = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).some((f) => {
        const src = f.src || '';
        if (!/recaptcha\/api2\/bframe|recaptcha\/enterprise\/bframe|hcaptcha\.com.*challenge|challenges\.cloudflare|turnstile/i.test(src)) return false;
        const r = f.getBoundingClientRect();
        const st = getComputedStyle(f);
        return r.width > 60 && r.height > 60 && st.visibility !== 'hidden' && st.display !== 'none';
      }),
    )
    .catch(() => false);
  if (visibleChallenge) return 'captcha challenge visible';
  const title = await page.title().catch(() => '');
  const head = await page
    .evaluate(() => (document.body?.innerText ?? '').slice(0, 1500))
    .catch(() => '');
  for (const [re, reason] of BLOCK_PATTERNS) {
    if (re.test(title) || (re.test(head) && head.length < 1500)) return reason;
  }
  return null;
}

export async function assertNotBlocked(page: Page, status?: number): Promise<void> {
  const reason = await detectBlock(page, status);
  if (reason) throw new BlockedError(reason);
}
