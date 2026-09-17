let neededData = { main: [], reserve: [] };
let pendingChanges = [];

let state = {
  bucket: 'main',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'welcometonightcitybeta'
};

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];
const RARITY_ORDER = [
  'Common', 'Uncommon', 'Rare', 'Epic', 'Nova Rare',
  'Iconic Legend', 'Iconic Other', 'Secret', 'Iconic Secret'
];

const el = (id) => document.getElementById(id);

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

async function init() {
  try {
    [neededData, pendingChanges] = await Promise.all([
      fetchJson('data/needed.json'),
      fetchJson('data/pending-changes.json')
    ]);
  } catch (err) {
    el('empty-state').hidden = false;
    el('empty-state').textContent = `Couldn't load data: ${err.message}`;
    return;
  }

  buildFilterOptions();
  attachControls();
  render();
}

function buildFilterOptions() {
  const all = [...neededData.main, ...neededData.reserve];
  const colors = [...new Set(all.map((c) => c.color).filter(Boolean))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(all.map((c) => c.cardType).filter(Boolean))]
    .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const rarities = [...new Set(all.map((c) => c.rarity).filter(Boolean))]
    .sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
  const sets = [...new Map(all.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);

  renderChipGroup('color-filters', colors, state.colors, (v) => `color-${v}`);
  renderChipGroup('type-filters', types, state.types);
  renderChipGroup('rarity-filters', rarities, state.rarities);

  const select = el('set-filter');
  select.innerHTML = '<option value="all">All Sets</option>' +
    sets.map((s) => `<option value="${s.code}">${s.name}</option>`).join('');
  if (sets.some((s) => s.code === state.set)) select.value = state.set;
  else state.set = 'all';
}

function renderChipGroup(containerId, values, activeSet, extraClass) {
  const container = el(containerId);
  container.innerHTML = values
    .map((v) => `<div class="chip ${extraClass ? extraClass(v) : ''}" data-value="${v}">${v}</div>`)
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

function attachControls() {
  document.querySelectorAll('#bucket-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.bucket = btn.dataset.bucket;
      document.querySelectorAll('#bucket-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });
  el('set-filter').addEventListener('change', (e) => {
    state.set = e.target.value;
    render();
  });
}

// Pending changes recorded on the Record page (not yet pulled into the
// desktop app) haven't regenerated needed.json yet, so we adjust the
// last-published numbers client-side - keeps this page feeling live.
function pendingDeltaFor(id, bucket) {
  return pendingChanges
    .filter((c) => c.id === id && c.bucket === bucket)
    .reduce((sum, c) => sum + (c.delta || 0), 0);
}

function render() {
  const source = state.bucket === 'main' ? neededData.main : neededData.reserve;

  let cards = source
    .map((c) => ({ ...c, needed: Math.max(0, c.needed - pendingDeltaFor(c.id, state.bucket)) }))
    .filter((c) => c.needed > 0);

  if (state.colors.size) cards = cards.filter((c) => state.colors.has(c.color));
  if (state.types.size) cards = cards.filter((c) => state.types.has(c.cardType));
  if (state.rarities.size) cards = cards.filter((c) => state.rarities.has(c.rarity));
  if (state.set !== 'all') cards = cards.filter((c) => c.set?.code === state.set);

  cards.sort((a, b) =>
    COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
    TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) ||
    a.name.localeCompare(b.name)
  );

  el('result-count').textContent = `${cards.length} card${cards.length === 1 ? '' : 's'} needed`;
  el('empty-state').hidden = cards.length !== 0;
  el('card-grid').innerHTML = cards.map(cardHtml).join('');
}

function cardHtml(c) {
  const safeName = c.name.replace(/'/g, '&#39;');
  const imgTag = `<img src="images/${c.id}.webp" alt="${c.displayName}" loading="lazy" onerror="this.closest('.need-card-img-wrap').classList.add('no-image'); this.insertAdjacentHTML('afterend', '<span>${safeName}</span>'); this.remove();" />`;
  return `
    <a class="need-card" href="record.html?q=${encodeURIComponent(c.name)}">
      <div class="need-card-img-wrap">
        ${imgTag}
        <div class="need-badge">${c.needed}</div>
      </div>
      <div class="need-card-info">
        <div class="need-card-name">${c.name}</div>
        ${c.subname ? `<div class="need-card-subname">${c.subname}</div>` : ''}
        <div class="need-card-meta ${rarityClass(c.rarity)}">${c.rarity} · ${c.set?.name || ''}</div>
      </div>
    </a>
  `;
}

init();
