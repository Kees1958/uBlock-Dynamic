#!/usr/bin/env node
// tools/verify-safe-update.mjs — proves a NEW extension zip qualifies for the
// Chrome Web Store skip-review ("safe update") path, compared with the zip
// that was last published.
//
// Usage:
//   node tools/verify-safe-update.mjs <previous-extension.zip> <new-extension.zip>
//
// Why this exists: tools/build-safe-filters.mjs BUILDS a safe-only update, but
// until 10.1.4 nothing checked the finished package, and the brief
// CHANGELOG.md that shipped inside the extension silently disqualified every
// release anyway. This is the missing last step. The rules it enforces are
// the ones listed in build-safe-filters.mjs's header (Chrome's skip-review
// criteria), applied to the two real zips:
//   1. No file added or removed anywhere in the package.
//   2. manifest.json differs ONLY in its "version" (which must change).
//   3. Every other changed file is a ruleset declared in the manifest's
//      declarative_net_request.rule_resources.
//   4. Every rule added, removed or changed inside those rulesets is safe
//      (tools/build/safe-update-rules.mjs).
//
// Outcomes (principle C38): PASS (exit 0) / FAIL (exit 1, with every reason) /
// DID NOT RUN (exit 1 — bad arguments, unzip missing, unreadable file).
// A check that did not run has not passed.
//
// Resources: two temporary extraction folders, always removed in `finally`.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { isSafeRule } from './build/safe-update-rules.mjs';

// ── Configuration (the only place these live) ───────────────────────────────
const MANIFEST_FILE        = 'manifest.json';
const MANIFEST_VERSION_KEY = 'version';
const TEMP_DIR_PREFIX      = 'verify-safe-update-';
const UNZIP_COMMAND        = 'unzip';
const MAX_REASONS_SHOWN    = 25;   // keep a failing report readable

console.log('=== Safe-update (skip-review) verification ===');

// ── Resource guard: every temp folder created is tracked and always released ─
const workDirs = [];
function releaseWorkDirs() {
    while ( workDirs.length > 0 ) { fs.rmSync(workDirs.pop(), { recursive: true, force: true }); }
}

// ── Small helpers ───────────────────────────────────────────────────────────
function didNotRun(reason) {
    releaseWorkDirs();   // process.exit() skips `finally`, so release here too
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

/** Every file under `dir`, as sorted POSIX-style relative paths. */
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

/** Extract a zip; return the folder that holds the package files (the single
 *  top-level folder when the zip has one, otherwise the extraction root). */
function extractZip(zipPath, intoDir) {
    try {
        execFileSync(UNZIP_COMMAND, [ '-q', zipPath, '-d', intoDir ], { stdio: 'pipe' });
    } catch (err) {
        didNotRun(`cannot extract ${zipPath} (${err.code === 'ENOENT' ? `${UNZIP_COMMAND} not installed` : err.message})`);
    }
    const entries = fs.readdirSync(intoDir, { withFileTypes: true });
    return entries.length === 1 && entries[0].isDirectory() ? path.join(intoDir, entries[0].name) : intoDir;
}

function readJson(file, what) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return didNotRun(`cannot read ${what} (${err.message})`); }
}

/** Stringified-rule sets, so a symmetric difference = rules added/removed/changed. */
function ruleSet(file) {
    const rules = readJson(file, file);
    if ( Array.isArray(rules) === false ) { didNotRun(`${file} is not a JSON array of rules`); }
    return new Map(rules.map(r => [ JSON.stringify(r), r ]));
}

// ── Checks (each pushes human-readable reasons; none touches the disk) ──────
function checkFileSets(oldFiles, newFiles, reasons) {
    const oldSet = new Set(oldFiles), newSet = new Set(newFiles);
    for ( const f of newFiles ) { if ( oldSet.has(f) === false ) { reasons.push(`file ADDED: ${f}`); } }
    for ( const f of oldFiles ) { if ( newSet.has(f) === false ) { reasons.push(`file REMOVED: ${f}`); } }
}

/** Manifest as a comparable string with its version blanked out. */
function withoutVersion(manifest) {
    return JSON.stringify({ ...manifest, [MANIFEST_VERSION_KEY]: null });
}

function checkManifest(oldDir, newDir, reasons) {
    const before = readJson(path.join(oldDir, MANIFEST_FILE), `previous ${MANIFEST_FILE}`);
    const after  = readJson(path.join(newDir, MANIFEST_FILE), `new ${MANIFEST_FILE}`);
    if ( before[MANIFEST_VERSION_KEY] === after[MANIFEST_VERSION_KEY] ) {
        reasons.push(`manifest version did not change (${after[MANIFEST_VERSION_KEY]}) — a published update needs a new version`);
    }
    if ( withoutVersion(before) !== withoutVersion(after) ) {
        reasons.push(`${MANIFEST_FILE} changed in more than its "${MANIFEST_VERSION_KEY}" (permissions, rule_resources, scripts … are not allowed to move)`);
    }
    return after;
}

function checkChangedFiles(oldDir, newDir, commonFiles, declaredRulesets, reasons) {
    const changedRulesets = [];
    for ( const rel of commonFiles ) {
        if ( rel === MANIFEST_FILE ) { continue; }
        const same = fs.readFileSync(path.join(oldDir, rel)).equals(fs.readFileSync(path.join(newDir, rel)));
        if ( same ) { continue; }
        if ( declaredRulesets.has(rel) ) { changedRulesets.push(rel); } else {
            reasons.push(`changed file is NOT a declared rule_resources ruleset: ${rel}`);
        }
    }
    return changedRulesets;
}

function checkRulesetChanges(oldDir, newDir, changedRulesets, reasons) {
    let safeChanges = 0;
    for ( const rel of changedRulesets ) {
        const before = ruleSet(path.join(oldDir, rel)), after = ruleSet(path.join(newDir, rel));
        const delta = [
            ...[ ...after ].filter(([ k ]) => before.has(k) === false).map(([ , r ]) => [ 'added/changed', r ]),
            ...[ ...before ].filter(([ k ]) => after.has(k) === false).map(([ , r ]) => [ 'removed/changed', r ]),
        ];
        for ( const [ kind, rule ] of delta ) {
            if ( isSafeRule(rule) ) { safeChanges++; } else {
                reasons.push(`${rel}: ${kind} rule id ${rule?.id} has UNSAFE action "${rule?.action?.type}"`);
            }
        }
    }
    return safeChanges;
}

// ── Main ────────────────────────────────────────────────────────────────────
const [ previousZip, newZip ] = process.argv.slice(2);
if ( !previousZip || !newZip ) { didNotRun('usage: node tools/verify-safe-update.mjs <previous-extension.zip> <new-extension.zip>'); }
for ( const z of [ previousZip, newZip ] ) { if ( fs.existsSync(z) === false ) { didNotRun(`file not found: ${z}`); } }

let exitCode = 0;
try {
    const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX)); workDirs.push(oldRoot);
    const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX)); workDirs.push(newRoot);
    const oldDir = extractZip(previousZip, oldRoot);
    const newDir = extractZip(newZip, newRoot);

    const oldFiles = listFiles(oldDir), newFiles = listFiles(newDir);
    const reasons = [];

    checkFileSets(oldFiles, newFiles, reasons);
    const newManifest = checkManifest(oldDir, newDir, reasons);
    const declaredRulesets = new Set((newManifest?.declarative_net_request?.rule_resources ?? []).map(r => String(r.path).replace(/^\//, '')));
    const commonFiles = oldFiles.filter(f => newFiles.includes(f));
    const changedRulesets = checkChangedFiles(oldDir, newDir, commonFiles, declaredRulesets, reasons);
    const safeChanges = checkRulesetChanges(oldDir, newDir, changedRulesets, reasons);

    console.log(`Previous: ${path.basename(previousZip)} (${oldFiles.length} files)`);
    console.log(`New:      ${path.basename(newZip)} (${newFiles.length} files)`);
    console.log(`Changed declared rulesets: ${changedRulesets.length ? changedRulesets.join(', ') : 'none'}; safe rule changes: ${safeChanges}`);

    if ( reasons.length === 0 ) {
        console.log('PASS: eligible for Chrome Web Store skip-review (only the manifest version and safe rules in declared rulesets differ).');
    } else {
        console.log(`FAIL: NOT eligible for skip-review — ${reasons.length} reason(s):`);
        reasons.slice(0, MAX_REASONS_SHOWN).forEach(r => console.log(`  - ${r}`));
        if ( reasons.length > MAX_REASONS_SHOWN ) { console.log(`  … and ${reasons.length - MAX_REASONS_SHOWN} more`); }
        exitCode = 1;
    }
} finally {
    releaseWorkDirs();
}
process.exit(exitCode);
