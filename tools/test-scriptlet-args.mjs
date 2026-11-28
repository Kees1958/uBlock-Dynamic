#!/usr/bin/env node
// tools/test-scriptlet-args.mjs — (11.1.6) THE scriptlet argument reader and writer (js/util/scriptlet-args.js), the
// one implementation for the build (rules, exceptions, uBO→AdGuard conversion) and the user's own rules (C42):
//   1. real AdGuard rule lines that were cut at an escaped quote (scriptlet audit 11.1.6, finding 3) read whole
//   2. doubled backslashes stay, `\\'` still closes; unquoted tokens are tolerated
//   3. uBO syntax: `\,`, quoted tokens (' " `) — unchanged behaviour after the move
//   4. writer round trip (both quote kinds now carried); values no AdGuard spelling can carry are refused (null)
//   5. wiring: no private copy of a reader is left in the build or in js/core/custom-scriptlets.js
// Fault check (documented, done 11.1.6): with the escape branch removed from splitAdguardScriptletArgs, part 1 fails.
// Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE = 'js/util/scriptlet-args.js';
const USERS = Object.freeze([ 'tools/build/scriptlet-rules.mjs', 'tools/build/ubo-scriptlet-syntax.mjs', 'js/core/custom-scriptlets.js' ]);
// Private reader shapes that must not come back (the 11.1.5 copies).
const RETIRED_READER_RES = Object.freeze([ /let qi = 0;/, /function splitUboArgs\(/, /let quoteChar = null;/ ]);
// Real lines from AdGuard Base (BaseFilter/sections, 2026-11-28): the call text and the arguments AdGuard means.
const REAL_LINES = Object.freeze([
    {
        call: String.raw`'trusted-replace-node-text', 'script', 'html5player', 'if (typeof html5player.setupVideo === \'function\')', 'if (false)'`,
        args: [ 'trusted-replace-node-text', 'script', 'html5player', "if (typeof html5player.setupVideo === 'function')", 'if (false)' ],
    },
    {
        call: String.raw`'trusted-replace-node-text', 'script', 'startSecureTimer', 'if (document.hidden || document.visibilityState === \'hidden\')', 'if (!0)'`,
        args: [ 'trusted-replace-node-text', 'script', 'startSecureTimer', "if (document.hidden || document.visibilityState === 'hidden')", 'if (!0)' ],
    },
    {
        call: String.raw`'prevent-addEventListener', '/click|DOMContentLoaded/', '/new MouseEvent|SPONSOR_LINKS|_url,|\[\'\\x/'`,
        args: [ 'prevent-addEventListener', '/click|DOMContentLoaded/', String.raw`/new MouseEvent|SPONSOR_LINKS|_url,|\['\\x/` ],
    },
]);
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function didNotRun(msg) { console.log(`DID NOT RUN: ${msg}`); process.exit(EXIT_DID_NOT_RUN); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

let m;
try { m = await import(pathToFileURL(path.join(ROOT, MODULE)).href); } catch ( err ) { didNotRun(`cannot import ${MODULE} (${err.message})`); }

// 1. Real lines.
for ( const { call, args } of REAL_LINES ) {
    const got = m.splitAdguardScriptletArgs(call);
    check(`real rule read whole: ${args[0]} … ${args[2].slice(0, 30)}`, same(got, args), JSON.stringify(got));
}
// 2. Backslash pairs, closing after `\\`, unquoted tokens.
check("doubled backslash kept and `\\\\'` closes the argument",
    same(m.splitAdguardScriptletArgs(String.raw`'a', 'ends\\', 'next'`), [ 'a', String.raw`ends\\`, 'next' ]));
check('unquoted tokens are read up to the comma', same(m.splitAdguardScriptletArgs('set-constant, a.b, true'), [ 'set-constant', 'a.b', 'true' ]));
check('double-quoted argument with single quotes inside', same(m.splitAdguardScriptletArgs(`'x', "it's"`), [ 'x', "it's" ]));
// 3. uBO syntax, unchanged.
check('uBO: \\, is a literal comma', same(m.splitUboScriptletArgs(String.raw`set, a\,b, 1`), [ 'set', 'a,b', '1' ]));
check('uBO: quoted token keeps its commas', same(m.splitUboScriptletArgs("rmnt, script, 'a,b', excludes, `c,d`"), [ 'rmnt', 'script', 'a,b', 'excludes', 'c,d' ]));
// 4. Writer.
for ( const value of [ 'plain', `it's "both"`, String.raw`back\\slash`, String.raw`/a\[\'x/`.replace("\\'", "'"), '' ] ) {
    const quoted = m.quoteAdguardScriptletArg(value);
    check(`writer round trip: ${JSON.stringify(value)}`, quoted !== null && m.splitAdguardScriptletArgs(quoted)[0] === value, String(quoted));
}
for ( const value of [ 'one\\', String.raw`a\'b "c"` ] ) {
    check(`writer refuses what no spelling carries: ${JSON.stringify(value)}`, m.quoteAdguardScriptletArg(value) === null);
}
// 5. Wiring.
for ( const rel of USERS ) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    check(`${rel} uses the shared module and keeps no private reader`,
        src.includes('scriptlet-args.js') && RETIRED_READER_RES.every(re => re.test(src) === false));
}

process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
