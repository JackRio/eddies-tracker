// Silent effects audit for the play page's log: plays fast bot-vs-bot games through src/bot/play.js and
// lists every engine effect that resolved (trace "trig ... <Action> ok") on a move whose log lines never
// mention the card - an ability that looks like it didn't trigger.
//   node scripts/log-audit.js [--games 40] [--examples 2]
'use strict';
const play = require('../src/bot/play');
const { loadDecks, TRAIN_DIRS } = require('../src/bot/arena');
const { CARDS } = require('../src/engine');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const GAMES = +flag('--games', 40), EX = +flag('--examples', 2);
const BY = new Map(CARDS.map(c => [c.number, c]));
const short = id => (BY.get(id)?.name || id).split(':')[0];
const files = loadDecks(TRAIN_DIRS).map(d => d.name);
const silent = new Map();   // "Card · Action" -> { n, ex: [] }
let moves = 0, effects = 0;
for (let g = 0; g < GAMES; g++) {
  const id = play.create({ mode: 'watch', bots: { p1: 'G', p2: 'G' }, decks: { p1: files[g % files.length], p2: files[(g * 7 + 3) % files.length] }, first: g % 2 ? 'p2' : 'p1', seed: 1000 + g });
  const s = play._sessions.get(id);
  s.audit = [];
  for (let i = 0; i < 3000 && !s.over; i++) { if (play.advance(id)?.error) break; }
  s.audit.forEach((a, i) => {
    moves++;
    const text = s.rlog.slice(a.from, s.audit[i + 1]?.from ?? s.rlog.length).map(l => l.message).join(' | ');
    for (const l of a.trace) {
      const m = l.match(/^T\d+\/trig (p[12])\/([^#\s]+)\S* (\w+)(\{[^}]*\})? (ok|HALT)/);
      if (!m || m[5] !== 'ok') continue;
      effects++;
      const name = short(m[2]);
      if (text.includes(name)) continue;
      const k = `${name} · ${m[3]}`;
      const e = silent.get(k) || { n: 0, ex: [] };
      e.n++;
      if (e.ex.length < EX) e.ex.push(text.slice(0, 220));
      silent.set(k, e);
    }
  });
}
console.log(`${GAMES} games, ${moves} moves, ${effects} resolved effects; effects whose card the move's log never names:\n`);
for (const [k, e] of [...silent].sort((x, y) => y[1].n - x[1].n)) {
  console.log(`${String(e.n).padStart(4)}  ${k}`);
  for (const x of e.ex) console.log(`        log: ${x}`);
}
