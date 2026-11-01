/*
 * JobHunter Fill — background worker. Works only when you press "Fill this form" in the extension's popup:
 *   1. refuses LinkedIn and Indeed outright (manual only: nothing is requested, nothing is injected there);
 *   2. asks your local JobHunter (with the per-install token) which job this page belongs to, and for its fill data;
 *   3. injects fill-core.js into THAT tab only (activeTab: no access to any other page, nothing runs by itself);
 *   4. relays "I applied" from the page's overlay back to JobHunter.
 * Nothing is sent anywhere but your own computer (127.0.0.1 / localhost).
 */
importScripts('fill-core.js'); // the shared rules (manualOnlyHost); defines functions only

const DEFAULT_BASE = 'http://127.0.0.1:8787';
const F = globalThis.JobHunterFill;

async function settings() {
  const s = await chrome.storage.local.get(['base', 'token']);
  return { base: (s.base || DEFAULT_BASE).replace(/\/+$/, ''), token: s.token || '' };
}

function localOnly(base) {
  const u = new URL(base);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('JobHunter Fill only talks to your own computer (127.0.0.1 / localhost)');
}

async function api(path, init = {}) {
  const { base, token } = await settings();
  localOnly(base);
  if (!token) throw new Error('no token yet: open the extension options and paste it from JobHunter → Settings → JobHunter Fill');
  const r = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), 'X-JobHunter-Token': token, 'content-type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `JobHunter answered HTTP ${r.status}`);
  return body;
}

/**
 * The fill of one tab (the popup's button, or "Fill again" in the overlay: only the fields still empty are filled).
 *   1. which JobHunter job the page belongs to; the page's fields, its job ad and frames (fill-core's scan);
 *   2. the form planner: each field → a profile key, a draft (cover / bio) or unknown — never a value;
 *   3. a draft for each empty cover-letter / message / bio field, written for THIS job (the stored job, else the ad
 *      on the page), fresh every time;
 *   4. the fill, with the reasons for anything left to you in the overlay.
 */
async function fillTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) throw new Error('not a web page');
  if (F.manualOnlyHost(tab.url)) throw new Error(F.MANUAL_ONLY_MESSAGE);
  const { job } = await api(`/api/fill/match?url=${encodeURIComponent(tab.url)}`);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['fill-core.js'] });
  const [scanned] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.JobHunterFill.scan(document) });
  const page = scanned?.result ?? { fields: [], title: tab.title || '', company: '', lang: 'en', jobText: '', frames: [] };
  const data = await api(`/api/fill/data?lang=${page.lang}${job ? `&jobId=${encodeURIComponent(job.id)}` : ''}`);
  // what went wrong on the way is shown in the overlay
  data.problems = [];
  data.frames = page.frames || [];
  data.jobContext = job ? 'the JobHunter job' : (page.jobText || '').length >= 200 ? 'from page' : 'the page title only (no job ad found on the page)';

  // the form planner (cached per site + form by JobHunter)
  data.plan = {};
  if (page.fields.length) {
    const p = await api('/api/fill/plan', {
      method: 'POST',
      body: JSON.stringify({ url: tab.url, fields: page.fields.map(({ empty, dict, ...f }) => f), job: { title: page.title || '', company: page.company || '', text: job ? '' : page.jobText || '' } }),
    }).catch((e) => ({ plan: {}, error: e.message }));
    data.plan = p.plan || {};
    if (p.error) data.problems.push(`the form was not planned (the dictionary only): ${p.error}`);
  }

  // the drafts: every empty cover-letter / message / bio field, one by one
  data.drafts = {};
  const wanted = page.fields.filter((f) => f.empty).map((f) => ({ f, kind: F.draftKindOf(f, data.plan) })).filter((x) => x.kind);
  if (wanted.length && data.fillCoverLetters) {
    for (const { f, kind } of wanted) {
      data.drafts[f.key] = await api('/api/fill/draft', {
        method: 'POST',
        body: JSON.stringify({
          jobId: job ? job.id : undefined,
          kind,
          title: page.title || '',
          company: page.company || '',
          label: (f.label || f.placeholder || (kind === 'bio' ? 'Bio' : 'Message to the hiring team')).slice(0, 300),
          lang: page.lang,
          jobText: job ? '' : (page.jobText || '').slice(0, 8000),
        }),
      }).catch((e) => ({ text: null, error: e.message }));
    }
  }

  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (d) =>
      globalThis.JobHunterFill.run(document, d, {
        // the overlay's buttons go through this worker (the page never sees the token)
        onApplied: (jobId) =>
          new Promise((resolve, reject) =>
            chrome.runtime.sendMessage({ type: 'applied', jobId }, (r) => (r && r.ok ? resolve(r) : reject(new Error((r && r.error) || 'no answer')))),
          ),
        onFillAgain: () =>
          new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: 'fillAgain' }, (r) => (r && r.ok ? resolve(r) : reject(new Error((r && r.error) || 'no answer'))))),
      }).then((s) => ({ filled: s.filled, drafts: s.drafts, needYou: s.needYou, cv: s.cv, refused: s.refused || null })),
    args: [data],
  });
  if (res?.result?.refused) throw new Error(res.result.refused);
  return res?.result ?? null;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'fill' && !sender.tab) {
    // from the popup
    fillTab(msg.tabId)
      .then((summary) => reply({ ok: true, summary }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'fillAgain' && sender.tab) {
    // "Fill again" in the overlay: the same fill on that tab (filled fields are never overwritten)
    fillTab(sender.tab.id)
      .then((summary) => reply({ ok: true, summary }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'applied' && sender.tab) {
    // from the overlay in the page
    if (F.manualOnlyHost(sender.tab.url)) {
      reply({ ok: false, error: F.MANUAL_ONLY_MESSAGE });
      return false;
    }
    api(`/api/fill/jobs/${encodeURIComponent(msg.jobId)}/applied`, { method: 'POST', body: '{}' })
      .then((r) => reply({ ok: true, ...r }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
