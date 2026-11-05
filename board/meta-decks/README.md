# Meta decks for the Replay Coach

Put current meta decklists here as `.txt` files, one card per line:

```
# Deck name
// Legends
1 Adam Smasher: Ender of Legends
1 River Ward: Detective on the Hunt
1 Viktor Vektor: Sit Down and Relax
// Main
3 Secondhand Bombus
3 Zetatech Faceplate
...
```

The coach can't see the Rival's hand or deck. It fills in their unseen cards from the decklist
(here, the engine's test decks, or your published decks) that best matches the cards they showed
during the game. The closer these lists are to what people actually play, the more realistic the
Rival's hidden cards, and the better the coach's advice. Re-run `node scripts/coach.js --force`
after adding decks.
