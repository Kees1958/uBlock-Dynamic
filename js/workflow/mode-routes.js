/*
 * mode-routes.js — Site-mode / filtering-mode message-route adapters
 *
 * Same three-layer split as matrix-routes.js / security-routes.js /
 * ruleset-routes.js (see matrix-routes.js's own header for the full
 * rationale):
 *   Layer 1 — message-routes.js:  POLICY
 *   Layer 2 — this file:          ADAPTER
 *   Layer 3 — mode-manager.js, site-mode-manager.js, scripting-manager.js
 *             — the actual logic
 *
 * Largest of the four route files split out of background.js so far (10
 * handlers) — this is the last piece of "target #2" (mode/security/
 * ruleset routes), after security-routes.js and ruleset-routes.js.
 *
 * (10.7.12) The site-mode and filtering-mode procedures (and
 * refreshToolbarIconsForOpenTabs()) moved down to core/site-mode-apply.js,
 * so Restore settings (settings-routes.js) can use them without importing
 * this route file (C15); the handlers below keep their names as wrappers.
 *
 * Public interface — one function per MSG_* route this feature owns,
 * referenced by background.js's ROUTE_HANDLERS:
 *   handleSiteModeGet, handleSiteModeGetAll, handleSiteModeSet,
 *   handleSiteModeSetAll, handleGetFilteringMode, handleSetFilteringMode,
 *   handleGetFilteringModeDetails, handleSetFilteringModeDetails,
 *   handleGetDefaultFilteringMode, handleSetDefaultFilteringMode,
 *   handleWorryfreeGetAll, handleWorryfreeSetAll
 *   (handleSaferegionsGetAll/SetAll were removed in 10.3.0 with the
 *   $saferegions option — see util/site-mode-parser.js RETIRED_SITE_MODE_OPTIONS.)
 */


import {
    getDefaultFilteringMode,
    getFilteringMode,
    getFilteringModeDetails,
    setDefaultFilteringMode,
    setFilteringMode,
} from '../core/mode-manager.js';

import {
    applySiteMode,
    getSiteMode,
} from '../core/site-mode-manager.js';

import {
    registerContentScripts,
    registerCookieClickerContentScripts,
} from '../core/scripting-manager.js';

import { setToolbarIconForLevel } from '../core/action.js';

// $worryfree — same Allow list tab, a different line shape entirely (see
// site-mode-parser.js's extractOptionLinesFromText()). Routed here, not a
// new route file, since the UI entry point is this same tab's editor
// (mode-editor.js) — worryfree-manager.js owns the dynamic-DNR-rule logic
// (layer 3), this is just the adapter.
import { getWorryfreeDomains, setWorryfreeDomains } from '../core/worryfree-manager.js';
import { catchExpected, EXPECTED_ERRORS } from '../data/expected-errors.js';
import { applyAllSiteModes, applyFilteringModeDetails, getAllSiteModes } from '../core/site-mode-apply.js';

/******************************************************************************/


/******************************************************************************/
// 4-way site mode / allowlist
/******************************************************************************/

export async function handleSiteModeGet(request) {
    const mode = await getSiteMode(request.hostname);
    return { mode };
}

export async function handleSiteModeGetAll() {
    return getAllSiteModes();
}

export async function handleSiteModeSet(request) {
    const { hostname, mode, tabId } = request;
    const result = await applySiteMode(hostname, mode, tabId, {
        setFilteringMode,
        registerContentScripts,
        registerCookieClickerContentScripts,
    });
    return result;
}

// The procedure (store the whole map, reconcile every affected site, refresh the icons) lives in
// core/site-mode-apply.js since 10.7.12 — Restore settings uses it too.
export async function handleSiteModeSetAll(request) {
    const { siteModes: newModes } = request;
    return applyAllSiteModes(newModes);
}

/******************************************************************************/
// Filtering mode (levels)
/******************************************************************************/

export async function handleGetFilteringMode(request) {
    return getFilteringMode(request.hostname);
}

export async function handleSetFilteringMode(request) {
    const beforeLevel = await getFilteringMode(request.hostname);
    if ( request.level === beforeLevel ) { return beforeLevel; }
    const afterLevel = await setFilteringMode(request.hostname, request.level);
    await registerContentScripts();
    if ( typeof request.tabId === 'number' ) {
        setToolbarIconForLevel(request.tabId, afterLevel).catch(catchExpected('set toolbar icon', [ EXPECTED_ERRORS.TAB_GONE ]));
    }
    return afterLevel;
}

export async function handleGetFilteringModeDetails() {
    return getFilteringModeDetails(true);
}

// Procedure in core/site-mode-apply.js since 10.7.12 (shared with Restore settings).
export async function handleSetFilteringModeDetails(request) {
    return applyFilteringModeDetails(request.modes);
}

export async function handleGetDefaultFilteringMode() {
    return getDefaultFilteringMode();
}

export async function handleSetDefaultFilteringMode(request) {
    const beforeLevel = await getDefaultFilteringMode();
    const afterLevel = await setDefaultFilteringMode(request.level);
    if ( afterLevel !== beforeLevel ) {
        await registerContentScripts();
    }
    return afterLevel;
}

/******************************************************************************/
// Per-site option lists ($worryfree)
/******************************************************************************/

// (10.7.12) reapplyExemptionRules() — a one-line pass-through to applyWorryfreeRules() whose only callers were
// the Import ABP save and Restore settings — was removed: those now call core/worryfree-manager.js directly
// (js/workflow/settings-routes.js), so no route file depends on another.

// GetAll returns a plain array of domains (JSON-safe, C31), SetAll
// replaces the whole list and returns what was actually stored, so the
// editor can re-render from storage rather than from what was typed.
export async function handleWorryfreeGetAll() {
    return getWorryfreeDomains();
}

export async function handleWorryfreeSetAll(request) {
    // Input validation at the module boundary (C6): the domain list comes
    // from a message, so anything that is not an array of strings is
    // normalised away by setWorryfreeDomains() rather than trusted.
    return setWorryfreeDomains(request.domains);
}

/******************************************************************************/
