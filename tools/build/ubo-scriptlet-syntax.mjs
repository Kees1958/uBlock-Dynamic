// ── tools/build/ubo-scriptlet-syntax.mjs ──────────────────────────────────────────
// (2026-11-09, audit of 10.6.4) Converts uBlock Origin scriptlet lines into the AdGuard form the build parses.
//
// Why: the build's scriptlet parser only reads AdGuard syntax (`site#%#//scriptlet('name', …)`). A uBO line
// `site##+js(name, …)` was therefore read by the COSMETIC parser as a hide rule with the selector "+js(…)". The
// extension joins every selector of a site into one CSS rule, and one invalid selector makes the browser drop the
// whole rule — so those lines silently disabled ALL hide rules of their sites (found in the shipped 10.6.4:
// Bulgarian, Latvian and Nordic lists, ~50 lines). Converting them makes them run as the scriptlets they are.
//
// The conversion is AdGuard's own uBO-compatibility convention: uBO name `x` becomes `ubo-x` (the bundled AdGuard
// scriptlet library registers every uBO name under that alias, e.g. `ubo-acs`, `ubo-set`). Every gate still applies
// afterwards: the trust gate already ran per source at download (fetch-helpers.mjs matches `##+js(` too), and the
// scriptlet policy (rules D, B, C) and the geographic scope run on the parsed result like for any AdGuard line.
//
//   site##+js(name, a, b)   ->  site#%#//scriptlet('ubo-name', 'a', 'b')
//   site#@#+js(name, a)     ->  site#@#//scriptlet('ubo-name', 'a')       (this project's exception form)
//   site#@#+js()            ->  site#@#//scriptlet()                       (wildcard exception)
//
// A line that cannot be converted faithfully is DROPPED and counted (never passed on to the cosmetic parser):
// an argument holding both quote characters, which the AdGuard parser (no escape support) cannot carry.
//
// Public interface: convertUboScriptletSyntax(text) -> { text, converted, dropped }; parseUboScriptletLine(line);
//                   formatAdguardScriptletLine(hosts, name, args)
// Pure function — nothing to initialise, clear or release.

// ── CONFIG ────────────────────────────────────────────────────────────────────
const UBO_SYNTAX_CONFIG = Object.freeze({
    // host part, optional "@" (exception), then the call body up to the LAST ")" of the line.
    LINE_RE: /^([^#]*)#(@?)#\+js\((.*)\)\s*$/,
    ALIAS_PREFIX: 'ubo-',                 // AdGuard's alias prefix for uBO scriptlet names
    QUOTES: Object.freeze([ "'", '"', '`' ]),   // uBO accepts quoted arguments with any of these
    OUTPUT_QUOTES: Object.freeze([ "'", '"' ]), // what the build's AdGuard parser reads
});

// Splits uBO arguments: separated by commas; `\,` is a literal comma; a token wrapped in matching quotes keeps its
// commas and loses the quotes.
function splitUboArgs(body) {
    const out = [];
    let i = 0;
    while ( i <= body.length ) {
        while ( body[i] === ' ' ) { i++; }
        const q = UBO_SYNTAX_CONFIG.QUOTES.find(c => body[i] === c);
        if ( q !== undefined ) {
            const end = body.indexOf(q, i + 1);
            const after = end === -1 ? -1 : body.slice(end + 1).search(/\S/);
            if ( end !== -1 && (after === -1 || body[end + 1 + after] === ',') ) {
                out.push(body.slice(i + 1, end));
                const comma = body.indexOf(',', end + 1);
                if ( comma === -1 ) { break; }
                i = comma + 1;
                continue;
            }
        }
        let token = '';
        while ( i < body.length ) {
            if ( body[i] === '\\' && body[i + 1] === ',' ) { token += ','; i += 2; continue; }
            if ( body[i] === ',' ) { break; }
            token += body[i++];
        }
        out.push(token.trim());
        if ( i >= body.length ) { break; }
        i++;   // skip the comma
    }
    return out;
}

function quoteArg(arg) {
    const q = UBO_SYNTAX_CONFIG.OUTPUT_QUOTES.find(c => arg.includes(c) === false);
    return q === undefined ? null : `${q}${arg}${q}`;
}

// (11.1.3) One uBO scriptlet line taken apart: { hosts, exception, name, args }, or null when the line is not a uBO
// scriptlet call (or is an empty wildcard exception). Same LINE_RE and argument splitting as the conversion below.
export function parseUboScriptletLine(line) {
    const m = UBO_SYNTAX_CONFIG.LINE_RE.exec(String(line).trim());
    if ( m === null || m[3].trim() === '' ) { return null; }
    const [ name, ...args ] = splitUboArgs(m[3]);
    if ( name === '' ) { return null; }
    return { hosts: m[1], exception: m[2] === '@', name, args };
}

// (11.1.3) Writes one rule in the AdGuard form the build parses (`hosts#%#//scriptlet('name', 'a')`), with the same
// quoting as the conversion below. null when an argument cannot be carried (it holds both quote characters).
export function formatAdguardScriptletLine(hosts, name, args) {
    const quoted = [ name, ...args ].map(quoteArg);
    return quoted.includes(null) ? null : `${hosts}#%#//scriptlet(${quoted.join(', ')})`;
}

export function convertUboScriptletSyntax(text) {
    let converted = 0;
    let dropped = 0;
    const out = [];
    for ( const line of text.split('\n') ) {
        const m = UBO_SYNTAX_CONFIG.LINE_RE.exec(line.trim());
        if ( m === null ) { out.push(line); continue; }
        const [ , hosts, at, body ] = m;
        const marker = at === '@' ? '#@#//scriptlet(' : '#%#//scriptlet(';
        if ( body.trim() === '' ) {                      // `#@#+js()` wildcard exception (an empty call runs nothing)
            if ( at === '@' ) { out.push(`${hosts}${marker})`); converted++; } else { dropped++; }
            continue;
        }
        const [ rawName, ...args ] = splitUboArgs(body);
        const name = rawName.startsWith(UBO_SYNTAX_CONFIG.ALIAS_PREFIX) ? rawName : `${UBO_SYNTAX_CONFIG.ALIAS_PREFIX}${rawName}`;
        const quoted = [ name, ...args ].map(quoteArg);
        if ( rawName === '' || quoted.includes(null) ) { dropped++; continue; }
        out.push(`${hosts}${marker}${quoted.join(', ')})`);
        converted++;
    }
    return { text: out.join('\n'), converted, dropped };
}
