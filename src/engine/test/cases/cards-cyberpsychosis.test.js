// Cyberpsychosis: "If that Unit steals or fights, defeat it at the end of this turn."
// FAQ: a Unit that already fought BEFORE Cyberpsychosis was played is not defeated.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, run } = require('./_helpers');

function game(castFirst) {
  const b = mainBoard();
  b.turn_number = 3;
  const u = unit(b, 'p1', 'WNTC-077', { iid: 'me', equipped_gear: [{ iid: 'mb', card_id: 'WNTC-025' }] });
  unit(b, 'p2', 'WNTC-076', { iid: 'v1', state: 'spent' });
  unit(b, 'p2', 'WNTC-076', { iid: 'v2', state: 'spent' });
  b.p1.zones.hand = [{ iid: 'cp', card_id: 'WNTC-067' }];
  const cast = r => { r.board.p1.tapped = eddies(r.board, 'p1', 3, 'c');
    return run(E.step(r.board, { step: 'play_card', iid: 'cp' }), x => x.waitingFor?.step === 'main_phase'); };
  const fight = (r, t) => run(E.step(r.board, { step: 'declare_attack', attacker_iid: 'me', target: { kind: 'unit', iid: t } }),
    x => x.waitingFor?.step === 'main_phase');
  let r = { board: b };
  if (castFirst) { r = cast(r); r.board.p1.zones.field[0].state = 'ready'; r = fight(r, 'v1'); }
  else { r = fight(r, 'v1'); r = cast(r); }
  r = run(E.step(r.board, { step: 'end_turn' }), x => x.board.active_player === 'p2');
  return r.board.p1.zones.field.some(x => x.iid === 'me');
}

assert.strictEqual(game(false), true, 'fought before Cyberpsychosis: survives (FAQ)');
assert.strictEqual(game(true), false, 'fights after Cyberpsychosis: defeated at end of turn');
console.log('ok');
