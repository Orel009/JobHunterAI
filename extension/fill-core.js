/*
 * JobHunter Fill — the part that runs in the page, only when you click the extension's button.
 * It FILLS fields and highlights what needs you. It never submits a form, never clicks a button or a link, never touches
 * a CAPTCHA, never runs by itself, and never sends anything anywhere (the data comes from your local JobHunter through
 * the extension's background worker). The only clicks it makes are on the radio / checkbox inputs of a question whose
 * prepared answer it is setting.
 *
 * Plain script (no modules): defines globalThis.JobHunterFill. The matching helpers are pure and tested in node.
 */
(function (root) {
  'use strict';

  // ---------- text ----------
  const norm = (s) =>
    String(s ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[֑-ׇ]/g, '')
      .replace(/[‎‏‪-‮]/g, '')
      .replace(/\*/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  /** Which of your details a field asks for, from its label / name / id / autocomplete / placeholder (Hebrew + English). */
  const FIELD_RULES = [
    ['cv', /\b(resume|cv|curriculum)\b|קורות חיים|קו ח/],
    ['coverLetter', /cover letter|motivation letter|מכתב מקדים|מכתב פנייה/],
    ['firstName', /\b(first name|given name|fname|first_name|firstname)\b|שם פרטי/],
    ['lastName', /\b(last name|family name|surname|lname|last_name|lastname)\b|שם משפחה/],
    ['email', /\b(e ?mail|email address)\b|דואל|דוא ל|אימייל|מייל/],
    ['phone', /\b(phone|mobile|tel|telephone|cell)\b|טלפון|נייד|סלולרי/],
    ['linkedin', /linkedin/],
    ['github', /github/],
    ['website', /\b(website|portfolio|personal site|homepage|blog)\b|אתר אישי|תיק עבודות/],
    ['salary', /salary|compensation|expected pay|pay expectation|desired pay|שכר|משכורת|ציפיות שכר/],
    ['city', /^(city|current city|current location|location|location city|town|place of residence|where do you live)$|^(עיר|עיר מגורים|מקום מגורים|יישוב|מגורים)$/],
    ['fullName', /^(name|full name|your name|legal name|candidate name)$|^(שם|שם מלא)$/],
  ];
  /** Never filled: CAPTCHA, consents / declarations (you tick those yourself), passwords, payment. */
  const NEVER = /captcha|recaptcha|hcaptcha|turnstile|password|סיסמה|credit card|cvv|i agree|i consent|i confirm|i acknowledge|i certify|privacy|terms|consent|אני מאשר|אני מסכים|מסכים לתנאי|מדיניות הפרטיות|תנאי השימוש|הצהרה|gdpr/;

  function classify(text) {
    const t = norm(text);
    if (!t) return null;
    if (NEVER.test(t)) return 'never';
    for (const [key, re] of FIELD_RULES) if (re.test(t)) return key;
    return null;
  }

  /** An answer from the bank for a question label: the same question, or one clearly containing the other. */
  function bankAnswer(label, bank) {
    const l = norm(label);
    if (l.length < 4) return null;
    const exact = bank.find((b) => norm(b.question) === l);
    if (exact) return exact;
    return bank.find((b) => {
      const q = norm(b.question);
      return q.length >= 12 && l.length >= 12 && (l.includes(q) || q.includes(l));
    }) ?? null;
  }

  const YES = /^(yes|y|true|כן|נכון|yes i am|yes i do|i am|i do)$/;
  const NO = /^(no|n|false|לא|no i am not|no i do not|i am not|i do not)$/;
  /** The option matching an answer: the same text; yes / no in either language; else one clearly containing it. */
  function chooseOption(options, answer) {
    const a = norm(answer);
    if (!a) return -1;
    const texts = options.map(norm);
    let i = texts.findIndex((t) => t === a);
    if (i >= 0) return i;
    if (YES.test(a)) i = texts.findIndex((t) => YES.test(t) || /^yes\b|^כן\b/.test(t));
    else if (NO.test(a)) i = texts.findIndex((t) => NO.test(t) || /^no\b|^לא\b/.test(t));
    if (i >= 0) return i;
    return texts.findIndex((t) => t.length >= 3 && a.length >= 3 && (t.includes(a) || a.includes(t)));
  }

  /**
   * What to put in one field (pure): { value } to fill, { pending } when it is a question with no answer on file,
   * { cv } for the CV upload, { skip } for anything that must be left alone. `f` = { label, name, id, type, options }.
   */
  function answerFor(f, data) {
    const c = data.contact ?? {};
    const text = [f.label, f.name, f.id, f.autocomplete, f.placeholder].filter(Boolean).join(' ');
    if (NEVER.test(norm(text)) || /captcha/i.test(`${f.name} ${f.id}`)) return { skip: 'never filled' };
    // Greenhouse: the prepared answer of this very question (by its field name = the input's id)
    const gh = (data.form ?? []).find((a) => a.name && (a.name === f.id || a.name === f.name || `${a.name}[]` === f.name));
    if (gh) return gh.status === 'resolved' && gh.value ? { value: gh.value, from: 'prepared answer' } : { pending: gh.source || 'answer pending' };
    const kind = classify(f.label) ?? classify(`${f.name ?? ''} ${f.id ?? ''} ${f.autocomplete ?? ''}`) ?? classify(f.placeholder);
    if (f.type === 'file') return kind === 'cv' ? { cv: true } : { skip: 'file' };
    if (kind === 'never') return { skip: 'never filled' };
    if (kind === 'coverLetter') return { skip: 'cover letter left empty (policy)' };
    const contact = {
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: c.fullName,
      email: c.email,
      phone: c.phone,
      city: c.city,
      linkedin: c.linkedin,
      github: c.github,
      website: c.website,
    };
    if (kind && kind in contact) return contact[kind] ? { value: contact[kind], from: 'profile' } : { pending: `no ${kind} in your profile` };
    if (kind === 'salary') {
      const s = data.salary;
      const v = f.type === 'number' ? (s?.number ?? null) : (s?.text ?? s?.number ?? null);
      if (v) return { value: v, from: 'salary settings' };
    }
    const b = bankAnswer(f.label, data.bank ?? []);
    if (b) return { value: b.answer, from: 'answers bank' };
    if (kind === 'salary') return { pending: 'salary: no answer by your rules' };
    return f.required ? { pending: 'no answer on file' } : { skip: 'not one of your details' };
  }

  // ---------- the page ----------
  const MARK = 'data-jobhunter-fill';
  const STYLE = { pending: '3px solid #f2c200', cv: '3px solid #2b7de9', filled: '2px solid #2e9e5b' };

  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  function labelFor(doc, el) {
    if (el.id) {
      const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && textOf(l)) return textOf(l);
    }
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return textOf(wrap);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const fs = el.closest('fieldset');
    if (fs && fs.querySelector('legend')) return textOf(fs.querySelector('legend'));
    // the nearest text before the field inside its group (forms without <label>)
    const group = el.closest('[class*="field"], [class*="question"], [class*="form-group"], li, .row, div');
    if (group) {
      const lab = group.querySelector('label, legend, [class*="label"], h3, h4, span');
      if (lab && lab !== el && textOf(lab)) return textOf(lab);
    }
    return el.getAttribute('placeholder') || '';
  }

  const isRequired = (doc, el, label) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label);

  /** React / Angular / Vue friendly: the native setter, then the events a person's typing fires. */
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** Only ever called on a radio / checkbox input (never a button, link or submit). */
  function tick(input) {
    if (!(input instanceof HTMLInputElement) || (input.type !== 'radio' && input.type !== 'checkbox')) throw new Error('JobHunter Fill: refusing to click a non-choice element');
    if (!input.checked) input.click();
  }

  function mark(el, kind, title) {
    const target = el.type === 'radio' || el.type === 'checkbox' ? el.closest('fieldset, [role="radiogroup"], [class*="question"], div') || el : el;
    target.setAttribute(MARK, kind);
    target.style.outline = STYLE[kind];
    target.style.outlineOffset = '2px';
    if (title) target.title = `JobHunter: ${title}`;
  }

  function clearMarks(doc) {
    for (const el of doc.querySelectorAll(`[${MARK}]`)) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.removeAttribute(MARK);
    }
    doc.getElementById('jobhunter-fill-overlay')?.remove();
  }

  const empty = (el) => (el.tagName === 'SELECT' ? !el.value || el.selectedIndex <= 0 : !String(el.value ?? '').trim());
  const inCaptcha = (el) => !!el.closest('[class*="captcha"], [id*="captcha"], .g-recaptcha, .h-captcha, iframe');

  /** Fills the page. Returns the summary; shows the overlay unless opts.overlay === false. */
  async function run(doc, data, opts = {}) {
    clearMarks(doc);
    const out = { filled: 0, needYou: 0, cv: data.cv?.file ?? null, cvFields: 0, skipped: 0, details: [] };
    const done = new Set();
    const fields = [...doc.querySelectorAll('input, textarea, select')].filter(
      (el) => !['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search'].includes(el.type) && !el.disabled && !el.readOnly && !inCaptcha(el) && (visible(el) || el.type === 'file'),
    );
    for (const el of fields) {
      if (done.has(el)) continue;
      const label = labelFor(doc, el);
      const info = { label, name: el.name || '', id: el.id || '', type: el.type || el.tagName.toLowerCase(), autocomplete: el.autocomplete || '', placeholder: el.placeholder || '', required: false };
      info.required = isRequired(doc, el, label);

      // radio group / checkbox group: one question, many inputs
      if (el.type === 'radio' || (el.type === 'checkbox' && el.name && doc.querySelectorAll(`input[type=checkbox][name="${CSS.escape(el.name)}"]`).length > 1)) {
        const group = [...doc.querySelectorAll(`input[type=${el.type}][name="${CSS.escape(el.name)}"]`)];
        group.forEach((g) => done.add(g));
        const gl = groupLabel(doc, el) || label;
        const a = answerFor({ ...info, label: gl, type: el.type }, data);
        if (group.some((g) => g.checked)) continue; // already answered (by you or the site)
        if (a.value !== undefined) {
          const answers = el.type === 'checkbox' ? String(a.value).split(/\s*[,;]\s*/) : [a.value];
          const optionLabels = group.map((g) => labelFor(doc, g) || g.value);
          const picks = answers.map((v) => chooseOption(optionLabels, v)).filter((i) => i >= 0);
          if (picks.length) {
            picks.forEach((i) => tick(group[i]));
            out.filled++;
            out.details.push({ label: gl, value: answers.join(', '), from: a.from });
            continue;
          }
        }
        if (a.pending || a.value !== undefined || info.required) {
          mark(el, 'pending', a.pending ?? 'no matching option for your answer');
          out.needYou++;
        }
        continue;
      }
      done.add(el);

      const a = answerFor(info, data);
      if (a.cv) {
        mark(el.closest('[class*="upload"], [class*="file"], div') || el, 'cv', `choose ${data.cv?.file ?? 'your CV'}`);
        out.cvFields++;
        continue;
      }
      if (a.skip) {
        // a required consent / declaration: never ticked for you, but shown so you decide
        if (a.skip === 'never filled' && info.required && (el.type === 'checkbox' ? !el.checked : empty(el))) {
          mark(el, 'pending', 'yours to decide (never ticked for you)');
          out.needYou++;
        } else out.skipped++;
        continue;
      }
      if (a.pending) {
        if (empty(el)) {
          mark(el, 'pending', a.pending);
          out.needYou++;
        }
        continue;
      }
      if (!empty(el)) continue; // never overwrite what is there
      if (el.type === 'checkbox') {
        if (/^(yes|true|כן)$/i.test(String(a.value).trim())) {
          tick(el);
          out.filled++;
        }
        continue;
      }
      if (el.tagName === 'SELECT') {
        const opts2 = [...el.options];
        const i = chooseOption(opts2.map((o) => o.text), a.value);
        if (i >= 0 && opts2[i].value !== '') {
          setValue(el, opts2[i].value);
          mark(el, 'filled');
          out.filled++;
          out.details.push({ label, value: opts2[i].text, from: a.from });
        } else {
          mark(el, 'pending', `no option matches "${a.value}"`);
          out.needYou++;
        }
        continue;
      }
      if (el.getAttribute('role') === 'combobox' || /select__input/.test(el.className)) {
        const ok = await fillCombobox(doc, el, String(a.value));
        if (ok) {
          out.filled++;
          out.details.push({ label, value: a.value, from: a.from });
        } else {
          mark(el, 'pending', `choose "${a.value}" in the list`);
          out.needYou++;
        }
        continue;
      }
      if (el.type === 'number' && !/^\d+(\.\d+)?$/.test(String(a.value).replace(/[,\s₪]/g, ''))) {
        mark(el, 'pending', `"${a.value}" is not a number`);
        out.needYou++;
        continue;
      }
      setValue(el, el.type === 'number' ? String(a.value).replace(/[,\s₪]/g, '') : String(a.value));
      mark(el, 'filled');
      out.filled++;
      out.details.push({ label, value: a.value, from: a.from });
    }
    // required fields still empty (questions the site renders as custom widgets too)
    for (const el of doc.querySelectorAll('[aria-required="true"], [required]')) {
      if (el.hasAttribute(MARK) || el.closest(`[${MARK}]`) || !visible(el) || inCaptcha(el) || el.type === 'file' || el.type === 'hidden') continue;
      if (('value' in el && !empty(el)) || (el.type === 'radio' || el.type === 'checkbox')) continue;
      mark(el, 'pending', 'required — fill it yourself');
      out.needYou++;
    }
    if (opts.overlay !== false) overlay(doc, data, out, opts);
    return out;
  }

  function groupLabel(doc, el) {
    const fs = el.closest('fieldset');
    if (fs && fs.querySelector('legend')) return textOf(fs.querySelector('legend'));
    const rg = el.closest('[role="radiogroup"], [role="group"]');
    if (rg) {
      const by = rg.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(' ').trim();
      if (rg.getAttribute('aria-label')) return rg.getAttribute('aria-label');
    }
    const q = el.closest('[class*="question"], [class*="field"], .form-group, li');
    const lab = q && q.querySelector('label:not(:has(input)), legend, [class*="label"], p, span');
    return lab ? textOf(lab) : '';
  }

  /** A searchable list (e.g. Greenhouse's): type the answer, take the matching suggestion with Enter, check it took. */
  async function fillCombobox(doc, input, value) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    setValue(input, value);
    await wait(250);
    const listbox = doc.getElementById(input.getAttribute('aria-controls') || '') || doc.querySelector('[role="listbox"]');
    const option = listbox && [...listbox.querySelectorAll('[role="option"]')].find((o) => chooseOption([textOf(o)], value) === 0);
    if (!option) {
      setValue(input, '');
      return false;
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await wait(150);
    const box = input.closest('[class*="container"], [class*="select"]') || input.parentElement;
    return chooseOption([textOf(box)], value) === 0 || textOf(box).includes(value);
  }

  function overlay(doc, data, out, opts) {
    const host = doc.createElement('div');
    host.id = 'jobhunter-fill-overlay';
    host.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;';
    const shadow = host.attachShadow({ mode: 'open' });
    const job = data.job;
    shadow.innerHTML = `
      <style>
        .b{font:13px system-ui,sans-serif;background:#fff;color:#222;border:1px solid #ccc;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);padding:10px 12px;max-width:340px}
        .t{font-weight:600;margin-bottom:4px} .m{color:#666;font-size:12px} .r{display:flex;gap:8px;margin-top:8px}
        button{font:inherit;padding:4px 10px;border-radius:5px;border:1px solid #888;background:#f6f6f6;cursor:pointer} button.p{background:#2e9e5b;color:#fff;border-color:#2e9e5b}
        .y{background:#f2c200;padding:0 4px;border-radius:3px} .c{background:#2b7de9;color:#fff;padding:0 4px;border-radius:3px}
      </style>
      <div class="b">
        <div class="t">JobHunter Fill</div>
        <div>filled ${out.filled} field${out.filled === 1 ? '' : 's'}, <span class="y">${out.needYou} need you</span>${out.cv ? `, <span class="c">CV: ${escapeHtml(out.cv)}</span>` : ''}</div>
        <div class="m">${job ? `${escapeHtml(job.title)} — ${escapeHtml(job.company)} (${escapeHtml(job.siteLabel)})` : 'not linked to a JobHunter job: your details only'}</div>
        <div class="m">Check everything, attach the CV, then submit yourself.</div>
        <div class="r">${job ? '<button class="p" id="applied">I applied</button>' : ''}<button id="close">Close</button></div>
        <div class="m" id="msg"></div>
      </div>`;
    shadow.getElementById('close').onclick = () => clearMarks(doc);
    const ap = shadow.getElementById('applied');
    if (ap)
      ap.onclick = async () => {
        ap.disabled = true;
        const msg = shadow.getElementById('msg');
        try {
          const r = await (opts.onApplied ? opts.onApplied(job.id) : Promise.reject(new Error('not available')));
          msg.textContent = r && r.already ? 'already marked as applied' : '✓ marked as applied in JobHunter';
        } catch (e) {
          ap.disabled = false;
          msg.textContent = `could not mark it: ${e.message}`;
        }
      };
    doc.body.appendChild(host);
  }

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  root.JobHunterFill = { norm, classify, bankAnswer, chooseOption, answerFor, run, clearMarks };
})(typeof globalThis !== 'undefined' ? globalThis : this);
