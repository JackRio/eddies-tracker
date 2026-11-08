// Game Review page (board/review.html): pick or upload a replay → validation → analysis (every move
// of your turns graded by Bot A, src/coach/review.js) → summary → each move on the board, with the
// better move played out on the same table (Board.branch) and the reasons.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const GRADES = ['great', 'good', 'okay', 'misplay', 'mistake', 'blunder'];
  const LABEL = { great: 'Great', good: 'Good', okay: 'Okay', misplay: 'Misplay', mistake: 'Mistake', blunder: 'Blunder' };
  const FLAG = new Set(['misplay', 'mistake', 'blunder']);
  const isCp = m => m.grade !== 'good' && !m.forced;   // a review checkpoint: has a marker on the timeline
  const pct = p => `${Math.round(p)}%`;
  const one = x => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
  const api = (u, o) => fetch(u, o).then(r => r.json());
  const lines = m => m.log.map(l => Board.logHtml(l)).filter(Boolean);

  let name = null, REV = null, moves = [], sel = -1, replayOpen = null;
  const dlg = $('rv-dlg'), body = $('rv-body');
  // every step of the flow gets the same way out: Home, and (once a game is on the board) close back to it
  const show = (html, wide = false) => {
    body.innerHTML = `<div class="dlg-nav"><a class="btn sm" href="/">⌂ Home</a>${REV ? '<button class="btn sm" type="button" id="dlg-x" title="Back to the board (Esc)">✕</button>' : ''}</div>${html}`;
    if ($('dlg-x')) $('dlg-x').onclick = () => dlg.close();
    dlg.classList.toggle('wide', wide); if (!dlg.open) dlg.showModal();
  };
  const stopLive = () => { liveJob = null; liveChip(''); };
  const stateHtml = g => g.reviewed ? `<i class="ok">${g.accuracy != null ? `${g.accuracy} acc` : 'Reviewed'}</i>` : g.old ? '<i class="old">Old review</i>' : '';
  const setUrl = () => history.replaceState(null, '', name ? `?r=${encodeURIComponent(name)}` : location.pathname);
  const pretty = n => { const m = n.match(/replay-(\d{4}-\d\d-\d\d)-(.+?)-[0-9a-f]{8}\.json$/); return m ? `${m[1]} · ${m[2].replace(/-vs-/, ' vs ')}` : n; };

  // ── 1. pick ───────────────────────────────────────────────────────────────
  async function pick() {
    stopLive();
    show(`<h2>Game Review</h2>
      <label class="drop" id="drop"><input id="file" type="file" accept=".json,application/json" hidden>
        <b>Drop a replay file</b><span>or click to choose one</span></label>
      <details class="paste"><summary>Paste instead</summary><textarea id="paste" rows="5" spellcheck="false" placeholder="Replay JSON"></textarea>
        <div class="dlg-ctl"><button class="btn" id="paste-go" type="button">Check</button></div></details>
      <h3>Your games</h3><ul class="games" id="games"><li class="dim">Loading…</li></ul>`);
    $('file').onchange = e => e.target.files[0] && upload(e.target.files[0]);
    const d = $('drop');
    d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('on'); });
    d.addEventListener('dragleave', () => d.classList.remove('on'));
    d.addEventListener('drop', e => { e.preventDefault(); d.classList.remove('on'); e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]); });
    $('paste-go').onclick = () => $('paste').value.trim() && upload($('paste').value);
    await loadList();
    $('games').innerHTML = LIST.map(g => `<li data-n="${esc(g.name)}" class="${g.name === name ? 'cur' : ''}"><span>${esc(pretty(g.name))}</span>${stateHtml(g)}</li>`).join('') || '<li class="dim">No replays yet.</li>';
    $('games').onclick = e => { const li = e.target.closest('li[data-n]'); if (li) go(li.dataset.n); };
  }

  // ── 2. validate ─────────────────────────────────────────────────────────
  const checksHtml = v => `<ul class="checks">${v.checks.map(c => `<li class="${c.level}">${esc(c.text)}</li>`).join('')}</ul>`;
  async function upload(fileOrText) {
    show('<h2>Checking…</h2><div class="bar"><i class="busy"></i></div>');
    const text = typeof fileOrText === 'string' ? fileOrText : await fileOrText.text();
    const v = await api('/api/review/upload', { method: 'POST', body: text });
    checked(v);
  }
  async function check(n) {
    stopLive();
    show('<h2>Checking…</h2><div class="bar"><i class="busy"></i></div>');
    checked(await api(`/api/review/check/${encodeURIComponent(n)}`));
  }
  async function checked(v) {
    const info = v.info || {};
    const head = info.you ? `<p class="who"><b>${esc(info.you)}</b> vs ${esc(info.rival)}</p>` : '';
    const done = v.ok && (await api('/api/review/list')).find(g => g.name === v.name)?.reviewed;
    show(`<h2>${v.ok ? 'Ready to review' : "Can't review this file"}</h2>${head}${checksHtml(v)}
      <div class="dlg-ctl"><button class="btn" id="back" type="button">← Games</button>
      ${v.ok ? (done ? '<button class="btn" id="redo" type="button">Analyze again</button><button class="btn primary" id="go" type="button">Open review</button>'
        : '<button class="btn primary" id="go" type="button">Analyze</button>') : ''}</div>`);
    $('back').onclick = pick;
    if (v.ok) { $('go').onclick = () => run(v.name, false); if ($('redo')) $('redo').onclick = () => run(v.name, true); }
  }

  // ── 3. analyze ──────────────────────────────────────────────────────────
  // Analysis runs in the background: once a turn is graded you can start reviewing, and the board,
  // marks and summary fill in as more moves finish (the result endpoint serves the review so far).
  let liveJob = null;
  const sleep = ms => new Promise(ok => setTimeout(ok, ms));
  async function run(n, force) {
    name = n; setUrl();
    const { job } = await api(`/api/review/run/${encodeURIComponent(n)}${force ? '?force=1' : ''}`, { method: 'POST' });
    show(`<h2>Analyzing</h2><p class="dim" id="prog-t">Starting…</p><div class="bar"><i id="prog"></i></div>
      <p class="note">Keeps running if you leave.</p>
      <div class="dlg-ctl"><button class="btn" id="leave" type="button">← Games</button><button class="btn primary" id="early" type="button" hidden>Start reviewing</button></div>`);
    $('leave').onclick = pick;
    $('early').onclick = () => { dlg.close(); select(Math.max(0, moves.findIndex(isCp))); };
    liveJob = job;
    for (;;) {
      const j = await api(`/api/review/job/${job}`);
      if (liveJob !== job) return;
      const txt = j.total ? `${j.done} of ${j.total} moves · ${j.seconds}s` : 'Starting…';
      if ($('prog')) { $('prog').style.width = `${j.total ? 100 * j.done / j.total : 0}%`; $('prog-t').textContent = txt; }
      liveChip(j.status === 'running' ? `Analyzing ${j.done}/${j.total}` : '');
      if (j.status !== 'running') break;
      if (j.done) {
        const r = await api(`/api/review/result/${encodeURIComponent(n)}`);
        if (liveJob !== job) return;   // you left for another game
        if (r && !r.error && r.turns?.length) {
          await applyRev(n, r);
          if ($('early')) { $('early').hidden = false; $('early').textContent = `Start reviewing (${r.turns.length} turn${r.turns.length > 1 ? 's' : ''} ready)`; }
        }
      }
      await sleep(2500);
    }
    if (liveJob !== job) return;
    stopLive(); loadList().catch(() => {});
    const stillWaiting = !!$('prog') && dlg.open;
    await applyRev(n, await api(`/api/review/result/${encodeURIComponent(n)}`));
    if (stillWaiting) summary();
  }
  function liveChip(text) {
    let c = $('rv-live');
    if (!c) { c = document.createElement('span'); c.id = 'rv-live'; c.className = 'rv-live'; document.querySelector('.side-top').prepend(c); }
    c.textContent = text; c.hidden = !text;
  }

  // ── 4. summary ──────────────────────────────────────────────────────────
  async function applyRev(n, r) {
    if (!r || r.error) return;
    REV = r;
    const keep = moves[sel]?.from;
    moves = REV.turns.flatMap(t => t.moves.map((m, i) => ({ ...m, turn: t.turn, k: i + 1, of: t.moves.length })));
    if (replayOpen !== n) {
      const json = await fetch(`/api/replays/${encodeURIComponent(n)}`).then(x => x.json());
      Board.open(json, n); replayOpen = n;
    }
    marks();
    if (keep != null) { sel = moves.findIndex(m => m.from === keep); if (sel >= 0 && !$('move-box').hidden) select(sel, false); }
  }
  async function openReview(n) {
    stopLive(); name = n; setUrl();
    const r = await api(`/api/review/result/${encodeURIComponent(n)}`);
    if (!r || r.error || r.partial) return check(n);
    sel = -1;
    await applyRev(n, r);
    summary();
  }

  function chartSvg() {
    const W = 760, H = 150, pad = 18, pts = moves.filter(m => !m.forced);
    if (pts.length < 2) return '';
    const x = i => pad + i * (W - 2 * pad) / (pts.length - 1), y = p => H - pad - (H - 2 * pad) * p / 100;
    const line = pts.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(m.you.p).toFixed(1)}`).join(' ');
    let turnsSvg = '', last = null;
    pts.forEach((m, i) => { if (m.turn !== last) { last = m.turn; turnsSvg += `<line x1="${x(i)}" x2="${x(i)}" y1="${pad / 2}" y2="${H - pad}" class="tl"/><text x="${x(i) + 3}" y="${pad}" class="tt">T${m.turn}</text>`; } });
    const dots = pts.map((m, i) => `<circle cx="${x(i)}" cy="${y(m.you.p)}" r="${m.grade === 'good' || m.grade === 'okay' ? 3 : 6}" class="g-${m.grade}" data-i="${moves.indexOf(m)}"><title>T${m.turn} · ${LABEL[m.grade]} · ${pct(m.you.p)}</title></circle>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="${pad}" x2="${W - pad}" y1="${y(50)}" y2="${y(50)}" class="mid"/>${turnsSvg}<path d="${line}" class="ln"/>${dots}</svg>`;
  }

  function summary() {
    const S = REV.summary, won = REV.result?.winnerId === REV.me;
    const key = moves.filter(m => m.grade === 'great' || FLAG.has(m.grade));
    show(`<h2>Game Review</h2>
      <p class="who"><b>${esc(REV.you)}</b> vs ${esc(REV.rival)} ${REV.result ? `<span class="res ${won ? 'win' : 'loss'}">${won ? 'Win' : 'Loss'}</span>` : ''}${REV.partial ? ` <span class="dim">· analyzing ${REV.done}/${REV.total}</span>` : ''}</p>
      <div class="sum">
        <div class="acc"><b>${S.accuracy}</b><span>Accuracy</span></div>
        <div class="tiles">${GRADES.map(g => `<div class="tile g-${g}"><b>${S.counts[g]}</b><span>${LABEL[g]}</span></div>`).join('')}</div>
      </div>
      <h3>Your win chance</h3>${chartSvg()}
      <h3>Key moments</h3>
      <ol class="moments">${key.map(m => `<li data-i="${moves.indexOf(m)}" class="g-${m.grade}"><span class="gchip g-${m.grade}">${LABEL[m.grade]}</span><span class="tn">T${m.turn}</span>
        <span class="mt">${lines(m)[0] || ''}${m.best ? ` <span class="arrow">→</span> <b>${esc(m.best.text)}</b>` : ''}</span>${m.loss >= 0.5 ? `<span class="ls">−${one(m.loss)}</span>` : ''}</li>`).join('') || '<li class="dim">Nothing stood out.</li>'}</ol>
      <div class="dlg-ctl"><button class="btn" id="games-btn" type="button">← Games</button><button class="btn primary" id="board-btn" type="button">Review on the board</button></div>`, true);
    $('games-btn').onclick = pick;
    $('board-btn').onclick = () => { dlg.close(); select(Math.max(0, moves.findIndex(isCp))); };
    body.querySelectorAll('[data-i]').forEach(el => el.addEventListener('click', () => { dlg.close(); select(+el.dataset.i); }));
  }

  // ── 5. one move on the board ────────────────────────────────────────────
  function marks() {
    const n = Board.total();
    $('coach-marks').innerHTML = moves.filter(isCp).map(m =>
      `<i class="g-${m.grade}" data-i="${moves.indexOf(m)}" style="left:${(100 * m.from / Math.max(1, n - 1)).toFixed(2)}%" title="T${m.turn}: ${LABEL[m.grade]}${m.loss >= 0.5 ? ` (−${one(m.loss)})` : ''}"></i>`).join('');
  }

  // the Rival's reply in the verification games (Bot A on both sides), counted per game
  function replyHtml(rp, great) {
    if (!rp) return '';
    const L = great ? ['You', "Bot's pick"] : ['You', 'Better'];
    const cnt = (s, k) => `${s[k]}/${s.n}`;
    const top = s => (s.attacks[0] ? `${esc(s.attacks[0][0])} <small>${s.attacks[0][1]}/${s.n}</small>` : '<span class="dim">no attack</span>');
    const row = (label, k, bad) => {
      const a = rp.you[k] / rp.you.n, b = rp.best[k] / rp.best.n, d = (b - a) * (bad ? -1 : 1);
      if (!rp.you[k] && !rp.best[k]) return '';
      return `<tr><td>${label}</td><td>${cnt(rp.you, k)}</td><td class="${Math.abs(b - a) < .2 ? '' : d > 0 ? 'up' : 'down'}">${cnt(rp.best, k)}</td></tr>`;
    };
    return `<table class="nx"><tr><th>Rival's reply</th><th>${L[0]}</th><th>${L[1]}</th></tr>
      <tr><td>Main attack</td><td>${top(rp.you)}</td><td>${top(rp.best)}</td></tr>
      ${row('Steals a Gig', 'steal', true)}${row('You lose a Unit', 'lose', true)}${row('Rival wins', 'rivalWins', true)}${row('You win', 'youWin', false)}</table>`;
  }

  function moveHtml(m) {
    const i = moves.indexOf(m);
    // checkpoints = the moves marked on the timeline (everything but plain good / only moves)
    const prevCp = moves.slice(0, i).reverse().find(isCp), nextCp = moves.slice(i + 1).find(isCp);
    const nCp = moves.filter(isCp).length, at = moves.slice(0, i + 1).filter(isCp).length;
    const better = m.best && m.loss >= 0.5;
    const why = m.why || {};
    return `<div class="mv-head"><span class="gchip g-${m.grade}">${m.forced ? 'Only move' : LABEL[m.grade]}</span>
        <span class="mv-at">T${m.turn} · ${m.k}/${m.of}</span>
        <span class="mv-nav">${isCp(m) ? `<span class="mv-cp">${at}/${nCp}</span>` : ''}<button class="btn sm" id="mv-prev" ${prevCp ? '' : 'disabled'} title="Previous checkpoint">◀</button><button class="btn sm" id="mv-next" ${nextCp ? '' : 'disabled'} title="Next checkpoint">▶</button></span></div>
      <div class="mv-row you"><span class="k">You</span><div class="mv-t">${lines(m).map(l => `<div>${l}</div>`).join('')}</div><span class="pc">${pct(m.you.p)}</span></div>
      ${better ? `<div class="mv-row best"><span class="k">Better</span><div class="mv-t"><b>${esc(m.best.text)}</b></div><span class="pc">${pct(m.best.p)} <small>+${one(m.loss)}</small></span></div>` : ''}
      ${why.headline ? `<p class="mv-line">${esc(why.headline)}</p>` : ''}
      ${why.reasons?.length ? `<ul class="why">${why.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${replyHtml(why.reply, m.grade === 'great')}
      ${m.matched === null ? '<p class="note">Couldn\'t replay this exact move in the engine; scored from the position after it.</p>' : ''}
      <div class="mv-btns"><button class="btn" id="show-you" type="button">▶ Your move</button>${better ? '<button class="btn primary" id="show-best" type="button">▶ Better move</button>' : ''}
        <button class="btn" id="back-game" type="button" hidden>↩ Back to the game</button></div>
      ${m.options?.length > 1 ? `<details class="opts-d"><summary>Moves compared</summary><table class="opts">${m.options.map(o => `<tr class="${o.yours ? 'chosen' : ''}"><td>${esc(o.text)}${o.yours ? ' <small>(yours)</small>' : ''}</td><td class="pct"><span class="wbar"><i style="width:${o.p}%"></i></span> ${pct(o.p)}</td></tr>`).join('')}</table></details>` : ''}`;
  }

  function select(i, jump = true) {
    if (i < 0 || i >= moves.length) return;
    sel = i;
    const m = moves[i];
    $('move-box').hidden = false;
    $('move-box').className = `panel info-panel g-${m.grade}`;
    $('move-box').innerHTML = moveHtml(m);
    $('mv-prev').onclick = () => select(moves.lastIndexOf(moves.slice(0, i).reverse().find(isCp)));
    $('mv-next').onclick = () => select(moves.indexOf(moves.slice(i + 1).find(isCp)));
    $('show-you').onclick = async () => { busy(true); if (Board.branched()) Board.unbranch(m.from); else BoardNav.go(m.from); await Board.playTo(m.to, 1000); busy(false); };
    if ($('show-best')) $('show-best').onclick = showBest;
    $('back-game').onclick = () => { Board.unbranch(m.from); branchUi(false); };
    if (jump) { if (Board.branched()) Board.unbranch(m.from); else BoardNav.go(m.from); branchUi(false); }
  }
  let playing = false;
  const busy = on => { playing = on; };
  const branches = new Map();
  async function showBest() {
    const m = moves[sel];
    $('show-best').disabled = true; $('show-best').textContent = 'Thinking…';
    let b = branches.get(m.from);
    if (!b) { b = await api(`/api/review/branch/${encodeURIComponent(name)}?from=${m.from}`); branches.set(m.from, b); }
    if (moves[sel] !== m) return;
    $('show-best').disabled = false; $('show-best').textContent = '▶ Better move';
    if (!b.steps?.length) return;
    branchUi(true); busy(true);
    await Board.branch(m.from, b.steps, b.log, 1100);
    busy(false);
  }
  function branchUi(on) {
    document.body.classList.toggle('branch', on);
    if ($('back-game')) $('back-game').hidden = !on;
  }

  // free navigation on the timeline: the panel follows to the move you're looking at
  document.addEventListener('board:step', e => {
    if (!moves.length || playing || Board.branched()) return;
    const s = e.detail.step;
    const i = moves.findIndex(m => s >= m.from && s < m.to);
    if (i >= 0 && i !== sel) select(i, false);
  });

  // timeline markers open that move's review
  $('coach-marks').addEventListener('click', e => { const i = e.target.closest('i[data-i]'); if (i) select(+i.dataset.i); });

  $('to-summary').onclick = () => REV ? summary() : pick();
  $('to-pick').onclick = pick;
  dlg.addEventListener('cancel', e => { if (!REV) e.preventDefault(); });

  // open a game: straight into its review if it has a current one, else the check / Analyze step
  let LIST = [];
  function go(n) { return LIST.find(x => x.name === n)?.reviewed ? openReview(n) : check(n); }
  async function loadList() {
    LIST = await api('/api/review/list');
    $('game-pick').innerHTML = '<option value="">Switch game…</option>' + LIST.map(g =>
      `<option value="${esc(g.name)}">${esc(pretty(g.name))}${g.reviewed && g.accuracy != null ? ` · ${g.accuracy}` : ''}</option>`).join('');
  }
  $('game-pick').onchange = e => { const n = e.target.value; e.target.value = ''; if (n) go(n); };
  loadList().catch(() => {});

  const q = new URLSearchParams(location.search).get('r');
  if (q) openReview(q).catch(() => check(q)); else pick();
})();
