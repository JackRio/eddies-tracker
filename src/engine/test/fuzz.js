// Random-legal self-play fuzzer with rule invariants.
'use strict';
const path = require('path');
const { parseTxt, ENG } = require('./decks');
const { setupGame, step, defaultPassAction, CARDS } = require(ENG);
const DB = Object.fromEntries(CARDS.map(c => [c.number, c]));
const clone = o => structuredClone(o);
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const shuffle = (a, r) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function countCards(p) {
  let n = 0;
  const walk = o => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') { if (o.card_id) n++; for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v); }
  };
  for (const z of ['hand', 'deck', 'trash', 'removed', 'legends', 'eddies', 'field']) walk(p.zones[z]);
  return n;
}

function candidates(wf, b, r) {
  const ownerId = wf.owner || b.active_player;
  const me = b[ownerId], opp = b[ownerId === 'p1' ? 'p2' : 'p1'];
  const Z = me.zones, out = [];
  const R = resp => [{ step: 'effect_choice_response', response: resp }];
  switch (wf.step) {
    case 'mulligan_decision': return [[{ step: 'mulligan', mulligan: false }], [{ step: 'mulligan', mulligan: false }], [{ step: 'mulligan', mulligan: true }]];
    case 'choose_gig_die': return (wf.available || []).map(s => [{ step: 'choose_gig_die', sides: s }]);
    case 'main_phase': {
      const ready = [...Z.eddies, ...Z.legends].filter(x => x.state === 'ready' && !me.tapped.includes(x.iid));
      const tapSeq = n => shuffle(ready, r).slice(0, Math.max(0, n)).map(x => ({ step: 'tap_resource', iid: x.iid }));
      for (const h of Z.hand) {
        const c = DB[h.card_id]; const cost = h.effective_cost ?? c.cost ?? 0;
        if (!me.sold_card_this_turn && c.eddie) out.push([{ step: 'sell_card', iid: h.iid }]);
        const hosts = c.type === 'Gear' ? [...Z.field, ...Z.legends.filter(l => l.face === 'face_up')] : [null];
        for (const host of hosts) out.push([...tapSeq(cost - me.tapped.length), { step: 'play_card', iid: h.iid, ...(host ? { equip_to: host.iid } : {}) }]);
      }
      for (const l of Z.legends) {
        if (l.face !== 'face_up' && !me.called_legend_this_turn) for (const n of [0, 1]) out.push([...tapSeq(n), { step: 'call_legend', iid: l.iid }]);
        if (l.face === 'face_up') out.push([...tapSeq(DB[l.card_id].cost || 0), { step: 'play_legend_solo', iid: l.iid }]);
      }
      for (const sp of wf.spend_activatable_iids || []) for (const n of [0, 1, 2]) out.push([...tapSeq(n), { step: 'activate_anytime_spend', iid: sp.iid, ability_idx: sp.ability_idx }]);
      for (const a of wf.attackable || []) {
        out.push([{ step: 'declare_attack', attacker_iid: a, target: { kind: 'gigs' } }]);
        for (const u of opp.zones.field) out.push([{ step: 'declare_attack', attacker_iid: a, target: { kind: 'unit', iid: u.iid } }]);
      }
      out.push([{ step: 'end_turn' }], [{ step: 'end_turn' }]);
      return out;
    }
    case 'defensive_step': {
      for (const x of wf.blocker_iids || []) out.push([{ step: 'blocker', iid: x }]);
      if (wf.can_call_legend) for (const l of Z.legends.filter(l => l.face !== 'face_up')) out.push([{ step: 'call_legend_defensive', iid: l.iid, pay_iids: shuffle(wf.call_legend_payable_iids || [], r).slice(0, wf.call_legend_cost ?? 1) }]);
      for (const x of wf.interrupt_castable_iids || []) out.push([{ step: 'play_card_interrupt_cast', iid: x }]);
      for (const x of wf.interrupt_spendable_iids || []) out.push([{ step: 'activate_asset_spend', iid: x.iid, ability_idx: x.ability_idx }]);
      out.push([{ step: 'pass_defensive' }], [{ step: 'pass_defensive' }]);
      return out;
    }
    case 'attacker_interrupt_step': {
      for (const x of wf.interrupt_castable_iids || []) out.push([{ step: 'play_card_interrupt_cast', iid: x }]);
      for (const x of wf.interrupt_spendable_iids || []) out.push([{ step: 'activate_asset_spend', iid: x.iid, ability_idx: x.ability_idx }]);
      out.push([{ step: 'pass_attacker_interrupt' }]);
      return out;
    }
    case 'choose_gig_to_steal': return [[{ step: 'choose_gig_to_steal', iids: shuffle(wf.available_iids, r).slice(0, wf.count) }]];
    case 'effect_choice': {
      const cn = wf.choice_needed;
      switch (cn.kind) {
        case 'confirm_optional': return [R({ accept: true }), R({ accept: false })];
        case 'choose_pending_order': return [...cn.available_iids.map(i => R({ iid: i })), R({ order: shuffle(cn.available_iids, r) })];
        case 'choose_amount': { const o = []; for (let n = cn.min; n <= cn.max; n++) if (!(cn.exclude_zero && n === 0)) o.push(R({ amount: n })); return o; }
        case 'choose_from_top_n': { const o = []; for (let k = cn.take_min || 0; k <= Math.min(cn.take_up_to, cn.eligible_iids.length); k++) o.push(R({ selected_iids: shuffle(cn.eligible_iids, r).slice(0, k) })); return o; }
        case 'choose_units': { const o = []; for (let k = 0; k <= Math.min(cn.take_up_to, cn.available_iids.length); k++) o.push(R({ selected_iids: shuffle(cn.available_iids, r).slice(0, k) })); return o; }
        default: { const o = (cn.available_iids || []).map(i => R({ iid: i })); if (cn.optional || !o.length) o.push(R({ iid: null })); return o; }
      }
    }
  }
  return [];
}

const isCrash = e => e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError;

function playGame(d1, d2, seed, stats) {
  const r = rng(seed); const first = r() < 0.5 ? 'p1' : 'p2';
  let res = step(setupGame(d1, d2, first, { seed }), undefined);
  let b = res.board, wf = res.waitingFor;
  const total = { p1: countCards(b.p1), p2: countCards(b.p2) };
  let steps = 0, lastTurn = b.turn_number;
  const fail = (kind, msg) => stats.issues.push({ kind, msg: String(msg), seed, d: d1.name + ' v ' + d2.name, turn: b.turn_number });
  while (!b.winner && wf) {
    if (++steps > 4000) { fail('step_cap', ''); break; }
    if (b.turn_number > 80) { fail('turn_cap', ''); break; }
    const cands = shuffle(candidates(wf, b, r), r);
    let moved = false;
    for (const seq of cands) {
      let bb = clone(b), w = wf, ok = true;
      for (const a of seq) {
        try { const rr = step(bb, a); bb = rr.board; w = rr.waitingFor; }
        catch (e) { if (isCrash(e)) fail('crash', `${a.step}: ${e.message} @ ${(e.stack || '').split('\n')[1]?.trim()}`); ok = false; break; }
      }
      if (!ok) continue;
      for (const a of seq) {
        stats.actions[a.step] = (stats.actions[a.step] || 0) + 1;
        if (a.step === 'play_card' || a.step === 'play_card_interrupt_cast') {
          const c = b[wf.owner || b.active_player].zones.hand.find(h => h.iid === a.iid);
          if (c) stats.played[c.card_id] = (stats.played[c.card_id] || 0) + 1;
        }
      }
      b = bb; wf = w; moved = true; break;
    }
    if (!moved) {
      const d = defaultPassAction(wf);
      if (!d) { fail('stuck', wf.step + ':' + (wf.choice_needed?.kind || '')); break; }
      try { const rr = step(b, d); b = rr.board; wf = rr.waitingFor; }
      catch (e) { fail(isCrash(e) ? 'crash' : 'stuck_default', wf.step + ' ' + e.message); break; }
    }
    if (wf && (wf.step==='main_phase'||wf.step==='choose_gig_die') && !b.effect_stack.length) for (const pid of ['p1', 'p2']) { const n = countCards(b[pid]); if (n !== total[pid]) { fail('card_count', `${pid} ${total[pid]}->${n}`); total[pid] = n; } }
    const dice = b.p1.zones.gigs.length + b.p2.zones.gigs.length + b.p1.zones.fixer.length + b.p2.zones.fixer.length;
    if (dice !== 12) fail('dice_count', dice);
    for (const pid of ['p1', 'p2']) for (const g of b[pid].zones.gigs) if (g.value < 1 || g.value > g.sides) fail('gig_value', `d${g.sides}=${g.value}`);
    if (b.turn_number !== lastTurn) {
      lastTurn = b.turn_number;
      const P = b[b.active_player];
      if (!b.winner && P.zones.gigs.length >= 8) fail('win_missed', `${b.active_player} has ${P.zones.gigs.length} gigs during own turn`);
    }
  }
  stats.games++; stats.turns += b.turn_number;
  if (b.winner) stats.wins[b.winner === first ? 'first' : 'second']++;
  const why = b.win_reason || b.end_reason || (b.winner ? 'win' : 'none');
  stats.endings[why] = (stats.endings[why] || 0) + 1;
  return b;
}
module.exports = { playGame, candidates, rng, countCards };

if (require.main === module) {
  const N = +(process.argv[2] || 3);
  const dir = path.join(__dirname, 'decks');
  const decks = require('fs').readdirSync(dir).filter(f => f.endsWith('.txt')).map(f => parseTxt(path.join(dir, f)));
  const stats = { games: 0, turns: 0, issues: [], actions: {}, played: {}, wins: { first: 0, second: 0 }, endings: {} };
  let seed = 1;
  for (let i = 0; i < decks.length; i++) for (let j = 0; j < decks.length; j++) for (let k = 0; k < N; k++) playGame(decks[i], decks[j], seed++, stats);
  const byKind = {};
  for (const x of stats.issues) (byKind[x.kind + ': ' + x.msg.replace(/d+/g, '#')] ??= []).push(x);
  console.log('games', stats.games, 'avg turns', (stats.turns / stats.games).toFixed(1), 'wins', JSON.stringify(stats.wins));
  for (const [k, v] of Object.entries(byKind)) console.log('  ' + v.length + 'x', k, '| e.g. seed', v[0].seed, v[0].d, 'T' + v[0].turn);
  const allIds = new Set(decks.flatMap(d => d.cards.map(c => c.card_id)));
  const never = [...allIds].filter(i => !stats.played[i]).map(i => DB[i].name);
  if (never.length) console.log('  never played:', never.join(', '));
  console.log(stats.issues.length ? '  ISSUES FOUND' : '  no issues');
  process.exit(stats.issues.length ? 1 : 0);
}
