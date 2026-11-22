/*******************************************************************************

    uBlock-Stripped-Dynamic — browser.scripting call-site finder (AST-based)

    Shared by tools/check-scripting-site-mode-gating.mjs (step 14, C25) and
    tools/check-scripting-batch-calls.mjs (step 31). Both used to find call
    sites by text matching, with their own copies of a line-based
    `function name(` lookup (B15 drift), which:
      - could not see arrow functions, function expressions or methods, and
        worse, silently attributed such a call to whatever `function` line
        came BEFORE it — so an ungated call could pass as an already-
        classified function (step 14);
      - recognised only `for (` loops, counted braces inside strings and
        comments, and scanned one hard-coded file (step 31).
    A Semgrep cross-check (step 29) had been added for the first gap, but
    Semgrep was never installed, so it never ran (principle C38); it was
    removed when this parser-based helper closed the gap in the checks that
    always run.

    scanScriptingCallSites(sourceText) →
        [ { method, line, enclosingFunction, insideLoop } ]
      method            — 'registerContentScripts' | 'updateContentScripts' |
                          'executeScript'
      enclosingFunction — name of the nearest NAMED function around the call
                          (see functionName() for what counts as a name), or
                          null at module top level. An anonymous callback is
                          skipped over to its named container, the same
                          meaning the old text lookup had for such callbacks.
      insideLoop        — true if, WITHIN that named function, the call sits
                          in a for / for-of / for-in / while / do-while loop
                          or in a callback of an array iteration method
                          (forEach, map, …).
    Throws on a file that cannot be parsed — callers report that as
    DID NOT RUN (principle C38), never as "no call sites".

*******************************************************************************/

import * as espree from 'espree';

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', loc: true };
// The browser.scripting methods these checks care about.
export const SCRIPTING_METHODS = Object.freeze([ 'registerContentScripts', 'updateContentScripts', 'executeScript' ]);
const SCRIPTING_ROOTS = new Set([ 'browser', 'chrome' ]);
const LOOP_TYPES = new Set([ 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement' ]);
// A callback passed to one of these runs once per item — a loop in effect.
const ITERATION_METHODS = new Set([ 'forEach', 'map', 'flatMap', 'filter', 'reduce', 'some', 'every', 'find' ]);
const FUNCTION_TYPES = new Set([ 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression' ]);

function unwrapChain(node) { return node?.type === 'ChainExpression' ? node.expression : node; }

function propertyName(node) {
    if ( node?.type === 'Identifier' ) { return node.name; }
    if ( node?.type === 'Literal' && typeof node.value === 'string' ) { return node.value; }
    return null;
}

// browser.scripting.<method>( … ) or chrome.scripting.<method>( … ),
// optional chaining included.
function scriptingMethodOf(call) {
    const callee = unwrapChain(call.callee);
    if ( callee?.type !== 'MemberExpression' ) { return null; }
    const method = propertyName(callee.property);
    if ( SCRIPTING_METHODS.includes(method) === false ) { return null; }
    const owner = unwrapChain(callee.object);
    if ( owner?.type !== 'MemberExpression' || propertyName(owner.property) !== 'scripting' ) { return null; }
    const root = unwrapChain(owner.object);
    return root?.type === 'Identifier' && SCRIPTING_ROOTS.has(root.name) ? method : null;
}

// The name a function is known by: its own id, the variable / property /
// method / assignment target it is bound to. null for a truly anonymous
// function (e.g. a callback argument).
function functionName(fn, parent) {
    if ( fn.id?.name ) { return fn.id.name; }
    if ( parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ) { return parent.id.name; }
    if ( (parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && parent.value === fn ) {
        return propertyName(parent.key);
    }
    if ( parent?.type === 'AssignmentExpression' && parent.right === fn ) {
        const left = parent.left;
        if ( left.type === 'Identifier' ) { return left.name; }
        if ( left.type === 'MemberExpression' ) { return propertyName(left.property); }
    }
    return null;
}

function isIterationCallback(fn, parent) {
    if ( parent?.type !== 'CallExpression' || parent.arguments.includes(fn) === false ) { return false; }
    const callee = unwrapChain(parent.callee);
    return callee?.type === 'MemberExpression' && ITERATION_METHODS.has(propertyName(callee.property));
}

export function scanScriptingCallSites(sourceText) {
    const ast = espree.parse(sourceText, PARSE_OPTIONS);
    const found = [];
    // ancestors: [ { node, parent } ] from the root down to the current node.
    function visit(node, parent, ancestors) {
        if ( node === null || typeof node !== 'object' || typeof node.type !== 'string' ) { return; }
        if ( node.type === 'CallExpression' ) {
            const method = scriptingMethodOf(node);
            if ( method !== null ) { found.push(describe(method, node, ancestors)); }
        }
        const next = [ ...ancestors, { node, parent } ];
        for ( const key of Object.keys(node) ) {
            if ( key === 'loc' || key === 'range' ) { continue; }
            const child = node[key];
            if ( Array.isArray(child) ) { for ( const c of child ) { visit(c, node, next); } }
            else if ( child && typeof child === 'object' ) { visit(child, node, next); }
        }
    }
    function describe(method, call, ancestors) {
        let enclosingFunction = null;
        let insideLoop = false;
        // Walk outward until the nearest NAMED function; loops (and
        // iteration callbacks) seen on the way count as "inside a loop".
        for ( let i = ancestors.length - 1; i >= 0; i-- ) {
            const { node, parent } = ancestors[i];
            if ( LOOP_TYPES.has(node.type) ) { insideLoop = true; }
            if ( FUNCTION_TYPES.has(node.type) ) {
                const name = functionName(node, parent);
                if ( name !== null ) { enclosingFunction = name; break; }
                if ( isIterationCallback(node, parent) ) { insideLoop = true; }
            }
        }
        return { method, line: call.loc.start.line, enclosingFunction, insideLoop };
    }
    visit(ast, null, []);
    return found;
}
