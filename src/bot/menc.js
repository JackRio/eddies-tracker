// Move encoding for the policy ("intuition") net: one macro move (see coach/policy.js moves) as
// sparse indices into a fixed-size table:
//   kind      - what the move does (sell, play Unit/Gear/Program, equip, call, Go Solo, Spend,
//               attack Gigs / attack Unit, block, interrupt, pass, end turn, die, steal, each
//               effect-choice response type, mulligan)
//   actor     - the card doing it (the played/sold/called card, the attacker, the blocker)
//   target    - the card it points at (Gear host, attacked Unit, picked card), split by owner
//   selected  - every card picked in a multi-pick choice
//   taps      - how many resources it spends (bucketed), die sides
// Card indices use the value net's vocabulary (150 legal cards).
'use strict';
const { VOCAB } = require('./vfeatures');
const { card } = require('../coach/policy');

const IDX = new Map(VOCAB.map((n, i) => [n, i]));
const V = VOCAB.length;
const KINDS = ['sell', 'play_unit', 'play_program', 'equip_unit', 'equip_legend', 'call', 'solo', 'spend',
  'attack_gigs', 'attack_unit', 'block', 'call_defensive', 'interrupt', 'asset_spend', 'pass_defensive',
  'pass_interrupt', 'end_turn', 'die', 'steal', 'mulligan_keep', 'mulligan_redraw',
  'resp_accept', 'resp_decline', 'resp_pick', 'resp_pick_none', 'resp_multi', 'resp_amount', 'resp_type', 'resp_ack', 'other'];
const OFF = {};
let o = 0;
for (const [k, n] of [['kind', KINDS.length], ['actor', V], ['tgtMine', V], ['tgtRival', V], ['selected', V], ['taps', 8], ['die', 6], ['amount', 6]]) { OFF[k] = o; o += n; }
const SIZE = o;

function locate(b, iid) {
  for (const p of ['p1', 'p2']) {
    const Z = b[p].zones;
    for (const z of ['hand', 'field', 'legends', 'trash', 'eddies', 'deck', 'removed']) {
      for (const r of Z[z] || []) {
        if (r.iid === iid) return { id: r.card_id, owner: p };
        for (const g of r.equipped_gear || []) if (g.iid === iid) return { id: g.card_id, owner: p };
      }
    }
  }
  return null;
}

// -> [[index, value], ...]
function encodeMove(b, pid, seq) {
  const out = new Map();
  const put = (k, v = 1) => out.set(k, (out.get(k) || 0) + v);
  const kind = k => put(OFF.kind + Math.max(0, KINDS.indexOf(k)));
  const cardAt = (slot, iid) => {
    const f = iid != null && locate(b, iid);
    if (!f) return;
    const i = IDX.get(f.id);
    if (i === undefined) return;
    if (slot === 'target') put((f.owner === pid ? OFF.tgtMine : OFF.tgtRival) + i);
    else put(OFF[slot] + i);
  };
  const taps = seq.filter(a => a.step === 'tap_resource').length;
  put(OFF.taps + Math.min(taps, 7));
  const a = seq[seq.length - 1];
  switch (a.step) {
    case 'sell_card': kind('sell'); cardAt('actor', a.iid); break;
    case 'play_card': {
      const f = locate(b, a.iid), t = f && card(f.id).type;
      if (a.equip_to) { const h = locate(b, a.equip_to); kind(h && card(h.id).type === 'Legend' ? 'equip_legend' : 'equip_unit'); cardAt('target', a.equip_to); }
      else kind(t === 'Program' ? 'play_program' : 'play_unit');
      cardAt('actor', a.iid); break;
    }
    case 'call_legend': kind('call'); cardAt('actor', a.iid); break;
    case 'play_legend_solo': kind('solo'); cardAt('actor', a.iid); break;
    case 'activate_anytime_spend': kind('spend'); cardAt('actor', a.iid); break;
    case 'declare_attack':
      kind(a.target.kind === 'gigs' ? 'attack_gigs' : 'attack_unit'); cardAt('actor', a.attacker_iid);
      if (a.target.kind === 'unit') cardAt('target', a.target.iid); break;
    case 'blocker': kind('block'); cardAt('actor', a.iid); if (b.current_attack) cardAt('target', b.current_attack.attacker_iid); break;
    case 'call_legend_defensive': kind('call_defensive'); cardAt('actor', a.iid); break;
    case 'play_card_interrupt_cast': kind('interrupt'); cardAt('actor', a.iid); break;
    case 'activate_asset_spend': kind('asset_spend'); cardAt('actor', a.iid); break;
    case 'pass_defensive': kind('pass_defensive'); break;
    case 'pass_attacker_interrupt': kind('pass_interrupt'); break;
    case 'end_turn': kind('end_turn'); break;
    case 'choose_gig_die': kind('die'); put(OFF.die + Math.min(5, Math.max(0, (a.sides - 2) / 2 | 0))); break;
    case 'choose_gig_to_steal': kind('steal'); put(OFF.amount + Math.min(5, a.iids.length)); break;
    case 'mulligan': kind(a.mulligan ? 'mulligan_redraw' : 'mulligan_keep'); break;
    case 'effect_choice_response': {
      const r = a.response || {};
      if (r.acknowledge) kind('resp_ack');
      else if (r.accept === true) kind('resp_accept');
      else if (r.accept === false) kind('resp_decline');
      else if (r.card_type) kind('resp_type');
      else if (r.amount !== undefined) { kind('resp_amount'); put(OFF.amount + Math.min(5, Math.max(0, r.amount))); }
      else if (r.selected_iids) { kind('resp_multi'); for (const i of r.selected_iids) cardAt('selected', i); }
      else if (r.iid) { kind('resp_pick'); cardAt('target', r.iid); }
      else kind('resp_pick_none');
      break;
    }
    default: kind('other');
  }
  return [...out];
}

// short label for reports
function kindOf(seq) {
  const a = seq[seq.length - 1];
  if (a.step === 'play_card') return a.equip_to ? 'equip' : 'play';
  if (a.step === 'declare_attack') return a.target.kind === 'gigs' ? 'attack_gigs' : 'attack_unit';
  if (a.step === 'effect_choice_response') return 'effect_choice';
  return a.step;
}

module.exports = { encodeMove, kindOf, SIZE, KINDS, OFF };
