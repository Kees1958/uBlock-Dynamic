#!/usr/bin/env node
// tools/test-annoyances-suppression.mjs — ruleset_annoyances is an always-on Built-in default
// list since 10.0.7 (it used to be a Worry-free extra, suppressed outside a session by a
// requestDomains-scoped allow rule). This test asserts the OLD mechanism STAYS retired:
//   1. dnr-budgets.js no longer exports a LIVE WORRY_FREE_ANNOYANCES_RULES_BASE_ID
//      (only the RETIRED id, kept so the number is never reassigned — see that file's comment)
//   2. no session rule ever gets registered at the retired id
//   3. every shipped ruleset_annoyances block rule sits at STATIC_FILTER_LIST_PRIORITY (no
//      `priority` override), i.e. it behaves exactly like any other always-on default list
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RULESET_FILE = path.join(ROOT, 'rulesets', 'ruleset_annoyances.json');

console.log('=== Worry-free annoyances suppression mechanism STAYS retired (10.0.7) ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
if ( !fs.existsSync(RULESET_FILE) ) {
    didNotRun('rulesets/ruleset_annoyances.json is missing — build the rulesets first (tools/build-rulesets.mjs)');
}
const shippedRules = JSON.parse(fs.readFileSync(RULESET_FILE, 'utf8'));

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
if ( typeof manager.reconcileWorryFreeExtraSuppressionRule !== 'function' ) {
    didNotRun('worry-free-extra-manager.js does not export reconcileWorryFreeExtraSuppressionRule — this check needs updating');
}
const RETIRED_ID = budgets.WORRY_FREE_ANNOYANCES_RULES_RETIRED_BASE_ID;
if ( typeof RETIRED_ID !== 'number' ) {
    didNotRun('dnr-budgets.js does not export WORRY_FREE_ANNOYANCES_RULES_RETIRED_BASE_ID — the id must be kept, unused, per this project\'s retirement convention');
}

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}

check('dnr-budgets.js exports NO live WORRY_FREE_ANNOYANCES_RULES_BASE_ID (only the retired one)',
    budgets.WORRY_FREE_ANNOYANCES_RULES_BASE_ID === undefined);

for ( const [ label, isActive ] of [ [ 'no session', false ], [ 'session active', true ] ] ) {
    sessionRules = [];
    await manager.reconcileWorryFreeExtraSuppressionRule(isActive, `test-retired-${label}`);
    check(`${label}: no session rule registered at the retired id`,
        sessionRules.some(r => r.id === RETIRED_ID) === false);
}

const blockRules = shippedRules.filter(r => r.action?.type === 'block');
check('the shipped ruleset has network block rules to check', blockRules.length > 0, `${blockRules.length} block rules`);
const overridden = blockRules.filter(r => r.priority !== undefined && r.priority !== budgets.STATIC_FILTER_LIST_PRIORITY);
check('every shipped block rule sits at STATIC_FILTER_LIST_PRIORITY (no Worry-free priority override)',
    overridden.length === 0,
    overridden.length === 0 ? `${blockRules.length}/${blockRules.length} at default priority` : `${overridden.length} rules still overridden`);

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — the retired Worry-free suppression mechanism for ruleset_annoyances resurfaced.`);
    process.exit(1);
}
console.log('\nPASS: ruleset_annoyances has no Worry-free suppression mechanism — it behaves as an ordinary always-on default list.');
