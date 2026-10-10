// Home page: hero, headline numbers, latest videos from followed YouTube
// creators (data/videos.json - refreshed by .github/workflows/videos.yml, see
// scripts/fetch-videos.js), the featured deck and the freshest decks.
//
// Read-only and static like the rest of the site. Deck helpers are small
// duplicates of the ones in decks.js (this repo's convention: pages don't
// share code beyond shared.js).

const el = (id) => document.getElementById(id);
const COLORS = { Red: '#e8465a', Blue: '#3d8bfd', Green: '#3ecf6e', Yellow: '#e8c93a' };
const COLOR_LETTER = { R: 'Red', B: 'Blue', G: 'Green', Y: 'Yellow' };
const FEATURED_ID = 'misc-featured';

let decks = [];
let details = {};
let meta = { groups: [], tags: {} };
let videoData = { channels: [], videos: [] };
let activeChannel = 'all';
let activeVideoId = null;
// 'recent' = uploaded in the past 24 hours; 'latest' = newest regardless of age.
// Starts on 'recent' when there is anything new, so a fresh upload leads.
let videoScope = null;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const imageUrl = (printingId) => `images/${printingId}.webp`;
const metaTag = (id) => meta.tags[id];
const deckTagIds = (d, cat) => (d.tags?.[cat] || []).filter(metaTag);
const isFeatured = (d) => deckTagIds(d, 'misc').includes(FEATURED_ID);
const updatedTs = (d) => Date.parse(d.updatedAt) || 0;

// ---- Decks ----------------------------------------------------------------
function legendsOf(deck) {
  return (deck.legendPrintingIds || []).filter((p) => p && details[p]);
}

function legendColors(deck) {
  return [...new Set(legendsOf(deck).map((p) => details[p].color).filter(Boolean))];
}

const accentOf = (deck) => `--accent1:${COLORS[legendColors(deck)[0]] || 'var(--yellow)'}`;
const totalCards = (deck) => Object.values(deck.cards || {}).reduce((a, b) => a + b, 0);

function fanHtml(deck) {
  return legendsOf(deck)
    .map((p) => `<img src="${imageUrl(p)}" alt="${escapeHtml(details[p].displayName)}" loading="lazy" />`)
    .join('');
}

function chipsHtml(deck) {
  const chips = [];
  if (deck.colorTag) {
    chips.push(`<span class="tag-chip cat-color">${[...deck.colorTag].map((l) => `<span style="color:${COLORS[COLOR_LETTER[l]]}">${l}</span>`).join('')}</span>`);
  }
  for (const cat of ['archetype', 'creator', 'misc']) {
    for (const id of deckTagIds(deck, cat)) {
      if (id !== FEATURED_ID) chips.push(`<span class="tag-chip cat-${cat}">${escapeHtml(metaTag(id).name)}</span>`);
    }
  }
  return chips.length ? `<div class="tag-chips">${chips.join('')}</div>` : '';
}

function excerpt(deck) {
  const raw = deck.descSections?.overview || deck.description || '';
  return raw.replace(/<[^>]+>/g, '').replace(/@\[+@?\[?([^\]|]+)(?:\|([^\]]+))?\]+/g, (_, n, a) => a || n).trim();
}

function deckLink(deck) {
  return `decks.html?id=${encodeURIComponent(deck.id)}`;
}

function renderDecks() {
  if (!decks.length) return;
  const byRecent = [...decks].sort((a, b) => updatedTs(b) - updatedTs(a));
  const featured = decks.find(isFeatured) || byRecent[0];

  // Hero art: the featured deck's three Legends.
  const heroLegends = legendsOf(featured).slice(0, 3);
  el('hero-art').innerHTML = heroLegends.map((p) => `<img class="hc" src="${imageUrl(p)}" alt="" />`).join('');
  if (!heroLegends.length) el('hero-art').hidden = true;

  el('featured-section').hidden = false;
  el('home-featured').innerHTML = `
    <a class="featured clip hoverable deck-link" style="${accentOf(featured)}" href="${deckLink(featured)}">
      <div class="tag">${isFeatured(featured) ? 'FEATURED' : 'LATEST'}</div>
      <div class="legend-fan">${fanHtml(featured)}</div>
      <div>
        <h2>${escapeHtml(featured.name || 'Untitled Deck')}</h2>
        ${chipsHtml(featured)}
        <p class="blurb">${escapeHtml(excerpt(featured)) || 'Open the deck to see the full list, cost curve and sideboard plans.'}</p>
        <div class="stat-row"><span class="pill"><b>${totalCards(featured)}</b> cards</span></div>
        <span class="cta primary">View deck &rarr;</span>
      </div>
    </a>`;

  const fresh = byRecent.filter((d) => d.id !== featured.id).slice(0, 8);
  el('fresh-section').hidden = !fresh.length;
  el('home-fresh').innerHTML = fresh
    .map((d) => `
      <a class="deck clip hoverable deck-link" style="${accentOf(d)}" href="${deckLink(d)}">
        <h3>${escapeHtml(d.name || 'Untitled Deck')}</h3>
        <div class="sub"><span class="dots">${legendColors(d).map((c) => `<span class="dot" style="background:${COLORS[c]}" title="${c}"></span>`).join('')}</span><span>${totalCards(d)} cards</span></div>
        ${chipsHtml(d)}
        <div class="legend-fan">${fanHtml(d)}</div>
      </a>`)
    .join('');
  stagger(el('home-fresh'), 8);
}

// ---- Stats ----------------------------------------------------------------
function renderStats(stats, looking, selling) {
  const items = [
    ['Decks published', decks.length],
    ['Cards still needed', stats?.neededMain],
    ['On my wishlist', looking?.cards?.length],
    ['Cards for sale', selling?.cards?.length]
  ].filter(([, n]) => Number.isFinite(n));
  el('home-stats').innerHTML = items.map(([label, n]) => `<div class="stat"><b data-n="${n}">0</b><span>${label}</span></div>`).join('');
  el('home-stats').querySelectorAll('b').forEach((b) => countUp(b, Number(b.dataset.n)));
  stagger(el('home-stats'), 4);
}

// ---- Videos ---------------------------------------------------------------
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const channelById = (id) => videoData.channels.find((c) => c.id === id);
const DAY_MS = 864e5;
const isNew = (v) => Date.now() - Date.parse(v.published) < DAY_MS;
const recentVideos = () => videoData.videos.filter(isNew);
const visibleVideos = () =>
  (videoScope === 'recent' ? recentVideos() : videoData.videos)
    .filter((v) => activeChannel === 'all' || v.channelId === activeChannel);

function playerHtml(v) {
  return `<div class="player" data-play="${escapeHtml(v.id)}" role="button" tabindex="0" aria-label="Play: ${escapeHtml(v.title)}">
    <img class="thumb" src="https://i.ytimg.com/vi/${escapeHtml(v.id)}/maxresdefault.jpg" alt="" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${escapeHtml(v.id)}/hqdefault.jpg'" />
    <span class="play">${PLAY_SVG}</span>
  </div>`;
}

function renderVideos() {
  const wrap = el('video-wrap');
  const channels = videoData.channels;
  el('videos-follow').textContent = channels.length ? `Following ${channels.length} creator${channels.length === 1 ? '' : 's'}` : '';
  el('videos-follow').title = channels.map((c) => c.name).join(', ');

  if (videoScope === null) videoScope = recentVideos().length ? 'recent' : 'latest';
  const recentCount = recentVideos().length;
  el('videos-title').textContent = videoScope === 'recent' ? 'New in the last 24 hours' : 'Latest videos';

  // Scope chips (only worth showing when something is new) + one chip per channel.
  const chipRow = el('video-channels');
  const scopeChips = recentCount
    ? [['scope', 'recent', `Past 24 hours (${recentCount})`], ['scope', 'latest', 'Latest']]
    : [];
  const channelChips = channels.length < 2 ? [] : [['ch', 'all', 'All channels'], ...channels.map((c) => ['ch', c.id, c.name])];
  const chipOn = (kind, value) => (kind === 'scope' ? videoScope === value : activeChannel === value);
  chipRow.hidden = !scopeChips.length && !channelChips.length;
  chipRow.innerHTML = [...scopeChips, ...channelChips]
    .map(([kind, value, label]) => `<div class="chip ${chipOn(kind, value) ? 'active' : ''}" data-${kind}="${escapeHtml(value)}" role="button" tabindex="0">${escapeHtml(label)}</div>`)
    .join('');

  const list = visibleVideos();
  if (!list.length) {
    wrap.innerHTML = `<div class="video-empty">${videoScope === 'recent'
      ? 'No new uploads from this channel in the last 24 hours.'
      : 'No videos yet. New uploads from the creators I follow will show up here automatically.'}</div>`;
    return;
  }
  if (!list.some((v) => v.id === activeVideoId)) activeVideoId = list[0].id;
  const main = list.find((v) => v.id === activeVideoId);
  const ch = channelById(main.channelId);
  const others = list.filter((v) => v.id !== main.id).slice(0, 5);
  wrap.classList.toggle('solo', !others.length);

  wrap.innerHTML = `
    <div class="video-main">
      ${playerHtml(main)}
      <div class="video-meta">
        <h3>${escapeHtml(main.title)}</h3>
        <div class="sub">
          ${isNew(main) ? '<span class="badge-new">NEW</span>' : ''}
          ${ch ? `<a href="${escapeHtml(ch.url)}" target="_blank" rel="noopener">${escapeHtml(ch.name)}</a>` : ''}
          <span>${escapeHtml(timeAgo(main.published))}</span>
          <a href="https://www.youtube.com/watch?v=${escapeHtml(main.id)}" target="_blank" rel="noopener">Watch on YouTube &#8599;</a>
        </div>
      </div>
    </div>
    <div class="video-list">
      ${others.map((v) => `
        <button class="vrow" data-pick="${escapeHtml(v.id)}">
          <img src="https://i.ytimg.com/vi/${escapeHtml(v.id)}/hqdefault.jpg" alt="" loading="lazy" />
          <span>
            <span class="t">${escapeHtml(v.title)}</span>
            <span class="m">${isNew(v) ? '<span class="badge-new">NEW</span> ' : ''}${escapeHtml(channelById(v.channelId)?.name || '')} &middot; ${escapeHtml(timeAgo(v.published))}</span>
          </span>
        </button>`).join('')}
    </div>`;
  stagger(wrap.querySelector('.video-list'), 5);
}

// Clicking the thumbnail swaps in YouTube's privacy-friendly embed (the
// cookie-less youtube-nocookie domain) - nothing from YouTube loads until
// someone presses play, which keeps the page fast.
function startPlayer(box) {
  const id = box.dataset.play;
  box.removeAttribute('role');
  box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0" title="YouTube video player" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
}

function setupVideoEvents() {
  el('videos-section').addEventListener('click', (e) => {
    const play = e.target.closest('[data-play]');
    if (play && !play.querySelector('iframe')) return startPlayer(play);
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      activeVideoId = pick.dataset.pick;
      renderVideos();
      el('video-wrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const scope = e.target.closest('[data-scope]');
    if (scope) {
      videoScope = scope.dataset.scope;
      activeVideoId = null;
      renderVideos();
      return;
    }
    const ch = e.target.closest('[data-ch]');
    if (ch) {
      activeChannel = ch.dataset.ch;
      activeVideoId = null;
      renderVideos();
    }
  });
  el('videos-section').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-play],[data-ch],[data-scope]');
    if (!t) return;
    e.preventDefault();
    t.click();
  });
}

// ---- Init -------------------------------------------------------------------
async function init() {
  renderBuildInfo();
  const get = (path, fallback) => fetchJson(path).catch(() => fallback);
  const [videosJson, decksJson, detailsJson, metaJson, stats, looking, selling] = await Promise.all([
    get('data/videos.json', { channels: [], videos: [] }),
    get('data/published-decks.json', []),
    get('data/deck-card-details.json', {}),
    get('data/deck-meta.json', { groups: [], tags: {} }),
    get('data/stats.json', null),
    get('data/looking.json', null),
    get('data/trade.json', null)
  ]);
  videoData = { channels: videosJson.channels || [], videos: videosJson.videos || [] };
  decks = decksJson;
  details = detailsJson;
  meta = { groups: metaJson.groups || [], tags: metaJson.tags || {} };

  renderStats(stats, looking, selling);
  renderVideos();
  setupVideoEvents();
  renderDecks();
}

init();
