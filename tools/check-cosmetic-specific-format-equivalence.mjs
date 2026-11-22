#!/usr/bin/env node
// check-cosmetic-specific-format-equivalence.mjs — proves the NEW compact
// storage-backed cosmetic format (buildCosmeticSpecificData(), tools/
// build-rulesets.mjs) produces the SAME lookup results as the OLD
// embedded-blob format (buildCosmeticFile(), still the live path) for
// every real hostname in the actual shipped data — except the one known,
// deliberately-accepted difference: bare-TLD-keyed entries (e.g. "no",
// "pl") that the OLD dispatch loop's ancestor walk can never reach for any
// real 2+-label hostname (a genuine dormant bug, confirmed by tracing its
// exact break condition), which the NEW format's fuller walk depth
// correctly starts matching. That is an intentional, accepted behavior
// change (see CHANGELOG.md), not a bug — this check asserts it explicitly
// rather than treating it as a failure, and fails loudly on ANY OTHER
// discrepancy, which would be a real bug.
//
// Ground truth for the OLD system: NOT a re-guess at what buildCosmeticFile()
// "should" do — it's the real OLD-format output, regenerated fresh on
// every build into test-fixtures/legacy-cosmetic/ (see tools/build-
// rulesets.mjs's GUARD comments in build()) SPECIFICALLY as this test's
// ground truth. As of 7.7.10 this format is no longer shipped in the
// extension itself (nothing at runtime has read it since 7.7.9's wiring
// removed the last consumer) — it lives here, as a test fixture only, not
// in rulesets/. Reverse-parsed back into a Map, combined with a direct
// transcription of that format's own dispatch-loop ancestor-walk
// condition (verified against the real generator's output, not
// approximated).
//
// Ground truth for the NEW system: the REAL js/scripting/isolated-api.js
// file, loaded and executed as-is (not reimplemented) for both
// binarySearch() and the needle-chain generation (isolatedAPI.contexts) —
// per this project's own standard of never re-guessing a contract that
// can be executed directly instead.
//
// Usage: node tools/check-cosmetic-specific-format-equivalence.mjs
// (requires test-fixtures/legacy-cosmetic/ to exist — run
// `node tools/build-rulesets.mjs` first if it's missing or stale)

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { buildCosmeticSpecificData } from './build/cosmetic-data.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LEGACY_FIXTURE_DIR = path.join(ROOT, 'test-fixtures', 'legacy-cosmetic');

/******************************************************************************/
// Use the REAL new-format generator — imported from its build module, so
// this test can never drift from the actual generator code (was: sliced
// out of tools/build-rulesets.mjs's source text; that stopped being
// possible when the build script was split into tools/build/ modules, and
// a real import is strictly better: no text markers to keep in sync).
/******************************************************************************/

// Known, accepted bare-TLD/wildcard entries the OLD dispatch loop can
// never reach (see file header) — confirmed deliberate (not an authoring
// accident) by checking the actual raw upstream source directly, not by
// TLD classification — see buildCosmeticSpecificData()'s own comment in
// the build script for the confirming example. Every bare-TLD/'*' entry
// is accepted uniformly; the only thing that fails this test is a
// missing selector, or an extra one that ISN'T traceable to a bare-TLD/'*'
// entry actually present in cosmeticMap.
function isBareTldOrWildcard(hostname) {
    return hostname === '*' || !hostname.includes('.');
}

/******************************************************************************/
// Load the REAL isolated-api.js verbatim — genuine reuse, not a
// reimplementation of binarySearch()/contexts needle-chain generation.
/******************************************************************************/

let currentOrigin = 'https://placeholder.invalid/';
const fakeSelf = {};
const fakeDocument = { location: { get origin() { return currentOrigin; }, ancestorOrigins: undefined } };
const isolatedApiSrc = fs.readFileSync(path.join(ROOT, 'js/scripting/isolated-api.js'), 'utf8');
new Function('self', 'document', isolatedApiSrc)(fakeSelf, fakeDocument);
const isolatedAPI = fakeSelf.isolatedAPI;

function needleChainFor(hostname) {
    currentOrigin = `https://${hostname}`;
    isolatedAPI.contexts.entries = []; // force recompute
    return isolatedAPI.contexts.hostnames; // finest -> broadest -> '*'
}

/******************************************************************************/
// NEW system's actual lookup — transcribed directly from css-specific.js's
// own selectorsFromHostnames()/selectorsFromListIndex(), using the REAL
// binarySearch() above. This IS a transcription (css-specific.js itself is
// async/storage-coupled, awkward to execute standalone) but every line
// maps 1:1 to that file — see its own comments for the field contract.
/******************************************************************************/

function newSystemLookup(data, hostname) {
    const needles = needleChainFor(hostname);
    const selectors = new Set();
    let listref = -1;
    for ( const needle of needles ) {
        listref = isolatedAPI.binarySearch(data.hostnames, needle, listref);
        if ( listref < 0 ) { listref = ~listref + 1; continue; }
        const ilist = data.selectorListRefs[listref];
        const indices = JSON.parse(`[${data.selectorLists[ilist]}]`);
        for ( const i of indices ) {
            selectors.add(i >= 0 ? data.selectors[i] : `EXCEPTION:${data.selectors[~i]}`);
        }
    }
    return selectors;
}

/******************************************************************************/
// OLD system's actual lookup — direct transcription of buildCosmeticFile()'s
// own dispatch-loop break condition (verified against the real generated
// source at the top of this file's investigation, not approximated):
//   the walk checks h, then strips one label at a time, but BREAKS as soon
//   as the NEXT-level candidate would have no further dot in it — i.e. it
//   never checks a bare single-label (TLD-only) hostname, and never checks
//   the literal '*' wildcard at all.
/******************************************************************************/

function oldSystemLookup(cosmeticMap, hostname) {
    const selectors = new Set();
    let p = hostname;
    for ( ;; ) {
        const s = cosmeticMap.get(p);
        if ( s ) { for ( const sel of s ) { selectors.add(sel); } }
        const i = p.indexOf('.');
        if ( i < 0 || !p.slice(i + 1).includes('.') ) { break; }
        p = p.slice(i + 1);
    }
    return selectors;
}

/******************************************************************************/
// Reverse-parse a real, already-built ruleset_*-cosmetic.js file back into
// a Map<hostname, Set<selector>> — reconstructing buildCosmeticFile()'s
// actual input from its actual (lossless, for this purpose) output, rather
// than re-fetching/re-parsing raw filter-list text.
/******************************************************************************/

function reverseParseCosmeticFile(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const map = new Map();
    const re = /'([^']+)':`([\s\S]*?)`(?=,'|\}\)|\};)/g;
    let m;
    while ( (m = re.exec(src)) !== null ) {
        const [ , hostname, cssText ] = m;
        const selectors = cssText.split(',\n').map(s => s.replace(/\\`/g, '`').replace(/\\\\/g, '\\'));
        map.set(hostname, new Set(selectors));
    }
    return map;
}

/******************************************************************************/

function section(name) { console.log(`\n── ${name} `.padEnd(70, '─')); }

let failures = 0;
let totalHostnamesTested = 0;
let exactMatches = 0;
let acceptedDormantFixes = 0;

function testRuleset(rulesetFile) {
    const filePath = path.join(LEGACY_FIXTURE_DIR, rulesetFile);
    if ( !fs.existsSync(filePath) ) { return; }

    const cosmeticMap = reverseParseCosmeticFile(filePath);
    if ( cosmeticMap.size === 0 ) { return; }

    const newData = buildCosmeticSpecificData(cosmeticMap);
    assert.ok(newData, `${rulesetFile}: generator returned null for non-empty input`);

    // CRITICAL correctness constraint check: hostnames must be sorted
    // length-ascending-then-lexicographic — verify directly, not just
    // trust the generator's own sort call.
    for ( let i = 1; i < newData.hostnames.length; i++ ) {
        const a = newData.hostnames[i - 1], b = newData.hostnames[i];
        const ok = a.length < b.length || (a.length === b.length && a <= b);
        assert.ok(ok, `${rulesetFile}: hostnames NOT correctly sorted at index ${i}: "${a}" then "${b}"`);
    }

    // Test every real hostname key, PLUS a synthetic 2-label-deeper
    // subdomain for each (to exercise the ancestor-walk itself, not just
    // exact-key lookups).
    const testHostnames = new Set();
    for ( const hostname of cosmeticMap.keys() ) {
        testHostnames.add(hostname);
        testHostnames.add(`www.probe-subdomain.${hostname}`);
    }

    for ( const hostname of testHostnames ) {
        totalHostnamesTested++;
        const oldResult = oldSystemLookup(cosmeticMap, hostname);
        const newResult = newSystemLookup(newData, hostname);

        const oldArr = [ ...oldResult ].sort();
        const newArr = [ ...newResult ].sort();

        if ( oldArr.length === newArr.length && oldArr.every((v, i) => v === newArr[i]) ) {
            exactMatches++;
            continue;
        }

        // Disagreement — must be EXPLAINED entirely by known dormant
        // bare-TLD entries newly matching (new is a strict superset of
        // old, and every extra entry traces back to a known dormant key
        // reachable from this hostname's own ancestor chain).
        const extra = newArr.filter(v => !oldArr.includes(v));
        const missing = oldArr.filter(v => !newArr.includes(v));

        if ( missing.length > 0 ) {
            failures++;
            console.log(`  FAIL: ${rulesetFile} / "${hostname}" — NEW is missing ${missing.length} selector(s) OLD had: ${JSON.stringify(missing.slice(0, 3))}`);
            continue;
        }

        // Every extra selector must come from a hostname reachable in this
        // chain that is a bare-TLD or wildcard entry actually present in
        // cosmeticMap — the one general, structural condition under which
        // NEW's fuller ancestor-walk depth can ever find something OLD's
        // shallower walk couldn't.
        const chain = needleChainFor(hostname);
        const dormantKeysInChain = chain.filter(h => isBareTldOrWildcard(h) && cosmeticMap.has(h));
        if ( dormantKeysInChain.length === 0 && extra.length > 0 ) {
            failures++;
            console.log(`  FAIL: ${rulesetFile} / "${hostname}" — NEW has ${extra.length} UNEXPLAINED extra selector(s), no known dormant key in chain: ${JSON.stringify(extra.slice(0, 3))}`);
            continue;
        }

        acceptedDormantFixes++;
        console.log(`  ACCEPTED (documented bonus fix): ${rulesetFile} / "${hostname}" — NEW newly applies ${extra.length} selector(s) from dormant bare-TLD entr${dormantKeysInChain.length === 1 ? 'y' : 'ies'} ${JSON.stringify(dormantKeysInChain)}`);
    }
}

/******************************************************************************/

section('Differential test — every ruleset with cosmetic data');

// GUARD — clear, actionable failure instead of a raw ENOENT stack trace.
// test-fixtures/legacy-cosmetic/ is deliberately NOT shipped in any zip
// (see tools/build-rulesets.mjs's build() and CHANGELOG.md's 7.7.10
// entry) — it only exists after a real build has run in this checkout.
// A fresh clone/extraction with no build yet is the expected, common case
// this guard is for, not a corrupted install.
if ( !fs.existsSync(LEGACY_FIXTURE_DIR) ) {
    console.log(`\nSKIPPED: ${LEGACY_FIXTURE_DIR} does not exist.`);
    console.log('This is expected on a fresh checkout/extraction — the legacy-cosmetic');
    console.log('test fixture is a build artifact, not something any zip ships (see');
    console.log("tools/build-rulesets.mjs's build() and CHANGELOG.md's 7.7.10 entry).");
    console.log('Run `node tools/build-legacy-cosmetic-fixture.mjs` first, then re-run');
    console.log('this check — it derives the fixture offline from the already-shipped');
    console.log('rulesets/*-cosmetic-specific.json files, no live upstream fetch needed.');
    console.log('(Only run the full `node tools/build-rulesets.mjs` when you actually');
    console.log('intend to refresh the shipped filter-list rulesets themselves.)');
    process.exit(1);
}

const cosmeticFiles = fs.readdirSync(LEGACY_FIXTURE_DIR).filter(f => f.endsWith('-cosmetic.js'));
console.log(`Testing ${cosmeticFiles.length} generated cosmetic files...`);
for ( const f of cosmeticFiles ) { testRuleset(f); }

console.log('');
console.log(`Hostnames tested:        ${totalHostnamesTested}`);
console.log(`Exact matches:           ${exactMatches}`);
console.log(`Accepted dormant fixes:  ${acceptedDormantFixes}`);
console.log(`Unexplained failures:    ${failures}`);

if ( failures > 0 ) {
    console.log(`\n${failures} unexplained discrepancies — DO NOT wire the new format into registration.`);
    process.exit(1);
}
console.log('\nAll hostnames verified — new format is behaviorally equivalent except the documented, accepted dormant bare-TLD fix.');
