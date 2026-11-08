// The "Gig language" for the value net: what the Gigs on the table say, and which Gig facts each
// side's cards care about. Cards don't all want the same Gigs - Jackie: Ride or Die counts even
// values, Hanako draws on value-pairs, Kerry / Octant / Carnage want 8+, Chrome Reverie and Trust
// No One want a min Gig, Pyramid Song a d4 at its min, 6th Street Recruits stolen d6s... So:
//   1. Gig facts per side: dice by size, even / odd, value-pairs, distinct values, 8+, max / min
//      Gigs, total and headroom, stolen dice, fixer dice left, hand cards whose cost equals a Gig.
//   2. Interest per side: how many of that side's known cards care about each fact (read from the
//      card text once, see CATS). Yours: your whole list (hand, deck, field, Legends, trash). The
//      Rival's: only what's face up (field, Legends up, Gear, trash).
//   3. Interest x fact for the facts with a clear "more is better" reading, so a small dataset can
//      still learn "my Gig-pair cards and I hold a pair".
// The net gets these numbers next to the card bags and learns what they're worth per deck.
'use strict';
const { CARDS } = require('../engine');
const { opp } = require('../coach/policy');

const CATS = {
  even: /even value|value is even/i,
  odd: /odd value|is odd/i,
  pair: /value-pair/i,
  high: /8\+ value/i,
  max: /max Gig/i,
  min: /min Gig/i,
  distinct: /different values|value not shared/i,
  count: /more Gigs than you|Gigs more than you/i,
  costmatch: /cost equals? (the value of )?(any )?(a )?friendly Gig|cost equal to any friendly Gig|equal to that Gig's value/i,
  d4: /\bd4\b/i,
  d6: /\bd6\b/i,
  d20: /\bd20\b/i,
  modify: /(increase|decrease|adjust|set|swap)s? (a|1|the|up to|\w+ friendly|\w+ player's)?\s*(friendly |rival )?Gig/i,
};
const CAT_KEYS = Object.keys(CATS);
const CARD_CATS = new Map(CARDS.map(c => [c.number, CAT_KEYS.filter(k => CATS[k].test(c.rules_text || ''))]));
const COST = new Map(CARDS.map(c => [c.number, c.cost]));
const SIZES = [4, 6, 8, 10, 12, 20];
const PRODUCTS = ['even', 'odd', 'pair', 'high', 'max', 'min', 'distinct'];

function facts(b, pid) {
  const Z = b[pid].zones, G = Z.gigs;
  const f = {};
  for (const s of SIZES) f['d' + s] = G.filter(g => g.sides === s).length;
  f.even = G.filter(g => g.value % 2 === 0).length;
  f.odd = G.length - f.even;
  const byV = new Map();
  for (const g of G) byV.set(g.value, (byV.get(g.value) || 0) + 1);
  f.pair = [...byV.values()].reduce((a, n) => a + Math.floor(n / 2), 0);
  f.distinct = byV.size;
  f.high = G.filter(g => g.value >= 8).length;
  f.max = G.filter(g => g.value === g.sides).length;
  f.min = G.filter(g => g.value === 1).length;
  f.d4min = +G.some(g => g.sides === 4 && g.value === 1);
  f.sum = G.reduce((a, g) => a + g.value, 0) / 10;
  f.room = G.reduce((a, g) => a + (g.sides - g.value), 0) / 10;
  f.stolen = G.filter(g => !String(g.iid).startsWith(pid)).length;
  f.fixer = (Z.fixer || []).reduce((a, d) => a + (d.sides || 0), 0) / 20;
  return f;
}
const FACT_KEYS = Object.keys(facts({ p1: { zones: { gigs: [], fixer: [] } } }, 'p1'));

// known cards of `pid` from `viewer`'s side
function known(b, pid, own) {
  const Z = b[pid].zones, out = [];
  const gear = x => { for (const g of x.equipped_gear || []) out.push(g.card_id); };
  for (const u of Z.field) { out.push(u.card_id); gear(u); }
  for (const l of Z.legends) { if (own || l.face === 'face_up') out.push(l.card_id); gear(l); }
  for (const c of Z.trash) out.push(c.card_id);
  if (own) for (const z of ['hand', 'deck']) for (const c of Z[z]) out.push(c.card_id);
  return out;
}

function interest(b, pid, own) {
  const n = Object.fromEntries(CAT_KEYS.map(k => [k, 0]));
  for (const id of known(b, pid, own)) for (const k of CARD_CATS.get(id) || []) n[k]++;
  return n;
}

function side(b, pid, own) {
  const f = facts(b, pid), n = interest(b, pid, own);
  // hand cards whose cost equals a friendly Gig's value (Hanako: In a Gilded Cage, The Heist, Caliber...) - yours only
  const vals = new Set(b[pid].zones.gigs.map(g => g.value));
  const cm = own ? b[pid].zones.hand.filter(c => vals.has(COST.get(c.card_id))).length : 0;
  return [...FACT_KEYS.map(k => f[k]), cm,
    ...CAT_KEYS.map(k => n[k] / 10),
    ...PRODUCTS.map(k => (n[k] / 10) * f[k])];
}

const NAMES = ['my', 'rv'].flatMap(s => [...FACT_KEYS, 'costHand', ...CAT_KEYS.map(k => 'int.' + k), ...PRODUCTS.map(k => 'x.' + k)].map(k => `${s}.gig.${k}`));
const N = NAMES.length;

function gigFeatures(b, pid) {
  return [...side(b, pid, true), ...side(b, opp(pid), false)];
}

module.exports = { gigFeatures, NAMES, N, CARD_CATS, CATS };
if (require.main === module) {
  console.log(`${N} Gig features`);
  for (const k of CAT_KEYS) {
    const cards = CARDS.filter(c => c.legal !== false && (CARD_CATS.get(c.number) || []).includes(k)).map(c => c.name.split(':')[0]);
    console.log(`${k.padEnd(9)} ${String(cards.length).padStart(2)}  ${cards.join(', ')}`);
  }
}
