// tools/test-json-safe.mjs — principle C31 (HARD check).
//
// 1. Exercises the REAL js/util/json-safe.js detector (Part D step 15 — no
//    re-implementation): every value Chrome's JSON-based messaging silently
//    changes must be reported, and every JSON-safe shape must pass clean.
// 2. Verifies the detector is actually WIRED: background.js's message router
//    must call it on every response in unpacked builds. A detector nothing
//    calls protects nothing (the same lesson as principle C38).
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== C31: JSON-lossy message responses — detector + router wiring ===');

let findJsonLossyValue;
try {
    ({ findJsonLossyValue } = await import(path.join(ROOT, 'js/util/json-safe.js')));
} catch (err) {
    console.log(`DID NOT RUN: cannot import js/util/json-safe.js (${err.message})`);
    process.exit(1);
}
if ( typeof findJsonLossyValue !== 'function' ) {
    console.log('DID NOT RUN: js/util/json-safe.js does not export findJsonLossyValue');
    process.exit(1);
}

class Custom { constructor() { this.a = 1; } }
const circular = { a: 1 }; circular.self = circular;

// [ label, value, mustBeReported ]
const CASES = [
    [ 'Map in a property',            { none: new Map([ [ 'a', 1 ] ]) }, true ],
    [ 'Set in a property',            { none: new Set([ 'a.com' ]) },     true ],
    [ 'Date',                         { when: new Date(0) },              true ],
    [ 'RegExp',                       { re: /x/ },                        true ],
    [ 'undefined property',           { ok: 1, gone: undefined },         true ],
    [ 'undefined in an array',        { list: [ 1, undefined ] },         true ],
    [ 'NaN',                          { n: NaN },                         true ],
    [ 'Infinity',                     { n: Infinity },                    true ],
    [ 'function',                     { f() {} },                         true ],
    [ 'class instance',               { c: new Custom() },                true ],
    [ 'circular reference',           circular,                           true ],
    [ 'deeply nested Set',            { a: [ { b: { c: new Set() } } ] }, true ],
    [ 'plain object',                 { a: 1, b: 'x', c: true, d: null }, false ],
    [ 'nested arrays and objects',    { a: [ 1, [ 2, { b: [ 'c' ] } ] ] }, false ],
    [ 'serialized mode details',      { none: [ 'a.com' ], basic: [] },   false ],
    [ 'undefined response (no reply)', undefined,                         false ],
    [ 'null',                         null,                               false ],
    [ 'string / number / boolean',    [ 'x', 1, false ],                  false ],
    [ 'null-prototype object',        Object.assign(Object.create(null), { a: 1 }), false ],
];

let failures = 0;
for ( const [ label, value, mustBeReported ] of CASES ) {
    const problem = findJsonLossyValue(value, 'response');
    const reported = problem !== null;
    const ok = reported === mustBeReported;
    if ( ok === false ) { failures += 1; }
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${reported ? problem : 'clean'}`);
}

// Wiring: the router must call the detector on every response, gated to
// unpacked builds only.
const bg = fs.readFileSync(path.join(ROOT, 'js/workflow/background.js'), 'utf8');
const wiring = [
    [ 'imports findJsonLossyValue from ../util/json-safe.js', /import \{ findJsonLossyValue \} from '\.\.\/util\/json-safe\.js';/ ],
    [ 'router checks each response in unpacked builds', /onMessage\(request, sender\)\.then\(\s*response => \{\s*if \( IS_UNPACKED_BUILD \) \{ warnIfResponseNotJsonSafe\(request\.what, response\); \}/ ],
    [ 'IS_UNPACKED_BUILD derives from update_url', /IS_UNPACKED_BUILD = runtime\.getManifest\(\)\.update_url === undefined/ ],
];
for ( const [ label, re ] of wiring ) {
    const ok = re.test(bg);
    if ( ok === false ) { failures += 1; }
    console.log(`${ok ? 'OK  ' : 'FAIL'} wiring: ${label}`);
}

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — the C31 tripwire would miss lossy responses or never run.`);
    process.exit(1);
}
console.log(`\nPASS: ${CASES.length} detector cases correct; router wiring present.`);
