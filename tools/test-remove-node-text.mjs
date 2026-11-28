#!/usr/bin/env node
// tools/test-remove-node-text.mjs — (11.1.6) uBD's own remove-node-text (js/resources/ubo-patch-scriptlets-source.mjs),
// which replaces AdGuard's for every rule of that name (also uBO's translated rmnt rules), against jsdom (C42):
//   1. a script whose element arrives EMPTY and whose text arrives afterwards (how the HTML parser delivers an inline
//      script; reproduced in real Chrome on Fox News's Admiral starter) — text added as a node AND appended to it
//   2. a matching script inserted much later than 10 s (AdGuard's observer stopped after 10 s): still emptied
//   3. a non-matching script is left alone; a regex text; '#text' mode with a parent selector; an invalid regex does
//      nothing; the same rule twice installs once
//   4. lifetime (B10): disconnected on pagehide, restarted (with a scan) on pageshow from the back/forward cache
//   4b. (11.1.6) replace mode (trusted-replace-node-text): late text, after 10 s, /regex/g, no replace loop
//   5. build wiring: every remove-node-text alias resolves to this function in the list library AND the custom-rule
//      dispatch; AdGuard's function is gone from both
// Fault check (documented, run by hand): FAULT=adguard swaps in AdGuard's own function from 11.1.5 — parts 1 and 2
// must then FAIL (they did: 11.1.6).
// Exit 0 = pass, 1 = failed assertion, 2 = could not run (C38).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_MODULE = 'js/resources/ubo-patch-scriptlets-source.mjs';
const LIBRARY_FILE = 'rulesets/scriptlet-library.js';
const DISPATCH_FILE = 'js/generated/custom-scriptlets-dispatch.mjs';
const ALIASES = Object.freeze([ 'remove-node-text', 'ubo-remove-node-text', 'rmnt', 'ubo-rmnt', 'rmnt.js', 'ubo-rmnt.js' ]);
const OWN_MARKER = 'uBD-remove-node-text';               // the Trusted Types policy name, only in uBD's function
const AGED_INSERT_MS = 12_000;                           // "later than AdGuard's 10 s": simulated, see part 2
const ADMIRAL_WORD = 'adblockerDisabled';
const REPLACE_NAME = 'trusted-replace-node-text';      // (11.1.6, audit finding 2) the replace rule's name
const FAULT_REF = '2a52567';                              // 11.1.5 as released: AdGuard's function, for FAULT=adguard
const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_DID_NOT_RUN = 2;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if ( !ok ) { failures += 1; }
}
function didNotRun(msg) { console.log(`DID NOT RUN: ${msg}`); process.exit(EXIT_DID_NOT_RUN); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function flush() { return new Promise(r => setTimeout(r, 0)); }   // lets MutationObserver callbacks run

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch ( err ) { didNotRun(`jsdom not available (${err.message})`); }

// The function under test: uBD's, or (FAULT=adguard) AdGuard's from a pre-11.1.6 tree.
async function loadScriptletSource(agName = 'remove-node-text') {
    if ( process.env.FAULT === 'adguard' ) {
        const old = JSON.parse(execFileSync('git', [ 'show', `${FAULT_REF}:js/resources/ag-scriptlets-corelibs.json` ], { cwd: ROOT, encoding: 'utf8' }));
        return old.scriptlets.find(e => e.names.includes(agName)).scriptlet;
    }
    const mod = await import(pathToFileURL(path.join(ROOT, SOURCE_MODULE)).href);
    const entry = mod.UBO_PATCH_SCRIPTLETS.find(e => e.names.includes('remove-node-text'));
    if ( entry === undefined ) { didNotRun('no remove-node-text entry in ' + SOURCE_MODULE); }
    return entry.scriptlet.toString();
}
const scriptletSource = await loadScriptletSource();
const replaceSource = await loadScriptletSource(REPLACE_NAME);   // uBD: the same function; FAULT: AdGuard's own

// A fresh page with the scriptlet installed for `args`; time is jsdom's real clock, so "later than 10 s" is simulated
// by fast-forwarding the page's own timers (AdGuard schedules its disconnect with setTimeout).
function makePage(args, source = { name: 'remove-node-text', uniqueId: 'test' }, fnSource = scriptletSource) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const timers = [];
    w.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };   // captured, fired by age()
    w.eval(`(${fnSource})(${JSON.stringify(source)}, ${JSON.stringify(args)})`);
    function age(ms) { for ( const t of timers.splice(0) ) { if ( t.ms <= ms ) { t.fn(); } else { timers.push(t); } } }
    return { w, doc: w.document, age, close: () => w.close() };
}
const SCRIPT_RULE = [ 'script', ADMIRAL_WORD ];

// 1. Parser-like delivery: empty element first, text afterwards (as a new node, and appended to that node).
{
    const p = makePage(SCRIPT_RULE);
    const el = p.doc.createElement('script');
    p.doc.body.appendChild(el);                                  // element arrives empty
    await flush();
    el.appendChild(p.doc.createTextNode('var a=1;'));            // first packet
    await flush();
    el.firstChild.appendData(`var ${ADMIRAL_WORD}=false;`);      // second packet appended to the same text node
    await flush();
    check('script text that arrives after its empty element is emptied', el.textContent === '', JSON.stringify(el.textContent.slice(0, 40)));
    p.close();
}
// 2. Inserted long after the page started (AdGuard stopped watching at 10 s).
{
    const p = makePage(SCRIPT_RULE);
    p.age(AGED_INSERT_MS);
    const el = p.doc.createElement('script');
    el.textContent = `var ${ADMIRAL_WORD}=true;`;
    p.doc.body.appendChild(el);
    await flush();
    check(`a matching script inserted after ${AGED_INSERT_MS / 1000} s is still emptied`, el.textContent === '');
    p.close();
}
// 3. Argument forms and guards.
{
    const p = makePage(SCRIPT_RULE);
    const keep = p.doc.createElement('script');
    keep.textContent = 'var harmless=1;';
    p.doc.body.appendChild(keep);
    await flush();
    check('a non-matching script is left alone', keep.textContent === 'var harmless=1;');
    p.close();

    const r = makePage([ 'script', '/typeof [a-z]\\.unshift/' ]);
    const re = r.doc.createElement('script');
    re.textContent = 'if(typeof q.unshift==="function"){}';
    r.doc.body.appendChild(re);
    await flush();
    check('a /regex/ text argument matches', re.textContent === '');
    r.close();

    const t = makePage([ '#text', 'Advertisement', '.content' ]);
    t.doc.body.innerHTML = '<div class="content">Advertisement</div><div class="other">Advertisement</div>';
    await flush();
    const [ inScope, outOfScope ] = t.doc.body.children;
    check("'#text' with a parent selector: only text under that parent is emptied",
        inScope.textContent === '' && outOfScope.textContent === 'Advertisement', `${JSON.stringify(inScope.textContent)} / ${JSON.stringify(outOfScope.textContent)}`);
    t.close();

    let threw = false;
    try { makePage([ 'script', '/(unclosed/' ]).close(); } catch { threw = true; }
    check('an invalid regex installs nothing and throws nothing', threw === false);

    const d = makePage(SCRIPT_RULE);
    let observers = 0;
    const Orig = d.w.MutationObserver;
    d.w.MutationObserver = class extends Orig { constructor(cb) { super(cb); observers += 1; } };
    d.w.eval(`(${scriptletSource})(${JSON.stringify({ name: 'remove-node-text', uniqueId: 'test' })}, ${JSON.stringify(SCRIPT_RULE)})`);
    check('the same rule injected twice installs once', observers === 0, `${observers} extra observer(s)`);
    d.close();
}
// 4. Lifetime: off on pagehide, back (with a scan) on pageshow from the back/forward cache.
{
    const p = makePage(SCRIPT_RULE);
    p.w.dispatchEvent(new p.w.PageTransitionEvent('pagehide', { persisted: true }));
    const hidden = p.doc.createElement('script');
    hidden.textContent = `var ${ADMIRAL_WORD}=1;`;
    p.doc.body.appendChild(hidden);
    await flush();
    const untouchedWhileHidden = hidden.textContent !== '';
    p.w.dispatchEvent(new p.w.PageTransitionEvent('pageshow', { persisted: true }));
    await flush();
    check('pagehide disconnects; pageshow (back/forward cache) restarts and scans',
        untouchedWhileHidden && hidden.textContent === '', `hidden=${untouchedWhileHidden}, after=${JSON.stringify(hidden.textContent)}`);
    p.close();
}
// 4b. (11.1.6) Replace mode — trusted-replace-node-text's arguments: node, text, PATTERN, REPLACEMENT.
{
    function replacePage(args) { return makePage(args, { name: REPLACE_NAME, uniqueId: 'rt' }, replaceSource); }
    const p = replacePage([ 'script', 'html5player', "if (typeof html5player.setupVideo === 'function')", 'if (false)' ]);
    const el = p.doc.createElement('script');
    p.doc.body.appendChild(el);
    await flush();
    el.appendChild(p.doc.createTextNode('var html5player={};'));
    await flush();
    el.firstChild.appendData("if (typeof html5player.setupVideo === 'function'){go()}");
    await flush();
    check('replace: text arriving after its empty element gets the replacement (once)',
        el.textContent === 'var html5player={};if (false){go()}', JSON.stringify(el.textContent));
    p.close();

    const g = replacePage([ 'script', 'ads', '/ad(\\d)/g', 'no$1' ]);
    g.age(AGED_INSERT_MS);
    const late = g.doc.createElement('script');
    late.textContent = 'ads: ad1 ad2';
    g.doc.body.appendChild(late);
    await flush();
    check(`replace: /regex/g replaces every match, also for a script inserted after ${AGED_INSERT_MS / 1000} s`,
        late.textContent === 'ads: no1 no2', JSON.stringify(late.textContent));
    g.close();

    const loop = replacePage([ 'script', 'keep', 'keep', 'keep keep' ]);
    const grow = loop.doc.createElement('script');
    grow.textContent = 'keep';
    loop.doc.body.appendChild(grow);
    await flush(); await flush(); await flush();
    check('replace: a replacement that still matches is applied once, not in a loop', grow.textContent === 'keep keep', JSON.stringify(grow.textContent));
    loop.close();
}
// 5. Build wiring (skipped under FAULT: it checks the generated files, not the function).
if ( process.env.FAULT === undefined ) {
    const lib = read(LIBRARY_FILE);
    const AG_SIGNATURE = 'function removeNodeText(source,args){const uniqueIdentifier';   // AdGuard's minified start
    check('list scriptlet library carries uBD\'s function, not AdGuard\'s', lib.includes(OWN_MARKER) && lib.includes(AG_SIGNATURE) === false);
    const dispatch = read(DISPATCH_FILE);
    const files = ALIASES.map(a => (new RegExp(`"${a.replace('.', '\\.')}":"([^"]+)"`).exec(dispatch) ?? [])[1]);
    const one = new Set(files);
    const body = files[0] ? read(files[0].replace(/^\//, '')) : '';
    const replaceFile = (new RegExp(`"${REPLACE_NAME}":"([^"]+)"`).exec(dispatch) ?? [])[1];
    check('trusted-replace-node-text resolves to uBD\'s function too', replaceFile !== undefined && read(replaceFile.replace(/^\//, '')).includes(OWN_MARKER), String(replaceFile));
    check('every alias resolves to ONE custom-rule file, which is uBD\'s function',
        files.every(Boolean) && one.size === 1 && body.includes(OWN_MARKER), JSON.stringify(files));
}

process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
