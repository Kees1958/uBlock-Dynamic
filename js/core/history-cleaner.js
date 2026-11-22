/*
 * history-cleaner.js — "Clear ... at browser start" Options-tab toggles
 * (browsing history, plus independently-opt-in downloads/form-data/cache/cookies).
 *
 * Approach inspired by (not a copy of) github.com/dessant/clear-browsing-
 * data's use of the chrome.browsingData API — that extension supports many
 * data types (cookies, cache, downloads, form data, etc.); this feature
 * covers exactly the data types below, each gated by its own securityConfig
 * checkbox, matching that checkbox's own literal label. Extending to a new
 * data type later just means adding one more entry to CLEAR_ON_START_TYPES
 * below (B1 — declared once) and a matching securityConfig default/checkbox.
 *
 * `passwords` can never be cleared by this feature — it is simply never a
 * key in CLEAR_ON_START_TYPES, so no config key, checkbox or future edit to
 * this map can set it true. chrome.browsingData.remove() only clears a type
 * when its key is explicitly `true`; omission is the guarantee, not an
 * exclusion list that needs to be kept in sync. Cookies, cacheStorage,
 * indexedDB, localStorage and serviceWorkers (10.5.0) are each their own
 * opt-in checkbox, default OFF, same as downloads/formData/cache — site
 * storage is no longer a blanket "never", it is per-type opt-in.
 *
 * Public interface:
 *   clearBrowsingDataOnBrowserStartup() — called once from background.js's
 *                                          browser.runtime.onStartup listener;
 *                                          clears whichever of the types
 *                                          below have their securityConfig
 *                                          toggle on; no-ops (no API call at
 *                                          all) if none are on.
 */

import { browser } from '../data/ext.js';
import { securityConfig } from '../data/config.js';

/******************************************************************************/
// Config — single source of truth for exactly what each checkbox clears,
// per this project's config-in-one-place convention. Add a data type here
// (plus its securityConfig default + dashboard checkbox) to extend.
/******************************************************************************/

// chrome.browsingData.remove()'s `since` field: epoch-ms cutoff, requests
// older than this are removed. 0 = the beginning of time — matches these
// toggles' "clear it all, every launch" intent rather than a rolling
// window. One value for every type below — there is no per-type reason to
// differ.
const REMOVE_SINCE_EPOCH_MS = 0;

// securityConfig key -> chrome.browsingData.remove() data type key. Order here is display order's
// source of truth for nothing (the dashboard rows are independent checkboxes, not generated from
// this), just the one place "which checkbox clears which data type" is declared.
const CLEAR_ON_START_TYPES = Object.freeze({
    deleteHistoryOnStart:     'history',
    clearDownloadsOnStart:    'downloads',
    clearFormDataOnStart:     'formData',
    clearCacheOnStart:        'cache',
    clearCookiesOnStart:      'cookies',
    clearCacheStorageOnStart: 'cacheStorage',
    clearIndexedDbOnStart:    'indexedDB',
    clearLocalStorageOnStart: 'localStorage',
    clearServiceWorkersOnStart: 'serviceWorkers',
});

/******************************************************************************/

async function clearBrowsingData(dataToRemove) {
    // Guard: browser.browsingData is only present when the "browsingData"
    // permission (manifest.json) is actually granted — absent on a build
    // where it was stripped, or (defensively) if a future manifest change
    // ever drops it without updating this file. Fails closed (does
    // nothing) rather than throwing and interrupting SW startup.
    if ( browser.browsingData?.remove === undefined ) {
        console.error('[uBlock-Dynamic] history-cleaner: browsingData API unavailable — permission missing?');
        return;
    }
    try {
        await browser.browsingData.remove(
            { since: REMOVE_SINCE_EPOCH_MS },
            dataToRemove,
        );
    } catch (reason) {
        console.error('[uBlock-Dynamic] history-cleaner/clearBrowsingData:', reason);
    }
}

/******************************************************************************/

// Called once from background.js's browser.runtime.onStartup listener —
// which fires only on a genuine browser launch, never on the routine
// service-worker sleep/wake cycles MV3 does constantly within a single
// browser session (see temp-disable-manager.js's own onStartup comment
// for the identical reasoning — "at start" means browser start, not every
// SW wakeup, or this would silently wipe data on an unpredictable,
// far-more-frequent schedule than the checkboxes' labels promise).
export async function clearBrowsingDataOnBrowserStartup() {
    const dataToRemove = {};
    for ( const [ configKey, dataType ] of Object.entries(CLEAR_ON_START_TYPES) ) {
        if ( securityConfig[configKey] === true ) { dataToRemove[dataType] = true; }
    }
    if ( Object.keys(dataToRemove).length === 0 ) { return; }   // nothing opted in — no API call at all
    await clearBrowsingData(dataToRemove);
}

/******************************************************************************/
