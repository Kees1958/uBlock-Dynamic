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
 * ext.js — Browser API surface normalisation and storage helpers
 *
 * Exports a consistent set of storage, runtime, and browser API references
 * that work across Chrome and Firefox. Key exports:
 *   browser, runtime                        — normalised API references
 *   localRead(key) / localWrite(key, val)   — chrome.storage.local wrappers
 *   localRemove(keys) / localKeys()         — chrome.storage.local wrappers
 *   sessionRead(key) / sessionWrite(key, v) — chrome.storage.session wrappers
 *   sessionAccessLevel(opts)                — sets session storage access level
 *   supportsUserScripts()                   — runtime check for userScripts API
 *   webextFlavor                            — 'chrome' | 'firefox' | 'safari'
 *   TAB_RELOAD_DELAY_MS                     — delay before reloading a tab
 *                                              after a filtering-relevant
 *                                              change (437ms)
 *   reloadTab(tabId, url?, bypassCache?)    — reload/navigate a tab after
 *                                              that delay
 *
 * TAB_RELOAD_DELAY_MS/reloadTab() live here rather than in util/utils.js —
 * where TAB_RELOAD_DELAY_MS used to be defined — specifically because
 * reloadTab() needs `browser` (this file's own export, just below) and
 * util/ has zero internal imports of any kind, by design (see
 * ARCHITECTURE.md's five-tier model: util/ and data/ are parallel leaf
 * tiers, neither may import the other). Moving the constant to sit next
 * to the function that actually uses it, in the one tier both core/ and
 * workflow/ can reach, was simpler and more honest than either duplicating
 * the constant or threading `browser` through as a parameter to keep it in
 * util/.
 */


import { webext } from './ext-compat.js';
import { catchExpected, EXPECTED_ERRORS } from './expected-errors.js';

/******************************************************************************/

export const browser = webext;

export const runtime = browser.runtime;

// The installed extension's version (manifest.json). (10.7.12) Moved here from background.js: the
// service worker's startup and the settings export (settings-routes.js) both use it.
export function getCurrentVersion() {
    return runtime.getManifest().version;
}

// Shared timing constant (single source of truth) — used wherever a tab
// needs to reload/navigate after a filtering-relevant change (a site-mode
// toggle, a Matrix panel override, a new host permission being granted):
// all three need the SAME short delay first, so the browser has actually
// finished registering the just-updated content scripts/DNR rules before
// the reload fires — without it, the reload can race ahead and load the
// page under the *old* rules. Centralised here so none of those call
// sites can silently drift apart on the delay value.
export const TAB_RELOAD_DELAY_MS = 437;

// Guard: the tab this reload/navigate targets may have been closed by the
// user during the TAB_RELOAD_DELAY_MS window between scheduling and
// firing — that's the whole reason for the delay in the first place (see
// above). Both calls are fire-and-forget by design (nothing awaits this
// Promise's *result*, only that it eventually settles), so an unguarded
// rejection here becomes an "Unchecked runtime.lastError" console warning
// rather than anything actually breaking — silently discard it either
// way, same pattern popup.js uses for its own tabs.remove calls.
//
// bypassCache matters specifically for DNR rule changes to take effect —
// a plain reload can still serve a page/resource from cache without
// re-running it through DNR at all, until cache is cleared or bypassed
// (chrome.declarativeNetRequest docs). Every caller whose change affects
// DNR rules (site-mode toggles, Matrix overrides) should pass true.
export async function reloadTab(tabId, url = '', bypassCache = false) {
    return new Promise(resolve => {
        self.setTimeout(( ) => {
            if ( url !== '' ) {
                browser.tabs.update(tabId, { url }).catch(catchExpected('navigate tab', [ EXPECTED_ERRORS.TAB_GONE ]));
            } else {
                browser.tabs.reload(tabId, { bypassCache }).catch(catchExpected('reload tab', [ EXPECTED_ERRORS.TAB_GONE ]));
            }
            resolve();
        }, TAB_RELOAD_DELAY_MS);
    });
}

/******************************************************************************/

export const webextFlavor = (( ) => {
    const extURL = runtime.getURL('');
    if ( extURL.startsWith('safari-web-extension:') ) { return 'safari'; }
    return extURL.startsWith('moz-extension:') ? 'firefox' : 'chromium';
})();

function notAnObject(a) { return typeof a !== 'object' || a === null; }

/******************************************************************************/

// supportsUserScripts removed in v3.12 — userScripts permission dropped;
// sandbox ABP import no longer registers scriptlets via userScripts API.

/******************************************************************************/

// The extension's service worker can be evicted at any time, so when we
// send a message, we try a few more times when the message fails to be sent.

// ── MESSAGE-SEND RETRY CONFIG ────────────────────────────────────────────
// Named here (not inline) so the tuning is visible in one place and can be
// adjusted without hunting through sendMessage()'s body.
//   SEND_MESSAGE_MAX_ATTEMPTS:   1 initial try + this many retries.
//   SEND_MESSAGE_RETRY_DELAY_MS: fixed delay between attempts — long enough
//                                 to cover a SW wake-up, short enough that a
//                                 UI waiting on the response doesn't stall
//                                 noticeably.
// A dropped attempt used to resolve to `undefined` immediately — completely
// indistinguishable from a handler that legitimately returns no data (e.g.
// the Allow list editor's siteModeGetAll returning an empty {}). That let a
// transient SW-eviction race during startup render as "your list is empty"
// in the dashboard, which could then be saved over the real stored data.
// Retrying first (this function) reduces how often that race is even hit;
// the Allow list editor also has its own guard against the remaining case
// where every attempt fails (see js/ui/mode-editor.js).
const SEND_MESSAGE_MAX_ATTEMPTS = 3;
const SEND_MESSAGE_RETRY_DELAY_MS = 200;

export async function sendMessage(msg) {
    for ( let attempt = 1; attempt <= SEND_MESSAGE_MAX_ATTEMPTS; attempt++ ) {
        try {
            return await runtime.sendMessage(msg);
        } catch (reason) {
            if ( attempt === SEND_MESSAGE_MAX_ATTEMPTS ) {
                console.log(reason);
                return;
            }
            await new Promise(resolve => {
                self.setTimeout(resolve, SEND_MESSAGE_RETRY_DELAY_MS);
            });
        }
    }
}

/******************************************************************************/

export async function localRead(key) {
    if ( notAnObject(browser?.storage?.local) ) { return; }
    try {
        const bin = await browser.storage.local.get(key);
        if ( notAnObject(bin) ) { return; }
        return bin[key] ?? undefined;
    } catch (reason) {
        // C5: a failed read still resolves undefined (callers fall back to defaults), but is logged.
        catchExpected(`read storage.local '${key}'`, [])(reason);
    }
}

export async function localWrite(key, value) {
    if ( notAnObject(browser?.storage?.local) ) { return; }
    return browser.storage.local.set({ [key]: value });
}

export async function localRemove(keys) {
    if ( notAnObject(browser?.storage?.local) ) { return; }
    return browser.storage.local.remove(keys);
}

export async function localKeys() {
    if ( notAnObject(browser?.storage?.local) ) { return; }
    if ( browser.storage.local.getKeys ) {
        return browser.storage.local.getKeys();
    }
    const bin = await browser.storage.local.get(null);
    if ( notAnObject(bin) ) { return; }
    return Object.keys(bin);
}

/******************************************************************************/

export async function sessionRead(key) {
    if ( notAnObject(browser?.storage?.session) ) { return; }
    try {
        const bin = await browser.storage.session.get(key);
        if ( notAnObject(bin) ) { return; }
        return bin[key] ?? undefined;
    } catch (reason) {
        // C5: a failed read still resolves undefined (callers fall back to defaults), but is logged.
        catchExpected(`read storage.session '${key}'`, [])(reason);
    }
}

export async function sessionWrite(key, value) {
    if ( notAnObject(browser?.storage?.session) ) { return; }
    return browser.storage.session.set({ [key]: value });
}

// (10.7.6) sessionRemove() / sessionKeys() removed: their only user was the per-site CSS cache, which moved to
// storage.local (audit 10.7.5 D-5) — knip step 17 found them unused.

// BUG FIX (audit 9.7.5, C5): setAccessLevel() returns a promise, but was
// called without await inside try/catch — a rejection escaped the catch
// as an unhandled rejection, and nothing recorded that content scripts
// had lost session-storage access (css-specific.js's selector cache then
// silently never hits). Now awaited, and a failure is logged with
// context. Still never throws to the caller: startup must continue.
export async function sessionAccessLevel(level) {
    try {
        await browser.storage.session.setAccessLevel(level);
    } catch (reason) {
        console.error('[uBlock-Dynamic] sessionAccessLevel failed:', level, reason);
    }
}

/******************************************************************************/
