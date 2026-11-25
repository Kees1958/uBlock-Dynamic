// ── tools/build/list-directives.mjs ───────────────────────────────────────────────────
// (11.1.4) A downloaded list's own platform directives, applied before anything parses the list.
//
// Why: AdGuard writes some rules for ONE kind of blocker only and marks them, either with a hint line directly above
// the rule ("!+ PLATFORM(ios, ext_safari)", "!+ NOT_PLATFORM(ext_ublock)") or with an "!#if … !#endif" block. AdGuard's
// own compiler (AdguardTeam/FiltersCompiler, src/main/platforms/filter.js and platforms-config.js) leaves such a rule
// out of every build it is not meant for. The project downloads the RAW AdGuard sections instead of a compiled build,
// so until 11.1.4 every marked rule shipped — e.g. the iOS/Safari-only allow for bbc.com's dotcom-ads.js, which beat
// AdGuard Base's own block of that script and let bbc.com's video ads through.
//
// What this module does, for every downloaded list (called once, from fetchListText() in fetch-helpers.mjs):
//   1. "!#if" blocks: evaluated by the project's own copy of uBO's preparser (js/core/filter-parser-helpers.js).
//      An AdGuard Team source is answered as AdGuard's Chrome MV3 extension answers it; any other source as uBO
//      Lite on Chromium answers it (the environment anti-admiral.mjs already used for uAssets).
//   2. "!+" hint lines: a rule whose hint names platforms is kept only when AdGuard's Chrome MV3 platform is among
//      them (PLATFORM) and not excluded (NOT_PLATFORM) — the same test, and the same "hint = the line directly
//      above" reading, as AdGuard's compiler. The hint lines themselves are dropped (they are comments).
// Every rule left out is reported (droppedPlatformLines → dropped-platform-rules.txt) so the effect stays reviewable.
//
// Public interface: LIST_DIRECTIVES_CONFIG, applyListDirectives, isRuleForPlatform
// Dependencies: see the imports below (strictly acyclic).
// Pure functions and frozen data, plus one append to the build's report accumulator — nothing to initialise, clear
// or release here (the accumulator is reset by resetBuildAccumulators() in build-state.mjs).
import { utils } from '../../js/core/filter-parser-helpers.js';
import { isTrustedScriptletSource } from '../../js/data/scriptlet-policy.js';
import { droppedPlatformLines } from './build-state.mjs';

export const LIST_DIRECTIVES_CONFIG = Object.freeze({
    // AdGuard's platform name for its Chrome MV3 extension — the build this extension is closest to (DNR + AdGuard
    // scriptlets). FiltersCompiler platforms-config.js, EXTENSION_CHROMIUM_MV3.platform.
    ADGUARD_PLATFORM: 'ext_chromium_mv3',
    // That platform's "!#if" defines (adguard, adguard_ext_chromium_mv3), written as the states the project's
    // preparser maps those tokens to (filter-parser-helpers.js preparserTokens: adguard → 'adguard',
    // adguard_ext_chromium_mv3 → 'mv3'). Every other adguard_* token then evaluates false, as in AdGuard's build.
    ADGUARD_PREPARSER_ENV: Object.freeze([ 'adguard', 'mv3' ]),
    // uBO Lite on Chromium (uBO's platform/mv3/make-rulesets.js env): no HTML filtering, so "!#else" branches of
    // cap_html_filtering are taken. Used for every non-AdGuard source (uAssets, EasyList, …).
    UBOL_PREPARSER_ENV: Object.freeze([ 'chromium', 'mv3', 'ublock', 'ubol', 'user_stylesheet' ]),
    // Hint line marker (FiltersCompiler rule-masks.js HINT_MASK = "!+" + space).
    HINT_PREFIX: '!+ ',
    // Hint syntax (FiltersCompiler platforms/filter.js PLATFORM_HINT_REGEXP / NOT_PLATFORM_HINT_REGEXP).
    PLATFORM_HINT_RE: /(^|\s)PLATFORM\(([^)]+)\)/g,
    NOT_PLATFORM_HINT_RE: /(^|\s)NOT_PLATFORM\(([^)]+)\)/g,
    // Hint aliases (FiltersCompiler PLATFORM_HINT_ALIASES).
    PLATFORM_ALIASES: Object.freeze({ corelibs: Object.freeze([ 'windows', 'mac', 'cli', 'android' ]) }),
    // Report reasons.
    REASON_IF_BLOCK: 'inside an !#if block for another platform',
    REASON_HINT:     'platform hint excludes AdGuard Chrome MV3',
});

// Pure: the platform names one hint kind lists (aliases expanded).
function hintPlatforms(hint, re) {
    const out = [];
    for ( const m of hint.matchAll(re) ) {
        for ( const raw of m[2].split(',') ) {
            const p = raw.trim();
            out.push(...(LIST_DIRECTIVES_CONFIG.PLATFORM_ALIASES[p] ?? [ p ]));
        }
    }
    return out;
}

// Pure: true when a rule under `hintLine` (the line directly above it, or null) is meant for AdGuard's Chrome MV3
// platform. Same test as FiltersCompiler isPlatformSupported().
export function isRuleForPlatform(hintLine, platform = LIST_DIRECTIVES_CONFIG.ADGUARD_PLATFORM) {
    if ( typeof hintLine !== 'string' || hintLine.startsWith(LIST_DIRECTIVES_CONFIG.HINT_PREFIX) === false ) { return true; }
    const hint = hintLine.slice(LIST_DIRECTIVES_CONFIG.HINT_PREFIX.length).trim();
    // "NOT_PLATFORM(" never matches the PLATFORM pattern: that needs a start or a space right before "PLATFORM".
    const included = hintPlatforms(hint, LIST_DIRECTIVES_CONFIG.PLATFORM_HINT_RE);
    const excluded = hintPlatforms(hint, LIST_DIRECTIVES_CONFIG.NOT_PLATFORM_HINT_RE);
    return (included.length === 0 || included.includes(platform)) && excluded.includes(platform) === false;
}

// Pure: the rule lines (non-blank, non-comment) of a text, as a Set, for the "what did !#if remove" report.
function ruleLineSet(text) {
    const out = new Set();
    for ( const raw of text.split('\n') ) {
        const l = raw.trim();
        if ( l !== '' && l.startsWith('!') === false ) { out.add(l); }
    }
    return out;
}

// The text of one downloaded list with its platform directives applied (see header). `url` decides the "!#if"
// environment; every left-out rule is appended to droppedPlatformLines.
export function applyListDirectives(url, text) {
    const env = isTrustedScriptletSource(url) ? LIST_DIRECTIVES_CONFIG.ADGUARD_PREPARSER_ENV : LIST_DIRECTIVES_CONFIG.UBOL_PREPARSER_ENV;
    const pruned = text.includes('!#if') ? utils.preparser.prune(text, env) : text;
    if ( pruned !== text ) {
        const kept = ruleLineSet(pruned);
        for ( const line of ruleLineSet(text) ) {
            if ( kept.has(line) === false ) { droppedPlatformLines.push({ source: url, line, reason: LIST_DIRECTIVES_CONFIG.REASON_IF_BLOCK }); }
        }
    }
    if ( pruned.includes(LIST_DIRECTIVES_CONFIG.HINT_PREFIX) === false ) { return pruned; }
    const lines = pruned.split('\n');
    const out = [];
    for ( let i = 0; i < lines.length; i++ ) {
        const line = lines[i];
        if ( line.startsWith(LIST_DIRECTIVES_CONFIG.HINT_PREFIX) ) { continue; }
        const hintLine = i > 0 ? lines[i - 1] : null;
        if ( isRuleForPlatform(hintLine) === false ) {
            if ( line.trim() !== '' ) { droppedPlatformLines.push({ source: url, line: line.trim(), reason: LIST_DIRECTIVES_CONFIG.REASON_HINT }); }
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}
