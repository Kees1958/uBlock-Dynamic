#!/usr/bin/env node
// tools/check-ui-name-copies.mjs — (10.5.0) guard for js/data/ui-names.js, the single source of the
// Worry-free feature name and the dashboard tab names (C39a, Part D step 51 rule).
//
//   1. Every file the platform forces to keep its OWN copy of a name (a content script cannot
//      import a module) declares it once, and that copy equals the source value.
//   2. No shipped file still uses a retired name ("safe surfing", the "Privacy & Security" tab
//      label in HTML) — except the files listed in RETIRED_NAME_ALLOWLIST, each with a reason.
//   3. The dashboard tab bar is not typed in HTML (it is built from DASHBOARD_TABS).
//
// Exit 0 = pass, 1 = a finding, 2 = could not run (C38: "did not run" is never a pass).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Config — every tunable declared once ──────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_MODULE = 'js/data/ui-names.js';
// Files that keep a forced copy: file -> { constName: the export it must equal }.
const FORCED_COPIES = Object.freeze({
    'js/scripting/worry-free-picker.js': { WORRY_FREE_NAME: 'WORRY_FREE_NAME', COOKIE_CLICKER_NAME: 'COOKIE_CLICKER_NAME' },
    'js/scripting/ad-cleaner.js':        { AD_CLEANER_NAME: 'AD_CLEANER_NAME' },   // (11.0.0)
});
// Retired names, as regular expressions over shipped source text.
const RETIRED_NAMES = Object.freeze([
    { label: '"safe surfing" (renamed "Worry-free surfing", 10.5.0)', re: /safe surfing/i },
]);
// Retired names that must not appear as HTML text (comments stripped).
const RETIRED_HTML_TEXT = Object.freeze([
    { label: '"Privacy & Security" tab label (renamed "Options", 10.5.0)', re: /Privacy (&amp;|&) Security/ },
]);
// (10.7.1) Retired names that must not appear in USER-VISIBLE text only: HTML text outside tags/comments, and JS string
// literals outside comments. Internal names keep the old word on purpose (worryFree* ids and setting keys, file names,
// "@@site$worryfree"), so a whole-file match is useless here. Not counted: module paths and console messages.
const RETIRED_VISIBLE_TEXT = Object.freeze([
    { label: '"Worry-free" (renamed "Seamless surfing", 10.7.1)', re: /worry[- ]free/i },
    { label: '"Dynamic DNR" (renamed "DNR tracking filter", 11.0.0)', re: /dynamic dnr/i },
    // (11.0.2) The product is "uBlock Dynamic" (manifest extName). The old names lingered in 3 window titles and the
    // Settings page title. Credits ("Based on uBlock Origin Lite", "inspired by uBO") are a different name: not matched.
    { label: '"uBlock Stripped" / "uBOL Stripped" (product renamed "uBlock Dynamic")', re: /u(?:block|bol)[ -]stripped/i },
    // (11.1.0, owner) Tool names in sentence case: the first word only.
    { label: '"Fingerprint Inspector" (now "Fingerprint inspector", sentence case, 11.1.0)', re: /Fingerprint Inspector/ },
    { label: '"Cookie consent-clicker" (the tool is "Cookie consent clicker")', re: /Cookie consent-clicker/ },   // space/hyphen only: internal ids like 'uBolStrippedDynamic.picker' stay (contract)
]);
const JS_STRING_RE = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const NOT_UI_STRING_RE = /^(?:\.{0,2}\/|\[uBlock-Dynamic\])|\.m?js$/;   // './x.js', '/js/x.js', '[uBlock-Dynamic] …'
const RETIRED_NAME_ALLOWLIST = Object.freeze({
    'js/data/ui-names.js': 'records the old name once, as history of the rename',
});
const SHIPPED_DIRS = [ 'js', 'dashboard', 'popup', 'picker', 'matrix', 'privacy', '_locales' ];
const SHIPPED_EXT_RE = /\.(js|html|css|json)$/;
const DASHBOARD_HTML = 'dashboard/dashboard.html';
const EXIT_PASS = 0, EXIT_FINDING = 1, EXIT_DID_NOT_RUN = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────
function listFiles(rel, out = []) {
    const abs = path.join(ROOT, rel);
    if ( !fs.existsSync(abs) ) { return out; }
    for ( const entry of fs.readdirSync(abs, { withFileTypes: true }) ) {
        const child = path.posix.join(rel, entry.name);
        if ( entry.isDirectory() ) { listFiles(child, out); } else if ( SHIPPED_EXT_RE.test(entry.name) ) { out.push(child); }
    }
    return out;
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripHtmlComments(html) { return html.replace(/<!--[\s\S]*?-->/g, ''); }
function htmlVisibleText(html) { return stripHtmlComments(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' '); }
// JS string literals on code lines (line and block comments skipped), minus module paths and console tags.
function jsUiStrings(js) {
    const out = [];
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '');
    for ( const line of code.split('\n') ) {
        if ( line.trim().startsWith('//') ) { continue; }
        for ( const m of line.replace(/\s\/\/.*$/, '').matchAll(JS_STRING_RE) ) {
            if ( NOT_UI_STRING_RE.test(m[2]) === false ) { out.push(m[2]); }
        }
    }
    return out;
}

let findings = 0;
function report(ok, text) {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
    if ( !ok ) { findings += 1; }
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────────
async function main() {
    const source = await import(pathToFileURL(path.join(ROOT, SOURCE_MODULE)).href);

    // 1. Forced copies.
    for ( const [ file, consts ] of Object.entries(FORCED_COPIES) ) {
        const text = read(file);
        for ( const [ constName, exportName ] of Object.entries(consts) ) {
            const decls = [ ...text.matchAll(new RegExp(`const\\s+${constName}\\s*=\\s*'([^']*)'`, 'g')) ];
            report(decls.length === 1, `${file}: ${constName} declared exactly once (found ${decls.length})`);
            if ( decls.length === 1 ) {
                const expected = source[exportName];
                report(decls[0][1] === expected, `${file}: ${constName} = '${decls[0][1]}' equals ${SOURCE_MODULE} ${exportName} = '${expected}'`);
            }
        }
    }

    // 2. Retired names in shipped files.
    const files = SHIPPED_DIRS.flatMap(d => listFiles(d));
    for ( const { label, re } of RETIRED_NAMES ) {
        const hits = files.filter(f => !Object.hasOwn(RETIRED_NAME_ALLOWLIST, f) && re.test(read(f)));
        report(hits.length === 0, `no shipped file uses ${label}${hits.length ? ': ' + hits.join(', ') : ''}`);
    }
    const htmlFiles = files.filter(f => f.endsWith('.html'));
    for ( const { label, re } of RETIRED_HTML_TEXT ) {
        const hits = htmlFiles.filter(f => re.test(stripHtmlComments(read(f))));
        report(hits.length === 0, `no HTML text uses the ${label}${hits.length ? ': ' + hits.join(', ') : ''}`);
    }

    // 2b. Retired names in user-visible text (10.7.1).
    for ( const { label, re } of RETIRED_VISIBLE_TEXT ) {
        const hits = files.filter(f => !Object.hasOwn(RETIRED_NAME_ALLOWLIST, f)).filter(f => {
            if ( f.endsWith('.html') ) { return re.test(htmlVisibleText(read(f))); }
            if ( f.endsWith('.js') ) { return jsUiStrings(read(f)).some(s => re.test(s)); }
            if ( f.startsWith('_locales/') ) { return re.test(read(f)); }
            return false;
        });
        report(hits.length === 0, `no user-visible text uses ${label}${hits.length ? ': ' + hits.join(', ') : ''}`);
    }

    // 3. Tab bar not typed in HTML.
    const typedTabs = (stripHtmlComments(read(DASHBOARD_HTML)).match(/class="tabButton"/g) ?? []).length;
    report(typedTabs === 0, `${DASHBOARD_HTML}: no typed tab buttons (found ${typedTabs}) — built from DASHBOARD_TABS`);

    console.log(findings === 0 ? '\nPASS: UI names derived from one source.' : `\n${findings} finding(s).`);
    process.exit(findings === 0 ? EXIT_PASS : EXIT_FINDING);
}

main().catch(err => {
    console.error('check-ui-name-copies: could not run —', err);
    process.exit(EXIT_DID_NOT_RUN);
});
