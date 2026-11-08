// WebAssembly SIMD forward passes for the value net (value.js) and the policy net (pnet.js). Same math as the
// plain-JS versions (which stay as the fallback, and as the reference: EDDIES_NO_WASM=1 turns this off), with
// float32 sums in a different order - outputs differ from the JS ones by ~1e-6.
// Kernels: nnkern.wat (build: node scripts/build-wasm.js). Each net's weights are copied into the wasm memory
// once, at load; matrices whose input is a post-ReLU vector are stored transposed so a product only visits
// the non-zero inputs, each a contiguous SIMD row.
'use strict';
const fs = require('fs');
const path = require('path');

let K = null;
if (process.env.EDDIES_NO_WASM !== '1') {
  try {
    const mod = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'nnkern.wasm')));
    K = new WebAssembly.Instance(mod, {}).exports;
  } catch { K = null; }
}
let F32 = null, I32 = null, top = 0;
const views = () => { F32 = new Float32Array(K.memory.buffer); I32 = new Int32Array(K.memory.buffer); };
if (K) { views(); top = 1024; }
// 16-byte aligned block of n floats (or ints)
function alloc(n) {
  const at = top;
  top += Math.ceil(n * 4 / 16) * 16;
  const need = Math.ceil(top / 65536) - K.memory.buffer.byteLength / 65536;
  if (need > 0) { K.memory.grow(need); views(); }
  return at;
}
function put(arr) { const at = alloc(arr.length); F32.set(arr, at / 4); return at; }
const transpose = (W, rows, cols) => { const T = new Float32Array(W.length); for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) T[c * rows + r] = W[r * cols + c]; return T; };
const PAIRS = 4096;

// first layer shared by both nets: h = relu(b1 + Wd·norm(dense) + E·sparse) -> returns the count of non-zero h
function layer1(w, dense, sparse, net) {
  const { D, mean, std } = net, H = w.H;
  let p = w.pairs / 4, c = 0;
  for (let i = 0; i < D; i++) {
    const x = (dense[i] - mean[i]) / std[i];
    if (x !== 0) { I32[p] = i; F32[p + 1] = x; p += 2; c++; }
  }
  K.copy(w.h, w.b1, H);
  K.rows(w.h, w.WdT, H * 4, w.pairs, c, H);
  p = w.pairs / 4; c = 0;
  for (const [idx, n] of sparse) { I32[p] = idx - D; F32[p + 1] = n; p += 2; c++; }
  K.rows(w.h, w.E, H * 4, w.pairs, c, H);
  return K.nz(w.h, H, w.idx);
}

function packValue(net) {
  const { H, H2, D } = net;
  if (!K || H % 4 || H2 % 4 || D + 600 > PAIRS) return null;
  return { H, H2, WdT: put(transpose(net.Wd, H, D)), b1: put(net.b1), E: put(net.E), W2T: put(transpose(net.W2, H2, H)), b2: put(net.b2), w3: put(net.w3),
    h: alloc(H), acc: alloc(H2), idx: alloc(Math.max(H, H2)), pairs: alloc(2 * PAIRS) };
}
function forwardValue(dense, sparse, net) {
  const w = net.w;
  const cnt = layer1(w, dense, sparse, net);
  K.copy(w.acc, w.b2, w.H2);
  K.gather(w.acc, w.W2T, w.H2 * 4, w.h, w.idx, cnt, w.H2);
  const z = net.b3 + K.relu_dot(w.acc, w.w3, w.H2);
  return 1 / (1 + Math.exp(-z));
}

function packPolicy(net) {
  const { H, MH, D } = net;
  if (!K || H % 4 || MH % 4 || D + 600 > PAIRS) return null;
  const msize = net.M.length / MH;
  return { H, MH, msize, WdT: put(transpose(net.Wd, H, D)), b1: put(net.b1), E: put(net.E), S2T: put(transpose(net.S2, MH, H)), s2b: put(net.s2b),
    M: put(net.M), mb: put(net.mb), JT: put(transpose(net.J, MH, MH)), jb: put(net.jb), o: put(net.o),
    h: alloc(H), s: alloc(MH), u: alloc(MH), acc: alloc(MH), idx: alloc(Math.max(H, MH)), pairs: alloc(2 * PAIRS) };
}
// state part: leaves the state vector in w.s (one decision at a time - the caller scores its moves right after)
function stateVecW(dense, sparse, net) {
  const w = net.w;
  const cnt = layer1(w, dense, sparse, net);
  K.copy(w.s, w.s2b, w.MH);
  K.gather(w.s, w.S2T, w.MH * 4, w.h, w.idx, cnt, w.MH);
}
function moveLogitW(menc, net) {
  const w = net.w, MH = w.MH;
  K.add(w.u, w.s, w.mb, MH);
  let p = w.pairs / 4, c = 0;
  for (const [i, x] of menc) { if (c >= PAIRS) break; I32[p] = i; F32[p + 1] = x; p += 2; c++; }
  K.rows(w.u, w.M, MH * 4, w.pairs, c, MH);
  const cnt = K.nz(w.u, MH, w.idx);
  K.copy(w.acc, w.jb, MH);
  K.gather(w.acc, w.JT, MH * 4, w.u, w.idx, cnt, MH);
  return net.ob + K.relu_dot(w.acc, w.o, MH);
}

module.exports = { enabled: !!K, packValue, forwardValue, packPolicy, stateVecW, moveLogitW };
