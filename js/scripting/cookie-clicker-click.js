/*******************************************************************************

    uBlock-Stripped-Dynamic — Cookie/consent-clicker click interpreter
    Copyright (C) 2025-present Kees1958

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/Kees1958/uBol-stripped
*/

/******************************************************************************/
//
// Architecture note: this file runs in the page (content-script) execution
// context, registered by js/core/scripting-manager.js's
// registerCookieClickerContentScriptsImpl() with `allFrames: true`. That
// single flag is the entire fix for the bug COOKIE-CLICKER-DESIGN.md
// documents at length: without it, this script would only ever run in a
// page's TOP frame, and could never see into a cross-origin CMP iframe's
// DOM at all (a hard browser law, not a bug to work around). WITH it, this
// exact same script runs SEPARATELY inside every frame, including
// cross-origin ones — the click code just already lives in the same origin
// as the button, so no cross-frame reach is ever needed.
//
// This is deliberately NOT AdGuard's `trusted-click-element` scriptlet —
// see COOKIE-CLICKER-DESIGN.md's "The 'trusted-' scriptlet question —
// resolved" section for why that trust tier was investigated and found
// unnecessary: a plain element.click() needs no elevated browser
// permission, in any world, in any frame a script is injected into.
//
// ── STATE / GUARDS ───────────────────────────────────────────────────────
// This file owns exactly one piece of transient state per frame load: the
// MutationObserver instance `observer` (see waitAndClick() below). It is
// created once, on first need, and is ALWAYS disconnected — on a
// successful click, on running out of applicable rules, or when
// WAIT_TIMEOUT_MS elapses — via the single stopObserving() guard, so a
// frame that never finds its target element can't leave a live observer
// (and its retained closure references) running for the rest of that
// frame's lifetime. See stopObserving()'s own comment for the exact
// release points.
//
/******************************************************************************/

(async function uBOL_cookieClickerClick() {

/******************************************************************************/
// Config — every constant/magic-number this file uses, declared once,
// here, with the reasoning for its value. Nothing below this block should
// ever repeat a literal that belongs here.
/******************************************************************************/

// STORAGE KEY — must match js/core/cookie-clicker-rules.js's own
// STORAGE_KEY constant (that module owns every write to it) AND
// js/core/scripting-manager.js's own COOKIE_CLICKER_STORAGE_KEY (which
// only reads it, to decide whether to register this file at all). Three
// independent copies of one string, across three different execution
// contexts with no shared import surface between this file and the other
// two — same constraint, same "must match exactly" warning, as
// scripting-manager.js's COSMETIC_SPECIFIC_STORAGE_PREFIX already
// documents for the identical cross-file-agreement problem.
const STORAGE_KEY = 'cookieClicker.rules';

// (v8.6.16) Restored — a v8.6.15 correction removed this from the WRONG
// system: DPG Media should stay OUT of Worry-free/auto-deny (removed
// separately, staying removed — see CHANGELOG), but was always meant to
// remain here, in the always-on manual cookie-clicker system, per
// explicit clarification. This is NOT session-scoped — it's active
// unconditionally, the same way a user-created picker rule would be,
// independent of any Worry-free session state.
//
// Built-in rules — NOT user-created, never touch chrome.storage, never
// appear in "Manage custom rules" (deliberately kept out of that storage
// key entirely, so there's nothing there for the user to accidentally
// edit or delete). Merged with user-stored rules at read time below
// (siteRules computation) — built-ins first, then user rules, so a
// user-created rule for the same site simply adds to, never replaces,
// a built-in one.
//
// WHY THIS EXISTS: DPG Media's myprivacy.dpgmedia.nl consent wall was
// previously handled by eval-snippets.js's EVAL_DPGMEDIA_REJECT/ACCEPT
// (part of the Worry-free auto-deny system) — both removed (see
// CHANGELOG), since that whole path is now DPG-Media-free. This built-in
// entry is a separate, independent mechanism: clicks #pg-accept-btn
// ("Akkoord") directly, no poll/verify/reload machinery — the button is
// shown immediately on first load, so there's nothing to wait for.
//
// Locale-aware textFilter — DPG Media's own properties (AD.nl, NU.nl,
// Volkskrant.nl) are Dutch-language ("Akkoord"); French only when the
// browser itself reports a French locale, per explicit request.
// #pg-accept-btn is already a unique ID selector on its own, so
// textFilter here is a verification safeguard, not the primary match —
// if the button's actual text ever stops containing the expected word,
// this rule simply won't fire (findRuleTarget() below), rather than
// blindly clicking whatever currently has that id.
function resolveDpgMediaAcceptTextFilter() {
    try {
        const lang = (navigator.language || '').toLowerCase();
        // Lowercase, no apostrophe — findRuleTarget()'s textContent.includes()
        // match is case-sensitive and would break on an apostrophe-glyph
        // mismatch ('J'accepte' vs 'J’accepte'); 'accepte' matches either
        // typographic style as a plain substring. Not yet verified against
        // a live French-locale render of this page — flagged here so a
        // future report of this NOT matching has somewhere to start.
        if ( lang.startsWith('fr') ) { return 'accepte'; }
    } catch {
    }
    return 'Akkoord';
}

const BUILTIN_SITE_RULES = {
    'myprivacy.dpgmedia.nl': [
        {
            frameHostname: 'myprivacy.dpgmedia.nl',
            selector: '#pg-accept-btn',
            shadowHostSelector: null,
            textFilter: resolveDpgMediaAcceptTextFilter(),
            enabled: true,
        },
    ],
};

// How long (ms) this frame keeps watching the DOM for a rule's target
// element before giving up. Cookie banners are frequently injected
// asynchronously (a CMP's own script fetching consent-category config
// before rendering anything) — a fixed, generous-but-bounded window
// beats both "click immediately, miss anything not yet rendered" and
// "watch forever, leak an observer on sites that never show the banner
// this visit (e.g. consent already recorded via cookie)".
const WAIT_TIMEOUT_MS = 8000;

// How long (ms) to wait, after the LAST mutation in a burst, before
// re-running findRuleTarget() against whatever rules are still
// unsatisfied. Real pages — especially ad-heavy ones — can produce
// dozens to hundreds of unrelated DOM mutations per second (ad
// creatives, autoplay players, tracking pixels); without coalescing,
// the observer callback below would run querySelectorAll on every
// single one of them for as long as WAIT_TIMEOUT_MS keeps it alive.
//
// Two values, picked at runtime (see MUTATION_DEBOUNCE_MS below,
// computed right after rules are loaded) rather than one fixed constant:
//   DEBOUNCE_MS_SINGLE_RULE (200ms)   — the common case, one rule for
//                                     this site. Short enough that a
//                                     real consent-banner reveal
//                                     (typically a single class/style
//                                     toggle, not an animation-driven
//                                     sequence) is still caught well
//                                     within a user's perception of
//                                     "instant".
//   DEBOUNCE_MS_MULTIPLE_RULES (500ms) — this site has MORE than one
//                                     saved rule, strongly suggesting a
//                                     sequential multi-popup flow (the
//                                     concrete case this was added for:
//                                     an age-verification gate, THEN a
//                                     separate cookie-consent banner).
//                                     The second popup typically needs
//                                     more real time to settle — the
//                                     first popup's own dismissal
//                                     animation/JS, THEN whatever the
//                                     site does to decide it's now safe
//                                     to render the second one — so a
//                                     longer per-mutation settle window
//                                     reduces the odds of re-checking
//                                     (and matching a still-transitional
//                                     DOM) too early.
const DEBOUNCE_MS_SINGLE_RULE = 200;
const DEBOUNCE_MS_MULTIPLE_RULES = 500;

// How long (ms) to wait BETWEEN two clicks fired within the same pass
// (e.g. an age-gate rule and a cookie-banner rule that both match at
// once). Added after real evidence, not a guess: a site's own console
// logged "sMainCatChoice is not set" — its OWN internal state, set by
// the first click, wasn't registered yet when the second click's
// handler read it a fraction of a millisecond later. A real person
// clicking two separate buttons always has a natural gap between
// clicks; firing both in the exact same JS tick (what this file
// originally did) has no equivalent in real usage, so it's plausible a
// site's own event handling genuinely doesn't expect it. 150ms is
// short enough to stay invisible in practice, long enough to cover any
// reasonable synchronous-or-microtask state update a site's own click
// handler might do.
const CLICK_SEQUENCE_DELAY_MS = 150;

// Click-verify-then-reload — see CHANGELOG.md's 7.17 entry for the real
// observed evidence this responds to: a rule worked on a page REFRESH
// but not on the FIRST load of the same page. That's the signature of
// a race, not a wrong selector or a state-ordering issue (7.16's own
// fix) — the button is genuinely present and matches, but the site's
// OWN script hasn't finished attaching its real click handler to it
// yet at the moment this file's click fires. A refresh benefits from
// warm caches/faster script execution, so the site's handler is ready
// in time; a first navigation may not be. Rather than keep retrying
// clicks in place against a script environment that may just be slow
// to initialize, this reloads the frame ONCE — directly reproducing
// the exact fix already confirmed to work by hand.
//
// Deliberately scoped to siteRules.length > 1 only (checked at the
// call site below) — the same "this site has more than one saved rule"
// signal DEBOUNCE_MS_MULTIPLE_RULES above already uses. A site with
// just one cookie-consent rule doesn't get this fallback: a plain
// single-banner site failing to close isn't the race this targets, and
// an unexpected reload is a real enough UX cost (page state, scroll
// position, a video that was playing) that it should stay confined to
// the specific pattern it was actually observed fixing — the
// sequential age-gate-then-cookie-banner flow multiple saved rules for
// one site is strong evidence of.
//
// CLICK_VERIFY_DELAY_MS: how long to wait, after a click, before
// checking whether the target is STILL there — long enough to catch a
// real close/redirect/reveal-next-step effect if the click DID work.
const CLICK_VERIFY_DELAY_MS = 400;

// RELOAD_GUARD_COOKIE / RELOAD_GUARD_MAX_AGE_S — release guard against
// a reload loop: set right before reloading, checked before reloading
// again, so a site where the race genuinely repeats after the reload
// (or where something else entirely is wrong) gets at most ONE
// automatic reload, not a cycle. Short max-age (20s — comfortably
// covers this file's own document_idle re-run on the reloaded page,
// nothing more) so it doesn't linger and silently suppress a REAL,
// later, unrelated reload-worthy moment on some future visit.
const RELOAD_GUARD_COOKIE = 'uBolCookieClickerReloaded';
const RELOAD_GUARD_MAX_AGE_S = 20;

// Attribute names the observer below watches, IN ADDITION TO element
// insertion/removal (childList) — this is the fix for a real, confirmed
// failure mode: a cookie-consent banner that's already present in the
// DOM, just hidden, and gets REVEALED by toggling one of these
// attributes (most CMPs' actual implementation) rather than by
// inserting new elements. childList-only observation — this file's
// original approach — never fires for that case, so a rule whose
// target only becomes clickable via an attribute change would sit
// unmatched until WAIT_TIMEOUT_MS gives up, even though the element was
// on the page the whole time. Not exhaustive (a framework could toggle
// some other, unlisted attribute or use Shadow DOM in a way this still
// misses) but covers the overwhelmingly common real patterns: a
// `hidden`/`aria-hidden` attribute, a `display:none`/`visibility:hidden`
// inline style, or a `.hidden`/`.is-open`-style class toggle.
const VISIBILITY_ATTRIBUTES = [ 'class', 'style', 'hidden', 'aria-hidden' ];

// Precedence marker (D5) — must match js/scripting/autodeny-snippets.
// generated.js's own read of the exact same attribute name. The two
// scripts run in different JS worlds (ISOLATED vs MAIN) that share the
// page's DOM but never share JS state directly, so a DOM attribute on
// documentElement is the one channel available for "a saved rule already
// covers this frame" to reach the generic auto-deny bundle. Same
// "must-match-exactly, no shared import surface" posture as STORAGE_KEY
// above.
const PRECEDENCE_MARKER_ATTR = 'data-ubol-cookie-clicker-rule';

// Diagnostic logging — OFF by default (a silent, working feature should
// stay silent), flip on ad hoc from the page's own DevTools console,
// then reload:
//   document.cookie = 'uBolCookieClickerDebug=1; path=/; max-age=3600'
// Deliberately a plain cookie, NOT sessionStorage/localStorage — the
// Storage API throws a SecurityError ("Access is denied for this
// document") in a genuinely common real situation this project has no
// control over: DevTools' own Console context selector defaulting to a
// sandboxed third-party iframe (an ad frame, extremely common on
// ad-heavy sites) rather than the top frame, or a site/browser storage-
// partitioning restriction on THAT particular frame. A first-party
// cookie set from the top frame's own console doesn't hit that
// restriction the same way, and document.cookie's reader below is
// wrapped so a still-somehow-denied read degrades to DEBUG staying
// false rather than throwing into this file's own top-level execution.
// max-age=3600 (1 hour) so a forgotten flag doesn't linger indefinitely
// the way an unset sessionStorage item would have kept doing until tab
// close anyway — this is slightly less self-cleaning than that, so the
// expiry is this version's substitute for it.
let DEBUG = false;
try {
    DEBUG = document.cookie.split('; ').includes('uBolCookieClickerDebug=1');
} catch {
}
function logDebug(...args) {
    if ( DEBUG === false ) { return; }
    console.info('[uBlock-Dynamic cookie-clicker]', topHostname, ...args);
}

/******************************************************************************/
// Rule lookup — read once per frame load, filtered to what THIS frame
// can actually act on.
/******************************************************************************/

async function localRead(key) {
    try {
        const bin = await chrome.storage.local.get(key);
        return bin?.[key];
    } catch {
    }
}

const { isolatedAPI } = self;
if ( isolatedAPI === undefined ) { return; } // guard: shared dependency file failed to load — nothing this script can do

// document.location.ancestorOrigins-based (see isolated-api.js) — works
// correctly from INSIDE a cross-origin iframe, unlike anything that would
// try to read window.top's own location directly (which throws
// cross-origin). This is the same technique css-specific.js already
// relies on for its own topHostname/thisHostname split.
const topHostname = isolatedAPI.contexts.topHostname;
const thisHostname = document.location.hostname || '';

const stored = await localRead(STORAGE_KEY);
const userSiteRules = stored?.[topHostname];
const builtinSiteRules = BUILTIN_SITE_RULES[topHostname] ?? [];
// Collision guard — a site-scoped user rule alongside a built-in one for
// the SAME site races it, with no visible signal otherwise. Debug-log
// only here (cheap, always correct); the more useful, always-visible
// warning lives in dashboard/custom-rules.js's own rendering.
if ( builtinSiteRules.length > 0 && Array.isArray(userSiteRules) && userSiteRules.length > 0 ) {
    logDebug('NOTE:', topHostname, 'has both a built-in rule and', userSiteRules.length,
        'user-saved rule(s) — all are evaluated independently and the first one whose',
        'target becomes available fires first; see dashboard \u2192 Manage custom rules for',
        'a visible warning about this.');
}
// Built-ins first, user rules after — order only matters for debug-log
// readability (both are evaluated independently by findRuleTarget()
// below regardless of array position, not sequentially against each
// other).
const siteRules = [
    ...builtinSiteRules,
    ...( Array.isArray(userSiteRules) ? userSiteRules : [] ),
];
if ( siteRules.length === 0 ) { return; }

// Only rules whose recorded frameHostname matches the frame THIS
// instance is running in — a rule picked inside consent.cookiebot.com
// must never be evaluated (let alone clicked) against some unrelated
// frame that happens to share the same top-level site.
const applicableRules = siteRules.filter(r => r.enabled !== false && r.frameHostname === thisHostname);
if ( applicableRules.length === 0 ) { return; }

// Precedence (D5) — set the marker BEFORE any click is attempted, and
// unconditionally (not just on eventual success): "a saved rule applies
// to this frame" is the D5 signal, not "the rule already fired". See
// PRECEDENCE_MARKER_ATTR's own comment above for why a DOM attribute is
// the cross-world signaling channel here.
try {
    document.documentElement.setAttribute(PRECEDENCE_MARKER_ATTR, '1');
} catch {
    // Benign: a denied DOM write here just means the generic auto-deny
    // bundle (if a session happens to be active) won't see the marker and
    // may also attempt this frame — redundant, not harmful (its own
    // snippets are idempotent no-ops once consent is already recorded).
}

// DEBOUNCE_MS_SINGLE_RULE / DEBOUNCE_MS_MULTIPLE_RULES switch — see
// those constants' own comment in Config above. Decided from
// siteRules.length (every rule saved for this SITE, across every
// frame) rather than applicableRules.length (only this frame's own
// rules): a two-popup flow where the age-gate rule lives in the top
// frame and the cookie-banner rule lives in a CMP iframe should still
// get the longer settle window in BOTH frames, not just whichever one
// happens to hold more than one rule itself.
const MUTATION_DEBOUNCE_MS = siteRules.length > 1 ? DEBOUNCE_MS_MULTIPLE_RULES : DEBOUNCE_MS_SINGLE_RULE;

logDebug(`frame ${thisHostname}: loaded ${applicableRules.length} applicable rule(s) ` +
    `(${siteRules.length} total for this site, debounce=${MUTATION_DEBOUNCE_MS}ms):`,
    applicableRules.map(r => ({ selector: r.selector, textFilter: r.textFilter || undefined })));

/******************************************************************************/
// FIX (8.2.11): a rule picked from inside a Shadow DOM subtree (real
// report: DPG Media's own consent dialog on nu.nl) carries a
// `shadowHostSelector` (js/scripting/cookie-clicker-picker.js's own
// buildSelector() — see that function's header for the full reasoning).
// `document.querySelectorAll()` can never see past a shadow boundary, so
// both lookup functions below need the CORRECT query scope — `document`
// for an ordinary rule, or the specific ShadowRoot a shadow-DOM rule was
// picked from — resolved once, here, so the two lookups can never
// silently diverge from each other.
/******************************************************************************/

function resolveRuleScope(rule) {
    if ( !rule.shadowHostSelector ) { return document; }
    let hosts;
    try {
        hosts = document.querySelectorAll(rule.shadowHostSelector);
    } catch {
        return null;
    }
    for ( const host of hosts ) {
        // .shadowRoot is null for a CLOSED root — a real browser security
        // boundary, not a bug: this rule was saved faithfully (see
        // buildSelector()'s own comment) but genuinely cannot be
        // automated from outside. Falls through to the next matching
        // host, if the selector matched more than one.
        if ( host.shadowRoot ) { return host.shadowRoot; }
    }
    return null;
}

/******************************************************************************/
// Element matching — selector plus optional textFilter, mirroring the
// same two-part disambiguation Consent-O-Matic's own rule format uses
// (see COOKIE-CLICKER-DESIGN.md's "Rule format" section) as an extra
// safety net for a selector that was unique at pick time but stops being
// unique after the site's markup drifts.
/******************************************************************************/

function findRuleTarget(rule) {
    const scope = resolveRuleScope(rule);
    if ( scope === null ) { return null; } // shadow host not found, or its shadow root is closed
    let elements;
    try {
        elements = scope.querySelectorAll(rule.selector);
    } catch {
        return null; // malformed/no-longer-valid selector — never throw into the observer callback
    }
    if ( elements.length === 0 ) { return null; }
    if ( !rule.textFilter ) { return elements[0]; }
    for ( const el of elements ) {
        if ( el.textContent && el.textContent.includes(rule.textFilter) ) { return el; }
    }
    return null;
}

// Debug-only counterpart to findRuleTarget() above — same lookup, plus
// enough detail to tell apart the three distinct ways a rule can stay
// unmatched, which otherwise all look identical from the outside ("never
// clicked"):
//   selectorMatches === 0   → the selector itself never matches anything
//                             in this frame's DOM at all. Either the
//                             element genuinely never renders here (a
//                             network request the banner's own script
//                             needs was blocked — plausible for an
//                             extension that is itself a content
//                             blocker, see CHANGELOG.md's 7.12 entry),
//                             or the selector was recorded against a
//                             different DOM shape than the one that
//                             actually occurs in the real sequential
//                             flow (e.g. an :nth-of-type() index that
//                             shifts depending on whether an earlier
//                             popup's markup is still present).
//   selectorMatches > 0,
//   textFilter set,
//   no element's text matched  → the selector finds the right AREA of
//                             the page but the textFilter string (typed
//                             in the picker's confirm bubble) doesn't
//                             actually appear in any candidate's
//                             textContent — likely a typo, wrong
//                             language variant, or extra surrounding
//                             whitespace/markup captured at pick time.
//   found a target             → findRuleTarget() would have returned
//                             it; if the rule STILL never fires, the
//                             problem is downstream of matching —
//                             clickElement() not producing the effect
//                             the site's own JS expects (e.g. an
//                             isTrusted check) — see this file's header
//                             note on that possibility.
function describeRuleState(rule) {
    const scope = resolveRuleScope(rule);
    if ( scope === null ) {
        return {
            selectorMatches: 0,
            reason: rule.shadowHostSelector
                ? 'shadow host not found, or its shadow root is closed (cannot be automated — see cookie-clicker-picker.js\'s buildSelector() for why)'
                : undefined,
        };
    }
    let elements;
    try {
        elements = scope.querySelectorAll(rule.selector);
    } catch (reason) {
        return { selectorMatches: -1, reason: `invalid selector: ${reason?.message ?? reason}` };
    }
    if ( elements.length === 0 ) { return { selectorMatches: 0 }; }
    if ( !rule.textFilter ) { return { selectorMatches: elements.length, matched: true }; }
    const matched = Array.from(elements).some(el => el.textContent && el.textContent.includes(rule.textFilter));
    return { selectorMatches: elements.length, textFilter: rule.textFilter, matched };
}

function clickElement(el) {
    // Real, trusted-shaped click: a FULL mousedown → mouseup → click
    // sequence, not just click() alone — this is the concrete fix for a
    // real, evidenced failure mode (see CHANGELOG.md's 7.16 entry): a
    // consecutive-rule click succeeded in finding and "clicking" the
    // right element, but the site's own state (observed directly in
    // that site's own console log: "sMainCatChoice is not set") wasn't
    // registered before the NEXT rule's click read it — some sites bind
    // their actual state-setting logic to mousedown/pointerdown rather
    // than the final click event. Firing the fuller sequence gives
    // whichever event the site actually listens for a chance to fire,
    // not just whichever one this file happened to guess first.
    // Neither call needs any elevated permission — see this file's own
    // header note on the 'trusted-' question.
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch {}
    try { el.click(); } catch {} // fallback for elements/frameworks that only wire up an 'onclick'-style handler
}

/******************************************************************************/
// Wait-and-click — GUARD: init/clear/release around the one piece of
// state this file owns (the MutationObserver instance).
/******************************************************************************/

let observer;      // the live MutationObserver, or undefined when not watching
let timeoutHandle;  // the pending WAIT_TIMEOUT_MS timer, or undefined

// RELEASE guard — the ONLY place `observer`/`timeoutHandle`/
// `debounceHandle` (declared further below, alongside the code that
// actually schedules it) are torn down. Called from every exit path
// below (immediate match, a later match found by the observer callback,
// or the timeout firing) so a frame that finishes early never leaves a
// live observer or a dangling timer running for the rest of that
// frame's lifetime.
function stopObserving() {
    if ( observer !== undefined ) {
        observer.disconnect();
        observer = undefined;
    }
    if ( timeoutHandle !== undefined ) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
    }
    if ( debounceHandle !== undefined ) {
        clearTimeout(debounceHandle);
        debounceHandle = undefined;
    }
}

function sleep(ms) {
    return new Promise(resolve => self.setTimeout(resolve, ms));
}

// Reload guard — see RELOAD_GUARD_COOKIE's own comment in Config above.
// A plain function (not tied to any rule's own state) since the reload
// decision is per-FRAME, not per-rule: whichever rule first triggers it
// speaks for the whole frame.
function hasAlreadyReloadedThisSession() {
    try {
        return document.cookie.split('; ').includes(`${RELOAD_GUARD_COOKIE}=1`);
    } catch {
        return false; // guard: a denied cookie read defaults to "not yet reloaded" — worst case one extra reload attempt, never a silent permanent block
    }
}

function reloadThisFrameOnce(reason) {
    try {
        document.cookie = `${RELOAD_GUARD_COOKIE}=1; path=/; max-age=${RELOAD_GUARD_MAX_AGE_S}`;
    } catch {
    }
    logDebug('reloading this frame once:', reason);
    stopObserving(); // RELEASE guard — no reason to leave a live observer/timer running through a navigation that's about to tear this whole execution context down anyway, but cheap and correct to be explicit
    self.location.reload();
}

async function tryRulesOnce(rules) {
    const remaining = [];
    let clickedAny = false;
    for ( const rule of rules ) {
        const el = findRuleTarget(rule);
        if ( el === null ) {
            if ( DEBUG ) { logDebug('not yet matched:', rule.selector, describeRuleState(rule)); }
            remaining.push(rule);
            continue;
        }
        if ( clickedAny ) {
            // CLICK_SEQUENCE_DELAY_MS guard — see its own comment
            // above: only inserted BETWEEN clicks (never before the
            // first or after the last), so a single-rule pass — the
            // overwhelming majority of real usage — is never slowed
            // down by this at all.
            await sleep(CLICK_SEQUENCE_DELAY_MS);
        }
        logDebug('clicking:', rule.selector, el);
        clickElement(el);
        clickedAny = true;

        // Verify-then-reload — see CLICK_VERIFY_DELAY_MS's own comment
        // above. Only armed when this SITE has more than one saved
        // rule (siteRules.length > 1, the same signal
        // DEBOUNCE_MS_MULTIPLE_RULES already uses) — see
        // RELOAD_GUARD_COOKIE's own comment for why this stays scoped
        // to that specific pattern rather than applying to every site.
        if ( siteRules.length > 1 ) {
            await sleep(CLICK_VERIFY_DELAY_MS);
            const stillThere = findRuleTarget(rule) !== null;
            if ( stillThere && hasAlreadyReloadedThisSession() === false ) {
                reloadThisFrameOnce(`${rule.selector} still present after click`);
                return { remaining, clickedAny }; // unreachable in practice (reload navigates away) but keeps this function's return type honest if navigation is ever deferred/blocked
            }
        }
        // This rule is considered satisfied for the rest of this frame
        // load — a successful click is not retried even if the observer
        // fires again (beyond the single verify-then-reload check just
        // above, which only ever fires once per frame per session).
    }
    return { remaining, clickedAny };
}

let debounceHandle; // the pending MUTATION_DEBOUNCE_MS re-check timer, or undefined

async function waitAndClick(rules) {
    // INIT guard: immediate attempt first — the common case, since
    // cookie-consent DOMs are frequently already present by the time a
    // document_idle-registered script runs (see scripting-manager.js's
    // own comment on why document_idle was chosen as this script's
    // runAt). Only falls through to the MutationObserver path if
    // anything is still missing.
    let remaining = (await tryRulesOnce(rules)).remaining;
    if ( remaining.length === 0 ) {
        logDebug('all rules satisfied on the immediate pass, nothing to watch for');
        return;
    }

    logDebug(`watching DOM for ${remaining.length} still-unmatched rule(s):`, remaining.map(r => r.selector));

    // Debounced re-check — coalesces a burst of mutations (childList
    // AND attribute, see VISIBILITY_ATTRIBUTES above) into a single
    // findRuleTarget() pass per MUTATION_DEBOUNCE_MS, rather than
    // re-querying the DOM on every individual mutation record. RELEASE:
    // cleared unconditionally at the top of every call (so a fresh
    // mutation burst always restarts the wait rather than stacking
    // timers) and in stopObserving() below (so a frame that finishes —
    // by match or by WAIT_TIMEOUT_MS — never leaves one pending).
    function scheduleRecheck() {
        if ( debounceHandle !== undefined ) { clearTimeout(debounceHandle); }
        debounceHandle = self.setTimeout(async () => {
            debounceHandle = undefined;
            const result = await tryRulesOnce(remaining);
            remaining = result.remaining;
            if ( remaining.length === 0 ) {
                logDebug('all rules satisfied after a DOM mutation');
                stopObserving();
            }
        }, MUTATION_DEBOUNCE_MS);
    }

    observer = new MutationObserver(scheduleRecheck);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: VISIBILITY_ATTRIBUTES,
    });

    timeoutHandle = self.setTimeout(( ) => {
        if ( remaining.length > 0 ) {
            logDebug(`TIMED OUT after ${WAIT_TIMEOUT_MS}ms — still unmatched:`,
                remaining.map(r => ({ selector: r.selector, textFilter: r.textFilter || undefined, ...describeRuleState(r) })));
        }
        stopObserving();
    }, WAIT_TIMEOUT_MS);
}

await waitAndClick(applicableRules);

/******************************************************************************/

})();

void 0;
