// Sanity check for the coach's rollout bot: it should beat a bot that plays random legal moves
// (the engine fuzzer's move list) by a wide margin across the meta decks in src/engine/test/decks.
'use strict';
const fs = require('fs');
const path = require('path');
const { setupGame, step } = require('../engine');
const { parseTxt } = require('../engine/test/decks');
const { candidates, rng } = require('../engine/test/fuzz');
const { botStep, tryApply } = require('./policy');
const { mulberry } = require('./bridge');

function run(games = 24) {
  const dir = path.join(__dirname, '..', 'engine', 'test', 'decks');
  const decks = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).map(f => parseTxt(path.join(dir, f)));
  let wins = 0, played = 0;
  for (let g = 0; g < games; g++) {
    const d1 = decks[g % decks.length], d2 = decks[(g + 1 + Math.floor(g / decks.length)) % decks.length];
    const botSide = g % 2 ? 'p1' : 'p2';
    const r = rng(g + 1), opts = { rng: mulberry(g + 1), noise: 0 };
    let res = step(setupGame(d1, d2, g % 4 < 2 ? 'p1' : 'p2', { seed: g + 1 }), undefined);
    let b = res.board, wf = res.waitingFor;
    for (let i = 0; i < 6000 && wf && !b.winner && b.turn_number < 80; i++) {
      const owner = wf.owner || b.active_player;
      let nx = null;
      if (owner === botSide) nx = botStep(b, wf, opts);
      else {
        const c = candidates(wf, b, r);
        for (let k = 0; k < 8 && !nx && c.length; k++) nx = tryApply(b, wf, c[Math.floor(r() * c.length)]);
        if (!nx) nx = botStep(b, wf, { rng: r, noise: 50 });
      }
      if (!nx) break;
      b = nx.board; wf = nx.waitingFor;
    }
    if (b.winner) { played++; if (b.winner === botSide) wins++; }
  }
  console.log(`Bot check: coach bot beat a random-move bot in ${wins}/${played} finished games (${Math.round(100 * wins / (played || 1))}%).`);
  return { wins, played };
}

module.exports = { run };
if (require.main === module) run(+(process.argv[2] || 24));
