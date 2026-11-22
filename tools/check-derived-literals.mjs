#!/usr/bin/env node
// tools/check-derived-literals.mjs — Part D step 50 (C39a), ported to uBlock Stripped Dynamic in 10.5.0.
//
// A number the user reads (a duration, a count, a threshold, a level) that is TYPED into HTML text or a
// JS string is a second, unlinked copy of a constant: right on the day it is typed, silently wrong after
// the next change (10.5.0 found two: the Privacy Inspector's "5:00" start value, and a tooltip that still
// described a removed "threshold is 5" rule). This check scans every user-visible text in the UI pages
// for a standalone number and fails on any hit that is not in ALLOWLIST with a stated reason.
// Values inserted with ${...} are derived and never count; digits inside a word (Kees1958, Mv3) are names.
//
// Exit 0 = pass, 1 = unclassified hit, 2 = could not run (C38).

import fs from 'node:fs';
import path from 'node:path';

// ── Config — every tunable declared once ──────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..');
const UI_DIRS = [ 'dashboard', 'popup', 'picker', 'matrix', 'privacy', 'js/ui' ];
const UI_FILE_RE = /\.(html|js)$/;
const SKIP_FILE_RE = /codemirror|cm6\.bundle/;                 // vendored editor
const STANDALONE_NUMBER_RE = /(?<![\w.#\-/])\d+(?![\w.\-/])/;   // "5", "5:00" — not "Kees1958", "v2", "1.5", "/2/"
const MIN_WORD_LETTERS = 3;                                     // a JS string is UI text only if it holds a real word
// Hits that are not a copy of any constant. Key: file; value: [ text fragment, reason ].
const ALLOWLIST = Object.freeze({
    'matrix/matrix-panel.js': [
        [ '(0=', 'the "none" tier is defined as zero matching rules — 0 is the definition, not a copy of a constant' ],
        [ '(1 of ', 'grammar: "1 of N domains in a combined rule" — this one domain out of the derived count' ],
    ],
    // (10.7.0) The tracking-element sizes are defined in privacy/privacy-probe.js's TRACKING_ELEMENT_CONFIG — a MAIN-world
    // page script that cannot import a shared module (and must not expose a page-visible global), so these two
    // explanations state the owner's spec (1x1 frames; 1x1 and 3x3 images) in words.
    'privacy/privacy-inspector.js': [
        [ 'An invisible frame of at most 1\\u00d71 pixel', 'the probe\'s MAX_FRAME_PX, stated in the panel\'s explanation (see above)' ],
        [ 'An image of 1\\u00d71 or 3\\u00d73 pixels', 'the probe\'s PIXEL_SIZES, stated in the panel\'s explanation (see above)' ],
    ],
});
const EXIT_PASS = 0, EXIT_FINDING = 1, EXIT_DID_NOT_RUN = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────
function listFiles(rel, out = []) {
    for ( const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }) ) {
        const child = path.posix.join(rel, entry.name);
        if ( entry.isDirectory() ) { listFiles(child, out); } else if ( UI_FILE_RE.test(entry.name) && !SKIP_FILE_RE.test(child) ) { out.push(child); }
    }
    return out;
}
// Removes ${ ... } (nested braces included) from a template literal body: inserted values are derived.
function stripInterpolations(text) {
    let out = '', depth = 0;
    for ( let i = 0; i < text.length; i++ ) {
        if ( depth === 0 && text[i] === '$' && text[i + 1] === '{' ) { depth = 1; i += 1; continue; }
        if ( depth > 0 ) { if ( text[i] === '{' ) { depth += 1; } else if ( text[i] === '}' ) { depth -= 1; } continue; }
        out += text[i];
    }
    return out;
}
function htmlTexts(html) {
    const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
    const texts = [ ...clean.matchAll(/>([^<>]+)</g) ].map(m => m[1].trim()).filter(Boolean);
    for ( const m of clean.matchAll(/\s(title|placeholder|aria-label|alt)="([^"]*)"/g) ) { texts.push(m[2]); }
    return texts;
}
function jsTexts(js) {
    const clean = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const texts = [];
    // '...' and "..." cannot span lines in JS; only template literals can.
    const STRING_RE = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
    for ( const m of clean.matchAll(STRING_RE) ) {
        const body = m[3] !== undefined ? stripInterpolations(m[3]) : (m[1] ?? m[2]);
        if ( (body.match(/[A-Za-z]{3,}/g) ?? []).length === 0 ) { continue; }
        if ( !new RegExp(`[A-Za-z]{${MIN_WORD_LETTERS},}\\s+[A-Za-z]`).test(body) ) { continue; }   // selectors, ids, keys
        texts.push(body);
    }
    return texts;
}
function isAllowed(file, text) {
    return (ALLOWLIST[file] ?? []).some(([ fragment ]) => text.includes(fragment));
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────────
function main() {
    const files = UI_DIRS.flatMap(d => listFiles(d));
    let hits = 0, allowed = 0;
    for ( const file of files ) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const texts = file.endsWith('.html') ? htmlTexts(src) : jsTexts(src);
        for ( const text of texts ) {
            if ( !STANDALONE_NUMBER_RE.test(text) ) { continue; }
            if ( isAllowed(file, text) ) { allowed += 1; continue; }
            hits += 1;
            console.log(`FAIL ${file}: typed number in UI text — "${text.slice(0, 120)}"`);
        }
    }
    const usedAllowlist = Object.entries(ALLOWLIST).flatMap(([ f, entries ]) => entries.map(([ frag ]) => [ f, frag ]));
    for ( const [ f, frag ] of usedAllowlist ) {
        const src = fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '';
        if ( !src.includes(frag) ) { hits += 1; console.log(`FAIL allowlist entry no longer matches anything: ${f} "${frag}" — remove it`); }
    }
    console.log(`\nScanned ${files.length} UI files: ${hits} unclassified hit(s), ${allowed} allowlisted.`);
    console.log(hits === 0 ? 'PASS: user-visible numbers are derived.' : 'Derive each value from its constant, or allowlist it with a reason.');
    process.exit(hits === 0 ? EXIT_PASS : EXIT_FINDING);
}

try { main(); } catch (err) {
    console.error('check-derived-literals: could not run —', err);
    process.exit(EXIT_DID_NOT_RUN);
}
