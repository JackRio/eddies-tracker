let catalog = [];
let pending = [];
let selected = null;

const el = (id) => document.getElementById(id);

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
    [catalog, pending] = await Promise.all([
      fetchJson('data/catalog.json'),
      fetchJson('data/pending-changes.json')
    ]);
  } catch (err) {
    el('search-results').innerHTML = `<div class="empty-state">Couldn't load data: ${err.message}</div>`;
    return;
  }

  attachControls();
  renderPending();

  const params = new URLSearchParams(location.search);
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
  el('selected-card').hidden = false;
  el('selected-name').textContent = selected.name;
  el('selected-subname').textContent = selected.subname || '';
  el('selected-subname').hidden = !selected.subname;
  el('selected-meta').textContent = `${selected.set?.name || ''} · ${selected.rarity} · ${selected.cardType}`;
  el('record-status').textContent = '';
  el('record-status').className = 'status-line';
  updatePendingCounts();
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
    content.push({
      id: selected.id,
      name: selected.displayName || selected.name,
      bucket,
      delta,
      ts: new Date().toISOString()
    });
    await ghPutFile(
      'docs/data/pending-changes.json',
      content,
      sha,
      `Record: ${delta > 0 ? '+' : ''}${delta} ${bucket} — ${selected.name}`
    );
    pending = content;
    updatePendingCounts();
    renderPending();
    status.textContent = 'Saved.';
    status.classList.add('ok');
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
