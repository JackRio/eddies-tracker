// Trading page - read-only view of the Looking and Selling lists, written
// into data/looking.json and data/trade.json by the desktop app's Publish
// Site (see publish:run in src/main.js). Lists are edited in the app's
// Trading window, never here.
let looking = { cards: [] };
let selling = { cards: [] };
let view = 'B';
let search = '';

const RARITY_ICONS = {
  Common: 'common', Uncommon: 'uncommon', Rare: 'rare', Epic: 'epic', Secret: 'secret-rare',
  'Iconic Legend': 'iconic-rare', 'Iconic Other': 'iconic-rare', 'Iconic Secret': 'iconic-rare', 'Nova Rare': 'nova-rare'
};

const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function formatEur(v) {
  if (v == null) return '—';
  return `€${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
}

// Card tile like the Deck Builder's stacked tiles: one card image per copy
// (capped), peeking out below each other, with the quantity overlaid.
const TILE_RAISE_PX = 12;
const TILE_ASPECT_PCT = (88 / 63) * 100;
const MAX_LAYERS = 4;

function tileHtml(c, qty, badgeHtml) {
  const icon = RARITY_ICONS[c.rarity] || 'common';
  const n = Math.max(1, Math.min(qty, MAX_LAYERS));
  const extra = (n - 1) * TILE_RAISE_PX;
  const layers = Array.from({ length: n }, (_, i) =>
    `<img class="layer" style="top: ${i * TILE_RAISE_PX}px; z-index: ${i + 1}" src="images/${c.id}.webp" alt="${escapeHtml(c.displayName)}" loading="lazy" onerror="this.style.visibility='hidden'" />`).join('');
  return `<div class="ctile" data-id="${c.id}">
    <div class="stack" style="padding-bottom: calc(${TILE_ASPECT_PCT}% + ${extra}px)">${layers}</div>
    <div class="cap">
      <div class="cqty">${badgeHtml}</div>
      <div class="cname" title="${escapeHtml(c.displayName)}">${escapeHtml(c.displayName)}</div>
      <div class="cmeta"><span class="rarity-icon rarity-icon-${icon}"></span><span>${escapeHtml(c.rarity)}</span></div>
      <div class="cprice" title="Cardmarket price"><img src="assets/cardmarket.svg" alt="Cardmarket" /><b>${formatEur(c.price)}</b></div>
    </div>
  </div>`;
}

// Hover the small card art for 0.5s to see the full card, sized and styled
// like the card popup in the other windows (340px, yellow ring) - not a
// full-page overlay. Only the card art triggers it, not the caption.
const PREVIEW_DELAY_MS = 500;

function setupCardPopup() {
  const box = document.createElement('div');
  box.id = 'card-popup';
  box.hidden = true;
  box.innerHTML = '<img alt="" />';
  document.body.appendChild(box);
  const img = box.firstChild;
  let timer = null;
  let current = null;

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    current = null;
    box.hidden = true;
  };
  const show = (thumb, src) => {
    img.src = src;
    box.hidden = false;
    const r = thumb.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight, m = 12;
    // Beside the thumbnail: right if it fits, else left; clamped vertically.
    let x = r.right + m;
    if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - m);
    const y = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8));
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  };

  document.body.addEventListener('mouseover', (e) => {
    const thumb = e.target.closest('.ctile .stack > img');
    if (thumb === current) return;
    hide();
    if (!thumb) return;
    current = thumb;
    const src = `images/${thumb.closest('.ctile').dataset.id}.webp`;
    timer = setTimeout(() => show(thumb, src), PREVIEW_DELAY_MS);
  });
  document.body.addEventListener('mouseout', (e) => {
    if (current && !e.relatedTarget?.closest?.('.ctile .stack > img')) hide();
  });
  // Dragging, clicking or scrolling dismisses it so it never gets in the way.
  document.body.addEventListener('mousedown', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

function fill(listId, countId, totalId, cards, qtyOf, badgeOf) {
  const shown = cards.filter((c) => !search || c.displayName.toLowerCase().includes(search));
  el(listId).innerHTML = shown.map((c) => tileHtml(c, qtyOf(c), badgeOf(c))).join('') || '<div class="empty-row">Nothing listed.</div>';
  el(countId).textContent = shown.length;
  el(totalId).textContent = formatEur(shown.reduce((sum, c) => sum + (c.price ?? 0) * qtyOf(c), 0));
}

function render() {
  fill('list-looking', 'count-looking', 'total-looking', looking.cards, (c) => c.needed,
    (c) => `<span class="qty-badge need">NEED ×${c.needed}</span>`);
  fill('list-selling', 'count-selling', 'total-selling', selling.cards, (c) => c.qty,
    (c) => `<span class="qty-badge sell">SELL ×${c.qty}</span>`);
  el('p-looking').hidden = view === 'S';
  el('p-selling').hidden = view === 'L';
  el('cols').classList.toggle('single', view !== 'B');
}

async function init() {
  renderBuildInfo();
  try {
    [looking, selling] = await Promise.all([fetchJson('data/looking.json'), fetchJson('data/trade.json')]);
  } catch (err) {
    el('list-looking').innerHTML = `<div class="empty-row">Couldn't load the lists (${escapeHtml(err.message)}).</div>`;
    return;
  }
  renderBuildInfo(looking.generatedAt);
  const asOf = looking.pricesAsOf || selling.pricesAsOf;
  el('price-note-text').textContent = `Prices are fetched from Cardmarket${asOf ? ` (as of ${new Date(asOf).toLocaleDateString()})` : ''}`;

  document.querySelectorAll('#seg span').forEach((s) => s.addEventListener('click', () => {
    view = s.dataset.v;
    document.querySelectorAll('#seg span').forEach((x) => x.classList.toggle('on', x === s));
    render();
  }));
  el('search').addEventListener('input', (e) => {
    search = e.target.value.trim().toLowerCase();
    render();
  });
  setupCardPopup();
  render();
}

init();
