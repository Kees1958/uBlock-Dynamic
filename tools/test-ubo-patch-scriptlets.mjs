#!/usr/bin/env node
/*******************************************************************************

    uBlock-Stripped-Dynamic — uBO-patch scriptlets functional test
    Run: node tools/test-ubo-patch-scriptlets.mjs

    What it checks (C40, audit 9.8.0): each of the 4 scriptlets in
    js/resources/ubo-patch-scriptlets-source.mjs actually does the thing
    it claims to, against a real JSDOM — not just that it parses. Each
    case calls the REAL exported function (per Part D step 15's own
    "end-to-end verification against the real API surface" rule — never
    a hand-copy that could drift from the real implementation), the same
    way it is actually invoked at runtime: fn(source, args).

*******************************************************************************/

import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { UBO_PATCH_SCRIPTLETS } from '../js/resources/ubo-patch-scriptlets-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

const byName = new Map();
for ( const entry of UBO_PATCH_SCRIPTLETS ) {
    for ( const name of entry.names ) { byName.set(name, entry.scriptlet); }
}

let failures = 0;
const setTimeoutOriginal = global.setTimeout;
function check(name, condition, detail) {
    if ( condition ) { console.log(`  \u2713 ${name}`); return; }
    failures += 1;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
}

function newDom(html = '<!doctype html><body></body>') {
    return new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
}

const source = { name: 'test', args: [], verbose: false, engine: 'test', uniqueId: 'u1' };

// ── prevent-dialog ───────────────────────────────────────────────────────
{
    console.log('prevent-dialog:');
    const dom = newDom('<!doctype html><body><dialog open>hi</dialog></body>');
    const { window } = dom;
    global.document = window.document;
    global.MutationObserver = window.MutationObserver;
    global.requestAnimationFrame = fn => setTimeout(fn, 0);
    const dlg = window.document.querySelector('dialog');
    dlg.close = function() { this.removeAttribute('open'); this.open = false; };
    byName.get('prevent-dialog')(source, []);
    check('closes an already-open <dialog>', dlg.open === false);

    const dlg2 = window.document.createElement('dialog');
    dlg2.open = true;
    dlg2.close = function() { this.removeAttribute('open'); this.open = false; };
    window.document.body.appendChild(dlg2);
    window.document.dispatchEvent(new window.Event('DOMNodeInserted'));
    // MutationObserver callbacks run on a microtask; give it a tick.
    await new Promise(r => setTimeout(r, 20));
    check('closes a <dialog> added after the scriptlet runs', dlg2.open === false);
    delete global.document; delete global.MutationObserver; delete global.requestAnimationFrame;
}

// ── bab-defuser / nobab ──────────────────────────────────────────────────
{
    console.log('bab-defuser:');
    global.document = { body: { style: { removeProperty() {} } }, getElementById: () => null };
    const calls = [];
    function realEval(str) { calls.push(str); return 'real-eval-result'; }
    global.eval = realEval;
    global.setTimeout = (fn, ms) => 'real-settimeout-result';
    byName.get('bab-defuser')(source);
    const babPayload = "function(){var s=document.getElementById(x);String.fromCharCode(1);'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(1);DOMContentLoaded;AdBlock;addEventListener;doScroll;fromCharCode;'<<2|r>>4';sessionStorage;clientWidth;localStorage;Math;random;}";
    const result = global.eval(babPayload);
    check('intercepts a BlockAdblock-signature eval() call', result === undefined, `got ${JSON.stringify(result)}`);
    const benign = global.eval('1+1');
    check('leaves an ordinary eval() call untouched', benign === 'real-eval-result');
    delete global.document; delete global.eval; delete global.setTimeout;
}

// ── freeze-element-property ──────────────────────────────────────────────
{
    console.log('freeze-element-property:');
    const dom = newDom('<!doctype html><body><script id="s1"></script></body>');
    const { window } = dom;
    global.HTMLScriptElement = window.HTMLScriptElement;
    global.HTMLElement = window.HTMLElement;
    global.Element = window.Element;
    global.Node = window.Node;
    byName.get('freeze-element-property')(source, [ 'textContent', '#s1', 'evil' ]);
    const el = window.document.getElementById('s1');
    el.textContent = 'this contains evil payload';
    check('blocks assignment matching the pattern', el.textContent === '', `got ${JSON.stringify(el.textContent)}`);
    el.textContent = 'harmless value';
    check('allows assignment not matching the pattern', el.textContent === 'harmless value');
    delete global.HTMLScriptElement; delete global.HTMLElement; delete global.Element; delete global.Node;
}

// ── href-sanitizer / urlskip ─────────────────────────────────────────────
{
    console.log('href-sanitizer (urlskip alias):');
    const html = '<!doctype html><body>' +
        '<a id="a1" href="/away.php?to=https%3A%2F%2Freal-site.example%2Fpage">go</a>' +
        '</body>';
    const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    global.document = window.document;
    global.URL = window.URL;
    global.MutationObserver = window.MutationObserver;
    const fn = byName.get('href-sanitizer') ?? byName.get('urlskip');
    fn(source, [ 'a#a1', '?to' ]);
    if ( window.document.readyState === 'loading' ) {
        await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }
    const a1 = window.document.getElementById('a1');
    check('rewrites href from a query-string target', a1.getAttribute('href') === 'https://real-site.example/page', `got ${a1.getAttribute('href')}`);
    delete global.document; delete global.URL; delete global.MutationObserver;
}

// ── stub-window-object ────────────────────────────────────────────
{
    console.log('stub-window-object:');
    const fn = byName.get('stub-window-object');
    const listeners = [];
    const timers = [];
    global.document = { readyState: 'loading', addEventListener: (type, cb) => { listeners.push([ type, cb ]); } };
    global.setTimeout = (cb, ms) => { timers.push([ cb, ms ]); return timers.length; };
    global.window = { AdFuel: { real: true } };
    fn(source, [ 'AdFuel', 'queueRegistry, destroySlots', '500' ]);
    check('does nothing before the page has loaded', global.window.AdFuel.real === true && timers.length === 0);
    listeners.find(l => l[0] === 'DOMContentLoaded')[1]();
    check('schedules the replacement after DOMContentLoaded with the given delay', timers.length === 1 && timers[0][1] === 500);
    timers[0][0]();
    const stub = global.window.AdFuel;
    check('replaces the page object with no-op methods', stub.real === undefined && typeof stub.queueRegistry === 'function' && typeof stub.destroySlots === 'function' && stub.queueRegistry() === undefined);
    global.document.readyState = 'complete';
    timers.length = 0;
    global.window = {};
    fn(source, [ 'Other', 'a' ]);
    check('page already loaded: schedules at once, default delay 0', timers.length === 1 && timers[0][1] === 0);
    timers.length = 0;
    fn(source, [ 'bad name', 'a' ]);
    fn(source, [ 'X', 'ok,not valid' ]);
    check('invalid property or method names do nothing', timers.length === 0);
    fn(source, [ 'Y', 'a', '99999999' ]);
    check('delay is capped', timers[0][1] === 10000);
    delete global.window; delete global.document;
    global.setTimeout = setTimeoutOriginal;
}

// ── disable-fave-ssai ─────────────────────────────────────────────
{
    console.log('disable-fave-ssai:');
    function ssaiOn() { return { ads: { ssai: { prod: { clips: { enabled: true }, liveAuth: { enabled: true }, liveUnauth: { enabled: true } } } } }; }
    function allOff(cfg) { return ['clips', 'liveAuth', 'liveUnauth'].every(k => cfg.ads.ssai.prod[k].enabled === false); }
    global.window = { FAVE: { settings: ssaiOn(), player: { instances: { a: { configs: ssaiOn() }, b: {} } } } };
    byName.get('disable-fave-ssai')(source, []);
    const fave = global.window.FAVE;
    check('switches off flags already present (settings + player instance)', allOff(fave.settings) && allOff(fave.player.instances.a.configs));
    fave.settings = ssaiOn();
    check('switches off flags of a settings object written later', allOff(fave.settings));
    fave.player.instances.c = { configs: ssaiOn() };
    fave.other = 1;
    check('switches off a player instance added later, on the next write', allOff(fave.player.instances.c.configs));
    check('leaves unrelated properties alone', fave.other === 1 && fave.player.instances.b !== undefined);
    global.window = {};
    byName.get('disable-fave-ssai')(source, []);
    check('works when the page has no FAVE yet', typeof global.window.FAVE === 'object');
    global.window = { FAVE: { settings: { ads: null }, player: { instances: null } } };
    let threw = false;
    try { byName.get('disable-fave-ssai')(source, []); global.window.FAVE.x = 1; } catch { threw = true; }
    check('tolerates a missing or null ads/instances structure', threw === false);
    delete global.window;
}

console.log('');
if ( failures !== 0 ) {
    console.error(`${failures} case(s) FAILED.`);
    process.exit(1);
}
console.log('All uBO-patch scriptlet cases passed.');
