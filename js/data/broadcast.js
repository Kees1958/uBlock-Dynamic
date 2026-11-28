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
 *   BROADCAST_CHANNEL_NAME    — the channel's name, the ONE copy for the sender and every panel that listens
 *   broadcastMessage(msg)     — sends a message on that channel
 *   releaseBroadcastChannel() — closes the sending channel (a later send opens a fresh one)
 *
 * Used to push live events (monitorEntry, monitorPaused, etc.) from the SW
 * to the block-monitor panel without a round-trip through chrome.runtime.
 *
 * State owned (11.1.6): `sendChannel` — the ONE sending channel of this service worker.
 *   Initialise: opened on the first send, then reused (until 11.1.6 every send opened a NEW channel and never
 *               closed it — one leaked channel per message, i.e. per request while the Matrix panel was open).
 *   Release:    releaseBroadcastChannel(); otherwise the browser releases it with the worker when the worker stops.
 */


// Separated from util/utils.js because BroadcastChannel is a side-effectful
// browser API — pure utility modules should have no side effects.

// ── Declared constants ────────────────────────────────────────────────────────
export const BROADCAST_CHANNEL_NAME = 'uBOL';   // sender and listeners (matrix/, privacy/) must use the same name

// ── State ─────────────────────────────────────────────────────────────────────
let sendChannel = null;   // the ONE sending channel; null = not opened yet, or released

// Guard (initialise): opens the channel once, reuses it after that.
function openSendChannel() {
    if ( sendChannel === null ) {
        sendChannel = new self.BroadcastChannel(BROADCAST_CHANNEL_NAME);
    }
    return sendChannel;
}

export function broadcastMessage(message) {
    openSendChannel().postMessage(message);
}

// Guard (release): closes the channel and clears the reference; a no-op when nothing is open.
/** @public The channel's release guard (B10). In the extension the browser releases it when the worker stops — the
 *  channel lives exactly as long as the worker that sends on it — so no shipped code needs to call this; the test
 *  (tools/test-broadcast-channel.mjs) and any future teardown do. */
export function releaseBroadcastChannel() {
    if ( sendChannel === null ) { return; }
    sendChannel.close();
    sendChannel = null;
}

/******************************************************************************/
