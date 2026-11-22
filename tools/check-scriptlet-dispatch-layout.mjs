#!/usr/bin/env node
// check-scriptlet-dispatch-layout.mjs — permanent guard for the scriptlet dispatch data layout (10.1.7).
//
// Four independent checks, all driving the REAL layout module (tools/build/scriptlet-dispatch-layout.mjs)
// and the REAL generated text — never a re-implementation of the lookup:
//   1. Fuzz equivalence: seeded random rule tables are encoded + rendered, a REAL library of recorder
//      functions (renderLibraryFile) + the data file + the end file are executed in one context for many page
//      hostnames, and the calls are compared with a plain reference walk (hostname, parent domains, entity
//      form; a rule runs once; two different rules with identical function+arguments both run). Also
//      compared: name == the library name, uniqueId == "<list id>:<rank of the rule>", round trip, and the
//      library global is gone after the end file.
//   2. Negative tests: the guards must fire (a dead key is refused, a corrupted file does not decode,
//      function sources containing the reserved library tail are refused, an invalid name is refused).
//   3. Every shipped rulesets/*-scriptlets.js decodes, has no unmatchable key, has an entity step iff it has
//      an entity key, and RUNS (recorder library, a spread of hostnames) without throwing.
//   4. The shipped shared library decodes, publishes every name any shipped data file calls, and the
//      shipped end file is exactly the one the layout module renders (shared library, after 10.4.4).
//
// Usage: node tools/check-scriptlet-dispatch-layout.mjs   (step 50 of tools/complete-check.mjs)

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import {
    DISPATCH_LAYOUT_CONFIG as L, decodeDispatchSource, decodeLibrarySource, encodeDispatchTables,
    renderLibraryEndFile, renderLibraryFile, renderScriptletFile, verifyRoundTrip,
} from './build/scriptlet-dispatch-layout.mjs';
import {
    SCRIPTLET_LIBRARY_END_FILE, SCRIPTLET_LIBRARY_FILE, SCRIPTLET_LIBRARY_GLOBAL,
} from '../js/data/scriptlet-library.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const isMainModule = process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

// ── CONFIG (every number of this check, one place) ────────────────────────
const CHECK_CONFIG = Object.freeze({
    FUZZ_SEED:            20261007,
    FUZZ_TABLES:          60,     // random tables
    FUZZ_RULES_MAX:       40,     // rules per table
    FUZZ_HOSTS_PER_TABLE: 60,     // page hostnames tried per table
    FNS_COUNT:            4,      // distinct scriptlet functions per table
    LABELS: ['a', 'b', 'kat', 'www', 'x1', 'co', 'uk', 'de'],
    TLDS:   ['com', 'org', 'co.uk', 'de'],
    ARG_POOL: ['', 'x', 'a,b', "it's", '"q"', 'back\\slash', 'semi;colon', '</script>', 'ünï', 'line\nbreak', '0', '1'],
    SHIPPED_PROBE_HOSTS: ['nomatch.invalid', 'example.com', 'www.example.co.uk', 'a.b.c.d.example.org', 'localhost'],
    FILE_TAG: 'ruleset_fuzz',     // list id used as the uniqueId prefix of fuzz files
});

// ── seeded PRNG (mulberry32) so a failure is reproducible ────────────────
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── reference walk: the documented contract, written plainly ─────────────
function referenceCalls(byHostname, pageHost, withEntities) {
    const seen = new Set();
    const out = [];
    let p = pageHost;
    for ( ;; ) {
        const keys = [ p ];
        if ( withEntities && p.includes('.') ) { keys.push(p.slice(0, p.lastIndexOf('.')) + '.*'); }
        for ( const k of keys ) {
            for ( const [ fn, id, args ] of byHostname.get(k) ?? [] ) {
                if ( seen.has(id) ) { continue; }
                seen.add(id);
                out.push({ fn, id, args });
            }
        }
        const i = p.indexOf('.');
        if ( i < 0 || !p.slice(i + 1).includes('.') ) { break; }
        p = p.slice(i + 1);
    }
    return out;
}

// ── execute library + data file + end file (one combined registration) against a page hostname ──
// Returns the calls and whether the library global was still present after the end file ran.
function runBundle(texts, pageHost) {
    const calls = [];
    const ctx = vm.createContext({ location: { hostname: pageHost }, __rec: calls });
    for ( const text of texts ) { vm.runInContext(text, ctx, { timeout: 20000 }); }
    const leaked = vm.runInContext(`Object.prototype.hasOwnProperty.call(globalThis, ${JSON.stringify(SCRIPTLET_LIBRARY_GLOBAL)})`, ctx);
    return { calls, leaked };
}
const RECORDER_NAMES = Array.from({ length: CHECK_CONFIG.FNS_COUNT }, (_, k) => `recorder-${k}`);
const RECORDER_LIBRARY = renderLibraryFile(RECORDER_NAMES.map((n, k) =>
    [ n, `function r${k}(s,a){__rec.push([${k},s.name,s.uniqueId,a])}` ]));
// Shipped data files run against a library that records ANY name (the real bodies need a browser page).
function recordingLibraryContext(pageHost, calls) {
    const ctx = vm.createContext({ location: { hostname: pageHost } });
    Object.defineProperty(ctx, SCRIPTLET_LIBRARY_GLOBAL, { value: new Proxy({}, {
        get: (t, name) => (s, a) => { calls.push([ name, s.name, s.uniqueId, a ]); },
    }) });
    return ctx;
}

// ── 1. fuzz ──────────────────────────────────────────────────────────────
function randomHost(rng, entity) {
    const n = 1 + Math.floor(rng() * 2);
    const labels = Array.from({ length: n }, () => CHECK_CONFIG.LABELS[Math.floor(rng() * CHECK_CONFIG.LABELS.length)]);
    const tld = entity ? '*' : CHECK_CONFIG.TLDS[Math.floor(rng() * CHECK_CONFIG.TLDS.length)];
    return labels.join('.') + '.' + tld;
}
function checkFuzz(violations) {
    const rng = makeRng(CHECK_CONFIG.FUZZ_SEED);
    let compared = 0;
    for ( let t = 0; t < CHECK_CONFIG.FUZZ_TABLES; t++ ) {
        const byHostname = new Map();
        const ruleCount = 1 + Math.floor(rng() * CHECK_CONFIG.FUZZ_RULES_MAX);
        let hasEntities = false;
        const usedIds = [];
        for ( let id = 0; id < ruleCount; id++ ) {
            if ( rng() < 0.15 ) { continue; }                       // gaps in rule ids, like skipped rules
            const fn = Math.floor(rng() * CHECK_CONFIG.FNS_COUNT);
            const args = Array.from({ length: Math.floor(rng() * 3) },
                () => CHECK_CONFIG.ARG_POOL[Math.floor(rng() * CHECK_CONFIG.ARG_POOL.length)]);
            const triple = [ fn, id, args ];
            usedIds.push(id);
            const hostCount = 1 + Math.floor(rng() * 3);
            const mine = new Set();
            for ( let h = 0; h < hostCount; h++ ) {
                const entity = rng() < 0.2;
                mine.add(randomHost(rng, entity));
            }
            for ( const hn of mine ) {
                if ( byHostname.has(hn) === false ) { byHostname.set(hn, []); }
                byHostname.get(hn).push(triple);
                hasEntities ||= hn.endsWith('.*');
            }
        }
        if ( byHostname.size === 0 ) { continue; }
        const tables = encodeDispatchTables(byHostname);
        const text = renderScriptletFile(RECORDER_NAMES, tables, hasEntities, CHECK_CONFIG.FILE_TAG);
        try { verifyRoundTrip(byHostname, text); }
        catch (e) { violations.push(`fuzz table ${t}: round trip failed — ${e.message}`); continue; }
        const rank = new Map([ ...new Set(usedIds.filter(id => [ ...byHostname.values() ].some(v => v.some(x => x[1] === id)))) ]
            .sort((x, y) => x - y).map((id, i) => [ id, i ]));
        const pages = new Set([ 'nomatch.invalid' ]);
        for ( const k of byHostname.keys() ) {
            const base = k.endsWith('.*') ? k.slice(0, -2) + '.com' : k;
            pages.add(base); pages.add('www.' + base); pages.add('x.y.' + base);
        }
        let n = 0;
        for ( const page of pages ) {
            if ( ++n > CHECK_CONFIG.FUZZ_HOSTS_PER_TABLE ) { break; }
            const want = referenceCalls(byHostname, page, hasEntities);
            const { calls: got, leaked } = runBundle([ RECORDER_LIBRARY, text, renderLibraryEndFile() ], page);
            if ( leaked ) { violations.push(`fuzz table ${t}: the library global survived the end file.`); }
            const same = want.length === got.length && want.every((w, i) =>
                got[i][0] === w.fn && got[i][1] === RECORDER_NAMES[w.fn] &&
                got[i][2] === `${CHECK_CONFIG.FILE_TAG}${L.UNIQUE_ID_SEP}${rank.get(w.id)}` &&
                JSON.stringify(got[i][3]) === JSON.stringify(w.args));
            compared++;
            if ( same === false ) {
                violations.push(`fuzz table ${t}, page "${page}": generated lookup differs from the reference walk ` +
                    `(want ${want.length} call(s), got ${got.length}).`);
                break;
            }
        }
    }
    return compared;
}

// ── 2. negative tests: the guards must actually fire ─────────────────────
function expectThrow(label, fn, violations) {
    try { fn(); } catch { return; }
    violations.push(`negative test "${label}": expected an error but none was raised.`);
}
function checkGuards(violations) {
    const good = new Map([ [ 'example.com', [ [ 0, 0, ['x'] ] ] ] ]);
    expectThrow('dead key "[$path=/a]host"', () => encodeDispatchTables(new Map([ [ '[$path=/a]host.com', [ [ 0, 0, [] ] ] ] ])), violations);
    expectThrow('negated key "~host"', () => encodeDispatchTables(new Map([ [ '~host.com', [ [ 0, 0, [] ] ] ] ])), violations);
    expectThrow('key with comma', () => encodeDispatchTables(new Map([ [ 'a,b', [ [ 0, 0, [] ] ] ] ])), violations);
    expectThrow('library tail inside a function source', () => renderLibraryFile([ [ 'a', 'function a(){"' + L.LIB_TAIL + '"}' ] ]), violations);
    expectThrow('invalid scriptlet name', () => renderScriptletFile([ '1bad name' ], encodeDispatchTables(good), false, 'ruleset_x'), violations);
    expectThrow('uniqueId prefix with the separator', () => renderScriptletFile([ 'a' ], encodeDispatchTables(good), false, 'x' + L.UNIQUE_ID_SEP), violations);
    expectThrow('pre-library file does not decode as a data file', () => decodeDispatchSource('(()=>{"use strict";const FNS=[];{const H=[]}})();'), violations);
    const text = renderScriptletFile(RECORDER_NAMES, encodeDispatchTables(good), false, CHECK_CONFIG.FILE_TAG);
    expectThrow('tampered lookup text does not decode', () => decodeDispatchSource(text.replace('t.add(+x)', 't.add(+x+1)')), violations);
    expectThrow('table for another input fails the round trip', () => verifyRoundTrip(new Map([ [ 'other.com', [ [ 0, 0, ['x'] ] ] ] ]), text), violations);
}

// ── 3. shipped files ─────────────────────────────────────────────────────
// Returns the number of data files scanned; fills `calledNames` with every library name they call.
function checkShipped(violations, calledNames) {
    const dir = path.join(ROOT, 'rulesets');
    let scanned = 0;
    if ( fs.existsSync(dir) === false ) { return scanned; }
    for ( const name of fs.readdirSync(dir).sort() ) {
        if ( name.endsWith('-scriptlets.js') === false ) { continue; }
        scanned++;
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        let decoded;
        try { decoded = decodeDispatchSource(text); }
        catch (e) { violations.push(`${name}: does not decode as the dispatch layout — ${e.message}`); continue; }
        for ( const n of decoded.fnNames ) { calledNames.add(n); }
        if ( `${decoded.fileTag}-scriptlets.js` !== name ) {
            violations.push(`${name}: uniqueId prefix "${decoded.fileTag}" is not the file's own list id.`);
        }
        const keys = [ ...decoded.entries.keys() ];
        const dead = keys.filter(k => L.UNMATCHABLE_KEY_RE.test(k));
        if ( dead.length ) { violations.push(`${name}: ${dead.length} unmatchable dispatch key(s), e.g. "${dead[0]}".`); }
        const hasEntityKey = keys.some(k => k.endsWith('.*'));
        if ( hasEntityKey !== decoded.hasEntities ) {
            violations.push(`${name}: entity step ${decoded.hasEntities ? 'present' : 'absent'} but entity keys ${hasEntityKey ? 'exist' : 'do not exist'}.`);
        }
        // Run it with every scriptlet function replaced by a recorder.
        const probes = [ ...CHECK_CONFIG.SHIPPED_PROBE_HOSTS, ...keys.filter(k => k.endsWith('.*') === false).slice(0, 5) ];
        for ( const page of probes ) {
            try {
                const calls = runWithStubFns(text, page);
                if ( calls.length === 0 && keys.includes(page) ) { violations.push(`${name}: key "${page}" ran no scriptlet.`); }
            } catch (e) {
                violations.push(`${name}: running the file for "${page}" threw — ${e.message}`);
                break;
            }
        }
    }
    return scanned;
}
// Run a shipped data file exactly as shipped, against a library that records every call.
function runWithStubFns(text, pageHost) {
    const calls = [];
    vm.runInContext(text, recordingLibraryContext(pageHost, calls), { timeout: 20000 });
    return calls;
}

// ── 4. shipped shared library + end file ─────────────────────────────────
function checkShippedLibrary(violations, calledNames) {
    const libPath = path.join(ROOT, SCRIPTLET_LIBRARY_FILE);
    const endPath = path.join(ROOT, SCRIPTLET_LIBRARY_END_FILE);
    if ( fs.existsSync(libPath) === false || fs.existsSync(endPath) === false ) {
        if ( calledNames.size > 0 ) { violations.push(`shared library or end file missing (${SCRIPTLET_LIBRARY_FILE}, ${SCRIPTLET_LIBRARY_END_FILE}).`); }
        return 0;
    }
    let lib;
    try { lib = decodeLibrarySource(fs.readFileSync(libPath, 'utf8')); }
    catch (e) { violations.push(`${SCRIPTLET_LIBRARY_FILE}: does not decode — ${e.message}`); return 0; }
    const published = new Set(lib.names);
    const missing = [ ...calledNames ].filter(n => published.has(n) === false);
    if ( missing.length ) { violations.push(`${SCRIPTLET_LIBRARY_FILE}: ${missing.length} called name(s) not published, e.g. "${missing[0]}".`); }
    const unused = lib.names.filter(n => calledNames.has(n) === false);
    if ( unused.length ) { violations.push(`${SCRIPTLET_LIBRARY_FILE}: ${unused.length} function(s) no data file calls, e.g. "${unused[0]}".`); }
    if ( fs.readFileSync(endPath, 'utf8') !== renderLibraryEndFile() ) {
        violations.push(`${SCRIPTLET_LIBRARY_END_FILE}: differs from the end file this layout module renders.`);
    }
    // The real library publishes real functions under exactly its names, and the end file removes them.
    try {
        const ctx = vm.createContext({});
        vm.runInContext(fs.readFileSync(libPath, 'utf8'), ctx);
        const keys = vm.runInContext(`Object.keys(globalThis[${JSON.stringify(SCRIPTLET_LIBRARY_GLOBAL)}])`, ctx);
        if ( JSON.stringify(Array.from(keys)) !== JSON.stringify(lib.names) ) { violations.push(`${SCRIPTLET_LIBRARY_FILE}: published names differ from its name list.`); }
        vm.runInContext(fs.readFileSync(endPath, 'utf8'), ctx);
        if ( vm.runInContext(`${JSON.stringify(SCRIPTLET_LIBRARY_GLOBAL)} in globalThis`, ctx) ) {
            violations.push(`${SCRIPTLET_LIBRARY_END_FILE}: the library global survives the end file.`);
        }
    } catch (e) {
        violations.push(`${SCRIPTLET_LIBRARY_FILE}: running library + end file threw — ${e.message}`);
    }
    return lib.names.length;
}

function run() {
    const violations = [];
    const compared = checkFuzz(violations);
    checkGuards(violations);
    const calledNames = new Set();
    const scanned = checkShipped(violations, calledNames);
    const libraryFunctions = checkShippedLibrary(violations, calledNames);
    for ( const v of violations ) { console.error(`VIOLATION: ${v}`); }
    if ( violations.length ) { console.error(`\n${violations.length} violation(s) of the scriptlet dispatch layout contract.`); return false; }
    console.log(`OK: ${compared} fuzz page lookups match the reference walk; guards fire; ${scanned} shipped scriptlet file(s) decode, carry no dead key and run; the shared library publishes exactly the ${libraryFunctions} function(s) they call and the end file removes it.`);
    return true;
}

if ( isMainModule ) { process.exit(run() ? 0 : 1); }
export { run };
