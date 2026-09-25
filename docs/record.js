let catalog = [];
let pending = [];
let selected = null;
let faqData = {};
let giveAway = null;
let giveAwayBucket = 'extras';
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
  renderBuildInfo();

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
  // Syncing is manual (the "Commit Trades" link) - these two are just a safety
  // net so anything staged but never synced (e.g. the tab was closed) still
  // gets a chance to commit, without auto-syncing *during* active editing.
  if (Object.keys(getStagedDeltas()).length) flushStaged();
  window.addEventListener('pagehide', () => {
    if (Object.keys(getStagedDeltas()).length) flushStaged();
  });

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
  document.querySelectorAll('.give-away-bucket-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      giveAwayBucket = btn.dataset.bucket;
      document.querySelectorAll('.give-away-bucket-btn').forEach((b) => b.classList.toggle('active', b === btn));
      updateGiveAwayOwned();
    });
  });
  el('refresh-pending-link').addEventListener('click', (e) => {
    e.preventDefault();
    refreshPending();
  });
  el('sync-now-link').addEventListener('click', (e) => {
    e.preventDefault();
    clearTimeout(flushTimer);
    flushStaged();
  });
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
        <div class="search-result-meta">${c.set?.name || ''} · ${c.rarity}${c.price != null ? ` · ${formatEur(c.price)}${c.priceGuess ? '?' : ''}` : ''}</div>
      </div>
    </div>
  `
    )
    .join('');
  container.querySelectorAll('.search-result-item').forEach((item) => {
    item.addEventListener('click', () => selectCard(item.dataset.id));
  });
}

// Cardmarket trend price snapshot from catalog.json (see needed.js).
function formatEur(v) {
  return `€${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
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
  const cmName = selected.cmName || `${selected.name}${selected.subname ? ` - ${selected.subname}` : ''}`;
  el('selected-price').innerHTML =
    (selected.price != null
      ? `<span class="price-value${selected.priceGuess ? ' price-guess' : ''}">${formatEur(selected.price)}${selected.priceGuess ? ' (best guess)' : ''}</span> Cardmarket trend · `
      : '') +
    `<a href="https://www.cardmarket.com/en/Cyberpunk/Products/Search?searchString=${encodeURIComponent(cmName)}" target="_blank" rel="noopener">View on Cardmarket ↗</a>`;
  el('selected-rules').innerHTML = renderRulesText(selected.rulesText);
  el('selected-faq').innerHTML = faqHtml(selected.slug);
  el('record-status').textContent = '';
  el('record-status').className = 'status-line';
  applyBucketVisibility();
  updateOwnedCounts();
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
  giveAwayBucket = 'extras';
  el('give-away-search').value = '';
  el('give-away-results').innerHTML = '';
  el('give-away-search').hidden = true;
  el('give-away-chip').hidden = false;
  el('give-away-name').textContent = giveAway.displayName || giveAway.name;
  el('give-away-bucket-picker').hidden = false;
  document.querySelectorAll('.give-away-bucket-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.bucket === giveAwayBucket);
  });
  updateGiveAwayOwned();
}

// Shows what you currently have in whichever bucket is picked for the
// give-away card, so it's clear how many you'll have left after this trade
// - same "last-published + anything staged/queued since" math as Owned.
function updateGiveAwayOwned() {
  if (!giveAway) return;
  const owned = (giveAway[giveAwayBucket] || 0) + pendingDeltaFor(giveAway.id, giveAwayBucket);
  el('give-away-owned').textContent = `${owned} owned in ${giveAwayBucket}`;
}

function clearGiveAway() {
  giveAway = null;
  giveAwayBucket = 'extras';
  el('give-away-chip').hidden = true;
  el('give-away-bucket-picker').hidden = true;
  el('give-away-search').hidden = false;
}

// Committed (from GitHub) + staged-but-not-yet-committed (this device,
// this browser only) both count toward what's "queued" for a card.
function pendingDeltaFor(id, bucket) {
  const committed = pending.filter((p) => p.id === id && p.bucket === bucket).reduce((sum, p) => sum + p.delta, 0);
  return committed + stagedDeltaFor(id, bucket);
}

// "Owned" = the last-published snapshot's count for this bucket (catalog.js
// entries carry main/reserve/extras from collection.json as of the last
// desktop Publish) plus whatever's been queued/staged since - i.e. what
// you're about to actually own, not a stale number from before this trade.
function updateOwnedCounts() {
  if (!selected) return;
  ['main', 'reserve', 'extras'].forEach((bucket) => {
    const owned = (selected[bucket] || 0) + pendingDeltaFor(selected.id, bucket);
    el(`owned-${bucket}`).textContent = owned;
  });
}

let flushTimer = null;
let isFlushing = false;
let reflushNeeded = false;

// The actual +/- click handler: instant, local, no network call at all.
// The real GitHub commit happens later in flushStaged(), batched.
function adjust(bucket, delta) {
  if (!selected) return;
  // A trade-away is only implied by a positive pickup (+1), not by undoing
  // a mistaken click (-1) - that shouldn't also silently give the traded
  // card back.
  const tradedAway = delta > 0 && giveAway;
  stageDelta(selected.id, selected.displayName || selected.name, bucket, delta);
  if (tradedAway) stageDelta(giveAway.id, giveAway.displayName || giveAway.name, giveAwayBucket, -1);

  updateOwnedCounts();
  renderPending();
  const status = el('record-status');
  status.textContent = tradedAway
    ? `Queued. Also queued -1 ${giveAwayBucket} for ${giveAway.name}. Click "Commit Trades" when ready.`
    : 'Queued. Click "Commit Trades" when ready.';
  status.className = 'status-line ok';
  if (tradedAway) clearGiveAway();
}

// Commits everything staged since the last flush in one write - so 5 rapid
// clicks (even across different cards) become 1 commit/Pages rebuild, not
// 5, and same-card clicks that net to 0 never get committed at all.
async function flushStaged() {
  if (isFlushing) {
    reflushNeeded = true;
    return;
  }
  const staged = Object.values(getStagedDeltas());
  if (!staged.length) return;

  isFlushing = true;
  const status = el('sync-status');
  status.textContent = 'Syncing to GitHub...';
  status.className = 'status-line';
  try {
    const next = await ghUpdateJsonFile(
      'docs/data/pending-changes.json',
      (content) => [...content, ...staged],
      () =>
        staged.length === 1
          ? `Record: ${staged[0].delta > 0 ? '+' : ''}${staged[0].delta} ${staged[0].bucket} — ${staged[0].name}`
          : `Record: ${staged.length} changes`,
      3,
      (attempt, total) => {
        status.textContent = attempt === 1 ? 'Syncing to GitHub...' : `Syncing... (retry ${attempt}/${total} after a conflict with another write)`;
      }
    );
    pending = next;
    // Only clear the deltas we actually just committed - not anything
    // staged in the moment between reading `staged` above and now.
    const map = getStagedDeltas();
    staged.forEach((s) => {
      const key = `${s.id}::${s.bucket}`;
      if (map[key]?.ts === s.ts) delete map[key];
    });
    setStagedDeltas(map);
    renderPending();
    if (selected) updateOwnedCounts();
    status.textContent = `Synced ${staged.length} change${staged.length === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}.`;
    status.classList.add('ok');
  } catch (err) {
    status.textContent = /\(409\)/.test(err.message)
      ? 'Kept hitting a conflict with another write after 3 tries - will retry shortly.'
      : `Sync failed, will retry: ${err.message}`;
    status.classList.add('error');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushStaged, 8000);
  } finally {
    isFlushing = false;
    if (reflushNeeded) {
      reflushNeeded = false;
      flushStaged();
    }
  }
}

function renderPending() {
  const list = el('pending-list');
  const combined = [
    ...pending.map((p) => ({ ...p, synced: true })),
    ...Object.values(getStagedDeltas()).map((p) => ({ ...p, synced: false }))
  ];
  if (!combined.length) {
    list.innerHTML = '<div class="empty-state">Nothing queued yet.</div>';
    return;
  }
  list.innerHTML = combined
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    .reverse()
    .map(
      (p) => `
    <div class="pending-item">
      <div>
        <div>${p.name} — ${p.bucket}${p.synced ? '' : ' <span class="pending-unsynced">· syncing soon</span>'}</div>
        <div class="pending-time">${p.ts ? new Date(p.ts).toLocaleString() : ''}</div>
      </div>
      <span class="pending-delta ${p.delta > 0 ? 'positive' : 'negative'}">${p.delta > 0 ? '+' : ''}${p.delta}</span>
    </div>
  `
    )
    .join('');
}

// This list's committed half only reflects what THIS tab has fetched/synced
// since load - another device's writes (or a desktop Publish clearing it)
// won't show up until refreshed, which otherwise looks like nothing
// happened even though something did.
async function refreshPending() {
  const status = el('pending-status');
  status.textContent = 'Refreshing from GitHub...';
  status.className = 'status-line';
  try {
    const { content } = await ghGetFile('docs/data/pending-changes.json');
    pending = content;
    renderPending();
    if (selected) updateOwnedCounts();
    status.textContent = `Up to date as of ${new Date().toLocaleTimeString()}.`;
    status.classList.add('ok');
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('error');
  }
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
