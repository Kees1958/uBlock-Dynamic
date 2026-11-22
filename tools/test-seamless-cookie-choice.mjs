#!/usr/bin/env node
// tools/test-seamless-cookie-choice.mjs — (10.7.1) the Seamless surfing cookie-banner choice, end to end on the
// background side, against the REAL modules with a mocked chrome (harness ported from
// tools/test-annoyances-suppression.mjs, C21):
//   1. js/data/cookie-banner-action.js — (11.0.0) default "accept, else decline" (prefer-accept), accept / decline when
//      chosen, an unknown stored value reads as the default, each mode maps to an existing generated bundle
//   2. js/core/seamless-cookie-prompt.js — due on a fresh install; not due again in the same browser session once
//      offered; not due after an answer; due again after "Reset to defaults" (storage cleared)
//   3. handleCookieClickerAutoDenyStart — stores a valid choice, ignores an invalid one, records the answer, and the
//      registered session bundle follows the choice; handleSeamlessCookiePromptDismiss records the answer only
//   3b. timed sessions retired — no cancel/expire exports; sessions are open-ended; retireTimedSession() converts a
//      pre-update timed session and releases its expiry job, idempotently
//   4. handleWorryFreeLaunchPicker — opens the prompt also while a session runs (no click-to-turn-off any more)
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
console.log('=== Seamless surfing cookie-banner choice (10.7.1) ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

// ── Minimal browser/chrome mock ───────────────────────────────────────────────
const local = new Map();
const session = new Map();
let registered = [];          // registered content scripts
const injected = [];          // executeScript calls
function mkArea(store) { return {
    get: async keys => {
        if ( keys === null || keys === undefined ) { return Object.fromEntries(store); }
        const names = typeof keys === 'string' ? [ keys ] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(names.filter(k => store.has(k)).map(k => [ k, store.get(k) ]));
    },
    set: async obj => { for ( const [ k, v ] of Object.entries(obj) ) { store.set(k, v); } },
    remove: async keys => { for ( const k of (typeof keys === 'string' ? [ keys ] : keys) ) { store.delete(k); } },
    clear: async () => { store.clear(); },
    setAccessLevel: async () => {},
}; }
globalThis.self = globalThis;
globalThis.chrome = globalThis.browser = {
    // (11.0.0) the prompt is due again for an answer older than 11.0.0
    runtime: { getManifest: () => ({ version: '11.0.0' }), getURL: p => p, lastError: null, id: 'test', onMessage: { addListener() {} } },
    storage: { local: mkArea(local), session: mkArea(session), onChanged: { addListener() {} } },
    declarativeNetRequest: {
        updateDynamicRules: async () => {}, getDynamicRules: async () => [],
        updateSessionRules: async () => {}, getSessionRules: async () => [],
        updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [],
    },
    scripting: {
        getRegisteredContentScripts: async ({ ids } = {}) => registered.filter(r => !ids || ids.includes(r.id)),
        registerContentScripts: async list => { registered = registered.filter(r => !list.some(n => n.id === r.id)).concat(list); },
        updateContentScripts: async list => { registered = registered.map(r => ({ ...r, ...(list.find(n => n.id === r.id) ?? {}) })); },
        unregisterContentScripts: async ({ ids } = {}) => { registered = ids ? registered.filter(r => !ids.includes(r.id)) : []; },
        executeScript: async details => { injected.push(details); return []; },
    },
    tabs: { query: async () => [], get: async () => ({}), sendMessage: async () => {} },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [ '<all_urls>' ] }) },
    action: { setIcon() {}, setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    alarms: { create() {}, clear: async () => true, get: async () => undefined, onAlarm: { addListener() {} } },
};

let action, prompt, routes, config;
try {
    action = await import(path.join(ROOT, 'js/data/cookie-banner-action.js'));
    prompt = await import(path.join(ROOT, 'js/core/seamless-cookie-prompt.js'));
    config = await import(path.join(ROOT, 'js/data/config.js'));
    routes = await import(path.join(ROOT, 'js/workflow/cookie-clicker-routes.js'));
} catch ( err ) {
    didNotRun(`cannot import the modules under test (${err.message})`);
}

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}
const { COOKIE_BANNER_ACTIONS: A, COOKIE_BANNER_SETTING_KEY: KEY } = action;
const sc = config.securityConfig;

// ── 1. Decision module ──
check('default choice is accept, else decline', action.cookieBannerActionFor(sc) === A.PREFER_ACCEPT, sc[KEY]);
check('accept when chosen', action.cookieBannerActionFor({ [KEY]: A.ACCEPT }) === A.ACCEPT);
check('unknown stored value reads as the default (accept, else decline)', action.cookieBannerActionFor({ [KEY]: 'yes please' }) === A.PREFER_ACCEPT);
for ( const mode of Object.values(A) ) {
    const file = action.COOKIE_BANNER_BUNDLES[mode];
    check(`${mode}: bundle ${file} exists`, fs.existsSync(path.join(ROOT, file.replace(/^\//, ''))));
}
check('the two modes use different bundles', action.COOKIE_BANNER_BUNDLES[A.ACCEPT] !== action.COOKIE_BANNER_BUNDLES[A.DECLINE]);

// ── 2. Once-after-update markers ──
check('fresh install: prompt is due', await prompt.isCookiePromptDue() === true);
await prompt.markCookiePromptOffered();
check('offered in this browser session: not due again', await prompt.isCookiePromptDue() === false);
session.clear();
check('next browser session, still unanswered: due again', await prompt.isCookiePromptDue() === true);

// ── 3. Start / dismiss handlers ──
const sender = { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' };
await routes.handleCookieClickerAutoDenyStart({ cookieBannerAction: A.ACCEPT }, sender);
check('start with accept: choice stored', sc[KEY] === A.ACCEPT);
check('start: prompt recorded as answered', await prompt.isCookiePromptDue() === false);
const autodeny = registered.find(r => (r.js ?? []).some(f => /auto(deny|accept)-snippets/.test(f)));
check('start with accept: session registers the ACCEPT bundle', autodeny?.js?.[0] === action.COOKIE_BANNER_BUNDLES[A.ACCEPT], JSON.stringify(autodeny?.js));
check('start with accept: immediate apply on this tab uses the ACCEPT bundle',
    injected.some(d => (d.files ?? []).includes(action.COOKIE_BANNER_BUNDLES[A.ACCEPT])));

await routes.handleCookieClickerAutoDenyStart({ cookieBannerAction: A.DECLINE }, sender);
const autodeny2 = registered.find(r => (r.js ?? []).some(f => /auto(deny|accept)-snippets/.test(f)));
check('switch to decline while running: choice stored', sc[KEY] === A.DECLINE);
check('switch to decline while running: registration follows', autodeny2?.js?.[0] === action.COOKIE_BANNER_BUNDLES[A.DECLINE], JSON.stringify(autodeny2?.js));

await routes.handleCookieClickerAutoDenyStart({ cookieBannerAction: 'everything' }, sender);
check('invalid choice ignored (stored choice kept)', sc[KEY] === A.DECLINE);

local.clear(); session.clear();   // "Reset to defaults"
check('after reset: prompt due again', await prompt.isCookiePromptDue() === true);
await routes.handleSeamlessCookiePromptDismiss();
check('Cancel: prompt recorded as answered', await prompt.isCookiePromptDue() === false);

// ── 3b. Timed sessions retired (10.7.1) ──
let manager;
try { manager = await import(path.join(ROOT, 'js/core/cookie-clicker-autodeny-manager.js')); } catch (err) { didNotRun(`cannot import the session manager (${err.message})`); }
check('no cancel / expire exports left', manager.cancelAutoDeny === undefined && manager.expireAutoDeny === undefined);
const running = await manager.getAutoDenyState();
check('a started session is open-ended (untilMs null, no remainingMs)', running.active === true && running.untilMs === null && running.remainingMs === undefined, JSON.stringify(running));
// A pre-update timed record plus its expiry job, as 10.7.0 left them:
const future = Date.now() + 20 * 60 * 1000;
local.set('cookieClicker.autoDeny', { active: true, untilMs: future, startedAtMs: Date.now() });
local.set('deferredJobs', [ { name: 'cookieClickerAutoDenyExpire', time: future } ]);
const freshManager = await import(path.join(ROOT, 'js/core/cookie-clicker-autodeny-manager.js') + '?fresh=1');   // fresh in-memory mirror
await freshManager.retireTimedSession();
check('retire: the pre-update timed session is now open-ended', local.get('cookieClicker.autoDeny')?.untilMs === null, JSON.stringify(local.get('cookieClicker.autoDeny')));
check('retire: its expiry job is released', !(local.get('deferredJobs') ?? []).some(j => j.name === 'cookieClickerAutoDenyExpire'));
await freshManager.retireTimedSession();
check('retire is idempotent', local.get('cookieClicker.autoDeny')?.untilMs === null);

// ── 4. Popup line click while a session runs ──
injected.length = 0;
const res = await routes.handleWorryFreeLaunchPicker({ tabId: 7 });
check('click while running opens the prompt (no turn-off)', res?.action === 'launched'
    && injected.some(d => (d.files ?? []).includes('/js/scripting/worry-free-picker.js')), JSON.stringify(res));

if ( failures !== 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) in the Seamless surfing cookie-banner choice.`);
    process.exit(1);
}
console.log('\nPASS: the cookie-banner choice is stored, followed by the session, and the prompt is offered once.');
process.exit(0);
