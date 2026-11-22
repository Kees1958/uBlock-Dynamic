#!/usr/bin/env node
// build-legacy-cosmetic-fixture.mjs — regenerates test-fixtures/legacy-
// cosmetic/ (the OLD embedded-blob cosmetic format, kept ONLY as ground
// truth for tools/check-cosmetic-specific-format-equivalence.mjs / step 16
// of complete-check.mjs) WITHOUT touching the network and WITHOUT touching
// anything under rulesets/ or manifest.json.
//
// WHY THIS FILE EXISTS (separate from tools/build-rulesets.mjs):
// build-rulesets.mjs has exactly one job — refresh rulesets/*.json and
// manifest.json's rule_resources from LIVE upstream filter lists, i.e.
// produce the artifact Chrome's "safe filter-list update" mechanism ships.
// That live refetch must only ever run when a ruleset update is actually
// intended — never as a side effect of "just run the checks."
//
// The legacy fixture, however, does NOT need live data at all: the
// already-shipped rulesets/*-cosmetic-specific.json files are themselves
// a complete, lossless serialization of the same cosmeticMap the legacy
// format is built from (hostnames + selectorLists + selectors — see
// buildCosmeticSpecificData() in build-rulesets.mjs). So this script
// reconstructs cosmeticMap from disk, then feeds it through the REAL
// buildCosmeticFile() generator (imported, not reimplemented — this
// project's own standing rule against parallel hand-written copies that
// can silently drift from the code they're meant to test).
//
// Usage: node tools/build-legacy-cosmetic-fixture.mjs
// (safe to run any time — reads rulesets/, writes only test-fixtures/,
// never touches the network)

import fs from 'fs/promises';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

/******************************************************************************/
// Reuse the REAL buildCosmeticFile() generator — imported from its build
// module (tools/build/cosmetic-data.mjs), so this script can never silently
// drift from the actual generator. (Was: extracted by source-slicing
// build-rulesets.mjs's text; not possible after the build was split into
// modules, and a real import is strictly better — no text markers to keep
// in sync.)
/******************************************************************************/

async function importBuildCosmeticFile() {
    return (await import('./build/cosmetic-data.mjs')).buildCosmeticFile;
}

/******************************************************************************/
// Reconstruct cosmeticMap<hostname, Set<selector>> from an already-shipped
// ruleset_X-cosmetic-specific.json file — the exact inverse of
// buildCosmeticSpecificData(), and structurally identical to the
// newSystemLookup() reader in check-cosmetic-specific-format-equivalence.mjs
// (kept here as reconstruction rather than lookup, since the whole map is
// needed, not a single hostname's chain).
/******************************************************************************/

function reverseParseSpecificData(data) {
    const map = new Map();
    for ( let i = 0; i < data.hostnames.length; i++ ) {
        const hostname = data.hostnames[i];
        const ilist = data.selectorListRefs[i];
        const indices = JSON.parse(`[${data.selectorLists[ilist]}]`);
        const selectors = new Set();
        for ( const idx of indices ) {
            // Positive index = plain selector. Negative (bitwise-complement)
            // index = EXCEPTION marker — not currently emitted by the real
            // generator (see this file's own header), handled defensively
            // so this script stays correct if that ever changes.
            selectors.add(idx >= 0 ? data.selectors[idx] : `EXCEPTION:${data.selectors[~idx]}`);
        }
        map.set(hostname, selectors);
    }
    return map;
}

/******************************************************************************/
// Main
/******************************************************************************/

async function main() {
    const rulesetDir = path.join(ROOT, 'rulesets');
    const fixtureDir = path.join(ROOT, 'test-fixtures', 'legacy-cosmetic');

    const cosmeticFilesPath = path.join(rulesetDir, 'cosmetic-files.json');
    let cosmeticFiles;
    try {
        cosmeticFiles = JSON.parse(await fs.readFile(cosmeticFilesPath, 'utf8'));
    } catch (reason) {
        console.error(`Could not read ${cosmeticFilesPath}: ${reason}`);
        console.error('Nothing to derive the fixture from — run `node tools/build-rulesets.mjs` at least once first (live refetch, deliberate) to establish the shipped storage-backed data.');
        process.exitCode = 1;
        return;
    }

    const buildCosmeticFile = await importBuildCosmeticFile();

    // GUARD: init — ensure the fixture directory exists.
    await fs.mkdir(fixtureDir, { recursive: true });
    // GUARD: clear/release — wipe any stale fixture files from a prior run
    // before writing this run's, same discipline as build-rulesets.mjs's
    // own build() function (see its GUARD comments) so a ruleset removed
    // or renamed since the last shipped update never leaves an orphaned,
    // no-longer-generated fixture file behind.
    for ( const f of await fs.readdir(fixtureDir).catch(() => []) ) {
        if ( f.endsWith('-cosmetic.js') ) {
            await fs.unlink(path.join(fixtureDir, f)).catch(() => {});
        }
    }

    let written = 0;
    for ( const entry of cosmeticFiles ) {
        const dataPath = path.join(ROOT, entry.specificDataFile);
        let data;
        try {
            data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
        } catch (reason) {
            console.warn(`  SKIP ${entry.id}: could not read ${entry.specificDataFile} (${reason.code || reason.message})`);
            continue;
        }

        const cosmeticMap = reverseParseSpecificData(data);
        const cosmeticCode = buildCosmeticFile(cosmeticMap);
        if ( cosmeticCode === null ) { continue; }

        const outPath = path.join(fixtureDir, `${entry.id}-cosmetic.js`);
        await fs.writeFile(outPath, cosmeticCode, 'utf8');
        written++;
    }

    console.log(`Wrote ${written} legacy-format fixture file(s) to test-fixtures/legacy-cosmetic/`);
    console.log('(derived entirely from already-shipped rulesets/*-cosmetic-specific.json — no network access, rulesets/ and manifest.json untouched)');
}

main();
