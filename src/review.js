const LEARN_AHEAD_MS = 20 * 60e3;

const $root = api.$container.find('.fc-root');

// ---------- load libraries (UMD builds stored in code notes labeled #fcLib=<name>) ----------
const { libs, notes, db, storedSettings } = await api.runOnBackend(() => {
  const libs = {};
  for (const n of api.searchForNotes('#fcLib')) libs[n.getLabelValue('fcLib')] = n.getContent();
  const notes = api.searchForNotes('#flashcards').map(n => ({
    noteId: n.noteId, title: n.title, mime: n.mime, content: n.getContent()
  }));
  const db = JSON.parse(api.searchForNote('#srsState').getContent() || '{}');
  const settingsNote = api.searchForNote('#srsSettings');   // null when only an older version's notes are installed
  const storedSettings = settingsNote ? JSON.parse(settingsNote.getContent() || '{}') : null;
  return { libs, notes, db, storedSettings };
});
const loadUmd = code => { const m = { exports: {} }; new Function('module', 'exports', 'define', code)(m, m.exports, undefined); return m.exports; };
const FSRS = loadUmd(libs['ts-fsrs']);
const { fsrs, generatorParameters, createEmptyCard, Rating } = FSRS;
const Opt = libs['optimizer'] ? loadUmd(libs['optimizer'])(FSRS) : null;   // optional: the settings tab hides the optimizer without it
db.cards ??= {};
db.logs ??= [];

// ---------- parse notes into cards ----------
const hash = s => { let x = 0; for (const ch of s) x = (x * 31 + ch.codePointAt(0)) | 0; return (x >>> 0).toString(36); };
const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
const SEP_TEXT = /\s::\s/;
const SEP_HTML = /(?:\s|&nbsp;)::(?:\s|&nbsp;)/;

const textOf = html => new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();
// Hide "::" inside <code> so `a :: b` in inline code is never taken as a card separator.
const mask = html => html.replace(/<code[^>]*>[\s\S]*?<\/code>/g, m => m.replaceAll('::', '\uE000'));
const unmask = s => s.replaceAll('\uE000', '::');

// Returns true if `src` (HTML of one line) held a single-line card (Q :: A) or cloze card(s).
function parseLine(src, add) {
  const text = textOf(src);
  const nums = new Set([...src.matchAll(CLOZE)].map(m => m[1]));
  for (const n of nums) {
    const show = hide => src.replace(CLOZE, (_, k, body, hint) =>
      k !== n ? body : `<span class="fc-cloze">${hide ? `[${hint ?? '…'}]` : body}</span>`);
    add(`${text}#c${n}`, show(true), show(false), true, text);
  }
  if (nums.size) return true;
  const masked = mask(src), maskedText = textOf(masked);
  if (!SEP_TEXT.test(maskedText)) return false;
  const [front, ...rest] = masked.split(SEP_HTML);
  add(unmask(maskedText.split(SEP_TEXT)[0]), unmask(front), unmask(rest.join(' :: ')));
  return true;
}

// A list item may hold several lines separated by <br> (Shift+Enter).
function parseInline(el, add) {
  if (el.matches('pre')) return false;
  let found = false;
  for (const line of el.innerHTML.split(/<br\s*\/?>/i)) found = parseLine(line, add) || found;
  return found;
}

// Turn "<p>a<br>b</p>" into two paragraphs so every line is its own block.
function blocksOf(html) {
  const out = [];
  for (const el of new DOMParser().parseFromString(html, 'text/html').body.children) {
    if (!el.matches('p') || !/<br/i.test(el.innerHTML)) { out.push(el); continue; }
    for (const line of el.innerHTML.split(/<br\s*\/?>/i)) {
      const p = el.ownerDocument.createElement('p');
      p.innerHTML = line;
      out.push(p);
    }
  }
  return out;
}

function parseNote(note) {
  const html = note.content;
  const cards = [];
  const add = (key, front, back, cloze = false, group = key) =>   // cards of one group are siblings (clozes of one line)
    cards.push({ id: `${note.noteId}:${hash(key)}`, group: `${note.noteId}:${hash(group)}`, noteId: note.noteId, title: note.title, front, back, cloze });

  let buf = [], back = null;   // back !== null → collecting a multi-block answer (after a "?" line)
  let pendingQ = null;         // set after a lone "::" line: the next block is the answer
  const flush = () => {
    if (buf.length && back?.length)
      add(buf.map(b => b.textContent).join('\n'), buf.map(b => b.outerHTML).join(''), back.map(b => b.outerHTML).join(''));
    buf = []; back = null;
  };

  for (const b of blocksOf(html)) {
    if (b.matches('hr, h1, h2, h3, h4, h5, h6')) { flush(); pendingQ = null; continue; }
    if (pendingQ) { add(pendingQ.textContent, pendingQ.outerHTML, b.outerHTML); pendingQ = null; continue; }
    if (back !== null) { back.push(b); continue; }
    const t = b.textContent.trim();
    if (t === '::' && buf.length) { pendingQ = buf.pop(); buf = []; continue; }   // Q / :: / A → one block each
    if (t === '?' && buf.length) { back = []; continue; }                       // Q… / ? / A… until hr or heading
    const found = b.matches('ul, ol')
      ? [...b.children].map(li => parseInline(li, add)).some(Boolean)
      : !b.matches('pre') && parseLine(b.innerHTML, add);
    if (found) buf = []; else buf.push(b);
  }
  flush();
  return cards;
}

const cards = notes.flatMap(parseNote);

const DAY = 864e5;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysAgo = n => { const d = dayStart(); d.setDate(d.getDate() - n); return d; };
const dur = ms => ms < 6e4 ? `${Math.round(ms / 1e3)}s` : ms < 36e5 ? `${Math.round(ms / 6e4)}m` : `${(ms / 36e5).toFixed(1)}h`;


// ---------- settings ----------
const DEFAULTS = {
  buttons: 2,               // 2 = Forgot/Remembered, 4 = Again/Hard/Good/Easy
  newPerDay: 20,
  maxReviews: 0,            // 0 = unlimited
  retention: 0.9,           // target recall probability
  maximumInterval: 36500,   // days
  learningSteps: '1m 10m',
  relearningSteps: '10m',
  weights: '',              // FSRS weights (21 numbers); empty = defaults
};
const DEFAULT_W = generatorParameters().w;
// Settings live in their own note (#srsSettings). Older versions kept them inside srs-state; those are moved over
// the first time the settings note is still empty. Without a settings note the old location keeps working.
const hasSettingsNote = storedSettings !== null;
const legacySettings = db.settings;
const migrateSettings = hasSettingsNote && legacySettings && !Object.keys(storedSettings).length;
const savedSettings = hasSettingsNote ? (migrateSettings ? legacySettings : storedSettings) : (legacySettings ?? {});
if (hasSettingsNote) delete db.settings;
for (const k of ['spread', 'loadBalance', 'fuzz']) delete savedSettings[k];   // options of earlier versions; the load balancer is always on
let S = { ...DEFAULTS, ...savedSettings };

const STEP = /^\d+[mhd]$/;
const words = str => str.split(/[\s,\[\]]+/).filter(Boolean);
function checkSettings(v) {
  if (v.buttons !== 2 && v.buttons !== 4) return 'Answer buttons must be 2 or 4.';
  if (!(v.newPerDay >= 0)) return 'New cards per day must be 0 or more.';
  if (!(v.maxReviews >= 0)) return 'Maximum reviews per day must be 0 or more (0 = unlimited).';
  if (!(v.retention >= 0.7 && v.retention <= 0.99)) return 'Desired retention must be between 0.70 and 0.99.';
  if (!(v.maximumInterval >= 1)) return 'Maximum interval must be at least 1 day.';
  for (const k of ['learningSteps', 'relearningSteps'])
    if (words(v[k]).some(x => !STEP.test(x))) return 'Steps look like "1m 10m 1h": a number followed by m, h or d.';
  const w = words(v.weights);
  if (w.length && (w.length !== DEFAULT_W.length || w.some(x => !isFinite(x))))
    return `FSRS weights need exactly ${DEFAULT_W.length} numbers (or leave empty for the defaults).`;
  return null;
}
function buildFsrs(v) {
  const w = words(v.weights).map(Number);
  return fsrs(generatorParameters({
    request_retention: v.retention,
    maximum_interval: v.maximumInterval,
    enable_fuzz: false,                       // review dates are varied by balance() below
    learning_steps: words(v.learningSteps),
    relearning_steps: words(v.relearningSteps),
    ...(w.length ? { w } : {}),
  }));
}
let f = buildFsrs(S);

// ---------- load balancer ----------
// Follows Anki's scheduler (rslib/src/scheduler/states/fuzz.rs and load_balancer.rs).
const FUZZ_RANGES = [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]];
const MAX_BALANCE_INTERVAL = 90;   // Anki does not balance intervals beyond this; they get plain fuzz
const SIBLING_RAMP = [1.0, 0.8, 0.6, 0.4, 0.2, 0.000001, 0.2, 0.4, 0.6, 0.8, 1.0];   // days -5 … +5 around a sibling
const clampN = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

const fuzzDelta = ivl => ivl < 2.5 ? 0 : FUZZ_RANGES.reduce((d, [from, to, k]) => d + k * Math.max(Math.min(ivl, to) - from, 0), 1);
function fuzzBounds(ivl, minimum, maximum) {
  minimum = Math.min(minimum, maximum);
  ivl = clampN(ivl, minimum, maximum);
  const d = fuzzDelta(ivl);
  const lower = clampN(Math.round(ivl - d), minimum, maximum);
  let upper = clampN(Math.round(ivl + d), minimum, maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}
// Lowest interval allowed after a successful review, so that fuzz never makes an interval shrink.
function minimumFuzzInterval(ivl, previous, maximum) {
  const upper = fuzzBounds(ivl, 1, maximum)[1];
  if (Math.round(ivl) > previous) return previous + 1;
  return previous <= upper ? previous : 0;
}
// The unrounded interval FSRS wants for a stability: S * (R^(1/decay) - 1) / factor.
function idealInterval(stability) {
  const w20 = (words(S.weights).length === DEFAULT_W.length ? words(S.weights).map(Number) : DEFAULT_W)[20], decay = -w20;
  const factor = Math.pow(0.9, 1 / decay) - 1;
  return clampN(stability * (Math.pow(S.retention, 1 / decay) - 1) / factor, 1, S.maximumInterval);
}

// Moves the due date of a card that has just been scheduled for review (state 2) inside its fuzz range.
// prev is the card as it was before the answer; id is used to leave the card itself out of the counts.
function balance(card, prev, id) {
  if (card.state !== 2) return card;
  const ideal = idealInterval(card.stability);
  const minimum = prev.state === 2 ? minimumFuzzInterval(ideal, prev.scheduled_days, S.maximumInterval) : 1;
  const [lo, hi] = fuzzBounds(ideal, minimum, S.maximumInterval);
  let pick = clampN(Math.round(ideal), minimum, S.maximumInterval);
  if (hi > lo) {
    pick = lo + Math.floor(Math.random() * (hi - lo + 1));                        // plain fuzz
    if (ideal <= MAX_BALANCE_INTERVAL && minimum <= MAX_BALANCE_INTERVAL) {
      const today = dayStart().getTime(), dayIndex = t => Math.round((dayStart(new Date(t)).getTime() - today) / DAY);
      const load = {}, siblingDays = [], group = cards.find(c => c.id === id)?.group;
      for (const c of cards) {
        const st = db.cards[c.id];
        if (c.id === id || !st || st.state === 0) continue;
        const d = dayIndex(st.due);
        load[d] = (load[d] ?? 0) + 1;
        if (group && c.group === group) siblingDays.push(d);
      }
      const modifier = Array(hi - lo + 1).fill(1);                                // keep clear of siblings
      for (const sd of siblingDays) SIBLING_RAMP.forEach((m, i) => { const t = sd + i - 5 - lo; if (t >= 0 && t < modifier.length) modifier[t] *= m; });
      const weights = modifier.map((m, i) => { const n = load[lo + i] ?? 0; return n === 0 ? 1 : Math.pow(1 / n, 2.15) * Math.pow(1 / (lo + i), 3) * m; });
      let r = Math.random() * weights.reduce((a, b) => a + b, 0), k = 0;
      while (k < weights.length - 1 && r >= weights[k]) { r -= weights[k]; k++; }
      pick = lo + k;
    }
  }
  return { ...card, scheduled_days: pick, due: new Date(Date.now() + pick * DAY) };
}

// ---------- queue ----------
const now = () => new Date();
let queue = [];
function buildQueue() {
  const today = new Date().toDateString();
  const todays = db.logs.filter(l => new Date(l.t).toDateString() === today);
  const newToday = todays.filter(l => l.s === 0).length, reviewedToday = todays.length - newToday;
  let due = cards.filter(c => db.cards[c.id] && new Date(db.cards[c.id].due) <= now())
    .sort((a, b) => new Date(db.cards[a.id].due) - new Date(db.cards[b.id].due));
  if (S.maxReviews) due = due.slice(0, Math.max(0, S.maxReviews - reviewedToday));
  const fresh = cards.filter(c => !db.cards[c.id]).slice(0, Math.max(0, S.newPerDay - newToday));
  queue = [...due, ...fresh];
}
buildQueue();

const fmt = ms => ms < 36e5 ? `${Math.max(1, Math.round(ms / 6e4))}m`
  : ms < 864e5 ? `${Math.round(ms / 36e5)}h` : `${Math.round(ms / 864e5)}d`;
const preview = (prev, r) => fmt(new Date(f.next(prev, now(), r).card.due) - Date.now());

let saving = Promise.resolve();
function save() {
  const json = JSON.stringify(db);
  saving = saving.then(() => api.runOnBackend(j => { api.searchForNote('#srsState').setContent(j); }, [json]));
}
function saveSettings() {
  if (!hasSettingsNote) { db.settings = { ...S }; return save(); }
  const json = JSON.stringify(S);
  saving = saving.then(() => api.runOnBackend(j => { api.searchForNote('#srsSettings').setContent(j); }, [json]));
}
if (migrateSettings) saveSettings();   // copy the old settings into their note …
if (hasSettingsNote && legacySettings) save();   // … and drop them from srs-state

// ---------- UI ----------
$root.html(`
  <div class="fc-tabs"><button data-tab="review" class="active">Review</button><button data-tab="stats">Statistics</button><button data-tab="settings">Settings</button></div>
  <div class="fc-view"></div>`);
const $view = $root.find('.fc-view');

let tab = 'review', flipped = false, shownAt = Date.now();

const gradeButtons = () => S.buttons === 4
  ? [{ rating: Rating.Again, key: 1, label: 'Again', cls: 'again' }, { rating: Rating.Hard, key: 2, label: 'Hard', cls: 'hard' },
     { rating: Rating.Good, key: 3, label: 'Good', cls: 'good' }, { rating: Rating.Easy, key: 4, label: 'Easy', cls: 'easy' }]
  : [{ rating: Rating.Again, key: 1, label: 'Forgot', cls: 'again' }, { rating: Rating.Good, key: 2, label: 'Remembered', cls: 'good' }];

const kind = c => { const s = db.cards[c.id]?.state ?? 0; return s === 0 ? 'new' : s === 2 ? 'review' : 'learn'; };

function render() {
  return tab === 'review' ? renderReview() : tab === 'stats' ? renderStats() : renderSettings();
}

function renderReview() {
  const c = queue[0];
  if (!c) {
    const next = cards.map(x => db.cards[x.id]).filter(Boolean).map(x => new Date(x.due) - Date.now()).sort((a, b) => a - b)[0];
    return $view.html(`<div class="fc-empty"><h3>🎉 All done for now</h3>
      <p>${cards.length} cards in total.</p>${next ? `<p>Next card due in ${fmt(Math.max(0, next))}.</p>` : ''}</div>`);
  }
  const n = { new: 0, learn: 0, review: 0 };
  for (const q of queue) n[kind(q)]++;
  const cur = kind(c);
  const prev = db.cards[c.id] ?? createEmptyCard(now());
  $view.html(`
    <div class="fc-top">
      <div class="fc-counts">${['new', 'learn', 'review'].map(k => `<span class="${k} ${k === cur ? 'cur' : ''}" title="${k}">${n[k]}</span>`).join('')}</div>
      <a href="#" class="fc-src"></a>
    </div>
    <div class="fc-card">${flipped && c.cloze ? c.back : c.front}</div>
    ${flipped
      ? `${c.cloze ? '' : `<div class="fc-card">${c.back}</div>`}
         <div class="fc-btns">${gradeButtons().map(b => `
           <button class="fc-btn ${b.cls}" data-r="${b.rating}"><b><kbd>${b.key}</kbd>${b.label}</b><small>${preview(prev, b.rating)}</small></button>`).join('')}
         </div>`
      : `<div class="fc-btns"><button class="fc-btn fc-flip"><b><kbd>space</kbd>Show answer</b></button></div>`}
  `);
  $view.find('.fc-src').text(c.title).on('click', e => { e.preventDefault(); api.activateNote(c.noteId); });
}

function grade(rating) {
  const c = queue.shift();
  const prev = db.cards[c.id] ?? createEmptyCard(now());
  const card = balance(f.next(prev, now(), rating).card, prev, c.id);
  db.cards[c.id] = card;
  db.logs.push({ c: c.id, t: Date.now(), r: rating, s: prev.state, d: Math.min(Date.now() - shownAt, 60e3) });
  if (new Date(card.due) - Date.now() < LEARN_AHEAD_MS) queue.push(c);   // learning step: see again this session
  flipped = false; shownAt = Date.now();
  render();
  save();
}

// ---------- statistics ----------
function bars(items, { cls = '' } = {}) {   // items: [{ label, parts: [[value, className]] }]
  const max = Math.max(1, ...items.map(i => i.parts.reduce((s, [v]) => s + v, 0)));
  return `<div class="fc-bars">${items.map(i => `<div class="fc-bar" title="${i.label}">${
    i.parts.map(([v, k]) => `<i class="${k || cls}" style="height:${(v / max) * 100}%"></i>`).join('')}</div>`).join('')}</div>`;
}

function renderStats() {
  const today = ymd(new Date());
  const daily = {};                                        // 'YYYY-MM-DD' → { n, again, ms }
  for (const l of db.logs) {
    const d = daily[ymd(new Date(l.t))] ??= { n: 0, again: 0, ms: 0 };
    d.n++; d.ms += l.d ?? 0;
    if (l.r === Rating.Again) d.again++;
  }
  const t = daily[today] ?? { n: 0, again: 0, ms: 0 };

  let streak = 0;                                          // consecutive days with reviews, today optional
  for (let i = daily[today] ? 0 : 1; daily[ymd(daysAgo(i))]; i++) streak++;

  const recent = db.logs.filter(l => l.s === 2 && l.t > Date.now() - 30 * DAY);   // reviews of mature-enough cards
  const retention = recent.length ? Math.round(100 * recent.filter(l => l.r !== Rating.Again).length / recent.length) : null;

  // card maturity
  const groups = { New: 0, Learning: 0, Young: 0, Mature: 0 };
  for (const c of cards) {
    const s = db.cards[c.id];
    if (!s || s.state === 0) groups.New++;
    else if (s.state !== 2) groups.Learning++;
    else if (s.scheduled_days < 21) groups.Young++;
    else groups.Mature++;
  }
  const colors = { New: 'var(--fc-blue)', Learning: 'var(--fc-red)', Young: '#8fd3a8', Mature: 'var(--fc-green)' };
  const total = Math.max(1, cards.length);

  // heatmap: last 53 weeks, weeks start on Sunday
  const end = dayStart(), first = new Date(end);
  first.setDate(first.getDate() - end.getDay() - 52 * 7);
  const maxDay = Math.max(1, ...Object.values(daily).map(d => d.n));
  let cols = '';
  for (let w = 0; w < 53; w++) {
    let cells = '', label = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(first); d.setDate(first.getDate() + w * 7 + i);
      if (d > end) { cells += '<u class="off"></u>'; continue; }
      const n = daily[ymd(d)]?.n ?? 0;
      if (i === 0 && d.getDate() <= 7) label = d.toLocaleString(undefined, { month: 'short' });
      cells += `<u class="${n ? 'l' + Math.ceil((n / maxDay) * 4) : ''}" title="${ymd(d)}: ${n} review${n === 1 ? '' : 's'}"></u>`;
    }
    cols += `<div class="fc-hm-col"><em>${label}</em>${cells}</div>`;
  }
  const yearTotal = Object.entries(daily).filter(([k]) => k >= ymd(first)).reduce((s, [, d]) => s + d.n, 0);
  const activeDays = Object.keys(daily).filter(k => k >= ymd(first)).length;

  // last 30 days of reviews
  const past = [...Array(30)].map((_, i) => {
    const d = daysAgo(29 - i), v = daily[ymd(d)] ?? { n: 0, again: 0 };
    return { label: `${ymd(d)}: ${v.n} reviews, ${v.again} forgotten`, parts: [[v.n - v.again, ''], [v.again, 'again']] };
  });

  // forecast: next 30 days (overdue counts as today)
  const future = Array(30).fill(0), t0 = dayStart().getTime();
  for (const c of cards) {
    const s = db.cards[c.id];
    if (!s || s.state === 0) continue;
    const i = Math.max(0, Math.round((dayStart(new Date(s.due)).getTime() - t0) / DAY));
    if (i < 30) future[i]++;
  }
  const fc = future.map((v, i) => ({ label: `${ymd(new Date(t0 + i * DAY + DAY / 2))}: ${v} due`, parts: [[v, 'fut']] }));

  $view.html(`
    <div class="fc-tiles">
      <div class="fc-tile"><b>${t.n}</b><span>reviewed today${t.n ? ` · ${dur(t.ms)} · ${t.again} forgotten` : ''}</span></div>
      <div class="fc-tile"><b>${streak} day${streak === 1 ? '' : 's'}</b><span>current streak</span></div>
      <div class="fc-tile"><b>${retention === null ? '–' : retention + '%'}</b><span>retention, last 30 days</span></div>
      <div class="fc-tile"><b>${cards.length}</b><span>cards in total</span></div>
    </div>

    <div class="fc-sec"><h4>Reviews per day</h4>
      <div class="fc-heat"><div class="fc-hm">${cols}</div></div>
      <div class="fc-sub">${yearTotal} reviews on ${activeDays} days in the past year</div>
    </div>

    <div class="fc-sec"><h4>Card maturity</h4>
      <div class="fc-stack">${Object.entries(groups).map(([k, v]) => `<i title="${k}: ${v}" style="width:${(v / total) * 100}%;background:${colors[k]}"></i>`).join('')}</div>
      <div class="fc-legend">${Object.entries(groups).map(([k, v]) => `<span style="--k:${colors[k]}">${k} ${v}</span>`).join('')}</div>
      <div class="fc-sub">Young: interval under 21 days. Mature: 21 days or more.</div>
    </div>

    <div class="fc-sec"><h4>Last 30 days</h4>${bars(past)}
      <div class="fc-axis"><span>30 days ago</span><span>today</span></div>
      <div class="fc-legend"><span style="--k:var(--fc-green)">Remembered</span><span style="--k:var(--fc-red)">Forgot</span></div>
    </div>

    <div class="fc-sec"><h4>Due in the next 30 days</h4>${bars(fc)}
      <div class="fc-axis"><span>today (incl. overdue)</span><span>+30 days</span></div>
      <div class="fc-sub">${future[0]} due now or overdue · ${future[1]} tomorrow</div>
    </div>`);
}

// ---------- weight optimizer ----------
const opt = { running: false, cancel: false, pct: 0, msg: '', result: null };
const currentWeights = () => { const w = words(S.weights).map(Number); return w.length === DEFAULT_W.length ? w : DEFAULT_W.slice(); };
const MIN_REVIEWS = 1000, MIN_Z = 1.5;

function optBlock() {
  if (!Opt) return '';
  const seqs = Opt.prepare(db.logs), usable = Opt.evaluate(seqs, currentWeights()).n;
  const r = opt.result;
  return `<div class="fc-sec fc-opt"><h4>Optimize weights</h4>
    <div class="fc-sub" style="margin:0 0 .8em">Fits the FSRS weights to your own review history, following the training procedure of the official FSRS optimizer. You have <b>${usable}</b> usable reviews
      (reviews of cards at least a day after their previous review). At least ${MIN_REVIEWS} are needed. Each card is held out once (5-fold cross-validation) and the new weights are only offered if they clearly predict those held-out reviews better.
      ${Opt.frozen(seqs).length ? `Not enough Hard/Easy reviews to fit ${Opt.frozen(seqs).map(i => 'w' + i).join(', ')}; they stay at their current values.` : 'Every weight can be fitted.'}</div>
    <div class="fc-btns fc-actions" style="margin-top:0">
      <button class="fc-btn fc-run" ${usable < MIN_REVIEWS || opt.running ? 'disabled' : ''}><b>${opt.running ? 'Optimizing…' : 'Optimize'}</b></button>
      ${opt.running ? '<button class="fc-btn again fc-stop"><b>Cancel</b></button>' : ''}
    </div>
    ${opt.running ? `<div class="fc-progress"><i style="width:${opt.pct}%"></i></div>` : ''}
    ${opt.msg ? `<div class="fc-msg">${opt.msg}</div>` : ''}
    ${r ? `<table class="fc-table"><tr><th></th><th>Current</th><th>Optimized</th></tr>
        <tr><td>Log loss (held-out)</td><td>${r.before.loss.toFixed(4)}</td><td>${r.after.loss.toFixed(4)}</td></tr>
        <tr><td>Calibration error</td><td>${(r.before.rmse * 100).toFixed(1)}%</td><td>${(r.after.rmse * 100).toFixed(1)}%</td></tr></table>
      <div class="fc-sub">Measured on ${r.n} reviews, each predicted by weights that were fitted without its card. Lower is better.</div>
      ${r.w ? `<div class="fc-btns fc-actions"><button class="fc-btn good fc-use"><b>Use these weights</b></button></div>` : ''}` : ''}
  </div>`;
}

function updateOpt() { $view.find('.fc-opt').replaceWith(optBlock()); }

async function runOptimizer() {
  const cur = currentWeights(), seqs = Opt.prepare(db.logs);
  const steps = { learning_steps: words(S.learningSteps), relearning_steps: words(S.relearningSteps) };
  Object.assign(opt, { running: true, cancel: false, pct: 0, msg: 'Checking the model against ts-fsrs…', result: null });
  updateOpt();
  await new Promise(r => setTimeout(r));
  try {
    const check = Opt.selfCheck(seqs, cur, steps);
    if (check.worst > 1e-3) throw new Error(`the optimizer's model differs from this ts-fsrs version (${check.worst.toExponential(1)}); refusing to run`);
    const o = { relearnSteps: steps.relearning_steps.length, cancelled: () => opt.cancel };
    opt.msg = 'Cross-validating: each card is held out once…'; updateOpt();
    const cv = await Opt.crossValidate(seqs, cur, { ...o, onProgress: f => { opt.pct = f * 85; updateOpt(); } });
    if (!cv) { opt.msg = 'Cancelled.'; return; }
    const better = cv.improvement > 0 && cv.z >= MIN_Z;
    const stat = `${cv.improvement.toFixed(4)} ± ${cv.se.toFixed(4)} log loss per review (${cv.z.toFixed(1)} standard errors)`;
    if (!better) {
      opt.result = { ...cv, w: null };
      opt.msg = `Not clearly better than your current weights: ${stat}. Need at least ${MIN_Z} standard errors. Nothing was changed.`;
      return;
    }
    opt.msg = 'Better on reviews it was not trained on. Fitting on all your cards…'; updateOpt();
    const all = await Opt.optimize(seqs, { ...o, onProgress: (i, n) => { opt.pct = 85 + (i / n) * 15; updateOpt(); } });
    if (!all) { opt.msg = 'Cancelled.'; return; }
    opt.result = { ...cv, w: all.w };
    opt.msg = `Better on held-out reviews: ${stat}.`;
  } catch (e) {
    opt.msg = `<span class="bad">Failed: ${e.message}</span>`;
  } finally {
    opt.running = false; updateOpt();
  }
}

$root.on('click', '.fc-run', () => runOptimizer());
$root.on('click', '.fc-stop', () => { opt.cancel = true; });
$root.on('click', '.fc-use', () => {
  const v = readSettings(); v.weights = opt.result.w.join(', ');
  const err = commitSettings(v);
  renderSettings(err ? v : S, err ? `<span class="bad">${err} Not saved.</span>` : '<span class="ok">Weights saved.</span>');
});

// ---------- settings tab ----------
function renderSettings(v = S, msg = 'Changes are saved automatically.') {
  const num = (k, label, help, attrs = '') => `<label class="fc-field"><span>${label}<small>${help}</small></span>
    <input type="number" data-k="${k}" value="${v[k]}" ${attrs}></label>`;
  const txt = (k, label, help) => `<label class="fc-field"><span>${label}<small>${help}</small></span>
    <input type="text" data-k="${k}" value="${v[k]}"></label>`;
  const chk = (k, label, help) => `<label class="fc-field fc-check"><input type="checkbox" data-k="${k}" ${v[k] ? 'checked' : ''}>
    <span>${label}<small>${help}</small></span></label>`;
  $view.html(`
    <div class="fc-sec"><h4>Answer buttons</h4>
      <label class="fc-field"><span>Buttons<small>2: Forgot / Remembered. 4: Again / Hard / Good / Easy. Hard and Easy fine-tune the next interval.</small></span>
        <select data-k="buttons" data-num="1"><option value="2" ${v.buttons === 2 ? 'selected' : ''}>2 buttons</option>
          <option value="4" ${v.buttons === 4 ? 'selected' : ''}>4 buttons</option></select></label>
    </div>
    <div class="fc-sec"><h4>Daily limits</h4>
      ${num('newPerDay', 'New cards per day', 'How many unseen cards to introduce each day.', 'min="0" step="1"')}
      ${num('maxReviews', 'Maximum reviews per day', '0 means no limit.', 'min="0" step="1"')}
    </div>
    <div class="fc-sec"><h4>Scheduling (FSRS)</h4>
      ${num('retention', 'Desired retention', 'Chance of remembering a card when it comes due. Higher means more reviews (0.70 – 0.99).', 'min="0.7" max="0.99" step="0.01"')}
      ${num('maximumInterval', 'Maximum interval (days)', 'No card is scheduled further out than this.', 'min="1" step="1"')}
      ${txt('learningSteps', 'Learning steps', 'Delays for a new card, e.g. <code>1m 10m</code>. Empty: go straight to days.')}
      ${txt('relearningSteps', 'Relearning steps', 'Delays after forgetting a review card, e.g. <code>10m</code>.')}
    </div>
    <div class="fc-sec"><h4>Advanced</h4>
      <label class="fc-field fc-wide"><span>FSRS weights<small>${DEFAULT_W.length} numbers, for example from the FSRS optimizer. Empty uses the defaults below.</small></span>
        <textarea data-k="weights" rows="3" placeholder="${DEFAULT_W.join(', ')}">${v.weights}</textarea></label>
    </div>
    ${optBlock()}
    <div class="fc-btns fc-actions">
      <button class="fc-btn fc-defaults"><b>Restore defaults</b></button>
    </div>
    <div class="fc-msg">${msg}</div>`);
}

function readSettings() {
  const v = {};
  $view.find('[data-k]').each((_, el) => {
    const k = el.dataset.k;
    v[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.dataset.num ? Number(el.value) : el.value.trim();
  });
  return v;
}

// Validates new settings, applies them and stores them. Returns the error message, or null on success.
function commitSettings(v) {
  const err = checkSettings(v);
  if (err) return err;
  S = { ...v }; f = buildFsrs(S); buildQueue(); saveSettings();
  return null;
}

// Every change is saved as soon as it is committed (field left, Enter pressed, option picked).
$root.on('change', '[data-k]', () => {
  const err = commitSettings(readSettings());
  $view.find('.fc-msg').html(err ? `<span class="bad">${err} Not saved.</span>` : '<span class="ok">Saved.</span>');
  if (!err) updateOpt();
});
$root.on('click', '.fc-defaults', () => {
  commitSettings({ ...DEFAULTS });
  renderSettings(S, '<span class="ok">Defaults restored and saved.</span>');
});

$root.on('click', '[data-tab]', e => {
  tab = e.currentTarget.dataset.tab;
  $root.find('[data-tab]').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
  render();
  $root.focus();
});
$root.on('click', '.fc-flip', () => { flipped = true; render(); });
$root.on('click', '[data-r]', e => grade(+e.currentTarget.dataset.r));
$root.on('keydown', e => {
  if (tab !== 'review' || !queue.length) return;
  if (!flipped && e.key === ' ') { e.preventDefault(); flipped = true; render(); }
  else if (flipped && e.key === ' ') { e.preventDefault(); grade(Rating.Good); }
  else if (flipped) { const b = gradeButtons().find(x => String(x.key) === e.key); if (b) grade(b.rating); }
});

render();
$root.focus();
