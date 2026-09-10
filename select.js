#!/usr/bin/env node
'use strict';

/**
 * Provably-fair random winner selector.
 *
 * Two runs, in this order:
 *
 *   1. BEFORE the target block exists:
 *        node select.js commit --ahead 20
 *      -> writes commitment.json  (git commit #1: the commitment)
 *
 *   2. AFTER the target block is mined:
 *        node select.js draw
 *      -> writes result.json      (git commit #2: the result)
 *
 * Anyone can then check the draw with:
 *        node select.js verify
 *
 * The algorithm section below is the reference implementation from the internal spec
 * (provably-fair-selector-SPEC-internal.md §8),
 * unchanged. Everything under "CLI" is plumbing around it -- it reads and writes
 * files and talks to a block explorer, but it never touches the math.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ===========================================================================
// Algorithm (internal spec §4, §7, §8) -- deterministic, no I/O, no dependencies.
// ===========================================================================

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeEntrants(entrants) {
  const seen = new Set();
  return entrants.map((raw, i) => {
    const id = String(raw).trim();
    if (id === '') throw new Error(`Entrant at index ${i} is empty`);
    if (seen.has(id)) throw new Error(`Duplicate entrant: ${id}`);
    seen.add(id);
    return id;
  });
}

function commitmentHash(entrants) {
  return sha256Hex(normalizeEntrants(entrants).join('\n'));
}

function deriveSeed(commitmentHex, blockHashHex) {
  const block = blockHashHex.trim().toLowerCase().replace(/^0x/, '');
  return crypto.createHash('sha256').update(commitmentHex + ':' + block).digest();
}

function createPRNG(seed) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  function refill() {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(counter++, 0);
    pool = Buffer.concat([pool, crypto.createHash('sha256').update(seed).update(ctr).digest()]);
  }
  return function nextBytes(n) {
    while (pool.length < n) refill();
    const out = pool.subarray(0, n);
    pool = pool.subarray(n);
    return out;
  };
}

function randomInt(nextBytes, range) {
  if (range <= 0) throw new Error('range must be > 0');
  if (range === 1) return 0;
  const bytesNeeded = Math.ceil(Math.log2(range) / 8);
  const maxValue = 2 ** (bytesNeeded * 8);
  const limit = maxValue - (maxValue % range);
  for (;;) {
    const buf = nextBytes(bytesNeeded);
    let val = 0;
    for (let i = 0; i < buf.length; i++) val = val * 256 + buf[i];
    if (val < limit) return val % range;
  }
}

function selectWinners(entrants, n, nextBytes) {
  if (n > entrants.length) throw new Error('n cannot exceed number of entrants');
  const arr = entrants.slice();
  const winners = [];
  for (let i = 0; i < n; i++) {
    const j = i + randomInt(nextBytes, arr.length - i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
    winners.push(arr[i]);
  }
  return winners;
}

function pickWinners(entrants, n, blockHashHex) {
  const list = normalizeEntrants(entrants);
  const commitmentHex = sha256Hex(list.join('\n'));
  const seed = deriveSeed(commitmentHex, blockHashHex);
  const nextBytes = createPRNG(seed);
  const winners = selectWinners(list, n, nextBytes);
  return { commitmentHex, blockHash: blockHashHex, seedHex: seed.toString('hex'), winners };
}

// Internal spec §7 -- optional hardening: require an attacker to control a run of blocks.
function combineBlockHashes(hashes) {
  return crypto.createHash('sha256').update(hashes.join('')).digest('hex');
}

// ===========================================================================
// CLI
// ===========================================================================

const REPO = __dirname;
const EXPLORER = 'https://mempool.space/api';

// Every draw gets its own folder under draws/, created by `commit`, holding a
// snapshot of the entrant list it committed to plus its four ceremony files.
// Nothing about a finished draw is ever touched again: a new tournament writes a
// new folder, so old draws stay verifiable even after the working entrant file
// at the repo root is replaced.
const DRAWS_DIR = path.join(REPO, 'draws');
const DRAWS_MD = path.join(REPO, 'DRAWS.md');

function drawFiles(dir) {
  return {
    dir,
    commitmentJson: path.join(dir, 'commitment.json'),
    commitmentMd: path.join(dir, 'COMMITMENT.md'),
    resultJson: path.join(dir, 'result.json'),
    resultMd: path.join(dir, 'RESULT.md'),
  };
}

// The uploaded entrant file, looked for in this order.
const DEFAULT_SOURCES = ['entrants.json', 'entrants.csv', 'entrants.txt'];

// When the file is an array of objects, the identifier and rank fields are
// detected from these, in priority order (matching is case- and
// punctuation-insensitive, so `user_id`, `userId` and `UserID` are one name).
// Override with --id-field / --rank-field.
// Publicly meaningful identifiers first: a verifier can recognise a username or
// a wallet address, whereas an internal row id tells them nothing. `email` is
// deliberately absent -- pass --id-field email if you really mean to publish one.
const ID_FIELD_CANDIDATES = [
  'username', 'user', 'player', 'entrant', 'participant', 'handle', 'gamertag',
  'nickname', 'nick', 'alias', 'displayName', 'login', 'wallet', 'walletAddress',
  'address', 'account', 'id', 'userId', 'uid', 'playerId', 'entrantId', 'name',
];
const RANK_FIELD_CANDIDATES = ['rank', 'position', 'place', 'standing', 'finalRank', 'pos'];

// A JSON object wrapping the array is unwrapped by looking for these keys.
const WRAPPER_KEY_CANDIDATES = [
  'entrants', 'finalists', 'players', 'participants', 'leaderboard', 'standings',
  'results', 'rankings', 'data', 'list', 'items',
];

const HEX64 = /^[0-9a-f]{64}$/;

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inlineValue] = a.slice(2).split('=');
      if (inlineValue !== undefined) flags[key] = inlineValue;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function intFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  const v = Number(flags[name]);
  if (!Number.isInteger(v)) die(`--${name} must be an integer (got "${flags[name]}")`);
  return v;
}

// --- Reading the uploaded entrant file -------------------------------------
//
// Someone uploads one file listing the entrants -- normally entrants.json.
// Accepted shapes:
//
//   ["alice", "bob", ...]                        bare array of identifiers
//   [{"rank": 1, "username": "alice"}, ...]      array of objects
//   {"finalists": [ ...either of the above... ]} wrapped in an object
//   alice<newline>bob<newline>...                entrants.txt, one id per line
//
// Whatever the shape, it resolves to an ordered list of identifier strings, and
// *that* list is what gets hashed (internal spec §4.1). The resolved list is recorded
// verbatim in commitment.json, so there is never any doubt about what was
// committed -- and `verify` re-derives it from the uploaded file to prove the
// two agree.

function rel(file) {
  return path.relative(REPO, file) || file;
}

function normKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function keyMapOf(obj) {
  const m = new Map();
  for (const k of Object.keys(obj)) m.set(normKey(k), k);
  return m;
}

function findDefaultSource() {
  const found = DEFAULT_SOURCES.map((n) => path.join(REPO, n)).filter((f) => fs.existsSync(f));
  if (found.length === 0) {
    die(
      `no entrant file found.\n` +
        `       Add ${DEFAULT_SOURCES.join(' or ')} to the repo, or pass --entrants <file>.`
    );
  }
  if (found.length > 1) {
    console.warn(
      `warning: found both ${found.map(rel).join(' and ')} -- using ${rel(found[0])}.` +
        ' Delete the other so there is only one source of truth.'
    );
  }
  return found[0];
}

/** Unwraps `{ "finalists": [...] }` down to the array. */
function unwrapArray(file, data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const map = keyMapOf(data);
    for (const cand of WRAPPER_KEY_CANDIDATES) {
      const actual = map.get(normKey(cand));
      if (actual && Array.isArray(data[actual])) return data[actual];
    }
    const arrayKeys = Object.keys(data).filter((k) => Array.isArray(data[k]));
    if (arrayKeys.length === 1) return data[arrayKeys[0]];
    die(
      `${rel(file)} is a JSON object, and I cannot tell which key holds the entrants.\n` +
        `       keys: ${Object.keys(data).join(', ') || '(none)'}\n` +
        '       Make the file a top-level array, or name the array "entrants".'
    );
  }
  die(`${rel(file)} must contain a JSON array of entrants (got ${data === null ? 'null' : typeof data}).`);
}

/**
 * RFC 4180-ish CSV: quoted fields, embedded commas, doubled quotes, CRLF or LF,
 * with or without a trailing newline. Spreadsheet exports are the common case.
 */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let started = false;

  const endField = () => {
    row.push(quoted ? field : field.trim());
    field = '';
    quoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      quoted = true;
      started = true;
    } else if (c === ',') {
      endField();
      started = true;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (started || field !== '' || row.length) endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (started || field !== '' || row.length) endRow();

  // Drop blank trailing rows (spreadsheets love these).
  return rows.filter((r) => r.some((v) => v !== ''));
}

function parseCsv(file, text) {
  let rows;
  try {
    rows = parseCsvRows(text);
  } catch (e) {
    die(`${rel(file)} is not valid CSV: ${e.message}`);
  }
  if (rows.length < 2) die(`${rel(file)} needs a header row and at least one entrant`);

  // Header names are trimmed -- a trailing space in a column name is a
  // spreadsheet artifact, not data ("Rank " and "Rank" are the same column).
  const header = rows[0].map((h) => h.trim());
  const named = header.map((h, i) => [h, i]).filter(([h]) => h !== '');
  const dupe = named.map(([h]) => h).find((h, i, a) => a.indexOf(h) !== i);
  if (dupe) die(`${rel(file)} has two columns both named "${dupe}"`);
  if (named.length === 0) die(`${rel(file)} has no named columns in its header row`);

  const unnamed = header.map((h, i) => [h, i]).filter(([h]) => h === '');
  return rows.slice(1).map((cells, r) => {
    if (cells.length > header.length) {
      die(
        `${rel(file)} row ${r + 2} has ${cells.length} values but the header has ${header.length} columns.\n` +
          '       A stray comma, or a value containing a comma that is not quoted.'
      );
    }
    for (const [, i] of unnamed) {
      if ((cells[i] ?? '') !== '') {
        die(`${rel(file)} row ${r + 2} has a value in a column with no header name -- name that column.`);
      }
    }
    const obj = {};
    for (const [name, i] of named) obj[name] = cells[i] ?? '';
    return obj;
  });
}

function parseSourceFile(file, raw) {
  const text = raw.toString('utf8').replace(/^﻿/, '');
  if (file.toLowerCase().endsWith('.csv')) {
    return { format: 'csv', items: parseCsv(file, text) };
  }
  if (file.toLowerCase().endsWith('.json')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      die(`${rel(file)} is not valid JSON: ${e.message}`);
    }
    return { format: 'json', items: unwrapArray(file, data) };
  }
  const items = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return { format: 'lines', items };
}

/** Resolves an explicit --id-field / --rank-field against the actual keys. */
function requireField(file, items, wanted, what) {
  const norm = normKey(wanted);
  const missing = items.findIndex((it) => !keyMapOf(it).has(norm));
  if (missing !== -1) {
    die(
      `--${what}-field "${wanted}" is missing from entry ${missing + 1} of ${rel(file)}.\n` +
        `       keys there: ${Object.keys(items[missing]).join(', ') || '(none)'}`
    );
  }
  return keyMapOf(items[0]).get(norm);
}

/** Picks the first candidate field that is present, non-empty and unique everywhere. */
function detectIdField(file, items) {
  const maps = items.map(keyMapOf);
  const rejected = [];
  const seenCandidates = new Set();
  for (const cand of ID_FIELD_CANDIDATES) {
    const norm = normKey(cand);
    if (seenCandidates.has(norm)) continue; // e.g. username / userName are one name
    seenCandidates.add(norm);
    if (!maps.every((m) => m.has(norm))) continue;
    const key = maps[0].get(norm);
    const values = items.map((it, i) => String(it[maps[i].get(norm)] ?? '').trim());
    if (values.some((v) => v === '')) {
      rejected.push({ key, why: 'empty in at least one entry' });
      continue;
    }
    const dupe = values.find((v, i) => values.indexOf(v) !== i);
    if (dupe !== undefined) {
      rejected.push({
        key,
        why: 'not unique',
        detail: `"${dupe}" appears ${values.filter((v) => v === dupe).length} times`,
      });
      continue;
    }
    return key;
  }

  // A field that is present everywhere but repeats a value is the more likely
  // story: the file lists the same entrant twice. Say that, rather than blaming
  // the detection.
  const notUnique = rejected.filter((r) => r.why === 'not unique');
  if (notUnique.length) {
    die(
      `${rel(file)} lists the same entrant more than once.\n` +
        notUnique.map((r) => `       ${r.key}: ${r.detail}\n`).join('') +
        '       Every entrant must appear exactly once. Fix the file,\n' +
        '       or pass --id-field <key> if a different field is the real identifier.'
    );
  }
  die(
    `cannot tell which field in ${rel(file)} is the entrant identifier.\n` +
      `       keys available: ${Object.keys(items[0]).join(', ') || '(none)'}\n` +
      (rejected.length ? `       rejected: ${rejected.map((r) => `${r.key} (${r.why})`).join('; ')}\n` : '') +
      '       Pass --id-field <key> to say which one it is.'
  );
}

function detectRankField(items) {
  const maps = items.map(keyMapOf);
  const seen = new Set();
  for (const cand of RANK_FIELD_CANDIDATES) {
    const norm = normKey(cand);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!maps.every((m) => m.has(norm))) continue;
    if (!items.every((it, i) => Number.isFinite(Number(it[maps[i].get(norm)])))) continue;
    return maps[0].get(norm);
  }
  return null;
}

function getField(item, field) {
  return item[keyMapOf(item).get(normKey(field))];
}

/** Parses `11-50` into an inclusive {from, to}. */
function parseRange(value, what) {
  const m = String(value).match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (!m) die(`--${what} must look like 11-50 (got "${value}")`);
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from > to) die(`--${what} start ${from} is greater than end ${to}`);
  return { from, to };
}

/**
 * Reads the uploaded file and works out the eligible pool.
 *
 * `spec` is the recorded, replayable description of how to get from the file to
 * the pool: { idField, rankField, eligibility: { mode, from, to } }. `commit`
 * builds it from the CLI flags and stores it; `verify` replays it.
 *
 * Returns { file, sha256, format, spec, records, ids } where records carry
 * { id, rank, position } for display, and ids is the ordered committed list.
 */
function resolveEntrantSource(file, spec) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    die(`cannot read ${rel(file)}: ${e.message}`);
  }
  const sha256 = sha256Hex(raw);
  const { format, items } = parseSourceFile(file, raw);
  if (items.length === 0) die(`${rel(file)} contains no entrants`);

  const kinds = new Set(items.map((it) => (it === null ? 'null' : Array.isArray(it) ? 'array' : typeof it)));
  const objects = kinds.has('object');
  if (objects && kinds.size > 1) {
    die(`${rel(file)} mixes objects and plain values -- make every entry the same shape.`);
  }
  if (kinds.has('null') || kinds.has('array')) {
    die(`${rel(file)} contains an entry that is null or an array -- entries must be identifiers or objects.`);
  }

  let idField = null;
  let rankField = null;
  let records;

  if (objects) {
    idField = spec.idField ? requireField(file, items, spec.idField, 'id') : detectIdField(file, items);
    if (spec.rankField) {
      rankField = requireField(file, items, spec.rankField, 'rank');
    } else if (spec.eligibility.mode === 'rank-range' || spec.rankField === undefined) {
      rankField = detectRankField(items);
    }
    records = items.map((it, i) => ({
      id: String(getField(it, idField) ?? '').trim(),
      rank: rankField ? Number(getField(it, rankField)) : null,
      position: i + 1,
      item: it,
    }));
  } else {
    records = items.map((it, i) => ({ id: String(it).trim(), rank: null, position: i + 1, item: it }));
  }

  // Eligibility: which of the uploaded entrants are in the draw, and in what order.
  const { mode, from, to } = spec.eligibility;
  let eligible;
  if (mode === 'rank-range') {
    if (!rankField) {
      die(
        `--rank-range needs a rank field, and ${rel(file)} has none I recognise.\n` +
          '       Pass --rank-field <key>, or use --slice to take positions from the file order instead.'
      );
    }
    const ranks = records.map((r) => r.rank);
    if (ranks.some((r) => !Number.isFinite(r))) die(`${rel(file)} has a non-numeric ${rankField}`);
    if (new Set(ranks).size !== ranks.length) {
      die(
        `${rel(file)} has duplicate ${rankField} values, so ascending-rank order is ambiguous.\n` +
          '       Break the ties in the file, or use --slice to commit to the file order as given.'
      );
    }
    eligible = records.filter((r) => r.rank >= from && r.rank <= to).sort((a, b) => a.rank - b.rank);
    if (eligible.length === 0) die(`no entrants in ${rel(file)} have a ${rankField} between ${from} and ${to}`);
  } else if (mode === 'slice') {
    if (from > records.length) {
      die(`--slice starts at ${from} but ${rel(file)} has only ${records.length} entries`);
    }
    eligible = records.slice(from - 1, to);
  } else {
    eligible = records.slice();
  }

  if (mode !== 'rank-range' && rankField) {
    const ranks = eligible.map((r) => r.rank);
    const ascending = ranks.every((r, i) => i === 0 || r >= ranks[i - 1]);
    if (!ascending) {
      console.warn(
        `warning: ${rel(file)} has a ${rankField} field but is not in ascending ${rankField} order.` +
          ' Committing to the file order as given -- use --rank-range to order by rank instead.'
      );
    }
  }

  return {
    file,
    sha256,
    format,
    spec: { idField, rankField, eligibility: { mode, from: from ?? null, to: to ?? null } },
    records: eligible,
    ids: normalizeEntrants(eligible.map((r) => r.id)),
  };
}

/** Builds the eligibility spec from `commit`'s flags. */
function eligibilityFromFlags(flags) {
  if (flags['rank-range'] && flags.slice) die('pass either --rank-range or --slice, not both');
  if (flags['rank-range']) return { mode: 'rank-range', ...parseRange(flags['rank-range'], 'rank-range') };
  if (flags.slice) return { mode: 'slice', ...parseRange(flags.slice, 'slice') };
  return { mode: 'all' };
}

function describeEligibility(spec) {
  const { mode, from, to } = spec.eligibility;
  if (mode === 'rank-range') return `${spec.rankField} ${from}-${to}, ascending`;
  if (mode === 'slice') return `positions ${from}-${to} of the file, in file order`;
  return 'every entrant in the file, in file order';
}

function printPool(source) {
  const rows = source.records;
  const show = rows.length <= 8 ? rows : [...rows.slice(0, 3), null, ...rows.slice(-3)];
  for (const r of show) {
    if (r === null) {
      console.log(`      ... ${rows.length - 6} more ...`);
      continue;
    }
    const label = r.rank !== null ? `${source.spec.rankField} ${r.rank}` : `#${r.position}`;
    console.log(`      ${String(label).padEnd(14)} ${r.id}`);
  }
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') die(`${what} not found at ${path.relative(REPO, file)}`);
    die(`cannot parse ${path.relative(REPO, file)}: ${e.message}`);
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function refuseOverwrite(file, flags, hint) {
  if (fs.existsSync(file) && !flags.force) {
    die(
      `${path.relative(REPO, file)} already exists.\n` +
        `       ${hint}\n` +
        `       Pass --force only if you are certain you are not re-rolling a published draw.`
    );
  }
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function getBitcoinTipHeight() {
  const v = parseInt(await fetchText(`${EXPLORER}/blocks/tip/height`), 10);
  if (!Number.isInteger(v)) throw new Error('explorer returned a non-numeric tip height');
  return v;
}

async function getBitcoinBlockHash(height) {
  const hash = await fetchText(`${EXPLORER}/block-height/${height}`);
  if (!HEX64.test(hash)) throw new Error(`explorer returned "${hash}" for height ${height}, not a 64-hex block hash`);
  return hash;
}

// --- Human-readable ceremony pages -----------------------------------------
//
// commitment.json / result.json are the machine-checkable artifacts. These two
// Markdown files carry the same facts for people who will read the repo rather
// than run the script -- GitHub renders them, so the draw is legible to anyone.



function blockLink(height, hash) {
  return '[`' + hash + '`](https://mempool.space/block/' + hash + ')  (height ' + height + ')';
}

function entrantTable(source) {
  const md = [];
  const ranked = source.records.some((r) => r.rank !== null);
  md.push(ranked ? '| # | ' + source.spec.rankField + ' | Entrant |' : '| # | Entrant |');
  md.push(ranked ? '|---:|---:|---|' : '|---:|---|');
  source.records.forEach((r, i) => {
    md.push(ranked ? '| ' + (i + 1) + ' | ' + r.rank + ' | ' + r.id + ' |' : '| ' + (i + 1) + ' | ' + r.id + ' |');
  });
  return md;
}

function renderCommitmentMd(c, source) {
  const last = c.target.height + c.target.blocks - 1;
  const blocks =
    c.target.blocks > 1
      ? 'Bitcoin blocks **' + c.target.height + '-' + last + '** (hashes combined)'
      : 'Bitcoin block **' + c.target.height + '**';
  const md = [];
  md.push('# Draw commitment');
  md.push('');
  md.push('**Status: committed. The winners are not yet known — to anyone, including us.**');
  md.push('');
  md.push('| | |');
  md.push('|---|---|');
  md.push('| Eligible pool | ' + c.entrantCount + ' entrants — ' + describeEligibility(source.spec) + ' |');
  md.push('| Winners to draw | ' + c.n + ' |');
  md.push('| Commitment hash | `' + c.commitmentHex + '` |');
  md.push('| Randomness | ' + blocks + ' |');
  md.push('| Chain tip when committed | ' + (c.tipHeightAtCommit === null ? 'not recorded' : c.tipHeightAtCommit) + ' |');
  md.push('| Committed at | ' + c.createdAt + ' |');
  md.push('| Entrant file | `' + c.source.file + '` — sha256 `' + c.source.sha256 + '` |');
  md.push('');
  md.push('The winners will be a deterministic function of the list below and the hash of that');
  md.push('block. The block did not exist when this was published (the tip was ' + c.tipHeightAtCommit + '),');
  md.push('so nobody could know or steer the outcome. See');
  md.push('[README](../../README.md#what-this-actually-does) for what that buys you.');
  md.push('');
  md.push('Watch the block: <https://mempool.space/block/' + c.target.height + '>');
  md.push('');
  md.push('## Eligible entrants, in committed order');
  md.push('');
  md.push('The commitment hash above is the SHA-256 of exactly these ' + c.entrantCount + ' identifiers, one per');
  md.push('line, in this order (see `commitmentHash` in [select.js](../../select.js)).');
  md.push('');
  md.push(...entrantTable(source));
  md.push('');
  md.push('## Checking this after the draw');
  md.push('');
  md.push('```bash');
  md.push('node select.js verify');
  md.push('```');
  md.push('');
  md.push('That recomputes the hash above from the list above, re-reads the block hash from the');
  md.push('chain, and re-runs the draw. Anything altered after this commit shows up as a FAIL.');
  md.push('');
  return md.join('\n');
}

function renderResultMd(c, r) {
  const md = [];
  md.push('# Draw result');
  md.push('');
  md.push('**' + r.n + ' winners, drawn from ' + r.entrantCount + ' eligible entrants.**');
  md.push('');
  md.push('| Draw order | Winner |');
  md.push('|---:|---|');
  r.winners.forEach((w, i) => md.push('| ' + (i + 1) + ' | **' + w + '** |'));
  md.push('');
  md.push('## The inputs, all publicly checkable');
  md.push('');
  md.push('| | |');
  md.push('|---|---|');
  md.push('| Commitment hash | `' + r.commitmentHex + '` |');
  r.blockHashes.forEach((h, i) => md.push('| Block hash | ' + blockLink(r.target.height + i, h) + ' |'));
  if (r.blockHashes.length > 1) md.push('| Combined beacon | `' + r.beacon + '` |');
  md.push('| Seed | `' + r.seedHex + '` |');
  md.push('| Winners drawn | ' + r.n + ' of ' + r.entrantCount + ' |');
  md.push('| Drawn at | ' + r.drawnAt + ' |');
  md.push('');
  md.push('The commitment hash and the block height were published in');
  md.push('[COMMITMENT.md](COMMITMENT.md) **before** that block was mined — that commit is in this');
  md.push("repo's history, timestamped. The eligible list is there too.");
  md.push('');
  md.push('## Verify it yourself');
  md.push('');
  md.push('You do not have to trust any of the above. Node 18+, no dependencies:');
  md.push('');
  md.push('```bash');
  md.push('node select.js verify');
  md.push('```');
  md.push('');
  md.push('It re-derives the eligible pool, re-reads the block hash from the live chain, re-runs');
  md.push('the draw, and prints a check per line — ending in `PASS` if, and only if, the winners');
  md.push('above follow from the committed inputs. Exit code 0 means pass, 1 means something was');
  md.push('tampered with.');
  md.push('');
  md.push('How it works, in full: [README.md](../../README.md).');
  md.push('');
  return md.join('\n');
}

// --- Draw history ----------------------------------------------------------

/** Folder name for a new draw: the date it was committed plus the target block. */
function newDrawDir(flags, height) {
  // UTC instant, colons dropped so the name survives the sanitizer below and reads
  // cleanly in a URL: 2026-09-09T142351Z-block966500. The T/Z mark it as a timestamp.
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '');
  const wanted = String(flags.draw || `${stamp}-block${height}`).replace(
    /[^A-Za-z0-9._-]+/g,
    '-'
  );
  let dest = path.join(DRAWS_DIR, wanted);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(DRAWS_DIR, `${wanted}-${n}`);
  return dest;
}

/** Resolves --draw: a folder name under draws/, or a path to one. */
function namedDraw(value) {
  const raw = String(value);
  const dir = raw.includes('/') || raw.includes(path.sep) ? path.resolve(raw) : path.join(DRAWS_DIR, raw);
  if (!fs.existsSync(dir)) die(`no draw at ${path.relative(REPO, dir) || dir}`);
  return drawFiles(dir);
}

function readDrawRow(dir) {
  const files = drawFiles(dir);
  if (!fs.existsSync(files.commitmentJson)) return null;
  let c;
  try {
    c = JSON.parse(fs.readFileSync(files.commitmentJson, 'utf8'));
  } catch {
    return null;
  }
  let r = null;
  if (fs.existsSync(files.resultJson)) {
    try {
      r = JSON.parse(fs.readFileSync(files.resultJson, 'utf8'));
    } catch {
      r = null;
    }
  }
  return { relDir: path.relative(REPO, dir), files, c, r };
}

function listDraws() {
  const rows = [];
  if (fs.existsSync(DRAWS_DIR)) {
    for (const name of fs.readdirSync(DRAWS_DIR)) {
      const dir = path.join(DRAWS_DIR, name);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const row = readDrawRow(dir);
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) => String(a.c.createdAt).localeCompare(String(b.c.createdAt)));
  return rows;
}

/** The one draw that is committed but not yet drawn. */
function pendingDraw() {
  const pending = listDraws().filter((d) => !d.r);
  if (pending.length === 0) {
    die(
      'no draw is waiting to be drawn.\n' +
        '       Start one first:  node select.js commit --rank-range 11-50 --n 3 --ahead 20'
    );
  }
  if (pending.length > 1) {
    die(
      'more than one draw is waiting:\n' +
        pending.map((d) => `         ${d.relDir}  (block ${d.c.target && d.c.target.height})\n`).join('') +
        '       Say which one:  node select.js draw --draw <folder>'
    );
  }
  return pending[0].files;
}

/** The draw `verify` checks when not told which: the most recent finished one. */
function latestDraw() {
  const all = listDraws();
  if (all.length === 0) die('this repo has no draws yet.');
  const finished = all.filter((d) => d.r);
  return (finished.length ? finished[finished.length - 1] : all[all.length - 1]).files;
}

/** Rewrites DRAWS.md: every draw this repo has ever run, newest last. */
function writeDrawsIndex() {
  const rows = listDraws();
  if (rows.length === 0) return null;
  const md = [];
  md.push('# Draws');
  md.push('');
  md.push('Every draw this repo has run. Each one is a promise published before a Bitcoin');
  md.push('block existed, then the result that block produced.');
  md.push('');
  md.push('| Draw | Entrants | Winners | Block | Outcome |');
  md.push('|---|---:|---:|---:|---|');
  for (const { relDir, c, r } of rows) {
    const where = relDir.split(path.sep).join('/') + '/';
    const outcome = r
      ? r.winners.map((w) => '**' + w + '**').join(', ') + ' — [result](' + where + 'RESULT.md)'
      : '_waiting for block ' + (c.target && c.target.height) + '_ — [commitment](' + where + 'COMMITMENT.md)';
    md.push(
      '| [`' + relDir.split(path.sep).join('/') + '`](' + where + ') | ' + c.entrantCount + ' | ' + c.n + ' | ' +
        (c.target && c.target.height) + ' | ' + outcome + ' |'
    );
  }
  md.push('');
  md.push('Check any of them yourself — Node 18+, no dependencies:');
  md.push('');
  md.push('```bash');
  md.push('node select.js verify                  # the most recent draw');
  md.push('node select.js verify --draw <folder>  # a specific one');
  md.push('```');
  md.push('');
  fs.writeFileSync(DRAWS_MD, md.join('\n'));
  return rows.length;
}

// --- commit: Phase 1 -------------------------------------------------------

async function cmdCommit(flags) {
  // Each commit creates a fresh folder, so no earlier draw can be touched.

  const entrantsFile = flags.entrants ? path.resolve(flags.entrants) : findDefaultSource();
  const source = resolveEntrantSource(entrantsFile, {
    idField: flags['id-field'],
    rankField: flags['rank-field'],
    eligibility: eligibilityFromFlags(flags),
  });
  const entrants = source.ids;

  const n = intFlag(flags, 'n') ?? 3;
  if (n < 1) die('--n must be at least 1');
  if (n > entrants.length) die(`--n is ${n} but the eligible pool has only ${entrants.length} entrants`);

  const blocks = intFlag(flags, 'blocks') ?? 1;
  if (blocks < 1) die('--blocks must be at least 1');

  let height = intFlag(flags, 'height');
  const ahead = intFlag(flags, 'ahead');
  let tip = null;

  if (height !== undefined && ahead !== undefined) die('pass either --height or --ahead, not both');

  if (height === undefined) {
    const buffer = ahead ?? 20;
    if (buffer < 1) die('--ahead must be at least 1');
    try {
      tip = await getBitcoinTipHeight();
    } catch (e) {
      die(`could not read the Bitcoin tip height (${e.message}).\n       Re-run with --height <H> and pick a height you know is still in the future.`);
    }
    height = tip + buffer;
  } else {
    try {
      tip = await getBitcoinTipHeight();
    } catch (e) {
      console.warn(`warning: could not read the tip height (${e.message}).`);
      console.warn('warning: could NOT confirm the target block is still unmined. Verify by hand before publishing.');
    }
  }

  // The whole scheme rests on this: the beacon must not exist yet at commit time.
  if (tip !== null) {
    const lastNeeded = height + blocks - 1;
    if (lastNeeded <= tip) {
      die(
        `target block${blocks > 1 ? `s ${height}-${lastNeeded} already exist` : ` ${height} already exists`} (current tip is ${tip}).\n` +
          '       The randomness must not be knowable when you commit. Pick a higher height.'
      );
    }
    if (height - tip < 6) {
      console.warn(`warning: height ${height} is only ${height - tip} block(s) past the tip -- little margin. Consider a larger --ahead.`);
    }
  }

  const drawDir = newDrawDir(flags, height);
  const files = drawFiles(drawDir);

  const commitment = {
    version: 1,
    algorithm: 'select.js (pin the exact commit of this repo when you publish)',
    createdAt: new Date().toISOString(),
    chain: 'bitcoin',
    target: { height, blocks },
    tipHeightAtCommit: tip,
    n,
    entrantCount: entrants.length,
    commitmentHex: commitmentHash(entrants),
    // How the pool was derived from the uploaded file, so `verify` can replay it.
    source: {
      file: path.basename(entrantsFile), // the snapshot beside this commitment
      copiedFrom: path.relative(REPO, entrantsFile) || path.basename(entrantsFile),
      format: source.format,
      sha256: source.sha256,
      idField: source.spec.idField,
      rankField: source.spec.rankField,
      eligibility: source.spec.eligibility,
    },
    entrants,
  };

  // Snapshot the entrant list into the draw folder, then commit to it there. The
  // working copy at the repo root is free to be replaced for the next tournament.
  fs.mkdirSync(drawDir, { recursive: true });
  fs.copyFileSync(entrantsFile, path.join(drawDir, path.basename(entrantsFile)));
  writeJson(files.commitmentJson, commitment);
  fs.writeFileSync(files.commitmentMd, renderCommitmentMd(commitment, source));

  const lastNeeded = height + blocks - 1;
  console.log('PHASE 1 -- COMMIT');
  console.log('');
  console.log(`  Entrant file      ${rel(entrantsFile)}  (${source.format}, sha256 ${source.sha256.slice(0, 16)}...)`);
  if (source.spec.idField) console.log(`  Identifier field  ${source.spec.idField}`);
  console.log(`  Eligible pool     ${entrants.length} entrants -- ${describeEligibility(source.spec)}`);
  printPool(source);
  console.log(`  Winners to draw   N = ${n}`);
  console.log(`  Commitment hash   ${commitment.commitmentHex}`);
  console.log(`  Chain             bitcoin`);
  console.log(
    `  Target block      height ${height}${blocks > 1 ? ` plus the next ${blocks - 1} (through ${lastNeeded}, combined)` : ''}`
  );
  console.log(`  Tip at commit     ${tip === null ? 'unknown (offline)' : tip}`);
  console.log(`  Explorer          https://mempool.space/block/${height}`);
  console.log('');
  const indexed = writeDrawsIndex();
  console.log(`  This draw         ${rel(drawDir)}/`);
  console.log(`  Wrote             ${rel(files.commitmentJson)}   (machine-checkable)`);
  console.log(`                    ${rel(files.commitmentMd)}     (readable -- what people will open)`);
  console.log(`                    ${rel(path.join(drawDir, path.basename(entrantsFile)))}   (snapshot of the list)`);
  if (indexed) console.log(`                    ${rel(DRAWS_MD)}   (index of all ${indexed} draw(s))`);
  console.log('');
  console.log('  Publish this now, before the target block is mined:');
  console.log('    git add -A && git commit -m "Commit: draw parameters + entrant list"');
  console.log('    git push');
  console.log('');
  console.log(`  Then wait for block ${lastNeeded} and run:  node select.js draw`);
  console.log('');
  console.log('  The next tournament: replace the leaderboard at the repo root and run');
  console.log('  commit again. It writes a new folder; this one is never touched.');
}

// --- draw: Phase 3 ---------------------------------------------------------

/** Loads commitment.json and re-checks it against its own entrant list. */
function loadCommitment(files) {
  const c = readJson(files.commitmentJson, 'commitment.json');
  if (!Array.isArray(c.entrants)) die('commitment.json has no entrants array');
  if (!c.commitmentHex) die('commitment.json has no commitmentHex');
  if (!c.target || !Number.isInteger(c.target.height)) die('commitment.json has no target.height');
  if (!Number.isInteger(c.n)) die('commitment.json has no n');

  const recomputed = commitmentHash(c.entrants);
  if (recomputed !== c.commitmentHex) {
    die(
      'commitment.json is inconsistent -- the entrant list does not hash to the published commitment.\n' +
        `       published:  ${c.commitmentHex}\n` +
        `       recomputed: ${recomputed}\n` +
        '       The list was edited after the commitment was made.'
    );
  }
  c.target.blocks = c.target.blocks ?? 1;
  return c;
}

async function resolveBeacon(commitment, flags) {
  const { height, blocks } = commitment.target;
  const heights = Array.from({ length: blocks }, (_, i) => height + i);

  // Offline mode: paste the hash(es) read off an explorer by eye.
  if (flags['block-hash']) {
    const pasted = String(flags['block-hash'])
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/^0x/, ''));
    if (pasted.length !== blocks) die(`this draw needs ${blocks} block hash(es), got ${pasted.length}`);
    for (const h of pasted) if (!HEX64.test(h)) die(`"${h}" is not a 64-character lowercase hex block hash`);
    return { blockHashes: pasted, source: 'pasted (--block-hash)' };
  }

  let tip;
  try {
    tip = await getBitcoinTipHeight();
  } catch (e) {
    die(`could not reach the explorer (${e.message}).\n       Read the hash off any explorer and pass --block-hash <hex>.`);
  }
  const lastNeeded = heights[heights.length - 1];
  if (lastNeeded > tip) {
    die(
      `block ${lastNeeded} is not mined yet (current tip is ${tip}, ${lastNeeded - tip} to go).\n` +
        '       Wait for it. The draw cannot be run early.'
    );
  }

  const blockHashes = [];
  for (const h of heights) blockHashes.push(await getBitcoinBlockHash(h));
  return { blockHashes, source: `mempool.space (tip ${tip})` };
}

async function cmdDraw(flags) {
  const files = flags.draw ? namedDraw(flags.draw) : pendingDraw();
  refuseOverwrite(files.resultJson, flags, 'This draw has already been run and its result recorded.');

  const commitment = loadCommitment(files);
  const { blockHashes, source } = await resolveBeacon(commitment, flags);
  const beacon = blockHashes.length === 1 ? blockHashes[0] : combineBlockHashes(blockHashes);

  const drawn = pickWinners(commitment.entrants, commitment.n, beacon);
  if (drawn.commitmentHex !== commitment.commitmentHex) die('internal inconsistency: commitment hash changed during the draw');

  const result = {
    version: 1,
    drawnAt: new Date().toISOString(),
    chain: commitment.chain ?? 'bitcoin',
    target: commitment.target,
    commitmentHex: commitment.commitmentHex,
    entrantCount: commitment.entrants.length,
    n: commitment.n,
    blockHashes,
    beacon,
    seedHex: drawn.seedHex,
    winners: drawn.winners,
  };
  writeJson(files.resultJson, result);
  fs.writeFileSync(files.resultMd, renderResultMd(commitment, result));

  const { height, blocks } = commitment.target;
  console.log('PHASE 3 -- DRAW');
  console.log('');
  console.log(`  This draw         ${rel(files.dir)}/`);
  console.log(`  Commitment hash   ${result.commitmentHex}`);
  console.log(`  Eligible pool     ${result.entrantCount} entrants`);
  blockHashes.forEach((h, i) => {
    console.log(`  Block ${height + i}      ${h}`);
  });
  if (blocks > 1) console.log(`  Combined beacon   ${beacon}`);
  console.log(`  Beacon source     ${source}`);
  console.log(`  Seed              ${result.seedHex}`);
  console.log('');
  console.log(`  Winners (${result.n}), in draw order:`);
  result.winners.forEach((w, i) => console.log(`    ${i + 1}. ${w}`));
  console.log('');
  const indexed = writeDrawsIndex();
  console.log(`  Wrote             ${rel(files.resultJson)}   (machine-checkable)`);
  console.log(`                    ${rel(files.resultMd)}     (readable -- what people will open)`);
  if (indexed) console.log(`                    ${rel(DRAWS_MD)}   (index of all ${indexed} draw(s))`);
  console.log('');
  console.log('  Publish the result:');
  console.log('    git add -A && git commit -m "Result: winners drawn from block ' + height + '"');
  console.log('    git push');
  console.log('');
  console.log(`  Anyone can now check it with:  node select.js verify --draw ${path.basename(files.dir)}`);
}

// --- convert: CSV (or anything supported) -> entrants.json -----------------

/** Numeric strings become numbers, but only when they round-trip exactly. */
function coerceScalar(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '' || !Number.isFinite(Number(t))) return v;
  return String(Number(t)) === t ? Number(t) : v; // "007" and "1e3" stay strings
}

async function cmdConvert(flags) {
  const inFile = flags.entrants ? path.resolve(flags.entrants) : findDefaultSource();
  const outFile = path.resolve(flags.out || path.join(REPO, 'entrants.json'));
  if (path.resolve(inFile) === outFile) die('--out is the same file as the input');
  refuseOverwrite(outFile, flags, `${rel(outFile)} already exists.`);

  let raw;
  try {
    raw = fs.readFileSync(inFile);
  } catch (e) {
    die(`cannot read ${rel(inFile)}: ${e.message}`);
  }
  const { format, items } = parseSourceFile(inFile, raw);
  if (items.length === 0) die(`${rel(inFile)} contains no entrants`);

  // Every column is kept as-is. All --rank-range / --slice do is drop rows and
  // put the survivors in rank order; no value is invented or rewritten.
  const spec = {
    idField: flags['id-field'],
    rankField: flags['rank-field'],
    eligibility: eligibilityFromFlags(flags),
  };
  const before = resolveEntrantSource(inFile, spec);
  const kept = before.records.map((r) => r.item);

  const entrants = kept.map((it) => {
    if (typeof it !== 'object' || it === null) return coerceScalar(it);
    const out = {};
    for (const k of Object.keys(it)) out[k] = coerceScalar(it[k]);
    return out;
  });

  const filtered = spec.eligibility.mode !== 'all';
  writeJson(outFile, {
    note:
      'Converted by: node select.js convert' +
      (filtered ? ` (kept ${describeEligibility(before.spec)})` : ' (format change only)') +
      '. Columns and values are unchanged.',
    convertedFrom: {
      file: path.relative(REPO, inFile) || path.basename(inFile),
      format,
      sha256: sha256Hex(raw),
      rows: items.length,
    },
    kept: { count: entrants.length, rule: describeEligibility(before.spec) },
    convertedAt: new Date().toISOString(),
    entrants,
  });

  // Prove the conversion changed nothing that matters: reading the output back
  // must give the same ordered identifier list the input gave.
  const after = resolveEntrantSource(outFile, { eligibility: { mode: 'all' } });
  const faithful = JSON.stringify(before.ids) === JSON.stringify(after.ids);

  console.log('CONVERT');
  console.log('');
  console.log(`  In                ${rel(inFile)}  (${format}, ${items.length} rows)`);
  console.log(`  Out               ${rel(outFile)}  (${entrants.length} rows)`);
  if (before.spec.idField) console.log(`  Identifier field  ${before.spec.idField}`);
  const cols = typeof kept[0] === 'object' && kept[0] !== null ? Object.keys(kept[0]) : null;
  if (cols) console.log(`  Columns kept      ${cols.join(', ')}`);
  console.log(`  Rows kept         ${entrants.length} -- ${describeEligibility(before.spec)}`);
  printPool(before);
  console.log(`  Round-trips?      ${faithful ? 'yes -- same identifiers, same order' : 'NO'}`);
  console.log('');
  if (!faithful) {
    die('the converted file does not resolve to the same entrant list -- refusing to call it faithful');
  }
  if (items.length !== entrants.length) {
    console.log(`  Dropped ${items.length - entrants.length} row(s) outside ${describeEligibility(before.spec)}.`);
  }
  console.log('  Draw from it with:');
  console.log(
    `    node select.js commit --entrants ${rel(outFile)}` +
      (filtered ? ` --rank-range ${spec.eligibility.from}-${spec.eligibility.to}` : '') +
      ' --n 3 --ahead 20'
  );
}

// --- verify: Phase 4 -------------------------------------------------------

async function cmdVerify(flags) {
  // Default to the most recent draw; --draw <folder> checks a specific one.
  const files = flags.draw ? namedDraw(flags.draw) : latestDraw();
  const dir = files.dir;
  const where = path.relative(REPO, dir) || '.';
  const commitment = loadCommitment(files); // dies if the list no longer matches the commitment
  const result = readJson(files.resultJson, 'result.json');
  const checks = [];
  // level: 'ok' passed | 'warn' worth knowing, draw still sound | 'fail' tampered
  const check = (ok, label, detail, level) => {
    checks.push({ level: level || (ok ? 'ok' : 'fail'), label, detail });
  };

  check(true, 'Entrant list matches the published commitment hash', commitment.commitmentHex);

  // Close the loop back to the uploaded file: it is unchanged, and replaying the
  // recorded derivation on it reproduces the committed pool exactly.
  const src = commitment.source;
  if (!src || !src.file) {
    check(true, 'Eligible pool re-derives from the uploaded entrant file', 'SKIPPED -- commitment.json records no source file');
  } else {
    const srcPath = path.join(dir, src.file);
    if (!fs.existsSync(srcPath)) {
      check(true, `Uploaded entrant file ${src.file} is unchanged`, 'SKIPPED -- file is not in this checkout');
    } else {
      const liveHash = sha256Hex(fs.readFileSync(srcPath));
      const replayed = resolveEntrantSource(srcPath, {
        idField: src.idField ?? undefined,
        rankField: src.rankField ?? undefined,
        eligibility: src.eligibility ?? { mode: 'all' },
      });
      const same = JSON.stringify(replayed.ids) === JSON.stringify(commitment.entrants);

      // The raw file hash is provenance, not the commitment. If the bytes moved
      // but the eligible pool still comes out identical -- a reformat, or an edit
      // somewhere outside the pool -- the draw itself is untouched, so that is a
      // warning. A pool that no longer matches is the real failure.
      if (liveHash === src.sha256) {
        check(true, `Uploaded entrant file ${src.file} is unchanged`, `sha256 ${liveHash}`);
      } else if (same) {
        check(
          false,
          `Uploaded entrant file ${src.file} was edited after the commitment`,
          `now hashes to ${liveHash}, commitment recorded ${src.sha256}\n` +
            '        -- but it still yields the identical eligible pool, so the draw is unaffected\n' +
            '           (a reformat, or an edit outside the eligible pool)',
          'warn'
        );
      } else {
        check(false, `Uploaded entrant file ${src.file} was edited after the commitment`, `now hashes to ${liveHash}, commitment recorded ${src.sha256}`);
      }

      check(
        same,
        'Eligible pool re-derives from the uploaded entrant file',
        same
          ? `${replayed.ids.length} entrants -- ${describeEligibility(replayed.spec)}`
          : `replaying ${src.file} gives ${replayed.ids.length} entrants that differ from the committed list`
      );
    }
  }

  check(
    result.commitmentHex === commitment.commitmentHex,
    'Result was drawn from the committed list',
    result.commitmentHex === commitment.commitmentHex
      ? 'result.json and commitment.json agree'
      : `result says ${result.commitmentHex}, commitment says ${commitment.commitmentHex}`
  );

  const sameTarget =
    result.target &&
    result.target.height === commitment.target.height &&
    (result.target.blocks ?? 1) === commitment.target.blocks;
  check(
    !!sameTarget,
    'Result used the pre-announced target block(s)',
    sameTarget
      ? `height ${commitment.target.height}${commitment.target.blocks > 1 ? ` +${commitment.target.blocks - 1}` : ''}`
      : `result target ${JSON.stringify(result.target)} != committed target ${JSON.stringify(commitment.target)}`
  );

  check(
    result.n === commitment.n,
    'Result drew the pre-announced number of winners',
    result.n === commitment.n ? `N = ${commitment.n}` : `result N = ${result.n}, committed N = ${commitment.n}`
  );

  // The block hash is real: fetch it live from the explorer unless told not to.
  if (flags.offline) {
    check(true, 'Block hash checked against an explorer', 'SKIPPED (--offline) -- check it by eye');
  } else {
    const heights = Array.from({ length: commitment.target.blocks }, (_, i) => commitment.target.height + i);
    try {
      const live = [];
      for (const h of heights) live.push(await getBitcoinBlockHash(h));
      const match = JSON.stringify(live) === JSON.stringify(result.blockHashes);
      check(
        match,
        'Block hash(es) match the live chain',
        match ? live.join(', ') : `chain says ${live.join(', ')}, result says ${(result.blockHashes || []).join(', ')}`
      );
    } catch (e) {
      check(false, 'Block hash(es) match the live chain', `could not reach the explorer: ${e.message}`);
    }
  }

  const expectedBeacon =
    (result.blockHashes || []).length === 1 ? result.blockHashes[0] : combineBlockHashes(result.blockHashes || []);
  check(
    result.beacon === expectedBeacon,
    'Beacon derived correctly from the block hash(es)',
    result.beacon === expectedBeacon ? result.beacon : `expected ${expectedBeacon}, result says ${result.beacon}`
  );

  // The math is honest: re-run the draw.
  const redrawn = pickWinners(commitment.entrants, commitment.n, result.beacon);
  check(
    redrawn.seedHex === result.seedHex,
    'Seed reproduces',
    redrawn.seedHex === result.seedHex ? redrawn.seedHex : `recomputed ${redrawn.seedHex}, result says ${result.seedHex}`
  );
  const winnersMatch = JSON.stringify(redrawn.winners) === JSON.stringify(result.winners);
  check(
    winnersMatch,
    'Winners reproduce',
    winnersMatch ? redrawn.winners.join(', ') : `recomputed [${redrawn.winners.join(', ')}], result says [${(result.winners || []).join(', ')}]`
  );

  console.log('PHASE 4 -- VERIFY');
  console.log('');
  console.log(`  Draw              ${where}${flags.draw ? '' : '  (most recent)'}`);
  console.log('');
  const marker = { ok: 'ok  ', warn: 'note', fail: 'FAIL' };
  for (const c of checks) {
    console.log(`  ${marker[c.level]}  ${c.label}`);
    console.log(`        ${c.detail}`);
  }
  console.log('');
  const failed = checks.filter((c) => c.level === 'fail');
  const warned = checks.filter((c) => c.level === 'warn');
  if (failed.length === 0) {
    console.log('  PASS -- the draw is reproducible from public data.');
    if (warned.length) console.log(`         ${warned.length} note(s) above -- worth reading, but the winners check out.`);
  } else {
    console.log(`  FAIL -- ${failed.length} check(s) did not pass. Something was tampered with.`);
    process.exit(1);
  }
}

// --- selftest --------------------------------------------------------------

function cmdSelftest() {
  const results = [];
  const t = (name, fn) => {
    try {
      fn();
      results.push([true, name, '']);
    } catch (e) {
      results.push([false, name, e.message]);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const pool = Array.from({ length: 40 }, (_, i) => `player_${i + 11}`);
  const block = 'a'.repeat(64);

  t('commitment is the SHA-256 of the newline-joined list', () => {
    assert(
      commitmentHash(['a', 'b', 'c']) === sha256Hex('a\nb\nc'),
      'commitmentHash does not match SHA-256 of "a\\nb\\nc"'
    );
  });

  t('commitment is order-sensitive', () => {
    assert(commitmentHash(['a', 'b']) !== commitmentHash(['b', 'a']), 'reordering did not change the commitment');
  });

  t('empty and duplicate identifiers are rejected', () => {
    let threw = 0;
    try { normalizeEntrants(['a', '  ']); } catch { threw++; }
    try { normalizeEntrants(['a', 'a']); } catch { threw++; }
    assert(threw === 2, 'normalizeEntrants accepted an empty or duplicate identifier');
  });

  t('draw is deterministic across runs', () => {
    const a = pickWinners(pool, 3, block);
    const b = pickWinners(pool, 3, block);
    assert(JSON.stringify(a) === JSON.stringify(b), 'two runs with identical inputs disagreed');
  });

  t('block hash normalization (0x, case, whitespace) is a no-op on the outcome', () => {
    const a = pickWinners(pool, 3, block).seedHex;
    const b = pickWinners(pool, 3, `  0x${block.toUpperCase()}  `).seedHex;
    assert(a === b, 'seed changed under trim/lowercase/0x-strip');
  });

  t('one changed character changes the winners', () => {
    const a = pickWinners(pool, 3, block).winners.join(',');
    const b = pickWinners(pool, 3, 'b' + block.slice(1)).winners.join(',');
    assert(a !== b, 'a different block hash produced the same winners');
  });

  t('winners are unique and drawn from the pool', () => {
    for (let k = 0; k < 200; k++) {
      const w = pickWinners(pool, 5, sha256Hex(String(k))).winners;
      assert(new Set(w).size === 5, `run ${k} produced a duplicate winner`);
      for (const x of w) assert(pool.includes(x), `run ${k} produced ${x}, not in the pool`);
    }
  });

  t('drawing the whole pool is a permutation', () => {
    const w = pickWinners(pool, pool.length, block).winners;
    assert(new Set(w).size === pool.length, 'full draw contained duplicates');
    assert([...w].sort().join() === [...pool].sort().join(), 'full draw was not a permutation of the pool');
  });

  t('n > pool size is rejected', () => {
    let threw = false;
    try { pickWinners(['a', 'b'], 3, block); } catch { threw = true; }
    assert(threw, 'drawing more winners than entrants was allowed');
  });

  t('selection is uniform (chi-square over 60000 single draws from 40)', () => {
    const counts = new Array(40).fill(0);
    const trials = 60000;
    for (let k = 0; k < trials; k++) {
      counts[pool.indexOf(pickWinners(pool, 1, sha256Hex(`u${k}`)).winners[0])]++;
    }
    const expected = trials / 40;
    const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    // 39 degrees of freedom: chi-square exceeds ~72.1 with probability 0.001.
    assert(chi2 < 72.1, `chi-square ${chi2.toFixed(1)} over 39 df -- distribution looks skewed`);
  });

  t('randomInt never exceeds its range', () => {
    for (const range of [2, 3, 40, 255, 256, 257, 1000, 65535, 65537]) {
      const next = createPRNG(deriveSeed('c', String(range)));
      for (let k = 0; k < 500; k++) {
        const v = randomInt(next, range);
        assert(Number.isInteger(v) && v >= 0 && v < range, `randomInt returned ${v} for range ${range}`);
      }
    }
  });

  t('combineBlockHashes binds every block in the run', () => {
    const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);
    assert(combineBlockHashes([h1, h2]) === sha256Hex(h1 + h2), 'combineBlockHashes is not SHA-256 of the concatenation');
    assert(combineBlockHashes([h1, h2]) !== combineBlockHashes([h2, h1]), 'combineBlockHashes ignores order');
  });

  console.log('SELFTEST');
  console.log('');
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
  const failed = results.filter(([ok]) => !ok).length;
  console.log('');
  console.log(failed === 0 ? `  PASS -- ${results.length}/${results.length} checks.` : `  FAIL -- ${failed} of ${results.length} checks failed.`);
  if (failed > 0) process.exit(1);
}

// --- usage -----------------------------------------------------------------

function cmdHelp() {
  console.log(`Provably-fair random winner selector (see README.md)

Usage: node select.js <command> [options]

  commit     Phase 1, run BEFORE the target block exists.
             Hashes the entrant list, pins the target block height, and writes
             commitment.json. Commit that to git and publish it.

               --entrants <file>     the uploaded entrant file: .json, .csv or
                                     .txt  (default: entrants.json, then
                                     entrants.csv, then entrants.txt)
               --rank-range <a-b>    eligible = this inclusive rank range,
                                     ordered by ascending rank (e.g. 11-50)
               --slice <a-b>         eligible = these 1-based positions of the
                                     file, in file order (for files with no rank)
               --id-field <key>      which field is the identifier
                                     (default: detected, then printed)
               --rank-field <key>    which field is the rank (default: detected)
               --n <count>           winners to draw                (default: 3)
               --ahead <blocks>      target = current tip + blocks (default: 20, ~3.3h)
               --height <height>     pin an exact target height instead of --ahead
               --blocks <count>      combine a run of blocks (default: 1)
               --draw <name>         folder name for this draw under draws/
                                     (default: today's date and the block height)

             Each run creates draws/<name>/ holding the commitment and a snapshot
             of the entrant list. Earlier draws are never touched, so every past
             result stays published and verifiable.

  draw       Phase 3, run AFTER the target block is mined.
             Finds the draw that is waiting, fetches the block hash, derives the
             seed, draws the winners, and writes result.json + RESULT.md into
             that draw's folder.

               --draw <folder>     which draw to run, if more than one is waiting
               --block-hash <hex>  use a hash you read off an explorer instead
                                   of fetching it (comma-separated if --blocks > 1)
               --force             overwrite an existing result.json

  verify     Phase 4, for anyone. Re-checks the uploaded entrant file,
             commitment.json and result.json against each other and against the
             live chain, and re-runs the draw.

               --offline           skip the live block-hash lookup
               --draw <folder>     check a specific draw under draws/
                                   (default: the most recent one)

  convert    Rewrites a CSV (or any supported file) as entrants.json: same
             columns, same order, nothing invented. Optionally trims it to the
             rows you actually want to draw from. Note that commit reads CSV
             directly, so this is only for when you want the list as JSON.

               --entrants <file>     input  (default: entrants.json/.csv/.txt)
               --out <file>          output (default: entrants.json)
               --rank-range <a-b>    keep only this rank range, ascending
               --slice <a-b>         keep only these 1-based file positions
               --force               overwrite an existing output file

  selftest   Checks the algorithm itself: determinism, uniqueness, uniformity,
             tamper-sensitivity. No network, no files.

Typical run:

  node select.js commit --rank-range 11-50 --n 3 --ahead 20
                                       # then: git commit + push   (commit phase)
  ... wait for the block ...
  node select.js draw                  # then: git commit + push   (result phase)
  node select.js verify
`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  switch (cmd) {
    case 'commit': return cmdCommit(flags);
    case 'draw': return cmdDraw(flags);
    case 'verify': return cmdVerify(flags);
    case 'convert': return cmdConvert(flags);
    case 'selftest': return cmdSelftest();
    case 'help': case undefined: return cmdHelp();
    default:
      console.error(`error: unknown command "${cmd}"\n`);
      cmdHelp();
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => die(e.message));
}

module.exports = {
  sha256Hex, normalizeEntrants, commitmentHash, deriveSeed,
  createPRNG, randomInt, selectWinners, pickWinners, combineBlockHashes,
};
