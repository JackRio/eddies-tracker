#!/usr/bin/env node
// Rebuilds the seven rarity icons from the OFFICIAL Rarity Chart (Figure 2 of
// the Comprehensive Rules on cyberpunktcg.com), as 1024x1024 black-on-
// transparent PNGs used as CSS masks (the color comes from CSS).
//
//   node scripts/build-rarity-icons.js [path-or-url-to-chart.png]
//
// The chart is one image with the seven symbols on a black grid (white
// symbols, yellow labels). The script finds each symbol (connected white
// regions), upscales it with cubic sampling + a soft threshold so edges stay
// crisp, and centers it on the canvas. ONE shared scale is used for all seven,
// so they keep the official proportions (Epic is smaller than Rare, etc.).
// Output goes to both the website (docs/assets/rarity) and the app
// (src/renderer/assets/rarity). No dependencies; Node 18+.
//
// The chart URL contains the rules edition (2026-08) and a content hash, so it
// changes when the rules are republished - find the current one in the
// "Rarity" rule (3.16) of https://api.netdeck.gg/api/cyberpunk/comprehensive-rules
// (the image link in its body_markdown).

const fs = require('fs');
const path = require('path');
const { readPng, writePng } = require('./lib/png');

const DEFAULT_CHART = 'https://cyberpunktcg.com/comprehensive-rules/2026-08/figure-2-rarity-chart-e3b14b9c.png';
const ROOT = path.join(__dirname, '..');
const OUT_DIRS = [path.join(ROOT, 'docs', 'assets', 'rarity'), path.join(ROOT, 'src', 'renderer', 'assets', 'rarity')];
// Left-to-right, top row then bottom row, exactly as in the chart.
const NAMES = ['common', 'uncommon', 'rare', 'epic', 'secret-rare', 'iconic-rare', 'nova-rare'];
const CANVAS = 1024;

async function loadChart(src) {
  if (!/^https?:/.test(src)) return readPng(src);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`chart download failed: ${res.status}`);
  const tmp = path.join(require('os').tmpdir(), 'eddies-rarity-chart.png');
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  return readPng(tmp);
}

function findSymbols({ w, h, data }, white) {
  const lab = new Int32Array(w * h).fill(-1);
  const comps = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (white[i] <= 128 || lab[i] !== -1) continue;
    const id = comps.length, stack = [i];
    lab[i] = id;
    const c = { minx: x, maxx: x, miny: y, maxy: y, area: 0 };
    while (stack.length) {
      const p = stack.pop(), px = p % w, py = (p / w) | 0;
      c.area++;
      if (px < c.minx) c.minx = px; if (px > c.maxx) c.maxx = px; if (py < c.miny) c.miny = py; if (py > c.maxy) c.maxy = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (white[n] > 128 && lab[n] === -1) { lab[n] = id; stack.push(n); }
      }
    }
    comps.push(c);
  }
  // Pieces of one symbol (e.g. Rare's two chevrons) sit within ~40px of each other;
  // different symbols are over 100px apart.
  const big = comps.filter((c) => c.area > 40);
  const parent = big.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const G = 40;
  for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
    const a = big[i], b = big[j];
    if (a.minx - G <= b.maxx && b.minx - G <= a.maxx && a.miny - G <= b.maxy && b.miny - G <= a.maxy) parent[find(i)] = find(j);
  }
  const groups = {};
  big.forEach((c, i) => { (groups[find(i)] ||= []).push(c); });
  const symbols = Object.values(groups).map((g) => ({
    minx: Math.min(...g.map((c) => c.minx)), maxx: Math.max(...g.map((c) => c.maxx)),
    miny: Math.min(...g.map((c) => c.miny)), maxy: Math.max(...g.map((c) => c.maxy))
  }));
  symbols.sort((a, b) => (Math.abs(a.miny - b.miny) > 150 ? a.miny - b.miny : a.minx - b.minx));
  if (symbols.length !== NAMES.length) throw new Error(`expected ${NAMES.length} symbols, found ${symbols.length} - has the chart layout changed?`);
  symbols.forEach((s) => { s.w = s.maxx - s.minx + 1; s.h = s.maxy - s.miny + 1; });
  return symbols;
}

async function main() {
  const chart = await loadChart(process.argv[2] || DEFAULT_CHART);
  const { w, h, data } = chart;
  // "whiteness" = min(R,G,B): white symbols are high; the yellow labels and grid dots have a low blue channel.
  const white = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) white[i] = Math.round(Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) * (data[i * 4 + 3] / 255));
  const symbols = findSymbols(chart, white);

  const S = (CANVAS * 0.92) / Math.max(...symbols.map((s) => s.w)); // widest symbol (Secret Rare) fills ~92%
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : Math.max(0, Math.min(1, (white[y * w + x] - 40) / 190)));
  const cr = (t) => { t = Math.abs(t); return t < 1 ? 1.5 * t ** 3 - 2.5 * t ** 2 + 1 : t < 2 ? -0.5 * t ** 3 + 2.5 * t ** 2 - 4 * t + 2 : 0; };
  const sample = (fx, fy) => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    let v = 0;
    for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) v += alphaAt(x0 + i, y0 + j) * cr(fx - (x0 + i)) * cr(fy - (y0 + j));
    return Math.max(0, Math.min(1, v));
  };
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  symbols.forEach((s, idx) => {
    const buf = Buffer.alloc(CANVAS * CANVAS * 4); // RGB stays 0 = black
    const cx = (s.minx + s.maxx + 1) / 2, cy = (s.miny + s.maxy + 1) / 2;
    for (let y = 0; y < CANVAS; y++) for (let x = 0; x < CANVAS; x++) {
      const sx = cx + (x + 0.5 - CANVAS / 2) / S - 0.5, sy = cy + (y + 0.5 - CANVAS / 2) / S - 0.5;
      if (sx < s.minx - 4 || sx > s.maxx + 4 || sy < s.miny - 4 || sy > s.maxy + 4) continue;
      buf[(y * CANVAS + x) * 4 + 3] = Math.round(smooth(0.38, 0.62, sample(sx, sy)) * 255);
    }
    for (const dir of OUT_DIRS) writePng(path.join(dir, NAMES[idx] + '.png'), CANVAS, CANVAS, buf);
    console.log(NAMES[idx].padEnd(12), `${s.w}x${s.h} px in chart`);
  });
  console.log(`Wrote ${NAMES.length} icons to ${OUT_DIRS.length} folders (scale ${S.toFixed(2)}x).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
