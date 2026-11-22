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

*******************************************************************************/
/*
 * broadcast.js — BroadcastChannel wrapper for SW → panel communication
 *
 * Public interface:
 *   broadcastMessage(msg) — sends a message on the 'uBOL' BroadcastChannel
 *
 * Used to push live events (monitorEntry, monitorPaused, etc.) from the SW
 * to the block-monitor panel without a round-trip through chrome.runtime.
 */


// Separated from util/utils.js because BroadcastChannel is a side-effectful
// browser API — pure utility modules should have no side effects.

export function broadcastMessage(message) {
    const bc = new self.BroadcastChannel('uBOL');
    bc.postMessage(message);
}

/******************************************************************************/
