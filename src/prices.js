// Cardmarket price lookup.
//
// Cardmarket's real API is closed to new applicants, but it publishes free,
// daily-regenerated JSON dumps per game on its own S3 bucket - a product
// catalog (id/name/expansion, no rarity or collector number) and a price
// guide (low/trend/averages in EUR, keyed by product id). Cyberpunk is game
// id 23. Neither file says which *printing* a product is, so matching our
// printings to Cardmarket products is a heuristic (see matchPrintings), with
// per-printing manual overrides stored in price-overrides.json.

const CM_GAME_ID = 23;
const CM_PRODUCTS_URL = `https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_${CM_GAME_ID}.json`;
const CM_PRICES_URL = `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_${CM_GAME_ID}.json`;
const PRICE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // Cardmarket regenerates once a day

// Our set code -> Cardmarket idExpansion. Cardmarket merges Retail/Beta
// printings into one expansion, and all tournament-prize sets into another.
// Inferred from card-name overlap between the two catalogs; if Cardmarket
// adds a new expansion, printings in unmapped sets just fall back to
// name-only candidates (manual pick).
const SET_TO_EXPANSION = {
  welcometonightcityretail: 6714,
  welcometonightcitybeta: 6714,
  theheistretailstarterdeck: 6715,
  theheistbetastarterdeck: 6715,
  embracingpowerretailstarterdeck: 6716,
  embracingpowerbetastarterdeck: 6716,
  boxtoppersretail: 6717,
  boxtoppersbeta: 6717,
  prereleasebeta: 6718,
  PRM01: 6719,
  mercdemodeck: 6720,
  arasakademodeck: 6721,
  nightcitybrawls1: 6722,
  edgerunneropens1: 6722,
  nightcityshowdowns1: 6722
};

const EXPANSION_NAMES = {
  6714: 'Welcome to Night City',
  6715: 'The Heist Starter Deck',
  6716: 'Embracing Power Starter Deck',
  6717: 'Box Toppers',
  6718: 'Pre-Release',
  6719: 'Promos',
  6720: 'Merc Demo Deck',
  6721: 'Arasaka Demo Deck',
  6722: 'Tournament Prizes'
};

// Keep in sync with RARITY_ORDER in renderer.js.
const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Nova Rare', 'Iconic Legend', 'Iconic Other', 'Secret', 'Iconic Secret'];

function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function printingNormName(c) {
  return normName(c.subname ? `${c.name}${c.subname}` : c.name);
}

// "005a", "β005a", "5a" all describe the same art version - Beta and Retail
// share one Cardmarket product, and starter decks zero-pad inconsistently.
function versionKey(c) {
  const m = String(c.collectorNumber || '').replace(/^β/, '').match(/^0*(\d+)(.*)$/);
  return m ? { num: Number(m[1]), suffix: m[2], key: `${Number(m[1])}${m[2]}` } : { num: Infinity, suffix: '', key: String(c.collectorNumber) };
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Cardmarket spells a few names differently ("Tetratonic" vs our
// "Tetratronic", "Armored Minotaur" vs "Minotaur").
function namesLooselyMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return true;
  return levenshtein(a, b) <= 2;
}

function num(v) {
  return typeof v === 'number' && v > 0 ? v : null;
}

function slimGuide(g) {
  return {
    trend: num(g.trend),
    low: num(g.low),
    avg1: num(g.avg1),
    avg7: num(g.avg7),
    avg30: num(g.avg30),
    trendFoil: num(g['trend-foil']),
    lowFoil: num(g['low-foil'])
  };
}

function headlinePrice(p) {
  return p ? p.trend ?? p.low ?? p.trendFoil ?? p.lowFoil ?? null : null;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cardmarket download failed (${res.status}): ${url}`);
  return res.json();
}

async function downloadCardmarketData() {
  const [catalog, guide] = await Promise.all([fetchJson(CM_PRODUCTS_URL), fetchJson(CM_PRICES_URL)]);
  const guides = new Map((guide.priceGuides || []).map((g) => [g.idProduct, g]));
  const products = {};
  for (const p of catalog.products || []) {
    products[p.idProduct] = {
      idProduct: p.idProduct,
      name: p.name,
      exp: p.idExpansion,
      expName: EXPANSION_NAMES[p.idExpansion] || `Expansion ${p.idExpansion}`,
      ...slimGuide(guides.get(p.idProduct) || {})
    };
  }
  return { fetchedAt: new Date().toISOString(), priceDate: guide.createdAt || null, products };
}

function isStale(data) {
  return !data || !data.fetchedAt || Date.now() - new Date(data.fetchedAt).getTime() > PRICE_MAX_AGE_MS;
}

// Returns { [printingId]: { idProduct, source } }, source one of:
//   auto   - version count lines up 1:1 with Cardmarket's products for this
//            name+expansion, matched in collector-number / product-id order
//   guess  - counts don't line up; matched by rarity rank vs price rank
//   manual - user override from price-overrides.json
//   none   - nothing plausible (or user explicitly picked "no match")
function matchPrintings(cards, products, overrides = {}) {
  const productList = Object.values(products);
  const cmByExp = new Map();
  for (const p of productList) {
    if (!cmByExp.has(p.exp)) cmByExp.set(p.exp, []);
    cmByExp.get(p.exp).push(p);
  }

  const groups = new Map();
  for (const c of cards) {
    const exp = SET_TO_EXPANSION[c.set?.code];
    const key = `${exp}|${printingNormName(c)}`;
    if (!groups.has(key)) groups.set(key, { exp, name: printingNormName(c), printings: [] });
    groups.get(key).printings.push(c);
  }

  const matches = {};
  for (const { exp, name, printings } of groups.values()) {
    const inExp = cmByExp.get(exp) || [];
    let candidates = inExp.filter((p) => normName(p.name) === name);
    if (!candidates.length) candidates = inExp.filter((p) => namesLooselyMatch(normName(p.name), name));
    candidates.sort((a, b) => a.idProduct - b.idProduct);

    const versions = new Map();
    for (const c of printings) {
      const v = versionKey(c);
      if (!versions.has(v.key)) versions.set(v.key, { ...v, rank: RARITY_ORDER.indexOf(c.rarity), printings: [] });
      versions.get(v.key).printings.push(c);
    }
    const vlist = [...versions.values()];

    const assign = (v, product, source) => {
      for (const c of v.printings) matches[c.id] = { idProduct: product ? product.idProduct : null, source: product ? source : 'none' };
    };

    if (!candidates.length) {
      vlist.forEach((v) => assign(v, null));
    } else if (candidates.length === vlist.length) {
      vlist.sort((a, b) => a.num - b.num || a.suffix.localeCompare(b.suffix));
      vlist.forEach((v, i) => assign(v, candidates[i], 'auto'));
    } else {
      // Rarer version <-> pricier product. Unpriced products only as a last
      // resort, since a guess that shows no price is no help anyway.
      const priced = candidates.filter((p) => headlinePrice(p) != null);
      const pool = (priced.length ? priced : candidates).slice().sort((a, b) => (headlinePrice(a) ?? 0) - (headlinePrice(b) ?? 0));
      vlist.sort((a, b) => a.rank - b.rank || a.num - b.num);
      vlist.forEach((v, i) => {
        const idx = vlist.length === 1 ? 0 : Math.round((i * (pool.length - 1)) / (vlist.length - 1));
        assign(v, pool[idx], 'guess');
      });
    }
  }

  for (const [printingId, idProduct] of Object.entries(overrides)) {
    if (!(printingId in matches)) continue;
    if (idProduct === null) matches[printingId] = { idProduct: null, source: 'none-manual' };
    else if (products[idProduct]) matches[printingId] = { idProduct: Number(idProduct), source: 'manual' };
  }
  return matches;
}

// Everything a renderer needs: product prices, each printing's match, and
// per-printing override candidates (name-matched products across *all*
// expansions, so a printing in an unmapped/misfiled set can still be
// matched by hand). Candidates are computed once per card name, not per
// printing, since fuzzy name matching is the expensive part.
function buildPriceView(cards, data, overrides) {
  if (!data) return null;
  const { products } = data;
  const matches = matchPrintings(cards, products, overrides);
  const byName = new Map();
  for (const c of cards) {
    const name = printingNormName(c);
    if (!byName.has(name)) {
      byName.set(name, Object.values(products)
        .filter((p) => namesLooselyMatch(normName(p.name), name))
        .sort((a, b) => a.exp - b.exp || a.idProduct - b.idProduct)
        .map((p) => p.idProduct));
    }
    matches[c.id].candidates = byName.get(name);
  }
  return { fetchedAt: data.fetchedAt, priceDate: data.priceDate, products, matches };
}

module.exports = { downloadCardmarketData, isStale, buildPriceView, headlinePrice };
