"""Train the policy ("intuition") net on strong-bot search records, and measure what it learned.

    D:/Codebase/venv/nitorch/Scripts/python.exe scripts/train-policy.py [policy-data.jsonl ...]
        [--out src/bot/policy-net.json] [--epochs 15] [--tau 0.03] [--report notes/policy-report.json]

The net scores (position, move) pairs; a softmax over a decision's legal moves is its "intuition".
Trained to match the search: target = softmax(search value / tau) over the moves the search tried.

Strategy metrics on held-out games (every 10th game), each compared with the greedy ranking:
  agree            - top choice is a best move by the search's values (within 0.005; exact ties are
                     common - attack orders, equivalent picks - so the literal pick isn't the target)
  agree_nonobvious - same, only on decisions where greedy's top choice was clearly worse
                     (the search knew something the one-move heuristic didn't)
  gem_recall@k     - "discoveries": decisions where the search's pick came from exploration (greedy
                     would never have shortlisted it) and it beat greedy's choice by >= 0.03 win
                     chance. Recall@k = the net ranks that move in its top k, i.e. it would now be
                     shortlisted without exploration. This is the "did it learn the combo" number.
  regret           - average win chance lost vs the search's best, picking the top-ranked move
  by_kind          - agreement per move type (equip, Spend, interrupt, block, attack, ...)
Writes the weights (for src/bot/pnet.js) and the metric report (JSON).
"""
import argparse, json, os, time
from collections import defaultdict
import numpy as np
import torch
import torch.nn as nn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('files', nargs='*', default=[os.path.join(ROOT, 'notes', 'policy-data.jsonl')])
ap.add_argument('--out', default=os.path.join(ROOT, 'src', 'bot', 'policy-net.json'))
ap.add_argument('--report', default=os.path.join(ROOT, 'notes', 'policy-report.json'))
ap.add_argument('--epochs', type=int, default=15)
ap.add_argument('--tau', type=float, default=0.03)
ap.add_argument('--hidden', type=int, default=256)
ap.add_argument('--mhidden', type=int, default=128)
ap.add_argument('--batch', type=int, default=1024)
ap.add_argument('--lr', type=float, default=2e-3)
ap.add_argument('--msize', type=int, default=0, help='move table size (menc.js SIZE); 0 = read from data')
ap.add_argument('--grank', type=int, default=900, help='move-table offset for the greedy-rank input (0 = off)')
# --init: start from an existing net (its weights and input normalization); --teach-only / --informative-only
# pick which decisions train (league data: teacher re-scored ones / best 5-95% and top two >= 1 point apart)
ap.add_argument('--init', default=None)
ap.add_argument('--teach-only', action='store_true')
ap.add_argument('--informative-only', action='store_true')
args = ap.parse_args()

DENSE, NSP = 45, 13 * 150
KIND_NAMES = ['sell', 'play_unit', 'play_program', 'equip_unit', 'equip_legend', 'call', 'solo', 'spend',
              'attack_gigs', 'attack_unit', 'block', 'call_defensive', 'interrupt', 'asset_spend', 'pass_defensive',
              'pass_interrupt', 'end_turn', 'die', 'steal', 'mulligan_keep', 'mulligan_redraw',
              'resp_accept', 'resp_decline', 'resp_pick', 'resp_pick_none', 'resp_multi', 'resp_amount', 'resp_type', 'resp_ack', 'other']
dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print('device', dev, torch.cuda.get_device_name(0) if dev.type == 'cuda' else '')

t0 = time.time()
recs, test = [], []
for f in args.files:
    with open(f, encoding='utf8') as fh:
        for line in fh:
            if line.strip():
                o = json.loads(line)
                for r in o['recs']:
                    vals = sorted([c[3] for c in r['c'] if c[3] is not None], reverse=True)
                    if args.teach_only and not r.get('teach'):
                        continue
                    if args.informative_only and not r.get('teach') and not (len(vals) >= 2 and 0.05 <= vals[0] <= 0.95 and vals[0] - vals[1] >= 0.01):
                        continue
                    recs.append(r); test.append(abs(o['g']) % 10 == 0)
N = len(recs)
C = min(48, max(len(r['c']) for r in recs))
P = max(len(c[0]) for r in recs for c in r['c'][:C]) + (1 if args.grank else 0)
SP = max(len(r['s'][1]) for r in recs)
MSIZE = args.msize or (max(i for r in recs for c in r['c'] for i, _ in c[0]) + 1)
MSIZE = max(MSIZE, 1000, args.grank + 16 if args.grank else 0)

dense = np.zeros((N, DENSE), np.float32)
sidx = np.zeros((N, SP), np.int64); sval = np.zeros((N, SP), np.float32)
midx = np.zeros((N, C, P), np.int64); mval = np.zeros((N, C, P), np.float32)
legal = np.zeros((N, C), bool); tried = np.zeros((N, C), bool); value = np.zeros((N, C), np.float32)
grank = np.full((N, C), 999, np.int64); pick = np.zeros(N, np.int64); kind = np.zeros(N, np.int64)
for n, r in enumerate(recs):
    d, s = r['s']
    dense[n] = d
    for j, (i, v) in enumerate(s):
        sidx[n, j] = i - DENSE; sval[n, j] = v
    for c, (m, g, sl, v) in enumerate(r['c'][:C]):
        legal[n, c] = True; grank[n, c] = g
        for j, (i, w) in enumerate(m):
            midx[n, c, j] = i; mval[n, c, j] = w
        if args.grank:   # greedy's rank of this move as an input: the net learns greedy + corrections
            midx[n, c, len(m)] = args.grank + min(g, 15); mval[n, c, len(m)] = 1
        if v is not None:
            tried[n, c] = True; value[n, c] = v
    pick[n] = min(r['pick'], C - 1) if r['pick'] >= 0 else 0
    k0 = [i for i, _ in r['c'][pick[n]][0] if i < len(KIND_NAMES)] if r['pick'] >= 0 else []
    kind[n] = k0[0] if k0 else len(KIND_NAMES) - 1
T = np.asarray(test)
keep = tried.sum(1) >= 2          # the search compared at least two moves
print(f'{N} decisions ({keep.sum()} with a search comparison, {T.sum()} held out), up to {C} moves, move table {MSIZE}, loaded in {time.time() - t0:.0f}s')

INIT = json.load(open(args.init)) if args.init else None
if INIT:
    mean = np.asarray(INIT['mean'], np.float32); std = np.asarray(INIT['std'], np.float32)
    args.hidden, args.mhidden = len(INIT['b1']), len(INIT['s2b'])
    MSIZE = max(MSIZE, len(INIT['M']))
else:
    mean = dense[~T].mean(0); std = dense[~T].std(0); std[std < 1e-6] = 1
dn = (dense - mean) / std
to = lambda a: torch.from_numpy(a).to(dev)
D = {k: to(v) for k, v in dict(dn=dn, sidx=sidx, sval=sval, midx=midx, mval=mval, legal=legal, tried=tried, value=value, grank=grank.astype(np.float32)).items()}


class PNet(nn.Module):
    def __init__(s, h, mh):
        super().__init__()
        s.d = nn.Linear(DENSE, h)
        s.e = nn.EmbeddingBag(NSP, h, mode='sum')
        s.s2 = nn.Linear(h, mh)
        s.m = nn.EmbeddingBag(MSIZE, mh, mode='sum')
        s.mb = nn.Parameter(torch.zeros(mh))
        s.j = nn.Linear(mh, mh)
        s.o = nn.Linear(mh, 1)
        for e in (s.e, s.m):
            nn.init.normal_(e.weight, std=0.01)

    def forward(s, dn, si, sv, mi, mv):
        B, Cc, Pp = mi.shape
        st = torch.relu(s.d(dn) + s.e(si, per_sample_weights=sv))
        st = s.s2(st)                                                       # [B, mh]
        mv_ = s.m(mi.reshape(-1, Pp), per_sample_weights=mv.reshape(-1, Pp)).reshape(B, Cc, -1) + s.mb
        z = torch.relu(s.j(torch.relu(st[:, None, :] + mv_)))               # state x move interaction
        return s.o(z).squeeze(-1)                                           # [B, C] logits


def batch(ix):
    return D['dn'][ix], D['sidx'][ix], D['sval'][ix], D['midx'][ix], D['mval'][ix]


net = PNet(args.hidden, args.mhidden).to(dev)
if INIT:
    T_ = lambda a: torch.tensor(np.asarray(a, dtype=np.float32), device=dev)
    with torch.no_grad():
        net.d.weight.copy_(T_(INIT['Wd'])); net.d.bias.copy_(T_(INIT['b1'])); net.e.weight.copy_(T_(INIT['E']))
        net.s2.weight.copy_(T_(INIT['S2'])); net.s2.bias.copy_(T_(INIT['s2b']))
        Mi = np.zeros((MSIZE, args.mhidden), np.float32); Mi[:len(INIT['M'])] = np.asarray(INIT['M'], np.float32)
        net.m.weight.copy_(T_(Mi)); net.mb.copy_(T_(INIT['mb']))
        net.j.weight.copy_(T_(INIT['J'])); net.j.bias.copy_(T_(INIT['jb']))
        net.o.weight.copy_(T_([INIT['o']])); net.o.bias.copy_(T_([INIT['ob']]))
    print('starting from', args.init)
opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
tr = torch.from_numpy(np.nonzero(keep & ~T)[0]).to(dev)
te_all = np.nonzero(T)[0]
steps = args.epochs * ((len(tr) + args.batch - 1) // args.batch)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps)
NEG = -1e9


def loss_fn(ix):
    z = net(*batch(ix))
    m = D['tried'][ix]
    # exact ties (moves reaching the same position) go to greedy's order, so the net doesn't pick at random among them
    tv = D['value'][ix] - 1e-4 * D['grank'][ix].clamp(max=30)
    tgt = torch.where(m, tv / args.tau, torch.full_like(z, NEG)).softmax(-1)
    lz = torch.where(m, z, torch.full_like(z, NEG)).log_softmax(-1)
    return -(tgt * torch.where(m, lz, torch.zeros_like(lz))).sum(-1).mean()


def scores(idx):
    out = []
    net.eval()
    with torch.no_grad():
        for k in range(0, len(idx), 4096):
            ix = torch.from_numpy(idx[k:k + 4096]).to(dev)
            z = net(*batch(ix))
            out.append(torch.where(D['legal'][ix], z, torch.full_like(z, NEG)).cpu().numpy())
    net.train()
    return np.concatenate(out) if out else np.zeros((0, C))


def metrics(idx, z):
    """compare net ranking (z) and greedy ranking against the search on decisions idx"""
    res = {}
    g_top = np.argmin(np.where(legal[idx], grank[idx], 999), 1)
    n_top = z.argmax(1)
    pk = pick[idx]
    res['decisions'] = int(len(idx))
    # "agree" = picked a best-valued move (within 0.005 of the search's best): many moves reach the
    # same position and tie exactly, so matching the search's literal pick would reward tie-breaking
    tvv = np.where(tried[idx], value[idx], -1); bst = tvv.max(1); ar = np.arange(len(idx))
    good = lambda top: tried[idx][ar, top] & (tvv[ar, top] >= bst - 0.005)
    res['agree'] = {'net': float(good(n_top).mean()), 'greedy': float(good(g_top).mean()),
                    'exact_net': float((n_top == pk).mean()), 'exact_greedy': float((g_top == pk).mean())}
    # non-obvious: greedy's top move was clearly worse than the search's best
    no = tried[idx][ar, g_top] & (tvv[ar, g_top] < bst - 0.005)
    res['agree_nonobvious'] = {'n': int(no.sum()), 'net': float(good(n_top)[no].mean()) if no.any() else None, 'greedy': 0.0}
    # regret among moves the search tried
    tv = np.where(tried[idx], value[idx], -1)
    best = tv.max(1)
    has = tried[idx].sum(1) >= 2
    zt = np.where(tried[idx], z, NEG)
    gt = np.where(tried[idx], -grank[idx], -999)
    res['regret'] = {'net': float((best - tv[np.arange(len(idx)), zt.argmax(1)])[has].mean()),
                     'greedy': float((best - tv[np.arange(len(idx)), gt.argmax(1)])[has].mean())}
    # gems: the search's pick came from exploration (outside greedy's shortlist) and beat greedy's choice
    sl = np.array([recs[i]['c'][min(pick[i], len(recs[i]['c']) - 1)][2] for i in idx]) if len(idx) else np.array([])
    gval = tv[np.arange(len(idx)), g_top]
    # (ending the turn is always searched, so it never counts as a discovery)
    gem = (sl == 0) & (kind[idx] != KIND_NAMES.index('end_turn')) & (tv[np.arange(len(idx)), pk] - np.where(gval < 0, tv.max(1), gval) >= 0.03)
    rank_net = (z > z[np.arange(len(idx)), pk][:, None]).sum(1)
    rank_g = grank[idx][np.arange(len(idx)), pk]
    res['gems'] = {'n': int(gem.sum())}
    for k in (1, 3, 5):
        res['gems'][f'recall@{k}'] = {'net': float((rank_net[gem] < k).mean()) if gem.any() else None,
                                      'greedy': float((rank_g[gem] < k).mean()) if gem.any() else None}
    bk = defaultdict(lambda: [0, 0, 0])
    for j, i in enumerate(idx):
        name = KIND_NAMES[kind[i]] if kind[i] < len(KIND_NAMES) else 'other'
        gn, gg = good(n_top), good(g_top)
        bk[name][0] += 1; bk[name][1] += int(gn[j]); bk[name][2] += int(gg[j])
    res['by_kind'] = {k: {'n': v[0], 'net': v[1] / v[0], 'greedy': v[2] / v[0]} for k, v in sorted(bk.items(), key=lambda x: -x[1][0])}
    return res


for ep in range(args.epochs):
    perm = tr[torch.randperm(len(tr), device=dev)]
    tot = 0.0
    for k in range(0, len(perm), args.batch):
        loss = loss_fn(perm[k:k + args.batch])
        opt.zero_grad(); loss.backward(); opt.step(); sched.step(); tot += loss.item()
    m = metrics(te_all, scores(te_all))
    print(f"  epoch {ep + 1}/{args.epochs}  loss {tot / max(1, (len(perm) + args.batch - 1) // args.batch):.4f}  "
          f"best-move net {100 * m['agree']['net']:.1f}% (greedy {100 * m['agree']['greedy']:.1f}%)  "
          f"non-obvious {100 * (m['agree_nonobvious']['net'] or 0):.1f}%  gem recall@5 {m['gems']['recall@5']['net']}")

M = metrics(te_all, scores(te_all))
pct = lambda x: '-' if x is None else f'{100 * x:.1f}%'
print('\nheld-out strategy metrics (net vs greedy ranking):')
print(f"  picks a best move (within 0.5%)  {pct(M['agree']['net'])} vs {pct(M['agree']['greedy'])}   ({M['decisions']} decisions)")
print(f"  ...where greedy's choice was clearly worse  {pct(M['agree_nonobvious']['net'])} vs 0%   ({M['agree_nonobvious']['n']})")
print(f"  regret (win chance lost)  {M['regret']['net']:.4f} vs {M['regret']['greedy']:.4f}")
print(f"  discoveries found by search ({M['gems']['n']}): recall@1 {pct(M['gems']['recall@1']['net'])} vs {pct(M['gems']['recall@1']['greedy'])}, "
      f"@3 {pct(M['gems']['recall@3']['net'])} vs {pct(M['gems']['recall@3']['greedy'])}, @5 {pct(M['gems']['recall@5']['net'])} vs {pct(M['gems']['recall@5']['greedy'])}")
print('  by move type (picks a best move: net / greedy):')
for k, v in M['by_kind'].items():
    print(f"    {k:16s} {v['n']:6d}  {100 * v['net']:5.1f}% / {100 * v['greedy']:5.1f}%")

sd = {k: v.detach().cpu().numpy() for k, v in net.state_dict().items()}
r = lambda a: np.round(a.astype(np.float64), 5).tolist()
# a few held-out decisions with the net's logits, so pnet.js can check its forward pass
chk_idx = te_all[:6]
chk_z = scores(chk_idx)
checks = [{'dense': dense[i].tolist(), 'sparse': [[int(a) + DENSE, float(b)] for a, b in zip(sidx[i], sval[i]) if b != 0],
           'moves': [[[int(a), float(b)] for a, b in zip(midx[i, c], mval[i, c]) if b != 0] for c in range(C) if legal[i, c]],
           'logits': [float(x) for c, x in enumerate(chk_z[n]) if legal[i, c]]} for n, i in enumerate(chk_idx)]
out = {'format': 'eddies-policy-net', 'version': 1, 'dense': DENSE, 'sparse': NSP, 'msize': MSIZE, 'grank': args.grank,
       'mean': r(mean), 'std': r(std), 'Wd': r(sd['d.weight']), 'b1': r(sd['d.bias']), 'E': r(sd['e.weight']),
       'S2': r(sd['s2.weight']), 's2b': r(sd['s2.bias']), 'M': r(sd['m.weight']), 'mb': r(sd['mb']),
       'J': r(sd['j.weight']), 'jb': r(sd['j.bias']), 'o': r(sd['o.weight'][0]), 'ob': float(sd['o.bias'][0]),
       'checks': checks, 'metrics': M, 'trainedOn': int(len(tr)), 'tau': args.tau}
with open(args.out, 'w') as fh:
    json.dump(out, fh, separators=(',', ':'))
os.makedirs(os.path.dirname(args.report), exist_ok=True)
with open(args.report, 'w') as fh:
    json.dump({'files': args.files, 'metrics': M}, fh, indent=1)
print('wrote', args.out, f'({os.path.getsize(args.out) / 1e6:.1f} MB) and', args.report)
