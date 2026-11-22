#!/usr/bin/env node
// ── build-tracker-radar.mjs ─────────────────────────────────────────────
// Regenerates js/data/tracker-radar-data.json from a local checkout of
// https://github.com/duckduckgo/tracker-radar (CC BY-NC-SA 4.0 — see
// THIRD_PARTY_LICENSES.md for the full attribution this build produces).
//
// NOTE ON PROVENANCE: this project's original build-tracker-radar.mjs
// (the one that produced the historically-documented 2,082-domain /
// 712-entity output) was not recovered — only that output's own header
// comment survived, documenting its parameters (9 regions, 0.1% cutoff).
// This is a fresh script reproducing that documented behavior against
// the real repo layout, not a restoration of the original file's actual
// code — see CHANGELOG for this distinction when this was rebuilt.
//
// Meant to be re-run on a recurring (e.g. biweekly) schedule against a
// FRESH checkout — this script does not fetch the checkout itself.
// Verified repo layout (checked directly against a real checkout, not
// assumed): domains live under domains/<REGION>/<domain>.json, one file
// per domain PER REGION (the same domain can have a separate file, with
// its own region-specific `prevalence`, under each region it was
// observed in) — NOT a flat domains/*.json with a per-region object
// inside each file, as an earlier draft of this script assumed.
//
// Getting a checkout (full repo is 100MB+; a normal full clone or the
// codeload tarball both work — a git partial+sparse clone limited to
// domains/ is the lighter option if bandwidth is tight):
//   git clone https://github.com/duckduckgo/tracker-radar
//   -- or, sparse (domains/ only) --
//   git clone --filter=blob:none --no-checkout \
//     https://github.com/duckduckgo/tracker-radar.git tracker-radar
//   cd tracker-radar && git sparse-checkout init --cone
//   git sparse-checkout set domains && git checkout main
//
// Usage:
//   node tools/build-tracker-radar.mjs                 (10.2.1: downloads it itself — see below)
//   node tools/build-tracker-radar.mjs <path-to-tracker-radar-checkout>
//
// Self-download (10.2.1, `npm run update:tracker-radar`): with no path, the script makes a shallow, sparse
// clone of domains/ only into a temporary folder (about 1.5 min and ~900 MB), builds from it and ALWAYS removes
// it again (finally + exit handler). Run it with every normal release — the output, js/data/tracker-radar-data.json,
// is page data, not a rule_resources file, so it can never ride along in a SAFE (skip-review) update.
//
// Region scope: only the 9 regions DuckDuckGo crawls
// (US/GB/DE/FR/NL/NO/CH/CA/AU — see REGION_CODES below) are read at all.
//
// Prevalence cutoff: 0.1% (PREVALENCE_CUTOFF below) — a domain must reach
// this prevalence in at least one in-scope region's own file to be
// included. Where the same domain has files in multiple regions, the
// MAX prevalence across those region files is what's recorded and
// checked against the cutoff.
//
// Output shape: js/data/tracker-radar-data.json is a plain JSON object
// keyed by domain:
//   { "doubleclick.net": { owner: "Google", prevalence: 0.446,
//                           fingerprinting: 3 }, ... }
// Plain JSON, not an ES module — tracker-radar-lookup.js loads this via
// fetch()+.json() (dynamic import() is disallowed inside a service
// worker, per the HTML spec; fetch() is not). This is a simpler shape
// than the original script's documented entity-index-compacted array
// format (see the provenance note above — that internal compaction
// scheme wasn't recoverable) but carries the same information;
// tracker-radar-lookup.js reads this shape directly.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TRACKER_RADAR_BRANCH, TRACKER_RADAR_REGIONS, TRACKER_RADAR_REPO } from './build/tracker-radar-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// (10.5.5) Repo, branch and regions come from tools/build/tracker-radar-source.mjs (shared with the
// HaGeZi Multi light selection) — one place for all three.
const REGION_CODES = TRACKER_RADAR_REGIONS;

const PREVALENCE_CUTOFF = 0.001; // 0.1%

// Self-download settings (10.2.1) — the only place they live.
const TEMP_DIR_PREFIX = 'tracker-radar-';
// Plausibility floor for the OUTPUT (historically ~2 000 domains): far fewer means a broken or partial checkout,
// and the existing good file must not be overwritten (C13a).
const MIN_OUTPUT_DOMAINS = 1000;

// ── Resource guard: a temporary checkout is always released, also on process.exit() ──
let tempCheckout = null;
function releaseTempCheckout() {
    if ( tempCheckout !== null ) { fs.rmSync(tempCheckout, { recursive: true, force: true }); tempCheckout = null; }
}
process.on('exit', releaseTempCheckout);

function downloadCheckout() {
    tempCheckout = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    const dir = path.join(tempCheckout, 'tracker-radar');
    console.log(`[build-tracker-radar] downloading ${TRACKER_RADAR_REPO} (domains/ only, shallow) …`);
    function git(args, cwd) { execFileSync('git', args, { cwd, stdio: [ 'ignore', 'ignore', 'inherit' ] }); }
    git([ 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', TRACKER_RADAR_BRANCH, TRACKER_RADAR_REPO, dir ], tempCheckout);
    git([ 'sparse-checkout', 'init', '--cone' ], dir);
    git([ 'sparse-checkout', 'set', 'domains' ], dir);
    git([ 'checkout', '-q', TRACKER_RADAR_BRANCH ], dir);
    return dir;
}

const checkoutArg = process.argv[2];
const checkoutPath = checkoutArg ? path.resolve(checkoutArg) : downloadCheckout();

const domainsRoot = path.join(checkoutPath, 'domains');

if ( !fs.existsSync(domainsRoot) ) {
    console.error(`[build-tracker-radar] domains/ not found under: ${checkoutPath}`);
    console.error('[build-tracker-radar] Clone the dataset first — see this file\'s own header for the two clone options.');
    process.exit(1);
}

/******************************************************************************/

function buildDataset() {
    const out = {}; // domain -> { owner, prevalence, fingerprinting }
    let filesConsidered = 0;
    let regionsFound = 0;
    const prevalenceCurve = [];

    for ( const region of REGION_CODES ) {
        const regionDir = path.join(domainsRoot, region);
        if ( !fs.existsSync(regionDir) ) { continue; }
        regionsFound += 1;

        const files = fs.readdirSync(regionDir).filter(f => f.endsWith('.json'));
        for ( const file of files ) {
            filesConsidered += 1;
            let raw;
            try {
                raw = JSON.parse(fs.readFileSync(path.join(regionDir, file), 'utf8'));
            } catch {
                console.warn(`[build-tracker-radar] skipping unparseable file: ${region}/${file}`);
                continue;
            }

            const domain = raw.domain ?? path.basename(file, '.json');
            const prevalence = typeof raw.prevalence === 'number' ? raw.prevalence : 0;
            prevalenceCurve.push(prevalence);

            const existing = out[domain];
            if ( existing !== undefined && existing.prevalence >= prevalence ) { continue; }

            const owner = raw.owner?.displayName ?? raw.owner?.name ?? 'Unknown';
            const fingerprinting = typeof raw.fingerprinting === 'number' ? raw.fingerprinting : 0;
            out[domain] = { owner, prevalence, fingerprinting };
        }
    }

    // Apply the cutoff as a final pass, now that each domain's MAX
    // prevalence across all its region files has been resolved above.
    for ( const domain of Object.keys(out) ) {
        if ( out[domain].prevalence < PREVALENCE_CUTOFF ) { delete out[domain]; }
    }

    for ( const domain of Object.keys(out) ) {
        out[domain].prevalence = Number(out[domain].prevalence.toFixed(4));
    }

    prevalenceCurve.sort((a, b) => b - a);
    console.log(`[build-tracker-radar] regions found: ${regionsFound}/${REGION_CODES.length}`);
    console.log(`[build-tracker-radar] domain files considered: ${filesConsidered}`);
    console.log(`[build-tracker-radar] ${Object.keys(out).length} distinct domains clear the ${PREVALENCE_CUTOFF * 100}% cutoff`);
    if ( prevalenceCurve.length > 0 ) {
        console.log(`[build-tracker-radar] top prevalence seen: ${prevalenceCurve[0]?.toFixed(4)}`);
    }

    return out;
}

/******************************************************************************/

function writeDataModule(dataset) {
    const entityCount = new Set(Object.values(dataset).map(v => v.owner)).size;
    const domainCount = Object.keys(dataset).length;
    // JSON has no comment syntax, so the generation metadata that used to
    // live in a header comment inside the .js module now lives here, in
    // this script's own console output and in THIRD_PARTY_LICENSES.md
    // (kept up to date by hand on each regen) — same as scriptlet-files.json
    // and every other plain-JSON generated file in this project already do.
    console.log(`[build-tracker-radar] ${entityCount} entities / ${domainCount} domains, ${REGION_CODES.length} regions (${REGION_CODES.join('/')}), ${PREVALENCE_CUTOFF * 100}% prevalence cutoff, generated ${new Date().toISOString().slice(0, 10)}`);
    console.log(`[build-tracker-radar] update THIRD_PARTY_LICENSES.md's domain/entity counts and date to match the line above.`);
    const body = JSON.stringify(dataset, null, 4);
    const outPath = path.resolve(__dirname, '..', 'js', 'data', 'tracker-radar-data.json');
    fs.writeFileSync(outPath, body, 'utf8');
    console.log(`[build-tracker-radar] wrote ${outPath}`);
}

/******************************************************************************/

const dataset = buildDataset();
if ( Object.keys(dataset).length < MIN_OUTPUT_DOMAINS ) {
    console.error(`[build-tracker-radar] only ${Object.keys(dataset).length} domains (expected at least ${MIN_OUTPUT_DOMAINS}) — refusing to overwrite the existing dataset.`);
    process.exit(1);
}
if ( Object.keys(dataset).length === 0 ) {
    console.error('[build-tracker-radar] zero domains cleared the cutoff — refusing to write an empty dataset (see this project\'s own C13a build-time-guard convention: a fetch/build producing implausibly small output must not silently overwrite good data).');
    process.exit(1);
}
writeDataModule(dataset);

