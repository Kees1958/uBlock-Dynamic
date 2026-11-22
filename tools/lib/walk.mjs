/*******************************************************************************

    uBlock-Stripped-Dynamic — shared file walker for the tools scripts

    Why this exists (tools audit after 9.7.5, item 3 / B2): the same
    recursive "list files with these extensions" function was written
    four separate times (complete-check, check-css-class-usage,
    check-dead-exports, check-scripting-site-mode-gating), each with its
    own exclusion rules, and they had already drifted:
      - complete-check skipped every directory NAMED `lib` at any depth,
        meant for the vendored top-level lib/ — so when tools/lib/ was
        added, its files silently dropped out of the syntax check (step 1);
      - check-dead-exports walked all of node_modules/ and filtered it out
        afterwards.

    Exclusions here are therefore EXACT PATHS relative to the walked root
    ('lib' means <root>/lib only), never bare names matched at any depth.
    NEVER_WALKED_DIR_NAMES are the only by-name exclusions: directories
    that are never project source wherever they appear.

    (tools/package-release.mjs's own walk() is deliberately NOT replaced:
    it inspects every entry NAME in a staged zip, directories included,
    looking for forbidden files — a different job from listing sources.)

*******************************************************************************/

import fs from 'fs';
import path from 'path';

// Directories that are never project source, at any depth.
export const NEVER_WALKED_DIR_NAMES = Object.freeze([ 'node_modules', '.git' ]);

// listFiles(rootDir, { exts, excludeDirs })
//   exts        — file-name suffixes to keep, e.g. [ '.js', '.mjs' ]
//   excludeDirs — directory paths RELATIVE TO rootDir to skip entirely,
//                 e.g. [ 'lib', 'js/generated' ]
// Returns absolute paths, sorted, so every caller sees a stable order.
export function listFiles(rootDir, { exts, excludeDirs = [] }) {
    if ( Array.isArray(exts) === false || exts.length === 0 ) {
        throw new Error('listFiles: `exts` must be a non-empty array');
    }
    const excluded = new Set(excludeDirs.map(d => path.normalize(d)));
    const out = [];
    function walk(dir) {
        for ( const entry of fs.readdirSync(dir, { withFileTypes: true }) ) {
            const full = path.join(dir, entry.name);
            if ( entry.isDirectory() ) {
                if ( NEVER_WALKED_DIR_NAMES.includes(entry.name) ) { continue; }
                if ( excluded.has(path.relative(rootDir, full)) ) { continue; }
                walk(full);
            } else if ( entry.isFile() && exts.some(e => entry.name.endsWith(e)) ) {
                // Regular files only: a symlink (e.g. a symlinked
                // node_modules) is neither a directory to descend into
                // nor a source file to list.
                out.push(full);
            }
        }
    }
    walk(rootDir);
    return out.sort();
}
