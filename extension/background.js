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

async function api(path, init = {}, timeoutMs = 0) {
  const { base, token } = await settings();
  localOnly(base);
  if (!token) throw new Error('no token yet: open the extension options and paste it from JobHunter → Settings → JobHunter Fill');
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const r = await fetch(`${base}${path}`, { ...init, signal, headers: { ...(init.headers || {}), 'X-JobHunter-Token': token, 'content-type': 'application/json' } }).catch((e) => {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw new Error(`JobHunter did not answer (${e.message}) — is it running?`);
  });
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
  // the job ad: the stored job; the page's own; else fetched by JobHunter (the ATS's public job endpoint, or the same
  // address without "/apply") — plain GETs, same site, never LinkedIn / Indeed
  let hasAd = !!job || (page.jobText || '').length >= 200;
  data.jobContext = job ? 'the JobHunter job' : hasAd ? 'from page' : '';
  if (!hasAd) {
    const ctx = await api('/api/fill/job-context', { method: 'POST', body: JSON.stringify({ url: tab.url }) }, 60000).catch((e) => ({ ok: false, error: e.message }));
    if (ctx.ok) {
      page.jobText = ctx.text;
      if (ctx.title && !page.title) page.title = ctx.title;
      if (ctx.company) page.company = ctx.company;
      hasAd = true;
      data.jobContext = `fetched from ${ctx.source}`;
    } else data.jobContext = `the page title only (no job ad on the page; ${ctx.error || 'none fetched'})`;
  }
  data.hasJobContext = hasAd;
  const title = String(page.title || '').slice(0, 300);
  const company = String(page.company || '').slice(0, 200);

  // the form planner, only for the fields the rules do not recognize (cached per site + form by JobHunter)
  data.plan = {};
  const unknown = page.fields.filter((f) => !f.dict);
  if (unknown.length) {
    const p = await api(
      '/api/fill/plan',
      { method: 'POST', body: JSON.stringify({ url: tab.url, fields: unknown.map(({ empty, dict, ...f }) => f), job: { title, company, text: job ? '' : page.jobText || '' } }) },
      120000,
    ).catch((e) => ({ plan: {}, error: e.message }));
    data.plan = p.plan || {};
    if (p.error) data.problems.push(`the form planner failed (${p.error}); the rules only`);
  }

  // the drafts: every empty cover-letter / message / bio field, one by one; for every other free-text field, why not
  data.drafts = {};
  data.draftNotes = {};
  const report = [];
  for (const f of page.fields.filter((x) => x.empty)) {
    const kind = F.draftKindOf(f, data.plan, data.hasJobContext);
    if (!kind) {
      if (f.type === 'textarea') data.draftNotes[f.key] = F.noDraftReason(f, data.plan);
      continue;
    }
    if (!data.fillCoverLetters) {
      data.draftNotes[f.key] = 'cover letters are OFF (JobHunter → Settings → JobHunter Fill → "Fill cover letters in the extension")';
      continue;
    }
    if (!f.required && data.draftOptionalFields === false) {
      data.draftNotes[f.key] = 'an optional field, and "draft optional cover / bio fields" is off (JobHunter → Settings → JobHunter Fill)';
      continue;
    }
    const t0 = Date.now();
    data.drafts[f.key] = await api(
      '/api/fill/draft',
      {
        method: 'POST',
        body: JSON.stringify({
          jobId: job ? job.id : undefined,
          kind,
          title,
          company,
          label: String(f.label || f.placeholder || (kind === 'bio' ? 'Bio' : 'Message to the hiring team')).slice(0, 300),
          lang: page.lang,
          jobText: job ? '' : String(page.jobText || '').slice(0, 8000),
        }),
      },
      180000,
    ).catch((e) => ({ text: null, error: e.message }));
    report.push({ label: f.label || f.placeholder, kind, ok: !!data.drafts[f.key].text, error: data.drafts[f.key].error || null, ms: Date.now() - t0 });
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
      }).then((s) => ({ filled: s.filled, drafts: s.drafts, needYou: s.needYou, cv: s.cv, refused: s.refused || null, pending: s.pending, notes: s.notes, questions: s.questions || [] })),
    args: [data],
  });
  if (res?.result?.refused) throw new Error(res.result.refused);
  // questions the form asked with no answer on file (yes / no, a choice): into your answers bank as pending, once
  const questions = (res?.result?.questions || []).slice(0, 20);
  if (questions.length) {
    const r = await api('/api/fill/pending', { method: 'POST', body: JSON.stringify({ questions }) }).catch(() => null);
    const text = r
      ? `${questions.length} question${questions.length > 1 ? 's' : ''} sent to your answers bank${r.added ? ` (${r.added} new)` : ''}: answer ${questions.length > 1 ? 'them' : 'it'} in JobHunter → Answers, then Fill again`
      : 'the questions could not be sent to your answers bank';
    await chrome.scripting.executeScript({ target: { tabId }, func: (t) => globalThis.JobHunterFill.notice(document, t), args: [text] }).catch(() => undefined);
  }
  // what happened, in JobHunter's log (no values: field labels, kinds and reasons only)
  api('/api/fill/report', {
    method: 'POST',
    body: JSON.stringify({
      url: tab.url,
      linked: !!job,
      jobContext: data.jobContext,
      fields: page.fields.map((f) => ({ label: f.label || f.placeholder, type: f.type, required: f.required, rule: f.dict, planned: data.plan[f.key] || null })),
      drafts: report,
      questions: questions.map((q) => q.question),
      problems: data.problems,
      result: res?.result ? { filled: res.result.filled, drafts: res.result.drafts, needYou: res.result.needYou, pending: res.result.pending, notes: res.result.notes } : null,
    }),
  }).catch(() => undefined);
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
