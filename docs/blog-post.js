// Shared script for every blog/<slug>.html post: build-info strip plus the
// "On this page" sidebar, built from the article's section headings, with the
// section currently on screen highlighted. The sidebar only shows on wide
// screens (blog.css), so on phones this just leaves it empty and hidden.

function buildToc() {
  const toc = document.getElementById('post-toc');
  if (!toc) return;
  const sections = [...document.querySelectorAll('.prose section[id]')].filter((s) => s.querySelector('h2'));
  if (sections.length < 2) return;

  // The heading text without its number tag ("01").
  const label = (h2) => [...h2.childNodes].filter((n) => !(n.classList && n.classList.contains('num'))).map((n) => n.textContent).join('').trim();
  toc.innerHTML = `<div class="toc-title">On this page</div><ol>${sections.map((s) => `<li><a href="#${s.id}">${label(s.querySelector('h2'))}</a></li>`).join('')}</ol>`;

  const links = new Map(sections.map((s) => [s.id, toc.querySelector(`a[href="#${s.id}"]`)]));
  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => (e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id)));
    const current = sections.find((s) => visible.has(s.id));
    if (!current) return;
    links.forEach((a, id) => a.classList.toggle('on', id === current.id));
  }, { rootMargin: '-90px 0px -55% 0px' });
  sections.forEach((s) => io.observe(s));
}

renderBuildInfo();
buildToc();
