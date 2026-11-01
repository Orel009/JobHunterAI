/*
 * JobHunter Fill — the part that runs in the page, only when you press "Fill this form".
 * It FILLS fields and highlights what needs you. It never submits a form, never touches a CAPTCHA, never runs by itself,
 * and never sends anything anywhere (the data comes from your local JobHunter through the extension's background
 * worker). The only things it clicks: the radio / checkbox inputs of a question it is answering, a suggestion in a list
 * that matches your answer exactly, and an "Add" button inside an Experience / Education section (to create an entry it
 * then fills) — never Submit, Next, Apply, Save or anything outside those sections. Never on LinkedIn or Indeed.
 *
 * Plain script (no modules): defines globalThis.JobHunterFill. Works through open shadow roots (web-component forms such
 * as SmartRecruiters'), and sets values the way frameworks accept (native setter + input / change / blur events that
 * cross shadow boundaries). The matching helpers are pure and tested in node.
 */
(function (root) {
  'use strict';

  // ---------- where it never runs ----------
  /** LinkedIn and Indeed are manual only: the extension never fills (or injects anything) there. */
  const MANUAL_ONLY_MESSAGE = 'LinkedIn/Indeed: manual only, use the copy panel';
  function manualOnlyHost(url) {
    let h = '';
    try {
      h = new URL(String(url)).hostname.toLowerCase();
    } catch {
      return false;
    }
    return /(^|\.)linkedin\.com$/.test(h) || /(^|\.)lnkd\.in$/.test(h) || /(^|\.)indeed\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/.test(h) || /(^|\.)indeedapply\.com$/.test(h);
  }

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
  /** camelCase / snake_case / kebab-case names → words ("firstName" → "first name") */
  const words = (s) => norm(String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '));

  // ---------- field types: what a field asks for ----------
  /** the page's own autocomplete hint first */
  const AUTOCOMPLETE = {
    'given-name': 'firstName',
    'family-name': 'lastName',
    name: 'fullName',
    email: 'email',
    tel: 'phone',
    'tel-national': 'phone',
    'address-level2': 'city',
    'street-address': 'address',
    'address-line1': 'address',
    url: 'website',
    organization: 'currentCompany',
    'organization-title': 'currentTitle',
  };
  /** then the synonym dictionary (Hebrew + English; order matters: specific before general) */
  const SYNONYMS = [
    ['never', /captcha|recaptcha|hcaptcha|turnstile|password|סיסמה|credit card|cvv|i agree|i consent|i confirm|i acknowledge|i certify|privacy|terms|consent|אני מאשר|אני מסכים|מסכים לתנאי|מדיניות הפרטיות|תנאי השימוש|הצהרה|gdpr/],
    ['social', /facebook|twitter|\bx fka\b|instagram|tiktok|פייסבוק|טוויטר/],
    ['cv', /\b(resume|cv|curriculum)\b|קורות חיים|קו ח/],
    ['coverLetter', /cover letter|motivation letter|message to (the )?hiring|hiring (team|manager) message|let the company know|why (do you want|us|are you interested|this (role|company|position))|about (yourself|you)|tell us about|introduce yourself|מכתב מקדים|מכתב פנייה|מכתב לצוות|ספר (י )?על עצמך|ספרו על עצמכם|קצת על עצמי|למה (את|אתה|את ה|אתם)|מדוע (את|אתה)/],
    ['confirmEmail', /\b(confirm|re enter|reenter|repeat|verify|retype) (your )?e ?mail|e ?mail (confirmation|again)|אימות (דוא ל|דואל|מייל|כתובת)|הקלד(ה| י)? שוב/],
    ['firstName', /\b(first name|given name|fname|first)\b|שם פרטי/],
    ['lastName', /\b(last name|family name|surname|lname|last)\b|שם משפחה/],
    ['email', /\b(e ?mail|email address)\b|דואל|דוא ל|אימייל|מייל/],
    ['phone', /\b(phone|mobile|tel|telephone|cell)\b|טלפון|נייד|סלולרי/],
    ['linkedin', /linked ?in/],
    ['github', /git ?hub/],
    ['website', /\b(website|web site|portfolio|personal site|homepage|blog|url)\b|אתר אישי|תיק עבודות/],
    ['salary', /salary|compensation|expected pay|pay expectation|desired pay|שכר|משכורת|ציפיות שכר/],
    ['noticePeriod', /notice period|availability to start|start date|when can you start|available to start|הודעה מוקדמת|זמינות להתחלת|מתי (תוכל|תוכלי|אפשר) להתחיל/],
    // GENERAL years only: a question naming a technology ("… with Node.js") is not this field
    ['yearsExperience', /^(total )?(number of )?years of (professional |work |relevant |overall )?experience$|^how many years of (professional |work |relevant |overall )?experience (do you have|have you got)$|^(סה כ )?שנות ניסיון( מקצועי| בעבודה)?$/],
    ['currentTitle', /current (job )?(title|position|role)|job title|תפקיד נוכחי/],
    ['currentCompany', /current (company|employer)|present employer|employer name|מקום עבודה נוכחי|מעסיק נוכחי|חברה נוכחית/],
    ['city', /^(city|current city|current location|location|location city|town|place of residence|city of residence|where do you live)$|^(עיר|עיר מגורים|מקום מגורים|יישוב|מגורים)$/],
    ['address', /\b(street )?address\b|^כתובת( מגורים)?$/],
    ['fullName', /^(name|full name|your name|legal name|candidate name)$|^(שם|שם מלא)$/],
  ];

  function classify(text) {
    const t = norm(text);
    if (!t) return null;
    for (const [type, re] of SYNONYMS) if (re.test(t)) return type;
    return null;
  }

  /** A field's type: autocomplete → label → form-control name / name / id → placeholder → the cached label classification. */
  function fieldType(f, data) {
    const ac = String(f.autocomplete || '').toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) {
      // "email" twice on a page: the one whose label / id says confirm is the confirmation
      if (AUTOCOMPLETE[ac] === 'email' && classify(`${f.label} ${words(f.id)} ${words(f.name)}`) === 'confirmEmail') return 'confirmEmail';
      return AUTOCOMPLETE[ac];
    }
    const byLabel = classify(f.label);
    if (byLabel) return byLabel;
    const byName = classify(`${words(f.controlName)} ${words(f.name)} ${words(f.id)} ${words(f.dataTest)}`);
    if (byName) return byName;
    const byPlaceholder = classify(f.placeholder);
    if (byPlaceholder) return byPlaceholder;
    const learned = data && data.labelTypes ? data.labelTypes[norm(f.label)] : undefined;
    return learned && learned !== 'unknown' ? learned : null;
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
  /** a bank answer for a field type (e.g. notice period) by any of its synonyms in the bank's questions */
  const bankByType = (type, bank) => bank.find((b) => classify(b.question) === type) ?? null;

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
  /** A suggestion that IS the city: the same text, or the same before its first comma ("Tel Aviv, Israel"). */
  const exactPlace = (option, value) => norm(String(option).split(',')[0]) === norm(value) || norm(option) === norm(value);

  /** "+972-50-123 4567" / "972501234567" → "0501234567" (a country selector next to the field holds the +972). */
  function localPhone(p) {
    const d = String(p ?? '').replace(/[^\d+]/g, '');
    if (d.startsWith('+972')) return `0${d.slice(4).replace(/^0/, '')}`;
    if (d.startsWith('972') && d.length >= 11) return `0${d.slice(3).replace(/^0/, '')}`;
    return d;
  }

  /**
   * What to put in one field (pure). Returns { value, from } to fill, { draft } for an AI draft, { pending } for a
   * question with no answer on file, { cv } for the CV upload, { skip } for anything left alone.
   * `f` = { label, name, id, controlName, dataTest, type, autocomplete, placeholder, required, hasCountry }.
   */
  function answerFor(f, data) {
    const c = data.contact ?? {};
    const p = data.profile ?? {};
    const all = [f.label, f.name, f.id, f.autocomplete, f.placeholder].filter(Boolean).join(' ');
    if (SYNONYMS[0][1].test(norm(all)) || /captcha/i.test(`${f.name} ${f.id}`)) return { skip: 'never filled' };
    // Greenhouse: the prepared answer of this very question (by its field name = the input's id)
    const gh = (data.form ?? []).find((a) => a.name && (a.name === f.id || a.name === f.name || `${a.name}[]` === f.name));
    if (gh) return gh.status === 'resolved' && gh.value ? { value: gh.value, from: 'prepared answer' } : { pending: gh.source || 'answer pending' };
    const type = fieldType(f, data);
    if (f.type === 'file') return type === 'cv' ? { cv: true } : { skip: 'file' };
    // the very question you answered in your answers bank wins over a profile value
    const sameQuestion = (data.bank ?? []).find((b) => norm(b.question) === norm(f.label) && norm(f.label).length >= 4);
    if (sameQuestion && type !== 'never' && type !== 'cv') return { value: sameQuestion.answer, from: 'answers bank' };
    if (type === 'never') return { skip: 'never filled' };
    if (type === 'social') return { skip: 'no such profile on file' };
    if (type === 'coverLetter') {
      if (data.fillCoverLetters === false) return { skip: 'cover letters are off (Settings)' };
      if (data.draft && data.draft.text) return { draft: data.draft.text };
      return { pending: data.draft && data.draft.error ? `no draft: ${data.draft.error}` : 'cover letter: write it yourself' };
    }
    const simple = {
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: c.fullName,
      email: c.email,
      confirmEmail: c.email,
      phone: f.hasCountry ? localPhone(c.phone) : c.phone,
      city: c.city,
      linkedin: c.linkedin,
      github: c.github,
      website: c.website || c.github,
      currentTitle: p.currentTitle,
      currentCompany: p.currentCompany,
      yearsExperience: p.yearsExperience === null || p.yearsExperience === undefined ? null : String(p.yearsExperience),
    };
    if (type && type in simple) return simple[type] ? { value: simple[type], from: 'profile', type } : { pending: `no ${type} in your profile` };
    if (type === 'salary') {
      const s = data.salary;
      const v = f.type === 'number' ? (s?.number ?? null) : (s?.text ?? s?.number ?? null);
      if (v) return { value: v, from: 'salary settings' };
    }
    const b = bankAnswer(f.label, data.bank ?? []) ?? (type ? bankByType(type, data.bank ?? []) : null);
    if (b) return { value: b.answer, from: 'answers bank' };
    if (type === 'salary' || type === 'noticePeriod' || type === 'address') return { pending: `${type}: no answer on file` };
    return f.required ? { pending: 'no answer on file' } : { skip: 'not one of your details' };
  }

  // ---------- the page: open shadow roots included ----------
  const MARK = 'data-jobhunter-fill';
  const STYLE = { pending: '3px solid #f2c200', cv: '3px solid #2b7de9', filled: '2px solid #2e9e5b', draft: '3px solid #8e44ad' };

  /** the document and every open shadow root in it */
  function allRoots(doc) {
    const out = [doc];
    for (let i = 0; i < out.length; i++) for (const el of out[i].querySelectorAll('*')) if (el.shadowRoot) out.push(el.shadowRoot);
    return out;
  }
  const deepAll = (doc, sel) => allRoots(doc).flatMap((r) => [...r.querySelectorAll(sel)]);
  /** the shadow hosts around an element, innermost first */
  function hosts(el) {
    const out = [];
    for (let r = el.getRootNode(); r && r.host; r = r.host.getRootNode()) out.push(r.host);
    return out;
  }
  /** the element to outline: the outermost host in the page (or the field itself) */
  const outer = (el) => hosts(el).pop() ?? el;
  const visible = (el) => {
    const t = outer(el);
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length || t.offsetWidth || t.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  };
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  function labelFor(el) {
    const r = el.getRootNode();
    if (el.id && r.querySelector) {
      const l = r.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && textOf(l)) return textOf(l);
    }
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return textOf(wrap);
    const by = el.getAttribute('aria-labelledby');
    if (by && r.getElementById) {
      const t = by.split(/\s+/).map((id) => textOf(r.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    // web components: the label lives on the host (<spl-input label="First name">)
    for (const h of hosts(el)) {
      const l = h.getAttribute('label') || h.getAttribute('aria-label');
      if (l) return l;
    }
    const fs = el.closest('fieldset');
    if (fs && fs.querySelector('legend')) return textOf(fs.querySelector('legend'));
    const group = el.closest('[class*="field"], [class*="question"], [class*="form-group"], li, .row, div');
    if (group) {
      const lab = group.querySelector('label, legend, [class*="label"], h3, h4, span');
      if (lab && lab !== el && textOf(lab)) return textOf(lab);
    }
    return el.getAttribute('placeholder') || '';
  }

  /** the framework's form-control name around a field (Angular formcontrolname, data-test) */
  function controlName(el) {
    for (const h of [el, ...hosts(el)]) {
      const fc = h.closest && h.closest('[formcontrolname], [data-test]');
      if (fc && fc !== el) return { controlName: fc.getAttribute('formcontrolname') || '', dataTest: fc.getAttribute('data-test') || '' };
    }
    return { controlName: '', dataTest: '' };
  }

  function info(el) {
    const label = labelFor(el);
    const hs = hosts(el);
    const ctl = controlName(el);
    const host = outer(el);
    const required = el.required || el.getAttribute('aria-required') === 'true' || hs.some((h) => h.hasAttribute('required') || h.getAttribute('aria-required') === 'true') || /\*\s*$/.test(label);
    // a phone field with its own country-code selector (the +972 is already there)
    const hasCountry = el.type === 'tel' && (hs.some((h) => /phone/i.test(h.tagName)) || /\+\s?972|country code|קידומת/i.test(textOf(host.parentElement || host).slice(0, 4000)));
    const autocomplete = el.getAttribute('autocomplete') || hs.map((h) => h.getAttribute('autocomplete')).find(Boolean) || '';
    return { label, name: el.name || '', id: el.id || '', type: el.type || el.tagName.toLowerCase(), autocomplete, placeholder: el.placeholder || '', required, hasCountry, ...ctl };
  }

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  /** React / Angular / Lit friendly: the native setter, the events typing fires (crossing shadow roots), the host's value. */
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
    fire(el, 'change');
    // a web component that keeps its own value property in step with the inner field
    const h = hosts(el)[0];
    if (h && 'value' in h && typeof h.value !== 'object' && h.value !== value) {
      try {
        h.value = value;
        fire(h, 'input');
        fire(h, 'change');
      } catch {
        /* read-only on this component */
      }
    }
    fire(el, 'blur');
    el.blur();
  }

  /** Only ever called on a radio / checkbox input (never a button, link or submit). */
  function tick(input) {
    if (!(input instanceof HTMLInputElement) || (input.type !== 'radio' && input.type !== 'checkbox')) throw new Error('JobHunter Fill: refusing to click a non-choice element');
    if (!input.checked) input.click();
  }

  /** a field that needs you: outlined yellow, counted once, and listed */
  function needYou(out, el, label, why) {
    const target = outer(el);
    if (target.getAttribute && target.getAttribute(MARK) === 'pending') return;
    mark(el, 'pending', why);
    out.needYou++;
    out.pending.push(`${label || el.getAttribute('aria-label') || el.id || el.tagName.toLowerCase()}: ${why}`);
  }

  function mark(el, kind, title) {
    const base = outer(el);
    const target = el.type === 'radio' || el.type === 'checkbox' ? base.closest('fieldset, [role="radiogroup"], [class*="question"], div') || base : base;
    target.setAttribute(MARK, kind);
    target.style.outline = STYLE[kind];
    target.style.outlineOffset = '2px';
    if (title) target.title = `JobHunter: ${title}`;
  }

  function clearMarks(doc) {
    for (const el of deepAll(doc, `[${MARK}]`)) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.removeAttribute(MARK);
    }
    doc.getElementById('jobhunter-fill-overlay')?.remove();
  }

  /** a list's own search box, or a country / country-code picker: never one of your fields */
  const isPickerSearch = (el) =>
    /search/i.test(el.className || '') ||
    /^(search|חיפוש)|country|region|dial code|calling code|מדינה|קידומת/i.test(`${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`);
  const empty = (el) => (el.tagName === 'SELECT' ? !el.value || el.selectedIndex <= 0 : !String(el.value ?? '').trim());
  const inCaptcha = (el) => !!el.closest('[class*="captcha"], [id*="captcha"], .g-recaptcha, .h-captcha, iframe');
  const isAutocomplete = (el) => el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('role') === 'combobox' || /select__input/.test(el.className) || hosts(el).some((h) => /autocomplete|combobox/i.test(h.tagName));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** A list with suggestions: type, then pick the suggestion that matches (exactly, for a city); else clear and leave it to you. */
  async function fillFromList(doc, input, value, matches) {
    setValue(input, value);
    input.focus();
    let option = null;
    for (let i = 0; i < 12 && !option; i++) {
      await wait(250);
      option = deepAll(doc, '[role="option"]').find((o) => visible(o) && matches(textOf(o)));
    }
    if (!option) {
      setValue(input, '');
      return false;
    }
    option.click(); // a suggestion in the field's own list (not a button)
    await wait(200);
    return true;
  }

  // ---------- Experience / Education entries ----------
  const FORBIDDEN = /submit|next|apply|save|send|continue|done|finish|confirm|review|שלח|הבא|הגש|שמור|המשך|סיום|אישור/i;
  const SECTION = { experience: /experience|work history|employment|ניסיון תעסוקתי|ניסיון מקצועי|ניסיון עבודה|ניסיון/i, education: /education|השכלה|לימודים/i };
  const ADD = /^\+?\s*(add|הוסף|הוספת)\b/i;

  /** "Add" for that section only: its own label / test id, or a plain "+ Add" under that section's heading. Never anything else. */
  function addButton(doc, section) {
    const other = section === 'experience' ? 'education' : 'experience';
    for (const b of deepAll(doc, 'button, [role="button"], spl-button, oc-button')) {
      const own = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-test') || ''} ${textOf(b)}`.trim();
      if (!own || FORBIDDEN.test(own)) continue;
      const named = new RegExp(`add[ -]?(an? |new )?${section}|${section}[ -]?(entry[ -]?)?add`, 'i').test(own) || (section === 'experience' ? /הוסף ניסיון/ : /הוסף השכלה/).test(own);
      let underHeading = false;
      if (!named && ADD.test(textOf(b) || b.getAttribute('aria-label') || '') && !SECTION[other].test(own)) {
        let n = outer(b);
        for (let i = 0; i < 5 && n && !underHeading; i++, n = n.parentElement) {
          const head = textOf(n).slice(0, 60);
          underHeading = SECTION[section].test(head) && !SECTION[other].test(head);
        }
      }
      if (named || underHeading) return (b.shadowRoot && b.shadowRoot.querySelector('button')) || b;
    }
    return null;
  }

  const ENTRY = {
    experience: [
      ['company', /company|employer|organi[sz]ation|חברה|מעסיק|ארגון|מקום עבודה/],
      ['title', /title|position|role|תפקיד/],
      ['current', /current|present|i work here|עובד כאן|עובדת כאן|עדיין|כיום/],
      ['start', /^(from|start)|start date|from date|מתאריך|התחלה|^מ$/],
      ['end', /^(to|end)\b|end date|to date|עד תאריך|סיום|^עד$/],
      ['description', /description|responsibilit|achievement|summary|תיאור|תחומי אחריות/],
    ],
    education: [
      ['institution', /school|institution|university|college|מוסד|אוניברסיטה|מכללה|בית ספר/],
      ['degree', /degree|diploma|תואר|תעודה/],
      ['field', /field|major|discipline|study|תחום|חוג|מגמה/],
      ['start', /^(from|start)|start date|מתאריך|התחלה/],
      ['end', /^(to|end)\b|end date|graduat|עד תאריך|סיום/],
    ],
  };
  const entryKey = (section, label) => (ENTRY[section].find(([, re]) => re.test(norm(label))) || [null])[0];

  /** "2021-03" / "2021" → the field's own format (month / date input, or the placeholder's MM/YYYY, MM/YY, YYYY). */
  function dateFor(el, d) {
    if (!d) return null;
    const [y, m = '01'] = String(d).split('-');
    if (el.type === 'month') return `${y}-${m}`;
    if (el.type === 'date') return `${y}-${m}-01`;
    const ph = `${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    if (/dd\/mm\/yyyy|dd\.mm\.yyyy/.test(ph)) return `01/${m}/${y}`;
    if (/mm\/yy\b/.test(ph) && !/yyyy/.test(ph)) return `${m}/${y.slice(2)}`;
    if (/yyyy/.test(ph) && !/mm/.test(ph)) return y;
    return `${m}/${y}`;
  }

  /** A profile entry already on the page (its company / institution shows somewhere)? */
  const onPage = (doc, name) => !!name && allRoots(doc).some((r) => norm(textOf(r.body || r)).includes(norm(name)) || [...r.querySelectorAll('input, textarea')].some((i) => norm(i.value) === norm(name)));

  /** One new entry per section per click: Add, then fill the fields that appeared. You click its Save. */
  async function fillEntries(doc, data, out) {
    for (const section of ['experience', 'education']) {
      const list = section === 'experience' ? data.experience ?? [] : data.education ?? [];
      const nameOf = (e) => (section === 'experience' ? e.company : e.institution);
      const next = list.find((e) => !onPage(doc, nameOf(e)));
      if (!next) continue;
      const btn = addButton(doc, section);
      if (!btn) continue;
      const before = new Set(deepAll(doc, 'input, textarea, select'));
      btn.click(); // "Add" inside the Experience / Education section only
      let fresh = [];
      for (let i = 0; i < 12 && !fresh.length; i++) {
        await wait(250);
        fresh = deepAll(doc, 'input, textarea, select').filter((el) => !before.has(el) && visible(el) && el.type !== 'hidden' && el.type !== 'file');
      }
      if (!fresh.length) {
        out.notes.push(`${section}: "Add" opened nothing JobHunter can fill — add it yourself`);
        continue;
      }
      let filled = 0;
      for (const el of fresh) {
        const key = entryKey(section, labelFor(el) || el.name || el.placeholder);
        if (!key) continue;
        if (key === 'current') {
          if (el.type === 'checkbox' && next.current) tick(el);
          continue;
        }
        const v = key === 'start' || key === 'end' ? (key === 'end' && next.current ? null : dateFor(el, next[key])) : next[key];
        if (!v || !empty(el)) continue;
        if (el.tagName === 'SELECT') {
          const i = chooseOption([...el.options].map((o) => o.text), v);
          if (i < 0) continue;
          setValue(el, el.options[i].value);
        } else setValue(el, String(v));
        mark(el, 'filled');
        filled++;
      }
      out.filled += filled;
      const left = list.filter((e) => e !== next && !onPage(doc, nameOf(e))).length;
      out.notes.push(`${section}: added "${nameOf(next)}" (${filled} fields) — check it and click its Save${left > 0 ? `, then JobHunter Fill again for the next (${left} left)` : ''}`);
    }
  }

  // ---------- the run ----------
  function groupLabel(doc, el) {
    const fs = el.closest('fieldset');
    if (fs && fs.querySelector('legend')) return textOf(fs.querySelector('legend'));
    const rg = el.closest('[role="radiogroup"], [role="group"]');
    if (rg) {
      const by = rg.getAttribute('aria-labelledby');
      const r = el.getRootNode();
      if (by && r.getElementById) return by.split(/\s+/).map((id) => textOf(r.getElementById(id))).join(' ').trim();
      if (rg.getAttribute('aria-label')) return rg.getAttribute('aria-label');
    }
    const q = el.closest('[class*="question"], [class*="field"], .form-group, li');
    const lab = q && q.querySelector('label:not(:has(input)), legend, [class*="label"], p, span');
    return lab ? textOf(lab) : '';
  }

  /** The labels the dictionary does not know (for the backend's classification), whether there is a cover-letter field, and the page. */
  function scan(doc, data = {}) {
    const unknown = [];
    let coverLetter = false;
    for (const el of deepAll(doc, 'input, textarea, select')) {
      if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search', 'file', 'radio', 'checkbox'].includes(el.type) || el.disabled || inCaptcha(el) || isPickerSearch(el) || !visible(el)) continue;
      const f = info(el);
      const t = fieldType(f, data);
      if (t === 'coverLetter' && empty(el)) coverLetter = true;
      if (!t && f.label && !bankAnswer(f.label, data.bank ?? [])) unknown.push(f.label);
    }
    const h1 = doc.querySelector('h1');
    // the page's own job title and company (for a page JobHunter does not know): the heading, og:site_name / the tab title's last part
    const parts = String(doc.title || '').split(/\s+[-|–]\s+/).map((x) => x.trim()).filter(Boolean);
    const company = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || (parts.length > 1 ? parts[parts.length - 1] : '');
    return { unknown: [...new Set(unknown)].slice(0, 40), coverLetter, title: textOf(h1) || parts.slice(0, -1).join(' - ') || doc.title, company, lang: /[א-ת]/.test(textOf(doc.body).slice(0, 3000)) ? 'he' : 'en' };
  }

  /** Fills the page. Returns the summary; shows the overlay unless opts.overlay === false. */
  async function run(doc, data, opts = {}) {
    // defense in depth: the popup and the background worker never get here on LinkedIn / Indeed
    if (manualOnlyHost((opts.location ?? doc.location).href)) return { refused: MANUAL_ONLY_MESSAGE, filled: 0, drafts: 0, needYou: 0, pending: [], cv: null, cvFields: 0, skipped: 0, details: [], notes: [], flaggedClaims: [] };
    clearMarks(doc);
    const out = { filled: 0, drafts: 0, needYou: 0, pending: [], cv: data.cv?.file ?? null, cvFields: 0, skipped: 0, details: [], notes: [], flaggedClaims: (data.draft && data.draft.flaggedClaims) || [] };
    const done = new Set();
    const fields = deepAll(doc, 'input, textarea, select').filter(
      (el) => !['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search'].includes(el.type) && !el.disabled && !el.readOnly && !inCaptcha(el) && !isPickerSearch(el) && (visible(el) || el.type === 'file'),
    );
    for (const el of fields) {
      if (done.has(el)) continue;
      const f = info(el);

      // radio group / checkbox group: one question, many inputs
      if (el.type === 'radio' || (el.type === 'checkbox' && el.name && el.getRootNode().querySelectorAll(`input[type=checkbox][name="${CSS.escape(el.name)}"]`).length > 1)) {
        const group = [...el.getRootNode().querySelectorAll(`input[type=${el.type}][name="${CSS.escape(el.name)}"]`)];
        group.forEach((g) => done.add(g));
        const gl = groupLabel(doc, el) || f.label;
        const a = answerFor({ ...f, label: gl, type: el.type }, data);
        if (group.some((g) => g.checked)) continue; // already answered (by you or the site)
        if (a.value !== undefined) {
          const answers = el.type === 'checkbox' ? String(a.value).split(/\s*[,;]\s*/) : [a.value];
          const optionLabels = group.map((g) => labelFor(g) || g.value);
          const picks = answers.map((v) => chooseOption(optionLabels, v)).filter((i) => i >= 0);
          if (picks.length) {
            picks.forEach((i) => tick(group[i]));
            out.filled++;
            out.details.push({ label: gl, value: answers.join(', '), from: a.from });
            continue;
          }
        }
        if (a.pending || a.value !== undefined || f.required) {
          needYou(out, el, f.label, a.pending ?? 'no matching option for your answer');
        }
        continue;
      }
      done.add(el);

      const a = answerFor(f, data);
      if (a.cv) {
        mark(outer(el).closest('[class*="upload"], [class*="file"], [class*="dropzone"], div') || el, 'cv', `choose ${data.cv?.file ?? 'your CV'}`);
        out.cvFields++;
        continue;
      }
      if (a.skip) {
        // a required consent / declaration: never ticked for you, but shown so you decide
        if (a.skip === 'never filled' && f.required && (el.type === 'checkbox' ? !el.checked : empty(el))) {
          needYou(out, el, f.label, 'yours to decide (never ticked for you)');
        } else out.skipped++;
        continue;
      }
      if (a.pending) {
        if (empty(el)) {
          needYou(out, el, f.label, a.pending);
        }
        continue;
      }
      if (!empty(el)) continue; // never overwrite what is there
      if (a.draft) {
        setValue(el, a.draft);
        mark(el, 'draft', 'AI draft — review before submitting');
        out.drafts++;
        continue;
      }
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
          out.details.push({ label: f.label, value: opts2[i].text, from: a.from });
        } else {
          needYou(out, el, f.label, `no option matches "${a.value}"`);
        }
        continue;
      }
      if (isAutocomplete(el)) {
        // a city: only the exact suggestion; any other list: the option matching the answer
        const ok = await fillFromList(doc, el, String(a.value), a.type === 'city' ? (t) => exactPlace(t, a.value) : (t) => chooseOption([t], a.value) === 0);
        if (ok) {
          mark(el, 'filled');
          out.filled++;
          out.details.push({ label: f.label, value: a.value, from: a.from });
        } else {
          needYou(out, el, f.label, a.type === 'city' ? `no suggestion is exactly "${a.value}" — pick your city` : `choose "${a.value}" in the list`);
        }
        continue;
      }
      if (el.type === 'number' && !/^\d+(\.\d+)?$/.test(String(a.value).replace(/[,\s₪]/g, ''))) {
        needYou(out, el, f.label, `"${a.value}" is not a number`);
        continue;
      }
      setValue(el, el.type === 'number' ? String(a.value).replace(/[,\s₪]/g, '') : String(a.value));
      mark(el, 'filled');
      out.filled++;
      out.details.push({ label: f.label, value: a.value, from: a.from });
    }
    await fillEntries(doc, data, out);
    // required fields still empty (custom widgets too), in shadow roots as well
    for (const el of deepAll(doc, '[aria-required="true"], [required]')) {
      const host = outer(el);
      if (host.hasAttribute(MARK) || host.closest(`[${MARK}]`) || el.hasAttribute(MARK) || !visible(el) || inCaptcha(el) || el.type === 'file' || el.type === 'hidden') continue;
      if (el.shadowRoot && el.shadowRoot.querySelector('input, textarea, select')) continue; // its inner field was handled
      if (('value' in el && typeof el.value === 'string' && el.value.trim()) || el.type === 'radio' || el.type === 'checkbox') continue;
      needYou(out, el, el.getAttribute('label') || labelFor(el), 'required — fill it yourself');
    }
    if (opts.overlay !== false) overlay(doc, data, out, opts);
    return out;
  }

  function overlay(doc, data, out, opts) {
    const host = doc.createElement('div');
    host.id = 'jobhunter-fill-overlay';
    host.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;';
    const shadow = host.attachShadow({ mode: 'open' });
    const job = data.job;
    const claims = (out.flaggedClaims ?? []).map((c) => `<li>${escapeHtml(c)}</li>`).join('');
    shadow.innerHTML = `
      <style>
        .b{font:13px system-ui,sans-serif;background:#fff;color:#222;border:1px solid #ccc;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);padding:10px 12px;max-width:360px}
        .t{font-weight:600;margin-bottom:4px} .m{color:#666;font-size:12px} .r{display:flex;gap:8px;margin-top:8px}
        button{font:inherit;padding:4px 10px;border-radius:5px;border:1px solid #888;background:#f6f6f6;cursor:pointer} button.p{background:#2e9e5b;color:#fff;border-color:#2e9e5b}
        .g{background:#2e9e5b;color:#fff;padding:0 4px;border-radius:3px} .d{background:#8e44ad;color:#fff;padding:0 4px;border-radius:3px}
        .y{background:#f2c200;padding:0 4px;border-radius:3px} .c{background:#2b7de9;color:#fff;padding:0 4px;border-radius:3px} ul{margin:4px 0 0 16px;padding:0}
      </style>
      <div class="b">
        <div class="t">JobHunter Fill</div>
        <div id="sum"><span class="g">filled ${out.filled}</span>${out.drafts ? `, <span class="d">AI drafts ${out.drafts}</span>` : ''}, <span class="y">need you ${out.needYou}</span>${out.cv ? `, <span class="c">CV: ${escapeHtml(out.cv)}</span>` : ''}</div>
        <div class="m">${job ? `${escapeHtml(job.title)} — ${escapeHtml(job.company)} (${escapeHtml(job.siteLabel)})` : 'not linked to a JobHunter job: your details only'}</div>
        ${out.drafts ? `<div class="m">The purple text is an AI draft from your profile: read and edit it before submitting.${claims ? ` Check these claims: <ul>${claims}</ul>` : ''}</div>` : ''}
        ${out.notes.map((n) => `<div class="m">${escapeHtml(n)}</div>`).join('')}
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

  root.JobHunterFill = { norm, classify, fieldType, bankAnswer, chooseOption, exactPlace, localPhone, answerFor, dateFor, entryKey, run, scan, clearMarks, manualOnlyHost, MANUAL_ONLY_MESSAGE, FORBIDDEN };
})(typeof globalThis !== 'undefined' ? globalThis : this);
