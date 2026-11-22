// ── tools/build/hagezi-light-selection.mjs ───────────────────────────────────────────
// Which entries of HaGeZi's Multi light ship in ruleset_hagezi_light (10.5.5, owner's decision).
//
// Replaces Chris Buijs' TOP-N version (10.5.2–10.5.4). That one was found (2026-11-02, reproduced exactly)
// to be "HaGeZi light ∩ Tranco top 250,000", matched on '.' AND '-' (so `next-whatsapp.com` counted as
// popular because `whatsapp.com` is): website popularity only, which drops ad-tech that pages LOAD but people
// never VISIT, and keeps mobile-app SDK endpoints a browser never loads.
//
// An entry of HaGeZi's own `adblock/light.txt` is KEPT when any switched-on source vouches for it:
//   TRACKER_RADAR — the entry or a parent of it is a domain DuckDuckGo Tracker Radar lists for one of its
//                   9 crawl regions (domains/<REGION>/<domain>.json; every listed domain, no prevalence cutoff).
//   TOP_SITES     — the entry or a parent of it (down to two labels) is a CrUX site ranked ≤ TOP_SITES_MAX_RANK
//                   (first-party tracking hosts of popular sites: metrics.example.com, sst.example.com).
//   ADULT_SITES   — the entry or a parent of it is one of the owner's top-25 adult sites (adult-sites.mjs).
//   HTTP_ARCHIVE  — the entry, or a subdomain of it, was a third-party request on ≥ HTTP_ARCHIVE_MIN_PAGES pages
//                   in one of the newest HTTP_ARCHIVE_SNAPSHOTS HTTP Archive snapshots (long-tail trackers the
//                   Tracker Radar crawl, top sites only, never meets).
// Matching is on '.' label boundaries only. The geographic scope is NOT applied here: list-parser.mjs's
// applyGeoScopeToNetworkRule() applies it to every network rule of every list, this one included.
// Measured 2026-11-02 against HTTP Archive 2026-03 (selection built from 2025 data only): 26,144 entries,
// 96.9 % of the third-party hosts full HaGeZi light blocks (99.9 % page-weighted); TOP-N 35,696 / 81.9 % / 97.95 %.
//
// Every source is fetched from GitHub. A source that fails, or returns implausibly little, throws — the build then
// keeps the previous ruleset_hagezi_light (carryOverPreviousBuild), never an unfiltered or empty list.
//
// (11.0.0) EFF Privacy Badger's "needed" hosts are excepted for this list by the shared tracker-exception ruleset
// (tools/build/tracking-allowlist-source.mjs), since this list moved into the Seamless tracker lists.
// Public interface: buildSelectedHageziLightText, keepHageziEntry, hageziAdultSiteEntries
// Dependencies: worry-free-extra-lists.mjs (HAGEZI_LIGHT_SOURCE, buildWorryFreeLists), build-state.mjs (topSitesSet),
//   crux-top-sites.mjs, adult-sites.mjs, tracker-radar-source.mjs, ../lib/fetch-with-retry.mjs.
// State owned by this module: none. Temporary git listings live in an OS temp folder, removed in `finally`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withRetry, fetchWithTimeout } from '../lib/fetch-with-retry.mjs';
import { HAGEZI_LIGHT_SOURCE, buildWorryFreeLists } from './worry-free-extra-lists.mjs';
import { topSitesSet } from './build-state.mjs';
import { isTopRankedHostname, topSiteRanksOf } from './crux-top-sites.mjs';
import { ADULT_SITE_DOMAINS } from './adult-sites.mjs';
import { TRACKER_RADAR_BRANCH, TRACKER_RADAR_REGIONS, TRACKER_RADAR_REPO } from './tracker-radar-source.mjs';

/******************************************************************************/
// Settings — the ONLY place these values live.
/******************************************************************************/

// Sources that can keep an entry, each switchable (false = the source is not fetched and keeps nothing).
const HAGEZI_SELECTION_SOURCES = Object.freeze({
    TRACKER_RADAR: true,
    TOP_SITES:     true,
    ADULT_SITES:   true,
    HTTP_ARCHIVE:  true,
});
// CrUX publishes rank buckets (1K, 5K, 10K, 50K, 100K, 500K, 1M) — there is no 250K bucket. 100K and 500K
// measured almost the same coverage (2026-11-02); 100K keeps the list smaller.
const TOP_SITES_MAX_RANK = 100_000;
// HTTP Archive "observed third-party domains" snapshots (patrickhulce/third-party-web, MIT), ~2 per year.
const HTTP_ARCHIVE_REPO = 'https://github.com/patrickhulce/third-party-web.git';
const HTTP_ARCHIVE_BRANCH = 'master';
const HTTP_ARCHIVE_DATA_DIR = 'data';
const HTTP_ARCHIVE_RAW_BASE = 'https://raw.githubusercontent.com/patrickhulce/third-party-web/master/data/';
const HTTP_ARCHIVE_SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}-observed-domains\.json$/;
const HTTP_ARCHIVE_SNAPSHOTS = 3;          // newest snapshots used (≈ 1.5 years of evidence)
const HTTP_ARCHIVE_MIN_PAGES = 50;         // the dataset's own floor — no row has fewer pages
const SNAPSHOT_LABEL_LENGTH = 'YYYY-MM'.length;   // build log shows each snapshot as its month
// Plausibility guards (C13a): far below these means a broken download, not a real change.
const MIN_TRACKER_RADAR_DOMAINS = 10_000;  // 2026-11-02: 23,453
const MIN_SNAPSHOT_ROWS = 40_000;          // 2026-03 snapshot: 72,210
const MIN_HAGEZI_ENTRIES = 50_000;         // HaGeZi light 2026-11-02: 79,665
const MIN_KEPT_ENTRIES = 15_000;           // 2026-11-02: ≈ 26,000
// Git listing (tree only, no file contents) — big enough for Tracker Radar's ~50,000 paths.
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;
const TEMP_DIR_PREFIX = 'hagezi-selection-';
// One line of buildWorryFreeLists()' output: `||domain^` or `||domain^$third-party`.
const ENTRY_LINE_RE = /^\|\|([a-z0-9_.-]+)\^(?:\$third-party)?$/;
const HOSTNAME_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;
const TRACKER_RADAR_FILE_EXT = '.json';    // domains/<REGION>/<domain>.json
const LABEL_SEP = '.';

/******************************************************************************/
// Pure helpers
/******************************************************************************/

// The name itself and every parent ("a.b.c" -> a.b.c, b.c, c). '-' is not a boundary.
function selfAndParents(name) {
    const out = [ name ];
    for ( let i = name.indexOf(LABEL_SEP); i !== -1; i = name.indexOf(LABEL_SEP, i + 1) ) { out.push(name.slice(i + 1)); }
    return out;
}

// Which source keeps a HaGeZi entry (the first that vouches, in HAGEZI_SELECTION_SOURCES order), or null.
// evidence: { trackerRadar: Set|null, topSiteRanks: Map|null, adultSites: Set|null, httpArchive: Set|null }
// (null = source switched off). httpArchive holds every observed name AND each of its parents, so membership of
// the entry itself means "the entry or a subdomain of it was observed".
export function keepHageziEntry(domain, evidence) {
    const chain = selfAndParents(domain);
    if ( evidence.trackerRadar !== null && chain.some(d => evidence.trackerRadar.has(d)) ) { return 'TRACKER_RADAR'; }
    if ( evidence.topSiteRanks !== null && isTopRankedHostname(domain, evidence.topSiteRanks, TOP_SITES_MAX_RANK) ) { return 'TOP_SITES'; }
    if ( evidence.adultSites !== null && chain.some(d => evidence.adultSites.has(d)) ) { return 'ADULT_SITES'; }
    if ( evidence.httpArchive !== null && evidence.httpArchive.has(domain) ) { return 'HTTP_ARCHIVE'; }
    return null;
}

/******************************************************************************/
// Source readers (network)
/******************************************************************************/

// Paths under `dir` in a GitHub repo's newest commit — a tree-only clone (no file contents), always removed.
function listRepoPaths(repo, branch, dir) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    try {
        const checkout = path.join(temp, 'repo');
        execFileSync('git', [ 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', branch, repo, checkout ],
            { stdio: [ 'ignore', 'ignore', 'inherit' ] });
        const out = execFileSync('git', [ 'ls-tree', '-r', '--name-only', 'HEAD', dir ],
            { cwd: checkout, encoding: 'utf8', maxBuffer: GIT_LIST_MAX_BUFFER });
        return out.split('\n').filter(Boolean);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

// Every domain Tracker Radar lists for the in-scope regions (file names: domains/<REGION>/<domain>.json).
function readTrackerRadarDomains() {
    const regions = new Set(TRACKER_RADAR_REGIONS);
    const domains = new Set();
    for ( const p of listRepoPaths(TRACKER_RADAR_REPO, TRACKER_RADAR_BRANCH, 'domains') ) {
        const [ , region, file ] = p.split('/');
        if ( !regions.has(region) || file === undefined || !file.endsWith(TRACKER_RADAR_FILE_EXT) ) { continue; }
        const domain = file.slice(0, -TRACKER_RADAR_FILE_EXT.length).toLowerCase();
        if ( HOSTNAME_RE.test(domain) ) { domains.add(domain); }
    }
    if ( domains.size < MIN_TRACKER_RADAR_DOMAINS ) {
        throw new Error(`HaGeZi selection: Tracker Radar listed only ${domains.size} domains (expected ≥ ${MIN_TRACKER_RADAR_DOMAINS})`);
    }
    return domains;
}

// Every name (and each of its parents) seen as a third party on ≥ HTTP_ARCHIVE_MIN_PAGES pages in the newest snapshots.
async function readHttpArchiveNames() {
    const snapshots = listRepoPaths(HTTP_ARCHIVE_REPO, HTTP_ARCHIVE_BRANCH, HTTP_ARCHIVE_DATA_DIR)
        .map(p => path.posix.basename(p)).filter(n => HTTP_ARCHIVE_SNAPSHOT_RE.test(n)).sort().slice(-HTTP_ARCHIVE_SNAPSHOTS);
    if ( snapshots.length === 0 ) { throw new Error('HaGeZi selection: no HTTP Archive snapshot found'); }
    const names = new Set();
    for ( const snapshot of snapshots ) {
        const url = HTTP_ARCHIVE_RAW_BASE + snapshot;
        const rows = await withRetry(`HTTP Archive ${snapshot}`, async signal => (await fetchWithTimeout(url, signal)).json());
        if ( !Array.isArray(rows) || rows.length < MIN_SNAPSHOT_ROWS ) {
            throw new Error(`HaGeZi selection: ${snapshot} has ${Array.isArray(rows) ? rows.length : 0} rows (expected ≥ ${MIN_SNAPSHOT_ROWS})`);
        }
        for ( const row of rows ) {
            if ( typeof row?.domain !== 'string' || !(row.totalOccurrences >= HTTP_ARCHIVE_MIN_PAGES) ) { continue; }
            for ( const name of selfAndParents(row.domain.toLowerCase()) ) { names.add(name); }
        }
    }
    process.stdout.write(`(HTTP Archive ${snapshots.map(s => s.slice(0, SNAPSHOT_LABEL_LENGTH)).join(', ')}) `);
    return names;
}

// HaGeZi light entries whose domain (or a parent of it) is one of the owner's top-25 adult sites — e.g.
// "ads.pornhub.com" — independent of TRACKER_RADAR/TOP_SITES/HTTP_ARCHIVE evidence and of whether
// ruleset_hagezi_light itself ships them. Reuses keepHageziEntry()'s own ADULT_SITES branch (C21: one
// definition of "is this an adult-site host" for HaGeZi data, not a second one). `lines` is raw
// buildWorryFreeLists(HAGEZI_LIGHT_SOURCE) output, same shape buildSelectedHageziLightText() parses.
// 10.6.1: used by adult-site-rules.mjs to also ship these in the always-on annoyances list, so the
// protection applies even when ruleset_hagezi_light itself is disabled — reverses that file's earlier
// "HaGeZi hosts NOT copied in" decision.
export function hageziAdultSiteEntries(lines) {
    const evidence = { trackerRadar: null, topSiteRanks: null, adultSites: new Set(ADULT_SITE_DOMAINS), httpArchive: null };
    const kept = [];
    for ( const line of lines ) {
        const m = ENTRY_LINE_RE.exec(line);
        if ( m === null ) { continue; }
        if ( keepHageziEntry(m[1], evidence) !== null ) { kept.push(line); }
    }
    return kept;
}

/******************************************************************************/
// Build entry point (ruleset_hagezi_light's customFetch)
/******************************************************************************/

export async function buildSelectedHageziLightText() {
    const S = HAGEZI_SELECTION_SOURCES;
    const lines = (await buildWorryFreeLists(HAGEZI_LIGHT_SOURCE)).split('\n').filter(Boolean);
    if ( lines.length < MIN_HAGEZI_ENTRIES ) {
        throw new Error(`HaGeZi selection: HaGeZi light gave only ${lines.length} entries (expected ≥ ${MIN_HAGEZI_ENTRIES})`);
    }
    let evidence = {
        trackerRadar: S.TRACKER_RADAR ? readTrackerRadarDomains() : null,
        topSiteRanks: S.TOP_SITES ? topSiteRanksOf(topSitesSet) : null,
        adultSites:   S.ADULT_SITES ? new Set(ADULT_SITE_DOMAINS) : null,
        httpArchive:  S.HTTP_ARCHIVE ? await readHttpArchiveNames() : null,
    };
    if ( S.TOP_SITES && evidence.topSiteRanks === null ) {
        throw new Error('HaGeZi selection: CrUX ranks missing — fetchTopSitesSet() must run before the lists');
    }
    const kept = [];
    const keptBy = Object.fromEntries(Object.keys(S).map(k => [ k, 0 ]));
    for ( const line of lines ) {
        const m = ENTRY_LINE_RE.exec(line);
        if ( m === null ) { throw new Error(`HaGeZi selection: unexpected line from buildWorryFreeLists(): ${JSON.stringify(line.slice(0, 120))}`); }
        const source = keepHageziEntry(m[1], evidence);
        if ( source !== null ) { kept.push(line); keptBy[source] += 1; }
    }
    evidence = null;   // GUARD: release the source sets (≈ 1M names) before the list is parsed
    if ( kept.length < MIN_KEPT_ENTRIES ) {
        throw new Error(`HaGeZi selection: only ${kept.length} entries kept (expected ≥ ${MIN_KEPT_ENTRIES})`);
    }
    process.stdout.write(`(selection: kept ${kept.length} of ${lines.length} — ` +
        Object.entries(keptBy).map(([ k, n ]) => `${k} ${n}`).join(', ') + ') ');
    return kept.join('\n');
}
