'use strict';
// B12 — France Sirene Register Actor (dataset-only v1).
// Runs on Apify (uses the `apify` SDK if present) or standalone for local
// testing (no account needed): `node src/main.js` reads input from
// ./input.json or APIFY_INPUT env, writes ./output.json.
//
// Run-path design (deviation from B9/B11, forced by scale and documented in
// the build report): the register holds 13.2M rows. B9/B11 load the whole
// snapshot into memory before filtering; measured locally that peaks >6 GB
// and is OOM-killed on a 7.9 GB VM before the load even completes. This
// Actor instead streams the snapshot row-by-row: filtering, analytics
// accumulation and chunk pushes all happen in a single pass, so peak
// memory is O(one push chunk + analytics maps), independent of register
// size. Output rows are pushed in snapshot order, exactly as before.
const fs = require('fs');
const path = require('path');
const { matchesFilters, createAnalyticsAccumulator } = require('./lib');
const { resolveSnapshotParts, readSnapshotMeta, streamSnapshotRows } = require('./snapshot');

async function getRuntime() {
  try {
    const { Actor } = require('apify');
    await Actor.init();
    return {
      getInput: () => Actor.getInput(),
      pushData: (items) => Actor.pushData(items),
      setValue: (k, v) => Actor.setValue(k, v),
      exit: () => Actor.exit(),
      onPlatform: true,
    };
  } catch (e) {
    return {
      getInput: async () => {
        if (process.env.APIFY_INPUT) return JSON.parse(process.env.APIFY_INPUT);
        const p = path.join(process.cwd(), 'input.json');
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
      },
      pushData: async (items) => { module.exports._localDataset = (module.exports._localDataset || []).concat(items); },
      setValue: async (k, v) => { module.exports._localKV = module.exports._localKV || {}; module.exports._localKV[k] = v; },
      exit: async () => {},
      onPlatform: false,
    };
  }
}

async function main() {
  const rt = await getRuntime();
  const input = (await rt.getInput()) || {};
  const mode = input.mode || 'both'; // rows | analytics | both
  const wantRows = mode !== 'analytics';
  const wantAnalytics = mode === 'analytics' || mode === 'both';
  // resolveSnapshotParts (async, B7 hosted-snapshot pattern): local data/
  // parts when bundled, otherwise the parts are downloaded from
  // SIRENE_SNAPSHOT_BASE_URL into a cache dir first. Either way the rest of
  // the run sees ordinary local files.
  const partPaths = await resolveSnapshotParts(path.join(__dirname, '..', 'data'));
  const totalGzBytes = partPaths.reduce((s, p) => s + fs.statSync(p).size, 0);
  console.log('DIAG gz_bytes=' + totalGzBytes + ' parts=' + partPaths.length);
  const meta = await readSnapshotMeta(partPaths);
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : Infinity;
  const acc = wantAnalytics ? createAnalyticsAccumulator(meta) : null;

  // Direct public-API pushes on platform (standing portfolio rule, from
  // the B6 root cause, 2026-11-21): the SDK pushData path silently loses
  // ~99.6% of items past ~4,24x on this platform. Push chunks straight to
  // api.apify.com with per-chunk HTTP status, then verify the stored count
  // and fail loudly on any mismatch.
  let token = null;
  let datasetId = null;
  if (wantRows && rt.onPlatform) {
    token = process.env.APIFY_TOKEN;
    datasetId = process.env.APIFY_DEFAULT_DATASET_ID;
    if (!token || !datasetId) throw new Error('Missing APIFY_TOKEN or APIFY_DEFAULT_DATASET_ID in run env');
  }
  const BATCH = 1000;
  let chunk = [];
  let pushed = 0;
  const flush = async () => {
    if (!chunk.length) return;
    if (rt.onPlatform) {
      const res = await fetch('https://api.apify.com/v2/datasets/' + datasetId + '/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) throw new Error('Direct push failed at item ' + pushed + ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
      await new Promise((r) => setTimeout(r, 100));
    } else {
      await rt.pushData(chunk);
    }
    pushed += chunk.length;
    if ((pushed / BATCH) % 100 === 0) console.log('DIAG pushed_up_to=' + pushed);
    chunk = [];
  };

  let scanned = 0;
  let filteredCount = 0;
  for await (const row of streamSnapshotRows(partPaths)) {
    scanned += 1;
    if (!matchesFilters(row, input, meta)) continue;
    filteredCount += 1;
    if (acc) acc.add(row);
    if (wantRows && pushed + chunk.length < limit) {
      chunk.push(row);
      if (chunk.length >= BATCH) await flush();
    }
  }
  await flush();
  console.log('DIAG scanned_rows=' + scanned + ' filtered_rows=' + filteredCount + ' pushed=' + pushed);

  if (wantRows && rt.onPlatform) {
    let landed = 0;
    for (let p = 0; p < 24; p++) {
      const infoRes = await fetch('https://api.apify.com/v2/datasets/' + datasetId, { headers: { Authorization: 'Bearer ' + token } });
      const info = await infoRes.json();
      landed = info && info.data ? info.data.itemCount : 0;
      console.log('DIAG dataset_items=' + landed + ' target=' + pushed);
      if (landed >= pushed) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (landed < pushed) {
      throw new Error('Dataset write incomplete after direct pushes: ' + landed + ' of ' + pushed + ' items stored');
    }
    console.log('DIAG dataset_write_landing_complete items=' + landed);
  }

  let analytics = null;
  if (wantAnalytics) {
    analytics = acc.finish();
    analytics.meta = meta;
    console.log('DIAG analytics_rows_analysed=' + analytics.rows_analysed);
    await rt.setValue('ANALYTICS', analytics);
  }
  if (!rt.onPlatform) {
    fs.writeFileSync(path.join(process.cwd(), 'output.json'), JSON.stringify({ dataset: module.exports._localDataset || [], kv: module.exports._localKV || {} }, null, 2));
    console.log(`standalone run: ${pushed} rows pushed, analytics=${analytics ? 'yes' : 'no'}, filtered=${filteredCount}/${scanned}`);
  }
  await rt.exit();
  return { pushedCount: pushed, analytics, filteredCount, scannedCount: scanned };
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
