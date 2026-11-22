#!/usr/bin/env node
// check-scriptlet-exception-logic.mjs — pins the behavior of the custom-
// scriptlet EXCEPTION feature (`#@#+js(...)` / `#@%#//scriptlet(...)`,
// added in js/core/custom-scriptlets.js) against the real, live
// implementation — not a hand-maintained re-implementation that could
// silently drift from the code it's meant to guard.
//
// Imports parseScriptletLine (the single, consolidated parser for BOTH
// uBO and AdGuard syntax — see that function's own header comment for
// why the two were merged) and collectMatchingRules/isSameRuleContent
// (exported for this purpose specifically — see their own comments in
// custom-scriptlets.js) and exercises every branch found during the
// exception-feature review: both rule syntaxes, apply-vs-exception dedup,
// and every hostname-hierarchy/args/name combination the cancellation
// logic has to get right.
//
// Usage: node tools/check-scriptlet-exception-logic.mjs   (also runs as
// step 13 of `npm run check` / tools/complete-check.mjs)

import assert from 'assert';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Minimal global mock — same shape tools/test-core-modules-dry-run.mjs
// already uses — so the module graph (ext.js -> ext-compat.js, then
// mode-manager.js/ruleset-manager.js pulled in transitively) can load at
// all. Nothing this check actually calls (parseScriptletLine,
// collectMatchingRules, isSameRuleContent) is async or touches
// storage/DNR — this mock only needs to satisfy *module-load-time*
// references, not runtime behavior.
const store = {};
global.chrome = {
    storage: {
        local: {
            get: (key) => Promise.resolve(typeof key === 'string' ? { [key]: store[key] } : { ...store }),
            set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
            remove: (keys) => { for ( const k of [].concat(keys) ) { delete store[k]; } return Promise.resolve(); },
        },
        session: {
            get: (key) => Promise.resolve(typeof key === 'string' ? { [key]: store[key] } : { ...store }),
            set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
            remove: (keys) => { for ( const k of [].concat(keys) ) { delete store[k]; } return Promise.resolve(); },
        },
    },
    runtime: { getURL: p => `chrome-extension://test/${p}` },
    declarativeNetRequest: {
        getDynamicRules: () => Promise.resolve([]),
        updateDynamicRules: () => Promise.resolve(),
        getSessionRules: () => Promise.resolve([]),
        updateSessionRules: () => Promise.resolve(),
    },
};
global.browser = global.chrome;
global.self = global;

const {
    parseScriptletLine,
    collectMatchingRules,
    isSameRuleContent,
} = await import(`${ROOT}/js/core/custom-scriptlets.js?t=${Date.now()}`);

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  PASS: ${name}`);
    } catch (err) {
        failures++;
        console.log(`  FAIL: ${name}`);
        console.log(`    ${err.stack ?? err.message}`);
    }
}

function section(name) { console.log(`\n── ${name} `.padEnd(70, '─')); }

// Builds the same Map<hostname, rule[]> shape buildRuleIndex() (internal,
// not exported — see collectMatchingRules()'s own comment on why the
// index is built literally here instead) produces, so collectMatchingRules()
// receives exactly the input shape it expects in production.
function indexOf(rules) {
    const index = new Map();
    for ( const rule of rules ) {
        const hostname = rule.hostname || '*';
        if ( index.has(hostname) === false ) { index.set(hostname, []); }
        index.get(hostname).push(rule);
    }
    return index;
}

function namesMatched(rules, hostname) {
    return collectMatchingRules(indexOf(rules), hostname).map(r => r.name).sort();
}

/******************************************************************************/
section('parseScriptletLine() — uBO syntax (##+js / #@#+js)');
/******************************************************************************/

check('apply rule parses with exception:false', () => {
    const r = parseScriptletLine('youtube.com##+js(noeval)');
    assert.deepStrictEqual(r, { rules: [ { hostname: 'youtube.com', name: 'noeval', args: [], exception: false } ] });
});

check('exception rule parses with exception:true', () => {
    const r = parseScriptletLine('youtube.com#@#+js(noeval)');
    assert.deepStrictEqual(r, { rules: [ { hostname: 'youtube.com', name: 'noeval', args: [], exception: true } ] });
});

check('exception rule with args', () => {
    const r = parseScriptletLine("example.com#@#+js(set-constant, foo, 'true')");
    assert.deepStrictEqual(r, { rules: [ { hostname: 'example.com', name: 'set-constant', args: [ 'foo', 'true' ], exception: true } ] });
});

check('exception rule, wildcard "*" hostname allowed', () => {
    const r = parseScriptletLine('*#@#+js(noeval)');
    assert.deepStrictEqual(r, { rules: [ { hostname: '*', name: 'noeval', args: [], exception: true } ] });
});

check('bare ~ hostname rejected with an explicit error (not silent null)', () => {
    const r = parseScriptletLine('~#@#+js(noeval)');
    assert.ok(r && r.error, 'expected an { error } result');
});

check('malformed (missing scriptlet name) rejected with an explicit error', () => {
    const r = parseScriptletLine('example.com#@#+js()');
    assert.ok(r && r.error, 'expected an { error } result');
});

check('plain cosmetic line does not match (no false positive)', () => {
    assert.strictEqual(parseScriptletLine('example.com##.ad-banner'), null);
});

check('NEW: multi-domain uBO syntax now works, same as AdGuard already did', () => {
    const r = parseScriptletLine('a.com,b.com##+js(noeval)');
    assert.deepStrictEqual(r, { rules: [
        { hostname: 'a.com', name: 'noeval', args: [], exception: false },
        { hostname: 'b.com', name: 'noeval', args: [], exception: false },
    ] });
});

check('BUG FIX: quoted arg containing a literal comma now parses correctly in uBO syntax too (previously mis-split — same bug the AdGuard parser never had)', () => {
    const r = parseScriptletLine("example.com##+js(json-prune, 'a,b', c)");
    assert.deepStrictEqual(r, { rules: [ { hostname: 'example.com', name: 'json-prune', args: [ 'a,b', 'c' ], exception: false } ] });
});

/******************************************************************************/
section('parseScriptletLine() — AdGuard syntax (%# / #@%#)');
/******************************************************************************/

check('apply rule parses with exception:false', () => {
    const r = parseScriptletLine("youtube.com#%#//scriptlet('noeval')");
    assert.deepStrictEqual(r, { rules: [ { hostname: 'youtube.com', name: 'noeval', args: [], exception: false } ] });
});

check('exception rule parses with exception:true', () => {
    const r = parseScriptletLine("youtube.com#@%#//scriptlet('noeval')");
    assert.deepStrictEqual(r, { rules: [ { hostname: 'youtube.com', name: 'noeval', args: [], exception: true } ] });
});

check('multi-domain exception expansion carries the flag to every hostname', () => {
    const r = parseScriptletLine("a.com,b.com#@%#//scriptlet('noeval')");
    assert.deepStrictEqual(r, { rules: [
        { hostname: 'a.com', name: 'noeval', args: [], exception: true },
        { hostname: 'b.com', name: 'noeval', args: [], exception: true },
    ] });
});

check('quoted args with internal comma not split, on an exception rule', () => {
    const r = parseScriptletLine("example.com#@%#//scriptlet('json-prune', 'a,b', 'c')");
    assert.deepStrictEqual(r, { rules: [ { hostname: 'example.com', name: 'json-prune', args: [ 'a,b', 'c' ], exception: true } ] });
});

check('~-prefixed exception DOMAIN still rejected regardless of #@%# exception-RULE syntax', () => {
    const r = parseScriptletLine("~sub.example.com#@%#//scriptlet('noeval')");
    assert.ok(r && r.error, 'expected an { error } result');
});

check('plain cosmetic line does not match (no false positive)', () => {
    assert.strictEqual(parseScriptletLine('example.com##.ad-banner'), null);
});

check('both syntaxes on the same hostname/name/args produce byte-identical rule shape', () => {
    const ubo = parseScriptletLine('example.com##+js(noeval)');
    const adg = parseScriptletLine("example.com#%#//scriptlet('noeval')");
    assert.deepStrictEqual(ubo, adg);
});

/******************************************************************************/
section('isSameRuleContent() — apply/exception must never dedup together');
/******************************************************************************/

check('identical hostname/name/args but opposite exception flags are NOT the same rule', () => {
    assert.strictEqual(
        isSameRuleContent(
            { hostname: 'example.com', name: 'noeval', args: [] },
            { hostname: 'example.com', name: 'noeval', args: [], exception: true },
        ),
        false,
    );
});

check('two identical apply rules are still deduped (pre-existing behavior unchanged)', () => {
    assert.strictEqual(
        isSameRuleContent(
            { hostname: 'example.com', name: 'noeval', args: [] },
            { hostname: 'example.com', name: 'noeval', args: [] },
        ),
        true,
    );
});

check('two identical exception rules are deduped', () => {
    assert.strictEqual(
        isSameRuleContent(
            { hostname: 'example.com', name: 'noeval', args: [], exception: true },
            { hostname: 'example.com', name: 'noeval', args: [], exception: true },
        ),
        true,
    );
});

check('missing exception field treated the same as exception:false', () => {
    assert.strictEqual(
        isSameRuleContent(
            { hostname: 'example.com', name: 'noeval', args: [] },
            { hostname: 'example.com', name: 'noeval', args: [], exception: false },
        ),
        true,
    );
});

/******************************************************************************/
section('collectMatchingRules() — exception cancellation, every branch');
/******************************************************************************/

check('same-level cancel: apply + exception on the identical hostname', () => {
    const rules = [
        { hostname: 'youtube.com', name: 'noeval', args: [] },
        { hostname: 'youtube.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'youtube.com'), []);
});

check('broader exception cancels an inherited subdomain apply rule', () => {
    const rules = [
        { hostname: 'm.youtube.com', name: 'noeval', args: [] },
        { hostname: 'youtube.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'm.youtube.com'), []);
});

check('exception scoped to one subdomain does not leak to an unrelated sibling', () => {
    const rules = [
        { hostname: 'youtube.com', name: 'noeval', args: [] },
        { hostname: 'm.youtube.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'music.youtube.com'), [ 'noeval' ]);
});

check('same exception DOES cancel the inherited broader rule when visiting its own host', () => {
    const rules = [
        { hostname: 'youtube.com', name: 'noeval', args: [] },
        { hostname: 'm.youtube.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'm.youtube.com'), []);
});

check('different args does not cancel', () => {
    const rules = [
        { hostname: 'example.com', name: 'set-constant', args: [ 'foo', 'true' ] },
        { hostname: 'example.com', name: 'set-constant', args: [ 'bar', 'true' ], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'example.com'), [ 'set-constant' ]);
});

check('different scriptlet name does not cancel', () => {
    const rules = [
        { hostname: 'example.com', name: 'noeval', args: [] },
        { hostname: 'example.com', name: 'nowebrtc', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'example.com'), [ 'noeval' ]);
});

check('global "*" apply rule cancelled by a site-specific exception on that site', () => {
    const rules = [
        { hostname: '*', name: 'noeval', args: [] },
        { hostname: 'example.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'example.com'), []);
});

check('global "*" apply rule unaffected on a site the exception does not name', () => {
    const rules = [
        { hostname: '*', name: 'noeval', args: [] },
        { hostname: 'example.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'other.com'), [ 'noeval' ]);
});

check('no exceptions present at all — fast path returns every apply rule untouched', () => {
    const rules = [
        { hostname: 'example.com', name: 'noeval', args: [] },
        { hostname: 'example.com', name: 'nowebrtc', args: [] },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'example.com'), [ 'noeval', 'nowebrtc' ]);
});

check('an exception with no matching apply rule is simply a no-op', () => {
    const rules = [
        { hostname: 'example.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'example.com'), []);
});

check('multiple apply rules — only the one an exception targets is cancelled', () => {
    const rules = [
        { hostname: 'example.com', name: 'noeval', args: [] },
        { hostname: 'example.com', name: 'nowebrtc', args: [] },
        { hostname: 'example.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'example.com'), [ 'nowebrtc' ]);
});

check('args field entirely absent is equivalent to an empty array for matching', () => {
    const rules = [
        { hostname: 'example.com', name: 'noeval' }, // no args field at all
        { hostname: 'example.com', name: 'noeval', args: [], exception: true },
    ];
    assert.deepStrictEqual(namesMatched(rules, 'example.com'), []);
});

/******************************************************************************/
console.log('');
if ( failures > 0 ) {
    console.log(`${failures} scriptlet-exception-logic check(s) FAILED.`);
    process.exit(1);
}
console.log('All scriptlet-exception-logic checks passed.');
