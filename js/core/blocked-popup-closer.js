/*******************************************************************************

    uBlock-Stripped-Dynamic — blocked popup closer (10.7.3)

    Public interface:
      registerBlockedPopupCloser()  — watches tabs a page opens (call at SW top level)
      closeIfBlockedPopup(details)  — (10.7.5) onErrorOccurred decision, called by
                                      js/core/block-page.js; true = this module closed the tab

    (10.7.5) ONE onErrorOccurred decision for a blocked top-level load, made in
    js/core/block-page.js, in this order: a tab the tab-under guard is sending
    back is left alone → a watched popup tab is closed HERE → any other tab gets
    uBD's block page. Before, this module had its own onErrorOccurred listener;
    with the block page added, two listeners would race on the same tab.

    WHAT: when a PAGE opens a new tab or window (window.open, a target=_blank
    link, a form) and Chrome then blocks that tab's page load because one of
    uBD's rules matched (e.g. an ad host the lists mark `$all`, such as
    s.pemsrv.com), the tab is closed at once — the user never sees an empty
    "This page has been blocked by an extension" tab.

    WHY THIS WAY (owner's decision, 10.7.3): no domain list of its own and
    nothing runs on page load. Chrome's own block IS the signal, so what
    counts as "an ad page" stays decided in one place: the DNR rulesets.
    The only cost is two webNavigation events, which fire only when a page
    opens a tab and when a page load fails.

    "Empty tab first, ad a moment later" (popunder trick) is covered: the
    tab stays watched for POPUP_WATCH_WINDOW_MS after it was opened, so a
    later navigation of that same tab that gets blocked still closes it.

    KNOWN LIMITATION: Chrome reports a tab opened by a middle-click or
    Ctrl+click on a link the same way as a script popup. If such a link
    points at a blocked address, that tab is closed too — it would only
    have shown the blocked page.

    RESOURCES: one in-memory Map (tab id → time opened), capped at
    MAX_WATCHED_TABS, pruned on every event, cleared per tab when the tab
    closes. Nothing is stored; nothing about visited sites is kept.

*******************************************************************************/

import { browser } from '../data/ext.js';

/*==============================================================================
    CONFIG — every tunable value of this module, declared once.
==============================================================================*/

// How long after a page opened a tab a blocked page load in that tab still
// counts as "the popup". Covers the open-empty-then-redirect trick; a tab the
// user keeps using is no longer watched after this.
const POPUP_WATCH_WINDOW_MS = 5000;

// The error webNavigation.onErrorOccurred reports when an extension's rule
// (DNR) blocked the load. Any other error (offline, DNS, …) is left alone.
const BLOCKED_BY_EXTENSION_ERROR = 'net::ERR_BLOCKED_BY_CLIENT';

// webNavigation's frame id of a tab's top-level page.
const TOP_LEVEL_FRAME_ID = 0;

// Upper bound on watched tabs, so a page that opens tabs in a loop cannot
// grow the Map without limit; the oldest entry is dropped first.
const MAX_WATCHED_TABS = 50;

/*==============================================================================
    STATE — initialised here, cleared per tab, never persisted.
==============================================================================*/

const watchedPopupTabs = new Map();   // tabId → Date.now() when a page opened it
let registered = false;               // guard: listeners are added exactly once

/*==============================================================================
    Helpers
==============================================================================*/

// Release every entry older than the watch window (no timers: a sleeping
// service worker needs no wake-up just to forget something).
function pruneExpired(now) {
    for ( const [ tabId, openedAt ] of watchedPopupTabs ) {
        if ( now - openedAt > POPUP_WATCH_WINDOW_MS ) { watchedPopupTabs.delete(tabId); }
    }
}

/*==============================================================================
    Event handlers
==============================================================================*/

// Initiate: a page opened a new tab/window → start watching it.
function onCreatedNavigationTarget(details) {
    const now = Date.now();
    pruneExpired(now);
    if ( watchedPopupTabs.size >= MAX_WATCHED_TABS ) {
        const oldest = watchedPopupTabs.keys().next().value;   // Map keeps insertion order
        watchedPopupTabs.delete(oldest);
    }
    watchedPopupTabs.set(details.tabId, now);
}

// Perform: the watched tab's top-level page was blocked by a rule → close it.
// (10.7.5) Exported and called by js/core/block-page.js (no listener of its own any more, see the header).
// Returns true when this module took the tab (closing it), false when the tab is not a watched popup.
export function closeIfBlockedPopup(details) {
    if ( details.frameId !== TOP_LEVEL_FRAME_ID ) { return false; }
    if ( details.error !== BLOCKED_BY_EXTENSION_ERROR ) { return false; }
    const openedAt = watchedPopupTabs.get(details.tabId);
    if ( openedAt === undefined ) { return false; }
    watchedPopupTabs.delete(details.tabId);
    if ( Date.now() - openedAt > POPUP_WATCH_WINDOW_MS ) { return false; }
    browser.tabs.remove(details.tabId).catch(reason => {
        // The tab may already be gone (user closed it, page closed it) — nothing to release.
        console.info('[uBlock-Dynamic] blocked popup closer: tab not removed:', reason?.message ?? reason);
    });
    return true;
}

// End: the tab is gone (closed by us, the page or the user) → forget it.
function onTabRemoved(tabId) {
    watchedPopupTabs.delete(tabId);
}

/*==============================================================================
    Public interface
==============================================================================*/

// Must be called synchronously at the service worker's top level, so Chrome
// can wake the worker for these events.
export function registerBlockedPopupCloser() {
    if ( registered ) { return; }
    registered = true;
    browser.webNavigation.onCreatedNavigationTarget.addListener(onCreatedNavigationTarget);
    browser.tabs.onRemoved.addListener(onTabRemoved);
}
