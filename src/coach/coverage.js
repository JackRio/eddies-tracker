// Shadow check (milestone 1): for each of your turns, can the engine get from the replay's
// position A to the position you actually reached (B)? The bot tries many noisy turn plans from A;
// if one ends with your side matching B exactly, the bridge, the engine and the sim agree on that
// turn. Turns no plan reproduces point at a bridge gap, a rules difference between the two
// simulators, or simply a line the bot did not think of - the closest miss is printed.
'use strict';
const path = require('path');
const { loadReplay, allStates, cardKnowledge } = require('./sim');
const { inferDeck } = require('./decks');
const { toBoard, signature, mulberry } = require('./bridge');
const { turnPositions } = require('./positions');
const { playTurn } = require('./search');
const { mainWaiting } = require('../engine/lib/combat');

// your side of the signature, minus which Legends are spent: payment is a free choice in the sim
// (the bot pays with face-down Legends first), so it says nothing about rules agreement
const mySide = (sig, pid) => ((sig.match(new RegExp(`${pid}\\[([^\\]]*)\\]`)) || [])[1] || '')
  .split(' ; ').map(p => (p.startsWith('L') ? p.replace(/\*/g, '') : p)).join(' ; ');
const parts = s => s.split(' ; ');
const dist = (x, y) => { const a = parts(x), b = parts(y); return a.reduce((n, p, i) => n + (p === b[i] ? 0 : 1), 0); };

function run(files, tries = 40) {
  let total = 0, hit = 0, near = 0;
  const misses = [];
  for (const file of files) {
    const R = loadReplay(file);
    const states = allStates(R.json);
    const knowledge = cardKnowledge(states);
    const last = states[states.length - 1].state;
    const decks = {}, pidMap = { player1: 'p1', player2: 'p2' };
    for (const sid of Object.keys(last.players)) decks[sid] = inferDeck(knowledge, sid, last.players[sid].deckName);
    const ctx = { pidMap, knowledge, decks }, pid = pidMap[R.me];
    let fh = 0, ft = 0;
    for (const T of turnPositions(states, R.me)) {
      if (!T.ended) continue;
      const a = mainWaiting(structuredClone(toBoard(states[T.a].state, ctx, 1).board));
      const want = mySide(signature(toBoard(states[T.b].state, ctx, 1).board), pid);
      let best = null, bestD = 1e9;
      for (let k = 0; k < tries && bestD > 0; k++) {
        const res = playTurn(a.board, a.waitingFor, pid, { rng: mulberry(9000 + k), noise: k === 0 ? 0 : 2 + (k % 8) });
        const got = mySide(signature(res.board), pid);
        const d = dist(got, want);
        if (d < bestD) { bestD = d; best = got; }
      }
      ft++; total++;
      if (bestD === 0) { fh++; hit++; }
      else { if (bestD === 1) near++; misses.push({ file: path.basename(file), turn: T.turn, want, best, d: bestD, did: T.log.slice(0, 6) }); }
    }
    console.log(`  ${path.basename(file).replace('cyberpunk-tcg-sim-replay-', '')}: ${fh}/${ft} of your turns reproduced`);
  }
  const pc = n => Math.round(100 * n / (total || 1));
  console.log(`\nShadow check: the engine reproduces ${hit}/${total} of your turns exactly (${pc(hit)}%), ` +
    `${hit + near}/${total} to within one detail (${pc(hit + near)}%).`);
  misses.sort((x, y) => y.d - x.d);
  if (misses.length) console.log('\nFurthest misses:');
  for (const m of misses.slice(0, 8)) console.log(`\n  ${m.file} turn ${m.turn} (${m.d} details differ)\n    you:     ${m.want}\n    closest: ${m.best}\n    log:     ${m.did.join(' / ')}`);
  return { total, hit, misses };
}

module.exports = { run };
