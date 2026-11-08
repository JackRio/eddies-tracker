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
const { simState, PID, artId, unitKeywords, kwText } = require('./simview');
const { hideOwnLegends } = require('./strong');
const { botView } = require('./view');   // what a bot may know (opponent re-dealt from its deck guess)
const { SCRIPTS } = require('../engine/lib/cards');
const { cloneBoard } = require('../engine/lib/clone');
const { evalExpr } = require('../engine/lib/eval');
const P = require('../engine/lib/primitives');

const BY = new Map(CARDS.map(c => [c.number, c]));
const short = n => (BY.get(n)?.name || n).split(':')[0];

const BOTS = [
  { id: 'A', name: 'Daemon', spec: 'strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:gb=1:alt=1:tb=1',   // r3 nets + search fixes (gb/alt/tb): vs r3 Daemon 60.0% / 60.0% pilot, 58.1% pool (3 gates, Nov 8 2026)
   
    about: ['The strongest bot', 'Learned from thousands of bot games', 'Guesses your hand and deck from what you show', 'Looks a few turns ahead before each move'] },
  { id: 'B', name: 'Black ICE', spec: 'strong:leaf=prob:horizon=99:deals=6:k=4',
    about: ['Plays each option out to the end of the game', 'Guesses your hidden cards too', 'Strong but slow; never learns'] },
  { id: 'G', name: 'Gonk', spec: 'greedyt',
    about: ['Only looks one move ahead', 'Instant, and the easiest to beat'] },
];
// default match: Bot A vs Bot A, YYR (River / Viktor / Adam, ChoomBattler list) vs BBG (Alt / Hanako / Jackie);
// in "I play the bot" you get YYR and the bot BBG
const DEFAULTS = { mode: 'watch', bot: 'A', p1: 'choombattler-adam-river-viktor.txt', p2: '4-blue-2-green-standard.txt' };

let DECKS = null, NETDECKS = null;
const NET_DIR = path.join(__dirname, 'field-decks', 'netdeck');
function deckEntry(d) {
    const L = d.legends.map(n => BY.get(n));
    const ram = {};
    for (const l of L) ram[l.color] = (ram[l.color] || 0) + (l.ram || 0);
    const colors = Object.entries(ram).sort((a, b) => b[1] - a[1]);
    const n = {}; for (const l of L) n[l.color] = (n[l.color] || 0) + 1;
    const tag = Object.entries(n).sort((a, b) => b[1] - a[1]).map(([c, k]) => (c[0]).repeat(k)).join('');   // YYR, BBG...
    return { file: d.name, deck: d, legends: L.map(l => l.name.split(':')[0]), colors, tag,
      label: `${L.map(l => l.name.split(':')[0]).join(' / ')} (${colors.map(([c, r]) => `${c} ${r}`).join(' / ')})` };
}
// the 1,600 public netdeck.gg lists (scripts/fetch-netdeck.js): only for "random community deck"
function netDecks() {
  return (NETDECKS ||= loadDecks([NET_DIR]).map(d => {
    const e = deckEntry(d);
    const head = fs.readFileSync(path.join(NET_DIR, d.name), 'utf8').split('\n')[0];
    e.title = (head.match(/^#\s*(.+?)\s+-\s+by\s+(\S+)/) || []).slice(1).join(' by ') || null;   // "12 unit BBG - SIde Gig by alexkrez"
    if (e.title) e.label += ` · "${e.title}"`;
    e.likes = +((head.match(/, (\d+) likes/) || [])[1] || 0);
    return e;
  }));
}
// 'random' = a random list from the menu, 'random-net' = a random community list; picked from the game's seed
function resolveDeck(f, rng) {
  const D = decks().filter(d => !d.coverage);
  if (f === 'random') return D[Math.floor(rng() * D.length)];
  if (f === 'random-net') { const N = netDecks(); return N.length ? N[Math.floor(rng() * N.length)] : D[Math.floor(rng() * D.length)]; }
  return decks().find(d => d.file === f) || netDecks().find(d => d.file === f) || D[0];
}
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
  return { bots: BOTS.map(({ id, name, about }) => ({ id, name, about })), defaults: DEFAULTS, community: netDecks().length, sample: community(8),
    decks: decks().filter(d => !d.coverage).map(d => { const e = deckEntry(d.deck);
      return { file: d.file, label: d.label, rate: d.rate, legends: e.legends, colors: e.colors, tag: e.tag,
        group: d.file.startsWith('choombattler') ? 'meta' : 'standard' }; }) };
}

const SESSIONS = new Map();
let nextId = 1;

// opts: { mode: 'play'|'watch', you: 'p1'|'p2', bots: { p1, p2 } (bot ids; the human's side null),
//         decks: { p1, p2 } (file names), first: 'p1'|'p2'|'random', seed }
function create(opts) {
  const seed = Number.isFinite(+opts.seed) && opts.seed !== '' ? +opts.seed : Math.floor(Math.random() * 1e9);
  const rng = mulberry(seed);
  const deckOf = f => resolveDeck(f, rng);
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
  if (s.you) s.b.ask_single = { [s.you]: true };   // you see every target pick, even a single one
  s.labels = { p1: name(s, 'p1'), p2: name(s, 'p2') };
  s.steps = []; s.rlog = [];
  record(s, { turn: 0, kind: 'info', text: `${first === s.you ? 'You go' : name(s, first) + ' goes'} first. Seed ${seed}.` });
  autoForced(s);
  SESSIONS.set(s.id, s);
  return s.id;
}

const baseName = (s, p) => s.you === p ? 'You' : (s.bots[p]?.name.split(' - ')[0] || p.toUpperCase());
// colour tag of a deck's Legends, most-represented colour first (YYR, BBG...)
function colourTag(deck) {
  const n = {};
  for (const id of deck.legends || []) { const c = BY.get(id)?.color; if (c) n[c] = (n[c] || 0) + 1; }
  return Object.entries(n).sort((a, b) => b[1] - a[1]).map(([c, k]) => c[0].toUpperCase().repeat(k)).join('');
}
function name(s, p) {
  if (s.names) return s.names[p];   // review branches (branch() below): the replay's player names
  const q = p === 'p1' ? 'p2' : 'p1', n = baseName(s, p);
  if (n !== baseName(s, q)) return n;
  const a = colourTag(s.decks[p].deck), b = colourTag(s.decks[q].deck);
  return a && a !== b ? `${n} (${a})` : `${n} (${p === 'p1' ? 'left' : 'right'})`;
}
const owner = s => s.wf && (s.wf.owner || s.b.active_player);

// legal options for the current decision (each a macro move that the engine accepts)
function options(s) {
  if (!s.wf || s.b.winner) return [];
  const out = [];
  for (const seq of policy.moves(s.wf, s.b)) if (policy.tryApply(s.b, s.wf, seq)) out.push(seq);
  if (!out.length) { const d = defaultPassAction(s.wf); if (d) out.push([d]); }
  return out;
}

// ---- your options, with payment left to you ----
// Bots use macro moves with automatic taps. You pick what pays: each option is the bare action plus
// `n` (how many €$ it costs) and how the payment is passed to the engine:
//   'taps'  main-phase plays / Calls / Go Solo: tap_resource for each payer, then the action
//   'iids'  defensive Call and {Spend} abilities with a €$ cost: the action's pay_iids
// Calls get one option per face-down Legend slot (you don't know which Legend is where), so you can
// flip a READY one and pay with something else - a Called Legend keeps its state.
function abilityCost(b, pid, a) {
  let ref = null;
  for (const l of [...b[pid].zones.field, ...b[pid].zones.legends]) {
    if (l.iid === a.iid) ref = l;
    for (const g of l.equipped_gear || []) if (g.iid === a.iid) ref = g;
  }
  const c = ref && SCRIPTS[ref.card_id]?.abilities?.[a.ability_idx]?.cost?.eddies;
  if (c == null) return 0;
  try { return Math.max(0, typeof c === 'number' ? c : evalExpr(c, b, { self_pid: pid, self_iid: ref.iid, self_card_id: ref.card_id, bindings: {} })); } catch { return 0; }
}
function payables(b, pid, exclude) {
  const p = b[pid], Z = p.zones;
  const out = [];
  Z.eddies.forEach(e => { if (e.state === 'ready') out.push({ iid: e.iid, label: 'Eddie', kind: 'eddie' }); });
  Z.legends.forEach((l, k) => {
    if (l.state !== 'ready' || !P.legendSpendable(l) || l.iid === exclude) return;
    const down = l.face !== 'face_up';
    const lastDown = down && Z.legends.filter(x => x.face !== 'face_up').length === 1;
    out.push({ iid: l.iid, kind: down ? 'legend-down' : 'legend', label: down && !lastDown ? `Face-down Legend #${k + 1}` : short(l.card_id) });
  });
  return out;
}
// default payment: Eddies, then face-down Legends, then face-up ones (they may have a {Spend} to keep)
const order = { eddie: 0, 'legend-down': 1, legend: 2 };
// (`avoid` last: the Legend being Called - paying with it flips it up spent)
const defaultPay = (list, n, avoid) => list.slice().sort((x, y) => (x.iid === avoid) - (y.iid === avoid) || order[x.kind] - order[y.kind]).slice(0, n).map(x => x.iid);

function humanOptions(s) {
  const b = s.b, wf = s.wf, pid = s.you;
  if (!wf || b.winner) return [];
  const out = [];
  const add = (o, cn) => {
    const list = o.n ? payables(b, pid, o.exclude) : [];
    if (o.n && list.length < o.n) return;
    const dp = o.n ? defaultPay(list, o.n, o.avoid) : [];
    if (!policy.tryApply(b, wf, build(o, dp))) return;
    out.push({ ...o, text: o.text || describe(b, pid, build(o, dp), cn), payables: list, defaultPay: dp });
  };
  const cn = cnOf(s);
  const Z = b[pid].zones;
  const downSlots = () => Z.legends.map((l, k) => ({ l, k })).filter(x => x.l.face !== 'face_up');
  const callText = (x, n, defensive) => {
    const last = downSlots().length === 1;
    return `Call ${last ? `${short(x.l.card_id)} - last face-down Legend` : `face-down Legend #${x.k + 1}`}${x.l.state === 'spent' ? ' (spent - flips up spent)' : ''}${defensive ? ' (as a reaction)' : ''}`;
  };
  let calls = false;
  for (const seq of options(s)) {
    const last = seq[seq.length - 1];
    const n = seq.filter(x => x.step === 'tap_resource').length;
    if (last.step === 'call_legend') {
      if (calls) continue; calls = true;
      for (const x of downSlots()) add({ seq: [{ ...last, iid: x.l.iid }], n, mode: 'taps', avoid: x.l.iid, group: 'Legends', text: callText(x) });
      continue;
    }
    if (last.step === 'call_legend_defensive') {
      if (calls) continue; calls = true;
      for (const x of downSlots()) add({ seq: [{ ...last, iid: x.l.iid, pay_iids: undefined }], n: wf.call_legend_cost ?? 1, mode: 'iids', avoid: x.l.iid, group: 'Legends', text: callText(x, 0, true) });
      continue;
    }
    if (last.step === 'activate_anytime_spend' || last.step === 'activate_asset_spend') {
      const c = abilityCost(b, pid, last);
      add({ seq: [last], n: c, mode: c ? 'iids' : 'taps', exclude: last.iid }, cn);
      continue;
    }
    add({ seq: seq.filter(x => x.step !== 'tap_resource'), n, mode: 'taps' }, cn);
  }
  return out;
}
// the engine actions for option `o` paid with `iids`
function build(o, iids) {
  if (!o.n) return o.seq;
  if (o.mode === 'taps') return [...iids.map(iid => ({ step: 'tap_resource', iid })), ...o.seq];
  const a = o.seq[o.seq.length - 1];
  return [...o.seq.slice(0, -1), { ...a, pay_iids: iids }];
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

// what a move did that its text can't say in advance, by comparing the boards before and after:
//   inline  (appended to the move's line): what paid ("paid 1 Eddie + 1 Legend"), the Legend a Call
//           flipped, where Units / Gear went, power changes, dice rolled / changed / swapped / taken,
//           cards drawn, discarded, trashed from the deck or returned from the trash
//   start   (its own line when the move ended a turn): the new turn's ready and draw
// `subj` = the player whose line this is (the log prefixes it): their own things are unnamed ("draws
// X", "own d12"), the other player's are named ("Bot A's d12", "you draw X", "your Meredith Stout").
// Dice are named by their OWNER (both players have a d6) and old value; the board rings the die.
// Hidden cards stay hidden: the Rival's draws read "draws a card" unless you may see them.
const OPP = { p1: 'p2', p2: 'p1' };
function results(s, before, after, seq, subj, trace = []) {
  const inline = [], start = [], drawnBy = {}, recovered = [];
  const see = p => s.mode === 'watch' || p === s.you;
  const who = p => name(s, p);
  // "draws X" for the subject, "you draw X" / "Bot A draws X" for the other player
  const act = (p, third, base) => (p === subj ? third : p === s.you ? `you ${base}` : `${who(p)} ${third}`);
  const poss = p => (p === subj ? '' : p === s.you ? 'your ' : `${who(p)}'s `);
  const dieOwner = g => (String(g.iid).match(/^(p[12])/) || [])[1];
  const dieName = g => { const o = dieOwner(g); return `${o === s.you ? 'your' : o === subj ? 'own' : o ? `${who(o)}'s` : ''} d${g.sides}`.trim(); };
  const turnChanged = after.turn_number !== before.turn_number;
  const where = new Map();   // iid -> zone, before
  for (const p of ['p1', 'p2']) for (const z of ['hand', 'deck', 'trash', 'field', 'eddies']) for (const c of before[p].zones[z] || []) where.set(c.iid, `${p}:${z}`);
  const played = new Set(seq.filter(a => a.iid && (a.step === 'play_card' || a.step === 'sell_card' || a.step === 'play_card_interrupt_cast')).map(a => a.iid));
  const ability = new Set(seq.filter(a => /spend$/.test(a.step) || a.step === 'activate_anytime_spend').map(a => a.iid));
  const mulligan = seq.some(a => a.step === 'mulligan' && a.mulligan);
  const list = cs => cs.map(c => short(c.card_id)).join(', ');

  // what paid: Eddies and Legends the subject spent (not a {Spend} ability's own card)
  if (!turnChanged && subj) {
    const eddies = before[subj].zones.eddies.filter(e => e.state === 'ready' && after[subj].zones.eddies.find(x => x.iid === e.iid)?.state === 'spent').length;
    const legs = before[subj].zones.legends.filter(l => {
      const a = after[subj].zones.legends.find(x => x.iid === l.iid);
      return l.state === 'ready' && a?.state === 'spent' && !ability.has(l.iid);
    }).length;
    const parts = [eddies ? `${eddies} Eddie${eddies === 1 ? '' : 's'}` : '', legs ? `${legs} Legend${legs === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (parts.length) inline.push(`paid ${parts.join(' + ')}`);
  }
  // dice that changed hands this move: two at once is a swap
  const bg = new Map(['p1', 'p2'].flatMap(q => before[q].zones.gigs.map(g => [g.iid, { ...g, ctl: q }])));
  const moved = ['p1', 'p2'].flatMap(p => after[p].zones.gigs.filter(g => bg.get(g.iid) && bg.get(g.iid).ctl !== p).map(g => ({ g, p })));
  const stealMove = seq.some(a => a.step === 'choose_gig_to_steal');
  if (moved.length === 2 && moved[0].p !== moved[1].p) inline.push(`swaps ${dieName(moved[0].g)} (${moved[0].g.value}) with ${dieName(moved[1].g)} (${moved[1].g.value})`);
  else if (!stealMove) for (const { g, p } of moved) inline.push(`${act(p, dieOwner(g) === p ? 'takes back' : 'takes', dieOwner(g) === p ? 'take back' : 'take')} ${dieName(g)} (${g.value})`);

  for (const p of ['p1', 'p2']) {
    const B = before[p].zones, A = after[p].zones;
    const up = new Set(B.legends.filter(l => l.face === 'face_up').map(l => l.iid));
    for (const l of A.legends) if (l.face === 'face_up' && !up.has(l.iid)) inline.push(`flips ${short(l.card_id)}`);
    // Units that left the Field, and where they went
    const still = new Set(A.field.map(u => u.iid));
    for (const u of B.field) {
      if (still.has(u.iid)) continue;
      const to = A.hand.some(h => h.iid === u.iid) ? 'returned to hand'
        : A.deck.some(c => c.iid === u.iid) ? (A.deck[A.deck.length - 1]?.iid === u.iid ? 'put on the bottom of the deck' : 'shuffled into the deck')
        : (A.removed || []).some(c => c.iid === u.iid) ? 'removed from the game'
        : ['p1', 'p2'].some(q => after[q].zones.field.some(x => x.iid === u.iid)) ? 'changes sides'
        : 'defeated';
      inline.push(`${poss(p)}${short(u.card_id)} ${to}`);
    }
    // Gear that left a Unit / Legend that's still there
    for (const h of [...B.field, ...B.legends]) {
      const now = [...A.field, ...A.legends].find(x => x.iid === h.iid);
      if (!now) continue;
      for (const g of h.equipped_gear || []) if (!(now.equipped_gear || []).some(x => x.iid === g.iid)) inline.push(`${poss(p)}${short(g.card_id)} (on ${short(h.card_id)}) defeated`);
    }
    // keyword effects put on a Unit this move ("your Johnny Silverhand: can't attack until Bot A's next turn")
    if (!turnChanged) for (const u of A.field) {
      const w = B.field.find(x => x.iid === u.iid);
      const had = new Set(w ? unitKeywords(w).map(k => k.kw) : []);
      for (const k of unitKeywords(u)) {
        if (had.has(k.kw)) continue;
        const until = k.until === 'turn' ? ' this turn' : k.until.pid === s.you ? ' until your next turn' : ` until ${who(k.until.pid)}'s next turn`;
        inline.push(`${poss(p)}${short(u.card_id)}: ${kwText(k.kw)}${until}`);
      }
    }
    // power changed by an effect this move (not at a turn change, when "this turn" boosts end)
    if (!turnChanged) for (const u of A.field) {
      const w = B.field.find(x => x.iid === u.iid);
      if (!w) continue;
      const pw = policy.unitPower(before, p, w), pa = policy.unitPower(after, p, u);
      if (pw !== pa) inline.push(`${poss(p)}${short(u.card_id)}: power ${pw} → ${pa}`);
    }
    // dice rolled in, values changed
    for (const g of A.gigs) {
      const was = bg.get(g.iid);
      if (!was) inline.push(`${p === subj || turnChanged ? '' : `${who(p)} `}rolled d${g.sides} → ${g.value}`.trim());
      else if (was.ctl === p && was.value !== g.value) inline.push(`${dieName(g)}: ${was.value} → ${g.value}`);
    }
    // cards that moved between hidden / known zones
    // from the deck - or from nowhere visible: a card an effect was looking at (River Ward's top 2) has left the deck
    let drawn = A.hand.filter(c => where.get(c.iid) === `${p}:deck` || where.get(c.iid) === undefined);
    const fromTrash = A.hand.filter(c => where.get(c.iid) === `${p}:trash`);
    const milled = A.trash.filter(c => where.get(c.iid) === `${p}:deck`);
    // "Trash 3, then add a Program from your trash to your hand" (V: Streetkid) in one step: the card went
    // deck -> trash -> hand, not drawn. Only when this player's effects milled + recovered and drew nothing.
    const tr = x => trace.some(l => new RegExp(`^T\\d+/\\S+ ${p}/\\S+ ${x}\\b.* ok$`).test(l));
    if (drawn.length && tr('Mill') && tr('RecoverFromTrash') && !tr('Draw')) {
      milled.push(...drawn); fromTrash.push(...drawn);
      recovered.push(...drawn.map(c => ({ pid: p, iid: c.iid }))); drawn = [];
    }
    const discarded = A.trash.filter(c => where.get(c.iid) === `${p}:hand` && !played.has(c.iid));
    if (mulligan && p === subj) inline.push(see(p) ? `draws a new hand: ${list(A.hand)}` : 'draws a new hand');
    else if (drawn.length) {
      const what = see(p) ? list(drawn) : drawn.length === 1 ? 'a card' : `${drawn.length} cards`;
      if (turnChanged && p === after.active_player) start.push(`draws ${what}`);
      else { const item = `${act(p, 'draws', 'draw')} ${what}`; inline.push(item); drawnBy[p] = { names: drawn.map(c => short(c.card_id)), item }; }
    }
    if (milled.length) inline.push(`${act(p, 'trashes', 'trash')} ${list(milled)} from the deck`);
    if (fromTrash.length) inline.push(`${act(p, 'returns', 'return')} ${list(fromTrash)} from the trash to hand`);
    if (discarded.length) inline.push(`${act(p, 'discards', 'discard')} ${list(discarded)}`);
  }
  // a new turn: the turn player readied everything (8.6.3)
  if (turnChanged && after.active_player) {
    const n = after.active_player, Z = before[n].zones;
    const spent = [...Z.field, ...Z.legends, ...Z.eddies].filter(c => c.state === 'spent').length;
    if (spent) start.unshift(`readies ${spent} spent card${spent === 1 ? '' : 's'}`);
  }
  return { inline, start, drawn: drawnBy, recovered };
}

// The engine's trace for one move -> the Draw effects that ran, in order: [{ pid, card, n }]
// (lines look like "T8/trig p2/HEIST-002#55 Draw{n:2} ok")
function traceDraws(lines) {
  const out = [];
  for (const l of lines || []) {
    const m = l.match(/^T\d+\/\S+ (p[12])\/([^#\s]+)\S* Draw(?:\{([^}]*)\})? ok$/);
    if (!m) continue;
    const n = (m[3] || '').match(/(?:^|,)n:(\d+)/);
    out.push({ pid: m[1], card: m[2], n: n ? +n[1] : null });
  }
  return out;
}

// An effect that resolved on a move whose log never names its card gets its own line ("Evelyn Parker:
// readies an Eddie"), so nothing looks like it didn't trigger. scripts/log-audit.js finds the gaps.
const ownCards = (b, p) => [...b[p].zones.field, ...b[p].zones.legends];
const SILENT = {
  Draw: (p, a) => { const n = +((a.match(/n:(\d+)/) || [])[1] || 1); return n ? `draws ${n === 1 ? 'a card' : `${n} cards`}` : null; },
  ReadyEddie: (p, a) => { const n = +((a.match(/n:(\d+)/) || [])[1] || 1); return n ? `readies ${n === 1 ? 'an Eddie' : `${n} Eddies`}` : null; },
  Ready: (p, a, b0, b1) => {
    const was = new Map(ownCards(b0, p).map(c => [c.iid, c.state]));
    const up = ownCards(b1, p).filter(c => was.get(c.iid) === 'spent' && c.state !== 'spent' && c.face !== 'face_down').map(c => short(c.card_id));
    return up.length ? `readies ${up.join(', ')}` : null;
  },
  RivalDiscards: () => 'makes the Rival discard',
  MarkPeeked: () => 'looks at a face-down Legend',
};

function apply(s, seq, entry) {
  s.b._trace = [];   // the engine logs every effect it runs (card + action): used to split the log by source
  const r = policy.tryApply(s.b, s.wf, seq);
  const trace = r?.board._trace || [];
  s.b._trace = null;
  if (!r) return false;
  (s.moves ||= []).push(seq);
  // a sale shows the card (the log names it): the board pops it up before it flies to the Eddies
  const sell = seq.find(x => x.step === 'sell_card');
  if (sell) { const pid = s.b.active_player, h = s.b[pid].zones.hand.find(c => c.iid === sell.iid); if (h) entry.sold = { pid, iid: h.iid, card_id: h.card_id }; }
  // dice in choices: "own d12" / "opponent's d4" from the chooser's side -> whose die it is
  if (entry.who) {
    const mineOr = q => (q === s.you ? 'your' : `${name(s, q)}'s`);
    entry.text = entry.text.replace(/(^|[\s(])own d(\d+)/g, (_, b, n) => `${b}${entry.who === s.you ? 'your' : 'own'} d${n}`)
      .replace(/\bopponent's d(\d+)/g, (_, n) => `${mineOr(entry.who === 'p1' ? 'p2' : 'p1')} d${n}`);
  }
  const subj = entry.who || s.b.active_player;
  const R = results(s, s.b, r.board, seq, subj, trace), res = R.inline;
  if (R.recovered.length) entry.recovered = R.recovered;
  // a roll's result reads "Roll the d6 → 4" rather than "→ rolled d6 → 4"
  const roll = res.findIndex(x => /^rolled d\d+ → /.test(x));
  if (roll >= 0 && /^Roll the d/.test(entry.text)) { entry.text += ` → ${res[roll].split(' → ')[1]}`; res.splice(roll, 1); }
  const flipped = res.find(x => x.startsWith('flips '));
  if (flipped && entry.text.startsWith('Call ' + flipped.slice(6))) res.splice(res.indexOf(flipped), 1);
  // fold a die's change into the choice that caused it:
  //   "increases by 2" + "own d12: 3 → 5"        -> "increases own d12 by 2 (3 → 5)"
  //   "picks own d8 (3) to set" + "own d8: 3 → 1" -> "sets own d8 (3 → 1)"
  const dieCh = res.filter(x => /^(?:.*\s)?d\d+: \d+ → \d+$/.test(x));
  if (dieCh.length === 1) {
    const [, die, from, to] = dieCh[0].match(/^(.*d\d+): (\d+) → (\d+)$/);
    const by = entry.text.match(/(increases|decreases|adjusts) by ([+-]?\d+)$/);
    const pick = entry.text.match(/picks (.*d\d+) \(\d+\) to (\w+)$/);
    if (by) entry.text = entry.text.replace(by[0], `${by[1]} ${die} by ${by[2]} (${from} → ${to})`);
    else if (pick && pick[1] === die) entry.text = entry.text.replace(pick[0], `${pick[2].replace(/y$/, 'ie')}s ${die} (${from} → ${to})`);
    if (by || (pick && pick[1] === die)) res.splice(res.indexOf(dieCh[0]), 1);
  }
  // "picks X's d6 (2)" + "swaps X's d6 (2) with own d4 (1)" / "takes back own d12 (12)": the result says it
  const pickD = entry.text.match(/picks ((?:\S+ )*?d\d+ \(\d+\))$/);
  if (pickD) { const k = res.findIndex(x => /^(swaps|takes|takes back) /.test(x) && x.includes(pickD[1])); if (k >= 0) { entry.text = entry.text.replace(pickD[0], res[k]); res.splice(k, 1); } }
  // "Adam Smasher: Defeat a rival Unit → Pepe Najarro" + "Bot A's Pepe Najarro defeated"
  //   -> "Adam Smasher: Bot A's Pepe Najarro defeated" (the effect's prompt and the pick, said once)
  const picked = entry.text.match(/^((?:[^:→]+: )?)[^→]+ → ([^→]+)$/);
  if (picked && !/^\d+$/.test(picked[2])) {
    const card = picked[2];
    const fate = /^( \(on |: | defeated| removed| put on| returned| shuffled| changes)/;
    const k = res.findIndex(x => [x, x.replace(/^(your |.*?'s )/, '')].some(y => y.startsWith(card) && fate.test(y.slice(card.length))));
    if (k >= 0) { entry.text = picked[1] + res[k]; res.splice(k, 1); }
  }
  const pickT = entry.text.match(/: picks ([^→]+?)(?= →|$)/);
  if (pickT && subj) {
    const c = s.b[subj].zones.trash.find(x => short(x.card_id) === pickT[1]);
    if (c && !r.board[subj].zones.hand.some(h => h.iid === c.iid)) entry.text = entry.text.replace(`: picks ${pickT[1]}`, `: plays ${pickT[1]} from the trash`);
  }
  // "picks X to discard" already says it: drop the matching "discards X"
  const disc = entry.text.match(/picks (.+) to discard$/);
  if (disc) { const k = res.findIndex(x => x === `discards ${disc[1]}`); if (k >= 0) { entry.text = entry.text.replace(disc[0], `discards ${disc[1]}`); res.splice(k, 1); } }
  // draws made by a DIFFERENT card's effect than the one this line is about (a second trigger that
  // resolved in the same engine step, e.g. Dexter DeShawn's "Defeated: draw 2" after River Ward's
  // trash) get their own line: "Dexter DeShawn: draws Adrenaline Converter, Bootleg …"
  const extra = [];
  const lineSrc = (entry.text.match(/^([^:→]+):/) || [])[1];
  for (const pid of ['p1', 'p2']) {
    const d = R.drawn?.[pid];
    const by = traceDraws(trace).filter(x => x.pid === pid);
    if (!d || !by.length || by.every(x => short(x.card) === lineSrc)) continue;
    const k0 = res.indexOf(d.item);
    if (k0 < 0) continue;
    res.splice(k0, 1);
    const see = s.mode === 'watch' || pid === s.you;
    let k = 0;
    by.forEach((x, j) => {
      const part = d.names.slice(k, j === by.length - 1 ? undefined : k + (x.n ?? 1));
      k += part.length;
      if (!part.length) return;
      const txt = see ? `draws ${part.join(', ')}` : `draws ${part.length === 1 ? 'a card' : `${part.length} cards`}`;
      if (short(x.card) === lineSrc) res.push(txt);
      else extra.push({ who: pid, text: `${short(x.card)}: ${txt}` });
    });
  }
  if (res.length) entry.text += ` → ${res.join(' · ')}`;
  // a search of the top of the deck that found nothing resolves without a prompt - say so, or it looks
  // like the ability never triggered (Sketchy Ripper with no Gear in the top 3)
  for (const l of trace) {
    const m = l.match(/^T\d+\/trig (p[12])\/([^#\s]+)\S* SearchTopN\{n:(\d+)[^}]*\} ok$/);
    if (!m) continue;
    const js = JSON.stringify(SCRIPTS[m[2]] || {}), kind = js.match(/"filter":\{"type":"(\w+)"/);
    const rest = /"trash_remainder":true/.test(js) ? 'trashes them' : 'puts them on the bottom of the deck';
    extra.push({ who: m[1], text: `${short(m[2])}: searches the top ${m[3]} - no ${kind ? kind[1] : 'match'} found, ${rest}` });
  }
  if (s.wf.step === 'main_phase' || s.wf.step === 'defensive_step') s.lastSrc = null;
  const flip = res.find(x => x.startsWith('flips ')) || flipped;
  if (flip) s.lastSrc = flip.slice(6);   // the Called Legend's prompts that follow belong to it
  // effects nobody's line names yet (start-of-turn ones go under the new turn's start line)
  const said = [entry.text, ...extra.map(x => x.text), ...(R.start || [])].join(' | ');
  const silent = [];
  for (const l of trace) {
    const m = l.match(/^T(\d+)\/trig (p[12])\/([^#\s]+)\S* (\w+)(\{[^}]*\})? ok$/);
    if (!m || !SILENT[m[4]]) continue;
    const nm = short(m[3]);
    if (said.includes(nm) || silent.some(x => x.text.startsWith(nm + ':'))) continue;
    const phrase = SILENT[m[4]](m[2], m[5] || '', s.b, r.board);
    if (phrase) silent.push({ who: m[2], text: `${nm}: ${phrase}`, turn: +m[1] });
  }
  entry.active = s.b.active_player;   // whose turn the move was made in (end turn flips it)
  s.b = r.board; s.wf = r.waitingFor; s.b._trace = null;
  if (s.b.winner || !s.wf) s.over = true;
  const logFrom = s.rlog.length;
  record(s, entry);
  for (const x of extra) record(s, { turn: entry.turn, who: x.who, kind: 'info', text: x.text, active: entry.active });
  const startTurn = s.b.turn_number !== entry.turn ? s.b.turn_number : null;
  for (const x of silent.filter(x => x.turn !== startTurn)) record(s, { turn: entry.turn, who: x.who, kind: 'info', text: x.text, active: entry.active });
  if (s.audit) s.audit.push({ trace, from: logFrom });   // scripts/log-audit.js
  // the next turn's start phase (ready, draw) as its own line, under the new turn
  if (R.start.length && !s.over) record(s, { turn: s.b.turn_number, who: s.b.active_player, kind: 'info', text: `Turn ${s.b.turn_number} starts: ${R.start.join(' · ')}`, active: s.b.active_player });
  if (!s.over) for (const x of silent.filter(x => x.turn === startTurn)) record(s, { turn: s.b.turn_number, who: x.who, kind: 'info', text: x.text, active: s.b.active_player });
  if (s.over) record(s, { turn: s.b.turn_number, kind: 'info', text: s.b.winner ? `${name(s, s.b.winner)} won.` : 'Game ended.' });
  return true;
}

// one board step (the position AFTER `entry`'s move) in the replay board's format, plus its log line
function record(s, entry) {
  s.log.push(entry);
  const viewer = s.mode === 'watch' ? 'p1' : s.you;
  const state = simState(s.b, viewer, s.labels, s.mode === 'watch' || s.over, s.over);
  // cards that went deck -> trash -> hand in this step: the board shows them trashed first, then returned
  if (entry.recovered) state.game.recovered = entry.recovered.map(x => x.iid);
  if (entry.sold) state.game.sold = { player: PID[entry.sold.pid], id: entry.sold.iid, cardId: artId(entry.sold.card_id), name: BY.get(entry.sold.card_id)?.name || entry.sold.card_id };
  const i = s.steps.length;
  const turnOf = entry.active || s.b.active_player;
  const who = entry.who ? `${s.labels[entry.who]}: ` : '';
  // the line names its actor itself, so tag it with the actor (app.js adds a name only for other players)
  const line = { id: `l${i}`, message: `${who}${entry.text}`, turnNumber: entry.turn, turnOwnerPlayerId: PID[entry.who || turnOf], turnOwnerLabel: s.labels[turnOf], step: i };
  s.steps.push({ state, action: { label: line.message }, newLog: [line], turn: s.b.turn_number, think: entry.kind === 'bot' ? entry : null, mv: (s.moves || []).length, who: entry.who || null });
  s.rlog.push(line);
}

// the human never has to click through a decision with exactly one option that isn't a real choice
function autoForced(s) {
  for (let i = 0; i < 50 && !s.over && s.wf && owner(s) === s.you; i++) {
    const o = options(s);
    if (o.length !== 1 || s.wf.step === 'main_phase') return;
    if (s.wf.choice_needed?.available_iids?.length) return;   // a target pick is yours to click, even with one option
    apply(s, o[0], { turn: s.b.turn_number, who: s.you, kind: 'forced', text: describe(s.b, s.you, o[0], cnOf(s)) });
  }
}

function move(id, i, pay) {
  const s = SESSIONS.get(id);
  if (!s || s.over || owner(s) !== s.you) return { error: 'not your decision' };
  const o = humanOptions(s)[+i];
  if (!o) return { error: 'no such option' };
  let iids = o.defaultPay;
  if (o.n && Array.isArray(pay)) {
    const okIds = new Set(o.payables.map(x => x.iid));
    if (pay.length !== o.n || new Set(pay).size !== o.n || pay.some(x => !okIds.has(x))) return { error: `pick exactly ${o.n} to pay` };
    iids = pay;
  }
  const seq = build(o, iids);
  const text = o.text || describe(s.b, s.you, seq, cnOf(s));
  // undo: the game as it was before this decision of yours (bot moves after it are undone with it)
  (s.undo ||= []).push({ b: cloneBoard(s.b), wf: JSON.parse(JSON.stringify(s.wf)), log: s.log.length, steps: s.steps.length,
    rlog: s.rlog.length, lastSrc: s.lastSrc, over: s.over, moves: (s.moves || []).length });
  if (s.undo.length > 200) s.undo.shift();
  if (!apply(s, seq, { turn: s.b.turn_number, who: s.you, kind: 'you', text, onTurn: s.b.active_player === s.you })) return { error: 'engine refused the move' };
  autoForced(s);
  return { ok: true };
}

// The line for a bot's effect choice when you may not see what it picked (play mode): the cards it
// looked at on top of its deck, or chose from its hand / deck, aren't named. null = say it normally.
function privateText(s, p, b, seq, cn) {
  if (s.mode === 'watch' || p === s.you) return null;
  const a = seq[seq.length - 1];
  if (a.step !== 'effect_choice_response' || !cn) return null;
  const hidden = new Set([...b[p].zones.hand, ...b[p].zones.deck].map(c => c.iid));
  const ids = a.response?.selected_iids || (a.response?.iid ? [a.response.iid] : []);
  const src = cn.source_card_id ? short(cn.source_card_id) : cn._src;
  const pre = src ? `${src}: ` : '';
  if (cn.kind === 'choose_from_top_n' && /trash|bottom/i.test(cn.prompt || '')) return null;   // trashed / bottom-decked cards are public
  if (cn.kind === 'choose_from_top_n') return `${pre}looks at the top ${(cn.available_refs || []).length} of the deck, takes ${ids.length === 1 ? 'a card' : `${ids.length} cards`}`;
  if (ids.some(i => hidden.has(i))) return `${pre}picks ${ids.length === 1 ? 'a card' : `${ids.length} cards`} you can't see`;
  return null;
}

// take back your last decision (play mode): everything after it - bot moves included - is gone
function undo(id) {
  const s = SESSIONS.get(id);
  if (!s || s.mode !== 'play') return { error: 'no game' };
  const u = s.undo?.pop();
  if (!u) return { error: 'nothing to undo' };
  s.b = u.b; s.wf = u.wf; s.lastSrc = u.lastSrc; s.over = u.over;
  s.log.length = u.log; s.steps.length = u.steps; if (s.moves) s.moves.length = u.moves;
  for (const k of Object.keys(s.flags || {})) if (+k >= u.steps) delete s.flags[k]; s.rlog = s.rlog.filter(l => l.step < u.steps);
  return { ok: true, total: s.steps.length };
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
  // keep / mulligan: the hand-quality rule every bot uses (src/bot/mulligan.js), with its reasons
  let mull = null;
  if (s.wf.step === 'mulligan_decision' && !/greedy$|mull=old/.test(B.spec)) {
    mull = require('./mulligan').decide(s.b, s.wf, ctx.rng);
    seq = [{ step: 'mulligan', mulligan: mull.mulligan }];
  } else try { seq = B.bot.act(botView(s.b, p, ctx.rng), s.wf, p, ctx); } catch (e) { s.log.push({ turn: s.b.turn_number, kind: 'info', text: `${name(s, p)} error: ${e.message}` }); }
  const ms = Date.now() - t;
  if (!seq || !policy.tryApply(s.b, s.wf, seq)) { const o = options(s); seq = o[0]; }
  if (!seq) { s.over = true; return { error: 'stuck' }; }
  const entry = { turn: s.b.turn_number, who: p, kind: 'bot', text: privateText(s, p, before, seq, prompt) || describe(before, p, seq, prompt), ms, step: step_, onTurn: s.b.active_player === p };
  const L = ctx.lastSearch || (ctx.last ? { options: ctx.last } : null);
  if (L?.options?.length > 1) {
    const sl = L.shortlist ? new Set(L.shortlist) : null;
    entry.considered = L.options.map(o => ({ text: describe(before, p, o.seq, prompt), pct: Math.round(1000 * o.value) / 10, chosen: o.seq === seq,
      explored: sl ? !sl.has(o.seq) && o.seq[o.seq.length - 1].step !== 'end_turn' : false }));
    if (L.ranked) entry.notSearched = L.ranked.length - L.options.length;
  }
  if (mull) entry.note = `Hand score ${mull.score.toFixed(1)} (going ${mull.first ? 'first' : 'second'}); a fresh 6 from this deck averages ${mull.mean.toFixed(1)}, and the bottom quarter scores under ${mull.cut.toFixed(1)}. ${mull.mulligan ? 'Clearly weak, so it redraws.' : 'Good enough to keep - a redraw is a gamble.'}`;
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
    v.decision = { step: s.wf.step, prompt: s.wf.choice_needed?.prompt || null,
      options: humanOptions(s).map((o, i) => ({ i, text: o.text, group: o.group || null, pay: o.n, payables: o.payables, defaultPay: o.defaultPay })) };
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
    from, steps: s.steps.slice(from).map(st => (st.think && s.mode === 'play' && !s.over ? { ...st, think: { ...st.think, considered: null, notSearched: null, note: null, hidden: true } } : st)),
    log: s.rlog.filter(l => l.step >= from), total: s.steps.length,
    mode: s.mode, you: s.you ? PID[s.you] : null, over: s.over, winner: s.b.winner ? PID[s.b.winner] : null,
    toAct: v.toAct ? PID[v.toAct] : null, botToAct: v.botToAct, bots: Object.fromEntries(Object.entries(v.bots).map(([k, x]) => [PID[k], x])),
    decision: v.decision || null, attack: v.attack || null, seed: s.seed,
  };
}

// Game Review (src/coach/review-service.js): from an engine position in `pid`'s turn, play `first`
// (the better move), then let Bot A finish the turn - recorded as board steps + log lines like a live
// game, seen by `pid` (the Rival's hand stays hidden). Stops before ending the turn.
function branch(b, wf, pid, first, labels, maxMoves = 16) {
  const rv = pid === 'p1' ? 'p2' : 'p1';
  const B = BOTS[0];
  const s = { id: 'review', mode: 'play', you: pid, names: labels, labels, seed: 0, first: b.first_player, bots: { [rv]: { ...B, bot: makeBot('greedyt') } },
    ctx: { [pid]: { rng: mulberry(7) }, [rv]: { rng: mulberry(8) } }, log: [], over: false, steps: [], rlog: [], b, wf };
  const me = makeBot(B.spec), turn = b.turn_number;
  const startTurn = s.steps.length;
  s.steps.push({ state: simState(b, pid, labels), action: { label: 'start' }, newLog: [], turn });
  if (!apply(s, first, { turn, who: pid, kind: 'best', text: describe(b, pid, first, cnOf(s)) })) return { steps: [], log: [] };
  let n = 1;
  for (let i = 0; i < 60 && !s.over && s.wf && s.b.turn_number === turn; i++) {
    const p = owner(s), before = s.b, prompt = cnOf(s);
    let seq = null;
    try { seq = (p === pid ? me : s.bots[rv].bot).act(botView(s.b, p, s.ctx[p].rng), s.wf, p, s.ctx[p]); } catch { seq = null; }
    if (!seq || !policy.tryApply(s.b, s.wf, seq)) seq = options(s)[0];
    if (!seq) break;
    const isMain = s.wf.step === 'main_phase' && p === pid;
    if (isMain && seq[seq.length - 1].step === 'end_turn') break;
    if (isMain && ++n > maxMoves) break;
    apply(s, seq, { turn, who: p, kind: p === pid ? 'plan' : 'bot', text: describe(before, p, seq, prompt) });
  }
  return { steps: s.steps.slice(startTurn + 1), log: s.rlog };
}

// ---- flags: you mark a log line as a bot misplay or a good play (board/play.html ⚑); saved for later review ----
// notes/bot-flags/flags.jsonl, one record per flag: the game (seed, decks, bots, first player, every move so
// far - enough to rebuild any position with scripts/flags.js), the flagged line, its step and turn, the move
// count before it (mvBefore: replay that many moves to stand just before it), what the bot compared, your tags + note.
// Removing a flag appends { remove: id }.
const FLAG_FILE = path.join(__dirname, '..', '..', 'notes', 'bot-flags', 'flags.jsonl');
// three groups: a bot misplay (what was wrong), a good play (what made it good) or a UI issue (the board/log
// showed something wrong), each with a grade + reasons.
// Older records have no kind: they are misplays (their grade was one of the tags).
const FLAG_KINDS = {
  misplay: { label: 'Misplay', grades: ['Inaccuracy', 'Mistake', 'Blunder'],
    tags: ['Wrong order', 'Missed play', 'Bad attack', 'Bad block', 'Wrong target', 'Wasted card', 'Bad payment', 'Too passive', 'Overextended', 'Rules bug', 'Log text'],
    ask: 'What was wrong? What should it have done?' },
  good: { label: 'Good play', grades: ['Good', 'Great', 'Brilliant'],
    tags: ['Good order', 'Good attack', 'Good block', 'Good target', 'Good timing', 'Efficient payment', 'Saved a card', 'Set up next turn', 'Read the Rival', 'Found a combo', 'Took the Gig race'],
    ask: 'What made it good?' },
  ui: { label: 'UI issue', grades: ['Minor', 'Confusing', 'Broken'],
    tags: ['Wrong text', 'Log wording', 'Wrong card shown', 'Missing info', 'Wrong highlight', 'Layout / overlap', 'Animation', 'Hover / tooltip', 'Controls', 'Sound'],
    ask: 'What looks wrong? What did you expect?' },
};
const FLAG_TAGS = [...new Set(Object.values(FLAG_KINDS).flatMap(k => [...k.grades, ...k.tags]))];
function flag(id, body) {
  const s = SESSIONS.get(id);
  if (!s) return { error: 'no game' };
  const st = s.steps[+body.step];
  if (!st) return { error: 'no such line' };
  s.flags ||= {};
  if (body.remove) {
    const f = s.flags[body.step];
    if (!f) return { error: 'not flagged' };
    delete s.flags[body.step];
    fs.appendFileSync(FLAG_FILE, JSON.stringify({ remove: f.id, at: new Date().toISOString() }) + '\n');
    return { ok: true, flags: s.flags };
  }
  const kind = FLAG_KINDS[body.kind] ? body.kind : 'misplay', K = FLAG_KINDS[kind];
  const grade = K.grades.includes(body.grade) ? body.grade : K.grades[1];
  const tags = (Array.isArray(body.tags) ? body.tags : []).filter(t => K.tags.includes(t));
  const note = String(body.note || '').slice(0, 2000);
  // the move that produced this line: lines after a move share its count, so step back to the first line of it
  let first = +body.step;
  while (first > 0 && s.steps[first - 1].mv === st.mv) first--;
  const f = { id: `${s.seed}-${body.step}-${Date.now()}`, at: new Date().toISOString(), kind, grade, tags, note,
    step: +body.step, turn: st.newLog[0].turnNumber, line: st.newLog[0].message, who: st.who, whoName: st.who ? s.labels[st.who] : null,
    mvBefore: Math.max(0, st.mv - 1), firstLineOfMove: s.steps[first].newLog[0].message,
    think: s.steps[first].think ? { considered: s.steps[first].think.considered || null, notSearched: s.steps[first].think.notSearched ?? null, belief: s.steps[first].think.belief || null, note: s.steps[first].think.note || null } : null,
    game: { seed: s.seed, first: s.first, you: s.you, mode: s.mode,
      decks: { p1: s.decks.p1.file, p2: s.decks.p2.file }, deckLabels: { p1: s.decks.p1.label, p2: s.decks.p2.label },
      bots: Object.fromEntries(Object.entries(s.bots).map(([q, B]) => [q, { id: B.id, name: B.name, spec: B.spec }])) },
    moves: s.moves || [] };
  s.flags[body.step] = { id: f.id, kind, grade, tags, note };
  fs.mkdirSync(path.dirname(FLAG_FILE), { recursive: true });
  fs.appendFileSync(FLAG_FILE, JSON.stringify(f) + '\n');
  return { ok: true, flags: s.flags };
}
// rebuild a flagged game's engine position after its first n moves (scripts/flags.js) -> { b, wf }
function rebuild(game, n) {
  const deckOf = f => resolveDeck(f, () => 0).deck;
  let r = step(setupGame(deckOf(game.decks.p1), deckOf(game.decks.p2), game.first, { seed: game.seed }), undefined);
  for (const seq of game.moves.slice(0, n)) { r = policy.tryApply(r.board, r.waitingFor, seq); if (!r) return null; }
  return { b: r.board, wf: r.waitingFor };
}
const flagsOf = id => ({ kinds: FLAG_KINDS, flags: SESSIONS.get(id)?.flags || {} });

// n community lists for the new-game menu (popular ones more often: weight sqrt(1 + likes)), excluding `skip` files
function community(n = 8, skip = []) {
  const no = new Set(skip), pool = netDecks().filter(d => !no.has(d.file)), out = [];
  const w = pool.map(d => Math.sqrt(1 + (d.likes || 0)));
  for (let k = 0; k < n && pool.length; k++) {
    let u = Math.random() * w.reduce((a, b) => a + b, 0), i = 0;
    while (i < pool.length - 1 && (u -= w[i]) > 0) i++;
    const d = pool.splice(i, 1)[0]; w.splice(i, 1);
    out.push({ file: d.file, title: d.title, legends: d.legends, colors: d.colors, tag: d.tag, likes: d.likes || 0 });
  }
  return out;
}

module.exports = { community, flag, flagsOf, rebuild, FLAG_FILE, FLAG_TAGS, FLAG_KINDS, branch, config, create, view, poll, move, advance, undo, BOTS, _sessions: SESSIONS };   // _sessions: debugging only
