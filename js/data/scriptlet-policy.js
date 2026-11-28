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
 *   safeReplacementFor(name, args)         — rule A's safe equivalent of a trusted rule ({ name, args }), or null
 *   scriptletRuleRejection(name, args)     — rules D+A+B+C for rules from an untrusted source (user input):
 *                                            a user-facing message, or null
 *   baseScriptletName(name)                — (11.1.4, exported for js/data/ubo-scriptlet-args.js) the name without
 *                                            uBO's alias spellings, lower case
 * Pure functions and frozen data — nothing to initialise, clear or release.
 */

export const SCRIPTLET_POLICY = Object.freeze({
    // Rule A — AdGuard prefixes every scriptlet that needs trust with this.
    TRUSTED_NAME_PREFIX: 'trusted-',
    // Rule A — scriptlets that need trust WITHOUT the prefix (uBO registers them with requiresTrust: true).
    // (11.1.6) + uBO's `replace-node-text` / `rpnt` — aliases of its trusted-replace-node-text.js (requiresTrust: true,
    // uBO source); before, `ubo-rpnt` from uBlock Origin's lists slipped past rule A and was only reported as "missing".
    REQUIRES_TRUST_NAMES: Object.freeze([ 'prevent-clipboard-write', 'replace-node-text', 'rpnt' ]),
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
    // (11.1.3, owner's decision) Safe replacements for rule A. A rule refused for needing trust is not simply dropped
    // when its arguments have exactly a known, harmless shape: it is replaced by a scriptlet that does that one job and
    // can insert nothing of the rule's choosing — a project-own scriptlet (js/resources/ubo-patch-scriptlets-source.mjs)
    // or the trusted scriptlet's own non-trusted AdGuard twin. Every other argument shape stays refused.
    BLANK_SETATTRIBUTE_VALUE_NAME: 'blank-setattribute-value',
    SET_STORAGE_ITEM_NOW_NAME:     'set-storage-item-now',
    SET_DATA_ATTR_NAME:            'set-data-attr',
    // The value token of the trusted storage setters meaning "the current time".
    NOW_VALUE_TOKEN:               '$now$',
    // set-storage-item-now's first argument.
    STORAGE_KINDS:                 Object.freeze({ LOCAL: 'local', SESSION: 'session' }),
    // set-data-attr: only data-* attributes (never run as code by a browser) and a short plain word as value.
    DATA_ATTR_NAME_RE:             /^data-[a-z0-9-]{1,64}$/i,
    DATA_ATTR_VALUE_RE:            /^[A-Za-z0-9_-]{1,32}$/,
    // A storage key or cookie name the replacements accept (non-empty, bounded).
    MAX_KEY_LENGTH:                256,
    // Trusted setter -> its non-trusted AdGuard twin, which applies ONLY its own list of safe values at run time
    // (AdGuard's design: set-cookie, set-local-storage-item, … ignore any other value). Mapped only when the call has
    // the twin's argument layout (name, value — set-attr: selector, attribute, value) and the value is a plain word or
    // a small number (TWIN_VALUE_RE), so a JSON blob or code is never reported as "replaced" for a twin to refuse.
    TWINS: Object.freeze({
        'trusted-set-cookie':               Object.freeze({ twin: 'set-cookie',               argCount: 2, valueAt: 1 }),
        'trusted-set-local-storage-item':   Object.freeze({ twin: 'set-local-storage-item',   argCount: 2, valueAt: 1 }),
        'trusted-set-session-storage-item': Object.freeze({ twin: 'set-session-storage-item', argCount: 2, valueAt: 1 }),
        'trusted-set-constant':             Object.freeze({ twin: 'set-constant',             argCount: 2, valueAt: 1 }),
        // set-attr accepts far fewer values than the setters above (true, false or a small number only), so it carries
        // its own, narrower shape; the others use TWIN_VALUE_RE.
        'trusted-set-attr':                 Object.freeze({ twin: 'set-attr',                 argCount: 3, valueAt: 2, valueRe: /^(?:true|false|\d{1,5})$/ }),
    }),
    TWIN_VALUE_RE:                 /^(?:[A-Za-z_$]{1,32}|-?\d{1,5})$/,
    REASON_REPLACED:               'trusted scriptlet replaced by a safe equivalent',
});

// The replacement table (rule A, see SCRIPTLET_POLICY above), tried IN ORDER — the specific shapes before the general
// twin mapping. Each entry: the trusted scriptlet (base name, or null = any name in TWINS) and replace(base, args) ->
// { name, args } of the safe equivalent, or null when this call does not have the entry's shape. Pure.
function isBoundedKey(value) {
    return typeof value === 'string' && value.trim() !== '' && value.length <= SCRIPTLET_POLICY.MAX_KEY_LENGTH;
}
const SAFE_SCRIPTLET_REPLACEMENTS = Object.freeze([
    Object.freeze({
        // uBlock Origin (uAssets, Ad-Shield section):
        //   site##+js(trusted-replace-argument, Element.prototype.setAttribute, 1, , condition, /pattern/)
        // = "when a setAttribute VALUE matches the pattern, set it to the empty string". The safe scriptlet can only
        // ever blank a matching value, so it inserts nothing.
        trustedName: 'trusted-replace-argument',
        replace(base, args) {
            const FIXED = [ 'Element.prototype.setAttribute', '1', '', 'condition' ];
            if ( args.length !== FIXED.length + 1 || FIXED.some((v, i) => String(args[i]).trim() !== v) ) { return null; }
            const pattern = String(args[FIXED.length]);
            return pattern.trim() === '' ? null : { name: SCRIPTLET_POLICY.BLANK_SETATTRIBUTE_VALUE_NAME, args: [ pattern ] };
        },
    }),
    Object.freeze({
        // site##+js(trusted-set-local-storage-item, key, $now$) — and the session-storage form: "remember when the ad
        // was last shown", so pop-unders and interstitials wait. The safe scriptlet writes only the current time.
        trustedName: null,
        replace(base, args) {
            const KIND_BY_NAME = {
                'trusted-set-local-storage-item':   SCRIPTLET_POLICY.STORAGE_KINDS.LOCAL,
                'trusted-set-session-storage-item': SCRIPTLET_POLICY.STORAGE_KINDS.SESSION,
            };
            const kind = KIND_BY_NAME[base];
            if ( kind === undefined || args.length !== 2 || String(args[1]).trim() !== SCRIPTLET_POLICY.NOW_VALUE_TOKEN ) { return null; }
            return isBoundedKey(args[0]) ? { name: SCRIPTLET_POLICY.SET_STORAGE_ITEM_NOW_NAME, args: [ kind, String(args[0]) ] } : null;
        },
    }),
    Object.freeze({
        // site##+js(trusted-set-attr, selector, data-x, word) — a page probe ("data-allok=y"). Only data-* names and a
        // short plain word, which a browser never runs as code.
        trustedName: 'trusted-set-attr',
        replace(base, args) {
            if ( args.length !== 3 || String(args[0]).trim() === '' ) { return null; }
            const [ selector, attr, value ] = args.map(String);
            if ( SCRIPTLET_POLICY.DATA_ATTR_NAME_RE.test(attr) === false || SCRIPTLET_POLICY.DATA_ATTR_VALUE_RE.test(value) === false ) { return null; }
            return { name: SCRIPTLET_POLICY.SET_DATA_ATTR_NAME, args: [ selector, attr, value ] };
        },
    }),
    Object.freeze({
        // Trusted setter -> non-trusted AdGuard twin (TWINS above), all arguments kept.
        trustedName: null,
        replace(base, args) {
            const spec = SCRIPTLET_POLICY.TWINS[base];
            if ( spec === undefined || args.length !== spec.argCount ) { return null; }
            if ( isBoundedKey(args[0]) === false ) { return null; }
            if ( (spec.valueRe ?? SCRIPTLET_POLICY.TWIN_VALUE_RE).test(String(args[spec.valueAt]).trim()) === false ) { return null; }
            return { name: spec.twin, args: args.map(String) };
        },
    }),
]);

// The scriptlet's own name without uBO's alias spellings: "ubo-x.js" / "ubo-x" / "x.js" -> "x" (lower case).
// (audit 10.6.4) Shared by rules A and D, so an alias spelling can never slip past either one — e.g. the build turns
// uBO's `##+js(trusted-x, …)` into AdGuard's `ubo-trusted-x`, which the old prefix test did not see as trusted.
export function baseScriptletName(name) {
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
        'set-data-attr':                  [ 2 ],    // (11.1.3) project scriptlet: selector, data-attribute, VALUE
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

// Rule A's safe replacement (see SAFE_SCRIPTLET_REPLACEMENTS): { name, args } of the project scriptlet that does the
// same job, or null when this trusted rule has no safe equivalent. Pure.
export function safeReplacementFor(name, args) {
    if ( typeof name !== 'string' || Array.isArray(args) === false ) { return null; }
    const base = baseScriptletName(name);
    for ( const entry of SAFE_SCRIPTLET_REPLACEMENTS ) {
        if ( entry.trustedName !== null && entry.trustedName !== base ) { continue; }
        const safe = entry.replace(base, args);
        if ( safe !== null ) { return safe; }
    }
    return null;
}

// For rules that do NOT come from an AdGuard Team source (Custom Rules, ABP import): rule D refuses the blocked
// families, rule A every trusted scriptlet, then rules B and C. Returns the message to show the user, or null.
export function scriptletRuleRejection(name, args) {
    if ( isBlockedScriptletFamily(name) ) {
        return `Scriptlet "${name}" refused: ${SCRIPTLET_POLICY.REASON_BLOCKED_FAMILY}.`;
    }
    if ( requiresTrust(name) ) {
        // (11.1.3) Point the user to the safe equivalent when this exact rule has one.
        const safe = safeReplacementFor(name, Array.isArray(args) ? args : []);
        return safe === null
            ? `Scriptlet "${name}" needs trust and is only accepted from AdGuard filter lists, not from own rules.`
            : `Scriptlet "${name}" needs trust and is only accepted from AdGuard filter lists. ` +
              `Use ${safe.name}(${safe.args.join(', ')}) instead: it does the same here without needing trust.`;
    }
    const violation = scriptletPolicyViolation(name, args);
    return violation === null ? null : `Scriptlet "${name}" refused: ${violation}.`;
}
