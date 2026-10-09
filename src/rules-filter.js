// Strips the parts of the rules text that are about the physical/social side of
// playing, not about how the game is played, before it is given to the AI:
// page header/footer noise, the "Respect Your Rival" conduct block, and the
// component rules (dice quality, sleeves). Pure string-in/string-out so it can
// be run from node directly:  node src/rules-filter.js   (prints what it cut)

// Whole blocks: from a line equal to `start` up to (not including) the next
// numbered section heading like "03 CARD INFORMATION".
const DROP_BLOCKS = ['RESPECT YOUR RIVAL'];

// Single numbered rules (plus their continuation lines) that are about
// components/meta, not gameplay. 7.2.x = dice must be balanced/legible (7.2
// itself stays: it says which dice exist),
// 7.3.7 = sleeve regulations, 1.3 = translations.
const DROP_RULES = new Set(['1.3', '7.2.1', '7.2.2', '7.2.3', '7.2.4', '7.3.7']);

const NOISE = [
  /^Cyberpunk Trading Card Game https:\/\/\S+\s*$/, // page footer
  /^\d+ of \d+ \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}\s*$/ // "4 of 51 17/09/2026, 21:42"
];

const SECTION_HEADING = /^\d{2} [A-Z]/;
const RULE_LINE = /^(\d+(?:\.\d+)+)\s/;
// ALL-CAPS sub-heading such as "PRE-GAME SETUP". EXAMPLE:/TIP: labels belong to
// the rule above them, so they don't count.
const SUB_HEADING = /^[A-Z0-9][A-Z0-9 ,&'’\-:.()/]+$/;
const LABELS = new Set(['EXAMPLE:', 'TIP:', 'NOTE:']);

function filterRules(text) {
  const out = [];
  let inBlock = false;
  let dropRule = false;
  for (const line of text.split(/\r?\n/)) {
    if (NOISE.some((re) => re.test(line))) continue;
    if (SECTION_HEADING.test(line)) {
      inBlock = false;
      dropRule = false;
    } else if (DROP_BLOCKS.includes(line.trim())) {
      inBlock = true;
    }
    if (inBlock) continue;

    const rule = RULE_LINE.exec(line);
    if (rule) dropRule = DROP_RULES.has(rule[1]);
    else if (SUB_HEADING.test(line.trim()) && !LABELS.has(line.trim())) dropRule = false;
    if (dropRule) continue;

    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { filterRules };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'rules.txt'), 'utf-8');
  const kept = filterRules(raw);
  const keptSet = new Set(kept.split(/\r?\n/));
  const cut = raw.split(/\r?\n/).filter((l) => !keptSet.has(l) && l.trim());
  console.log(`raw ${raw.length} chars -> filtered ${kept.length} chars (${Math.round((1 - kept.length / raw.length) * 100)}% removed)`);
  console.log('\n--- removed lines (excluding page header/footer noise) ---');
  console.log(cut.filter((l) => !NOISE.some((re) => re.test(l))).join('\n'));
}
