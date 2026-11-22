#!/usr/bin/env node
// ── check-tier-direction.mjs ──────────────────────────────────────────────────
// Manual C15 (v15, audit 11.0.2 finding 1): imports between the five tiers flow downward only. Step 26 (madge)
// catches cycles; a sideways or upward import that closes no cycle passes it — this check catches those.
//
// Rules (ARCHITECTURE.md "The five-tier model"):
//   ui/ (1) → workflow/ (2) → core/ (3) → util/ (4), data/ (5)        — a file may import its own tier or a lower one
//   workflow/  — only background.js imports a workflow/ file (a route file never imports another route file, 10.7.12)
//   util/      — imports nothing inside the extension, except owner-approved entries in UTIL_IMPORT_EXCEPTIONS
//   data/      — may import another data/ file, and a util/ file only if that util/ file imports nothing (10.7.6)
//   any tier   — never imports js/scripting/ or js/offscreen/ code (separate execution contexts)
// Every listed exception is re-verified: its target must still import nothing (no cycle risk), and a stale entry
// (the import no longer exists) fails.
//
// Usage: node tools/check-tier-direction.mjs [<root>]      Outcomes (C38): PASS / FAIL / DID NOT RUN.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import * as espree from 'espree';
import { listFiles } from './lib/walk.mjs';

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));

// ── Declared configuration ────────────────────────────────────────────────────
const TIER_CONFIG = Object.freeze({
    TIERS: Object.freeze({ ui: 1, workflow: 2, core: 3, util: 4, data: 5 }),
    EXECUTION_CONTEXT_DIRS: Object.freeze([ 'js/scripting/', 'js/offscreen/' ]),
    WORKFLOW_ENTRY: 'js/workflow/background.js',
    // Fewer relative imports than this inside the tiers means the scan is not seeing the code (C38 rule 2).
    MIN_TIER_IMPORTS: 200,
});

// util/ → util/ imports APPROVED BY THE OWNER, each with its reason (owner's decision 2026-11-22, ARCHITECTURE.md):
// allowed only when the target imports nothing (re-checked every run) AND the alternative would break or contradict
// another rule (e.g. copying a constant, against B2) AND the owner discussed and approved that specific import.
// Never add an entry without that approval — an unlisted util/ import is meant to fail.
const UTIL_IMPORT_EXCEPTIONS = Object.freeze({
    'js/util/popunder-parser.js → js/util/utils.js': 'approved 2026-11-22 — shared MAX_HOSTNAME_LENGTH / PLAIN_HOSTNAME_RE; a copy would break B2',
    'js/util/site-mode-parser.js → js/util/utils.js': 'approved 2026-11-22 — shared isValidHostnamePattern / MAX_HOSTNAME_LENGTH; a copy would break B2',
    'js/util/site-mode-parser.js → js/util/punycode.js': 'approved 2026-11-22 — one punycode converter for Allow-list hostnames; a copy would break B2/B15',
});

// ── Scan ──────────────────────────────────────────────────────────────────────
function rel(abs) { return path.relative(ROOT, abs).split(path.sep).join('/'); }

function tierOf(r) {
    const m = /^js\/(ui|workflow|core|util|data)\//.exec(r);
    return m ? { name: m[1], rank: TIER_CONFIG.TIERS[m[1]] } : null;
}

function importsOf(abs) {
    const src = fs.readFileSync(abs, 'utf8');
    let ast;
    try { ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', loc: true }); }
    catch { return []; }   // a classic script has no imports; step 1 already proves every file parses
    const out = [];
    for ( const node of ast.body ) {
        const isImport = node.type === 'ImportDeclaration';
        const isReExport = (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source;
        if ( !isImport && !isReExport ) { continue; }
        const spec = node.source.value;
        if ( spec.startsWith('.') === false ) { continue; }
        out.push({ target: rel(path.resolve(path.dirname(abs), spec)), line: node.loc.start.line });
    }
    return out;
}

function hasImports(r) { return fs.existsSync(path.join(ROOT, r)) && importsOf(path.join(ROOT, r)).length > 0; }

const failures = [];
const usedExceptions = new Set();
let tierImports = 0;
const files = listFiles(path.join(ROOT, 'js'), { exts: [ '.js', '.mjs' ], excludeDirs: [ 'generated' ] });

for ( const abs of files ) {
    const from = rel(abs);
    const fromTier = tierOf(from);
    if ( fromTier === null ) { continue; }
    for ( const { target, line } of importsOf(abs) ) {
        const where = `${from}:${line} → ${target}`;
        if ( TIER_CONFIG.EXECUTION_CONTEXT_DIRS.some(d => target.startsWith(d)) ) {
            failures.push(`${where}: a tier file imports execution-context code`);
            continue;
        }
        const toTier = tierOf(target);
        if ( toTier === null ) { continue; }
        tierImports += 1;
        if ( fromTier.name === 'data' && toTier.name === 'util' ) {
            if ( hasImports(target) ) { failures.push(`${where}: data/ may import only a util/ file that imports nothing`); }
            continue;
        }
        if ( toTier.rank < fromTier.rank ) {
            failures.push(`${where}: upward import (${fromTier.name}/ may not import ${toTier.name}/)`);
            continue;
        }
        if ( toTier.name === 'workflow' && from !== TIER_CONFIG.WORKFLOW_ENTRY ) {
            failures.push(`${where}: only ${TIER_CONFIG.WORKFLOW_ENTRY} may import a workflow/ file — move the shared code down to core/ or util/`);
            continue;
        }
        if ( fromTier.name === 'util' && target !== from ) {
            const key = `${from} → ${target}`;
            if ( UTIL_IMPORT_EXCEPTIONS[key] === undefined ) {
                failures.push(`${where}: util/ imports nothing inside the extension — an exception needs the owner's approval first (ARCHITECTURE.md)`);
            } else {
                usedExceptions.add(key);
                if ( hasImports(target) ) { failures.push(`${where}: listed exception, but the target now imports something (cycle risk)`); }
            }
            continue;
        }
    }
}
for ( const key of Object.keys(UTIL_IMPORT_EXCEPTIONS) ) {
    if ( usedExceptions.has(key) === false ) { failures.push(`stale exception: ${key} — the import no longer exists, remove it`); }
}

console.log(`Scanned ${files.length} files under js/: ${tierImports} imports between tier files, ${usedExceptions.size} listed util/ exceptions in use.`);
if ( failures.length > 0 ) {
    for ( const f of failures ) { console.error(`FAIL: ${f}`); }
    process.exit(1);
}
if ( tierImports < TIER_CONFIG.MIN_TIER_IMPORTS ) {
    console.error(`DID NOT RUN properly: only ${tierImports} tier imports found, at least ${TIER_CONFIG.MIN_TIER_IMPORTS} expected.`);
    process.exit(2);
}
console.log('PASS: every import between tiers flows downward; no route file imports another.');
