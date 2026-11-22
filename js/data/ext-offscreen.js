/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2026-present Raymond Hill

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
 * ext-offscreen.js — Chrome offscreen document lifecycle management
 *
 * Public interface:
 *   getOffscreenDocument(url) — creates (or returns existing) offscreen document
 *   closeOffscreenDocument()  — closes the offscreen document when no longer needed
 *
 * Used to run the ABP filter compiler (static-filtering-parser + ubo-parser)
 * in a context that supports synchronous DOM APIs unavailable in SW.
 */

// Chromium supports the offscreen API natively since Chrome 109.

export async function createOffscreenDocument(path) {
    return chrome.offscreen.createDocument({
        url: path,
        reasons: [ 'WORKERS' ],
        justification: 'To compile custom & imported filters in a modular way from service worker (service workers do not allow dynamic module import)',
    });
}

export async function closeOffscreenDocument() {
    return chrome.offscreen.closeDocument();
}
