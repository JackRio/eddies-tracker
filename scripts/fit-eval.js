// Diagnostic: fit a position score to self-play outcomes (logistic regression, "Texel tuning").
// Not used by any bot: driving greedy with it made it stop playing cards (a card in hand predicts
// winning more than the same card on the field). Kept for value-net work; see CLAUDE.md.
//   node scripts/fit-eval.js [data.jsonl ...] [--out src/bot/eval-weights.json] [--l2 X]
// Splits by game (80/20), reports held-out log loss for the hand-tuned score vs the fitted one,
// and writes { names, mean, std, w, b } (nothing reads it yet).
'use strict';
const fs = require('fs');
const path = require('path');
const { NAMES } = require('../src/bot/features');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!files.length) files.push(path.join(__dirname, '..', 'notes', 'bot-data.jsonl'));
const out = flag('--out', path.join(__dirname, '..', 'src', 'bot', 'eval-weights.json'));
const l2 = +flag('--l2', 1e-4);

const train = [], test = [];
for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!line) continue;
  const { g, rows } = JSON.parse(line);
  (g % 5 === 0 ? test : train).push(...rows);
}
const D = NAMES.length;
const mean = Array(D).fill(0), std = Array(D).fill(0);
for (const [x] of train) x.forEach((v, i) => { mean[i] += v; });
mean.forEach((_, i) => { mean[i] /= train.length; });
for (const [x] of train) x.forEach((v, i) => { std[i] += (v - mean[i]) ** 2; });
std.forEach((_, i) => { std[i] = Math.sqrt(std[i] / train.length) || 1; });
const norm = x => x.map((v, i) => (v - mean[i]) / std[i]);
const Xtr = train.map(([x, y]) => [norm(x), y]), Xte = test.map(([x, y]) => [norm(x), y]);

const sig = z => 1 / (1 + Math.exp(-z));
const ll = (p, y) => -(y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9)));

// baseline: best a*ev + c for the hand-tuned score
let a = 1 / 22, c = 0;
for (let it = 0; it < 300; it++) {
  let ga = 0, gc = 0;
  for (const [, y, ev] of train) { const e = sig(a * ev + c) - y; ga += e * ev; gc += e; }
  a -= 1e-5 * ga / train.length * 100; c -= 0.5 * gc / train.length;
}
const baseLL = test.reduce((s, [, y, ev]) => s + ll(sig(a * ev + c), y), 0) / test.length;
const base22 = test.reduce((s, [, y, ev]) => s + ll(sig(ev / 22), y), 0) / test.length;

// fitted: full-batch gradient descent with Adam
let w = Array(D).fill(0), b0 = 0;
const m = Array(D + 1).fill(0), v = Array(D + 1).fill(0);
for (let it = 1; it <= 600; it++) {
  const g = Array(D + 1).fill(0);
  for (const [x, y] of Xtr) {
    let z = b0; for (let i = 0; i < D; i++) z += w[i] * x[i];
    const e = sig(z) - y;
    for (let i = 0; i < D; i++) g[i] += e * x[i];
    g[D] += e;
  }
  for (let i = 0; i <= D; i++) {
    let gi = g[i] / Xtr.length + (i < D ? l2 * w[i] : 0);
    m[i] = 0.9 * m[i] + 0.1 * gi; v[i] = 0.999 * v[i] + 0.001 * gi * gi;
    const step = 0.05 * (m[i] / (1 - 0.9 ** it)) / (Math.sqrt(v[i] / (1 - 0.999 ** it)) + 1e-8);
    if (i < D) w[i] -= step; else b0 -= step;
  }
}
const pred = x => { let z = b0; for (let i = 0; i < D; i++) z += w[i] * x[i]; return sig(z); };
const fitLL = Xte.reduce((s, [x, y]) => s + ll(pred(x), y), 0) / Xte.length;
const acc = (f, X) => X.filter(r => (f(r) > 0.5) === !!r[1]).length / X.length;

console.log(`rows: ${train.length} train, ${test.length} test (held-out games)`);
console.log(`log loss  coin flip 0.693 | hand-tuned /22 ${base22.toFixed(4)} | hand-tuned rescaled ${baseLL.toFixed(4)} | fitted ${fitLL.toFixed(4)}`);
console.log(`accuracy  hand-tuned ${(100 * acc(([, , ev]) => sig(a * ev + c), test)).toFixed(1)}% | fitted ${(100 * acc(([x]) => pred(x), Xte)).toFixed(1)}%`);
const top = NAMES.map((n, i) => [n, w[i] / std[i]]).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
console.log('weights per raw unit (largest first):\n  ' + top.map(([n, x]) => `${n} ${x.toFixed(3)}`).join('\n  '));
fs.writeFileSync(out, JSON.stringify({ names: NAMES, mean, std, w, b: b0, testLogLoss: fitLL, rows: train.length }, null, 1));
console.log(`wrote ${path.relative(process.cwd(), out)}`);
