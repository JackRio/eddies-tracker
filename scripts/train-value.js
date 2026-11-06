// Re-tune the value net on new positions in plain Node (no PyTorch needed - the laptop has none).
//   node scripts/train-value.js <rows.jsonl ...> [--init src/bot/value-net.json] [--out file]
//        [--epochs 6] [--lr 3e-4] [--batch 64] [--l2 1e-5] [--hold 10]
// Same model and file format as scripts/train-value.py / src/bot/value.js:
//   h = relu(Wd*norm(dense) + sum(n * E[card-zone]) + b1), h2 = relu(W2 h + b2), p = sigmoid(w3 h2 + b3)
// Starts from --init (its weights and input normalization), trains with Adam on binary cross-entropy,
// holds out every --hold-th game, keeps the epoch with the best held-out log loss, and prints the
// starting net's held-out numbers next to the result so you see whether it helped.
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const init = flag('--init', path.join(__dirname, '..', 'src', 'bot', 'value-net.json'));
const out = flag('--out', path.join(__dirname, '..', 'notes', 'value-net-tuned.json'));
const EPOCHS = +flag('--epochs', 6), LR = +flag('--lr', 3e-4), BATCH = +flag('--batch', 64), L2 = +flag('--l2', 1e-5), HOLD = +flag('--hold', 10);

const J = JSON.parse(fs.readFileSync(init, 'utf8'));
const D = J.dense, H = J.b1.length, H2 = J.b2.length, NSP = J.sparse;
const f32 = a => Float32Array.from(a.flat());
const W = { Wd: f32(J.Wd), b1: f32(J.b1), E: f32(J.E), W2: f32(J.W2), b2: f32(J.b2), w3: f32(J.w3), b3: Float32Array.of(J.b3) };
const mean = f32(J.mean), std = f32(J.std);

// data: [{ y, x: Float32Array(D) normalized, sp: [[row, n]] , test }]
const rows = [];
for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const o = JSON.parse(line);
  const test = Math.abs(o.g) % HOLD === 0;
  for (const [y, d, s] of o.rows) {
    const x = new Float32Array(D);
    for (let i = 0; i < D; i++) x[i] = (d[i] - mean[i]) / std[i];
    rows.push({ y, x, sp: s.map(([i, n]) => [(i - D) * H, n]), test });
  }
}
const train = rows.filter(r => !r.test), test = rows.filter(r => r.test);
console.log(`${rows.length} positions (${test.length} held out), net ${D}+${NSP} -> ${H} -> ${H2} -> 1, from ${path.basename(init)}`);

const h = new Float32Array(H), a2 = new Float32Array(H2), h2 = new Float32Array(H2);
function forward(r) {
  h.set(W.b1);
  for (let i = 0; i < D; i++) { const x = r.x[i]; if (x !== 0) for (let k = 0, o = i; k < H; k++, o += D) h[k] += W.Wd[o] * x; }
  for (const [row, n] of r.sp) for (let k = 0; k < H; k++) h[k] += n * W.E[row + k];
  for (let k = 0; k < H; k++) if (h[k] < 0) h[k] = 0;
  let z = W.b3[0];
  for (let m = 0; m < H2; m++) {
    let a = W.b2[m];
    for (let k = 0, o = m * H; k < H; k++) a += W.W2[o + k] * h[k];
    a2[m] = a; h2[m] = a > 0 ? a : 0; z += W.w3[m] * h2[m];
  }
  return z;
}
const sig = z => 1 / (1 + Math.exp(-z));
function evaluate(set) {
  let ll = 0, acc = 0;
  for (const r of set) { const p = Math.min(1 - 1e-7, Math.max(1e-7, sig(forward(r)))); ll -= r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p); if ((p > 0.5) === (r.y === 1)) acc++; }
  return [ll / set.length, acc / set.length];
}

// gradients (dense arrays for the small layers; E updated sparsely row by row)
const G = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Float32Array(v.length)]));
const M = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Float32Array(v.length)]));
const V = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Float32Array(v.length)]));
const touched = new Set();
const dh = new Float32Array(H);
function backward(r, g) {   // g = dLoss/dz
  W.b3; G.b3[0] += g;
  dh.fill(0);
  for (let m = 0; m < H2; m++) {
    G.w3[m] += g * h2[m];
    if (a2[m] <= 0) continue;
    const da = g * W.w3[m];
    G.b2[m] += da;
    for (let k = 0, o = m * H; k < H; k++) { G.W2[o + k] += da * h[k]; dh[k] += da * W.W2[o + k]; }
  }
  for (let k = 0; k < H; k++) if (h[k] <= 0) dh[k] = 0;
  for (let k = 0; k < H; k++) G.b1[k] += dh[k];
  for (let i = 0; i < D; i++) { const x = r.x[i]; if (x !== 0) for (let k = 0, o = i; k < H; k++, o += D) G.Wd[o] += dh[k] * x; }
  for (const [row, n] of r.sp) { touched.add(row); for (let k = 0; k < H; k++) G.E[row + k] += dh[k] * n; }
}
let t = 0;
const B1 = 0.9, B2 = 0.999, EPS = 1e-8;
function adam(name, lo = 0, hi = W[name].length) {
  const w = W[name], g = G[name], m = M[name], v = V[name];
  const c1 = 1 - B1 ** t, c2 = 1 - B2 ** t;
  for (let i = lo; i < hi; i++) {
    const gi = g[i] / BATCH + L2 * w[i];
    m[i] = B1 * m[i] + (1 - B1) * gi; v[i] = B2 * v[i] + (1 - B2) * gi * gi;
    w[i] -= LR * (m[i] / c1) / (Math.sqrt(v[i] / c2) + EPS);
    g[i] = 0;
  }
}

const [ll0, acc0] = evaluate(test), [tl0] = evaluate(train);
console.log(`start: held-out log loss ${ll0.toFixed(4)}  accuracy ${(100 * acc0).toFixed(1)}%  (train ${tl0.toFixed(4)})`);
let best = { ll: ll0, acc: acc0, ep: 0, W: Object.fromEntries(Object.entries(W).map(([k, v]) => [k, Float32Array.from(v)])) };
const t0 = Date.now();
for (let ep = 1; ep <= EPOCHS; ep++) {
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  for (let s = 0; s < train.length; s += BATCH) {
    const batch = train.slice(s, s + BATCH);
    for (const r of batch) backward(r, sig(forward(r)) - r.y);
    t++;
    for (const k of ['Wd', 'b1', 'W2', 'b2', 'w3', 'b3']) adam(k);
    for (const row of touched) adam('E', row, row + H);
    touched.clear();
  }
  const [ll, acc] = evaluate(test), [tl] = evaluate(train);
  console.log(`  epoch ${ep}/${EPOCHS}  held-out log loss ${ll.toFixed(4)}  accuracy ${(100 * acc).toFixed(1)}%  (train ${tl.toFixed(4)})  ${Math.round((Date.now() - t0) / 1000)}s`);
  if (ll < best.ll) best = { ll, acc, ep, W: Object.fromEntries(Object.entries(W).map(([k, v]) => [k, Float32Array.from(v)])) };
}
if (best.ep === 0) { console.log('no epoch beat the starting net - nothing written'); process.exit(0); }
const r5 = a => Array.from(a, x => Math.round(x * 1e5) / 1e5);
const re2 = (a, rowsN, cols) => Array.from({ length: rowsN }, (_, i) => r5(a.subarray(i * cols, (i + 1) * cols)));
const outJ = { ...J, Wd: re2(best.W.Wd, H, D), b1: r5(best.W.b1), E: re2(best.W.E, NSP, H), W2: re2(best.W.W2, H2, H), b2: r5(best.W.b2), w3: r5(best.W.w3), b3: best.W.b3[0],
  checks: [], heldOutLogLoss: best.ll, heldOutAccuracy: best.acc, tunedFrom: path.basename(init), tunedOn: train.length, tunedAt: new Date().toISOString() };
fs.writeFileSync(out, JSON.stringify(outJ));
console.log(`best epoch ${best.ep}: held-out ${best.ll.toFixed(4)} / ${(100 * best.acc).toFixed(1)}% (was ${ll0.toFixed(4)} / ${(100 * acc0).toFixed(1)}%) -> ${out}`);
