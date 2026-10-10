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
// 'fresh' (default) = per creator: everything uploaded in the past 24 hours, or
// - when they have nothing new - their single most recent video, so every
// followed creator is represented. 'all' = every stored video.
let videoScope = 'fresh';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const imageUrl = (printingId) => `images/${printingId}.webp`;
const metaTag = (id) => meta.tags[id];
const deckTagIds = (d, cat) => (d.tags?.[cat] || []).filter(metaTag);
const isFeatured = (d) => deckTagIds(d, 'misc').includes(FEATURED_ID);
const updatedTs = (d) => Date.parse(d.updatedAt) || 0;

// ---- Hero: the rarest cards in the collection, cycling -------------------------
// data/showcase.json is written by the desktop app's Publish (src/showcase.js):
// owned cards, rarest first. Three are shown at once (the rarest of the trio in
// the middle) and the trio advances every few seconds; hover, a hidden tab, or
// reduced-motion settings pause it. Dots jump straight to a card.
let showcase = [];
let heroIdx = 1; // centre card; starting at 1 puts the three rarest on screen first
let heroTimer = null;
const HERO_MS = 4500;
const RARITY_GLOW = { 'Nova Rare': '255,95,168', 'Iconic Legend': '255,184,51', 'Iconic Other': '255,184,51', 'Iconic Secret': '255,184,51', Secret: '255,77,77', Epic: '184,102,255', Rare: '77,166,255' };
const RARITY_ICON = { 'Nova Rare': 'nova-rare', 'Iconic Legend': 'iconic-rare', 'Iconic Other': 'iconic-rare', 'Iconic Secret': 'iconic-rare', Secret: 'secret-rare', Epic: 'epic', Rare: 'rare', Uncommon: 'uncommon', Common: 'common' };
const heroAt = (i) => showcase[((i % showcase.length) + showcase.length) % showcase.length];

function heroCaption(card) {
  const icon = RARITY_ICON[card.rarity];
  return `${icon ? `<span class="rarity-icon rarity-icon-${icon}"></span>` : ''}<b>${escapeHtml(card.displayName || card.name)}</b><span>${escapeHtml(card.rarity)}</span>`;
}

function paintHeroMeta() {
  const art = el('hero-art');
  const card = heroAt(heroIdx);
  art.style.setProperty('--glow', RARITY_GLOW[card.rarity] || '245,228,0');
  el('hero-cap').innerHTML = heroCaption(card);
  const active = ((heroIdx % showcase.length) + showcase.length) % showcase.length;
  art.querySelectorAll('.hero-dots button').forEach((b, i) => b.classList.toggle('on', i === active));
}

function setupHero() {
  if (showcase.length < 3) { showcase = []; return; }
  const art = el('hero-art');
  const cards = [-1, 0, 1].map((o) => {
    const c = heroAt(heroIdx + o);
    return `<img class="hc" data-off="${o}" src="${imageUrl(c.id)}" alt="${escapeHtml(c.displayName || c.name)}" />`;
  }).join('');
  const dots = showcase.map((c, i) => `<button type="button" data-hero="${i}" aria-label="Show ${escapeHtml(c.displayName || c.name)}"></button>`).join('');
  art.innerHTML = `${cards}<div class="hero-meta"><div class="hero-cap" id="hero-cap"></div><div class="hero-dots">${dots}</div></div>`;
  paintHeroMeta();
  showcase.forEach((c) => { const im = new Image(); im.src = imageUrl(c.id); }); // preload so swaps never flash

  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const goTo = (idx) => {
    heroIdx = idx;
    art.querySelectorAll('.hc').forEach((img, k) => {
      setTimeout(() => {
        img.classList.add('swap');
        setTimeout(() => {
          const c = heroAt(heroIdx + Number(img.dataset.off));
          img.src = imageUrl(c.id);
          img.alt = c.displayName || c.name;
          img.classList.remove('swap');
        }, 330);
      }, k * 140);
    });
    paintHeroMeta();
  };
  const stop = () => { clearInterval(heroTimer); heroTimer = null; };
  const start = () => { stop(); if (!reduce && !document.hidden) heroTimer = setInterval(() => goTo(heroIdx + 1), HERO_MS); };
  art.addEventListener('mouseenter', stop);
  art.addEventListener('mouseleave', start);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  art.addEventListener('click', (e) => {
    const dot = e.target.closest('[data-hero]');
    if (dot) { goTo(Number(dot.dataset.hero)); start(); }
  });
  start();
}

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

  // No showcase published yet: fall back to the featured deck's Legends.
  if (!showcase.length) {
    const heroLegends = legendsOf(featured).slice(0, 3);
    el('hero-art').innerHTML = heroLegends.map((p) => `<img class="hc" src="${imageUrl(p)}" alt="" />`).join('');
    if (!heroLegends.length) el('hero-art').hidden = true;
  }

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
const byNewest = (a, b) => Date.parse(b.published) - Date.parse(a.published);
function freshVideos() {
  const perChannel = new Map();
  for (const v of videoData.videos) {
    if (!perChannel.has(v.channelId)) perChannel.set(v.channelId, []);
    perChannel.get(v.channelId).push(v);
  }
  const out = [];
  for (const list of perChannel.values()) {
    list.sort(byNewest);
    const recent = list.filter(isNew);
    out.push(...(recent.length ? recent : [list[0]]));
  }
  return out.sort(byNewest);
}
const visibleVideos = () =>
  (videoScope === 'fresh' ? freshVideos() : [...videoData.videos].sort(byNewest))
    .filter((v) => activeChannel === 'all' || v.channelId === activeChannel);
const CHANNEL_CHIP_LIMIT = 6; // more creators than this and the filter becomes a dropdown

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

  const freshCount = freshVideos().length;
  el('videos-title').textContent = videoScope === 'fresh' ? 'Fresh from the creators' : 'All recent videos';

  // Scope chips, then the creator filter: chips for a handful, a dropdown for many.
  const chipRow = el('video-channels');
  const chip = (kind, value, label, on) => `<div class="chip ${on ? 'active' : ''}" data-${kind}="${escapeHtml(value)}" role="button" tabindex="0">${escapeHtml(label)}</div>`;
  let html = chip('scope', 'fresh', `Fresh (${freshCount})`, videoScope === 'fresh') + chip('scope', 'all', `All videos (${videoData.videos.length})`, videoScope === 'all');
  if (channels.length > 1 && channels.length <= CHANNEL_CHIP_LIMIT) {
    html += chip('ch', 'all', 'All creators', activeChannel === 'all') + channels.map((c) => chip('ch', c.id, c.name, activeChannel === c.id)).join('');
  } else if (channels.length > CHANNEL_CHIP_LIMIT) {
    html += `<select id="video-channel-select" class="video-select" aria-label="Filter by creator"><option value="all">All creators (${channels.length})</option>${channels.map((c) => `<option value="${escapeHtml(c.id)}" ${activeChannel === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>`;
  }
  chipRow.hidden = !videoData.videos.length;
  chipRow.innerHTML = html;

  const list = visibleVideos();
  if (!list.length) {
    wrap.innerHTML = '<div class="video-empty">No videos yet. New uploads from the creators I follow will show up here automatically.</div>';
    return;
  }
  if (!list.some((v) => v.id === activeVideoId)) activeVideoId = list[0].id;
  const main = list.find((v) => v.id === activeVideoId);
  const ch = channelById(main.channelId);
  const others = list.filter((v) => v.id !== main.id).slice(0, 14);
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
  stagger(wrap.querySelector('.video-list'), 6);
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
  el('videos-section').addEventListener('change', (e) => {
    if (e.target.id !== 'video-channel-select') return;
    activeChannel = e.target.value;
    activeVideoId = null;
    renderVideos();
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
  const [videosJson, decksJson, detailsJson, metaJson, stats, looking, selling, showcaseJson] = await Promise.all([
    get('data/videos.json', { channels: [], videos: [] }),
    get('data/published-decks.json', []),
    get('data/deck-card-details.json', {}),
    get('data/deck-meta.json', { groups: [], tags: {} }),
    get('data/stats.json', null),
    get('data/looking.json', null),
    get('data/trade.json', null),
    get('data/showcase.json', null)
  ]);
  videoData = { channels: videosJson.channels || [], videos: videosJson.videos || [] };
  decks = decksJson;
  details = detailsJson;
  meta = { groups: metaJson.groups || [], tags: metaJson.tags || {} };

  showcase = showcaseJson?.cards || [];
  setupHero();
  renderStats(stats, looking, selling);
  renderVideos();
  setupVideoEvents();
  renderDecks();
}

init();
