// tools/check-duplicate-code.mjs — token-level copy-paste detection via
// jscpd, informational (real false-positive risk — repeated enum/
// constant-table blocks in files like js/core/static-filtering-parser.js
// are legitimate repeated structure, not B15 violations; every finding
// needs a human read, same caveat as the dead-export/Knip checks).
//
// Real incident this check would have caught automatically:
// popup/worry-free-ui-test.js drifted from popup/worry-free-ui.js
// (missing a real `ev.isTrusted !== true` security guard — see
// CHANGELOG) — found by a manual jscpd run during an unrelated audit,
// not by any standing check. Wiring this in is what turns "found once,
// by chance" into "caught automatically, every run" (C25's own
// reasoning, applied to a duplication-drift bug class rather than a
// site-mode-gating one).
import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== jscpd: duplicate-code scan (informational) ===');

const TARGETS = [ 'js', 'dashboard', 'matrix', 'popup', 'privacy', 'picker' ];

try {
    execFileSync(
        path.join(ROOT, 'node_modules', '.bin', 'jscpd'),
        [ ...TARGETS, '--min-lines', '10', '--min-tokens', '50', '--reporters', 'consoleFull' ],
        { cwd: ROOT, stdio: 'inherit' }
    );
    // jscpd exits 0 whether or not it found clones (no --threshold set) —
    // the exit code alone can't tell us pass/fail here, only "ran
    // without crashing." The clone count itself is in the report above
    // (stdio:'inherit'); this check's whole point is surfacing that
    // report for a human to read, not gating on a number.
    console.log('\nSee "Found N clones" above — 0 is a clean run; anything else needs a human read (informational, see this file\'s own header for known false-positive classes).');
} catch {
    // jscpd exits 0 whenever it completes (no --threshold is set), so an
    // exception here can only mean it did not run. Findings stay
    // informational; not running fails the suite (principle C38).
    console.log('\nDID NOT RUN: jscpd did not complete (see error above). A check that did not run has not passed.');
    process.exit(1);
}
