#!/usr/bin/env node
/*
 * build-autodeny-bundle.mjs — compiles js/scripting/autodeny-snippets.generated.js
 *
 * Reads (read-only, vendored — D2):
 *   vendor/autoconsent/eval-snippets.js  — FNS, the reject-all action functions
 *   vendor/autoconsent/rules/rules.json  — CMP detection signatures + which
 *                                          FNS key each one maps to
 *
 * Writes:
 *   js/scripting/autodeny-snippets.generated.js — a single static file,
 *   registered MAIN-world by js/core/scripting-manager.js's
 *   registerCookieClickerAutoDenyContentScriptsImpl() ONLY while a
 *   session is active (D11) — see that function's own header.
 *
 * Guard: fails loudly (non-zero exit) if
 * eval-snippets.js's content hash doesn't match the recorded value below —
 * a deliberate trip-wire so an accidental, unreviewed edit to the
 * vendored file can't silently ship. Run with --update-hash after a
 * conscious, reviewed change to eval-snippets.js to record the new hash.
 *
 * Usage:
 *   node tools/build-autodeny-bundle.mjs               # build, verify hash
 *   node tools/build-autodeny-bundle.mjs --update-hash  # record new hash, then build
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/******************************************************************************/
// Config — declared once, here.
/******************************************************************************/

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_SNIPPETS_PATH = join(ROOT, 'vendor/autoconsent/eval-snippets.js');
const RULES_PATH = join(ROOT, 'vendor/autoconsent/rules/rules.json');
// (10.7.1) Two bundles from ONE template — the person's cookie-clean-up setting picks which one is registered
// (js/data/cookie-banner-action.js). Each lists exactly the FNS it calls: decline = every rule's `action`,
// accept = ACCEPT_FN with each rule's `accept` data. Paths must match COOKIE_BANNER_BUNDLES there.
const ACCEPT_FN = 'EVAL_ACCEPT_ALL';
const BUNDLES = Object.freeze([
    Object.freeze({ mode: 'decline', outputPath: join(ROOT, 'js/scripting/autodeny-snippets.generated.js'),
        fileName: 'autodeny-snippets.generated.js', what: 'decline ("reject all")' }),
    Object.freeze({ mode: 'accept', outputPath: join(ROOT, 'js/scripting/autoaccept-snippets.generated.js'),
        fileName: 'autoaccept-snippets.generated.js', what: 'accept ("accept all")' }),
]);

// RECORDED_HASH — the sha256 of eval-snippets.js at the last conscious,
// reviewed re-vendor. Update ONLY via `--update-hash`, never by hand —
// see this file's own header for why the trip-wire exists at all.
const RECORDED_HASH = '41ecaf63ded3d6ad686750197d481ad63323bff75918ed7dbeb4dfd8e8a3a8ab'; // vendor/autoconsent/eval-snippets.js @ 11.0.0 (added EVAL_GOOGLEFC_REJECT — Google Funding Choices, owner's bbc.com report; no other function changed). Previous: f9e63bd8… @ 10.7.16 (EVAL_HIDE_ONLY, accept.hideOnly)

// Must match js/scripting/cookie-clicker-click.js's own
// PRECEDENCE_MARKER_ATTR constant exactly (D5) — the DOM attribute the
// two different-JS-world scripts use as their one shared signal.
const PRECEDENCE_MARKER_ATTR = 'data-ubol-cookie-clicker-rule';
// (10.4.9) Set by js/scripting/cookie-clicker-precedence.js (must match its PRECEDENCE_PENDING_ATTR) while it is
// still deciding whether this frame belongs to a cookie-clicker rule site. Present = "not decided yet": the bundle
// skips this pass and retries on its normal schedule — so it can never act before that decision.
const PRECEDENCE_PENDING_ATTR = 'data-ubol-cookie-clicker-pending';

// D4 — bounded retry/poll: CMP globals may not exist yet at the moment
// this script first runs. RETRY_INTERVAL_MS between attempts,
// RETRY_MAX_ATTEMPTS total, giving a RETRY_INTERVAL_MS * RETRY_MAX_ATTEMPTS
// = 1500 * 8 = 12s window — comfortably covers a CMP script that's still
// loading, bounded so a page that never shows a recognized CMP doesn't
// leave a live interval running for the rest of its lifetime.
const RETRY_INTERVAL_MS = 1500;
const RETRY_MAX_ATTEMPTS = 8;

/******************************************************************************/

function computeHash(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadFns(source) {
    // Extract the FNS object literal's function bodies WITHOUT executing
    // the vendored file as a module import (this script has no bundler
    // and eval-snippets.js's own `export` statement isn't meaningful
    // outside a module context anyway).
    //
    // FIX (8.2.25): the original approach was a naive non-greedy regex
    // (`([\s\S]*?)\n\s*},`) that stopped at the FIRST `\n<indent>},` it
    // found — fine for every function that was a single flat try/catch,
    // but broke the instant a function contained its own nested closure
    // ending in the same shape (e.g. `setTimeout(() => { ... }, 300);`,
    // added this version for Quantcast/CookieFirst/Cookie Script/Ketch —
    // each of those has an inner `}, <ms>);` that the old regex matched
    // as if it were the OUTER function's own closing brace, silently
    // truncating the extracted body mid-function and producing invalid
    // JS in the generated bundle). Replaced with real brace-depth
    // counting: find each `KEY: function() {`, then walk forward
    // tracking `{`/`}` depth (skipping the contents of any string
    // literal, so a `{`/`}` character INSIDE a string — e.g. inside one
    // of the CSS selector strings these functions are full of — never
    // miscounts) until depth returns to zero, which is the function's
    // real closing brace regardless of how much nesting is inside it.
    // BUG FIXED (v8.6.2): character class was [A-Z_]+ — didn't allow
    // digits, so any EVAL_ constant name containing one (EVAL_
    // TYPO3COOKIEMAN_REJECT's "3", EVAL_STCMPV2_REJECT's "2") silently
    // failed to match this header pattern at all, permanently skipping
    // that function — not a brace-counting bug (the depth-counter below
    // never even got a chance to run for these two), the header regex
    // itself just never found them. Confirmed by testing the exact old
    // pattern directly against the real file before concluding this was
    // the cause, not guessed. Caught via tools/self-test.mjs's own
    // rules.json-vs-bundle count check surfacing a genuine 44-vs-42
    // mismatch, itself only newly visible after removing that check's
    // own now-defunct cookie-clicker-detect.js comparison (v8.6.2) which
    // had been sitting alongside it.
    const fns = {};
    // (10.7.1) an optional single parameter — EVAL_ACCEPT_ALL(rule) — is captured and re-emitted.
    const headerRe = /(EVAL_[A-Z0-9_]+):\s*function\s*\(\s*([a-z]*)\s*\)\s*\{/g;
    let m;
    while ( (m = headerRe.exec(source)) !== null ) {
        const key = m[1];
        const param = m[2];
        const bodyStart = headerRe.lastIndex; // just past the opening '{'
        let depth = 1;
        let i = bodyStart;
        let inString = null; // one of `'`, `"`, or '`' while inside a string/template literal, else null
        for ( ; i < source.length && depth > 0; i++ ) {
            const ch = source[i];
            if ( inString !== null ) {
                if ( ch === '\\' ) { i++; continue; } // skip escaped char, including an escaped quote
                if ( ch === inString ) { inString = null; }
                continue;
            }
            // FIX (8.2.25, round 2): `//` line comments must be skipped
            // entirely, not scanned character-by-character — an ordinary
            // English apostrophe in a comment ("doesn't", "CMP's own",
            // etc., which this project's own comments use constantly)
            // was being misread as OPENING a string literal, silently
            // swallowing every real `{`/`}` until the next apostrophe
            // happened to close it — sometimes hundreds of lines and
            // several whole functions later. Confirmed as the actual
            // cause of a real, shipped bug: EVAL_TERMLY_REJECT's own
          // comment ("scoped to `document` here") plus later comments'
            // ordinary contractions left the scanner's string-tracking
            // state corrupted for the rest of the file, truncating
            // extraction at 7 of 24 functions with no error until the
            // generated bundle failed to even parse.
            if ( ch === '/' && source[i + 1] === '/' ) {
                const nl = source.indexOf('\n', i);
                i = nl === -1 ? source.length : nl; // for-loop's own i++ lands just past the newline
                continue;
            }
            if ( ch === '\'' || ch === '"' || ch === '`' ) { inString = ch; continue; }
            if ( ch === '{' ) { depth++; }
            else if ( ch === '}' ) { depth--; }
        }
        // i is now just past the function's real closing '}'; body is
        // everything between bodyStart and that closing brace (exclusive).
        fns[key] = { param, body: source.slice(bodyStart, i - 1) };
        headerRe.lastIndex = i; // resume scanning after this function
    }
    return fns;
}

function main() {
    const updateHash = process.argv.includes('--update-hash');

    const evalSnippetsSource = readFileSync(EVAL_SNIPPETS_PATH, 'utf8');
    const actualHash = computeHash(evalSnippetsSource);

    if ( updateHash === false && RECORDED_HASH !== '__PENDING__' && actualHash !== RECORDED_HASH ) {
        console.error(
            '[build-autodeny-bundle] eval-snippets.js content hash mismatch.\n' +
            `  recorded: ${RECORDED_HASH}\n` +
            `  actual:   ${actualHash}\n` +
            'This means the vendored file changed without a conscious re-vendor step.\n' +
            'Review the change, then re-run with --update-hash if intentional.'
        );
        process.exit(1);
    }
    if ( updateHash ) {
        console.log(`[build-autodeny-bundle] Recorded hash: ${actualHash}`);
        console.log('Paste this into RECORDED_HASH at the top of this script.');
    }

    const fns = loadFns(evalSnippetsSource);
    const rulesDoc = JSON.parse(readFileSync(RULES_PATH, 'utf8'));

    if ( fns[ACCEPT_FN] === undefined ) {
        console.error(`[build-autodeny-bundle] ${ACCEPT_FN} missing from eval-snippets.js`);
        process.exit(1);
    }
    for ( const bundle of BUNDLES ) {
        writeBundle(bundle, fns, rulesDoc);
    }
}

// One generated file per mode — same template; only the action table and the rules' action field differ.
function writeBundle({ mode, outputPath, fileName, what }, fns, rulesDoc) {
    const actionable = rulesDoc.rules.filter(r => r.action !== null && fns[r.action] !== undefined);
    const rulesForBundle = actionable.map(r => ({ name: r.name, detect: r.detect, hideSelector: r.hideSelector ?? null,
        action: mode === 'accept' ? ACCEPT_FN : r.action,
        ...(mode === 'accept' ? { accept: r.accept ?? {} } : {}) }));
    const usedKeys = [ ...new Set(rulesForBundle.map(r => r.action)) ];
    const fnsBody = usedKeys
        .map(key => `    ${key}: function(${fns[key].param}) {${fns[key].body}\n    },`)
        .join('\n');

    const output = `/*
 * ${fileName} — BUILD-TIME GENERATED, DO NOT EDIT BY HAND.
 * Mode: ${what} — the bundle registered while the person ${mode === 'accept' ? 'DOES' : 'does NOT'} delete cookies at every
 * browser start (js/data/cookie-banner-action.js).
 * Regenerate via: node tools/build-autodeny-bundle.mjs
 * Source: vendor/autoconsent/eval-snippets.js + vendor/autoconsent/rules/rules.json
 *
 * LICENSE — MIXED, per-entry (see THIRD_PARTY_LICENSES.md and
 * vendor/autoconsent/rules/rules.json's own _provenance field): some of
 * the functions/rules compiled into this file are adapted from
 * duckduckgo/autoconsent's own MPL-2.0 code, others independently
 * hand-authored. vendor/autoconsent/LICENSE (MPL-2.0 text) covers the
 * former, per MPL-2.0 §3.1's own directory-level-notice allowance.
 *
 * Registered MAIN-world, allFrames:true, ONLY while a "Never consent"
 * session is active — js/core/scripting-manager.js's
 * registerCookieClickerAutoDenyContentScriptsImpl() (D11: registration-
 * presence IS the gate, no in-bundle runtime skip check).
 */
(() => {
    "use strict";

    // Precedence (D5) — a saved per-site cookie-clicker rule always wins;
    // see js/scripting/cookie-clicker-click.js's own PRECEDENCE_MARKER_ATTR
    // comment for why a DOM attribute is this cross-world signal.
    const PRECEDENCE_MARKER_ATTR = ${JSON.stringify(PRECEDENCE_MARKER_ATTR)};
    const PRECEDENCE_PENDING_ATTR = ${JSON.stringify(PRECEDENCE_PENDING_ATTR)};
    const RETRY_INTERVAL_MS = ${RETRY_INTERVAL_MS};
    const RETRY_MAX_ATTEMPTS = ${RETRY_MAX_ATTEMPTS};
    // (8.2.21) — after the fast retry window above gives up, fall back to
    // a much lower-frequency, MutationObserver-driven watch for up to
    // this long before finally giving up for good. Exists specifically
    // for two realistic cases neither previous window covered: an SPA
    // that swaps in new content (including a consent banner) well after
    // the original page load, and a third-party CMP script that's simply
    // slower than RETRY_MAX_ATTEMPTS * RETRY_INTERVAL_MS on a particular
    // page (ad-heavy article pages vary a lot). Generous enough to cover
    // realistic article-reading dwell time, but still finite — this file
    // must never watch indefinitely for the lifetime of a long-lived tab.
    const EXTENDED_WATCH_MS = 5 * 60 * 1000; // 5 minutes

    const FNS = {
${fnsBody}
    };

    const RULES = ${JSON.stringify(rulesForBundle, null, 4)};

    // Opt-in debug logging — reuses the EXACT SAME cookie
    // cookie-clicker-click.js already established for this project
    // (per ARCHITECTURE.md's reuse-not-reinvent principle), so one flag
    // toggles diagnostics for both the manual click interpreter and this
    // generic auto-deny bundle:
    //   document.cookie = 'uBolCookieClickerDebug=1; path=/; max-age=3600'
    // then reload. Plain cookie, not sessionStorage — see that file's own
    // header for why (DevTools console context can default to a
    // sandboxed third-party iframe).
    let DEBUG = false;
    try {
        DEBUG = document.cookie.split('; ').includes('uBolCookieClickerDebug=1');
    } catch {}
    function logDebug(...args) {
        if ( DEBUG === false ) { return; }
        console.info('[uBlock-Dynamic autodeny]', location.hostname, ...args);
    }

    function hasPrecedenceMarker() {
        try {
            return document.documentElement.hasAttribute(PRECEDENCE_MARKER_ATTR);
        } catch {
            return false; // guard: a denied DOM read never blocks the generic fallback
        }
    }

    // (10.4.9) The precedence decision for this frame is still pending (see PRECEDENCE_PENDING_ATTR).
    function isPrecedencePending() {
        try {
            return document.documentElement.hasAttribute(PRECEDENCE_PENDING_ATTR);
        } catch {
            return false; // guard: a denied DOM read never blocks the generic fallback
        }
    }

    // Cosmetic-hide fallback (v8.2.8 — Option A, see NEVER-CONSENT-
    // DESIGN.md's own note on this decision): applied AFTER firing the
    // real reject action above, never instead of it — this never records
    // or implies any consent choice, it's a pure, reversible CSS
    // display:none on the CMP's own banner root element (reusing
    // rule.hideSelector when present, else rule.detect.selector — see
    // rules.json's own header on why these two are sometimes
    // deliberately DIFFERENT: hideSelector (8.2.14) can be broader/less
    // CMP-specific than what's safe to also use for detection, e.g.
    // Sourcepoint's own backdrop on bbc.com using generic class names
    // like '.message-overlay' that would risk false-positive DETECTION
    // on an unrelated site if used for that purpose too).
    function hideBannerContainer(rule) {
        const selector = rule.hideSelector || rule.detect.selector;
        if ( !selector ) { return false; }
        let hidAny = false;
        try {
            const nodes = document.querySelectorAll(selector);
            for ( const node of nodes ) {
                node.style.setProperty('display', 'none', 'important');
                hidAny = true;
            }
        } catch {}
        return hidAny;
    }

    function matchesRule(rule) {
        try {
            if ( rule.detect.global && window[rule.detect.global] !== undefined ) { return true; }
            if ( rule.detect.selector && document.querySelector(rule.detect.selector) ) { return true; }
        } catch {}
        return false;
    }

    function tryOnce() {
        if ( hasPrecedenceMarker() ) {
            logDebug('precedence marker present — a saved rule covers this frame, not firing generic bundle');
            return { precedence: true, matched: [] };
        }
        if ( isPrecedencePending() ) {
            logDebug('precedence decision still pending for this frame — skipping this pass, retrying later');
            return { precedence: false, matched: [] };
        }
        const matched = [];
        for ( const rule of RULES ) {
            if ( matchesRule(rule) === false ) { continue; }
            const fn = FNS[rule.action];
            if ( typeof fn !== 'function' ) {
                logDebug(\`matched CMP "\${rule.name}" but no action fn "\${rule.action}" found — bundle/rules mismatch\`);
                continue;
            }
            logDebug(\`matched CMP "\${rule.name}" — firing \${rule.action}\`);
            try { fn(rule); } catch (reason) { logDebug(\`\${rule.action} threw:\`, reason); }
            const cosmeticHide = hideBannerContainer(rule);
            if ( cosmeticHide ) { logDebug(\`also cosmetically hid "\${rule.name}"'s banner container (Option A fallback)\`); }
            matched.push({ name: rule.name, cosmeticHide });
        }
        if ( matched.length === 0 ) { logDebug('no known CMP matched on this pass'); }
        return { precedence: false, matched };
    }

    // GUARD — init/clear/release around every piece of state this file
    // owns: the fast-retry interval, the extended-watch MutationObserver
    // (8.2.21), and its own overall timeout — all torn down together
    // from this single stop(), whichever condition ends the session
    // first (a match, precedence, or either window's own budget
    // expiring). Same convention cookie-clicker-click.js's own
    // stopObserving() documents for its own MutationObserver.
    let attempts = 0;
    let intervalHandle;
    let observerHandle;
    let extendedWatchTimeoutHandle;
    function stop() {
        if ( intervalHandle !== undefined ) {
            clearInterval(intervalHandle);
            intervalHandle = undefined;
        }
        if ( observerHandle !== undefined ) {
            observerHandle.disconnect();
            observerHandle = undefined;
        }
        if ( extendedWatchTimeoutHandle !== undefined ) {
            clearTimeout(extendedWatchTimeoutHandle);
            extendedWatchTimeoutHandle = undefined;
        }
    }

    // Re-injection guard (8.2.21) — mirrors js/scripting/cookie-clicker-
    // picker.js's own self.__uBolCookieClickerPicker sentinel pattern
    // exactly. This file can genuinely be injected twice into the SAME
    // already-loaded frame without a navigation in between — e.g. the
    // person re-opens the action dialog and clicks "Never consent" again
    // on a tab where a previous instance's extended watch is still
    // running. Without this guard, two independent instances would run
    // concurrently in the same frame: each polling/observing and
    // potentially firing a reject action redundantly, wasting resources
    // and risking a double-fire against some CMP's own idempotency-
    // sensitive flow. Tearing down the PREVIOUS instance first, rather
    // than letting both run, keeps exactly one live instance per frame
    // at all times.
    if ( self.__uBolAutodenyBundle ) {
        self.__uBolAutodenyBundle.stop();
    }
    self.__uBolAutodenyBundle = { stop };

    function startExtendedWatch() {
        // MutationObserver — catches a banner that appears well after the
        // fast-retry window gave up, without needing to poll tightly for
        // the whole EXTENDED_WATCH_MS budget. Guarded: if the browser
        // denies observer creation for some reason, this degrades to
        // "no extended watch" rather than throwing into the caller.
        try {
            observerHandle = new MutationObserver(() => {
                const r = tryOnce();
                if ( r.precedence || r.matched.length > 0 ) { stop(); }
            });
            observerHandle.observe(document.documentElement, { childList: true, subtree: true });
        } catch {
            observerHandle = undefined;
        }
        // Hard overall cap — see EXTENDED_WATCH_MS's own comment above on
        // why this must stay finite.
        extendedWatchTimeoutHandle = self.setTimeout(() => {
            logDebug(\`gave up after extended watch window (\${EXTENDED_WATCH_MS / 1000}s) — no known CMP ever matched\`);
            stop();
        }, EXTENDED_WATCH_MS);
    }

    logDebug('bundle injected, running immediate pass');
    const immediateResult = tryOnce();
    if ( immediateResult.precedence === false && immediateResult.matched.length === 0 ) {
        intervalHandle = setInterval(() => {
            attempts += 1;
            const r = tryOnce();
            if ( r.precedence || r.matched.length > 0 ) {
                stop();
                return;
            }
            if ( attempts >= RETRY_MAX_ATTEMPTS ) {
                logDebug(\`fast-retry window ended after \${RETRY_MAX_ATTEMPTS} attempts — falling back to a longer, lower-frequency watch (SPA content changes / slow-loading CMP scripts)\`);
                stop(); // clears the fast interval only — observer/timeout not yet set
                startExtendedWatch();
            }
        }, RETRY_INTERVAL_MS);
    }
    // Completion value (8.2.7) — collected per-frame by the caller's own
    // executeScript() return value (same InjectionResult mechanism a
    // one-off detection script would rely on for the same reason — see
    // e.g. how js/workflow/cookie-clicker-routes.js's own
    // handleCookieClickerLaunchPicker() used to collect a per-frame
    // result this same way, before that specific detection pass was
    // removed as dead weight in v8.6.2), so
    // js/workflow/cookie-clicker-routes.js's handleCookieClickerAutoDenyStart()
    // can report the REAL immediate-pass outcome back to the on-page
    // toast — not just "the message was sent", which told the person
    // nothing about whether an actual click happened. Only reflects the
    // IMMEDIATE, synchronous pass; a later retry-loop or extended-watch
    // match isn't reflected here, since execution has already returned to
    // the caller by then — the toast's own copy accounts for this (see
    // that file's own comment).
    return immediateResult;
})();
`;

    writeFileSync(outputPath, output, 'utf8');
    console.log(`[build-autodeny-bundle] Wrote ${outputPath} (${rulesForBundle.length} CMP rule(s), ${usedKeys.length} action fn(s)).`);
}

main();
