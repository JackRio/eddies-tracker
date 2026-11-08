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

// The rest of the board with a halted effect: nothing outside the stack is shared with anything else
// outside it (checked over 35k boards), only with objects inside the stack - so after the stack is
// copied, the rest needs a lookup per object, not a full shared copy (half the Map work).
function copyLookup(v, seen) {
  const hit = seen.get(v);
  if (hit) return hit;
  if (Array.isArray(v)) {
    const n = v.length, out = new Array(n);
    for (let i = 0; i < n; i++) { const x = v[i]; out[i] = (x === null || typeof x !== 'object') ? x : copyLookup(x, seen); }
    return out;
  }
  const out = {};
  for (const k in v) { const x = v[k]; out[k] = (x === null || typeof x !== 'object') ? x : copyLookup(x, seen); }
  return out;
}

function cloneBoard(b) {
  if (!b || typeof b !== 'object') return b;
  if (b.effect_stack && b.effect_stack.length) {
    const seen = new Map(), stack = copyShared(b.effect_stack, seen), out = {};
    for (const k in b) { const x = b[k]; out[k] = k === 'effect_stack' ? stack : (x === null || typeof x !== 'object') ? x : copyLookup(x, seen); }
    return out;
  }
  return copyPlain(b);
}

// Deck cards are SHARED between copies: each copy gets its own deck array (order, draws, mills, searches
// are private), but the card objects in it are the same. Safe because nothing edits a card object while
// it sits in a deck - code that changes a deck card must put in a new object (strong.js determinize,
// belief.js redeal do). A card that leaves the deck is deep-copied at the next clone like everything else.
// Check after engine changes: EDDIES_CHECK_SHARE=1 node src/engine/test/run.js --fuzz 400 freezes deck
// cards, so any edit throws (the tests and fuzz report it).
const CHECK = process.env.EDDIES_CHECK_SHARE === '1';
function copyDeck(d) {
  if (CHECK) for (const c of d) if (c && typeof c === 'object') Object.freeze(c);
  return d.slice();
}
function copyPlain(b) {
  const out = {};
  for (const k in b) {
    const x = b[k];
    if ((k === 'p1' || k === 'p2') && x && x.zones && Array.isArray(x.zones.deck)) {
      const pl = {};
      for (const pk in x) {
        const y = x[pk];
        if (pk === 'zones') { const z = {}; for (const zk in y) { const v = y[zk]; z[zk] = zk === 'deck' ? copyDeck(v) : (v === null || typeof v !== 'object') ? v : copy(v); } pl[pk] = z; }
        else pl[pk] = (y === null || typeof y !== 'object') ? y : copy(y);
      }
      out[k] = pl;
    } else out[k] = (x === null || typeof x !== 'object') ? x : copy(x);
  }
  return out;
}

module.exports = { cloneBoard };
