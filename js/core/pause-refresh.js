// ── pause-refresh.js ─────────────────────────────────────────────────────────
// What happens to the page the user is on when they pause filtering (11.1.6, owner's request 2026-11-28).
//
// Why: a pause only changes the DNR rules. The page that is already open keeps what it loaded under the old rules,
// and two browser caches can keep serving copies that never pass through DNR again: the HTTP cache, and the copies a
// site's own service worker keeps in Cache Storage (Chrome documents that rules may be ignored for those pages until
// that storage is cleared). So, when a pause starts, the site's cached copies are cleared first and the tab is then
// reloaded from the network, so the user sees the page as it really loads without filtering.
//
// Used by BOTH pause entry points (the same fact — "filtering just went off for this page" — in one place):
//   - the global pause ("Pause filtering…", js/core/temp-disable-manager.js), for the tab the popup was opened on;
//   - the per-site switch set to OFF (js/core/site-mode-manager.js's applySiteMode()), which already reloaded.
//
// Only the tab's OWN site (its origin) is cleared — never other sites, never cookies or logins, never local storage.
// Service workers are NOT removed by default (switch below): removing one also ends the site's push notifications.
//
// Public interface:
//   refreshTabAfterPause(tabId) — clears the tab's site caches (per the switches), then reloads the tab
//
// State: none — every call decides from its own tab. Resources: none held (the browser call is awaited and done).
// ─────────────────────────────────────────────────────────────────────────────
import { browser, reloadTab } from '../data/ext.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

// ── Declared constants and switches ───────────────────────────────────────────
const PAUSE_REFRESH_CONFIG = Object.freeze({
    CLEAR_SITE_CACHES: true,     // switch: clear the site's cached copies before the reload
    // browsingData data types cleared for the tab's origin when CLEAR_SITE_CACHES is on (all support `origins`):
    SITE_DATA_TYPES: Object.freeze({
        cache:          true,    // the HTTP cache: page resources the browser stored for this site
        cacheStorage:   true,    // Cache Storage: the copies the site's own service worker serves offline
        serviceWorkers: false,   // switch: also remove the site's service worker (ends its push notifications)
    }),
    RELOAD_TAB:    true,         // switch: reload the tab after clearing
    BYPASS_CACHE:  true,         // reload from the network, not from the browser's cache
    WEB_PROTOCOLS: Object.freeze([ 'http:', 'https:' ]),   // only real web pages; extension/browser pages are left alone
    LOG_PREFIX:    '[uBlock-Dynamic] pause-refresh',
});

// The tab's web origin, or null when the tab is gone or not a web page.
async function webOriginOfTab(tabId) {
    const tab = await browser.tabs.get(tabId).catch(catchExpected('get paused tab', [ EXPECTED_ERRORS.TAB_GONE ], null));
    if ( tab === null || typeof tab?.url !== 'string' ) { return null; }
    try {
        const u = new URL(tab.url);
        return PAUSE_REFRESH_CONFIG.WEB_PROTOCOLS.includes(u.protocol) ? u.origin : null;
    } catch {
        return null;
    }
}

// Clears the configured data types for ONE origin. A failure is logged and does not stop the reload.
async function clearSiteCaches(origin) {
    const C = PAUSE_REFRESH_CONFIG;
    if ( C.CLEAR_SITE_CACHES !== true ) { return; }
    try {
        await browser.browsingData.remove({ origins: [ origin ] }, { ...C.SITE_DATA_TYPES });
    } catch (reason) {
        console.error(`${C.LOG_PREFIX}/clearSiteCaches:`, reason);
    }
}

export async function refreshTabAfterPause(tabId) {
    const C = PAUSE_REFRESH_CONFIG;
    // Guard: tabId comes from the popup — anything that is not a real tab id is ignored.
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return; }
    const origin = await webOriginOfTab(tabId);
    if ( origin === null ) { return; }
    await clearSiteCaches(origin);
    if ( C.RELOAD_TAB === true ) {
        // reloadTab() waits TAB_RELOAD_DELAY_MS first, so the just-written DNR rules are in place before the reload.
        await reloadTab(tabId, '', C.BYPASS_CACHE);
    }
}
