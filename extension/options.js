const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['base', 'token']).then((s) => {
  $('base').value = s.base || 'http://127.0.0.1:8787';
  $('token').value = s.token || '';
});

$('save').onclick = async () => {
  const base = $('base').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787';
  const token = $('token').value.trim();
  const msg = $('msg');
  try {
    const u = new URL(base);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('only your own computer: 127.0.0.1 or localhost');
    await chrome.storage.local.set({ base, token });
    const r = await fetch(`${base}/api/fill/ping`, { headers: { 'X-JobHunter-Token': token } });
    msg.textContent = r.ok ? '✓ saved — connected to JobHunter' : r.status === 401 ? '✗ saved, but the token is wrong (copy it again from Settings)' : `✗ saved, but JobHunter answered HTTP ${r.status}`;
  } catch (e) {
    msg.textContent = `✗ ${e.message} (is JobHunter running?)`;
  }
};
