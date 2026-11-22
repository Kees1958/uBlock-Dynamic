#!/usr/bin/env node
// pre-zip.mjs — the one command to run before creating any distributable
// zip. Exists because, historically, this project's own devDependencies
// (eslint, jsdom) were treated as "usually unavailable" — three of
// complete-check.mjs's checks were long documented as "expected to fail
// in a sandbox" rather than actually fixed. That assumption turned out to
// be wrong: `npm install` reaches npm's registry from every environment
// this project has actually been built in so far. This script makes that
// the automatic, unconditional first step instead of a manual afterthought
// someone has to remember.
//
// Runs, in order:
//   1. Ensure devDependencies are installed (GUARD: init — see below)
//   2. Rebuild rulesets/ from live upstream sources (also regenerates
//      test-fixtures/legacy-cosmetic/, required by check #16)
//   3. Run the full check suite (tools/complete-check.mjs — every step it registers; the count is not
//      repeated here, so this comment cannot go stale again — audit 10.5.0)
//
// Exit code 0 ONLY if every step succeeds. Non-zero on ANY failure — this
// script is meant to gate a zip step (in CI, or a person's own habit of
// "always run this before zipping"), not just report status.
//
// Usage: node tools/pre-zip.mjs   (or: npm run prezip)

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Single place for this script's one real constant — the marker file
// npm itself uses to know a package is installed. Checked directly rather
// than shelling out to `npm ls` (slower, and its exit code semantics
// don't cleanly distinguish "not installed" from "installed but stale").
const NODE_MODULES_DIR = path.join(ROOT, 'node_modules');

function step(label, fn) {
    console.log(`\n${'─'.repeat(70)}\n${label}\n${'─'.repeat(70)}`);
    try {
        fn();
        console.log(`✓ ${label}`);
        return true;
    } catch (err) {
        console.error(`✗ ${label}`);
        console.error(err.message ?? err);
        return false;
    }
}

// ── GUARD: init ──────────────────────────────────────────────────────
// Installs devDependencies only if genuinely missing — never a redundant
// reinstall on every run. `npm install` is deterministic and idempotent
// on an already-satisfied node_modules/, but skipping it entirely when
// unnecessary keeps this script fast for the common case (already
// installed, running this a second time in the same session).
const needsInstall = !fs.existsSync(NODE_MODULES_DIR);
const installOk = needsInstall
    ? step('1. Install devDependencies (node_modules/ missing)', () => {
          execFileSync('npm', [ 'install' ], { stdio: 'inherit', cwd: ROOT });
      })
    : (console.log('\n1. Install devDependencies — SKIPPED (node_modules/ already present)'), true);

if ( !installOk ) {
    console.log('\nCannot proceed without devDependencies installed. Aborting.');
    process.exit(1);
}

const buildOk = step('2. Rebuild rulesets/ (node tools/build-rulesets.mjs)', () => {
    execFileSync(process.execPath, [ 'tools/build-rulesets.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

if ( !buildOk ) {
    console.log('\nBuild failed — check #16 (and likely others) would fail on stale/missing data. Aborting.');
    process.exit(1);
}

const checkOk = step('3. Full check suite (node tools/complete-check.mjs)', () => {
    execFileSync(process.execPath, [ 'tools/complete-check.mjs' ], { stdio: 'inherit', cwd: ROOT });
});

console.log(`\n${'═'.repeat(70)}`);
if ( checkOk ) {
    console.log('PRE-ZIP GATE: PASSED — safe to zip.');
    process.exit(0);
} else {
    console.log('PRE-ZIP GATE: FAILED — do NOT zip until the above is resolved.');
    process.exit(1);
}
