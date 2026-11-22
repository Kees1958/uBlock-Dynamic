#!/usr/bin/env node
// test-language-filter-countries.mjs — combined language filters' country rows (10.4.5), suite step 57.
//
// Drives the REAL js/core/language-filter-countries.js and js/core/static-rulesets.js against a mocked
// chrome.storage / declarativeNetRequest:
//   Data element (C41): Create (add), Read (get), Update (set/replace), Delete (set [] removes the entry),
//   input validation (bad ruleset ids / country ids never stored).
//   Process: Initiate (startup restore) -> Perform (stored choices are re-applied; a choice for an id this
//   version does not ship — e.g. the retired Lithuanian filter — is deleted and turns nothing on) -> End (a
//   second startup changes nothing). (10.5.0: the 10.4.5 carry-over of retired filters and the backfill of
//   former country rows were removed with the old conversion code; their cases left this test.)
// Mocks only; every resource is local to this process — nothing to initialise, clear or release.
import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── CONFIG ────────────────────────────────────────────────────────────────
const CHECK_CONFIG = Object.freeze({
    BALTIC: 'ruleset_easylist_latvian',
    BALKAN: 'ruleset_easylist_bulgarian',
    RETIRED: 'ruleset_easylist_lithuanian',
    OVERRIDES_KEY: 'enabledRulesetOverrides',
    COUNTRIES_KEY: 'languageFilterCountries',
});

const storage = new Map();
let enabled = new Set();
function area() {
    return {
        get: async keys => {
            const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
            return Object.fromEntries(names.filter(k => storage.has(k)).map(k => [ k, JSON.parse(JSON.stringify(storage.get(k))) ]));
        },
        set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { storage.set(k, JSON.parse(JSON.stringify(v))); } },
        remove: async keys => { for ( const k of [ keys ].flat() ) { storage.delete(k); } },
    };
}
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null },
    storage: { local: area(), session: area() },
    declarativeNetRequest: {
        getEnabledRulesets: async () => [ ...enabled ],
        updateEnabledRulesets: async ({ enableRulesetIds = [], disableRulesetIds = [] }) => {
            for ( const id of disableRulesetIds ) { enabled.delete(id); }
            for ( const id of enableRulesetIds ) { enabled.add(id); }
        },
    },
};

const countries = await import(path.join(ROOT, 'js/core/language-filter-countries.js'));
const rulesets = await import(path.join(ROOT, 'js/core/static-rulesets.js'));

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`PASS: ${label}`); }
    catch (err) { failures++; console.log(`FAIL: ${label} — ${err.message}`); }
}
function reset() { storage.clear(); enabled = new Set(); }

await check('data: add creates, get reads, no duplicates', async () => {
    reset();
    await countries.addLanguageFilterCountries(CHECK_CONFIG.BALKAN, [ 'al', 'rs' ]);
    await countries.addLanguageFilterCountries(CHECK_CONFIG.BALKAN, [ 'rs', 'gr' ]);
    assert.deepEqual(await countries.getLanguageFilterCountries(), { [CHECK_CONFIG.BALKAN]: [ 'al', 'rs', 'gr' ] });
});
await check('data: set replaces one ruleset, set [] deletes its entry', async () => {
    await countries.setLanguageFilterCountries(CHECK_CONFIG.BALKAN, [ 'bg' ]);
    assert.deepEqual((await countries.getLanguageFilterCountries())[CHECK_CONFIG.BALKAN], [ 'bg' ]);
    await countries.setLanguageFilterCountries(CHECK_CONFIG.BALKAN, []);
    assert.deepEqual(await countries.getLanguageFilterCountries(), {});
});
await check('data: invalid ruleset id or country id is never stored', async () => {
    reset();
    assert.equal(await countries.setLanguageFilterCountries('not a ruleset', [ 'al' ]), false);
    await countries.replaceLanguageFilterCountries({ [CHECK_CONFIG.BALTIC]: [ 'lv', 'BAD!', 42 ], evil: [ 'x' ] });
    assert.deepEqual(await countries.getLanguageFilterCountries(), { [CHECK_CONFIG.BALTIC]: [ 'lv' ] });
});
await check('process: a stored choice for an id this version does not ship is deleted and turns nothing on', async () => {
    reset();
    storage.set(CHECK_CONFIG.OVERRIDES_KEY, { [CHECK_CONFIG.RETIRED]: true, [CHECK_CONFIG.BALKAN]: true });
    await rulesets.restoreEnabledRulesetsFromStorage();
    assert.ok(enabled.has(CHECK_CONFIG.BALKAN), 'known choice re-applied');
    assert.equal(enabled.has(CHECK_CONFIG.RETIRED), false, 'unknown id not enabled');
    assert.equal(enabled.has(CHECK_CONFIG.BALTIC), false, 'no carry-over to a successor any more');
    assert.equal(Object.hasOwn(storage.get(CHECK_CONFIG.OVERRIDES_KEY), CHECK_CONFIG.RETIRED), false, 'unknown id removed from storage');
});
await check('end: a second startup changes nothing (idempotent)', async () => {
    const before = JSON.stringify([ ...storage ]);
    await rulesets.restoreEnabledRulesetsFromStorage();
    assert.equal(JSON.stringify([ ...storage ]), before);
});
if ( failures > 0 ) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exit(1);
}
console.log('\nPASS: combined language filters store their country rows; unknown stored choices are pruned.');
