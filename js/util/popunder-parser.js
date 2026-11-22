// ── popunder-parser.js ────────────────────────────────────────────────────────
// The ONE parser for uBD's pop-up / pop-under configuration lines (10.7.2). Used by every channel, so they can never
// disagree about what such a line means (B15):
//   build   — tools/build/build-steps.mjs (Quick-fixes list → carrier rules)
//   runtime — js/core/custom-scriptlets.js (Import ABP editor: accept / comment out with a reason),
//             js/core/tab-under-guard.js (Import ABP editor text → entries),
//             js/core/compiled-filters.js (keeps these lines out of the network/cosmetic compiler)
//
// 1. "prevent-popunder" — uBD's own pseudo-scriptlet: a SETTING written in scriptlet form, never injected into a page.
//        example.com#%#//scriptlet('prevent-popunder', 'adnetwork.com')
//        example.com##+js(prevent-popunder, adnetwork.com)
//    Several sites: "a.com,b.com#%#//…"; several networks: extra arguments. Meaning: when a tab showing one of the
//    sites (or a subdomain) is turned into an ad of one of the networks (or a subdomain) — a "tab-under" — uBD sends
//    the tab back to the site page (js/core/tab-under-guard.js). Rejected with a reason: an exception (#@%# / #@#),
//    no site, an entity "site.*", a negated "~site", a site or network that is not a plain lower-case ASCII hostname.
//
// 2. "$popup" / "$popunder" network rules — NOT supported (10.7.2, owner's decision): Chrome MV3 has no notion of a
//    pop-up, so their uBO/AdGuard meaning (close the new window) cannot be reproduced, and compiling them as plain
//    block rules over-blocked the named host. Recognised here so every channel can refuse them the same way.
//
// Public interface:
//   PREVENT_POPUNDER_NAME            — the pseudo-scriptlet's name
//   POPUP_OPTION_REJECTION           — the reason shown under a refused $popup/$popunder line
//   parsePopunderLine(line)          — null (not a prevent-popunder line) | { ok:true, sites, networks } | { ok:false, reason }
//   isPopupOptionLine(line)          — true for a network rule carrying $popup or $popunder
//   extractPopunderLines(text)       — { entries:[{network,sites}], rejected:[{line,reason}], remainingText }
//                                      remainingText = text without prevent-popunder lines AND without $popup/$popunder lines
//
// Pure: no state — nothing to initialise, clear or release.
// ─────────────────────────────────────────────────────────────────────────────

export const PREVENT_POPUNDER_NAME = 'prevent-popunder';
export const POPUP_OPTION_REJECTION = '$popup/$popunder not supported, use prevent-window-open / prevent-navigation / prevent-popunder';

// ── Declared limits and patterns ──────────────────────────────────────────────
import { MAX_HOSTNAME_LENGTH, PLAIN_HOSTNAME_RE } from './utils.js';

const POPUNDER_PARSER_CONFIG = Object.freeze({
    COMMENT_PREFIXES:    Object.freeze([ '!', '# ', '[' ]),
    MAX_HOSTNAME_LENGTH,                                       // DNS limit, shared (11.0.2: js/util/utils.js)
    MAX_LIST_LENGTH:     100,                                  // sites or networks per line — longer is almost surely a mistake
    // AdGuard form and uBO form; group 1 = site list, group 2 = argument list. Exceptions are matched separately.
    AG_RE:          /^([^#]*)#%#\/\/scriptlet\((.*)\)\s*$/,
    UBO_RE:         /^([^#]*)##\+js\((.*)\)\s*$/,
    EXCEPTION_RE:   /#@%#\/\/scriptlet\(|#@#\/\/scriptlet\(|#@#\+js\(/,
    // uBO alias prefix: the build's uBO→AdGuard syntax conversion (tools/build/ubo-scriptlet-syntax.mjs ALIAS_PREFIX)
    // writes every uBO-form name as "ubo-<name>", so "ubo-prevent-popunder" must mean the same as "prevent-popunder".
    UBO_ALIAS_PREFIX: 'ubo-',
    HOSTNAME_RE:    PLAIN_HOSTNAME_RE,   // (11.0.2) shared with the service worker; underscores allowed
    // Cosmetic / scriptlet separators: a line containing one of these is never a network rule.
    COSMETIC_MARKERS: Object.freeze([ '##', '#@#', '#%#', '#@%#', '#?#', '#$#', '#@$#', '#@?#' ]),
    POPUP_OPTIONS:  Object.freeze([ 'popup', 'popunder' ]),
});

function isComment(trimmed) {
    return trimmed === '' || POPUNDER_PARSER_CONFIG.COMMENT_PREFIXES.some(p => trimmed.startsWith(p));
}

function isHostname(name) {
    const C = POPUNDER_PARSER_CONFIG;
    return name.length <= C.MAX_HOSTNAME_LENGTH && C.HOSTNAME_RE.test(name);
}

// Splits a scriptlet argument list on commas and removes one level of surrounding quotes from each argument.
function splitArgs(argText) {
    return argText.split(',').map(a => a.trim().replace(/^(['"])(.*)\1$/, '$2').trim());
}

// The scriptlet name a line calls, for a quick "is this ours?" test before full validation.
function scriptletNameOf(trimmed) {
    const C = POPUNDER_PARSER_CONFIG;
    const m = C.AG_RE.exec(trimmed) ?? C.UBO_RE.exec(trimmed);
    if ( m !== null ) {
        const raw = splitArgs(m[2])[0];
        return { m, name: raw.startsWith(C.UBO_ALIAS_PREFIX) ? raw.slice(C.UBO_ALIAS_PREFIX.length) : raw };
    }
    if ( C.EXCEPTION_RE.test(trimmed) && trimmed.includes(PREVENT_POPUNDER_NAME) ) { return { m: null, name: PREVENT_POPUNDER_NAME }; }
    return null;
}

export function parsePopunderLine(line) {
    const C = POPUNDER_PARSER_CONFIG;
    if ( typeof line !== 'string' ) { return null; }
    const trimmed = line.trim();
    if ( isComment(trimmed) ) { return null; }
    const call = scriptletNameOf(trimmed);
    if ( call === null || call.name !== PREVENT_POPUNDER_NAME ) { return null; }
    if ( call.m === null ) { return { ok: false, reason: `exceptions are not supported for ${PREVENT_POPUNDER_NAME}` }; }
    const sites = call.m[1].split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '');
    const networks = splitArgs(call.m[2]).slice(1).map(n => n.toLowerCase()).filter(n => n !== '');
    if ( sites.length === 0 ) { return { ok: false, reason: `${PREVENT_POPUNDER_NAME} needs a site before #%# / ##` }; }
    if ( networks.length === 0 ) { return { ok: false, reason: `${PREVENT_POPUNDER_NAME} needs at least one ad network domain as argument` }; }
    if ( sites.length > C.MAX_LIST_LENGTH || networks.length > C.MAX_LIST_LENGTH ) { return { ok: false, reason: `more than ${C.MAX_LIST_LENGTH} sites or networks in one line` }; }
    const badSite = sites.find(s => isHostname(s) === false);
    if ( badSite !== undefined ) { return { ok: false, reason: `site "${badSite}" is not a plain domain name (no ~, no .*, punycode for non-ASCII)` }; }
    const badNetwork = networks.find(n => isHostname(n) === false);
    if ( badNetwork !== undefined ) { return { ok: false, reason: `network "${badNetwork}" is not a plain domain name` }; }
    return { ok: true, sites: [ ...new Set(sites) ].sort(), networks: [ ...new Set(networks) ].sort() };
}

export function isPopupOptionLine(line) {
    const C = POPUNDER_PARSER_CONFIG;
    if ( typeof line !== 'string' ) { return false; }
    const trimmed = line.trim();
    if ( isComment(trimmed) || C.COSMETIC_MARKERS.some(m => trimmed.includes(m)) ) { return false; }
    const dollar = trimmed.lastIndexOf('$');
    if ( dollar === -1 ) { return false; }
    return trimmed.slice(dollar + 1).split(',').some(o => C.POPUP_OPTIONS.includes(o.trim().toLowerCase()));
}

export function extractPopunderLines(text) {
    const entries = [];
    const rejected = [];
    const remainingLines = [];
    for ( const rawLine of (typeof text === 'string' ? text : '').split(/\n|\r\n|\r/) ) {
        if ( isPopupOptionLine(rawLine) ) {
            rejected.push({ line: rawLine.trim(), reason: POPUP_OPTION_REJECTION });
            continue;
        }
        const result = parsePopunderLine(rawLine);
        if ( result === null ) { remainingLines.push(rawLine); continue; }
        if ( result.ok === false ) {
            rejected.push({ line: rawLine.trim(), reason: result.reason });
            continue;
        }
        for ( const network of result.networks ) { entries.push({ network, sites: result.sites }); }
    }
    return { entries, rejected, remainingText: remainingLines.join('\n') };
}
