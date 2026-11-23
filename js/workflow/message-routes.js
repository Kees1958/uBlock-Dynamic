/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2022-present Raymond Hill

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
    Based on uBlock Origin Lite (https://github.com/gorhill/uBlock), modified in
    2026 for uBlock-Stripped-Dynamic — see CHANGELOG.md for the changes.
*/

// ── message-routes.js ─────────────────────────────────────────────────────────
// The route table for every runtime message: which sender kind each message needs, and the one dispatcher
// background.js's single onMessage listener calls (C3, C20a).
//
// Public interface:
//   MESSAGE_ROUTES                         — frozen map: request.what -> { sender kind, ... }
//   SENDER_KINDS                           — the sender categories a route can require
//   dispatchRoutedMessage(request, sender, ctx, handlers) — checks the route's precondition, then calls its handler
//   isTrustedSender(sender, origin, id)    — re-exported from js/util/trusted-sender.js (C28)
//
// Dependencies: data/message-types.js (MSG_* constants), util/trusted-sender.js.
// State owned: none.
// (C10 header added in 10.7.9, audit 10.7.8.)

// `request.what` values are literal strings for most routes, but some are
// exported constants (see js/data/message-types.js). Import here so the
// object-literal keys below can use the actual string values rather than
// hardcoding a second copy of them (see uBol-stripped-code-review.md, "no
// duplicated constants").
import {
    MSG_GET_MATCHING_SCRIPTLET_RULES,
    MSG_GET_TOOL_OVERLAY_SECRET,
    MSG_START_PRIVACY_INSPECTOR,
    MSG_STOP_PRIVACY_INSPECTOR,
    MSG_PAUSE_PRIVACY_INSPECTOR,
    MSG_RESUME_PRIVACY_INSPECTOR,
    MSG_GET_PRIVACY_INSPECTOR_DATA,
    MSG_ADD_PRIVACY_SCRIPTLET_RULE,
    MSG_APPLY_PRIVACY_EXTRAS,
    MSG_GET_CUSTOM_COSMETIC_RULES,
    MSG_DELETE_COSMETIC_RULE,
    MSG_CLEAR_COSMETIC_RULES,
    MSG_GET_MATRIX_BLOCK_RULES,
    MSG_DELETE_MATRIX_BLOCK_RULE,
    MSG_CLEAR_MATRIX_BLOCK_RULES,
    MSG_SITE_MODE_GET,
    MSG_SITE_MODE_SET,
    MSG_GET_ENABLED_RULESETS,
    MSG_SET_RULESET_ENABLED,
    MSG_GET_LANGUAGE_FILTER_COUNTRIES,
    MSG_SET_LANGUAGE_FILTER_COUNTRIES,
    MSG_START_MATRIX,
    MSG_STOP_MATRIX,
    MSG_GET_MATRIX_DATA,
    MSG_MATRIX_SET_OVERRIDE,
    MSG_MATRIX_SET_OVERRIDES,
    MSG_RELOAD_MATRIX_TAB,
    MSG_GET_DOMAIN_RULE_DETAIL,
    MSG_EXPORT_CUSTOM_RULES,
    MSG_IMPORT_CUSTOM_RULES,
    MSG_EXPORT_ALL_SETTINGS,
    MSG_IMPORT_ALL_SETTINGS,
    MSG_RESET_ALL_SETTINGS,
    MSG_DELETE_FILTERED_CUSTOM_RULES,
    MSG_GET_PRIVACY_SCRIPTLET_RULES,
    MSG_DELETE_PRIVACY_SCRIPTLET_RULE,
    MSG_CLEAR_PRIVACY_SCRIPTLET_RULES,
    MSG_COOKIE_CLICKER_ADD_RULE,
    MSG_GET_COOKIE_CLICKER_RULES,
    MSG_DELETE_COOKIE_CLICKER_RULE,
    MSG_CLEAR_COOKIE_CLICKER_RULES,
    MSG_COOKIE_CLICKER_AUTODENY_GET,
    MSG_COOKIE_CLICKER_AUTODENY_START,
    MSG_SEAMLESS_COOKIE_PROMPT_DISMISS,
    MSG_COOKIE_CLICKER_LAUNCH_PICKER,
    MSG_WORRY_FREE_LAUNCH_PICKER,
    MSG_AD_CLEANER_LAUNCH,
    MSG_AD_CLEANER_KEEP,
} from '../data/message-types.js';

/*******************************************************************************

    MESSAGE ROUTING TABLE — background.js dispatcher refactor
    ==========================================================
    See dispatcher-refactor-plan.md for the full background and rationale.
    Kept in its own workflow-tier module so routing *policy* (which
    preconditions a message needs) is declared as data, separate from the
    handler *logic* (what the message does, which stays in background.js).

    THE BUG THIS REPLACES
    ----------------------
    background.js used to gate messages with three sequential switch
    statements. Which gates applied to a given `request.what` depended
    entirely on *which switch block it was pasted into* — an implicit,
    position-dependent contract. A handler moved to the wrong switch (or a
    new case added in the wrong place) would silently pick up the wrong
    gating, with no syntax error to catch it. That is exactly the bug that
    motivated this refactor (see dispatcher-refactor-plan.md §1).

    Here, every `request.what` value declares its own requirements as data
    (`requiresInit`, `allowedSenders`). There is no shared "stage" left to
    misplace a handler within.

    MIGRATION STATUS (update this as each stage lands)
    ----------------------------------------------------
    - Stage 0 (done): insertCSS, removeCSS, injectCSSProceduralAPI
    - Stage 1 (done): startCustomFilters, terminateCustomFilters,
                       injectCustomFilters, privacyInspectorEvent,
                       MSG_GET_MATCHING_SCRIPTLET_RULES
    - Stage 2, batch 1 (done): Privacy Inspector UI messages
                       (MSG_START_PRIVACY_INSPECTOR .. MSG_ADD_PRIVACY_
                       SCRIPTLET_RULE, MSG_GET/DELETE/CLEAR_PRIVACY_
                       SCRIPTLET_RULES) + dashboard cosmetic/monitor-block
                       -rule messages (MSG_GET_CUSTOM_COSMETIC_RULES,
                       MSG_DELETE_COSMETIC_RULE, MSG_CLEAR_COSMETIC_RULES,
                       MSG_GET/DELETE/CLEAR_MONITOR_BLOCK_RULES)
    - Stage 2, batch 2 (done): site mode / allowlist messages
                       (MSG_SITE_MODE_GET, MSG_SITE_MODE_SET,
                       siteModeGetAll, siteModeSetAll)
    - Stage 2, batch 3 (done): everything else — security config, filtering
                       mode, rulesets, sandbox filters, monitor. This
                       completes the dispatcher refactor: every
                       `request.what` this listener handles now has a
                       declared route, and the legacy switch statements in
                       background.js have been removed entirely.

    All 72 routes are now declared above (this count grows as later
    features, e.g. the cookie/consent-clicker, add their own — see
    MESSAGE_ROUTES below for the current, authoritative set; don't trust
    this number without recounting). There is no longer a legacy
    switch in background.js to fall through to — dispatchRoutedMessage()
    below now handles every message this listener is meant to receive.
    A `request.what` reaching background.js without a match here means
    either a genuine wiring bug (see the console.warn below) or a message
    that was never meant for this listener in the first place (see the
    `request.what.includes(':')` convention at the runtime.onMessage
    listener itself, upstream of this module) — background.js logs a
    console.info diagnostic and ignores it either way (see plan §5).

*******************************************************************************/

// ── TRUSTED SENDER (10.7.6, audit 10.7.5 D-4) ────────────────────────────
// isTrustedSender(): true for uBD's own internal calls (no sender at all) and this extension's own pages (own id AND
// own origin). Lives in js/util/trusted-sender.js since 10.7.9 so the core tier can use it too; re-exported here
// under the same name (a public contract — background.js and the suite import it from this file).
export { isTrustedSender } from '../util/trusted-sender.js';

// ── SENDER KINDS ─────────────────────────────────────────────────────────
// The three categories a message's precondition can require. Declared once
// here (not re-derived from switch position) so every route states its own
// requirement explicitly.
export const SENDER_KINDS = Object.freeze({
    // No origin requirement at all (e.g. cosmetic-filter plumbing that must
    // run even before the extension has finished initializing).
    ANY: 'any',
    // Sender is expected to be a page's content script. `sender.origin` is
    // therefore the *inspected page's* origin, not the extension's — the
    // handler must NOT be gated on the extension's trusted-origin check.
    // If the handler needs its own sender validation (e.g. confirming
    // sender.id === runtime.id), that check lives inside the handler body,
    // not in this table.
    CONTENT_SCRIPT: 'contentScript',
    // Sender must be a genuine extension page (popup, dashboard, monitor /
    // privacy-inspector panel window) — gated on the trusted-origin check.
    EXTENSION_PAGE: 'extensionPage',
});

// ── ROUTES ───────────────────────────────────────────────────────────────
// One entry per `request.what` value that has been migrated to the new
// dispatcher so far. Each entry is the *complete* precondition contract for
// that message — nothing about its handling depends on anything else in
// this file or in background.js.
//
//   requiresInit:    true  -> handler runs only after `isFullyInitialized`
//                              has resolved.
//   allowedSenders:  one of SENDER_KINDS above.
//
// Object.freeze (on the table and every entry) so a route's contract can't
// be mutated at runtime by accident from elsewhere in the codebase.
export const MESSAGE_ROUTES = Object.freeze({
    // Stage 0 — cosmetic-filter plumbing. Runs before the extension is
    // fully initialized and accepts senders of any origin, matching the
    // original Stage A switch's total absence of gating.
    insertCSS: Object.freeze({
        requiresInit: false,
        allowedSenders: SENDER_KINDS.ANY,
    }),
    removeCSS: Object.freeze({
        requiresInit: false,
        allowedSenders: SENDER_KINDS.ANY,
    }),
    injectCSSProceduralAPI: Object.freeze({
        requiresInit: false,
        allowedSenders: SENDER_KINDS.ANY,
    }),

    // Stage 1 — content-script-sourced messages. sender.origin here belongs
    // to the *inspected page*, not the extension, so these must never be
    // gated on the extension's trusted-origin check (that was the exact
    // position-dependent bug this refactor exists to prevent — see module
    // header). Two of these (privacyInspectorEvent,
    // MSG_GET_MATCHING_SCRIPTLET_RULES) additionally validate
    // `sender.id === runtime.id` inside their own handler body, since that
    // check is specific to those two handlers, not a generic routing rule.
    startCustomFilters: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    terminateCustomFilters: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    injectCustomFilters: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    privacyInspectorEvent: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    // The overlay script in the page and the tool frame both ask; the handler answers only senders whose id is
    // this extension (a web page cannot send runtime messages at all). No init needed: the secret is standalone.
    [MSG_GET_TOOL_OVERLAY_SECRET]: Object.freeze({
        requiresInit: false,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    [MSG_GET_MATCHING_SCRIPTLET_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    // Cookie/consent-clicker picker → SW — content-script-sourced, same
    // gate as the rest of Stage 1 above (sender.origin here is the
    // INSPECTED PAGE's origin, never the extension's).
    [MSG_COOKIE_CLICKER_ADD_RULE]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    cookieClickerPickCancelled: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    // getWorryFreeItemStates removed (per explicit request) —
    // js/scripting/worry-free-picker.js switched from a per-item dynamic
    // explanation list to fixed text and no longer needs this route.
    // See CHANGELOG / cookie-clicker-routes.js's own removal comment.

    // Stage 2, batch 1 — genuine extension pages (popup, dashboard,
    // Monitor / Privacy Inspector panel windows), gated on the
    // trusted-origin check. Well-understood surface from the session that
    // produced this refactor, migrated first within Stage 2 for that
    // reason.
    [MSG_START_PRIVACY_INSPECTOR]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_STOP_PRIVACY_INSPECTOR]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_PAUSE_PRIVACY_INSPECTOR]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_RESUME_PRIVACY_INSPECTOR]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_PRIVACY_INSPECTOR_DATA]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_ADD_PRIVACY_SCRIPTLET_RULE]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_APPLY_PRIVACY_EXTRAS]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_PRIVACY_SCRIPTLET_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_DELETE_PRIVACY_SCRIPTLET_RULE]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_CLEAR_PRIVACY_SCRIPTLET_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_CUSTOM_COSMETIC_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_DELETE_COSMETIC_RULE]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_CLEAR_COSMETIC_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_COOKIE_CLICKER_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_DELETE_COOKIE_CLICKER_RULE]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_CLEAR_COOKIE_CLICKER_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_MATRIX_BLOCK_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_DELETE_MATRIX_BLOCK_RULE]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_CLEAR_MATRIX_BLOCK_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_EXPORT_CUSTOM_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_IMPORT_CUSTOM_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_EXPORT_ALL_SETTINGS]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_IMPORT_ALL_SETTINGS]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_RESET_ALL_SETTINGS]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_DELETE_FILTERED_CUSTOM_RULES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),

    // Stage 2, batch 2 — 4-way site mode / allowlist messages. Same
    // EXTENSION_PAGE contract as batch 1; migrated as its own batch per the
    // plan so the allowlist bug fix (siteModeSetAll) gets a dedicated
    // re-test after moving, rather than being buried in a larger diff.
    [MSG_SITE_MODE_GET]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_SITE_MODE_SET]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    siteModeGetAll: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    siteModeSetAll: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    // (10.3.0) saferegionsGetAll / saferegionsSetAll removed with the $saferegions option.
    // $worryfree — same Allow list tab, same editor, same EXTENSION_PAGE
    // contract as siteModeGetAll/siteModeSetAll above.
    worryfreeGetAll: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    worryfreeSetAll: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),

    // Stage 2, batch 3 — everything else: security config, filtering mode,
    // rulesets, sandbox filters, monitor. Same EXTENSION_PAGE contract as
    // the rest of Stage 2. This is the largest and least-exercised-this-
    // session batch, per the plan — sub-groups worth a dedicated manual
    // test: (1) security config/allowlist toggles, (2) filtering mode
    // get/set + default mode, (3) DNR/rulesets/sandbox filters/
    // addCustomFilters, (4) Block Monitor start/stop/pause/resume/data.
    getCurrentConfig: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getSecurityConfig: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    setSecurityConfig: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    // (10.3.0) get/set/restoreWorryFreeFamiliarTlds removed with the editable safer-region TLD list.
    // (audit 10.6.4) getSecurityAllowlist / setSecurityAllowlist removed with securityAllowlist (no sender left).
    getOptionsPageData: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    popupPanelData: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getFilteringMode: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    setFilteringMode: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getDefaultFilteringMode: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    setDefaultFilteringMode: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getFilteringModeDetails: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    setFilteringModeDetails: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getAllDynamicRules: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getAllSessionRules: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getEffectiveUserRules: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    updateUserDnrRules: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    addCustomFilters: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    getSandboxFilters: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    setSandboxFilters: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    pruneCSSCache: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    // "Buying, booking, banking mode" — timed global filtering pause.
    // tempDisableExpire is dispatched internally by js/data/alarms.js's
    // processDueJobs() with no `sender` at all (same as the existing
    // 'pruneCSSCache' job above) — dispatchRoutedMessage()'s
    // isTrustedOrigin() check treats a missing sender as trusted, so
    // EXTENSION_PAGE here is correct for that internal call too, not just
    // for genuine popup-initiated tempDisableGet/Start/Cancel calls.
    tempDisableGet: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    tempDisableStart: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    tempDisableStartUntilRestart: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    tempDisableCancel: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    tempDisableExpire: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    // "Never consent for 60 minutes" (v8.2) — timed global auto-deny
    // session. FIX (8.2.3): MSG_COOKIE_CLICKER_AUTODENY_START is sent
    // from js/scripting/cookie-clicker-picker.js — a CONTENT SCRIPT
    // running on the inspected page's own origin (cnn.com, nbcnews.com,
    // etc.), NOT a genuine extension page. Classifying it as
    // EXTENSION_PAGE (as an earlier version of this table did) means
    // isTrustedOrigin() fails for every real caller and
    // dispatchRoutedMessage() silently drops the message — no error, no
    // response, the session never starts. This is exactly the
    // position-dependent-gating trap this file's own header warns about;
    // caught via a real report ("Never consent doesn't work on
    // nbcnews.com or CNN," reproducible on every site regardless of
    // which CMP is present — the actual signature of a dropped message,
    // not a CMP-selector bug). MSG_COOKIE_CLICKER_AUTODENY_GET/CANCEL
    // stay EXTENSION_PAGE — both are only ever sent from popup.js /
    // cookie-clicker-autodeny-ui.js, genuine extension-page contexts.
    [MSG_COOKIE_CLICKER_AUTODENY_GET]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_COOKIE_CLICKER_AUTODENY_START]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    // (10.7.1) Sent by the same in-page Seamless surfing prompt (worry-free-picker.js, a content script) as the
    // START route above — same sender kind, same reasoning.
    [MSG_SEAMLESS_COOKIE_PROMPT_DISMISS]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    // (10.7.1) The CANCEL route and the 'cookieClickerAutoDenyExpire' deferred-job route REMOVED with the timed
    // sessions. A left-over expiry job is released once by retireTimedSession() (background.js runVersionMigration()).
    // (10.0.7) Alarm-fired fallback that resumes a Worry-free session paused for the picker.
    cookieClickerPickerResumeFallback: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    // (8.2.17) Sent only from popup.js's own #gotoCookieClicker handler
    // — a genuine extension page, not a content script (contrast with
    // MSG_COOKIE_CLICKER_AUTODENY_START's own comment above, which is
    // the opposite classification for the opposite reason).
    [MSG_COOKIE_CLICKER_LAUNCH_PICKER]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    // (11.0.0) Ad leftover cleaner: launch from the popup; keep from the page script (the handler checks
    // sender.id, the top frame, and that every selector is one of the shipped list's — js/workflow/ad-cleaner-routes.js).
    [MSG_AD_CLEANER_LAUNCH]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_AD_CLEANER_KEEP]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.CONTENT_SCRIPT,
    }),
    // v8.3.19 — same reasoning/shape as MSG_COOKIE_CLICKER_LAUNCH_PICKER
    // just above (sent only from popup.js's own #gotoWorryFree handler,
    // a genuine extension page).
    [MSG_WORRY_FREE_LAUNCH_PICKER]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    keepAlive: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_ENABLED_RULESETS]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_SET_RULESET_ENABLED]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_LANGUAGE_FILTER_COUNTRIES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_SET_LANGUAGE_FILTER_COUNTRIES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_START_MATRIX]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_STOP_MATRIX]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_MATRIX_DATA]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_MATRIX_SET_OVERRIDE]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_MATRIX_SET_OVERRIDES]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_RELOAD_MATRIX_TAB]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
    [MSG_GET_DOMAIN_RULE_DETAIL]: Object.freeze({
        requiresInit: true,
        allowedSenders: SENDER_KINDS.EXTENSION_PAGE,
    }),
});

/*******************************************************************************

    dispatchRoutedMessage()
    ------------------------
    Generic, single-implementation validator + dispatcher. Replaces the
    per-case, position-dependent gating that used to live in switch-statement
    order. Returns `{ handled: false }` for any `request.what` not present in
    MESSAGE_ROUTES — as of Stage 2 batch 3, that means either a genuine
    wiring bug (a route missing its handler, see the console.warn below) or
    a message never meant for this listener at all (background.js logs a
    diagnostic and ignores it — see plan §5).

    `ctx` fields (all required):
      - tabId, frameId:       as computed by background.js from `sender`.
      - isFullyInitialized:   the SW's startup promise (awaited only when
                               the matched route declares requiresInit).
      - isTrustedOrigin():    zero-arg function returning a boolean, called
                               only when the matched route declares
                               allowedSenders === EXTENSION_PAGE (kept lazy
                               so Stage 0/1 routes never pay for a check
                               they don't need).

    `handlers` is a plain object mapping the same `request.what` keys to
    their handler function, owned and defined by background.js (handler
    *logic* stays there — see module header).

*******************************************************************************/
export async function dispatchRoutedMessage(request, sender, ctx, handlers) {
    const route = MESSAGE_ROUTES[request.what];
    if ( route === undefined ) { return { handled: false }; }

    const handler = handlers[request.what];
    if ( typeof handler !== 'function' ) {
        // A route was declared here but background.js never registered a
        // handler for it — a wiring mistake, not a "message not meant for
        // this listener" situation. Diagnostic only, per the plan's §5
        // modification: never turn this into a thrown error. Reported as
        // { handled: false } so background.js's own no-route diagnostic
        // fires too — there is no legacy switch left to fall back to.
        console.warn(
            `[uBlock-Dynamic] message-routes: '${request.what}' has a declared route but no registered handler`
        );
        return { handled: false };
    }

    if ( route.requiresInit ) {
        await ctx.isFullyInitialized;
    }

    if ( route.allowedSenders === SENDER_KINDS.EXTENSION_PAGE ) {
        if ( ctx.isTrustedOrigin() === false ) {
            // Matches the original gate-2 behavior exactly: silently drop,
            // no response value.
            return { handled: true, value: undefined };
        }
    }

    const value = await handler(request, sender, ctx.tabId, ctx.frameId);
    return { handled: true, value };
}
