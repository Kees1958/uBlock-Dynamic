// tools/check-stylelint-style-guide.mjs — runs stylelint with only this
// project's own custom rules (see .stylelintrc.mjs and
// tools/stylelint-plugins/), which directly encode
// STYLE_GUIDE_LIGHT.md / STYLE_GUIDE_DARK.md's proven-safe opacity
// tables and the documented --color-green/--color-amber-as-text bug —
// per A9's requirement that the style guides be the reference these
// checks run against, not re-derived from scratch each time.
//
// Informational only: findings span a real range of severity in one
// report — a documented-fail opacity value (e.g. 35%) is a genuine bug,
// while an unverified-but-likely-safe value between two proven points
// (e.g. 60%, between 55%/75%) is advisory, not a defect. Splitting
// these into separate hard/soft checks would need per-message severity
// stylelint doesn't cleanly support without real complexity for
// marginal benefit — the message text itself already states which kind
// each finding is. Verify each by hand; see this project's own
// STYLE_GUIDE_LIGHT.md/STYLE_GUIDE_DARK.md for the reference tables.
import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== stylelint: style-guide-derived rules (informational) ===');
console.log('Rules: ubol/verified-color-mix-opacity, ubol/no-unsafe-status-color-as-text\n');

const CSS_GLOBS = [
    'css/**/*.css',
    'matrix/*.css',
    'dashboard/*.css',
    'popup/*.css',
    'privacy/*.css',
    'picker/*.css',
];

try {
    const out = execFileSync(
        path.join(ROOT, 'node_modules', '.bin', 'stylelint'),
        [ ...CSS_GLOBS, '--config', '.stylelintrc.mjs' ],
        { cwd: ROOT, encoding: 'utf8' }
    );
    console.log(out);
    console.log('PASS: no style-guide-rule findings.');
} catch (err) {
    // stylelint's exit codes: 2 = it ran and found problems (expected —
    // informational, surfaced without failing the suite); anything else
    // (1 = fatal error, 78 = invalid config) = it did NOT run. Before the
    // audit after 9.7.5 every non-zero code was reported as "findings", so
    // a crash looked the same as a clean-but-flagged run (principle C38).
    const STYLELINT_EXIT_FINDINGS = 2;
    if ( err.status === STYLELINT_EXIT_FINDINGS ) {
        if ( err.stdout ) { console.log(err.stdout); }
        console.log('FLAG (informational — see each message for severity; verify against the style guides before acting).');
    } else {
        console.log(`DID NOT RUN: stylelint exited ${err.status ?? err.message} (not a findings exit).`);
        if ( err.stderr ) { console.log(String(err.stderr).split('\n').slice(0, 12).join('\n')); }
        process.exit(1);
    }
}
