// AI deck agent: studies individual cards into a persistent knowledge base,
// then reasons over a decklist to write the Deck Description sections.
// Runs in the main process only - the API key never reaches a renderer.
// Key is stored in userData/ai-key.json (encrypted with the OS keychain via
// Electron safeStorage when available). Never committed.
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { filterRules } = require('./rules-filter');

const MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

const keyPath = () => path.join(app.getPath('userData'), 'ai-key.json');
const rulesPath = () => path.join(__dirname, 'data', 'rules.txt');
// The agent's long-term memory of individual cards (see studyCards()).
const knowledgePath = () => path.join(app.getPath('userData'), 'card-knowledge.json');

async function readKey() {
  try {
    const { enc, value } = JSON.parse(await fs.readFile(keyPath(), 'utf-8'));
    if (!value) return null;
    return enc ? safeStorage.decryptString(Buffer.from(value, 'base64')) : value;
  } catch (err) {
    return null;
  }
}

// 'none' (nothing saved), 'ok', or 'unreadable' (a file exists but can't be
// decrypted - e.g. copied from another Windows account - so it must be re-entered).
async function keyStatus() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(keyPath(), 'utf-8'));
  } catch (err) {
    return 'none';
  }
  if (!raw.value) return 'none';
  return (await readKey()) ? 'ok' : 'unreadable';
}

async function setKey(key) {
  const trimmed = (key || '').trim();
  if (!trimmed) {
    await fs.rm(keyPath(), { force: true });
    return false;
  }
  const enc = safeStorage.isEncryptionAvailable();
  const value = enc ? safeStorage.encryptString(trimmed).toString('base64') : trimmed;
  await fs.writeFile(keyPath(), JSON.stringify({ enc, value }), 'utf-8');
  return true;
}

const SECTION_KEYS = ['overview', 'early', 'mid', 'late', 'combos', 'mulligan', 'mulliganFirst', 'mulliganSecond', 'sideboard', 'notes'];

// Roles a card can play in a deck. Fixed list so profiles stay comparable and
// can be tallied in code (the model never has to count).
const ROLES = [
  'removal', 'bottom-deck-removal', 'bounce', 'board-presence', 'evasion', 'finisher',
  'card-draw', 'search', 'recursion', 'discard', 'eddies-ramp', 'protection',
  'disruption', 'buff', 'tax', 'enabler', 'payoff', 'cheap-filler'
];

// ---- Shared API plumbing ------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The rulebook minus conduct/component rules (see rules-filter.js).
const rulesText = async () => filterRules(await fs.readFile(rulesPath(), 'utf-8'));

// `context` is the reference text sent (and prompt-cached) after the
// instructions: the full rules while studying, the short playbook for decks.
// Thinking tokens count toward max_tokens, so keep the cap roomy; `effort`
// (low|medium|high) trades thinking depth for speed/cost.
async function callClaude({ system, context, tool, user, maxTokens = 16000, effort }) {
  const apiKey = await readKey();
  if (!apiKey) throw new Error('No API key set.');
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    ...(effort ? { output_config: { effort } } : {}),
    system: [
      { type: 'text', text: system },
      { type: 'text', text: context, cache_control: { type: 'ephemeral' } }
    ],
    ...(tool ? { tools: [tool], tool_choice: { type: 'auto' } } : {}),
    messages: [{ role: 'user', content: user }]
  });
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body
    });
    // Rate-limited / overloaded: back off and retry.
    if (res.status !== 429 && res.status !== 529 && res.status < 500) break;
    await sleep(2000 * 2 ** attempt);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error?.message || '';
    } catch (err) {}
    throw new Error(`Anthropic API ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') throw new Error('The model ran out of space mid-answer (max_tokens).');
  // No tool: plain-text mode (used for the long free-form playbook).
  if (!tool) return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const input = data.content?.find((b) => b.type === 'tool_use' && b.name === tool.name)?.input;
  if (!input) throw new Error(`The model did not call ${tool.name}.`);
  return input;
}

// ---- Card knowledge (memory) --------------------------------------------------

const cardHash = (c) =>
  crypto.createHash('sha1').update(`${c.displayName}\n${c.cardType}\n${c.rulesText || ''}`).digest('hex').slice(0, 12);

async function loadKnowledge() {
  try {
    return JSON.parse(await fs.readFile(knowledgePath(), 'utf-8'));
  } catch (err) {
    return {};
  }
}

const cardLine = (c, i) =>
  `[${i}] ${c.displayName} | ${c.cardType}${c.color ? ' | ' + c.color : ''}` +
  `${c.cost != null ? ' | cost ' + c.cost : ''}${c.power != null ? ' | power ' + c.power : ''}${c.ram != null ? ' | RAM ' + c.ram : ''}` +
  `${c.classifications?.length ? ' | ' + c.classifications.join(', ') : ''}${c.isEddiable ? ' | has Sell Tag' : ' | no Sell Tag (cannot be sold)'}\n    ${c.rulesText || '(no rules text)'}`;

const STUDY_SYSTEM = `You are a Cyberpunk Trading Card Game rules expert building a permanent knowledge base of individual cards. Rely ONLY on the official rules and the card text given - never import mechanics from other card games.

For each card, record what it actually DOES in this game and what kind of deck wants it:
- summary: one plain sentence on the card's effect (not a restatement of its stats).
- roles: pick every role it genuinely fills from the allowed list. Use "bottom-deck-removal" only for effects that bottom-deck a card or unit (the rules define "Bottom-deck" as a game action); use "removal" for destroying or otherwise dealing with a card.
- mechanics: short phrases for the specific effects and triggers (e.g. "bottom-decks target rival Unit", "draws when a Program is played", "gets +2 power while equipped").
- wants: what cards, archetype or conditions make it good (e.g. "many Programs", "Units with Go Solo", "low-cost Units").
- enables: what it supplies to other cards (e.g. "puts Programs into play", "adds Eddies").
Be specific and short. Return one profile per card, keyed by its [index].

Vocabulary: use only this game's own terms (the keywords and actions in the rules and on the cards). Do NOT use slang or terms from other card games (e.g. cantrip, haste, exile, graveyard, mana, board wipe, tutor, counterspell). Describe the effect in plain words instead - say "draws a card when played" rather than "cantrip".

Deliver the result by calling the record_card_profiles tool. Do not reply with plain text.`;

const STUDY_TOOL = {
  name: 'record_card_profiles',
  description: 'Store a knowledge profile for each studied card.',
  input_schema: {
    type: 'object',
    properties: {
      profiles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            summary: { type: 'string' },
            roles: { type: 'array', items: { type: 'string', enum: ROLES } },
            mechanics: { type: 'array', items: { type: 'string' } },
            wants: { type: 'array', items: { type: 'string' } },
            enables: { type: 'array', items: { type: 'string' } }
          },
          required: ['index', 'summary', 'roles', 'mechanics', 'wants', 'enables']
        }
      }
    },
    required: ['profiles']
  }
};

const STUDY_BATCH = 20;
const STUDY_CONCURRENCY = 3;

const uniqueByCardId = (cards) => [...new Map(cards.map((c) => [c.cardId, c])).values()];
const needsStudy = (knowledge, c) => knowledge[c.cardId]?.hash !== cardHash(c);

// Studies any card that has no profile yet (or whose text changed) and stores
// it. Already-known cards cost nothing, so the knowledge base only grows.
// Batches run a few at a time and each is saved as it lands, so an interrupted
// run keeps what it learned and a re-run only does what's left.
async function studyCards(cards, onProgress) {
  const knowledge = await loadKnowledge();
  const todo = uniqueByCardId(cards).filter((c) => needsStudy(knowledge, c));
  if (!todo.length) return { studied: 0, knowledge };
  const context = `OFFICIAL RULES:\n\n${await rulesText()}`;
  const batches = [];
  for (let i = 0; i < todo.length; i += STUDY_BATCH) batches.push(todo.slice(i, i + STUDY_BATCH));
  let next = 0;
  let done = 0;
  let firstError = null;
  const worker = async () => {
    while (next < batches.length && !firstError) {
      const batch = batches[next++];
      try {
        const out = await callClaude({
          system: STUDY_SYSTEM,
          context,
          tool: STUDY_TOOL,
          user: `Study these ${batch.length} cards:\n\n${batch.map(cardLine).join('\n')}`,
          maxTokens: 16000,
          effort: 'medium'
        });
        for (const p of out.profiles || []) {
          const c = batch[p.index];
          if (!c) continue;
          knowledge[c.cardId] = {
            name: c.displayName,
            hash: cardHash(c),
            summary: p.summary,
            roles: (p.roles || []).filter((r) => ROLES.includes(r)),
            mechanics: p.mechanics || [],
            wants: p.wants || [],
            enables: p.enables || []
          };
        }
        await fs.writeFile(knowledgePath(), JSON.stringify(knowledge, null, 2), 'utf-8');
        done += batch.length;
        onProgress?.(`Studying cards ${Math.min(done, todo.length)}/${todo.length}...`);
      } catch (err) {
        firstError = firstError || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STUDY_CONCURRENCY, batches.length) }, worker));
  if (firstError) throw new Error(`${firstError.message} (${done}/${todo.length} cards studied and saved - run it again to continue)`);
  return { studied: todo.length, knowledge };
}

// ---- Rules playbook (short, pre-digested rules) -------------------------------
// Deck analysis doesn't re-read the 50-page rules every time; it gets this
// distilled playbook (built once, rebuilt only if rules.txt changes).

// Bump to force the playbook to be re-distilled after changing PLAYBOOK_SYSTEM.
const PLAYBOOK_VERSION = 'v2';
const playbookPath = () => path.join(app.getPath('userData'), 'rules-playbook.json');

const PLAYBOOK_SYSTEM = `You are a Cyberpunk Trading Card Game rules expert. Distill the official rules into a compact reference (about 1,200-1,800 words) that a strategist will use to evaluate decks without re-reading the full rulebook. Rely only on the rules text given.

Cover, tersely: how to win; pre-game setup and exactly what differs between going first and going second (mulligan order, starting Legends, who draws when); deck construction (Legends, RAM/color ceilings, copy limits, sideboard); the turn structure and phases; the resources (Eddies, Gigs, fixer dice, etc.) and how they are gained and spent; the card types and where they live; combat and how units attack/block/die; and a GLOSSARY of every keyword and game action (e.g. Bottom-deck, Go Solo, Call, Spend) with its precise effect. Finish with a short list of rules that most often decide games or create non-obvious interactions.

Reply with the playbook text only - no preamble.`;

const playbookHashOf = (rules) => crypto.createHash('sha1').update(PLAYBOOK_VERSION + rules).digest('hex').slice(0, 12);
const playbookHash = async () => playbookHashOf(await rulesText());

async function getPlaybook() {
  const rules = await rulesText();
  const hash = playbookHashOf(rules);
  try {
    const saved = JSON.parse(await fs.readFile(playbookPath(), 'utf-8'));
    if (saved.hash === hash && saved.playbook) return saved.playbook;
  } catch (err) {}
  const playbook = await callClaude({
    system: PLAYBOOK_SYSTEM,
    context: `OFFICIAL RULES:\n\n${rules}`,
    user: 'Write the playbook.',
    maxTokens: 16000,
    effort: 'medium'
  });
  // Never save (or use) an empty playbook - a blank one silently ruins drafts.
  if (playbook.length < 1000) throw new Error('The rules playbook came back empty or too short - try again.');
  await fs.writeFile(playbookPath(), JSON.stringify({ hash, playbook }), 'utf-8');
  return playbook;
}

// What the agent already knows, for the UI: studied/total cards in the pool.
async function knowledgeStatus(poolCards) {
  const knowledge = await loadKnowledge();
  const pool = uniqueByCardId(poolCards);
  const studied = pool.filter((c) => !needsStudy(knowledge, c)).length;
  let playbook = false;
  try {
    const saved = JSON.parse(await fs.readFile(playbookPath(), 'utf-8'));
    playbook = !!saved.playbook && saved.hash === (await playbookHash());
  } catch (err) {}
  return { studied, total: pool.length, playbook };
}

// One-time (and resumable) "go learn everything": the playbook, then every card.
async function buildKnowledge(poolCards, onProgress) {
  onProgress?.('Distilling the rules...');
  await getPlaybook();
  await studyCards(poolCards, onProgress);
  return knowledgeStatus(poolCards);
}

// ---- Deck analysis ------------------------------------------------------------

const DECK_SYSTEM = `You are an expert Cyberpunk Trading Card Game strategist. The deck's owner built this deck and already knows the rules - your job is to work out what THIS DECK is trying to do and write that down.

You are given a rules playbook (distilled from the official rules), then the decklist where every card carries a knowledge profile (what it does, its roles, what it wants and enables), plus a tally of roles across the deck computed in code.

How to think (fill the "analysis" fields first, then write the sections from them):
1. Find the deck's engine: which roles and mechanics are over-represented, and which cards feed each other (a card's "enables" matching another's "wants"). A theme only counts if the card counts back it up - cite the cards and quantities.
2. Decide the primary plan and the win condition in terms of what the deck makes the opponent's board, hand or deck do (e.g. "plays cheap Programs to bottom-deck the Rival's Units each turn, then wins with the Legend's attacks on an empty board"). Note any secondary plan and what the deck is bad at.
3. Work out the sequencing: what it wants to do on turns 1-3, how it builds, how it closes.

Writing rules for the sections:
- The reader owns this deck and knows the game and the cards. NEVER explain game rules, keywords, setup, or turn structure, and never recite facts like how many Legends or Eddies a player has - use such facts only to reason, not to write. Describe the deck, not the game.
- Vocabulary: use only this game's own terms (the keywords and actions in the rules and on the cards). Do NOT use slang or terms from other card games (e.g. cantrip, haste, exile, graveyard, mana, board wipe, tutor, counterspell). Say what the card does in plain words instead. General strategy words everyone knows (tempo, aggro, removal) are fine.
- Describe a card's ROLE in the plan, not its text. The reader can hover any card to read it, so do not paraphrase what the card says. Say why it is in the deck and what it does for the plan: what it answers, what it sets up, what it needs, what it enables. Restate specifics from the card ONLY when they decide a decision (a threshold, a timing, a number that gates a play) or when the point is a sequence of plays.
  BAD (restates the card): "@[Pyramid Song] answers a Unit with -4 power or bottom-decks a 0-power one, and both modes work if a friendly d4 is at min."
  GOOD (a role): "@[Pyramid Song] is the cheap answer that keeps the Program count high and feeds the bottom-deck plan."
  GOOD (a sequence worth spelling out): "On turn 3, @[Delamain: Rideshare AI] draws 2, or @[Three Mouths, One Desire] digs for removal and Units."
- Every line must be specific to this list: name the cards, the quantities, what the deck is trying to make the opponent do. Delete any line that would be equally true of a different deck.
- Format: write each field as 2-4 SHORT lines separated by newlines, one idea per line, no bullet characters, no long paragraphs. Short lines are easier to scan than a block of prose.
- Reference cards ONLY as @[Card Name] using the exact display name from the decklist (including any subtitle after the colon). Tag every card you name, every time.
- overview: 2 short lines - the archetype and plan, then the win condition.
- early / mid / late: 2-3 short lines each. Name the plays and the goal of the phase; do not narrate card text.
- combos (shown as "Key Cards"): pick the 3 to 5 cards that matter most - NOT more, and do not list every good card. Importance is not only power: a card can be key because other cards depend on it, because it turns on an important card or a whole type of cards (e.g. it makes every Program in the deck better), or because the plan collapses without it. One line each: "@[Card] - its role, and who depends on it or what it unlocks". Optionally one final line for the best two-card pairing.
- mulligan: 3-4 short lines on what makes an opening hand a keep for THIS plan and what is a dead draw alone. You get exactly one mulligan (all 6 cards back, shuffle, draw a fresh 6).
- mulliganFirst / mulliganSecond: for each seat, say what to want in the opening six and how the first turns go, judging EVERY card by its role in the plan under that seat's constraints - not by cost alone. Do not call a card bad just because it is expensive: if the deck can set up for it with its early plays, it is fine to keep a hand built around it, and say how the setup works. Seat facts to REASON with (never state them): the first player starts with two of their three Legends spent, so they have far less Eddies available in the opening turns and cannot cast expensive cards early, but the cheap turns can be used to set up the next turn; the first player decides their mulligan before the second player decides theirs; the second player sees the first player's board and has all their Legends available.
- sideboard: only if a sideboard or swap plans are given: when to swap which cards and against what. Otherwise an empty string.
- notes: the deck's real weaknesses and how it can lose, in 2-3 short lines. Empty if nothing useful.
- Selling: only a card marked SELLABLE (it has a Sell Tag) can be sold for Eddies, only from hand, and only once per turn. Never suggest selling a card marked NOT SELLABLE - it can only be played, never turned into an Eddie. Legends are never sold: a face-up Legend with a Sell Tag can be spent for 1 Eddie instead, which is not selling and does not make an Eddie - do not write "sell Legends" or give Legend-spending advice. Do not write blanket advice by card type ("don't sell Units", "sell spare Programs"). Mention selling only when it matters for THIS list, and then name the specific SELLABLE cards.
- Rely only on the rules, card text and profiles - if unsure, say less.

Deliver the result by calling the write_deck_description tool. Do not reply with plain text.`;

const DECK_TOOL = {
  name: 'write_deck_description',
  description: 'Submit the deck analysis and the finished description.',
  input_schema: {
    type: 'object',
    properties: {
      analysis: {
        type: 'object',
        properties: {
          themes: { type: 'array', items: { type: 'string' }, description: 'Each theme with its supporting cards and quantities.' },
          primaryPlan: { type: 'string' },
          loop: { type: 'string', description: 'The repeatable sequence the deck tries to execute.' },
          weaknesses: { type: 'string' }
        },
        required: ['themes', 'primaryPlan', 'loop', 'weaknesses']
      },
      ...Object.fromEntries(SECTION_KEYS.map((k) => [k, { type: 'string' }]))
    },
    required: ['analysis', ...SECTION_KEYS]
  }
};

function formatDecklist(deck, knowledge) {
  const line = (c) => {
    const k = knowledge[c.cardId];
    return (
      `- ${c.qty ? c.qty + 'x ' : ''}@[${c.displayName}] | ${c.cardType}${c.color ? ' | ' + c.color : ''}` +
      `${c.cost != null ? ' | cost ' + c.cost : ''}${c.power != null ? ' | power ' + c.power : ''}${c.ram != null ? ' | RAM ' + c.ram : ''}` +
      `${c.isEddiable ? ' | SELLABLE (has a Sell Tag)' : ' | NOT SELLABLE (no Sell Tag)'}\n` +
      `  TEXT: ${c.rulesText || '(none)'}\n` +
      (k
        ? `  PROFILE: ${k.summary} | roles: ${k.roles.join(', ') || 'none'} | mechanics: ${k.mechanics.join('; ')} | wants: ${k.wants.join('; ')} | enables: ${k.enables.join('; ')}`
        : '')
    );
  };
  // Role tally weighted by copies, computed here so the model never counts.
  const tally = {};
  for (const c of [...deck.legends, ...deck.cards]) {
    for (const r of knowledge[c.cardId]?.roles || []) tally[r] = (tally[r] || 0) + (c.qty || 1);
  }
  const tallyLine = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}: ${n}`)
    .join(', ');
  const out = [
    `DECK NAME: ${deck.name || 'Untitled'} (the name is not evidence of the plan)`,
    '',
    'LEGENDS:',
    ...deck.legends.map(line),
    '',
    `MAIN DECK (${deck.stats.total} cards):`,
    ...deck.cards.map(line)
  ];
  out.push('', `ROLE TALLY (copies of cards filling each role): ${tallyLine}`, `STATS: ${JSON.stringify(deck.stats)}`);
  if (deck.sideboard.length) out.push('', 'SIDEBOARD:', ...deck.sideboard.map(line));
  if (deck.swapPlans.length) {
    out.push('', 'SWAP PLANS (out -> in):', ...deck.swapPlans.map((p) => `- ${p.name}: ${p.swaps.map((s) => `${s.qty}x @[${s.out}] -> @[${s.in}]`).join('; ')}`));
  }
  return out.join('\n');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Makes card tags reliable. Card display names carry a subtitle after a colon
// ("Maman Brigitte: Spirit of Death") and the model often writes the short form
// or forgets the tag, so:
//  1. a tag whose name isn't exact is resolved to the deck card it means
//     (case-insensitive, or by the part before the colon); unresolvable -> plain text
//  2. plain mentions of a deck card's full or short name are tagged automatically
// A tag written for a short name keeps it as the label: @[Full Name|Short].
function makeTagger(names) {
  const exact = new Set(names);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const baseCount = new Map();
  for (const n of names) {
    const base = n.split(':')[0].trim();
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }
  // short name (text before the colon) -> full name, only when unambiguous
  const shortToFull = new Map();
  for (const n of names) {
    const base = n.split(':')[0].trim();
    if (base !== n && base.length >= 4 && baseCount.get(base) === 1) shortToFull.set(base, n);
  }
  const resolve = (raw) => {
    const t = raw.trim();
    if (exact.has(t)) return { full: t, label: null };
    const lc = lower.get(t.toLowerCase());
    if (lc) return { full: lc, label: null };
    for (const [short, full] of shortToFull) if (short.toLowerCase() === t.toLowerCase()) return { full, label: short };
    return null;
  };
  const tag = (r) => `@[${r.full}${r.label ? '|' + r.label : ''}]`;

  // every mention form, longest first so a full name wins over its short form
  const forms = [...names.map((n) => [n, { full: n, label: null }]), ...[...shortToFull].map(([s, f]) => [s, { full: f, label: s }])].sort((a, b) => b[0].length - a[0].length);
  const formMap = new Map(forms);
  const mentionRe = forms.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${forms.map(([f]) => escapeRe(f)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
    : null;

  return (text) => {
    // 1. normalize existing tags
    let out = text.replace(/@\[([^\]|]+)(?:\|([^\]]+))?\]/g, (m, name, alias) => {
      const r = resolve(name);
      if (!r) return alias || name;
      if (alias) return `@[${r.full}|${alias}]`;
      return tag(r);
    });
    if (!mentionRe) return out;
    // 2. tag plain mentions (outside existing tags)
    out = out
      .split(/(@\[[^\]]*\])/)
      .map((part) => (part.startsWith('@[') ? part : part.replace(mentionRe, (hit) => tag(formMap.get(hit)))))
      .join('');
    return out;
  };
}

// Safety net: drop any sentence that says to sell a card that has no Sell Tag.
// Also drops two kinds of sentence that are wrong or are rules recital rather
// than deck advice: selling Legends (they are spent for 1 Eddie, never sold),
// and blanket "don't sell Units" statements.
const WRONG_SELL = [/\bsell\w*\b[^.!?]*\blegends?\b/i, /\blegends?\b[^.!?]*\bsell\w*\b/i, /\b(?:don'?t|do not|never|can'?t|cannot)\s+sell\s+(?:any\s+)?units?\b/i];
function dropBadSellAdvice(text, unsellable) {
  if (!/sell/i.test(text)) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      if (!/\bsell/i.test(sentence)) return true;
      if (WRONG_SELL.some((re) => re.test(sentence.replace(/@\[[^\]]*\]/g, '')))) return false;
      return ![...sentence.matchAll(/@\[([^\]|]+)/g)].some((m) => unsellable.has(m[1]));
    })
    .join(' ');
}

async function analyzeDeck(deck, onProgress) {
  const all = [...deck.legends, ...deck.cards, ...deck.sideboard];
  // Normally a no-op: the pool was studied up front. Only cards new since then
  // (a new set, edited text) get studied here.
  const { studied, knowledge } = await studyCards(all, (m) => onProgress?.(m));
  if (studied) onProgress?.(`Learned ${studied} new card${studied === 1 ? '' : 's'}.`);
  const playbook = await getPlaybook();
  onProgress?.('Working out the game plan...');
  const input = await callClaude({
    system: DECK_SYSTEM,
    context: `RULES PLAYBOOK:\n\n${playbook}`,
    tool: DECK_TOOL,
    user: formatDecklist(deck, knowledge),
    maxTokens: 16000
  });
  const known = new Set(all.map((c) => c.displayName));
  const sections = {};
  const unsellable = new Set(all.filter((c) => !c.isEddiable).map((c) => c.displayName));
  const retag = makeTagger([...known]);
  for (const k of SECTION_KEYS) sections[k] = dropBadSellAdvice(retag(String(input[k] || '').trim()), unsellable);
  return { sections, analysis: input.analysis || null };
}

// ---- Deck tagging ---------------------------------------------------------------
// Only these tag categories are the model's to assign. Colors are rule-based
// and YouTube channels are the owner's own record, so neither is predicted.
// Add 'misc' here to let it assign miscellaneous tags too.
const AI_TAG_CATEGORIES = ['archetype'];

const TAG_SYSTEM = `You label Cyberpunk Trading Card Game decks with archetype tags. You are given the owner's tag database (each tag with the owner's own definition), then one decklist where every card carries its text and, when known, a knowledge profile.

- Choose ONLY tags from the database, using their definitions as written. Never invent a tag.
- Pick 1 or 2 tags that clearly describe how THIS list plays - judged from the cards, quantities and the Legends, not the deck's name. Pick 0 if none truly fits.
- If worked examples of already-tagged decks are given, stay consistent with how the owner labels decks.
- Give a one-sentence reason per tag, naming the cards that justify it.

Deliver the result by calling the tag_deck tool. Do not reply with plain text.`;

async function tagDeck(deck, tags, examples, onProgress) {
  const pool = tags.filter((t) => AI_TAG_CATEGORIES.includes(t.category));
  if (!pool.length) throw new Error('No archetype tags in the tag database yet.');
  const knowledge = await loadKnowledge();
  const tool = {
    name: 'tag_deck',
    description: 'Submit the archetype tags for this deck.',
    input_schema: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            properties: { id: { type: 'string', enum: pool.map((t) => t.id) }, reason: { type: 'string' } },
            required: ['id', 'reason']
          }
        }
      },
      required: ['tags']
    }
  };
  const context =
    `TAG DATABASE:\n${pool.map((t) => `- ${t.id} | ${t.name}: ${t.description}`).join('\n')}` +
    (examples.length ? `\n\nDECKS THE OWNER HAS ALREADY TAGGED:\n${examples.map((e) => `- ${e.name} (${e.legends.join(', ')}) => ${e.tags.join(', ')}`).join('\n')}` : '');
  onProgress?.('Choosing archetype tags...');
  const input = await callClaude({ system: TAG_SYSTEM, context, tool, user: formatDecklist(deck, knowledge), maxTokens: 4000, effort: 'low' });
  const valid = new Set(pool.map((t) => t.id));
  return { tags: (input.tags || []).filter((t) => valid.has(t.id)).slice(0, 2) };
}

module.exports = { readKey, keyStatus, setKey, tagDeck, analyzeDeck, buildKnowledge, knowledgeStatus };
