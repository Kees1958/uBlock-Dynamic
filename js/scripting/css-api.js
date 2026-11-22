/*******************************************************************************

    uBlock-Stripped-Dynamic - a Chrome MV3 content blocker
    Copyright (C) 2026-present Kees1958
    Copyright (C) 2025-present Raymond Hill

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

(api => {
    if ( typeof api === 'object' ) { return; }
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
    // insert(css, immediate): with immediate === true the CSS is also applied in the page at once, as a constructed
    // stylesheet, so site-specific hiding does not wait for the background's insertCSS round trip (fewer ad
    // flashes on load; uBO 2720077). The background insertCSS still follows: it is the copy that keeps applying
    // after the page replaces document.adoptedStyleSheets. Only the site-specific hiding callers pass true.
    self.cssAPI = {
        insert(css, immediate = false) {
            if ( immediate && Array.isArray(document.adoptedStyleSheets) ) {
                try {
                    const sheet = new CSSStyleSheet();
                    sheet.replaceSync(css);
                    document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, sheet ];
                } catch {
                    // benign: an unparsable sheet only loses the early copy; insertCSS below still runs
                }
            }
            sendToExtension({
                what: 'insertCSS',
                css,
            }).catch(( ) => {
            });
        },
    };
})(self.cssAPI);
