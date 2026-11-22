// tools/check-depcheck.mjs — flags any devDependency in package.json
// that nothing in the tree actually imports/requires, and any import
// that has no corresponding package.json entry.
//
// FALSE-POSITIVE CLASS, DOCUMENTED (see .depcheckrc.json's own
// `ignores` list): `knip`, `typescript`, `depcheck`, `madge`, `jscpd`,
// and `c8` are all invoked as CLI binaries (`node_modules/.bin/...` via
// execFileSync — see tools/check-knip-dead-code.mjs,
// tools/check-circular-deps.mjs, tools/check-duplicate-code.mjs,
// tools/check-coverage.mjs, and this file) rather than statically
// `import`ed anywhere in this codebase. depcheck's own static-usage
// resolver can't see a binary invocation, so all six read as "unused"
// without the ignore list. `typescript` specifically is knip@5.x's own
// peer dependency (see check-knip-dead-code.mjs's header for why knip
// is pinned to 5.x), never imported by this project's own code at all.
import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== depcheck: unused/missing devDependency check ===');

try {
    const out = execFileSync(
        path.join(ROOT, 'node_modules', '.bin', 'depcheck'),
        [ '--json' ],
        { cwd: ROOT, encoding: 'utf8' }
    );
    const result = JSON.parse(out);
    const unused = result.devDependencies ?? [];
    const missing = Object.keys(result.missing ?? {});

    if ( unused.length === 0 && missing.length === 0 ) {
        console.log('PASS: every devDependency is used, and every import has a matching devDependency.');
        process.exitCode = 0;
    } else {
        if ( unused.length > 0 ) {
            console.log(`FAIL: unused devDependencies (declared in package.json, nothing imports them): ${unused.join(', ')}`);
        }
        if ( missing.length > 0 ) {
            console.log(`FAIL: missing devDependencies (imported somewhere, not declared in package.json): ${missing.join(', ')}`);
        }
        process.exitCode = 1;
    }
} catch (err) {
    console.log(`FAIL: depcheck did not run: ${err.message}`);
    process.exitCode = 1;
}
