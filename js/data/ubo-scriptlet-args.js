/*
 * ubo-scriptlet-args.js — (11.1.4) uBlock Origin's extra scriptlet arguments, translated for the AdGuard scriptlet
 * library this extension runs.
 *
 * Why: uBO's remove-node-text (`rmnt`) takes optional NAMED arguments after the text to match —
 * `##+js(rmnt, script, PATTERN, excludes, OTHER)` empties a <script> containing PATTERN unless it also contains OTHER
 * (uBO src/js/resources/scriptlets.js replaceNodeTextFn()). AdGuard's remove-node-text reads its third argument as a
 * parent-element selector instead, so such a rule was handed `excludes` as a CSS selector and never matched anything
 * (found 2026-11-25: uBO's Admiral rules for foxbusiness.com). Here the named arguments are folded into the ONE text
 * pattern AdGuard's scriptlet takes, so the rule empties exactly the nodes uBO would.
 *
 * Translation (only for a uBO spelling of the name, or any name in a uBO-syntax `##+js(…)` line):
 *   rmnt(node, PAT, includes|condition, INC, excludes, EXC, …)
 *   → remove-node-text(node, /(?<![\s\S])(?![\s\S]*?(?:EXC))(?=[\s\S]*?(?:INC))[\s\S]*?(?:PAT)/flags)
 *   `(?<![\s\S])` is "start of the text" whatever the flags (a plain `^` would mean "start of any line" under `m`).
 *   A string pattern is matched literally (escaped), a `/regex/flags` one as written — as uBO's patternToRegex() does.
 *   Timing-only arguments (stay, quitAfter, sedCount) are dropped: AdGuard's scriptlet keeps watching the page and
 *   empties every match, so they never change WHICH node is emptied.
 *   A rule that cannot be expressed exactly is refused with a reason (never run with a guessed meaning): an unknown
 *   named argument, a missing value, or patterns whose regex flags differ (one regex has one set of flags).
 *
 * Read by: tools/build/scriptlet-rules.mjs (every filter list, rules and exceptions) and js/core/custom-scriptlets.js
 * (the user's own rules) — one translation, so a list rule and a typed rule behave the same (B15).
 * Public interface: UBO_SCRIPTLET_ARGS, translateUboScriptletArgs(name, args, uboSyntax)
 * Pure data and pure functions — nothing to initialise, clear or release.
 */

import { baseScriptletName } from './scriptlet-policy.js';

export const UBO_SCRIPTLET_ARGS = Object.freeze({
    // uBO's base names (after baseScriptletName(): no "ubo-" prefix, no ".js" suffix) of remove-node-text.
    REMOVE_NODE_TEXT_NAMES: Object.freeze([ 'remove-node-text', 'rmnt' ]),
    // The AdGuard scriptlet a translated rule runs as.
    ADGUARD_REMOVE_NODE_TEXT: 'remove-node-text',
    // A name in one of these spellings is uBO's even inside an AdGuard-syntax line (AdGuard's alias convention).
    UBO_ALIAS_PREFIX: 'ubo-',
    UBO_ALIAS_SUFFIX: '.js',
    UBO_ONLY_SHORT_NAMES: Object.freeze([ 'rmnt' ]),
    // Named arguments that decide WHICH node is emptied (uBO: includes wins over condition when both are given).
    INCLUDE_KEYS: Object.freeze([ 'includes', 'condition' ]),
    EXCLUDE_KEY: 'excludes',
    // Named arguments that only decide how long / how often it runs — dropped (see header).
    TIMING_KEYS: Object.freeze([ 'stay', 'quitAfter', 'sedCount' ]),
    // uBO's regex-literal form (safe-self.js patternToRegex): /body/flags.
    REGEX_LITERAL_RE: /^\/(.+)\/([gimsu]*)$/,
    // The one flag that is state, not meaning.
    STATE_FLAG: 'g',
    // Characters escaped to match a string pattern literally.
    REGEX_SPECIAL_RE: /[.*+?^${}()|[\]\\]/g,
    // Pieces of the combined pattern.
    TEXT_START: '(?<![\\s\\S])',
    ANY: '[\\s\\S]*?',
    // Refusal reasons (shown in the build report and to the user for a typed rule).
    REASON_UNKNOWN_KEY:   'uBO argument this extension cannot translate',
    REASON_MISSING_VALUE: 'uBO named argument without a value',
    REASON_FLAG_MIX:      'uBO patterns with different regex flags cannot be combined into one',
});

// True when `name` is uBO's (its spelling, or any name in a uBO-syntax line).
function isUboSemantics(name, uboSyntax) {
    if ( uboSyntax === true ) { return true; }
    const n = String(name).trim().toLowerCase();
    return n.startsWith(UBO_SCRIPTLET_ARGS.UBO_ALIAS_PREFIX) || n.endsWith(UBO_SCRIPTLET_ARGS.UBO_ALIAS_SUFFIX)
        || UBO_SCRIPTLET_ARGS.UBO_ONLY_SHORT_NAMES.includes(n);
}

// One uBO pattern as { body, flags } — flags without the state flag, sorted; null flags for a literal string.
function patternPart(pattern) {
    const m = UBO_SCRIPTLET_ARGS.REGEX_LITERAL_RE.exec(pattern);
    if ( m === null ) { return { body: pattern.replace(UBO_SCRIPTLET_ARGS.REGEX_SPECIAL_RE, '\\$&'), flags: null }; }
    return { body: m[1], flags: [ ...m[2] ].filter(f => f !== UBO_SCRIPTLET_ARGS.STATE_FLAG).sort().join('') };
}

// The one flag set every part can share, or null when they differ. A literal string is unaffected by every flag
// except "i" (it has no "." "^" "$"), so it fits any set without "i".
function sharedFlags(parts) {
    const regexFlags = [ ...new Set(parts.filter(p => p.flags !== null).map(p => p.flags)) ];
    if ( regexFlags.length > 1 ) { return null; }
    const flags = regexFlags[0] ?? '';
    if ( flags.includes('i') && parts.some(p => p.flags === null) ) { return null; }
    return flags;
}

// { name, args } to run, or { error }. Rules that need no translation come back unchanged.
export function translateUboScriptletArgs(name, args, uboSyntax = false) {
    const list = Array.isArray(args) ? args.map(String) : [];
    if ( typeof name !== 'string' || isUboSemantics(name, uboSyntax) === false ) { return { name, args: list }; }
    if ( UBO_SCRIPTLET_ARGS.REMOVE_NODE_TEXT_NAMES.includes(baseScriptletName(name)) === false ) { return { name, args: list }; }
    if ( list.length <= 2 ) { return { name, args: list }; }   // node name + pattern only: same meaning in both
    const [ nodeName, pattern, ...varargs ] = list;
    if ( varargs.length % 2 !== 0 ) { return { error: UBO_SCRIPTLET_ARGS.REASON_MISSING_VALUE }; }
    let include = '';
    let exclude = '';
    for ( let i = 0; i < varargs.length; i += 2 ) {
        const key = varargs[i];
        const value = varargs[i + 1];
        if ( UBO_SCRIPTLET_ARGS.INCLUDE_KEYS.includes(key) ) {
            // uBO: `includes` takes precedence over `condition`.
            if ( include === '' || key === UBO_SCRIPTLET_ARGS.INCLUDE_KEYS[0] ) { include = value; }
        } else if ( key === UBO_SCRIPTLET_ARGS.EXCLUDE_KEY ) {
            exclude = value;
        } else if ( UBO_SCRIPTLET_ARGS.TIMING_KEYS.includes(key) === false ) {
            return { error: `${UBO_SCRIPTLET_ARGS.REASON_UNKNOWN_KEY}: ${key}` };
        }
    }
    if ( include === '' && exclude === '' ) { return { name: UBO_SCRIPTLET_ARGS.ADGUARD_REMOVE_NODE_TEXT, args: [ nodeName, pattern ] }; }
    const parts = [ exclude, include, pattern ].filter(p => p !== '').map(patternPart);
    const flags = sharedFlags(parts);
    if ( flags === null ) { return { error: UBO_SCRIPTLET_ARGS.REASON_FLAG_MIX }; }
    const { ANY } = UBO_SCRIPTLET_ARGS;
    let body = UBO_SCRIPTLET_ARGS.TEXT_START;
    if ( exclude !== '' ) { body += `(?!${ANY}(?:${patternPart(exclude).body}))`; }
    if ( include !== '' ) { body += `(?=${ANY}(?:${patternPart(include).body}))`; }
    if ( pattern !== '' ) { body += `${ANY}(?:${patternPart(pattern).body})`; }
    return { name: UBO_SCRIPTLET_ARGS.ADGUARD_REMOVE_NODE_TEXT, args: [ nodeName, `/${body}/${flags}` ] };
}
