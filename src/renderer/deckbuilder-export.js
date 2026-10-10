// Picture export: builds two self-contained HTML pages for a deck -
//   1. "Deck"      - Legends, every card as art with its quantity, sideboard,
//                    cost curve and donuts
//   2. "Game Plan" - the written description sections (overview, game plan,
//                    key cards, mulligan, sideboard / swap plans, notes)
// The main process renders each page in a hidden window and saves a PNG
// (ipc deck:exportImages). Loaded before deckbuilder.js; uses its globals
// (cardById, computeDeckStats, printingsForCardEntry, ...) at call time.

const EXPORT_WIDTH = 1600;
const EXPORT_COLORS = { Red: '#e8465a', Blue: '#3d8bfd', Green: '#3ecf6e', Yellow: '#e8c93a' };
const EXPORT_TYPE_COLORS = { Unit: '#4da6ff', Gear: '#ff9f43', Program: '#b866ff' };

const EXPORT_CSS = `
* { box-sizing: border-box; margin: 0; }
body { width: ${EXPORT_WIDTH}px; background: #0a0a0f; color: #e8e8ec; font-family: 'Segoe UI', system-ui, sans-serif; padding: 44px 48px 36px; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; border-bottom: 3px solid #f5e400; padding-bottom: 16px; margin-bottom: 26px; }
.head h1 { font-size: 46px; letter-spacing: .03em; text-transform: uppercase; line-height: 1.05; }
.head .sub { margin-top: 8px; color: #8b8b96; font-size: 20px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; max-width: 620px; }
.chip { font-size: 18px; padding: 4px 14px; border-radius: 999px; border: 1px solid #2a2a35; color: #8b8b96; background: #17171f; font-weight: 600; }
.chip.archetype { color: #1de1e1; border-color: rgba(29,225,225,.5); }
.chip.creator { color: #ff7b7b; border-color: rgba(255,123,123,.5); }
.chip.misc { color: #b866ff; border-color: rgba(184,102,255,.5); }
.chip.color { font-weight: 800; letter-spacing: .1em; }
h2 { font-size: 22px; letter-spacing: .1em; text-transform: uppercase; color: #f5e400; margin: 0 0 12px; display: flex; align-items: center; gap: 10px; }
h2 .n { color: #8b8b96; font-size: 18px; letter-spacing: 0; font-weight: 600; }
.top { display: flex; gap: 40px; margin-bottom: 30px; align-items: flex-start; }
.legends { display: flex; gap: 16px; flex: none; }
.legends .card { width: 215px; }
.stats { flex: 1; display: flex; flex-direction: column; gap: 18px; }
.stats-row { display: flex; gap: 26px; }
.panel { background: #131319; border: 1px solid #2a2a35; border-radius: 10px; padding: 16px 18px; }
.curve { display: flex; align-items: flex-end; gap: 10px; height: 150px; }
.curve .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
.curve .bar { width: 100%; background: #1de1e1; border-radius: 4px 4px 0 0; position: relative; min-height: 3px; }
.curve .bar span { position: absolute; top: -24px; left: 0; right: 0; text-align: center; font-size: 17px; font-weight: 700; }
.curve .lbl { margin-top: 6px; color: #8b8b96; font-size: 16px; }
.donuts { display: flex; gap: 26px; }
.donut-block { flex: 1; text-align: center; }
.donut-block h3 { font-size: 15px; letter-spacing: .08em; text-transform: uppercase; color: #8b8b96; margin-bottom: 10px; }
.donut { width: 130px; height: 130px; border-radius: 50%; margin: 0 auto 10px; position: relative; }
.donut::after { content: ''; position: absolute; inset: 28px; border-radius: 50%; background: #131319; }
.donut b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 2; font-size: 22px; }
.legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 12px; font-size: 16px; color: #cfcfd6; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
.section { margin-bottom: 26px; }
.grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 14px; }
.card { position: relative; border-radius: 9px; overflow: hidden; background: #17171f; aspect-ratio: 63 / 88; }
.card img { width: 100%; height: 100%; display: block; object-fit: cover; }
.card .q { position: absolute; top: 8px; right: 8px; background: #f5e400; color: #000; font-weight: 800; font-size: 21px; padding: 1px 11px; border-radius: 999px; box-shadow: 0 2px 8px rgba(0,0,0,.6); }
.card .miss { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(255,159,26,.9); color: #000; font-size: 14px; font-weight: 700; text-align: center; padding: 2px; }
.foot { margin-top: 10px; color: #55555f; font-size: 15px; display: flex; justify-content: space-between; letter-spacing: .08em; text-transform: uppercase; }
/* game plan page */
.block { background: #131319; border: 1px solid #2a2a35; border-left: 4px solid #f5e400; border-radius: 10px; padding: 20px 24px; margin-bottom: 22px; }
.block.key { border-left-color: #1de1e1; }
.block.side { border-left-color: #ff9f43; }
.block.notes { border-left-color: #ff4d4d; }
.cols { display: grid; gap: 26px; }
.cols.c3 { grid-template-columns: repeat(3, 1fr); }
.cols.c1 { grid-template-columns: 1fr; }
.field h3 { font-size: 17px; letter-spacing: .1em; text-transform: uppercase; color: #8b8b96; margin-bottom: 8px; }
.field p, .field li { font-size: 22px; line-height: 1.45; }
.field ul { padding-left: 24px; display: flex; flex-direction: column; gap: 6px; }
.ct { color: #1de1e1; font-weight: 600; }
.thumbs { display: flex; gap: 14px; margin-top: 18px; flex-wrap: wrap; }
.thumbs .card { width: 150px; }
.plan { margin-top: 14px; font-size: 20px; color: #cfcfd6; line-height: 1.6; }
.plan b { color: #ff9f43; }
.legends-mini { display: flex; gap: 10px; }
.legends-mini .card { width: 74px; }
.head-r { display: flex; align-items: center; gap: 24px; }
`;

const exEsc = (s) => escapeHtml(s == null ? '' : String(s));

function exportDeckName(deck) {
  return (deck.name || 'Untitled Deck').trim();
}

function exportChipsHtml(deck) {
  const ids = deckTagIds(deck);
  const color = colorTagOf(deck);
  const colorChip = color
    ? `<span class="chip color">${[...color].map((l) => `<span style="color:${EXPORT_COLORS[COLOR_LETTER[l]]}">${l}</span>`).join('')}</span>`
    : '';
  const tags = ['archetype', 'creator', 'misc'].flatMap((cat) => ids[cat].filter((id) => id !== FEATURED_ID).map((id) => `<span class="chip ${cat}">${exEsc(tagOf(id).name)}</span>`));
  return `<div class="chips">${[colorChip, ...tags].join('')}</div>`;
}

function exportHead(deck, sub) {
  return `<div class="head"><div><h1>${exEsc(exportDeckName(deck))}</h1><div class="sub">${exEsc(sub)}</div></div>${exportChipsHtml(deck)}</div>`;
}

function exportDonut(title, segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  let acc = 0;
  const stops = segments
    .filter((s) => s.count > 0)
    .map((s) => {
      const a = (acc / (total || 1)) * 100;
      acc += s.count;
      return `${s.color} ${a}% ${(acc / (total || 1)) * 100}%`;
    })
    .join(', ');
  const legend = segments.filter((s) => s.count > 0).map((s) => `<span><i style="background:${s.color}"></i>${exEsc(s.label)} ${s.count}</span>`).join('');
  return `<div class="donut-block"><h3>${exEsc(title)}</h3><div class="donut" style="background: ${stops ? `conic-gradient(${stops})` : '#17171f'}"><b>${total}</b></div><div class="legend">${legend}</div></div>`;
}

function exportCardTile(printing, qty, missing) {
  return `<div class="card"><img src="${exEsc(printing.imageUrl)}" alt="">${qty > 1 ? `<div class="q">&times;${qty}</div>` : ''}${missing ? `<div class="miss">need ${missing}</div>` : ''}</div>`;
}

function exportSectionsOf(deck, map) {
  return Object.entries(map || {})
    .map(([cardId, qty]) => ({ cardId, card: cardById(cardId), qty }))
    .filter((e) => e.card && e.qty > 0)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));
}

// Page 1: the deck as pictures + stats.
function buildDeckPicturePage(deck) {
  const stats = computeDeckStats(deck);
  const legends = [0, 1, 2]
    .map((i) => (deck.legendCardIds[i] ? legendPrintingForDeck(deck, i) || cardById(deck.legendCardIds[i]) : null))
    .filter(Boolean);

  const buckets = [0, 1, 2, 3, 4, 5, 6, 7];
  const maxCost = Math.max(1, ...buckets.map((b) => stats.costCounts[b] || 0));
  const curve = buckets
    .map((b) => {
      const n = stats.costCounts[b] || 0;
      return `<div class="col"><div class="bar" style="height:${(n / maxCost) * 82}%">${n ? `<span>${n}</span>` : ''}</div><div class="lbl">${b === 7 ? '7+' : b}</div></div>`;
    })
    .join('');

  const donuts = [
    exportDonut('Card types', TYPE_ORDER.map((t) => ({ label: t + 's', count: stats.typeCounts[t] || 0, color: EXPORT_TYPE_COLORS[t] }))),
    exportDonut('Colors', COLOR_ORDER.map((c) => ({ label: c, count: stats.colorCounts[c] || 0, color: EXPORT_COLORS[c] }))),
    exportDonut('Sellable', [
      { label: 'Sellable', count: stats.sellable, color: '#4dff88' },
      { label: 'Unsellable', count: stats.unsellable, color: '#ff4d4d' }
    ])
  ].join('');

  const entries = exportSectionsOf(deck, deck.cards);
  const typeSections = TYPE_ORDER.map((t) => ({ type: t, list: entries.filter((e) => e.card.cardType === t) }))
    .filter((g) => g.list.length)
    .map((g) => {
      const tiles = g.list
        .map((e) => {
          const list = printingsForCardEntry(deck, e.cardId, e.qty);
          return exportCardTile(list[list.length - 1] || e.card, e.qty);
        })
        .join('');
      return `<div class="section"><h2>${g.type}s <span class="n">${g.list.reduce((s, e) => s + e.qty, 0)}</span></h2><div class="grid">${tiles}</div></div>`;
    })
    .join('');

  const side = exportSectionsOf(deck, deck.sideboard);
  const sideTotal = side.reduce((s, e) => s + e.qty, 0);
  const sideSection = side.length
    ? `<div class="section"><h2>Sideboard <span class="n">${sideTotal}/${SIDEBOARD_SIZE}</span></h2><div class="grid">${side.map((e) => exportCardTile(e.card, e.qty)).join('')}</div></div>`
    : '';

  const sub = `${stats.total} cards · ${stats.legendsFilled} Legends · ${stats.sellablePct}% sellable`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${EXPORT_CSS}</style></head><body>
    ${exportHead(deck, sub)}
    <div class="top">
      <div><h2>Legends</h2><div class="legends">${legends.map((p) => exportCardTile(p, 1)).join('')}</div></div>
      <div class="stats">
        <div class="panel"><h2>Eddie cost curve</h2><div class="curve">${curve}</div></div>
        <div class="panel"><div class="donuts">${donuts}</div></div>
      </div>
    </div>
    ${typeSections}${sideSection}
    <div class="foot"><span>Eddies</span><span>${new Date().toLocaleDateString()}</span></div>
  </body></html>`;
}

// @[Card|Alias] -> highlighted name (no hover on a picture).
function exLinesHtml(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  const fmt = (l) => exEsc(l).replace(/@\[([^\]|]+)(?:\|([^\]]+))?\]/g, (_, n, a) => `<span class="ct">${a || n}</span>`);
  if (!lines.length) return '';
  return lines.length === 1 ? `<p>${fmt(lines[0])}</p>` : `<ul>${lines.map((l) => `<li>${fmt(l)}</li>`).join('')}</ul>`;
}

function exField(label, text) {
  const body = exLinesHtml(text);
  return body ? `<div class="field">${label ? `<h3>${label}</h3>` : ''}${body}</div>` : '';
}

// Page 2: the written game plan. Returns null when nothing is written.
function buildGamePlanPage(deck) {
  const s = deck.descSections || {};
  const legacy = (deck.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const block = (title, cls, fields, cols) => {
    const inner = fields.filter(Boolean).join('');
    return inner ? `<div class="block ${cls}"><h2>${title}</h2><div class="cols ${cols}">${inner}</div></div>` : '';
  };

  // thumbnails for the cards tagged in Key Cards
  const keyNames = [...new Set([...(s.combos || '').matchAll(/@\[([^\]|]+)/g)].map((m) => m[1]))];
  const thumbs = keyNames
    .map((name) => {
      const card = allCards.find((c) => c.displayName === name);
      if (!card) return '';
      const p = ownedPrintingsFor(card.cardId)[0] || card;
      return exportCardTile(p, 1);
    })
    .join('');
  const keyField = exField('', s.combos);
  const keyBlock = keyField ? `<div class="block key"><h2>Key cards</h2><div class="cols c1">${keyField}</div>${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}</div>` : '';

  const nameOf = (cardId) => cardById(cardId)?.displayName || cardId;
  const plans = (deck.swapPlans || [])
    .filter((p) => p.swaps?.length)
    .map((p) => `<div class="plan"><b>${exEsc(p.name || 'Plan')}</b>: ${p.swaps.map((w) => `${w.qty > 1 ? w.qty + '&times; ' : ''}<span class="ct">${exEsc(nameOf(w.out))}</span> &rArr; <span class="ct">${exEsc(nameOf(w.in))}</span>`).join(' &nbsp;·&nbsp; ')}</div>`)
    .join('');
  const sideField = exField('', s.sideboard);
  const sideBlock = sideField || plans ? `<div class="block side"><h2>Sideboard</h2><div class="cols c1">${sideField}</div>${plans}</div>` : '';

  const body = [
    block('Overview', '', [exField('', s.overview), !s.overview && legacy ? `<div class="field"><p>${exEsc(legacy)}</p></div>` : ''], 'c1'),
    block('Game plan', '', [exField('Early', s.early), exField('Mid', s.mid), exField('Late', s.late)], 'c3'),
    keyBlock,
    block('Mulligan', '', [exField('Keep / toss', s.mulligan), exField('Going first', s.mulliganFirst), exField('Going second', s.mulliganSecond)], 'c3'),
    sideBlock,
    block('Notes', 'notes', [exField('', s.notes)], 'c1')
  ].join('');
  if (!body.trim()) return null;

  const legends = [0, 1, 2].map((i) => (deck.legendCardIds[i] ? legendPrintingForDeck(deck, i) || cardById(deck.legendCardIds[i]) : null)).filter(Boolean);
  const head = `<div class="head"><div><h1>${exEsc(exportDeckName(deck))}</h1><div class="sub">Game plan</div></div><div class="head-r"><div class="legends-mini">${legends.map((p) => exportCardTile(p, 1)).join('')}</div>${exportChipsHtml(deck)}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${EXPORT_CSS}</style></head><body>${head}${body}<div class="foot"><span>Eddies</span><span>${new Date().toLocaleDateString()}</span></div></body></html>`;
}

// Entry point used by the Export modal.
async function exportDeckImages(deck) {
  const safe = exportDeckName(deck).replace(/[<>:"/\\|?*]/g, '_');
  const pages = [{ filename: `${safe} - Deck.png`, html: buildDeckPicturePage(deck) }];
  const plan = buildGamePlanPage(deck);
  if (plan) pages.push({ filename: `${safe} - Game Plan.png`, html: plan });
  const res = await window.api.exportDeckImages({ width: EXPORT_WIDTH, pages });
  return { ...res, skippedPlan: !plan };
}
