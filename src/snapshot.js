'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const readline = require('readline');
// Snapshot format: gzipped NDJSON, shipped as ordered parts
// data/entities-1.ndjson.gz, entities-2.ndjson.gz, ... (the single file
// would be several hundred MB gzipped — far over GitHub's 25 MB
// browser-upload limit, and this portfolio publishes via browser upload).
// Concatenating the gunzipped parts in filename order reproduces the
// original stream byte-exactly (split on line boundaries by
// scripts/split-snapshot.js, SHA-256-verified at split time). Line 1 of
// part 1 is {"__meta__": {...}}; each following line is one entity row.
//
// Deliberate deviation from B9's loader: B9 concatenates all gunzipped
// parts into a single Buffer before parsing. At ~3.3M rows the
// uncompressed stream is >2 GB, so this loader streams — gunzip per part,
// line-wise parse, one row materialised at a time. The row array still
// accumulates (the Actor filters in memory, like B6/B9), but no second
// full-size buffer is ever held.
function snapshotPartPaths(dataDir) {
  if (!fs.existsSync(dataDir)) return []; // code-only deployment: parts are hosted (see resolveSnapshotParts)
  return fs.readdirSync(dataDir)
    .filter((n) => /^entities-\d+\.ndjson\.gz$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((n) => path.join(dataDir, n));
}

async function loadSnapshotParts(gzPaths, onProgress) {
  if (!gzPaths.length) throw new Error('loadSnapshotParts: no snapshot part files given');
  let meta = null;
  const rows = [];
  for (const p of gzPaths) {
    const rl = readline.createInterface({
      input: fs.createReadStream(p).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      if (!meta) meta = JSON.parse(line).__meta__;
      else rows.push(JSON.parse(line));
    }
    if (onProgress) onProgress(p, rows.length);
  }
  return { meta, rows };
}

function loadBundledSnapshot(dataDir, onProgress) {
  return loadSnapshotParts(snapshotPartPaths(dataDir), onProgress);
}

// Synchronous loader for a SINGLE small gzipped NDJSON file (test fixtures
// and tooling only — the bundled snapshot is always multi-part).
function loadSnapshot(gzPath) {
  const buf = zlib.gunzipSync(fs.readFileSync(gzPath));
  let meta = null;
  const rows = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i > start) {
        const line = buf.toString('utf8', start, i);
        if (!meta) meta = JSON.parse(line).__meta__;
        else rows.push(JSON.parse(line));
      }
      start = i + 1;
    }
  }
  return { meta, rows };
}

// Meta only (first line of the first part) — cheap.
async function readSnapshotMeta(gzPaths) {
  if (!gzPaths.length) throw new Error('readSnapshotMeta: no snapshot part files given');
  const rl = readline.createInterface({
    input: fs.createReadStream(gzPaths[0]).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    rl.close();
    return JSON.parse(line).__meta__;
  }
  throw new Error('snapshot meta line not found');
}

// Row-by-row streaming over all parts (skips the meta line). The run path
// uses this so peak memory is O(output), not O(register): at 13.2M rows the
// accumulate-everything loader peaks >6 GB in local measurement and cannot
// run on this VM or in Apify's smaller memory tiers.
async function* streamSnapshotRows(gzPaths) {
  let first = true;
  for (const p of gzPaths) {
    const rl = readline.createInterface({
      input: fs.createReadStream(p).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      if (first) { first = false; continue; } // meta line
      yield JSON.parse(line);
    }
  }
}

// --- Hosted-snapshot route (B7 pattern, added 2026-11-22) -------------------
// Resolution order for a snapshot file, mirroring B7's partitions.js:
//   1. the local data/ directory (bundled snapshot — the original behaviour;
//      every function above is untouched and purely local);
//   2. download from SIRENE_SNAPSHOT_BASE_URL (env var, set at publish time
//      to the hosted snapshot location — Cloudflare KV behind a public
//      Worker, see scripts/host_on_cloudflare.py) into a per-run cache
//      directory, then read from disk.
// snapshotPartPaths() stays synchronous and local-only; the run path uses
// resolveSnapshotParts() (async): with local parts present it returns
// exactly what snapshotPartPaths() returns and nothing is downloaded; with
// none present (code-only deployment) it fetches the hosted index.json and
// downloads the canonical part list into the cache, returning cache paths —
// so readSnapshotMeta / streamSnapshotRows / main.js see ordinary local
// files either way.
function snapshotCacheDir() {
  const d = process.env.SIRENE_CACHE_DIR || path.join(os.tmpdir(), 'sirene-snapshot-cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download ${url}: HTTP ${res.statusCode}`)); }
      const tmp = `${dest}.tmp`;
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => { fs.renameSync(tmp, dest); resolve(dest); }));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveSnapshotFile(fileName, dataDir) {
  const local = path.join(dataDir, fileName);
  if (fs.existsSync(local)) return local;
  const base = process.env.SIRENE_SNAPSHOT_BASE_URL;
  if (!base) throw new Error(`snapshot file ${fileName} not found locally and SIRENE_SNAPSHOT_BASE_URL is not set`);
  const dest = path.join(snapshotCacheDir(), fileName);
  if (!fs.existsSync(dest)) await download(`${base.replace(/\/$/, '')}/${fileName}`, dest);
  return dest;
}

async function resolveSnapshotParts(dataDir) {
  const local = snapshotPartPaths(dataDir);
  if (local.length) return local;
  const indexPath = await resolveSnapshotFile('index.json', dataDir);
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!index || !Array.isArray(index.parts) || !index.parts.length) {
    throw new Error('hosted snapshot index.json carries no parts list');
  }
  const parts = [];
  for (const part of index.parts) parts.push(await resolveSnapshotFile(part.file, dataDir));
  return parts;
}

module.exports = { loadSnapshot, loadSnapshotParts, loadBundledSnapshot, snapshotPartPaths, readSnapshotMeta, streamSnapshotRows, resolveSnapshotFile, resolveSnapshotParts };
