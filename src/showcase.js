// Picks the cards for the website Home hero, which cycles through them.
// Pure logic (no Electron), so main.js's publish step and one-off scripts can
// share it.
//
// The pool is EVERY English printing in the game's rarest tiers - not just the
// ones in the collection - so Iconic Secrets, Promo Nova Rares, Box Toppers and
// tournament-prize Nova Rares can all appear:
//   1. Tier 1: Nova Rare + Iconic Secret, ranked by Cardmarket price (highest
//      first).
//   2. If that leaves fewer than `limit` cards, the gap is filled from tier 2
//      (Iconic Legend), again by price.
// Cards under MIN_PRICE are skipped: tournament-prize cards have no real
// market and get heuristically matched to unrelated EUR 0.10 listings.
// Retail/Beta printings of the same card share art, so only the pricier one is
// kept (a Box Topper and a prize printing of the same card both stay - they
// are different art).

const TIERS = [['Nova Rare', 'Iconic Secret'], ['Iconic Legend']];
const MIN_PRICE = 1;
const RARITY_RANK = ['Common', 'Uncommon', 'Rare', 'Epic', 'Secret', 'Iconic Other', 'Iconic Legend', 'Iconic Secret', 'Nova Rare'];

// "Box Toppers - Retail" and "... - Beta" are one family; so are "Pre-Release Retail/Beta".
const setFamily = (name) => String(name || '').replace(/\s*(?:[—-]\s*)?(?:Retail|Beta)(?:\s*[—-]\s*FR)?$/i, '').trim();

function pickShowcase(cards, { priceFor = () => ({}), hasImage = () => true, limit = 21 } = {}) {
  const english = cards.filter((c) => !/-fr$/i.test(c.set?.code || '') && hasImage(c.id));
  const picked = [];
  const seen = new Set();

  for (const tier of TIERS) {
    if (picked.length >= limit) break;
    const rows = english
      .filter((c) => tier.includes(c.rarity))
      .map((c) => ({ c, ...priceFor(c.id) }))
      .filter((r) => r.price != null && r.price >= MIN_PRICE)
      .sort((a, b) => b.price - a.price || RARITY_RANK.indexOf(b.c.rarity) - RARITY_RANK.indexOf(a.c.rarity) || String(a.c.displayName).localeCompare(String(b.c.displayName)));
    for (const r of rows) {
      const key = `${r.c.cardId}|${r.c.rarity}|${setFamily(r.c.set?.name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({
        id: r.c.id,
        name: r.c.name,
        subname: r.c.subname,
        displayName: r.c.displayName,
        rarity: r.c.rarity,
        cardType: r.c.cardType,
        color: r.c.color,
        set: setFamily(r.c.set?.name),
        price: r.price,
        priceGuess: !!r.priceGuess
      });
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

module.exports = { pickShowcase, RARITY_RANK };
