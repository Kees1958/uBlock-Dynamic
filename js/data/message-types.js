/*
 * message-types.js — Named constants for all chrome.runtime message types
 *
 * All MSG_* constants used in onMessage handlers and sendMessage() calls
 * are defined here as the single source of truth. No logic, no state.
 *
 * Public interface: all exports are MSG_* string constants.
 *
 * Import in consumers:
 *   import { MSG_START_MATRIX, MSG_GET_MATRIX_DATA } from '../data/message-types.js';
 */
/*******************************************************************************

    uBlock-Stripped-Dynamic — Matrix panel message type constants
    All inter-component communication for the Matrix panel passes through
    these. Replaces the standalone "DDG Tracker Radar" Block Monitor
    feature's message types (MSG_START_MONITOR etc., removed) — the Matrix
    panel superseded it with broader scope (every connection, not just
    known trackers). That "known DDG Tracker" column has since been
    removed too (see CHANGELOG) — nothing in this project reads DuckDuckGo
    Tracker Radar data anymore.

*******************************************************************************/

// popup → SW
export const MSG_START_MATRIX  = 'startMatrix';   // start session, register listener, reload tab
export const MSG_STOP_MATRIX   = 'stopMatrix';    // end session, full cleanup

// panel → SW
export const MSG_GET_MATRIX_DATA   = 'getMatrixData';   // fetch FIFO array + session metadata
// Sets or clears a per-SITE, per-domain, per-scope override — payload:
// { domain, scope: 'all'|'code', action: 'block'|'allow'|null }. Site is
// NOT part of the payload — the background derives it authoritatively
// from the currently-running Matrix session (see getCurrentSessionSite()
// in matrix-panel.js), so a buggy/compromised panel page can't scope an
// override to a site it isn't actually showing. null clears the override
// for that (site, domain, scope) triple. See matrix-block-rules.js's
// header for the full per-site design (deliberately NOT global, unlike
// real 3P-Matrix-lite's own domain overrides).
export const MSG_MATRIX_SET_OVERRIDE = 'matrixSetOverride';
// Reloads the tab the current Matrix session is watching — sent by the
// panel's REFRESH button. Separate from the row-list re-evaluation
// refreshMatrixView() already does locally in the panel (see
// matrix-panel.js): that part needs no round-trip to the background at
// all, but making an override actually visible on an ALREADY-LOADED page
// does, since DNR only affects requests made AFTER a rule change — a
// resource that already failed earlier in the page's current load won't
// retry on its own. tabId is never taken from the request payload — see
// getCurrentSessionTabId()'s own doc comment in matrix-panel.js.
export const MSG_RELOAD_MATRIX_TAB = 'reloadMatrixTab';
// On-demand raw rule lookup for one domain — backs the Matrix panel's
// expand-row detail column. See js/core/domain-rule-detail.js's own
// header for the full "why" (a domain-level yes/no can't represent a
// domain like phncdn.com with both block and allow rules on different
// paths) and for exactly what this deliberately does NOT resolve
// (priority ordering, resourceType/initiator matching against the
// actual page — raw rule data only, no verdict).
export const MSG_GET_DOMAIN_RULE_DETAIL = 'getDomainRuleDetail';

// SW → panel  (sent via BroadcastChannel)
export const MSG_MATRIX_ENTRY   = 'matrixEntry';   // new FIFO entry to push into panel UI
export const MSG_MATRIX_CLOSED  = 'matrixClosed';  // notify panel to close (clash / force-close)

// dashboard → SW  (Manage custom rules → "3P Matrix (block) rules", the
// 4th custom-rules category — per-SITE 3P-all/3P-code block overrides
// created from the Matrix panel)
export const MSG_GET_MATRIX_BLOCK_RULES   = 'getMatrixBlockRules';
export const MSG_DELETE_MATRIX_BLOCK_RULE = 'deleteMatrixBlockRule';
export const MSG_CLEAR_MATRIX_BLOCK_RULES = 'clearMatrixBlockRules';

// dashboard → SW
export const MSG_GET_CUSTOM_COSMETIC_RULES = 'getCustomCosmeticRules'; // fetch all site.* entries
export const MSG_DELETE_COSMETIC_RULE      = 'deleteCosmeticRule';     // delete one selector from a site
export const MSG_CLEAR_COSMETIC_RULES      = 'clearCosmeticRules';     // remove all site.* keys
export const MSG_GET_PRIVACY_SCRIPTLET_RULES   = 'getPrivacyScriptletRules';   // dashboard: list Privacy-Inspector-sourced scriptlet rules only
export const MSG_DELETE_PRIVACY_SCRIPTLET_RULE = 'deletePrivacyScriptletRule'; // dashboard: delete one such rule by uid
export const MSG_CLEAR_PRIVACY_SCRIPTLET_RULES = 'clearPrivacyScriptletRules'; // dashboard: remove all such rules (sandbox-sourced rules untouched)
export const MSG_GET_MATCHING_SCRIPTLET_RULES  = 'getMatchingScriptletRules';  // content script: rules (any source) matching one hostname
export const MSG_GET_TOOL_OVERLAY_SECRET     = 'getToolOverlaySecret';       // overlay content script + tool frame: per-session secret (js/core/tool-overlay-secret.js)

// dashboard → SW  (Manage Custom Rules — combined export/import across all
// four sections at once: Cosmetic, Cookie/consent-clicker, Dynamic DNR,
// Privacy/scriptlet. NOT per-section — the "Clear all" buttons stay
// per-section, this is deliberately the one exception that spans all of
// them together.)
export const MSG_EXPORT_CUSTOM_RULES = 'exportCustomRules';
export const MSG_IMPORT_CUSTOM_RULES = 'importCustomRules';
// dashboard → SW (Filter (block) lists tab — "Save settings"/"Restore
// settings", broader than MSG_EXPORT_CUSTOM_RULES above: the full
// configuration (rulesetConfig, securityConfig, site modes/Allow list) PLUS the same custom-rules payload nested inside,
// so one file is a complete backup — not a replacement for the
// narrower custom-rules-only export, which stays available on its own
// tab for that more focused use case.
export const MSG_EXPORT_ALL_SETTINGS = 'exportAllSettings';
export const MSG_IMPORT_ALL_SETTINGS = 'importAllSettings';
// dashboard → SW (Filter (block) lists tab — "Reset to defaults").
// Same destructive-action pattern as MSG_DELETE_FILTERED_CUSTOM_RULES's
// own "Delete all rules" (confirm() required client-side before
// sending) but far broader in scope: clears ALL of chrome.storage.local
// AND chrome.storage.session, then reloads the extension outright —
// the only way to genuinely restore rulesetConfig/securityConfig
// to their real literal defaults, since those are
// live objects Object.assign() has already mutated in place; nothing
// short of a fresh module evaluation (a real reload) actually reverts
// them, and duplicating a second copy of every default value just to
// avoid the reload would itself be a maintenance/drift risk (C21).
export const MSG_RESET_ALL_SETTINGS = 'resetAllSettings';
// "Delete rules" toolbar button — deletes across all three sections at
// once, scoped to whatever domain filter is currently active in the
// dashboard ('' = no filter = delete everything). Replaces needing three
// separate per-section MSG_CLEAR_* calls from that one button; those
// three message types stay defined (still valid, low-level per-section
// operations) even though nothing in the UI currently triggers them
// individually.
export const MSG_DELETE_FILTERED_CUSTOM_RULES = 'deleteFilteredCustomRules';

// dashboard → SW  (static ruleset enable/disable)
export const MSG_GET_ENABLED_RULESETS = 'getEnabledRulesets';
export const MSG_SET_RULESET_ENABLED   = 'setRulesetEnabled';
// dashboard → SW  (10.4.5) which country rows of a combined language filter (Balkan, Baltic states) were added —
// js/core/language-filter-countries.js
export const MSG_GET_LANGUAGE_FILTER_COUNTRIES = 'getLanguageFilterCountries';
export const MSG_SET_LANGUAGE_FILTER_COUNTRIES = 'setLanguageFilterCountries';

// popup/dashboard → SW  (4-way site mode)
export const MSG_SITE_MODE_GET = 'siteModeGet';
export const MSG_SITE_MODE_SET = 'siteModeSet';


// popup/privacy panel → SW
export const MSG_START_PRIVACY_INSPECTOR = 'startPrivacyInspector';
export const MSG_STOP_PRIVACY_INSPECTOR = 'stopPrivacyInspector';
export const MSG_PAUSE_PRIVACY_INSPECTOR = 'pausePrivacyInspector';
export const MSG_RESUME_PRIVACY_INSPECTOR = 'resumePrivacyInspector';
export const MSG_GET_PRIVACY_INSPECTOR_DATA = 'getPrivacyInspectorData';
export const MSG_PRIVACY_INSPECTOR_ENTRY = 'privacyInspectorEntry';
export const MSG_PRIVACY_INSPECTOR_CLOSED = 'privacyInspectorClosed'; // notify panel to close (timeout / clash / force-close) — mirrors MSG_MATRIX_CLOSED
export const MSG_ADD_PRIVACY_SCRIPTLET_RULE = 'addPrivacyScriptletRule'; // panel → SW, mitigation via scriptlet
export const MSG_APPLY_PRIVACY_EXTRAS = 'applyPrivacyExtras'; // panel → SW, sent once after "Block All" completes — see applyPrivacyExtrasForHost() in custom-scriptlets.js

// ── Cookie / consent-clicker ─────────────────────────────────────────────
// See COOKIE-CLICKER-DESIGN.md for the feature's full design history.

// picker content script (js/scripting/cookie-clicker-picker.js) → SW.
// Persists one new rule; SW responds { ok, rule } (rule includes the
// stamped uid/id/createdAt — see cookie-clicker-rules.js's
// addCookieClickerRule()).
export const MSG_COOKIE_CLICKER_ADD_RULE = 'cookieClickerAddRule';
// picker content script → SW → SW relays to every OTHER frame of the
// same tab (frameId omitted from tabs.sendMessage broadcasts to every
// frame — see the picker file's own comment on this call), so pressing
// Escape or saving in ANY one frame's picker instance exits pick mode
// everywhere in that tab, not just locally.
export const MSG_COOKIE_CLICKER_PICKER_STOP = 'cookieClickerPickerStop';

// dashboard (Manage Custom Rules) → SW — same
// get/delete/clear/deleteFiltered/import shape as the Dynamic DNR
// (matrix) and cosmetic categories right above.
export const MSG_GET_COOKIE_CLICKER_RULES          = 'getCookieClickerRules';
export const MSG_DELETE_COOKIE_CLICKER_RULE        = 'deleteCookieClickerRule';
export const MSG_CLEAR_COOKIE_CLICKER_RULES        = 'clearCookieClickerRules';

// ── Never-consent / cookie-clicker auto-deny (v8.2) ──────────────────────
// Popup ->SW
// get/start/cancel triad, same shape as the existing tempDisableGet/
// Start/Cancel triad (js/core/temp-disable-manager.js) this feature is
// directly modeled on. 'cookieClickerAutoDenyExpire' is dispatched
// internally by js/data/alarms.js's processDueJobs() (no MSG_* constant
// needed for it — same convention 'tempDisableExpire' already follows,
// a plain string literal used only at its two route-table/dispatch-table
// call sites, never imported elsewhere).
export const MSG_COOKIE_CLICKER_AUTODENY_GET    = 'cookieClickerAutoDenyGet';
export const MSG_COOKIE_CLICKER_AUTODENY_START  = 'cookieClickerAutoDenyStart';
// (10.7.1) Seamless surfing prompt dismissed — records the prompt as answered (seamless-cookie-prompt.js). (11.0.0) Sent when
// the prompt is closed — a click outside it or Escape (keeps the existing choice); the Cancel button is gone.
export const MSG_SEAMLESS_COOKIE_PROMPT_DISMISS = 'seamlessCookiePromptDismiss';
// (10.7.1) MSG_COOKIE_CLICKER_AUTODENY_CANCEL ('cookieClickerAutoDenyCancel') REMOVED — no sender since the D6 toggle-off went.
// REMOVED (this pass) — MSG_COOKIE_CLICKER_DETECT_CMP. Declared "so the
// detection result's own shape/name has one declared home" but never
// actually imported, sent, or read anywhere: cookie-clicker-detect.js's
// one-off chrome.scripting.executeScript() result is consumed directly as
// a returned value in handleCookieClickerLaunchPicker
// (js/workflow/cookie-clicker-routes.js), never as a runtime.sendMessage
// payload — confirmed by a full-tree grep, zero other references, before
// removing. Caught by tools/check-message-routing.mjs's C20a cross-check.
// If a real message-based use for this name is ever needed, re-add it
// then, wired to an actual sender/handler — not as a placeholder.
// (8.2.17) The full "toggle off, else detect+inject" sequence popup.js's
// own #gotoCookieClicker click handler used to run entirely within its
// own ephemeral window — moved to the background service worker
// (handleCookieClickerLaunchPicker, js/workflow/cookie-clicker-
// routes.js) since a Chrome extension popup closes the instant it loses
// focus, and the detection step's own bounded retry (8.2.9, up to ~1.5s)
// made that sequence vulnerable to being silently abandoned mid-flight —
// the real cause behind "sometimes I have to click a few times before
// it starts."
export const MSG_COOKIE_CLICKER_LAUNCH_PICKER = 'cookieClickerLaunchPicker';

// v8.3.19 — Worry-free surfing mode's own launch message, same
// shape/reasoning as MSG_COOKIE_CLICKER_LAUNCH_PICKER just above (sent
// only from popup.js's #gotoWorryFree handler, fire-and-forget, popup
// closes immediately after sending) — see js/workflow/cookie-clicker-
// routes.js's handleWorryFreeLaunchPicker().
export const MSG_WORRY_FREE_LAUNCH_PICKER = 'worryFreeLaunchPicker';

// (11.0.0) "Ad leftover cleaner" (js/data/ad-cleaner.js). LAUNCH: popup.js #gotoAdCleaner, fire-and-forget (the popup
// closes at once), same shape as MSG_COOKIE_CLICKER_LAUNCH_PICKER. KEEP: sent by the page script
// js/scripting/ad-cleaner.js (content script; its own copy of this string is proven equal by tools/test-ad-cleaner.mjs).
export const MSG_AD_CLEANER_LAUNCH = 'adCleanerLaunch';
export const MSG_AD_CLEANER_KEEP   = 'adCleanerKeep';
