// ── block-page.js ────────────────────────────────────────────────────────────
// Replaces the browser's bare error page with uBD's own block page when a top-level page load was blocked (10.7.2).
//
// Mechanism (owner's decision): the service worker REACTS to the failed load — webNavigation.onErrorOccurred with
// ERR_BLOCKED_BY_CLIENT in the top frame — and sends that tab to blocked/blocked.html. Deliberately NOT done with
// redirect rules (AdGuard's way): a redirect is an "unsafe" rule type that would cost the filter lists their
// skip-review updates, and a redirect always shows the page before anything else can act.
//
// Covers every whole-page block ($document / $all rules — the Import ABP box and the built-in lists). Chrome does not
// say which rule (or which extension, or Brave) blocked the load, so the page is worded neutrally and never names a
// rule.
//
// Coordination (10.7.5 — the ONE onErrorOccurred decision for a blocked top-level load, in this order):
//   0. (11.1.6) a page whose filtering is OFF (site switched off, or the global pause) is left alone: uBD's rules
//      cannot have blocked it, so the failure came from elsewhere (Brave, another extension, a browser feature
//      cancelling the navigation) and uBD's page would wrongly claim it — and keep reappearing during a pause.
//      The browser's own error page shows instead;
//   1. a tab the tab-under guard (js/core/tab-under-guard.js) is sending back to its site is left alone —
//      isTabBeingSentBack() waits for the guard's decision first;
//   2. a popup tab a page opened moments ago is closed by js/core/blocked-popup-closer.js (10.7.3 behaviour);
//   3. every other tab gets the block page.
//
// Public interface:
//   showBlockPageForFailedLoad(details) — webNavigation.onErrorOccurred handler body
//
// State: none — every call decides from its own event. Resources: none held.
// ─────────────────────────────────────────────────────────────────────────────
import { browser } from '../data/ext.js';
import { isTabBeingSentBack } from './tab-under-guard.js';
import { closeIfBlockedPopup } from './blocked-popup-closer.js';
import { getFilteringMode, MODE_NONE } from './mode-manager.js';

// ── Declared constants ────────────────────────────────────────────────────────
const BLOCK_PAGE_CONFIG = Object.freeze({
    PAGE_PATH:     '/blocked/blocked.html',          // the page (not web-accessible: only uBD navigates to it)
    HOST_PARAM:    'host',                           // query parameter read by blocked/blocked.js
    BLOCKED_ERROR: 'net::ERR_BLOCKED_BY_CLIENT',     // the error Chrome reports for a blocked load
    TOP_FRAME_ID:  0,
    WEB_PROTOCOLS: Object.freeze([ 'http:', 'https:' ]),
    LOG_PREFIX:    '[uBlock-Dynamic] block-page',
});

function blockedHostnameOf(details) {
    const C = BLOCK_PAGE_CONFIG;
    if ( details?.frameId !== C.TOP_FRAME_ID || !(details.tabId >= 0) || details.error !== C.BLOCKED_ERROR ) { return null; }
    try {
        const u = new URL(details.url);
        return C.WEB_PROTOCOLS.includes(u.protocol) && u.hostname !== '' ? u.hostname : null;
    } catch {
        return null;
    }
}

export async function showBlockPageForFailedLoad(details) {
    const C = BLOCK_PAGE_CONFIG;
    const hostname = blockedHostnameOf(details);
    if ( hostname === null ) { return; }
    if ( await getFilteringMode(hostname) === MODE_NONE ) { return; }   // (11.1.6) filtering off: not uBD's block
    if ( await isTabBeingSentBack(details.tabId) ) { return; }
    if ( closeIfBlockedPopup(details) ) { return; }   // (10.7.5) a blocked popup tab is closed, not shown a page
    const url = `${browser.runtime.getURL(C.PAGE_PATH)}?${C.HOST_PARAM}=${encodeURIComponent(hostname)}`;
    try {
        await browser.tabs.update(details.tabId, { url });
    } catch (reason) {
        // The tab may have been closed meanwhile — nothing else to do.
        console.error(`${C.LOG_PREFIX}/showBlockPageForFailedLoad:`, reason);
    }
}
