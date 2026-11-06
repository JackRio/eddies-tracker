// Live games on the replay board (board/play.html): play a bot, or watch two bots.
// The server (scripts/serve-board.js -> src/bot/play.js) runs the engine and the bots; this page
// asks it for new board steps, shows your options as buttons, and lets a bot make one decision at a
// time so every bot move lands on the board as it happens. "Bot's thinking" shows, for the step you
// are looking at, every move the bot compared with its estimated win chance, and its deck guess.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());

  let cfg = null, id = null, total = 0, last = null, busy = false, auto = false, gen = 0, labels = {};
  let paying = null;          // { o, sel: Set } while you pick what pays for option o
  // bot pace: ms each bot move stays on screen before the next one lands ('step' = wait for a click)
  // ms per bot move, and how much slower the animations run at that pace
  const PACE = { step: 0, vslow: 6000, slow: 4000, normal: 1800, fast: 1000 };
  const ANIM = { step: 1.8, vslow: 2.2, slow: 1.8, normal: 1.1, fast: .8 };
  const pace = () => $('pace').value;
  $('pace').value = localStorage.getItem('eddies_bot_pace2') || 'normal';
  Board.setSpeed(ANIM[pace()]);
  $('pace').onchange = () => { localStorage.setItem('eddies_bot_pace2', pace()); Board.setSpeed(ANIM[pace()]); if (nextBot && pace() !== 'step') nextBot(); };
  let shownAt = 0, nextBot = null;
  const sleep = ms => new Promise(ok => setTimeout(ok, ms));

  // ── setup ────────────────────────────────────────────────────────────────
  // before a game: the empty table, so the page already has the board's layout behind the setup dialog
  const emptyP = id => ({ playerId: id, dicePool: [4, 6, 8, 10, 12, 20].map(s => ({ sides: s, available: true })), gigDice: [], field: [], legends: [], eddies: [], trash: [], hand: [], handCount: 0, deckCount: 0 });
  const blank = { state: { game: { turnNumber: 0, stageLabel: 'Setup' }, players: { player1: emptyP('player1'), player2: emptyP('player2') } }, action: { label: 'Pick decks and a bot, then Start game' }, newLog: [], turn: 0 };
  Board.openLive({ match: { startedAt: Date.now() }, me: 'player1', rival: 'player2', labels: { player1: 'You', player2: 'Bot' }, steps: [blank], log: [] });

  fetch('/api/play/config').then(r => r.json()).then(c => {
    cfg = c;
    const deckOpts = c.decks.map(d => `<option value="${esc(d.file)}">${esc(d.label)}${d.rate ? ` · ${esc(d.rate)}` : ''}</option>`).join('');
    const botOpts = c.bots.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    for (const k of ['deck-p1', 'deck-p2']) $(k).innerHTML = deckOpts;
    for (const k of ['bot-p1', 'bot-p2']) $(k).innerHTML = botOpts;
    $('mode').value = c.defaults.mode || 'watch';
    setMode();
  });
  function setMode() {
    const watch = $('mode').value === 'watch';
    document.querySelector('.bot-p1').hidden = !watch;
    $('p1-label').textContent = watch ? 'Left bot' : 'You';
    const D = cfg.defaults;
    $('deck-p1').value = D.p1;
    $('bot-p1').value = D.bot;
    $('bot-p2').value = D.bot;
    $('deck-p2').value = D.p2;
    about();
  }
  function about() {
    const ids = [$('mode').value === 'watch' && $('bot-p1').value, $('bot-p2').value].filter(Boolean);
    $('bot-about').innerHTML = [...new Set(ids)].map(i => { const b = cfg.bots.find(x => x.id === i); return `<p><b>${esc(b.name)}</b>: ${esc(b.about)}</p>`; }).join('');
  }
  $('mode').onchange = setMode;
  // ── undo (play mode): the server restores the game before your last decision; the board reloads there ──
  async function undoMove() {
    if (!id || !last || last.mode !== 'play') return;
    const my = ++gen;                                  // stops a bot that was about to move
    if (nextBot) nextBot();
    const r = await post(`/api/play/${id}/undo`);
    if (r.error) { waiting(r.error); return; }
    while (busy) await sleep(50);
    total = 0; revealed = false;
    const q = await poll();
    total = q.total; last = q;
    Board.openLive({ match: { ...q.match, startedAt: Date.now() }, me: q.match.me, rival: q.match.rival, labels: q.match.labels, steps: q.steps, log: q.log });
    panels(q);
    loop(my);
  }
  $('undo').onclick = undoMove;
  addEventListener('keydown', e => { if ((e.key === 'u' || e.key === 'U') && !e.ctrlKey && !e.metaKey && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) undoMove(); });
  $('new-game').onclick = () => { $('setup-cancel').hidden = !id; if (!$('setup-box').open) $('setup-box').showModal(); };
  $('setup-cancel').onclick = () => $('setup-box').close();
  $('bot-p1').onchange = about;
  $('bot-p2').onchange = about;

  $('setup').onsubmit = async e => {
    e.preventDefault();
    const watch = $('mode').value === 'watch';
    const body = { mode: watch ? 'watch' : 'play', you: 'p1', first: $('first').value,
      bots: { p1: watch ? $('bot-p1').value : null, p2: $('bot-p2').value }, decks: { p1: $('deck-p1').value, p2: $('deck-p2').value } };
    auto = false; setAuto(false);
    const my = ++gen;
    const r = await post('/api/play/new', body);
    if (r.error) return alert(r.error);
    id = r.id; total = 0; revealed = false;
    const q = await poll();
    if (my !== gen) return;
    total = q.total; last = q; labels = q.match.labels;
    Board.openLive({ match: { ...q.match, startedAt: Date.now() }, me: q.match.me, rival: q.match.rival, labels: q.match.labels, steps: q.steps, log: q.log });
    $('setup-box').close();
    $('watch-box').hidden = !watch;
    $('undo').hidden = watch;
    document.body.classList.toggle('playing', !watch);   // no replay timeline / match header while you play
    $('think-box').hidden = false;
    panels(q);
    loop(my);
  };

  const poll = () => fetch(`/api/play/${id}?from=${total}`).then(r => r.json());
  // new steps play one at a time (each animates), `gap` ms apart
  let revealed = false;
  async function sync(gap = 650) {
    const q = await poll();
    // game over: fetch the bot's full reasoning for every step (hidden during play - it names its hand)
    if (q.over && q.mode === 'play' && !revealed) {
      revealed = true;
      window.Sfx?.play(q.winner === q.you ? 'win' : 'lose', 600);
      fetch(`/api/play/${id}?from=0`).then(r => r.json()).then(all => {
        all.steps.forEach((st, i) => { const mine = Board.step(i); if (mine && st.think) mine.think = st.think; });
        document.dispatchEvent(new CustomEvent('board:step'));
      });
    }
    if (q.steps.length) { await Board.extend(q.steps, q.log, gap); shownAt = Date.now(); }
    total = q.total;
    last = q;
    panels(q);
    return q;
  }

  // ── the game loop: bots move one decision at a time until it's your turn (or you pause) ──
  async function loop(my) {
    if (busy) return;
    busy = true;
    try {
      while (my === gen) {
        const q = last && last.total === total ? last : await sync();
        if (q.over) break;
        if (!q.botToAct) break;                                  // your decision: wait for a click
        if (q.mode === 'watch' && !auto && !stepRequests) break;
        if (stepRequests) stepRequests--;
        if (q.mode === 'play' && pace() === 'step') {
          // step mode: each bot move waits for your click
          waiting('', true);
          await new Promise(ok => { nextBot = ok; });
          nextBot = null;
          if (my !== gen) break;
        }
        waiting(`${q.match.labels[q.toAct]} is thinking…`);
        const r = await post(`/api/play/${id}/advance`);
        if (r.error) { waiting(`Stopped: ${r.error}`); break; }
        // the previous move stays on screen for the chosen pace (thinking time counts towards it)
        if (pace() !== 'step' && (q.mode === 'play' || auto || turnTarget != null)) await sleep(Math.max(0, PACE[pace()] - (Date.now() - shownAt)));
        last = null;
        await sync(Math.max(600, (PACE[pace()] || 2500) / 2));
        if (q.mode === 'watch' && turnTarget != null && (last?.over || Board.step(total - 1)?.turn !== turnTarget)) { turnTarget = null; stepRequests = 0; }
      }
    } finally { busy = false; }
    if (last) panels(last);
  }
  function waiting(text, stepBtn) {
    $('decision-box').hidden = false;
    $('decision-title').textContent = stepBtn ? 'Bot to act' : 'Waiting';
    $('decision-prompt').textContent = '';
    $('decision').innerHTML = stepBtn ? `<button class="btn primary" id="next-bot" type="button">Next bot move ▶</button>` : `<div class="waiting">${esc(text)}</div>`;
    $('next-bot')?.addEventListener('click', () => nextBot && nextBot());
  }

  // bot vs bot controls
  let stepRequests = 0, turnTarget = null;
  $('w-step').onclick = () => { stepRequests = 1; loop(gen); };
  $('w-turn').onclick = () => { turnTarget = Board.step(total - 1)?.turn; stepRequests = 999; loop(gen); };
  function setAuto(on) { auto = on; $('w-run').classList.toggle('on', on); $('w-run').textContent = on ? 'Pause ❚❚' : 'Auto ▶'; }
  $('w-run').onclick = () => { setAuto(!auto); if (auto) loop(gen); };
  // keys from the board (app.js): D / E / S on the latest step of a bot-vs-bot game
  document.addEventListener('board:live-key', e => {
    if (!id || last?.mode !== 'watch' || last?.over) return;
    ({ step: $('w-step'), turn: $('w-turn'), auto: $('w-run') })[e.detail]?.click();
  });

  // ── panels: your decision, result ───────────────────────────────────────
  function panels(q) {
    const box = $('decision-box');
    if (q.over) {
      box.hidden = false;
      const youWon = q.mode === 'play' && q.winner === q.you;
      $('decision-title').textContent = 'Game over';
      $('decision-prompt').textContent = '';
      $('decision').innerHTML = `<div class="result-big ${q.mode === 'play' ? (youWon ? 'win' : 'loss') : ''}">${q.winner ? esc(q.match.labels[q.winner]) + (q.mode === 'play' ? (youWon ? ' — you win' : ' wins') : ' wins') : 'No winner'}</div>
        <div class="about">Seed ${q.seed}. Step back through the game with the timeline; every bot move shows its thinking.</div>`;
      return;
    }
    if (!q.decision) {
      if (q.mode === 'watch') { box.hidden = true; return; }
      if (!busy) waiting(`${q.match.labels[q.toAct] || 'Bot'} to act`);
      return;
    }
    box.hidden = false;
    const step = q.decision.step;
    $('decision-title').textContent = { main_phase: 'Your move', defensive_step: 'You are attacked', attacker_interrupt_step: 'Before the fight', choose_gig_die: 'Pick a Gig die to roll',
      mulligan_decision: 'Keep or mulligan?', choose_gig_to_steal: 'Steal a Gig', effect_choice: 'Choose' }[step] || 'Your move';
    const att = q.attack ? `${q.attack.attacker} attacks ${q.attack.target === 'Gigs' ? 'your Gigs' : q.attack.target}. ` : '';
    $('decision-prompt').textContent = att + (q.decision.prompt || '');
    const behind = Board.current() < total - 1 ? `<div class="behind">You're looking at an earlier step.<button class="btn" id="to-now">Back to now</button></div>` : '';
    const opts = q.decision.options;
    // cards an effect shows you (e.g. Viktor Vektor looks at the top 5): name, type, and whether it can be taken
    const reveal = q.decision.reveal ? `<div class="reveal">${q.decision.reveal.map(c => `<span class="rv${c.ok ? '' : ' no'}" title="${esc(c.text)}">${esc(c.short)} <small>${esc(c.type)}${c.ok ? '' : ' · can’t take'}</small></span>`).join('')}</div>` : '';
    const groups = new Map();
    const groupOf = t => /^End turn/.test(t) ? 'zz' : /^Sell/.test(t) ? 'Sell (once per turn)' : /^Play .* on /.test(t) ? 'Gear' : /^Play/.test(t) ? 'Play' : /^Call|Solo/.test(t) ? 'Legends' : /^Attack/.test(t) ? 'Attack' : /^Use/.test(t) ? 'Abilities' : '';
    for (const o of opts) { const g = o.group || (step === 'main_phase' ? groupOf(o.text) : ''); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(o); }
    if (paying) { const o = opts.find(x => x.i === paying.o.i && x.text === paying.o.text); if (o) return payHtml(o, att); paying = null; }
    markPayers(null);
    const order = ['Sell (once per turn)', 'Play', 'Gear', 'Legends', 'Abilities', 'Attack', '', 'zz'];
    $('decision').innerHTML = behind + reveal + order.filter(g => groups.has(g)).map(g =>
      (g && g !== 'zz' ? `<div class="choice-group">${esc(g)}</div>` : '') +
      groups.get(g).map(o => `<button class="choice${g === 'zz' ? ' end' : ''}" data-i="${o.i}"><span>${esc(o.text)}</span>${o.pay ? `<span class="pay">€$${o.pay}</span>` : ''}</button>`).join('')).join('');
    $('to-now')?.addEventListener('click', () => BoardNav.go(total - 1));
  }
  // ── paying: you pick which Eddies / Legends pay (pre-picked: Eddies, then face-down Legends) ──
  function payHtml(o, att) {
    $('decision-title').textContent = 'Pay';
    $('decision-prompt').textContent = att || '';
    const n = paying.sel.size;
    $('decision').innerHTML = `<div class="pay-what"><b>${esc(o.text)}</b> <span class="sub">pick ${o.pay} · ${n}/${o.pay}</span></div>
      <div class="payers">${o.payables.map(p => `<button type="button" class="payer ${p.kind}${paying.sel.has(p.iid) ? ' on' : ''}" data-iid="${esc(p.iid)}">${esc(p.label)}</button>`).join('')}</div>
      <div class="pay-ctl"><button class="btn" type="button" id="pay-back">Back</button>
      <button class="btn primary" type="button" id="pay-go"${n === o.pay ? '' : ' disabled'}>Pay &amp; play</button></div>`;
    markPayers(paying.sel);
  }
  // what you picked to pay glows on the board (Legends by id; Eddies from the top of the pile)
  function markPayers(sel) {
    document.querySelectorAll('#table .pay-pick').forEach(el => el.classList.remove('pay-pick'));
    if (!sel || !paying) return;
    const ed = paying.o.payables.filter(p => p.kind === 'eddie' && sel.has(p.iid)).length;
    const ready = [...document.querySelectorAll('#table .pz.you .eddies .card:not(.spent-e)')];
    ready.slice(Math.max(0, ready.length - ed)).forEach(el => el.classList.add('pay-pick'));
    for (const p of paying.o.payables) if (p.kind !== 'eddie' && sel.has(p.iid)) document.querySelector(`#table [data-uid="${CSS.escape(p.iid)}"]`)?.classList.add('pay-pick');
  }
  document.addEventListener('board:step', () => { if (paying) markPayers(paying.sel); });
  async function play(i, pay) {
    [...$('decision').querySelectorAll('button')].forEach(x => { x.disabled = true; });
    paying = null; markPayers(null);
    const r = await post(`/api/play/${id}/move`, { i, pay });
    if (r.error) alert(r.error);
    last = null;
    await sync();
    loop(gen);
  }
  $('decision').addEventListener('click', async e => {
    if (busy) return;
    const payer = e.target.closest('.payer');
    if (payer && paying) {
      const k = payer.dataset.iid, S = paying.sel;
      if (S.has(k)) S.delete(k);
      else { if (S.size >= paying.o.pay) S.delete([...S][0]); S.add(k); }
      return panels(last);
    }
    if (e.target.id === 'pay-back') { paying = null; return panels(last); }
    if (e.target.id === 'pay-go' && paying) return play(paying.o.i, [...paying.sel]);
    const b = e.target.closest('.choice');
    if (!b) return;
    const o = last?.decision?.options.find(x => x.i === +b.dataset.i);
    // a cost with more than one way to pay: pick the payers first
    if (o && o.pay && o.payables.length > o.pay) { paying = { o, sel: new Set(o.defaultPay) }; return panels(last); }
    play(+b.dataset.i);
  });

  // ── the bot's thinking: every bot decision this turn, up to the step on screen ──
  const botName = who => labels[who === 'p1' ? 'player1' : 'player2'] || who;
  function thinkHtml(t, open) {
    const rows = (t.considered || []).slice().sort((a, b) => b.pct - a.pct).map(o =>
      `<tr class="${o.chosen ? 'chosen' : ''}"><td>${o.chosen ? '▶ ' : ''}${esc(o.text)}${o.explored ? '<span class="tagx">explored</span>' : ''}</td>
        <td><span class="wbar"><i style="width:${Math.max(1, Math.min(100, o.pct))}%"></i></span></td><td class="pct">${o.pct.toFixed(1)}%</td></tr>`).join('');
    const head = `<b>${esc(t.text)}</b>${t.onTurn ? '' : ' <span class="sub">(on the opponent’s turn)</span>'}${rows ? ` <span class="sub">${t.considered.find(o => o.chosen)?.pct.toFixed(1)}% · ${(t.ms / 1000).toFixed(1)} s</span>` : t.note ? ' <span class="sub">· hand check</span>' : ' <span class="sub">· only option</span>'}`;
    if (t.hidden) return `<div class="tk none"><b>${esc(t.text)}</b></div>`;
    if (!rows && t.note) return `<details class="tk"${open ? ' open' : ''}><summary>${head}</summary><div class="about">${esc(t.note)}</div></details>`;
    if (!rows) return `<div class="tk none">${head}</div>`;
    return `<details class="tk"${open ? ' open' : ''}><summary>${head}</summary><table class="opts"><tbody>${rows}</tbody></table>
      ${t.notSearched ? `<div class="about">+${t.notSearched} legal move${t.notSearched === 1 ? '' : 's'} not searched</div>` : ''}
      ${t.belief ? `<div class="belief">Deck guess: ${t.belief.map(b => `<b>${b.p}%</b> ${esc(b.deck)}`).join(' · ')}</div>` : ''}</details>`;
  }
  document.addEventListener('board:step', () => {
    if (!id) return;
    if (last && !last.over && last.decision) panels(last);   // keep "back to now" accurate
    const at = Board.current();
    // the bot turn to show: the one containing this step, else the latest bot turn before it
    let k = at;
    while (k >= 0 && !Board.step(k)?.think) k--;
    if (k < 0) { $('think-at').textContent = ''; $('think').innerHTML = '<div class="think-none">No bot move yet.</div>'; return; }
    const turn = Board.step(k).think.turn, who = Board.step(k).think.who;
    const list = [];
    for (let j = k; j >= 0; j--) { const t = Board.step(j)?.think; if (!t) continue; if (t.turn !== turn) break; if (t.who === who) list.unshift(t); }
    $('think-at').textContent = `· ${botName(who)}, turn ${turn}`;
    $('think').innerHTML = `<div class="about">${list.some(t => t.hidden) ? 'What it compared stays hidden until the game ends (it names its hand).' : 'Each decision: the moves it compared and the win chance it estimated for each. ▶ = played.'}</div>`
      + list.map((t, i) => thinkHtml(t, i === list.length - 1)).join('');
  });

  document.addEventListener('board:matchinfo', () => {
    if (!last) return;
    const L = last.match.labels, D = last.match.decks;
    $('match-info').innerHTML = `<span class="who"><b>${esc(L.player1)}</b> <small>${esc(D.player1)}</small> vs <b>${esc(L.player2)}</b> <small>${esc(D.player2)}</small></span>`;
  });
})();
