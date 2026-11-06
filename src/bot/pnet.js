// The policy ("intuition") net (trained by scripts/train-policy.py) in plain JS: scores every legal
// move at a decision, so the strong bot shortlists by learned intuition instead of the greedy
// one-move heuristic (strong option prior=net). Weights: src/bot/policy-net.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { encode } = require('./vfeatures');
const { encodeMove } = require('./menc');

const FILE = path.join(__dirname, 'policy-net.json');
let NET = null;

function load(file = FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const f32 = a => Float32Array.from(a.flat());
  const net = { H: j.b1.length, MH: j.s2b.length, D: j.dense, mean: f32(j.mean), std: f32(j.std), Wd: f32(j.Wd), b1: f32(j.b1),
    E: f32(j.E), S2: f32(j.S2), s2b: f32(j.s2b), M: f32(j.M), mb: f32(j.mb), J: f32(j.J), jb: f32(j.jb), o: f32(j.o), ob: j.ob, meta: j };
  if (path.resolve(file) === path.resolve(FILE)) NET = net;   // only the default file is shared
  return net;
}

// state part, once per decision -> Float32Array(MH)
function stateVec(dense, sparse, net) {
  const { H, MH, D, mean, std, Wd, b1, E, S2, s2b } = net;
  const h = Float32Array.from(b1);
  for (let i = 0; i < D; i++) {
    const x = (dense[i] - mean[i]) / std[i];
    if (x !== 0) for (let k = 0, o = i; k < H; k++, o += D) h[k] += Wd[o] * x;
  }
  for (const [idx, n] of sparse) { const row = (idx - D) * H; for (let k = 0; k < H; k++) h[k] += n * E[row + k]; }
  for (let k = 0; k < H; k++) if (h[k] < 0) h[k] = 0;
  const s = Float32Array.from(s2b);
  for (let m = 0; m < MH; m++) { let a = s[m]; for (let k = 0, o = m * H; k < H; k++) a += S2[o + k] * h[k]; s[m] = a; }
  return s;
}

function moveLogit(s, menc, net) {
  const { MH, M, mb, J, jb, o, ob } = net;
  const u = new Float32Array(MH);
  for (let k = 0; k < MH; k++) u[k] = s[k] + mb[k];
  for (const [i, w] of menc) { const row = i * MH; for (let k = 0; k < MH; k++) u[k] += w * M[row + k]; }
  for (let k = 0; k < MH; k++) if (u[k] < 0) u[k] = 0;
  let z = ob;
  for (let m = 0; m < MH; m++) { let a = jb[m]; for (let k = 0, q = m * MH; k < MH; k++) a += J[q + k] * u[k]; if (a > 0) z += o[m] * a; }
  return z;
}

// logits for a list of macro moves (arrays of engine actions) at board b for player pid.
// granks: each move's greedy rank (nets trained with the greedy-rank input need it; else ignored)
function logits(b, pid, seqs, net = NET || load(), granks = null) {
  const x = encode(b, pid);
  const s = stateVec(x.dense, x.sparse, net);
  const g = net.meta.grank;
  return seqs.map((seq, i) => {
    const m = encodeMove(b, pid, seq);
    if (g) m.push([g + Math.min(granks ? granks[i] : i, 15), 1]);
    return moveLogit(s, m, net);
  });
}

// strong.js prior hook: R = [{ seq, s }] (greedy-ranked) -> the same items, best intuition first
function rank(b, wf, me, R, net) {
  const z = logits(b, me, R.map(x => x.seq), net || NET || load(), R.map((_, i) => i));
  return R.map((x, i) => ({ x, z: z[i] })).sort((a, c) => c.z - a.z).map(y => y.x);
}

function selfCheck(file = FILE) {
  const net = load(file);
  let worst = 0;
  for (const c of net.meta.checks || []) {
    const s = stateVec(c.dense, c.sparse, net);
    c.moves.forEach((m, i) => { worst = Math.max(worst, Math.abs(moveLogit(s, m, net) - c.logits[i])); });
  }
  return worst;
}

module.exports = { logits, rank, load, selfCheck, FILE };
if (require.main === module) {
  const d = selfCheck(process.argv[2] || FILE);
  console.log(`policy net self-check: max |js - torch| logit = ${d.toExponential(2)} ${d < 2e-3 ? 'OK' : 'MISMATCH'} (5-decimal weights)`);
}
