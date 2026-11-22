#!/usr/bin/env node
// check-scripting-batch-calls.mjs — guards against the recurring bug class
// documented in ARCHITECTURE.md's "HARD CONSTRAINT — batch browser.scripting
// (un)registration, never one call per directive": a `for` loop that calls
// browser.scripting.registerContentScripts()/updateContentScripts() ONCE PER
// DIRECTIVE instead of batching the whole wanted-directives array into at
// most one call of each. Found independently, in this exact shape, THREE
// times in js/core/scripting-manager.js (scriptlet, cosmetic, security
// registration) before being consolidated into the shared
// registerOrUpdateContentScripts() helper — see that function's own header
// comment and ARCHITECTURE.md for the full history.
//
// How it scans (rewritten in the audit after 9.7.5): each file is PARSED
// (tools/lib/scripting-call-sites.mjs, shared with step 14) instead of
// scanned line by line. The old line scanner recognised only `for (`
// loops, counted braces inside strings/regexes/comments, and scanned one
// hard-coded file — so a `.forEach(d => browser.scripting.register…)`
// loop, or the same shape in any other file, passed unseen. Now: every
// file under js/, and "inside a loop" means a for / for-of / for-in /
// while / do-while loop or an array-iteration callback (forEach, map, …)
// within the call's own named function.
//
// A per-item registerContentScripts()/updateContentScripts() call inside
// a loop, in any function other than ALLOWED_FUNCTION, fails this check.
// A registration function that handles a single, non-looped directive is
// not flagged — the "N calls instead of one" shape needs the loop.
//
// Usage: node tools/check-scripting-batch-calls.mjs   (also runs as a step
// of `npm run check` / tools/complete-check.mjs)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listFiles } from './lib/walk.mjs';
import { scanScriptingCallSites } from './lib/scripting-call-sites.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const isMainModule = process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

// Files scanned for this pattern. Currently only scripting-manager.js owns
// any browser.scripting.registerContentScripts()/updateContentScripts()
// call sites in this codebase — add a path here if a future file gains one.
// The one function allowed to contain a per-item registerContentScripts()/
// updateContentScripts() call inside a loop — its own documented fallback
// path when a batched call is rejected. Every other *ContentScriptsImpl()
// function must route through it instead of looping itself.
const ALLOWED_FUNCTION = 'registerOrUpdateContentScripts';
// Only registration batching matters here — executeScript is one-shot.
const BATCHED_METHODS = new Set([ 'registerContentScripts', 'updateContentScripts' ]);

function run() {
    const files = listFiles(path.join(ROOT, 'js'), { exts: [ '.js', '.mjs' ], excludeDirs: [ 'lib', 'generated' ] });
    if ( files.length === 0 ) {
        console.error('DID NOT RUN: no files found under js/ — the scan covered nothing.');
        return false;
    }
    const violations = [];
    for ( const file of files ) {
        const relPath = path.relative(ROOT, file).split(path.sep).join('/');
        let sites;
        try {
            sites = scanScriptingCallSites(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            // Not scanned is not "no violations" (principle C38).
            console.error(`DID NOT RUN: cannot parse ${relPath} (${err.message}). A check that did not run has not passed.`);
            return false;
        }
        for ( const s of sites ) {
            if ( BATCHED_METHODS.has(s.method) && s.insideLoop && s.enclosingFunction !== ALLOWED_FUNCTION ) {
                violations.push(`${relPath}:${s.line} — ${s.method}() inside a loop in ${s.enclosingFunction ?? '(module top level)'}()`);
            }
        }
    }
    for ( const v of violations ) {
        console.error(`VIOLATION: ${v} — per-item browser.scripting call.`);
    }
    if ( violations.length > 0 ) {
        console.error(
            `\n${violations.length} violation(s) of the batch-registration ` +
            `HARD CONSTRAINT (see ARCHITECTURE.md). Route through ` +
            `${ALLOWED_FUNCTION}() instead of a per-directive loop.`
        );
        return false;
    }
    console.log(`OK: no per-item browser.scripting loops found outside ${ALLOWED_FUNCTION}() (${files.length} file(s) scanned).`);
    return true;
}

if ( isMainModule ) {
    const ok = run();
    process.exit(ok ? 0 : 1);
}

export { run };
