// Readable logs of games in the policy dataset, to check what the nets learn from.
//   node scripts/data-log.js [data.jsonl] [--games N | --g ID,ID] [--bot spec] [--out file]
// Re-plays recorded games with the same seed, decks and bot (default: the settings
// scripts/policy-data.js used - round 1 = strong:deals=4:k=5:explore=2, round 2 adds :prior=mix)
// and checks every decision against the dataset (same moves offered, same move chosen). Writes a
// plain-text log and an HTML version (same name, .html): each turn's board, then every decision -
// the move chosen with its estimated win chance, the alternatives compared, and tags (found by
// exploring / all about equal / looks decided / exact tie).
'use strict';
const fs = require('fs');
const path = require('path');
const { setupGame, step } = require('../src/engine');
const { loadDecks, TRAIN_DIRS } = require('../src/bot/arena');
const { tryApply, nm } = require('../src/coach/policy');
const { mulberry } = require('../src/coach/bridge');
const { makeBot } = require('../src/bot/bots');
const { describePlan } = require('../src/coach/search');
const { encodeMove } = require('../src/bot/menc');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = args.find(a => a.endsWith('.jsonl')) || path.join(__dirname, '..', 'notes', 'policy-data.jsonl');
const r2 = /r2/.test(path.basename(file));
const spec = flag('--bot', r2 ? 'strong:deals=4:k=5:explore=2:prior=mix' : 'strong:deals=4:k=5:explore=2');
const out = flag('--out', path.join(__dirname, '..', 'notes', `data-log-${path.basename(file, '.jsonl')}.txt`));
const want = flag('--g', null)?.split(',').map(Number);
const nGames = +flag('--games', 3);

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const games = want ? lines.map(l => JSON.parse(l)).filter(o => want.includes(o.g))
  : lines.slice(0, nGames).map(l => JSON.parse(l));
// round 1 was generated before the coverage decks existed (real lists only); round 2 uses all
const decks = r2 || args.includes('--train-decks') ? loadDecks(TRAIN_DIRS) : loadDecks();

const short = n => n.replace(/\.txt$/, '').replace(/^choombattler-/, '');
const cardName = s => s.replace(/: [^,;]+?(?= on | with |,|;|$| during)/g, '');   // drop subtitles
// Legend "call" prompts read "X: do <effect>? (No = draw 1)" - say what each answer actually does
const yesNo = (a, prompt) => {
  if (!prompt || a.step !== 'effect_choice_response' || typeof a.response?.accept !== 'boolean') return null;
  const m = prompt.match(/^(?:[^:]+:\s*)?(.*?)\??\s*(?:\(No = ([^)]+)\))?$/);
  const effect = cardName(m ? m[1] : prompt), alt = m && m[2];
  if (a.response.accept) return `Yes: ${effect}`;
  return alt ? `${alt[0].toUpperCase()}${alt.slice(1)} (instead of: ${effect})` : `No (skip: ${effect})`;
};
const words = (b, pid, seq, prompt) => {
  const a = seq[seq.length - 1];
  const yn = yesNo(a, prompt);
  if (yn) return yn;
  const w = describePlan([{ owner: pid, seq, before: b, prompt: null }], pid).map(s => s.trim()).join('; ');
  if (w) return cardName(w.replace(/^pick /, 'Pick ').replace(/^use the optional effect/, 'Yes, use the effect').replace(/^skip the optional effect/, 'No, skip the effect'));
  return { end_turn: 'End turn', pass_defensive: "Don't block", pass_attacker_interrupt: 'No interrupt', mulligan: a.mulligan ? 'Mulligan' : 'Keep hand',
    choose_gig_die: `Roll the d${a.sides}` }[a.step] || (a.response?.acknowledge ? 'OK' : a.step);
};
const legendTeam = d => d.legends.map(n => nm(n).split(':')[0].split(' ')[0]).join('/');
const boardOf = (b, pid) => {
  const Z = b[pid].zones, up = Z.legends.filter(l => l.face === 'face_up');
  return {
    gigs: Z.gigs.length, gigVals: Z.gigs.map(g => g.value), hand: Z.hand.length, eddies: Z.eddies.length, deck: Z.deck.length,
    legends: up.map(l => nm(l.card_id).split(':')[0]), hidden: Z.legends.length - up.length,
    field: Z.field.map(u => ({ name: nm(u.card_id).split(':')[0], spent: u.state === 'spent', gear: (u.equipped_gear || []).map(g => nm(g.card_id).split(':')[0]) })),
  };
};
const PROMPT = { choose_gig_die: 'Which Gig die to roll', main_phase: 'Main phase', defensive_step: 'Block?', attacker_interrupt_step: 'Interrupt?',
  choose_gig_to_steal: 'Which Gig to steal', mulligan_decision: 'Mulligan?', effect_choice: 'Effect choice' };

// ---- replay, collecting a structured log ----
const LOG = [];
let checked = 0, mismatch = 0, explWins = 0, decided = 0, flat = 0;
const t0 = Date.now();
for (const G of games) {
  const g = G.g, r = mulberry(g * 13 + 5);
  const d1 = decks[Math.floor(r() * decks.length)], d2 = decks[Math.floor(r() * decks.length)];
  const first = r() < 0.5 ? 'p1' : 'p2';
  let res = step(setupGame(d1, d2, first, { seed: g }), undefined);
  let b = res.board, wf = res.waitingFor; b._trace = null;
  const bot = makeBot(spec);
  const ctx = { p1: { rng: mulberry(g * 2 + 1) }, p2: { rng: mulberry(g * 2 + 2) } };
  const game = { g, names: { p1: legendTeam(d1), p2: legendTeam(d2) }, decks: { p1: short(d1.name), p2: short(d2.name) }, first, turns: [], datasetWinner: G.winner };
  let ri = 0, T = null;
  for (let i = 0; i < 6000 && wf && !b.winner; i++) {
    const pid = wf.owner || b.active_player;
    if (!T || T.n !== b.turn_number) {
      T = { n: b.turn_number, active: b.active_player, board: { p1: boardOf(b, 'p1'), p2: boardOf(b, 'p2') }, ev: [] };
      game.turns.push(T);
    }
    ctx[pid].lastSearch = null;
    const seq = bot.act(b, wf, pid, ctx[pid]);
    const L = ctx[pid].lastSearch;
    const offTurn = pid !== b.active_player;
    if (L && L.ranked.length >= 2 && L.options.length) {
      const rec = G.recs[ri++];
      const pick = L.ranked.indexOf(seq);
      const same = !!rec && rec.c.length === L.ranked.length && rec.pick === pick
        && JSON.stringify(rec.c[pick][0]) === JSON.stringify(encodeMove(b, pid, seq));
      checked++; if (!same) mismatch++;
      const sl = new Set(L.shortlist);
      const opts = L.options.map(o => ({ text: words(b, pid, o.seq, wf.choice_needed?.prompt), pct: 100 * o.value, g: L.ranked.indexOf(o.seq) + 1,
        explored: !sl.has(o.seq) && o.seq[o.seq.length - 1].step !== 'end_turn', chosen: o.seq === seq }));
      const vals = opts.map(o => o.pct), best = Math.max(...vals), spread = best - Math.min(...vals);
      const ch = opts.find(o => o.chosen);
      const e = { who: pid, offTurn, kind: 'choice', what: PROMPT[wf.step] || wf.step, prompt: cardName(wf.choice_needed?.prompt || ''), opts,
        untried: L.ranked.length - opts.length, chosen: ch.text, pct: ch.pct, flat: spread < 0.5, decided: best > 95 || best < 5,
        explored: ch.explored, tie: opts.length > 1 && Math.abs(opts[0].pct - opts[1].pct) < 1e-7, matches: same };
      if (e.explored) explWins++; if (e.decided) decided++; if (e.flat) flat++;
      T.ev.push(e);
    } else if (seq) {
      const w = words(b, pid, seq);
      if (w && w !== 'OK' && w !== 'tap_resource') T.ev.push({ who: pid, offTurn, kind: 'forced', chosen: w });
    }
    const nx = seq && tryApply(b, wf, seq);
    if (!nx) break;
    b = nx.board; wf = nx.waitingFor; b._trace = null;
  }
  game.winner = b.winner; game.lastTurn = b.turn_number; game.matched = `${ri}/${G.recs.length}`;
  LOG.push(game);
  console.log(`game ${g} done (${Math.round((Date.now() - t0) / 1000)}s)`);
}
const summary = `${checked} decisions replayed, ${mismatch} differ from the dataset. ${decided} were in a game that already looked decided (best move <5% or >95%), ${flat} had every option within 0.5% of each other, and in ${explWins} the bot played a move only exploration found.`;

// ---- plain text ----
const pc = x => `${x.toFixed(1)}%`;
const who = (game, p) => `${p.toUpperCase()} ${game.names[p]}`;
const boardTxt = (game, p, B) => `${who(game, p).padEnd(26)} Gigs ${B.gigs}${B.gigs ? ' [' + B.gigVals.join(' ') + ']' : ''} | hand ${B.hand} | Eddies ${B.eddies} | deck ${B.deck}\n${' '.repeat(29)}Legends: ${[...B.legends, ...(B.hidden ? [`${B.hidden} hidden`] : [])].join(', ')} | Field: ${B.field.map(u => u.name + (u.gear.length ? ' +' + u.gear.join(' +') : '') + (u.spent ? ' (spent)' : '')).join(', ') || 'empty'}`;
const tagsOf = e => [e.explored && 'found by exploring', e.flat && 'all about equal', e.decided && 'looks decided', e.tie && !e.flat && 'exact tie', !e.matches && 'DIFFERS FROM DATASET'].filter(Boolean);
const TX = [
  'HOW TO READ THIS',
  'Each turn shows both boards, then every decision in order.',
  '  >> a move the bot chose after searching, with its estimated chance to win the game from there',
  '     (always from the point of view of the player deciding). "also tried" = other moves it compared.',
  '  .. a move with only one option.',
  'Tags: [found by exploring] outside greedy\'s shortlist   [all about equal] every option within 0.5%',
  '      [looks decided] best move <5% or >95% - little to learn here   [exact tie] two moves scored the same',
  '', `Data check: ${summary}`, `Bot: ${spec}`, ''];
for (const game of LOG) {
  TX.push('='.repeat(100), `GAME ${game.g}: ${who(game, 'p1')} (${game.decks.p1})  vs  ${who(game, 'p2')} (${game.decks.p2})`,
    `${game.first.toUpperCase()} goes first. Winner: ${game.winner ? who(game, game.winner) : 'none'} after ${game.lastTurn} turns.`, '='.repeat(100));
  for (const T of game.turns) {
    TX.push('', `TURN ${T.n} - ${who(game, T.active)} to play`);
    for (const p of ['p1', 'p2']) TX.push(`  ${boardTxt(game, p, T.board[p])}`);
    for (const e of T.ev) {
      const by = e.offTurn ? `${e.who.toUpperCase()} (on the other player's turn): ` : (e.who !== T.active ? `${e.who.toUpperCase()}: ` : '');
      if (e.kind === 'forced') { TX.push(`  .. ${by}${e.chosen}`); continue; }
      const tags = tagsOf(e);
      TX.push(`  >> ${by}${e.chosen}  ${pc(e.pct)}${e.prompt ? `   (${e.prompt})` : ''}${tags.length ? '   [' + tags.join('] [') + ']' : ''}`);
      const others = e.opts.filter(o => !o.chosen), alts = others.slice(0, 3).map(o => `${o.text} ${pc(o.pct)}`);
      if (alts.length) TX.push(`       also tried: ${alts.join('  |  ')}${others.length > 3 ? `  | +${others.length - 3} more` : ''}${e.untried ? `   (${e.untried} not searched)` : ''}`);
    }
  }
  TX.push('', `RESULT: ${game.winner ? who(game, game.winner) + ' wins' : 'no winner'} (dataset: ${game.datasetWinner}); ${game.matched} recorded decisions replayed`, '');
}
fs.writeFileSync(out, TX.join('\n') + '\n');

// ---- HTML ----
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const htmlOut = out.replace(/\.txt$/, '') + '.html';
const bar = x => `<span class="bar"><span style="width:${Math.max(1, Math.min(100, x)).toFixed(1)}%"></span></span>`;
const TAGC = { 'found by exploring': 'explore', 'all about equal': 'flat', 'looks decided': 'decided', 'exact tie': 'tie', 'DIFFERS FROM DATASET': 'bad' };
const boardH = (game, p, B) => `<div class="side ${p}"><b class="${p}">${p.toUpperCase()} ${esc(game.names[p])}</b>
  <span class="stat">Gigs <b>${B.gigs}</b>${B.gigs ? ' <small>[' + B.gigVals.join(' ') + ']</small>' : ''}</span><span class="stat">hand <b>${B.hand}</b></span><span class="stat">Eddies <b>${B.eddies}</b></span><span class="stat">deck ${B.deck}</span>
  <div class="row">Legends: ${[...B.legends.map(esc), ...(B.hidden ? [`<i>${B.hidden} hidden</i>`] : [])].join(', ')}</div>
  <div class="row">Field: ${B.field.map(u => `<span class="unit${u.spent ? ' spent' : ''}">${esc(u.name)}${u.gear.length ? ' <small>+' + u.gear.map(esc).join(' +') + '</small>' : ''}</span>`).join(' ') || '<i>empty</i>'}</div></div>`;
const H = [];
for (const game of LOG) {
  H.push(`<section class="game"><h2>Game ${game.g}: <span class="p1">P1 ${esc(game.names.p1)}</span> vs <span class="p2">P2 ${esc(game.names.p2)}</span></h2>
  <p class="meta">${esc(game.decks.p1)} vs ${esc(game.decks.p2)} · ${game.first.toUpperCase()} goes first · <b>Winner: ${game.winner ? esc(who(game, game.winner)) : 'none'}</b> after ${game.lastTurn} turns</p>`);
  for (const T of game.turns) {
    H.push(`<details class="turn ${T.active}" open><summary>Turn ${T.n} · <span class="${T.active}">${esc(who(game, T.active))}</span> to play</summary><div class="board">${boardH(game, 'p1', T.board.p1)}${boardH(game, 'p2', T.board.p2)}</div><ol>`);
    for (const e of T.ev) {
      const by = e.who !== T.active || e.offTurn ? `<span class="${e.who}">${e.who.toUpperCase()}</span> ` : '';
      if (e.kind === 'forced') { H.push(`<li class="forced">${by}${esc(e.chosen)}</li>`); continue; }
      const tags = tagsOf(e).map(t => `<span class="tag ${TAGC[t]}">${t}</span>`).join(' ');
      const n = e.opts.length - 1;
      H.push(`<li class="choice"><div class="pick">${by}<b>${esc(e.chosen)}</b> ${bar(e.pct)} <span class="pct">${pc(e.pct)}</span> ${tags}</div>
        ${e.prompt ? `<div class="prompt">${esc(e.prompt)}</div>` : ''}
        <details class="alts"><summary>${n} other move${n === 1 ? '' : 's'} compared${e.untried ? ` · ${e.untried} not searched` : ''}</summary><table>${e.opts.map(o => `<tr class="${o.chosen ? 'chosen' : ''}"><td>${o.chosen ? '▶' : ''}</td><td>${esc(o.text)}${o.explored ? ' <span class="tag explore">explored</span>' : ''}</td><td>${bar(o.pct)}</td><td class="pct">${pc(o.pct)}</td><td class="g">greedy #${o.g}</td></tr>`).join('')}</table></details></li>`);
    }
    H.push(`</ol></details>`);
  }
  H.push(`<p class="result">Result: <b>${game.winner ? esc(who(game, game.winner)) + ' wins' : 'no winner'}</b> · dataset says ${game.datasetWinner} · ${game.matched} recorded decisions replayed</p></section>`);
}
fs.writeFileSync(htmlOut, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot training games</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e4e2dc;--p1:#1f6feb;--p2:#c2410c;--barbg:#ecebe6;--bar:#4b8f5c;--tag:#f1efe9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141414;--fg:#e9e7e2;--mut:#9a978f;--card:#1d1d1c;--line:#33322f;--p1:#6ea8ff;--p2:#fb923c;--barbg:#2c2b28;--bar:#6fbf86;--tag:#2a2926}}
:root[data-theme="dark"]{--bg:#141414;--fg:#e9e7e2;--mut:#9a978f;--card:#1d1d1c;--line:#33322f;--p1:#6ea8ff;--p2:#fb923c;--barbg:#2c2b28;--bar:#6fbf86;--tag:#2a2926}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}h2{font-size:18px;margin:28px 0 4px}.meta,.result{color:var(--mut);margin:4px 0 12px}
.help{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px}
.p1{color:var(--p1)}.p2{color:var(--p2)}
.turn{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;margin:10px 0;padding:6px 12px}
.turn.p1{border-left-color:var(--p1)}.turn.p2{border-left-color:var(--p2)}
.turn>summary{cursor:pointer;font-weight:600;padding:4px 0}
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:8px;margin:6px 0}
.side{font-size:13px;background:var(--bg);border-radius:8px;padding:6px 8px}
.stat{margin-left:10px;color:var(--mut)}.stat b{color:var(--fg)}.row{color:var(--mut)}
.unit{display:inline-block;background:var(--tag);border-radius:5px;padding:0 5px;margin:1px;color:var(--fg)}.unit.spent{opacity:.55;font-style:italic}
ol{margin:6px 0;padding-left:22px}li{margin:6px 0}li.forced{color:var(--mut);font-size:14px}
.bar{display:inline-block;width:80px;height:7px;background:var(--barbg);border-radius:4px;vertical-align:middle;overflow:hidden}.bar span{display:block;height:100%;background:var(--bar)}
.pct{font-variant-numeric:tabular-nums;color:var(--mut);font-size:13px}.prompt{color:var(--mut);font-size:13px}
.tag{font-size:11px;border-radius:9px;padding:1px 7px;background:var(--tag);color:var(--mut);white-space:nowrap}
.tag.explore{color:#7c3aed}.tag.decided{color:#b45309}.tag.bad{color:#dc2626}
.alts summary{cursor:pointer;color:var(--mut);font-size:13px}table{border-collapse:collapse;font-size:13px;margin:4px 0}td{padding:2px 6px}tr.chosen td{font-weight:600}td.g{color:var(--mut)}
</style></head><body><main><h1>Bot training games</h1>
<div class="help"><b>How to read this.</b> Each turn shows both boards, then each decision in order. <b>Bold</b> = the move the bot chose, with its estimated chance to win from there (from the deciding player's point of view). Tap "other moves compared" to see the alternatives. Grey lines had only one option.<br>
Tags: <span class="tag explore">found by exploring</span> outside greedy's shortlist · <span class="tag flat">all about equal</span> options within 0.5% · <span class="tag decided">looks decided</span> best &lt;5% or &gt;95%, little to learn · <span class="tag tie">exact tie</span><br><b>Data check:</b> ${esc(summary)}</div>
${H.join('\n')}</main></body></html>`);
console.log(`wrote ${out} and ${htmlOut}\n${summary}`);
