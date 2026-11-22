#!/usr/bin/env node
// tools/test-storage-sender-trust.mjs — (10.7.6, audit 10.7.5 D-4/D-5) what a web page's content script can reach.
//   Part A (D-4): isTrustedSender() (js/workflow/message-routes.js) on the real function — only "no sender at all"
//                 (uBD's internal calls) and uBD's own pages are trusted; a sender object without an origin is not.
//   Part B (D-5, owner's option B): session storage stays closed to content scripts — background.js sets
//                 TRUSTED_CONTEXTS, nothing opens it, and no content-script file (every file registered with
//                 js: [...] / files: [...] or in the manifest) touches storage.session.
//   Part C: the per-site CSS cache lives in storage.local on both sides (content script + worker reset/prune).
// Usage: node tools/test-storage-sender-trust.mjs        Outcomes (C38): PASS / FAIL / DID NOT RUN.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop';
const EXT_ID = 'abcdefghijklmnop';
const SOURCE_DIRS = [ 'js', 'dashboard', 'popup', 'matrix', 'privacy' ];
// js: [ ... ] / files: [ ... ] arrays in registerContentScripts() / executeScript() directives.
const SCRIPT_LIST_RE = /\b(?:js|files)\s*:\s*\[([^\]]*)\]/g;
const SCRIPT_PATH_RE = /['"`]\/?([\w./-]+\.js)['"`]/g;
// ...and a content-script path held in a named constant (e.g. COSMETIC_SPECIFIC_READER_JS = '/js/scripting/css-specific.js').
const SCRIPT_CONST_RE = /\b[A-Z][A-Z0-9_]*_JS\s*=\s*['"`]\/?([\w./-]+\.js)['"`]/g;

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
    if ( !ok ) { failures += 1; }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function listJs(dir) {
    const abs = path.join(ROOT, dir);
    if ( !fs.existsSync(abs) ) { return []; }
    return fs.readdirSync(abs, { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));
}
function functionBody(src, signature) {
    const at = src.indexOf(signature);
    return at === -1 ? '' : src.slice(at, src.indexOf('\n}\n', at));
}

async function main() {
    console.log('── A. Trusted sender ──');
    const { isTrustedSender } = await import(pathToFileURL(path.join(ROOT, 'js/workflow/message-routes.js')).href);
    const cases = [
        [ 'no sender (internal call)', undefined, true ],
        [ 'own page', { id: EXT_ID, origin: EXT_ORIGIN }, true ],
        [ 'own page, upper-case origin', { id: EXT_ID, origin: EXT_ORIGIN.toUpperCase() }, true ],
        [ 'sender object WITHOUT origin', { id: EXT_ID }, false ],
        [ 'empty sender object', {}, false ],
        [ 'own content script (page origin)', { id: EXT_ID, origin: 'https://example.com' }, false ],
        [ 'other extension with our origin string', { id: 'otherextension', origin: EXT_ORIGIN }, false ],
        [ 'null sender', null, false ],
    ];
    for ( const [ label, sender, want ] of cases ) {
        check(`isTrustedSender: ${label} -> ${want}`, isTrustedSender(sender, EXT_ORIGIN, EXT_ID) === want);
    }
    const bg = read('js/workflow/background.js');
    check('background.js gates trusted routes with isTrustedSender(sender, UBOL_ORIGIN, runtime.id)',
        /isTrustedOrigin:\s*\(\s*\)\s*=>\s*isTrustedSender\(sender, UBOL_ORIGIN, runtime\.id\)/.test(bg));

    // (10.7.9, audit 10.7.8) Every runtime.onMessage listener in the service-worker graph is classified: the main
    // router (gated per route above) or a listener that refuses an untrusted sender itself. A new, unclassified
    // listener fails (C25 shape) — the offscreen compile listener had no sender check until 10.7.9.
    const SW_LISTENER_FILES = Object.freeze({
        'js/workflow/background.js': 'main router — per-route isTrustedOrigin gate',
        'js/core/compiled-filters.js': 'offscreen compile listener — refuses untrusted senders itself',
    });
    const swDirs = [ 'js/workflow', 'js/core', 'js/data', 'js/util' ];
    const listenerFiles = swDirs.flatMap(listJs).filter(f => /onMessage\.addListener\(/.test(read(f)));
    for ( const f of listenerFiles ) {
        check(`runtime.onMessage listener in ${f} is classified`, Object.hasOwn(SW_LISTENER_FILES, f));
    }
    const cfHandler = functionBody(read('js/core/compiled-filters.js'), 'function handler(request, sender, callback) {');
    check('compiled-filters.js handler refuses untrusted senders before its switch',
        /isTrustedSender\(sender, EXTENSION_ORIGIN, runtime\.id\) === false[\s\S]*switch \(/.test(cfHandler));

    console.log('\n── B. Session storage closed to content scripts ──');
    const allFiles = SOURCE_DIRS.flatMap(listJs);
    const opens = allFiles.filter(f => read(f).includes('TRUSTED_AND_UNTRUSTED_CONTEXTS'));
    check('nothing opens session storage (TRUSTED_AND_UNTRUSTED_CONTEXTS)', opens.length === 0, opens.join(', '));
    check('background.js sets session storage to TRUSTED_CONTEXTS', /sessionAccessLevel\(\{\s*accessLevel:\s*'TRUSTED_CONTEXTS'\s*\}\)/.test(bg));

    const contentScripts = new Set();
    for ( const f of allFiles ) {
        for ( const list of read(f).matchAll(SCRIPT_LIST_RE) ) {
            for ( const m of list[1].matchAll(SCRIPT_PATH_RE) ) { contentScripts.add(m[1]); }
        }
        for ( const m of read(f).matchAll(SCRIPT_CONST_RE) ) { contentScripts.add(m[1]); }
    }
    const manifest = JSON.parse(read('manifest.json'));
    for ( const cs of manifest.content_scripts ?? [] ) { for ( const js of cs.js ?? [] ) { contentScripts.add(js.replace(/^\//, '')); } }
    const existing = [ ...contentScripts ].filter(p => fs.existsSync(path.join(ROOT, p)));
    check('content-script files found (sanity: the scan works)', existing.includes('js/scripting/css-specific.js'), existing.join(', '));
    const usingSession = existing.filter(p => /storage\.session\b/.test(read(p)));
    check('no content-script file touches storage.session', usingSession.length === 0, usingSession.join(', '));

    console.log('\n── C. Per-site CSS cache in storage.local ──');
    const css = read('js/scripting/css-specific.js');
    check('css-specific.js reads the cache from storage.local', /await localRead\(cacheKey\)/.test(css));
    check('css-specific.js writes the cache to storage.local', /chrome\.storage\.local\.set\(\{ \[key\]: data \}\)/.test(functionBody(css, 'function cacheWrite')));
    const sm = read('js/core/scripting-manager.js');
    check('resetCSSCache() clears storage.local', /localKeys\(\)[\s\S]*localRemove\(/.test(functionBody(sm, 'async function resetCSSCache')));
    check('pruneCSSCache() trims storage.local', /localKeys\(\)[\s\S]*localRemove\(/.test(functionBody(sm, 'export async function pruneCSSCache')));

    console.log(failures === 0 ? '\nPASS' : `\n${failures} assertion(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('DID NOT RUN: test-storage-sender-trust —', err);
    process.exit(1);
});
