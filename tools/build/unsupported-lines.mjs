// ── tools/build/unsupported-lines.mjs ─────────────────────────────────────────────────
// Classifies a list line this build cannot use, so a list the owner writes by hand (the Quick-fixes list) never
// loses a line without a trace. Pure functions: no state, nothing to initialise or release.
//
// A line is "unsupported" when it has a recognisable list syntax that this build does not implement (raw-JavaScript
// rules, CSS injection, procedural cosmetic filters, HTML filtering) or when it looks like a network rule but cannot be
// compiled into a declarativeNetRequest rule (modifiers such as $replace/$csp/$redirect, invalid pattern). Lines the
// build does handle (comments, hide rules, #%#//scriptlet(...) calls and their exceptions, $removeparam) are not
// reported; an unknown scriptlet NAME is reported by the scriptlet step of the build, not here.
//
// Public interface:
//   UNSUPPORTED_LINES_CONFIG        — every constant of this module, one place
//   classifyUnsupportedSyntax(line) — reason string if the line uses a syntax this build never implements, else null
//   describeUncompilableNetworkLine(line) — reason string for a network-shaped line that produced no rule
//   isHandledElsewhere(line)        — true for lines other parsers of the build consume (comments, cosmetic, scriptlet, removeparam)
// Dependencies: none.

export const UNSUPPORTED_LINES_CONFIG = Object.freeze({
    // Report file written to the tools root by the build (same convention as the other dropped-*.txt reports).
    REPORT_FILE: 'dropped-unsupported-list-lines.txt',
    // Separators of syntaxes this build does not implement. Longest first, so '#@%#' is not read as '#%#'.
    UNSUPPORTED_SEPARATORS: Object.freeze([
        [ '#@%#', 'raw JavaScript exception rule (only #@#//scriptlet(...) exceptions are supported)' ],
        [ '#$?#', 'CSS-injection with procedural selector (not supported)' ],
        [ '#@$#', 'CSS-injection exception (not supported)' ],
        [ '#@?#', 'procedural cosmetic exception (not supported)' ],
        [ '#?#',  'procedural cosmetic filter (not supported)' ],
        [ '#$#',  'CSS-injection rule (not supported)' ],
        [ '$@$',  'HTML-filtering exception (not supported)' ],
        [ '$$',   'HTML-filtering rule (not supported)' ],
    ]),
    RAW_JS_SEPARATOR:  '#%#',
    SCRIPTLET_CALL:    '//scriptlet(',
    RAW_JS_REASON:     'raw JavaScript rule (only #%#//scriptlet(\'name\', ...) calls are supported; write the behaviour as a named scriptlet)',
    COMMENT_PREFIXES:  Object.freeze([ '!', '[', '# ' ]),
    // Network-rule modifiers that have no declarativeNetRequest equivalent here; named in the reason when present.
    UNSUPPORTED_MODIFIERS: Object.freeze([ 'replace', 'csp', 'redirect', 'redirect-rule', 'jsonprune', 'hls', 'permissions', 'cookie', 'urltransform' ]),
    GENERIC_NETWORK_REASON: 'could not be compiled into a network rule (unsupported modifier or invalid pattern)',
});

export function isHandledElsewhere(line) {
    const L = UNSUPPORTED_LINES_CONFIG;
    const t = line.trim();
    if ( t === '' || L.COMMENT_PREFIXES.some(p => t.startsWith(p)) || t === '#' ) { return true; }
    // Cosmetic hide / hide-exception and scriptlet calls / exceptions are parsed by their own parsers.
    if ( t.includes('##') && t.includes('#$#') === false && t.includes('#?#') === false ) { return true; }
    if ( t.includes('#@#') && t.includes('#@$#') === false && t.includes('#@?#') === false ) { return true; }
    if ( t.includes(L.RAW_JS_SEPARATOR + L.SCRIPTLET_CALL) ) { return true; }
    // $removeparam=<name> is consumed by parseRemoveparamRules() (a regex value is skipped there on purpose).
    if ( /removeparam=[^/]/.test(t) ) { return true; }
    return false;
}

export function classifyUnsupportedSyntax(line) {
    const L = UNSUPPORTED_LINES_CONFIG;
    const t = line.trim();
    if ( t === '' || L.COMMENT_PREFIXES.some(p => t.startsWith(p)) ) { return null; }
    for ( const [ sep, reason ] of L.UNSUPPORTED_SEPARATORS ) {
        if ( t.includes(sep) ) { return reason; }
    }
    if ( t.includes(L.RAW_JS_SEPARATOR) && t.includes(L.RAW_JS_SEPARATOR + L.SCRIPTLET_CALL) === false ) { return L.RAW_JS_REASON; }
    return null;
}

export function describeUncompilableNetworkLine(line) {
    const L = UNSUPPORTED_LINES_CONFIG;
    const dollar = line.lastIndexOf('$');
    if ( dollar > 0 ) {
        const names = line.slice(dollar + 1).split(',').map(o => o.replace(/^~/, '').split('=')[0].trim());
        const hit = names.filter(n => L.UNSUPPORTED_MODIFIERS.includes(n));
        if ( hit.length !== 0 ) { return `network rule with unsupported modifier $${hit.join(', $')} (no declarativeNetRequest equivalent)`; }
    }
    return `network rule ${L.GENERIC_NETWORK_REASON}`;
}
