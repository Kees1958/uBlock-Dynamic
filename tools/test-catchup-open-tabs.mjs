#!/usr/bin/env node
// tools/test-catchup-open-tabs.mjs — (10.6.0, fix #5) scripting-manager.js's
// catchUpAlreadyOpenTabsForScriptlets(): a one-time, best-effort pass that imperatively injects the combined
// scriptlet files into already-open http(s) tabs after a genuine browser restart or install/update, since
// declarative content-script registration only affects *future* navigations.
//
// Why this needs its own test, not just a manual check: this function is deliberately coarser-grained than the
// per-list SITES/ENTITY split registerScriptletContentScripts() builds (see that function's own header comment
// in scripting-manager.js for why) — "coarser" is a specific, checkable claim (every wanted list's data file,
// combined, injected via an explicit tabId rather than a match pattern), and the eligibility gate
// (getFilteringMode(hostname) !== MODE_NONE) is a real branch that silently decides whether a tab gets anything
// at all. Both deserve a real test, not just "it runs without throwing."
//
// Drives the REAL exported catchUpAlreadyOpenTabsForScriptlets() (Part D step 15) against a minimal
// chrome/browser mock — never a reimplementation of its eligibility or file-selection logic (C21/C24).
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RULESETS = path.join(ROOT, 'rulesets');

console.log('=== catchUpAlreadyOpenTabsForScriptlets() — fix #5 one-time open-tabs catch-up ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
if ( !fs.existsSync(path.join(RULESETS, 'scriptlet-files.json')) ) {
    didNotRun('rulesets/scriptlet-files.json is missing — build the rulesets first');
}
const scriptletFiles = JSON.parse(fs.readFileSync(path.join(RULESETS, 'scriptlet-files.json'), 'utf8'));
const ORDINARY = 'ruleset_adguard_base';
if ( !scriptletFiles.some(e => e.id === ORDINARY) ) {
    didNotRun(`${ORDINARY} is not in the shipped scriptlet-files.json registry — pick another list for this check`);
}
const ordinaryEntry = scriptletFiles.find(e => e.id === ORDINARY);

// ── Minimal browser/chrome mock ───────────────────────────────────────────────
const storage = new Map();
const executeScriptCalls = [];
let tabsToReturn = [];
let executeScriptShouldThrowForTabId = null;

function mkArea() { return {
    get: async keys => {
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        return Object.fromEntries(names.filter(k => storage.has(k)).map(k => [ k, storage.get(k) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { storage.set(k, v); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { storage.delete(k); } },
    setAccessLevel: async () => {},
}; }

let enabledRulesets = [ ORDINARY ];
let registeredDirectives = new Map();
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
    storage: { local: mkArea(), session: mkArea() },
    declarativeNetRequest: {
        updateDynamicRules: async () => {}, getDynamicRules: async () => [],
        updateSessionRules: async () => {}, getSessionRules: async () => [],
        updateEnabledRulesets: async () => {},
        getEnabledRulesets: async () => enabledRulesets,
        isRegexSupported: async () => ({ isSupported: true }),
    },
    scripting: {
        getRegisteredContentScripts: async filter => {
            const all = [ ...registeredDirectives.values() ];
            return filter?.ids ? all.filter(d => filter.ids.includes(d.id)) : all;
        },
        registerContentScripts: async list => { for ( const d of list ) { registeredDirectives.set(d.id, JSON.parse(JSON.stringify(d))); } },
        updateContentScripts: async list => { for ( const d of list ) { registeredDirectives.set(d.id, JSON.parse(JSON.stringify(d))); } },
        unregisterContentScripts: async ({ ids } = {}) => { for ( const id of (ids ?? [ ...registeredDirectives.keys() ]) ) { registeredDirectives.delete(id); } },
        // The function under test — real calls recorded, not re-implemented (C24): this mock only records what
        // was asked for and optionally simulates one tab Chrome genuinely cannot inject into (GUARD check).
        executeScript: async opts => {
            executeScriptCalls.push(JSON.parse(JSON.stringify(opts)));
            if ( opts.target?.tabId === executeScriptShouldThrowForTabId ) {
                throw new Error('mock: cannot access contents of this page (fault injection)');
            }
        },
    },
    tabs: {
        query: async () => tabsToReturn,
        get: async () => ({}),
    },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {} },
    permissions: { contains: async () => true },
};
globalThis.fetch = async url => {
    const file = path.join(ROOT, String(url));
    if ( !fs.existsSync(file) ) { throw new Error(`no such shipped file: ${url}`); }
    return { json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

let manager;
try {
    manager = await import(path.join(ROOT, 'js/core/scripting-manager.js'));
} catch ( err ) {
    didNotRun(`cannot import the module under test (${err.message})`);
}
if ( typeof manager.catchUpAlreadyOpenTabsForScriptlets !== 'function' ) {
    didNotRun('scripting-manager.js does not export catchUpAlreadyOpenTabsForScriptlets — this check needs updating');
}

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}

// setFilteringMode via mode-manager's own real localRead/localWrite path: write filteringModeDetails directly to
// the mocked storage, the same shape readFilteringModeDetails() expects (unserializeModeDetails/serializeModeDetails
// in js/core/mode-manager.js) — driving the real getFilteringMode() through its real storage contract, not a
// bypassed stub of it (C24).
function setFilteringModeDetailsStorage({ none = [], basic = [] }) {
    storage.set('filteringModeDetails', { none, basic });
    storage.delete('filteringModeDetails:cache'); // not a real key; readFilteringModeDetails.cache is in-module
}

try {
    // ── 1 — scriptlet-files.json genuinely unreadable, run FIRST (before any successful fetch has had a
    //        chance to populate scripting-manager.js's own module-level scriptletFilesCache, which this test
    //        file has no exported hook to reset): returns cleanly, no throw, no calls — mirrors
    //        registerScriptletContentScriptsImpl()'s own "catch { return; }" posture for the identical fetch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network unavailable (simulated)'); };
    tabsToReturn = [ { id: 20, url: 'https://on.example/' } ];
    executeScriptCalls.length = 0;
    let threw2 = false;
    try {
        await manager.catchUpAlreadyOpenTabsForScriptlets();
    } catch {
        threw2 = true;
    }
    check('scriptlet-files.json unreadable: returns cleanly instead of throwing', threw2 === false);
    check('scriptlet-files.json unreadable: no executeScript calls attempted', executeScriptCalls.length === 0);
    globalThis.fetch = realFetch;

    // ── 2 — baseline: one eligible http(s) tab (basic filtering), one explicitly filtered-off tab (MODE_NONE),
    //        one tab with no numeric id, one tab whose URL cannot be parsed, one tab with an empty hostname.
    //        (First call with a working fetch — populates scriptletFilesCache from here on.)
    setFilteringModeDetailsStorage({ none: [ 'off.example' ], basic: [ 'all-urls' ] });
    tabsToReturn = [
        { id: 1, url: 'https://on.example/path' },          // eligible
        { id: 2, url: 'https://off.example/path' },         // MODE_NONE — must be skipped
        { url: 'https://no-id.example/' },                  // no numeric tab.id — must be skipped
        { id: 3, url: 'not-a-valid-url' },                   // unparseable — must be skipped, not throw
        { id: 4, url: 'about:blank' },                       // empty hostname after parse — must be skipped
    ];
    executeScriptCalls.length = 0;
    await manager.catchUpAlreadyOpenTabsForScriptlets();

    check('exactly one executeScript call (only the eligible tab)', executeScriptCalls.length === 1,
        `got ${executeScriptCalls.length}`);
    const call1 = executeScriptCalls[0];
    check('…targets the eligible tab\'s id', call1?.target?.tabId === 1);
    check('…targets allFrames (document_start-equivalent reach for this one-time pass)', call1?.target?.allFrames === true);
    check('…runs in the MAIN world (scriptlets need page-context access, same as the declarative registration)', call1?.world === 'MAIN');
    check('…is file-based (files, not func) — never re-parses the dispatch module\'s function bodies for this pass', Array.isArray(call1?.files));
    const { SCRIPTLET_LIBRARY_FILE, SCRIPTLET_LIBRARY_END_FILE } = await import(path.join(ROOT, 'js/data/scriptlet-library.js'));
    check('…files start with the shared scriptlet library file', call1?.files?.[0] === `/${SCRIPTLET_LIBRARY_FILE}`);
    check('…files end with the shared end file', call1?.files?.at(-1) === `/${SCRIPTLET_LIBRARY_END_FILE}`);
    check('…files include the one wanted (enabled) list\'s own data file', call1?.files?.includes(`/${ordinaryEntry.file}`));

    // ── 3 — an ALWAYS_ON_RULESETS member (ORDINARY = ruleset_adguard_base) still gets caught up even when the
    //        "enabled rulesets" list is reported empty — the SAME default-always-on fallback
    //        registerScriptletContentScriptsImpl() itself relies on at SW startup (this function is explicitly
    //        documented to pass no bypassAlwaysOnIds, since a restart/install has no in-flight toggle override
    //        to honor — see this function's own header comment). This is intended behavior, not a bug: proves
    //        getWantedScriptletEntries() is being driven for real here, not stubbed.
    enabledRulesets = [];
    tabsToReturn = [ { id: 30, url: 'https://on.example/' } ];
    executeScriptCalls.length = 0;
    await manager.catchUpAlreadyOpenTabsForScriptlets();
    check('always-on list still catches up with an empty "enabled rulesets" report', executeScriptCalls.length === 1);
    enabledRulesets = [ ORDINARY ];

    // ── 4 — fault injection: one tab's executeScript call throws (e.g. a tab Chrome refuses access to); the
    //        OTHER eligible tab must still get its own call — Promise.all over independent per-tab attempts,
    //        not a loop that aborts the whole pass on the first failure.
    tabsToReturn = [
        { id: 10, url: 'https://on.example/' },
        { id: 11, url: 'https://also-on.example/' },
    ];
    executeScriptShouldThrowForTabId = 10;
    executeScriptCalls.length = 0;
    let threw = false;
    try {
        await manager.catchUpAlreadyOpenTabsForScriptlets();
    } catch {
        threw = true;
    }
    check('fault injection: one tab\'s executeScript rejecting does not throw out of the whole pass', threw === false);
    check('fault injection: the OTHER eligible tab still got its own executeScript call',
        executeScriptCalls.some(c => c.target?.tabId === 11));
    check('fault injection: the failing tab\'s call was still attempted (not pre-filtered away)',
        executeScriptCalls.some(c => c.target?.tabId === 10));
    executeScriptShouldThrowForTabId = null;
} finally {
    // GUARD (release): nothing persistent to release — storage/registeredDirectives are this file's own local
    // Maps, discarded when the process exits; listed here for symmetry with the sibling test files' finally
    // blocks, not because anything leaks without it.
}

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — catchUpAlreadyOpenTabsForScriptlets() no longer behaves as documented.`);
    process.exit(1);
}
console.log('\nPASS: catchUpAlreadyOpenTabsForScriptlets() injects only into eligible open tabs, is fault-tolerant per-tab, and never throws on a missing data file.');
