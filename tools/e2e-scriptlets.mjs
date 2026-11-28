#!/usr/bin/env node
// tools/e2e-scriptlets.mjs — (11.1.6) scriptlet behaviour in REAL Chrome with the REAL extension (C42): remove- and
// replace-node-text (scriptlet audit findings 1-2) and scriptlets in frames without an address (finding 8).
//
// Why: the Fox News failure (Admiral's 7 KB inline starter ran although the Anti-Admiral rule matched its text) only
// happens when the HTML parser delivers a script's text in more than one network packet — jsdom
// (tools/test-remove-node-text.mjs) cannot show that. This step loads uBD in Chrome, points www.foxnews.com at a local
// HTTPS server (no outside site is contacted) and serves a page with a Fox-like starter that matches the shipped
// Anti-Admiral rule (uBO's "adblockerDisabled" rmnt rule for foxnews.com):
//   1. whole script in one packet                 → must not run, text emptied
//   2. script split mid-way over two packets      → must not run, text emptied   (failed with AdGuard's version)
//   3. matching script added by the page at 12 s  → text emptied (AdGuard's observer had stopped at 10 s); it still
//                                                    runs once — a script runs the moment it is inserted, as in uBO
//   4. control: a non-matching late script        → runs and keeps its text
//   5. frames the page creates without an address (about:blank, srcdoc) get the site's scriptlets: the shipped
//      AdGuard anti-adblock rule foxnews.com#%#//scriptlet('set-constant', 'googlefc', 'null') locks `googlefc` in them
//      too — before 11.1.6 (no matchOriginAsFallback) such a frame had no scriptlets at all
// Chrome: the first of CHROME_CANDIDATES that exists, and openssl for a throw-away certificate; without either the step
// is SKIPPED (exit 0) and says so.
// Fault-verified (11.1.6): against the 11.1.5 build (AdGuard's function), case 2 ran with its full 7 KB text and
// case 3 kept its text; with matchOriginAsFallback removed from the scriptlet registrations, case 5 fails.
// Exit 0 = pass or skipped, 1 = failed assertion, 2 = could not run (C38).
/* global document, window -- these callbacks run inside Chrome pages (page.evaluate), where both exist */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME_CANDIDATES = Object.freeze([ '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser' ]);
const SITE_HOST = 'www.foxnews.com';            // a site the shipped Anti-Admiral rule names
const ADMIRAL_WORD = 'adblockerDisabled';       // what that rule looks for
const STARTER_FILLER_LEN = 7000;                // about the size of Fox's real starter
const SPLIT_DELAY_MS = 150;                     // pause between the two packets of the split page
const LATE_INSERT_MS = 12_000;                  // after AdGuard's 10 s cut-off
const INSTALL_SETTLE_MS = 8000;                 // rulesets + content-script registration after install
const PAGE_SETTLE_MS = 1000;
const LATE_WAIT_MS = LATE_INSERT_MS + 2000;
const PROTOCOL_TIMEOUT_MS = 60_000;
const FRAME_SETTLE_MS = 1500;                   // after the page created its frames
const LOCKED_GLOBAL = 'googlefc';               // the shipped foxnews.com set-constant rule's property (value null)
// The page makes one about:blank and one srcdoc frame; the test then asks each frame whether the rule's getter is there.
const FRAME_PAGE_SCRIPT = '<script>for(const k of ["blank","srcdoc"]){const f=document.createElement("iframe");f.id=k;'
    + 'if(k==="srcdoc"){f.srcdoc="<p>x</p>";}document.body.appendChild(f);}</script>';
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}

const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if ( chromePath === undefined ) { console.log('SKIPPED: no Chrome found — remove-node-text was NOT checked in a real browser.'); process.exit(EXIT_PASS); }
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubd-rmnt-'));
try {
    execFileSync('openssl', [ 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmpDir, 'k.pem'),
        '-out', path.join(tmpDir, 'c.pem'), '-days', '1', '-subj', `/CN=${SITE_HOST}` ], { stdio: 'ignore' });
} catch {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('SKIPPED: openssl not available — remove-node-text was NOT checked in a real browser.');
    process.exit(EXIT_PASS);
}

// ── The local pages ───────────────────────────────────────────────────────────────────────────────
// The starter is built so the page's OWN scheduler script never contains the matched word (it is assembled at run time),
// otherwise the rule would rightly empty the scheduler itself.
function starter(flag) {
    return `!(function(b,n,v,U,Q,V){V=[],Q=function(){V[V.length]=arguments};window.admiral=Q;var x${'a'.repeat(STARTER_FILLER_LEN)}=1;var ${ADMIRAL_WORD}=false;window.${flag}=true;})(window);`;
}
const HEAD = '<!doctype html><html><head><title>t</title></head><body><p>x</p><script type="text/javascript">';
const TAIL = '</script><p>after</p></body></html>';
function lateScheduler(text) {
    return `<script>setTimeout(()=>{window.__SCHED=true;const s=document.createElement('script');s.textContent=${JSON.stringify(text)}.replace('ADB_WORD','adblocker'+'Disabled');document.body.appendChild(s);},${LATE_INSERT_MS})</script>`;
}
const PAGES = Object.freeze({
    '/whole':   res => res.end(HEAD + starter('__RAN') + TAIL),
    '/split':   async res => {
        const text = starter('__RAN');
        const half = Math.floor(text.length / 2);
        res.write(HEAD + text.slice(0, half));
        await new Promise(r => setTimeout(r, SPLIT_DELAY_MS));
        res.end(text.slice(half) + TAIL);
    },
    '/late':    res => res.end(HEAD + 'window.__RAN=false;' + TAIL.replace('</body>', lateScheduler(starter('__LATE').replace(ADMIRAL_WORD, 'ADB_WORD')) + '</body>')),
    '/control': res => res.end(HEAD + 'window.__RAN=false;' + TAIL.replace('</body>', lateScheduler('window.__LATE=true;') + '</body>')),
    '/frames':  res => res.end(`<!doctype html><html><head><title>t</title></head><body>${FRAME_PAGE_SCRIPT}</body></html>`),
});

let server = null, browser = null;
try {
    server = https.createServer({ key: fs.readFileSync(path.join(tmpDir, 'k.pem')), cert: fs.readFileSync(path.join(tmpDir, 'c.pem')) }, async (req, res) => {
        const handler = PAGES[new URL(req.url, `https://${SITE_HOST}`).pathname];
        if ( handler === undefined ) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html' });
        await handler(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    browser = await puppeteer.launch({
        executablePath: chromePath, headless: 'new', pipe: true, enableExtensions: true, protocolTimeout: PROTOCOL_TIMEOUT_MS,
        args: [ `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run', '--no-default-browser-check',
            `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${port}`, '--ignore-certificate-errors', '--no-proxy-server',
            ...(process.getuid?.() === 0 ? [ '--no-sandbox' ] : []) ],
    });
    await new Promise(r => setTimeout(r, INSTALL_SETTLE_MS));
    const page = await browser.newPage();
    async function visit(p, waitMs) {
        await page.goto(`https://${SITE_HOST}${p}`, { waitUntil: 'load' });
        await new Promise(r => setTimeout(r, waitMs));
        return page.evaluate(() => ({ ran: window.__RAN === true, late: window.__LATE === true, sched: window.__SCHED === true,
            lengths: [ ...document.scripts ].map(s => s.textContent.length) }));
    }
    const whole = await visit('/whole', PAGE_SETTLE_MS);
    check('whole script: did not run, text emptied', whole.ran === false && whole.lengths[0] === 0, JSON.stringify(whole));
    const split = await visit('/split', PAGE_SETTLE_MS);
    check('script split over two packets: did not run, text emptied', split.ran === false && split.lengths[0] === 0, JSON.stringify(split));
    const late = await visit('/late', LATE_WAIT_MS);
    check(`script added at ${LATE_INSERT_MS / 1000} s: text emptied`, late.sched === true && late.lengths.at(-1) === 0, JSON.stringify(late));
    const control = await visit('/control', LATE_WAIT_MS);
    check('control: a non-matching late script runs and keeps its text', control.late === true && control.lengths.at(-1) > 0, JSON.stringify(control));
    await page.goto(`https://${SITE_HOST}/frames`, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, FRAME_SETTLE_MS));
    const frames = await page.evaluate(name => [ 'blank', 'srcdoc' ].map(id => {
        const w = document.getElementById(id)?.contentWindow;
        const d = w ? Object.getOwnPropertyDescriptor(w, name) : undefined;
        return { id, locked: typeof d?.get === 'function' && w[name] === null };
    }), LOCKED_GLOBAL);
    const top = await page.evaluate(name => Object.getOwnPropertyDescriptor(window, name)?.get !== undefined, LOCKED_GLOBAL);
    check('frames without an address (about:blank, srcdoc) get the site\'s scriptlets', top && frames.every(f => f.locked), JSON.stringify({ top, frames }));
} catch ( err ) {
    console.log(`DID NOT RUN: ${err.message}`);
    process.exitCode = EXIT_DID_NOT_RUN;
} finally {
    // Release: browser, server and the throw-away certificate, on every exit path.
    if ( browser !== null ) { await browser.close().catch(() => {}); }
    if ( server !== null ) { server.close(); }
    fs.rmSync(tmpDir, { recursive: true, force: true });
}
if ( process.exitCode === undefined ) { process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL); }
