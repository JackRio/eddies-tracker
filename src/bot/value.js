// The value net (trained by scripts/train-value.py) in plain JS: position -> the acting player's
// win chance. Weights: src/bot/value-net.json. No GPU needed at play time; one evaluation is a few
// tens of thousands of multiply-adds (~0.1 ms).
'use strict';
const fs = require('fs');
const path = require('path');
const { encode } = require('./vfeatures');
const W = require('./nnwasm');   // SIMD forward pass (plain JS below is the fallback / reference)

const FILE = path.join(__dirname, 'value-net.json');
let NET = null;

// load(file) returns a net; only the default file becomes the shared one value() uses by default
function load(file = FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const H = j.b1.length, H2 = j.b2.length, D = j.dense;
  const f32 = a => Float32Array.from(a.flat());
  const NET_ = { H, H2, D, mean: f32(j.mean), std: f32(j.std), Wd: f32(j.Wd), b1: f32(j.b1), E: f32(j.E),
    W2: f32(j.W2), b2: f32(j.b2), w3: f32(j.w3), b3: j.b3, meta: j };
  const net = NET_;
  net.w = W.packValue(net);
  if (path.resolve(file) === path.resolve(FILE)) NET = net;
  return net;
}

// dense: number[D]; sparse: [[index (>= D), count], ...] as vfeatures.encode returns
function forward(dense, sparse, net = NET || load()) {
  if (net.w) return W.forwardValue(dense, sparse, net);
  const { H, H2, D, mean, std, Wd, b1, E, W2, b2, w3, b3 } = net;
  const h = Float32Array.from(b1);
  for (let i = 0; i < D; i++) {
    const x = (dense[i] - mean[i]) / std[i];
    if (x === 0) continue;
    for (let k = 0, o = i; k < H; k++, o += D) h[k] += Wd[o] * x;   // Wd is [H][D]
  }
  for (const [idx, n] of sparse) {
    const row = (idx - D) * H;
    for (let k = 0; k < H; k++) h[k] += n * E[row + k];
  }
  for (let k = 0; k < H; k++) if (h[k] < 0) h[k] = 0;
  let z = b3;
  for (let m = 0; m < H2; m++) {
    let a = b2[m];
    for (let k = 0, o = m * H; k < H; k++) a += W2[o + k] * h[k];
    if (a > 0) z += w3[m] * a;
  }
  return 1 / (1 + Math.exp(-z));
}

// win chance for `pid` at board `b` (1/0 if the game is over)
function value(b, pid, net) {
  if (b.winner) return b.winner === pid ? 1 : 0;
  const N = net || NET || load();
  const x = encode(b, pid, N.D);   // a Gig-language net takes more dense inputs (vfeatures DENSE_GIG)
  return forward(x.dense, x.sparse, N);
}

// compare against the PyTorch outputs stored with the weights; returns the largest difference
function selfCheck(file = FILE) {
  const net = load(file);
  let worst = 0;
  for (const c of net.meta.checks || []) worst = Math.max(worst, Math.abs(forward(c.dense, c.sparse, net) - c.p));
  return worst;
}

module.exports = { value, forward, load, selfCheck, FILE };
if (require.main === module) {
  const d = selfCheck(process.argv[2] || FILE);
  console.log(`value net self-check (${W.enabled ? 'wasm SIMD' : 'plain JS'}): max |js - torch| = ${d.toExponential(2)} ${d < 1e-3 ? 'OK' : 'MISMATCH'} (weights are stored to 5 decimals, so ~1e-4 is expected)`);
}
