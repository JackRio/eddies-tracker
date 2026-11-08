#!/bin/sh
# after=1 (end-of-turn leaf) gates vs the current Daemon, Nov 8 2026
D='strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:gb=1:alt=1:tb=1'
cd "$(dirname "$0")/../.."
echo "#### after=1 pilot"; node scripts/pilot-arena.js "$D:after=1" "$D" --pairs 80 --seq --seed 4100000
echo "#### after=1 deals=16 k=8 pilot"; node scripts/pilot-arena.js "$D:after=1:deals=16:k=8" "$D" --pairs 80 --seq --seed 4200000
echo "#### DONE"
