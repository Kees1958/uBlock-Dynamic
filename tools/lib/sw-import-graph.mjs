// tools/lib/sw-import-graph.mjs — the service worker's real STATIC import graph, parsed.
//
// Shared by tools/check-sw-no-dynamic-import.mjs (C33) and tools/check-silent-catch.mjs (C5/C25),
// so both checks walk exactly the same set of modules (B15: one copy, not two that drift).
//
// Public interface:
//   walkAst(node)                 — generator over every AST node (skips loc/range)
//   loadServiceWorkerGraph(root)  — { entry, modules: [ { file, rel, source, ast } ] }; throws a
//                                   GraphError (callers report it as DID NOT RUN, C38) when the
//                                   manifest, a module or the parse fails, or the graph is implausibly small
import fs from 'fs';
import path from 'path';
import * as espree from 'espree';

// ecmaVersion 'latest' so every syntax the extension may use parses; comments kept for the checks
// that look for a reason comment next to a construct.
const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', loc: true, comment: true };
// Minimum plausible graph size — a walk reaching fewer modules than this did not really walk the
// service worker (a resolution bug, a moved entry), and must not be reported as a pass.
const MIN_EXPECTED_MODULES = 10;

export class GraphError extends Error {}

export function* walkAst(node) {
    if ( node === null || typeof node !== 'object' ) { return; }
    if ( typeof node.type === 'string' ) { yield node; }
    for ( const key of Object.keys(node) ) {
        if ( key === 'loc' || key === 'range' || key === 'comments' ) { continue; }
        const child = node[key];
        if ( Array.isArray(child) ) { for ( const c of child ) { yield* walkAst(c); } }
        else if ( child !== null && typeof child === 'object' ) { yield* walkAst(child); }
    }
}

export function loadServiceWorkerGraph(root) {
    let entry;
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
        entry = path.join(root, manifest.background.service_worker.replace(/^\//, ''));
    } catch (err) {
        throw new GraphError(`cannot read background.service_worker from manifest.json (${err.message})`);
    }
    const visited = new Set();
    const modules = [];
    const queue = [ entry ];
    while ( queue.length !== 0 ) {
        const file = queue.shift();
        if ( visited.has(file) ) { continue; }
        visited.add(file);
        let source, ast;
        try {
            source = fs.readFileSync(file, 'utf8');
            ast = espree.parse(source, PARSE_OPTIONS);
        } catch (err) {
            throw new GraphError(`cannot read or parse ${path.relative(root, file)} (${err.message})`);
        }
        modules.push({ file, rel: path.relative(root, file), source, ast });
        for ( const node of walkAst(ast) ) {
            // Static edges: import … from, export … from, export * from.
            const isStaticEdge = node.type === 'ImportDeclaration'
                || ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source);
            if ( isStaticEdge && typeof node.source.value === 'string' && node.source.value.startsWith('.') ) {
                queue.push(path.resolve(path.dirname(file), node.source.value));
            }
        }
    }
    if ( modules.length < MIN_EXPECTED_MODULES ) {
        throw new GraphError(`only ${modules.length} module(s) reached from ${path.relative(root, entry)} — expected at least ${MIN_EXPECTED_MODULES}; the graph walk did not work`);
    }
    return { entry: path.relative(root, entry), modules };
}
