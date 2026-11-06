// The coach's hand-tuned position score (coach/policy.js sideScore) with every constant exposed
// as a weight, so scripts/tune-greedy.js can tune them on win rate. DEFAULT_W reproduces the
// original numbers exactly; TUNED_W (src/bot/tuned-weights.json, if present) is the tuned set.
'use strict';
const fs = require('fs');
const path = require('path');
const { unitPower, card, opp } = require('../coach/policy');

const DEFAULT_W = {
  gig: 11, gig6: 12, gig5: 4, gigValue: 0.15,
  unit: 2.5, unitPow: 0.9, ready: 1, readyPow: 0.15, gear: 0.8,
  legUp: 3, legDown: 1.6, legGear: 1, legGearPow: 0.3,
  hand: 2.4, handOver: 0.8, eddie: 2.6, deckOut: 30,
  rival: 1, sell: 0.6,
};
const KEYS = Object.keys(DEFAULT_W);

function sideScore(b, pid, W) {
  const Z = b[pid].zones;
  let s = 0;
  const gigs = Z.gigs.length;
  s += gigs * W.gig + (gigs >= 6 ? W.gig6 : 0) + (gigs >= 5 ? W.gig5 : 0);
  s += Z.gigs.reduce((a, g) => a + g.value, 0) * W.gigValue;
  for (const u of Z.field) {
    const p = unitPower(b, pid, u);
    s += W.unit + p * W.unitPow + (u.state === 'ready' ? W.ready + p * W.readyPow : 0);
    s += (u.equipped_gear || []).length * W.gear;
  }
  for (const l of Z.legends) {
    s += l.face === 'face_up' ? W.legUp : W.legDown;
    s += (l.equipped_gear || []).reduce((a, g) => a + W.legGear + (card(g.card_id).power || 0) * W.legGearPow, 0);
  }
  s += Math.min(Z.hand.length, 7) * W.hand + Math.max(0, Z.hand.length - 7) * W.handOver;
  s += Math.min(Z.eddies.length, 8) * W.eddie;
  if (Z.deck.length === 0) s -= W.deckOut;
  return s;
}

function makeEval(W) {
  return (b, pid) => (b.winner ? (b.winner === pid ? 1000 : -1000) : sideScore(b, pid, W) - W.rival * sideScore(b, opp(pid), W));
}

const FILE = path.join(__dirname, 'tuned-weights.json');
function loadTuned() {
  try { return { ...DEFAULT_W, ...JSON.parse(fs.readFileSync(FILE, 'utf8')).weights }; } catch { return null; }
}

module.exports = { DEFAULT_W, KEYS, makeEval, loadTuned, FILE };
