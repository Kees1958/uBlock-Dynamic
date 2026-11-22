/*
 * scriptlet-policy.js — Single source of truth for which scriptlet rules this extension may ship or run (10.4.6).
 *
 * Why (Chrome Web Store rejection "Blue Argon", 2026-10-23): an AdGuard French rule
 *   supersoluce.com#%#//scriptlet('trusted-create-element','head','script','', '(()=>{… e.src = <cdn.viously.com/js/sdk/boot.js> …})()')
 * reached the package. That is remotely hosted code, forbidden for every Manifest V3 item. Three gaps let it in:
 *   1. the build's "no raw JavaScript" rule only looked at the SHAPE of a line (`#%#` without `//scriptlet(`), never
 *      at what a named scriptlet does with its arguments — trusted-create-element + 'script' IS raw JavaScript;
 *   2. the old trust exclusion (custom-scriptlets.js DELIBERATELY_EXCLUDED_SCRIPTLET_NAMES) was a documentation
 *      constant that no code read, listing names the library did not even contain;
 *   3. no check compared shipped data against the Manifest V3 rules.
 * This module replaces all three with ONE policy, enforced in four places that all import it:
 *   - the build: tools/build/fetch-helpers.mjs (trust gate per source) and tools/build/build-steps.mjs (rule gate);
 *   - the suite: tools/check-mv3-compliance.mjs;
 *   - the extension, at input: js/core/custom-scriptlets.js (Custom Rules, ABP import);
 *   - the extension, at run time: the guard the build writes into rulesets/scriptlet-library.js
 *     (scriptletPolicyViolation's own source, see tools/build/scriptlet-dispatch-layout.mjs) and the check before
 *     executeScript in custom-scriptlets.js.
 *
 * The policy (owner's decisions, 2026-10-23):
 *   A. Scriptlets that need trust (`trusted-*`, plus uBO names with requiresTrust) are accepted ONLY from AdGuard
 *      Team filter sources. Never from other lists, the Quick-fixes list, Custom Rules or the ABP import.
 *   B. No code as an argument: a scriptlet that creates a <script> element (trusted-create-element) is refused,
 *      whatever its source — same rule as the build's existing "no raw JavaScript".
 *   C. No external resources: a value a scriptlet INSERTS into the page (element attributes/text, attribute value,
 *      replacement text, constant value) may not reference an external URL. URLs a scriptlet only MATCHES in order
 *      to block (prevent-fetch, prevent-xhr, prevent-element-src-loading …) are not inserted and stay allowed.
 *   D. (audit 10.6.4, owner's decision 2026-11-09) Blocked families, whatever the source: the uBO json-edit family
 *      (json-edit, jsonl-edit, their -fetch-response / -xhr-response variants and the trusted- versions). They CHANGE
 *      values in the data a page receives; json-prune (which only REMOVES fields) stays allowed. Enforced by the
 *      build gate, the suite and every own-rule input/run path via isBlockedScriptletFamily(); not part of the
 *      serialized run-time guard, so the shipped scriptlet library needs no rebuild for it (no shipped list uses
 *      the family, and the build now refuses it).
 *
 * Public interface:
 *   SCRIPTLET_POLICY                       — names, sources and report reasons, one place
 *   requiresTrust(name)                    — true for a scriptlet name that needs a trusted source (rule A)
 *   isTrustedScriptletSource(url)          — true for an AdGuard Team source URL (rule A)
 *   scriptletPolicyViolation(name, args)   — rules B and C: a reason string, or null when the rule may run
 *   isBlockedScriptletFamily(name)         — rule D: true for a json-edit-family name (any alias spelling)
 *   scriptletViolationAnySource(name, args) — rules D+B+C for every source (build, suite): a reason, or null
 *   scriptletRuleRejection(name, args)     — rules D+A+B+C for rules from an untrusted source (user input):
 *                                            a user-facing message, or null
 * Pure functions and frozen data — nothing to initialise, clear or release.
 */

export const SCRIPTLET_POLICY = Object.freeze({
    // Rule A — AdGuard prefixes every scriptlet that needs trust with this.
    TRUSTED_NAME_PREFIX: 'trusted-',
    // Rule A — scriptlets that need trust WITHOUT the prefix (uBO registers them with requiresTrust: true).
    REQUIRES_TRUST_NAMES: Object.freeze([ 'prevent-clipboard-write' ]),
    // Rule A — the only sources allowed to ship trusted scriptlets: AdGuard Team's own repositories
    // (AdguardFilters, FiltersRegistry). Matched as URL prefixes, so a look-alike owner name cannot pass.
    TRUSTED_SOURCE_URL_PREFIXES: Object.freeze([ 'https://raw.githubusercontent.com/AdguardTeam/' ]),
    // Report reasons (also the values scriptletPolicyViolation() returns).
    REASON_UNTRUSTED_SOURCE:   'trusted scriptlet from a non-AdGuard source',
    REASON_CODE_ARGUMENT:      'code as argument (creates a <script> element)',
    REASON_EXTERNAL_RESOURCE:  'inserts an external URL into the page (remotely hosted resource)',
    // Rule D — base names (without the uBO alias spellings "ubo-" prefix / ".js" suffix, see isBlockedScriptletFamily()).
    BLOCKED_FAMILY_NAMES: Object.freeze([
        'json-edit', 'json-edit-fetch-response', 'json-edit-xhr-response',
        'jsonl-edit', 'jsonl-edit-fetch-response', 'jsonl-edit-xhr-response',
        'trusted-json-edit', 'trusted-json-edit-fetch-response', 'trusted-json-edit-xhr-response',
        'trusted-jsonl-edit', 'trusted-jsonl-edit-fetch-response', 'trusted-jsonl-edit-xhr-response',
    ]),
    REASON_BLOCKED_FAMILY:     'blocked scriptlet family (json-edit changes the data a page receives)',
    // Rule D — alias spellings uBO accepts for the same scriptlet ("ubo-json-edit.js" = "json-edit").
    ALIAS_PREFIX: 'ubo-',
    ALIAS_SUFFIX: '.js',
});

// The scriptlet's own name without uBO's alias spellings: "ubo-x.js" / "ubo-x" / "x.js" -> "x" (lower case).
// (audit 10.6.4) Shared by rules A and D, so an alias spelling can never slip past either one — e.g. the build turns
// uBO's `##+js(trusted-x, …)` into AdGuard's `ubo-trusted-x`, which the old prefix test did not see as trusted.
function baseScriptletName(name) {
    let base = name.trim().toLowerCase();
    if ( base.startsWith(SCRIPTLET_POLICY.ALIAS_PREFIX) ) { base = base.slice(SCRIPTLET_POLICY.ALIAS_PREFIX.length); }
    if ( base.endsWith(SCRIPTLET_POLICY.ALIAS_SUFFIX) ) { base = base.slice(0, -SCRIPTLET_POLICY.ALIAS_SUFFIX.length); }
    return base;
}

export function requiresTrust(name) {
    if ( typeof name !== 'string' ) { return false; }
    const base = baseScriptletName(name);
    return base.startsWith(SCRIPTLET_POLICY.TRUSTED_NAME_PREFIX) || SCRIPTLET_POLICY.REQUIRES_TRUST_NAMES.includes(base);
}

export function isTrustedScriptletSource(url) {
    if ( typeof url !== 'string' ) { return false; }
    return SCRIPTLET_POLICY.TRUSTED_SOURCE_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

// Rules B and C. SELF-CONTAINED ON PURPOSE: the build writes this function's source text into the shared scriptlet
// library as the run-time guard (MAIN world, no imports possible), so it may not reference anything outside its own
// body — its constants live here, and the suite (tools/check-mv3-compliance.mjs) proves the serialized copy works
// stand-alone and returns the same answers. The reason strings repeat SCRIPTLET_POLICY's (asserted equal there).
export function scriptletPolicyViolation(name, args) {
    // Scriptlets that create a page element: arg 1 is the tag. A 'script' tag means code as argument (rule B).
    const ELEMENT_CREATORS = [ 'trusted-create-element' ];
    const CODE_TAGS = [ 'script' ];
    // Rule C: per scriptlet, the argument positions (0-based, after the name) holding a value it INSERTS into the
    // page. -1 = every argument. Positions not listed are match patterns (what to look for), never inserted.
    const INSERTED_VALUE_ARGS = {
        'trusted-create-element':         [ -1 ],   // parent, tag, attributes, text
        'trusted-set-attr':               [ 2 ],    // selector, attribute, VALUE
        'set-attr':                       [ 2 ],
        'trusted-replace-argument':       [ 2 ],    // method, index, VALUE, pattern
        'trusted-replace-node-text':      [ 3 ],    // node, text match, pattern, REPLACEMENT
        'trusted-replace-fetch-response': [ 1 ],    // pattern, REPLACEMENT
        'trusted-replace-xhr-response':   [ 1 ],
        'trusted-replace-outbound-text':  [ 2 ],    // method, text, REPLACEMENT
        'trusted-set-constant':           [ 1 ],    // property, VALUE
        'set-constant':                   [ 1 ],
    };
    // An external URL: an explicit network scheme, or a quoted protocol-relative "//host.tld/…" (a bare "//word"
    // is a JavaScript comment, e.g. a replacement that comments a statement out, and must not match).
    const EXTERNAL_URL_RE = /\b(?:https?|wss?|ftp):\/\/|["'`]\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[/"'`]/i;
    const REASON_CODE_ARGUMENT = 'code as argument (creates a <script> element)';
    const REASON_EXTERNAL_RESOURCE = 'inserts an external URL into the page (remotely hosted resource)';

    const list = Array.isArray(args) ? args : [];
    if ( ELEMENT_CREATORS.includes(name) ) {
        const tag = String(list[1] ?? '').trim().toLowerCase().split(/[\s[.#>]/)[0];
        if ( CODE_TAGS.includes(tag) ) { return REASON_CODE_ARGUMENT; }
    }
    const positions = INSERTED_VALUE_ARGS[name];
    if ( positions === undefined ) { return null; }
    const values = positions[0] === -1 ? list : positions.map(i => list[i]);
    for ( const v of values ) {
        if ( typeof v === 'string' && EXTERNAL_URL_RE.test(v) ) { return REASON_EXTERNAL_RESOURCE; }
    }
    return null;
}

// Rule D. Normalises the uBO alias spellings before matching, so "ubo-json-edit.js" cannot slip past "json-edit".
export function isBlockedScriptletFamily(name) {
    if ( typeof name !== 'string' ) { return false; }
    return SCRIPTLET_POLICY.BLOCKED_FAMILY_NAMES.includes(baseScriptletName(name));
}

// Rules D, B and C — what is refused for EVERY source (the build gate per list, the suite's shipped-data check).
export function scriptletViolationAnySource(name, args) {
    if ( isBlockedScriptletFamily(name) ) { return SCRIPTLET_POLICY.REASON_BLOCKED_FAMILY; }
    return scriptletPolicyViolation(name, args);
}

// For rules that do NOT come from an AdGuard Team source (Custom Rules, ABP import): rule D refuses the blocked
// families, rule A every trusted scriptlet, then rules B and C. Returns the message to show the user, or null.
export function scriptletRuleRejection(name, args) {
    if ( isBlockedScriptletFamily(name) ) {
        return `Scriptlet "${name}" refused: ${SCRIPTLET_POLICY.REASON_BLOCKED_FAMILY}.`;
    }
    if ( requiresTrust(name) ) {
        return `Scriptlet "${name}" needs trust and is only accepted from AdGuard filter lists, not from own rules.`;
    }
    const violation = scriptletPolicyViolation(name, args);
    return violation === null ? null : `Scriptlet "${name}" refused: ${violation}.`;
}
