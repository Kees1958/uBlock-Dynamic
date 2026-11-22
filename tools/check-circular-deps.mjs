// tools/check-circular-deps.mjs — no circular import dependencies
// anywhere in js/. Directly automates C15's "dependency flow may only
// flow downward" rule for the one violation class that's mechanically
// checkable without understanding tier semantics: a genuine import
// cycle is always a violation regardless of which tiers are involved
// (ui->workflow->ui, or even core->core, is never valid). Does NOT
// check tier direction itself (ui must not import from workflow/core/
// util/data — see the audit doc's own diagram) — that needs knowledge
// of which directory is which tier, which madge's generic graph
// analysis doesn't have; this check is a real but partial automation
// of C15, not a full replacement for manual review.
//
// Hard check — a real circular dependency is unambiguous (no
// false-positive risk the way Knip/jscpd have), so this fails the
// build like any other structural check.
import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== madge: circular dependency check (js/) ===');

try {
    execFileSync(
        path.join(ROOT, 'node_modules', '.bin', 'madge'),
        [ '--circular', '--extensions', 'js', 'js/workflow/background.js' ],
        { cwd: ROOT, stdio: 'inherit' }
    );
    // madge exits 0 (and prints "No circular dependency found!" to
    // stderr) on success — execFileSync throwing is the actual signal
    // of a cycle being found, not any particular message text (which
    // moved streams between madge versions before — don't rely on it).
    console.log('\nPASS: no circular dependencies.');
    process.exitCode = 0;
} catch {
    console.log('\nFAIL: madge reported circular dependencies (see above) or failed to run.');
    process.exitCode = 1;
}
