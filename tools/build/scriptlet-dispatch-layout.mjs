// ── tools/build/scriptlet-dispatch-layout.mjs ─────────────────────────────────────────
// Scriptlet dispatch data layout: encodes a ruleset's hostname -> scriptlet table into the compact
// "sorted hostname list + shared rows" layout, renders the generated per-list DATA file (data + lookup code),
// renders the SHARED scriptlet library and its end file, and decodes generated files back (round-trip guard in
// the build, structural checks in the suite).
//
// Why this layout (measured, 10.1.7 research): the previous layout repeated each rule's arguments for
// every hostname it applies to and built a 14,000-key object literal on every page load. Now each rule is
// stored ONCE (a "row"), hostnames only hold row numbers, argument strings are pooled, and the lookup
// binary-searches a sorted hostname array and decodes only the few rows a page needs. AdGuard Base file:
// 1,916,160 -> about 927,000 bytes; cold parse+run of that file about 60 ms -> about 20 ms (node/V8).
//
// Shared library (after 10.4.4, uBOL's scriptlet-begin/-end design — see js/data/scriptlet-library.js): the
// scriptlet FUNCTIONS no longer live in each list's file. Every function used by any list is written ONCE to
// the library file, keyed by its scriptlet name; a list's data file holds the names it uses and calls
// LIB[name]. Measured on 10.4.4: 59 of 67 functions were duplicated across lists (~1.8 MB of 2.9 MB), and
// every enabled list compiled its own copy on every page and frame.
//
// Behaviour contract (proven equivalent to the previous layout, see tools/check-scriptlet-dispatch-layout.mjs):
//   - same hostname walk: the page hostname, then each parent domain; at every level its own "name.*"
//     entity form too when the file has entity keys;
//   - a rule runs at most once per page even if it is listed under several levels (a Set of row numbers);
//   - two DIFFERENT rules with identical function and arguments both still run ("keep-twice"), also when
//     they come from two different lists;
//   - each scriptlet call gets { name: <scriptlet name>, uniqueId: "<list id>:<row number>" }. The pair
//     only feeds the scriptlets' own run-once guard (uniqueId+name+args) and prevent-element-src-loading's
//     marker attribute; the list id keeps two lists' rows apart, the name is a valid attribute name (a bare
//     number, used up to 10.4.4, is not — setAttribute() threw for that one scriptlet).
//
// Public interface:
//   DISPATCH_LAYOUT_CONFIG                     — every constant of the layout, one place
//   encodeDispatchTables(byHostname)           — Map<hostname, [fnIndex, ruleId, args[]][]> -> packed tables
//   renderScriptletFile(fnNames, tables, hasEntities, fileTag) — packed tables + used names -> data file text
//   renderLibraryFile(entries)                 — [[name, functionSource], ...] -> library file text
//   renderLibraryEndFile()                     — end file text (removes the library global)
//   decodeDispatchSource(text)                 — data file text -> { hostnames, entries, fnNames, fileTag, ... }
//   decodeLibrarySource(text)                  — library file text -> { names, fnsText }
//   verifyRoundTrip(byHostname, text)          — throws unless decode(text) holds exactly the input table
//   splitSitesAndEntities(text)                — (10.5.6) data file text -> its site keys + its "name.*"-only file
//   (11.0.0) Every renderer/decoder takes an optional LAST argument `libGlobal` (default SCRIPTLET_LIBRARY_GLOBAL): the
//   page-global name the library publishes under. A registration that can run on the SAME page as the SITES registration
//   (Seamless surfing's cookie-consent sets, js/data/cookie-notice-sets.js) needs its own: "a second copy of the library
//   keeps the first", so with a shared name the registration that ran first would decide which functions the other's data
//   files find. The default output is byte-identical to 10.7.16 (tools/verify-build-unchanged.mjs).
// Dependencies: js/data/scriptlet-library.js (the global's name), js/data/scriptlet-policy.js (the run-time guard). Pure functions: every Map/Array is allocated
// inside the call and nothing is kept afterwards, so there is nothing to initialise, clear or release.

import { SCRIPTLET_LIBRARY_GLOBAL } from '../../js/data/scriptlet-library.js';
import { scriptletPolicyViolation } from '../../js/data/scriptlet-policy.js';
import { SCRIPTLET_LIBRARY_NOTICE } from './third-party-credits.mjs';

/******************************************************************************/
// Single place for every constant, limit and format token of the layout.
// Changing any of them changes the generated file format: the decoders and the lookup code in
// renderLookup() all read from here, so they cannot drift apart.
/******************************************************************************/
// (11.0.0) The three global-dependent tokens, for any library global name (the config's own values use the default).
function fileHeadFor(g) {
    return `(()=>{"use strict";const LIB=globalThis[${JSON.stringify(g)}];if(typeof LIB!=="object"||LIB===null)return;const N=`;
}
function libHeadFor(g) { return `(()=>{"use strict";const K=${JSON.stringify(g)},N=`; }
function libEndFor(g) { return `(()=>{"use strict";delete globalThis[${JSON.stringify(g)}]})();`; }
// A library global name: a plain identifier-like property name (it is embedded in generated code as a JSON string).
const LIB_GLOBAL_RE = /^__[A-Za-z0-9_]+$/;
function assertLibGlobal(g, where) {
    if ( typeof g !== 'string' || LIB_GLOBAL_RE.test(g) === false ) {
        throw new TypeError(`${where}: invalid library global name ${JSON.stringify(g)}`);
    }
    return g;
}
export const DISPATCH_LAYOUT_CONFIG = Object.freeze({
    // Identifiers of the four data constants inside the generated block. The block is a nested scope.
    IDENT_HOSTNAMES: 'H',   // sorted JSON array of dispatch keys
    IDENT_ARG_POOL:  'G',   // JSON array of distinct argument strings
    IDENT_HOST_REFS: 'RS',  // packed string: per hostname, the row numbers that apply to it
    IDENT_ROWS:      'LS',  // packed string: per row, "nameIndex,argPoolIndex,argPoolIndex,..."
    // Separators inside the two packed strings. Their payload is decimal digits only (indexes), so a
    // separator can never occur inside a value and no escaping is needed.
    SEP_ITEM: ';',          // between hostnames (RS) or between rows (LS)
    SEP_NUM:  ',',          // between numbers inside one item
    // Separator between the list id and the row number in a call's uniqueId.
    UNIQUE_ID_SEP: ':',
    // ── data file (per list) ──
    // Head: fetch the library, stop silently without it, then the JSON array of used names (N).
    FILE_HEAD:  fileHeadFor(SCRIPTLET_LIBRARY_GLOBAL),
    TAG_MARK:   ',U=',            // between the names array and the uniqueId prefix (a JSON string)
    BLOCK_MARK: ';{const ',       // after the uniqueId prefix, start of the data block
    DATA_TAIL:  ';let P,Q;',      // after the four data constants, before the lookup code
    FILE_TAIL:  '}})();',         // after the lookup code (closes block + file closure)
    // ── library file (shared) ──
    // Credit comment first (AdGuard Scriptlets / uBlock Origin, tools/build/third-party-credits.mjs), then the head,
    // the JSON array of names (N), LIB_BODIES_MARK, the function sources, LIB_TAIL.
    LIB_NOTICE:      SCRIPTLET_LIBRARY_NOTICE,
    LIB_HEAD:        libHeadFor(SCRIPTLET_LIBRARY_GLOBAL),
    LIB_BODIES_MARK: ',F=[',
    // Publishes {name: function} once; a second copy of the library in the same page keeps the first.
    // (10.4.6) Each function is published wrapped in the run-time policy guard: V is the SOURCE TEXT of
    // js/data/scriptlet-policy.js scriptletPolicyViolation() (self-contained by design), so a rule with code as an
    // argument or an inserted external URL never runs, even if it reached a data file past the build's own gate.
    LIB_TAIL:        '];if(Object.prototype.hasOwnProperty.call(globalThis,K))return;const L=Object.create(null);' +
                     `const V=${scriptletPolicyViolation.toString()};` +
                     'const W=(n,f)=>function(s,a){if(V(n,a)!==null)return;return f.call(this,s,a)};' +
                     'for(let i=0;i<N.length;i++)L[N[i]]=W(N[i],F[i]);' +
                     'Object.defineProperty(globalThis,K,{value:Object.freeze(L),configurable:true,enumerable:false,writable:false})})();',
    // ── end file (shared) ──
    LIB_END: libEndFor(SCRIPTLET_LIBRARY_GLOBAL),
    // A scriptlet name is also used as an attribute name by prevent-element-src-loading: letters, digits,
    // "-", "_", "." only, starting with a letter.
    SCRIPTLET_NAME_RE: /^[A-Za-z][\w.-]*$/,
    // A dispatch key is compared with a page hostname (or is a "name.*" entity). A key containing any of
    // these can never equal one: whitespace, bracket/regex/modifier syntax, a leading "~" negation, a
    // port, quotes. Such a key is dead weight and means the rule parser regressed, so the build stops.
    UNMATCHABLE_KEY_RE: /[\s[\]/$,()|^!@#%?=&:;'"<>\\{}]|^~/,
    // Guard limits: a runaway or corrupt input must fail the build, never produce an enormous file.
    MAX_HOSTNAMES: 200000,
    MAX_ROWS:      200000,
    MAX_ARG_POOL:  200000,
    MAX_LIBRARY_FUNCTIONS: 2000,
    // (10.5.6) A dispatch key ending in this is an entity ("name.*", any TLD); every other key is a site.
    ENTITY_SUFFIX: '.*',
});

/******************************************************************************/
// Input validation (module boundary) — fail loudly, never ship a partial table.
/******************************************************************************/
function assertValidInput(byHostname) {
    const L = DISPATCH_LAYOUT_CONFIG;
    if ( byHostname instanceof Map === false ) {
        throw new TypeError('encodeDispatchTables: byHostname must be a Map');
    }
    if ( byHostname.size === 0 || byHostname.size > L.MAX_HOSTNAMES ) {
        throw new RangeError(`encodeDispatchTables: ${byHostname.size} hostnames is outside 1..${L.MAX_HOSTNAMES}`);
    }
    for ( const [ hostname, entries ] of byHostname ) {
        if ( typeof hostname !== 'string' || hostname === '' ) {
            throw new TypeError(`encodeDispatchTables: invalid hostname key ${JSON.stringify(hostname)}`);
        }
        if ( L.UNMATCHABLE_KEY_RE.test(hostname) ) {
            throw new Error(`encodeDispatchTables: dispatch key ${JSON.stringify(hostname)} can never match a hostname`);
        }
        if ( Array.isArray(entries) === false || entries.length === 0 ) {
            throw new TypeError(`encodeDispatchTables: "${hostname}" has no entries`);
        }
        for ( const entry of entries ) {
            const [ fnIndex, ruleId, args ] = Array.isArray(entry) ? entry : [];
            if ( Number.isInteger(fnIndex) === false || fnIndex < 0 ||
                 Number.isInteger(ruleId) === false || ruleId < 0 ||
                 Array.isArray(args) === false || args.some(a => typeof a !== 'string') ) {
                throw new TypeError(`encodeDispatchTables: malformed entry under "${hostname}": ${JSON.stringify(entry)}`);
            }
        }
    }
}

/******************************************************************************/
// Encoder.
/******************************************************************************/
export function encodeDispatchTables(byHostname) {
    const L = DISPATCH_LAYOUT_CONFIG;
    assertValidInput(byHostname);

    // 1. Rows: one per rule id, ordered by ascending rule id (= source order). A rule id must always
    //    carry the same function and arguments, whatever hostname lists it.
    const ruleById = new Map();
    for ( const entries of byHostname.values() ) {
        for ( const [ fnIndex, ruleId, args ] of entries ) {
            const known = ruleById.get(ruleId);
            if ( known === undefined ) {
                ruleById.set(ruleId, { fnIndex, args });
            } else if ( known.fnIndex !== fnIndex || JSON.stringify(known.args) !== JSON.stringify(args) ) {
                throw new Error(`encodeDispatchTables: rule id ${ruleId} carries two different scriptlets`);
            }
        }
    }
    if ( ruleById.size > L.MAX_ROWS ) {
        throw new RangeError(`encodeDispatchTables: ${ruleById.size} rows exceeds ${L.MAX_ROWS}`);
    }
    const ruleIds = [ ...ruleById.keys() ].sort((a, b) => a - b);
    const rowByRuleId = new Map(ruleIds.map((id, row) => [ id, row ]));

    // 2. Argument pool: distinct strings, most frequently used first (shorter indexes), ties by text so the
    //    output is deterministic.
    const frequency = new Map();
    for ( const { args } of ruleById.values() ) {
        for ( const a of args ) { frequency.set(a, (frequency.get(a) ?? 0) + 1); }
    }
    if ( frequency.size > L.MAX_ARG_POOL ) {
        throw new RangeError(`encodeDispatchTables: ${frequency.size} distinct arguments exceeds ${L.MAX_ARG_POOL}`);
    }
    const argPool = [ ...frequency.keys() ].sort((a, b) => (frequency.get(b) - frequency.get(a)) || (a < b ? -1 : 1));
    const poolIndex = new Map(argPool.map((a, i) => [ a, i ]));

    // 3. Packed strings. Hostnames use default (UTF-16 code unit) order — the same order the generated
    //    lookup's `<` comparison binary-searches by.
    const hostnames = [ ...byHostname.keys() ].sort();
    const rows = ruleIds.map(id => {
        const { fnIndex, args } = ruleById.get(id);
        return [ fnIndex, ...args.map(a => poolIndex.get(a)) ].join(L.SEP_NUM);
    }).join(L.SEP_ITEM);
    const hostRefs = hostnames.map(h =>
        byHostname.get(h).map(([ , ruleId ]) => rowByRuleId.get(ruleId)).join(L.SEP_NUM)
    ).join(L.SEP_ITEM);

    return { hostnames, argPool, hostRefs, rows, rowCount: ruleIds.length };
}

/******************************************************************************/
// Lookup code (the only runtime logic of the layout). Local names (h, t, f, p, i, j, l, r, m, x, q, k, n, P, Q)
// are private to the generated block. Same walk as the previous layout.
/******************************************************************************/
function renderLookup(hasEntities) {
    const L = DISPATCH_LAYOUT_CONFIG;
    const H = L.IDENT_HOSTNAMES, G = L.IDENT_ARG_POOL, RS = L.IDENT_HOST_REFS, LS = L.IDENT_ROWS;
    // At each real hostname level `p` (e.g. "kat.com") also try that level's own entity form: trim the last
    // label ("kat.com" -> "kat") and look up "kat.*". Emitted only for files that contain an entity key.
    const entityStep = hasEntities ? 'const j=p.lastIndexOf(".");if(j>=0)f(p.slice(0,j)+".*");' : '';
    return [
        // (11.1.6, scriptlet audit finding 8) A frame without an address (about:blank, srcdoc) has no hostname but has
        // inherited its creator's origin — the same thing Chrome's matchOriginAsFallback injected it by — so its site is
        // read from self.origin then ("null" for a sandboxed frame: no site, no rules).
        'const h=location.hostname||(()=>{try{return new URL(self.origin).hostname}catch{return""}})();const t=new Set();',
        // f(s): binary-search key s in the sorted array; on a hit add its row numbers to the Set t.
        `const f=s=>{let l=0,r=${H}.length;while(l<r){const m=l+r>>>1;if(${H}[m]<s)l=m+1;else r=m}`,
        `if(${H}[l]!==s)return;P??=${RS}.split("${L.SEP_ITEM}");for(const x of P[l].split("${L.SEP_NUM}"))t.add(+x)};`,
        // Walk: the hostname, then each parent domain, stopping before a bare TLD.
        `let p=h;for(;;){f(p);${entityStep}const i=p.indexOf(".");if(i<0||!p.slice(i+1).includes("."))break;p=p.slice(i+1)}`,
        // Run each collected row once, each call isolated by its own try/catch. The function comes from the
        // shared library by name (N = the names this file uses, U = "<list id>:").
        `if(t.size){Q??=${LS}.split("${L.SEP_ITEM}");for(const r of t){const q=Q[r].split("${L.SEP_NUM}");`,
        `try{const n=N[q[0]];LIB[n]({name:n,uniqueId:U+r},q.slice(1).map(k=>${G}[k]))}catch(e){}}}`,
    ].join('');
}

/******************************************************************************/
// Renderers.
/******************************************************************************/
function assertScriptletNames(names, where) {
    const L = DISPATCH_LAYOUT_CONFIG;
    if ( Array.isArray(names) === false || names.length === 0 ) {
        throw new TypeError(`${where}: names must be a non-empty array`);
    }
    const bad = names.find(n => typeof n !== 'string' || L.SCRIPTLET_NAME_RE.test(n) === false);
    if ( bad !== undefined ) { throw new TypeError(`${where}: invalid scriptlet name ${JSON.stringify(bad)}`); }
    if ( new Set(names).size !== names.length ) { throw new Error(`${where}: duplicate scriptlet name`); }
}

// Per-list data file. fnNames[i] is the library name of the function the rows call with name index i;
// fileTag is the list id (prefix of every uniqueId of this file).
export function renderScriptletFile(fnNames, tables, hasEntities, fileTag, libGlobal = SCRIPTLET_LIBRARY_GLOBAL) {
    const L = DISPATCH_LAYOUT_CONFIG;
    const head = fileHeadFor(assertLibGlobal(libGlobal, 'renderScriptletFile'));
    assertScriptletNames(fnNames, 'renderScriptletFile');
    if ( typeof fileTag !== 'string' || fileTag === '' || fileTag.includes(L.UNIQUE_ID_SEP) ) {
        throw new TypeError(`renderScriptletFile: fileTag must be a non-empty string without "${L.UNIQUE_ID_SEP}"`);
    }
    const data =
        `${L.IDENT_HOSTNAMES}=${JSON.stringify(tables.hostnames)},` +
        `${L.IDENT_ARG_POOL}=${JSON.stringify(tables.argPool)},` +
        `${L.IDENT_HOST_REFS}=${JSON.stringify(tables.hostRefs)},` +
        `${L.IDENT_ROWS}=${JSON.stringify(tables.rows)}`;
    return head + JSON.stringify(fnNames) + L.TAG_MARK + JSON.stringify(fileTag + L.UNIQUE_ID_SEP) +
        L.BLOCK_MARK + data + L.DATA_TAIL + renderLookup(hasEntities === true) + L.FILE_TAIL;
}

// Shared library file: entries = [[name, functionSource], ...]. Written in the given order (the build sorts
// by name, so the file is deterministic).
export function renderLibraryFile(entries, libGlobal = SCRIPTLET_LIBRARY_GLOBAL) {
    const L = DISPATCH_LAYOUT_CONFIG;
    const head = libHeadFor(assertLibGlobal(libGlobal, 'renderLibraryFile'));
    if ( Array.isArray(entries) === false || entries.length > L.MAX_LIBRARY_FUNCTIONS ) {
        throw new RangeError(`renderLibraryFile: entries must be an array of at most ${L.MAX_LIBRARY_FUNCTIONS}`);
    }
    const names = entries.map(e => Array.isArray(e) ? e[0] : undefined);
    if ( names.length > 0 ) { assertScriptletNames(names, 'renderLibraryFile'); }
    const bodies = entries.map(([ name, body ]) => {
        if ( typeof body !== 'string' || body.trim() === '' ) {
            throw new TypeError(`renderLibraryFile: "${name}" has no function source`);
        }
        return body;
    });
    const fnsText = bodies.join(',');
    // The decoder anchors on the first occurrence of the tail: the function sources must never contain it.
    if ( fnsText.includes(L.LIB_TAIL) ) {
        throw new Error('renderLibraryFile: function sources contain the reserved library tail');
    }
    return L.LIB_NOTICE + head + JSON.stringify(names) + L.LIB_BODIES_MARK + fnsText + L.LIB_TAIL;
}

export function renderLibraryEndFile(libGlobal = SCRIPTLET_LIBRARY_GLOBAL) {
    return libEndFor(assertLibGlobal(libGlobal, 'renderLibraryEndFile'));
}

/******************************************************************************/
// Decoders.
/******************************************************************************/
// End index (exclusive) of the JSON value (array, object or string) that starts at `pos`.
function scanJsonValueEnd(text, pos) {
    let depth = 0, inString = false, escaped = false;
    for ( let i = pos; i < text.length; i++ ) {
        const c = text[i];
        if ( inString ) {
            if ( escaped ) { escaped = false; }
            else if ( c === '\\' ) { escaped = true; }
            else if ( c === '"' ) { inString = false; if ( depth === 0 ) { return i + 1; } }
            continue;
        }
        if ( c === '"' ) { inString = true; continue; }
        if ( c === '[' || c === '{' ) { depth++; continue; }
        if ( c === ']' || c === '}' ) { depth--; if ( depth === 0 ) { return i + 1; } }
    }
    throw new Error('decodeDispatchSource: unterminated JSON value');
}

// Reads a JSON value at `pos` and returns [ value, nextPos ].
function readJsonAt(text, pos) {
    const end = scanJsonValueEnd(text, pos);
    return [ JSON.parse(text.slice(pos, end)), end ];
}

// Reads `<ident>=<json>` at `pos` and returns [ value, nextPos ].
function readConstant(text, pos, ident) {
    const prefix = `${ident}=`;
    if ( text.startsWith(prefix, pos) === false ) {
        throw new Error(`decodeDispatchSource: expected "${prefix}" at offset ${pos}`);
    }
    return readJsonAt(text, pos + prefix.length);
}

function expectAt(text, pos, token, what) {
    if ( text.startsWith(token, pos) === false ) { throw new Error(`decodeDispatchSource: ${what} not found at offset ${pos}`); }
    return pos + token.length;
}

export function decodeDispatchSource(text, libGlobal = SCRIPTLET_LIBRARY_GLOBAL) {
    const L = DISPATCH_LAYOUT_CONFIG;
    const head = fileHeadFor(assertLibGlobal(libGlobal, 'decodeDispatchSource'));
    if ( typeof text !== 'string' || text.startsWith(head) === false ) {
        throw new Error('decodeDispatchSource: not a generated scriptlet data file (unexpected head — a pre-library ' +
            'file carries its own functions and is not this layout)');
    }
    let pos = head.length;
    let fnNames, tag;
    [ fnNames, pos ] = readJsonAt(text, pos);
    pos = expectAt(text, pos, L.TAG_MARK, 'uniqueId prefix');
    [ tag, pos ] = readJsonAt(text, pos);
    pos = expectAt(text, pos, L.BLOCK_MARK, 'data block');
    assertScriptletNames(fnNames, 'decodeDispatchSource');
    if ( typeof tag !== 'string' || tag.endsWith(L.UNIQUE_ID_SEP) === false || tag.length < 2 ) {
        throw new Error('decodeDispatchSource: malformed uniqueId prefix');
    }

    let hostnames, argPool, hostRefs, rows;
    [ hostnames, pos ] = readConstant(text, pos, L.IDENT_HOSTNAMES);
    if ( text[pos++] !== ',' ) { throw new Error('decodeDispatchSource: missing separator after hostnames'); }
    [ argPool, pos ] = readConstant(text, pos, L.IDENT_ARG_POOL);
    if ( text[pos++] !== ',' ) { throw new Error('decodeDispatchSource: missing separator after argument pool'); }
    [ hostRefs, pos ] = readConstant(text, pos, L.IDENT_HOST_REFS);
    if ( text[pos++] !== ',' ) { throw new Error('decodeDispatchSource: missing separator after host references'); }
    [ rows, pos ] = readConstant(text, pos, L.IDENT_ROWS);
    pos = expectAt(text, pos, L.DATA_TAIL, 'end of the data constants');

    // The rest must be EXACTLY the lookup code this module renders (with or without the entity step).
    const rest = text.slice(pos);
    let hasEntities;
    for ( const candidate of [ true, false ] ) {
        if ( rest === renderLookup(candidate) + L.FILE_TAIL ) { hasEntities = candidate; break; }
    }
    if ( hasEntities === undefined ) {
        throw new Error('decodeDispatchSource: lookup code differs from this layout module (file and module out of sync)');
    }

    // Structural validation of the packed tables.
    if ( Array.isArray(hostnames) === false || Array.isArray(argPool) === false ||
         typeof hostRefs !== 'string' || typeof rows !== 'string' ) {
        throw new Error('decodeDispatchSource: data constants have the wrong types');
    }
    for ( let i = 1; i < hostnames.length; i++ ) {
        if ( hostnames[i - 1] >= hostnames[i] ) {
            throw new Error(`decodeDispatchSource: hostnames not strictly sorted at "${hostnames[i]}"`);
        }
    }
    const rowItems = rows === '' ? [] : rows.split(L.SEP_ITEM);
    const rowTable = rowItems.map((item, row) => {
        const nums = item.split(L.SEP_NUM).map(Number);
        if ( nums.some(n => Number.isInteger(n) === false || n < 0) ) {
            throw new Error(`decodeDispatchSource: row ${row} is malformed: "${item}"`);
        }
        const [ fnIndex, ...argIdx ] = nums;
        if ( fnIndex >= fnNames.length ) {
            throw new Error(`decodeDispatchSource: row ${row} references name ${fnIndex} outside 0..${fnNames.length - 1}`);
        }
        if ( argIdx.some(k => k >= argPool.length) ) {
            throw new Error(`decodeDispatchSource: row ${row} references an argument outside the pool`);
        }
        return { fnIndex, args: argIdx.map(k => argPool[k]) };
    });
    const refItems = hostRefs === '' ? [] : hostRefs.split(L.SEP_ITEM);
    if ( refItems.length !== hostnames.length ) {
        throw new Error(`decodeDispatchSource: ${hostnames.length} hostnames but ${refItems.length} reference lists`);
    }
    const entries = new Map();
    hostnames.forEach((hostname, i) => {
        entries.set(hostname, refItems[i].split(L.SEP_NUM).map(Number).map(row => {
            if ( Number.isInteger(row) === false || row < 0 || row >= rowTable.length ) {
                throw new Error(`decodeDispatchSource: "${hostname}" references row ${row} outside 0..${rowTable.length - 1}`);
            }
            return [ rowTable[row].fnIndex, row, rowTable[row].args ];
        }));
    });
    return { hostnames, argPool, rowTable, entries, hasEntities, fnNames, fileTag: tag.slice(0, -L.UNIQUE_ID_SEP.length) };
}

// Library file -> the names it publishes (in order) and the raw function sources text.
export function decodeLibrarySource(text, libGlobal = SCRIPTLET_LIBRARY_GLOBAL) {
    const L = DISPATCH_LAYOUT_CONFIG;
    const libHead = libHeadFor(assertLibGlobal(libGlobal, 'decodeLibrarySource'));
    // A library written before 10.7.7 has no credit comment; both forms decode.
    const headAt = typeof text === 'string' && text.startsWith(L.LIB_NOTICE) ? L.LIB_NOTICE.length : 0;
    if ( typeof text !== 'string' || text.startsWith(libHead, headAt) === false ) {
        throw new Error('decodeLibrarySource: not a generated scriptlet library (unexpected head)');
    }
    let [ names, pos ] = readJsonAt(text, headAt + libHead.length);
    pos = expectAt(text, pos, L.LIB_BODIES_MARK, 'function sources');
    const tailAt = text.indexOf(L.LIB_TAIL, pos);
    if ( tailAt < 0 || tailAt + L.LIB_TAIL.length !== text.length ) {
        throw new Error('decodeLibrarySource: library tail missing or followed by extra text');
    }
    if ( Array.isArray(names) === false ) { throw new Error('decodeLibrarySource: names is not an array'); }
    if ( names.length > 0 ) { assertScriptletNames(names, 'decodeLibrarySource'); }
    return { names, fnsText: text.slice(pos, tailAt) };
}

/******************************************************************************/
// Round-trip guard (C13a): the build calls this on every file before writing it.
/******************************************************************************/
export function verifyRoundTrip(byHostname, text, libGlobal = SCRIPTLET_LIBRARY_GLOBAL) {
    const decoded = decodeDispatchSource(text, libGlobal);
    if ( decoded.entries.size !== byHostname.size ) {
        throw new Error(`verifyRoundTrip: ${byHostname.size} hostnames in, ${decoded.entries.size} out`);
    }
    const rowByRuleId = new Map();   // input rule id -> decoded row (must stay one-to-one)
    const ruleIdByRow = new Map();
    for ( const [ hostname, input ] of byHostname ) {
        const output = decoded.entries.get(hostname);
        if ( output === undefined || output.length !== input.length ) {
            throw new Error(`verifyRoundTrip: entry list for "${hostname}" differs in length`);
        }
        input.forEach(([ fnIndex, ruleId, args ], i) => {
            const [ outFn, outRow, outArgs ] = output[i];
            if ( outFn !== fnIndex || JSON.stringify(outArgs) !== JSON.stringify(args) ) {
                throw new Error(`verifyRoundTrip: entry ${i} under "${hostname}" differs`);
            }
            if ( (rowByRuleId.get(ruleId) ?? outRow) !== outRow || (ruleIdByRow.get(outRow) ?? ruleId) !== ruleId ) {
                throw new Error(`verifyRoundTrip: rule id ${ruleId} and row ${outRow} are not one-to-one`);
            }
            rowByRuleId.set(ruleId, outRow);
            ruleIdByRow.set(outRow, ruleId);
        });
    }
}

/******************************************************************************/
// (10.5.6) Site / entity split — see js/data/scriptlet-library.js for the two registrations it feeds.
// From ONE generated data file (so a carried-over list is split exactly like a freshly built one):
//   sites      — every non-entity key, sorted (the SITES registration is limited to these sites);
//   entityCode — a data file holding ONLY the "name.*" keys and the rows they reference (null when the list has
//                none), names pruned to the ones those rows call; same file tag, same lookup walk;
//   entityNames — the library names entityCode calls (the entity library is their union over all lists).
// On a page that is not one of `sites` (nor a subdomain of one) no site key can match, so entityCode collects
// exactly the rows the full file collects there. Pure: nothing is kept between calls.
/******************************************************************************/
export function splitSitesAndEntities(text) {
    const L = DISPATCH_LAYOUT_CONFIG;
    const decoded = decodeDispatchSource(text);
    const sites = [];
    const entityTable = new Map();   // key -> [ fnIndex (remapped below), row, args ]
    for ( const [ key, entries ] of decoded.entries ) {
        if ( key.endsWith(L.ENTITY_SUFFIX) ) { entityTable.set(key, entries); } else { sites.push(key); }
    }
    sites.sort();
    if ( entityTable.size === 0 ) { return { sites, entityCode: null, entityNames: [] }; }

    // Keep only the names the entity rows call, in their original order, and renumber the function index.
    const usedFn = new Set();
    for ( const entries of entityTable.values() ) { for ( const [ fnIndex ] of entries ) { usedFn.add(fnIndex); } }
    const keptFn = [ ...usedFn ].sort((a, b) => a - b);
    const newFnIndex = new Map(keptFn.map((fn, i) => [ fn, i ]));
    const entityNames = keptFn.map(fn => decoded.fnNames[fn]);
    const byHostname = new Map();
    for ( const [ key, entries ] of entityTable ) {
        byHostname.set(key, entries.map(([ fnIndex, row, args ]) => [ newFnIndex.get(fnIndex), row, args ]));
    }
    const entityCode = renderScriptletFile(entityNames, encodeDispatchTables(byHostname), true, decoded.fileTag);
    verifyRoundTrip(byHostname, entityCode);   // C13a: the written entity file holds exactly this table
    return { sites, entityCode, entityNames };
}
