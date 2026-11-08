// Re-search flagged bot plays with one or more bot specs and show what each would do now.
//   node scripts/flag-decide.js [--kind misplay] [--id <flag id prefix>] [--seed S] <spec> [<spec> ...]
// Rebuilds the position before the flagged move (scripts/flags.js), gives each spec the bot's own view
// (botView: hidden cards re-dealt) and prints its top options with win chances. ">" = its pick,
// "hold" = scored best with no more attacks this turn (alt=1).
'use strict';
const fs = require('fs');
const play = require('../src/bot/play');
const { makeBot } = require('../src/bot/bots');
const { botView } = require('../src/bot/view');
const { mulberry } = require('../src/coach/bridge');
const { describe } = require('../src/bot/describe');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const kind = opt('--kind') || 'misplay', idF = opt('--id'), seed = +(opt('--seed') || 1);
const specs = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const rows = fs.readFileSync(play.FLAG_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const removed = new Set(rows.filter(r => r.remove).map(r => r.remove));
const seen = new Set();
const flags = rows.filter(r => r.id && !removed.has(r.id) && (r.kind || 'misplay') === kind && (!idF || r.id.startsWith(idF)))
  .filter(r => { const k = r.game.seed + ':' + r.mvBefore; if (seen.has(k)) return false; seen.add(k); return true; });
const bots = specs.map(s => ({ spec: s, bot: makeBot(s) }));
for (const f of flags) {
  const r = play.rebuild({ ...f.game, moves: f.moves }, f.mvBefore);
  console.log(`\n== ${f.line}\n   ${f.note || ''}`.slice(0, 400));
  if (!r) { console.log('   (could not rebuild)'); continue; }
  const me = r.wf.owner || r.b.active_player;
  for (const B of bots) {
    const ctx = { rng: mulberry(seed) }, t0 = Date.now();
    const seq = B.bot.act(botView(r.b, me, mulberry(seed + 1)), r.wf, me, ctx);
    const txt = q => { try { return describe(r.b, me, q); } catch { return JSON.stringify(q).slice(0, 80); } };
    console.log(`   [${B.spec.replace(/vnet=[^:]+:pnet=[^:]+:/, '')}] ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    for (const o of (ctx.last || []).slice(0, 6)) console.log(`     ${o.seq === seq ? '>' : ' '} ${(100 * o.value).toFixed(1).padStart(5)}%${o.hold ? ' hold' : '     '}${o.vg != null ? `  [then greedy ${(100 * o.vg).toFixed(1)} / no attacks ${(100 * o.vh).toFixed(1)}]` : ''}  ${txt(o.seq)}`);
  }
}
