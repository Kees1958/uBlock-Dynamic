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
 * (11.1.6, scriptlet audit findings 4-7 — every mapping checked against uBO's own source, gorhill/uBlock master):
 *   ra / remove-attr, rc / remove-class (attr|class, selector, BEHAVIOUR [, quitAfter, N]) → AdGuard's
 *     (…, selector, APPLYING): uBO's behaviour words asap / complete / stay are AdGuard's too; `quitAfter` means "keep
 *     watching for N s after load", so it becomes AdGuard's `stay` (AdGuard has no time limit — it watches longer, it
 *     never misses what uBO catches). Before: AdGuard read `asap` alone and made ONE pass.
 *   set / set-constant (chain, VALUE [, runAt, X] [, as, Y]) → AdGuard's set-constant (chain, VALUE, '', WRAPPER):
 *     uBO values `{}` `[]` `''` become emptyObj / emptyArr / ''; `as` function|callback|resolved|rejected becomes the
 *     AdGuard wrapper asFunction|…; `runAt` is timing only (AdGuard sets from the start). A value uBO ITSELF does not
 *     accept (e.g. `function() {}`) or AdGuard cannot express (a negative number other than -1) is refused.
 *     Before: AdGuard silently ignored `{}` (rule did nothing) and read `runAt` as a value wrapper.
 *   json-prune-fetch-response / json-prune-xhr-response (prune, required [, propsToMatch, P] [, stackToMatch, S]) →
 *     AdGuard's positional (prune, required, P, S). Before: AdGuard took the WORD `propsToMatch` as the pattern.
 *   acs / acis / abort-current-script (target, needle, CONTEXT): uBO's context (the script's src must match) has no
 *     AdGuard equivalent — refused (AdGuard's function only judges inline scripts, so the rule did nothing).
 *   Names: uBO's `prevent-setTimeout` / `prevent-setInterval` / `prevent-requestAnimationFrame` (uBO's primary names,
 *     AdGuard's names too) when written with uBO's alias spelling (`ubo-prevent-setTimeout`), which AdGuard does not
 *     register.
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
    // (11.1.6) remove-attr / remove-class — uBO's base names, AdGuard's names, behaviour words both understand.
    REMOVE_ATTR_NAMES:  Object.freeze([ 'remove-attr', 'ra' ]),
    REMOVE_CLASS_NAMES: Object.freeze([ 'remove-class', 'rc' ]),
    ADGUARD_REMOVE_ATTR:  'remove-attr',
    ADGUARD_REMOVE_CLASS: 'remove-class',
    APPLYING_WORDS: Object.freeze([ 'asap', 'complete', 'stay' ]),
    STAY_WORD: 'stay',
    QUIT_AFTER_KEY: 'quitAfter',
    // (11.1.6) set-constant — uBO's base names, AdGuard's name, value spellings, wrappers.
    SET_CONSTANT_NAMES: Object.freeze([ 'set-constant', 'set' ]),
    ADGUARD_SET_CONSTANT: 'set-constant',
    SET_VALUE_SPELLINGS: Object.freeze({ '{}': 'emptyObj', '[]': 'emptyArr', "''": '' }),
    // Values AdGuard's set-constant accepts (its own source, @adguard/scriptlets 2.6.0); numbers checked separately.
    ADGUARD_SET_VALUES: Object.freeze([ 'undefined', 'false', 'true', 'null', 'emptyArr', 'emptyObj', 'noopFunc',
        'noopCallbackFunc', 'trueFunc', 'falseFunc', 'throwFunc', 'noopPromiseResolve', 'noopPromiseReject', '', '-1',
        'yes', 'no' ]),
    ADGUARD_MAX_NUMBER: 32767,
    UNSIGNED_NUMBER_RE: /^\d+$/,
    SET_WRAPPERS: Object.freeze({ function: 'asFunction', callback: 'asCallback', resolved: 'asResolved', rejected: 'asRejected' }),
    RUN_AT_KEY: 'runAt',
    AS_KEY: 'as',
    NO_STACK: '',
    // (11.1.6) json-prune-*-response — uBO named → AdGuard positional (3rd, 4th).
    JSON_PRUNE_RESPONSE_NAMES: Object.freeze([ 'json-prune-fetch-response', 'json-prune-xhr-response' ]),
    PROPS_TO_MATCH_KEY: 'propsToMatch',
    STACK_TO_MATCH_KEY: 'stackToMatch',
    // (11.1.6) abort-current-script — uBO names whose third argument is the script-src context.
    ACS_NAMES: Object.freeze([ 'abort-current-script', 'acs', 'abort-current-inline-script', 'acis' ]),
    // (11.1.6) uBO alias spellings of names AdGuard registers only in its own spelling: uBO base → AdGuard name.
    NAME_EQUIVALENTS: Object.freeze({
        'prevent-settimeout': 'prevent-setTimeout',
        'prevent-setinterval': 'prevent-setInterval',
        'prevent-requestanimationframe': 'prevent-requestAnimationFrame',
    }),
    REASON_UNKNOWN_WORD:   'uBO behaviour word this extension cannot translate',
    REASON_BAD_NUMBER:     'uBO number argument that is not a number',
    REASON_SET_VALUE:      'uBO value AdGuard\'s set-constant cannot express (or uBO itself ignores)',
    REASON_SET_WRAPPER:    'uBO "as" value this extension cannot translate',
    REASON_ACS_CONTEXT:    'uBO script-src context has no AdGuard equivalent (the rule would do nothing)',
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

// uBO's named arguments (key, value pairs) as a Map, or { error } when a value is missing.
function namedArgs(varargs) {
    if ( varargs.length % 2 !== 0 ) { return { error: UBO_SCRIPTLET_ARGS.REASON_MISSING_VALUE }; }
    const named = new Map();
    for ( let i = 0; i < varargs.length; i += 2 ) { named.set(varargs[i], varargs[i + 1]); }
    return { named };
}

// The first key of `named` not in `allowed`, or undefined.
function unknownKey(named, allowed) {
    return [ ...named.keys() ].find(k => allowed.includes(k) === false);
}

// (11.1.6) ra / rc: uBO behaviour words + quitAfter → AdGuard's applying words.
function translateRemoveAttrOrClass(name, list, adguardName, allowQuitAfter) {
    const A = UBO_SCRIPTLET_ARGS;
    if ( list.length <= 2 ) { return { name, args: list }; }   // no behaviour: AdGuard's default, as before
    const [ token, selector, behaviour, ...varargs ] = list;
    const parsed = namedArgs(varargs);
    if ( parsed.error !== undefined ) { return parsed; }
    const allowed = allowQuitAfter ? [ A.QUIT_AFTER_KEY ] : [];
    const bad = unknownKey(parsed.named, allowed);
    if ( bad !== undefined ) { return { error: `${A.REASON_UNKNOWN_KEY}: ${bad}` }; }
    const words = behaviour.split(/\s+/).filter(w => w !== '');
    const badWord = words.find(w => A.APPLYING_WORDS.includes(w) === false);
    if ( badWord !== undefined ) { return { error: `${A.REASON_UNKNOWN_WORD}: ${badWord}` }; }
    if ( parsed.named.has(A.QUIT_AFTER_KEY) ) {
        if ( A.UNSIGNED_NUMBER_RE.test(parsed.named.get(A.QUIT_AFTER_KEY)) === false ) { return { error: A.REASON_BAD_NUMBER }; }
        if ( words.includes(A.STAY_WORD) === false ) { words.push(A.STAY_WORD); }
    }
    return { name: adguardName, args: words.length === 0 ? [ token, selector ] : [ token, selector, words.join(' ') ] };
}

// (11.1.6) set: uBO value spellings, `as` wrappers, `runAt` (timing only) → AdGuard's set-constant.
function translateSetConstant(name, list) {
    const A = UBO_SCRIPTLET_ARGS;
    if ( list.length < 2 ) { return { name, args: list }; }
    const [ chain, rawValue, ...varargs ] = list;
    const parsed = namedArgs(varargs);
    if ( parsed.error !== undefined ) { return parsed; }
    const bad = unknownKey(parsed.named, [ A.RUN_AT_KEY, A.AS_KEY ]);
    if ( bad !== undefined ) { return { error: `${A.REASON_UNKNOWN_KEY}: ${bad}` }; }
    const value = Object.hasOwn(A.SET_VALUE_SPELLINGS, rawValue) ? A.SET_VALUE_SPELLINGS[rawValue] : rawValue;
    const isNumber = A.UNSIGNED_NUMBER_RE.test(value) && Number(value) <= A.ADGUARD_MAX_NUMBER;
    if ( A.ADGUARD_SET_VALUES.includes(value) === false && isNumber === false ) { return { error: `${A.REASON_SET_VALUE}: ${rawValue}` }; }
    let wrapper = '';
    if ( parsed.named.has(A.AS_KEY) ) {
        wrapper = A.SET_WRAPPERS[parsed.named.get(A.AS_KEY)] ?? null;
        if ( wrapper === null ) { return { error: `${A.REASON_SET_WRAPPER}: ${parsed.named.get(A.AS_KEY)}` }; }
    }
    if ( value === rawValue && wrapper === '' && parsed.named.size === 0 ) { return { name, args: list }; }   // nothing to translate
    return { name: A.ADGUARD_SET_CONSTANT, args: wrapper === '' ? [ chain, value ] : [ chain, value, A.NO_STACK, wrapper ] };
}

// (11.1.6) json-prune-*-response: uBO named propsToMatch / stackToMatch → AdGuard's 3rd / 4th position.
function translateJsonPruneResponse(name, list, base) {
    const A = UBO_SCRIPTLET_ARGS;
    if ( list.length <= 2 ) { return { name, args: list }; }
    const [ prune, required, ...varargs ] = list;
    const parsed = namedArgs(varargs);
    if ( parsed.error !== undefined ) { return parsed; }
    const bad = unknownKey(parsed.named, [ A.PROPS_TO_MATCH_KEY, A.STACK_TO_MATCH_KEY ]);
    if ( bad !== undefined ) { return { error: `${A.REASON_UNKNOWN_KEY}: ${bad}` }; }
    const props = parsed.named.get(A.PROPS_TO_MATCH_KEY) ?? '';
    const stack = parsed.named.get(A.STACK_TO_MATCH_KEY) ?? '';
    return { name: base, args: stack === '' ? [ prune, required, props ] : [ prune, required, props, stack ] };
}

// { name, args } to run, or { error }. Rules that need no translation come back unchanged.
export function translateUboScriptletArgs(name, args, uboSyntax = false) {
    const A = UBO_SCRIPTLET_ARGS;
    const list = Array.isArray(args) ? args.map(String) : [];
    if ( typeof name !== 'string' || isUboSemantics(name, uboSyntax) === false ) { return { name, args: list }; }
    const base = baseScriptletName(name);
    if ( Object.hasOwn(A.NAME_EQUIVALENTS, base) ) { return { name: A.NAME_EQUIVALENTS[base], args: list }; }
    if ( A.REMOVE_ATTR_NAMES.includes(base) ) { return translateRemoveAttrOrClass(name, list, A.ADGUARD_REMOVE_ATTR, true); }
    if ( A.REMOVE_CLASS_NAMES.includes(base) ) { return translateRemoveAttrOrClass(name, list, A.ADGUARD_REMOVE_CLASS, false); }
    if ( A.SET_CONSTANT_NAMES.includes(base) ) { return translateSetConstant(name, list); }
    if ( A.JSON_PRUNE_RESPONSE_NAMES.includes(base) ) { return translateJsonPruneResponse(name, list, base); }
    if ( A.ACS_NAMES.includes(base) ) {
        return list.length > 2 && list[2] !== '' ? { error: A.REASON_ACS_CONTEXT } : { name, args: list };
    }
    if ( A.REMOVE_NODE_TEXT_NAMES.includes(base) === false ) { return { name, args: list }; }
    return translateRemoveNodeText(name, list);
}

// (11.1.4) rmnt / remove-node-text — moved out of translateUboScriptletArgs() unchanged (11.1.6).
function translateRemoveNodeText(name, list) {
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
