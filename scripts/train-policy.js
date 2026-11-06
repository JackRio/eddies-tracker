// Re-tune the policy ("intuition") net on league decisions in plain Node (no PyTorch on the laptop).
//   node scripts/train-policy.js <league data-*.jsonl ...> [--init src/bot/policy-net.json] [--out file]
//        [--epochs 4] [--lr 2e-4] [--batch 32] [--tau 0.03] [--teach-only] [--informative-only]
// Same model and format as scripts/train-policy.py / src/bot/pnet.js:
//   st = relu(Wd*norm(dense) + sum(n * E[card-zone]) + b1);  s = S2 st + s2b
//   per move: u = relu(s + mb + sum(w * M[feature])),  v = relu(J u + jb),  logit = o.v + ob
// Target: softmax(search value / tau) over the moves the search tried (teacher values where the
// teacher re-scored the decision). Which decisions train:
//   --teach-only        only teacher re-scored decisions (the cleanest labels)
//   --informative-only  only decisions whose best value is 5-95% and the top two >= 1 point apart
// Prints held-out agreement with the search's best move and regret, for the starting net and after.
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const init = flag('--init', path.join(__dirname, '..', 'src', 'bot', 'policy-net.json'));
const out = flag('--out', path.join(__dirname, '..', 'notes', 'policy-net-tuned.json'));
const EPOCHS = +flag('--epochs', 4), LR = +flag('--lr', 2e-4), BATCH = +flag('--batch', 32), TAU = +flag('--tau', 0.03), L2 = 1e-5;
const teachOnly = args.includes('--teach-only'), infoOnly = args.includes('--informative-only');

const J0 = JSON.parse(fs.readFileSync(init, 'utf8'));
const D = J0.dense, H = J0.b1.length, MH = J0.s2b.length, GR = J0.grank || 0, MS = J0.M.length;
const f32 = a => Float32Array.from(a.flat());
const W = { Wd: f32(J0.Wd), b1: f32(J0.b1), E: f32(J0.E), S2: f32(J0.S2), s2b: f32(J0.s2b), M: f32(J0.M), mb: f32(J0.mb), J: f32(J0.J), jb: f32(J0.jb), o: f32(J0.o), ob: Float32Array.of(J0.ob) };
const mean = f32(J0.mean), std = f32(J0.std);

// ── data ──
const recs = [];
for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const o = JSON.parse(line);
  const test = Math.abs(o.g) % 10 === 0;
  for (const r of o.recs) {
    const tried = r.c.map((c, i) => [i, c[3]]).filter(([, v]) => v != null);
    if (tried.length < 2) continue;
    if (teachOnly && !r.teach) continue;
    const vals = tried.map(([, v]) => v).sort((a, b) => b - a);
    if (infoOnly && !r.teach && !(vals[0] >= 0.05 && vals[0] <= 0.95 && vals[0] - vals[1] >= 0.01)) continue;
    const x = new Float32Array(D);
    for (let i = 0; i < D; i++) x[i] = (r.s[0][i] - mean[i]) / std[i];
    const moves = r.c.slice(0, 48).map(([m, g, , v]) => ({ f: [...m.filter(([i]) => i < MS), ...(GR ? [[GR + Math.min(g, 15), 1]] : [])], g, v }));
    recs.push({ x, sp: r.s[1].map(([i, n]) => [(i - D) * H, n]), moves, test, teach: !!r.teach });
  }
}
const train = recs.filter(r => !r.test), test = recs.filter(r => r.test);
console.log(`${recs.length} decisions (${test.length} held out, ${recs.filter(r => r.teach).length} teacher-scored), net from ${path.basename(init)}`);

// ── forward / backward ──
const st = new Float32Array(H), s = new Float32Array(MH);
function stateFwd(r) {
  st.set(W.b1);
  for (let i = 0; i < D; i++) { const x = r.x[i]; if (x !== 0) for (let k = 0, o = i; k < H; k++, o += D) st[k] += W.Wd[o] * x; }
  for (const [row, n] of r.sp) for (let k = 0; k < H; k++) st[k] += n * W.E[row + k];
  for (let k = 0; k < H; k++) if (st[k] < 0) st[k] = 0;
  s.set(W.s2b);
  for (let m = 0; m < MH; m++) { let a = s[m]; for (let k = 0, o = m * H; k < H; k++) a += W.S2[o + k] * st[k]; s[m] = a; }
}
function moveFwd(mv) {   // -> { u, v, z }
  const u = new Float32Array(MH);
  for (let k = 0; k < MH; k++) u[k] = s[k] + W.mb[k];
  for (const [i, w] of mv.f) { const row = i * MH; for (let k = 0; k < MH; k++) u[k] += w * W.M[row + k]; }
  for (let k = 0; k < MH; k++) if (u[k] < 0) u[k] = 0;
  const v = new Float32Array(MH);
  let z = W.ob[0];
  for (let m = 0; m < MH; m++) { let a = W.jb[m]; for (let k = 0, q = m * MH; k < MH; k++) a += W.J[q + k] * u[k]; v[m] = a > 0 ? a : 0; z += W.o[m] * v[m]; }
  return { u, v, z };
}
function targets(r) {   // softmax(value / tau) over tried moves, ties broken toward greedy's order
  const t = r.moves.map(m => (m.v == null ? null : (m.v - 1e-4 * Math.min(m.g, 30)) / TAU));
  const mx = Math.max(...t.filter(x => x != null));
  const e = t.map(x => (x == null ? 0 : Math.exp(x - mx))), S = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / S);
}
const G = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Float32Array(v.length)]));
const Mo = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Float32Array(v.length)]));
const Vo = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Float32Array(v.length)]));
const touchedE = new Set(), touchedM = new Set();
function step(r) {
  stateFwd(r);
  const fw = r.moves.map(moveFwd), t = targets(r);
  const tried = r.moves.map(m => m.v != null);
  const zs = fw.map((f, i) => (tried[i] ? f.z : -Infinity)), mx = Math.max(...zs);
  const e = zs.map(z => (z === -Infinity ? 0 : Math.exp(z - mx))), S = e.reduce((a, b) => a + b, 0);
  let loss = 0;
  const ds = new Float32Array(MH);
  r.moves.forEach((mv, i) => {
    if (!tried[i]) return;
    const p = e[i] / S;
    if (t[i] > 0) loss -= t[i] * Math.log(Math.max(p, 1e-12));
    const dz = p - t[i];
    const { u, v } = fw[i];
    G.ob[0] += dz;
    const du = new Float32Array(MH);
    for (let m = 0; m < MH; m++) {
      G.o[m] += dz * v[m];
      if (v[m] <= 0) continue;
      const dv = dz * W.o[m];
      G.jb[m] += dv;
      for (let k = 0, q = m * MH; k < MH; k++) { G.J[q + k] += dv * u[k]; du[k] += dv * W.J[q + k]; }
    }
    for (let k = 0; k < MH; k++) if (u[k] <= 0) du[k] = 0;
    for (let k = 0; k < MH; k++) { G.mb[k] += du[k]; ds[k] += du[k]; }
    for (const [fi, w] of mv.f) { const row = fi * MH; touchedM.add(row); for (let k = 0; k < MH; k++) G.M[row + k] += w * du[k]; }
  });
  const dst = new Float32Array(H);
  for (let m = 0; m < MH; m++) { G.s2b[m] += ds[m]; for (let k = 0, o = m * H; k < H; k++) { G.S2[o + k] += ds[m] * st[k]; dst[k] += ds[m] * W.S2[o + k]; } }
  for (let k = 0; k < H; k++) if (st[k] <= 0) dst[k] = 0;
  for (let k = 0; k < H; k++) G.b1[k] += dst[k];
  for (let i = 0; i < D; i++) { const x = r.x[i]; if (x !== 0) for (let k = 0, o = i; k < H; k++, o += D) G.Wd[o] += dst[k] * x; }
  for (const [row, n] of r.sp) { touchedE.add(row); for (let k = 0; k < H; k++) G.E[row + k] += dst[k] * n; }
  return loss;
}
let t = 0;
function adam(name, lo = 0, hi = W[name].length) {
  const w = W[name], g = G[name], m = Mo[name], v = Vo[name], c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
  for (let i = lo; i < hi; i++) {
    const gi = g[i] / BATCH + L2 * w[i];
    m[i] = 0.9 * m[i] + 0.1 * gi; v[i] = 0.999 * v[i] + 0.001 * gi * gi;
    w[i] -= LR * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8); g[i] = 0;
  }
}
// held-out: agreement with the search's best (within 0.5 point) and regret, net vs greedy's top
function evaluate(set) {
  let agree = 0, gAgree = 0, regret = 0, gRegret = 0;
  for (const r of set) {
    stateFwd(r);
    const zs = r.moves.map(m => moveFwd(m).z);
    const vals = r.moves.map(m => (m.v == null ? -1 : m.v)), best = Math.max(...vals);
    let ni = 0; for (let i = 1; i < zs.length; i++) if (zs[i] > zs[ni]) ni = i;
    let gi = 0; for (let i = 1; i < r.moves.length; i++) if (r.moves[i].g < r.moves[gi].g) gi = i;
    // regret among tried moves: the net's favourite tried move vs the best
    let nt = -1; for (let i = 0; i < zs.length; i++) if (r.moves[i].v != null && (nt < 0 || zs[i] > zs[nt])) nt = i;
    let gt = -1; for (let i = 0; i < zs.length; i++) if (r.moves[i].v != null && (gt < 0 || r.moves[i].g < r.moves[gt].g)) gt = i;
    if (vals[ni] >= best - 0.005) agree++;
    if (vals[gi] >= best - 0.005) gAgree++;
    regret += best - vals[nt]; gRegret += best - vals[gt];
  }
  const n = Math.max(1, set.length);
  return { agree: agree / n, gAgree: gAgree / n, regret: regret / n, gRegret: gRegret / n };
}
const fmt = e => `agree ${(100 * e.agree).toFixed(1)}% (greedy ${(100 * e.gAgree).toFixed(1)}%), regret ${(100 * e.regret).toFixed(2)} pts (greedy ${(100 * e.gRegret).toFixed(2)})`;
const e0 = evaluate(test);
console.log(`start: ${fmt(e0)}`);
let best = { e: e0, ep: 0, W: null };
const t0 = Date.now();
for (let ep = 1; ep <= EPOCHS; ep++) {
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  let loss = 0;
  for (let b0 = 0; b0 < train.length; b0 += BATCH) {
    for (const r of train.slice(b0, b0 + BATCH)) loss += step(r);
    t++;
    for (const k of ['Wd', 'b1', 'S2', 's2b', 'mb', 'J', 'jb', 'o', 'ob']) adam(k);
    for (const row of touchedE) adam('E', row, row + H);
    for (const row of touchedM) adam('M', row, row + MH);
    touchedE.clear(); touchedM.clear();
  }
  const e = evaluate(test);
  console.log(`  epoch ${ep}/${EPOCHS}  train loss ${(loss / train.length).toFixed(4)}  held-out ${fmt(e)}  ${Math.round((Date.now() - t0) / 1000)}s`);
  if (e.regret < best.e.regret) best = { e, ep, W: Object.fromEntries(Object.entries(W).map(([k, v]) => [k, Float32Array.from(v)])) };
}
if (!best.W) { console.log('no epoch beat the starting net on regret - nothing written'); process.exit(0); }
const r5 = a => Array.from(a, x => Math.round(x * 1e5) / 1e5);
const re2 = (a, rows, cols) => Array.from({ length: rows }, (_, i) => r5(a.subarray(i * cols, (i + 1) * cols)));
const B = best.W;
fs.writeFileSync(out, JSON.stringify({ ...J0, Wd: re2(B.Wd, H, D), b1: r5(B.b1), E: re2(B.E, J0.E.length, H), S2: re2(B.S2, MH, H), s2b: r5(B.s2b), M: re2(B.M, MS, MH), mb: r5(B.mb), J: re2(B.J, MH, MH), jb: r5(B.jb), o: r5(B.o), ob: B.ob[0],
  checks: [], tunedFrom: path.basename(init), tunedOn: train.length, tunedAt: new Date().toISOString(), heldOut: best.e }));
console.log(`best epoch ${best.ep}: ${fmt(best.e)} -> ${out}`);
