let allCards = [];
let collection = {};
let activeType = 'Legend';
let activeCompletion = 'all';

const COLORS = ['Red', 'Blue', 'Green', 'Yellow'];
const el = (id) => document.getElementById(id);

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

function getBucketCount(cardId, bucket) {
  return collection[cardId]?.[bucket] || 0;
}

const MAIN_SET_TARGET = 3;

// A card's Main set is "full" once you hold 3 copies of it (deck legality).
function isFullSet(cardId) {
  return getBucketCount(cardId, 'main') >= MAIN_SET_TARGET;
}

async function init() {
  const cache = await window.api.getCards();
  allCards = (cache && cache.cards) || [];
  collection = await window.api.getCollection();

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectType(btn.dataset.type));
  });
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCompletion = btn.dataset.filter;
      document.querySelectorAll('.filter-chip').forEach((b) => b.classList.toggle('active', b === btn));
      selectType(activeType);
    });
  });
  el('close-btn').addEventListener('click', () => window.close());
  el('popped-overlay').addEventListener('click', (e) => {
    if (e.target === el('popped-overlay')) closePopped();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopped();
  });

  selectType('Legend');
}

function selectType(type) {
  activeType = type;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  let cardsInMainSet = allCards.filter((c) => c.cardType === type && getBucketCount(c.id, 'main') > 0);

  if (activeCompletion === 'full') {
    cardsInMainSet = cardsInMainSet.filter((c) => isFullSet(c.id));
  } else if (activeCompletion === 'partial') {
    cardsInMainSet = cardsInMainSet.filter((c) => !isFullSet(c.id));
  }

  COLORS.forEach((color) => {
    const rowCards = cardsInMainSet
      .filter((c) => c.color === color)
      .sort((a, b) => a.name.localeCompare(b.name));
    renderRow(color, rowCards);
  });
}

function renderRow(color, cards) {
  const stackEl = document.querySelector(`.fan-stack[data-row="${color}"]`);
  if (!cards.length) {
    stackEl.innerHTML = '<div class="fan-empty">No cards in your main set yet</div>';
    return;
  }
  stackEl.innerHTML = cards
    .map(
      (c, i) => `
      <div class="fan-card" data-id="${c.id}" style="z-index:${i + 1}">
        <img src="${c.imageUrl}" alt="${c.displayName}" loading="lazy" />
      </div>`
    )
    .join('');
  attachFanInteractions(stackEl);
}

// The row that holds the fan is a horizontal-scroll container (overflow-x:
// auto), and CSS forces overflow-y to clip too whenever overflow-x isn't
// "visible" - so a raised, scaled-up card gets its top sliced off by that
// invisible boundary no matter how much padding the row is given. The fix
// is to lift the hovered card into a `position: fixed` "ghost" appended to
// <body>, i.e. outside every clipping ancestor, positioned exactly over the
// real card and then animated - the real card's own image just fades out
// underneath so nothing visually duplicates.
let ghostEl = null;

function ensureGhost() {
  if (ghostEl) return ghostEl;
  ghostEl = document.createElement('div');
  ghostEl.className = 'fan-ghost';
  ghostEl.innerHTML = '<img alt="" />';
  document.body.appendChild(ghostEl);
  return ghostEl;
}

function showGhost(cardEl) {
  const rect = cardEl.getBoundingClientRect();
  const ghost = ensureGhost();
  ghost.querySelector('img').src = cardEl.querySelector('img').src;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.classList.add('visible');
  requestAnimationFrame(() => ghost.classList.add('raised'));
}

function hideGhost() {
  if (!ghostEl) return;
  ghostEl.classList.remove('raised', 'visible');
}

function attachFanInteractions(stackEl) {
  const cards = [...stackEl.querySelectorAll('.fan-card')];
  cards.forEach((card, i) => {
    card.addEventListener('mouseenter', () => {
      card.classList.add('hovered');
      showGhost(card);
      cards.forEach((other, j) => {
        if (other === card) return;
        const dist = j - i;
        if (dist < 0 && dist >= -3) other.classList.add('push-left');
        if (dist > 0 && dist <= 3) other.classList.add('push-right');
      });
    });
    card.addEventListener('mouseleave', () => {
      card.classList.remove('hovered');
      hideGhost();
      cards.forEach((other) => other.classList.remove('push-left', 'push-right'));
    });
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopped(card.dataset.id);
    });
  });
}

function openPopped(cardId) {
  const c = allCards.find((x) => x.id === cardId);
  if (!c) return;

  el('popped-img').src = c.imageUrl;
  el('popped-img').alt = c.displayName;
  el('popped-name').textContent = c.name;
  el('popped-subname').textContent = c.subname || '';
  el('popped-subname').hidden = !c.subname;

  const main = getBucketCount(c.id, 'main');
  const reserve = getBucketCount(c.id, 'reserve');
  const extras = getBucketCount(c.id, 'extras');
  const completionLabel = main >= MAIN_SET_TARGET ? 'Full Set' : `Partial — need ${MAIN_SET_TARGET - main} more`;
  el('popped-buckets').innerHTML = `
    <div class="popped-bucket-row">
      <span class="bucket-pill bucket-main">Main ${main}</span>
      <span class="bucket-pill bucket-reserve">Reserve ${reserve}</span>
      <span class="bucket-pill bucket-extras">Extras ${extras}</span>
    </div>
    <div class="popped-completion">${main}/${MAIN_SET_TARGET} for Main Set — ${completionLabel}</div>
  `;

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

  el('popped-rules').textContent = c.rulesText || '';

  const overlay = el('popped-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closePopped() {
  const overlay = el('popped-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    overlay.hidden = true;
  }, 200);
}

init();
