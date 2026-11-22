#!/usr/bin/env node
// tools/test-priority-ladder-migration.mjs — dynamic/security rules always land on the CURRENT
// priority ladder, no matter what priority a stale rule was previously written at (HARD check).
//
// (10.0.3) This file's original purpose — verifying the 9.9.1 one-time migration step
// (reapplyDynamicRulesForPriorityLadder) actually reached rules an auto-update left behind at the OLD
// ladder (2 000 000 / 1 600 000 / 1 550 000 / 1 500 000 / 1 000 000) — no longer applies: that step,
// and every other pre-10.0.3 migration, was removed in 10.0.3 (see CHANGELOG_HISTORY.md's 10.0.3
// entry; this codebase starts a fresh release lineage with no in-place upgrade path). The three checks
// that source-scraped background.js for that removed step and its removed companion session-rule
// clear were removed along with it.
//
// What's left still has independent, ongoing value and was kept: updateUserRules() is the real
// function any fresh (re)registration pass calls, and this test drives it with rules SEEDED at what
// the OLD (pre-9.9.1) ladder would have written, to confirm it always rebuilds onto the CURRENT
// ladder regardless of what priority was already there — i.e. the function is not merely correct for
// a brand-new install, it is also self-correcting if it is ever handed stale data by some future path
// this test doesn't know about yet. Only Chrome's storage/DNR APIs are mocked.
//
// (10.3.0 removal) Section 2 (updateSecurityRules()) REMOVED — that function and the whole
// security-toggle-rule mechanism it rebuilt were retired along with the Privacy & Security tab's
// "Security enhancements"/breakage-risk groups; see CHANGELOG.md 10.3.0. Only updateUserRules()
// survives this file's own self-correction test now.
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
console.log('=== Priority ladder: stale-priority rules are always rebuilt onto the current ladder ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}

// ── mock ──────────────────────────────────────────────────────────────────────
const storage = new Map();
let dynamicRules = [];
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
        isRegexSupported: async () => ({ isSupported: true }),
        updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
            dynamicRules = dynamicRules.filter(r => removeRuleIds.includes(r.id) === false).concat(JSON.parse(JSON.stringify(addRules)));
        },
        getDynamicRules: async () => dynamicRules,
        updateSessionRules: async () => {}, getSessionRules: async () => [],
        updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [],
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

let budgets, rm;
try {
    budgets = await import(path.join(ROOT, 'js/core/dnr-budgets.js'));
    rm = await import(path.join(ROOT, 'js/core/ruleset-manager.js'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}
for ( const fn of [ 'updateUserRules' ] ) {
    if ( typeof rm[fn] !== 'function' ) { didNotRun(`ruleset-manager.js does not export ${fn} — this check needs updating`); }
}

const OLD = { USER: 1_000_000 };
const maxAllowed = budgets.MATRIX_RULES_ALL_PRIORITY;       // everything that is "a user rule" must stay below Matrix

// ── 1. imported / custom rules ───────────────────────────────────────────────
// A previous version wrote this rule at OLD.USER + 10 (a block); the compiled source in storage still
// holds the small offset (10), exactly as the real compiler stores it.
dynamicRules = [ { id: budgets.USER_RULES_BASE_ID, priority: OLD.USER + 10, action: { type: 'block' }, condition: { urlFilter: '||old.example^' } } ];
storage.set('sandboxFilters.dnrRules', [
    { id: budgets.USER_RULES_BASE_ID,     priority: 10, action: { type: 'block' },    condition: { urlFilter: '||old.example^' } },
    { id: budgets.USER_RULES_BASE_ID + 1, priority: 30, action: { type: 'allow' },    condition: { urlFilter: '||ok.example^' } },
]);
await rm.updateUserRules();
const mine = dynamicRules.filter(r => r.id >= budgets.USER_RULES_BASE_ID && r.id < budgets.USER_RULES_BASE_ID + budgets.USER_RULES_MAX);
check('user rules were re-written', mine.length === 2, `${mine.length} rules`);
check('  ... at USER_RULES_PRIORITY + their own offset (200 010 / 200 030)',
    mine.every(r => r.priority >= budgets.USER_RULES_PRIORITY && r.priority < budgets.USER_RULES_PRIORITY + 100),
    mine.map(r => r.priority).join(','));
check('  ... and no user rule outranks the pause list or the Matrix panel',
    mine.every(r => r.priority < maxAllowed && r.priority < budgets.TRUSTED_DIRECTIVE_PRIORITY));
check('  ... and no stale rule at the old priority is left', !dynamicRules.some(r => r.priority >= OLD.USER));

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) — a rule seeded at an old priority was not rebuilt onto the current ladder.`);
    process.exit(1);
}
console.log('\nPASS: updateUserRules() always rebuilds onto the current ladder, regardless of a rule\'s prior priority.');
