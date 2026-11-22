// tools/test-hagezi-light-selection.mjs — HaGeZi Multi light selection (10.5.5, HARD check).
//
// Exercises the REAL keepHageziEntry() (tools/build/hagezi-light-selection.mjs) and the REAL CrUX rank walk
// (isTopRankedHostname(), tools/build/crux-top-sites.mjs) — no re-implementation (Part D step 15):
//   - each source keeps what it vouches for and nothing else; a switched-off source (null) keeps nothing;
//   - matching is on '.' only: `next-whatsapp.com` is NOT kept on `whatsapp.com`'s evidence (the TOP-N quirk);
//   - Tracker Radar / adult / top sites match the entry or a PARENT; HTTP Archive the entry or a SUBDOMAIN;
//   - the top-sites rank cut-off holds (a site in the 500K bucket does not count).
// Also checks the wiring: ruleset_hagezi_light's customFetch IS the selection (an unwired selection protects nothing).
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== HaGeZi Multi light selection — sources, label boundaries, rank cut-off, wiring ===');

let keepHageziEntry, buildSelectedHageziLightText, hageziAdultSiteEntries, isTopRankedHostname, FILTER_LISTS, buildTop25AdultSiteRulesText;
try {
    ({ keepHageziEntry, buildSelectedHageziLightText, hageziAdultSiteEntries } = await import(path.join(ROOT, 'tools/build/hagezi-light-selection.mjs')));
    ({ isTopRankedHostname } = await import(path.join(ROOT, 'tools/build/crux-top-sites.mjs')));
    ({ FILTER_LISTS } = await import(path.join(ROOT, 'tools/build/filter-lists.mjs')));
    ({ buildTop25AdultSiteRulesText } = await import(path.join(ROOT, 'tools/build/adult-site-rules.mjs')));
} catch (err) {
    console.log(`DID NOT RUN: cannot import the selection modules (${err.message})`);
    process.exit(1);
}

// Rank buckets as CrUX publishes them.
const RANK_IN = 100_000;
const RANK_OUT = 500_000;

const evidence = {
    trackerRadar: new Set([ 'doubleclick.net', 'whatsapp.com' ]),
    topSiteRanks: new Map([ [ 'example.com', RANK_IN ], [ 'lesser.org', RANK_OUT ] ]),
    adultSites:   new Set([ 'pornhub.com' ]),
    // HTTP Archive set = every observed name AND its parents (as readHttpArchiveNames() builds it).
    httpArchive:  new Set([ 'x.cdn.tracker.io', 'cdn.tracker.io', 'tracker.io', 'io' ]),
};
const OFF = { trackerRadar: null, topSiteRanks: null, adultSites: null, httpArchive: null };

// [ label, domain, evidence, expected source or null ]
const CASES = [
    [ 'Tracker Radar: the domain itself',             'doubleclick.net',          evidence, 'TRACKER_RADAR' ],
    [ 'Tracker Radar: a subdomain of a listed domain', 'stats.g.doubleclick.net', evidence, 'TRACKER_RADAR' ],
    [ "'-' is no boundary (next-whatsapp.com)",        'next-whatsapp.com',       evidence, null ],
    [ 'top sites: tracking host of a 100K site',       'metrics.example.com',     evidence, 'TOP_SITES' ],
    [ 'top sites: a 500K site does not count',         'metrics.lesser.org',      evidence, null ],
    [ 'adult top 25: host on the site',                'ads.pornhub.com',         evidence, 'ADULT_SITES' ],
    [ 'HTTP Archive: a subdomain was observed',        'cdn.tracker.io',          evidence, 'HTTP_ARCHIVE' ],
    [ 'HTTP Archive: only a parent was observed',      'y.x.cdn.tracker.io',      evidence, null ],
    [ 'no source vouches',                             'unknown-telemetry.com',   evidence, null ],
    [ 'every source switched off keeps nothing',       'doubleclick.net',         OFF,      null ],
];

let failures = 0;
for ( const [ label, domain, ev, expected ] of CASES ) {
    const got = keepHageziEntry(domain, ev);
    const ok = got === expected;
    if ( !ok ) { failures += 1; }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${expected}, got ${got}`}`);
}

// The rank walk stops at two labels: a bare TLD entry never counts as a top site.
const tldRanks = new Map([ [ 'com', 1 ] ]);
const tldOk = isTopRankedHostname('a.b.com', tldRanks, RANK_IN) === false;
if ( !tldOk ) { failures += 1; }
console.log(`  ${tldOk ? 'PASS' : 'FAIL'}  rank walk stops at two labels (a bare TLD is never a top site)`);

// Wiring: the shipped ruleset's customFetch is the selection.
const entry = FILTER_LISTS.find(l => l.id === 'ruleset_hagezi_light');
const wired = entry !== undefined && entry.customFetch === buildSelectedHageziLightText;
if ( !wired ) { failures += 1; }
console.log(`  ${wired ? 'PASS' : 'FAIL'}  ruleset_hagezi_light's customFetch is buildSelectedHageziLightText`);

// ── hageziAdultSiteEntries() (10.6.1) — real exported function, same raw-line shape
// buildSelectedHageziLightText() itself parses (Part D step 15: no reimplementation). ──
const HAGEZI_LINES = [
    '||ads.pornhub.com^',                 // subdomain of an adult site -> kept
    '||pornhub.com^$third-party',         // the adult site's own domain, third-party form -> kept
    '||doubleclick.net^',                 // not an adult-site host -> dropped
    '||next-whatsapp.com^',               // '-' is not a label boundary either, here -> dropped
    'not a valid entry line',             // ENTRY_LINE_RE mismatch -> silently skipped, not thrown
];
const adultHageziLines = hageziAdultSiteEntries(HAGEZI_LINES);
const adultHageziOk =
    adultHageziLines.includes('||ads.pornhub.com^') &&
    adultHageziLines.includes('||pornhub.com^$third-party') &&
    !adultHageziLines.includes('||doubleclick.net^') &&
    !adultHageziLines.includes('||next-whatsapp.com^') &&
    adultHageziLines.length === 2;
if ( !adultHageziOk ) { failures += 1; }
console.log(`  ${adultHageziOk ? 'PASS' : 'FAIL'}  hageziAdultSiteEntries() keeps only adult-site hosts, ignores unparseable lines — got ${JSON.stringify(adultHageziLines)}`);

// Wiring: the always-on annoyances build actually calls hageziAdultSiteEntries() and ships what it returns
// (real network fetch — HaGeZi's live light.txt — same as every other source in this file already does).
let annoyancesText, annoyancesFetchErr = null;
try {
    annoyancesText = await buildTop25AdultSiteRulesText();
} catch (err) {
    annoyancesFetchErr = err;
}
const annoyancesWired = annoyancesFetchErr === null &&
    typeof annoyancesText === 'string' &&
    annoyancesText.includes('HaGeZi Multi light hosts');
if ( !annoyancesWired ) { failures += 1; }
console.log(`  ${annoyancesWired ? 'PASS' : 'FAIL'}  buildTop25AdultSiteRulesText() includes the HaGeZi source banner${annoyancesFetchErr ? ` — threw: ${annoyancesFetchErr.message}` : ''}`);

console.log(failures === 0 ? 'PASS: HaGeZi Multi light selection' : `FINDINGS: ${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
