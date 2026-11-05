// "Why is the coach's line better?" in plain sentences, from two sources:
//   1. the two end-of-turn boards side by side, naming cards (what's on the field, what got
//      sold, which Legend was called, which Rival Units are gone);
//   2. what happened next in the playouts (the Rival's reply, your next turn, how often the
//      game was lost on the spot).
'use strict';
const { unitPower, opp, nm } = require('./policy');

const short = n => String(n).split(/: | — /)[0];
const list = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const one = x => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
const pc = x => `${Math.round(x * 100)}%`;

// multiset difference by name: names in a not in b
function minus(a, b) {
  const left = b.slice(), out = [];
  for (const x of a) { const i = left.indexOf(x); if (i >= 0) left.splice(i, 1); else out.push(x); }
  return out;
}

function sideFacts(b, pid, startBoard) {
  const Z = b[pid].zones, R = b[opp(pid)].zones;
  // only cards sold from the hand you started the turn with: a card sold by an effect (Bootleg
  // sells the top of your deck) was never seen, so its name would be made up
  const startHand = new Set(startBoard[pid].zones.hand.map(h => h.iid));
  return {
    units: Z.field.map(u => short(nm(u.card_id))),
    unitText: Object.fromEntries(Z.field.map(u => [short(nm(u.card_id)), `${short(nm(u.card_id))} (${unitPower(b, pid, u)} power)`])),
    gear: Z.field.flatMap(u => (u.equipped_gear || []).map(g => `${short(nm(g.card_id))} on ${short(nm(u.card_id))}`))
      .concat(Z.legends.flatMap(l => (l.equipped_gear || []).map(g => `${short(nm(g.card_id))} on ${short(nm(l.card_id))}`))),
    sold: Z.eddies.filter(e => startHand.has(e.iid)).map(e => short(nm(e.card_id))),
    called: Z.legends.filter(l => l.face === 'face_up').map(l => short(nm(l.card_id))),
    rivalUnits: R.field.map(u => short(nm(u.card_id))),
  };
}

function boardReasons(yourEnd, coachEnd, startBoard, pid) {
  const y = sideFacts(yourEnd, pid, startBoard), c = sideFacts(coachEnd, pid, startBoard);
  const out = [];
  const plays = minus(c.units, y.units), skips = minus(y.units, c.units);
  const txt = (f, n) => f.unitText[n] || n;
  if (plays.length && skips.length) out.push(`Ends with ${list(plays.map(n => txt(c, n)))} on the field, where you had ${list(skips.map(n => txt(y, n)))}.`);
  else if (plays.length) out.push(`Also gets ${list(plays.map(n => txt(c, n)))} onto the field.`);
  else if (skips.length) out.push(`Ends the turn without ${list(skips)} on the field.`);
  const gearC = minus(c.gear, y.gear), gearY = minus(y.gear, c.gear);
  if (gearC.length) out.push(`Equips ${list(gearC)}${gearY.length ? ` (you equipped ${list(gearY)})` : ''}.`);
  else if (gearY.length) out.push(`Doesn't equip ${list(gearY)}.`);
  const soldC = minus(c.sold, y.sold), soldY = minus(y.sold, c.sold);
  if (soldC.length && soldY.length) out.push(`Sells ${list(soldC)} instead of ${list(soldY)}.`);
  else if (soldY.length) out.push(`Keeps ${list(soldY)} instead of selling it.`);
  else if (soldC.length) out.push(`Also sells ${list(soldC)} for Eddies.`);
  const callC = minus(c.called, y.called), callY = minus(y.called, c.called);
  if (callC.length) out.push(`Calls ${list(callC)}${callY.length ? ` instead of ${list(callY)}` : ''}.`);
  const goneC = minus(y.rivalUnits, c.rivalUnits), goneY = minus(c.rivalUnits, y.rivalUnits);
  if (goneC.length) out.push(`Gets rid of the Rival's ${list(goneC)}.`);
  if (goneY.length) out.push(`Doesn't remove the Rival's ${list(goneY)} like you did, but comes out ahead anyway.`);
  const gy = yourEnd[pid].zones.gigs.length, gc = coachEnd[pid].zones.gigs.length;
  const ry = yourEnd[opp(pid)].zones.gigs.length, rc = coachEnd[opp(pid)].zones.gigs.length;
  if (gc > gy) out.push(`Takes ${gc - gy} more Gig${gc - gy > 1 ? 's' : ''} this turn (${gc} vs your ${gy}).`);
  else if (rc < ry) out.push(`Leaves the Rival with ${rc} Gig${rc === 1 ? '' : 's'} instead of ${ry}.`);
  return out;
}

const avg = (rs, f) => { const v = rs.map(f).filter(x => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

function playoutReasons(yours, coach, pid) {
  const out = [];
  const losses = rs => rs.filter(r => r.p < 0.5).length;
  const Ly = losses(yours), Lc = losses(coach);
  if (Ly > Lc) out.push(`Out of ${yours.length} playouts you lost ${Ly} after your turn, and ${Lc} after the coach's.`);
  const lostNext = rs => avg(rs, r => (r.afterRival ? (r.afterRival.winner && r.afterRival.winner !== pid ? 1 : 0) : null));
  const ly = lostNext(yours), lc = lostNext(coach);
  if (ly !== null && lc !== null && ly - lc >= 0.1)
    out.push(`The Rival won on their very next turn in ${pc(ly)} of the playouts after your turn, but only ${pc(lc)} after the coach's.`);
  const rg = rs => avg(rs, r => r.afterRival?.rivalGigs), mg = rs => avg(rs, r => r.afterRival?.gigs);
  const ry = rg(yours), rc = rg(coach), my = mg(yours), mc = mg(coach);
  if (ry !== null && rc !== null && ry - rc >= 0.5)
    out.push(`After the Rival's next turn they have ${one(rc)} Gigs on average, instead of ${one(ry)} after your line.`);
  if (my !== null && mc !== null && mc - my >= 0.5)
    out.push(`You still hold ${one(mc)} Gigs on average once the Rival's turn is over, instead of ${one(my)}.`);
  const ng = rs => avg(rs, r => r.afterMine?.gigs);
  const ny = ng(yours), nc = ng(coach);
  if (ny !== null && nc !== null && nc - ny >= 0.5)
    out.push(`By the end of your next turn you're at ${one(nc)} Gigs on average, instead of ${one(ny)}.`);
  const wy = avg(yours, r => (r.p === 1 ? r.turns : null)), wc = avg(coach, r => (r.p === 1 ? r.turns : null));
  if (wy !== null && wc !== null && wy - wc >= 1.5)
    out.push(`When you win, it's about ${Math.round(wy - wc)} turns sooner.`);
  return out;
}

module.exports = { boardReasons, playoutReasons };
