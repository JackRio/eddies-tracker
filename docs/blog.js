// Blog index (blog/index.html): every post in data/blog.json, newest first.
// Posts themselves are plain static pages at blog/<slug>.html; this file only
// renders the list. Paths in blog.json are relative to the site root, and this
// page lives one folder down, hence ROOT.

const ROOT = '../';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const postDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function postCardHtml(p, i) {
  const href = `${p.slug}.html`;
  return `
    <a class="post-card${i === 0 ? ' lead' : ''}" href="${href}">
      <div class="post-cover"><img src="${ROOT}${escapeHtml(p.cover)}" alt="${escapeHtml(p.coverAlt || '')}" loading="lazy" /></div>
      <div class="post-body">
        <div class="post-kicker">${escapeHtml(p.category || 'Guide')}${i === 0 ? '<span class="badge-latest">Latest</span>' : ''}</div>
        <h2>${escapeHtml(p.title)}</h2>
        <p>${escapeHtml(p.dek)}</p>
        <div class="post-meta"><span>${postDate(p.date)}</span><span>${p.readMin} min read</span></div>
        <span class="post-go">Read now &rarr;</span>
      </div>
    </a>`;
}

async function init() {
  renderBuildInfo();
  const grid = document.getElementById('post-grid');
  const data = await fetchJson(`${ROOT}data/blog.json`).catch(() => ({ posts: [] }));
  const posts = (data.posts || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  grid.innerHTML = posts.length
    ? posts.map(postCardHtml).join('')
    : '<div class="post-empty">No posts yet. Check back soon.</div>';
  stagger(grid);
}

init();
