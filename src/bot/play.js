// Play-vs-bot and bot-vs-bot game sessions for board/play.html (served by scripts/serve-board.js).
// A session holds the engine board, whose decision it is, the bots, and a log. The page polls:
//   view(id)       what the viewer may see (in 'play' mode the bot's hand/deck/face-down Legends are
//                  hidden; in 'watch' mode the spectator sees everything)
//   move(id, i)    the human plays option i of the current decision
//   advance(id)    the bot to act makes ONE decision (the page calls this repeatedly, so each bot move
//                  shows up as it happens; the strong bots take 0.3-2 s per decision)
// Every bot decision is logged with what the bot compared: each searched move and its estimated win
// chance, and the bot's guess at its opponent's deck.
'use strict';
const fs = require('fs');
const path = require('path');
const { setupGame, step, defaultPassAction, CARDS } = require('../engine');
const { loadDecks, TRAIN_DIRS } = require('./arena');
const { makeBot } = require('./bots');
const policy = require('../coach/policy');
const { mulberry } = require('../coach/bridge');
const { describe, taps } = require('./describe');
const { simState, PID } = require('./simview');
const { hideOwnLegends } = require('./strong');

const BY = new Map(CARDS.map(c => [c.number, c]));
const short = n => (BY.get(n)?.name || n).split(':')[0];

const BOTS = [
  { id: 'A', name: 'Bot A - Net Searcher', spec: 'strong',
    about: 'Every decision: tries its top 5 moves (greedy shortlist) in 8 imagined games with your hidden cards guessed from what you showed, plays out this turn and your reply, then asks the value net who is winning. Strongest measured: 82.6% vs tuned greedy, 64.8% vs Bot B. Known weakness: the value net under-rates selling.' },
  { id: 'B', name: 'Bot B - Playout Searcher', spec: 'strong:leaf=prob:horizon=99:deals=6:k=4',
    about: 'Every decision: tries its top 4 moves in 6 imagined games and plays each one to the end of the game with the tuned greedy bot - no neural net. 72.7% vs tuned greedy.' },
  { id: 'G', name: 'Tuned greedy (fast)', spec: 'greedyt',
    about: 'One move ahead with the tuned position score. Instant; the baseline the others are measured against.' },
];
const DEFAULTS = { you: 'choombattler-adam-river-viktor.txt', A: 'choombattler-dexter-padre-v.txt', B: '4-blue-2-green-standard.txt' };

let DECKS = null;
function decks() {
  if (DECKS) return DECKS;
  DECKS = loadDecks(TRAIN_DIRS).map(d => {
    const L = d.legends.map(n => BY.get(n));
    const ram = {};
    for (const l of L) ram[l.color] = (ram[l.color] || 0) + (l.ram || 0);
    let rate = null;
    const f = path.join(__dirname, '..', '..', 'board', 'meta-decks', d.name);
    if (fs.existsSync(f)) { const m = fs.readFileSync(f, 'utf8').match(/([\d.]+)% win rate over (\d+)/); if (m) rate = `${m[1]}% over ${m[2]} games`; }
    const colours = Object.entries(ram).sort((a, b) => b[1] - a[1]).map(([c, r]) => `${c} ${r}`).join(' / ');
    return { file: d.name, deck: d, label: `${L.map(l => l.name.split(':')[0]).join(' / ')} (${colours})`, rate, coverage: d.name.startsWith('coverage') };
  });
  return DECKS;
}
function config() {
  return { bots: BOTS.map(({ id, name, about }) => ({ id, name, about })), defaults: DEFAULTS,
    decks: decks().filter(d => !d.coverage).map(({ file, label, rate }) => ({ file, label, rate })) };
}

const SESSIONS = new Map();
let nextId = 1;

// opts: { mode: 'play'|'watch', you: 'p1'|'p2', bots: { p1, p2 } (bot ids; the human's side null),
//         decks: { p1, p2 } (file names), first: 'p1'|'p2'|'random', seed }
function create(opts) {
  const D = decks();
  const deckOf = f => (D.find(d => d.file === f) || D[0]);
  const seed = Number.isFinite(+opts.seed) && opts.seed !== '' ? +opts.seed : Math.floor(Math.random() * 1e9);
  const rng = mulberry(seed);
  const first = opts.first === 'p1' || opts.first === 'p2' ? opts.first : (rng() < 0.5 ? 'p1' : 'p2');
  const s = { id: String(nextId++), mode: opts.mode === 'watch' ? 'watch' : 'play', you: opts.mode === 'watch' ? null : (opts.you || 'p1'),
    seed, first, decks: { p1: deckOf(opts.decks?.p1), p2: deckOf(opts.decks?.p2) }, bots: {}, ctx: {}, log: [], over: false };
  for (const p of ['p1', 'p2']) {
    if (p === s.you) continue;
    const B = BOTS.find(b => b.id === opts.bots?.[p]) || BOTS[0];
    s.bots[p] = { ...B, bot: makeBot(B.spec) };
    s.ctx[p] = { rng: mulberry(seed * 2 + (p === 'p1' ? 1 : 2)) };
  }
  const r = step(setupGame(s.decks.p1.deck, s.decks.p2.deck, first, { seed }), undefined);
  s.b = r.board; s.wf = r.waitingFor; s.b._trace = null;
  s.labels = { p1: name(s, 'p1'), p2: name(s, 'p2') };
  s.steps = []; s.rlog = [];
  record(s, { turn: 0, kind: 'info', text: `${first === s.you ? 'You go' : name(s, first) + ' goes'} first. Seed ${seed}.` });
  autoForced(s);
  SESSIONS.set(s.id, s);
  return s.id;
}

const name = (s, p) => s.you === p ? 'You' : (s.bots[p]?.name.split(' - ')[0] || p.toUpperCase());
const owner = s => s.wf && (s.wf.owner || s.b.active_player);

// legal options for the current decision (each a macro move that the engine accepts)
function options(s) {
  if (!s.wf || s.b.winner) return [];
  const out = [];
  for (const seq of policy.moves(s.wf, s.b)) if (policy.tryApply(s.b, s.wf, seq)) out.push(seq);
  if (!out.length) { const d = defaultPassAction(s.wf); if (d) out.push([d]); }
  return out;
}

// the decision's choice_needed, with the last known source card carried over to follow-up prompts
// ("Increase by how much?" belongs to the 6th Street Recruits prompt just before it)
function cnOf(s) {
  const cn = s.wf?.choice_needed;
  if (!cn) return null;
  const m = (cn.prompt || '').match(/^([^:?]+?):/);
  if (cn.source_card_id) s.lastSrc = short(cn.source_card_id);
  else if (m && CARDS.some(c => c.name.split(':')[0] === m[1])) s.lastSrc = m[1];
  return { ...cn, _src: s.lastSrc || null };
}
function describeSrc(cn) {
  const c = { ...cn, _src: null };
  const src = cn.source_card_id ? short(cn.source_card_id) : null;
  return src && !cn.prompt.startsWith(src) ? `${src}: ${cn.prompt}` : cn.prompt;
}

// what a move did that its text can't say in advance: the Legend a Call flipped, Units defeated
function results(before, after) {
  const out = [];
  for (const p of ['p1', 'p2']) {
    const up = new Set(before[p].zones.legends.filter(l => l.face === 'face_up').map(l => l.iid));
    for (const l of after[p].zones.legends) if (l.face === 'face_up' && !up.has(l.iid)) out.push(`flips ${short(l.card_id)}`);
    const still = new Set(after[p].zones.field.map(u => u.iid));
    for (const u of before[p].zones.field) if (!still.has(u.iid) && !after[p].zones.hand.some(h => h.iid === u.iid)) out.push(`${short(u.card_id)} defeated`);
  }
  return out;
}

function apply(s, seq, entry) {
  const r = policy.tryApply(s.b, s.wf, seq);
  if (!r) return false;
  const res = results(s.b, r.board);
  if (res.length && !entry.text.startsWith('Call ' + res[0].slice(6))) entry.text += ` → ${res.join(', ')}`;
  if (s.wf.step === 'main_phase' || s.wf.step === 'defensive_step') s.lastSrc = null;
  const flip = res.find(x => x.startsWith('flips '));
  if (flip) s.lastSrc = flip.slice(6);   // the Called Legend's prompts that follow belong to it
  entry.active = s.b.active_player;   // whose turn the move was made in (end turn flips it)
  s.b = r.board; s.wf = r.waitingFor; s.b._trace = null;
  if (s.b.winner || !s.wf) s.over = true;
  record(s, entry);
  if (s.over) record(s, { turn: s.b.turn_number, kind: 'info', text: s.b.winner ? `${name(s, s.b.winner)} won.` : 'Game ended.' });
  return true;
}

// one board step (the position AFTER `entry`'s move) in the replay board's format, plus its log line
function record(s, entry) {
  s.log.push(entry);
  const viewer = s.mode === 'watch' ? 'p1' : s.you;
  const state = simState(s.b, viewer, s.labels, s.mode === 'watch' || s.over);
  const i = s.steps.length;
  const turnOf = entry.active || s.b.active_player;
  const who = entry.who ? `${s.labels[entry.who]}: ` : '';
  // the line names its actor itself, so tag it with the actor (app.js adds a name only for other players)
  const line = { id: `l${i}`, message: `${who}${entry.text}`, turnNumber: entry.turn, turnOwnerPlayerId: PID[entry.who || turnOf], turnOwnerLabel: s.labels[turnOf], step: i };
  s.steps.push({ state, action: { label: line.message }, newLog: [line], turn: s.b.turn_number, think: entry.kind === 'bot' ? entry : null });
  s.rlog.push(line);
}

// the human never has to click through a decision with exactly one option that isn't a real choice
function autoForced(s) {
  for (let i = 0; i < 50 && !s.over && s.wf && owner(s) === s.you; i++) {
    const o = options(s);
    if (o.length !== 1 || s.wf.step === 'main_phase') return;
    apply(s, o[0], { turn: s.b.turn_number, who: s.you, kind: 'forced', text: describe(s.b, s.you, o[0], cnOf(s)) });
  }
}

function move(id, i) {
  const s = SESSIONS.get(id);
  if (!s || s.over || owner(s) !== s.you) return { error: 'not your decision' };
  const o = options(s);
  const seq = o[+i];
  if (!seq) return { error: 'no such option' };
  const text = describe(s.b, s.you, seq, cnOf(s));
  if (!apply(s, seq, { turn: s.b.turn_number, who: s.you, kind: 'you', text, onTurn: s.b.active_player === s.you })) return { error: 'engine refused the move' };
  autoForced(s);
  return { ok: true };
}

function advance(id) {
  const s = SESSIONS.get(id);
  if (!s || s.over) return { error: 'game over' };
  const p = owner(s);
  if (!s.bots[p]) return { error: 'not a bot decision' };
  const B = s.bots[p], ctx = s.ctx[p];
  ctx.lastSearch = null; ctx.last = null; ctx.belief = null;
  const prompt = cnOf(s), before = s.b, step_ = s.wf.step;
  const t = Date.now();
  let seq = null;
  // bots can't see which face-down Legend is where
  try { seq = B.bot.act(hideOwnLegends(s.b, p, ctx.rng), s.wf, p, ctx); } catch (e) { s.log.push({ turn: s.b.turn_number, kind: 'info', text: `${name(s, p)} error: ${e.message}` }); }
  const ms = Date.now() - t;
  if (!seq || !policy.tryApply(s.b, s.wf, seq)) { const o = options(s); seq = o[0]; }
  if (!seq) { s.over = true; return { error: 'stuck' }; }
  const entry = { turn: s.b.turn_number, who: p, kind: 'bot', text: describe(before, p, seq, prompt), ms, step: step_, onTurn: s.b.active_player === p };
  const L = ctx.lastSearch || (ctx.last ? { options: ctx.last } : null);
  if (L?.options?.length > 1) {
    const sl = L.shortlist ? new Set(L.shortlist) : null;
    entry.considered = L.options.map(o => ({ text: describe(before, p, o.seq, prompt), pct: Math.round(1000 * o.value) / 10, chosen: o.seq === seq,
      explored: sl ? !sl.has(o.seq) && o.seq[o.seq.length - 1].step !== 'end_turn' : false }));
    if (L.ranked) entry.notSearched = L.ranked.length - L.options.length;
  }
  if (ctx.belief) entry.belief = ctx.belief.map(x => ({ deck: x.deck === 'custom' ? 'an unknown / custom list' : (decks().find(d => d.file === x.deck)?.label || x.deck), p: Math.round(100 * x.p) }));
  apply(s, seq, entry);
  autoForced(s);
  return { ok: true };
}

// ---- what the viewer sees ----
function cardInfo(n) {
  const c = BY.get(n) || {};
  return { name: c.name || n, short: short(n), type: c.type, color: c.color, cost: c.cost, power: c.power, ram: c.ram, text: c.rules_text || '' };
}
function side(s, p, reveal) {
  const b = s.b, Z = b[p].zones;
  const unit = u => ({ ...cardInfo(u.card_id), iid: u.iid, power: policy.unitPower(b, p, u), printed: BY.get(u.card_id)?.power, spent: u.state === 'spent',
    gear: (u.equipped_gear || []).map(g => cardInfo(g.card_id)) });
  return {
    name: name(s, p), deck: s.decks[p].label,
    gigs: Z.gigs.map(g => ({ sides: g.sides, value: g.value, stolen: !String(g.iid).startsWith(p) })),
    fixer: (Z.fixer || []).map(d => d.sides),
    legends: Z.legends.map(l => (l.face === 'face_up' || reveal ? { ...cardInfo(l.card_id), up: l.face === 'face_up', spent: l.state === 'spent', gear: (l.equipped_gear || []).map(g => cardInfo(g.card_id)) } : { hidden: true, spent: l.state === 'spent' })),
    field: Z.field.map(unit),
    hand: reveal ? Z.hand.map(h => cardInfo(h.card_id)) : null, handCount: Z.hand.length,
    eddies: Z.eddies.length, eddiesReady: Z.eddies.filter(e => e.state === 'ready' && !b[p].tapped.includes(e.iid)).length,
    deck: Z.deck.length, trash: Z.trash.map(c => short(c.card_id)),
  };
}

function view(id) {
  const s = SESSIONS.get(id);
  if (!s) return null;
  const p = owner(s);
  const yourTurn = !s.over && p === s.you;
  const reveal = q => s.mode === 'watch' || q === s.you || s.over;
  const v = {
    id: s.id, mode: s.mode, you: s.you, over: s.over, winner: s.b.winner || null, turn: s.b.turn_number, active: s.b.active_player,
    toAct: s.over ? null : p, botToAct: !s.over && !!s.bots[p],
    bots: Object.fromEntries(Object.entries(s.bots).map(([q, B]) => [q, { name: B.name, about: B.about }])),
    sides: { p1: side(s, 'p1', reveal('p1')), p2: side(s, 'p2', reveal('p2')) },
    log: s.log, seed: s.seed,
  };
  if (s.b.current_attack) {
    const A = s.b.current_attack;
    v.attack = { attacker: describeIid(s.b, A.attacker_iid), target: A.target?.kind === 'gigs' ? 'Gigs' : describeIid(s.b, A.target?.iid) };
  }
  if (yourTurn) {
    const o = options(s);
    v.decision = { step: s.wf.step, prompt: s.wf.choice_needed?.prompt || null,
      options: o.map((seq, i) => ({ i, text: describe(s.b, s.you, seq, cnOf(s)), pay: taps(seq) })) };
    // cards an effect shows you (Viktor Vektor's top-of-deck look...): show them, marking what can be taken
    const cn = s.wf.choice_needed;
    if (cn?.available_refs) v.decision.reveal = cn.available_refs.map(r => ({ ...cardInfo(r.card_id), ok: !cn.eligible_iids || cn.eligible_iids.includes(r.iid) }));
    if (v.decision.prompt) v.decision.prompt = describeSrc(cn);
  }
  return v;
}
function describeIid(b, iid) {
  for (const p of ['p1', 'p2']) for (const z of ['field', 'legends']) {
    const r = b[p].zones[z].find(x => x.iid === iid);
    if (r) return short(r.card_id);
  }
  return '?';
}

// everything the page needs since step `from`: new board steps + log lines, and the current decision
function poll(id, from = 0) {
  const s = SESSIONS.get(id);
  if (!s) return null;
  const v = view(id);
  const me = s.mode === 'watch' ? 'p1' : s.you, rival = me === 'p1' ? 'p2' : 'p1';
  return {
    match: { me: PID[me], rival: PID[rival], labels: { player1: s.labels.p1, player2: s.labels.p2 },
      decks: { player1: s.decks.p1.label, player2: s.decks.p2.label } },
    from, steps: s.steps.slice(from), log: s.rlog.filter(l => l.step >= from), total: s.steps.length,
    mode: s.mode, you: s.you ? PID[s.you] : null, over: s.over, winner: s.b.winner ? PID[s.b.winner] : null,
    toAct: v.toAct ? PID[v.toAct] : null, botToAct: v.botToAct, bots: Object.fromEntries(Object.entries(v.bots).map(([k, x]) => [PID[k], x])),
    decision: v.decision || null, attack: v.attack || null, seed: s.seed,
  };
}

module.exports = { config, create, view, poll, move, advance, BOTS };
