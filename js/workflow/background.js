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

/*******************************************************************************

    STATE / GUARDS / TIMERS REFERENCE
    ==================================
    (Kept up to date manually - see the code-quality audit that introduced
    this block for the methodology.)

    STATE OVERVIEW
    --------------
    - Persisted (chrome.storage.local, survives browser restart):
      rulesetConfig (config.js), filteringModeDetails (mode-manager.js),
      sandboxFilters.dnrRules (filter-manager.js / compiled-filters.js -
      network + cosmetic rules compiled from the sandbox ABP editor; the
      userScripts permission and its sandboxFilters.userScripts key were
      removed in v3.12), custom per-hostname filters under "site.*" keys,
      userDnrRules.
    - Persisted (chrome.storage.session, survives SW restart but not browser
      restart): a session-only mirror of rulesetConfig/filteringModeDetails,
      used so a SW restart doesn't need to re-derive everything from local
      storage on every wakeup - see config.js/_loadRulesetConfig() and
      mode-manager.js/readFilteringModeDetails().
    - In-memory only (lost on SW restart, and why that's safe):
        * action.js: reverseMode (bool) - recomputed and corrected on the
          very next registerToolbarIconToggler() call after restart.
        * background.js: lastIconLevelByTab (Map<tabId, level>) - a dedup
          cache only; losing it just costs one redundant (not incorrect)
          browser.action.setIcon() call per tab after a restart.
        * compiled-filters.js: compileLock (createLock) - a same-lifetime
          sequencing helper for compile/register calls, not meant to
          survive restart.
        * permissionChangeLock (createLock) - same-lifetime sequencing of
          permission changes only (see the RACE CONDITION GUARDS section below).
        * matrix-panel.js: entriesByDomain (Map), session (Object|null),
          sessionTimeoutHandle/watchdogHandle - the live Matrix-panel
          session state (this project's own 3P traffic monitor; see that
          file's own header for the full state/guard account - it is the
          current owner of the session-monitor role this comment block
          used to describe for the retired block-monitor.js module).

    STATE GUARDS
    ------------
    - swLifecycle (config.js): single state vector for the SW startup lane.
      phase progresses booting → starting → ready (or error on throw).
      startPhase tracks the sub-step within 'starting' so a hang during
      startup is immediately pinpointed in devtools.
      All event listeners gate on swLifecycle.phase === SW_PHASES.READY via
      the isFullyInitialized promise.
    - swLifecycle.firstRun / .wakeupRun: set once by loadRulesetConfig(),
      distinguish fresh-install from SW-wakeup so one-time setup doesn't re-run.
      Exposed as `process` alias for backward compat with call sites.

    RACE CONDITION GUARDS
    ----------------------
    - onPermissionsChanged() (this file): runs every permission change under
      permissionChangeLock (createLock), one at a time in arrival order, so
      overlapping permission events can't interleave; a failure is logged and
      the next change still runs (10.7.8, uBO 30c897c).
    - compiled-filters.js: compileLock (createLock) serialises
      updateCompiledFilters() calls, so a sandbox save that arrives
      mid-compile doesn't race the previous one. (registerUserScripts() was
      removed in v3.12 along with the userScripts permission; the security
      scriptlet registration that replaced it, registerSecurityContentScripts(),
      was removed in the 10.6.4 audit — no security scriptlet exists since 10.5.0.)

    ENDLESS LOOP GUARDS
    --------------------
    - popup.js: tryInit() retries at most INIT_RETRY_MAX_ATTEMPTS (20) times,
      INIT_RETRY_DELAY_MS (100ms) apart, rather than forever, if init()
      keeps throwing.

    TIMER REFERENCE
    ---------------
    - TAB_RELOAD_DELAY_MS (data/ext.js, 437ms, exported alongside
      reloadTab()): the short delay before reloading/navigating a tab
      after a filtering-relevant change, to give the just-updated content
      scripts/DNR rules a moment to register first. Used by reloadTab()'s
      three real callers — onPermissionGrantedThruBrowser() below,
      matrix-routes.js's handleReloadMatrixTab(), and
      core/site-mode-manager.js's applySiteMode() (which calls reloadTab()
      directly rather than a plain browser.tabs.reload(), for the same
      reason). Centralised as one constant specifically so none of these
      call sites can silently drift apart. (This comment previously named
      a fourth caller, "popup.js: commitFilteringMode()" — that function
      does not exist anywhere in this fork; it was upstream uBOL's
      location for the same reload, before this fork moved site-mode
      application into site-mode-manager.js. Corrected here rather than
      left to describe a file that was never actually checked.)
    - OFFSCREEN_COMPILE_TIMEOUT_MS (compiled-filters.js, 60000ms): upper
      bound while waiting for the offscreen document to finish compiling
      sandbox filters, cleared via clearTimeout() in a `finally` block the
      moment the real result arrives (or the offscreen document fails).
    - INIT_RETRY_DELAY_MS / INIT_RETRY_MAX_ATTEMPTS (popup.js): see ENDLESS
      LOOP GUARDS above.
    - The debounce timer in develop.js (editor auto-save) guards against re-entrancy by
      checking/clearing their own timer id before scheduling a new one.
    - SESSION_TIMEOUT_MS / watchdogHandle (matrix-panel.js): primary session
      timeout plus a belt-and-suspenders setInterval fallback for the Matrix
      panel's own timed session - see that file's own header for the full
      account (this entry used to describe the retired block-monitor.js
      module, which matrix-panel.js's session mechanism replaced).

*******************************************************************************/

/*******************************************************************************

    READING MAP (10.7.12 — sections; settings moved to settings-routes.js)
    =====================================================================
    The order of the code is the order the service worker needs: every
    top-level statement still runs in exactly the same sequence as before.

     1. Imports                         (tier order: data/, util/, core/)
     2. Module constants, shared helpers
     3. Permission changes              (host permissions granted/removed)
     4. Small route handlers            config, options page and popup data, prune, keepAlive
     5. Message routing                 ROUTE_HANDLERS table + onMessage()
     6. Startup                         version migration, startSession(), start()
     7. Initialisation promise          isFullyInitialized (every listener waits on it)
     8. Event wiring: messages, permissions
     9. Toolbar icon, tabs and navigation (tab-under guard, block page,
                                        Seamless prompt, custom scriptlets)
    10. Alarms and session deadlines
    11. Browser-restart-only actions    (onStartup + the storage.session fallback)
    12. Right-click context menu

    Most message handlers live in their own *-routes.js files; section 5
    lists which file holds which handlers.

*******************************************************************************/

/* ══════════════════════════════════════════════════════════════
   1. IMPORTS
   tier order: data/ (5), util/ (4), core/ (3) — routed handlers come from the *-routes.js files
   ══════════════════════════════════════════════════════════════ */

// ── Tier 5 — data/ ──────────────────────────────────────────────────────────

// Dispatcher refactor (see dispatcher-refactor-plan.md) — routing metadata
// lives in its own module; handler logic (below) stays in background.js.
import { dispatchRoutedMessage, isTrustedSender } from './message-routes.js';

import {
    handleClearMatrixBlockRules,
    handleDeleteMatrixBlockRule,
    handleGetMatrixBlockRules,
    handleGetMatrixData,
    handleMatrixSetOverride,
    handleMatrixSetOverrides,
    handleReloadMatrixTab,
    handleStartMatrix,
    handleStopMatrix,
    handleGetDomainRuleDetail,
} from './matrix-routes.js';

import {
    handleGetSecurityConfig,
    handleSetSecurityConfig,
} from './security-routes.js';

import {
    handleGetAllDynamicRules,
    handleGetAllSessionRules,
    handleUpdateUserDnrRules,
    handleGetEffectiveUserRules,
    handleGetEnabledRulesets,
    handleSetRulesetEnabled,
    handleGetLanguageFilterCountries,
    handleSetLanguageFilterCountries,
} from './ruleset-routes.js';

import {
    handleSiteModeGet,
    handleSiteModeGetAll,
    handleSiteModeSet,
    handleSiteModeSetAll,
    handleGetFilteringMode,
    handleSetFilteringMode,
    handleGetFilteringModeDetails,
    handleSetFilteringModeDetails,
    handleGetDefaultFilteringMode,
    handleSetDefaultFilteringMode,
    handleWorryfreeGetAll,
    handleWorryfreeSetAll,
} from './mode-routes.js';

import {
    handleInsertCSS,
    handleRemoveCSS,
    handleInjectCSSProceduralAPI,
    handleStartCustomFilters,
    handleTerminateCustomFilters,
    handleInjectCustomFilters,
    handleGetToolOverlaySecret,
    handleAddCustomFilters,
    handleClearCosmeticRules,
    handleDeleteCosmeticRule,
    handleGetCustomCosmeticRules,
} from './filter-routes.js';
import { isVersionOlderThan } from '../util/version-compare.js';

import {
    handlePrivacyInspectorEvent,
    handleGetMatchingScriptletRules,
    handleStartPrivacyInspector,
    handleStopPrivacyInspector,
    handlePausePrivacyInspector,
    handleResumePrivacyInspector,
    handleGetPrivacyInspectorData,
    handleAddPrivacyScriptletRule,
    handleApplyPrivacyExtras,
    handleGetPrivacyScriptletRules,
    handleDeletePrivacyScriptletRule,
    handleClearPrivacyScriptletRules,
} from './privacy-inspector-routes.js';

import {
    handleExportCustomRules,
    handleImportCustomRules,
    handleExportAllSettings,
    handleImportAllSettings,
    handleResetAllSettings,
    handleDeleteFilteredCustomRules,
    handleGetSandboxFilters,
    handleSetSandboxFilters,
} from './settings-routes.js';

import {
    handleTempDisableGet,
    handleTempDisableStart,
    handleTempDisableStartUntilRestart,
    handleTempDisableCancel,
    handleTempDisableExpire,
} from './temp-disable-routes.js';

import {
    browser,
    localRead, localRemove, localWrite,
    runtime,
    sessionAccessLevel,
    reloadTab,
    sessionRead, sessionWrite,
    getCurrentVersion,
} from '../data/ext.js';

import { loadRulesetDetailsMap } from '../data/ruleset-details-loader.js';

import {
    loadRulesetConfig,
    process,
    swLifecycle,
    SW_PHASES,
    rulesetConfig,
    saveRulesetConfig,
    saveSecurityConfig,
    securityConfig,
} from '../data/config.js';
import { CONTEXT_MENU_TOOL_IDS, POWER_TOOLS_SETTING_KEY, arePowerToolsShown } from '../data/power-tools.js';

import {
    DEFERRED_JOBS_ALARM_NAME,
    processDueJobs,
    resetJobsAlarm,
} from '../data/alarms.js';

import { dnr } from '../data/ext-compat.js';
import { openOrFocusPanel } from '../core/panel-window.js';
import { findJsonLossyValue } from '../util/json-safe.js';
// (audit 10.6.4, C13b) The dnr-budgets.js import of four retired range constants
// (WORRY_FREE_EXTRA_RULES_BASE_ID, STRICT_3P_RULES_BASE_ID, HIGH_RISK_HEADERS_RULES_BASE_ID/_SLOTS)
// was removed — nothing here used them; the ranges stay reserved in dnr-budgets.js itself.

import {
    MSG_GET_CUSTOM_COSMETIC_RULES,
    MSG_DELETE_COSMETIC_RULE,
    MSG_CLEAR_COSMETIC_RULES,
    MSG_GET_MATRIX_BLOCK_RULES,
    MSG_DELETE_MATRIX_BLOCK_RULE,
    MSG_CLEAR_MATRIX_BLOCK_RULES,
    MSG_GET_ENABLED_RULESETS,
    MSG_SET_RULESET_ENABLED,
    MSG_GET_LANGUAGE_FILTER_COUNTRIES,
    MSG_SET_LANGUAGE_FILTER_COUNTRIES,
    MSG_SITE_MODE_GET,
    MSG_SITE_MODE_SET,
    MSG_GET_PRIVACY_SCRIPTLET_RULES,
    MSG_DELETE_PRIVACY_SCRIPTLET_RULE,
    MSG_CLEAR_PRIVACY_SCRIPTLET_RULES,
    MSG_GET_MATCHING_SCRIPTLET_RULES,
    MSG_GET_TOOL_OVERLAY_SECRET,
    MSG_START_PRIVACY_INSPECTOR,
    MSG_STOP_PRIVACY_INSPECTOR,
    MSG_PAUSE_PRIVACY_INSPECTOR,
    MSG_RESUME_PRIVACY_INSPECTOR,
    MSG_GET_PRIVACY_INSPECTOR_DATA,
    MSG_ADD_PRIVACY_SCRIPTLET_RULE,
    MSG_APPLY_PRIVACY_EXTRAS,
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
import { AD_CLEANER_NAME, COOKIE_CLICKER_NAME, DNR_TRACKING_FILTER_NAME, FINGERPRINT_INSPECTOR_NAME } from '../data/ui-names.js';   // (11.0.0) right-click item titles
import { SEAMLESS_ENABLED_SETTING_KEY, isSeamlessSurfingEnabled } from '../data/seamless-switch.js';   // (11.0.0) Seamless surfing always on

// ── Tier 4 — util/ ──────────────────────────────────────────────────────────
import {
    hostnameFromMatch,
} from '../util/utils.js';

// ── Tier 3 — core/ ──────────────────────────────────────────────────────────
import { injectCustomScriptletsForFrame } from '../core/custom-scriptlets.js';

import {
    getDefaultFilteringMode,
    getFilteringMode,
    syncWithBrowserPermissions,
    MODE_NONE,
} from '../core/mode-manager.js';

import { getSandboxFilters } from '../core/filter-manager.js';

import {
    updateUserRules,
    applyBadgeCountVisibility,
} from '../core/ruleset-manager.js';

import {
    getRegisteredContentScripts,
    pruneCSSCache,
    registerContentScripts,
    registerScriptletContentScripts,
    registerCosmeticContentScripts,
    registerCookieClickerContentScripts,
    getScriptingManagerLockState,
    catchUpAlreadyOpenTabsForScriptlets,
} from '../core/scripting-manager.js';


import { setToolbarIconForLevel } from '../core/action.js';

import { setRulesetEnabled, restoreEnabledRulesetsFromStorage } from '../core/static-rulesets.js';
import { addLanguageFilterCountries } from '../core/language-filter-countries.js';
import {
    pickLanguageFilters, pickFirstLanguageFilters, FIRST_LANGUAGE_FILTERS_SINCE, FIRST_LANGUAGE_FILTERS_MARKER_KEY,
} from '../core/language-auto-enable.js';
import {
    browserEnvironment, countryFromRegion, countryFromTimeZone, initCountryResolver, languagesOfCountry, releaseCountryResolver,
} from '../core/country-resolver.js';
import { restoreMatrixBlockRules } from '../core/matrix-block-rules.js';
import { updateBuiltinWhitelistRules } from '../core/builtin-whitelist-rules.js';
import { applyWorryfreeRules } from '../core/worryfree-manager.js';
import { loadBuiltinExemptDomains, refreshImportedExemptDomains } from '../core/exempt-domains.js';
import {
    loadBuiltinTabUnderEntries,
    refreshImportedTabUnderEntries,
    recordTabUnderCommit,
    restoreTabUnderNavigation,
    releaseTabUnderTab,
} from '../core/tab-under-guard.js';
import { showBlockPageForFailedLoad } from '../core/block-page.js';
import { updateBuiltinFixExceptions } from '../core/builtin-fix-exceptions.js';

import {
    handleCookieClickerAddRule,
    handleCookieClickerPickCancelled,
    handleGetCookieClickerRules,
    handleDeleteCookieClickerRule,
    handleClearCookieClickerRules,
    handleCookieClickerAutoDenyGet,
    handleCookieClickerAutoDenyStart,
    handleSeamlessCookiePromptDismiss,
    handleCookieClickerPickerResumeFallback,
    handleCookieClickerLaunchPicker,
    handleWorryFreeLaunchPicker,
    injectSeamlessPrompt,
} from './cookie-clicker-routes.js';
// (11.0.0) Ad leftover cleaner — launch and keep (js/data/ad-cleaner.js).
import { handleAdCleanerKeep, handleAdCleanerLaunch } from './ad-cleaner-routes.js';
import { isCookiePromptDue, markCookiePromptOffered } from '../core/seamless-cookie-prompt.js';
import {
    handleMatrixDeadlineAlarm,
    reconcileMatrixDeadline,
    reconcileMatrixCaches,
} from '../core/matrix-panel.js';


import {
    handlePrivacyInspectorDeadlineAlarm,
    reconcilePrivacyInspectorDeadline,
} from '../core/privacy-inspector.js';

import {
    clearTempDisableOnBrowserStartup,
} from '../core/temp-disable-manager.js';

import { clearBrowsingDataOnBrowserStartup } from '../core/history-cleaner.js';
import { registerBlockedPopupCloser } from '../core/blocked-popup-closer.js';
import { applySeamlessSwitch, clearAutoDenyOnBrowserStartup, getAutoDenyState, retireTimedSession, startAutoDeny } from '../core/cookie-clicker-autodeny-manager.js';
import { reconcileWorryFreeExtraSuppressionRule } from '../core/worry-free-extra-manager.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';
import { createLock } from '../util/async-lock.js';


/* ══════════════════════════════════════════════════════════════
   2. MODULE CONSTANTS AND SHARED HELPERS
   ══════════════════════════════════════════════════════════════ */

const UBOL_ORIGIN = runtime.getURL('').replace(/\/$/, '').toLowerCase();
function canShowBlockedCount() { return typeof dnr.setExtensionActionOptions === 'function'; }

// DEVTOOLS DEBUGGING AID — this project's first instance of this pattern
// (no prior convention to match; established here per explicit request).
// ES module exports are NOT automatically visible to a service worker's
// DevTools console REPL — only names explicitly attached to `self` are.
// getScriptingManagerLockState() (scripting-manager.js) existed but was
// unreachable from the console for exactly this reason — the underlying
// phase-tagged lock mechanism (js/util/async-lock.js's createLock(),
// implemented in 5.0.16-5.0.17) was always correct, only the "devtools
// visibility" half of that original ask was still missing. Exposed here,
// not called by any other code in this codebase — inspect via the SW's
// "Inspect" DevTools console: getScriptingManagerLockState().
self.getScriptingManagerLockState = getScriptingManagerLockState;

// getCurrentVersion() lives in ../data/ext.js since 10.7.12 (settings-routes.js uses it too).

/* ══════════════════════════════════════════════════════════════
   3. PERMISSION CHANGES
   a host permission granted or removed through the browser
   ══════════════════════════════════════════════════════════════ */

// When a new host permission is granted through the browser
async function onPermissionGrantedThruBrowser(origins) {
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return; }
    await registerContentScripts();
    if ( rulesetConfig.autoReload !== true ) { return; }
    if ( origins.length !== 1 ) { return; }
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if ( typeof tabId !== 'number' || tabId === -1 ) { return; }
    const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [ 0 ] },
        func: ( ) => document.location.hostname,
    }).catch(catchExpected('read active tab hostname', [ EXPECTED_ERRORS.TAB_GONE, EXPECTED_ERRORS.NOT_SCRIPTABLE ]));
    const tabHostname = results?.[0]?.result;
    if ( typeof tabHostname !== 'string' ) { return; }
    const hostname = hostnameFromMatch(origins[0]);
    if ( tabHostname.endsWith(hostname) === false ) { return; }
    const pos = tabHostname.length - hostname.length;
    if ( pos !== 0 && tabHostname.charAt(pos-1) !== '.' ) { return; }
    await reloadTab(tabId);
}

// https://github.com/uBlockOrigin/uBOL-home/issues/280
async function onPermissionsAdded(permissions) {
    const { origins = [] } = permissions;
    return onPermissionGrantedThruBrowser(origins);
}

async function onPermissionsRemoved() {
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return false; }
    // (10.7.8) awaited, so the next queued permission change starts only after registration finished (uBO 30c897c).
    await registerContentScripts();
    return true;
}

// (10.7.8) One lock for all permission changes (uBO 30c897c; C5 rule 4). The previous version awaited a snapshot of
// a `pending` array, so two changes arriving in the same tick both saw it empty and ran at the same time. A failed
// change is logged with context and does not block the next one.
const permissionChangeLock = createLock('permission-changes');

async function onPermissionsChanged(op, permissions) {
    await isFullyInitialized;
    return permissionChangeLock.withLock(( ) => op === 'removed'
        ? onPermissionsRemoved()
        : onPermissionsAdded(permissions)
    ).catch(catchExpected(`apply permission change (${op})`, []));
}

/* ══════════════════════════════════════════════════════════════
   4. SMALL ROUTE HANDLERS
   ══════════════════════════════════════════════════════════════ */

async function handleGetCurrentConfig() {
    return rulesetConfig;
}

async function handleGetOptionsPageData() {
    const defaultFilteringMode = await getDefaultFilteringMode();
    process.firstRun = false;
    return {
        defaultFilteringMode,
        autoReload: rulesetConfig.autoReload,
        showBlockedCount: rulesetConfig.showBlockedCount,
        canShowBlockedCount: canShowBlockedCount(),
        firstRun: process.firstRun,
    };
}

async function handlePopupPanelData(request) {
    const level = await getFilteringMode(request.hostname);
    return {
        level,
        autoReload: rulesetConfig.autoReload,
        // (11.0.0) "I am an advanced user (unhide power tools)" — the popup hides the power-tool lines when false.
        powerTools: arePowerToolsShown(securityConfig),
    };
}

async function handlePruneCSSCache() {
    return pruneCSSCache();
}

// This is used to ensure we are not suspended while busy fetching filter
// lists from remote servers.
async function handleKeepAlive() {
    return;
}

/* ══════════════════════════════════════════════════════════════
   5. MESSAGE ROUTING
   ROUTE_HANDLERS (request.what -> handler) and the one onMessage() router (C3)
   ══════════════════════════════════════════════════════════════ */

// Where the routed handlers live (10.7.12 — replaces the "moved to …" notes that used to be scattered
// through this file; ROUTE_HANDLERS below is the authoritative list):
//   filter-routes.js            CSS insert/remove, procedural CSS API, custom (picker) filters, tool-overlay
//                               secret, custom cosmetic rules
//   privacy-inspector-routes.js Fingerprint Inspector session + its privacy scriptlet rules
//   matrix-routes.js            Matrix panel session, Matrix block rules, domain rule detail
//   security-routes.js          security config
//   ruleset-routes.js           dynamic/session/user DNR rules, enabled rulesets, language-filter countries
//   mode-routes.js              site modes, filtering modes (+ refreshToolbarIconsForOpenTabs()), $worryfree lists
//   temp-disable-routes.js      "Buying, booking, banking mode" (timed global pause)
//   cookie-clicker-routes.js    cookie consent clicker rules, auto-deny, pickers, Seamless prompt
//   settings-routes.js          Save/Restore/Reset settings, custom-rules export/import, Delete rules, Import ABP save
//   this file                   config/options/popup data, prune, keepAlive (section 4)
// Elsewhere: reloadTab() lives in ../data/ext.js (shared with core/). block-monitor.js (the old Tracker Radar
// session monitor) was removed — superseded by the Matrix panel, whose "Known tracker" column uses
// js/core/tracker-radar-lookup.js.
//
// Single source of truth mapping a routed `request.what` to its handler.
// Grows alongside MESSAGE_ROUTES in message-routes.js — add both in the same
// commit, never one without the other (a route with no handler, or a handler
// with no route, is a wiring bug the dispatcher will flag via console.warn).
const ROUTE_HANDLERS = {
    insertCSS: handleInsertCSS,
    removeCSS: handleRemoveCSS,
    injectCSSProceduralAPI: handleInjectCSSProceduralAPI,
    startCustomFilters: handleStartCustomFilters,
    terminateCustomFilters: handleTerminateCustomFilters,
    injectCustomFilters: handleInjectCustomFilters,
    privacyInspectorEvent: handlePrivacyInspectorEvent,
    [MSG_GET_MATCHING_SCRIPTLET_RULES]: handleGetMatchingScriptletRules,
    [MSG_GET_TOOL_OVERLAY_SECRET]: handleGetToolOverlaySecret,
    [MSG_COOKIE_CLICKER_ADD_RULE]: handleCookieClickerAddRule,
    cookieClickerPickCancelled: handleCookieClickerPickCancelled,
    [MSG_START_PRIVACY_INSPECTOR]: handleStartPrivacyInspector,
    [MSG_STOP_PRIVACY_INSPECTOR]: handleStopPrivacyInspector,
    [MSG_PAUSE_PRIVACY_INSPECTOR]: handlePausePrivacyInspector,
    [MSG_RESUME_PRIVACY_INSPECTOR]: handleResumePrivacyInspector,
    [MSG_GET_PRIVACY_INSPECTOR_DATA]: handleGetPrivacyInspectorData,
    [MSG_ADD_PRIVACY_SCRIPTLET_RULE]: handleAddPrivacyScriptletRule,
    [MSG_APPLY_PRIVACY_EXTRAS]: handleApplyPrivacyExtras,
    [MSG_GET_PRIVACY_SCRIPTLET_RULES]: handleGetPrivacyScriptletRules,
    [MSG_DELETE_PRIVACY_SCRIPTLET_RULE]: handleDeletePrivacyScriptletRule,
    [MSG_CLEAR_PRIVACY_SCRIPTLET_RULES]: handleClearPrivacyScriptletRules,
    [MSG_GET_CUSTOM_COSMETIC_RULES]: handleGetCustomCosmeticRules,
    [MSG_DELETE_COSMETIC_RULE]: handleDeleteCosmeticRule,
    [MSG_CLEAR_COSMETIC_RULES]: handleClearCosmeticRules,
    [MSG_GET_COOKIE_CLICKER_RULES]: handleGetCookieClickerRules,
    [MSG_DELETE_COOKIE_CLICKER_RULE]: handleDeleteCookieClickerRule,
    [MSG_CLEAR_COOKIE_CLICKER_RULES]: handleClearCookieClickerRules,
    [MSG_GET_MATRIX_BLOCK_RULES]: handleGetMatrixBlockRules,
    [MSG_DELETE_MATRIX_BLOCK_RULE]: handleDeleteMatrixBlockRule,
    [MSG_CLEAR_MATRIX_BLOCK_RULES]: handleClearMatrixBlockRules,
    [MSG_EXPORT_CUSTOM_RULES]: handleExportCustomRules,
    [MSG_IMPORT_CUSTOM_RULES]: handleImportCustomRules,
    [MSG_EXPORT_ALL_SETTINGS]: handleExportAllSettings,
    [MSG_IMPORT_ALL_SETTINGS]: handleImportAllSettings,
    [MSG_RESET_ALL_SETTINGS]: handleResetAllSettings,
    [MSG_DELETE_FILTERED_CUSTOM_RULES]: handleDeleteFilteredCustomRules,
    [MSG_SITE_MODE_GET]: handleSiteModeGet,
    [MSG_SITE_MODE_SET]: handleSiteModeSet,
    siteModeGetAll: handleSiteModeGetAll,
    siteModeSetAll: handleSiteModeSetAll,
    worryfreeGetAll: handleWorryfreeGetAll,
    worryfreeSetAll: handleWorryfreeSetAll,
    getCurrentConfig: handleGetCurrentConfig,
    getSecurityConfig: handleGetSecurityConfig,
    setSecurityConfig: handleSetSecurityConfig,
    getOptionsPageData: handleGetOptionsPageData,
    popupPanelData: handlePopupPanelData,
    getFilteringMode: handleGetFilteringMode,
    setFilteringMode: handleSetFilteringMode,
    getDefaultFilteringMode: handleGetDefaultFilteringMode,
    setDefaultFilteringMode: handleSetDefaultFilteringMode,
    getFilteringModeDetails: handleGetFilteringModeDetails,
    setFilteringModeDetails: handleSetFilteringModeDetails,
    getAllDynamicRules: handleGetAllDynamicRules,
    getAllSessionRules: handleGetAllSessionRules,
    getEffectiveUserRules: handleGetEffectiveUserRules,
    updateUserDnrRules: handleUpdateUserDnrRules,
    addCustomFilters: handleAddCustomFilters,
    getSandboxFilters: handleGetSandboxFilters,
    setSandboxFilters: handleSetSandboxFilters,
    pruneCSSCache: handlePruneCSSCache,
    keepAlive: handleKeepAlive,
    tempDisableGet: handleTempDisableGet,
    tempDisableStart: handleTempDisableStart,
    tempDisableStartUntilRestart: handleTempDisableStartUntilRestart,
    tempDisableCancel: handleTempDisableCancel,
    tempDisableExpire: handleTempDisableExpire,
    [MSG_COOKIE_CLICKER_AUTODENY_GET]: handleCookieClickerAutoDenyGet,
    [MSG_COOKIE_CLICKER_AUTODENY_START]: handleCookieClickerAutoDenyStart,
    [MSG_SEAMLESS_COOKIE_PROMPT_DISMISS]: handleSeamlessCookiePromptDismiss,
    cookieClickerPickerResumeFallback: handleCookieClickerPickerResumeFallback,
    [MSG_COOKIE_CLICKER_LAUNCH_PICKER]: handleCookieClickerLaunchPicker,
    [MSG_WORRY_FREE_LAUNCH_PICKER]: handleWorryFreeLaunchPicker,
    [MSG_AD_CLEANER_LAUNCH]: handleAdCleanerLaunch,
    [MSG_AD_CLEANER_KEEP]: handleAdCleanerKeep,
    [MSG_GET_ENABLED_RULESETS]: handleGetEnabledRulesets,
    [MSG_SET_RULESET_ENABLED]: handleSetRulesetEnabled,
    [MSG_GET_LANGUAGE_FILTER_COUNTRIES]: handleGetLanguageFilterCountries,
    [MSG_SET_LANGUAGE_FILTER_COUNTRIES]: handleSetLanguageFilterCountries,
    [MSG_START_MATRIX]: handleStartMatrix,
    [MSG_STOP_MATRIX]: handleStopMatrix,
    [MSG_GET_MATRIX_DATA]: handleGetMatrixData,
    [MSG_MATRIX_SET_OVERRIDE]: handleMatrixSetOverride,
    [MSG_MATRIX_SET_OVERRIDES]: handleMatrixSetOverrides,
    [MSG_RELOAD_MATRIX_TAB]: handleReloadMatrixTab,
    [MSG_GET_DOMAIN_RULE_DETAIL]: handleGetDomainRuleDetail,
};

async function onMessage(request, sender) {

    const tabId = sender?.tab?.id ?? false;
    const frameId = tabId && (sender?.frameId ?? false);

    // Dispatcher refactor complete (see dispatcher-refactor-plan.md):
    // every `request.what` this listener handles has a declared route in
    // MESSAGE_ROUTES (message-routes.js). dispatchRoutedMessage() validates
    // requiresInit/allowedSenders generically instead of via switch-
    // statement position, then calls the matched handler below.
    const routed = await dispatchRoutedMessage(request, sender, {
        tabId,
        frameId,
        isFullyInitialized,
        isTrustedOrigin: ( ) => isTrustedSender(sender, UBOL_ORIGIN, runtime.id),   // (10.7.6) message-routes.js
    }, ROUTE_HANDLERS);
    if ( routed.handled ) { return routed.value; }

    // Stage B (content-script-sourced, no trusted-origin gate) is now fully
    // migrated to the routing table above — see MESSAGE_ROUTES in
    // message-routes.js. Stage C (genuine extension pages: popup,
    // dashboard, Monitor / Privacy Inspector panels) is likewise fully
    // migrated as of Stage 2, batch 3 — every `request.what` this listener
    // handles now has a declared route, and dispatchRoutedMessage() above
    // already applies the trusted-origin gate for EXTENSION_PAGE routes.
    // Nothing left to fall through to.

    // No route matched. Diagnostic only, per dispatcher-refactor-plan.md
    // §5 — never turn this into a thrown error or hard rejection. The
    // outer runtime.onMessage listener already filters out
    // `request.what.includes(':')` (the convention other listeners
    // coexisting on this same event use for their own namespaced
    // messages), so an unmatched, colon-free `what` reaching here is
    // unexpected, not necessarily invalid — likely a stale message from a
    // reloaded content script/page, or a genuine wiring bug worth noticing
    // during development.
    console.info(`[uBlock-Dynamic] onMessage: no route for '${request.what}' — ignored`);
    return;
}

/* ══════════════════════════════════════════════════════════════
   6. STARTUP
   one-time version migration, startSession() on install/update, start() on every worker boot
   ══════════════════════════════════════════════════════════════ */

// ── runVersionMigration() ───────────────────────────────────────────────────
// This codebase (10.0.3) starts a fresh release lineage with no in-place
// upgrade path from any pre-10.0.3 install (a deliberate, requested removal —
// see CHANGELOG_HISTORY.md's 10.0.3 entry for the full list of what was
// removed and why: 18 one-time steps carrying forward settings/DNR-rule
// cleanup for features retired between v6.4.0 and v9.6.8, none of which a
// genuinely fresh install, under a new extension ID with no prior storage,
// can ever need to run). The function below is intentionally the entire
// migration surface going forward — keep it that way (no step should be
// added "just in case"; see C13b, dead-guard/stale-state audit) until a
// REAL future version actually needs a one-time upgrade step of its own,
// at which point it is added here the same way the original 18 were: a
// comment naming the version and the exact condition being migrated away
// from.

// (10.5.0) migrateTo10_0_7() and its constants REMOVED (owner's clean-up of old conversion code).
// isVersionOlderThan() lives in js/util/version-compare.js — one comparator, not two copies (C21/B15).

async function runVersionMigration(currentVersion) {
    rulesetConfig.version = currentVersion;
    // (11.0.0) The 10.5.0 "Worry-free surfing at browser startup: ON once per install" step is REMOVED with that
    // option: Seamless surfing is always on (js/data/seamless-switch.js). Its stored marker is released by
    // js/data/config.js RETIRED_STORAGE_KEYS.
    // (10.7.0) Filters switched on by the browser's FIRST language (the English filter for sites outside the top
    // 1M): once per install — at install and on the update that introduced them — then the user's own choice
    // stands. Same marker discipline as the Worry-free step above (js/core/language-auto-enable.js). The marker
    // is written only after the enabling succeeded, so a failure is retried on the next start.
    try {
        const appliedIn = await localRead(FIRST_LANGUAGE_FILTERS_MARKER_KEY);
        if ( isVersionOlderThan(appliedIn, FIRST_LANGUAGE_FILTERS_SINCE) ) {   // due: never ran here
            const [ details, env ] = await Promise.all([ loadRulesetDetailsMap(), browserEnvironment() ]);
            for ( const id of pickFirstLanguageFilters([ ...details.values() ], env) ) {
                await setRulesetEnabled(id, true);
            }
            await localWrite(FIRST_LANGUAGE_FILTERS_MARKER_KEY, currentVersion);
        }
    } catch (reason) {
        console.error('[uBlock-Dynamic] runVersionMigration: 10.7.0 first-language filter step failed:', reason);
    }
    // (10.7.1) Timed Seamless surfing sessions retired: a session started with 20/60 minutes before this update
    // becomes open-ended and its expiry job is released. Idempotent, so no marker is needed — a second run finds
    // nothing to change.
    try {
        await retireTimedSession();
    } catch (reason) {
        console.error('[uBlock-Dynamic] runVersionMigration: 10.7.1 timed-session retirement failed:', reason);
    }
    // (10.5.0, audit finding) Persist the version the steps above ran for. It used to be set in memory
    // only, so after every browser restart rulesetConfig.version was '' again: every browser start was
    // treated as an update (migrations + full content-script re-registration each time). Saved LAST, so
    // a crash halfway leaves the old version and the steps are retried on the next start.
    await saveRulesetConfig();
}

// Sub-function: auto-enable the language filters that fit this browser.
// Runs only on first install (process.firstRun === true).
// (10.4.5) Decided by js/core/language-auto-enable.js from the browser's language list + UI language, and — only
// when none of those languages has a filter — the country (the time zone, else the region of a language tag, through
// js/core/country-resolver.js) with every language spoken there. Which filter answers which language stays pure
// data: each ruleset's (or country row's) `locales` in ruleset-details.json, generated from
// tools/build/filter-lists.mjs. The hidden "other EU" AdGuard Base bucket declares locales too, and this is its
// only enable path (see RULESET_COMPANIONS). A combined filter also gets the matching country rows recorded
// (js/core/language-filter-countries.js) so the dashboard shows them.
async function enableLocaleLanguageFilter() {
    // (10.4.5) Owner's rule, decided in js/core/language-auto-enable.js: the browser's languages first; only when
    // none has a filter, the country (time zone, else language-tag region) and every language spoken there.
    // GUARD (init/release): the resolver's lookup tables exist only for this one decision.
    let picks;
    try {
        await initCountryResolver();
        const [ details, env ] = await Promise.all([ loadRulesetDetailsMap(), browserEnvironment() ]);
        picks = pickLanguageFilters([ ...details.values() ], env, { countryFromRegion, countryFromTimeZone, languagesOfCountry });
    } catch (reason) {
        console.error('[uBlock-Dynamic] enableLocaleLanguageFilter: no automatic language filter —', reason);
        return;
    } finally {
        releaseCountryResolver();
    }
    for ( const [ id, rowIds ] of picks ) {
        if ( rowIds.length > 0 ) { await addLanguageFilterCountries(id, rowIds); }
        await setRulesetEnabled(id, true);
    }
}

// Sub-function: (re)register content scripts after a version bump or permission change.
async function syncScriptRegistrations(isNewVersion, permissionsUpdated) {
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/RegisteredContentScript#persistacrosssessions
    // "When an extension updates, content scripts are cleared"
    // (audit 10.6.4) The sec-* security scriptlet re-registration that used to sit here was removed
    // with registerSecurityContentScripts(); by the note above, Chrome clears any old sec-* registration
    // itself when the extension updates.
    if ( isNewVersion || permissionsUpdated ) {
        await Promise.all([
            registerContentScripts(),
            updateUserRules(),
        ]);
    }
}

async function startSession() {
    const currentVersion = getCurrentVersion();
    const isNewVersion = currentVersion !== rulesetConfig.version;

    if ( isNewVersion ) {
        swLifecycle.startPhase = 'migration';
        await runVersionMigration(currentVersion);
    }
    if ( process.firstRun ) {
        swLifecycle.startPhase = 'locale';
        await enableLocaleLanguageFilter();
    }

    // Permissions may have been removed while the extension was disabled.
    swLifecycle.startPhase = 'permissions';
    const permissionsUpdated = await syncWithBrowserPermissions();

    swLifecycle.startPhase = 'scripts';
    await syncScriptRegistrations(isNewVersion, permissionsUpdated);

    swLifecycle.startPhase = 'finalising';

    // (Tracker Radar's restoreMonitorBlockRules() call removed along with
    // the rest of block-monitor.js — see the import-site comment near the
    // top of this file. The NEW 3P Matrix rules restore themselves via
    // restoreMatrixBlockRules() instead — see Stage 5 below.)
    restoreMatrixBlockRules();

    // Global CRITICAL RESOURCE exemption (BUILTIN_DOMAINS) — bundled/
    // static data, never changes at runtime, so (unlike
    // restoreMatrixBlockRules() above) this never needs re-triggering
    // outside of an SW restart re-running this same startup path.
    updateBuiltinWhitelistRules();

    // $worryfree dynamic rules — persisted, person-editable data (unlike
    // BUILTIN_DOMAINS above): re-established here, and a no-op when the list
    // is empty (applyRules() adds nothing then, while still clearing any
    // stale ids).
    applyWorryfreeRules();

    // Built-in, domain-scoped exceptions for known upstream filter-list
    // miscategorizations (v9.3.0) — same bundled/static-data lifecycle as
    // updateBuiltinWhitelistRules() just above; applies regardless of
    // which default-filter or worry-free checkboxes are on/off. See
    // js/core/builtin-fix-exceptions.js's own header.
    updateBuiltinFixExceptions();

    // Re-apply the user's static-ruleset enable/disable choices — Chrome
    // resets these to the manifest's declared defaults on a version update
    // (see restoreEnabledRulesetsFromStorage()'s own comment for why).
    // startSession() itself only runs on a fresh install or version bump
    // (see start() below), which is exactly when this reset can happen, so
    // no extra isNewVersion check is needed here. Awaited (unlike
    // restoreMatrixBlockRules() above) because registerScriptletContentScripts()
    // and registerCosmeticContentScripts() right below both read the
    // enabled-ruleset set — running them before this resolves would race
    // against Chrome's own updateEnabledRulesets() calls and could register
    // content scripts for the pre-restore (wrong) set.
    await restoreEnabledRulesetsFromStorage();

    // Register pre-compiled scriptlet + cosmetic content scripts for enabled rulesets.
    registerScriptletContentScripts();
    registerCosmeticContentScripts();

    // Register the cookie/consent-clicker content script (a no-op,
    // idempotent unregister when no rules exist yet — see
    // registerCookieClickerContentScriptsImpl()'s own RELEASE guard).
    // Same "always re-assert every startup" reasoning as the two lines
    // just above: registerContentScripts() itself already re-registers
    // this group too (see its own Promise.all), but Chrome clears every
    // registered content script on an extension update (see
    // syncScriptRegistrations()'s own MDN citation above) — this call
    // guarantees a plain same-version SW wakeup (which skips
    // syncScriptRegistrations() entirely) still re-asserts it.
    registerCookieClickerContentScripts();

    // (10.7.6, audit 10.7.5 D-5, owner's option B) Session storage is for uBD's own pages and worker ONLY: it holds the
    // filtering-mode details, the ruleset config and the session states, and a content script (one per visited page)
    // could read and write ALL of it. 10.7.5 and earlier opened it to content scripts for one per-site CSS cache, which
    // now lives in storage.local (js/scripting/css-specific.js). Set explicitly: Chrome's default, re-asserted on every
    // worker start so no earlier setting survives.
    sessionAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

    // Icon badge count — single source of truth is ruleset-manager.js's
    // applyBadgeCountVisibility() (see that function's own comment —
    // it used to also account for enableGPC before GPC was removed as a
    // feature; now back to a straightforward passthrough of
    // rulesetConfig.showBlockedCount, kept as a real function since a
    // second call site may reasonably exist again in the future).
    applyBadgeCountVisibility();

    swLifecycle.startPhase = null;
}

/******************************************************************************/

async function start() {
    swLifecycle.phase = SW_PHASES.BOOTING;
    await loadRulesetConfig();
    // The ABP-import part of the per-site exemption lists is derived from the editor's stored text and held in
    // memory only (exempt-domains.js): recompute it here, before startSession()/registrations consume it.
    refreshImportedExemptDomains(await getSandboxFilters());
    // Built-in exemptions (10.2.0): the quick-fixes list's "$worryfree" lines are read from the shipped
    // quick-fixes ruleset (exempt-domains.js) — also in memory only, so loaded on every SW start, before
    // startSession() consumes them.
    await loadBuiltinExemptDomains();
    // (10.7.2) Tab-under guard: the ABP-import editor's and the Quick-fixes list's "$popunder" lines — in memory only,
    // so loaded on every SW start (js/core/tab-under-guard.js).
    refreshImportedTabUnderEntries(await getSandboxFilters());
    await loadBuiltinTabUnderEntries();

    // Always run startSession on a fresh install or version bump.
    // On a plain SW wakeup (same version) skip it — all persisted state is
    // already in place and re-running would needlessly rewrite DNR rules.
    swLifecycle.phase = SW_PHASES.STARTING;
    const isNewVersion = getCurrentVersion() !== rulesetConfig.version;
    if ( process.wakeupRun === false || isNewVersion ) {
        await startSession();
    }

    const scripts = await getRegisteredContentScripts();
    if ( scripts.length === 0 ) {
        await registerContentScripts();
    }

    // Reconcile the Worry-free extra suppression rule against the
    // persisted session state — covers fresh install and version bumps
    // (session rules start empty either way) — see worry-free-extra-
    // manager.js's own header on why this reconciliation exists.
    const autoDenyState = await getAutoDenyState();
    await reconcileWorryFreeExtraSuppressionRule(autoDenyState?.active === true);
    // (10.3.0) The high-risk-site header and sandbox-safe-scripts reconciles that used to follow here were
    // removed with those protections.
    // Same reconcile-on-every-SW-wake pattern, second instance — Matrix
    // panel's own blockedDomains/matrixOverridesCache caches (see
    // matrix-panel.js's reconcileMatrixCaches() for the real bug this
    // fixes: a mid-session SW restart silently emptied both, with
    // nothing to rebuild them for the rest of that session). No
    // autoDenyState/isActive parameter needed here — reconcileMatrixCaches()
    // determines "is there anything to reconcile" from Matrix's own
    // session state internally, not an externally-supplied flag.
    await reconcileMatrixCaches();

    // Fallback trigger for the restart-only actions below (history/downloads/cookies/etc. "clear at
    // browser start", temp-disable, Worry-free startup) — see RESTART_ONLY_ACTIONS_RAN_KEY's own
    // comment for why this exists alongside the onStartup listener rather than relying on that event
    // alone. Fire-and-forget: start()'s own caller (isFullyInitialized) must not wait on this.
    runBrowserRestartOnlyActionsOnce();
}

/* ══════════════════════════════════════════════════════════════
   7. INITIALISATION PROMISE
   isFullyInitialized — every listener below waits on it
   ══════════════════════════════════════════════════════════════ */

// https://github.com/uBlockOrigin/uBOL-home/issues/199
// Force a restart of the extension once when an "internal error" occurs

// (11.0.2, audit 11.0.2 finding 2 — first proposed as 10.7.5 D-8) LAST-RESORT LOGGER. An error or rejection that no
// handler caught still shows on chrome://extensions, but without our prefix or any hint of where it came from. These
// two listeners add both: the "[uBlock-Dynamic]" prefix and the worker's startup phase. They only log — no
// preventDefault(), so Chrome lists the original error exactly as before. Registered at top level, before start().
function describeWorkerPhase() {
    return `phase='${swLifecycle.phase}', startPhase='${swLifecycle.startPhase}'`;
}
self.addEventListener('unhandledrejection', event => {
    console.error(`[uBlock-Dynamic] unhandled rejection (${describeWorkerPhase()}):`, event.reason);
});
self.addEventListener('error', event => {
    console.error(`[uBlock-Dynamic] uncaught error (${describeWorkerPhase()}):`, event.error ?? event.message);
});

const isFullyInitialized = start().then(( ) => {
    swLifecycle.phase      = SW_PHASES.READY;
    swLifecycle.startPhase = null;
    swLifecycle.errorReason = null;
    localRemove('goodStart');
    return false;
}).catch(reason => {
    swLifecycle.phase       = SW_PHASES.ERROR;
    swLifecycle.errorReason = String(reason);
    console.error(
        `[uBlock-Dynamic] startup failed at startPhase='${swLifecycle.startPhase}':`,
        reason
    );
    swLifecycle.startPhase = null;
    if ( process.wakeupRun ) { return; }
    return localRead('goodStart').then(goodStart => {
        if ( goodStart === false ) {
            localRemove('goodStart');
            return false;
        }
        return localWrite('goodStart', false).then(( ) => true);
    });
}).then(restart => {
    if ( restart !== true ) { return; }
    runtime.reload();
});
/* ══════════════════════════════════════════════════════════════
   8. EVENT WIRING: MESSAGES AND PERMISSIONS
   ══════════════════════════════════════════════════════════════ */

// ── C31 development tripwire ──────────────────────────────────────────────
// Chrome sends message responses as JSON, so a Map/Set/Date/undefined in a
// response silently arrives changed (principle C31). In an UNPACKED build
// (how this extension is tested — a Web Store install always carries
// update_url in its installed manifest, an unpacked one never does) every
// response is checked and the first lossy value is logged with the message
// type. Store installs pay one boolean test per message, nothing more.
const IS_UNPACKED_BUILD = runtime.getManifest().update_url === undefined;

function warnIfResponseNotJsonSafe(what, response) {
    const problem = findJsonLossyValue(response, 'response');
    if ( problem !== null ) {
        console.warn(`[uBlock-Dynamic] C31: response to '${what}' will not survive messaging unchanged — ${problem}`);
    }
}

runtime.onMessage.addListener((request, sender, callback) => {
    if ( typeof request?.what !== 'string' || request.what.includes(':') ) { return; }
    onMessage(request, sender).then(
        response => {
            if ( IS_UNPACKED_BUILD ) { warnIfResponseNotJsonSafe(request.what, response); }
            callback(response);
        },
        reason => {
            console.error('[uBlock-Dynamic] onMessage rejected:', request?.what, reason);
            callback({ error: String(reason?.message || reason) });
        }
    );
    return true;
});

// userScripts message listener removed in v3.12 (userScripts permission dropped)

browser.permissions.onRemoved.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        onPermissionsChanged('removed', ...args);
    });
});

browser.permissions.onAdded.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        onPermissionsChanged('added', ...args);
    });
});
/* ══════════════════════════════════════════════════════════════
   9. TOOLBAR ICON, TABS AND NAVIGATION
   ══════════════════════════════════════════════════════════════ */

// Chrome resets a tab's per-tab toolbar icon override whenever that tab
// navigates. Re-apply the correct icon on every navigation directly from
// here, so it never depends on a content script's registration having
// already propagated (which can otherwise race with a fast manual reload).
//
// (10.5.6) ONE shared check, called from BOTH navigation points below —
// webNavigation.onCommitted (fires early) and tabs.onUpdated's 'complete'
// (fires later, as a confirming catch-up). Until now each computed the
// icon from a DIFFERENT source: onCommitted read site-mode-manager.js's
// siteModes alone (only the popup toggle), onUpdated read mode-manager.js's
// getFilteringMode() (the toggle AND mode-routes.js's per-hostname editor,
// which never touches siteModes). BUG FIXED (reported: wrong on/off icon —
// which also makes the block-count badge look absent, since the icon reads
// as off): a hostname set only through the editor could show the wrong
// icon from the first check and never get corrected, or get "corrected"
// only by accident, because the two checks weren't sharing one cache
// either. Both now read the one authoritative source and the one cache, so
// the second check is a cheap no-op confirmation in the normal case and a
// real correction only when the level genuinely changed between the two —
// which is the only reason to keep checking twice.
// Bound (B6): one entry per open tab at most; deleted on tabs.onRemoved (below) and when the tab shows a non-filterable page.
const lastIconLevelByTab = new Map();

function applyTabIconForHostname(tabId, hostname) {
    // Non-HTTP pages (new tab, chrome://, etc.) are not filterable — show
    // the disabled icon and drop any stale cached level for this tab, so a
    // later real site isn't skipped just because it happens to match a
    // level cached before this non-filterable page was visited.
    if ( !hostname ) {
        lastIconLevelByTab.delete(tabId);
        return setToolbarIconForLevel(tabId, 0).catch(catchExpected('set toolbar icon', [ EXPECTED_ERRORS.TAB_GONE ]));
    }
    return getFilteringMode(hostname).then(level => {
        if ( lastIconLevelByTab.get(tabId) === level ) { return; }
        lastIconLevelByTab.set(tabId, level);
        return setToolbarIconForLevel(tabId, level).catch(catchExpected('set toolbar icon', [ EXPECTED_ERRORS.TAB_GONE ]));
    });
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if ( changeInfo.status !== 'complete' ) { return; }
    isFullyInitialized.then(( ) => {
        let hostname;
        try {
            hostname = new URL(tab.url).hostname;
        } catch {
            return;
        }
        applyTabIconForHostname(tabId, hostname);
    });
});

browser.tabs.onRemoved.addListener(tabId => {
    lastIconLevelByTab.delete(tabId);
    // (10.7.2 branch, merged in 10.7.5) RELEASE the tab-under guard's record and loop-guard state of the closed tab.
    releaseTabUnderTab(tabId).catch(reason => {
        console.error('[uBlock-Dynamic] releaseTabUnderTab:', reason);
    });
});

// (10.7.3) Close a tab a page opened when Chrome blocks its page load (e.g. an s.pemsrv.com ad popup) — see
// js/core/blocked-popup-closer.js. Registered at top level so Chrome can wake the worker for its events.
registerBlockedPopupCloser();

// (10.7.2 branch, merged in 10.7.5) Tab-under guard (js/core/tab-under-guard.js): remember which tabs show a site
// configured with a "prevent-popunder" line, and send such a tab back when that site turns it into an ad. Top frame
// only. Own listeners, so a failure here can never affect the icon or scriptlet listeners below. LIGHT WAKE-UP PATH
// (owner's decision): these handlers do NOT wait for isFullyInitialized — the guard reads its own small storage.session
// mirror instead, so a service worker woken by the tab-under itself decides as fast as possible. SITE-MODE GATE (C25):
// skipped on a site whose filtering is OFF — passed in as isTabUnderSiteFilteringOff.
browser.webNavigation.onCommitted.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    recordTabUnderCommit(details).catch(reason => {
        console.error('[uBlock-Dynamic] recordTabUnderCommit:', reason);
    });
});
async function isTabUnderSiteFilteringOff(hostname) {
    return await getFilteringMode(hostname) === MODE_NONE;
}
browser.webNavigation.onBeforeNavigate.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    restoreTabUnderNavigation(details, isTabUnderSiteFilteringOff);   // logs its own errors, never rejects
});

// (10.7.2 branch, merged in 10.7.5) uBD's block page (js/core/block-page.js): the ONE listener for a blocked top-level
// page load. In order: a tab the tab-under guard is sending back is left alone; a popup tab a page just opened is
// closed (10.7.3, js/core/blocked-popup-closer.js, which has no onErrorOccurred listener of its own any more); any other
// tab shows uBD's own page instead of the browser's bare error page.
browser.webNavigation.onErrorOccurred.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    showBlockPageForFailedLoad(details).catch(reason => {
        console.error('[uBlock-Dynamic] showBlockPageForFailedLoad:', reason);
    });
});

// (10.7.1, owner's decision) Offer the Seamless surfing prompt ONCE after the update, on the first ordinary web page
// that finishes loading in the ACTIVE tab — see js/core/seamless-cookie-prompt.js for what "once" means.
// SITE-MODE GATE (ARCHITECTURE.md HARD CONSTRAINT, C25): this injection is automatic, not a user click, so it is
// skipped on a site whose filtering is OFF (getFilteringMode() === MODE_NONE) — offered on the next page instead.
// Offered-marker written BEFORE injecting: two tabs completing together can never both show it.
const SEAMLESS_PROMPT_PROTOCOLS = Object.freeze([ 'http:', 'https:' ]);
async function maybeOfferSeamlessCookiePrompt(tabId, tab) {
    if ( tab?.active !== true ) { return; }
    let url;
    try { url = new URL(tab.url); } catch { return; }
    if ( SEAMLESS_PROMPT_PROTOCOLS.includes(url.protocol) === false ) { return; }
    if ( await isCookiePromptDue() === false ) { return; }
    if ( await getFilteringMode(url.hostname) === MODE_NONE ) { return; }
    await markCookiePromptOffered();
    await injectSeamlessPrompt(tabId, 'seamlessCookiePromptOffer');
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if ( changeInfo.status !== 'complete' ) { return; }
    isFullyInitialized.then(( ) => maybeOfferSeamlessCookiePrompt(tabId, tab)).catch(reason => {
        console.error('[uBlock-Dynamic] maybeOfferSeamlessCookiePrompt:', reason);
    });
});

// Re-apply site-mode scriptlets for the newly-committed hostname on every
// main-frame navigation. (The Tracker Radar monitor's own
// onMonitorCommitted() call, previously piggybacked on this same
// listener, was removed with block-monitor.js — see the import-site
// comment near the top of this file.)
//
// (10.5.6) Reads details.url directly instead of a separate
// browser.tabs.get(details.tabId) round-trip — webNavigation.onCommitted
// already carries the committed URL; the extra lookup only ever
// re-fetched what this event handed over for free. Only acts when a
// hostname is present (chrome://-style pages are left to tabs.onUpdated
// above, as before — this listener never showed the disabled icon).
browser.webNavigation.onCommitted.addListener(details => {
    if ( details.frameId !== 0 ) { return; }
    isFullyInitialized.then(() => {
        let hostname;
        try {
            hostname = new URL(details.url).hostname;
        } catch {
            return;
        }
        if ( !hostname ) { return; }
        applyTabIconForHostname(details.tabId, hostname);
    });
});

// Dispatch custom-rule scriptlets on every committed navigation, main frame
// and subframes alike (matching the security scriptlets' allFrames:true
// convention) — see js/core/custom-scriptlets.js. Kept as its own listener,
// separate from the monitor/site-mode one above, so this feature's own
// failure mode can never affect that one or vice versa.
browser.webNavigation.onCommitted.addListener(details => {
    isFullyInitialized.then(() => {
        let hostname;
        try {
            hostname = new URL(details.url).hostname;
        } catch {
            return; // not a parseable URL (e.g. about:/data:) — nothing to inject, by design
        }
        // (audit 10.6.4, C5) injectCustomScriptletsForFrame() is async: the old try/catch only
        // covered new URL(), so a rejection (e.g. a storage error in getFilteringMode()) escaped
        // as an unhandled promise rejection. Now caught and logged with context.
        injectCustomScriptletsForFrame({
            tabId: details.tabId,
            frameId: details.frameId,
            hostname,
        }).catch(reason => {
            console.error('[uBlock-Dynamic] injectCustomScriptletsForFrame:', hostname, reason);
        });
    });
});
/* ══════════════════════════════════════════════════════════════
   10. ALARMS AND SESSION DEADLINES
   ══════════════════════════════════════════════════════════════ */

// (10.7.6) Timed panel sessions (Fingerprint Inspector, Matrix panel): at every worker boot, a running session that
// was re-hydrated from chrome.storage.session gets its deadline alarm (again), and with no session a left-over
// Inspector probe is released (js/core/session-deadline.js). Replaces the 10.5.0 setInterval watchdogs, which died
// with the sleeping worker (audit 10.7.5, D-1).
isFullyInitialized.then(( ) => Promise.all([
    reconcilePrivacyInspectorDeadline(),
    reconcileMatrixDeadline(),
])).catch(reason => {
    console.error('[uBlock-Dynamic] reconcile session deadlines:', reason);
});

// One onAlarm listener, registered at top level so Chrome can wake the worker for it. Routes by alarm name:
// the deferred-jobs queue (js/data/alarms.js) and the session deadlines (SESSION_DEADLINE_ALARMS).
browser.alarms.onAlarm.addListener(alarm => {
    if ( alarm.name !== DEFERRED_JOBS_ALARM_NAME ) {
        isFullyInitialized
            .then(async ( ) => {
                if ( await handlePrivacyInspectorDeadlineAlarm(alarm.name) ) { return; }
                if ( await handleMatrixDeadlineAlarm(alarm.name) ) { return; }
                console.warn(`[uBlock-Dynamic] onAlarm: unknown alarm "${alarm.name}" — ignored`);
            })
            .catch(reason => {
                console.error(`[uBlock-Dynamic] onAlarm ${alarm.name}:`, reason);
            });
        return;
    }
    isFullyInitialized.then(( ) => {
        if ( process.wakeupRun === false && process.firstAlarm !== true ) {
            process.firstAlarm = true;
            return resetJobsAlarm();
        }
        processDueJobs(onMessage);
    });
});
/* ══════════════════════════════════════════════════════════════
   11. BROWSER-RESTART-ONLY ACTIONS
   onStartup, with the storage.session fallback
   ══════════════════════════════════════════════════════════════ */

// "Buying, booking, banking mode" is meant to last only as long as the
// browsing session it was started in. onStartup fires only on a genuine
// browser launch — never on the routine service-worker sleep/wake cycles
// MV3 triggers constantly within one continuous session — so this is the
// correct, narrow hook for "the browser restarted, end any leftover
// pause immediately" without accidentally cutting a pause short just
// because the SW went idle and woke back up minutes later in the same
// session.
//
// REDUNDANCY (fault-tolerance, C25): browser.runtime.onStartup is DOCUMENTED to fire only on a
// genuine browser launch — but it has been observed, via direct trace logging, to not fire AT ALL
// across some automated relaunch cycles (the SW boots fine every time; the onStartup listener
// callback itself never runs). chrome.storage.session is a second, independent signal for "did a
// genuine restart just happen": it is wiped by the browser on every real close, but survives every
// routine SW sleep/wake within one continuous session — so it cannot be fooled by a plain SW restart
// the way a missed event can. RESTART_ONLY_ACTIONS_RAN_KEY below is that signal. The actions
// themselves are called from BOTH start() (every SW cold boot — runs whether or not onStartup ever
// fires) and the onStartup listener (kept as a second, faster trigger). Both paths go through the
// same sessionRead/sessionWrite-guarded function, so whichever fires first does the work and the
// other is a no-op — never double-applied, never skipped because one path alone failed.
const RESTART_ONLY_ACTIONS_RAN_KEY = 'restartOnlyActionsRanThisSession';

async function runBrowserRestartOnlyActionsOnce() {
    if ( await sessionRead(RESTART_ONLY_ACTIONS_RAN_KEY) === true ) { return; }
    await sessionWrite(RESTART_ONLY_ACTIONS_RAN_KEY, true);   // set FIRST — never retried even if an action below throws
    clearTempDisableOnBrowserStartup();
    // "Clear ... at browser start" toggles (history, + opt-in downloads/form-data/cache/cookies/
    // cacheStorage/indexedDB/localStorage/serviceWorkers) — same restart-only guard, same reasoning
    // as the line above: a genuine browser launch, not a routine SW wakeup. See history-cleaner.js.
    clearBrowsingDataOnBrowserStartup();
    // Worry-free session — like temp-disable above, meant to last only
    // as long as the browsing session it was started in. A genuine
    // restart ends any leftover session outright (clearAutoDenyOnBrowserStartup()
    // handles storage, the deferred alarm job, content-script
    // unregistration, security rules, AND the suppression rule
    // together — see its own comment in cookie-clicker-autodeny-
    // manager.js for the bug this fixes). The general SW-cold-start/
    // version-bump reconciliation in start() above is unrelated and
    // stays as-is — that path can legitimately see a still-active
    // session (a plain SW wakeup, not a browser restart) and must
    // keep it running.
    // "Enable Worry-free surfing at browser startup" (v8.5.5; Options tab since 10.5.0) —
    // same restart-only guard as every other startup-only preference
    // above, consulted AFTER clearAutoDenyOnBrowserStartup() so this
    // always begins from a genuinely fresh session (freshly-registered
    // content scripts) rather than reasoning about whatever the
    // pre-restart state happened to be. (10.7.1) Sessions are open-ended;
    // the person's stored cookie-banner choice decides decline/accept
    // (js/data/cookie-banner-action.js).
    //
    // FIX (real bug, reported live): clearAutoDenyOnBrowserStartup()
    // is async and was previously called WITHOUT await — this
    // comment's own stated "consulted AFTER" intent was never
    // actually enforced by the code. Both functions write to the
    // same stored state as their very first step; without this
    // await, they raced, and clearAutoDenyOnBrowserStartup()'s own
    // writeState(null) (behind one extra readState() call) tended to
    // land AFTER startAutoDeny()'s writeState({active:true}),
    // silently reverting it — checkbox on, genuine restart, Worry-
    // free ends up inactive anyway. Awaiting it here is the entire
    // fix; no other logic needed to change.
    await clearAutoDenyOnBrowserStartup();
    // (11.0.0, owner's decision) On at EVERY browser start (js/data/seamless-switch.js): an advanced user's "off" lasts
    // only for the browser session it was chosen in, so it is switched back on here, then the session starts.
    // Replaces the removed "Enable Seamless surfing on startup" option.
    if ( isSeamlessSurfingEnabled(securityConfig) === false ) {
        securityConfig[SEAMLESS_ENABLED_SETTING_KEY] = true;
        await saveSecurityConfig();
    }
    await startAutoDeny();
    // Fix #5 (10.6.0): tabs that were already open before this genuine restart never got the scriptlet
    // registrations rebuilt above by start()'s own registerScriptletContentScripts() call — registration only
    // affects *future* navigations. One-time best-effort catch-up, gated by this same restart-only guard so it
    // never re-fires on a routine SW idle-wake within the same session. See that function's own header comment
    // (scripting-manager.js) for why this is deliberately coarser-grained than the per-list declarative split.
    catchUpAlreadyOpenTabsForScriptlets();
}

browser.runtime.onStartup.addListener(( ) => {
    isFullyInitialized.then(runBrowserRestartOnlyActionsOnce);
});
/* ══════════════════════════════════════════════════════════════
   12. RIGHT-CLICK CONTEXT MENU
   ══════════════════════════════════════════════════════════════ */

/******************************************************************************/
// Right-click context menu — "Cosmetic element picker" (v8.5.6), plus
// "Cookie consent clicker" / "Dynamic DNR filtering" / "Privacy
// Inspector" (v8.6.3). Every entry launches the exact same tool its
// matching popup menu item does (see popup/popup.js's #gotoPicker,
// #gotoCookieClicker, #gotoMatrixPanel, #gotoPrivacyInspector) — same
// handler functions, same target shape — so each feature has only ever
// one real launch path with two entry points into it, not a second copy
// that could drift apart (this project's own C21 principle).
//
// contextMenus.create() must be called from onInstalled — Chrome persists
// the menu items themselves across every later service-worker wake/sleep
// cycle, so calling create() again on every wake (e.g. from a general
// startup routine) would throw a duplicate-ID error the second time
// onward. onInstalled fires exactly once per install and once per
// version update — the right, narrow hook for "(re)declare the menu
// structure," mirroring this file's own onStartup listener just above,
// which is the same "once per the right kind of lifecycle event, not
// every SW wake" posture, just for a different event.
//
// The click LISTENER itself, by contrast, is registered unconditionally
// at this file's own top level (not inside onInstalled) — MV3 requires
// every event listener a service worker cares about to be attached
// synchronously on every fresh script evaluation, so a click arriving
// right after a cold SW wake (before onInstalled would ever re-fire) is
// never missed. One listener, one switch statement routing on
// menuItemId — same "single router" convention this file's own message
// dispatch table (see message-routes.js) already follows for messages,
// applied here to context-menu clicks instead (C3).
/******************************************************************************/

// ── CONTEXT_MENU_IDS ─────────────────────────────────────────────────────
// Single declared place for every right-click menu item id this file
// creates, and every item's own title text (kept identical to its sibling
// popup menu item's label — see popup/popup.html — per C22 cross-variant
// consistency: same feature, same label, wherever it's launched from).
// CONTEXT_MENU_ID_PICKER's own string value (not the JS name it was
// previously bound to) is unchanged from v8.5.6 — right-click menu ids
// aren't a stored/messaged contract, but keeping the value stable avoids
// any risk of a stale duplicate entry surviving a service-worker update.
const CONTEXT_MENU_IDS = Object.freeze({
    PICKER:            'uBolStrippedDynamic.cosmeticElementPicker',
    COOKIE_CLICKER:    'uBolStrippedDynamic.cookieConsentClicker',
    DYNAMIC_FILTERING: 'uBolStrippedDynamic.dynamicDnrFiltering',
    PRIVACY_INSPECTOR: 'uBolStrippedDynamic.privacyInspector',
    AD_CLEANER:        'uBolStrippedDynamic.adLeftoverCleaner',   // (11.0.0)
});

const CONTEXT_MENU_ITEMS = Object.freeze([
    // (11.0.0, owner) Same order as the popup: Ad leftover cleaner first (the popup's Seamless surfing line has no
    // right-click counterpart), then the picker, Cookie consent clicker, Dynamic DNR filtering, Fingerprint Inspector.
    {
        id: CONTEXT_MENU_IDS.AD_CLEANER,
        title: AD_CLEANER_NAME,
        contexts: [ 'page', 'frame', 'image' ],
    },
    {
        id: CONTEXT_MENU_IDS.PICKER,
        title: 'Cosmetic element picker',
        contexts: [ 'page', 'frame', 'image', 'video', 'audio' ],
    },
    {
        id: CONTEXT_MENU_IDS.COOKIE_CLICKER,
        title: COOKIE_CLICKER_NAME,
        contexts: [ 'page', 'frame' ],
    },
    {
        id: CONTEXT_MENU_IDS.DYNAMIC_FILTERING,
        title: DNR_TRACKING_FILTER_NAME,
        contexts: [ 'page', 'frame' ],
    },
    {
        id: CONTEXT_MENU_IDS.PRIVACY_INSPECTOR,
        title: FINGERPRINT_INSPECTOR_NAME,
        contexts: [ 'page', 'frame' ],
    },
]);

// (11.0.0) The items shown: every item when the power tools are shown, else only those js/data/power-tools.js keeps
// for everyone (the Cookie consent clicker). Rebuilt here at install/update and whenever the stored setting changes
// (storage listener below) — the context menu stays in this file (owner's decision 2026-11-16), no route imports it.
function visibleContextMenuItems() {
    if ( arePowerToolsShown(securityConfig) ) { return CONTEXT_MENU_ITEMS; }
    return CONTEXT_MENU_ITEMS.filter(item => CONTEXT_MENU_TOOL_IDS.always.includes(item.id));
}
// GUARD (race): one rebuild at a time — two overlapping removeAll()/create() runs would create an id twice.
const contextMenuLock = createLock('context-menus');
// (11.0.2, audit 11.0.2 finding 3) create() has no promise form: its failures arrive only through runtime.lastError,
// and an unread lastError surfaced as "Unchecked runtime.lastError" with no context. Read and logged here, per item.
function createContextMenuItem(item) {
    return new Promise(resolve => {
        browser.contextMenus.create(item, ( ) => {
            const error = browser.runtime.lastError;
            if ( error ) { console.error(`[uBlock-Dynamic] context menu item '${item.id}' not created:`, error.message); }
            resolve();
        });
    });
}
function rebuildContextMenus() {
    return contextMenuLock.withLock(async ( ) => {
        // Guard: removeAll() first — an update (not a fresh install) would
        // otherwise hit the same duplicate-ID error create() throws for an
        // already-existing ID; this makes the whole block safely re-runnable.
        await browser.contextMenus.removeAll();
        for ( const item of visibleContextMenuItems() ) {
            await createContextMenuItem(item);
        }
    }).catch(reason => {
        // (11.0.2) Callers fire and forget (install/update, setting change): a failure is logged here, never unhandled.
        console.error('[uBlock-Dynamic] context menu not rebuilt:', reason);
    });
}

// (11.0.0) The setting changed (Options tab, the one-time upgrade switch, Restore settings): rebuild the menu.
browser.storage.onChanged.addListener((changes, area) => {
    if ( area !== 'local' || changes.securityConfig === undefined ) { return; }
    const before = changes.securityConfig.oldValue?.[POWER_TOOLS_SETTING_KEY];
    const after = changes.securityConfig.newValue?.[POWER_TOOLS_SETTING_KEY];
    if ( before === after ) { return; }
    isFullyInitialized.then(rebuildContextMenus);
});

browser.runtime.onInstalled.addListener(( ) => {
    isFullyInitialized.then(( ) => {
        rebuildContextMenus();
        // (11.0.0) Seamless surfing is always on: an install or update starts it now (not only at the next browser
        // start), unless an advanced user turned it off. A running session is left as it is.
        applySeamlessSwitch(isSeamlessSurfingEnabled(securityConfig)).catch(reason => {
            console.error('[uBlock-Dynamic] onInstalled: Seamless surfing not started:', reason);
        });
        // Fix #5 (10.6.0): a fresh install has no already-open tabs to catch up (nothing predates the
        // extension), but an UPDATE does — every tab open across the update shares the exact same
        // "registered-after-the-fact" situation as a tab open across a genuine restart (see this function's
        // own header comment in scripting-manager.js). onInstalled fires for both install and update; calling
        // this unconditionally is harmless for the install case (an empty/near-empty tab set, or tabs this
        // function's own http(s)-only query simply won't match yet).
        catchUpAlreadyOpenTabsForScriptlets();
    });
});

// Guard: every branch validates `tab.id` before doing anything — a
// context-menu click can theoretically fire without a resolvable tab
// (e.g. certain non-page surfaces), and each handler below needs a real
// tabId either to inject into (picker) or to resolve a hostname from
// (the other three, inside their own handleStart*() functions).
function onContextMenuClicked(info, tab) {
    if ( tab instanceof Object === false || typeof tab.id !== 'number' ) { return; }
    // (11.0.0) GUARD: a hidden power tool never opens, even from a menu entry that has not been rebuilt yet.
    if ( CONTEXT_MENU_TOOL_IDS.power.includes(info.menuItemId) && arePowerToolsShown(securityConfig) === false ) { return; }

    switch ( info.menuItemId ) {
    case CONTEXT_MENU_IDS.PICKER: {
        if ( browser.scripting === undefined ) { return; }
        browser.scripting.executeScript({
            files: [
                '/js/scripting/css-procedural-api.js',
                '/js/scripting/tool-overlay.js',
                '/js/scripting/picker.js',
            ],
            target: { tabId: tab.id },
        }).catch(reason => {
            // v9.6.5 — same warn-only failure handling as popup.js's own
            // #gotoPicker (the other launch path for this exact picker):
            // console only, never a user-visible signal.
            console.warn('[uBlock-Dynamic] Cosmetic element picker launch failed (context menu), tabId=', tab.id, reason);
        });
        break;
    }
    case CONTEXT_MENU_IDS.COOKIE_CLICKER: {
        // Same one-shot, fire-and-forget shape as popup.js's own
        // #gotoCookieClicker handler: the actual detect/toggle/inject
        // sequence lives in handleCookieClickerLaunchPicker() and keeps
        // running in the service worker regardless of anything on this
        // end, so there is nothing further to await here.
        handleCookieClickerLaunchPicker({ tabId: tab.id });
        break;
    }
    case CONTEXT_MENU_IDS.AD_CLEANER: {
        handleAdCleanerLaunch({ tabId: tab.id });   // warn-only on failure, like the picker
        break;
    }
    case CONTEXT_MENU_IDS.DYNAMIC_FILTERING: {
        handleStartMatrix({ tabId: tab.id }).then(result => {
            if ( result?.ok !== true ) { return; }
            openOrFocusPanel(browser.runtime.getURL('matrix/matrix-panel.html'));
        });
        break;
    }
    case CONTEXT_MENU_IDS.PRIVACY_INSPECTOR: {
        handleStartPrivacyInspector({ tabId: tab.id }).then(result => {
            if ( result?.ok !== true ) { return; }
            openOrFocusPanel(browser.runtime.getURL('privacy/privacy-inspector.html'));
        });
        break;
    }
    default:
        break;
    }
}
browser.contextMenus.onClicked.addListener(onContextMenuClicked);
