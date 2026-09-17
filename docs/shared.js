// Shared across index.html (Needed) and record.html (Record). Needed-page
// reads are plain same-origin fetches (GitHub Pages just serves docs/ as
// static files - no auth needed). Only Record's *writes* to
// data/pending-changes.json go through GitHub's authenticated Contents API,
// since that's the only way a static site can persist anything.

const GH_TOKEN_KEY = 'eddies_gh_token';

function getToken() {
  return localStorage.getItem(GH_TOKEN_KEY) || '';
}

function setToken(token) {
  localStorage.setItem(GH_TOKEN_KEY, token.trim());
}

function clearToken() {
  localStorage.removeItem(GH_TOKEN_KEY);
}

function mainSetCap(cardType) {
  return cardType === 'Legend' ? 1 : 3;
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

// Always hits api.github.com directly (never the Pages CDN), so the sha we
// get back is fresh enough to safely PUT against right after.
async function ghGetFile(path) {
  const { owner, repo } = window.EDDIES_CONFIG;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json'
    }
  });
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}). Check your token has access to this repo.`);
  const data = await res.json();
  return { content: JSON.parse(base64ToUtf8(data.content)), sha: data.sha };
}

async function ghPutFile(path, contentObj, sha, message) {
  const { owner, repo } = window.EDDIES_CONFIG;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(JSON.stringify(contentObj, null, 2)),
      sha
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Quick check that a token actually works against this repo before we
// trust it (catches typos/wrong scopes immediately instead of on first use).
async function verifyToken(token) {
  const { owner, repo } = window.EDDIES_CONFIG;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  });
  return res.ok;
}

// Read-modify-write against a single JSON file, retrying on a 409 (the
// file's sha changed between our read and write - e.g. the desktop app's
// "Publish Site" reset pending-changes.json at nearly the same moment as
// this write). Re-reading and re-applying the mutation on the fresh content
// is safe here because mutateFn is a pure append, not a diff against what
// we last saw.
async function ghUpdateJsonFile(path, mutateFn, messageFn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const { content, sha } = await ghGetFile(path);
    const next = mutateFn(content);
    try {
      await ghPutFile(path, next, sha, messageFn(next));
      return next;
    } catch (err) {
      const isConflict = /\(409\)/.test(err.message);
      if (!isConflict || i === attempts - 1) throw err;
      // Stale sha - loop back and re-read+re-apply against the latest content.
    }
  }
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}
