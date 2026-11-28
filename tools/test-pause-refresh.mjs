#!/usr/bin/env node
// tools/test-pause-refresh.mjs — (11.1.6) the refresh when filtering is paused, against the REAL js/core/pause-refresh.js
// with only the browser APIs mocked (C42):
//   1. a web page: its OWN origin's HTTP cache and Cache Storage are cleared (service workers kept, cookies/storage
//      never touched), THEN the tab is reloaded from the network
//   2. not a web page (extension/browser page), a closed tab, or no / a bad tab id: nothing is cleared or reloaded
//   3. a failed clear is logged and the tab is still reloaded
//   4. wiring: both pause entry points use it (global pause with the popup's tab, per-site switch set OFF), the popup
//      sends its tab id with both pause messages
// Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
globalThis.self = globalThis;   // the extension modules expect a worker global

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE = 'js/core/pause-refresh.js';
const WEB_TAB_ID = 7, EXT_TAB_ID = 8, GONE_TAB_ID = 9;
const WEB_URL = 'https://shop.example/basket?x=1';
const WEB_ORIGIN = 'https://shop.example';
const EXPECTED_TYPES = Object.freeze({ cache: true, cacheStorage: true, serviceWorkers: false });
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function didNotRun(msg) { console.log(`DID NOT RUN: ${msg}`); process.exit(EXIT_DID_NOT_RUN); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── Mocked chrome API: records every call in one ordered log ──────────────────────────────────────
const calls = [];
let failRemove = false;
const TABS = new Map([
    [ WEB_TAB_ID, { id: WEB_TAB_ID, url: WEB_URL } ],
    [ EXT_TAB_ID, { id: EXT_TAB_ID, url: 'chrome-extension://test/dashboard.html' } ],
]);
globalThis.chrome = globalThis.browser = {
    runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: p => `chrome-extension://test${p}`, lastError: null, id: 'test' },
    tabs: {
        get: async tabId => {
            if ( TABS.has(tabId) === false ) { throw new Error(`No tab with id: ${tabId}.`); }
            return TABS.get(tabId);
        },
        reload: async (tabId, props) => { calls.push({ op: 'reload', tabId, bypassCache: props?.bypassCache }); },
        update: async (tabId, props) => { calls.push({ op: 'update', tabId, url: props?.url }); },
    },
    browsingData: {
        remove: async (options, types) => {
            calls.push({ op: 'remove', options, types });
            if ( failRemove ) { throw new Error('simulated browsingData failure'); }
        },
    },
};

let mod;
try {
    mod = await import(pathToFileURL(path.join(ROOT, MODULE)).href);
} catch ( err ) {
    didNotRun(`cannot import ${MODULE} (${err.message})`);
}

// 1. A web page: clear its own origin, then reload from the network.
await mod.refreshTabAfterPause(WEB_TAB_ID);
const [ c0, c1 ] = calls;
check('web page — site caches cleared first, for its own origin only',
    calls.length === 2 && c0.op === 'remove'
        && JSON.stringify(c0.options) === JSON.stringify({ origins: [ WEB_ORIGIN ] })
        && JSON.stringify(c0.types) === JSON.stringify(EXPECTED_TYPES),
    JSON.stringify(calls));
check('web page — then reloaded, bypassing the cache', c1?.op === 'reload' && c1.tabId === WEB_TAB_ID && c1.bypassCache === true,
    JSON.stringify(c1));

// 2. Nothing for a non-web page, a closed tab, or a missing / bad tab id.
calls.length = 0;
for ( const tabId of [ EXT_TAB_ID, GONE_TAB_ID, undefined, -1, 1.5, '7' ] ) {
    await mod.refreshTabAfterPause(tabId);
}
check('extension page, closed tab, missing or bad tab id — nothing cleared or reloaded', calls.length === 0, JSON.stringify(calls));

// 3. A failed clear does not stop the reload.
calls.length = 0;
failRemove = true;
const origError = console.error;
let logged = 0;
console.error = () => { logged += 1; };
try {
    await mod.refreshTabAfterPause(WEB_TAB_ID);
} finally {
    console.error = origError;   // release: restore the real logger whatever happened
    failRemove = false;
}
check('failed clear — logged, tab still reloaded', logged === 1 && calls.at(-1)?.op === 'reload', JSON.stringify(calls));

// 4. Wiring — every pause entry point goes through the ONE refresh.
const temp = read('js/core/temp-disable-manager.js');
check('global pause (timed and until restart) refreshes the popup\'s tab',
    (temp.match(/await refreshTabAfterPause\(tabId\);/g) ?? []).length === 2
        && /export async function startTempDisable\(minutes, tabId\)/.test(temp)
        && /export async function startTempDisableUntilRestart\(tabId\)/.test(temp));
const siteMode = read('js/core/site-mode-manager.js');
check('per-site switch set OFF uses the pause refresh', /mode === SITE_MODE_OFF[\s\S]{0,80}refreshTabAfterPause\(tabId\)/.test(siteMode));
const routes = read('js/workflow/temp-disable-routes.js');
check('routes pass the tab id on', /startTempDisable\(request\.minutes, request\.tabId\)/.test(routes)
    && /startTempDisableUntilRestart\(request\.tabId\)/.test(routes));
const popupUi = read('popup/temp-disable-ui.js');
check('popup sends its tab id with both pause messages',
    (popupUi.match(/tabId: getCurrentTabId\(\)/g) ?? []).length === 2);

process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
