// tools/e2e_seamless_line.mjs — (10.7.1) the popup's ONE Seamless surfing line, driven through the REAL
// popup/worry-free-ui.js against the REAL popup/popup.html (replaces e2e_countdown.mjs / e2e_reopen.mjs: the
// countdown was removed). Scenarios: session off, on + accept, on + decline, on + unknown action (must read as
// decline). Every expected text is derived from js/data/ui-names.js (C39a) — never typed here — and the
// accept/decline words from the line's own contract below.
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { UI_NAMES } from '../js/data/ui-names.js';
import { COOKIE_BANNER_ACTIONS } from '../js/data/cookie-banner-action.js';

// ── Config ──────────────────────────────────────────────────────────────────────
const ROOT = process.cwd();
const INIT_SETTLE_MS = 50;   // init() is async: one sendMessage round-trip on module load
// The line's contract (owner, 10.7.1): "<mode> - accept" / "<mode> - decline", "<mode>" when off.
const SCENARIOS = Object.freeze([
    { name: 'session off',              state: { active: false },                                                 expect: UI_NAMES.worryFreeMode },
    { name: 'on, accept',               state: { active: true, cookieBannerAction: COOKIE_BANNER_ACTIONS.ACCEPT },  expect: `${UI_NAMES.worryFreeMode} - accept` },
    { name: 'on, decline',              state: { active: true, cookieBannerAction: COOKIE_BANNER_ACTIONS.DECLINE }, expect: `${UI_NAMES.worryFreeMode} - decline` },
    { name: 'on, accept else decline',  state: { active: true, cookieBannerAction: COOKIE_BANNER_ACTIONS.PREFER_ACCEPT }, expect: `${UI_NAMES.worryFreeMode} - smart` },
    // (11.0.0) An unknown action reads as the default mode, "accept, else decline".
    { name: 'on, unknown action (guard)', state: { active: true, cookieBannerAction: 'bogus' },                     expect: `${UI_NAMES.worryFreeMode} - smart` },
]);
const EXPOSED_GLOBALS = [ 'window', 'document', 'navigator', 'location', 'HTMLElement', 'Node', 'CustomEvent', 'Event',
    'MutationObserver', 'Blob', 'URL', 'Window', 'Document', 'Element' ];

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

let html;
try { html = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8'); } catch (err) { didNotRun(`popup/popup.html unreadable (${err.message})`); }

// ONE mock object for the whole run: js/data/ext.js captures `browser` once, at its first evaluation, so the
// per-scenario answer is read from `current` at call time instead of swapping mocks.
let current = SCENARIOS[0];
const chromeMock = {
    runtime: {
        id: 'x', getURL: p => `chrome-extension://test/${p}`,
        sendMessage: msg => Promise.resolve(msg.what === 'cookieClickerAutoDenyGet' ? current.state : { ok: true }),
        onMessage: { addListener() {} },
    },
    scripting: {},
    tabs: { query: () => Promise.resolve([ { id: 42, url: 'https://example.com/' } ]) },
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, session: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } },
    i18n: { getMessage: k => k },
};

let failures = 0;
for ( const scenario of SCENARIOS ) {
    current = scenario;
    const dom = new JSDOM(html, { url: 'chrome-extension://test/popup/popup.html', runScripts: 'outside-only' });
    const { window } = dom;
    window.chrome = window.browser = chromeMock;
    for ( const key of EXPOSED_GLOBALS ) {
        if ( window[key] !== undefined ) { Object.defineProperty(global, key, { value: window[key], writable: true, configurable: true }); }
    }
    global.chrome = global.browser = chromeMock;
    global.self = window;
    // A fresh module instance per scenario (query string), so init() runs against this scenario's DOM.
    await import(pathToFileURL(path.join(ROOT, 'popup/worry-free-ui.js')).href + `?scenario=${encodeURIComponent(scenario.name)}`);
    await new Promise(r => setTimeout(r, INIT_SETTLE_MS));
    const label = window.document.getElementById('worryFreeLabel');
    const countdown = window.document.getElementById('worryFreeCountdown');
    const okText = label?.textContent === scenario.expect;
    const okOneLine = countdown === null && (label?.title ?? '') === '';
    console.log(`${okText && okOneLine ? 'OK  ' : 'FAIL'} ${scenario.name}: ${JSON.stringify(label?.textContent)}`
        + (okText ? '' : ` (expected ${JSON.stringify(scenario.expect)})`)
        + (okOneLine ? '' : ' — not one line: a countdown element or a hover text is still present'));
    if ( !okText || !okOneLine ) { failures++; }
    dom.window.close();   // release this scenario's DOM before the next one
}

if ( failures > 0 ) {
    console.log(`\n${failures} scenario(s) failed.`);
    process.exit(1);
}
console.log('\nPASS: the popup shows one Seamless surfing line, with the cookie-banner choice while a session runs.');
process.exit(0);
