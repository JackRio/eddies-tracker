// Decklists for both players. A replay never lists a deck: your own deck pile is hidden during
// play and face-down Legends stay hidden even from you. So each list is built from
//   1. every card instance seen face up during the whole game (exact lower bound on copies), plus
//   2. the closest published deck (docs/data/published-decks.json) to fill the unseen slots -
//      for you, matched by the replay's deck name first; for the Rival, by overlap alone.
// The Rival list uses hindsight (cards they only revealed later count from turn 1). That is the
// point of a post-game review, and it is stated in the report.
'use strict';
const { cardByNumber, engineCard, publishedDecks, metaDecks, letters, CARDS } = require('./cards');

const MAIN_SIZE = 40;

function seenCards(knowledge, pid) {
  const cards = new Map(), legends = new Set(), unknown = new Set();
  for (const k of knowledge.values()) {
    if (k.owner !== pid) continue;
    const c = engineCard(k.name) || engineCard(k.cardId);
    if (!c) { unknown.add(k.name); continue; }
    if (c.type === 'Legend') legends.add(c.number);
    else cards.set(c.number, (cards.get(c.number) || 0) + 1);
  }
  return { cards, legends, unknown };
}

function overlap(seen, deck) {
  let n = 0;
  for (const [num, k] of seen.cards) n += Math.min(k, deck.cards.get(num) || 0);
  for (const l of seen.legends) if (deck.legends.includes(l)) n += 1;
  return n;
}

function pickBase(seen, deckName) {
  const all = [...metaDecks(), ...publishedDecks()];
  if (!all.length) return null;
  const want = letters(deckName);
  let pool = want ? all.filter(d => letters(d.name) === want) : [];
  if (!pool.length && want) pool = all.filter(d => letters(d.name).startsWith(want) || want.startsWith(letters(d.name)));
  if (!pool.length) pool = all;
  let best = null, bestScore = -1;
  for (const d of pool) { const s = overlap(seen, d); if (s > bestScore) { best = d; bestScore = s; } }
  // a base that shares almost nothing with what was seen is worse than no base
  const seenTotal = [...seen.cards.values()].reduce((a, b) => a + b, 0) + seen.legends.size;
  if (pool === all && seenTotal >= 6 && bestScore < seenTotal * 0.4) return null;
  return best;
}

function colorsOf(nums) {
  const s = new Set();
  for (const n of nums) { const c = cardByNumber(n); if (c?.color) s.add(c.color); }
  return s;
}

// -> { legends: [3 numbers], cards: Map(number -> count), total, source, seen: {cards, legends}, unknown }
function inferDeck(knowledge, pid, deckName) {
  const seen = seenCards(knowledge, pid);
  const base = pickBase(seen, deckName);
  const cards = new Map(seen.cards);
  const fill = [];

  // legends: seen first, then the base deck's, then any Legend in the seen colours
  const legends = [...seen.legends];
  for (const l of base?.legends || []) if (legends.length < 3 && !legends.includes(l)) legends.push(l);
  if (legends.length < 3) {
    const cols = colorsOf([...seen.cards.keys(), ...legends]);
    for (const c of CARDS) if (legends.length < 3 && c.type === 'Legend' && cols.has(c.color) && !legends.includes(c.number)) legends.push(c.number);
  }

  let total = [...cards.values()].reduce((a, b) => a + b, 0);
  // fill from the base list, one copy per pass so the fill is spread across the list
  if (base) {
    for (let pass = 0; pass < 3 && total < MAIN_SIZE; pass++)
      for (const [num, k] of base.cards) {
        if (total >= MAIN_SIZE) break;
        const have = cards.get(num) || 0;
        if (have < k && have <= pass) { cards.set(num, have + 1); total++; fill.push(num); }
      }
  }
  // still short: extra copies of what was seen (max 3), then same-colour cards
  for (const [num, k] of [...cards]) while (total < MAIN_SIZE && (cards.get(num) || 0) < 3) { cards.set(num, (cards.get(num) || 0) + 1); total++; fill.push(num); }
  if (total < MAIN_SIZE) {
    const cols = colorsOf([...cards.keys(), ...legends]);
    for (const c of CARDS) {
      if (total >= MAIN_SIZE) break;
      if (c.type === 'Legend' || !cols.has(c.color) || cards.has(c.number)) continue;
      const add = Math.min(3, MAIN_SIZE - total); cards.set(c.number, add); total += add; fill.push(c.number);
    }
  }
  const nSeen = seen.legends.size + [...seen.cards.values()].reduce((a, b) => a + b, 0);
  return {
    legends: legends.slice(0, 3), cards, total,
    source: !fill.length && seen.legends.size >= 3 ? `all ${nSeen} cards seen in the game (exact)`
      : base ? `${nSeen} cards seen in the game, rest from ${base.meta ? "meta" : "published"} deck "${base.name}"`
      : `${nSeen} cards seen in the game, rest filled with extra copies`,
    base: base?.name || null, filled: fill.length, seen, unknown: [...seen.unknown],
  };
}

module.exports = { inferDeck, seenCards, MAIN_SIZE };
