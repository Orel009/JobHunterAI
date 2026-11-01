/**
 * Before a login window is opened: does the site's login address answer with a real page? One plain GET (no browser,
 * no cookies, nothing sent). A refusal page (JobKarov's HTTP 402 "site unavailable", 403 / 429, bot protection) or a
 * redirect to another site is reported with its reason instead of opening a window on it.
 */
export interface LoginPageCheck {
  ok: boolean;
  status: number | null;
  reason: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** The verdict for an answer (pure; tested). */
export function judgeLoginPage(url: string, status: number, finalUrl: string, body: string): LoginPageCheck {
  const ref = /מזהה מספר\s*-?\s*(\d+)/.exec(body)?.[1];
  if (status === 402 || /Sorry!\s*(<[^>]*>\s*)*This page cannot be found/i.test(body)) {
    return { ok: false, status, reason: `the site refused the request (HTTP ${status}, "Sorry! This page cannot be found"${ref ? `, reference ${ref}` : ''}) — it is not serving this network right now` };
  }
  if (status === 403 || status === 429) return { ok: false, status, reason: `the site refused the request (HTTP ${status}${status === 429 ? ', too many requests' : ''})` };
  if (/just a moment|cf-chl|radware page|verifying your browser|_incapsula_resource|px-captcha/i.test(body)) return { ok: false, status, reason: `bot protection page (HTTP ${status})` };
  if (status === 404 || status === 410) return { ok: false, status, reason: `page not found (HTTP ${status})` };
  if (status >= 500) return { ok: false, status, reason: `server error (HTTP ${status})` };
  const host = (u: string) => new URL(u).hostname.replace(/^www\./, '');
  if (host(finalUrl) !== host(url)) return { ok: false, status, reason: `redirected to another site (${finalUrl})` };
  if (status >= 400) return { ok: false, status, reason: `HTTP ${status}` };
  return { ok: true, status, reason: `answers with a real page (HTTP ${status}${finalUrl !== url ? `, via ${finalUrl}` : ''})` };
}

export async function checkLoginPage(url: string, timeoutMs = 20_000): Promise<LoginPageCheck> {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
    return judgeLoginPage(url, r.status, r.url || url, (await r.text()).slice(0, 20_000));
  } catch (e) {
    return { ok: false, status: null, reason: `no answer (${e instanceof Error ? e.message : String(e)})` };
  }
}
