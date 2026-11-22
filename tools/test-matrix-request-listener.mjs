#!/usr/bin/env node
// tools/test-matrix-request-listener.mjs — (10.5.6) the Matrix panel's request listener exists only while a session runs.
//
// Why: it used to be registered when the service worker loaded, for every URL of every tab, so Chrome woke the
// worker for every network request even with the Matrix closed (measured: 535 calls in 47 s with 10 idle tabs)
// and the worker never went idle. Drives the REAL js/core/matrix-panel.js against a mocked chrome API (C42):
//   Initiate — no listener after loading with nothing stored; the listener is attached by startMatrix(), before the
//              tab reload (so the first requests of the reloaded page are seen).
//   Perform  — a third-party request during the session reaches the module (an entry is broadcast).
//   End      — stopMatrix() detaches it, on every exit reason; a second stop leaves nothing behind.
//   Restart  — a worker that wakes with a running session in storage gets its listener back on hydration.
// Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
globalThis.self = globalThis;   // the extension modules expect a worker global

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE = 'js/core/matrix-panel.js';
const TAB_ID = 7;
const HOST = 'www.news.example';
const THIRD_PARTY_URL = 'https://tracker.example.net/pixel.gif';
const STORAGE_KEY = 'matrixPanelState';   // matrix-panel.js's own key (a stored running session = worker restart case)
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function didNotRun(msg) { console.log(`DID NOT RUN: ${msg}`); process.exit(EXIT_DID_NOT_RUN); }

// ── Mocked chrome API: one webRequest event that records its listeners; storage in memory ─────────
function makeEvent() {
    const listeners = new Set();
    return {
        listeners,
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); },
        hasListener(fn) { return listeners.has(fn); },
        fire(details) { for ( const fn of listeners ) { fn(details); } },
    };
}
function makeArea(initial = {}) {
    const data = { ...initial };
    return {
        get: async keys => { const out = {}; for ( const k of [].concat(keys ?? Object.keys(data)) ) { if ( k in data ) { out[k] = data[k]; } } return out; },
        set: async obj => { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
        remove: async keys => { for ( const k of [].concat(keys) ) { delete data[k]; } },
    };
}
const broadcasts = [];
const reloads = [];
// ONE mock object for the whole run: js/data/ext.js captures it once at load (and node caches that module), so a
// "worker restart" swaps the storage and the event IN PLACE rather than installing a new object.
function installChrome(sessionStore) {
    const onBeforeRequest = makeEvent();
    if ( globalThis.chrome === undefined ) {
        globalThis.chrome = globalThis.browser = {
            runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => p, lastError: null, id: 'test', onMessage: { addListener() {} } },
            storage: { local: makeArea() },
            webRequest: {},
            tabs: { reload: async tabId => { reloads.push({ tabId, listenerAttached: globalThis.chrome.webRequest.onBeforeRequest.listeners.size > 0 }); }, get: async () => ({}), query: async () => [] },
            declarativeNetRequest: { getDynamicRules: async () => [], getSessionRules: async () => [], getEnabledRulesets: async () => [] },
            // (10.7.6) the session deadline is a chrome.alarms alarm (js/core/session-deadline.js; tested in step 64)
            alarms: { create: async () => {}, clear: async () => true },
        };
        globalThis.BroadcastChannel = class { postMessage(m) { broadcasts.push(m); } close() {} };
        globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    }
    globalThis.chrome.storage.session = makeArea(sessionStore);
    globalThis.chrome.webRequest.onBeforeRequest = onBeforeRequest;
    return onBeforeRequest;
}

async function loadFresh() {
    // A fresh module instance per scenario = a fresh service-worker start.
    return import(`${pathToFileURL(path.join(ROOT, MODULE)).href}?run=${Math.random()}`);
}
async function settle() { for ( let i = 0; i < 5; i++ ) { await new Promise(r => setTimeout(r, 0)); } }

async function main() {
    let event, mp;
    try {
        event = installChrome({});
        mp = await loadFresh();
    } catch ( err ) { didNotRun(`cannot import ${MODULE} (${err.message})`); }
    for ( const fn of [ 'startMatrix', 'stopMatrix', 'getMatrixData' ] ) {
        if ( typeof mp[fn] !== 'function' ) { didNotRun(`${MODULE} does not export ${fn} — this check needs updating`); }
    }

    console.log('\n── Initiate ──');
    await settle();
    check('no request listener while no session runs (worker not woken by every request)', event.listeners.size === 0, `${event.listeners.size} listener(s)`);
    await mp.startMatrix(TAB_ID, HOST);
    check('startMatrix() attaches exactly one listener', event.listeners.size === 1, `${event.listeners.size}`);
    check('…before the tab reload, so the reloaded page\'s first requests are seen', reloads.at(-1)?.listenerAttached === true);

    console.log('\n── Perform ──');
    const before = broadcasts.length;
    event.fire({ tabId: TAB_ID, url: THIRD_PARTY_URL, type: 'image' });
    check('a third-party request during the session reaches the Matrix', broadcasts.length === before + 1, `${broadcasts.length - before} broadcast(s)`);

    console.log('\n── End ──');
    await mp.stopMatrix('user');
    check('stopMatrix() detaches the listener', event.listeners.size === 0, `${event.listeners.size}`);
    await mp.startMatrix(TAB_ID, HOST);
    await mp.stopMatrix('timeout');
    check('a timed-out session detaches it too', event.listeners.size === 0);
    await mp.stopMatrix('user');
    check('a second stop leaves nothing behind', event.listeners.size === 0);

    console.log('\n── Restart ──');
    const stored = { [STORAGE_KEY]: { session: { tabId: TAB_ID, host: HOST, hostEtldPlusOne: 'news.example', phase: 'running', startTime: Date.now(), timeElapsed: 0 }, entriesByDomain: {} } };
    event = installChrome(stored);
    mp = await loadFresh();
    await settle();
    check('a worker waking with a running session gets its listener back', event.listeners.size === 1, `${event.listeners.size}`);
    await mp.stopMatrix('user');
    check('…and releases it when that session ends', event.listeners.size === 0);
}

main().then(() => {
    console.log(failures ? `\nFAIL: ${failures} problem(s)` : '\nPASS: the Matrix request listener lives exactly as long as its session.');
    process.exit(failures ? EXIT_FAIL : EXIT_PASS);
}).catch(err => didNotRun(err.stack ?? err.message));
