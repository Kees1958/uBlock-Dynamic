#!/usr/bin/env node
// ── check-input-size-limits.mjs ───────────────────────────────────────────────
// Manual C49 / F-INPUT-1 (v15, 11.0.2 audit): outside input is size-checked BEFORE it is read.
//
// Part A — static scan. Every call that reads a whole blob or file into memory (.text(), .arrayBuffer(), .bytes(),
//   FileReader readAs*) in shipped code must be either
//     GATED     — its enclosing function calls checkImportFileSize() earlier in the source, or
//     CLASSIFIED — listed in READ_SITE_ALLOWLIST below with a reason (e.g. a fetch of a file bundled with the
//                  extension, which is not outside input).
//   A new, unclassified read site fails the check (C25: classify, never silently adopt).
// Part B — the real checkImportFileSize() from js/util/input-limits.js, driven with edge sizes.
//
// Usage: node tools/check-input-size-limits.mjs [<root>]     Outcomes (C38): PASS / FAIL / DID NOT RUN.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as espree from 'espree';
import { listFiles } from './lib/walk.mjs';

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));

// ── Declared configuration ────────────────────────────────────────────────────
const CHECK_CONFIG = Object.freeze({
    EXCLUDE_DIRS: [ 'tools', 'lib', 'vendor', 'js/generated', 'rulesets', 'web_accessible_resources', '_locales' ],
    READ_METHODS: new Set([ 'text', 'arrayBuffer', 'bytes', 'readAsText', 'readAsArrayBuffer', 'readAsDataURL', 'readAsBinaryString' ]),
    GATE_FUNCTION: 'checkImportFileSize',
    // Minimum number of read sites expected: the three file imports (Restore settings, Import custom rules,
    // Import ABP box). Fewer means the scan is no longer seeing them — DID NOT RUN, not PASS (C38 rule 2).
    MIN_GATED_SITES: 3,
});

// file → enclosing function names whose reads are not outside input, with the reason.
const READ_SITE_ALLOWLIST = Object.freeze({
    'js/offscreen/compile-filters.js': {
        toMv3Data: 'fetches files bundled with the extension (css-api.js, isolated-api.js, …) — not outside input',
    },
});

// ── Part A ────────────────────────────────────────────────────────────────────
function functionName(node, parent) {
    if ( node.id?.name ) { return node.id.name; }
    if ( parent?.type === 'VariableDeclarator' ) { return parent.id.name; }
    if ( parent?.type === 'MethodDefinition' || parent?.type === 'Property' ) { return parent.key?.name ?? '(anonymous)'; }
    return null;   // an anonymous callback: the read belongs to the nearest NAMED function around it
}

function scanFile(abs) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const src = fs.readFileSync(abs, 'utf8');
    let ast;
    try { ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true }); }
    catch { ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'script', range: true, loc: true }); }
    const sites = [];
    const stack = [];   // { name, node }
    function visit(node, parent) {
        if ( node === null || typeof node.type !== 'string' ) { return; }
        const isFn = /Function/.test(node.type);
        if ( isFn ) { stack.push({ name: functionName(node, parent), node }); }
        if ( node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.computed === false
             && CHECK_CONFIG.READ_METHODS.has(node.callee.property.name) && node.arguments.length <= 1 ) {
            const named = [ ...stack ].reverse().find(f => f.name !== null);
            const owner = named ?? null;
            const body = owner ? src.slice(owner.node.range[0], node.range[0]) : src.slice(0, node.range[0]);
            sites.push({
                file: rel,
                line: node.loc.start.line,
                fn: owner?.name ?? '(top level)',
                gated: body.includes(`${CHECK_CONFIG.GATE_FUNCTION}(`),
            });
        }
        for ( const key of Object.keys(node) ) {
            if ( key === 'range' || key === 'loc' ) { continue; }
            const v = node[key];
            if ( Array.isArray(v) ) { for ( const c of v ) { if ( c && typeof c.type === 'string' ) { visit(c, node); } } }
            else if ( v && typeof v.type === 'string' ) { visit(v, node); }
        }
        if ( isFn ) { stack.pop(); }
    }
    visit(ast, null);
    return sites;
}

function isAllowlisted(site) {
    return READ_SITE_ALLOWLIST[site.file]?.[site.fn] !== undefined;
}

// ── Part B ────────────────────────────────────────────────────────────────────
async function checkHelper(failures) {
    const mod = await import(pathToFileURL(path.join(ROOT, 'js/util/input-limits.js')).href);
    const { INPUT_LIMITS, checkImportFileSize } = mod;
    const max = INPUT_LIMITS.MAX_IMPORT_FILE_BYTES;
    const cases = [
        [ 'empty file',          { size: 0 },        true ],
        [ 'exactly the limit',   { size: max },      true ],
        [ 'one byte over',       { size: max + 1 },  false ],
        [ 'missing size',        {},                 false ],
        [ 'no file at all',      undefined,          false ],
        [ 'NaN size',            { size: NaN },      false ],
        [ 'negative size',       { size: -1 },       false ],
        [ 'infinite size',       { size: Infinity }, false ],
    ];
    for ( const [ label, file, expectOk ] of cases ) {
        const r = checkImportFileSize(file);
        if ( r.ok !== expectOk ) { failures.push(`checkImportFileSize(${label}): expected ok=${expectOk}, got ${r.ok}`); }
        if ( r.ok === false && (typeof r.error !== 'string' || r.error === '') ) {
            failures.push(`checkImportFileSize(${label}): refused without a reason the person can read`);
        }
    }
    const text = checkImportFileSize({ size: max + 1 }).error ?? '';
    if ( text.includes(String(max)) ) { failures.push('the refusal shows a raw byte count instead of megabytes'); }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const failures = [];
const files = listFiles(ROOT, { exts: [ '.js' ], excludeDirs: CHECK_CONFIG.EXCLUDE_DIRS });
const sites = files.flatMap(scanFile);
const gated = sites.filter(s => s.gated);
const allowed = sites.filter(s => !s.gated && isAllowlisted(s));
const open = sites.filter(s => !s.gated && !isAllowlisted(s));

for ( const s of open ) {
    failures.push(`${s.file}:${s.line} (${s.fn}) reads a whole file/blob with no ${CHECK_CONFIG.GATE_FUNCTION}() before it and is not classified in READ_SITE_ALLOWLIST`);
}
for ( const [ file, fns ] of Object.entries(READ_SITE_ALLOWLIST) ) {
    for ( const fn of Object.keys(fns) ) {
        if ( !sites.some(s => s.file === file && s.fn === fn) ) {
            failures.push(`stale allowlist entry: ${file} → ${fn} has no read site any more — remove it`);
        }
    }
}
await checkHelper(failures);

console.log(`Scanned ${files.length} files: ${sites.length} read sites — ${gated.length} gated, ${allowed.length} classified, ${open.length} open.`);
if ( failures.length > 0 ) {
    for ( const f of failures ) { console.error(`FAIL: ${f}`); }
    process.exit(1);
}
if ( gated.length < CHECK_CONFIG.MIN_GATED_SITES ) {
    console.error(`DID NOT RUN properly: only ${gated.length} gated read sites found, at least ${CHECK_CONFIG.MIN_GATED_SITES} expected (the three file imports).`);
    process.exit(2);
}
console.log('PASS: every whole-file read is size-checked first or classified; checkImportFileSize() behaves.');
