// ── e2e-live-smoke.mjs ────────────────────────────────────────────────────────
// Step 91 (11.0.2, audit 11.0.2 finding 8): load the REAL extension in Chrome and use it.
//
// Why: every other step runs in Node with mocked browser APIs. The errors that kept slipping through only exist in a
// real browser: the audit's first live run found "Extension context invalidated." thrown on pages after an extension
// reload within minutes, after 89 mocked steps had passed. This step does what a person testing by hand does, and
// fails on any uncaught error or console error/warning:
//   1. Load the extension in a fresh profile; Seamless surfing must start by itself (always on, 11.0.0).
//   2. Open the popup and the dashboard.
//   3. On a local test page: popup data, Ad leftover cleaner, element picker, Seamless picker, Cookie consent clicker.
//   4. Stop the service worker (Chrome does this after ~30 s idle): it must answer again with the same session rules.
//   5. Reload the extension under an open page with the Ad leftover cleaner running, then change the page.
//
// Chrome: CHROME_PATH, else the first of CHROME_CANDIDATES that exists. Without one the step is SKIPPED (exit 0) and
// says so loudly — the person's own machine may not have Chrome for Testing; puppeteer-core never downloads one.
// Network: only a local server on 127.0.0.1 (no outside sites, so results do not depend on the internet).

/* global chrome, document -- these callbacks run inside Chrome pages (page.evaluate), where both exist */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { WORRY_FREE_HAGEZI_RULES_BASE_ID } from '../js/core/dnr-budgets.js';

/******************************************************************************/
// Configuration — one place
/******************************************************************************/

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = Object.freeze([
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
]);

const SW_START_TIMEOUT_MS = 20_000;       // the service worker target must appear within this
const SEAMLESS_START_TIMEOUT_MS = 20_000; // Seamless surfing must be running within this after install
const POLL_MS = 500;
const SETTLE_MS = 2_500;                  // after each action, time for its scripts to run and report
const RELOAD_SETTLE_MS = 5_000;           // after chrome.runtime.reload()
const PROTOCOL_TIMEOUT_MS = 60_000;       // one browser call longer than this is a hang, not a slow machine

// The HaGeZi Light off-switch: present while Seamless surfing is NOT running (js/core/worry-free-extra-manager.js).
const SEAMLESS_OFF_SWITCH_ID = WORRY_FREE_HAGEZI_RULES_BASE_ID;

// Console lines that are expected and not a failure (none today). Add an entry only with the reason.
const ALLOWED_CONSOLE = Object.freeze([]);

// The local test page: ad-like leftovers, a cookie banner, a frame, and content added after load.
const PAGES = Object.freeze({
    '/': `<!doctype html><html><head><title>uBD live smoke</title><link rel="icon" href="data:,"></head>
<body><div id="ad-banner" class="adsbygoogle ad-slot advertisement" style="width:728px;height:90px">AD</div>
<div class="sponsored-content">sponsor</div>
<div id="cookie-banner" class="cookie-consent"><button>Accept</button><button>Reject</button></div>
<iframe src="/frame" width="300" height="100"></iframe><p>Text</p><script src="/app.js"></script></body></html>`,
    '/frame': '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div class="ad-container">frame ad</div></body></html>',
    '/app.js': 'setTimeout(()=>{const d=document.createElement("div");d.className="ad-unit";d.textContent="late";document.body.append(d);},500);',
});

/******************************************************************************/

const problems = [];
let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
    if ( ok === false ) { failures += 1; }
}
function sleep(ms) { return new Promise(resolve => { setTimeout(resolve, ms); }); }

function findChrome() {
    if ( process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH) ) { return process.env.CHROME_PATH; }
    return CHROME_CANDIDATES.find(p => fs.existsSync(p)) ?? null;
}

function recordConsole(source, message) {
    const type = message.type();
    if ( type !== 'error' && type !== 'warn' && type !== 'warning' ) { return; }
    const text = message.text();
    if ( ALLOWED_CONSOLE.some(re => re.test(text)) ) { return; }
    problems.push(`[${source} console.${type}] ${text.slice(0, 300)}`);
}
function watchPage(page, source) {
    page.on('console', m => recordConsole(source, m));
    page.on('pageerror', e => problems.push(`[${source} uncaught] ${String(e?.stack ?? e?.message ?? e).slice(0, 600)}`));
}
// The worker is NOT attached to (no target.worker()): with DevTools attached, Chrome did not answer any message after
// the worker stop in step 4 (verified 2026-11-20 — without the attachment it answers in ~0.16 s). Worker errors still
// show up here: the background's last-resort logger and every route reply reach the extension pages watched below.
async function waitForWorker(browser) {
    return browser.waitForTarget(t => t.type() === 'service_worker', { timeout: SW_START_TIMEOUT_MS });
}

function startServer() {
    const server = http.createServer((req, res) => {
        const body = PAGES[new URL(req.url, 'http://x').pathname];
        if ( body === undefined ) { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/html' });
        res.end(body);
    });
    return new Promise(resolve => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

/******************************************************************************/

console.log('=== Step 91: live smoke test in real Chrome (11.0.2) ===');
const chromePath = findChrome();
if ( chromePath === null ) {
    console.log('SKIPPED — no Chrome found. Set CHROME_PATH to a Chrome or Chrome for Testing binary to run this step.');
    process.exit(0);
}
console.log(`Chrome: ${chromePath}`);

const server = await startServer();
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
let browser = null;
try {
    browser = await puppeteer.launch({
        executablePath: chromePath, headless: 'new', pipe: true, enableExtensions: true, protocolTimeout: PROTOCOL_TIMEOUT_MS,
        // Loaded the way "Load unpacked" does it (Chrome's own flags), not through puppeteer's CDP loader.
        args: [ `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run', '--no-default-browser-check', ...(process.getuid?.() === 0 ? [ '--no-sandbox' ] : []) ],
    });

    // ── 1. Install: the worker starts and Seamless surfing starts by itself ──────────────────────────────────────────
    const swTarget = await waitForWorker(browser);
    const extId = new URL(swTarget.url()).host;
    // The driver is a dashboard tab: the popup page closes itself on some actions, which would end the run.
    const ext = await browser.newPage();
    watchPage(ext, 'extension page');
    await ext.goto(`chrome-extension://${extId}/dashboard/dashboard.html`);
    const popup = await browser.newPage();
    watchPage(popup, 'popup');
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    function sessionRuleIds() {
        return ext.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map(r => r.id).sort((a, b) => a - b));
    }
    let seamlessOn = false;
    for ( let waited = 0; waited < SEAMLESS_START_TIMEOUT_MS && seamlessOn === false; waited += POLL_MS ) {
        seamlessOn = (await sessionRuleIds()).includes(SEAMLESS_OFF_SWITCH_ID) === false;
        if ( seamlessOn === false ) { await sleep(POLL_MS); }
    }
    check('fresh install: the service worker starts and Seamless surfing turns on by itself', seamlessOn);

    // ── 2. Popup and dashboard open cleanly ─────────────────────────────────────────────────────────────────────────
    const dash = await browser.newPage();
    watchPage(dash, 'dashboard');
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html`);
    await sleep(SETTLE_MS);

    // ── 3. The tools, on a local page ───────────────────────────────────────────────────────────────────────────────
    const page = await browser.newPage();
    watchPage(page, 'web page');
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await sleep(SETTLE_MS);
    const tabId = await ext.evaluate(async url => (await chrome.tabs.query({ url: `${url}*` }))[0]?.id, pageUrl);
    check('the local test page is open in a tab', typeof tabId === 'number');
    function send(msg) { return ext.evaluate(m => chrome.runtime.sendMessage(m), msg); }
    const panel = await send({ what: 'popupPanelData', tabId });
    check('popup data answers for the page', panel !== undefined && panel !== null && typeof panel === 'object', JSON.stringify(panel));
    check('Ad leftover cleaner launches', (await send({ what: 'adCleanerLaunch', tabId }))?.ok === true);
    await sleep(SETTLE_MS);
    const pickerOk = await ext.evaluate(async t => {
        await chrome.scripting.executeScript({
            files: [ '/js/scripting/css-procedural-api.js', '/js/scripting/tool-overlay.js', '/js/scripting/picker.js' ],
            target: { tabId: t },
        });
        return true;
    }, tabId).catch(e => String(e));
    check('element picker launches', pickerOk === true, String(pickerOk));
    await sleep(SETTLE_MS);
    check('Seamless picker launches', (await send({ what: 'worryFreeLaunchPicker', tabId }))?.ok === true);
    await sleep(SETTLE_MS);
    check('Cookie consent clicker launches', (await send({ what: 'cookieClickerLaunchPicker', tabId }))?.ok === true);
    await sleep(SETTLE_MS);

    // ── 4. Service worker stopped and woken again ──────────────────────────────────────────────────────────────────
    console.log('… stopping the service worker');
    const before = JSON.stringify(await sessionRuleIds());
    const cdp = await ext.createCDPSession();
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(POLL_MS);
    const again = await send({ what: 'popupPanelData', tabId });
    await waitForWorker(browser);
    check('after a worker stop: it answers again', again !== undefined && again !== null);
    await sleep(SETTLE_MS);
    check('after a worker stop: the same session rules', JSON.stringify(await sessionRuleIds()) === before);

    // ── 5. Extension reloaded under an open page, with the Ad leftover cleaner running ─────────────────────────────
    console.log('… reloading the extension under an open page');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(SETTLE_MS);
    await send({ what: 'adCleanerLaunch', tabId });
    await sleep(SETTLE_MS);
    await ext.evaluate(() => { chrome.runtime.reload(); }).catch(( ) => { /* expected: the page closes with the reload */ });
    await sleep(RELOAD_SETTLE_MS);
    await page.evaluate(() => {
        for ( let i = 0; i < 20; i++ ) {
            const d = document.createElement('div');
            d.className = `ad-unit ad-${i}`;
            document.body.append(d);
        }
    });
    await sleep(SETTLE_MS);
    check('extension reloaded under an open page: the page sees no error', problems.every(p => p.startsWith('[web page') === false), problems.filter(p => p.startsWith('[web page')).join(' | '));
} catch (reason) {
    check('the live run completed', false, String(reason?.stack ?? reason));
} finally {
    await browser?.close().catch(( ) => { /* benign: already closed */ });
    server.close();
}

check(`no uncaught error and no console error/warning anywhere (${problems.length})`, problems.length === 0, `\n  ${problems.join('\n  ')}`);
console.log(failures === 0 ? '\nPASS' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
