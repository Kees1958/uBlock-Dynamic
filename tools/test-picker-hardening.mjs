#!/usr/bin/env node
// ── tools/test-picker-hardening.mjs ───────────────────────────────────────────
// Suite step 81 (10.7.13): defence in depth after the uBO picker UXSS
// (GHSA-cmqw-9r2w-6wv2) review. uBD was not vulnerable; these close the
// remaining gaps. Each section drives the real exported code, with only
// browser storage mocked (Part D rule 15).
//
//   A. Picked cosmetic selectors cannot escape the stylesheet
//      (js/util/css-selector-guard.js + its wiring in filter-routes.js).
//      Real ExtSelectorCompiler output for every selector in the bundled
//      cosmetic rulesets must pass (no false positives); escape attempts fail.
//   B. Cookie-clicker rules: hostname + length validation in the core module
//      (addCookieClickerRule), sender cross-check in the route.
//   C. Cookie-clicker picker acts on real user gestures only (isTrusted).
//   D. Manifest: the matrix panel is not web-accessible; JSON messaging mode
//      stays pinned (C31) — the latter is enforced by step 33 as well.
//   E. (10.7.14) Import / Restore paths use the same checks: cosmetic
//      selectors via the shared computeUpdatedSelectors() guard, cookie
//      rules via areRuleFieldsValid(); the extension-page CSP is tightened;
//      nothing outside uBD is listened to (no onMessageExternal /
//      onConnectExternal, no externally_connectable — an empty one only
//      makes Chrome warn "nothing will be able to connect").
//
// Exit 0 = all pass; 1 = a failure.

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';   // mock extension id

// Upper bound on corpus selectors compiled in section A: enough to cover
// every bundled list's shapes, small enough to keep the step fast.
const CORPUS_MAX = 50_000;

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}
// Shipped extension JS (everything except build tooling and dependencies).
const NON_SHIPPED_DIRS = Object.freeze(new Set([ 'node_modules', 'tools', 'dist', 'coverage', 'test-fixtures', '.git' ]));
function listShippedJs(dir = ROOT, out = []) {
    for ( const entry of fs.readdirSync(dir, { withFileTypes: true }) ) {
        if ( entry.isDirectory() ) {
            if ( dir === ROOT && NON_SHIPPED_DIRS.has(entry.name) ) { continue; }
            listShippedJs(path.join(dir, entry.name), out);
        } else if ( entry.name.endsWith('.js') ) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function moduleUrl(rel) { return pathToFileURL(path.join(ROOT, rel)).href; }

globalThis.self = globalThis;
// Mock browser before any extension module is imported (storage.local as a Map).
const localStore = new Map();
globalThis.chrome = {
    runtime: { id: EXT_ID, getURL: p => `chrome-extension://${EXT_ID}${p}`, sendMessage: async () => undefined, getManifest: () => ({ version: '0' }) },
    storage: {
        local: {
            async get(key) {
                if ( typeof key === 'string' ) { return localStore.has(key) ? { [key]: localStore.get(key) } : {}; }
                return Object.fromEntries(localStore);
            },
            async set(bin) { for ( const [ k, v ] of Object.entries(bin) ) { localStore.set(k, v); } },
            async remove(key) { localStore.delete(key); },
        },
        session: { async get() { return {}; }, async set() {}, async setAccessLevel() {} },
    },
    i18n: { getMessage: () => '' },
};

// Every cosmetic selector shipped in rulesets/*-cosmetic-specific.json.
function collectStrings(value, out) {
    if ( out.size >= CORPUS_MAX ) { return; }
    if ( typeof value === 'string' ) { out.add(value); return; }
    if ( Array.isArray(value) ) { for ( const v of value ) { collectStrings(v, out); } return; }
    if ( value && typeof value === 'object' ) { for ( const v of Object.values(value) ) { collectStrings(v, out); } }
}

function collectCorpusSelectors() {
    const out = new Set();
    const dir = path.join(ROOT, 'rulesets');
    for ( const name of fs.readdirSync(dir) ) {
        if ( name.endsWith('-cosmetic-specific.json') === false ) { continue; }
        collectStrings(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), out);
    }
    return [ ...out ];
}

async function sectionA() {
    console.log('── A. Picked selectors cannot escape the stylesheet ──');
    const { isSafePickedSelector } = await import(moduleUrl('js/util/css-selector-guard.js'));
    const { ExtSelectorCompiler } = await import(moduleUrl('js/core/static-filtering-parser.js'));
    const compiler = new ExtSelectorCompiler({ nativeCssHas: true });   // same options as picker/picker.js
    let compiled = 0;
    const rejected = [];
    for ( const raw of collectCorpusSelectors() ) {
        const out = {};
        if ( compiler.compile(raw, out) === false ) { continue; }
        compiled += 1;
        if ( isSafePickedSelector(out.compiled) === false ) { rejected.push(out.compiled); }
    }
    check(`corpus large enough to mean something (${compiled} compiled selectors)`, compiled >= 1_000, String(compiled));
    check('no real compiled selector is refused (no false positives)', rejected.length === 0, rejected.slice(0, 3).join(' | '));

    const attacks = [
        'a{}body{background:url(//x)}', 'div;*{color:red}', 'a\n+js(trusted-x)', '@import url(x)', 'a/*',
        'x[a="}"]{b}', 'x[a="unterminated', '{not json',
        JSON.stringify({ selector: 'a{}b', raw: 'a' }),
        JSON.stringify({ selector: 'a', tasks: [ [ 'matches-media', '(x){}*' ] ], raw: 'a' }),
        JSON.stringify({ selector: 'a', tasks: [ [ 'spath', '}*{x' ] ], raw: 'a' }),
        JSON.stringify({ selector: 'a', action: [ 'style', 'color:red}*{x:y' ], raw: 'a' }),
        JSON.stringify({ selector: 'a', action: [ 'style', 'background:url(//e)' ], raw: 'a' }),
    ];
    const leaked = attacks.filter(a => isSafePickedSelector(a));
    check(`every escape attempt is refused (${attacks.length})`, leaked.length === 0, leaked.join(' | '));
    const legit = [
        '.ad', 'div[title="a;b{c}"]', '.a\\{b', '#x > .y:not(.z)',
        JSON.stringify({ selector: 'a', action: [ 'style', 'color:red; display:block' ], raw: 'a' }),
        JSON.stringify({ selector: 'div', tasks: [ [ 'has-text', '/a{2}/' ] ], raw: 'x' }),
    ];
    const refused = legit.filter(a => isSafePickedSelector(a) === false);
    check('legitimate edge cases pass (quoted braces, escapes, :style, JS-only task args)', refused.length === 0, refused.join(' | '));
    const routes = read('js/workflow/filter-routes.js');
    const at = routes.indexOf('export async function handleAddCustomFilters(');
    const body = at === -1 ? '' : routes.slice(at, routes.indexOf('\n}\n', at));
    // (11.0.0) the store call moved into the shared saveCustomCosmeticSelectors(); the guard must still come first.
    check('handleAddCustomFilters refuses before storing', /selectors\.every\(isSafePickedSelector\) === false \)[\s\S]*saveCustomCosmeticSelectors\(/.test(body));
    const cleaner = read('js/workflow/ad-cleaner-routes.js');
    const keepAt = cleaner.indexOf('export async function handleAdCleanerKeep(');
    const keepBody = keepAt === -1 ? '' : cleaner.slice(keepAt, cleaner.indexOf('\n}\n', keepAt));
    check('(11.0.0) Ad leftover cleaner keep refuses before storing', /isSafePickedSelector\(s\)[\s\S]*valid === false[\s\S]*saveCustomCosmeticSelectors\(/.test(keepBody));
    // (11.0.3, C15) The save path moved to js/core/cosmetic-rule-save.js (a route file never imports another route
    // file). Count real calls only — comment lines are skipped — across every shipped js/ file.
    function codeCalls(text) {
        return text.split('\n')
            .filter(line => line.trim().startsWith('//') === false && line.trim().startsWith('*') === false)
            .filter(line => /saveCustomCosmeticSelectors\(/.test(line) && /function saveCustomCosmeticSelectors\(/.test(line) === false)
            .length;
    }
    const saver = read('js/core/cosmetic-rule-save.js');
    check('(11.0.3) the shared save path is defined once, in core', /export async function saveCustomCosmeticSelectors\(/.test(saver));
    const callerFiles = fs.readdirSync(path.join(ROOT, 'js'), { recursive: true })
        .filter(f => f.endsWith('.js') && f.startsWith('generated') === false)
        .map(f => `js/${f.split(path.sep).join('/')}`)
        .filter(f => codeCalls(read(f)) > 0);
    const expectedCallers = [ 'js/workflow/ad-cleaner-routes.js', 'js/workflow/filter-routes.js' ];
    check('(11.0.0) the shared save path has only the two guarded callers',
        JSON.stringify(callerFiles.sort()) === JSON.stringify(expectedCallers) && codeCalls(routes) === 1 && codeCalls(cleaner) === 1,
        `callers: ${callerFiles.join(', ') || 'none'}`);
}

// (11.0.2) The picker lists <html>/<body> (uBO 9510a0b38c); a pick that hides
// them is refused in the picker page and in the service worker route, while
// a selector merely anchored on their classes still passes.
async function sectionWholePage() {
    console.log('── A2. Whole-page picks are refused (11.0.2) ──');
    const { hidesWholePage, isSafePickedSelector } = await import(moduleUrl('js/util/css-selector-guard.js'));
    const wholePage = [
        'body', 'html', 'html > body', ':root', 'BODY', 'body.modal-open', 'html.no-scroll',
        'body:has(.x)', 'div, body', 'body + body',
        JSON.stringify({ selector: 'body', tasks: [ [ 'has-text', 'x' ] ], raw: 'x' }),
        JSON.stringify({ selector: 'body', action: [ 'remove', '' ], raw: 'x' }),
    ];
    const missed = wholePage.filter(a => hidesWholePage(a) === false);
    check(`every whole-page pick is caught (${wholePage.length})`, missed.length === 0, missed.join(' | '));
    const anchored = [
        'body > div.ad', 'body.modal-open .overlay', 'html body div', 'div:has(> body)',
        '[data-x="a, body"]', 'tbody', 'div.body-wrap', '.body', '#body', 'bodyx',
        JSON.stringify({ selector: 'body.modal-open', action: [ 'style', 'overflow:auto !important' ], raw: 'x' }),
        JSON.stringify({ selector: 'html', action: [ 'remove-class', 'no-scroll' ], raw: 'x' }),
        JSON.stringify({ selector: 'body', tasks: [ [ 'spath', ' > div' ] ], raw: 'x' }),
    ];
    const wrong = anchored.filter(a => hidesWholePage(a));
    check(`selectors anchored on <html>/<body> still pass (${anchored.length})`, wrong.length === 0, wrong.join(' | '));
    check('the escape guard itself stays unchanged (shipped lists may hide <body>)', isSafePickedSelector('body') === true);

    const routes = read('js/workflow/filter-routes.js');
    const at = routes.indexOf('export async function handleAddCustomFilters(');
    const body = at === -1 ? '' : routes.slice(at, routes.indexOf('\n}\n', at));
    check('service worker picker route refuses a whole-page pick before storing', /selectors\.some\(hidesWholePage\)[\s\S]*return;[\s\S]*saveCustomCosmeticSelectors\(/.test(body));
    const page = read('picker/picker.js');
    check('picker page refuses a whole-page pick in validateSelector()', /hidesWholePage\(result\.compiled\)[\s\S]{0,120}return;/.test(page));
    const script = read('js/scripting/picker.js');
    check('element path walks up to <html> (elem !== null)', /while \( elem !== null \)/.test(script) && script.includes('elem !== document.body') === false);
    // (11.0.2 fix) A click with nothing pickable (only <body>/<html>, or no element) is ignored, not shown as an empty
    // dialog — that threw "reading 'partsDB'" / "parts is not iterable" on cnn.com (owner's report). Runs the real guard.
    const pageSrc = read('picker/picker.js');
    const guardAt = pageSrc.indexOf('function hasPickCandidates(msg) {');
    const guardEnd = pageSrc.indexOf('\n}\n', guardAt);
    const { default: vm } = await import('node:vm');
    const sandbox = {};
    vm.runInNewContext(`${pageSrc.slice(guardAt, guardEnd + 2)}\nthis.hasPickCandidates = hasPickCandidates;`, sandbox);
    const hp = sandbox.hasPickCandidates;
    const emptyCases = [ undefined, null, {}, { partsDB: [], listParts: [ [ 1 ], [ 2 ] ], sliderParts: [] } ];
    check('picker page ignores a click with nothing pickable (no reply, or only <body>/<html>)',
        guardAt !== -1 && emptyCases.every(c => hp(c) === false) && hp({ partsDB: [], listParts: [ [ 1 ] ], sliderParts: [ [ 1 ] ] }) === true);
    check('showDialog() checks first, updateSlider() skips a missing position',
        /function showDialog\(msg\) \{\s*if \( hasPickCandidates\(msg\) === false \) \{ return; \}/.test(pageSrc) &&
        /const parts = sliderParts\[i\];\s*if \( Array\.isArray\(parts\) === false \) \{ return; \}/.test(pageSrc));
    check('slider never starts at <body>/<html>', /Math\.max\(listParts\.length - WHOLE_PAGE_DEPTH, 0\)/.test(script) && /const WHOLE_PAGE_DEPTH = 2;/.test(script));
}

async function sectionB() {
    console.log('── B. Cookie-clicker rules: validated hostnames, bounded fields, sender cross-check ──');
    const rulesMod = await import(moduleUrl('js/core/cookie-clicker-rules.js'));
    const base = { siteHostname: 'example.com', frameHostname: 'cmp.example.net', selector: 'button.accept', textFilter: '' };
    check('a real pick is stored', (await rulesMod.addCookieClickerRule(base)) !== null);
    check('a malformed site hostname is refused', (await rulesMod.addCookieClickerRule({ ...base, siteHostname: 'exa mple.com' })) === null);
    check('the "*" wildcard is refused as a site', (await rulesMod.addCookieClickerRule({ ...base, siteHostname: '*' })) === null);
    check('a malformed frame hostname is refused', (await rulesMod.addCookieClickerRule({ ...base, frameHostname: 'a/b' })) === null);
    check('an oversized selector is refused', (await rulesMod.addCookieClickerRule({ ...base, selector: 'a'.repeat(2_001) })) === null);
    check('an oversized text filter is refused', (await rulesMod.addCookieClickerRule({ ...base, textFilter: 'a'.repeat(2_001) })) === null);
    check('count reflects only the stored rule', await rulesMod.countCookieClickerRules() === 1);

    const routeSrc = read('js/workflow/cookie-clicker-routes.js');
    check('route compares siteHostname with sender.tab.url', /siteHostname !== hostnameOf\(sender\?\.tab\?\.url\)/.test(routeSrc));
    check('route compares frameHostname with sender.url', /frameHostname !== hostnameOf\(sender\?\.url\)/.test(routeSrc));
    const at = routeSrc.indexOf('export async function handleCookieClickerAddRule(');
    const body = routeSrc.slice(at, routeSrc.indexOf('\n}\n', at));
    check('cross-check runs before the rule is stored', body.indexOf('hostnameOf(sender?.tab?.url)') < body.indexOf('addCookieClickerRule('));
}

function sectionC() {
    console.log('── C. Cookie-clicker picker: real user gestures only ──');
    const src = read('js/scripting/cookie-clicker-picker.js');
    for ( const fn of [ 'onMouseOver', 'onClick', 'onKeyDown' ] ) {
        const at = src.indexOf(`function ${fn}(ev) {`);
        const head = at === -1 ? '' : src.slice(at, at + 200);
        check(`${fn} ignores synthetic events`, head.includes('isUserGesture(ev) === false'));
    }
    const bare = src.match(/(saveBtn|cancelBtn|understoodBtn)\.addEventListener\('click', (?!trustedOnly\()/g) ?? [];
    check('every dialog button handler is wrapped in trustedOnly()', bare.length === 0, bare.join(', '));
    check('isUserGesture checks isTrusted', /function isUserGesture\(ev\) \{\s*return ev\?\.isTrusted === true;/.test(src));
    // C47 (10.7.15): picking listeners on window/capture, so a page's capture listener cannot stop them first.
    const onDocument = src.match(/document\.(?:add|remove)EventListener\('(?:mouseover|click|keydown)'/g) ?? [];
    check('picker listeners sit on window, capture (none left on document)', onDocument.length === 0 &&
        /window\.addEventListener\('click', onClick, true\)/.test(src), onDocument.join(', '));
    const wf = read('js/scripting/worry-free-picker.js');
    const wfClicks = wf.match(/\.addEventListener\('click', (?:async )?ev => \{\s*if \( ev\.isTrusted !== true \) \{ return; \}/g) ?? [];
    check('Worry-free picker buttons act on real clicks only', wfClicks.length === 2, String(wfClicks.length));
    const overlay = read('js/scripting/tool-overlay.js');
    check('picker overlay Escape acts on a real key only', /onKeyPressed\(ev\) \{\s*if \( ev\.isTrusted !== true \) \{ return; \}/.test(overlay));
}

function sectionD() {
    console.log('── D. Manifest ──');
    const manifest = JSON.parse(read('manifest.json'));
    const war = (manifest.web_accessible_resources ?? []).flatMap(e => e.resources ?? []);
    check('matrix panel is not web-accessible (opened as an extension page only)', war.some(r => r.includes('matrix-panel')) === false, war.join(', '));
    check('picker stays web-accessible with use_dynamic_url', (manifest.web_accessible_resources ?? []).some(e =>
        (e.resources ?? []).includes('/picker/picker.html') && e.use_dynamic_url === true));
    check('no message_serialization key (C31: JSON mode pinned)', Object.hasOwn(manifest, 'message_serialization') === false);
}

// Directives the extension-page CSP must carry (10.7.14) — tighter than
// Chrome's default, never looser. One place; mirrored in the principles doc.
const REQUIRED_CSP_DIRECTIVES = Object.freeze([ "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'" ]);

async function sectionE() {
    console.log('── E. Import / Restore paths and manifest closing ──');
    const fm = await import(moduleUrl('js/core/filter-manager.js'));
    const added = await fm.importCosmeticFiltersBulk([
        [ 'import.example', [ { selector: '.ok-ad' }, { selector: 'a{}*{color:red}' }, { selector: 'b\n.c' } ] ],
    ]);
    const stored = localStore.get('site.import.example') ?? [];
    check('bulk import stores the safe selector', added.has('import.example') && stored.includes('.ok-ad'), JSON.stringify(stored));
    check('bulk import drops a selector that escapes the stylesheet', stored.includes('a{}*{color:red}') === false, JSON.stringify(stored));
    const fmSrc = read('js/core/filter-manager.js');
    const at = fmSrc.indexOf('function computeUpdatedSelectors(');
    check('the guard sits in the one shared selector merge', fmSrc.slice(at, fmSrc.indexOf('\n}\n', at)).includes('isSafePickedSelector(selector) === false'));

    const rulesMod = await import(moduleUrl('js/core/cookie-clicker-rules.js'));
    const before = await rulesMod.countCookieClickerRules();
    const { added: n } = await rulesMod.importCookieClickerRules([
        { siteHostname: 'imp.example', frameHostname: 'imp.example', selector: '#ok' },
        { siteHostname: '*', frameHostname: 'imp.example', selector: '#x' },
        { siteHostname: 'imp.example', frameHostname: 'bad host', selector: '#x' },
        { siteHostname: 'imp.example', frameHostname: 'imp.example', selector: 'a'.repeat(2_001) },
    ]);
    check('cookie-rule import keeps only the valid rule', n === 1 && await rulesMod.countCookieClickerRules() === before + 1, String(n));
    // (11.1.3) Restoring the same backup again overwrites instead of duplicating (owner's report): nothing is added,
    // the on/off state from the file wins, and a manual pick of the same button returns the stored rule.
    const again = await rulesMod.importCookieClickerRules([
        { siteHostname: 'imp.example', frameHostname: 'imp.example', selector: '#ok', enabled: false },
    ]);
    const impRules = (await rulesMod.getAllCookieClickerRules()).filter(r => r.siteHostname === 'imp.example');
    check('a second restore of the same rule adds nothing', again.added === 0 && impRules.length === 1, JSON.stringify(again));
    check('the restored on/off state overwrites the stored one', again.changed === 1 && impRules[0]?.enabled === false, JSON.stringify(impRules));
    const picked = await rulesMod.addCookieClickerRule({ siteHostname: 'imp.example', frameHostname: 'imp.example', selector: '#ok' });
    check('picking the same button again reuses the stored rule (switched on)', picked?.uid === impRules[0]?.uid && picked?.enabled === true
        && (await rulesMod.countCookieClickerRules()) === before + 1, JSON.stringify(picked));

    const manifest = JSON.parse(read('manifest.json'));
    check('no externally_connectable key (web pages cannot message uBD; an empty key only adds a Chrome warning)', Object.hasOwn(manifest, 'externally_connectable') === false);
    const external = listShippedJs().filter(f => /\bonMessageExternal\b|\bonConnectExternal\b/.test(fs.readFileSync(f, 'utf8')));
    check('no listener for other extensions or web pages', external.length === 0, external.join(', '));
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    const missing = REQUIRED_CSP_DIRECTIVES.filter(d => csp.includes(d) === false);
    check('extension-page CSP carries every required directive', missing.length === 0, missing.join(', '));
    check('extension-page CSP has no unsafe source', /unsafe-|wasm-unsafe-eval|https?:|\*/.test(csp) === false, csp);
}

console.log('=== Step 81: picker / cookie-clicker hardening (10.7.13, extended 10.7.14, 11.0.2) ===');
try {
    await sectionA();
    await sectionWholePage();
    await sectionB();
    sectionC();
    sectionD();
    await sectionE();
} catch (err) {
    console.log(`DID NOT RUN: ${err.stack ?? err}`);
    process.exit(1);
}
console.log(failures === 0 ? '\nPASS' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
