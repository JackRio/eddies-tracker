// The policy ("intuition") net (trained by scripts/train-policy.py) in plain JS: scores every legal
// move at a decision, so the strong bot shortlists by learned intuition instead of the greedy
// one-move heuristic (strong option prior=net). Weights: src/bot/policy-net.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { encode } = require('./vfeatures');
const { encodeMove, GIG_FROM, SIZE: MSIZE_NOW } = require('./menc');
const W = require('./nnwasm');   // SIMD forward pass (plain JS below is the fallback / reference)

const FILE = path.join(__dirname, 'policy-net.json');
let NET = null;

function load(file = FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const f32 = a => Float32Array.from(a.flat());
  const net = { H: j.b1.length, MH: j.s2b.length, D: j.dense, mean: f32(j.mean), std: f32(j.std), Wd: f32(j.Wd), b1: f32(j.b1),
    E: f32(j.E), S2: f32(j.S2), s2b: f32(j.s2b), M: f32(j.M), mb: f32(j.mb), J: f32(j.J), jb: f32(j.jb), o: f32(j.o), ob: j.ob, meta: j };
  // Wd stored [hidden][dense]; a [dense][hidden] copy lets stateVec read it in order (same sums, same order)
  const WdT = new Float32Array(net.Wd.length);
  for (let k = 0; k < net.H; k++) for (let i = 0; i < net.D; i++) WdT[i * net.H + k] = net.Wd[k * net.D + i];
  net.WdT = WdT;
  net.nz = new Int32Array(Math.max(net.H, net.MH));   // scratch: indices of non-zero ReLU outputs
  net.w = W.packPolicy(net);
  if (path.resolve(file) === path.resolve(FILE)) NET = net;   // only the default file is shared
  return net;
}

// state part, once per decision -> Float32Array(MH)
function stateVec(dense, sparse, net) {
  const { H, MH, D, mean, std, WdT, b1, E, S2, s2b, nz } = net;
  const h = Float32Array.from(b1);
  for (let i = 0; i < D; i++) {
    const x = (dense[i] - mean[i]) / std[i];
    if (x !== 0) for (let k = 0, o = i * H; k < H; k++) h[k] += WdT[o + k] * x;
  }
  for (const [idx, n] of sparse) { const row = (idx - D) * H; for (let k = 0; k < H; k++) h[k] += n * E[row + k]; }
  // ReLU, keeping only the non-zero entries (a zero adds nothing - the sums come out exactly the same)
  let cnt = 0;
  for (let k = 0; k < H; k++) if (h[k] > 0) nz[cnt++] = k;
  const s = Float32Array.from(s2b);
  for (let m = 0; m < MH; m++) { let a = s[m]; const o = m * H; for (let t = 0; t < cnt; t++) { const k = nz[t]; a += S2[o + k] * h[k]; } s[m] = a; }
  return s;
}

function moveLogit(s, menc, net) {
  const { MH, M, mb, J, jb, o, ob, nz } = net;
  const u = new Float32Array(MH);
  for (let k = 0; k < MH; k++) u[k] = s[k] + mb[k];
  for (const [i, w] of menc) { const row = i * MH; for (let k = 0; k < MH; k++) u[k] += w * M[row + k]; }
  let cnt = 0;
  for (let k = 0; k < MH; k++) if (u[k] > 0) nz[cnt++] = k;   // ReLU: only non-zero entries contribute
  let z = ob;
  for (let m = 0; m < MH; m++) { let a = jb[m]; const q = m * MH; for (let t = 0; t < cnt; t++) { const k = nz[t]; a += J[q + k] * u[k]; } if (a > 0) z += o[m] * a; }
  return z;
}

// logits for a list of macro moves (arrays of engine actions) at board b for player pid.
// granks: each move's greedy rank (nets trained with the greedy-rank input need it; else ignored)
function logits(b, pid, seqs, net = NET || load(), granks = null) {
  const x = encode(b, pid);
  const s = net.w ? (W.stateVecW(x.dense, x.sparse, net), null) : stateVec(x.dense, x.sparse, net);
  const g = net.meta.grank;
  return seqs.map((seq, i) => {
    let m = encodeMove(b, pid, seq);
    if (!net.meta.gigMoves) m = m.filter(([k]) => k < GIG_FROM || k >= MSIZE_NOW);   // trained before the Gig slots existed
    if (g) m.push([g + Math.min(granks ? granks[i] : i, 15), 1]);
    return net.w ? W.moveLogitW(m, net) : moveLogit(s, m, net);
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
    const s = net.w ? (W.stateVecW(c.dense, c.sparse, net), null) : stateVec(c.dense, c.sparse, net);
    c.moves.forEach((m, i) => { worst = Math.max(worst, Math.abs((net.w ? W.moveLogitW(m, net) : moveLogit(s, m, net)) - c.logits[i])); });
  }
  return worst;
}

module.exports = { logits, rank, load, selfCheck, FILE };
if (require.main === module) {
  const d = selfCheck(process.argv[2] || FILE);
  console.log(`policy net self-check (${W.enabled ? 'wasm SIMD' : 'plain JS'}): max |js - torch| logit = ${d.toExponential(2)} ${d < 2e-3 ? 'OK' : 'MISMATCH'} (5-decimal weights)`);
}
