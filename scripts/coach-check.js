// Bridge check (Replay Coach milestone 1): converts every calm position of every replay into an
// engine board and checks it. Prints one line per replay plus a list of problems.
//   node scripts/coach-check.js [replay files or folder]   (default board/replays)
//   --coverage   also check that the engine can reproduce each of your turns (about a minute)
//   --bot        also check the rollout bot beats random play
'use strict';
const fs = require('fs');
const path = require('path');
const { loadReplay, allStates, cardKnowledge } = require('../src/coach/sim');
const { inferDeck } = require('../src/coach/decks');
const { toBoard, isCalm } = require('../src/coach/bridge');
const { mainWaiting } = require('../src/engine/lib/combat');
const { cardByNumber } = require('../src/coach/cards');

const args = process.argv.slice(2);
const coverage = args.includes('--coverage');
const inputs = args.filter(a => !a.startsWith('--'));
const dir = path.join(__dirname, '..', 'board', 'replays');
const files = (inputs.length ? inputs : [dir]).flatMap(p => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]);

const problems = new Map();
const problem = (k, ex) => { const e = problems.get(k) || { n: 0, ex }; e.n++; problems.set(k, e); };

let totalPos = 0, okPos = 0;
for (const file of files) {
  const R = loadReplay(file);
  const states = allStates(R.json);
  const knowledge = cardKnowledge(states);
  const last = states[states.length - 1].state;
  const decks = {}, pidMap = {};
  for (const sid of Object.keys(last.players)) {
    decks[sid] = inferDeck(knowledge, sid, last.players[sid].deckName);
    pidMap[sid] = sid === 'player1' ? 'p1' : 'p2';
    for (const u of decks[sid].unknown) problem(`unknown card name "${u}"`, path.basename(file));
  }
  const ctx = { pidMap, knowledge, decks };
  let pos = 0, ok = 0;
  for (const { state, step } of states) {
    if (!isCalm(state)) continue;
    pos++;
    let res;
    try {
      const { board, notes } = toBoard(state, ctx, step);
      for (const n of notes) problem(n.replace(/\d+ -> \d+/, 'N -> M'), `${path.basename(file)} step ${step}`);
      res = mainWaiting(structuredClone(board));
      const bb = res.board;
      let bad = false;
      for (const [sid, S] of Object.entries(state.players)) {
        const Z = bb[pidMap[sid]].zones;
        const cmp = { hand: [Z.hand.length, S.handCount ?? S.hand.length], deck: [Z.deck.length, S.deckCount], field: [Z.field.length, S.field.length],
          trash: [Z.trash.length, S.trash.length], legends: [Z.legends.length, S.legends.length], eddies: [Z.eddies.length, S.eddies.length],
          gigs: [Z.gigs.length, S.gigDice.length] };
        for (const [z, [e, s]] of Object.entries(cmp)) if (s != null && e !== s) { bad = true; problem(`${z} count differs`, `${path.basename(file)} step ${step}: engine ${e} vs sim ${s}`); }
        for (const ref of [...Z.hand, ...Z.deck, ...Z.trash, ...Z.legends, ...Z.eddies, ...Z.field])
          if (!cardByNumber(ref.card_id)) { bad = true; problem('card with no engine id', `${path.basename(file)} step ${step} ${JSON.stringify(ref).slice(0, 80)}`); }
      }
      const dice = ['p1', 'p2'].reduce((n, p) => n + bb[p].zones.gigs.length + bb[p].zones.fixer.length, 0);
      if (dice !== 12) { bad = true; problem('dice total is not 12', `${path.basename(file)} step ${step}: ${dice}`); }
      if (res.waitingFor?.step !== 'main_phase') { bad = true; problem('engine not waiting for a main-phase move', `${path.basename(file)} step ${step}: ${res.waitingFor?.step}`); }
      if (!bad) ok++;
    } catch (e) {
      problem(`throws: ${e.message}`, `${path.basename(file)} step ${step} ${(e.stack || '').split('\n')[1]?.trim()}`);
    }
  }
  totalPos += pos; okPos += ok;
  const me = R.me;
  console.log(`${path.basename(file).replace('cyberpunk-tcg-sim-replay-', '')}: ${ok}/${pos} positions ok | your deck: ${decks[me].source}; Rival: ${decks[R.rival].source}`);
}
console.log(`\n${okPos}/${totalPos} calm positions convert cleanly`);
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${v.n}x ${k}   e.g. ${v.ex}`);
if (coverage) require('../src/coach/coverage').run(files);
if (args.includes('--bot')) require('../src/coach/botcheck').run(24);
