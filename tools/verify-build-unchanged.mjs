#!/usr/bin/env node
// tools/verify-build-unchanged.mjs — proves that a change to the BUILD
// SCRIPTS (e.g. restructuring tools/build-rulesets.mjs) changes nothing in
// what they produce. Deliberately STANDALONE, not a complete-check step: it
// needs a recording of every upstream download (tens of MB, never shipped),
// and it only makes sense around a build-script change.
//
// How it was used (phase 2 of the tools rework, audit after 9.7.5): the old
// single ~900-line build() was split into an orchestrator plus nine steps;
// after the move, a replayed build produced byte-identical output files and
// byte-identical console output.
//
// Usage:
//   node tools/verify-build-unchanged.mjs record <dir>
//       BEFORE the change: live build, recording every download into <dir>,
//       then snapshots every output file + the console output as the golden
//       reference (<dir>/golden.json).
//   node tools/verify-build-unchanged.mjs verify <dir>
//       AFTER the change: replays the recorded downloads (never fetches live)
//       and compares every output file and the console output against the
//       golden reference. Exit 0 only if everything is identical.
//
// Outcomes (principle C38): PASS / FINDINGS (differences — fails) /
// DID NOT RUN (build failed, no recording, … — fails).
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { listFiles } from './lib/walk.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PRELOAD = path.join(ROOT, 'tools', 'lib', 'fetch-record-replay.mjs');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-rulesets.mjs');
// Snapshot everything the build could write — the whole tree, except the
// build scripts themselves (they are what is being changed) and the
// recording's own directory.
const SNAPSHOT_EXCLUDE = [ 'lib', 'tools', 'coverage' ];
const SNAPSHOT_EXTRA_FILES = [ 'tools/adguard-scriptlets.lock.json', 'tools/scriptlet-wildcard-report.json' ];
const MAX_REPORTED_DIFFERENCES = 20;

const [ mode, dirArg ] = process.argv.slice(2);
function didNotRun(reason) { console.log(`DID NOT RUN: ${reason}`); process.exit(1); }
if ( (mode !== 'record' && mode !== 'verify') || !dirArg ) {
    didNotRun('usage: node tools/verify-build-unchanged.mjs record|verify <dir>');
}
const dir = path.resolve(dirArg);
const goldenPath = path.join(dir, 'golden.json');

function snapshot() {
    const files = listFiles(ROOT, { exts: [ '' ], excludeDirs: SNAPSHOT_EXCLUDE })
        .map(f => path.relative(ROOT, f))
        .filter(f => f.startsWith(path.relative(ROOT, dir)) === false)
        .concat(SNAPSHOT_EXTRA_FILES.filter(f => fs.existsSync(path.join(ROOT, f))));
    return Object.fromEntries(files.sort().map(f => [ f, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex') ]));
}

function runBuild(rrMode) {
    const r = spawnSync(process.execPath, [ '--import', PRELOAD, BUILD_SCRIPT ], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, FETCH_RR_MODE: rrMode, FETCH_RR_DIR: dir },
    });
    if ( r.status !== 0 ) { didNotRun(`build exited ${r.status}:\n${`${r.stdout}${r.stderr}`.split('\n').slice(-15).join('\n')}`); }
    return `${r.stdout}${r.stderr}`;
}

if ( mode === 'record' ) {
    fs.mkdirSync(dir, { recursive: true });
    const log = runBuild('record');
    fs.writeFileSync(goldenPath, JSON.stringify({ files: snapshot(), log }, null, 1));
    console.log(`Recorded ${fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'golden.json').length} downloads and a golden snapshot in ${dir}.`);
    process.exit(0);
}

if ( fs.existsSync(goldenPath) === false ) { didNotRun(`no golden reference in ${dir} — run "record" first`); }
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
const log = runBuild('replay');
const now = snapshot();
const differences = [];
for ( const f of new Set([ ...Object.keys(golden.files), ...Object.keys(now) ]) ) {
    if ( golden.files[f] !== now[f] ) {
        differences.push(`${f}: ${golden.files[f] === undefined ? 'NEW' : now[f] === undefined ? 'MISSING' : 'CHANGED'}`);
    }
}
const logSame = log === golden.log;
console.log(`Compared ${Object.keys(now).length} files and the console output against the golden reference.`);
if ( differences.length !== 0 || logSame === false ) {
    for ( const d of differences.slice(0, MAX_REPORTED_DIFFERENCES) ) { console.log(`  ${d}`); }
    if ( logSame === false ) { console.log('  console output: CHANGED'); }
    console.log('FAIL: the build no longer produces identical output.');
    process.exit(1);
}
console.log('PASS: identical output files and identical console output.');
