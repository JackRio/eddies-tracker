let allCards = [];
let collection = {};
let faqData = {};
let state = {
  search: '',
  ownership: 'all',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'welcometonightcitybeta',
  sort: 'default'
};

const el = (id) => document.getElementById(id);

const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];
const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
// Ordered common -> rarest, by actual printing population in the card pool.
const RARITY_ORDER = [
  'Common',
  'Uncommon',
  'Rare',
  'Epic',
  'Nova Rare',
  'Iconic Legend',
  'Iconic Other',
  'Secret',
  'Iconic Secret'
];

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

// Card rulesText comes from the API with {Keyword} tokens (e.g. "{Call}",
// "{Go Solo}") standing in for the game's official badge icons. Swap each
// one for the matching SVG (scraped from cyberpunktcg.com's own rules-faq
// page, same icons/colors as the real cards) instead of showing the raw
// bracketed text. Kept in sync with the same helper in collection.js.
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
  try {
    const cached = await window.api.getCards();
    if (cached && cached.cards && cached.cards.length) {
      allCards = cached.cards;
      setLastUpdated(cached.fetchedAt);
    } else {
      await doRefresh();
    }
    collection = await window.api.getCollection();
    try {
      faqData = await fetch('faq-data.json').then((r) => r.json());
    } catch {
      faqData = {};
    }
    buildFilterOptions();
    render();
    await refreshBackupList();
    el('loading-state').hidden = true;
  } catch (err) {
    console.error('INIT ERROR:', err);
    el('loading-state').textContent = 'Error loading cards: ' + err.message;
  }
}

function setLastUpdated(iso) {
  if (!iso) return;
  const d = new Date(iso);
  el('last-updated').textContent = `Last updated: ${d.toLocaleString()}`;
}

async function doRefresh() {
  const btn = el('refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';
  try {
    const cache = await window.api.refreshCards();
    allCards = cache.cards;
    setLastUpdated(cache.fetchedAt);
    buildFilterOptions();
    render();
  } catch (err) {
    alert('Failed to refresh card data: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh Card Data';
  }
}

function buildFilterOptions() {
  const colors = [...new Set(allCards.map((c) => c.color).filter(Boolean))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(allCards.map((c) => c.cardType).filter(Boolean))]
    .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const rarities = [...new Set(allCards.map((c) => c.rarity).filter(Boolean))]
    .sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
  const sets = [...new Map(allCards.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);

  renderChipGroup('color-filters', colors, state.colors);
  renderChipGroup('type-filters', types, state.types);
  renderChipGroup('rarity-filters', rarities, state.rarities);

  const setSelect = el('set-filter');
  setSelect.innerHTML = '<option value="all">All Sets</option>' +
    sets.map((s) => `<option value="${s.code}">${s.name}</option>`).join('');
  if (sets.some((s) => s.code === state.set)) {
    setSelect.value = state.set;
  }
}

function renderChipGroup(containerId, values, activeSet) {
  const container = el(containerId);
  container.innerHTML = values.map((v) => `<div class="chip" data-value="${v}">${v}</div>`).join('');
  container.querySelectorAll('.chip').forEach((chip) => {
    if (activeSet.has(chip.dataset.value)) chip.classList.add('active');
    chip.addEventListener('click', () => {
      const val = chip.dataset.value;
      if (activeSet.has(val)) activeSet.delete(val);
      else activeSet.add(val);
      chip.classList.toggle('active');
      render();
    });
  });
}

function getFilteredCards() {
  let cards = allCards.filter((c) => {
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = `${c.name} ${c.subname || ''} ${c.rulesText || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.colors.size && !state.colors.has(c.color)) return false;
    if (state.types.size && !state.types.has(c.cardType)) return false;
    if (state.rarities.size && !state.rarities.has(c.rarity)) return false;
    if (state.set !== 'all' && c.set?.code !== state.set) return false;
    const owned = getTotalCount(c.id);
    if (state.ownership === 'owned' && owned === 0) return false;
    if (state.ownership === 'missing' && owned > 0) return false;
    return true;
  });

  cards = cards.slice().sort((a, b) => {
    switch (state.sort) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'cost':
        return (a.cost ?? 99) - (b.cost ?? 99);
      case 'power':
        return (b.power ?? -1) - (a.power ?? -1);
      case 'rarity':
        return RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
      default:
        return (
          COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
          TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) ||
          (a.cost ?? 0) - (b.cost ?? 0)
        );
    }
  });

  return cards;
}

function getBucketCount(cardId, bucket) {
  return collection[cardId]?.[bucket] || 0;
}

function getTotalCount(cardId) {
  return getBucketCount(cardId, 'main') + getBucketCount(cardId, 'reserve') + getBucketCount(cardId, 'extras');
}

let poppedRowCards = [];
let poppedIndex = -1;

function render() {
  const cards = getFilteredCards();
  poppedRowCards = cards;
  const grid = el('card-grid');
  el('result-count').textContent = `${cards.length} printing${cards.length === 1 ? '' : 's'}`;
  el('empty-state').hidden = cards.length !== 0;

  grid.innerHTML = cards.map(cardTileHtml).join('');

  grid.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onCounterClick);
  });

  grid.querySelectorAll('.card-tile').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      openPopped(tile.dataset.cardId);
    });
  });

  grid.querySelectorAll('.card-image-wrap').forEach((wrap) => {
    const img = wrap.querySelector('img');
    const markLoaded = () => {
      img.classList.add('loaded');
      wrap.classList.add('img-loaded');
    };
    if (img.complete && img.naturalWidth > 0) markLoaded();
    else {
      img.addEventListener('load', markLoaded);
      img.addEventListener('error', markLoaded);
    }
  });

  updateStats();

  // The popup may be open across a re-render (e.g. clicking +/- inside it),
  // so refresh its contents in place instead of leaving stale counts shown.
  if (!el('popped-overlay').hidden && poppedIndex >= 0 && poppedRowCards[poppedIndex]) {
    openPopped(poppedRowCards[poppedIndex].id);
  }
}

function poppedOwnedControlsHtml(c) {
  const cap = mainSetCap(c.cardType);
  return BUCKETS.map(
    ({ key, label, showMax }) => `
          <div class="mini-counter">
            <span class="mini-label">${label}</span>
            <button data-action="dec" data-bucket="${key}" data-card-id="${c.id}">-</button>
            <span class="counter-value">${getBucketCount(c.id, key)}</span>
            <button data-action="inc" data-bucket="${key}" data-card-id="${c.id}">+</button>
            ${showMax ? `<button class="mini-max-btn" data-action="setmax" data-bucket="${key}" data-cap="${cap}" data-card-id="${c.id}" title="Set ${label} to ${cap}">MAX</button>` : ''}
          </div>`
  ).join('');
}

function stepPopped(delta) {
  if (!poppedRowCards.length) return;
  const next = (poppedIndex + delta + poppedRowCards.length) % poppedRowCards.length;
  openPopped(poppedRowCards[next].id);
}

function openPopped(cardId) {
  const c = poppedRowCards.find((x) => x.id === cardId) || allCards.find((x) => x.id === cardId);
  if (!c) return;

  poppedIndex = poppedRowCards.findIndex((x) => x.id === cardId);

  el('popped-img').src = c.imageUrl;
  el('popped-img').alt = c.displayName;
  el('popped-name').textContent = c.name;
  el('popped-subname').textContent = c.subname || '';
  el('popped-subname').hidden = !c.subname;

  const meta = [
    c.cost != null ? `Cost ${c.cost}` : '',
    c.power != null ? `Power ${c.power}` : '',
    c.ram != null ? `RAM ${c.ram}` : '',
    c.cardType
  ]
    .filter(Boolean)
    .join(' · ');
  el('popped-meta').textContent = meta;

  const rarityEl = el('popped-rarity');
  rarityEl.textContent = c.rarity || '';
  rarityEl.className = `popped-rarity ${rarityClass(c.rarity)}`;

  el('popped-owned-controls').innerHTML = poppedOwnedControlsHtml(c);
  el('popped-owned-controls').querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onCounterClick);
  });

  el('popped-rules').innerHTML = renderRulesText(c.rulesText);
  el('popped-faq').innerHTML = faqHtml(c.slug);

  const overlay = el('popped-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closePopped() {
  const overlay = el('popped-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 200);
}

// Deck legality: a unique Legend only needs 1 copy in your Main set; every
// other card type (Unit/Gear/Program) can run up to 3.
function mainSetCap(cardType) {
  return cardType === 'Legend' ? 1 : 3;
}

// Only Main and Reserve get a "Max" shortcut - Extras is just raw
// inventory with no target count to jump to.
const BUCKETS = [
  { key: 'main', label: 'Main', showMax: true },
  { key: 'reserve', label: 'Rsv', showMax: true },
  { key: 'extras', label: 'Xtra', showMax: false }
];

// Each bucket gets its own border color; a card held in more than one
// bucket gets a banded border instead of a single color, stacked top to
// bottom in this fixed order so it reads the same way on every card.
const OWNERSHIP_BANDS = [
  { bucket: 'main', color: 'var(--yellow)', cls: 'own-main' },
  { bucket: 'extras', color: 'var(--purple)', cls: 'own-extras' },
  { bucket: 'reserve', color: 'var(--cyan)', cls: 'own-reserve' }
];

function ownershipVisual(cardId) {
  const active = OWNERSHIP_BANDS.filter((b) => getBucketCount(cardId, b.bucket) > 0);
  if (active.length === 0) return { cls: '', style: '' };
  if (active.length === 1) return { cls: active[0].cls, style: '' };

  const step = 100 / active.length;
  const stops = active
    .map((b, i) => `${b.color} ${(i * step).toFixed(2)}%, ${b.color} ${((i + 1) * step).toFixed(2)}%`)
    .join(', ');
  return { cls: 'own-multi', style: `--band-gradient: linear-gradient(to bottom, ${stops});` };
}

function cardTileHtml(c) {
  const visual = ownershipVisual(c.id);
  const total = getTotalCount(c.id);
  const cap = mainSetCap(c.cardType);
  const statLine = [
    c.cost != null ? `<span>CST ${c.cost}</span>` : '',
    c.power != null ? `<span>PWR ${c.power}</span>` : '',
    c.ram != null ? `<span>RAM ${c.ram}</span>` : ''
  ].join('');

  const bucketRows = BUCKETS.map(
    ({ key, label, showMax }) => `
          <div class="mini-counter">
            <span class="mini-label">${label}</span>
            <button data-action="dec" data-bucket="${key}" data-card-id="${c.id}">-</button>
            <span class="counter-value">${getBucketCount(c.id, key)}</span>
            <button data-action="inc" data-bucket="${key}" data-card-id="${c.id}">+</button>
            ${showMax ? `<button class="mini-max-btn" data-action="setmax" data-bucket="${key}" data-cap="${cap}" data-card-id="${c.id}" title="Set ${label} to ${cap}">MAX</button>` : ''}
          </div>`
  ).join('');

  return `
    <div class="card-tile ${visual.cls}" style="${visual.style}" data-card-id="${c.id}">
      <div class="card-image-wrap">
        <div class="card-shimmer"></div>
        <img src="${c.imageUrl}" alt="${c.displayName}" loading="lazy" decoding="async" />
        ${total > 0 ? `<div class="owned-badge">${total}</div>` : ''}
      </div>
      <div class="color-bar ${c.color || ''}"></div>
      <div class="card-info">
        <div class="card-name">${c.name}</div>
        ${c.subname ? `<div class="card-subname">${c.subname}</div>` : ''}
        <div class="card-meta">${statLine}<span>${c.cardType}</span></div>
        <div class="card-rarity ${rarityClass(c.rarity)}">${c.rarity}</div>
        <div class="owned-controls">${bucketRows}
        </div>
      </div>
    </div>
  `;
}

async function onCounterClick(e) {
  const cardId = e.currentTarget.dataset.cardId;
  const action = e.currentTarget.dataset.action;
  const bucket = e.currentTarget.dataset.bucket;

  let next;
  if (action === 'setmax') {
    next = Number(e.currentTarget.dataset.cap);
  } else {
    const current = getBucketCount(cardId, bucket);
    next = action === 'inc' ? current + 1 : Math.max(0, current - 1);
  }

  collection = await window.api.setCollection(cardId, bucket, next);
  render();
}

function updateStats() {
  // Stats track whichever Set is selected in the filter (all sets stay
  // selectable; this just decides what "owned" is measured against).
  const statCards = state.set === 'all' ? allCards : allCards.filter((c) => c.set?.code === state.set);
  const totalUnique = statCards.length;
  const ownedUnique = statCards.filter((c) => getTotalCount(c.id) > 0).length;
  const totalCopies = statCards.reduce((sum, c) => sum + getTotalCount(c.id), 0);
  const pct = totalUnique ? Math.round((ownedUnique / totalUnique) * 100) : 0;

  el('stat-owned').textContent = `${ownedUnique}/${totalUnique}`;
  el('stat-complete').textContent = `${pct}%`;
  el('stat-total-copies').textContent = totalCopies;

  const setName = state.set === 'all' ? 'All Sets' : (statCards[0]?.set?.name || state.set);
  el('stat-tracking').textContent = `Tracking: ${setName}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Electron's window.prompt() is unreliable (silently no-ops in some builds),
// which is why "Rename" used to do nothing. Renaming and destructive actions
// (restore/overwrite) use inline UI states on the item itself instead of any
// native dialog.
let backupUiState = { filename: null, mode: null };

async function refreshBackupList() {
  const backups = await window.api.listBackups();
  const container = el('backup-list');
  if (!backups.length) {
    container.innerHTML = '<div class="backup-empty">No saves yet</div>';
    return;
  }
  container.innerHTML = backups.map(backupItemHtml).join('');
  container.querySelectorAll('[data-backup-action]').forEach((btn) => {
    btn.addEventListener('click', onBackupAction);
  });
  container.querySelectorAll('.backup-label[data-renameable]').forEach((label) => {
    label.addEventListener('dblclick', () => {
      backupUiState = { filename: label.dataset.filename, mode: 'rename' };
      refreshBackupList();
    });
  });
  const renameInput = container.querySelector('.backup-rename-input');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        container.querySelector('[data-backup-action="confirm-rename"]').click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        container.querySelector('[data-backup-action="cancel"]').click();
      }
    });
  }
}

function backupItemHtml(b) {
  const date = new Date(b.mtime).toLocaleString();
  const isActive = backupUiState.filename === b.filename;

  if (isActive && backupUiState.mode === 'rename') {
    return `
      <div class="backup-item ${b.locked ? 'locked' : ''}">
        <div class="backup-info">
          <input type="text" class="backup-rename-input" data-filename="${b.filename}" value="${escapeHtml(b.label || '')}" placeholder="${date}" />
        </div>
        <div class="backup-actions">
          <button data-backup-action="confirm-rename" data-filename="${b.filename}">Save</button>
          <button data-backup-action="cancel" data-filename="${b.filename}">Cancel</button>
        </div>
      </div>
    `;
  }

  if (isActive && (backupUiState.mode === 'confirm-restore' || backupUiState.mode === 'confirm-overwrite')) {
    const verb = backupUiState.mode === 'confirm-restore' ? 'Restore' : 'Overwrite';
    const confirmAction = backupUiState.mode === 'confirm-restore' ? 'confirm-restore' : 'confirm-overwrite';
    return `
      <div class="backup-item ${b.locked ? 'locked' : ''}">
        <div class="backup-info">
          <div class="backup-label">${b.label ? escapeHtml(b.label) : date}</div>
          <div class="backup-date">${verb} this save?</div>
        </div>
        <div class="backup-actions">
          <button class="backup-danger" data-backup-action="${confirmAction}" data-filename="${b.filename}">Yes, ${verb}</button>
          <button data-backup-action="cancel" data-filename="${b.filename}">Cancel</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="backup-item ${b.locked ? 'locked' : ''}">
      <div class="backup-info">
        <div class="backup-label" data-renameable data-filename="${b.filename}" title="Double-click to rename">${b.label ? escapeHtml(b.label) : date}</div>
        ${b.label ? `<div class="backup-date">${date}</div>` : ''}
      </div>
      <div class="backup-actions">
        <button data-backup-action="ask-restore" data-filename="${b.filename}">Restore</button>
        <button data-backup-action="ask-overwrite" data-filename="${b.filename}">Overwrite</button>
        <button data-backup-action="lock" data-filename="${b.filename}" data-locked="${b.locked}">${b.locked ? 'Unlock' : 'Lock'}</button>
      </div>
    </div>
  `;
}

async function onSaveBackup() {
  const btn = el('save-backup-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await window.api.backupCollection();
    await refreshBackupList();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function onPublishSite() {
  const btn = el('publish-site-btn');
  const status = el('publish-status');
  btn.disabled = true;
  btn.textContent = 'Publishing...';
  status.hidden = false;
  status.className = 'publish-status';
  status.textContent = 'Pulling latest, applying any phone-recorded changes, and pushing...';
  try {
    const result = await window.api.publishSite();
    collection = result.collection;
    render();
    status.classList.add('publish-status-ok');
    status.textContent = result.steps.join(' ');
  } catch (err) {
    status.classList.add('publish-status-error');
    status.textContent = `Publish failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish Site';
  }
}

async function onBackupAction(e) {
  const action = e.currentTarget.dataset.backupAction;
  const filename = e.currentTarget.dataset.filename;

  if (action === 'ask-restore' || action === 'ask-overwrite') {
    backupUiState = { filename, mode: action === 'ask-restore' ? 'confirm-restore' : 'confirm-overwrite' };
    await refreshBackupList();
    return;
  }

  if (action === 'cancel') {
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    return;
  }

  if (action === 'confirm-rename') {
    const input = document.querySelector(`.backup-rename-input[data-filename="${CSS.escape(filename)}"]`);
    const next = input ? input.value.trim() : '';
    await window.api.renameBackup(filename, next);
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    return;
  }

  if (action === 'confirm-restore') {
    collection = await window.api.restoreBackup(filename);
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    render();
    return;
  }

  if (action === 'confirm-overwrite') {
    await window.api.overwriteBackup(filename);
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    return;
  }

  if (action === 'lock') {
    const isLocked = e.currentTarget.dataset.locked === 'true';
    await window.api.setBackupLocked(filename, !isLocked);
    await refreshBackupList();
    return;
  }
}

function attachControls() {
  el('win-minimize').addEventListener('click', () => window.api.windowMinimize());
  el('win-maximize').addEventListener('click', () => window.api.windowToggleMaximize());
  el('win-close').addEventListener('click', () => window.api.windowClose());
  el('refresh-btn').addEventListener('click', doRefresh);
  el('collection-view-btn').addEventListener('click', () => window.api.openCollectionView());
  el('save-backup-btn').addEventListener('click', onSaveBackup);
  el('publish-site-btn').addEventListener('click', onPublishSite);
  el('search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });
  el('ownership-filter').addEventListener('change', (e) => {
    state.ownership = e.target.value;
    render();
  });
  el('set-filter').addEventListener('change', (e) => {
    state.set = e.target.value;
    render();
  });
  el('sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
  el('popped-overlay').addEventListener('click', (e) => {
    if (e.target === el('popped-overlay')) closePopped();
  });
  el('popped-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    stepPopped(-1);
  });
  el('popped-next').addEventListener('click', (e) => {
    e.stopPropagation();
    stepPopped(1);
  });
  document.addEventListener('keydown', (e) => {
    if (!el('popped-overlay').classList.contains('open')) return;
    if (e.key === 'Escape') closePopped();
    if (e.key === 'ArrowLeft') stepPopped(-1);
    if (e.key === 'ArrowRight') stepPopped(1);
  });
}

attachControls();
init();
