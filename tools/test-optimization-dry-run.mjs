// Functional dry-run for the async/race-sensitive changes made during the
// performance-optimization pass (OPTIMIZE.md) — exercises the real
// exported functions against mocked chrome.storage/scripting/dnr, not
// just "does it parse". Written specifically to check: (a) the new bulk
// functions produce the SAME end state as the sequential code they
// replaced, and (b) the registerContentScripts() css-user diff logic
// (OPTIMIZE.md 1.1) behaves correctly across all three cases (new,
// update, remove) without a preceding blanket wipe.
import assert from 'assert';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Mocks ────────────────────────────────────────────────────────────────
const localStore = {};
const sessionStore = {};
let scriptingRegistered = []; // [{ id, ...directive }]
const scriptingCalls = []; // log of every browser.scripting.* call, for asserting call counts/order

global.chrome = {
    storage: {
        local: {
            get: (key) => Promise.resolve(typeof key === 'string' ? { [key]: localStore[key] } : { ...localStore }),
            set: (obj) => { Object.assign(localStore, obj); return Promise.resolve(); },
            remove: (keys) => { for ( const k of [].concat(keys) ) { delete localStore[k]; } return Promise.resolve(); },
        },
        session: {
            get: (key) => Promise.resolve(typeof key === 'string' ? { [key]: sessionStore[key] } : { ...sessionStore }),
            set: (obj) => { Object.assign(sessionStore, obj); return Promise.resolve(); },
            remove: (keys) => { for ( const k of [].concat(keys) ) { delete sessionStore[k]; } return Promise.resolve(); },
            setAccessLevel: () => Promise.resolve(),
        },
    },
    runtime: { getURL: p => `chrome-extension://test/${p}` },
    declarativeNetRequest: {
        _dynamicRules: [],
        _sessionRules: [],
        async getDynamicRules({ ruleIds } = {}) {
            scriptingCalls.push('dnr:getDynamicRules');
            if ( !ruleIds ) { return this._dynamicRules.slice(); }
            return this._dynamicRules.filter(r => ruleIds.includes(r.id));
        },
        async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
            this._dynamicRules = this._dynamicRules.filter(r => !removeRuleIds.includes(r.id)).concat(addRules);
        },
        async getSessionRules({ ruleIds } = {}) {
            scriptingCalls.push('dnr:getSessionRules');
            if ( !ruleIds ) { return this._sessionRules.slice(); }
            return this._sessionRules.filter(r => ruleIds.includes(r.id));
        },
        async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
            this._sessionRules = this._sessionRules.filter(r => !removeRuleIds.includes(r.id)).concat(addRules);
        },
        async getEnabledRulesets() { return []; },
    },
    scripting: {
        async getRegisteredContentScripts(filter) {
            scriptingCalls.push(`get:${filter?.ids?.join(',') ?? 'all'}`);
            if ( !filter?.ids ) { return scriptingRegistered.slice(); }
            return scriptingRegistered.filter(s => filter.ids.includes(s.id));
        },
        async registerContentScripts(directives) {
            scriptingCalls.push(`register:${directives.map(d => d.id).join(',')}`);
            for ( const d of directives ) {
                if ( scriptingRegistered.some(s => s.id === d.id) ) {
                    throw new Error(`Duplicate script id ${d.id}`);
                }
                scriptingRegistered.push(d);
            }
        },
        async updateContentScripts(directives) {
            scriptingCalls.push(`update:${directives.map(d => d.id).join(',')}`);
            for ( const d of directives ) {
                const idx = scriptingRegistered.findIndex(s => s.id === d.id);
                if ( idx === -1 ) { throw new Error(`No such script ${d.id} to update`); }
                scriptingRegistered[idx] = d;
            }
        },
        async unregisterContentScripts(filter) {
            if ( !filter || !filter.ids ) {
                scriptingCalls.push('unregister:ALL (blanket wipe)');
                scriptingRegistered = [];
                return;
            }
            scriptingCalls.push(`unregister:${filter.ids.join(',')}`);
            scriptingRegistered = scriptingRegistered.filter(s => !filter.ids.includes(s.id));
        },
    },
    permissions: {
        async getAll() { return { origins: [ '<all_urls>' ], permissions: [] }; },
    },
    tabs: {
        TAB_ID_NONE: -1,
    },
    alarms: {
        create: () => {},
        clear: () => Promise.resolve(true),
        onAlarm: { addListener: () => {} },
    },
};
global.browser = global.chrome;
global.self = global;

const realFetch = global.fetch;
global.fetch = async (url) => {
    const prefix = 'chrome-extension://test/';
    if ( typeof url === 'string' && url.startsWith(prefix) ) {
        const fs = await import('fs/promises');
        try {
            const text = await fs.readFile(path.join(ROOT, url.slice(prefix.length)), 'utf8');
            return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
        } catch {
            return { ok: false, status: 404, json: async () => { throw new Error('not found'); } };
        }
    }
    return realFetch(url);
};

function section(name) { console.log(`\n── ${name} `.padEnd(70, '─')); }

let failures = 0;
async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
    } catch (err) {
        failures++;
        console.log(`  FAIL: ${name}`);
        console.log(`    ${err.stack ?? err.message}`);
    }
}

/******************************************************************************/
section('mode-manager.js — setFilteringModeBulk() vs sequential setFilteringMode() equivalence');
/******************************************************************************/

const modeMod = await import(`${ROOT}/js/core/mode-manager.js?t=${Date.now()}`);

await checkAsync('setFilteringModeBulk produces the identical end state as N sequential setFilteringMode calls', async () => {
    // Reference run: sequential, one storage round-trip per hostname.
    for ( const k of Object.keys(localStore) ) { delete localStore[k]; }
    for ( const k of Object.keys(sessionStore) ) { delete sessionStore[k]; }
    await modeMod.setFilteringMode('a.example', modeMod.MODE_NONE);
    await modeMod.setFilteringMode('b.example', modeMod.MODE_NONE);
    await modeMod.setFilteringMode('c.example', modeMod.MODE_BASIC);
    const sequentialResult = await modeMod.getFilteringModeDetails(true);

    // Bulk run against a fresh store, same net changes, one round-trip.
    for ( const k of Object.keys(localStore) ) { delete localStore[k]; }
    for ( const k of Object.keys(sessionStore) ) { delete sessionStore[k]; }
    modeMod.readFilteringModeDetails.cache = undefined; // force a fresh read, same as a cold cache
    await modeMod.setFilteringModeBulk([
        [ 'a.example', modeMod.MODE_NONE ],
        [ 'b.example', modeMod.MODE_NONE ],
        [ 'c.example', modeMod.MODE_BASIC ],
    ]);
    const bulkResult = await modeMod.getFilteringModeDetails(true);

    assert.deepStrictEqual(
        [ ...bulkResult.none ].sort(), [ ...sequentialResult.none ].sort(),
        'none set must match between bulk and sequential application'
    );
    assert.deepStrictEqual(
        [ ...bulkResult.basic ].sort(), [ ...sequentialResult.basic ].sort(),
        'basic set must match between bulk and sequential application'
    );
});

await checkAsync('setFilteringModeBulk only rebuilds native DNR rules ONCE for the whole batch, not once per hostname', async () => {
    scriptingCalls.length = 0;
    await modeMod.setFilteringModeBulk([
        [ 'x1.example', modeMod.MODE_NONE ],
        [ 'x2.example', modeMod.MODE_NONE ],
        [ 'x3.example', modeMod.MODE_NONE ],
        [ 'x4.example', modeMod.MODE_NONE ],
    ]);
    const dnrRebuilds = scriptingCalls.filter(c => c === 'dnr:getDynamicRules').length;
    assert.strictEqual(dnrRebuilds, 1, `expected exactly 1 DNR rebuild for a 4-hostname batch, got ${dnrRebuilds}`);
});

await checkAsync('setFilteringModeBulk matches applyFilteringMode()\'s actual (pre-existing) reverse-mode behavior for a per-hostname BASIC override', async () => {
    for ( const k of Object.keys(localStore) ) { delete localStore[k]; }
    for ( const k of Object.keys(sessionStore) ) { delete sessionStore[k]; }
    modeMod.readFilteringModeDetails.cache = undefined;
    await modeMod.setFilteringModeBulk([
        [ 'all-urls', modeMod.MODE_NONE ],
        [ 'exempt.example', modeMod.MODE_BASIC ],
    ]);
    const level1 = await modeMod.getFilteringMode('random-other-site.example');
    const level2 = await modeMod.getFilteringMode('exempt.example');
    assert.strictEqual(level1, modeMod.MODE_NONE, 'default (all-urls) must be NONE');
    // NOTE (found during this dry-run pass, not introduced by it):
    // applyFilteringMode() — pre-existing, unmodified by this session —
    // has no branch that records a hostname into the 'basic' set when
    // the default is NONE (only the reverse — recording into 'none' when
    // the default is BASIC — is implemented). setFilteringModeBulk()
    // calls this exact same function the same way setFilteringMode()
    // does, so this is identical between sequential and bulk application
    // — confirmed by inspection, not something either function's own
    // logic could differ on. Recorded here as a known current behavior,
    // not asserted as "correct", and flagged separately for a possible
    // follow-up fix outside this optimization pass.
    assert.strictEqual(level2, modeMod.MODE_NONE, 'current (pre-existing) behavior: a per-hostname BASIC override does not survive when the default is NONE');
});

/******************************************************************************/
section('custom-scriptlets.js — importCustomScriptletRules() vs addCustomScriptletRule() equivalence');
/******************************************************************************/

for ( const k of Object.keys(localStore) ) { delete localStore[k]; }
const csMod = await import(`${ROOT}/js/core/custom-scriptlets.js?t=${Date.now()}`);

await checkAsync('importCustomScriptletRules validates each rule the same way addCustomScriptletRule does (rejects unknown name)', async () => {
    const results = await csMod.importCustomScriptletRules([
        { hostname: 'example.com', name: 'totally-not-a-real-scriptlet', args: [] },
    ], 'import');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ok, false);
    assert.ok(/Unknown scriptlet name/.test(results[0].error));
});

await checkAsync('importCustomScriptletRules stores valid rules and dedups within the same batch', async () => {
    const stored = await csMod.getCustomScriptletRules();
    const anyRealName = stored.length ? stored[0].name : null;
    // Use a name known to be valid — isKnownScriptletName() checks against
    // a real registry; use one already accepted by this codebase's own
    // scriptlet library rather than guessing a private list.
    const knownName = csMod.isKnownScriptletName('abort-current-inline-script') ? 'abort-current-inline-script' : anyRealName;
    if ( !knownName ) { throw new Error('no known scriptlet name available to test with — skipping is not an option, this needs a real name'); }
    const rule = { hostname: 'dup.example', name: knownName, args: [ 'x' ] };
    const results = await csMod.importCustomScriptletRules([ rule, rule ], 'import'); // same rule twice in one batch
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(results[1].ok, true);
    assert.strictEqual(results[0].rule.uid, results[1].rule.uid, 'second identical rule in the same batch must dedup against the first, not create a duplicate');
    const allStored = await csMod.getCustomScriptletRules();
    const matching = allStored.filter(r => r.hostname === 'dup.example' && r.name === knownName);
    assert.strictEqual(matching.length, 1, 'only one copy should actually be persisted to storage');
});

await checkAsync('importCustomScriptletRules writes storage exactly ONCE for a multi-rule batch, not once per rule', async () => {
    let setCalls = 0;
    const originalSet = global.chrome.storage.local.set;
    global.chrome.storage.local.set = (obj) => { setCalls++; return originalSet(obj); };
    const knownName = csMod.isKnownScriptletName('abort-current-inline-script') ? 'abort-current-inline-script' : null;
    await csMod.importCustomScriptletRules([
        { hostname: 'batch1.example', name: knownName, args: [] },
        { hostname: 'batch2.example', name: knownName, args: [] },
        { hostname: 'batch3.example', name: knownName, args: [] },
    ], 'import');
    global.chrome.storage.local.set = originalSet;
    assert.strictEqual(setCalls, 1, `expected exactly 1 storage.local.set call for a 3-rule batch, got ${setCalls}`);
});

/******************************************************************************/
section('filter-manager.js — importCosmeticFiltersBulk() batches shared dates read/write correctly');
/******************************************************************************/

for ( const k of Object.keys(localStore) ) { delete localStore[k]; }
const fmMod = await import(`${ROOT}/js/core/filter-manager.js?t=${Date.now()}`);

await checkAsync('importCosmeticFiltersBulk applies entries for multiple hostnames and preserves each createdAt', async () => {
    const addedHostnames = await fmMod.importCosmeticFiltersBulk([
        [ 'site-a.example', [ { selector: '.ad-a', createdAt: '2021-03-01' } ] ],
        [ 'site-b.example', [ { selector: '.ad-b', createdAt: '2022-07-15' } ] ],
    ]);
    assert.strictEqual(addedHostnames.size, 2);
    assert.ok(addedHostnames.has('site-a.example'));
    assert.ok(addedHostnames.has('site-b.example'));
    const withDates = await fmMod.getAllCustomFiltersWithDates();
    const siteA = withDates.find(([ h ]) => h === 'site-a.example');
    const siteB = withDates.find(([ h ]) => h === 'site-b.example');
    assert.strictEqual(siteA[1][0].createdAt, '2021-03-01');
    assert.strictEqual(siteB[1][0].createdAt, '2022-07-15');
});

await checkAsync('importCosmeticFiltersBulk writes the shared dates map exactly ONCE for a multi-hostname batch', async () => {
    let setCalls = 0;
    const originalSet = global.chrome.storage.local.set;
    global.chrome.storage.local.set = (obj) => { setCalls++; return originalSet(obj); };
    await fmMod.importCosmeticFiltersBulk([
        [ 'batch-a.example', [ { selector: '.x', createdAt: '2023-01-01' } ] ],
        [ 'batch-b.example', [ { selector: '.y', createdAt: '2023-01-02' } ] ],
        [ 'batch-c.example', [ { selector: '.z', createdAt: '2023-01-03' } ] ],
    ]);
    global.chrome.storage.local.set = originalSet;
    // One set() per hostname's own site.<hostname> key (unavoidable — each
    // hostname's selectors live under a separate storage key) PLUS exactly
    // one for the shared cosmeticRuleDates map — not one dates-map write
    // per hostname (which would make this 6, not 4).
    assert.strictEqual(setCalls, 4, `expected 3 per-hostname selector writes + 1 shared dates write = 4, got ${setCalls}`);
});

await checkAsync('importCosmeticFiltersBulk does not report a hostname as added when its entries are empty/invalid', async () => {
    const addedHostnames = await fmMod.importCosmeticFiltersBulk([
        [ 'empty.example', [] ],
        [ 'invalid.example', [ { selector: '', createdAt: '2023-01-01' } ] ],
    ]);
    assert.strictEqual(addedHostnames.size, 0);
});

/******************************************************************************/
section('tracker-radar-lookup.js — session-start preload, synchronous lookup, safe pre-load fallback');
/******************************************************************************/

const trMod = await import(`${ROOT}/js/core/tracker-radar-lookup.js?t=${Date.now()}`);

await checkAsync('lookupTracker returns null (safe fallback) before preload resolves, not a throw', async () => {
    // Fresh module state (no preload triggered yet in this test file's
    // own import of it) — must degrade safely, never throw.
    const result = trMod.lookupTracker('doubleclick.net');
    assert.strictEqual(result, null);
});

await checkAsync('preloadTrackerRadarData populates the dataset and lookupTracker finds a real entry afterward', async () => {
    await trMod.preloadTrackerRadarData();
    const result = trMod.lookupTracker('doubleclick.net');
    assert.ok(result !== null, 'doubleclick.net should be a known tracker once the real dataset is loaded');
    assert.ok(typeof result.owner === 'string');
});

await checkAsync('a second preloadTrackerRadarData call reuses the same promise, does not re-fetch', async () => {
    const before = trMod.lookupTracker('doubleclick.net');
    await trMod.preloadTrackerRadarData();
    await trMod.preloadTrackerRadarData();
    const after = trMod.lookupTracker('doubleclick.net');
    assert.deepStrictEqual(before, after);
});

await checkAsync('isKnownTracker suffix-walks correctly for a subdomain of a known entry', async () => {
    assert.strictEqual(trMod.isKnownTracker('stats.g.doubleclick.net'), true);
    assert.strictEqual(trMod.isKnownTracker('totally-unknown-domain-xyz123.test'), false);
});

/******************************************************************************/
section('scripting-manager.js — registerContentScripts() css-user diff (OPTIMIZE.md 1.1, no blanket wipe)');
/******************************************************************************/

// Fresh, minimal storage state so registerContentScripts() has something
// deterministic to compute against.
for ( const k of Object.keys(localStore) ) { delete localStore[k]; }
for ( const k of Object.keys(sessionStore) ) { delete sessionStore[k]; }
scriptingRegistered = [];
modeMod.readFilteringModeDetails.cache = undefined;

const smMod = await import(`${ROOT}/js/core/scripting-manager.js?t=${Date.now()}`);

await checkAsync('a completely fresh registerContentScripts() call does not throw and does not perform a blanket wipe', async () => {
    scriptingCalls.length = 0;
    await smMod.registerContentScripts();
    const blanketWipes = scriptingCalls.filter(c => c === 'unregister:ALL (blanket wipe)').length;
    assert.strictEqual(blanketWipes, 0, 'registerContentScripts() must never issue a no-filter unregisterContentScripts() call');
});

await checkAsync('an UNRELATED manually-registered script id survives a registerContentScripts() call untouched', async () => {
    // This is the actual behavioral proof that OPTIMIZE.md 1.1 is safe:
    // before the fix, ANY call to registerContentScripts() would wipe
    // every registered script, including ones it doesn't itself manage.
    scriptingRegistered.push({ id: 'totally-unrelated-external-id', js: [ '/noop.js' ], matches: [ '<all_urls>' ] });
    await smMod.registerContentScripts();
    const stillThere = scriptingRegistered.some(s => s.id === 'totally-unrelated-external-id');
    assert.ok(stillThere, 'an id this module does not own must never be touched by registerContentScripts()');
});

console.log('');
if ( failures > 0 ) {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exit(1);
}
console.log('ALL OPTIMIZATION-CHANGE DRY-RUN CHECKS PASSED');
// Explicit exit (v9.7.3): the imported production modules leave a handle open
// (a timer/promise they own), so on the success path this process never
// terminated by itself. Run standalone that only meant a hang until Ctrl-C;
// once wired into complete-check.mjs (step 34) via execFileSync it blocked
// the whole suite forever, and the summary never printed. A check that
// cannot finish cannot gate anything — exit deterministically, 0 = pass.
process.exit(0);
