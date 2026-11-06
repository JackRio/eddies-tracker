"""Train the bot's value net on self-play positions (scripts/value-data.js) on the GPU.

    D:/Codebase/venv/nitorch/Scripts/python.exe scripts/train-value.py [data.jsonl ...]
        [--out src/bot/value-net.json] [--epochs 12] [--hidden 256] [--hidden2 64]

Input per position (src/bot/vfeatures.js): 45 dense aggregate features + sparse card counts
per zone. Model: h1 = relu(Wd * norm(dense) + sum(count * E[card-zone]) + b1),
h2 = relu(W2 h1 + b2), logit = w3 h2 + b3 = the acting player's chance to win.
The first layer is an EmbeddingBag, i.e. a linear layer over the sparse input.

Splits by game (every 10th game held out), reports held-out log loss and accuracy next to a
dense-only logistic baseline, and writes the weights as JSON for src/bot/value.js (plain-JS
forward pass, no GPU needed at play time).
"""
import argparse, json, math, os, sys, time
import numpy as np
import torch
import torch.nn as nn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('files', nargs='*', default=[os.path.join(ROOT, 'notes', 'value-data.jsonl')])
ap.add_argument('--out', default=os.path.join(ROOT, 'src', 'bot', 'value-net.json'))
ap.add_argument('--epochs', type=int, default=12)
ap.add_argument('--hidden', type=int, default=256)
ap.add_argument('--hidden2', type=int, default=64)
ap.add_argument('--batch', type=int, default=4096)
ap.add_argument('--lr', type=float, default=2e-3)
ap.add_argument('--wd', type=float, default=1e-4)
ap.add_argument('--sparse', type=int, default=13 * 150)
# --init: start from an existing net's weights (and its input normalization) and re-tune it on these
# positions - for small new datasets (league games) that should correct, not replace, what it knows
ap.add_argument('--init', default=None)
# --aux W: weight of the auxiliary 'turns left' head (rows from league-to-value.js); it only shapes the
# hidden layers during training and is not saved (the bot never uses it)
ap.add_argument('--aux', type=float, default=0.1)
args = ap.parse_args()

DENSE = 45
dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print('device', dev, torch.cuda.get_device_name(0) if dev.type == 'cuda' else '')

t0 = time.time()
ys, dense, sp_idx, sp_val, test, wons, tl = [], [], [], [], [], [], []
for f in args.files:
    with open(f, encoding='utf8') as fh:
        for line in fh:
            if not line.strip():
                continue
            o = json.loads(line)
            hold = o['g'] % 10 == 0
            for row in o['rows']:
                y, d, s = row[:3]
                ys.append(y); dense.append(d); test.append(hold)
                wons.append(row[3] if len(row) > 3 else y); tl.append(row[4] if len(row) > 4 else -1)
                sp_idx.append([i - DENSE for i, _ in s]); sp_val.append([n for _, n in s])
N = len(ys)
P = max(len(s) for s in sp_idx)
NSP = args.sparse  # = vfeatures.js SIZE - DENSE (13 zone bags x 150 cards)
assert max(max(s) if s else 0 for s in sp_idx) < NSP, 'card index beyond --sparse: vfeatures.js changed?'
idx = np.zeros((N, P), dtype=np.int64); val = np.zeros((N, P), dtype=np.float32)
for r, (a, b) in enumerate(zip(sp_idx, sp_val)):
    idx[r, :len(a)] = a; val[r, :len(b)] = b
X = np.asarray(dense, dtype=np.float32); Y = np.asarray(ys, dtype=np.float32); T = np.asarray(test)
W = np.asarray(wons, dtype=np.float32); TL = np.asarray(tl, dtype=np.float32) / 10   # turns left / 10, -0.1 = unknown
print(f'{N} positions ({T.sum()} held out), max {P} cards/position, sparse table {NSP}, loaded in {time.time() - t0:.0f}s')

INIT = json.load(open(args.init)) if args.init else None
if INIT:
    mean = np.asarray(INIT['mean'], dtype=np.float32); std = np.asarray(INIT['std'], dtype=np.float32)
    args.hidden, args.hidden2 = len(INIT['b1']), len(INIT['b2'])
else:
    mean = X[~T].mean(0); std = X[~T].std(0); std[std < 1e-6] = 1
Xn = (X - mean) / std
to = lambda a: torch.from_numpy(a).to(dev)
Xtr, Itr, Vtr, Ytr, TLtr = to(Xn[~T]), to(idx[~T]), to(val[~T]), to(Y[~T]), to(TL[~T])
Xte, Ite, Vte, Yte = to(Xn[T]), to(idx[T]), to(val[T]), to(W[T])   # held out: scored on the real result


class Net(nn.Module):
    def __init__(s, h, h2):
        super().__init__()
        s.d = nn.Linear(DENSE, h)
        s.e = nn.EmbeddingBag(NSP, h, mode='sum')
        nn.init.normal_(s.e.weight, std=0.01)
        s.l2 = nn.Linear(h, h2)
        s.l3 = nn.Linear(h2, 1)
        s.aux = nn.Linear(h2, 1)   # turns left (training only)

    def forward(s, x, i, v, aux=False):
        h = torch.relu(s.d(x) + s.e(i, per_sample_weights=v))
        h2 = torch.relu(s.l2(h))
        z = s.l3(h2).squeeze(-1)
        return (z, s.aux(h2).squeeze(-1)) if aux else z


class Logit(nn.Module):
    def __init__(s):
        super().__init__(); s.d = nn.Linear(DENSE, 1)

    def forward(s, x, i, v, aux=False):
        z = s.d(x).squeeze(-1)
        return (z, None) if aux else z


bce = nn.BCEWithLogitsLoss()


def evaluate(m):
    m.eval(); tot = 0.0; acc = 0
    with torch.no_grad():
        for k in range(0, len(Yte), 65536):
            z = m(Xte[k:k + 65536], Ite[k:k + 65536], Vte[k:k + 65536]); y = Yte[k:k + 65536]
            tot += nn.functional.binary_cross_entropy_with_logits(z, y, reduction='sum').item()
            acc += ((z > 0).float() == y).sum().item()
    m.train()
    return tot / len(Yte), acc / len(Yte)


def train(m, epochs, lr):
    opt = torch.optim.AdamW(m.parameters(), lr=lr, weight_decay=args.wd)
    steps = epochs * math.ceil(len(Ytr) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps)
    best = (9, 0, None)
    if m is globals().get('net') and INIT:   # never end worse than the starting net
        l0, a0 = evaluate(m); best = (l0, a0, {k: v.detach().clone() for k, v in m.state_dict().items()})
    for ep in range(epochs):
        perm = torch.randperm(len(Ytr), device=dev)
        for k in range(0, len(Ytr), args.batch):
            b = perm[k:k + args.batch]
            z, a = m(Xtr[b], Itr[b], Vtr[b], aux=True)
            loss = bce(z, Ytr[b])
            if a is not None and args.aux > 0:
                known = TLtr[b] >= 0
                if known.any():
                    loss = loss + args.aux * nn.functional.smooth_l1_loss(a[known], TLtr[b][known])
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        ll, acc = evaluate(m)
        print(f'  epoch {ep + 1}/{epochs}  held-out log loss {ll:.4f}  accuracy {100 * acc:.1f}%')
        if ll < best[0]:
            best = (ll, acc, {k: v.detach().clone() for k, v in m.state_dict().items()})
    m.load_state_dict(best[2])
    return best[0], best[1]


torch.manual_seed(0)
print('dense-only logistic baseline:')
base = train(Logit().to(dev), 4, 1e-2)
print('value net:')
net = Net(args.hidden, args.hidden2).to(dev)
if INIT:
    T_ = lambda a: torch.tensor(np.asarray(a, dtype=np.float32), device=dev)
    with torch.no_grad():
        net.d.weight.copy_(T_(INIT['Wd'])); net.d.bias.copy_(T_(INIT['b1'])); net.e.weight.copy_(T_(INIT['E']))
        net.l2.weight.copy_(T_(INIT['W2'])); net.l2.bias.copy_(T_(INIT['b2']))
        net.l3.weight.copy_(T_([INIT['w3']])); net.l3.bias.copy_(T_([INIT['b3']]))
    l0, a0 = evaluate(net)
    print(f'  starting from {args.init}: held-out log loss {l0:.4f}  accuracy {100 * a0:.1f}%')
ll, acc = train(net, args.epochs, args.lr)
print(f'\nheld-out log loss: coin flip 0.6931 | logistic {base[0]:.4f} ({100 * base[1]:.1f}%) | net {ll:.4f} ({100 * acc:.1f}%)')

# a few held-out rows with the net's output, so src/bot/value.js can check its forward pass
net.eval()
with torch.no_grad():
    zc = torch.sigmoid(net(Xte[:8], Ite[:8], Vte[:8])).cpu().numpy()
hi = np.nonzero(T)[0][:8]
checks = [{'dense': X[j].tolist(), 'sparse': [[int(a) + DENSE, float(b)] for a, b in zip(sp_idx[j], sp_val[j])], 'p': float(zc[n])} for n, j in enumerate(hi)]
sd = {k: v.cpu().numpy() for k, v in net.state_dict().items() if not k.startswith('aux.')}
r = lambda a: np.round(a.astype(np.float64), 5).tolist()
out = {
    'format': 'eddies-value-net', 'version': 1, 'dense': DENSE, 'sparse': NSP,
    'mean': r(mean), 'std': r(std),
    'Wd': r(sd['d.weight']), 'b1': r(sd['d.bias']), 'E': r(sd['e.weight']),
    'W2': r(sd['l2.weight']), 'b2': r(sd['l2.bias']), 'w3': r(sd['l3.weight'][0]), 'b3': float(sd['l3.bias'][0]),
    'checks': checks,
    'trainedOn': N - int(T.sum()), 'heldOutLogLoss': ll, 'heldOutAccuracy': acc, 'logisticLogLoss': base[0],
}
with open(args.out, 'w') as fh:
    json.dump(out, fh, separators=(',', ':'))
print('wrote', args.out, f'({os.path.getsize(args.out) / 1e6:.1f} MB)')
