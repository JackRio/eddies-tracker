// Trade list page - cards up for sale, written into data/trade.json by the
// desktop app's Publish Site (see publish:run in src/main.js). Standalone on
// purpose: no shared.js/config.js, no links to the rest of the site.
let tradeData = { cards: [] };

let state = {
  search: '',
  colors: new Set(),
  types: new Set(),
  sort: 'price'
};

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];

const el = (id) => document.getElementById(id);

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function formatEur(v) {
  return `€${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
}

async function init() {
  try {
    const res = await fetch('data/trade.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    tradeData = await res.json();
  } catch (err) {
    el('empty-state').hidden = false;
    el('empty-state').textContent = `Couldn't load the list (${err.message}).`;
    return;
  }

  const updated = tradeData.generatedAt ? new Date(tradeData.generatedAt).toLocaleString() : 'unknown';
  el('build-info').textContent = `List updated ${updated} · Prices: Cardmarket trend${tradeData.pricesAsOf ? ` as of ${new Date(tradeData.pricesAsOf).toLocaleDateString()}` : ''}`;

  const colors = [...new Set(tradeData.cards.map((c) => c.color).filter(Boolean))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(tradeData.cards.map((c) => c.cardType).filter(Boolean))]
    .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  renderChipGroup('color-filters', colors, state.colors, (v) => `color-${v}`);
  renderChipGroup('type-filters', types, state.types, (v) => `type-${v}`);

  el('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  });
  el('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });

  render();
}

function renderChipGroup(containerId, values, activeSet, extraClass) {
  const container = el(containerId);
  container.innerHTML = values
    .map((v) => `<div class="chip ${extraClass(v)}" data-value="${v}">${v}</div>`)
    .join('');
  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.value;
      if (activeSet.has(val)) activeSet.delete(val);
      else activeSet.add(val);
      chip.classList.toggle('active');
      render();
    });
  });
}

function render() {
  let cards = tradeData.cards.slice();
  if (state.search) {
    cards = cards.filter((c) => `${c.name} ${c.subname || ''} ${c.set?.name || ''}`.toLowerCase().includes(state.search));
  }
  if (state.colors.size) cards = cards.filter((c) => state.colors.has(c.color));
  if (state.types.size) cards = cards.filter((c) => state.types.has(c.cardType));

  cards.sort((a, b) => {
    if (state.sort === 'price') return (b.price ?? -1) - (a.price ?? -1) || a.name.localeCompare(b.name);
    if (state.sort === 'name') return a.name.localeCompare(b.name);
    return (
      COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
      TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) ||
      a.name.localeCompare(b.name)
    );
  });

  const copies = cards.reduce((sum, c) => sum + c.qty, 0);
  el('result-count').textContent = `${cards.length} card${cards.length === 1 ? '' : 's'} · ${copies} cop${copies === 1 ? 'y' : 'ies'}`;
  el('empty-state').hidden = cards.length !== 0;
  el('card-grid').innerHTML = cards.map(cardHtml).join('');
}

function cardHtml(c) {
  const safeName = escapeHtml(c.name).replace(/'/g, '&#39;');
  const imgTag = `<img src="images/${c.id}.webp" alt="${escapeHtml(c.displayName)}" loading="lazy" onerror="this.closest('.need-card-img-wrap').classList.add('no-image'); this.insertAdjacentHTML('afterend', '<span>${safeName}</span>'); this.remove();" />`;
  return `
    <div class="need-card">
      <div class="need-card-img-wrap">${imgTag}</div>
      <div class="need-card-info">
        <div class="need-badge">×${c.qty} available</div>
        <div class="need-card-name">${escapeHtml(c.name)}</div>
        ${c.subname ? `<div class="need-card-subname">${escapeHtml(c.subname)}</div>` : ''}
        <div class="need-card-meta ${rarityClass(c.rarity)}">${escapeHtml(c.rarity)} · ${escapeHtml(c.set?.name || '')}</div>
        ${c.price != null
          ? `<div class="need-card-price${c.priceGuess ? ' price-guess' : ''}" title="Cardmarket trend${c.priceGuess ? ' (best-guess match)' : ''}">${formatEur(c.price)}${c.priceGuess ? '?' : ''}</div>`
          : '<div class="need-card-price price-guess">No price</div>'}
      </div>
    </div>
  `;
}

init();
