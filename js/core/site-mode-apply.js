/*
 * site-mode-apply.js — applying a change to the sites' on/off (site mode) and filtering-mode settings
 *
 * (10.7.12) Moved here, verbatim, from js/workflow/mode-routes.js. These procedures are needed by three entry
 * points — the popup's on/off switch, the Allow list editor (both via mode-routes.js) and Restore settings
 * (js/workflow/settings-routes.js) — so they belong to the core tier that all of them build on, not inside one
 * of the route files (C15: a route file must not import another route file). mode-routes.js keeps its handler
 * names as thin wrappers around these functions, so the message contracts are unchanged.
 *
 * Public interface:
 *   getAllSiteModes()                 — the stored { hostname: mode } map ('siteModes'), {} when none
 *   applyAllSiteModes(newModes)       — stores the whole map and reconciles every affected site: filtering level,
 *                                       content-script registrations, toolbar icons of open tabs
 *   applyFilteringModeDetails(modes)  — stores the filtering-mode details and re-applies them (content scripts,
 *                                       default-mode broadcast, toolbar icons)
 *
 * Dependencies: data/ext.js, data/broadcast.js, core/mode-manager.js, core/site-mode-manager.js,
 *               core/scripting-manager.js, core/action.js.
 * State owned: none.
 */

import { browser, localRead, localWrite } from '../data/ext.js';
import { broadcastMessage } from '../data/broadcast.js';

import {
    getDefaultFilteringMode,
    getFilteringMode,
    getFilteringModeDetails,
    setFilteringModeBulk,
    setFilteringModeDetails,
} from './mode-manager.js';

import {
    invalidateSiteModeCache,
    filteringLevelForMode,
    SITE_MODE_DEFAULT,
} from './site-mode-manager.js';

import {
    registerContentScripts,
    registerCookieClickerContentScripts,
} from './scripting-manager.js';

import { setToolbarIconForLevel } from './action.js';

/******************************************************************************/

async function refreshToolbarIconsForOpenTabs() {
    const tabs = await browser.tabs.query({}).catch(reason => {
        console.error(`[uBlock-Dynamic] refreshToolbarIconsForOpenTabs/tabs.query/${reason}`);
        return [];
    });
    await Promise.all(tabs.map(async tab => {
        if ( typeof tab.id !== 'number' ) { return; }
        let hostname;
        try {
            hostname = new URL(tab.url).hostname;
        } catch {
            return;
        }
        if ( hostname === '' ) { return; }
        const level = await getFilteringMode(hostname);
        try {
            await setToolbarIconForLevel(tab.id, level);
        } catch(reason) {
            console.error(`[uBlock-Dynamic] refreshToolbarIconsForOpenTabs/setIcon/${reason}`);
        }
    }));
}

/******************************************************************************/
// 4-way site mode / allowlist
/******************************************************************************/

export async function getAllSiteModes() {
    const all = await localRead('siteModes') ?? {};
    return all;
}

export async function applyAllSiteModes(newModes) {
    if ( newModes instanceof Object === false ) { return {}; }
    const oldModes = await localRead('siteModes') ?? {};
    await localWrite('siteModes', newModes);
    invalidateSiteModeCache();
    // BUG FIX (real, reported): this used to only re-sync hostnames whose
    // mode differed from the CURRENTLY-STORED 'siteModes' — the same
    // storage this diff compared against. If a hostname's real filtering
    // state (filteringModeDetails, a separate storage key) ever desynced
    // from 'siteModes' at any point in the past — e.g. an entry saved
    // before an earlier version of this same function's own fix existed
    // — every later save saw "no change" for it and never re-synced it.
    // The dashboard editor would keep showing it correctly allowlisted
    // while the toolbar icon and actual request-blocking behavior never
    // reflected it — a permanently-stuck desync that outlived the very
    // fix meant to prevent it.
    //
    // Fix: reconcile the FULL UNION of old+new hostnames unconditionally
    // on every save, not gated on a diff — every save is now self-healing
    // regardless of what 'siteModes' previously claimed. Applies all
    // changes via setFilteringModeBulk() (OPTIMIZE.md 3.1) — reuses the
    // exact same applyFilteringMode() mutator setFilteringMode() itself
    // uses, just applied to one in-memory object across every hostname
    // before a single read+write+DNR-rebuild, instead of the same logic
    // reapplied via N separate full read+write+DNR-rebuild round trips.
    // Not a rewrite of that hierarchy/subtree-pruning logic — same
    // caution this comment's original fix already documented, still
    // honored.
    const allHostnames = new Set([
        ...Object.keys(oldModes),
        ...Object.keys(newModes),
    ]);
    if ( allHostnames.size > 0 ) {
        const changes = Array.from(allHostnames, hostname => [
            hostname,
            filteringLevelForMode(newModes[hostname] ?? SITE_MODE_DEFAULT),
        ]);
        await setFilteringModeBulk(changes);

        // Same real bug as applySiteMode()'s own fix (see that function's
        // own comment) — registerCookieClickerContentScripts() was
        // missing here too, a second occurrence of the identical gap.
        await Promise.all([
            registerContentScripts(),
            registerCookieClickerContentScripts(),
        ]);

        // BUG FIX (reported: toolbar icon stuck on an old mode — stays
        // green, or keeps showing a block count — for a domain just
        // changed via a bulk Allow-list save or a Settings restore, both
        // of which route through this function): applySiteMode() (the
        // single-site popup-toggle path, site-mode-manager.js) always
        // sets the icon for the affected tab; this bulk path
        // never called anything equivalent for any of the potentially
        // many tabs it just changed, so their icons kept showing
        // whatever they had before this save until an unrelated
        // navigation happened to refresh them. Reuses the exact same
        // refreshToolbarIconsForOpenTabs() already defined above in this
        // file and already used by applyFilteringModeDetails() for
        // the identical purpose (C21) — it reads getFilteringMode(),
        // which is backed by the same filteringModeDetails storage
        // setFilteringModeBulk() above just wrote, so it reflects these
        // changes correctly, not a stale snapshot. Icon only — this
        // deliberately does NOT add the tab reload applySiteMode() also
        // does — see below: reload-per-tab across a potentially-large
        // bulk save is a bigger, separately-flagged behavior change,
        // not silently folded into this fix.
        refreshToolbarIconsForOpenTabs();
    }
    // Same caveat applySiteMode() documents for the single-site path:
    // an already-open tab for a changed hostname needs a manual reload
    // to actually stop already-injected scriptlets or clear an
    // already-applied block count — this bulk path affects potentially
    // many hostnames at once, so it does not force-reload every
    // matching open tab automatically.
    return newModes;
}

/******************************************************************************/
// Filtering mode (levels)
/******************************************************************************/

export async function applyFilteringModeDetails(modes) {
    await setFilteringModeDetails(modes);
    await registerContentScripts();
    const defaultFilteringMode = await getDefaultFilteringMode();
    broadcastMessage({ defaultFilteringMode });
    refreshToolbarIconsForOpenTabs();
    return getFilteringModeDetails(true);
}

/******************************************************************************/
