#!/usr/bin/env node
// tools/test-disconnect-retired.mjs — (10.7.1) ruleset_disconnect_other (Disconnect Cryptomining + Fingerprinting)
// was removed. Its Worry-free suppression rule was an ALLOW at WORRY_FREE_EXTRA_ALLOW_PRIORITY (9 000) over
// Disconnect's 569 domains; a leftover copy would keep unblocking the ~280 of them the remaining extra lists also
// block. This test asserts the removal is complete and the leftover guard works:
//   1. dnr-budgets.js exports only the RETIRED id (kept so the number is never reassigned)
//   2. reconcileWorryFreeExtraSuppressionRule() REMOVES a leftover session rule at that id, in and out of a session
//   3. it never ADDS one
//   4. no manifest entry, ruleset file, settings default or dashboard row for Disconnect remains
// Mock harness ported verbatim from tools/test-annoyances-suppression.mjs (C21).
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== Disconnect list STAYS removed, leftover suppression rule is released (10.7.1) ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

// ── Minimal browser/chrome mock ───────────────────────────────────────────────
const storage = new Map();
let sessionRules = [];
function mkArea() { return {
    get: async keys => {
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
        return Object.fromEntries(names.filter(k => storage.has(k)).map(k => [ k, storage.get(k) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { storage.set(k, v); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { storage.delete(k); } },
    setAccessLevel: async () => {},
}; }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, onMessage: { addListener() {} } },
    storage: { local: mkArea(), session: mkArea() },
    declarativeNetRequest: {
        updateDynamicRules: async () => {},
        getDynamicRules: async () => [],
        updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
            sessionRules = sessionRules.filter(r => removeRuleIds.includes(r.id) === false).concat(addRules);
        },
        getSessionRules: async () => sessionRules,
        updateEnabledRulesets: async () => {},
        getEnabledRulesets: async () => [],
    },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {} },
    tabs: { query: async () => [], get: async () => ({}) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {} },
    permissions: { contains: async () => true },
};
globalThis.fetch = async url => {
    const file = path.join(ROOT, String(url));
    if ( !fs.existsSync(file) ) { throw new Error(`no such shipped file: ${url}`); }
    return { json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

let manager, budgets;
try {
    manager = await import(path.join(ROOT, 'js/core/worry-free-extra-manager.js'));
    budgets = await import(path.join(ROOT, 'js/core/dnr-budgets.js'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}
let config;
try {
    config = await import(path.join(ROOT, 'js/data/config.js'));
} catch ( err ) {
    didNotRun(`cannot import js/data/config.js (${err.message})`);
}
if ( typeof manager.reconcileWorryFreeExtraSuppressionRule !== 'function' ) {
    didNotRun('worry-free-extra-manager.js does not export reconcileWorryFreeExtraSuppressionRule — this check needs updating');
}
const RETIRED_ID = budgets.WORRY_FREE_DISCONNECT_OTHER_RULES_RETIRED_BASE_ID;
if ( typeof RETIRED_ID !== 'number' ) {
    didNotRun('dnr-budgets.js does not export WORRY_FREE_DISCONNECT_OTHER_RULES_RETIRED_BASE_ID — the id must be kept, unused');
}

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}

check('dnr-budgets.js exports NO live WORRY_FREE_DISCONNECT_OTHER_RULES_BASE_ID (only the retired one)',
    budgets.WORRY_FREE_DISCONNECT_OTHER_RULES_BASE_ID === undefined);

const leftover = { id: RETIRED_ID, priority: budgets.WORRY_FREE_EXTRA_ALLOW_PRIORITY, action: { type: 'allow' },
    condition: { requestDomains: [ 'google-analytics.com' ] } };
for ( const [ label, isActive ] of [ [ 'no session', false ], [ 'session active', true ] ] ) {
    sessionRules = [ leftover ];
    await manager.reconcileWorryFreeExtraSuppressionRule(isActive, `test-disconnect-${label}`);
    check(`${label}: a leftover session rule at the retired id is removed`,
        sessionRules.some(r => r.id === RETIRED_ID) === false);
    sessionRules = [];
    await manager.reconcileWorryFreeExtraSuppressionRule(isActive, `test-disconnect-${label}`);
    check(`${label}: no session rule is ever added at the retired id`,
        sessionRules.some(r => r.id === RETIRED_ID) === false);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
check('manifest.json declares no ruleset_disconnect_other',
    (manifest.declarative_net_request?.rule_resources ?? []).some(r => r.id === 'ruleset_disconnect_other') === false);
check('rulesets/ruleset_disconnect_other.json is gone',
    fs.existsSync(path.join(ROOT, 'rulesets', 'ruleset_disconnect_other.json')) === false);
check('settings default worryFreeDisconnectOtherEnabled is gone (a stored value is dropped on load)',
    Object.hasOwn(config.securityConfig, 'worryFreeDisconnectOtherEnabled') === false);
check('dashboard has no Disconnect toggle',
    fs.readFileSync(path.join(ROOT, 'dashboard', 'dashboard.html'), 'utf8').includes('worryFreeDisconnectOtherToggle') === false);

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — the Disconnect removal is incomplete.`);
    process.exit(1);
}
console.log('\nPASS: Disconnect is fully removed and a leftover suppression rule is released.');
