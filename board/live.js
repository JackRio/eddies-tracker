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

  // ── setup ────────────────────────────────────────────────────────────────
  fetch('/api/play/config').then(r => r.json()).then(c => {
    cfg = c;
    const deckOpts = c.decks.map(d => `<option value="${esc(d.file)}">${esc(d.label)}${d.rate ? ` · ${esc(d.rate)}` : ''}</option>`).join('');
    const botOpts = c.bots.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    for (const k of ['deck-p1', 'deck-p2']) $(k).innerHTML = deckOpts;
    for (const k of ['bot-p1', 'bot-p2']) $(k).innerHTML = botOpts;
    setMode();
  });
  function setMode() {
    const watch = $('mode').value === 'watch';
    document.querySelector('.bot-p1').hidden = !watch;
    $('p1-label').textContent = watch ? 'Left bot' : 'You';
    const D = cfg.defaults;
    $('deck-p1').value = watch ? D.A : D.you;
    $('bot-p1').value = 'A';
    $('bot-p2').value = watch ? 'B' : 'A';
    $('deck-p2').value = watch ? D.B : D.A;
    about();
  }
  function about() {
    const ids = [$('mode').value === 'watch' && $('bot-p1').value, $('bot-p2').value].filter(Boolean);
    $('bot-about').innerHTML = [...new Set(ids)].map(i => { const b = cfg.bots.find(x => x.id === i); return `<p><b>${esc(b.name)}</b>: ${esc(b.about)}</p>`; }).join('');
  }
  $('mode').onchange = setMode;
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
    id = r.id; total = 0;
    const q = await poll();
    if (my !== gen) return;
    total = q.total; last = q; labels = q.match.labels;
    Board.openLive({ match: { ...q.match, startedAt: Date.now() }, me: q.match.me, rival: q.match.rival, labels: q.match.labels, steps: q.steps, log: q.log });
    $('setup-box').open = false;
    $('watch-box').hidden = !watch;
    $('think-box').hidden = false;
    panels(q);
    loop(my);
  };

  const poll = () => fetch(`/api/play/${id}?from=${total}`).then(r => r.json());
  async function sync() {
    const q = await poll();
    if (q.steps.length) Board.extend(q.steps, q.log);
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
        waiting(`${q.match.labels[q.toAct]} is thinking…`);
        const r = await post(`/api/play/${id}/advance`);
        if (r.error) { waiting(`Stopped: ${r.error}`); break; }
        last = null;
        await sync();
        if (q.mode === 'watch' && turnTarget != null && (last?.over || Board.step(total - 1)?.turn !== turnTarget)) { turnTarget = null; stepRequests = 0; }
        if (q.mode === 'watch' && auto) await new Promise(ok => setTimeout(ok, 500));
      }
    } finally { busy = false; }
    if (last) panels(last);
  }
  function waiting(text) {
    $('decision-box').hidden = false;
    $('decision-title').textContent = 'Waiting';
    $('decision-prompt').textContent = '';
    $('decision').innerHTML = `<div class="waiting">${esc(text)}</div>`;
  }

  // bot vs bot controls
  let stepRequests = 0, turnTarget = null;
  $('w-step').onclick = () => { stepRequests = 1; loop(gen); };
  $('w-turn').onclick = () => { turnTarget = Board.step(total - 1)?.turn; stepRequests = 999; loop(gen); };
  function setAuto(on) { auto = on; $('w-run').classList.toggle('on', on); $('w-run').textContent = on ? 'Pause ❚❚' : 'Auto ▶'; }
  $('w-run').onclick = () => { setAuto(!auto); if (auto) loop(gen); };

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
    for (const o of opts) { const g = step === 'main_phase' ? groupOf(o.text) : ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(o); }
    const order = ['Sell (once per turn)', 'Play', 'Gear', 'Legends', 'Abilities', 'Attack', '', 'zz'];
    $('decision').innerHTML = behind + reveal + order.filter(g => groups.has(g)).map(g =>
      (g && g !== 'zz' ? `<div class="choice-group">${esc(g)}</div>` : '') +
      groups.get(g).map(o => `<button class="choice${g === 'zz' ? ' end' : ''}" data-i="${o.i}"><span>${esc(o.text)}</span>${o.pay ? `<span class="pay">pay ${o.pay}</span>` : ''}</button>`).join('')).join('');
    $('to-now')?.addEventListener('click', () => BoardNav.go(total - 1));
  }
  $('decision').addEventListener('click', async e => {
    const b = e.target.closest('.choice');
    if (!b || busy) return;
    [...$('decision').querySelectorAll('.choice')].forEach(x => { x.disabled = true; });
    const r = await post(`/api/play/${id}/move`, { i: +b.dataset.i });
    if (r.error) alert(r.error);
    last = null;
    await sync();
    loop(gen);
  });

  // ── the bot's thinking: every bot decision this turn, up to the step on screen ──
  const botName = who => labels[who === 'p1' ? 'player1' : 'player2'] || who;
  function thinkHtml(t, open) {
    const rows = (t.considered || []).slice().sort((a, b) => b.pct - a.pct).map(o =>
      `<tr class="${o.chosen ? 'chosen' : ''}"><td>${o.chosen ? '▶ ' : ''}${esc(o.text)}${o.explored ? '<span class="tagx">explored</span>' : ''}</td>
        <td><span class="wbar"><i style="width:${Math.max(1, Math.min(100, o.pct))}%"></i></span></td><td class="pct">${o.pct.toFixed(1)}%</td></tr>`).join('');
    const head = `<b>${esc(t.text)}</b>${t.onTurn ? '' : ' <span class="sub">(on the opponent’s turn)</span>'}${rows ? ` <span class="sub">${t.considered.find(o => o.chosen)?.pct.toFixed(1)}% · ${(t.ms / 1000).toFixed(1)} s</span>` : ' <span class="sub">· only option</span>'}`;
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
    $('think').innerHTML = `<div class="about">Each decision: the moves it compared and the win chance it estimated for each. ▶ = played.</div>`
      + list.map((t, i) => thinkHtml(t, i === list.length - 1)).join('');
  });

  document.addEventListener('board:matchinfo', () => {
    if (!last) return;
    const L = last.match.labels, D = last.match.decks;
    $('match-info').innerHTML = `<span class="who"><b>${esc(L.player1)}</b> <small>${esc(D.player1)}</small> vs <b>${esc(L.player2)}</b> <small>${esc(D.player2)}</small></span>`;
  });
})();
