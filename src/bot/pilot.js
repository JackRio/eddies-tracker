// Pilots: one archetype bot each (BBG, YYR, RRG, RGB), playing Bo3 matches with a deck it tunes.
//
// A pilot's state (src/bot/pilots/state/<ID>.json) is everything it learns outside the nets:
//   champion       { main, side }  the deck it currently believes is best (seeded from ChoomBattler)
//   challenger     { main, side, change } one-card variation being tested against the champion
//   tune           { champ: [w, n], chall: [w, n] }  match results with each since the last promotion
//   first          { oppKey: { first: [w, n], second: [w, n] } }  games won going first / second
//   swaps          { "oppKey|plan": [w, n] }  games 2-3 won with each sideboard plan vs that opponent
//   history        promotions / rejected changes, newest last
// All choices are Thompson sampling over Beta posteriors: plans that look good get played more, but
// every option keeps a chance until the data rules it out ("try a few cards").
//
// Rules used here (Tournament Rules, Appendix D.1 + the comprehensive rules): 3 Legends, 40-50 cards,
// max 3 copies of a card across main + sideboard, sideboard exactly 7 cards and no Legends, RAM per
// colour within the Legends' total. Between games of a match a pilot swaps cards 1-for-1 with its
// sideboard (deck size unchanged); each game starts from its registered deck + sideboard.
'use strict';
const fs = require('fs');
const path = require('path');
const { CARDS, deckIsIllegal } = require('../engine');

const DATA = path.join(__dirname, 'pilots', 'choombattler.json');
const STATE_DIR = path.join(__dirname, 'pilots', 'state');
const LEGAL = CARDS.filter(c => c.legal !== false);
const BY = new Map(CARDS.map(c => [c.number, c]));
const byName = n => LEGAL.find(c => c.name === n) || LEGAL.find(c => c.name.split(':')[0] === n && c.type !== 'Legend');
const SIDE = 7, MAX_COPIES = 3;

// ── decks as { id: count } maps ──
const toMap = list => { const m = {}; for (const [k, n] of list) { const c = byName(n); if (!c) throw new Error(`unknown card ${n}`); if (c.type !== 'Legend') m[c.number] = (m[c.number] || 0) + k; } return m; };
const legendsOf = list => list.map(([, n]) => byName(n)).filter(c => c && c.type === 'Legend').map(c => c.number);
const total = m => Object.values(m).reduce((a, x) => a + x, 0);
const add = (m, id, k) => { const r = { ...m }; r[id] = (r[id] || 0) + k; if (r[id] <= 0) delete r[id]; return r; };
function deckDef(legends, main, name = 'pilot') {
  return { name, legends: legends.slice(), cards: Object.entries(main).map(([card_id, count]) => ({ card_id, count })), unknown: [] };
}
// legal: main deck (engine check) + sideboard size / no Legends / copies across both
function legal(legends, main, side) {
  if (deckIsIllegal(deckDef(legends, main))) return false;
  if (side && (total(side) !== SIDE || Object.keys(side).some(id => BY.get(id)?.type === 'Legend'))) return false;
  for (const id of new Set([...Object.keys(main), ...Object.keys(side || {})])) if ((main[id] || 0) + ((side || {})[id] || 0) > MAX_COPIES) return false;
  return true;
}

// ── random helpers (rng: () => [0, 1)) ──
function gamma(k, rng) {   // Marsaglia-Tsang, k >= 1 (our counts + 1)
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = rng() || 1e-9, u2 = rng(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u || 1e-9) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = ([w, n], rng, prior = [1, 1]) => { const a = gamma(w + prior[0], rng), b = gamma(n - w + prior[1], rng); return a / (a + b); };
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

// ── the seed: ChoomBattler list + a 7-card sideboard from the trio's other cards ──
function seed(id) {
  const P = JSON.parse(fs.readFileSync(DATA, 'utf8')).pilots[id];
  if (!P) throw new Error(`no pilot ${id}`);
  const legends = legendsOf(P.list), main = toMap(P.list);
  const pool = [...new Set(P.pool.map(([n]) => byName(n)?.number).filter(Boolean))];
  // sideboard: cards these lists play that the standard list doesn't (or not at full copies), most
  // popular first, one copy at a time - the "try a few cards" start; tuning replaces them later
  let side = {};
  const cand = P.pool.map(([n, avg, pct]) => ({ id: byName(n)?.number, avg, pct })).filter(x => x.id).sort((a, b) => b.pct - a.pct);
  for (let round = 0; round < 3 && total(side) < SIDE; round++)
    for (const c of cand) {
      if (total(side) >= SIDE) break;
      if ((main[c.id] || 0) + (side[c.id] || 0) >= Math.min(MAX_COPIES, Math.ceil(c.avg))) continue;
      side = add(side, c.id, 1);
    }
  // still short (a trio whose pool is all in the main deck): any legal card of the deck's colours
  for (const c of LEGAL) {
    if (total(side) >= SIDE) break;
    if (c.type === 'Legend' || (main[c.number] || 0) + (side[c.number] || 0) >= MAX_COPIES) continue;
    const s2 = add(side, c.number, 1);
    if (legal(legends, add(main, c.number, 0), null) && !deckIsIllegal(deckDef(legends, { ...main, [c.number]: (main[c.number] || 0) + 1 }))) side = s2;
  }
  return {
    id, trio: P.trio, source: `${P.queue} ${P.games} games ${P.wr}%`, legends, pool,
    champion: { main, side }, challenger: null, tune: { champ: [0, 0], chall: [0, 0] },
    first: {}, swaps: {}, history: [], version: 1, matches: 0,
  };
}

const file = id => path.join(STATE_DIR, `${id}.json`);
function load(id) {
  if (fs.existsSync(file(id))) return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  return seed(id);
}
function save(st) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(file(st.id), JSON.stringify(st, null, 1)); }

// ── deck tuning: a challenger differs from the champion by one card ──
// change: { kind: 'main'|'side', out, in } - one copy of `out` replaced by one copy of `in`
function mutate(st, rng) {
  const { main, side } = st.champion;
  for (let tries = 0; tries < 200; tries++) {
    const kind = rng() < 0.65 ? 'main' : 'side';
    const from = kind === 'main' ? main : side;
    const out = pick(Object.keys(from), rng);
    // in: mostly the trio's pool, sometimes any legal non-Legend card (explore beyond the meta)
    const inn = rng() < 0.8 ? pick(st.pool, rng) : pick(LEGAL.filter(c => c.type !== 'Legend'), rng).number;
    if (!inn || inn === out) continue;
    const m2 = kind === 'main' ? add(add(main, out, -1), inn, 1) : main;
    const s2 = kind === 'side' ? add(add(side, out, -1), inn, 1) : side;
    if (!legal(st.legends, m2, s2)) continue;
    return { main: m2, side: s2, change: { kind, out, in: inn } };
  }
  return null;
}
// after a match: count it for the deck it used; promote / reject once there's enough evidence
const TUNE_MIN = 24, TUNE_MAX = 80;
function recordTuning(st, usedChallenger, won, rng) {
  const k = usedChallenger ? 'chall' : 'champ';
  st.tune[k][1]++; if (won) st.tune[k][0]++;
  const [cw, cn] = st.tune.chall, [pw, pn] = st.tune.champ;
  if (!st.challenger || cn < TUNE_MIN) return null;
  // P(challenger better) by sampling both posteriors
  let better = 0;
  for (let i = 0; i < 400; i++) if (beta([cw, cn], rng) > beta([pw, pn], rng)) better++;
  const p = better / 400, ch = st.challenger.change;
  let verdict = null;
  if (p > 0.85) { st.champion = { main: st.challenger.main, side: st.challenger.side }; verdict = 'promoted'; st.version++; }
  else if (p < 0.3 || cn >= TUNE_MAX) verdict = 'rejected';
  if (verdict) {
    st.history.push({ at: st.matches, verdict, change: { ...ch, outName: BY.get(ch.out)?.name, inName: BY.get(ch.in)?.name }, chall: [cw, cn], champ: [pw, pn], p: Math.round(p * 100) / 100 });
    st.challenger = null; st.tune = { champ: verdict === 'promoted' ? [cw, cn] : [pw, pn], chall: [0, 0] };
  }
  return verdict;
}
// which deck to register for the next match (champion or challenger, alternating while testing)
function registerDeck(st, rng) {
  if (!st.challenger) st.challenger = mutate(st, rng);
  const useChall = !!st.challenger && st.tune.chall[1] <= st.tune.champ[1];
  const d = useChall ? st.challenger : st.champion;
  return { main: d.main, side: d.side, challenger: useChall };
}

// ── go first or second (the D20 winner's choice) ──
// prior: ChoomBattler's field wins 59.5% going first
function chooseFirst(st, oppKey, rng) {
  const s = st.first[oppKey] || { first: [0, 0], second: [0, 0] };
  return beta(s.first, rng, [6, 4]) >= beta(s.second, rng, [4, 6]);
}
function recordFirst(st, oppKey, wentFirst, won) {
  const s = st.first[oppKey] ||= { first: [0, 0], second: [0, 0] };
  const k = wentFirst ? 'first' : 'second';
  s[k][1]++; if (won) s[k][0]++;
}

// ── sideboarding between games ──
// A plan is a list of 1-for-1 swaps [[out, in], ...] (main card out, sideboard card in). Candidates:
// no swap, every single swap that keeps the deck legal, and a few pairs. Thompson sampling over each
// plan's record vs this opponent; untried plans keep a fair chance.
function plans(legends, main, side, rng, maxPlans = 40) {
  const singles = [];
  for (const inn of Object.keys(side)) for (const out of Object.keys(main)) {
    if (inn === out) continue;
    const m2 = add(add(main, out, -1), inn, 1);
    if (!deckIsIllegal(deckDef(legends, m2))) singles.push([out, inn]);
  }
  const out = [[]];
  const shuffled = singles.map(x => [rng(), x]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  for (const s of shuffled.slice(0, maxPlans - 10)) out.push([s]);
  for (let i = 0; i < 10 && shuffled.length > 1; i++) {
    const a = pick(shuffled, rng), b = pick(shuffled, rng);
    if (a[1] === b[1] && (side[a[1]] || 0) < 2) continue;
    if (a === b) continue;
    const m2 = add(add(add(add(main, a[0], -1), a[1], 1), b[0], -1), b[1], 1);
    if (!deckIsIllegal(deckDef(legends, m2))) out.push([a, b]);
  }
  return out;
}
const planKey = p => p.length ? p.map(([o, i]) => `${o}>${i}`).sort().join(',') : 'none';
function chooseSideboard(st, deck, oppKey, rng) {
  const P = plans(st.legends, deck.main, deck.side, rng);
  let best = null, bv = -1;
  for (const p of P) {
    const rec = st.swaps[`${oppKey}|${planKey(p)}`] || [0, 0];
    const v = beta(rec, rng, p.length ? [1, 1] : [2, 2]);   // 'none' starts a little more trusted
    if (v > bv) { bv = v; best = p; }
  }
  let main = deck.main, side = deck.side;
  for (const [o, i] of best) { main = add(add(main, o, -1), i, 1); side = add(add(side, i, -1), o, 1); }
  return { main, side, plan: best, key: planKey(best) };
}
function recordSideboard(st, oppKey, key, won) {
  const r = st.swaps[`${oppKey}|${key}`] ||= [0, 0];
  r[1]++; if (won) r[0]++;
}

const cardName = id => BY.get(id)?.name || id;
module.exports = { seed, load, save, deckDef, legal, registerDeck, recordTuning, chooseFirst, recordFirst, chooseSideboard, recordSideboard, planKey, cardName, STATE_DIR, beta };
