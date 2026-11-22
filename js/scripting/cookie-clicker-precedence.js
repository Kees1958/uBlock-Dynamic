/*******************************************************************************

    uBlock-Stripped-Dynamic — Cookie-clicker precedence marker for CMP frames
    Copyright (C) 2026-present Kees1958

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
*/

/******************************************************************************/
// cookie-clicker-precedence.js (10.4.9) — "Cookie consent clicker rules always prevail above Worry-free trying to
// decline cookies" (owner's decision), layer 2 of 2 (layer 1 and the full reasoning: js/core/scripting-manager.js,
// registerCookieClickerAutoDenyContentScriptsImpl()).
//
// Registered ISOLATED, allFrames, document_start — and ONLY while a "Never consent" / Worry-free auto-deny session is
// active (same lifecycle as the auto-deny bundle). In a SUBFRAME whose top-level site has a cookie-clicker rule, it sets
// the D5 precedence marker, so the auto-deny bundle (MAIN world, document_idle) stays out of that frame (a CMP frame
// such as consent.cookiebot.com, which cannot be excluded by URL). Top frames are not handled here: a rule site's own
// frames are excluded from the bundle's registration (layer 1).
//
// Ordering guard: PENDING is set synchronously first and removed only after the marker decision, so the bundle can
// never act in the gap while the one storage read is in flight (it treats PENDING as "retry later").
//
// Resources: no listeners, no timers, no state kept; one storage read; both attributes it touches are set/cleared
// within this single run (PENDING always cleared in `finally`).
/******************************************************************************/

(async function uBOL_cookieClickerPrecedence() {

// ── Config — must match the other copies exactly (content script: no shared import surface) ──────────────────────
// js/scripting/cookie-clicker-click.js PRECEDENCE_MARKER_ATTR and tools/build-autodeny-bundle.mjs.
const PRECEDENCE_MARKER_ATTR = 'data-ubol-cookie-clicker-rule';
// tools/build-autodeny-bundle.mjs PRECEDENCE_PENDING_ATTR.
const PRECEDENCE_PENDING_ATTR = 'data-ubol-cookie-clicker-pending';
// js/core/scripting-manager.js COOKIE_CLICKER_RULE_SITES_KEY (written there, read here).
const RULE_SITES_STORAGE_KEY = 'cookieClicker.ruleSites';

// Guard: top frames are layer 1's job (excluded by registration) — exit without touching anything.
if ( window.top === window ) { return; }
const root = document.documentElement;
if ( root === null ) { return; }

// Top-level site of this frame: the last ancestor origin (works inside cross-origin frames).
function topHostnameOfFrame() {
    try {
        const origins = document.location.ancestorOrigins;
        if ( origins === undefined || origins.length === 0 ) { return ''; }
        return new URL(origins[origins.length - 1]).hostname.toLowerCase();
    } catch {
        return '';
    }
}

try { root.setAttribute(PRECEDENCE_PENDING_ATTR, '1'); } catch { return; }   // a denied write: nothing to guard
try {
    const topHostname = topHostnameOfFrame();
    if ( topHostname !== '' ) {
        const bin = await chrome.storage.local.get(RULE_SITES_STORAGE_KEY);
        const ruleSites = bin?.[RULE_SITES_STORAGE_KEY];
        if ( Array.isArray(ruleSites) && ruleSites.includes(topHostname) ) {
            root.setAttribute(PRECEDENCE_MARKER_ATTR, '1');   // set BEFORE PENDING is cleared (see header)
        }
    }
} catch {
    // Benign: no marker means the generic bundle may act here — the pre-10.4.9 behaviour, never worse.
} finally {
    try { root.removeAttribute(PRECEDENCE_PENDING_ATTR); } catch { /* nothing left to release */ }
}

})();
