/*
 * JobHunter Fill — background worker. Runs only when you click the extension's button:
 *   1. asks your local JobHunter (with the per-install token) which job this page belongs to, and for its fill data;
 *   2. injects fill-core.js into THIS tab only (activeTab: no access to any other page, nothing runs by itself);
 *   3. relays "I applied" from the page's overlay back to JobHunter.
 * Nothing is sent anywhere but your own computer (127.0.0.1 / localhost).
 */
const DEFAULT_BASE = 'http://127.0.0.1:8787';

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

async function showMessage(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (t) => {
      document.getElementById('jobhunter-fill-overlay')?.remove();
      const d = document.createElement('div');
      d.id = 'jobhunter-fill-overlay';
      d.textContent = `JobHunter Fill: ${t}`;
      d.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;max-width:340px;font:13px system-ui,sans-serif;background:#fff;color:#222;border:1px solid #c33;border-radius:8px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.2)';
      d.onclick = () => d.remove();
      document.body.appendChild(d);
    },
    args: [text],
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return;
  try {
    const { job } = await api(`/api/fill/match?url=${encodeURIComponent(tab.url)}`);
    const data = await api(`/api/fill/data${job ? `?jobId=${encodeURIComponent(job.id)}` : ''}`);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fill-core.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (d) =>
        globalThis.JobHunterFill.run(document, d, {
          // the overlay's "I applied" goes through this worker (the page never sees the token)
          onApplied: (jobId) =>
            new Promise((resolve, reject) =>
              chrome.runtime.sendMessage({ type: 'applied', jobId }, (r) => (r && r.ok ? resolve(r) : reject(new Error((r && r.error) || 'no answer')))),
            ),
        }),
      args: [data],
    });
  } catch (e) {
    await showMessage(tab.id, e.message).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'applied' || !sender.tab) return false;
  api(`/api/fill/jobs/${encodeURIComponent(msg.jobId)}/applied`, { method: 'POST', body: '{}' })
    .then((r) => reply({ ok: true, ...r }))
    .catch((e) => reply({ ok: false, error: e.message }));
  return true; // answered asynchronously
});
