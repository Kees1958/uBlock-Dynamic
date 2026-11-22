// tools/check-json-syntax.mjs — every .json file in the tree parses
// cleanly, except rulesets/ and _metadata/ (large, pre-existing,
// machine-generated — not hand-edited, and rulesets/'s own build script
// (tools/build-rulesets.mjs) validates its own output at generation
// time). Ported from tools/self-test.mjs's check [2/6] (see CHANGELOG —
// self-test.mjs retired once complete-check.mjs, the tool it was
// explicitly a stopgap substitute for, was actually available and its
// own unique checks had somewhere real to live).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

function findFiles(dir, ext, exclude) {
    const out = [];
    for ( const entry of fs.readdirSync(dir) ) {
        if ( entry.startsWith('.') ) { continue; }
        const full = path.join(dir, entry);
        const st = fs.statSync(full);
        if ( st.isDirectory() ) {
            if ( exclude.some(x => full.includes(x)) ) { continue; }
            out.push(...findFiles(full, ext, exclude));
        } else if ( full.endsWith(ext) ) {
            out.push(full);
        }
    }
    return out;
}

console.log('=== JSON syntax — every .json file except _metadata/ and rulesets/ ===');

const jsonFiles = findFiles(ROOT, '.json', [ '/_metadata/', '/rulesets/', '/node_modules/' ]);
let failures = 0;
for ( const f of jsonFiles ) {
    try {
        JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
        failures++;
        console.log(`FAIL: ${f.replace(ROOT + '/', '')} — ${e.message}`);
    }
}

console.log('');
if ( failures > 0 ) {
    console.log(`${failures} JSON file(s) failed to parse.`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${jsonFiles.length} JSON files, all valid.`);
}
