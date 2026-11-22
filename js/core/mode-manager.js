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
 * mode-manager.js — Per-hostname DNR filtering level management (none / basic)
 *
 * Public interface:
 *   getFilteringMode(hostname)             — returns 0 (none) or 1 (basic) for a hostname
 *   setFilteringMode(hostname, level)      — updates one hostname's filtering level
 *   getDefaultFilteringMode()             — returns the global default level
 *   setDefaultFilteringMode(level)         — sets the global default level
 *   getFilteringModeDetails(serializable)  — returns full {none, basic} sets
 *   setFilteringModeDetails(modes)         — replaces the full mode map
 *   filteringModesToDNR(modes)             — writes allowAllRequests DNR rules for OFF-mode sites
 *   syncWithBrowserPermissions()           — reconciles host permissions with filtering modes
 *
 * Persisted: chrome.storage.local + chrome.storage.session (session = fast wakeup cache)
 *
 * ── STATE / GUARDS (uBol-stripped-code-review.md §1 retrofit) ───────────────
 * No session, no phases: every exported function is a standalone read/write
 * against persisted storage — there's no multi-step lifecycle to model with
 * a phase enum (contrast block-monitor.js, which genuinely has one).
 *
 * The one piece of real state this module owns:
 *   readFilteringModeDetails.cache {Object|undefined} — in-memory mirror of
 *     the {none, basic} mode sets, attached directly to the function it
 *     belongs to (same "function-as-namespace" convention used elsewhere in
 *     this codebase, e.g. scripting-manager.js's registerContentScripts.pendingOp).
 *     Populated from chrome.storage.session on first read after an SW
 *     restart (falling back to chrome.storage.local only if the session
 *     mirror is empty), then kept in sync by every write going through
 *     writeFilteringModeDetails() re-assigning it directly — never
 *     explicitly nulled/invalidated, since a write always immediately
 *     replaces it with the new authoritative value. Lost on SW restart;
 *     safe, since it's rebuilt from storage.session/storage.local on the
 *     next read (see readFilteringModeDetails()'s own bypassCache logic).
 */


import { broadcastMessage } from '../data/broadcast.js';

import {
    hostnamesFromMatches,
    isDescendantHostnameOfIter,
    toBroaderHostname,
} from '../util/utils.js';

import {
    browser,
    localRead, localWrite,
    sessionRead, sessionWrite,
} from '../data/ext.js';

import {
    rulesetConfig,
    saveRulesetConfig,
} from '../data/config.js';

import { filteringModesToDNR } from './ruleset-manager.js';


/******************************************************************************/

// 0: no filtering
// 1: basic filtering

export const  MODE_NONE = 0;
export const MODE_BASIC = 1;

export const defaultFilteringModes = {
    none: [],
    basic: [ 'all-urls' ],
};

/******************************************************************************/

function pruneDescendantHostnamesFromSet(hostname, hnSet) {
    for ( const hn of hnSet ) {
        if ( hn.endsWith(hostname) === false ) { continue; }
        if ( hn === hostname ) { continue; }
        if ( hn.at(-hostname.length-1) !== '.' ) { continue; }
        hnSet.delete(hn);
    }
}

function pruneHostnameFromSet(hostname, hnSet) {
    let hn = hostname;
    for (;;) {
        hnSet.delete(hn);
        hn = toBroaderHostname(hn);
        if ( hn === '*' ) { break; }
    }
}

/******************************************************************************/

function serializeModeDetails(details) {
    return {
        none: Array.from(details.none),
        basic: Array.from(details.basic),
    };
}

// ── Read-boundary validation (audit 9.7.5, C6) ────────────────────────────
// filteringModeDetails is read back from chrome.storage (local AND session).
// Content scripts can write local always; until 10.7.6 they could write
// session too (background.js opened it for css-specific.js's cache — closed
// in 10.7.6, audit 10.7.5 D-5). The validation stays: local is still reachable. Previously the only check was `instanceof Object`, and
// `new Set(details.none)` accepts nearly anything: a string becomes a Set
// of single characters, a number throws. Now each list is reduced to its
// string entries only; anything else is dropped and logged.
//
// Deliberately SANITIZE, not reject: rejecting would fall back to the
// defaults and make a user's whole Allow list vanish over one bad entry.
// Valid data passes through unchanged.
//
// Performance: runs only on readFilteringModeDetails()'s cache-miss path
// (once per service-worker wake-up); one linear pass per list.
function sanitizeModeList(list, listName, source) {
    if ( list === undefined ) { return []; }
    if ( Array.isArray(list) === false ) {
        console.warn(`[uBlock-Dynamic] filteringModeDetails.${listName} from ${source} is not an array — ignored`);
        return [];
    }
    const out = list.filter(entry => typeof entry === 'string' && entry !== '');
    if ( out.length !== list.length ) {
        console.warn(`[uBlock-Dynamic] filteringModeDetails.${listName} from ${source}: dropped ${list.length - out.length} invalid entr${list.length - out.length === 1 ? 'y' : 'ies'}`);
    }
    return out;
}

function unserializeModeDetails(details, source = 'memory') {
    const obj = details instanceof Object ? details : {};
    return {
        none: new Set(sanitizeModeList(obj.none, 'none', source)),
        basic: new Set(sanitizeModeList(obj.basic, 'basic', source)),
    };
}

/******************************************************************************/

function lookupFilteringMode(filteringModes, hostname) {
    const { none, basic } = filteringModes;
    if ( hostname === 'all-urls' ) {
        if ( none.has('all-urls') ) { return MODE_NONE; }
        return MODE_BASIC;
    }
    if ( none.has(hostname) ) { return MODE_NONE; }
    if ( none.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, none) ) { return MODE_NONE; }
    }
    if ( basic.has(hostname) ) { return MODE_BASIC; }
    return lookupFilteringMode(filteringModes, 'all-urls');
}

/******************************************************************************/

function applyFilteringMode(filteringModes, hostname, afterLevel) {
    // Only two states exist: NONE or BASIC.
    afterLevel = afterLevel === MODE_NONE ? MODE_NONE : MODE_BASIC;
    const defaultLevel = lookupFilteringMode(filteringModes, 'all-urls');
    if ( hostname === 'all-urls' ) {
        if ( afterLevel === defaultLevel ) { return afterLevel; }
        if ( afterLevel === MODE_NONE ) {
            filteringModes.none.clear();
            filteringModes.none.add('all-urls');
        } else {
            filteringModes.none.clear();
        }
        return lookupFilteringMode(filteringModes, 'all-urls');
    }
    const beforeLevel = lookupFilteringMode(filteringModes, hostname);
    if ( afterLevel === beforeLevel ) { return afterLevel; }
    const { none } = filteringModes;
    pruneHostnameFromSet(hostname, none);
    if ( afterLevel !== defaultLevel && afterLevel === MODE_NONE ) {
        if ( isDescendantHostnameOfIter(hostname, none) === false ) {
            filteringModes.none.add(hostname);
            pruneDescendantHostnamesFromSet(hostname, none);
        }
    }
    return lookupFilteringMode(filteringModes, hostname);
}

/******************************************************************************/

export async function readFilteringModeDetails(bypassCache = false) {
    if ( bypassCache === false ) {
        if ( readFilteringModeDetails.cache ) {
            return readFilteringModeDetails.cache;
        }
        const sessionModes = await sessionRead('filteringModeDetails');
        if ( sessionModes instanceof Object ) {
            readFilteringModeDetails.cache = unserializeModeDetails(sessionModes, 'storage.session');
            return readFilteringModeDetails.cache;
        }
    }
    let [
        userModes = structuredClone(defaultFilteringModes),
    ] = await Promise.all([
        localRead('filteringModeDetails'),
    ]);
    userModes = unserializeModeDetails(userModes, 'storage.local');
    filteringModesToDNR(userModes);
    sessionWrite('filteringModeDetails', serializeModeDetails(userModes));
    readFilteringModeDetails.cache = userModes;
    return userModes;
}

/******************************************************************************/

async function writeFilteringModeDetails(afterDetails) {
    await filteringModesToDNR(afterDetails);
    const data = serializeModeDetails(afterDetails);
    readFilteringModeDetails.cache = unserializeModeDetails(data);
    return Promise.all([
        getDefaultFilteringMode(),
        localWrite('filteringModeDetails', data),
        sessionWrite('filteringModeDetails', data),
    ]).then(results => {
        broadcastMessage({
            defaultFilteringMode: results[0],
            filteringModeDetails: readFilteringModeDetails.cache,
        });
    });
}

/******************************************************************************/

export async function getFilteringModeDetails(serializable = false) {
    const actualDetails = await readFilteringModeDetails();
    const out = {
        none: new Set(actualDetails.none),
        basic: new Set(actualDetails.basic),
    };
    return serializable ? serializeModeDetails(out) : out;
}

export async function setFilteringModeDetails(details) {
    await writeFilteringModeDetails(details);
}

/******************************************************************************/

export async function getFilteringMode(hostname) {
    const filteringModes = await getFilteringModeDetails();
    return lookupFilteringMode(filteringModes, hostname);
}

export async function setFilteringMode(hostname, afterLevel) {
    const filteringModes = await getFilteringModeDetails();
    const level = applyFilteringMode(filteringModes, hostname, afterLevel);
    await writeFilteringModeDetails(filteringModes);
    return level;
}

// Bulk counterpart to setFilteringMode() above, for callers changing many
// hostnames at once (a bulk Allow-list save, a Settings-restore import —
// see OPTIMIZE.md 3.1). `entries` is an iterable of [ hostname, afterLevel ]
// pairs. Reads the filtering-mode map once, applies every change to that
// SAME in-memory object via the same applyFilteringMode() mutator
// setFilteringMode() itself uses, then writes — and therefore rebuilds the
// native DNR allowAllRequests rules — exactly once for the whole batch,
// instead of once per hostname.
export async function setFilteringModeBulk(entries) {
    const filteringModes = await getFilteringModeDetails();
    for ( const [ hostname, afterLevel ] of entries ) {
        applyFilteringMode(filteringModes, hostname, afterLevel);
    }
    await writeFilteringModeDetails(filteringModes);
    return filteringModes;
}

/******************************************************************************/

export function getDefaultFilteringMode() {
    return getFilteringMode('all-urls');
}

export function setDefaultFilteringMode(afterLevel) {
    return setFilteringMode('all-urls', afterLevel);
}

/******************************************************************************/

// BUG FIXED: this used to also persist the granted-hostnames list to
// 'permissions.hostnames' via a persistHostPermissions() helper, "for use
// elsewhere (e.g. the strict-block feature)" per that helper's own old
// comment — but strict-block was removed in v1.1, and nothing has read
// that storage key since. Confirmed via a repo-wide grep before removing
// it: no remaining reader anywhere. (The one-time migration cleanup this
// comment used to point to, in background.js's runVersionMigration(), was
// itself removed in 10.0.3 along with every other pre-10.0.3 upgrade
// step — see CHANGELOG_HISTORY.md's 10.0.3 entry.)
//
// What this function's return value IS still genuinely used for (not
// bookkeeping): background.js's onPermissionGrantedThruBrowser() and
// onPermissionsRemoved() — both wired to real browser.permissions.
// onAdded/onRemoved listeners, reachable whenever a user changes this
// extension's site-access level via Chrome's own extension UI, which
// fires those events even for a mandatory (not optional) host_permission
// like this extension's <all_urls> — call this and act on its result to
// decide whether to re-register content scripts / auto-reload the
// active tab. This used to unconditionally `return false`, silently
// disabling both of those reactions to a real permission change; it now
// returns the `toggled` value it already correctly computes below.
//
// Host permissions no longer gate any *filtering level* (basic mode
// never required broad host permissions — see this module's own
// none/basic duality), so this doesn't affect NONE/BASIC mode
// determination; it only affects whether content scripts get
// re-registered promptly when the user's actual permission grant
// changes outside of this extension's own UI.
export async function syncWithBrowserPermissions() {
    const afterPermissions = await browser.permissions.getAll();
    const afterAllowedHostnames = new Set(
        hostnamesFromMatches(afterPermissions.origins || [])
    );
    const hasBroad = afterAllowedHostnames.has('all-urls');
    const toggled = hasBroad !== rulesetConfig.hasBroadHostPermissions;
    if ( toggled ) {
        rulesetConfig.hasBroadHostPermissions = hasBroad;
        saveRulesetConfig();
    }
    return toggled;
}

/******************************************************************************/
