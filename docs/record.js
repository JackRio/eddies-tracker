let catalog = [];
let pending = [];
let selected = null;
let faqData = {};
let giveAway = null;
// Set from a Needed-page link (?bucket=main|reserve) so the bucket the user
// was already filtering by there doesn't have to be picked again here.
let impliedBucket = null;
let bucketsExpanded = false;

const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Card rulesText comes from the API with {Keyword} tokens (e.g. "{Call}",
// "{Go Solo}") standing in for the game's official badge icons. Swap each
// one for the matching SVG (scraped from cyberpunktcg.com's own rules-faq
// page, same icons/colors as the real cards) instead of showing the raw
// bracketed text. Kept in sync with the same helper in the desktop app's
// renderer.js/collection.js.
function renderRulesText(text) {
  if (!text) return '';
  return text
    .split(/(\{[^}]+\})/g)
    .map((part) => {
      const m = part.match(/^\{([^}]+)\}$/);
      if (!m) return escapeHtml(part);
      const slug = m[1].toLowerCase().replace(/\s+/g, '-');
      const label = escapeHtml(m[1]);
      return `<img class="keyword-icon" src="assets/keywords/${slug}.svg" alt="${label}" title="${label}">`;
    })
    .join('');
}

function faqHtml(slug) {
  const entry = faqData[slug];
  if (!entry || !entry.faqs.length) return '';
  const items = entry.faqs
    .map((f) => `<div class="faq-item"><div class="faq-q">${renderRulesText(f.q)}</div><div class="faq-a">${renderRulesText(f.a)}</div></div>`)
    .join('');
  return `<div class="popped-faq"><h4>Rules FAQ</h4>${items}</div>`;
}

async function init() {
  if (!getToken()) {
    el('token-gate').hidden = false;
    el('record-body').hidden = true;
    attachTokenControls();
    return;
  }

  el('token-gate').hidden = true;
  el('record-body').hidden = false;

  try {
    [catalog, pending, faqData] = await Promise.all([
      fetchJson('data/catalog.json'),
      fetchJson('data/pending-changes.json'),
      fetchJson('data/faq.json').catch(() => ({}))
    ]);
  } catch (err) {
    el('search-results').innerHTML = `<div class="empty-state">Couldn't load data: ${err.message}</div>`;
    return;
  }

  attachControls();
  renderPending();

  const params = new URLSearchParams(location.search);
  const bucket = params.get('bucket');
  if (bucket === 'main' || bucket === 'reserve') impliedBucket = bucket;

  const id = params.get('id');
  if (id) {
    el('search-section').hidden = true;
    el('search-different-link').hidden = false;
    selectCard(id);
    return;
  }

  const q = params.get('q');
  if (q) {
    el('search-input').value = q;
    renderSearchResults(q);
  }
}

function attachTokenControls() {
  el('save-token-btn').addEventListener('click', onSaveToken);
}

function attachControls() {
  el('search-input').addEventListener('input', (e) => renderSearchResults(e.target.value));
  el('forget-token-btn').addEventListener('click', (e) => {
    e.preventDefault();
    if (!confirm('Forget the saved token on this device?')) return;
    clearToken();
    location.reload();
  });
  document.querySelectorAll('.bucket-action-row button').forEach((btn) => {
    btn.addEventListener('click', () => adjust(btn.dataset.bucket, Number(btn.dataset.delta)));
  });
  el('search-different-link').addEventListener('click', (e) => {
    e.preventDefault();
    el('search-section').hidden = false;
    el('search-different-link').hidden = true;
  });
  el('toggle-other-buckets').addEventListener('click', (e) => {
    e.preventDefault();
    bucketsExpanded = !bucketsExpanded;
    applyBucketVisibility();
  });
  el('give-away-search').addEventListener('input', (e) => renderGiveAwayResults(e.target.value));
  el('give-away-remove').addEventListener('click', clearGiveAway);
}

// When a card was clicked from the Needed page, the bucket (Main/Reserve)
// is already known from the toggle selected there - only show that row by
// default so recording is just "how many", with a link to reveal the rest
// (e.g. to log Extras too) for anyone who wants it.
function applyBucketVisibility() {
  const showAll = !impliedBucket || bucketsExpanded;
  document.querySelectorAll('.bucket-action-row').forEach((row) => {
    row.hidden = !showAll && row.dataset.bucketRow !== impliedBucket;
  });
  const toggle = el('toggle-other-buckets');
  toggle.hidden = !impliedBucket;
  toggle.textContent = bucketsExpanded ? 'Just show the inferred bucket' : 'Show Main/Reserve/Extras separately';
}

function renderSearchResults(query) {
  const q = query.trim().toLowerCase();
  const container = el('search-results');
  if (!q) {
    container.innerHTML = '';
    return;
  }
  const matches = catalog
    .filter((c) => c.name.toLowerCase().includes(q) || (c.subname || '').toLowerCase().includes(q))
    .slice(0, 25);
  container.innerHTML = matches
    .map(
      (c) => `
    <div class="search-result-item" data-id="${c.id}">
      <div>
        <div>${c.name}${c.subname ? ` <span class="search-result-meta">— ${c.subname}</span>` : ''}</div>
        <div class="search-result-meta">${c.set?.name || ''} · ${c.rarity}</div>
      </div>
    </div>
  `
    )
    .join('');
  container.querySelectorAll('.search-result-item').forEach((item) => {
    item.addEventListener('click', () => selectCard(item.dataset.id));
  });
}

function selectCard(id) {
  selected = catalog.find((c) => c.id === id);
  if (!selected) return;
  clearGiveAway();
  bucketsExpanded = false;
  el('selected-card').hidden = false;
  el('selected-name').textContent = selected.name;
  el('selected-subname').textContent = selected.subname || '';
  el('selected-subname').hidden = !selected.subname;
  el('selected-meta').textContent = `${selected.set?.name || ''} · ${selected.rarity} · ${selected.cardType}`;
  el('selected-rules').innerHTML = renderRulesText(selected.rulesText);
  el('selected-faq').innerHTML = faqHtml(selected.slug);
  el('record-status').textContent = '';
  el('record-status').className = 'status-line';
  applyBucketVisibility();
  updatePendingCounts();
}

function renderGiveAwayResults(query) {
  const q = query.trim().toLowerCase();
  const container = el('give-away-results');
  if (!q) {
    container.innerHTML = '';
    return;
  }
  const matches = catalog
    .filter((c) => c.name.toLowerCase().includes(q) || (c.subname || '').toLowerCase().includes(q))
    .slice(0, 25);
  container.innerHTML = matches
    .map(
      (c) => `
    <div class="search-result-item" data-id="${c.id}">
      <div>
        <div>${c.name}${c.subname ? ` <span class="search-result-meta">— ${c.subname}</span>` : ''}</div>
        <div class="search-result-meta">${c.set?.name || ''} · ${c.rarity}</div>
      </div>
    </div>
  `
    )
    .join('');
  container.querySelectorAll('.search-result-item').forEach((item) => {
    item.addEventListener('click', () => selectGiveAway(item.dataset.id));
  });
}

function selectGiveAway(id) {
  giveAway = catalog.find((c) => c.id === id);
  if (!giveAway) return;
  el('give-away-search').value = '';
  el('give-away-results').innerHTML = '';
  el('give-away-search').hidden = true;
  el('give-away-chip').hidden = false;
  el('give-away-name').textContent = giveAway.displayName || giveAway.name;
}

function clearGiveAway() {
  giveAway = null;
  el('give-away-chip').hidden = true;
  el('give-away-search').hidden = false;
}

function pendingDeltaFor(id, bucket) {
  return pending.filter((p) => p.id === id && p.bucket === bucket).reduce((sum, p) => sum + p.delta, 0);
}

function updatePendingCounts() {
  if (!selected) return;
  ['main', 'reserve', 'extras'].forEach((bucket) => {
    el(`pending-${bucket}`).textContent = pendingDeltaFor(selected.id, bucket);
  });
}

async function adjust(bucket, delta) {
  if (!selected) return;
  const buttons = document.querySelectorAll('.bucket-action-row button');
  buttons.forEach((b) => (b.disabled = true));
  const status = el('record-status');
  status.textContent = 'Saving...';
  status.className = 'status-line';
  try {
    const { content, sha } = await ghGetFile('docs/data/pending-changes.json');
    const ts = new Date().toISOString();
    content.push({
      id: selected.id,
      name: selected.displayName || selected.name,
      bucket,
      delta,
      ts
    });
    let message = `Record: ${delta > 0 ? '+' : ''}${delta} ${bucket} — ${selected.name}`;

    // A trade-away is only implied by a positive pickup (+1), not by
    // undoing a mistaken click (-1) - that shouldn't also silently give
    // the traded card back.
    const tradedAway = delta > 0 && giveAway;
    if (tradedAway) {
      content.push({
        id: giveAway.id,
        name: giveAway.displayName || giveAway.name,
        bucket: 'extras',
        delta: -1,
        ts
      });
      message += ` (traded away ${giveAway.name})`;
    }

    await ghPutFile('docs/data/pending-changes.json', content, sha, message);
    pending = content;
    updatePendingCounts();
    renderPending();
    status.textContent = tradedAway ? `Saved. Also queued -1 Extras for ${giveAway.name}.` : 'Saved.';
    status.classList.add('ok');
    if (tradedAway) clearGiveAway();
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('error');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function renderPending() {
  const list = el('pending-list');
  if (!pending.length) {
    list.innerHTML = '<div class="empty-state">Nothing queued yet.</div>';
    return;
  }
  list.innerHTML = pending
    .slice()
    .reverse()
    .map(
      (p) => `
    <div class="pending-item">
      <span>${p.name} — ${p.bucket}</span>
      <span class="pending-delta ${p.delta > 0 ? 'positive' : 'negative'}">${p.delta > 0 ? '+' : ''}${p.delta}</span>
    </div>
  `
    )
    .join('');
}

async function onSaveToken() {
  const input = el('token-input');
  const token = input.value.trim();
  if (!token) return;
  const status = el('token-status');
  status.textContent = 'Checking...';
  status.className = 'status-line';
  const ok = await verifyToken(token);
  if (!ok) {
    status.textContent = 'That token could not access the repo. Check it has Contents read/write access to this specific repo.';
    status.classList.add('error');
    return;
  }
  setToken(token);
  location.reload();
}

init();
