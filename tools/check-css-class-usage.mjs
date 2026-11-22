// New check (this session): CSS class cross-reference. Every class name
// assigned via `.className = '...'` in JS should have a matching CSS
// rule somewhere; every class-selector in CSS should appear in at least
// one JS/HTML file's class list. This is exactly the kind of check that
// would have caught the unclosed-comment bug from earlier in this
// session automatically (the swallowed .scriptlet-api-label rule would
// have shown up as "CSS class used in JS but with no matching rule",
// since the real rule was invisible to a parser once the comment ate it).
import fs from 'fs';
import path from 'path';
import { listFiles } from './lib/walk.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// Pairs a directory with the CSS file(s) that actually style it — this
// project has several independent page contexts, each with its own CSS,
// not one global stylesheet, so cross-checking dashboard/ against
// matrix-panel.css (for example) would be comparing unrelated things.
const scopes = [
    { name: 'dashboard', jsHtmlDirs: [ 'dashboard' ], cssFiles: [
        'dashboard/custom-rules.css', 'dashboard/dashboard.css', 'dashboard/dashboard-common.css',
        'dashboard/settings.css', 'dashboard/filtering-mode.css', 'dashboard/filter-editor.css', 'dashboard/develop.css',
        'css/default.css', 'css/common.css',
    ] },
    { name: 'matrix panel', jsHtmlDirs: [ 'matrix' ], cssFiles: [
        'matrix/matrix-panel.css',
        'css/default.css', 'css/common.css', 'css/panel-shared.css',
    ] },
];

function classesUsedInSource(files) {
    const used = new Set();
    const dynamicPrefixes = new Set();
    for ( const f of files ) {
        const src = fs.readFileSync(f, 'utf8');
        // .className = 'a b c'  /  .classList.add('x')  /  class="a b c" in HTML
        for ( const m of src.matchAll(/\.className\s*=\s*[`'"]([^`'"]+)[`'"]/g) ) {
            for ( const c of m[1].split(/\s+/) ) { if ( c ) { used.add(c); } }
        }
        for ( const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*[`'"]([^`'"]+)[`'"]/g) ) {
            used.add(m[1]);
        }
        for ( const m of src.matchAll(/\bclass="([^"]+)"/g) ) {
            for ( const c of m[1].split(/\s+/) ) { if ( c ) { used.add(c); } }
        }
        // Template-literal class names, e.g. `rule-action-dot-${rowAction}`
        // — can't statically resolve the interpolation to an exact class
        // name, so record the static PREFIX (text immediately before
        // ${) separately; matched against CSS-defined classes by
        // startsWith() below rather than exact match, since an exact
        // string compare would never match a real class like
        // rule-action-dot-block against the literal prefix
        // "rule-action-dot-" (which isn't itself a real class name).
        for ( const m of src.matchAll(/className\s*=\s*`([^`]*)\$\{/g) ) {
            const tokens = m[1].trim().split(/\s+/).filter(Boolean);
            const prefix = tokens[tokens.length - 1]; // the token directly touching ${...}
            if ( prefix ) { dynamicPrefixes.add(prefix); }
            for ( const c of tokens.slice(0, -1) ) { used.add(c); } // any earlier, complete static tokens on the same line
        }
    }
    return { used, dynamicPrefixes };
}

function classesDefinedInCSS(files) {
    const defined = new Map(); // class -> count of rules defining it
    for ( const f of files ) {
        if ( !fs.existsSync(path.join(ROOT, f)) ) { continue; }
        const css = fs.readFileSync(path.join(ROOT, f), 'utf8');
        // Strip comments first — a real CSS parser would never see class
        // names trapped inside a comment as live selectors, and this
        // check should match that, not just regex over raw text.
        const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        for ( const m of withoutComments.matchAll(/\.([a-zA-Z][\w-]*)/g) ) {
            defined.set(m[1], (defined.get(m[1]) ?? 0) + 1);
        }
    }
    return defined;
}

// Classes used purely as JS querySelector hooks (e.g. document.
// querySelectorAll('.ruleset-toggle')), with no visual styling of their
// own by design (a bare native <input type="checkbox"> here, styled only
// by the browser default) — legitimately have no CSS rule. Maintained
// explicitly, same reasoning as check-message-routing.mjs's
// BROADCAST_ONLY set: verified by hand once, not silently suppressed.
const JS_HOOK_ONLY_CLASSES = new Set([
    'ruleset-toggle', // dashboard/filter-manager-ui.js — marker class for querySelectorAll, not a style hook
]);

console.log('=== CSS class cross-reference check ===');
let ok = true;

for ( const scope of scopes ) {
    const jsHtmlFiles = scope.jsHtmlDirs.flatMap(d => listFiles(path.join(ROOT, d), { exts: [ '.js', '.html' ] }));
    const { used, dynamicPrefixes } = classesUsedInSource(jsHtmlFiles);
    const defined = classesDefinedInCSS(scope.cssFiles);

    const usedButNotDefined = [ ...used ].filter(c => {
        if ( defined.has(c) ) { return false; }
        if ( JS_HOOK_ONLY_CLASSES.has(c) ) { return false; }
        // Could still be covered by a dynamic-prefix class built at
        // runtime elsewhere in the same scope (e.g. this exact literal
        // token also happens to be a complete class on its own, AND some
        // other line builds it dynamically) — not applicable to most
        // entries, but cheap to check and avoids a spurious flag.
        return ![ ...dynamicPrefixes ].some(p => c.startsWith(p));
    });
    // Every dynamic-prefix token (e.g. "rule-action-dot-") should match
    // AT LEAST ONE real defined class by startsWith — if none do, the
    // whole dynamically-built family of classes has no CSS backing it at
    // all, which IS worth flagging same as any other missing class.
    const unmatchedDynamicPrefixes = [ ...dynamicPrefixes ].filter(p =>
        ![ ...defined.keys() ].some(c => c.startsWith(p))
    );
    // Defined-but-unused is much noisier to get right (pseudo-classes,
    // state classes like :hover targets, third-party-library class names)
    // — reported as informational only, not a failure.
    const definedButNotUsed = [ ...defined.keys() ].filter(c =>
        !used.has(c) && ![ ...dynamicPrefixes ].some(p => c.startsWith(p))
    );

    console.log(`\n${scope.name}: ${used.size} classes referenced in JS/HTML (+${dynamicPrefixes.size} dynamic-prefix families), ${defined.size} classes defined in CSS.`);
    if ( usedButNotDefined.length > 0 || unmatchedDynamicPrefixes.length > 0 ) {
        ok = false;
        if ( usedButNotDefined.length > 0 ) {
            console.log(`FAIL: classes used in JS/HTML with NO matching CSS rule: ${usedButNotDefined.join(', ')}`);
        }
        if ( unmatchedDynamicPrefixes.length > 0 ) {
            console.log(`FAIL: dynamically-built class families with NO matching CSS rule at all: ${unmatchedDynamicPrefixes.join(', ')}`);
        }
    } else {
        console.log('PASS: every class used in JS/HTML has a matching CSS rule.');
    }
    if ( definedButNotUsed.length > 0 ) {
        console.log(`INFO: CSS classes defined but not found referenced in JS/HTML (verify by hand — includes legitimate state/pseudo-selector-only classes): ${definedButNotUsed.slice(0, 15).join(', ')}${definedButNotUsed.length > 15 ? ` (+${definedButNotUsed.length - 15} more)` : ''}`);
    }
}

console.log('');
process.exitCode = ok ? 0 : 1;
