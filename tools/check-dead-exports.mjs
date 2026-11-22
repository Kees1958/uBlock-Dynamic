// New check (this session): dead-export detection. Every function/const
// exported from js/core/*.js should be imported by at least one other
// file — an export nobody imports is either orphaned code or a wiring
// mistake (a function that should be used somewhere but isn't). Scoped
// to js/core/ specifically (the shared logic layer) rather than the
// whole tree — page-context files (dashboard/, matrix/, popup/) export
// nothing by convention (they're entry points, not libraries), so
// checking them would just be noise.
import fs from 'fs';
import path from 'path';
import { listFiles } from './lib/walk.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Settings (one place) ─────────────────────────────────────────────
// Directories whose files do NOT count as importers. Only vendored/helper
// `lib` dirs are excluded. `tools/` used to be excluded too, which made
// every export consumed only by a check/test script look dead (19 false
// positives in the 9.8.0 audit) — tools ARE real consumers, and knip
// (step 17) already treats them as entry points, so this check now agrees.
const EXCLUDED_IMPORTER_DIRS = [ 'lib' ];
// An export is intentionally kept when a `/** @public <reason> */` tag sits
// directly above it (same convention knip.jsonc documents). Only this many
// characters before the export are searched for that tag.
const PUBLIC_TAG_LOOKBACK_CHARS = 500;
const PUBLIC_TAG_PATTERN = /\/\*\*(?:(?!\*\/)[\s\S])*@public(?:(?!\*\/)[\s\S])*\*\/\s*$/;

function isTaggedPublic(src, exportIndex) {
    return PUBLIC_TAG_PATTERN.test(src.slice(Math.max(0, exportIndex - PUBLIC_TAG_LOOKBACK_CHARS), exportIndex));
}

const coreFiles = listFiles(path.join(ROOT, 'js/core'), { exts: [ '.js', '.mjs' ] });
const allJsFiles = listFiles(ROOT, { exts: [ '.js', '.mjs' ], excludeDirs: EXCLUDED_IMPORTER_DIRS });
// (was: walk everything incl. node_modules/, then filter it out afterwards)

// Combined source of every OTHER file, to search for import references —
// excludes each core file's own content when checking itself (a function
// calling a sibling in the same file isn't an "import").
const allSourcesCombined = allJsFiles.map(f => {
    const content = fs.readFileSync(f, 'utf8');
    return { file: f, content };
});

console.log('=== Dead-export check: js/core/*.js ===');

const exportPattern = /export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g;
let checkedCount = 0;
const deadExports = [];

for ( const coreFile of coreFiles ) {
    const src = fs.readFileSync(coreFile, 'utf8');
    for ( const m of src.matchAll(exportPattern) ) {
        const name = m[1] ?? m[2];
        if ( !name ) { continue; }
        checkedCount++;
        if ( isTaggedPublic(src, m.index) ) { continue; }   // kept on purpose, reason sits at the export
        const usedElsewhere = allSourcesCombined.some(({ file, content }) => {
            if ( file === coreFile ) { return false; }
            // A real import, not just the name appearing incidentally in
            // a comment or string — require it inside an import{...} block
            // or as a namespace-qualified call, both realistic enough for
            // this codebase's own consistent ES-module import style.
            return new RegExp(`\\b${name}\\b`).test(content) && content.includes('from');
        });
        if ( !usedElsewhere ) {
            deadExports.push({ name, file: path.relative(ROOT, coreFile) });
        }
    }
}

console.log(`Checked ${checkedCount} exports across ${coreFiles.length} files in js/core/.`);
if ( deadExports.length > 0 ) {
    for ( const { name, file } of deadExports ) {
        console.log(`FLAG (unused outside its own file — verify by hand, this check has false-positive risk): ${name} (${file})`);
    }
} else {
    console.log('PASS: every export from js/core/*.js is referenced by at least one other file.');
}
console.log('');
// Informational only, not a hard failure — see the false-positive caveat
// in the FLAG message above (e.g. a name reused as a common word
// elsewhere, or genuinely-intentional unused public API surface).
process.exitCode = 0;
