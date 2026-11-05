// Card identity across the three naming schemes the coach meets:
//   sim cardId   "meredith_stout_stone_cold_corpo"     (replays)
//   sim name     "Meredith Stout — Stone Cold Corpo"   (replays; newer servers write "Name: Subtitle")
//   catalog UUID "40502c1f-..."                        (docs/data/catalog.json, published decks)
// All resolve to the engine's card number ("WNTC-001") by letters-only name matching,
// the same rule test/decks.js uses.
'use strict';
const path = require('path');
const fs = require('fs');
const { CARDS } = require('../engine');

const letters = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const byLetters = new Map();
for (const c of CARDS) if (!byLetters.has(letters(c.name))) byLetters.set(letters(c.name), c);
const byNumber = new Map(CARDS.map(c => [c.number, c]));

// "Meredith Stout — Stone Cold Corpo", "V: Streetkid", "meredith_stout_stone_cold_corpo" all work.
function engineCard(nameOrSimId) {
  return byLetters.get(letters(nameOrSimId)) || null;
}
const cardByNumber = n => byNumber.get(n) || null;

let catalog = null;
function catalogCard(uuid) {
  if (!catalog) {
    catalog = new Map();
    const file = path.join(__dirname, '..', '..', 'docs', 'data', 'catalog.json');
    try { for (const e of JSON.parse(fs.readFileSync(file, 'utf8'))) if (!catalog.has(e.cardId)) catalog.set(e.cardId, e); } catch { /* no catalog */ }
  }
  const e = catalog.get(uuid);
  return e ? engineCard(e.displayName || `${e.name}: ${e.subname}`) : null;
}

// Published decks (docs/data/published-decks.json) as engine decks:
// { name, legends: [number], cards: Map(number -> count) }
let published = null;
function publishedDecks() {
  if (published) return published;
  published = [];
  const file = path.join(__dirname, '..', '..', 'docs', 'data', 'published-decks.json');
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return published; }
  for (const d of raw) {
    const legends = (d.legendCardIds || []).map(catalogCard).filter(Boolean).map(c => c.number);
    const cards = new Map();
    for (const [uuid, n] of Object.entries(d.cards || {})) {
      const c = catalogCard(uuid);
      if (c) cards.set(c.number, (cards.get(c.number) || 0) + n);
    }
    if (legends.length && cards.size) published.push({ id: d.id, name: (d.name || '').trim(), legends, cards });
  }
  return published;
}

// Meta decklists as text ("3 Card Name" per line, "//" and "#" lines ignored), from
// board/meta-decks/*.txt (yours to fill) and the engine's own test decks. Used to guess the Rival's
// unseen cards: the closer a meta list matches what they showed, the more it shapes the guess.
let meta = null;
function metaDecks() {
  if (meta) return meta;
  meta = [];
  const dirs = [path.join(__dirname, '..', '..', 'board', 'meta-decks'), path.join(__dirname, '..', 'engine', 'test', 'decks')];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')); } catch { continue; }
    for (const f of files) {
      const legends = [], cards = new Map();
      let title = f.replace(/\.txt$/, '');
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
        const h = line.match(/^#\s*(.+)/); if (h) { title = h[1].trim(); continue; }
        const m = line.match(/^\s*(\d+)\s*x?\s+(.+?)\s*$/); if (!m) continue;
        const c = engineCard(m[2]); if (!c) continue;
        if (c.type === 'Legend') legends.push(c.number); else cards.set(c.number, (cards.get(c.number) || 0) + +m[1]);
      }
      if (legends.length && cards.size) meta.push({ id: f, name: title, legends, cards, meta: true });
    }
  }
  return meta;
}

module.exports = { letters, engineCard, cardByNumber, catalogCard, publishedDecks, metaDecks, CARDS };
