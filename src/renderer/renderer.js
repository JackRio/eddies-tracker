let allCards = [];
let collection = {};
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

function render() {
  const cards = getFilteredCards();
  const grid = el('card-grid');
  el('result-count').textContent = `${cards.length} printing${cards.length === 1 ? '' : 's'}`;
  el('empty-state').hidden = cards.length !== 0;

  grid.innerHTML = cards.map(cardTileHtml).join('');

  grid.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onCounterClick);
  });

  updateStats();
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

function cardTileHtml(c) {
  const main = getBucketCount(c.id, 'main');
  const total = getTotalCount(c.id);
  const isMain = main > 0;
  const isOwnedOnly = total > 0 && main === 0;
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
    <div class="card-tile ${isMain ? 'owned' : ''} ${isOwnedOnly ? 'owned-other' : ''}" data-card-id="${c.id}">
      <div class="card-image-wrap">
        <img src="${c.imageUrl}" alt="${c.displayName}" loading="lazy" />
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

async function refreshBackupList() {
  const backups = await window.api.listBackups();
  const select = el('backup-select');
  if (!backups.length) {
    select.innerHTML = '<option value="">No backups yet</option>';
    el('restore-backup-btn').disabled = true;
    return;
  }
  select.innerHTML = backups
    .map((b) => `<option value="${b.filename}">${new Date(b.mtime).toLocaleString()}</option>`)
    .join('');
  el('restore-backup-btn').disabled = false;
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

async function onRestoreBackup() {
  const select = el('backup-select');
  const filename = select.value;
  if (!filename) return;
  const label = select.options[select.selectedIndex].textContent;
  if (!confirm(`Restore collection from backup saved at ${label}? Your current state will be backed up first.`)) return;
  collection = await window.api.restoreBackup(filename);
  await refreshBackupList();
  render();
}

function attachControls() {
  el('refresh-btn').addEventListener('click', doRefresh);
  el('collection-view-btn').addEventListener('click', () => window.api.openCollectionView());
  el('save-backup-btn').addEventListener('click', onSaveBackup);
  el('restore-backup-btn').addEventListener('click', onRestoreBackup);
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
}

attachControls();
init();
