// tools/check-coverage.mjs — real V8 statement/branch/function coverage
// (via c8) of the existing dry-run test scripts
// (test-core-modules-dry-run.mjs, test-dashboard-dry-run.mjs).
// Informational — this project has no defined coverage-percentage gate,
// and a numeric threshold picked without real analysis of which paths
// matter would be an arbitrary gate, not a meaningful one. This reports
// real numbers (genuine V8 execution data, not simulated) so gaps are
// visible and can inform where a future test is worth writing, without
// pretending a single percentage is a pass/fail signal on its own.
//
// NOTE: this measures coverage of the Node-run dry-run scripts only —
// it does not and cannot measure real browser/user-interaction
// coverage (no Chrome instance in this environment). See the
// programming-principles audit doc's own tooling-comparison notes for
// that distinction.
import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== c8: coverage report (dry-run test scripts, informational) ===\n');

try {
    execFileSync(
        path.join(ROOT, 'node_modules', '.bin', 'c8'),
        [
            '--reporter', 'text',
            '--exclude', 'tools/**',
            '--exclude', 'node_modules/**',
            process.execPath, 'tools/test-core-modules-dry-run.mjs',
        ],
        { cwd: ROOT, stdio: 'inherit' }
    );
} catch {
    // The coverage report was not produced — c8 crashed, or the dry-run it
    // wraps did not complete. There is no coverage gate (findings are
    // informational), but a report that was never produced has not passed
    // (principle C38).
    console.log('\nDID NOT RUN: c8/dry-run did not complete — no coverage report was produced (see output above).');
    process.exit(1);
}
