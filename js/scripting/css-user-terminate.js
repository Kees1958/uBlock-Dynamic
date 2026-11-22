/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2019-present Raymond Hill

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

(function uBOL_cssUserTerminate() {

// ── (11.0.2) GUARD: the extension was reloaded or updated under this page ─────────────────────────────────────────────
// Scripts left in an open page then lose their connection: chrome.runtime.id becomes undefined and
// chrome.runtime.sendMessage() THROWS synchronously ("Extension context invalidated."), which a .catch() cannot see —
// it surfaced on chrome://extensions as an error with no context. sendToExtension() always returns a promise: it
// resolves to undefined once the extension is gone, and rejects (never throws) on any other failure. Same pattern as
// css-specific.js cacheWrite(). Page scripts cannot import, so this block is copied word for word into every page
// script that messages the extension; tools/test-content-script-context.mjs keeps the copies identical.
function isExtensionGone() {
    try {
        return chrome.runtime?.id === undefined;
    } catch {
        return true;   // benign: no runtime at all means the same — the extension is gone
    }
}
function sendToExtension(msg) {
    if ( isExtensionGone() ) { return Promise.resolve(); }
    try {
        return chrome.runtime.sendMessage(msg);
    } catch (reason) {
        return Promise.reject(reason);
    }
}
// ── end GUARD ──────────────────────────────────────────────────────────────────────────────────────────────────────────


/******************************************************************************/

const plainSelectors = self.customFilters?.plainSelectors;
if ( plainSelectors ) {
    sendToExtension({
        what: 'removeCSS',
        css: `${plainSelectors.join(',\n')}{display:none!important;}`,
    }).catch(( ) => {
    });
}

if ( self.customProceduralFiltererAPI instanceof Object ) {
    self.customProceduralFiltererAPI.reset();
}

self.customFilters = undefined;

/******************************************************************************/

})();

void 0;
