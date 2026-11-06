'use strict';
// Fast board copy for step(). A board is plain JSON-like data (objects, arrays, strings, numbers,
// booleans, null; never undefined, Map, Set or class instances). The only shared references
// (one object reachable from two places) live inside a halted effect stack's saved state, so a
// plain tree copy is exact whenever the stack is empty - most positions - and several times
// faster than structuredClone. With a pending effect, copyShared() keeps those references shared.

function copy(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const n = v.length, out = new Array(n);
    for (let i = 0; i < n; i++) { const x = v[i]; out[i] = (x === null || typeof x !== 'object') ? x : copy(x); }
    return out;
  }
  const out = {};
  for (const k in v) { const x = v[k]; out[k] = (x === null || typeof x !== 'object') ? x : copy(x); }
  return out;
}

// Same copy, but an object reached twice is copied once and shared again, like structuredClone.
function copyShared(v, seen) {
  if (v === null || typeof v !== 'object') return v;
  const hit = seen.get(v);
  if (hit) return hit;
  let out;
  if (Array.isArray(v)) {
    out = new Array(v.length); seen.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = copyShared(v[i], seen);
  } else {
    out = {}; seen.set(v, out);
    for (const k in v) out[k] = copyShared(v[k], seen);
  }
  return out;
}

function cloneBoard(b) {
  if (!b || typeof b !== 'object') return b;
  if (b.effect_stack && b.effect_stack.length) return copyShared(b, new Map());
  return copy(b);
}

module.exports = { cloneBoard };
