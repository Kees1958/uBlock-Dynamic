// tools/check-silent-catch.mjs — principle C5 + C25 (HARD check, 10.7.6).
//
// Why this exists: silently swallowed errors in service-worker code have now been found and fixed in three
// separate audits (9.7.5, 10.6.4, 10.7.5) — the C25 threshold for a standing check. The 10.7.5 instance hid
// a failed ABP-import compile completely: the dashboard looked successful while the old rules stayed active.
//
// Rule enforced, for every module in the service worker's real static import graph:
//   1. A `.catch(handler)` whose handler ignores the error — empty body, or just returns a constant
//      (undefined/null/false/[]/{}) — is a FINDING. Use catchExpected() from js/data/expected-errors.js,
//      which drops only the declared expected error classes (tab gone, script not registered) and logs
//      everything else.
//   2. An empty `catch { }` block is a FINDING unless its own line (or a line inside the block) carries a
//      `// benign: <reason>` comment — reserved for local parsing such as `new URL()`, where the fallback
//      value IS the handling.
//   3. A raw promise-chain lock `x = x.then(...)` is a FINDING: one rejected step leaves the chain rejected
//      and every later step is skipped until the service worker restarts (found 10.7.5 in compiled-filters.js,
//      config.js and filter-manager.js ×2). Use createLock() from js/util/async-lock.js.
//
// Outcomes (principle C38): PASS / FINDINGS (fails) / DID NOT RUN (fails).
import path from 'path';
import { loadServiceWorkerGraph, walkAst, GraphError } from './lib/sw-import-graph.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
// The marker a reviewed empty catch block must carry.
const BENIGN_MARKER = /(?:\/\/|\/\*)\s*benign:/;   // "// benign: …" or, on a one-line catch, "/* benign: … */"
// Expression bodies that count as "the error is ignored" in a .catch(() => <expr>) handler.
const CONSTANT_RETURN_TYPES = new Set([ 'Literal', 'ArrayExpression', 'ObjectExpression' ]);

console.log('=== C5/C25: no silently swallowed errors or raw promise-chain locks in the service worker graph ===');

function didNotRun(reason) {
    console.log(`DID NOT RUN: ${reason}`);
    console.log('A check that did not run has not passed.');
    process.exit(1);
}

function isIgnoringHandler(fn) {
    if ( fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression' ) { return false; }
    const body = fn.body;
    if ( body.type === 'BlockStatement' ) { return body.body.length === 0; }
    if ( CONSTANT_RETURN_TYPES.has(body.type) ) {
        // [] / {} only when empty; any Literal (null/false/0/'') is a constant.
        if ( body.type === 'ArrayExpression' ) { return body.elements.length === 0; }
        if ( body.type === 'ObjectExpression' ) { return body.properties.length === 0; }
        return true;
    }
    return body.type === 'Identifier' && body.name === 'undefined';
}

function hasBenignMarker(source, startLine, endLine) {
    const lines = source.split('\n');
    for ( let i = startLine - 1; i <= endLine - 1 && i < lines.length; i++ ) {
        if ( BENIGN_MARKER.test(lines[i]) ) { return true; }
    }
    return false;
}

let graph;
try {
    graph = loadServiceWorkerGraph(ROOT);
} catch (err) {
    if ( err instanceof GraphError ) { didNotRun(err.message); }
    throw err;
}

const findings = [];
let catchCallsSeen = 0;
for ( const { rel, source, ast } of graph.modules ) {
    for ( const node of walkAst(ast) ) {
        if ( node.type === 'CallExpression'
            && node.callee?.type === 'MemberExpression'
            && node.callee.property?.name === 'catch' ) {
            catchCallsSeen += 1;
            if ( isIgnoringHandler(node.arguments[0]) ) {
                findings.push(`${rel}:${node.loc.start.line} — .catch() handler ignores the error (use catchExpected())`);
            }
        }
        if ( node.type === 'AssignmentExpression'
            && node.left.type === 'Identifier'
            && node.right.type === 'CallExpression'
            && node.right.callee?.type === 'MemberExpression'
            && node.right.callee.property?.name === 'then'
            && node.right.callee.object?.type === 'Identifier'
            && node.right.callee.object.name === node.left.name ) {
            findings.push(`${rel}:${node.loc.start.line} — raw promise-chain lock "${node.left.name} = ${node.left.name}.then(…)" (use createLock())`);
        }
        if ( node.type === 'CatchClause' && node.body.body.length === 0 ) {
            if ( hasBenignMarker(source, node.loc.start.line, node.loc.end.line) === false ) {
                findings.push(`${rel}:${node.loc.start.line} — empty catch {} without a "// benign: <reason>" comment`);
            }
        }
    }
}

console.log(`Scanned ${graph.modules.length} modules reachable from ${graph.entry} (${catchCallsSeen} .catch() calls).`);
if ( catchCallsSeen === 0 ) {
    didNotRun('no .catch() call found at all — the AST walk is not seeing the code');
}
if ( findings.length !== 0 ) {
    console.log(`FAIL: ${findings.length} silently swallowed error(s):\n  ${findings.join('\n  ')}`);
    process.exit(1);
}
console.log('PASS: every swallowed error is a declared expected class (catchExpected) or a reviewed "// benign:" parse fallback, and no raw promise-chain lock is left.');
