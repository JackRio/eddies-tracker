// How fast does the deck guesser (src/bot/belief.js) work out what the Rival is playing?
//   node scripts/belief-check.js [--games N]
// Plays tuned-greedy games over all known lists. At the start of every turn it asks, from the
// player's side, what the opponent is on, and reports by game turn:
//   known  - real list among the candidates: chance given to it, and how often it is the top guess
//   hidden - real list removed (an unseen variant): chance given to "custom deck", and how often the
//            top guess at least has the right Legends face up so far / the right colours
'use strict';
const { setupGame, step, CARDS } = require('../src/engine');
const { loadDecks } = require('../src/bot/arena');
const { tryApply } = require('../src/coach/policy');
const { makeBot } = require('../src/bot/bots');
const { mulberry } = require('../src/coach/bridge');
const B = require('../src/bot/belief');

const args = process.argv.slice(2);
const games = +(args[args.indexOf('--games') + 1] || 120);
const decks = loadDecks();
const bot = makeBot('greedyt');
const BY = new Map(CARDS.map(c => [c.number, c]));
const colours = legends => [...new Set(legends.map(n => BY.get(n)?.color))].sort().join('/');
const stat = new Map();
const S = t => { if (!stat.has(t)) stat.set(t, { n: 0, pTrue: 0, top: 0, nh: 0, pCustom: 0, colOk: 0 }); return stat.get(t); };

for (let g = 0; g < games; g++) {
  const r = mulberry(g + 77);
  const d1 = decks[g % decks.length], d2 = decks[Math.floor(r() * decks.length)];
  let res = step(setupGame(d1, d2, g % 2 ? 'p1' : 'p2', { seed: 7000 + g }), undefined);
  let b = res.board, wf = res.waitingFor; b._trace = null;
  const seenTurn = new Set();
  for (let i = 0; i < 6000 && wf && !b.winner; i++) {
    const pid = wf.owner || b.active_player;
    if (wf.step === 'main_phase' && !seenTurn.has(b.turn_number)) {
      seenTurn.add(b.turn_number);
      const rv = pid === 'p1' ? 'p2' : 'p1', real = B.trueList(b, rv), seen = B.shown(b, rv);
      const s = S(Math.min(b.turn_number, 14));
      const post = B.posterior(seen);
      const hit = post.find(x => x.deck !== 'custom' && B.sameList(x.deck, real));
      s.n++; s.pTrue += hit ? hit.w : 0; s.top += post[0].deck !== 'custom' && B.sameList(post[0].deck, real) ? 1 : 0;
      const hid = B.posterior(seen, { exclude: d => B.sameList(d, real) });
      s.nh++; s.pCustom += hid.find(x => x.deck === 'custom').w;
      const best = hid.find(x => x.deck !== 'custom');
      s.colOk += best && colours(best.deck.legends) === colours(real.legends) ? 1 : 0;
    }
    const seq = bot.act(b, wf, pid, { rng: r });
    const nx = seq && tryApply(b, wf, seq);
    if (!nx) break;
    b = nx.board; wf = nx.waitingFor; b._trace = null;
  }
}

console.log(`${games} games, ${decks.length} known lists. Turn = game turn (both players count).`);
console.log('turn | real list known: P(real)  top guess right | real list hidden: P(custom)  best list has right colours');
for (const [t, s] of [...stat].sort((a, b) => a[0] - b[0])) {
  console.log(`${String(t).padStart(4)} | ${(100 * s.pTrue / s.n).toFixed(0).padStart(20)}%  ${(100 * s.top / s.n).toFixed(0).padStart(14)}% | ${(100 * s.pCustom / s.nh).toFixed(0).padStart(20)}%  ${(100 * s.colOk / s.nh).toFixed(0).padStart(26)}%   (${s.n})`);
}
