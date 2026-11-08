// Why one move beat another (Game Review, src/coach/review.js). Three kinds of reasons, all from data
// the review already has - never invented:
//   1. the moment: what the board allowed right then (an attack nobody could block, a Unit the
//      attacker beats, the Gig race);
//   2. right after: the two boards once each move (and its prompts) has resolved - what's on the
//      field, what was sold, which Gigs moved;
//   3. what happens next: the imagined Rival replies the bot scored both moves with, summarised at
//      the start of your next turn (Gigs, Units left, games lost on the spot).
'use strict';
const policy = require('./policy');
const { hasBlocker, isLagging } = require('../engine/lib/rules');

const { opp, nm, unitPower } = policy;
const short = n => String(nm(n)).split(/: | — /)[0];
const list = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const one = x => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
const pc = x => `${Math.round(x * 100)}%`;
const findUnit = (b, iid) => { for (const p of ['p1', 'p2']) { const u = b[p].zones.field.find(x => x.iid === iid); if (u) return { u, p }; } return null; };
const findAny = (b, iid) => { for (const p of ['p1', 'p2']) for (const z of Object.values(b[p].zones)) if (Array.isArray(z)) { const r = z.find(x => x.iid === iid); if (r) return r; } return null; };

function run(A, path, pid) {
  let cur = { board: A.board, waitingFor: A.waitingFor };
  for (const seq of path) { const r = policy.tryApply(cur.board, cur.waitingFor, seq); if (!r) return null; cur = r; }
  if (cur.waitingFor && cur.waitingFor.step !== 'main_phase') cur = policy.settle(cur.board, cur.waitingFor, pid);
  return cur.board;
}

// blockers the Rival has right now (ready, not lagging, with Blocker)
function blockers(b, pid) {
  const rv = opp(pid);
  return b[rv].zones.field.filter(u => u.state === 'ready' && !isLagging(u, b) && hasBlocker(u, b, rv));
}

// 1. what the moment allowed, for a move (the last step of a seq)
function momentFacts(b, pid, seq, who) {
  const a = seq[seq.length - 1], out = [];
  if (a.step === 'declare_attack') {
    const att = findUnit(b, a.attacker_iid);
    const ap = att ? unitPower(b, pid, att.u) : 0, an = att ? short(att.u.card_id) : 'the attacker';
    const bl = blockers(b, pid);
    if (a.target.kind === 'gigs') {
      if (!bl.length) out.push(`${who} attack on the Gigs couldn't be blocked: the Rival had no ready Blocker.`);
      else {
        const big = bl.filter(u => unitPower(b, opp(pid), u) >= ap);
        if (!big.length) out.push(`The Rival's Blocker${bl.length > 1 ? 's' : ''} (${list(bl.map(u => `${short(u.card_id)} ${unitPower(b, opp(pid), u)}`))}) lose${bl.length > 1 ? '' : 's'} the fight to ${an} (${ap}).`);
      }
    } else {
      const t = findUnit(b, a.target.iid);
      if (t) {
        const tp = unitPower(b, opp(pid), t.u);
        out.push(`${an} (${ap}) ${ap >= tp ? 'beats' : 'loses to'} ${short(t.u.card_id)} (${tp})${ap >= tp ? '' : ' in a fight'}.`);
      }
    }
  }
  return out;
}

function sideNow(b, pid, startHand) {
  const Z = b[pid].zones, R = b[opp(pid)].zones;
  return {
    units: Z.field.map(u => short(u.card_id)), gear: Z.field.flatMap(u => (u.equipped_gear || []).map(g => short(g.card_id))),
    sold: Z.eddies.filter(e => startHand.has(e.iid)).map(e => short(e.card_id)),
    called: Z.legends.filter(l => l.face === 'face_up').map(l => short(l.card_id)),
    rivalUnits: R.field.map(u => short(u.card_id)), gigs: Z.gigs.length, rivalGigs: R.gigs.length,
    ready: Z.field.filter(u => u.state === 'ready').length,
    unspent: Z.eddies.filter(e => e.state === 'ready').length,
  };
}
const minus = (a, b) => { const left = b.slice(), out = []; for (const x of a) { const i = left.indexOf(x); if (i >= 0) left.splice(i, 1); else out.push(x); } return out; };

// 2. what each move did to the board it started from (both start from the same position)
function changes(b0, b1, pid, startHand) {
  const a = sideNow(b0, pid, startHand), z = sideNow(b1, pid, startHand), out = [];
  const played = minus(z.units, a.units), lost = minus(a.units, z.units);
  const removed = minus(a.rivalUnits, z.rivalUnits), gear = minus(z.gear, a.gear), sold = minus(z.sold, a.sold), called = minus(z.called, a.called);
  if (played.length) out.push(`plays ${list(played)}`);
  if (gear.length) out.push(`equips ${list(gear)}`);
  if (called.length) out.push(`calls ${list(called)}`);
  if (sold.length) out.push(`sells ${list(sold)}`);
  if (removed.length) out.push(`removes the Rival's ${list(removed)}`);
  if (z.gigs > a.gigs) out.push(`takes ${z.gigs - a.gigs} Gig${z.gigs - a.gigs > 1 ? 's' : ''}`);
  if (lost.length) out.push(`loses your ${list(lost)}`);
  return out;
}
function afterFacts(b0, yourBoard, bestBoard, pid, startHand, names = ['Your move', 'The better move']) {
  if (!yourBoard || !bestBoard) return [];
  const y = changes(b0, yourBoard, pid, startHand), c = changes(b0, bestBoard, pid, startHand);
  const onlyY = y.filter(x => !c.includes(x)), onlyC = c.filter(x => !y.includes(x));
  const out = [];
  if (onlyY.length) out.push(`${names[0]} ${list(onlyY)}.`);
  if (onlyC.length) out.push(`${names[1]} ${list(onlyC)}.`);
  return out;
}

// 3. the Rival's reply in the verification games (Bot A on both sides): counted, not averaged
function replySum(events) {
  const xs = (events || []).filter(Boolean), n = xs.length;
  if (!n) return null;
  const tally = arr => { const t = new Map(); for (const k of arr) t.set(k, (t.get(k) || 0) + 1); return [...t].sort((a, b) => b[1] - a[1]); };
  return {
    n,
    steal: xs.filter(e => e.gigsLost > 0).length,
    lose: xs.filter(e => e.lost.length).length,
    lost: tally(xs.flatMap(e => [...new Set(e.lost)])),
    attacks: tally(xs.flatMap(e => [...new Set(e.attacks.map(a => `${a.by} → ${a.to === 'Gigs' ? 'your Gigs' : a.to}`))])),
    rivalWins: xs.filter(e => e.won === false).length,
    youWin: xs.filter(e => e.won === true).length,
  };
}
const of = (k, n) => `${k} of ${n}`;
function replyFacts(y, c, names) {
  if (!y || !c) return [];
  const out = [], n = c.n;
  const big = (a, b) => Math.abs(a / y.n - b / c.n) >= 0.2;
  if (big(y.rivalWins, c.rivalWins)) out.push(`The Rival wins on their turn in ${of(y.rivalWins, y.n)} games after ${names[0]}, ${of(c.rivalWins, n)} after ${names[1]}.`);
  if (big(y.steal, c.steal)) out.push(`They steal a Gig in ${of(y.steal, y.n)} games after ${names[0]}, ${of(c.steal, n)} after ${names[1]}.`);
  if (big(y.lose, c.lose)) {
    const who = (s, k) => (s.lost.length ? ` (${s.lost.slice(0, 2).map(([x]) => x).join(', ')})` : '');
    out.push(`You lose a Unit in ${of(y.lose, y.n)} games after ${names[0]}${who(y)}, ${of(c.lose, n)} after ${names[1]}${who(c)}.`);
  }
  return out;
}

// 1b. exposure: an attack spends the attacker; which Rival Units could attack it on their turn
function exposure(b, pid, seq, who) {
  const a = seq?.[seq.length - 1];
  if (!a || a.step !== 'declare_attack') return null;
  const att = findUnit(b, a.attacker_iid);
  if (!att || att.p !== pid) return null;
  const ap = unitPower(b, pid, att.u), rv = opp(pid);
  const threats = b[rv].zones.field.filter(u => unitPower(b, rv, u) >= ap).map(u => `${short(u.card_id)} (${unitPower(b, rv, u)})`);
  if (!threats.length) return null;
  return `${who} spends ${short(att.u.card_id)} (${ap}); on their turn the Rival's ${list(threats)} can attack it.`;
}

// the kind of move, for one headline sentence
const kind = seq => {
  const a = seq[seq.length - 1];
  if (a.step === 'declare_attack') return a.target.kind === 'gigs' ? 'attack-gigs' : 'attack-unit';
  if (a.step === 'end_turn') return 'end';
  return seq.find(x => ['play_card', 'sell_card', 'call_legend', 'play_legend_solo', 'activate_anytime_spend'].includes(x.step))?.step || a.step;
};

function headline(yk, bk) {
  if (bk === 'end' && yk !== 'end') return 'Stopping here was better.';
  if (yk === 'end' && bk !== 'end') return 'You ended the turn with a better play left.';
  if (bk.startsWith('attack') && !yk.startsWith('attack')) return 'Attack first.';
  if (yk.startsWith('attack') && !bk.startsWith('attack')) return 'This attack was a risk.';
  if (yk === 'attack-unit' && bk === 'attack-gigs') return 'Go for the Gigs, not the Unit.';
  if (yk === 'attack-gigs' && bk === 'attack-unit') return 'Clear the Unit before going for Gigs.';
  return null;
}

function explainMove({ A, pid, yours, best, match, say, g }) {
  const startHand = new Set(A.board[pid].zones.hand.map(h => h.iid));
  const bestBoard = run(A, [best.seq], pid);
  const yourBoard = match ? run(A, match.path, pid) : null;
  const yourSeq = match ? match.path[0] : null;
  const ry = replySum(yours.events), rb = replySum(best.events);
  const reply = ry && rb ? { you: ry, best: rb } : null;
  const reasons = [];
  if (g === 'great') {   // you beat the bot's best idea: say what your move did better
    if (yourSeq) reasons.push(...momentFacts(A.board, pid, yourSeq, 'Your'));
    const ex = exposure(A.board, pid, best.seq, "The bot's pick");
    if (ex) reasons.push(ex);
    reasons.push(...afterFacts(A.board, yourBoard, bestBoard, pid, startHand, ['Your move', "The bot's pick"]));
    reasons.push(...replyFacts(rb, ry, ["the bot's pick", 'yours']));
    return { headline: null, reasons: [...new Set(reasons)], reply, better: null };
  }
  const yk = yourSeq ? kind(yourSeq) : null, bk = kind(best.seq);
  const h = yk ? headline(yk, bk) : null;
  reasons.push(...momentFacts(A.board, pid, best.seq, 'This'));
  const exY = exposure(A.board, pid, yourSeq, 'Your attack');
  if (exY) reasons.push(exY);
  const exB = exposure(A.board, pid, best.seq, 'The better move');
  if (exB) reasons.push(`${exB} It still comes out ahead.`);
  if (yourSeq) for (const f of momentFacts(A.board, pid, yourSeq, 'Your')) if (/loses|couldn't/.test(f)) reasons.push(f);
  reasons.push(...afterFacts(A.board, yourBoard, bestBoard, pid, startHand));
  reasons.push(...replyFacts(ry, rb, ['your move', 'this one']));
  return { headline: h, reasons: [...new Set(reasons)], reply, better: say(best.seq) };
}

module.exports = { explainMove, replySum };
