// Decision points: for every turn of the reviewed player, the calm position right after the
// Gig roll (A, "what you had") and the last calm position before they ended the turn
// (B, "what you made of it"). Everything in between - plays, attacks, choices - is the turn plan
// the coach grades, so no single sim action ever has to be translated into an engine action.
'use strict';
const { isCalm } = require('./bridge');

function turnPositions(states, sid) {
  const turns = new Map();   // turnNumber -> { a, b, steps: [] }
  for (let i = 0; i < states.length; i++) {
    const { state, action } = states[i];
    const g = state.game;
    if (g.stage !== 'player_turn' || g.activePlayerId !== sid) continue;
    const t = g.turnNumber;
    if (!turns.has(t)) turns.set(t, { turn: t, a: null, b: null, ended: false, steps: [] });
    const T = turns.get(t);
    T.steps.push(i);
    if (isCalm(state)) { if (T.a === null) T.a = i; T.b = i; }
  }
  // B is the last calm position *before* the end-turn frame; the end frame itself already
  // shows the next turn's start.
  for (const T of turns.values()) {
    // the end frame's action carries the *next* turn's number, so match on order instead
    const endIdx = states.findIndex((s, i) => i > (T.a ?? 0) && s.action?.actorPlayerId === sid && /^Ended the turn/.test(s.action.label || '')
      && states[i - 1].state.game.turnNumber === T.turn);
    if (endIdx > 0) {
      T.ended = true;
      for (let i = endIdx - 1; i >= (T.a ?? 0); i--) if (isCalm(states[i].state) && states[i].state.game.turnNumber === T.turn) { T.b = i; break; }
    }
    T.log = [];
    if (T.a !== null)
      for (let i = T.a + 1; i <= (endIdx > 0 ? endIdx - 1 : T.b); i++)
        for (const h of states[i].newLog) T.log.push(h.message);
  }
  return [...turns.values()].filter(T => T.a !== null && T.b !== null).sort((x, y) => x.turn - y.turn);
}

module.exports = { turnPositions };
