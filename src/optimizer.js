// FSRS-6 weight optimizer. Loaded by review.js: `loadUmd(libs['optimizer'])(tsFsrs)`.
//
// It follows the training procedure of the official fsrs-rs optimizer (the one Anki uses) for FSRS-6:
//   1. items      every review at least a day after the previous one is one training item
//   2. outliers   rare interval buckets of first reviews are dropped
//   3. pretrain   initial stabilities w0-w3 are fitted per first rating, then smoothed and filled in
//   4. train      Adam (beta 0.70/0.98, lr 0.04 with cosine decay), 5 epochs, batches of 512 items grouped by
//                 history length, recency weights, and an L2 pull toward the pretrained weights
//   5. finish     w0-w3 are smoothed again so that Again <= Hard <= Good <= Easy
// Differences: gradients come from finite differences instead of analytic ones, and the random batch order
// uses a different random generator. Grades are 1 Again, 2 Hard, 3 Good, 4 Easy.
module.exports = function makeOptimizer(F) {
  const DAY = 864e5, S_MIN = 0.001, S_MAX = 36500, EPS = 1e-6, INIT_S_MAX = 100;
  const EPOCHS = 5, BATCH = 512, LR = 0.04, B1 = 0.70, B2 = 0.98, ADAM_EPS = 1e-8, L2 = 0.5, MIN_GRADE_EVENTS = 30;
  // per-weight spread used to scale the L2 pull (fsrs-rs training_v6.rs)
  const STDDEV = [6.43, 9.66, 17.58, 27.85, 0.57, 0.28, 0.6, 0.12, 0.39, 0.18, 0.33, 0.3, 0.09, 0.16, 0.57, 0.25, 1.03, 0.31, 0.32, 0.14, 0.27];
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
  const utcDay = t => Math.floor(t / DAY);

  // ----- data -----
  // logs → one sequence per card, oldest event first. dt[i] = whole days since the previous review.
  function prepare(logs) {
    const by = new Map();
    for (const l of logs) {
      if (!(l.r >= 1 && l.r <= 4)) continue;
      if (!by.has(l.c)) by.set(l.c, []);
      by.get(l.c).push(l);
    }
    const seqs = [];
    for (const [id, ev] of by) {
      if (ev.length < 2) continue;
      ev.sort((a, b) => a.t - b.t);
      const t = Float64Array.from(ev, e => e.t), g = Int8Array.from(ev, e => e.r);
      const dt = Int32Array.from(t, (x, i) => (i ? utcDay(x) - utcDay(t[i - 1]) : 0));
      seqs.push({ id, t, g, dt });
    }
    return seqs;
  }

  const hashId = s => { let x = 0; for (const ch of s) x = (x * 31 + ch.codePointAt(0)) | 0; return x >>> 0; };
  const split = (seqs, testShare = 0.2) => {   // by card, so a card is never in both sets
    const train = [], test = [];
    for (const s of seqs) (hashId(s.id) % 100 < testShare * 100 ? test : train).push(s);
    return { train, test };
  };

  // w1/w15 need Hard reviews and w3/w16 need Easy reviews to be constrained by the data at all.
  function frozen(seqs) {
    const first = { 2: 0, 4: 0 }, later = { 2: 0, 4: 0 };
    for (const q of seqs) q.g.forEach((g, i) => { if (g === 2 || g === 4) (i === 0 ? first : later)[g]++; });
    const out = [];
    if (first[2] < MIN_GRADE_EVENTS) out.push(1);
    if (first[4] < MIN_GRADE_EVENTS) out.push(3);
    if (later[2] < MIN_GRADE_EVENTS) out.push(15);
    if (later[4] < MIN_GRADE_EVENTS) out.push(16);
    return out;
  }

  // ----- FSRS-6 memory model -----
  // Replays events 0..upto. onScore(p, recalled) is called for every review at least a day after the previous one.
  function replay(seq, w, onScore, upto = seq.g.length - 1) {
    const decay = -w[20], factor = Math.exp(Math.log(0.9) / decay) - 1;
    const d0easy = w[4] - Math.exp(3 * w[5]) + 1;
    let d = 0, s = 0;
    for (let i = 0; i <= upto; i++) {
      const g = seq.g[i];
      if (i === 0) {
        s = Math.max(w[g - 1], 0.1);
        d = clamp(w[4] - Math.exp((g - 1) * w[5]) + 1, 1, 10);
        continue;
      }
      const t = seq.dt[i], r = Math.pow(1 + factor * t / s, decay);
      if (t >= 1 && onScore) onScore(r, g !== 1 ? 1 : 0);
      let ns;
      if (t === 0) {
        const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
        ns = clamp(s * (g >= 2 ? Math.max(sinc, 1) : sinc), S_MIN, S_MAX);
      } else if (g === 1) {
        const sf = clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX);
        ns = clamp(s / Math.exp(w[17] * w[18]), S_MIN, sf);
      } else {
        ns = clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1)), S_MIN, S_MAX);
      }
      const nd = d + (-w[6] * (g - 3)) * (10 - d) / 9;
      d = clamp(w[7] * d0easy + (1 - w[7]) * nd, 1, 10);
      s = ns;
    }
    return { d, s };
  }

  // Log loss plus a calibration error: predicted vs observed recall in 20 probability bins.
  function evaluate(seqs, w) {
    const bins = Array.from({ length: 20 }, () => ({ n: 0, p: 0, y: 0 }));
    let sum = 0, n = 0;
    const score = (p, y) => {
      p = clamp(p, EPS, 1 - EPS); sum -= y ? Math.log(p) : Math.log(1 - p); n++;
      const b = bins[Math.min(19, Math.floor(p * 20))]; b.n++; b.p += p; b.y += y;
    };
    for (const q of seqs) replay(q, w, score);
    let se = 0;
    for (const b of bins) if (b.n) se += b.n * (b.p / b.n - b.y / b.n) ** 2;
    return { loss: n ? sum / n : 0, rmse: n ? Math.sqrt(se / n) : 0, n };
  }

  // Paired comparison on the same reviews: mean loss saved by B over A and its standard error.
  // improvement > 0 means B predicts better; improvement / se is how many standard errors that is.
  function compare(seqs, wA, wB) {
    const loss = w => { const out = []; for (const q of seqs) replay(q, w, (p, y) => { p = clamp(p, EPS, 1 - EPS); out.push(-(y ? Math.log(p) : Math.log(1 - p))); }); return out; };
    const a = loss(wA), b = loss(wB), n = a.length;
    if (n < 2) return { improvement: 0, se: Infinity, z: 0, n };
    const d = a.map((x, i) => x - b[i]), mean = d.reduce((s, x) => s + x, 0) / n;
    const se = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) / n);
    return { improvement: mean, se, z: se > 0 ? mean / se : 0, n };
  }

  // ----- cross-validation -----
  const metrics = (ps, ys) => {
    const bins = Array.from({ length: 20 }, () => ({ n: 0, p: 0, y: 0 }));
    let sum = 0;
    ps.forEach((p, i) => { p = clamp(p, EPS, 1 - EPS); sum -= ys[i] ? Math.log(p) : Math.log(1 - p); const b = bins[Math.min(19, Math.floor(p * 20))]; b.n++; b.p += p; b.y += ys[i]; });
    let se = 0; for (const b of bins) if (b.n) se += b.n * (b.p / b.n - b.y / b.n) ** 2;
    return { loss: ps.length ? sum / ps.length : 0, rmse: ps.length ? Math.sqrt(se / ps.length) : 0, n: ps.length };
  };
  const predictions = (seqs, w) => { const p = [], y = []; for (const q of seqs) replay(q, w, (pp, yy) => { p.push(pp); y.push(yy); }); return { p, y }; };

  // Every card is held out once: fit on 4/5 of the cards, score the current weights and the fitted ones on the
  // other 1/5, and pool all the held-out reviews. Returns how much better the fitted weights predict them, in
  // standard errors (paired over reviews). onProgress(0..1) covers the folds only.
  async function crossValidate(seqs, cur, { folds = 5, relearnSteps = 1, onProgress, cancelled } = {}) {
    const groups = Array.from({ length: folds }, () => []);
    for (const s of seqs) groups[hashId(s.id) % folds].push(s);
    const pa = [], pb = [], ys = [], d = [];
    for (let f = 0; f < folds; f++) {
      const train = groups.flatMap((g, i) => (i === f ? [] : g));
      const fit = await optimize(train, { relearnSteps, cancelled, onProgress: (i, n) => onProgress?.((f + i / n) / folds) });
      if (!fit) return null;
      const A = predictions(groups[f], cur), B = predictions(groups[f], fit.w);
      A.p.forEach((p, i) => {
        const ll = x => -(A.y[i] ? Math.log(clamp(x, EPS, 1 - EPS)) : Math.log(1 - clamp(x, EPS, 1 - EPS)));
        d.push(ll(p) - ll(B.p[i])); pa.push(p); pb.push(B.p[i]); ys.push(A.y[i]);
      });
    }
    const n = d.length, mean = n ? d.reduce((s, x) => s + x, 0) / n : 0;
    const se = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) / n) : Infinity;
    return { before: metrics(pa, ys), after: metrics(pb, ys), improvement: mean, se, z: se > 0 && Number.isFinite(se) ? mean / se : 0, n };
  }

  // ----- training items -----
  function buildItems(seqs) {
    const items = [];
    for (const seq of seqs) {
      let lt = 0, firstLT = 0;
      for (let k = 1; k < seq.g.length; k++) {
        if (seq.dt[k] < 1) continue;
        if (!lt++) firstLT = seq.dt[k];
        items.push({ seq, k, label: seq.g[k] !== 1 ? 1 : 0, t: seq.t[k], len: k + 1, lt, firstRating: seq.g[0], firstLT });
      }
    }
    return items;
  }

  // Drops rare (first rating, first interval) buckets. Returns the items to pretrain on and to train on.
  function filterOutliers(items) {
    const init = items.filter(it => it.lt === 1);
    const groups = new Map();
    for (const it of init) {
      if (!groups.has(it.firstRating)) groups.set(it.firstRating, new Map());
      const m = groups.get(it.firstRating);
      if (!m.has(it.firstLT)) m.set(it.firstLT, []);
      m.get(it.firstLT).push(it);
    }
    const removed = Array.from({ length: 5 }, () => new Set()), kept = [];
    for (const rating of [...groups.keys()].sort((a, b) => a - b)) {
      const subs = [...groups.get(rating)].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);
      const total = subs.reduce((s, [, v]) => s + v.length, 0);
      let gone = 0;
      for (const [dt, its] of subs.reverse()) {
        if (gone + its.length >= Math.max(20, Math.floor(total / 20))) {
          if (its.length < 6 || dt > (rating !== 4 ? 100 : 365)) removed[rating].add(dt); else kept.push(...its);
        } else { gone += its.length; removed[rating].add(dt); }
      }
    }
    return { init: kept, train: items.filter(it => !removed[it.firstRating].has(it.firstLT)) };
  }

  // ----- pretraining of w0-w3 -----
  function searchS0(data, averageRecall, defaultS0) {
    const w0 = F.generatorParameters().w, decay = -w0[20], factor = Math.pow(0.9, 1 / decay) - 1;
    const rows = data.map(d => ({ dt: d.dt, n: d.n, recall: (d.recall * d.n + averageRecall) / (d.n + 1) }));   // Laplace smoothing
    const loss = s => rows.reduce((sum, r) => {
      const p = Math.pow(1 + factor * r.dt / s, decay);
      return sum - (r.recall * Math.log(p) + (1 - r.recall) * Math.log(1 - p)) * r.n;
    }, 0) + Math.abs(s - defaultS0) / 16;
    let lo = S_MIN, hi = INIT_S_MAX, best = defaultS0;
    for (let i = 0; i < 1000 && hi - lo > 1e-12; i++) {   // ternary search
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (loss(m1) < loss(m2)) hi = m2; else lo = m1;
      best = (hi + lo) / 2;
    }
    return best;
  }

  // Makes the four initial stabilities increase with the rating and fills in ratings with no data.
  function smoothAndFill(stab, count) {
    const def = F.generatorParameters().w, st = {};
    for (const k of [1, 2, 3, 4]) if (count[k] !== undefined && stab[k] !== undefined) st[k] = stab[k];
    for (const [a, b] of [[1, 2], [2, 3], [3, 4], [1, 3], [2, 4], [1, 4]])
      if (st[a] !== undefined && st[b] !== undefined && st[a] > st[b]) { if (count[a] > count[b]) st[b] = st[a]; else st[a] = st[b]; }
    const w1 = 0.41, w2 = 0.54, keys = Object.keys(st).length;
    let r = [null, st[1], st[2], st[3], st[4]];
    if (keys === 0) return null;
    if (keys === 1) {
      const k = +Object.keys(st)[0], f = st[k] / def[k - 1];
      return def.slice(0, 4).map(x => x * f).sort((a, b) => a - b).map(v => clamp(v, S_MIN, INIT_S_MAX));
    }
    const has = (...ix) => [1, 2, 3, 4].every(i => (ix.includes(i)) === (r[i] != null));
    const [, r1, r2, r3, r4] = r, den = w1 + w2 - w1 * w2;
    if (keys === 2) {
      if (has(3, 4)) { r[2] = Math.pow(r3, 1 / (1 - w2)) * Math.pow(r4, 1 - 1 / (1 - w2)); r[1] = Math.pow(r[2], 1 / w1) * Math.pow(r3, 1 - 1 / w1); }
      else if (has(2, 4)) { r[3] = Math.pow(r2, 1 - w2) * Math.pow(r4, w2); r[1] = Math.pow(r2, 1 / w1) * Math.pow(r[3], 1 - 1 / w1); }
      else if (has(2, 3)) { r[4] = Math.pow(r2, 1 - 1 / w2) * Math.pow(r3, 1 / w2); r[1] = Math.pow(r2, 1 / w1) * Math.pow(r3, 1 - 1 / w1); }
      else if (has(1, 4)) { r[2] = Math.pow(r1, w1 / den) * Math.pow(r4, 1 - w1 / den); r[3] = Math.pow(r1, 1 - w2 / den) * Math.pow(r4, w2 / den); }
      else if (has(1, 3)) { r[2] = Math.pow(r1, w1) * Math.pow(r3, 1 - w1); r[4] = Math.pow(r[2], 1 - 1 / w2) * Math.pow(r3, 1 / w2); }
      else if (has(1, 2)) { r[3] = Math.pow(r1, 1 - 1 / (1 - w1)) * Math.pow(r2, 1 / (1 - w1)); r[4] = Math.pow(r2, 1 - 1 / w2) * Math.pow(r[3], 1 / w2); }
    } else if (keys === 3) {
      if (r[1] == null) r[1] = Math.pow(r2, 1 / w1) * Math.pow(r3, 1 - 1 / w1);
      else if (r[2] == null) r[2] = Math.pow(r1, w1) * Math.pow(r3, 1 - w1);
      else if (r[3] == null) r[3] = Math.pow(r2, 1 - w2) * Math.pow(r4, w2);
      else if (r[4] == null) r[4] = Math.pow(r2, 1 - 1 / w2) * Math.pow(r3, 1 / w2);
    }
    return [1, 2, 3, 4].map(i => clamp(r[i] ?? def[i - 1], S_MIN, INIT_S_MAX));
  }

  function pretrain(initItems, averageRecall) {
    const by = {};
    for (const it of initItems) ((by[it.firstRating] ??= {})[it.firstLT] ??= []).push(it.label);
    const def = F.generatorParameters().w, stab = {}, count = {};
    for (const [rating, m] of Object.entries(by)) {
      const data = Object.entries(m).map(([dt, ys]) => ({ dt: +dt, n: ys.length, recall: ys.reduce((a, b) => a + b, 0) / ys.length })).sort((a, b) => a.dt - b.dt);
      stab[rating] = searchS0(data, averageRecall, def[rating - 1]);
      count[rating] = data.reduce((s, d) => s + d.n, 0);
    }
    return { s0: smoothAndFill(stab, count), count };
  }

  // ----- training -----
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  async function optimize(seqs, { relearnSteps = 1, onProgress, cancelled } = {}) {
    const def = F.generatorParameters().w;
    const items = buildItems(seqs).sort((a, b) => a.t - b.t);
    if (items.length < 8) return { w: def.slice(), trained: false };
    const { init, train } = filterOutliers(items);
    const averageRecall = train.length ? train.reduce((s, it) => s + it.label, 0) / train.length : 0;
    const pre = pretrain(init, averageRecall);
    if (!pre.s0) return { w: def.slice(), trained: false };
    const clip = w => F.clipParameters(Array.from(w), relearnSteps, true);
    const start = clip([...pre.s0, ...def.slice(4)]);
    if (train.length === init.length || train.length < 64) return { w: start.map(round4), trained: false };

    const n = train.length;
    const weighted = train.map((it, i) => ({ it, wt: 0.25 + 0.75 * Math.pow(i / Math.max(n - 1, 1), 3) }));
    weighted.sort((a, b) => a.it.len - b.it.len);                       // batches of similar history length
    const batches = []; for (let i = 0; i < n; i += BATCH) batches.push(weighted.slice(i, i + BATCH));
    const noData = frozen(seqs), active = start.map((_, i) => !noData.includes(i));   // weights no review can move have zero gradient
    const total = (Math.floor(n / BATCH) + 1) * EPOCHS, rand = mulberry32(2023);
    const m = new Float64Array(21), v = new Float64Array(21);
    let w = start.slice(), step = 0;

    const batchLoss = (wv, batch) => {
      const decay = -wv[20], factor = Math.exp(Math.log(0.9) / decay) - 1;
      let sum = 0;
      for (const { it, wt } of batch) {
        let p = 0;
        replay(it.seq, wv, (pp) => { p = pp; }, it.k);   // the last scored review of the prefix is the item itself
        p = clamp(p, EPS, 1 - EPS);
        sum -= wt * (it.label ? Math.log(p) : Math.log(1 - p));
      }
      return sum;
    };

    for (let epoch = 1; epoch <= EPOCHS; epoch++) {
      const order = batches.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (const bi of order) {
        if (cancelled?.()) return null;
        const batch = batches[bi], scale = L2 * batch.length / n;
        const grad = new Float64Array(21);
        for (let i = 0; i < 21; i++) {
          if (!active[i]) continue;
          const h = 1e-3 * Math.max(Math.abs(w[i]), 0.1);
          const up = w.slice(), dn = w.slice(); up[i] += h; dn[i] -= h;
          const g = (batchLoss(up, batch) - batchLoss(dn, batch)) / (2 * h);
          grad[i] = (Number.isFinite(g) ? g : 0) + 2 * (w[i] - start[i]) / (STDDEV[i] * STDDEV[i]) * scale;
        }
        step++;
        const lr = LR * (1 + Math.cos(Math.PI * (step - 1) / total)) / 2;   // cosine annealing
        for (let i = 0; i < 21; i++) {
          m[i] = B1 * m[i] + (1 - B1) * grad[i];
          v[i] = B2 * v[i] + (1 - B2) * grad[i] * grad[i];
          w[i] -= lr * (m[i] / (1 - Math.pow(B1, step))) / (Math.sqrt(v[i] / (1 - Math.pow(B2, step))) + ADAM_EPS);
        }
        w = clip(w);
        if (onProgress) { onProgress(step, total); await new Promise(r => setTimeout(r)); }
      }
    }
    const s0 = smoothAndFill({ 1: w[0], 2: w[1], 3: w[2], 4: w[3] }, pre.count) ?? w.slice(0, 4);
    return { w: [...s0, ...w.slice(4)].map(round4), trained: true };
  }
  const round4 = x => Math.round(x * 1e4) / 1e4;

  // Replays a few cards through the real ts-fsrs scheduler and compares the memory state with this file's
  // model. Guards against a ts-fsrs update that changed the formulas.
  function selfCheck(seqs, w, steps = {}) {
    const f = F.fsrs(F.generatorParameters({ w, enable_fuzz: false, ...steps }));
    let worst = 0, checked = 0;
    for (const q of seqs.filter(q => q.g.length >= 3).slice(0, 40)) {
      let card = F.createEmptyCard(new Date(q.t[0]));
      for (let i = 0; i < q.g.length; i++) card = f.next(card, new Date(q.t[i]), q.g[i]).card;
      const mine = replay(q, F.clipParameters(Array.from(w), (steps.relearning_steps ?? ['10m']).length, true));
      worst = Math.max(worst, Math.abs(card.stability - mine.s) / card.stability, Math.abs(card.difficulty - mine.d) / card.difficulty);
      checked++;
    }
    return { worst, checked };
  }

  return { prepare, split, evaluate, compare, crossValidate, optimize, selfCheck, frozen };
};
