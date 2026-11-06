// Build "coverage" decklists so the bot's nets see every legal card and Legend in play, not just the
// ~half the meta lists use. Writes src/bot/train-decks/coverage-NN.txt (training only: the arena and
// the deck guesser keep using the real lists in board/meta-decks).
//   node scripts/coverage-decks.js [--min 2] [--max 40] [--seed S]
// Each deck: 3 Legends with different names, chosen from the least-used ones (so every Legend shows up
// at least --min times), cards legal under their RAM ceilings, the least-used fitting cards first
// (2-3 copies each), then filled to 40 with fitting cards weighted by how much the meta plays them,
// steered toward the meta's cost curve. Every deck passes the engine's validateDeck.
'use strict';
const fs = require('fs');
const path = require('path');
const { CARDS, validateDeck } = require('../src/engine');
const { loadDecks } = require('../src/bot/arena');
const { mulberry } = require('../src/coach/bridge');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const MIN = flag('--min', 2), MAX = flag('--max', 40);
const rng = mulberry(flag('--seed', 2026));
const OUT = path.join(__dirname, '..', 'src', 'bot', 'train-decks');

const LEGAL = CARDS.filter(c => c.legal !== false);
const LEGENDS = LEGAL.filter(c => c.type === 'Legend');
const MAINS = LEGAL.filter(c => c.type !== 'Legend');
const base = c => c.name.split(':')[0];
const key = c => `${c.name}\u0000${c.subname || ''}`;

// meta play rate and cost curve
const meta = loadDecks();
const freq = new Map(), curve = new Map();
let metaCards = 0;
for (const d of meta) for (const { card_id, count } of d.cards) {
  freq.set(card_id, (freq.get(card_id) || 0) + count);
  const c = CARDS.find(x => x.number === card_id);
  curve.set(c.cost || 0, (curve.get(c.cost || 0) || 0) + count); metaCards += count;
}
const used = new Map();   // card number -> decks it appears in (meta lists count too)
for (const d of meta) { for (const n of d.legends) used.set(n, (used.get(n) || 0) + 1); for (const { card_id } of d.cards) used.set(card_id, (used.get(card_id) || 0) + 1); }

const pick = (arr, w) => { let u = rng() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < arr.length; i++) { u -= w[i]; if (u <= 0) return arr[i]; } return arr[arr.length - 1]; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ceilings = L => { const c = {}; for (const l of L) c[l.color] = (c[l.color] || 0) + (l.ram || 0); return c; };
const fits = (c, ceil) => !c.color || (c.ram || 0) <= (ceil[c.color] || 0);
const covered = () => LEGAL.every(c => (used.get(c.number) || 0) >= MIN);

function buildDeck() {
  // Legends: least-used first; the 2nd and 3rd lean toward the first one's colour (typical 4/2 splits)
  const minUse = Math.min(...LEGENDS.map(l => used.get(l.number) || 0));
  // a still-uncovered card that random Legends rarely allow (high RAM): build the Legends around it
  const hard = MAINS.filter(c => (used.get(c.number) || 0) < MIN && (c.ram || 0) > 4);
  const target = hard.length && rng() < 0.5 ? hard[Math.floor(rng() * hard.length)] : null;
  const first = target ? pick(LEGENDS.filter(l => l.color === target.color), LEGENDS.filter(l => l.color === target.color).map(() => 1))
    : pick(LEGENDS, LEGENDS.map(l => ((used.get(l.number) || 0) === minUse ? 10 : 1)));
  const L = [first];
  while (target && L.length < 3 && (ceilings(L)[target.color] || 0) < target.ram) {
    const pool = LEGENDS.filter(l => l.color === target.color && !L.some(x => base(x) === base(l)));
    if (!pool.length) break;
    L.push(pool.sort((a, b) => (b.ram || 0) - (a.ram || 0))[0]);
  }
  while (L.length < 3) {
    const pool = LEGENDS.filter(l => !L.some(x => base(x) === base(l)));
    L.push(pick(pool, pool.map(l => (1 + 3 / (1 + (used.get(l.number) || 0))) * (l.color === first.color ? 2 : 1))));
  }
  const ceil = ceilings(L);
  const fit = MAINS.filter(c => fits(c, ceil));
  const counts = new Map(), byKey = new Map();
  let size = 0;
  const add = (c, n) => {
    const k = key(c), room = 3 - (byKey.get(k) || 0), m = Math.min(n, room, 40 - size);
    if (m <= 0) return 0;
    counts.set(c.number, (counts.get(c.number) || 0) + m); byKey.set(k, (byKey.get(k) || 0) + m); size += m;
    return m;
  };
  // least-used fitting cards first
  const need = shuffle(fit.filter(c => (used.get(c.number) || 0) < MIN)).sort((a, b) => (used.get(a.number) || 0) - (used.get(b.number) || 0));
  for (const c of need.slice(0, 9)) add(c, 2 + (rng() < 0.5 ? 1 : 0));
  // fill toward the meta curve
  for (let guard = 0; size < 40 && guard < 5000; guard++) {
    const have = new Map();
    for (const [n, k] of counts) { const c = CARDS.find(x => x.number === n); have.set(c.cost || 0, (have.get(c.cost || 0) || 0) + k); }
    const w = fit.map(c => {
      const target = (curve.get(c.cost || 0) || 0) / metaCards * 40, gap = Math.max(0.2, target - (have.get(c.cost || 0) || 0));
      return ((freq.get(c.number) || 0) + 1) * gap;
    });
    add(pick(fit, w), 1 + (rng() < 0.6 ? 1 : 0));
  }
  return { legends: L, cards: [...counts].map(([card_id, count]) => ({ card_id, count })) };
}

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^coverage-\d+\.txt$/.test(f)) fs.unlinkSync(path.join(OUT, f));
let made = 0;
for (let tries = 0; made < MAX && !covered() && tries < MAX * 20; tries++) {
  const d = buildDeck();
  const v = validateDeck({ legends: d.legends.map(l => l.number), cards: d.cards });
  if (v.errors.length) continue;
  made++;
  for (const l of d.legends) used.set(l.number, (used.get(l.number) || 0) + 1);
  for (const { card_id } of d.cards) used.set(card_id, (used.get(card_id) || 0) + 1);
  const name = `coverage-${String(made).padStart(2, '0')}.txt`;
  const cols = [...new Set(d.legends.map(l => l.color))].join('/');
  const lines = [`# Coverage ${made}: ${d.legends.map(base).join(' / ')} (${cols})`, '// generated by scripts/coverage-decks.js - training only, not a real list', '', '// Legends',
    ...d.legends.map(l => `1 ${l.name}`), '', '// Main',
    ...d.cards.map(({ card_id, count }) => `${count} ${CARDS.find(c => c.number === card_id).name}`)];
  fs.writeFileSync(path.join(OUT, name), lines.join('\n') + '\n');
}
const miss = LEGAL.filter(c => (used.get(c.number) || 0) < MIN);
console.log(`${made} coverage decks in ${path.relative(process.cwd(), OUT)}; cards used < ${MIN} times (meta + coverage): ${miss.length}` + (miss.length ? ' - ' + miss.map(c => c.name).join(', ') : ''));
