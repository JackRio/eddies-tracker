// Deck guessing: what is the Rival playing, given only what they have shown?
//
// Candidates are the known lists (board/meta-decks + the engine's test decks) plus one "custom
// deck" hypothesis. Prior: ChoomBattler play counts from each meta file's header ("over N games";
// other lists count as 300). Evidence: every card the Rival has shown face up (field, Gear, face-up
// Legends, trash, removed) - a list that can't contain a shown card is penalised hard (EPS per
// missing copy; someone may run a tweaked list), and lists running more copies of the shown cards
// score higher (each shown copy multiplies by copies/40).
//
// The custom-deck hypothesis builds a list from the rules instead: Legends are drawn so that every
// shown card's RAM fits its colour's ceiling (sum of RAM over Legends of that colour - a 4-RAM green
// card means at least 4 green RAM among their Legends), then the 40 cards are the shown ones plus
// legal cards of those colours within the ceilings, weighted by how often the meta plays them.
//
// redeal(b, me, rng, post) re-deals everything `me` can't see of the Rival - hand, deck, face-down
// Eddies, face-down Legends - from one list drawn from the posterior, minus what has been shown.
'use strict';
const { CARDS } = require('../engine');
const fs = require('fs');
const path = require('path');
const { loadDecks, DECK_DIRS } = require('./arena');
const { opp } = require('../coach/policy');

const EPS = 0.01, CUSTOM_SHARE = 0.08, MAIN = 40;
const BY = new Map(CARDS.map(c => [c.number, c]));
const LEGAL = CARDS.filter(c => c.legal !== false);
const LEGENDS = LEGAL.filter(c => c.type === 'Legend');
const MAINS = LEGAL.filter(c => c.type !== 'Legend');

let CANDS = null, FREQ = null;
function candidates() {
  if (CANDS) return CANDS;
  CANDS = loadDecks().map(d => {
    const cards = new Map();
    for (const { card_id, count } of d.cards) cards.set(card_id, (cards.get(card_id) || 0) + count);
    let games = 300;
    for (const dir of DECK_DIRS) {
      const f = path.join(dir, d.name);
      if (!fs.existsSync(f)) continue;
      const head = fs.readFileSync(f, 'utf8').slice(0, 400).match(/over (\d+) games/);
      if (head) games = +head[1];
      break;
    }
    return { name: d.name, legends: d.legends.slice(), cards, games };
  });
  // how much the meta plays each card (copies summed over lists, weighted by play count)
  FREQ = new Map();
  for (const d of CANDS) {
    for (const [n, k] of d.cards) FREQ.set(n, (FREQ.get(n) || 0) + k * d.games);
    for (const n of d.legends) FREQ.set(n, (FREQ.get(n) || 0) + d.games);
  }
  const top = Math.max(...FREQ.values());
  for (const [n, v] of FREQ) FREQ.set(n, v / top);
  return CANDS;
}

// what `pid` has shown face up
function shown(b, pid) {
  const Z = b[pid].zones, cards = new Map(), legends = [];
  const add = n => { if (BY.get(n)?.type === 'Legend') legends.push(n); else cards.set(n, (cards.get(n) || 0) + 1); };
  for (const u of Z.field) { add(u.card_id); for (const g of u.equipped_gear || []) add(g.card_id); }
  for (const l of Z.legends) { if (l.face === 'face_up') add(l.card_id); for (const g of l.equipped_gear || []) add(g.card_id); }
  for (const c of [...Z.trash, ...(Z.removed || [])]) add(c.card_id);
  return { cards, legends };
}

// -> [{ deck, w }] sorted by weight (deck === 'custom' for the rules-built hypothesis)
function posterior(seen, opts = {}) {
  const C = candidates().filter(d => !opts.exclude || !opts.exclude(d));
  const logs = C.map(d => {
    let L = Math.log(d.games);
    for (const [n, k] of seen.cards) {
      const have = d.cards.get(n) || 0;
      L += Math.min(k, have) * Math.log(have / MAIN || 1) + Math.max(0, k - have) * Math.log(EPS);
    }
    for (const n of seen.legends) if (!d.legends.includes(n)) L += Math.log(EPS);
    return L;
  });
  const total = C.reduce((a, d) => a + d.games, 0);
  // custom deck: no list to miss, but each shown copy is only as likely as the meta's average
  let Lc = Math.log(total * CUSTOM_SHARE / (1 - CUSTOM_SHARE));
  for (const [n, k] of seen.cards) Lc += k * Math.log(Math.max(0.005, (FREQ.get(n) || 0) * 0.06));
  const all = [...C.map((d, i) => ({ deck: d, L: logs[i] })), { deck: 'custom', L: Lc }];
  const m = Math.max(...all.map(x => x.L));
  let z = 0;
  for (const x of all) { x.w = Math.exp(x.L - m); z += x.w; }
  for (const x of all) x.w /= z;
  return all.sort((a, b) => b.w - a.w).map(({ deck, w }) => ({ deck, w }));
}

function pick(arr, wts, rng) {
  let u = rng() * wts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) { u -= wts[i]; if (u <= 0) return arr[i]; }
  return arr[arr.length - 1];
}

// RAM ceiling per colour for a set of Legends
function ceilings(legends) {
  const c = {};
  for (const n of legends) { const L = BY.get(n); if (L?.color) c[L.color] = (c[L.color] || 0) + (L.ram || 0); }
  return c;
}
const fits = (n, ceil) => { const c = BY.get(n); return !c?.color || (c.ram || 0) <= (ceil[c.color] || 0); };

// build a legal-looking list around what was shown
function customDeck(seen, rng) {
  const need = {};   // colour -> RAM the shown cards demand
  for (const n of seen.cards.keys()) { const c = BY.get(n); if (c?.color) need[c.color] = Math.max(need[c.color] || 0, c.ram || 0); }
  let legends = null;
  for (let t = 0; t < 300 && !legends; t++) {
    const L = [...new Set(seen.legends)];
    const names = new Set(L.map(n => BY.get(n).name.split(':')[0]));
    while (L.length < 3) {
      const pool = LEGENDS.filter(c => !L.includes(c.number) && !names.has(c.name.split(':')[0]));
      const c = pick(pool, pool.map(c => (FREQ.get(c.number) || 0) + 0.05), rng);
      L.push(c.number); names.add(c.name.split(':')[0]);
    }
    const ceil = ceilings(L);
    if (Object.entries(need).every(([col, r]) => (ceil[col] || 0) >= r) || t === 299) legends = L;
  }
  const ceil = ceilings(legends);
  const cards = new Map(seen.cards);
  let size = [...cards.values()].reduce((a, b) => a + b, 0);
  const pool = MAINS.filter(c => fits(c.number, ceil));
  const wts = pool.map(c => (FREQ.get(c.number) || 0) + 0.03);
  for (let guard = 0; size < MAIN && guard < 2000; guard++) {
    const c = pick(pool, wts, rng);
    if ((cards.get(c.number) || 0) >= 3) continue;
    cards.set(c.number, (cards.get(c.number) || 0) + 1); size++;
  }
  return { name: 'custom', legends, cards };
}

function shuffleInPlace(a, rng) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Re-deal `me`'s Rival on board copy `d` (mutated): hand, deck, Eddies and face-down Legends.
function redeal(d, me, rng, post, seen) {
  const rv = d[opp(me)].zones;
  const pickD = pick(post.map(x => x.deck), post.map(x => x.w), rng);
  const deck = pickD === 'custom' ? customDeck(seen, rng) : pickD;
  // main cards: the list minus what has been shown, topped up with same-colour cards if short
  const left = new Map(deck.cards);
  for (const [n, k] of seen.cards) left.set(n, Math.max(0, (left.get(n) || 0) - k));
  const pool = [];
  for (const [n, k] of left) for (let i = 0; i < k; i++) pool.push(n);
  const slots = [...rv.hand, ...rv.deck, ...rv.eddies];
  if (pool.length < slots.length) {
    const ceil = ceilings(deck.legends);
    const fill = MAINS.filter(c => fits(c.number, ceil));
    while (pool.length < slots.length) pool.push(pick(fill, fill.map(c => (FREQ.get(c.number) || 0) + 0.03), rng).number);
  }
  shuffleInPlace(pool, rng);
  slots.forEach((c, i) => { c.card_id = pool[i]; });
  // face-down Legends: the list's Legends that aren't face up yet
  const down = rv.legends.filter(l => l.face !== 'face_up');
  if (down.length) {
    const up = new Set(rv.legends.filter(l => l.face === 'face_up').map(l => l.card_id));
    let rest = deck.legends.filter(n => !up.has(n));
    if (rest.length < down.length) {
      const names = new Set([...up, ...rest].map(n => BY.get(n).name.split(':')[0]));
      rest = rest.concat(LEGENDS.filter(c => !names.has(c.name.split(':')[0])).map(c => c.number));
    }
    shuffleInPlace(rest, rng);
    down.forEach((l, i) => { l.card_id = rest[i]; });
  }
  return deck.name;
}

// The Rival's real list on a board (all their cards, wherever they are) - for evaluation only.
function trueList(b, pid) {
  const Z = b[pid].zones, cards = new Map(), legends = [];
  const add = n => { if (BY.get(n)?.type === 'Legend') legends.push(n); else cards.set(n, (cards.get(n) || 0) + 1); };
  for (const z of ['hand', 'deck', 'trash', 'eddies', 'removed']) for (const c of Z[z] || []) add(c.card_id);
  for (const u of [...Z.field, ...Z.legends]) { add(u.card_id); for (const g of u.equipped_gear || []) add(g.card_id); }
  return { cards, legends };
}
const sameList = (d, t) => d.legends.slice().sort().join() === t.legends.slice().sort().join()
  && d.cards.size === t.cards.size && [...d.cards].every(([n, k]) => t.cards.get(n) === k);

module.exports = { shown, posterior, redeal, customDeck, candidates, ceilings, trueList, sameList };
