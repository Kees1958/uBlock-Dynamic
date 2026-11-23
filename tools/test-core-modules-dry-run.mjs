// Functional dry-run for the three core modules touched by this
// session's Map conversions (matrix-block-rules.js, filter-manager.js's
// cosmetic-rule-dates path, custom-scriptlets.js's date handling).
// Exercises the real exported functions against a mocked
// chrome.storage.local — actually create/read/update/delete/import/
// backfill, not just "does it parse".
import assert from 'assert';
import path from 'path';   // (audit 10.6.4) unused `fs`/`vm` imports removed — the fetch shim below imports fs/promises itself

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Mock chrome.storage.local — plain in-memory object, standard
//    get(key)/set(obj) promise-based shape (matches ext.js's own usage
//    exactly, see localRead()/localWrite() there). ─────────────────────
const store = {};
global.chrome = {
    storage: {
        local: {
            get: (key) => Promise.resolve(typeof key === 'string' ? { [key]: store[key] } : { ...store }),
            set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
            remove: (keys) => { for ( const k of [].concat(keys) ) { delete store[k]; } return Promise.resolve(); },
        },
    },
    runtime: { getURL: p => `chrome-extension://test/${p}` },
};
global.browser = global.chrome;
global.self = global;

// fetch() mock — worry-free-extra-manager.js's getRulesetRequestDomains()
// reads a bundled ruleset JSON via fetch(runtime.getURL(path)). A real
// browser resolves chrome-extension://... URLs itself; Node's own fetch
// (undici) has no concept of that scheme at all — not a network-
// permission issue, an unsupported-scheme one, so this failed in EVERY
// environment this test has ever run in, not just a sandboxed one.
// Fixed here rather than deleted: serve the REAL file straight off disk
// for any chrome-extension://test/<path> URL, so this still exercises
// getRulesetRequestDomains() against the project's actual bundled
// ruleset JSON, not a hand-written stand-in that could drift from it.
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

// dnr mock — matrix-block-rules.js calls dnr.getDynamicRules()/updateDynamicRules()
const dnrMock = {
    _rules: [],
    async getDynamicRules() { return this._rules; },
    async isRegexSupported() { return { isSupported: true }; },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        this._rules = this._rules.filter(r => !removeRuleIds.includes(r.id));
        this._rules.push(...addRules);
    },
    // SESSION rules — separate store from dynamic rules above (real Chrome
    // keeps these distinct too). updateSessionRules() deliberately mimics
    // Chrome's real validation error ("Rule with id N does not have a
    // unique ID") when addRules contains an id already present in
    // _sessionRules that removeRuleIds didn't also remove in the SAME
    // call — the exact behaviour worry-free-extra-manager.js's own bug
    // (see that section below) depended on to reproduce, and that a
    // too-lenient mock would silently fail to catch.
    _sessionRules: [],
    async getSessionRules() { return this._sessionRules; },
    // STATIC ruleset enable state (10.2.0 — ruleset-manager.js reconcileSecurityOwnedRulesets() switches the
    // security-owned ruleset_suspicious_hosting). Same shape as Chrome's API.
    _enabledRulesets: new Set(),
    async getEnabledRulesets() { return [ ...this._enabledRulesets ]; },
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
        for ( const id of disableRulesetIds ) { this._enabledRulesets.delete(id); }
        for ( const id of enableRulesetIds ) { this._enabledRulesets.add(id); }
    },
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        const stillPresent = new Set(
            this._sessionRules.filter(r => !removeRuleIds.includes(r.id)).map(r => r.id)
        );
        for ( const rule of addRules ) {
            if ( stillPresent.has(rule.id) ) {
                throw new Error(`Rule with id ${rule.id} does not have a unique ID.`);
            }
        }
        this._sessionRules = this._sessionRules
            .filter(r => !removeRuleIds.includes(r.id))
            .concat(addRules);
    },
};
// ext-compat.js exports `dnr` derived from chrome.declarativeNetRequest —
// mock that surface directly so the real module picks it up unmodified.
global.chrome.declarativeNetRequest = dnrMock;

/******************************************************************************/
section('matrix-block-rules.js — Dynamic DNR overrides (Map<site, Map<domain, entry>>)');
/******************************************************************************/

const mbr = await import(`${ROOT}/js/core/matrix-block-rules.js?t=${Date.now()}`);

await checkAsync('setMatrixOverride creates a new entry with today\'s createdAt', async () => {
    await mbr.setMatrixOverride('example.com', 'tracker.net', 'all', 'block');
    const rules = await mbr.getMatrixBlockRules();
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].site, 'example.com');
    assert.strictEqual(rules[0].domain, 'tracker.net');
    assert.strictEqual(rules[0].all, 'block');
    assert.match(rules[0].createdAt, /^\d{4}-\d{2}-\d{2}$/);
});

let firstCreatedAt;
await checkAsync('setMatrixOverride on the SAME pair preserves the original createdAt', async () => {
    const before = await mbr.getMatrixBlockRules();
    firstCreatedAt = before[0].createdAt;
    await mbr.setMatrixOverride('example.com', 'tracker.net', 'code', 'allow');
    const after = await mbr.getMatrixBlockRules();
    assert.strictEqual(after.length, 1); // still the same one pair, now with both scopes set
    assert.strictEqual(after[0].all, 'block');
    assert.strictEqual(after[0].code, 'allow');
    assert.strictEqual(after[0].createdAt, firstCreatedAt);
});

await checkAsync('setMatrixOverride on a second, different pair creates a separate entry', async () => {
    await mbr.setMatrixOverride('other-site.org', 'ads.example', 'all', 'allow');
    const rules = await mbr.getMatrixBlockRules();
    assert.strictEqual(rules.length, 2);
});

await checkAsync('getMatrixOverridesForSite returns only that site\'s overrides', async () => {
    const forExample = await mbr.getMatrixOverridesForSite('example.com');
    assert.deepStrictEqual(Object.keys(forExample), [ 'tracker.net' ]);
    const forOther = await mbr.getMatrixOverridesForSite('other-site.org');
    assert.deepStrictEqual(Object.keys(forOther), [ 'ads.example' ]);
    const forUnknown = await mbr.getMatrixOverridesForSite('nope.test');
    assert.deepStrictEqual(forUnknown, {});
});

// (11.1.0) Bulk form — the tracking filter's Block/Allow-by-risk buttons.
await checkAsync('setMatrixOverrides applies every valid change with ONE DNR sync, skips invalid ones', async () => {
    const before = (await mbr.getMatrixBlockRules()).length;
    let syncs = 0;
    const realUpdate = dnrMock.updateDynamicRules;
    dnrMock.updateDynamicRules = async function(arg) { syncs++; return realUpdate.call(this, arg); };
    try {
        await mbr.setMatrixOverrides('bulk-site.com', [
            { domain: 'a.example', scope: 'all', action: 'block' },
            { domain: 'b.example', scope: 'all', action: 'block' },
            { domain: 'c.example', scope: 'nope', action: 'block' },   // invalid scope — skipped
            { domain: 42, scope: 'all', action: 'block' },            // invalid domain — skipped
        ]);
    } finally {
        dnrMock.updateDynamicRules = realUpdate;   // GUARD (release): the mock is shared by later sections
    }
    assert.strictEqual(syncs, 1);
    const forBulk = await mbr.getMatrixOverridesForSite('bulk-site.com');
    assert.deepStrictEqual(Object.keys(forBulk).sort(), [ 'a.example', 'b.example' ]);
    assert.strictEqual(forBulk['a.example'].all, 'block');
    assert.strictEqual((await mbr.getMatrixBlockRules()).length, before + 2);
    await mbr.setMatrixOverrides('bulk-site.com', [   // clean up: null clears
        { domain: 'a.example', scope: 'all', action: null }, { domain: 'b.example', scope: 'all', action: null },
    ]);
    assert.strictEqual((await mbr.getMatrixBlockRules()).length, before);
});

await checkAsync('setMatrixOverrides with nothing valid writes nothing (no DNR sync)', async () => {
    let syncs = 0;
    const realUpdate = dnrMock.updateDynamicRules;
    dnrMock.updateDynamicRules = async function(arg) { syncs++; return realUpdate.call(this, arg); };
    try {
        await mbr.setMatrixOverrides('bulk-site.com', [ { domain: '', scope: 'all', action: 'block' } ]);
        await mbr.setMatrixOverrides('bulk-site.com', 'not an array');
    } finally {
        dnrMock.updateDynamicRules = realUpdate;
    }
    assert.strictEqual(syncs, 0);
});

await checkAsync('deleteMatrixOverridesMatching deletes only matching entries (site OR domain substring)', async () => {
    await mbr.setMatrixOverride('another.com', 'akamaihd.net', 'all', 'block');
    const deleted = await mbr.deleteMatrixOverridesMatching('akamaihd');
    assert.strictEqual(deleted, 1);
    const rules = await mbr.getMatrixBlockRules();
    assert.strictEqual(rules.length, 2); // the other two, untouched
    assert.ok(!rules.some(r => r.domain === 'akamaihd.net'));
});

await checkAsync('importMatrixOverrides merges without clobbering existing pairs, preserves local createdAt', async () => {
    const before = await mbr.getMatrixBlockRules();
    const exampleEntry = before.find(r => r.domain === 'tracker.net');
    const imported = await mbr.importMatrixOverrides([
        { site: 'example.com', domain: 'tracker.net', all: 'allow', code: null, createdAt: '2020-01-01' }, // pre-existing pair — local date must win, not 2020-01-01
        { site: 'brand-new.com', domain: 'fresh.net', all: 'block', code: null, createdAt: '2020-06-15' }, // new pair — imported date must be preserved
    ]);
    assert.strictEqual(imported, 2);
    const after = await mbr.getMatrixBlockRules();
    const updatedExample = after.find(r => r.domain === 'tracker.net');
    assert.strictEqual(updatedExample.all, 'allow'); // value did get updated
    assert.strictEqual(updatedExample.createdAt, exampleEntry.createdAt); // but date is preserved, not overwritten
    const freshEntry = after.find(r => r.domain === 'fresh.net');
    assert.strictEqual(freshEntry.createdAt, '2020-06-15'); // brand new pair keeps the imported date
});

await checkAsync('deleteMatrixBlockRule removes exactly one rule by uid', async () => {
    const before = await mbr.getMatrixBlockRules();
    const target = before[0];
    await mbr.deleteMatrixBlockRule(target.uid);
    const after = await mbr.getMatrixBlockRules();
    assert.strictEqual(after.length, before.length - 1);
    assert.ok(!after.some(r => r.uid === target.uid));
});

await checkAsync('clearMatrixBlockRules removes everything', async () => {
    await mbr.clearMatrixBlockRules();
    const rules = await mbr.getMatrixBlockRules();
    assert.strictEqual(rules.length, 0);
});

await checkAsync('DNR rules were actually kept in sync with overrides throughout (not just storage)', async () => {
    await mbr.setMatrixOverride('sync-test.com', 'blocked.net', 'all', 'block');
    assert.ok(dnrMock._rules.some(r => r.action.type === 'block' && r.condition.requestDomains.includes('blocked.net')));
    await mbr.clearMatrixBlockRules();
    assert.strictEqual(dnrMock._rules.length, 0);
});

/******************************************************************************/
section('filter-manager.js — cosmetic rule dates (Map<hostname, Map<selector, date>>)');
/******************************************************************************/

const fm = await import(`${ROOT}/js/core/filter-manager.js?t=${Date.now()}`);

await checkAsync('addCustomFilters stamps createdAt on new selectors', async () => {
    await fm.addCustomFilters('news.example', [ '.ad-banner', '.tracker-widget' ]);
    const withDates = await fm.getAllCustomFiltersWithDates();
    const entry = withDates.find(([ h ]) => h === 'news.example');
    assert.ok(entry, 'hostname entry should exist');
    assert.strictEqual(entry[1].length, 2);
    for ( const { selector, createdAt } of entry[1] ) {
        assert.match(createdAt, /^\d{4}-\d{2}-\d{2}$/, `${selector} should have a valid date`);
    }
});

await checkAsync('re-adding an existing selector does not reset its date', async () => {
    const before = await fm.getAllCustomFiltersWithDates();
    const beforeDate = before.find(([ h ]) => h === 'news.example')[1].find(e => e.selector === '.ad-banner').createdAt;
    await fm.addCustomFilters('news.example', [ '.ad-banner', '.brand-new-selector' ]); // one dup, one new
    const after = await fm.getAllCustomFiltersWithDates();
    const afterEntries = after.find(([ h ]) => h === 'news.example')[1];
    assert.strictEqual(afterEntries.length, 3); // dup didn't double up
    assert.strictEqual(afterEntries.find(e => e.selector === '.ad-banner').createdAt, beforeDate);
});

await checkAsync('deleteCustomFilter removes the selector AND its date entry', async () => {
    await fm.deleteCustomFilter('news.example', '.tracker-widget');
    const after = await fm.getAllCustomFiltersWithDates();
    const entry = after.find(([ h ]) => h === 'news.example');
    assert.ok(!entry[1].some(e => e.selector === '.tracker-widget'));
});

await checkAsync('importCosmeticFilters preserves an imported date for a genuinely new selector', async () => {
    await fm.importCosmeticFilters('imported.example', [
        { selector: '.old-rule', createdAt: '2019-03-14' },
    ]);
    const after = await fm.getAllCustomFiltersWithDates();
    const entry = after.find(([ h ]) => h === 'imported.example');
    assert.strictEqual(entry[1][0].createdAt, '2019-03-14');
});

await checkAsync('deleteCustomFiltersMatching removes matching hostnames and their dates together', async () => {
    const deleted = await fm.deleteCustomFiltersMatching('imported');
    assert.strictEqual(deleted, 1);
    const after = await fm.getAllCustomFiltersWithDates();
    assert.ok(!after.some(([ h ]) => h === 'imported.example'));
});

// OPTIMIZE.md 3.3 — importCosmeticFiltersBulk() used to delegate to
// applyCosmeticImportForHostname()/addCustomFilters() once per hostname,
// each of which independently re-scanned the whole site.* corpus for its
// cap check and triggered a full index rebuild via writeToStorage(). Found
// while porting the 3.1/3.2 optimizations to a sibling extension —
// see PORTING_9_4_9_ISSUES_FOUND.md item 8. From here on, the store is
// cleared at the start of each of these two tests (safe: this is the last
// pair of checks in this section).
await checkAsync('importCosmeticFiltersBulk produces the identical end state as N sequential importCosmeticFilters calls', async () => {
    // Reference run: sequential, one importCosmeticFilters() call per hostname.
    for ( const k of Object.keys(store) ) { delete store[k]; }
    await fm.importCosmeticFilters('seq-a.example', [ { selector: '.seq-a1' }, { selector: '.seq-a2' } ]);
    await fm.importCosmeticFilters('seq-b.example', [ { selector: '.seq-b1' } ]);
    const sequentialResult = await fm.getAllCustomFiltersWithDates();

    // Bulk run against a fresh store, same net changes, one call.
    for ( const k of Object.keys(store) ) { delete store[k]; }
    await fm.importCosmeticFiltersBulk([
        [ 'seq-a.example', [ { selector: '.seq-a1' }, { selector: '.seq-a2' } ] ],
        [ 'seq-b.example', [ { selector: '.seq-b1' } ] ],
    ]);
    const bulkResult = await fm.getAllCustomFiltersWithDates();

    function norm(list) {
        return list
            .map(([ h, sels ]) => [ h, sels.map(e => e.selector).sort() ])
            .sort((a, b) => a[0].localeCompare(b[0]));
    }
    assert.deepStrictEqual(
        norm(bulkResult), norm(sequentialResult),
        'bulk and sequential cosmetic-filter imports must produce the same stored selectors'
    );
});

await checkAsync('importCosmeticFiltersBulk rebuilds the custom-filter index ONCE for the whole batch, not once per hostname', async () => {
    for ( const k of Object.keys(store) ) { delete store[k]; }
    let fullCorpusReads = 0;
    const realGet = global.chrome.storage.local.get;
    global.chrome.storage.local.get = (key) => {
        // localKeys() (used by getAllCustomFilters()) calls get(null) to
        // list every stored key — that's the specific "full corpus scan"
        // shape this test is counting, not the many single-key get(key)
        // calls a bulk import legitimately makes.
        if ( key === null ) { fullCorpusReads++; }
        return realGet(key);
    };
    try {
        await fm.importCosmeticFiltersBulk([
            [ 'bulk1.example', [ { selector: '.b1' } ] ],
            [ 'bulk2.example', [ { selector: '.b2' } ] ],
            [ 'bulk3.example', [ { selector: '.b3' } ] ],
            [ 'bulk4.example', [ { selector: '.b4' } ] ],
        ]);
    } finally {
        global.chrome.storage.local.get = realGet;
    }
    // Expected: 1 full-corpus read for importCosmeticFiltersBulk()'s own
    // initial snapshot + 1 more inside the single refreshCustomFilterIndex()
    // call writeManyToStorage() triggers at the end of the batch = 2 total.
    // Under the pre-fix per-hostname path this would have been 2 PER
    // hostname (one from addCustomFilters()'s own cap check, one from the
    // refreshCustomFilterIndex() writeToStorage() triggered) — 8 for this
    // 4-hostname batch, growing linearly with the import size.
    assert.strictEqual(
        fullCorpusReads, 2,
        `expected exactly 2 full-corpus reads for a 4-hostname batch, got ${fullCorpusReads}`
    );
});

/******************************************************************************/
section('worry-free-extra-manager.js — session-rule collision regression (real bug report)');
/******************************************************************************/

// REGRESSION TEST for a live bug report: onWorryFreeSessionStart() threw
// "Rule with id 13000001 does not have a unique ID." because it built
// addRules purely from securityConfig settings, with no check for what
// dnr.getSessionRules() actually had registered — unlike
// reconcileWorryFreeExtraSuppressionRule(), which already did this
// correctly. Fix: onWorryFreeSessionStart()/onWorryFreeSessionEnd() now
// delegate to that same, already-correct reconcile function (C21) instead
// of duplicating the (buggy) logic. This test reproduces the exact
// pre-existing-rule scenario that triggered the original error, using the
// mock's own Chrome-accurate "not a unique ID" validation above — a mock
// that silently accepted the collision would let this regression back in
// unnoticed.
//
// (10.3.0 removal) Re-keyed AGAIN: blockScpPrivacy/13000011 (the previous re-keying target) is itself
// now retired along with the whole Privacy & Security tab's extra protections; see CHANGELOG.md
// 10.3.0. The regression this test guards against is a property of the suppression mechanism in
// general (SCOPED_SUPPRESSION_RULES/NO_TIER_CONDITION_SUPPRESSION_RULES), not of any one item, so
// re-keying again to a surviving item (worryFreeAdguardTrackingEnabled, 13000006) preserves the
// coverage rather than losing it.
const cfgMod = await import(`${ROOT}/js/data/config.js`); // NO cache-busting query here — must resolve to the exact same module instance worry-free-extra-manager.js's own internal `import { securityConfig } from '../data/config.js'` sees, or mutating this reference wouldn't reach the real one at all
const wfx = await import(`${ROOT}/js/core/worry-free-extra-manager.js?t=${Date.now()}`);

await checkAsync('onWorryFreeSessionStart does not throw when its own suppression rule is already present', async () => {
    // Reproduce the exact reported state: id 13000006 (worryFreeAdguardTrackingEnabled's own
    // suppression-rule id) already sitting in session rules — plausible any time this ran without a
    // matching prior removal — and its setting currently disabled, so the (buggy) old code would try
    // to blindly re-add that same id without removing it first.
    dnrMock._sessionRules = [ { id: 13_000_006, priority: 150, action: { type: 'allow' }, condition: {} } ];
    cfgMod.securityConfig.worryFreeAdguardTrackingEnabled = false;
    // Would throw "Rule with id 13000006 does not have a unique ID." on
    // the pre-fix implementation — assert.doesNotReject makes that
    // failure show up as a normal, readable test failure instead of an
    // uncaught rejection crashing the whole run.
    await assert.doesNotReject(() => wfx.onWorryFreeSessionStart());
});

await checkAsync('...and the disabled item\'s suppression rule (13000006) is still present afterwards', async () => {
    const ids = dnrMock._sessionRules.map(r => r.id);
    assert.ok(ids.includes(13_000_006), 'disabled setting\'s suppression rule should remain in place, not be dropped by the fix');
});

await checkAsync('onWorryFreeSessionEnd does not throw when some suppression rules are already present', async () => {
    // Session ending: 13000006 is still there from the start() call above
    // (never removed, since its setting was disabled the whole time) —
    // the old unconditional addRules-with-no-removeRuleIds implementation
    // would hit the identical collision trying to re-add it.
    await assert.doesNotReject(() => wfx.onWorryFreeSessionEnd());
    const ids = dnrMock._sessionRules.map(r => r.id);
    assert.ok(ids.includes(13_000_006), 'worryFreeAdguardTrackingEnabled\'s suppression rule should be present after session end');
    // GUARD (release): leave the shared config as found.
    cfgMod.securityConfig.worryFreeAdguardTrackingEnabled = true;
});


/******************************************************************************/
// (10.3.0 removal) Everything from here through the sec-scp-fingerprint.js/sec-adult-fingerprint.js
// comparison test that used to precede "site-mode-manager.js" below is retired: the Privacy & Security
// tab's Group 1/2/3 gating (compiled-filters.js prepareSecurityScriptletDirectives()'s isWorryFreeActive
// parameter and securityConfig's two-dozen retired keys), the sandbox-safe-scripts row, the high-risk-
// site Permissions-Policy headers (worry-free-high-risk-headers-manager.js, js/data/high-risk-sites.js,
// js/data/permissions-policy-values.js), the Worry-free tier hierarchy and its editable familiar-TLD
// allowlist (worry-free-tiers.js, worry-free-familiar-tld-manager.js, generic-tlds.js), the
// $saferegions exemption (saferegions-manager.js), and the sec-scp-fingerprint.js/sec-adult-
// fingerprint.js guarded-copy pair all moved to 3P-Matrix or were deleted outright; see
// js/data/retired-protections.js and CHANGELOG.md 10.3.0. The one still-live piece this block used to
// touch — prepareSecurityScriptletDirectives() for the surviving blockPings scriptlet — has its own,
// much smaller coverage in the Group 1 (blockPings) idea folded into test-worryfree-exemption.mjs's own
// scope note; nothing here needs a replacement test, since none of the retired mechanisms exist to
// mis-gate any more.
/******************************************************************************/

// ── site-mode-manager.js — siteModes cache is a Map (B14/B6, v9.7.3) ──────
// Drives the REAL exported functions (getSiteMode/setSiteMode/
// invalidateSiteModeCache) against the mocked chrome.storage.local above —
// checks the two things the Map conversion could silently break: (1) the
// STORED shape is still a plain { hostname: mode } object (every other
// reader of the 'siteModes' key depends on that), (2) set/delete/get and
// the cache-invalidate-then-reload round trip behave exactly as the
// plain-object version did.
section('site-mode-manager.js — siteModes cache is a Map, storage shape unchanged (B14/B6)');
const smm = await import(`${ROOT}/js/core/site-mode-manager.js?t=${Date.now()}`);

await checkAsync('default for an unknown / empty hostname, and nothing written by a read', async () => {
    delete store.siteModes;
    smm.invalidateSiteModeCache();
    assert.strictEqual(await smm.getSiteMode('example.com'), smm.SITE_MODE_DEFAULT);
    assert.strictEqual(await smm.getSiteMode(''), smm.SITE_MODE_DEFAULT);
    assert.strictEqual(store.siteModes, undefined, 'a read must not write');
});

await checkAsync('setSiteMode(OFF) persists a PLAIN OBJECT, not a Map or an entries array', async () => {
    await smm.setSiteMode('example.com', smm.SITE_MODE_OFF);
    await smm.setSiteMode('123.example', smm.SITE_MODE_OFF);   // digit-leading key: the plain-object ordering quirk B14 mentions
    assert.strictEqual(Object.getPrototypeOf(store.siteModes), Object.prototype, 'stored value must be a plain object');
    assert.deepStrictEqual(Object.keys(store.siteModes).sort(), [ '123.example', 'example.com' ]);
    assert.strictEqual(store.siteModes['example.com'], smm.SITE_MODE_OFF);
    assert.strictEqual(await smm.getSiteMode('example.com'), smm.SITE_MODE_OFF);
});

await checkAsync('setting a hostname back to the default DELETES its entry (storage and cache)', async () => {
    await smm.setSiteMode('example.com', smm.SITE_MODE_DEFAULT);
    assert.strictEqual('example.com' in store.siteModes, false);
    assert.strictEqual(await smm.getSiteMode('example.com'), smm.SITE_MODE_DEFAULT);
    assert.strictEqual(await smm.getSiteMode('123.example'), smm.SITE_MODE_OFF, 'the other entry must be untouched');
});

await checkAsync('invalidate + reload reads a plain object written by ANOTHER writer (mode-routes.js / import) correctly', async () => {
    store.siteModes = { 'other.example': 0, 'third.example': 0 };   // as handleSiteModeSetAll() / import would write it
    smm.invalidateSiteModeCache();
    assert.strictEqual(await smm.getSiteMode('other.example'), smm.SITE_MODE_OFF);
    assert.strictEqual(await smm.getSiteMode('123.example'), smm.SITE_MODE_DEFAULT, 'stale cache entry must be gone after invalidate');
    await smm.setSiteMode('fourth.example', smm.SITE_MODE_OFF);
    assert.deepStrictEqual(Object.keys(store.siteModes).sort(), [ 'fourth.example', 'other.example', 'third.example' ], 'unrelated entries survive a write');
});

console.log('');
if ( failures > 0 ) {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exit(1);
}
console.log('ALL CORE-MODULE DRY-RUN CHECKS PASSED');
