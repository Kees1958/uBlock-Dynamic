// tools/e2e_seamless_prompt.mjs — (10.7.1) the in-page Seamless surfing prompt, driven through the REAL
// js/scripting/worry-free-picker.js in a JSDOM page: (11.0.0) exactly three stacked choice buttons and no Cancel,
// each sending exactly the message the background expects:
//   Accept, else decline -> { what: 'cookieClickerAutoDenyStart', cookieBannerAction: 'prefer-accept' }
//   Accept               -> the same with 'accept'   (no duration: sessions are open-ended)
//   Decline              -> the same with 'decline'
// and the dialog is removed after each click. A real click outside the panel is the dismissal: it keeps the existing
// choice and sends { what: 'seamlessCookiePromptDismiss' } (the prompt counts as answered), as Cancel did before 11.0.0. The prompt's shadow root is closed on purpose; the test opens it by
// wrapping attachShadow() in this page only.
// 10.7.15 (C47): the buttons act on real (isTrusted) clicks only. JSDOM cannot produce a trusted event, so the test
// records each button's own click listener (addEventListener wrapped in this page only) and calls it with a
// trusted-shaped event; a plain btn.click() (isTrusted false) must do nothing — that is checked first.
//
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { COOKIE_BANNER_ACTIONS } from '../js/data/cookie-banner-action.js';

// ── Config ──────────────────────────────────────────────────────────────────────
const ROOT = process.cwd();
const PROMPT_FILE = 'js/scripting/worry-free-picker.js';
const MSG_START = 'cookieClickerAutoDenyStart';       // js/data/message-types.js MSG_COOKIE_CLICKER_AUTODENY_START
// The window's live keydown listeners, as recorded by openPrompt() (a copy, safe to call while they remove themselves).
function keydownListeners(window) { return [ ...(window.__keydown ?? []) ]; }
const MSG_DISMISS = 'seamlessCookiePromptDismiss';    // js/data/message-types.js MSG_SEAMLESS_COOKIE_PROMPT_DISMISS
const SETTLE_MS = 20;
// (11.0.0) Three modes; the default "accept, else decline" first.
const EXPECTED_LABELS = Object.freeze([ 'Accept, else decline', 'Accept cookies', 'Decline cookies' ]);

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}
let source;
try { source = fs.readFileSync(path.join(ROOT, PROMPT_FILE), 'utf8'); } catch (err) { didNotRun(`${PROMPT_FILE} unreadable (${err.message})`); }

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if ( !ok ) { failures++; }
}

// One fresh page per click under test; returns { buttons, sent, window, hosts }.
function openPrompt() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/', runScripts: 'outside-only' });
    const { window } = dom;
    const sent = [];
    const shadows = [];
    const realAttach = window.Element.prototype.attachShadow;
    window.Element.prototype.attachShadow = function(init) {
        const root = realAttach.call(this, { ...init, mode: 'open' });
        shadows.push(root);
        return root;
    };
    const clickListeners = new Map();                     // element → its own click listeners (C47 trusted click)
    const realAdd = window.EventTarget.prototype.addEventListener;
    const realRemove = window.EventTarget.prototype.removeEventListener;
    window.__keydown = new Set();                         // (11.0.0) the window's live keydown listeners (Escape)
    window.EventTarget.prototype.addEventListener = function(type, listener, options) {
        if ( type === 'click' && this instanceof window.HTMLElement ) {   // (11.0.0) buttons and the backdrop
            if ( clickListeners.has(this) === false ) { clickListeners.set(this, []); }
            clickListeners.get(this).push(listener);
        }
        if ( type === 'keydown' && this === window ) { window.__keydown.add(listener); }
        return realAdd.call(this, type, listener, options);
    };
    window.EventTarget.prototype.removeEventListener = function(type, listener, options) {
        if ( type === 'keydown' && this === window ) { window.__keydown.delete(listener); }
        return realRemove.call(this, type, listener, options);
    };
    window.chrome = { runtime: { id: 'test-extension-id', sendMessage: msg => { sent.push(msg); return Promise.resolve({ ok: true }); } } };
    window.eval(source);
    const root = shadows[0];
    const buttons = root ? [ ...root.querySelectorAll('button') ] : [];
    // A real user click, as far as the button's own handlers can tell (isTrusted true).
    // `target`: where the click really landed (a click inside the panel bubbles to the backdrop with the panel as target).
    function trustedClick(el, target = el) {
        const ev = { type: 'click', isTrusted: true, target, currentTarget: el };
        for ( const listener of clickListeners.get(el) ?? [] ) { listener.call(el, ev); }
    }
    return { dom, window, root, sent, buttons, trustedClick };
}

// ── 1. Layout ──
{
    const { dom, buttons } = openPrompt();
    const labels = buttons.map(b => b.textContent.trim());
    check(`exactly ${EXPECTED_LABELS.join(' / ')}, in that order`, JSON.stringify(labels) === JSON.stringify(EXPECTED_LABELS), JSON.stringify(labels));
    check('no duration buttons left', buttons.every(b => !/\bmin\b|until next session/i.test(b.textContent)));
    dom.window.close();
}

// ── 2. Each button's message ──
const CASES = Object.freeze([
    { label: 'Accept, else decline', expect: { what: MSG_START, cookieBannerAction: COOKIE_BANNER_ACTIONS.PREFER_ACCEPT } },
    { label: 'Accept cookies',  expect: { what: MSG_START, cookieBannerAction: COOKIE_BANNER_ACTIONS.ACCEPT } },
    { label: 'Decline cookies', expect: { what: MSG_START, cookieBannerAction: COOKIE_BANNER_ACTIONS.DECLINE } },
]);
for ( const { label, expect } of CASES ) {
    const { dom, window, sent, buttons, trustedClick } = openPrompt();
    const btn = buttons.find(b => b.textContent.trim() === label);
    if ( btn === undefined ) { check(`${label}: button present`, false); dom.window.close(); continue; }
    btn.click();                                            // synthetic (isTrusted false) — a page could do this
    await new Promise(r => setTimeout(r, SETTLE_MS));
    check(`${label}: a page's synthetic click does nothing (C47)`, sent.length === 0 && window.document.documentElement.children.length === 3, JSON.stringify(sent));
    trustedClick(btn);
    await new Promise(r => setTimeout(r, SETTLE_MS));
    check(`${label}: sends ${JSON.stringify(expect)}`, sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify(expect), JSON.stringify(sent));
    check(`${label}: dialog removed afterwards`, window.document.documentElement.children.length === 2 /* head + body */);
    dom.window.close();
}

// ── 3. (11.0.0) No Cancel: a real click outside the panel, or Escape, keeps the existing choice (dismiss) ──
{
    const { dom, window, root, sent, trustedClick } = openPrompt();
    const backdrop = root?.querySelector('.backdrop');
    const panel = root?.querySelector('.panel');
    trustedClick(backdrop, panel);                           // inside the panel (bubbled to the backdrop): stays open
    await new Promise(r => setTimeout(r, SETTLE_MS));
    check('a click inside the panel keeps the prompt open', window.document.documentElement.children.length === 3);
    trustedClick(backdrop);
    await new Promise(r => setTimeout(r, SETTLE_MS));
    check(`a click outside the panel closes it, keeps the choice and sends ${JSON.stringify({ what: MSG_DISMISS })}`,
        sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ what: MSG_DISMISS }) && window.document.documentElement.children.length === 2, JSON.stringify(sent));
    check('the prompt says how to keep the current choice', /Escape or click outside this box to keep your current choice/.test(fs.readFileSync(path.join(ROOT, PROMPT_FILE), 'utf8')));
    dom.window.close();
}
{
    const { dom, window, sent } = openPrompt();
    function key(k) { return { type: 'keydown', key: k, isTrusted: true }; }
    for ( const listener of keydownListeners(window) ) { listener(key('a')); }
    check('another key keeps the prompt open', window.document.documentElement.children.length === 3 && sent.length === 0);
    for ( const listener of keydownListeners(window) ) { listener({ ...key('Escape'), isTrusted: false }); }
    check('a page\'s synthetic Escape does nothing (C47)', window.document.documentElement.children.length === 3 && sent.length === 0);
    const before = keydownListeners(window).length;           // jsdom adds one of its own; the prompt adds one
    for ( const listener of keydownListeners(window) ) { listener(key('Escape')); }
    await new Promise(r => setTimeout(r, SETTLE_MS));
    check(`Escape closes it, keeps the choice and sends ${JSON.stringify({ what: MSG_DISMISS })}`,
        sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ what: MSG_DISMISS }) && window.document.documentElement.children.length === 2, JSON.stringify(sent));
    check('the Escape listener is removed with the dialog (release guard)', keydownListeners(window).length === before - 1, `${before} -> ${keydownListeners(window).length}`);
    check('the choices are stacked (column), so they stay inside the panel', /\.row \{[^}]*flex-direction: column/.test(fs.readFileSync(path.join(ROOT, PROMPT_FILE), 'utf8')));
    dom.window.close();
}

if ( failures > 0 ) {
    console.log(`\nFAIL: ${failures} problem(s) in the Seamless surfing prompt.`);
    process.exit(1);
}
console.log(`\nPASS: the Seamless surfing prompt offers ${EXPECTED_LABELS.join(' / ')} and sends the right messages.`);
process.exit(0);
