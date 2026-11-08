// Board landing page (served at /): the three things to do here, then your games with their review state.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const players = n => { const m = n.match(/replay-\d{4}-\d\d-\d\d-(.+?)-[0-9a-f]{8}\.json$/); return m ? m[1].split('-vs-') : [n, '']; };

  function row(g) {
    const [a, b] = players(g.name);
    const you = g.you || a, rival = g.rival || (g.you ? '' : b);
    const res = g.won == null ? '<span class="res"></span>' : `<span class="res ${g.won ? 'win' : 'loss'}">${g.won ? 'Win' : 'Loss'}</span>`;
    const state = g.reviewed && g.accuracy != null ? `<span class="acc-n" title="Accuracy">${g.accuracy}</span>`
      : g.old ? '<span class="tag old" title="Reviewed with an older bot">Old review</span>' : '<span class="tag">Not reviewed</span>';
    const u = encodeURIComponent(g.name);
    return `<li><span class="g-date">${esc(g.date)}</span>
      <span class="g-who"><b>${esc(you)}</b>${rival ? ` <i>vs</i> ${esc(rival)}` : ''}</span>${res}
      <span class="g-state">${state}</span>
      <span class="g-acts"><a class="hb ${g.reviewed ? 'pri' : ''}" href="review.html?r=${u}">${g.reviewed ? 'Open review' : 'Review'}</a><a class="hb" href="index.html?r=${u}">Watch</a></span></li>`;
  }

  fetch('/api/review/list').then(r => r.json()).then(list => {
    $('games').innerHTML = list.map(row).join('') || '<li class="dim">No replays yet - drop one on the Review page.</li>';
    const n = list.filter(g => g.reviewed).length;
    $('g-count').textContent = `${list.length} games · ${n} reviewed`;
  }).catch(() => { $('games').innerHTML = '<li class="dim">Couldn\'t load games.</li>'; });
})();
