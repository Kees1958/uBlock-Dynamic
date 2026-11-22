#!/usr/bin/env node
// tools/test-cmp-loader-block.mjs — CMP loader blocks (10.7.16), HARD check.
//
// Proves the Initiate / Perform / End lifecycle (C41) of js/core/cmp-loader-block-manager.js against the REAL exported
// function (Part D step 15 — never a re-implementation), with only chrome.declarativeNetRequest's session-rule store
// mocked, plus the wiring in js/core/scripting-manager.js that decides WHEN it runs:
//   Initiate — Seamless surfing in DECLINE mode adds one block rule per js/data/cmp-loader-blocks.js entry;
//   Perform  — the rule blocks Sourcepoint's loader (script only) at CMP_LOADER_BLOCK_PRIORITY, saved-rule sites are
//              exempt (standing precedence rule), malformed input is filtered, an unchanged state writes nothing;
//   End      — the RELEASE path (no session, or ACCEPT mode) removes every rule of the reserved id range.
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Config (one place) ───────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    LOADER_URL_FILTER: '/wrapperMessagingWithoutDetection.js^',   // must match js/data/cmp-loader-blocks.js
    RULE_SITES: Object.freeze([ 'www.bbc.com', 'tweakers.net' ]),
    // (11.0.2) 'bad_host.example' removed: '_' is valid (Chrome's DNR only refuses non-ASCII domains,
    // indexed_rule.cc CanonicalizeDomains()); 'nodot' (one label) and 'bad..host' are malformed instead.
    BAD_SITES: Object.freeze([ 'Not A Host', '', 42, 'nodot', 'bad..host' ]),
    FOREIGN_RULE_ID: 123,   // a session rule owned by someone else — must survive every pass
});

console.log('=== CMP loader blocks — Initiate / Perform / End (C41) ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

// ── Minimal declarativeNetRequest mock: a real session-rule store with Chrome's remove-then-add semantics ──
let sessionRules = [];
// (11.0.0) The regex Chrome really refused (2 KB compiled limit): a long counted repetition like {32}.
const REFUSED_REGEX_RE = /\{3\d\}/;
const COOKIE_NOTICE_BLOCK_FILE = 'rulesets/cookie-notice-block-decline.json';
globalThis.fetch = async url => ({ json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, String(url).replace(/^\//, '')), 'utf8')) });
let writeCount = 0;
// Deep copy so the mock never shares objects with the module under test (rules are plain JSON data).
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null },
    declarativeNetRequest: {
        getSessionRules: async () => cloneJson(sessionRules),
        // (11.0.0) Chrome's own regex check, and its all-or-nothing update: one refused regex fails the whole batch.
        isRegexSupported: async ({ regex }) => (REFUSED_REGEX_RE.test(regex)
            ? { isSupported: false, reason: 'memoryLimitExceeded' } : { isSupported: true }),
        updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
            if ( addRules.some(r => REFUSED_REGEX_RE.test(r.condition?.regexFilter ?? '')) ) {
                throw new Error('Rule was skipped as the "regexFilter" value exceeded the 2KB memory limit when compiled.');
            }
            writeCount += 1;
            const ids = new Set(removeRuleIds);
            const kept = sessionRules.filter(r => ids.has(r.id) === false);
            for ( const r of addRules ) {
                if ( kept.some(k => k.id === r.id) ) { throw new Error(`duplicate rule id ${r.id}`); }
                kept.push(cloneJson(r));
            }
            sessionRules = kept;
        },
    },
};

let mgr, B, data;
try {
    mgr  = await import(path.join(ROOT, 'js/core/cmp-loader-block-manager.js'));
    B    = await import(path.join(ROOT, 'js/core/dnr-budgets.js'));
    data = await import(path.join(ROOT, 'js/data/cmp-loader-blocks.js'));
} catch (e) {
    didNotRun(`could not import the real modules: ${e.message}`);
}

const findings = [];
function ok(cond, label) {
    console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
    if ( !cond ) { findings.push(label); }
}
function ownRules() {
    return sessionRules.filter(r => r.id >= B.CMP_LOADER_BLOCK_RULES_BASE_ID
        && r.id < B.CMP_LOADER_BLOCK_RULES_BASE_ID + B.CMP_LOADER_BLOCK_RULES_MAX);
}

// A foreign session rule must never be touched.
sessionRules = [ { id: CONFIG.FOREIGN_RULE_ID, priority: 1, action: { type: 'allow' }, condition: { urlFilter: 'x' } } ];

// ── Initiate ──────────────────────────────────────────────────────────────────
await mgr.syncCmpLoaderBlockRules(true, [ ...CONFIG.RULE_SITES ]);
ok(ownRules().length === data.CMP_LOADER_BLOCKS.length,
    `initiate: decline mode adds one loader-block rule per CMP_LOADER_BLOCKS entry (${data.CMP_LOADER_BLOCKS.length})`);

// ── Perform ───────────────────────────────────────────────────────────────────
const sp = ownRules().find(r => r.condition.urlFilter === CONFIG.LOADER_URL_FILTER);
ok(sp !== undefined, 'perform: the Sourcepoint loader (wrapperMessagingWithoutDetection.js) is blocked');
ok(sp?.action.type === 'block' && sp?.priority === B.CMP_LOADER_BLOCK_PRIORITY && sp?.priority === 9_200,
    'perform: a block rule at CMP_LOADER_BLOCK_PRIORITY (9 200)');
ok(JSON.stringify(sp?.condition.resourceTypes) === JSON.stringify([ 'script' ]), 'perform: scripts only — nothing else of the CMP is touched');
ok(JSON.stringify([ ...(sp?.condition.excludedInitiatorDomains ?? []) ].sort()) === JSON.stringify([ ...CONFIG.RULE_SITES ].sort()),
    'perform: sites with a saved cookie-clicker rule are exempt (saved rules prevail)');
ok(B.CMP_LOADER_BLOCK_PRIORITY < B.STATIC_FILTER_LIST_PRIORITY && B.CMP_LOADER_BLOCK_PRIORITY < B.WORRY_FREE_SITE_ALLOW_PRIORITY,
    'perform: below the default lists and "@@site$worryfree", so their allows still win');

const writesBefore = writeCount;
await mgr.syncCmpLoaderBlockRules(true, [ ...CONFIG.RULE_SITES ].reverse());
ok(writeCount === writesBefore, 'perform: an unchanged state (same sites, any order) makes no DNR write (churn guard)');

await mgr.syncCmpLoaderBlockRules(true, [ ...CONFIG.RULE_SITES, ...CONFIG.BAD_SITES ]);
const sp2 = ownRules()[0];
ok(JSON.stringify([ ...(sp2?.condition.excludedInitiatorDomains ?? []) ].sort()) === JSON.stringify([ ...CONFIG.RULE_SITES ].sort()),
    'perform: malformed exempt hostnames are filtered out (one bad entry would fail the whole DNR update)');

await mgr.syncCmpLoaderBlockRules(true, []);
ok(ownRules().length === data.CMP_LOADER_BLOCKS.length && ownRules()[0].condition.excludedInitiatorDomains === undefined,
    'perform: with no saved rules the block covers every site (no empty exclusion list)');

// ── End ───────────────────────────────────────────────────────────────────────
await mgr.syncCmpLoaderBlockRules(false);
ok(ownRules().length === 0, 'end: release removes every loader-block rule');
ok(sessionRules.some(r => r.id === CONFIG.FOREIGN_RULE_ID), 'end: a session rule outside the reserved range is left alone');

await mgr.syncCmpLoaderBlockRules('yes', CONFIG.RULE_SITES);
ok(ownRules().length === 0, 'end: a non-boolean switch is treated as off (input guard)');

// ── (11.0.0) A regex Chrome refuses must not take the other rules down (real incident, 11.0.0 first load) ──
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, COOKIE_NOTICE_BLOCK_FILE), 'utf8'));
const refusedInFile = shipped.filter(r => REFUSED_REGEX_RE.test(r.condition?.regexFilter ?? '')).length;
function cookieNoticeRules() {
    return sessionRules.filter(r => r.id >= B.COOKIE_NOTICE_BLOCK_RULES_BASE_ID
        && r.id < B.COOKIE_NOTICE_BLOCK_RULES_BASE_ID + B.COOKIE_NOTICE_BLOCK_RULES_MAX);
}
await mgr.syncCmpLoaderBlockRules(true, [], COOKIE_NOTICE_BLOCK_FILE);
ok(refusedInFile !== 0, 'regex guard: the shipped file still holds the regex Chrome refused (test input is real)');
ok(ownRules().length === data.CMP_LOADER_BLOCKS.length && cookieNoticeRules().length === shipped.length - refusedInFile
    && cookieNoticeRules().every(r => REFUSED_REGEX_RE.test(r.condition?.regexFilter ?? '') === false),
    'regex guard: only the refused regex rule is dropped — every other loader and cookie-notice block rule is installed');
await mgr.syncCmpLoaderBlockRules(false);
ok(ownRules().length === 0 && cookieNoticeRules().length === 0, 'regex guard: release still removes everything');

// ── Wiring: WHEN it runs (scripting-manager.js) ──────────────────────────────
const sm = fs.readFileSync(path.join(ROOT, 'js/core/scripting-manager.js'), 'utf8');
const impl = sm.slice(sm.indexOf('async function registerCookieClickerAutoDenyContentScriptsImpl'));
const releaseIdx = impl.indexOf('if ( active === false )');
const releaseBlock = impl.slice(releaseIdx, impl.indexOf('}', impl.indexOf('unregisterContentScripts', releaseIdx)));
ok(releaseIdx !== -1 && releaseBlock.includes('syncCmpLoaderBlockRules(false)'),
    'wiring: no Seamless surfing session -> the RELEASE path removes the loader block');
// (11.0.0) The call also hands over the mode's cookie-notice block file; the loader block itself stays DECLINE-only.
ok(/syncCmpLoaderBlockRules\(\s*declining\s*,\s*ruleSites\s*,\s*modeFiles\.blocks\s*\)/.test(impl)
    && /const mode = cookieBannerActionFor\(securityConfig\)/.test(impl)
    && /const declining = mode === COOKIE_BANNER_ACTIONS\.DECLINE/.test(impl),
    'wiring: an active session blocks the CMP loader ONLY in DECLINE mode (the other modes leave the dialog), with the saved-rule sites exempt');

if ( findings.length !== 0 ) {
    console.log(`\nFINDINGS: ${findings.length} — the CMP loader block lifecycle is broken.`);
    process.exit(1);
}
console.log('\nPASS: CMP loader blocks start in decline mode, block the loader with saved-rule sites exempt, and are released.');
