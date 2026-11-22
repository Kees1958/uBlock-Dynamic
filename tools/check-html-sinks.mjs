#!/usr/bin/env node
// tools/check-html-sinks.mjs — (10.7.6, audit 10.7.5 D-10) forbidden practice F-SINK-1: HTML text built with values.
// innerHTML / outerHTML / insertAdjacentHTML / document.write may only receive FIXED markup: a string or template
// literal whose every ${…} is a named UPPER_CASE constant (fixed text or a number from the file's own config). Any
// other value — page text, a variable, a function result — is set afterwards with textContent / setAttribute /
// a property, so the browser treats it as plain text. A non-literal argument (a variable holding HTML) fails too.
// Scans every own JS file (generated / vendored code excluded).
// Usage: node tools/check-html-sinks.mjs        Outcomes (C38): PASS / FAIL / DID NOT RUN.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = [ 'js', 'dashboard', 'popup', 'matrix', 'privacy' ];
const EXCLUDED_DIRS = [ 'js/generated' ];
// Assignments / calls that parse a string as HTML.
const SINK_RE = /\.(?:innerHTML|outerHTML)\s*=(?!=)|\.insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(/g;
const CONSTANT_RE = /^[A-Z][A-Z0-9_]*$/;

function listJs(dir) {
    const abs = path.join(ROOT, dir);
    if ( !fs.existsSync(abs) ) { return []; }
    return fs.readdirSync(abs, { recursive: true })
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(dir, f).split(path.sep).join('/'))
        .filter(f => EXCLUDED_DIRS.some(d => f.startsWith(`${d}/`)) === false);
}

// The literal starting at `at` (after optional whitespace and, for insertAdjacentHTML, the position argument), or null.
function literalAfter(src, at) {
    let i = at;
    while ( /\s/.test(src[i]) ) { i += 1; }
    const quote = src[i];
    if ( quote !== '`' && quote !== '\'' && quote !== '"' ) { return null; }
    let j = i + 1;
    while ( j < src.length && src[j] !== quote ) { j += src[j] === '\\' ? 2 : 1; }
    return { quote, body: src.slice(i + 1, j) };
}

function interpolationsOf(body) {
    const out = [];
    let at = body.indexOf('${');
    while ( at !== -1 ) {
        let depth = 1;
        let j = at + 2;
        while ( j < body.length && depth > 0 ) { if ( body[j] === '{' ) { depth += 1; } else if ( body[j] === '}' ) { depth -= 1; } j += 1; }
        out.push(body.slice(at + 2, j - 1).trim());
        at = body.indexOf('${', j);
    }
    return out;
}

function findingsOf(file) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const findings = [];
    for ( const m of src.matchAll(SINK_RE) ) {
        const line = src.slice(0, m.index).split('\n').length;
        const lineText = src.split('\n')[line - 1].trim();
        if ( lineText.startsWith('//') || lineText.startsWith('*') ) { continue; }   // a comment that names the API
        let at = m.index + m[0].length;
        if ( m[0].startsWith('.insertAdjacentHTML') ) { at = src.indexOf(',', at) + 1; }
        const literal = literalAfter(src, at);
        if ( literal === null ) { findings.push(`${file}:${line} HTML from a non-literal value`); continue; }
        if ( literal.quote !== '`' ) { continue; }
        for ( const expr of interpolationsOf(literal.body) ) {
            if ( CONSTANT_RE.test(expr) === false ) { findings.push(`${file}:${line} HTML text holds a value: \${${expr}}`); }
        }
    }
    return findings;
}

function main() {
    const files = SCAN_DIRS.flatMap(listJs);
    const findings = files.flatMap(findingsOf);
    console.log(`Scanned ${files.length} files for HTML sinks.`);
    for ( const f of findings ) { console.log(`FAIL ${f}`); }
    if ( findings.length !== 0 ) {
        console.log('\nFix: keep only fixed markup and UPPER_CASE constants in the HTML text; set every other value afterwards with textContent / setAttribute / a property (forbidden practice F-SINK-1).');
        process.exit(1);
    }
    console.log('PASS: every HTML sink receives fixed markup only.');
}

try { main(); } catch (err) { console.error('DID NOT RUN: check-html-sinks —', err); process.exit(1); }
