// tools/check-sw-no-dynamic-import.mjs — principle C33 (HARD check).
//
// The HTML specification disallows dynamic import() in a service worker,
// in every browser: it throws, every time. This project already shipped
// that bug once (js/core/tracker-radar-lookup.js's own header): the
// Tracker Radar dataset never loaded on any install, and a .catch() hid
// it. This check walks the service worker's real STATIC import graph from
// the manifest's background.service_worker entry, parses every module in
// it with a real JavaScript parser (espree — the parser ESLint itself
// uses), and fails on any ImportExpression node. A parser, not a text
// search, so the word "import(" in comments and strings (that header
// quotes it several times) is never a false hit.
//
// Outcomes (principle C38): PASS / FINDINGS (fails) / DID NOT RUN (fails —
// e.g. the entry file cannot be read or a module cannot be parsed).
import path from 'path';
import { loadServiceWorkerGraph, walkAst, GraphError } from './lib/sw-import-graph.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

console.log('=== C33: no dynamic import() in the service worker import graph ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

// The graph walk itself lives in tools/lib/sw-import-graph.mjs (shared with check-silent-catch.mjs, B15).
let graph;
try {
    graph = loadServiceWorkerGraph(ROOT);
} catch (err) {
    if ( err instanceof GraphError ) { didNotRun(err.message); }
    throw err;
}

const findings = [];
for ( const { rel, ast } of graph.modules ) {
    for ( const node of walkAst(ast) ) {
        if ( node.type === 'ImportExpression' ) {
            findings.push(`${rel}:${node.loc.start.line}`);
        }
    }
}

console.log(`Scanned ${graph.modules.length} modules reachable from ${graph.entry}.`);
if ( findings.length !== 0 ) {
    console.log(`FAIL: dynamic import() in the service worker graph (always throws there — C33):\n  ${findings.join('\n  ')}`);
    console.log('Lazy data belongs in a fetch(browser.runtime.getURL(...)) of JSON, the pattern tracker-radar-lookup.js uses.');
    process.exit(1);
}
console.log('PASS: no dynamic import() anywhere in the service worker graph.');
