/*
 * eslint.config.mjs — flat config for uBol-stripped.
 *
 * The codebase mixes three genuinely different script contexts (verified
 * against the actual <script> tags and manifest.json before writing this,
 * not assumed):
 *   1. ES modules — service worker (background.js), page contexts loaded
 *      with <script type="module">: dashboard/, popup/, picker/, matrix/,
 *      privacy/ (the two panel pages; NOT privacy/privacy-probe.js and
 *      privacy/privacy-bridge.js, which are classic content scripts — see
 *      group 2),
 *      js/offscreen/, js/ui/, js/core/, js/data/, js/util/.
 *   2. Classic scripts — js/scripting/, js/security/ and the two
 *      privacy/privacy-{probe,bridge}.js content scripts, injected via
 *      chrome.scripting.executeScript() as self-contained IIFEs (see
 *      ARCHITECTURE.md's C15 exception note). No import/export; page-global
 *      scope (self, document, location, etc.).
 *   3. Node.js — tools/build-rulesets.mjs (build-time only, never shipped).
 *
 * Deliberately excluded: lib/ (vendored third-party code, not ours to
 * lint), rulesets/ (generated build output).
 *
 * Rule set is intentionally moderate, not maximal: this is a solo-
 * maintainer project, so the goal is catching real bugs (unused vars,
 * undefined globals, unreachable code) rather than enforcing a large
 * stylistic rulebook that would fight the codebase's existing,
 * consistent 4-space/semicolon/=== style rather than protect it.
 */

import js from '@eslint/js';

const browserExtensionGlobals = {
    // WebExtension APIs
    chrome:  'readonly',
    browser: 'readonly',
    self:    'readonly',
    // DOM/browser globals used throughout page contexts and content scripts
    window:          'readonly',
    document:        'readonly',
    location:        'readonly',
    navigator:       'readonly',
    Navigator:       'readonly', // the interface/constructor, e.g. Navigator.prototype — distinct from the lowercase instance global above; see js/security/sec-gpc.js
    console:         'readonly',
    fetch:           'readonly',
    URL:             'readonly',
    URLSearchParams: 'readonly',
    CustomEvent:     'readonly', // v9.7.3 — used by privacy/privacy-probe.js + privacy-bridge.js (real browser global; surfaced when those two files came under lint)
    Blob:            'readonly',
    confirm:         'readonly',
    CSSStyleSheet:   'readonly',
    MutationObserver:'readonly',
    IntersectionObserver: 'readonly',
    customElements:  'readonly',
    getComputedStyle:'readonly',
    setTimeout:      'readonly',
    clearTimeout:    'readonly',
    setInterval:     'readonly',
    clearInterval:   'readonly',
    queueMicrotask:  'readonly',
    structuredClone: 'readonly',
    globalThis:      'readonly',
    TextEncoder:     'readonly',
    TextDecoder:     'readonly',
    // Found missing by actually running the linter against this codebase
    // (uBol-stripped-code-review.md §3a) — not assumed up front, same as
    // every other entry in this object.
    localStorage:      'readonly',
    AbortController:   'readonly',
    performance:       'readonly',
    CSS:               'readonly',
    HTMLAnchorElement: 'readonly',
    // Same "found by actually running the linter" provenance, added
    // alongside the cookie/consent-clicker feature: `crypto` (Web Crypto
    // API — available in both the service worker global scope and page/
    // content-script contexts; used by js/core/cookie-clicker-rules.js's
    // newRuleId()) and `MouseEvent` (DOM event constructor — used by
    // js/scripting/cookie-clicker-click.js's synthetic-click dispatch).
    crypto:            'readonly',
    MouseEvent:        'readonly',
    // DOM interface types (used in instanceof checks / type positions, not
    // just as values) — found by actually running the linter against this
    // codebase, not assumed up front.
    Element:            'readonly',
    HTMLElement:         'readonly',
    HTMLCanvasElement:   'readonly',
    DocumentFragment:    'readonly',
    Document:            'readonly',
    ShadowRoot:          'readonly',
    Window:              'readonly',
    EventTarget:         'readonly',
    DOMParser:           'readonly',
    MessageChannel:      'readonly',
    Event:               'readonly',
    BroadcastChannel:    'readonly',
    XPathResult:         'readonly',
};

const commonRules = {
    ...js.configs.recommended.rules,
    // Consistent with the codebase's existing style (verified: already
    // used throughout) — flag accidental var/loose-equality, don't
    // silently allow patterns the codebase doesn't already use.
    'no-var':      'error',
    // C9a (programming-principles audit doc) — named functions must use
    // the `function` keyword, not `const name = () => {}`/`const name =
    // function() {}`. Was 'warn' while 86 pre-existing violations were
    // cleaned up (verified: each converted case checked via real AST
    // analysis for `this`/`arguments`/`super` usage before touching it —
    // 0 of 84 depended on any of the three, so the mechanical conversion
    // couldn't silently change behavior). Now 'error' — no known
    // violations remain; a new one is a real regression, not debt.
    // Anonymous callbacks with no name (dom.on(..., async ev => {}),
    // .then(x => ...)) are unaffected — this rule only fires on a NAMED
    // function written the wrong way.
    'func-style':  [ 'error', 'declaration' ],
    'eqeqeq':      [ 'error', 'always' ],
    'no-unused-vars': [ 'warn', {
        args: 'none',            // many callbacks intentionally ignore unused params (e.g. (err) => {})
        varsIgnorePattern: '^_',  // explicit-intent-to-ignore convention
    } ],
    // Real-bug catchers, not style preferences.
    'no-undef':          'error',
    'no-unreachable':    'error',
    'no-dupe-keys':      'error',
    'no-dupe-args':      'error',
    'no-fallthrough':    'error',
    'no-const-assign':   'error',
    'no-self-compare':   'error',
    'no-constant-condition': [ 'error', { checkLoops: false } ],  // `for (;;)` idiom is used deliberately (see block-monitor.js watchdog)
    // `catch { }` (silently swallow an error) is a deliberate, pervasive
    // idiom in this codebase (regex-compile fallbacks, best-effort DOM
    // operations) — verified by sampling multiple hits before disabling
    // this check for catch blocks specifically. Still flags other empty
    // blocks (if/for/function), which are more likely to be real mistakes.
    'no-empty': [ 'error', { allowEmptyCatch: true } ],
    // Disabled, not just left at default — both verified false-positive-
    // prone against this codebase's real patterns rather than left on
    // blind faith in the rule:
    //   no-useless-assignment: flags the deliberate `iota = 0;` reset
    //     idiom before every enum sequence (see filter-ast-constants.js's
    //     header comment) and loop-initialized parser state variables
    //     (e.g. `next`/`prev` in static-filtering-parser.js's tokenizer) —
    //     the rule's flow analysis doesn't trace these loop back-edges
    //     correctly. Sampled multiple hits of both categories; found no
    //     real bug among them.
    //   no-control-regex: every hit is a filter-list-parser regex that
    //     legitimately needs to match control characters (\x00-\x1F) as
    //     part of parsing raw, potentially-malformed filter-list text —
    //     that's the actual job of this code, not a mistake.
    'no-useless-assignment': 'off',
    'no-control-regex':      'off',
};

export default [
    // (11.1.4) web_accessible_resources/google-ima.js is uBO's/Mozilla's IMA surrogate, shipped with its code unchanged
    // (THIRD_PARTY_LICENSES.md) — vendored like lib/**, so it is not held to this project's style rules.
    { ignores: [ 'lib/**', 'rulesets/**', 'node_modules/**', 'js/generated/**', 'js/resources/ag-scriptlets-corelibs.json', 'web_accessible_resources/google-ima.js' ] },

    // ── ES modules (service worker + page contexts + shared modules) ──────
    {
        files: [
            'js/workflow/**/*.js',
            'js/core/**/*.js',
            'js/data/**/*.js',
            'js/util/**/*.js',
            'js/ui/**/*.js',
            'js/offscreen/**/*.js',
            'dashboard/**/*.js',
            'popup/**/*.js',
            'picker/**/*.js',
            // v9.7.3 — was 'monitor/**/*.js', a directory that no longer
            // exists (the Monitor panels became matrix/ and privacy/), so
            // matrix/ and privacy/ silently ran under NONE of these rules
            // (found by tracing why func-style never flagged
            // `const tick = () =>` there). privacy-probe.js/privacy-bridge.js
            // sit in privacy/ but are classic scripts; the classic block
            // below comes later in this array and overrides sourceType for
            // exactly those two files.
            'matrix/**/*.js',
            'privacy/**/*.js',
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType:  'module',
            globals:     browserExtensionGlobals,
        },
        rules: commonRules,
    },

    // ── Classic injected content scripts (no import/export) ───────────────
    {
        files: [
            'js/scripting/**/*.js',
            // (10.7.6) 'js/security/**/*.js' removed: the folder was deleted in 10.5.0 (ARCHITECTURE.md).
            // Registered via chrome.scripting.registerContentScripts() in
            // js/core/privacy-inspector.js (js: [ '/privacy/privacy-probe.js' ]
            // / '/privacy/privacy-bridge.js') — no import/export.
            'privacy/privacy-probe.js',
            'privacy/privacy-bridge.js',
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType:  'script',
            globals:     browserExtensionGlobals,
        },
        rules: commonRules,
    },

    // ── Vendored, unmodified third-party code (uBol-stripped-code-review.md
    // §3d) ──────────────────────────────────────────────────────────────────
    // js/util/punycode.js is mathias's punycode.js v1.3.2, verbatim. Its
    // var/== style predates and is unrelated to this project's own
    // conventions; "fixing" it here would just be a stylistic diff against
    // upstream with no functional benefit, and would make future upstream
    // updates harder to diff. Scoped to exactly this one file (not a
    // blanket ignore) so it still gets every other check (no-undef,
    // no-unreachable, etc.) — only the vendor-style rules are relaxed, and
    // only for this file.
    {
        files: [ 'js/util/punycode.js' ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType:  'module',
            globals:     browserExtensionGlobals,
        },
        rules: {
            ...commonRules,
            'no-var':         'off',
            'eqeqeq':         'off',
            'no-unused-vars': 'off',
        },
    },

    // ── Node.js build tooling (never shipped in the extension package) ────
    {
        files: [ 'tools/**/*.mjs', 'eslint.config.mjs' ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType:  'module',
            globals: {
                process:         'readonly',
                console:         'readonly',
                fetch:           'readonly',
                // Node 18+ global — tools/lib/fetch-with-retry.mjs's
                // per-attempt download timeout.
                AbortSignal:     'readonly',
                // Node 18+ global — tools/lib/fetch-record-replay.mjs
                // rebuilds recorded responses.
                Response:        'readonly',
                Buffer:          'readonly',
                URL:             'readonly',
                setTimeout:      'readonly',
                clearTimeout:    'readonly',
                // 'writable', not 'readonly' — tools/test-*.mjs assign to
                // this directly (global.chrome = ..., global.window = ...)
                // to mock a browser environment for Node-executed module
                // dry-runs.
                global:          'writable',
            },
        },
        rules: commonRules,
    },
];
