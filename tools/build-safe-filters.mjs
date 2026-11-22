#!/usr/bin/env node
/*******************************************************************************

    uBlock-Stripped-Dynamic — SAFE filter update (Chrome Web Store skip-review)
    Run from the repo root:
        node tools/build-safe-filters.mjs --baseline <last-published-extension.zip> [<listId> ...]
    Example (every safe filter list at once — the normal case):
        node tools/build-safe-filters.mjs --baseline dist/uBlock-Stripped-Dynamic-10.2.0-extension.zip

    WHAT A "SAFE filter update" IS IN THIS PROJECT (owner's rule, 10.2.0) — read this before asking for one,
    or before answering a request for one:

      Only the SAFE filter rulesets change; everything else in the extension stays BYTE-FOR-BYTE the last
      published version. "Safe filter ruleset" = a declared rule_resources file holding only safe rules
      (block, allow, allowAllRequests, upgradeScheme — tools/build/safe-update-rules.mjs). Unsafe rules live
      in their own companion rulesets (js/data/ruleset-companions.js UNSAFE_RULE_COMPANIONS), so they never
      block a safe refresh; those companions, every scriptlet / hide-rule file, ruleset-details.json, the
      generated files and all code stay the published version — they need a normal release.

    Chrome's skip-review conditions (developer.chrome.com/docs/webstore/skip-review), all required:
      1. the only changed files are declared in manifest.json declarative_net_request.rule_resources;
      2. every added/changed/removed rule in them is a safe rule;
      3. no ruleset added or removed;
      4. nothing else changed (the manifest only in "version").

    How (each step guards the next):
      1. Extract the baseline zip (the LAST PUBLISHED extension package) — the reference, not the working
         tree. Released in `finally`.
      2. GUARD: the working tree's code must BE the published code. Every baseline file outside the build's
         output folders must be identical here; otherwise there is unreleased work, which a SAFE update
         cannot ship (and must not overwrite) — abort, change nothing.
      3. Run the REAL, full build (tools/build-rulesets.mjs), unmodified — lists feed each other (AdGuard
         Base's side effects feed later lists), so skipping lists mid-run could silently corrupt output.
      4. Choose the rulesets to ship: every baseline rule_resources entry (or only the named ids) that is
         not an unsafe-rule companion and whose new file has only safe rules.
      5. Write the shipped tree: every baseline file back to its baseline bytes (manifest.json included —
         the version bump is the next, separate step), except the chosen rulesets, which keep their new
         content. Files the build added that the baseline lacks are removed (no ruleset may be added).
      6. Report: rulesets updated, unchanged, and what was LEFT OUT (unsafe companions and a list's own
         scriptlet / hide-rule files that changed — tools/build/safe-update-report.mjs).
      7. Record the baseline for packaging (SAFE_MARKER_FILE): tools/package-release.mjs then runs
         tools/verify-safe-update.mjs against it right after zipping the extension, and fails the release
         if the package does not qualify. Proven, not assumed.

    Next steps printed at the end: bump the version (manifest.json), `npm run check`, `npm run package`.

    Resources: one temporary extraction folder (released in `finally`); no other state is kept.

*******************************************************************************/

import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isSafeRule } from './build/safe-update-rules.mjs';
import { findLeftOutFiles, describeLeftOutFile, formatLeftOutReport } from './build/safe-update-report.mjs';
import { ALL_UNSAFE_COMPANION_PAIRS } from '../js/data/ruleset-companions.js';

// ── Configuration (the only place these live) ───────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_FILE   = 'manifest.json';
const RULESETS_DIR    = 'rulesets';
// Folders the real build rewrites. Their baseline files may differ in the working tree before the build
// (an earlier normal build), so they are not part of the "is this the published code?" guard (step 2) — they
// are restored from the baseline anyway in step 5.
const BUILD_OUTPUT_DIRS = Object.freeze([ 'rulesets/', 'js/generated/', 'js/resources/' ]);
// Written for tools/package-release.mjs (step 7). In dist/, which never ships.
const SAFE_MARKER_FILE = path.join(ROOT, 'dist', '.safe-update-baseline.json');
const TEMP_DIR_PREFIX  = 'safe-filters-baseline-';
const UNZIP_COMMAND    = 'unzip';
const UNSAFE_COMPANION_IDS = new Set(ALL_UNSAFE_COMPANION_PAIRS.map(([ , companion ]) => companion));   // (10.7.6) both companion maps

// ── Resource guard: the temp folder is tracked and always released ───────────
const workDirs = [];
function releaseWorkDirs() {
    while ( workDirs.length > 0 ) { fs.rmSync(workDirs.pop(), { recursive: true, force: true }); }
}
function fail(message) {
    releaseWorkDirs();   // process.exit() skips `finally`
    console.error(`\nABORTED — ${message}\nNothing was changed.`);
    process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function listFiles(dir) {
    const out = [];
    (function walk(current) {
        for ( const entry of fs.readdirSync(current, { withFileTypes: true }) ) {
            const full = path.join(current, entry.name);
            if ( entry.isDirectory() ) { walk(full); } else { out.push(path.relative(dir, full).split(path.sep).join('/')); }
        }
    })(dir);
    return out.sort();
}

function extractBaseline(zipPath) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    workDirs.push(root);
    try { execFileSync(UNZIP_COMMAND, [ '-q', zipPath, '-d', root ], { stdio: 'pipe' }); } catch (err) { fail(`cannot extract ${zipPath} (${err.message})`); }
    // The package extracts into ONE plain folder (C27).
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory());
    if ( entries.length !== 1 ) { fail(`${zipPath} does not extract into exactly one folder`); }
    const dir = path.join(root, entries[0].name);
    if ( !fs.existsSync(path.join(dir, MANIFEST_FILE)) ) { fail(`${zipPath} has no ${MANIFEST_FILE} — not an extension package`); }
    return dir;
}

function isBuildOutput(rel) {
    return BUILD_OUTPUT_DIRS.some(prefix => rel.startsWith(prefix));
}

function readRules(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function snapshotRulesetsDir(dir) {
    const snap = new Map();
    const full = path.join(dir, RULESETS_DIR);
    if ( !fs.existsSync(full) ) { return snap; }
    for ( const name of fs.readdirSync(full) ) { snap.set(name, fs.readFileSync(path.join(full, name), 'utf8')); }
    return snap;
}

// Step 5: every baseline file back to its published bytes except `keep` (the chosen rulesets); build-only files
// in the build output folders that the baseline lacks are removed (a SAFE update may not add a file).
function restoreBaselineBytes(baseDir, baseFiles, keep) {
    let restored = 0, removed = 0;
    for ( const rel of baseFiles ) {
        if ( keep.has(rel) ) { continue; }
        const here = path.join(ROOT, rel);
        const want = fs.readFileSync(path.join(baseDir, rel));
        if ( fs.existsSync(here) && fs.readFileSync(here).equals(want) ) { continue; }
        fs.mkdirSync(path.dirname(here), { recursive: true });
        fs.writeFileSync(here, want);
        restored++;
    }
    const baseSet = new Set(baseFiles);
    for ( const dir of BUILD_OUTPUT_DIRS ) {
        const full = path.join(ROOT, dir);
        if ( !fs.existsSync(full) ) { continue; }
        for ( const rel of listFiles(full).map(f => dir + f) ) {
            if ( !baseSet.has(rel) ) { fs.rmSync(path.join(ROOT, rel)); removed++; }
        }
    }
    return { restored, removed };
}

// ── Main ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const ids = [];
    let baseline = null;
    for ( let i = 0; i < argv.length; i++ ) {
        if ( argv[i] === '--baseline' ) { baseline = argv[++i] ?? null; continue; }
        ids.push(argv[i]);
    }
    return { baseline, requestedIds: new Set(ids) };
}

function main() {
    const { baseline, requestedIds } = parseArgs(process.argv.slice(2));
    if ( !baseline ) { fail('usage: node tools/build-safe-filters.mjs --baseline <last-published-extension.zip> [<listId> ...]'); }
    if ( !fs.existsSync(baseline) ) { fail(`baseline not found: ${baseline}`); }

    // 1 — the reference
    const baseDir = extractBaseline(path.resolve(baseline));
    const baseManifest = JSON.parse(fs.readFileSync(path.join(baseDir, MANIFEST_FILE), 'utf8'));
    const baseFiles = listFiles(baseDir);
    console.log(`SAFE filter update against the published ${baseManifest.version} (${baseFiles.length} files).`);

    // 2 — GUARD: the working tree's code is the published code
    const drift = baseFiles.filter(rel => rel !== MANIFEST_FILE && !isBuildOutput(rel)).filter(rel => {
        const here = path.join(ROOT, rel);
        return !fs.existsSync(here) || !fs.readFileSync(here).equals(fs.readFileSync(path.join(baseDir, rel)));
    });
    if ( drift.length > 0 ) {
        fail(`the working tree is not the published ${baseManifest.version} code — ${drift.length} file(s) differ, e.g. ` +
             `${drift.slice(0, 5).join(', ')}. A SAFE update ships the published code unchanged; release this work normally first.`);
    }

    // 3 — the real build
    const preBuildRulesets = snapshotRulesetsDir(baseDir);
    console.log('\nRunning the real build (fetches everything, exactly as normal)...\n');
    execFileSync(process.execPath, [ path.join(ROOT, 'tools', 'build-rulesets.mjs') ], { cwd: ROOT, stdio: 'inherit' });
    const postBuildRulesets = snapshotRulesetsDir(ROOT);

    // 4 — choose the rulesets to ship
    const declared = baseManifest.declarative_net_request?.rule_resources ?? [];
    const updated = [], unchanged = [], notSafe = [], leftOutCompanions = [];
    const shipPaths = new Set();
    for ( const res of declared ) {
        if ( requestedIds.size > 0 && !requestedIds.has(res.id) ) { continue; }
        const rel = res.path.replace(/^\//, '');
        const fresh = readRules(path.join(ROOT, rel));
        if ( UNSAFE_COMPANION_IDS.has(res.id) ) {
            if ( fresh !== null && fs.existsSync(path.join(baseDir, rel)) && fs.readFileSync(path.join(ROOT, rel), 'utf8') !== fs.readFileSync(path.join(baseDir, rel), 'utf8') ) {
                leftOutCompanions.push(res.id);
            }
            continue;
        }
        if ( fresh === null ) { notSafe.push(`${res.id} (not produced by this build)`); continue; }
        const unsafe = fresh.filter(r => !isSafeRule(r));
        if ( unsafe.length > 0 ) { notSafe.push(`${res.id} (${unsafe.length} unsafe rule(s) — project-own header rules)`); continue; }
        const same = fs.readFileSync(path.join(ROOT, rel)).equals(fs.readFileSync(path.join(baseDir, rel)));
        if ( same ) { unchanged.push(res.id); continue; }
        updated.push(res.id);
        shipPaths.add(rel);
    }
    for ( const id of requestedIds ) {
        if ( !declared.some(r => r.id === id) ) { fail(`${id} is not a ruleset of the published ${baseManifest.version} — a SAFE update cannot add one`); }
    }

    // 6a — what this build compiled besides rule files, per updated list (reported, never shipped)
    const leftOutItems = [];
    for ( const id of updated ) {
        const names = findLeftOutFiles(id, preBuildRulesets, postBuildRulesets);
        if ( names.length > 0 ) {
            leftOutItems.push({ id, descriptions: names.map(n => describeLeftOutFile(n, postBuildRulesets.get(n))) });
        }
    }

    // 5 — write the shipped tree: baseline bytes everywhere except the chosen rulesets
    const { restored, removed } = restoreBaselineBytes(baseDir, baseFiles, shipPaths);

    // 7 — the baseline packaging verifies against
    fs.mkdirSync(path.dirname(SAFE_MARKER_FILE), { recursive: true });
    fs.writeFileSync(SAFE_MARKER_FILE, JSON.stringify({ baselineZip: path.resolve(baseline), baselineVersion: baseManifest.version, updated }, null, 2) + '\n');

    // 6b — report
    console.log('\n=== SAFE filter update ===');
    console.log(`Updated (${updated.length}): ${updated.join(', ') || 'none — every safe ruleset is already current'}`);
    console.log(`Unchanged (${unchanged.length}): ${unchanged.join(', ') || 'none'}`);
    if ( notSafe.length > 0 ) { console.log(`Not eligible (${notSafe.length}): ${notSafe.join('; ')}`); }
    if ( leftOutCompanions.length > 0 ) {
        console.log(`\nNOT INCLUDED — unsafe-rule companions that changed (need a normal release): ${leftOutCompanions.join(', ')}`);
    }
    const report = formatLeftOutReport(leftOutItems);
    if ( report !== '' ) { console.log(report); }
    console.log(`\n${restored} file(s) set back to the published ${baseManifest.version} bytes, ${removed} build-only file(s) removed.`);
    console.log('Next: bump the version in manifest.json, then `npm run check` and `npm run package` —');
    console.log(`packaging verifies the extension zip against ${path.basename(baseline)} and refuses it if it does not qualify.`);
}

try {
    main();
} finally {
    releaseWorkDirs();
}
