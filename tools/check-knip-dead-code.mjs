// tools/check-knip-dead-code.mjs — whole-tree unused-file / unused-export /
// unused-dependency / duplicate-export scan via Knip. HARD check
// (complete-check step 17) since the audit after 9.7.5.
//
// WHY THIS IS NO LONGER "INFORMATIONAL": until 9.7.5 this check always
// exited 0 and complete-check also wrapped it in try/catch. Knip had in fact
// crashed on every run (its stylelint plugin could not read
// .stylelintrc.mjs), so the step reported nothing, every time, and that
// looked exactly like "no dead code". Once fixed, its first real run found
// 3 unused files, 4 unused dependencies and 113 unused exports; every one
// was verified by hand and then either removed (dead) or given a written
// reason (see knip.jsonc and the `@public` / `@alias` tags at the exports).
// Principle C38 in the programming-principles doc records the lesson.
//
// Outcomes, each distinct:
//   PASS         Knip ran and reported nothing unapproved (exit 0).
//   FAIL         Knip ran and found something: fix it, or give it a
//                written reason in knip.jsonc / a tag at the export.
//   DID NOT RUN  Knip crashed or is missing. A check that did not run
//                has NOT passed, so this fails the suite too.
//
// Exceptions never live in this file — only in knip.jsonc (files and
// dependencies Knip cannot see being used) or as a `/** @public <reason> */`
// / `/** @alias <reason> */` tag at the export itself.
//
// KNOWN ENVIRONMENT CONSTRAINT: Knip >=6 (its oxc-parser "raw transfer"
// buffer pre-allocation) fails with "RangeError: Array buffer allocation
// failed" in sandboxes that reject a single ~4GB ArrayBuffer, so
// package.json pins knip@5.30.0. Re-run a `new ArrayBuffer(2**32)` repro
// before any upgrade.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const KNIP_BIN = path.join(ROOT, 'node_modules', '.bin', 'knip');
const KNIP_CONFIG = 'knip.jsonc';
// How "did the scan complete?" is decided: Knip is run with the JSON
// reporter, and a completed scan always prints one valid JSON document.
// The exit code alone can't tell: an unhandled crash inside Knip also
// exits 1 — the same code as "issues found" (proven when this check was
// written: re-enabling the crashing stylelint plugin produced exit 1).
const KNIP_EXIT_CLEAN = 0;
const KNIP_EXIT_ISSUES = 1;

console.log('=== Knip: unused files / exports / dependencies, duplicate exports (HARD) ===');

if ( fs.existsSync(path.join(ROOT, KNIP_CONFIG)) === false ) {
    console.log(`DID NOT RUN: ${KNIP_CONFIG} is missing — without it Knip would scan with defaults and prove nothing.`);
    process.exit(1);
}
if ( fs.existsSync(KNIP_BIN) === false ) {
    console.log('DID NOT RUN: node_modules/.bin/knip is missing — run `npm ci`. A check that did not run has not passed.');
    process.exit(1);
}

function runKnip(reporterArgs) {
    return spawnSync(KNIP_BIN, [ '--config', KNIP_CONFIG, ...reporterArgs ], { cwd: ROOT, encoding: 'utf8' });
}

const result = runKnip([ '--reporter', 'json' ]);
let scanCompleted = false;
try { JSON.parse(result.stdout); scanCompleted = true; } catch { /* no JSON = no completed scan */ }

if ( result.error || scanCompleted === false || (result.status !== KNIP_EXIT_CLEAN && result.status !== KNIP_EXIT_ISSUES) ) {
    console.log(`DID NOT RUN: Knip did not complete a scan (exit ${result.status ?? result.error?.message}, no report produced).`);
    const errText = `${result.stderr ?? ''}`.trim();
    if ( errText !== '' ) { console.log(errText.split('\n').slice(0, 12).join('\n')); }
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
if ( result.status === KNIP_EXIT_ISSUES ) {
    // Re-run with the human-readable reporter for the listing.
    console.log(`${runKnip([]).stdout ?? ''}`.trim());
    console.log('\nFAIL: each item above must be removed if dead, or given a written reason —');
    console.log(`in ${KNIP_CONFIG} (files/dependencies), or a /** @public <reason> */ or /** @alias <reason> */ tag at the export.`);
    process.exit(1);
}
console.log('PASS: Knip scanned the whole tree; every file, export and dependency is used or carries a written reason.');
