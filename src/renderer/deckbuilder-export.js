// Picture export: draws two PNGs for a deck straight onto a <canvas> in this
// window - no hidden windows or screenshots involved.
//   1. "<name> - Deck.png"      Legends, every card's art with a xN badge, the
//                               sideboard, cost curve, type/color/sellable donuts
//   2. "<name> - Game Plan.png" the written description sections (skipped when
//                               nothing is written)
// Card art comes through the cardimg:// protocol, which sends a CORS header so
// drawing it doesn't taint the canvas (see protocol.handle in main.js).
// Loaded before deckbuilder.js and uses its globals at call time.

const PX_W = 1600;
const PX_PAD = 48;
const PX_INNER = PX_W - PX_PAD * 2;
const PX_CARD_RATIO = 88 / 63;
const PX = {
  bg: '#0a0a0f', panel: '#131319', card: '#17171f', border: '#2a2a35', text: '#e8e8ec', dim: '#8b8b96', faint: '#55555f',
  yellow: '#f5e400', cyan: '#1de1e1', red: '#ff4d4d', green: '#4dff88', orange: '#ff9f43', purple: '#b866ff', creator: '#ff7b7b'
};
const PX_COLORS = { Red: '#e8465a', Blue: '#3d8bfd', Green: '#3ecf6e', Yellow: '#e8c93a' };
const PX_TYPES = { Unit: '#4da6ff', Gear: '#ff9f43', Program: '#b866ff' };
const pxFont = (size, weight = 400) => `${weight} ${size}px "Segoe UI", system-ui, sans-serif`;

const pxMeasure = document.createElement('canvas').getContext('2d');
function pxTextW(text, font, spacing = '0px') {
  pxMeasure.font = font;
  pxMeasure.letterSpacing = spacing;
  return pxMeasure.measureText(text).width;
}

function pxLoadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function pxRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function pxText(ctx, text, x, y, font, color, spacing = '0px', align = 'left') {
  ctx.font = font;
  ctx.letterSpacing = spacing;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
}

// Card art, cropped to the card shape, with an optional xN badge.
function pxCard(ctx, img, x, y, w, qty) {
  const h = w * PX_CARD_RATIO;
  ctx.save();
  pxRoundRect(ctx, x, y, w, h, Math.max(5, w * 0.05));
  ctx.fillStyle = PX.card;
  ctx.fill();
  ctx.clip();
  if (img) {
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  ctx.restore();
  if (qty > 1) {
    const label = `×${qty}`;
    const font = pxFont(21, 800);
    const bw = pxTextW(label, font) + 22;
    pxRoundRect(ctx, x + w - 8 - bw, y + 8, bw, 30, 15);
    ctx.fillStyle = PX.yellow;
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
    pxText(ctx, label, x + w - 8 - bw / 2, y + 11, font, '#000', '0px', 'center');
  }
}

// "@[Card|Alias]" text -> runs; card names in cyan.
function pxRuns(text, size = 22, color = PX.text) {
  const runs = [];
  const re = /@\[([^\]|]+)(?:\|([^\]]+))?\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index), c: color, f: pxFont(size) });
    runs.push({ t: m[2] || m[1], c: PX.cyan, f: pxFont(size, 600) });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ t: text.slice(last), c: color, f: pxFont(size) });
  return runs;
}

// Word-wraps runs to maxW. Returns lines of positioned pieces.
function pxWrap(runs, maxW) {
  const lines = [];
  let cur = [];
  let x = 0;
  for (const r of runs) {
    for (const tok of r.t.split(/(\s+)/)) {
      if (!tok) continue;
      const space = /^\s+$/.test(tok);
      const w = pxTextW(tok, r.f);
      if (!space && x > 0 && x + w > maxW) {
        lines.push(cur);
        cur = [];
        x = 0;
      }
      if (space && x === 0) continue;
      cur.push({ t: tok, c: r.c, f: r.f, x });
      x += w;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function pxDrawLines(ctx, lines, x, y, lh) {
  lines.forEach((line, i) => {
    for (const p of line) {
      ctx.font = p.f;
      ctx.fillStyle = p.c;
      ctx.fillText(p.t, x + p.x, y + i * lh);
    }
  });
}

// Tag chips (color tag + archetype/creator/misc), right-aligned rows.
function pxChips(deck) {
  const chips = [];
  const color = colorTagOf(deck);
  if (color) chips.push({ runs: [...color].map((l) => ({ t: l, c: PX_COLORS[COLOR_LETTER[l]] })), stroke: PX.border, weight: 800 });
  const ids = deckTagIds(deck);
  const catColor = { archetype: PX.cyan, creator: PX.creator, misc: PX.purple };
  for (const cat of ['archetype', 'creator', 'misc']) {
    for (const id of ids[cat]) if (id !== FEATURED_ID) chips.push({ runs: [{ t: tagOf(id).name, c: catColor[cat] }], stroke: catColor[cat], weight: 600 });
  }
  if (!chips.length) return null;
  const H = 34;
  const GAP = 8;
  const MAX = 640;
  for (const c of chips) {
    c.font = pxFont(18, c.weight);
    c.spacing = c.weight === 800 ? '2px' : '0px';
    c.w = c.runs.reduce((s, r) => s + pxTextW(r.t, c.font, c.spacing), 0) + 28;
  }
  const rows = [[]];
  let rowW = 0;
  for (const c of chips) {
    if (rows[rows.length - 1].length && rowW + GAP + c.w > MAX) {
      rows.push([]);
      rowW = 0;
    }
    rowW += (rows[rows.length - 1].length ? GAP : 0) + c.w;
    rows[rows.length - 1].push(c);
  }
  const rowWidth = (row) => row.reduce((s, c) => s + c.w, 0) + GAP * (row.length - 1);
  const w = Math.max(...rows.map(rowWidth));
  return {
    w,
    h: rows.length * H + (rows.length - 1) * GAP,
    draw(ctx, right, y) {
      rows.forEach((row, ri) => {
        let x = right - rowWidth(row);
        const cy = y + ri * (H + GAP);
        for (const c of row) {
          pxRoundRect(ctx, x, cy, c.w, H, H / 2);
          ctx.fillStyle = PX.card;
          ctx.fill();
          ctx.globalAlpha = 0.6;
          ctx.strokeStyle = c.stroke;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
          let tx = x + 14;
          for (const r of c.runs) {
            pxText(ctx, r.t, tx, cy + 6, c.font, r.c, c.spacing);
            tx += pxTextW(r.t, c.font, c.spacing);
          }
          x += c.w + GAP;
        }
      });
    }
  };
}

// Header: big deck name + subtitle on the left, `right` block on the right,
// yellow rule underneath. Returns the y where content starts.
function pxHeader(ops, y, title, sub, right) {
  const name = title.toUpperCase();
  const maxW = PX_INNER - (right ? right.w + 30 : 0);
  let size = 46;
  while (size > 26 && pxTextW(name, pxFont(size, 700), '1px') > maxW) size -= 2;
  const h = Math.max(size + 14 + 26, right ? right.h : 0);
  ops.push((ctx) => {
    pxText(ctx, name, PX_PAD, y, pxFont(size, 700), PX.text, '1px');
    pxText(ctx, sub, PX_PAD, y + size + 14, pxFont(20), PX.dim);
    if (right) right.draw(ctx, PX_W - PX_PAD, y);
    ctx.fillStyle = PX.yellow;
    ctx.fillRect(PX_PAD, y + h + 16, PX_INNER, 3);
  });
  return y + h + 16 + 3 + 28;
}

function pxLabel(ctx, text, x, y, count) {
  const font = pxFont(22, 700);
  pxText(ctx, text.toUpperCase(), x, y, font, PX.yellow, '2px');
  if (count != null) pxText(ctx, String(count), x + pxTextW(text.toUpperCase(), font, '2px') + 12, y + 3, pxFont(18, 600), PX.dim);
}

function pxFooter(ops, y) {
  ops.push((ctx) => {
    pxText(ctx, 'EDDIES', PX_PAD, y, pxFont(15, 600), PX.faint, '2px');
    pxText(ctx, new Date().toLocaleDateString(), PX_W - PX_PAD, y, pxFont(15, 600), PX.faint, '1px', 'right');
  });
  return y + 15 + 36;
}

function pxPanel(ctx, x, y, w, h, accent) {
  pxRoundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = PX.panel;
  ctx.fill();
  ctx.strokeStyle = PX.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (accent) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, 4, h);
    ctx.restore();
  }
}

function pxDonut(ctx, cx, top, blockW, title, segments) {
  pxText(ctx, title.toUpperCase(), cx, top, pxFont(15, 700), PX.dim, '1.5px', 'center');
  const cy = top + 32 + 65;
  const total = segments.reduce((s, x) => s + x.count, 0);
  ctx.lineWidth = 28;
  if (!total) {
    ctx.beginPath();
    ctx.arc(cx, cy, 51, 0, Math.PI * 2);
    ctx.strokeStyle = PX.card;
    ctx.stroke();
  }
  let a = -Math.PI / 2;
  for (const s of segments) {
    if (!s.count) continue;
    const b = a + (s.count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 51, a, b);
    ctx.strokeStyle = s.color;
    ctx.stroke();
    a = b;
  }
  pxText(ctx, String(total), cx, cy - 14, pxFont(24, 700), PX.text, '0px', 'center');
  // legend, wrapped and centred
  const font = pxFont(16);
  const items = segments.filter((s) => s.count).map((s) => ({ ...s, label: `${s.label} ${s.count}`, w: 15 + pxTextW(`${s.label} ${s.count}`, font) }));
  const rows = [[]];
  let rw = 0;
  for (const it of items) {
    if (rows[rows.length - 1].length && rw + 14 + it.w > blockW - 20) {
      rows.push([]);
      rw = 0;
    }
    rw += (rows[rows.length - 1].length ? 14 : 0) + it.w;
    rows[rows.length - 1].push(it);
  }
  rows.forEach((row, ri) => {
    const width = row.reduce((s, it) => s + it.w, 0) + 14 * (row.length - 1);
    let x = cx - width / 2;
    const y = cy + 65 + 16 + ri * 24;
    for (const it of row) {
      ctx.beginPath();
      ctx.arc(x + 5, y + 10, 5, 0, Math.PI * 2);
      ctx.fillStyle = it.color;
      ctx.fill();
      pxText(ctx, it.label, x + 15, y, font, '#cfcfd6');
      x += it.w + 14;
    }
  });
}

function pxEntries(map) {
  return Object.entries(map || {})
    .map(([cardId, qty]) => ({ cardId, card: cardById(cardId), qty }))
    .filter((e) => e.card && e.qty > 0)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));
}

function pxLegendPrintings(deck) {
  return [0, 1, 2].map((i) => (deck.legendCardIds[i] ? legendPrintingForDeck(deck, i) || cardById(deck.legendCardIds[i]) : null)).filter(Boolean);
}

// ---- Page 1: the deck ---------------------------------------------------------

function pxDeckPage(deck, imgs) {
  const ops = [];
  const stats = computeDeckStats(deck);
  const sub = `${stats.total} cards · ${stats.legendsFilled} Legends · ${stats.sellablePct}% sellable`;
  let y = pxHeader(ops, PX_PAD, deck.name || 'Untitled Deck', sub, pxChips(deck));

  // Legends (left) + stats panels (right)
  const legends = pxLegendPrintings(deck);
  const LW = 215;
  const LH = LW * PX_CARD_RATIO;
  const statsX = PX_PAD + LW * 3 + 16 * 2 + 40;
  const statsW = PX_W - PX_PAD - statsX;
  const CURVE_H = 214;
  const DONUT_H = 262;
  const topY = y;
  ops.push((ctx) => {
    pxLabel(ctx, 'Legends', PX_PAD, topY);
    legends.forEach((p, i) => pxCard(ctx, imgs.get(p.imageUrl), PX_PAD + i * (LW + 16), topY + 38, LW, 1));

    // cost curve
    pxPanel(ctx, statsX, topY, statsW, CURVE_H);
    pxLabel(ctx, 'Eddie cost curve', statsX + 20, topY + 16);
    const buckets = [0, 1, 2, 3, 4, 5, 6, 7];
    const max = Math.max(1, ...buckets.map((b) => stats.costCounts[b] || 0));
    const colW = (statsW - 40 - 7 * 12) / 8;
    const base = topY + CURVE_H - 40;
    buckets.forEach((b, i) => {
      const n = stats.costCounts[b] || 0;
      const x = statsX + 20 + i * (colW + 12);
      const h = Math.max(3, (n / max) * 110);
      pxRoundRect(ctx, x, base - h, colW, h, [4, 4, 0, 0]);
      ctx.fillStyle = PX.cyan;
      ctx.fill();
      if (n) pxText(ctx, String(n), x + colW / 2, base - h - 24, pxFont(17, 700), PX.text, '0px', 'center');
      pxText(ctx, b === 7 ? '7+' : String(b), x + colW / 2, base + 8, pxFont(16), PX.dim, '0px', 'center');
    });

    // donuts
    const dy = topY + CURVE_H + 18;
    pxPanel(ctx, statsX, dy, statsW, DONUT_H);
    const bw = statsW / 3;
    pxDonut(ctx, statsX + bw * 0.5, dy + 16, bw, 'Card types', TYPE_ORDER.map((t) => ({ label: `${t}s`, count: stats.typeCounts[t] || 0, color: PX_TYPES[t] })));
    pxDonut(ctx, statsX + bw * 1.5, dy + 16, bw, 'Colors', COLOR_ORDER.map((c) => ({ label: c, count: stats.colorCounts[c] || 0, color: PX_COLORS[c] })));
    pxDonut(ctx, statsX + bw * 2.5, dy + 16, bw, 'Sellable', [
      { label: 'Sellable', count: stats.sellable, color: PX.green },
      { label: 'Unsellable', count: stats.unsellable, color: PX.red }
    ]);
  });
  y = topY + Math.max(38 + LH, CURVE_H + 18 + DONUT_H) + 34;

  // card grids
  const COLS = 8;
  const GAP = 14;
  const CW = (PX_INNER - GAP * (COLS - 1)) / COLS;
  const CH = CW * PX_CARD_RATIO;
  const grid = (title, count, items) => {
    if (!items.length) return;
    const top = y;
    ops.push((ctx) => {
      pxLabel(ctx, title, PX_PAD, top, count);
      items.forEach((it, i) => pxCard(ctx, imgs.get(it.printing.imageUrl), PX_PAD + (i % COLS) * (CW + GAP), top + 40 + Math.floor(i / COLS) * (CH + GAP), CW, it.qty));
    });
    const rows = Math.ceil(items.length / COLS);
    y = top + 40 + rows * CH + (rows - 1) * GAP + 30;
  };
  const main = pxEntries(deck.cards);
  for (const type of TYPE_ORDER) {
    const list = main.filter((e) => e.card.cardType === type);
    grid(`${type}s`, list.reduce((s, e) => s + e.qty, 0), list.map((e) => {
      const printings = printingsForCardEntry(deck, e.cardId, e.qty);
      return { printing: printings[printings.length - 1] || e.card, qty: e.qty };
    }));
  }
  const side = pxEntries(deck.sideboard);
  grid('Sideboard', `${side.reduce((s, e) => s + e.qty, 0)}/${SIDEBOARD_SIZE}`, side.map((e) => ({ printing: e.card, qty: e.qty })));

  y = pxFooter(ops, y);
  return { ops, height: y };
}

// ---- Page 2: the game plan ----------------------------------------------------

const PX_TEXT = 22;
const PX_LH = 32;

// A column = optional label + one paragraph, or bullets when several lines.
function pxColumn(label, text, width) {
  const items = String(text || '').split(/\n+/).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  if (!items.length) return null;
  const bullet = items.length > 1;
  const indent = bullet ? 26 : 0;
  const wrapped = items.map((t) => pxWrap(pxRuns(t, PX_TEXT), width - indent));
  const labelH = label ? 30 : 0;
  const height = labelH + wrapped.reduce((s, l) => s + l.length * PX_LH, 0) + (wrapped.length - 1) * 8;
  return {
    height,
    draw(ctx, x, y) {
      if (label) pxText(ctx, label.toUpperCase(), x, y, pxFont(17, 700), PX.dim, '1.5px');
      let cy = y + labelH;
      for (const lines of wrapped) {
        if (bullet) {
          ctx.beginPath();
          ctx.arc(x + 8, cy + 15, 4, 0, Math.PI * 2);
          ctx.fillStyle = PX.text;
          ctx.fill();
        }
        pxDrawLines(ctx, lines, x + indent, cy, PX_LH);
        cy += lines.length * PX_LH + 8;
      }
    }
  };
}

function pxPlanPage(deck, imgs) {
  const s = deck.descSections || {};
  const legacy = (deck.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const ops = [];
  const legends = pxLegendPrintings(deck);
  const MW = 78;
  const right = legends.length
    ? { w: legends.length * MW + (legends.length - 1) * 10, h: MW * PX_CARD_RATIO, draw: (ctx, r, y) => legends.forEach((p, i) => pxCard(ctx, imgs.get(p.imageUrl), r - (legends.length - i) * MW - (legends.length - 1 - i) * 10, y, MW, 1)) }
    : null;
  let y = pxHeader(ops, PX_PAD, deck.name || 'Untitled Deck', 'Game plan', right);
  const contentTop = y;

  const INNER = PX_INNER - 4 - 48; // panel padding + accent bar
  const block = (title, accent, fields, extras = []) => {
    const n = fields.length;
    const colW = (INNER - (n - 1) * 30) / n;
    const cols = fields.map(([label, text]) => pxColumn(label, text, colW));
    const extraH = extras.reduce((sum, e) => sum + e.height, 0);
    if (!cols.some(Boolean) && !extraH) return;
    // single-field blocks don't need a label; multi-column ones keep empty
    // columns as blank space so Early/Mid/Late stay aligned
    const colsH = Math.max(0, ...cols.map((c) => (c ? c.height : 0)));
    const height = 20 + 34 + colsH + extraH + 22;
    const top = y;
    ops.push((ctx) => {
      pxPanel(ctx, PX_PAD, top, PX_INNER, height, accent);
      pxLabel(ctx, title, PX_PAD + 28, top + 20);
      cols.forEach((c, i) => c && c.draw(ctx, PX_PAD + 28 + i * (colW + 30), top + 20 + 34));
      let ey = top + 20 + 34 + colsH;
      for (const e of extras) {
        e.draw(ctx, PX_PAD + 28, ey);
        ey += e.height;
      }
    });
    y = top + height + 22;
  };

  block('Overview', PX.yellow, [['', s.overview || (legacy && !s.overview ? legacy : '')]]);
  block('Game plan', PX.yellow, [['Early', s.early], ['Mid', s.mid], ['Late', s.late]]);

  // Key cards + thumbnails of every card tagged there
  if ((s.combos || '').trim()) {
    const names = [...new Set([...s.combos.matchAll(/@\[([^\]|]+)/g)].map((m) => m[1]))];
    const thumbs = names
      .map((n) => allCards.find((c) => c.displayName === n))
      .filter(Boolean)
      .map((c) => ownedPrintingsFor(c.cardId)[0] || c);
    const TW = 150;
    const perRow = Math.floor((INNER + 14) / (TW + 14));
    const rows = Math.ceil(thumbs.length / perRow);
    const extras = thumbs.length
      ? [{ height: 18 + rows * TW * PX_CARD_RATIO + (rows - 1) * 14, draw: (ctx, x, ey) => thumbs.forEach((p, i) => pxCard(ctx, imgs.get(p.imageUrl), x + (i % perRow) * (TW + 14), ey + 18 + Math.floor(i / perRow) * (TW * PX_CARD_RATIO + 14), TW, 1)) }]
      : [];
    block('Key cards', PX.cyan, [['', s.combos]], extras);
  }

  block('Mulligan', PX.yellow, [['Keep / toss', s.mulligan], ['Going first', s.mulliganFirst], ['Going second', s.mulliganSecond]]);

  // Sideboard text + swap plans
  const nameOf = (id) => cardById(id)?.displayName || id;
  const planLines = (deck.swapPlans || [])
    .filter((p) => p.swaps?.length)
    .map((p) => {
      const runs = [{ t: `${p.name || 'Plan'}: `, c: PX.orange, f: pxFont(20, 700) }];
      p.swaps.forEach((w, i) => {
        if (i) runs.push({ t: '  ·  ', c: PX.dim, f: pxFont(20) });
        if (w.qty > 1) runs.push({ t: `${w.qty}× `, c: '#cfcfd6', f: pxFont(20) });
        runs.push({ t: nameOf(w.out), c: PX.cyan, f: pxFont(20, 600) }, { t: ' ⇒ ', c: '#cfcfd6', f: pxFont(20) }, { t: nameOf(w.in), c: PX.cyan, f: pxFont(20, 600) });
      });
      return pxWrap(runs, INNER);
    });
  const plansExtra = planLines.length
    ? [{ height: 10 + planLines.reduce((sum, l) => sum + l.length * 30 + 6, 0), draw: (ctx, x, ey) => {
        let cy = ey + 10;
        for (const lines of planLines) {
          pxDrawLines(ctx, lines, x, cy, 30);
          cy += lines.length * 30 + 6;
        }
      } }]
    : [];
  block('Sideboard', PX.orange, [['', s.sideboard]], plansExtra);
  block('Notes', PX.red, [['', s.notes]]);

  if (y === contentTop) return null;
  y = pxFooter(ops, y);
  return { ops, height: y };
}

// ---- Render + save ------------------------------------------------------------

function pxRender({ ops, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = PX_W;
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PX.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = 'top';
  for (const op of ops) {
    ctx.save();
    op(ctx);
    ctx.restore();
  }
  return canvas;
}

function pxPngBytes(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('Could not encode the PNG.'))), 'image/png')
  );
}

// Every image either page will draw, loaded once up front.
async function pxPreload(deck) {
  const urls = new Set(pxLegendPrintings(deck).map((p) => p.imageUrl));
  for (const e of pxEntries(deck.cards)) {
    const list = printingsForCardEntry(deck, e.cardId, e.qty);
    urls.add((list[list.length - 1] || e.card).imageUrl);
  }
  for (const e of pxEntries(deck.sideboard)) urls.add(e.card.imageUrl);
  for (const m of String(deck.descSections?.combos || '').matchAll(/@\[([^\]|]+)/g)) {
    const c = allCards.find((x) => x.displayName === m[1]);
    if (c) urls.add((ownedPrintingsFor(c.cardId)[0] || c).imageUrl);
  }
  const imgs = new Map();
  await Promise.all([...urls].filter(Boolean).map(async (u) => imgs.set(u, await pxLoadImage(u))));
  return imgs;
}

// Entry point used by the Export modal.
async function exportDeckImages(deck) {
  if (document.fonts?.ready) await document.fonts.ready;
  const imgs = await pxPreload(deck);
  const safe = (deck.name || 'Untitled Deck').trim().replace(/[<>:"/\\|?*]/g, '_');
  const files = [{ filename: `${safe} - Deck.png`, bytes: await pxPngBytes(pxRender(pxDeckPage(deck, imgs))) }];
  const plan = pxPlanPage(deck, imgs);
  if (plan) files.push({ filename: `${safe} - Game Plan.png`, bytes: await pxPngBytes(pxRender(plan)) });
  const missingArt = [...imgs.values()].filter((i) => !i).length;
  const res = await window.api.saveDeckImages(files);
  return { ...res, skippedPlan: !plan, missingArt };
}
