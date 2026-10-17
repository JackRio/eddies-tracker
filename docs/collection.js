let pendingChanges = [];
let catalog = [];

const VIEWS = ['lg', 'md', 'sm', 'list'];
const STATUSES = [
  { key: 'all', label: 'All' },
  { key: 'full', label: 'Full' },
  { key: 'partial', label: 'Partial' },
  { key: 'missing', label: 'Missing' }
];

let state = {
  bucket: 'main',
  status: 'all',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'all',
  unique: false,
  search: '',
  sort: 'default',
  view: 'md'
};

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];

// The 9 raw rarity values collapse to the 7 official tiers (same as the old
// Needed page), so all three "Iconic ..." rarities share one button.
const RARITY_GROUPS = [
  { key: 'Common', title: 'Common', icon: 'common', match: ['Common'] },
  { key: 'Uncommon', title: 'Uncommon', icon: 'uncommon', match: ['Uncommon'] },
  { key: 'Rare', title: 'Rare', icon: 'rare', match: ['Rare'] },
  { key: 'Epic', title: 'Epic Rare', icon: 'epic', match: ['Epic'] },
  { key: 'Secret', title: 'Secret Rare', icon: 'secret-rare', match: ['Secret'] },
  { key: 'Iconic', title: 'Iconic Rare', icon: 'iconic-rare', match: ['Iconic Legend', 'Iconic Other', 'Iconic Secret'] },
  { key: 'Nova Rare', title: 'Nova Rare', icon: 'nova-rare', match: ['Nova Rare'] }
];

// Lowest rarity first.
const RARITY_RANK = ['Common', 'Uncommon', 'Rare', 'Epic', 'Secret', 'Iconic Other', 'Iconic Legend', 'Iconic Secret', 'Nova Rare'];
const rarityRank = (r) => { const i = RARITY_RANK.indexOf(r); return i === -1 ? RARITY_RANK.length : i; };

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const rarityClass = (rarity) => 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
const mechKey = (c) => `${c.displayName || c.name}|${c.rulesText || c.cardId}`;

function formatEur(v) {
  return `€${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
}

function loadView() {
  try {
    const v = localStorage.getItem('eddies_collection_view');
    if (VIEWS.includes(v)) state.view = v;
  } catch { /* storage unavailable */ }
}

async function init() {
  renderBuildInfo();
  loadView();
  try {
    [catalog, pendingChanges] = await Promise.all([
      fetchJson('data/catalog.json'),
      fetchJson('data/pending-changes.json').catch(() => [])
    ]);
  } catch (err) {
    el('empty-state').hidden = false;
    el('empty-state').textContent = `Couldn't load data: ${err.message}`;
    return;
  }

  buildFilterOptions();
  attachControls();
  render();

  // Another tab on this device (the Record page) staged a trade.
  window.addEventListener('storage', (e) => {
    if (e.key === 'eddies_staged_deltas') render();
  });
}

function buildFilterOptions() {
  const colors = [...new Set(catalog.map((c) => c.color).filter(Boolean))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(catalog.map((c) => c.cardType).filter(Boolean))]
    .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const present = new Set(catalog.map((c) => c.rarity).filter(Boolean));
  const rarityGroups = RARITY_GROUPS.filter((g) => g.match.some((r) => present.has(r)));
  const sets = [...new Map(catalog.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);

  renderStatusFilters();
  renderChipGroup('color-filters', colors, state.colors, (v) => `color-${v}`);
  renderChipGroup('type-filters', types, state.types, (v) => `type-${v}`);
  renderRarityFilters(rarityGroups);

  const select = el('set-filter');
  select.innerHTML = '<option value="all">All Sets</option>' +
    sets.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
  select.value = sets.some((s) => s.code === state.set) ? state.set : 'all';
  state.set = select.value;
}

function renderStatusFilters() {
  const container = el('status-filters');
  container.innerHTML = STATUSES
    .map((s) => `<div class="chip${state.status === s.key ? ' active' : ''}" data-value="${s.key}" role="button" tabindex="0">${s.label}</div>`)
    .join('');
  container.querySelectorAll('.chip').forEach((chip) => {
    const pick = () => {
      state.status = chip.dataset.value;
      container.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      render();
    };
    chip.addEventListener('click', pick);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });
}

function renderChipGroup(containerId, values, activeSet, extraClass) {
  const container = el(containerId);
  container.innerHTML = values
    .map((v) => `<div class="chip ${extraClass ? extraClass(v) : ''}" data-value="${esc(v)}">${esc(v)}</div>`)
    .join('');
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

function renderRarityFilters(groups) {
  const container = el('rarity-filters');
  container.innerHTML = groups
    .map((g) => `
      <button class="rarity-filter-btn" data-value="${g.key}" title="${g.title}">
        <span class="rarity-icon rarity-icon-${g.icon}"></span>
      </button>
    `)
    .join('');
  container.querySelectorAll('.rarity-filter-btn').forEach((btn) => {
    if (state.rarities.has(btn.dataset.value)) btn.classList.add('active');
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      if (state.rarities.has(val)) state.rarities.delete(val);
      else state.rarities.add(val);
      btn.classList.toggle('active');
      render();
    });
  });
}

function attachControls() {
  document.querySelectorAll('#bucket-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.bucket = btn.dataset.bucket;
      document.querySelectorAll('#bucket-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });
  const syncView = () => document.querySelectorAll('#view-toggle button')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.querySelectorAll('#view-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      try { localStorage.setItem('eddies_collection_view', state.view); } catch { /* ignore */ }
      syncView();
      render();
    });
  });
  syncView();

  const toggleUnique = () => {
    state.unique = !state.unique;
    el('unique-filter').classList.toggle('active', state.unique);
    render();
  };
  el('unique-filter').addEventListener('click', toggleUnique);
  el('unique-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleUnique(); }
  });
  el('set-filter').addEventListener('change', (e) => { state.set = e.target.value; render(); });
  el('search').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); render(); });
  el('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  el('filter-clear').addEventListener('click', () => {
    state.status = 'all';
    state.colors.clear();
    state.types.clear();
    state.rarities.clear();
    state.unique = false;
    state.set = 'all';
    el('unique-filter').classList.remove('active');
    buildFilterOptions();
    render();
  });

  // Desktop: filters are an always-open sidebar. Phone: collapsed.
  const wide = window.matchMedia('(min-width: 960px)');
  const syncFilters = () => { el('filters').open = wide.matches; };
  syncFilters();
  wide.addEventListener('change', syncFilters);
}

// Deltas recorded on the Record page that the desktop app hasn't published
// yet (committed to GitHub, or only staged on this device).
function pendingDeltaFor(id, bucket) {
  const committed = pendingChanges
    .filter((c) => c.id === id && c.bucket === bucket)
    .reduce((sum, c) => sum + (c.delta || 0), 0);
  return committed + stagedDeltaFor(id, bucket);
}

const qtyOf = (c, bucket) => Math.max(0, (c[bucket] || 0) + pendingDeltaFor(c.id, bucket));

// One entry per mechanical card: total owned across every printing, shown as
// the printing you hold most of (ties: lowest rarity, then cheapest).
function collapseUnique(rows, keep) {
  const totals = new Map();
  for (const c of rows) totals.set(mechKey(c), (totals.get(mechKey(c)) || 0) + c.qty);
  const best = new Map();
  for (const c of rows) {
    if (!keep(c)) continue;
    const k = mechKey(c);
    const cur = best.get(k);
    const better = !cur || c.qty > cur.qty ||
      (c.qty === cur.qty && (rarityRank(c.rarity) < rarityRank(cur.rarity) ||
        (rarityRank(c.rarity) === rarityRank(cur.rarity) && (c.price ?? Infinity) < (cur.price ?? Infinity))));
    if (better) best.set(k, c);
  }
  return [...best.entries()].map(([k, c]) => ({ ...c, qty: totals.get(k) || 0 }));
}

const statusOf = (c) => (c.qty <= 0 ? 'missing' : c.qty >= c.cap ? 'full' : 'partial');

const byName = (a, b) => a.name.localeCompare(b.name);
const SORTERS = {
  'default': (a, b) =>
    COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
    TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) || byName(a, b),
  'price-desc': (a, b) => (b.price ?? -1) - (a.price ?? -1) || byName(a, b),
  'price-asc': (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || byName(a, b),
  'qty': (a, b) => b.qty - a.qty || byName(a, b),
  'rarity': (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || byName(a, b),
  'name': byName
};

function render() {
  const activeGroups = RARITY_GROUPS.filter((g) => state.rarities.has(g.key));
  const passesSet = (c) => state.set === 'all' || c.set?.code === state.set;
  const passesRarity = (c) => !state.rarities.size || activeGroups.some((g) => g.match.includes(c.rarity));
  const passesOther = (c) =>
    (!state.colors.size || state.colors.has(c.color)) && (!state.types.size || state.types.has(c.cardType));
  const passesSearch = (c) =>
    !state.search || `${c.displayName || ''} ${c.name} ${c.subname || ''}`.toLowerCase().includes(state.search);
  const passesStatus = (c) => state.status === 'all' || statusOf(c) === state.status;

  const rows = catalog.map((c) => ({ ...c, qty: qtyOf(c, state.bucket) }));
  let cards;
  if (state.unique) {
    cards = collapseUnique(rows, (c) => passesSet(c) && passesOther(c))
      .filter((c) => passesRarity(c) && passesSearch(c) && passesStatus(c));
  } else {
    cards = rows.filter((c) => passesSet(c) && passesOther(c) && passesRarity(c) && passesSearch(c) && passesStatus(c));
  }
  cards.sort(SORTERS[state.sort] || SORTERS.default);

  const copies = cards.reduce((sum, c) => sum + c.qty, 0);
  const total = cards.reduce((sum, c) => sum + (c.price != null ? c.price * c.qty : 0), 0);
  el('stat-cards').textContent = cards.length.toLocaleString();
  el('stat-copies').textContent = copies.toLocaleString();
  el('stat-cost').textContent = total ? `~${formatEur(total)}` : '–';
  el('result-count').textContent = `Showing ${cards.length.toLocaleString()} card${cards.length === 1 ? '' : 's'}`;

  const filterCount = (state.status !== 'all' ? 1 : 0) + state.colors.size + state.types.size +
    state.rarities.size + (state.set !== 'all' ? 1 : 0) + (state.unique ? 1 : 0);
  el('filter-count').hidden = !filterCount;
  el('filter-count').textContent = filterCount;
  el('filter-clear').hidden = !filterCount;

  el('empty-state').hidden = cards.length !== 0;
  const grid = el('card-grid');
  const list = el('own-list');
  const isList = state.view === 'list';
  grid.hidden = isList;
  list.hidden = !isList;
  if (isList) {
    list.innerHTML = cards.length ? listHtml(cards) : '';
  } else {
    grid.className = `card-grid size-${state.view}`;
    grid.innerHTML = cards.map(tileHtml).join('');
    stagger(grid);
  }
}

const hrefFor = (c) => `record.html?id=${encodeURIComponent(c.id)}&bucket=${state.bucket}`;

function tileHtml(c) {
  const img = `<img src="images/${c.id}.webp" alt="${esc(c.displayName)}" loading="lazy" onerror="this.closest('.need-card-img-wrap').classList.add('no-image'); this.remove();" />`;
  return `
    <a class="need-card own-${statusOf(c)}" href="${hrefFor(c)}" title="${esc(c.displayName)} · ${c.qty}/${c.cap}">
      <div class="need-card-img-wrap">
        ${img}
        <span class="own-qty">${c.qty}<small>/${c.cap}</small></span>
      </div>
      <div class="need-card-info">
        <div class="need-card-name">${esc(c.name)}</div>
        ${c.subname ? `<div class="need-card-subname">${esc(c.subname)}</div>` : ''}
        <div class="need-card-meta ${rarityClass(c.rarity)}">${esc(c.rarity)} · ${esc(c.set?.name || '')}</div>
        ${c.price != null ? `<div class="need-card-price${c.priceGuess ? ' price-guess' : ''}">${formatEur(c.price)}${c.priceGuess ? '?' : ''}</div>` : ''}
      </div>
    </a>
  `;
}

function listHtml(cards) {
  const label = state.bucket === 'main' ? 'Main' : 'Reserve';
  return `
    <div class="own-row own-head"><span>Card</span><span class="own-col-set">Set</span><span class="own-col-price">Price</span><span class="own-col-qty">${label}</span></div>
    ${cards.map((c) => `
      <a class="own-row own-${statusOf(c)}" href="${hrefFor(c)}">
        <span class="own-name"><b>${esc(c.name)}</b>${c.subname ? `<i>${esc(c.subname)}</i>` : ''}
          <em class="${rarityClass(c.rarity)}">${esc(c.rarity)}</em></span>
        <span class="own-col-set">${esc(c.set?.name || '')}</span>
        <span class="own-col-price">${c.price != null ? formatEur(c.price) + (c.priceGuess ? '?' : '') : ''}</span>
        <span class="own-col-qty">${c.qty}<small>/${c.cap}</small></span>
      </a>`).join('')}
  `;
}

init();
