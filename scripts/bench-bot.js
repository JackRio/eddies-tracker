// Speed benchmark + determinism check for the search bot: plays N fixed games (pilot decks, fixed seeds)
// with the same spec on both sides, prints ms per decision and a hash of every move played.
// Two code versions that play identical games print the same hash.
//   node scripts/bench-bot.js [--games 2] [--spec <bot spec>] [--seed 900] [--turns 16]
'use strict';
const crypto = require('crypto');
const { playGame } = require('../src/bot/match');
const { makeBot } = require('../src/bot/bots');
const P = require('../src/bot/pilot');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAEMON = 'strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:gb=1:alt=1:tb=1';
const spec = flag('--spec', DAEMON), games = +flag('--games', 2), seed0 = +flag('--seed', 900), maxTurns = +flag('--turns', 16);
const ids = ['YYR', 'BBG', 'RRG', 'RGB'];
const deck = id => { const s = P.load(id); return P.deckDef(s.legends, s.champion.main, id); };
let totalMs = 0, decisions = 0;
const h = crypto.createHash('sha256');
for (let g = 0; g < games; g++) {
  const A = ids[g % 4], B = ids[(g + 1) % 4];
  const bot = makeBot(spec);
  let n = 0;
  const timed = { key: 'x', bot: { name: bot.name, act: (...a) => { const t = process.hrtime.bigint(); const r = bot.act(...a); totalMs += Number(process.hrtime.bigint() - t) / 1e6; n++; return r; } } };
  const t0 = Date.now();
  const r = playGame({ p1: timed, p2: timed }, { p1: deck(A), p2: deck(B) }, g % 2 ? 'p2' : 'p1', seed0 + g, { record: true, maxTurns });
  decisions += n;
  h.update(JSON.stringify(r.actions));
  console.log(`game ${g + 1} ${A} vs ${B}: winner ${r.winner} turns ${r.turns} decisions ${n} ${((Date.now() - t0) / 1000).toFixed(1)}s${r.error ? ' ERR ' + r.error : ''}`);
}
console.log(`ms/decision ${(totalMs / decisions).toFixed(1)}  decisions ${decisions}  hash ${h.digest('hex').slice(0, 16)}`);
