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
    'country-name': 'country',
    country: 'country',
    'organization-title': 'currentTitle',
  };
  /** then the synonym dictionary (Hebrew + English; order matters: specific before general) */
  const SYNONYMS = [
    ['never', /captcha|recaptcha|hcaptcha|turnstile|password|סיסמה|credit card|cvv|i agree|i consent|i confirm|i acknowledge|i certify|privacy|terms|consent|אני מאשר|אני מסכים|מסכים לתנאי|מדיניות הפרטיות|תנאי השימוש|הצהרה|gdpr/],
    ['social', /facebook|twitter|\bx fka\b|instagram|tiktok|פייסבוק|טוויטר/],
    ['cv', /\b(resume|cv|curriculum)\b|קורות חיים|קו ח/],
    ['bio', /^(bio|biography|about|about me|about you|about yourself|summary|professional summary)$|\bbio(graphy)?\b|tell us (a bit |a little |more )?about (yourself|you)\b|introduce yourself|about yourself|ספר (י )?על עצמך|ספרו (לנו )?על עצמכם|ספר(י)? לנו על עצמך|קצת על עצמי|על עצמך/],
    ['coverLetter', /cover letter|motivation letter|message to (the )?hiring|hiring (team|manager) message|let the company know|note on why|why (do you want|you want|us|are you interested|this (role|company|position))|מכתב מקדים|מכתב פנייה|מכתב לצוות|למה (את|אתה|את ה|אתם)|מדוע (את|אתה)/],
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
    ['country', /^(country|country of residence|current country|country region|country or region|nationality country)$|^(מדינה|ארץ|ארץ מגורים|מדינת מגורים)$/],
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

  /**
   * A free-text field (textarea / editor) that is plainly a bio or a cover note, by its label or placeholder — decided
   * here, never left to the planner: bio / about you / about yourself / tell us about / summary / קצת עליי / ספר/י על
   * עצמך → a bio; message / cover / note / why / motivation / מכתב / הודעה → a cover note.
   */
  const BIO_RULE = /\bbio(graphy)?\b|\babout (you|yourself|me)\b|tell us about|\bsummary\b|קצת על|ספר.{0,3}על עצמ|על עצמך|על עצמי/;
  const COVER_RULE = /\bmessage\b|\bcover\b|\bnote\b|\bwhy\b|motivation|מכתב|הודעה|מוטיבציה|למה|מדוע/;
  function freeTextRule(f) {
    if (f.entry && (f.type === 'textarea' || entryKey('experience', f.label || f.placeholder) || entryKey('education', f.label || f.placeholder))) return 'entryText'; // an entry's own field: filled with the entry, never a draft
    if (f.type !== 'textarea') return null;
    for (const text of [f.label, f.placeholder]) {
      const t = norm(text);
      if (!t) continue;
      if (BIO_RULE.test(t)) return 'bio';
      if (COVER_RULE.test(t)) return 'coverLetter';
    }
    return null;
  }

  /** The dictionary's type: autocomplete → label → form-control name / name / id → placeholder; free-text rules. */
  function dictType(f) {
    const ac = String(f.autocomplete || '').toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) {
      // "email" twice on a page: the one whose label / id says confirm is the confirmation
      if (AUTOCOMPLETE[ac] === 'email' && classify(`${f.label} ${words(f.id)} ${words(f.name)}`) === 'confirmEmail') return 'confirmEmail';
      return AUTOCOMPLETE[ac];
    }
    const entry = freeTextRule(f);
    if (entry === 'entryText') return entry; // before the dictionary: an entry's "Start date" is not your notice period
    const byText = classify(f.label);
    if (byText) return byText;
    return entry || classify(`${words(f.controlName)} ${words(f.name)} ${words(f.id)} ${words(f.dataTest)}`) || classify(f.placeholder) || null;
  }

  /** the form planner's kinds → field types ("draft:cover" is a cover letter / message, "draft:bio" a bio) */
  const PLANNED = { 'draft:cover': 'coverLetter', 'draft:bio': 'bio' };
  const DRAFT_TYPES = ['coverLetter', 'bio'];
  /**
   * A field's type: the rules (dictionary + free-text rules) decide what they recognize; the form plan (data.plan, by
   * the field's key) only what they don't; then the cached label classification. Last: on a page with a job ad, a
   * REQUIRED free-text field nobody recognized is a cover note (it must not stay empty).
   */
  function fieldType(f, data) {
    const d = dictType(f);
    if (d) return d;
    const raw = data && data.plan && f.key ? data.plan[f.key] : undefined;
    const planned = raw ? PLANNED[raw] || raw : undefined;
    if (planned && planned !== 'unknown' && (!DRAFT_TYPES.includes(planned) || f.type === 'textarea' || f.type === 'text')) return planned;
    const learned = data && data.labelTypes ? data.labelTypes[norm(f.label)] : undefined;
    if (learned && learned !== 'unknown') return learned;
    if (data && data.hasJobContext && f.required && f.type === 'textarea') return 'coverLetter';
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
  /** A select's bucket for a number of years: "1-3", "2–4 years", "3+", "5 or more", "less than 1", "פחות משנה"… */
  function bucketOption(options, n) {
    if (!Number.isFinite(n)) return -1;
    return options.findIndex((o) => {
      // the raw text: norm() would drop the dash of "1-3"
      const t = String(o).toLowerCase().replace(/[–—]/g, '-');
      let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|עד)\s*(\d+(?:\.\d+)?)/);
      if (m) return n >= Number(m[1]) && n <= Number(m[2]);
      m = t.match(/(\d+(?:\.\d+)?)\s*(?:\+|plus|or more|and (?:more|above)|ומעלה|ויותר)/);
      if (m) return n >= Number(m[1]);
      m = t.match(/(?:less than|under|fewer than|פחות מ)\s*(\d+(?:\.\d+)?)/);
      if (m) return n < Number(m[1]);
      return false;
    });
  }

  /** A suggestion that IS the city: the same text, or the same before its first comma ("Tel Aviv, Israel"). */
  const exactPlace = (option, value) => norm(String(option).split(',')[0]) === norm(value) || norm(option) === norm(value);

  // words that do not identify an institution or a company
  const GENERIC = new Set(['college', 'university', 'academic', 'academy', 'institute', 'institution', 'school', 'center', 'centre', 'of', 'the', 'and', 'for', 'ltd', 'inc', 'llc', 'group', 'מכללת', 'מכללה', 'המכללה', 'אוניברסיטת', 'אוניברסיטה', 'האוניברסיטה', 'מרכז', 'המרכז', 'בית', 'ספר', 'בעמ']);
  const coreWords = (s) => norm(s).split(' ').filter((w) => w && !GENERIC.has(w));
  /**
   * A suggestion that is exactly or closely the value: the same name, or the same name without "College",
   * "University", "Ltd"… on either side ("ORT" or "ORT Hermelin Academic College" for "ORT Hermelin College",
   * "John Bryce" for "John Bryce College"). "ORT Braude College" is not "ORT Hermelin College".
   */
  const closeMatch = (option, value) => {
    if (norm(option) === norm(value) || exactPlace(option, value)) return true;
    const a = coreWords(String(option).split(',')[0]);
    const b = coreWords(value);
    if (!a.length || !b.length) return false;
    const within = (x, y) => x.every((w) => y.includes(w));
    return within(a, b) || within(b, a);
  };

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
    if (type === 'entryText') return { skip: 'part of an experience / education entry (filled with the entry)' };
    if (type === 'coverLetter' || type === 'bio') {
      if (data.fillCoverLetters === false) return { pending: `no ${type === 'bio' ? 'bio' : 'cover letter'} draft: cover letters are OFF (JobHunter → Settings → JobHunter Fill → "Fill cover letters in the extension")` };
      // this field's own draft (written for this job), else the page's one cover-letter draft
      const d = (data.drafts && f.key && data.drafts[f.key]) || (type === 'coverLetter' ? data.draft : null);
      if (d && d.text) return { draft: d.text, flaggedClaims: d.flaggedClaims || [] };
      if (d && d.error) return { pending: `no draft: ${d.error}` };
      const why = data.draftNotes && f.key ? data.draftNotes[f.key] : null;
      return { pending: `no ${type === 'bio' ? 'bio' : 'cover letter'} draft: ${why || 'none was requested for this field'}` };
    }
    const simple = {
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: c.fullName,
      email: c.email,
      confirmEmail: c.email,
      phone: f.hasCountry ? localPhone(c.phone) : c.phone,
      city: c.city,
      country: c.country,
      linkedin: c.linkedin,
      github: c.github,
      website: c.website || c.github,
      currentTitle: p.currentTitle,
      currentCompany: p.currentCompany,
      yearsExperience: p.yearsExperience === null || p.yearsExperience === undefined ? null : String(p.yearsExperience),
    };
    const alts = type === 'city' ? c.cityAlts || [] : type === 'country' ? c.countryAlts || [] : [];
    if (type && type in simple) return simple[type] ? { value: simple[type], from: 'profile', type, alts } : { pending: `no ${type} in your profile` };
    if (type === 'salary') {
      const s = data.salary;
      const v = f.type === 'number' ? (s?.number ?? null) : (s?.text ?? s?.number ?? null);
      if (v) return { value: v, from: 'salary settings' };
    }
    const b = bankAnswer(f.label, data.bank ?? []) ?? (type ? bankByType(type, data.bank ?? []) : null);
    if (b) return { value: b.answer, from: 'answers bank' };
    if (type === 'salary' || type === 'noticePeriod' || type === 'address') return { pending: `${type}: no answer on file` };
    // a free-text field that got no draft: why (what the rules / the planner said), never just "no answer"
    const why = f.type === 'textarea' && data.draftNotes && f.key ? data.draftNotes[f.key] : null;
    if (why && f.required) return { pending: `no draft: ${why}` };
    return f.required ? { pending: 'no answer on file' } : { skip: 'not one of your details' };
  }

  // ---------- the page: open shadow roots included ----------
  const MARK = 'data-jobhunter-fill';
  const STYLE = { pending: '3px solid #f2c200', cv: '3px solid #2b7de9', filled: '2px solid #2e9e5b', draft: '3px solid #8e44ad' };

  /** the document, every open shadow root in it, and the documents of same-origin frames (a form inside an iframe) */
  function allRoots(doc) {
    const out = [doc];
    for (let i = 0; i < out.length; i++)
      for (const el of out[i].querySelectorAll('*')) {
        if (el.shadowRoot) out.push(el.shadowRoot);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let d = null;
          try {
            d = el.contentDocument; // null / throws for another site's frame
          } catch {
            d = null;
          }
          if (d && d.documentElement && !out.includes(d)) out.push(d);
        }
      }
    return out;
  }
  /** visible frames from another site that look like a form (not CAPTCHA, video, maps or trackers): you open those yourself */
  function foreignFrames(doc) {
    return deepAll(doc, 'iframe')
      .filter((f) => {
        let same = false;
        try {
          same = !!f.contentDocument;
        } catch {
          same = false;
        }
        const src = f.src || '';
        // the frame's own host (an apply frame's address may carry "referrer=linkedin.com" and is still a form)
        const host = /^https?:/.test(src) ? hostOf(src) : '';
        const path = /^https?:/.test(src) ? src.replace(/[?#].*$/, '') : '';
        return !same && !!host && visible(f) && f.offsetWidth >= 300 && f.offsetHeight >= 200 && !/recaptcha|hcaptcha|turnstile|cloudflare|youtube|vimeo|doubleclick|googletagmanager|facebook|twitter|instagram|linkedin/i.test(host) && !/google\.com\/maps/.test(path);
      })
      .map((f) => f.src);
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
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length || t.offsetWidth || t.getClientRects().length) && win(el).getComputedStyle(el).visibility !== 'hidden';
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
    if (fs && fs.querySelector('legend') && fs.querySelectorAll('input:not([type=hidden]), textarea, select').length === 1) return textOf(fs.querySelector('legend'));
    // nearby text: the closest container that holds only this field, and text in it before the field
    let group = el.parentElement;
    for (let i = 0; i < 4 && group && group.tagName !== 'FORM' && group.tagName !== 'BODY'; i++, group = group.parentElement) {
      if (group.querySelectorAll('input:not([type=hidden]), textarea, select').length > 1) break;
      const lab = [...group.querySelectorAll('label, legend, [class*="label"], h3, h4, h5, span, p, div')].find(
        (x) => x !== el && !x.contains(el) && !x.querySelector('input, textarea, select') && textOf(x) && textOf(x).length <= 200 && x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      if (lab) return textOf(lab);
    }
    return el.getAttribute('placeholder') || words(el.name || el.id || '');
  }

  /** a rich-text editor (contenteditable, or a textbox role that is editable): filled like a textarea */
  const isEditor = (el) => !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && (el.isContentEditable || (el.getAttribute('role') === 'textbox' && el.getAttribute('contenteditable') !== 'false' && !!el.isContentEditable));
  const FIELD_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"][contenteditable]';

  /** the text just before the field and the form's heading ("Please send us a note on why you want to be part of our team") */
  function nearText(el) {
    const out = [];
    const host = outer(el);
    const form = host.closest('form');
    const section = host.closest('section, fieldset, [data-ui="section"]');
    for (const scope of [section && section.querySelector('h1, h2, h3, h4, legend'), form && form.previousElementSibling, form && form.querySelector('h1, h2, h3, h4, legend, p'), host.previousElementSibling]) {
      if (scope && !scope.contains(host) && !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(scope.tagName)) out.push(textOf(scope).slice(0, 200));
    }
    return [...new Set(out.filter(Boolean))].join(' | ').slice(0, 350);
  }

  /** what an entry field is for: a work entry (company / title) or an education entry (school / degree / field) */
  const nameKindOf = (x) => {
    const t = labelFor(x) || words(x.name || x.id || '');
    const w = entryKey('experience', t);
    if (w === 'company' || w === 'title') return 'work';
    const e = entryKey('education', t);
    return e === 'institution' || e === 'degree' || e === 'field' ? 'edu' : null;
  };
  /**
   * Inside one experience OR education entry: the closest container (not the whole form) that holds a company / title
   * field or a school / degree field, but not both kinds — a section with both is the list of entries, not an entry.
   */
  function inEntry(el) {
    let n = el.parentElement;
    for (let i = 0; i < 7 && n && n.tagName !== 'FORM' && n.tagName !== 'BODY'; i++, n = n.parentElement) {
      const fields = [...n.querySelectorAll('input:not([type=hidden]), textarea, select')];
      if (fields.length > 12) return false;
      const kinds = new Set(fields.filter((x) => x !== el).map(nameKindOf).filter(Boolean));
      if (kinds.size > 1) return false;
      if (kinds.size === 1 && fields.length >= 3) return true;
    }
    return false;
  }

  /** The fields JobHunter may fill, each with a key that is the same in the scan and in the fill. */
  function formFields(doc) {
    const seen = new Map();
    return deepAll(doc, FIELD_SELECTOR)
      .filter((el) => (isEditor(el) ? !inCaptcha(el) && visible(el) && !el.closest('[contenteditable]:not([contenteditable="false"]) [contenteditable]') : true))
      .filter((el) => isEditor(el) || (!['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search'].includes(el.type) && !el.disabled && !el.readOnly && !inCaptcha(el) && !isPickerSearch(el) && (visible(el) || el.type === 'file')))
      .map((el) => {
        const f = info(el);
        f.entry = inEntry(el);
        const base = `${el.tagName.toLowerCase()}:${f.type}:${f.name || f.id || norm(f.label || f.placeholder).slice(0, 60)}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return { el, f: { ...f, key: n ? `${base}#${n}` : base } };
      });
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
    if (isEditor(el)) {
      const label = el.getAttribute('aria-label') || labelFor(el) || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
      return { label, name: el.getAttribute('name') || '', id: el.id || '', type: 'textarea', autocomplete: '', placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '', required: el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label), hasCountry: false, controlName: '', dataTest: '' };
    }
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

  /** the element's own window (a form inside a same-origin frame has its own) */
  const win = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || globalThis;
  const fire = (el, type) => el.dispatchEvent(new (win(el).Event)(type, { bubbles: true, composed: true }));
  /** React / Angular / Lit friendly: the native setter, the events typing fires (crossing shadow roots), the host's value. */
  function setValue(el, value) {
    const w = win(el);
    if (el.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      // a rich-text editor: its text, then the events typing fires
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new w.InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
      fire(el, 'change');
      fire(el, 'blur');
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new w.InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
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

  /** A masked input (MM/YYYY, a phone mask): the value set; if the mask dropped it, typed as keystrokes would be. */
  function typeInto(el, value) {
    setValue(el, value);
    if (String(el.value ?? '') === value) return;
    const masked = el.tagName === 'INPUT' && (/^(tel|numeric|decimal)$/.test(el.getAttribute('inputmode') || '') || /[md]{2}|yyyy|\d{2}\/\d{2}/i.test(el.placeholder || '') || el.hasAttribute('data-mask'));
    if (!masked) return;
    const w = win(el);
    el.focus();
    try {
      el.select();
      // insertText goes through beforeinput / input like typing does (what masks listen to)
      if (!w.document.execCommand('insertText', false, value)) throw new Error('insertText refused');
    } catch {
      for (const ch of value) {
        el.dispatchEvent(new w.KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true }));
        el.dispatchEvent(new w.InputEvent('beforeinput', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }));
        el.dispatchEvent(new w.InputEvent('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }));
        el.dispatchEvent(new w.KeyboardEvent('keyup', { key: ch, bubbles: true, composed: true }));
      }
    }
    fire(el, 'change');
    fire(el, 'blur');
  }

  /** Only ever called on a radio / checkbox input (never a button, link or submit). */
  function tick(input) {
    if (!input || input.tagName !== 'INPUT' || (input.type !== 'radio' && input.type !== 'checkbox')) throw new Error('JobHunter Fill: refusing to click a non-choice element');
    if (input.checked) return;
    // a hidden input behind a button-styled option (Workable's YES / NO): its own label or option wrapper is what you would click
    const hidden = input.getAttribute('aria-hidden') === 'true' || !(input.offsetWidth || input.offsetHeight || input.getClientRects().length);
    const proxy = hidden ? input.closest('label') || input.closest('[role="radio"], [role="checkbox"]') : null;
    if (proxy && !FORBIDDEN.test(textOf(proxy)) && !proxy.closest('button, [type=submit]')) {
      proxy.click();
      if (input.checked) return;
    }
    input.click();
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
    // a choice: its whole group (fieldset / radiogroup), else the nearest wrapper
    const target = el.type === 'radio' || el.type === 'checkbox' ? base.closest('fieldset, [role="radiogroup"], [role="group"]') || base.closest('[class*="question"], div') || base : base;
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
    /^(search|חיפוש)\b|dial code|calling code|country code|קידומת/i.test(`${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`) ||
    // the country / region list of a phone widget (+972): not the form's own "Country"
    (/country|region|מדינה/i.test(`${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`) && (hosts(el).some((h) => /phone|tel/i.test(h.tagName)) || !!el.closest('[class*="phone"], [class*="tel-input"], [class*="intl-tel"]')));
  const empty = (el) => (el.tagName === 'SELECT' ? !el.value || el.selectedIndex <= 0 : el.isContentEditable && !/^(INPUT|TEXTAREA)$/.test(el.tagName) ? !(el.textContent || '').trim() : !String(el.value ?? '').trim());
  const inCaptcha = (el) => !!el.closest('[class*="captcha"], [id*="captcha"], .g-recaptcha, .h-captcha, iframe');
  const isAutocomplete = (el) => el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('role') === 'combobox' || /select__input/.test(el.className) || hosts(el).some((h) => /autocomplete|combobox/i.test(h.tagName));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * A list with suggestions: type, wait for them, pick the one that matches (the exact text first). No match: the typed
   * text stays and the caller marks the field yellow ("pick from the list").
   */
  async function fillFromList(doc, input, value, matches) {
    setValue(input, value);
    input.focus();
    let found = [];
    let shown = 0;
    for (let i = 0; i < 12 && !found.length; i++) {
      await wait(250);
      const opts = deepAll(doc, '[role="option"]').filter((o) => visible(o));
      found = opts.filter((o) => matches(textOf(o)));
      // suggestions are there but none is it: no need to wait the full time
      shown = opts.length ? shown + 1 : 0;
      if (!found.length && shown >= 3) break;
    }
    if (!found.length) return false;
    const option = found.find((o) => norm(textOf(o)) === norm(value)) || found[0];
    option.click(); // a suggestion in the field's own list (not a button)
    await wait(200);
    return true;
  }

  /**
   * What to type into a list of names, in turn: the name, the other language's name, the name without "College",
   * "University"… ("ORT Hermelin"), each distinctive word ("ORT", "Hermelin"), and "… Academic College".
   */
  function nameQueries(value, alt) {
    const v = String(value || '').trim();
    const core = v.split(/\s+/).filter((w) => w && !GENERIC.has(norm(w)));
    const out = [v, String(alt || '').trim(), core.join(' '), ...core.filter((w) => norm(w).length >= 3), /\bcollege$/i.test(v) && !/academic/i.test(v) ? v.replace(/\s*college$/i, ' Academic College') : ''];
    return [...new Set(out.filter(Boolean))];
  }
  /** A name from a list: each query in turn, a suggestion only when it is exactly or closely the name. None: the name typed, yellow. */
  async function pickName(doc, el, value, alt) {
    const match = (t) => closeMatch(t, value) || (!!alt && closeMatch(t, alt));
    for (const q of nameQueries(value, alt)) if (await fillFromList(doc, el, q, match)) return true;
    setValue(el, value);
    return false;
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
    // "location" first: "School location" / "Company location" is a place, never the institution or the company
    experience: [
      ['location', /location|city|עיר|מיקום|ישוב/],
      ['company', /company|employer|organi[sz]ation|חברה|מעסיק|ארגון|מקום עבודה/],
      ['title', /title|position|role|תפקיד/],
      ['current', /current|present|i work here|עובד כאן|עובדת כאן|עדיין|כיום/],
      ['start', /^(from|start)|start date|from date|מתאריך|התחלה|^מ$/],
      ['end', /^(to|end)\b|end date|to date|עד תאריך|סיום|^עד$/],
      ['description', /description|responsibilit|achievement|summary|תיאור|תחומי אחריות/],
    ],
    education: [
      ['location', /location|city|עיר|מיקום|ישוב/],
      ['institution', /school|institution|university|college|מוסד|אוניברסיטה|מכללה|בית ספר/],
      ['degree', /degree|diploma|תואר|תעודה/],
      ['field', /field|major|discipline|study|תחום|חוג|מגמה/],
      ['start', /^(from|start)|start date|מתאריך|התחלה/],
      ['end', /^(to|end)\b|end date|graduat|עד תאריך|סיום/],
    ],
  };
  const entryKey = (section, label) => (ENTRY[section].find(([, re]) => re.test(norm(label))) || [null])[0];

  /** does the field want a month (a month / date input, or a placeholder with MM or DD)? */
  function wantsMonth(el) {
    if (el.type === 'month' || el.type === 'date') return true;
    const ph = `${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    return /mm|dd/.test(ph);
  }
  /** "2021-03" / "2021" → the field's own format (month / date input, or the placeholder's MM/YYYY, MM/YY, YYYY); null when the field wants a month the date lacks. */
  function dateFor(el, d) {
    if (!d) return null;
    if (!/^\d{4}-\d{2}/.test(String(d)) && wantsMonth(el)) return null;
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

  /**
   * An entry form already open on the page (its own container with a name field and a date or description field), with
   * something still empty: its fields, and the profile entry it is for (by the name typed in it, else the next one).
   */
  function openEntry(doc, section, list) {
    const nameKey = section === 'experience' ? 'company' : 'institution';
    const nameOf = (e) => (section === 'experience' ? e.company : e.institution);
    for (const el of deepAll(doc, 'input, textarea, select')) {
      if (!visible(el) || el.type === 'hidden' || el.type === 'file') continue;
      if (entryKey(section, labelFor(el) || el.name || el.placeholder) !== nameKey) continue;
      let box = el.parentElement;
      for (let i = 0; i < 7 && box && box.tagName !== 'FORM' && box.tagName !== 'BODY'; i++, box = box.parentElement) {
        const fields = [...box.querySelectorAll('input:not([type=hidden]), textarea, select')].filter((x) => visible(x) && x.type !== 'file');
        if (fields.length > 14) break;
        const keys = fields.map((x) => entryKey(section, labelFor(x) || x.name || x.placeholder));
        if (keys.filter(Boolean).length >= 2 && keys.some((k) => k === 'start' || k === 'description' || k === 'degree' || k === 'title')) {
          const typed = String(el.value || '').trim();
          const entry = (typed && list.find((e) => norm(nameOf(e)) === norm(typed))) || list.find((e) => !onPage(doc, nameOf(e))) || (typed ? null : list[0]);
          if (!entry) return null;
          // only when something in it is still empty AND the profile entry has a value for it (a finished entry does not block "Add")
          const has = (k) => (k === 'location' ? !!entry.city : k === 'end' ? !!entry.end && !entry.current : k === 'current' ? false : !!entry[k]);
          const open = fields.some((x, i) => keys[i] && has(keys[i]) && empty(x) && (x.tagName !== 'SELECT' || x.selectedIndex <= 0));
          return open ? { fields, entry } : null;
        }
      }
    }
    return null;
  }

  /** One new entry per section per click: Add, then fill the fields that appeared (an entry already open: its empty fields). You click its Save. */
  async function fillEntries(doc, data, out) {
    for (const section of ['experience', 'education']) {
      const list = section === 'experience' ? data.experience ?? [] : data.education ?? [];
      const nameOf = (e) => (section === 'experience' ? e.company : e.institution);
      if (!list.length) continue;
      const open = openEntry(doc, section, list);
      let next = open ? open.entry : list.find((e) => !onPage(doc, nameOf(e)));
      if (!next) continue;
      let fresh = open ? open.fields : [];
      if (!open) {
        const btn = addButton(doc, section);
        if (!btn) continue;
        const before = new Set(deepAll(doc, 'input, textarea, select'));
        btn.click(); // "Add" inside the Experience / Education section only
        for (let i = 0; i < 12 && !fresh.length; i++) {
          await wait(250);
          fresh = deepAll(doc, 'input, textarea, select').filter((el) => !before.has(el) && visible(el) && el.type !== 'hidden' && el.type !== 'file');
        }
        if (!fresh.length) {
          out.notes.push(`${section}: "Add" opened nothing JobHunter can fill — add it yourself`);
          continue;
        }
      }
      let filled = 0;
      for (const el of fresh) {
        const key = entryKey(section, labelFor(el) || el.name || el.placeholder);
        if (!key) continue;
        if (key === 'current') {
          if (el.type === 'checkbox' && next.current) tick(el);
          continue;
        }
        // a date the field wants with a month, when the profile has only the year: left to you, with the reason
        if ((key === 'start' || key === 'end') && !(key === 'end' && next.current) && next[key] && empty(el) && !dateFor(el, next[key])) {
          needYou(out, el, labelFor(el) || key, 'month missing in profile — add it in Profile (e.g. 2021-10)');
          continue;
        }
        // a location: the institution's city when the profile has one, else left empty (never the institution's name)
        const v = key === 'location' ? next.city || null : key === 'start' || key === 'end' ? (key === 'end' && next.current ? null : dateFor(el, next[key])) : next[key];
        if (!v || !empty(el)) continue;
        if (isAutocomplete(el)) {
          // institution / company lists: several queries, a suggestion only when exactly or closely the name; places: exact
          const place = key === 'location';
          if (place ? await fillFromList(doc, el, String(v), (t) => exactPlace(t, v)) : await pickName(doc, el, String(v), key === 'institution' ? next.institutionAlt : '')) {
            mark(el, 'filled');
            filled++;
          } else needYou(out, el, labelFor(el) || key, `pick "${v}" from the list`);
          continue;
        }
        if (el.tagName === 'SELECT') {
          const i = chooseOption([...el.options].map((o) => o.text), v);
          if (i < 0) continue;
          setValue(el, el.options[i].value);
        } else typeInto(el, String(v));
        if (empty(el)) {
          needYou(out, el, labelFor(el) || key, `the field did not accept "${v}" — type it yourself`);
          continue;
        }
        mark(el, 'filled');
        filled++;
      }
      out.filled += filled;
      const left = list.filter((e) => e !== next && !onPage(doc, nameOf(e))).length;
      if (open && !filled) continue;
      out.notes.push(`${section}: ${open ? 'the open entry' : 'added'} "${nameOf(next)}" (${filled} fields) — check it and click its Save${left > 0 ? `, then JobHunter Fill again for the next (${left} left)` : ''}`);
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
  /** The job ad as the page shows it: the main content without navigation, header, footer, forms and scripts. */
  function pageJobText(doc) {
    const clean = (root) => {
      const c = root.cloneNode(true);
      c.querySelectorAll('nav, header, footer, aside, script, style, noscript, svg, form, iframe, button, select, input, textarea, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], #jobhunter-fill-overlay').forEach((n) => n.remove());
      return (c.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const main = doc.querySelector('main, article, [role="main"]');
    let text = main ? clean(main) : '';
    if (text.length < 300 && doc.body) text = clean(doc.body);
    return text.slice(0, 6000);
  }

  const MAX_OPTIONS = 60;
  /**
   * What the page asks for, for the background worker: every fillable field as the planner sees it (key, label,
   * placeholder, name, type, options, required, nearby text, empty or not, the dictionary's type), the job ad on the
   * page, its title / company / language, and frames from another site that hold a form.
   */
  function scan(doc, data = {}) {
    const fields = formFields(doc)
      .filter(({ el }) => el.type !== 'file' && el.type !== 'radio' && el.type !== 'checkbox')
      .map(({ el, f }) => ({
        key: f.key,
        label: String(f.label || '').slice(0, 300),
        placeholder: String(f.placeholder || '').slice(0, 300),
        name: String(f.name || f.id || '').slice(0, 200),
        type: el.tagName === 'TEXTAREA' || isEditor(el) ? 'textarea' : el.tagName === 'SELECT' ? 'select-one' : f.type,
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => textOf(o) || o.value).filter(Boolean).slice(0, MAX_OPTIONS) : [],
        required: !!f.required,
        near: nearText(el),
        empty: empty(el),
        entry: !!f.entry,
        dict: dictType(f),
      }));
    // the older shape, still read by tests and older workers
    const unknown = fields.filter((x) => !x.dict && x.label && !bankAnswer(x.label, data.bank ?? [])).map((x) => x.label);
    const h1 = doc.querySelector('h1');
    // the page's own job title and company (for a page JobHunter does not know): the heading, og:site_name / the tab title's last part
    const parts = String(doc.title || '').split(/\s+[-|–]\s+/).map((x) => x.trim()).filter(Boolean);
    const named = parts.filter((x) => !/^(application|apply|careers?|jobs?|job application|הגשת מועמדות|משרות|קריירה)$/i.test(x));
    const company = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || (named.length > 1 ? named[named.length - 1] : '');
    return {
      fields: fields.slice(0, 120),
      unknown: [...new Set(unknown)].slice(0, 40),
      coverLetter: fields.some((x) => x.empty && DRAFT_TYPES.includes(x.dict)),
      title: textOf(h1) || parts.slice(0, -1).join(' - ') || doc.title,
      company,
      lang: /[א-ת]/.test(textOf(doc.body).slice(0, 3000)) ? 'he' : 'en',
      jobText: pageJobText(doc),
      frames: foreignFrames(doc),
    };
  }

  /** The draft a field gets (pure, also used by the background worker): its planned / dictionary type, if a draft. */
  function draftKindOf(field, plan, hasJobContext = false) {
    if (field.entry) return null;
    const t = field.dict || draftOnly(field, plan, hasJobContext);
    return t === 'bio' ? 'bio' : t === 'coverLetter' ? 'cover' : null;
  }
  /** what the plan / the required-field fallback make of a field the rules do not recognize */
  function draftOnly(field, plan, hasJobContext) {
    const raw = plan ? plan[field.key] : undefined;
    const planned = raw ? PLANNED[raw] || raw : undefined;
    if (DRAFT_TYPES.includes(planned) && (field.type === 'textarea' || field.type === 'text')) return planned;
    if ((!planned || planned === 'unknown') && hasJobContext && field.required && field.type === 'textarea') return 'coverLetter';
    return null;
  }
  /** Why a free-text field gets no draft (for the overlay): what the rules and the planner said. */
  function noDraftReason(field, plan) {
    const raw = plan ? plan[field.key] : undefined;
    if (field.dict) return `recognized as "${field.dict}", not a cover letter or bio`;
    if (raw) return `the form planner said "${raw}"`;
    return 'not recognized by the rules, and the form planner gave nothing for it';
  }

  /** Fills the page. Returns the summary; shows the overlay unless opts.overlay === false. */
  async function run(doc, data, opts = {}) {
    // defense in depth: the popup and the background worker never get here on LinkedIn / Indeed
    if (manualOnlyHost((opts.location ?? doc.location).href)) return { refused: MANUAL_ONLY_MESSAGE, filled: 0, drafts: 0, needYou: 0, pending: [], cv: null, cvFields: 0, skipped: 0, details: [], notes: [], flaggedClaims: [] };
    clearMarks(doc);
    const out = { filled: 0, drafts: 0, needYou: 0, pending: [], cv: data.cv?.file ?? null, cvFields: 0, skipped: 0, details: [], notes: [], questions: [], flaggedClaims: (data.draft && data.draft.flaggedClaims) || [] };
    const done = new Set();
    for (const { el, f } of formFields(doc)) {
      if (done.has(el)) continue;

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
          needYou(out, el, gl, a.pending ?? 'no matching option for your answer');
          // a question with no answer on file: into your answers bank as pending (you answer it once, in JobHunter)
          if (a.value === undefined && gl && norm(gl).length >= 4 && !/never filled/.test(a.skip || '')) {
            const options = group.map((g) => labelFor(g) || g.value).filter(Boolean);
            out.questions.push({ question: gl, type: options.length === 2 && options.every((o) => YES.test(norm(o)) || NO.test(norm(o))) ? 'yes_no' : 'choice', options });
          }
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
          // a choice with no answer on file: into your answers bank as pending
          if (el.tagName === 'SELECT' && norm(f.label).length >= 4 && /no answer on file|^no \w+ in your profile/.test(a.pending)) {
            const options = [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|בחר|בחרי|--)/i.test(t)).slice(0, 40);
            if (options.length) out.questions.push({ question: f.label, type: 'choice', options });
          }
        }
        continue;
      }
      if (!empty(el)) continue; // never overwrite what is there
      if (a.draft) {
        setValue(el, a.draft);
        mark(el, 'draft', 'AI draft — review before submitting');
        out.drafts++;
        for (const c of a.flaggedClaims || []) if (!out.flaggedClaims.includes(c)) out.flaggedClaims.push(c);
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
        const texts = opts2.map((o) => o.text);
        // your value, the same in the other language (Israel / ישראל), or a years bucket ("1-3 years")
        let i = chooseOption(texts, a.value);
        for (const alt of a.alts || []) if (i < 0) i = chooseOption(texts, alt);
        if (i < 0 && a.type === 'yearsExperience') i = bucketOption(texts, Number(a.value));
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
        // a city: only the exact suggestion; a name (company, school): exact or close; anything else: the matching option.
        // No match: the typed text stays, yellow
        const places = [a.value, ...(a.alts || [])];
        const ok =
          a.type === 'city' || a.type === 'country'
            ? await fillFromList(doc, el, String(a.value), (t) => places.some((x) => exactPlace(t, x)))
            : a.type === 'currentCompany'
              ? await pickName(doc, el, String(a.value), '')
              : await fillFromList(doc, el, String(a.value), (t) => closeMatch(t, a.value) || chooseOption([t], a.value) === 0);
        if (ok) {
          mark(el, 'filled');
          out.filled++;
          out.details.push({ label: f.label, value: a.value, from: a.from });
        } else {
          needYou(out, el, f.label, `pick "${a.value}" from the list`);
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
    // a form inside another site's frame: the browser lets no extension script fill it from this page
    for (const src of data.frames || []) out.notes.push(`part of the form is inside a frame from ${hostOf(src)}: open ${src} in its own tab and click JobHunter Fill there`);
    // a form with more steps: this step only; you click Next yourself
    if (deepAll(doc, 'button, [role="button"], input[type="button"]').some((b) => visible(b) && /^(next|continue|הבא|המשך)\b/i.test((textOf(b) || b.value || '').trim()))) {
      out.notes.push('this form has more steps: this one is filled; after you click Next yourself, click Fill again (or JobHunter Fill) for the next step');
    }
    // required fields still empty (custom widgets too), in shadow roots as well
    for (const el of deepAll(doc, '[aria-required="true"], [required]')) {
      const host = outer(el);
      if (host.hasAttribute(MARK) || host.closest(`[${MARK}]`) || el.hasAttribute(MARK) || !visible(el) || inCaptcha(el) || el.type === 'file' || el.type === 'hidden') continue;
      if (/^(radio|checkbox|option)$/.test(el.getAttribute('role') || '') || el.querySelector('input[type=radio], input[type=checkbox]')) continue; // a choice's wrapper: handled with its group
      if (el.shadowRoot && el.shadowRoot.querySelector('input, textarea, select')) continue; // its inner field was handled
      if (('value' in el && typeof el.value === 'string' && el.value.trim()) || el.type === 'radio' || el.type === 'checkbox') continue;
      const text = el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox' || el.querySelector?.('textarea, [contenteditable]');
      needYou(out, el, el.getAttribute('label') || labelFor(el), text ? `required text, not filled: ${sweepReason(el)}` : 'required — fill it yourself');
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
        <div class="m">${job ? `${escapeHtml(job.title)} — ${escapeHtml(job.company)} (${escapeHtml(job.siteLabel)})` : 'not linked to a JobHunter job'}</div>
        ${data.jobContext ? `<div class="m">job context: ${escapeHtml(data.jobContext)}</div>` : ''}
        ${out.drafts ? `<div class="m">The purple text is an AI draft from your profile: read and edit it before submitting.${claims ? ` Check these claims: <ul>${claims}</ul>` : ''}</div>` : ''}
        ${out.pending.length ? `<div class="m"><span class="y">need you</span><ul>${out.pending.slice(0, 12).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}${out.pending.length > 12 ? `<li>… ${out.pending.length - 12} more (outlined yellow)</li>` : ''}</ul></div>` : ''}
        ${(data.problems || []).map((n) => `<div class="m">⚠ ${escapeHtml(n)}</div>`).join('')}
        ${(data.frames || []).map((src) => `<div class="m">Part of the form is inside a frame from ${escapeHtml(hostOf(src))}, which JobHunter cannot fill from this page: <a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">Open form in a new tab</a>, then click JobHunter Fill there.</div>`).join('')}
        ${out.notes.filter((n) => !/^part of the form is inside a frame/.test(n)).map((n) => `<div class="m">${escapeHtml(n)}</div>`).join('')}
        <div class="m">Check everything, attach the CV, then submit yourself.</div>
        <div class="r">${job ? '<button class="p" id="applied">I applied</button>' : ''}${opts.onFillAgain ? '<button id="again" title="fills only the fields that are still empty (new fields, the next step)">Fill again</button>' : ''}<button id="close">Close</button></div>
        <div class="m" id="msg"></div>
      </div>`;
    shadow.getElementById('close').onclick = () => clearMarks(doc);
    const again = shadow.getElementById('again');
    if (again)
      again.onclick = async () => {
        again.disabled = true;
        shadow.getElementById('msg').textContent = 'filling the empty fields again…';
        try {
          await opts.onFillAgain();
        } catch (e) {
          again.disabled = false;
          shadow.getElementById('msg').textContent = `could not fill again: ${e.message}`;
        }
      };
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

  /** why a required element the fill did not handle was left (the overlay shows it, never just "fill it yourself") */
  function sweepReason(el) {
    if (el.disabled) return 'it is disabled';
    if (el.readOnly) return 'it is read-only';
    if (inCaptcha(el)) return 'it is inside a CAPTCHA area';
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) return `a custom ${el.getAttribute('role') || el.tagName.toLowerCase()} element JobHunter cannot type into`;
    return 'JobHunter could not read it as a form field';
  }
  /** a line added to the overlay after the fill (e.g. questions sent to your answers bank) */
  function notice(doc, text) {
    const o = doc.getElementById('jobhunter-fill-overlay');
    const msg = o && o.shadowRoot && o.shadowRoot.getElementById('msg');
    if (msg) msg.textContent = `${msg.textContent ? `${msg.textContent} · ` : ''}${text}`;
  }
  const hostOf = (u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return 'another site';
    }
  };
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  root.JobHunterFill = { norm, classify, dictType, freeTextRule, fieldType, draftKindOf, noDraftReason, notice, wantsMonth, bucketOption, nameQueries, pageJobText, bankAnswer, chooseOption, exactPlace, closeMatch, localPhone, answerFor, dateFor, entryKey, run, scan, clearMarks, manualOnlyHost, MANUAL_ONLY_MESSAGE, FORBIDDEN };
})(typeof globalThis !== 'undefined' ? globalThis : this);
