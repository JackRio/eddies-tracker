# Cyberpunk TCG Tracker

A personal desktop collection tracker for the official [Cyberpunk TCG](https://cyberpunktcg.com) (licensed by CD Projekt Red, published by Weird Co.).

Pulls the full card list from the public netdeck.gg card database API and lets you track how many regular and foil copies of each card you own, locally on your machine.

## Run it

```bash
npm install
npm start
```

## Data

- Card data is fetched from `https://api.netdeck.gg/api/cards/cyberpunk` and cached locally. Use "Refresh Card Data" in the app to pull the latest set/cards.
- Your collection counts are stored locally in your user data folder (`collection.json`) — never uploaded anywhere.

## Build a Windows installer

```bash
npm run dist
```
