'use strict';

const P = require('./primitives');
const { DB, SCRIPTS } = require('./cards');
const { haltToWaiting } = require('./board');
const { evalExpr, evalCondition, matchTrigger } = require('./eval');
const { matchAffects, matchCard } = require('./filters');
const { resolveEffects } = require('./effects');
const { traceEventFired, traceListener } = require('./trace');

const SELF_KEYS = {
  OnPlay:       'onPlay',
  OnCall:       'onCall',
  OnFlip:       'onFlip',
  OnDefeated:   'onDefeated',
  OnSpent:      'onSpent',
};

// "The first time X happens each turn" (rate_limit 'first_per_turn' with scope
// 'controller') counts X even when no copy of the card is in play to hear it
// (FAQ: Jackie Welles: Pour One Out For Me, Yorinobu Arasaka). Every event gets a
// token; each such ability is matched hypothetically for both players and the
// occurrence recorded under that token, so a listener reacting to this same
// event still fires while a later event in the turn sees the limit as used.
const _EVENT_RATE_LIMITED = [];
for (const [card_id, script] of Object.entries(SCRIPTS)) {
  (script?.abilities || []).forEach((a, ai) => {
    if (a.kind === 'triggered' && a.trigger?.rate_limit === 'first_per_turn' &&
        a.trigger.rate_limit_scope === 'controller')
      _EVENT_RATE_LIMITED.push({ card_id, ai, ability: a });
  });
}

function _stampEvent(b, event, base_ctx) {
  b._ev_seq = (b._ev_seq || 0) + 1;
  const ctx = { ...base_ctx, _ev_token: b._ev_seq };
  for (const { card_id, ability } of _EVENT_RATE_LIMITED) {
    if (ability.trigger.event !== event) continue;
    for (const pid of ['p1', 'p2']) {
      const hc = { ...ctx, event, self_pid: pid, self_iid: null, self_card_id: card_id, bindings: {} };
      if (!matchTrigger(ability.trigger, event, b, hc)) continue;
      if (ability.condition && !evalCondition(ability.condition, b, hc)) continue;
      P.markTriggered(b, pid, P.rateLimitScopeId(ability.trigger, { card_id }), event, ctx._ev_token);
    }
  }
  return ctx;
}

// Rule 10 — pending resolution. Everything an event triggers becomes PENDING at
// once (10.16.1-2): triggers are matched, rate-limited, and badges consumed at
// that moment, so an entry still resolves if its source later leaves play
// (10.15). Then they resolve the TURN PLAYER's first (10.15), and a player with
// 2+ pending effects whose order can matter chooses the order (10.14.1) via the
// 'choose_pending_order' choice. See runPending().
function fireEvent(b, event, base_ctx_in, opts) {
  return runPending(b, _collect(b, event, base_ctx_in, opts));
}

// Collect (without resolving) every effect `event` triggers right now. Each
// entry is { id, key, owner, effect, ctx }; resolve with runPending() (or the
// `_RunPending` effect action).
function collectPending(b, event, base_ctx_in, opts) {
  return _collect(b, event, base_ctx_in, opts);
}

function _entry(b, owner, key, effect, ctx, cond) {
  b._pe_seq = (b._pe_seq || 0) + 1;
  const e = { id: 'pe' + b._pe_seq, key, owner, effect, ctx };
  if (cond) e.cond = cond;
  return e;
}

// 10.16.1 — a trigger's own condition ("if it's equipped", ...) must still hold
// when the pending effect resolves. Re-checked while the source is still in play;
// a source that has left play is judged on its last known information, i.e. the
// check made when the trigger went pending.
function _stillQualifies(b, e) {
  if (!e.cond) return true;
  const c = e.ctx;
  if (c.self_iid && !_findInPlay(b, c.self_pid, c.self_iid)) return true;
  return evalCondition(e.cond, b, c);
}

function _collect(b, event, base_ctx_in, opts) {
  const base_ctx = _stampEvent(b, event, base_ctx_in);
  const baseCtx = { ...base_ctx, event };
  traceEventFired(b, event, baseCtx);
  const listeners = _listenerDescriptors(b, base_ctx);
  const out = [];
  const selfKey = SELF_KEYS[event];
  if (!opts?.skipSelf && selfKey && baseCtx.source_card_id && baseCtx.source_pid) {
    const block = SCRIPTS[baseCtx.source_card_id]?.[selfKey];
    if (Array.isArray(block) && block.length > 0)
      out.push(_entry(b, baseCtx.source_pid, baseCtx.source_card_id + '#' + selfKey, block, _selfCtx(baseCtx)));
  }
  for (const l of listeners) {
    if (l.badge_id != null) {
      const badge = (b.badges || []).find(x => x.id === l.badge_id);
      if (!badge || badge.trigger?.event !== event) continue;
      const ctx = { ...base_ctx, event, self_pid: badge.owner_pid, self_iid: null,
                    self_card_id: badge.source_card_id, bindings: {}, badge_unit_iid: badge.unit_iid || null };
      if (!matchTrigger(badge.trigger, event, b, ctx)) continue;
      if (badge.unit_iid && base_ctx.source_iid !== badge.unit_iid) continue;   // tied to one Unit
      if (badge.condition && !evalCondition(badge.condition, b, ctx)) continue;
      b.badges = b.badges.filter(x => x.id !== badge.id);
      traceListener(b, event, badge.owner_pid, { iid: null, card_id: badge.source_card_id }, 'pending:badge');
      out.push(_entry(b, badge.owner_pid, badge.source_card_id + '#badge', badge.effect || [], ctx, badge.condition));
      continue;
    }
    const { pid, iid, card_id, ai } = l;
    const ref = l.ghost ? { iid, card_id } : _findInPlay(b, pid, iid);
    if (!ref || ref.card_id !== card_id) continue;
    const ability = SCRIPTS[card_id].abilities[ai];
    const ctx = { ...base_ctx, event, self_pid: pid, self_iid: iid, self_card_id: card_id, bindings: {} };
    if (!matchTrigger(ability.trigger, event, b, ctx)) continue;
    const rl = ability.trigger.rate_limit;
    const scopeId = P.rateLimitScopeId(ability.trigger, ref);
    if (rl === 'first_per_turn' && P.hasTriggered(b, pid, scopeId, event, base_ctx._ev_token)) {
      traceListener(b, event, pid, ref, 'skip:rate_limit'); continue;
    }
    if (ability.condition && !evalCondition(ability.condition, b, ctx)) {
      traceListener(b, event, pid, ref, 'skip:cond'); continue;
    }
    if (rl === 'first_per_turn') P.markTriggered(b, pid, scopeId, event, base_ctx._ev_token);
    traceListener(b, event, pid, ref, 'pending');
    out.push(_entry(b, pid, card_id + '#' + ai, ability.effect || [], ctx, ability.condition));
  }
  return out;
}

// 10.14.1 — can the order of one player's pending effects matter? Not when they
// are all the same ability of the same card (identical copies). A full order
// chosen once (`fixed`) is not asked again.
function _orderMatters(mine) {
  if (mine.every(e => e.fixed)) return false;
  return new Set(mine.map(e => e.key)).size > 1;
}

// Resolve pending entries: turn player's first (10.15); within one player, the
// player picks the order when it can matter (10.14.1). Halts return
// { halted, choice_needed, ..., resume_continuation: { entries } } and are
// resumed by fireEventResume().
function runPending(b, entries) {
  let list = (entries || []).slice();
  while (list.length) {
    const tp = b.active_player;
    const owner = list.some(e => e.owner === tp) ? tp : list[0].owner;
    const mine = list.filter(e => e.owner === owner);
    let next = mine.find(e => e.go);
    if (!next && mine.length >= 2 && _orderMatters(mine)) {
      return {
        halted: true,
        choice_needed: {
          kind: 'choose_pending_order',
          bind_pid: owner, chooser_pid: owner,
          prompt: 'Choose which of your pending effects resolves next',
          available_iids: mine.map(e => e.id),
          options: mine.map(e => ({ id: e.id, card_id: e.ctx?.self_card_id || null,
                                    name: DB[e.ctx?.self_card_id]?.name || null,
                                    source_iid: e.ctx?.self_iid || null })),
          optional: false,
        },
        pending_order: { owner, entries: list },
      };
    }
    next = next || mine[0];
    list = list.filter(e => e !== next);
    if (!_stillQualifies(b, next)) { traceListener(b, next.ctx.event, next.owner, { iid: next.ctx.self_iid, card_id: next.ctx.self_card_id }, 'skip:cond-at-resolution'); continue; }
    const res = resolveEffects(next.effect, b, next.ctx);
    if (res.halted) return { ...res, halted: true, resume_continuation: { entries: list } };
  }
  return { halted: false };
}

// Apply a choose_pending_order response: { iid } = resolve that one next, or
// { order: [ids] } = the full order of the offered effects (no further prompt).
function _applyOrder(po, response) {
  const offered = po.entries.filter(e => e.owner === po.owner).map(e => e.id);
  const others  = po.entries.filter(e => e.owner !== po.owner);
  const byId    = Object.fromEntries(po.entries.map(e => [e.id, e]));
  if (Array.isArray(response?.order)) {
    const ord = response.order;
    if (ord.length !== offered.length || new Set(ord).size !== ord.length || !ord.every(id => offered.includes(id)))
      throw new Error(`order must list each of ${offered.join(', ')} exactly once`);
    return [...ord.map(id => ({ ...byId[id], fixed: true })), ...others];
  }
  const id = response?.iid;
  if (!offered.includes(id)) throw new Error(`iid ${id} is not among the offered pending effects`);
  return [{ ...byId[id], go: true }, ...po.entries.filter(e => e.id !== id)];
}

function _selfCtx(baseCtx) {
  return {
    ...baseCtx,
    self_pid:     baseCtx.source_pid,
    self_iid:     baseCtx.source_iid,
    self_card_id: baseCtx.source_card_id,
    bindings:     {},
  };
}

function _listenerDescriptors(b, base_ctx) {
  const out = [];
  for (const { pid, ref } of _enumerateInPlay(b)) {
    const script = SCRIPTS[ref.card_id];
    if (!script?.abilities) continue;
    for (let ai = 0; ai < script.abilities.length; ai++) {
      const a = script.abilities[ai];
      if (a.kind !== 'triggered' || !a.trigger) continue;
      out.push({ pid, iid: ref.iid, card_id: ref.card_id, ai });
    }
  }

  // A card that just left play (e.g. was defeated) still hears the event about
  // itself when its trigger says `also_when_leaving` ("the first time an ARASAKA
  // Unit is defeated" counts Yorinobu: Steel Dragon itself — FAQ).
  const src = base_ctx && base_ctx.source_card_id && base_ctx.source_pid && base_ctx.source_iid;
  if (src && !_findInPlay(b, base_ctx.source_pid, base_ctx.source_iid)) {
    (SCRIPTS[base_ctx.source_card_id]?.abilities || []).forEach((a, ai) => {
      if (a.kind === 'triggered' && a.trigger?.also_when_leaving)
        out.push({ pid: base_ctx.source_pid, iid: base_ctx.source_iid,
                   card_id: base_ctx.source_card_id, ai, ghost: true });
    });
    // Rule 11.23.3: a defeated Unit's {Defeated} effects use its last state on the
    // field, including effects inherited from Gear it had equipped (The Relic).
    // Those Gear listen as ghosts for host-scoped triggers about that Unit.
    for (const g of (base_ctx.event_data?.equipped_gear || [])) {
      (SCRIPTS[g.card_id]?.abilities || []).forEach((a, ai) => {
        if (a.kind === 'triggered' && a.trigger?.by === 'host')
          out.push({ pid: base_ctx.source_pid, iid: g.iid, card_id: g.card_id, ai, ghost: true });
      });
    }
  }

  for (const badge of (b.badges || [])) out.push({ badge_id: badge.id });
  return out;
}

function _findInPlay(b, pid, iid) {
  for (const u of b[pid].zones.field) {
    if (u.iid === iid) return u;
    for (const g of (u.equipped_gear || [])) if (g.iid === iid) return g;
  }
  for (const l of b[pid].zones.legends) {
    if (l.face !== 'face_up') continue;
    if (l.iid === iid) return l;
    for (const g of (l.equipped_gear || [])) if (g.iid === iid) return g;
  }
  return null;
}

function _scanListeners(b, event, base_ctx, listeners, startIdx) {
  for (let i = startIdx; i < listeners.length; i++) {
    if (listeners[i].badge_id != null) {
      const res = _fireBadge(b, listeners[i].badge_id, event, base_ctx);
      if (res?.halted) return _withResume(res, event, base_ctx, listeners, i + 1);
      continue;
    }
    const { pid, iid, card_id, ai, ghost } = listeners[i];
    const ref = ghost ? { iid, card_id } : _findInPlay(b, pid, iid);
    if (!ref || ref.card_id !== card_id) continue;   // left play since the event fired
    const ability = SCRIPTS[card_id].abilities[ai];

    const ctx = {
      ...base_ctx,
      event,
      self_pid:     pid,
      self_iid:     iid,
      self_card_id: card_id,
      bindings:     {},
    };

    if (!matchTrigger(ability.trigger, event, b, ctx)) continue;
    const rl = ability.trigger.rate_limit;
    const scopeId = P.rateLimitScopeId(ability.trigger, ref);
    if (rl === 'first_per_turn' && P.hasTriggered(b, pid, scopeId, event, base_ctx._ev_token)) {
      traceListener(b, event, pid, ref, 'skip:rate_limit'); continue;
    }

    if (ability.condition && !evalCondition(ability.condition, b, ctx)) {
      traceListener(b, event, pid, ref, 'skip:cond'); continue;
    }

    if (rl === 'first_per_turn') P.markTriggered(b, pid, scopeId, event, base_ctx._ev_token);
    traceListener(b, event, pid, ref, 'fire');

    const res = resolveEffects(ability.effect || [], b, ctx);
    if (res.halted) {
      return _withResume(res, event, base_ctx, listeners, i + 1);
    }
  }
  return { halted: false };
}

function _fireBadge(b, badge_id, event, base_ctx) {
  const badge = (b.badges || []).find(x => x.id === badge_id);
  if (!badge || badge.trigger?.event !== event) return null;
  const ctx = {
    ...base_ctx, event,
    self_pid: badge.owner_pid, self_iid: null, self_card_id: badge.source_card_id,
    bindings: {}, badge_unit_iid: badge.unit_iid || null,
  };
  if (!matchTrigger(badge.trigger, event, b, ctx)) return null;
  if (badge.unit_iid && base_ctx.source_iid !== badge.unit_iid) return null;   // tied to one Unit
  if (badge.condition && !evalCondition(badge.condition, b, ctx)) return null;

  b.badges = (b.badges || []).filter(x => x.id !== badge.id);
  traceListener(b, event, badge.owner_pid, { iid: null, card_id: badge.source_card_id }, 'fire:badge');
  const res = resolveEffects(badge.effect || [], b, ctx);
  return res.halted ? res : null;
}

function _withResume(haltedState, event, base_ctx, listeners, next_index) {
  return {
    ...haltedState,
    halted: true,
    resume_continuation: { event, base_ctx, listeners, next_index },
  };
}

function fireEventResume(haltedState, response, b) {
  // A choose_pending_order halt: reorder, then keep resolving.
  if (haltedState.pending_order) return runPending(b, _applyOrder(haltedState.pending_order, response));

  const { resumeEffects } = require('./effects');
  const finish = resumeEffects(haltedState, response, b);
  if (finish.halted) {
    return {
      ...finish,
      halted: true,
      resume_continuation: haltedState.resume_continuation,
    };
  }

  const rc = haltedState.resume_continuation;
  if (!rc) return { halted: false };
  if (rc.entries) return runPending(b, rc.entries);
  // Legacy continuation shape (a board halted by the pre-pending engine).
  return _scanListeners(b, rc.event, rc.base_ctx, rc.listeners, rc.next_index);
}

function _enumerateInPlay(b) {
  const out = [];
  for (const pid of ['p1', 'p2']) {
    for (const u of b[pid].zones.field) {
      out.push({ pid, ref: u });
      for (const g of (u.equipped_gear || [])) out.push({ pid, ref: g });
    }
    for (const l of b[pid].zones.legends) {
      if (l.face !== 'face_up') continue;
      out.push({ pid, ref: l });
      for (const g of (l.equipped_gear || [])) out.push({ pid, ref: g });
    }
  }
  return out;
}

function _matchWhen(when, ctx) {
  if (!when) return true;
  if (when.during_fight !== undefined && !!ctx.during_fight !== !!when.during_fight) return false;
  if (when.role         !== undefined && ctx.role !== when.role) return false;
  // A fight opponent is always on the field, so it is a Unit whatever its printed
  // type (rule 4.2.1: a Go Solo'd Legend is both a Unit and a Legend).
  if (when.vs_type      !== undefined && ctx.opp_type !== when.vs_type &&
      !(when.vs_type === 'Unit' && ctx.opp_type)) return false;
  if (when.active_player !== undefined) {
    const expected = when.active_player === 'self' ? ctx.self_pid : P.opponent(ctx.self_pid);
    if (ctx.active_player !== expected) return false;
  }
  return true;
}

function applyStaticPower(b, pid, unit, ctx) {
  const base  = DB[unit.card_id]?.power || 0;
  let   power = base + (unit._temp_power || 0);
  let   mult  = 1;

  for (const g of (unit.equipped_gear || [])) {
    power += DB[g.card_id]?.power || 0;
  }

  const gate = {
    active_player: ctx?.active_player ?? b.active_player,
    during_fight:  ctx?.during_fight,
    role:          ctx?.role,
    opp_type:      ctx?.opp_type,
  };

  for (const e of (unit._temp_power_when || []))
    if (_matchWhen(e.when, { self_pid: pid, ...gate }))
      power += (e.n && typeof e.n === 'object')
        ? (evalExpr(e.n.expr, b, { self_pid: e.n.pid, bindings: {} }) || 0)   // live amount (GrantTempPower live)
        : e.n;

  const unitBinding = { ...unit, _pid: pid };
  const script = SCRIPTS[unit.card_id];

  if (script?.statics) {
    const selfCtx = {
      self_pid: pid, self_iid: unit.iid, self_card_id: unit.card_id,
      bindings: {}, ...gate,
    };
    for (const s of script.statics) {
      if (s.kind === 'SelfPower'      && _matchWhen(s.when, selfCtx))
        power += evalExpr(s.expr, b, selfCtx);
      else if (s.kind === 'PowerMultiplier' && _matchWhen(s.when, selfCtx))
        mult *= s.factor;
    }
  }

  for (const { pid: srcPid, ref: srcRef } of _enumerateInPlay(b)) {
    const srcScript = SCRIPTS[srcRef.card_id];
    if (!srcScript?.statics) continue;
    const srcCtx = {
      self_pid: srcPid, self_iid: srcRef.iid, self_card_id: srcRef.card_id,
      bindings: {}, ...gate,
    };
    for (const s of srcScript.statics) {
      if (s.kind !== 'Aura') continue;
      if (!matchAffects(s.affects, unitBinding, srcPid, b, srcRef.iid)) continue;
      if (!_matchWhen(s.when, srcCtx)) continue;
      if (s.requires && !evalCondition(s.requires, b, srcCtx)) continue;
      power += evalExpr(s.expr, b, srcCtx);
    }
  }

  return Math.max(0, Math.floor(power * mult));
}

// card_id -> its AuraKeyword statics (null if none), built on first use (scripts are final by then)
const _AURA_KW = new Map();
function _auraKeywords(cardId) {
  let v = _AURA_KW.get(cardId);
  if (v === undefined) {
    const st = SCRIPTS[cardId]?.statics;
    const list = st ? st.filter(s => s.kind === 'AuraKeyword') : [];
    v = list.length ? list : null;
    _AURA_KW.set(cardId, v);
  }
  return v;
}

function effectiveKeywords(b, pid, unit) {
  const out = new Set((unit._temp_keywords || []).map(k => k.toUpperCase()));
  for (const e of (unit._until_keywords || [])) out.add(e.kw);

  const script = SCRIPTS[unit.card_id];
  if (script?.statics) {
    const selfCtx = {
      self_pid: pid, self_iid: unit.iid, self_card_id: unit.card_id,
      bindings: {},
    };
    for (const s of script.statics) {
      if (s.kind === 'SelfKeyword' && (!s.condition || evalCondition(s.condition, b, selfCtx)))
        out.add(String(s.keyword).toUpperCase());
    }
  }

  // only in-play cards with an AuraKeyword static can add one (same order as _enumerateInPlay)
  let unitBinding = null;
  const aura = (srcPid, srcRef) => {
    const list = _auraKeywords(srcRef.card_id);
    if (!list) return;
    unitBinding ||= { ...unit, _pid: pid };
    const srcCtx = {
      self_pid: srcPid, self_iid: srcRef.iid, self_card_id: srcRef.card_id,
      bindings: {},
    };
    for (const s of list) {
      if (!matchAffects(s.affects, unitBinding, srcPid, b, srcRef.iid)) continue;
      if (s.condition && !evalCondition(s.condition, b, srcCtx)) continue;
      out.add(String(s.keyword).toUpperCase());
    }
  };
  for (const srcPid of ['p1', 'p2']) {
    for (const u of b[srcPid].zones.field) {
      aura(srcPid, u);
      for (const g of (u.equipped_gear || [])) aura(srcPid, g);
    }
    for (const l of b[srcPid].zones.legends) {
      if (l.face !== 'face_up') continue;
      aura(srcPid, l);
      for (const g of (l.equipped_gear || [])) aura(srcPid, g);
    }
  }

  return [...out];
}

// True if `unit` auto-wins a fight against the card `oppCardId`, regardless of
// power (Johnny Silverhand vs CORPO). `vs` is a CardFilter on the opposing card.
function alwaysWinsFight(b, pid, unit, oppCardId) {
  const script = SCRIPTS[unit.card_id];
  if (!script?.statics || !oppCardId) return false;
  const oppCard = DB[oppCardId] || {};
  const selfCtx = {
    self_pid: pid, self_iid: unit.iid, self_card_id: unit.card_id,
    bindings: {},
  };
  for (const s of script.statics) {
    if (s.kind !== 'AlwaysWinsFight') continue;
    if (s.vs && !matchCard(oppCard, s.vs, b, selfCtx)) continue;
    if (s.condition && !evalCondition(s.condition, b, selfCtx)) continue;
    return true;
  }
  return false;
}

// Cost to play `legend` via GO SOLO — its printed cost plus any SoloCostTax
// statics in play. `side` on the static names whose Go Solo is taxed, seen from
// the taxing card's controller (default 'opponent' — Riot Shield taxes rivals).
function goSoloCost(b, pid, legend) {
  let cost = DB[legend.card_id]?.cost || 0;
  for (const { pid: srcPid, ref } of _enumerateInPlay(b)) {
    for (const s of (SCRIPTS[ref.card_id]?.statics || [])) {
      if (s.kind !== 'SoloCostTax') continue;
      const taxed = (s.side || 'opponent') === 'opponent' ? P.opponent(srcPid) : srcPid;
      if (taxed === pid) cost += s.amount || 0;
    }
  }
  if (legend._solo_discount) {
    const d = legend._solo_discount;
    cost = Math.max(d.min ?? 1, cost - (d.amount || 0));
  }
  return Math.max(0, cost);
}

// Calling a Legend costs 1 €$; a friendly LegendCallDiscount static reduces it
// (Panam Palmer — Strength Through Family makes the call free).
function legendCallCost(b, pid) {
  let cost = 1;
  for (const { pid: srcPid, ref } of _enumerateInPlay(b)) {
    if (srcPid !== pid) continue;
    for (const s of (SCRIPTS[ref.card_id]?.statics || [])) {
      if (s.kind !== 'LegendCallDiscount') continue;
      cost -= s.amount || 0;
    }
  }
  return Math.max(0, cost);
}

function fireOrHalt(b, event, ctx, defaultOwner, opts) {
  const r = fireEvent(b, event, ctx, opts);
  if (r?.halted) return haltToWaiting(b, 'resume_fire_event', r, defaultOwner);
  return null;
}

function fireEventChain(b, events, ctx, defaultOwner, opts) {
  for (const event of events) {
    const w = fireOrHalt(b, event, ctx, defaultOwner, opts);
    if (w) return w;
  }
  return null;
}

module.exports = {
  fireEvent,
  collectPending,
  runPending,
  fireEventResume,
  fireOrHalt,
  fireEventChain,
  applyStaticPower,
  effectiveKeywords,
  alwaysWinsFight,
  goSoloCost,
  legendCallCost,
};
