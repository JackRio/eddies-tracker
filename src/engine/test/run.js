#!/usr/bin/env node
// Runs every test in test/cases/ (each is a standalone script that exits non-zero on failure),
// then the self-play fuzz over the meta decks.  Usage: node test/run.js [filter] [--fuzz N]
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const fuzzIdx = args.indexOf('--fuzz');
const fuzzN = fuzzIdx >= 0 ? args[fuzzIdx + 1] : '3';
const filter = args.find((a, i) => !a.startsWith('--') && !(fuzzIdx >= 0 && i === fuzzIdx + 1));

const dir = path.join(__dirname, 'cases');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && (!filter || f.includes(filter))).sort() : [];
let pass = 0, fail = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  if (r.status === 0) { pass++; console.log(`  ok    ${f}`); }
  else { fail++; console.log(`  FAIL  ${f}\n${(r.stdout + r.stderr).trim().split('\n').map(l => '        ' + l).join('\n')}`); }
}
console.log(`\n${pass} passed, ${fail} failed (${files.length} tests)`);

if (!filter && fuzzN !== '0') {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'fuzz.js'), fuzzN], { encoding: 'utf8' });
  process.stdout.write('\nfuzz: ' + r.stdout + r.stderr);
  if (r.status !== 0) fail++;
}
process.exit(fail ? 1 : 0);
