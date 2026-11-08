// Worker thread for the Game Review (review-service.js): reviews one move at a time.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const R = require('./review');

const P = R.prepare(workerData.file);
const turns = R.turnsOf(P);

parentPort.on('message', ({ ti, mi }) => {
  try {
    const move = R.reviewMove(P, turns[ti].moves[mi], R.DEFAULTS);
    parentPort.postMessage({ ok: true, ti, mi, move });
  } catch (e) {
    parentPort.postMessage({ ok: false, ti, mi, error: `T${turns[ti]?.T.turn} move ${mi + 1}: ${e.message}` });
  }
});
