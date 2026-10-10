// Picks the rarest cards in the collection for the website's Home hero, which
// cycles through them. Pure logic (no Electron), so main.js's publish step and
// one-off scripts can share it.
//
// Rarest first: Nova Rare, Iconic Secret, Iconic Legend, Iconic Other, Secret,
// Epic ... Within a rarity, Legends come first (their art is the showpiece),
// then alphabetical so the order is stable between publishes. One entry per
// card (cardId): a second printing of the same card adds nothing visually.

const RARITY_RANK = ['Common', 'Uncommon', 'Rare', 'Epic', 'Secret', 'Iconic Other', 'Iconic Legend', 'Iconic Secret', 'Nova Rare'];

const rankOf = (rarity) => RARITY_RANK.indexOf(rarity);

function pickShowcase(cards, collection, { limit = 12, hasImage = () => true } = {}) {
  const owned = cards.filter((c) => {
    const e = collection[c.id];
    return e && (e.main || 0) + (e.reserve || 0) + (e.extras || 0) > 0 && hasImage(c.id);
  });
  owned.sort(
    (a, b) =>
      rankOf(b.rarity) - rankOf(a.rarity) ||
      (b.cardType === 'Legend') - (a.cardType === 'Legend') ||
      String(a.displayName || a.name).localeCompare(String(b.displayName || b.name))
  );
  const seen = new Set();
  const picked = [];
  for (const c of owned) {
    if (seen.has(c.cardId)) continue;
    seen.add(c.cardId);
    picked.push({
      id: c.id,
      name: c.name,
      subname: c.subname,
      displayName: c.displayName,
      rarity: c.rarity,
      cardType: c.cardType,
      color: c.color
    });
    if (picked.length >= limit) break;
  }
  return picked;
}

module.exports = { pickShowcase, RARITY_RANK };
