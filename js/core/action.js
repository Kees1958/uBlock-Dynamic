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
 * action.js — Toolbar icon management
 *
 * Public interface:
 *   setToolbarIconForLevel(tabId, level)  — sets icon to on/off per filtering level
 *   registerToolbarIconToggler(context)   — registers content script for icon toggling
 *
 * State owned:
 *   reverseMode {bool} — in-memory; recomputed on next registerToolbarIconToggler() call after SW restart
 */


import { browser } from '../data/ext.js';

/******************************************************************************/

let reverseMode = false;

/******************************************************************************/

function disableToolbarIcon(tabId) {
    const details = {
        path: {
             '16': '/img/icon_16_off.png',
             '32': '/img/icon_32_off.png',
             '64': '/img/icon_64_off.png',
            '128': '/img/icon_128_off.png',
        }
    };
    if ( tabId !== undefined ) {
        details.tabId = tabId;
    }
    return browser.action.setIcon(details);
}

function enableToolbarIcon(tabId) {
    const details = {
        path: {
             '16': '/img/icon_16.png',
             '32': '/img/icon_32.png',
             '64': '/img/icon_64.png',
            '128': '/img/icon_128.png',
        }
    };
    if ( tabId !== undefined ) {
        details.tabId = tabId;
    }
    return browser.action.setIcon(details);
}

/******************************************************************************/

// Directly set the icon for a specific tab, without waiting for that tab to
// reload and its (possibly not-yet-registered) content script to report
// back. This matters because callers such as the popup may close well
// before a scheduled reload/content-script roundtrip would otherwise
// complete.

export function setToolbarIconForLevel(tabId, level) {
    if ( level === 0 ) {
        return disableToolbarIcon(tabId);
    }
    return enableToolbarIcon(tabId);
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/198
//  Ensure the toolbar icon reflects the no-filtering mode of "trusted sites"
//
// Per-tab icon correctness is now handled directly by a tabs.onUpdated
// listener in background.js, which re-applies the right icon on every
// navigation without depending on a content script's registration having
// already propagated. This function only still handles the global default
// icon for "reverse mode" (default filtering off everywhere, with specific
// exceptions) since that isn't tied to any one tab.

export async function registerToolbarIconToggler(context) {
    const { none, basic } = context.filteringModeDetails;
    const reverseModeAfter = none.delete('all-urls');
    void basic;

    if ( reverseModeAfter !== reverseMode ) {
        if ( reverseModeAfter ) {
            disableToolbarIcon();
        } else {
            enableToolbarIcon();
        }
        reverseMode = reverseModeAfter;
    }
}
