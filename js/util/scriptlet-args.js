/*
 * scriptlet-args.js — (11.1.6) THE reader and writer of scriptlet-call arguments, for both rule syntaxes.
 *
 * Why: there were three readers — two copies in the build (tools/build/scriptlet-rules.mjs: rules and exceptions) and a
 * simplified one for the user's own rules (js/core/custom-scriptlets.js) — and none understood AdGuard's escaped quote.
 * `'img[onerror="this.src=\',\'"]'` ended at the `\'`, the rest became extra arguments (scriptlet audit 11.1.6,
 * finding 3: 7 shipped rules ran with a cut-off argument). The uBO→AdGuard conversion had to DROP every uBO argument
 * holding both quote characters, because nothing could read them back. One reader and one writer now, used by the build
 * and by the user's rules alike (B15).
 *
 * AdGuard syntax  `'a', "b"` — each argument in ' or ". Inside, a backslash before THAT quote character is the quote
 *                  itself (AdGuard's own reading); a doubled backslash stays a pair (so `\\'` still closes the argument, as
 *                  AdGuard counts backslashes); every other backslash is kept (regex text). An unquoted token is read
 *                  up to the next comma and trimmed (tolerated, as the user's rules always were).
 * uBO syntax      `a, b\,c, 'd,e'` — moved here unchanged from tools/build/ubo-scriptlet-syntax.mjs: commas separate,
 *                  `\,` is a literal comma, a token wrapped in matching ' " or ` keeps its commas and loses the quotes.
 *
 * Public interface:
 *   splitAdguardScriptletArgs(callContent) — [ name, ...args ] from the text between `scriptlet(` and `)`
 *   splitUboScriptletArgs(body)            — [ name, ...args ] from the text between `+js(` and `)`
 *   quoteAdguardScriptletArg(arg)          — one argument written so splitAdguardScriptletArgs reads it back exactly,
 *                                            or null when no AdGuard spelling can carry it
 * Pure functions, no imports — nothing to initialise, clear or release.
 */

// ── Declared constants ────────────────────────────────────────────────────────
const SCRIPTLET_ARGS = Object.freeze({
    ADGUARD_QUOTES:   Object.freeze([ "'", '"' ]),        // what AdGuard syntax quotes with
    PREFERRED_QUOTE:  "'",                                 // the writer's choice when it must escape
    UBO_QUOTES:       Object.freeze([ "'", '"', '`' ]),   // uBO accepts quoted arguments with any of these
    ESCAPE:           '\\',
    SEPARATOR:        ',',
    BLANK:            ' ',
});

export function splitAdguardScriptletArgs(callContent) {
    const C = SCRIPTLET_ARGS;
    const text = String(callContent);
    const args = [];
    let i = 0;
    while ( i < text.length ) {
        const ch = text[i];
        if ( ch === C.SEPARATOR || ch === C.BLANK ) { i++; continue; }
        if ( C.ADGUARD_QUOTES.includes(ch) ) {
            const q = ch;
            let value = '';
            i++;
            while ( i < text.length ) {
                if ( text[i] === C.ESCAPE && text[i + 1] === C.ESCAPE ) { value += C.ESCAPE + C.ESCAPE; i += 2; continue; }   // \\ kept as is
                if ( text[i] === C.ESCAPE && text[i + 1] === C.ESCAPE ) { value += C.ESCAPE + C.ESCAPE; i += 2; continue; }   // \\ kept as a pair
                if ( text[i] === C.ESCAPE && text[i + 1] === q ) { value += q; i += 2; continue; }   // \' inside '…'
                if ( text[i] === q ) { i++; break; }
                value += text[i++];
            }
            args.push(value);
            continue;
        }
        let token = '';                                    // unquoted: up to the next comma
        while ( i < text.length && text[i] !== C.SEPARATOR ) { token += text[i++]; }
        args.push(token.trim());
    }
    return args;
}

export function splitUboScriptletArgs(body) {
    const C = SCRIPTLET_ARGS;
    const text = String(body);
    const out = [];
    let i = 0;
    while ( i <= text.length ) {
        while ( text[i] === C.BLANK ) { i++; }
        const q = C.UBO_QUOTES.find(c => text[i] === c);
        if ( q !== undefined ) {
            const end = text.indexOf(q, i + 1);
            const after = end === -1 ? -1 : text.slice(end + 1).search(/\S/);
            if ( end !== -1 && (after === -1 || text[end + 1 + after] === C.SEPARATOR) ) {
                out.push(text.slice(i + 1, end));
                const comma = text.indexOf(C.SEPARATOR, end + 1);
                if ( comma === -1 ) { break; }
                i = comma + 1;
                continue;
            }
        }
        let token = '';
        while ( i < text.length ) {
            if ( text[i] === C.ESCAPE && text[i + 1] === C.SEPARATOR ) { token += C.SEPARATOR; i += 2; continue; }
            if ( text[i] === C.SEPARATOR ) { break; }
            token += text[i++];
        }
        out.push(token.trim());
        if ( i >= text.length ) { break; }
        i++;   // skip the comma
    }
    return out;
}

// null when the value cannot be written unambiguously: it ends in an odd number of backslashes (the last one would
// escape the closing quote), or it needs an escaped quote right after a backslash.
export function quoteAdguardScriptletArg(arg) {
    const C = SCRIPTLET_ARGS;
    const text = String(arg);
    const trailing = text.length - text.replace(/\\+$/, '').length;
    if ( trailing % 2 === 1 ) { return null; }
    const free = C.ADGUARD_QUOTES.find(c => text.includes(c) === false);
    if ( free !== undefined ) { return `${free}${text}${free}`; }
    const q = C.PREFERRED_QUOTE;
    if ( text.includes(`${C.ESCAPE}${q}`) ) { return null; }
    return `${q}${text.split(q).join(`${C.ESCAPE}${q}`)}${q}`;   // both quotes present: escape the one used
}
