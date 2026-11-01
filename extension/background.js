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

/** The fill of one tab (the popup's button). */
async function fillTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) throw new Error('not a web page');
  if (F.manualOnlyHost(tab.url)) throw new Error(F.MANUAL_ONLY_MESSAGE);
  const { job } = await api(`/api/fill/match?url=${encodeURIComponent(tab.url)}`);
  const data = await api(`/api/fill/data${job ? `?jobId=${encodeURIComponent(job.id)}` : ''}`);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['fill-core.js'] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (d) =>
      globalThis.JobHunterFill.run(document, d, {
        // the overlay's "I applied" goes through this worker (the page never sees the token)
        onApplied: (jobId) =>
          new Promise((resolve, reject) =>
            chrome.runtime.sendMessage({ type: 'applied', jobId }, (r) => (r && r.ok ? resolve(r) : reject(new Error((r && r.error) || 'no answer')))),
          ),
      }).then((s) => ({ filled: s.filled, needYou: s.needYou, cv: s.cv, refused: s.refused || null })),
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
