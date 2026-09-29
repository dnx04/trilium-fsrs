// Guards the "always build against the latest ts-fsrs" policy.
// 1. review.js and optimizer.js need these ts-fsrs exports.
// 2. The optimizer carries its own copy of the FSRS-6 memory model; replaying random review logs must give the
//    same stability and difficulty as the real ts-fsrs scheduler, for all four grades.
const fs = require('fs');
const path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const load = (code) => { const m = { exports: {} }; new Function('module', 'exports', 'define', code)(m, m.exports); return m.exports; };

const F = load(src('ts-fsrs.js'));
for (const name of ['fsrs', 'generatorParameters', 'createEmptyCard', 'Rating', 'clipParameters']) {
  if (F[name] === undefined) { console.error(`ts-fsrs no longer exports ${name}`); process.exit(1); }
}
if (F.generatorParameters().w.length !== 21) { console.error('ts-fsrs is no longer FSRS-6 (expected 21 weights)'); process.exit(1); }

const O = load(src('optimizer.js'))(F);
let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const logs = [];
for (let c = 0; c < 150; c++) {
  let t = Date.UTC(2026, 0, 1) + rnd() * 864e5 * 30;
  for (let k = 0; k < 9; k++) {
    const x = rnd();
    logs.push({ c: 'c' + c, t, r: x < .15 ? 1 : x < .35 ? 2 : x < .8 ? 3 : 4 });
    t += (k % 4 === 3 ? 0.005 : 1 + rnd() * 25) * 864e5;   // some same-day reviews
  }
}
const seqs = O.prepare(logs);
const w0 = F.generatorParameters().w;
const w1 = F.clipParameters(w0.map(x => x * (0.8 + 0.4 * rnd())), 1, true);
let failed = false;
for (const [name, w] of [['default weights', w0], ['perturbed weights', w1]]) {
  const { worst, checked } = O.selfCheck(seqs, w);
  const ok = worst < 1e-3;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${checked} cards, worst relative difference ${worst.toExponential(2)}`);
  if (!ok) failed = true;
}

// The optimizer must run end to end on this data without producing NaN.
(async () => {
  const res = await O.optimize(seqs, { relearnSteps: 1 });
  const ok = res.w.length === 21 && res.w.every(Number.isFinite);
  console.log(`${ok ? 'ok  ' : 'FAIL'} optimize(): ${res.w.length} finite weights`);
  if (!ok) failed = true;
  process.exit(failed ? 1 : 0);
})();
