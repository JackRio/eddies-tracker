// Sanity probes for the value net: does it react the right way to changes that are obviously good
// (or bad) for the player to move? Catches nets that learned correlations instead of causes - the
// first value net thought selling a card was bad (-4.5 points on average), so the search stopped
// selling and the bot sat on 11 cards.
//   node scripts/value-probes.js [value-net.json] [--games N]
// Positions: turn starts from tuned-greedy games on the real lists. Each probe edits a copy of the
// position and compares the net's win chance before/after. "right way" = share of positions where the
// change moved the estimate in the expected direction (ties count as wrong).
'use strict';
const path = require('path');
const { setupGame, step } = require('../src/engine');
const { loadDecks } = require('../src/bot/arena');
const { makeBot } = require('../src/bot/bots');
const { tryApply, opp } = require('../src/coach/policy');
const { mulberry } = require('../src/coach/bridge');
const { cloneBoard } = require('../src/engine/lib/clone');
const V = require('../src/bot/value');

const args = process.argv.slice(2);
const file = args.find(a => a.endsWith('.json')) || V.FILE;
const games = args.includes('--games') ? +args[args.indexOf('--games') + 1] : 60;
const net = V.load(path.resolve(file));

// each probe: (board copy, pid) -> mutates it, returns false if not applicable; sign = expected direction
const PROBES = [
  { name: 'sell a card (hand -> Eddie)', sign: +1, f: (c, p) => { const Z = c[p].zones; if (Z.hand.length < 2) return false; Z.eddies.push({ ...Z.hand.pop(), state: 'ready' }); } },
  { name: 'gain a Gig (Rival loses it)', sign: +1, f: (c, p) => { const R = c[opp(p)].zones; if (!R.gigs.length) return false; c[p].zones.gigs.push(R.gigs.pop()); } },
  { name: 'Rival gains one of your Gigs', sign: -1, f: (c, p) => { const Z = c[p].zones; if (!Z.gigs.length) return false; c[opp(p)].zones.gigs.push(Z.gigs.pop()); } },
  { name: 'draw a card (deck -> hand)', sign: +1, f: (c, p) => { const Z = c[p].zones; if (Z.deck.length < 5 || Z.hand.length > 6) return false; Z.hand.push(Z.deck.pop()); } },
  { name: 'Rival Unit defeated (field -> trash)', sign: +1, f: (c, p) => { const R = c[opp(p)].zones; if (!R.field.length) return false; const u = R.field.pop(); R.trash.push({ iid: u.iid, card_id: u.card_id }, ...(u.equipped_gear || []).map(g => ({ iid: g.iid, card_id: g.card_id }))); } },
  { name: 'your Unit defeated', sign: -1, f: (c, p) => { const Z = c[p].zones; if (!Z.field.length) return false; const u = Z.field.pop(); Z.trash.push({ iid: u.iid, card_id: u.card_id }, ...(u.equipped_gear || []).map(g => ({ iid: g.iid, card_id: g.card_id }))); } },
  { name: 'extra ready Eddie', sign: +1, f: (c, p) => { const Z = c[p].zones; if (Z.deck.length < 5) return false; Z.eddies.push({ ...Z.deck.pop(), state: 'ready' }); } },
];

const decks = loadDecks();
const bot = makeBot('greedyt');
const stats = PROBES.map(() => ({ n: 0, right: 0, sum: 0 }));
for (let s = 0; s < games; s++) {
  const r = mulberry(s + 31337);
  let x = step(setupGame(decks[s % decks.length], decks[(s * 7 + 3) % decks.length], s % 2 ? 'p1' : 'p2', { seed: 424242 + s }), undefined);
  let b = x.board, wf = x.waitingFor; b._trace = null;
  const seen = new Set();
  for (let i = 0; i < 6000 && wf && !b.winner; i++) {
    const pid = wf.owner || b.active_player;
    if (wf.step === 'main_phase' && !seen.has(b.turn_number)) {
      seen.add(b.turn_number);
      const v0 = V.value(b, pid, net);
      PROBES.forEach((P, k) => {
        const c = cloneBoard(b);
        if (P.f(c, pid) === false) return;
        const d = V.value(c, pid, net) - v0;
        stats[k].n++; stats[k].sum += d; if (Math.sign(d) === P.sign) stats[k].right++;
      });
    }
    const nx = tryApply(b, wf, bot.act(b, wf, pid, { rng: r }));
    if (!nx) break;
    b = nx.board; wf = nx.waitingFor; b._trace = null;
  }
}
console.log(`value-net probes: ${path.basename(file)} (${games} games)`);
let worst = 1;
PROBES.forEach((P, k) => {
  const S = stats[k], share = S.right / (S.n || 1);
  worst = Math.min(worst, share);
  console.log(`  ${P.name.padEnd(38)} right way ${(100 * share).toFixed(0).padStart(3)}%   avg change ${(100 * S.sum / (S.n || 1) >= 0 ? '+' : '')}${(100 * S.sum / (S.n || 1)).toFixed(1)} pts   (${S.n})`);
});
console.log(worst >= 0.8 ? 'PASS: every probe moves the right way in >= 80% of positions' : 'FAIL: some probe moves the wrong way too often');
