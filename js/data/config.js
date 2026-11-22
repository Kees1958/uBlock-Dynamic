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
/*
 * config.js — Extension configuration loading and persistence
 *
 * Public interface:
 *   loadRulesetConfig()      — loads rulesetConfig from storage on SW startup
 *   saveRulesetConfig()      — persists rulesetConfig to chrome.storage.local
 *   saveSecurityConfig()     — persists securityConfig to chrome.storage.local
 *   saveWorryfreeState()     — persists worryfreeState to chrome.storage.local
 *   rulesetConfig {Object}   — runtime config (version, autoReload, showBlockedCount, etc.)
 *   securityConfig {Object}  — security/privacy toggle states
 *   worryfreeState {Object}  — { domains: string[] } — $worryfree per-domain
 *                               exemptions entered on the Allow list tab
 *   swLifecycle {Object}     — SW lifecycle state vector (phase, startPhase, firstRun, wakeupRun)
 *   SW_PHASES {Object}       — frozen enum of valid swLifecycle.phase values
 *   process                  — alias for swLifecycle (backward compat)
 *
 * Persisted: chrome.storage.local (full) + chrome.storage.session (fast wakeup cache)
 */


import {
    localRead, localRemove, localWrite,
    sessionRead, sessionWrite,
} from './ext.js';
import { createLock } from '../util/async-lock.js';
import { POWER_TOOLS_SETTING_KEY } from './power-tools.js';
import { SEAMLESS_ENABLED_SETTING_KEY } from './seamless-switch.js';

/******************************************************************************/

export const rulesetConfig = {
    version: '',
    autoReload: true,
    showBlockedCount: true,
    hasBroadHostPermissions: true,
};

// Options tab (was "Privacy & Security", renamed 10.5.0) and Worry-free settings. (10.3.0) The extra protections — the "Security
// enhancements", "Very low" and "Low" groups, the two Worry-free tier checkboxes and the editable
// "safer region" TLD list — were REMOVED (they moved to the separate 3P-Matrix extension). A stored key
// that is not in these defaults is dropped on load (pickKnownKeys(), below). For the history of each
// removed key see CHANGELOG_HISTORY.md.
export const securityConfig = {
    // ── "Privacy enhancements" (was "Safe privacy enhancements (enabled by default)" until 10.5.0 — the
    // group now mixes default-ON rows with the four default-OFF ones added below, so neither word fit
    // any more) ─────────────────────────────────────────────────────────────
    // blockPings (js/security/sec-pings.js) REMOVED outright, 10.5.0, owner's request — low value on
    // its own (most tracking now goes through sendBeacon/fetch keepalive, which it never touched). See
    // CHANGELOG_HISTORY.md for the full removal.
    // Startup-only action — no scriptlet, no DNR rule. Consulted exactly
    // once per genuine browser launch (browser.runtime.onStartup, NOT the
    // routine MV3 service-worker sleep/wake cycle — see history-cleaner.js
    // and background.js's onStartup listener for why that distinction
    // matters here specifically). "Except passwords": chrome.browsingData's
    // own `passwords` dataToRemove key is deliberately never set true by
    // this feature — see history-cleaner.js for exactly which data types
    // are (and are not) cleared. Plain on/off. Default TRUE.
    deleteHistoryOnStart: true,
    // Same startup-only shape as deleteHistoryOnStart just above — independent toggles, each its own
    // chrome.browsingData type, none touching history/passwords/site-storage (cookies is its own opt-in
    // toggle below, not bundled into any of these). See history-cleaner.js for the single declared
    // key->type map. Default FALSE (owner, 10.5.0) — opt-in, unlike deleteHistoryOnStart.
    clearDownloadsOnStart:   false,   // browsingData type: downloads (the Downloads-page list of records, not the files)
    clearFormDataOnStart:    false,   // browsingData type: formData (remembered values typed into form/search fields)
    clearCacheOnStart:       false,   // browsingData type: cache (cached page resources)
    // Signs the user out of every website on each browser start — the one data type here with a real
    // day-to-day cost, so it stays its own explicit opt-in rather than folding into deleteHistoryOnStart.
    // Default FALSE (owner, 10.5.0).
    clearCookiesOnStart:     false,   // browsingData type: cookies
    // Site storage, same shape as the four above — each its own opt-in, default FALSE. cacheStorage is
    // the service-worker/PWA Cache API store, NOT the ordinary HTTP cache cleared by clearCacheOnStart
    // above (see history-cleaner.js header for the distinction). indexedDB/localStorage clear sites'
    // own databases and localStorage/sessionStorage data (carts, offline app data, etc.).
    // serviceWorkers unregisters sites' own registered service workers (PWAs will re-register them on
    // next visit). None of these touch this extension's own storage — chrome.browsingData's
    // originTypes defaults to unprotectedWeb only, which structurally excludes extension storage.
    clearCacheStorageOnStart:   false,   // browsingData type: cacheStorage
    clearIndexedDbOnStart:      false,   // browsingData type: indexedDB
    clearLocalStorageOnStart:   false,   // browsingData type: localStorage
    clearServiceWorkersOnStart: false,   // browsingData type: serviceWorkers
    // ── Seamless surfing (11.0.0, owner's decision) ─────────────────────────
    // ALWAYS ON: started on install, on update and at every browser start (js/workflow/background.js). Only an
    // advanced user can turn it off, from the Seamless surfing prompt (js/data/seamless-switch.js). Replaces
    // startWorryFreeOnBrowserStartup (the "Enable Seamless surfing on startup" option, removed): a saved value of that
    // key is not a known key any more and is dropped on load, so everyone updating starts with Seamless surfing on.
    [SEAMLESS_ENABLED_SETTING_KEY]: true,
    // ── Worry-free (Filter (block) lists tab) ────────────────────────────────
    // The Worry-free extra filter lists — one independently-toggleable row
    // each, applied only during a Worry-free session. Each has its own
    // domain- or condition-scoped session suppression rule (see
    // worry-free-extra-manager.js), so turning one off cannot silently
    // suppress a sibling. Default TRUE.
    worryFreeAdguardTrackingEnabled: true,
    // worryFreeDisconnectOtherEnabled REMOVED (10.7.1) with the Disconnect list; a stored value is
    // dropped and released on the next load by assignKnownKeys() below.
    worryFreeKees1958Enabled: true,
    // (11.0.0, owner's decision) HaGeZi Light — moved from the always-on default lists to the Seamless surfing tracker
    // lists (first row). Default ON, like the other tracker lists; js/core/worry-free-extra-manager.js suppresses it
    // outside a Seamless session or when this is off.
    worryFreeHageziEnabled: true,
    worryFreePeterloweEnabled: true,
    worryFreeAdguardRemoveparamEnabled: true,
    // (10.7.1) What Seamless surfing does with cookie banners — chosen in the Seamless surfing prompt; read through
    // js/data/cookie-banner-action.js only. (11.0.0) 'prefer-accept' | 'accept' | 'decline'; default and unknown value =
    // 'prefer-accept' (accept, else decline) — must equal DEFAULT_COOKIE_BANNER_ACTION there.
    seamlessCookieBannerAction: 'prefer-accept',
    // (11.0.0) "I am an advanced user (unhide power tools)" — js/data/power-tools.js. OFF for a new install; an existing
    // user's saved settings predate the key, so it is switched ON for them once (upgradePowerToolsDefault() below).
    [POWER_TOOLS_SETTING_KEY]: false,
};

// (audit 10.6.4, owner's decision) securityAllowlist — the per-security-scriptlet hostname allowlists —
// REMOVED, with saveSecurityAllowlist(), its two message routes and its settings export/import field.
// It was empty since 10.5.0 (blockPings, its only key, was removed) and nothing read it after the
// security-scriptlet registration was removed. Its stored key is released once in loadRulesetConfig()
// below (RETIRED_STORAGE_KEYS); an older settings backup that still carries the field restores fine —
// the field is ignored.

// Stored keys of removed features, deleted from chrome.storage.local on every load (a no-op once gone).
// (11.0.0) worryFreeStartupDefaultAppliedIn: the marker of the removed 10.5.0 "startup ON once" step.
const RETIRED_STORAGE_KEYS = Object.freeze([ 'securityAllowlist', 'worryFreeStartupDefaultAppliedIn' ]);

// REMOVED (audit after 9.7.5): defaultConfig — a copy of rulesetConfig that
// was exported but never imported anywhere.

/******************************************************************************/
// SW lifecycle state vector
// Applies the same swimming-lane pattern used in block-monitor.js.
//
// Phases (SW startup lane — one linear sequence per SW lifetime):
//
//   [booting] — loadRulesetConfig() in progress; no config available yet
//       │
//       ▼
//   [starting] — startSession() in progress; config loaded, rules being applied
//       │  startPhase tracks the sub-step within starting:
//       │    'migration'   — runVersionMigration() running
//       │    'locale'      — enableLocaleLanguageFilter() running
//       │    'permissions' — syncWithBrowserPermissions() running
//       │    'scripts'     — registerContentScripts/UserScripts running
//       │    'finalising'  — security rules, badge, AG data loading
//       │
//       ├──(success)──► [ready]  — fully initialised; all event listeners active
//       │
//       └──(throw)────► [error]  — start() threw; errorReason holds the message
//                                  Chrome may attempt a one-shot reload (goodStart guard)
//
// The `phase` field is the authoritative signal used by all isFullyInitialized
// consumers. The three boolean flags (firstRun, wakeupRun, firstAlarm) are
// retained as named fields on the same vector so background.js call sites
// need no mass rename.
/******************************************************************************/

export const SW_PHASES = Object.freeze({
    BOOTING:  'booting',
    STARTING: 'starting',
    READY:    'ready',
    ERROR:    'error',
});

export const swLifecycle = {
    owner:       'background',
    phase:       SW_PHASES.BOOTING,
    startPhase:  null,      // sub-step within STARTING, null otherwise
    errorReason: null,      // set on ERROR, null otherwise
    // Boot-time flags — set once by loadRulesetConfig, never change after
    firstRun:    false,     // true  → fresh install (no prior rulesetConfig in storage)
    wakeupRun:   false,     // true  → SW restarted mid-session (session storage present)
    firstAlarm:  false,     // true  → first alarm tick after a wakeup has been handled
};

// Backward-compat alias — existing `process.firstRun` / `process.wakeupRun`
// references in background.js continue to work without a mass rename.
/** @alias Backward-compat alias for swLifecycle (B3a) — existing process.* call sites keep working. */
export const process = swLifecycle;

// (10.7.6) createLock() (js/util/async-lock.js), not a raw `p = p.then(fn)` chain: with a raw chain ONE rejected
// step left the chain rejected, so every later step was skipped until the service worker restarted. The lock runs
// each step after the previous one SETTLED, and each caller still sees its own failure (C21: reuse the proven lock).
const rulesetConfigLock = createLock('ruleset-config');

/******************************************************************************/

// GUARD — input validation (C6, 10.5.0; replaces the 10.3.0 retired-key lists): the keys of `saved`
// that the in-memory defaults also have, with a value of the same type. Anything else — a setting that
// no longer exists, a malformed value — is dropped. Used for stored settings (below) and for a
// restored backup (background.js handleImportAllSettings()).
export function pickKnownKeys(defaults, saved) {
    const known = {};
    if ( saved === null || typeof saved !== 'object' ) { return known; }
    for ( const [ key, value ] of Object.entries(saved) ) {
        if ( Object.hasOwn(defaults, key) && typeof value === typeof defaults[key] ) { known[key] = value; }
    }
    return known;
}

// GUARD — clear: copies the known part of a stored settings object into its in-memory default, and
// when the stored copy held anything else, writes the cleaned object back once, so the dropped
// values are released from storage too and never return.
function assignKnownKeys(target, saved, storageKey) {
    const known = pickKnownKeys(target, saved);
    Object.assign(target, known);
    if ( Object.keys(known).length !== Object.keys(saved).length ) { localWrite(storageKey, target); }
}

async function _loadRulesetConfig() {
    const sessionData = await sessionRead('rulesetConfig');
    if ( sessionData ) {
        Object.assign(rulesetConfig, sessionData);
        process.wakeupRun = true;
    } else {
        const localData = await localRead('rulesetConfig');
        if ( localData ) {
            Object.assign(rulesetConfig, localData);
        }
        sessionWrite('rulesetConfig', rulesetConfig);
        if ( !localData ) {
            localWrite('rulesetConfig', rulesetConfig);
            process.firstRun = true;
        }
    }
    const savedSecurity = await localRead('securityConfig');
    if ( savedSecurity ) {
        assignKnownKeys(securityConfig, savedSecurity, 'securityConfig');
        upgradePowerToolsDefault(savedSecurity);
    } else {
        localWrite('securityConfig', securityConfig);
    }
    // GUARD (release): storage of removed features — see RETIRED_STORAGE_KEYS.
    localRemove(RETIRED_STORAGE_KEYS).catch(reason => {
        console.warn('[uBlock-Dynamic] loadRulesetConfig: retired storage keys not removed:', reason);
    });
    // Same shape for $worryfree — absent on first run after the update,
    // which is a normal empty state, not an error.
    const savedWorryfree = await localRead('worryfreeState');
    if ( savedWorryfree && Array.isArray(savedWorryfree.domains) ) {
        worryfreeState.domains = savedWorryfree.domains;
    } else {
        localWrite('worryfreeState', worryfreeState);
    }
}

// (11.0.0, owner's decision) Existing users keep their power tools, as uBlock Origin's "I am an advanced user" did:
// settings saved before 11.0.0 have no POWER_TOOLS_SETTING_KEY, so that user is switched ON — once, because the key is
// written back. A new install has no saved settings and keeps the default (OFF); so does "Reset to defaults".
function upgradePowerToolsDefault(savedSecurity) {
    if ( Object.hasOwn(savedSecurity, POWER_TOOLS_SETTING_KEY) ) { return; }
    securityConfig[POWER_TOOLS_SETTING_KEY] = true;
    localWrite('securityConfig', securityConfig);
}

async function _saveRulesetConfig() {
    sessionWrite('rulesetConfig', rulesetConfig);
    return localWrite('rulesetConfig', rulesetConfig);
}

export async function saveSecurityConfig() {
    return localWrite('securityConfig', securityConfig);
}

// $worryfree per-domain exemptions — "@@domain$worryfree" lines from the
// Allow list tab. Same "const object, mutate .domains in place, never
// reassign the exported binding" shape as securityConfig
// above — keeps every importer's live binding correct without needing to
// re-import after a change. (The sibling saferegionsState was retired in
// 10.3.0 together with the $saferegions option.)
export const worryfreeState = { domains: [] };

export async function saveWorryfreeState() {
    return localWrite('worryfreeState', worryfreeState);
}

/******************************************************************************/

export function loadRulesetConfig() {
    return rulesetConfigLock.withLock(_loadRulesetConfig);
}

export function saveRulesetConfig() {
    return rulesetConfigLock.withLock(_saveRulesetConfig);
}
