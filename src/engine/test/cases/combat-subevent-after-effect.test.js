// Rule 10.16 — an event raised while an effect resolves makes its triggers pending; they
// resolve only after that effect has finished. We Gotta Live Together: "Play up to 2
// Units with cost 3 or less from your trash for free." p1 plays Valentino Street Racer
// ("{Play} Give another friendly Unit with cost 5 or less {Adrenaline} this turn.") and
// then Japantown Jonin. Street Racer's {Play} must wait until the Program has finished,
// so by then Jonin is on the field and can receive Adrenaline. (Resolving it at once, as
// the old engine did, finds no other Unit.) Both {Play}s are pending together, so p1
// also orders them.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies } = require('./_helpers');

const WGLT = 'WNTC-104', RACER = 'WNTC-091', JONIN = 'WNTC-010';
const b = mainBoard();
b.p1.zones.trash = [{ iid: 'SR', card_id: RACER }, { iid: 'JJ', card_id: JONIN }];
const pay = eddies(b, 'p1', 5);
b.p1.zones.hand = [{ iid: 'W', card_id: WGLT }];
let r = { board: b };
for (const e of pay) r = E.step(r.board, { step: 'tap_resource', iid: e });
r = E.step(r.board, { step: 'play_card', iid: 'W' });

let ordered = false, racerSawJonin = false;
for (let i = 0; i < 15 && r.waitingFor?.step === 'effect_choice'; i++) {
  const cn = r.waitingFor.choice_needed;
  const ids = cn.available_iids || [];
  let resp;
  if (cn.kind === 'choose_pending_order') {
    ordered = true;
    resp = { iid: cn.options.find(o => o.card_id === RACER).id };
  } else if (/Street Racer/.test(cn.prompt || '')) {
    racerSawJonin = ids.includes('JJ');
    resp = { iid: racerSawJonin ? 'JJ' : (ids[0] ?? null) };
  } else if (/play a Unit/.test(cn.prompt || '')) resp = { iid: 'SR' };
  else if (/second Unit/.test(cn.prompt || '')) resp = { iid: 'JJ' };
  else if (cn.kind === 'confirm_optional') resp = { accept: true };
  else resp = { iid: ids.includes('SR') ? 'SR' : (ids[0] ?? null) };
  r = E.step(r.board, { step: 'effect_choice_response', response: resp });
}
assert.strictEqual(r.waitingFor.step, 'main_phase');
assert.ok(r.board.p1.zones.field.some(u => u.iid === 'SR') && r.board.p1.zones.field.some(u => u.iid === 'JJ'));
const jj = r.board.p1.zones.field.find(u => u.iid === 'JJ');
assert.ok((jj._temp_keywords || []).map(String).some(k => k.toUpperCase() === 'ADRENALINE'),
  "Street Racer's {Play} resolved after both Units were played: Jonin got Adrenaline");
assert.ok(ordered, 'p1 ordered the two pending {Play} effects');
console.log('ok');
