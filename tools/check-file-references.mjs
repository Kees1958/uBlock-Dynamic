// C20 — every file path declared in the manifest (and a few other
// declaration points) must exist on disk. Straight port of the audit
// doc's C20 Python snippet to this project's own tools/ + npm test
// convention.
import fs from 'fs';
import path from 'path';
import { SCRIPTLET_LIBRARY_END_FILE, SCRIPTLET_LIBRARY_FILE } from '../js/data/scriptlet-library.js';

const ROOT = path.resolve(import.meta.dirname, '..');
function exists(p) { return fs.existsSync(path.join(ROOT, p.replace(/^\//, ''))); }

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const paths = [];
for ( const r of manifest.declarative_net_request?.rule_resources ?? [] ) { paths.push(r.path); }
for ( const r of manifest.web_accessible_resources ?? [] ) { paths.push(...(r.resources ?? [])); }
if ( manifest.background?.service_worker ) { paths.push(manifest.background.service_worker); }
for ( const cs of manifest.content_scripts ?? [] ) { paths.push(...(cs.js ?? []), ...(cs.css ?? [])); }
for ( const icon of Object.values(manifest.icons ?? {}) ) { paths.push(icon); }
for ( const icon of Object.values(manifest.action?.default_icon ?? {}) ) { paths.push(icon); }
if ( manifest.action?.default_popup ) { paths.push(manifest.action.default_popup); }
if ( manifest.options_ui?.page ) { paths.push(manifest.options_ui.page); }

console.log('=== C20: manifest file-reference cross-check ===');
console.log(`Checked ${paths.length} paths declared in manifest.json.`);

const missing = paths.filter(p => p && !exists(p));
let ok = missing.length === 0;
if ( !ok ) {
    for ( const p of missing ) { console.log(`FAIL: MISSING: ${p}`); }
} else {
    console.log('PASS: every manifest-declared path exists on disk.');
}

// The shared scriptlet library + end file (after 10.4.4): registered by js/core/scripting-manager.js around
// every scriptlet data file, so both must exist whenever any data file is listed.
{
    const listed = fs.existsSync(path.join(ROOT, 'rulesets/scriptlet-files.json')) &&
        JSON.parse(fs.readFileSync(path.join(ROOT, 'rulesets/scriptlet-files.json'), 'utf8')).length > 0;
    for ( const p of [ SCRIPTLET_LIBRARY_FILE, SCRIPTLET_LIBRARY_END_FILE ] ) {
        if ( listed && !exists(p) ) { console.log(`FAIL: MISSING (shared scriptlet library): ${p}`); ok = false; }
    }
}

// rulesets/scriptlet-files.json and rulesets/cosmetic-files.json, if present
for ( const fname of [ 'rulesets/scriptlet-files.json', 'rulesets/cosmetic-files.json' ] ) {
    const full = path.join(ROOT, fname);
    if ( !fs.existsSync(full) ) { continue; }
    const entries = JSON.parse(fs.readFileSync(full, 'utf8'));
    const list = Array.isArray(entries) ? entries : Object.values(entries).flat();
    const missingHere = list.filter(e => e?.file && !exists(e.file)).map(e => e.file);
    // New storage-backed fields (live since 7.7.9, sole path since 7.7.10 —
    // see CHANGELOG.md): every cosmetic entry should now carry these, so
    // check them with the same rigor `.file` got when it was still live.
    const missingSpecific = list
        .filter(e => fname === 'rulesets/cosmetic-files.json')
        .filter(e => e?.specificDataFile && !exists(e.specificDataFile))
        .map(e => e.specificDataFile);
    const missingLoader = list
        .filter(e => fname === 'rulesets/cosmetic-files.json')
        .filter(e => e?.loaderFile && !exists(e.loaderFile))
        .map(e => e.loaderFile);
    console.log(`Checked ${list.length} entries in ${fname}.`);
    if ( missingHere.length > 0 || missingSpecific.length > 0 || missingLoader.length > 0 ) {
        ok = false;
        for ( const p of [ ...missingHere, ...missingSpecific, ...missingLoader ] ) {
            console.log(`FAIL: MISSING (${fname}): ${p}`);
        }
    }
}

console.log('');
process.exitCode = ok ? 0 : 1;
