#!/usr/bin/env node
// ── tools/build-needed-trackers.mjs ─────────────────────────────────────────────────────────────────
// (11.1.0, owner's decision 2026-11-23) Regenerates js/data/needed-trackers-data.json: third-party domains that
// track but that websites NEED, as two independent tracker databases classify them. Read by
// js/core/breakage-risk.js — such a domain gets the MEDIUM Break risk badge in the DNR tracking filter.
//
// Sources (both CC BY-NC-SA 4.0, as DuckDuckGo Tracker Radar, which this extension already ships — credited in
// THIRD_PARTY_LICENSES.md and in the DNR tracking filter's footer):
//   Disconnect tracking protection  services.json, categories NEEDED_DISCONNECT_CATEGORIES ("Content" is the list
//                                   Firefox leaves unblocked because sites need it).
//   Ghostery TrackerDB              db/patterns/*.eno, categories NEEDED_GHOSTERY_CATEGORIES (players, hosting, …).
//
// Usage: node tools/build-needed-trackers.mjs   (npm run update:needed-trackers) — downloads both itself:
// Disconnect as one JSON file, Ghostery as a shallow sparse clone of db/patterns into a temporary folder that is
// ALWAYS removed (finally). Run it with every normal release; the output is page data, not a rule_resources file.
//
// Output: { generated, sources: [ {name, url, license, categories} ], domains: { "<domain>": [<source index>, …] } }
// A domain covers its subdomains (breakage-risk.js matches it as a `||domain` anchor).
//
// Exit 0 = written, 1 = a guard failed (nothing written), 2 = could not download (nothing written).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchJsonData } from './build/fetch-helpers.mjs';

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(ROOT, 'js/data/needed-trackers-data.json');

const DISCONNECT = Object.freeze({
    name: 'Disconnect tracking protection',
    url: 'https://github.com/disconnectme/disconnect-tracking-protection',
    data: 'https://raw.githubusercontent.com/disconnectme/disconnect-tracking-protection/master/services.json',
    license: 'CC BY-NC-SA 4.0',
});
const GHOSTERY = Object.freeze({
    name: 'Ghostery TrackerDB',
    url: 'https://github.com/ghostery/trackerdb',
    repo: 'https://github.com/ghostery/trackerdb.git',
    branch: 'main',
    patternsDir: 'db/patterns',
    license: 'CC BY-NC-SA 4.0',
});
// Categories meaning "tracks, but websites need it" (owner: medium risk).
const NEEDED_DISCONNECT_CATEGORIES = Object.freeze([ 'Content', 'Anti-fraud', 'ConsentManagers' ]);
const NEEDED_GHOSTERY_CATEGORIES = Object.freeze([ 'audio_video_player', 'hosting', 'utilities', 'consent', 'customer_interaction' ]);

// Not-near-empty guards (2026-11-23: Disconnect 438 domains, Ghostery 1,054) — a smaller result means a changed
// format or a failed download, never a real shrink of this size.
const MIN_DISCONNECT_DOMAINS = 100;
const MIN_GHOSTERY_DOMAINS = 500;

const TEMP_DIR_PREFIX = 'ubd-trackerdb-';
const ENO_FILE_EXT = '.eno';
const DOMAIN_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;   // hostname shape ('_' allowed, as js/util/utils.js)
const EXIT_OK = 0, EXIT_GUARD = 1, EXIT_DOWNLOAD = 2;

// ── Parsers (pure) ────────────────────────────────────────────────────────────────────────────────
function normalizeDomain(d) {
    const h = String(d).trim().toLowerCase().replace(/^\*\./, '');
    return DOMAIN_RE.test(h) ? h : null;
}

// services.json: { categories: { <cat>: [ { <entity>: { <homepage>: [domains], <flag>: "true" } } ] } }
export function disconnectNeededDomains(services) {
    const out = new Set();
    for ( const cat of NEEDED_DISCONNECT_CATEGORIES ) {
        for ( const entity of services?.categories?.[cat] ?? [] ) {
            for ( const props of Object.values(entity ?? {}) ) {
                for ( const value of Object.values(props ?? {}) ) {
                    if ( !Array.isArray(value) ) { continue; }   // flags such as "performance": "true"
                    for ( const d of value ) { const h = normalizeDomain(d); if ( h ) { out.add(h); } }
                }
            }
        }
    }
    return out;
}

// One .eno pattern: "category: <name>" and a "--- domains" … "--- domains" block, one domain per line.
export function ghosteryPatternDomains(text) {
    const category = /^category:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '';
    if ( !NEEDED_GHOSTERY_CATEGORIES.includes(category) ) { return []; }
    const block = /^--- domains\s*$([\s\S]*?)^--- domains\s*$/m.exec(text)?.[1] ?? '';
    return block.split('\n').map(normalizeDomain).filter(Boolean);
}

// ── Downloads ─────────────────────────────────────────────────────────────────────────────────────
function readGhosteryNeededDomains() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));   // GUARD (init): own temp folder
    try {
        const checkout = path.join(temp, 'repo');
        execFileSync('git', [ 'clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', GHOSTERY.branch, GHOSTERY.repo, checkout ],
            { stdio: [ 'ignore', 'ignore', 'inherit' ] });
        execFileSync('git', [ 'sparse-checkout', 'set', GHOSTERY.patternsDir ], { cwd: checkout, stdio: [ 'ignore', 'ignore', 'inherit' ] });
        const dir = path.join(checkout, GHOSTERY.patternsDir);
        const out = new Set();
        for ( const f of fs.readdirSync(dir) ) {
            if ( !f.endsWith(ENO_FILE_EXT) ) { continue; }
            for ( const d of ghosteryPatternDomains(fs.readFileSync(path.join(dir, f), 'utf8')) ) { out.add(d); }
        }
        return out;
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });   // GUARD (release): the clone never outlives the run
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────────
async function main() {
    let disconnect, ghostery;
    try {
        disconnect = disconnectNeededDomains(await fetchJsonData(DISCONNECT.data));
        ghostery = readGhosteryNeededDomains();
    } catch (e) {
        console.error(`DOWNLOAD FAILED: ${e.message} — nothing written`);
        return EXIT_DOWNLOAD;
    }
    if ( disconnect.size < MIN_DISCONNECT_DOMAINS || ghostery.size < MIN_GHOSTERY_DOMAINS ) {
        console.error(`GUARD: too few domains (Disconnect ${disconnect.size} < ${MIN_DISCONNECT_DOMAINS} or Ghostery ${ghostery.size} < ${MIN_GHOSTERY_DOMAINS}) — nothing written`);
        return EXIT_GUARD;
    }
    const sources = [
        { name: DISCONNECT.name, url: DISCONNECT.url, license: DISCONNECT.license, categories: NEEDED_DISCONNECT_CATEGORIES },
        { name: GHOSTERY.name, url: GHOSTERY.url, license: GHOSTERY.license, categories: NEEDED_GHOSTERY_CATEGORIES },
    ];
    const domains = {};
    [ disconnect, ghostery ].forEach((set, index) => {
        for ( const d of set ) { (domains[d] ??= []).push(index); }
    });
    const sorted = Object.fromEntries(Object.keys(domains).sort().map(d => [ d, domains[d] ]));
    const out = { generated: new Date().toISOString().slice(0, 10), sources, domains: sorted };
    fs.writeFileSync(OUT_FILE, JSON.stringify(out) + '\n');
    console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}: ${Object.keys(sorted).length} domains (Disconnect ${disconnect.size}, Ghostery ${ghostery.size})`);
    return EXIT_OK;
}

if ( import.meta.url === `file://${process.argv[1]}` ) {
    process.exit(await main());
}
