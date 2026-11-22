/*******************************************************************************

    uBlock-Stripped-Dynamic — Site mode manager

    Manages the 2-way per-site browsing mode, stored persistently in
    chrome.storage.local under the key 'siteModes'.

    Modes:
      0 = OFF   — no filtering, no scriptlets
      1 = BASIC — basic filtering (default)

    This is separate from the existing filteringModeDetails / mode-manager.js
    which handles the power-user per-hostname text editor. The 2-way mode
    overrides the filtering level for any hostname that has an explicit entry.

*******************************************************************************/

// ── site-mode-manager.js ──────────────────────────────────────────────────────
// Per-site filtering mode (OFF / BASIC): the stored choice per hostname and applying it to a tab.
//
// Public interface:
//   SITE_MODE_OFF / SITE_MODE_BASIC / SITE_MODE_DEFAULT  — the mode values (stored as numbers)
//   getSiteMode(hostname)                 — the stored mode, or SITE_MODE_DEFAULT
//   setSiteMode(hostname, mode)           — stores a mode; the default deletes the entry
//   invalidateSiteModeCache()             — drops the in-memory cache (after an external storage write)
//   filteringLevelForMode(mode)           — the toolbar/filtering level for a mode
//   applySiteMode(hostname, mode, tabId, deps) — stores the mode, sets the filtering level, re-registers the
//                                           content scripts and, given a tab, updates its icon and reloads it
//
// Dependencies: data/ext.js (storage, reloadTab), core/action.js (toolbar icon), data/expected-errors.js.
//
// State owned:
//   cache  {Map|null}  — hostname -> mode, mirror of storage key 'siteModes'; lost on SW restart (safe: re-read)
// (C10 header added in 10.7.9, audit 10.7.8.)

import { localRead, localWrite, reloadTab } from '../data/ext.js';
import { setToolbarIconForLevel } from './action.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';

/******************************************************************************/

export const SITE_MODE_OFF   = 0;
export const SITE_MODE_BASIC = 1;

/** @alias Named role: the default site mode is Basic; both names are imported. */
export const SITE_MODE_DEFAULT = SITE_MODE_BASIC;

const STORAGE_KEY = 'siteModes';

/******************************************************************************/
// Storage
/******************************************************************************/

// B14/B6 (v9.7.3) — the in-memory cache is a Map, not a plain object.
// It is keyed by arbitrary hostnames added AND deleted at runtime, which
// is exactly the shape that pushes a plain object into V8's dictionary
// mode for good (see the programming-principles doc, B14). The storage
// value under STORAGE_KEY stays a plain { hostname: mode } object — the
// only two places that touch that shape are readSiteModes() and
// writeSiteModes() below, so the on-disk format (and every other reader of
// the 'siteModes' key: mode-routes.js, background.js's export/import and
// one-time reconcile) is unchanged.
//
// Bound (B6): an entry exists only while a hostname is set to a
// non-default mode, i.e. after an explicit user action (popup toggle or
// the Allow (white) list editor); setting a hostname back to
// SITE_MODE_DEFAULT deletes its entry. So the size is bounded by what the
// user has deliberately chosen, and no artificial cap is imposed — a cap
// would have to silently refuse a user's own choice, which is a visible
// behaviour change this refactor must not introduce.
//
// Lost on service-worker restart: safe — re-read from storage on the next
// call (cache === null).
let cache = null; // Map<hostname, mode> | null

async function readSiteModes() {
    if ( cache !== null ) { return cache; }
    const stored = await localRead(STORAGE_KEY);
    cache = new Map(Object.entries(stored ?? {}));
    return cache;
}

async function writeSiteModes(modes) {
    cache = modes;
    return localWrite(STORAGE_KEY, Object.fromEntries(modes));
}

export async function getSiteMode(hostname) {
    if ( !hostname ) { return SITE_MODE_DEFAULT; }
    const modes = await readSiteModes();
    const val = modes.get(hostname);
    if ( val === undefined ) { return SITE_MODE_DEFAULT; }
    return val;
}

export function invalidateSiteModeCache() {
    cache = null;
}

export async function setSiteMode(hostname, mode) {
    const modes = await readSiteModes();
    if ( mode === SITE_MODE_DEFAULT ) {
        modes.delete(hostname);
    } else {
        modes.set(hostname, mode);
    }
    await writeSiteModes(modes);
    return mode;
}

/******************************************************************************/
// Filtering level mapping
/******************************************************************************/

export function filteringLevelForMode(mode) {
    return mode === SITE_MODE_OFF ? 0 : 1;
}

/******************************************************************************/
// Site mode application
/******************************************************************************/

export async function applySiteMode(hostname, mode, tabId, {
    setFilteringMode,
    registerContentScripts,
    registerCookieClickerContentScripts,
}) {
    await setSiteMode(hostname, mode);
    const level = filteringLevelForMode(mode);
    await setFilteringMode(hostname, level);
    // Both re-registrations must happen here, not just the cosmetic one —
    // see the two bugs this fixes, below.
    // REAL BUG FOUND AND FIXED (reported: "cookie clicker rules don't
    // work anymore" for a site whose Allow-list mode was toggled):
    // registerCookieClickerContentScripts() was missing from this list
    // entirely — its own site-mode scope (buildSiteModeMatchScope(), see
    // scripting-manager.js) is only recomputed when THIS function is
    // called, so a site toggled back on here kept using the STALE scope
    // from whenever cookie-clicker was last registered, same class of
    // staleness the two BUG FIXED comments below already describe for
    // DNR blocking and security scriptlets — just never extended to this
    // third registration group when those two were fixed.
    await Promise.all([
        registerContentScripts(),
        registerCookieClickerContentScripts(),
    ]);
    if ( typeof tabId === 'number' ) {
        // (10.5.6) setIconForMode() removed — it was a second, independent copy of action.js's own on/off PNG
        // pair, built from `mode` instead of `level`. `level` is already known here (computed above for
        // setFilteringMode()), so this reuses the one real icon-drawing primitive directly (C21), the same way
        // mode-routes.js's handleSetFilteringMode() already does for its own immediate, pre-reload feedback.
        setToolbarIconForLevel(tabId, level).catch(catchExpected('set toolbar icon', [ EXPECTED_ERRORS.TAB_GONE ]));
        // BUG FIXED (badge count / continued blocking after disabling a
        // site): the DNR allowAllRequests rule this function's caller
        // writes via setFilteringMode() only cascades its "don't block
        // anything from this frame" exemption to sub-resource requests
        // when the *main_frame* request itself matches the rule (see
        // ext-compat.js's setAllowAllRules — condition.resourceTypes:
        // ['main_frame']). That only happens on a fresh navigation. Without
        // reloading here, an already-loaded page keeps issuing requests
        // (AJAX, dynamically-inserted scripts/images) that get evaluated
        // against the *old* rule set, so blocking — and the badge count
        // dnr.setExtensionActionOptions({ displayActionCountAsBadgeText })
        // derives from — could continue for that page even though the UI
        // now shows the site as OFF, until the user happened to reload
        // manually.
        //
        // BUG FIXED (security scriptlets, e.g. the obfuscated-eval
        // blocker, still active after disabling a site): unlike DNR
        // blocking, content scripts already injected into an already-
        // running page (world: 'MAIN', runAt: 'document_start') cannot be
        // un-injected — updating the registration above only changes what
        // gets injected on the *next* load. Without a reload, a scriptlet
        // that was already running keeps running regardless of the
        // updated registration.
        //
        // Both fixes need the same thing: the current page has to actually
        // reload for a site-mode change to take effect immediately, not
        // just for the next unrelated navigation. This mirrors the
        // existing pattern in block-monitor.js's resumeMonitor(), which
        // already reloads for the same class of reason.
        //
        // Uses the shared reloadTab() (data/ext.js) rather than a plain
        // browser.tabs.reload() — ported from its two other callers
        // (background.js's onPermissionGrantedThruBrowser(), the Matrix
        // panel's handleReloadMatrixTab()) rather than reinvented, per
        // this project's own reuse-a-proven-solution standard: a site-mode
        // change affects DNR rules exactly the same way a Matrix override
        // does, so it needs the same two protections — the
        // TAB_RELOAD_DELAY_MS delay (lets the just-updated content
        // scripts/DNR rules actually finish registering before the reload
        // fires, instead of racing ahead of them) and bypassCache:true
        // (a plain reload can still serve a page/resource from cache
        // without re-running it through DNR at all). A bare
        // browser.tabs.reload(tabId) here — what this line was until this
        // fix — had neither protection, despite needing both for the
        // exact same reason its siblings already do.
        await reloadTab(tabId, '', true);
    }
    return { mode };
}


/******************************************************************************/
