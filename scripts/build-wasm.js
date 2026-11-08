// Compiles src/bot/nnkern.wat (SIMD kernels for the nets) into src/bot/nnkern.wasm. Only needed after editing
// the .wat - the .wasm is committed, so nothing extra is needed at run time.
//   node scripts/build-wasm.js [path to a node_modules folder that has wabt]   (npm install wabt somewhere)
'use strict';
const fs = require('fs');
const path = require('path');
const where = process.argv[2];
const wabtInit = require(where ? path.join(path.resolve(where), 'wabt') : 'wabt');
const SRC = path.join(__dirname, '..', 'src', 'bot', 'nnkern.wat'), OUT = SRC.replace(/\.wat$/, '.wasm');
wabtInit().then(wabt => {
  const mod = wabt.parseWat('nnkern.wat', fs.readFileSync(SRC, 'utf8'), { simd: true, bulk_memory: true });
  mod.validate();
  const { buffer } = mod.toBinary({});
  fs.writeFileSync(OUT, Buffer.from(buffer));
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${buffer.length} bytes)`);
});
