/* The toolbar popup: on LinkedIn / Indeed it only says "manual only" (nothing is injected, nothing is requested);
   anywhere else, "Fill this form" asks the background worker to fill the current tab. */
const $ = (id) => document.getElementById(id);
const F = globalThis.JobHunterFill;

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab || !/^https?:/.test(tab.url || '')) {
    $('msg').textContent = 'Open an application form first.';
    return;
  }
  if (F.manualOnlyHost(tab.url)) {
    $('manual').textContent = F.MANUAL_ONLY_MESSAGE;
    $('manual').hidden = false;
    return;
  }
  $('fill').hidden = false;
  $('go').onclick = () => {
    $('go').disabled = true;
    $('msg').textContent = 'filling…';
    chrome.runtime.sendMessage({ type: 'fill', tabId: tab.id, url: tab.url }, (r) => {
      $('go').disabled = false;
      if (!r) $('msg').textContent = 'no answer from the extension';
      else if (r.ok) $('msg').textContent = r.summary ? `filled ${r.summary.filled}, ${r.summary.needYou} need you${r.summary.cv ? ` · CV: ${r.summary.cv}` : ''}` : 'done';
      else $('msg').textContent = r.error;
    });
  };
});
