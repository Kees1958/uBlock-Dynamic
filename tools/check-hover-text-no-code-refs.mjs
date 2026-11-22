#!/usr/bin/env node
// tools/check-hover-text-no-code-refs.mjs — (11.0.0, owner's rule 2026-11-19) HARD check: user-facing hover text
// (title attributes, `.title =` assignments, `title:` entries, and the risk-badge `reason:` texts) must never name
// internal code: no file names or paths (".js", "js/…"), no "function()" names. Users cannot know what those are.
// Real incident: a custom-rules tooltip said "(see js/scripting/cookie-clicker-click.js)".
// Comments are ignored (a code reference in a comment is for developers and is fine).
// Outcomes (C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Settings ──────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    // Where user-facing text lives (pages, their scripts, page-injected tools, user-facing label data).
    DIRS: [ 'dashboard', 'popup', 'picker', 'matrix', 'privacy-inspector', 'inspector', 'js/scripting', 'js/ui' ],
    FILES: [ 'js/data/scriptlet-rule-labels.js', 'js/data/ui-names.js', 'js/data/retired-protections.js' ],
    EXTENSIONS: [ '.js', '.html' ],
    // A line that sets hover text (or a risk-badge reason shown as one).
    HOVER_LINE_RE: /(\.title\s*\+?=|\btitle\s*:|\btitle="|setAttribute\(\s*'title'|\breason\s*:)/,
    // What counts as an internal code reference.
    CODE_REF_RE: /\b[\w-]+\.(?:js|mjs|json|css)\b|\bjs\/[\w/-]+|\b[a-z][A-Za-z0-9_]*\(\)/,
});

function listFiles() {
    const out = [ ...CONFIG.FILES ];
    for ( const dir of CONFIG.DIRS ) {
        const abs = path.join(ROOT, dir);
        if ( fs.existsSync(abs) === false ) { continue; }
        for ( const name of fs.readdirSync(abs) ) {
            if ( CONFIG.EXTENSIONS.includes(path.extname(name)) ) { out.push(path.join(dir, name)); }
        }
    }
    return out;
}

// Drop comments: `// …` at line end (not inside a URL), whole-line `*`/`/*` comment lines, and HTML comments.
function codeOnly(line) {
    const t = line.trim();
    if ( t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--') ) { return ''; }
    return line.replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/.*$/, '$1');
}

console.log('=== Hover text has no internal code references (11.0.0) ===');
const findings = [];
let scanned = 0;
try {
    for ( const rel of listFiles() ) {
        const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
        lines.forEach((line, i) => {
            const code = codeOnly(line);
            if ( CONFIG.HOVER_LINE_RE.test(code) === false ) { return; }
            scanned++;
            // Only the quoted text on that line: a hover text is a string, not the code around it.
            const strings = [ ...code.matchAll(/'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g) ].map(m => m[0]);
            const hit = strings.find(s => CONFIG.CODE_REF_RE.test(s));
            if ( hit !== undefined ) { findings.push(`${rel}:${i + 1}: ${hit.slice(0, 120)}`); }
        });
    }
} catch ( err ) {
    console.log(`DID NOT RUN: ${err.message}\nA check that did not run has not passed.`);
    process.exit(1);
}
if ( scanned === 0 ) {
    console.log('DID NOT RUN: no hover-text lines found — the scan itself is broken.');
    process.exit(1);
}
for ( const f of findings ) { console.log(`FAIL ${f}`); }
console.log(findings.length === 0
    ? `PASS: ${scanned} hover-text lines checked, none names a file, path or function.`
    : `FINDINGS: ${findings.length} hover text(s) name internal code.`);
process.exit(findings.length === 0 ? 0 : 1);
